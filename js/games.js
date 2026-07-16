// 미니게임 4종 — 눈치게임 / 무궁화 꽃이 피었습니다 / 빨리 집어! / 초세기!
// 각 게임은 공통 인터페이스를 구현:
//   duration(n)                : play 페이즈 길이(ms)
//   hostSetup(ctx)             : 방장이 game/state 초기값 생성
//   mount(stage, dock, ctx)    : UI 생성 + 입력 연결
//   unmount()                  : 타이머/rAF 정리
//   onState(state, ctx)        : game/state 변경 콜백
//   onInputs(inputs, ctx)      : game/inputs 변경 콜백
//   hostEarlyEnd(ctx, i, s)    : 조기 종료 조건 → false | 지연ms
//   evaluate(ctx, i, s)        : {outcome:{uid:'win'|'lose'}, detail:{uid:문구}}
import { makeChar, setFace, setMotion, charSay } from "./character.js";
import { sfx, playDrumroll } from "./sfx.js";

// ── 공통 헬퍼 ────────────────────────────────
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function actionBtn(dock, label) {
  dock.innerHTML = "";
  const b = document.createElement("button");
  b.className = "btn btn-action boil";
  b.textContent = label;
  dock.appendChild(b);
  return b;
}

/** 플레이어 전원 캐릭터 필드 생성 → {field, map} */
function buildCharField(parent, ctx, { size = 54, exclude = [], sit = false } = {}) {
  const field = document.createElement("div");
  field.className = "char-field";
  const map = {};
  const players = ctx.players();
  for (const [pid, p] of Object.entries(players)) {
    if (exclude.includes(pid)) continue;
    const el = makeChar({
      color: ctx.colorOf(pid), nick: p.nick, size,
      motion: sit ? "sit" : "idle"
    });
    if (pid === ctx.uid) {
      el.classList.add("me");
      const mk = document.createElement("div");
      mk.className = "you-mark";
      mk.textContent = "▼ 나";
      el.appendChild(mk);
    }
    map[pid] = el;
    field.appendChild(el);
  }
  parent.appendChild(field);
  return { field, map };
}

function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* noop */ } }

/** 모션 클래스가 바뀔 때만 적용 — 매 프레임 리셋하면 CSS 애니메이션이 뚝뚝 끊긴다 */
function setM(el, m) {
  if (el && el._m !== m) { el._m = m; setMotion(el, m); }
}

/** 시드 고정 난수 (모든 클라이언트가 같은 두더지/단어 스케줄을 보게) */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 순위형 게임 공통 3단계 점수:
 * 상위 30% → win(+1), 31~60% → mid(0), 나머지·미참여 → lose(-1)
 * @param ctx
 * @param ranked 잘한 순서대로 정렬된 참가자 uid 배열
 * @param detailOf uid → 표시 문구
 * @param notPlayedText 미참여자 문구
 */
function tierOutcome(ctx, ranked, detailOf, notPlayedText) {
  const players = Object.keys(ctx.players());
  const winCut = Math.max(1, Math.ceil(players.length * 0.3));
  const midCut = Math.ceil(players.length * 0.6);
  const outcome = {}, detail = {};
  ranked.forEach((pid, i) => {
    outcome[pid] = i < winCut ? "win" : i < midCut ? "mid" : "lose";
    detail[pid] = detailOf(pid) + (outcome[pid] === "win" ? " 🏅" : "");
  });
  for (const pid of players) {
    if (outcome[pid] === undefined) { outcome[pid] = "lose"; detail[pid] = notPlayedText; }
  }
  return { outcome, detail };
}

/** 원형 배치 헬퍼 (빨리집어/폭탄돌리기 공용) */
function circleLayout(field, map) {
  const ids = Object.keys(map);
  const apply = () => {
    const w = field.clientWidth, h = field.clientHeight;
    const rx = Math.max(90, w / 2 - 85), ry = Math.max(70, h / 2 - 70);
    ids.forEach((pid, i) => {
      const a = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      const el = map[pid];
      el.style.left = (50 + (rx / w) * 100 * Math.cos(a)) + "%";
      el.style.top = (50 + (ry / h) * 100 * Math.sin(a)) + "%";
    });
  };
  apply();
  window.addEventListener("resize", apply);
  return () => window.removeEventListener("resize", apply);
}

/**
 * rAF 게임 루프. __SM_FROZEN(스크린샷용 정지) 동안엔 rAF 예약을 멈추고
 * setTimeout으로만 대기 → 정지 상태에서 화면 캡처가 가능해짐.
 * @returns 정지 함수
 */
function gameLoop(fn) {
  let raf = 0, stopped = false, prev = performance.now();
  const arm = () => {
    if (stopped) return;
    if (window.__SM_FROZEN) { prev = performance.now(); setTimeout(arm, 300); return; }
    if (document.hidden) {
      // 탭이 백그라운드면 rAF가 멈추므로 setTimeout으로 게임 로직만 유지
      setTimeout(() => {
        if (stopped) return;
        const t = performance.now();
        fn(t, Math.min(0.05, (t - prev) / 1000));
        prev = t;
        arm();
      }, 200);
      return;
    }
    raf = requestAnimationFrame(t => {
      const dt = Math.min(0.05, (t - prev) / 1000);
      prev = t;
      fn(t, dt);
      arm();
    });
  };
  arm();
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

// ═════════════════════════════════════════════
// 1. 눈치게임
// ═════════════════════════════════════════════
const nunchi = {
  id: "nunchi",
  name: "눈치게임",
  tag: "1분 내에 눈치를 발휘해라!",
  desc: "아무도 안 누를 때 <b>혼자</b> [외치기!]를 눌러야 성공!<br>누군가와 동시에(0.9초 안에) 누르면 같이 누른 사람 전부 탈락.<br>끝까지 안 누르고 버텨도 탈락이야! 👀",
  WINDOW: 900,

  duration: () => 60000,
  hostSetup: () => ({ on: true }),

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { shown: new Set(), pressed: false, timers: [] };
    const status = document.createElement("div");
    status.className = "nunchi-status";
    status.innerHTML = "다들 눈치를 보는 중… <b>혼자</b>일 때 외쳐!";
    stage.appendChild(status);
    const { map } = buildCharField(stage, ctx, { size: 56 });
    c.map = map;

    const btn = actionBtn(dock, "외치기!");
    c.btn = btn;
    btn.addEventListener("click", () => {
      if (c.pressed) return;
      c.pressed = true;
      btn.disabled = true;
      btn.textContent = "외쳤다…!";
      ctx.writeInput({ t: ctx.tsSentinel() });
      status.innerHTML = "외쳤다!! 아무도 같이 안 눌렀길… 🙏";
    });
  },
  onState() {},
  onInputs(inputs, ctx) {
    const c = this._c;
    if (!c || !inputs) return;
    for (const pid of Object.keys(inputs)) {
      if (c.shown.has(pid)) continue;
      c.shown.add(pid);
      const el = c.map[pid];
      if (!el) continue;
      setMotion(el, "shout");
      charSay(el, "얍!!", 1500);
      sfx.pop();
      c.timers.push(setTimeout(() => setMotion(el, "idle"), 700));
    }
  },
  hostEarlyEnd(ctx, inputs) {
    const n = Object.keys(ctx.players()).length;
    if (inputs && Object.keys(inputs).length >= n) return 2200;
    return false;
  },
  evaluate(ctx, inputs) {
    inputs = inputs || {};
    const entries = Object.entries(inputs)
      .map(([u, v]) => ({ u, t: typeof v.t === "number" ? v.t : 0 }))
      .sort((a, b) => a.t - b.t);
    const failed = new Set();
    for (let i = 0; i < entries.length - 1; i++) {
      if (entries[i + 1].t - entries[i].t < this.WINDOW) {
        failed.add(entries[i].u);
        failed.add(entries[i + 1].u);
      }
    }
    const outcome = {}, detail = {};
    for (const pid of Object.keys(ctx.players())) {
      if (!inputs[pid]) { outcome[pid] = "lose"; detail[pid] = "침묵… 🤐"; }
      else if (failed.has(pid)) { outcome[pid] = "lose"; detail[pid] = "동시에 외쳤다!"; }
      else { outcome[pid] = "win"; detail[pid] = "혼자 외침! 👑"; }
    }
    return { outcome, detail };
  },
  unmount() {
    if (this._c) this._c.timers.forEach(clearTimeout);
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 2. 무궁화 꽃이 피었습니다
// ═════════════════════════════════════════════
const SYL = ["무", "궁", "화", "꽃", "이", "피", "었", "습", "니", "다"];
const SENTENCE = "무궁화 꽃이 피었습니다";
const ROULETTE_MS = 4200;

const TREE_SVG = `<svg viewBox="0 0 100 132" aria-hidden="true">
  <path d="M50 10 C22 8 12 34 23 47 C8 54 15 76 33 73 C36 86 64 86 68 73 C86 76 93 54 78 47 C89 32 79 8 50 10 Z"
        fill="#7cb85c" fill-opacity="0.85" stroke="#33312e" stroke-width="3.4" stroke-linejoin="round"/>
  <path d="M45 128 C44 104 45 88 42 66 M56 128 C57 106 55 88 58 66" fill="none" stroke="#33312e" stroke-width="5.5" stroke-linecap="round"/>
</svg>`;

const mugunghwa = {
  id: "mugunghwa",
  name: "무궁화 꽃이 피었습니다",
  tag: "1분 안에 탈출해!",
  desc: "술래가 글자를 외치는 동안 [전진!]을 꾹 눌러 달려!<br>술래가 돌아보는 순간 움직이면 잡힌다!! 🚨<br>빨간 선을 넘으면 성공! 술래는 글자를 순서대로 빨리 눌러!",

  duration: () => ROULETTE_MS + 60000,
  hostSetup(ctx) {
    const players = ctx.players();
    const ids = Object.keys(players);
    const humans = ids.filter(id => !players[id].bot);
    const pool = humans.length ? humans : ids;
    const tagger = pool[Math.floor(Math.random() * pool.length)];
    return { tagger, sub: "roulette" };
  },
  hostTick(ctx, state) {
    if (state && state.sub === "roulette" && ctx.now() >= ctx.playStart + ROULETTE_MS) {
      ctx.writeState({ sub: "run", runStart: ctx.now() });
    }
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = {
      timers: [], raf: 0, myX: 0, moving: false, caught: false, fin: false,
      lastWrite: 0, tagger: null, layoutDone: false, runnerEls: {}, laneOf: {},
      cycle: null, cycleTimers: [], order: [], progress: 0, rouletteDone: false,
      lastTick: 0
    };

    stage.innerHTML = `
      <div class="mg-field" id="mgField">
        <div class="mg-status sketch" id="mgStatus">술래 뽑는 중…</div>
        <div class="mg-startline"></div>
        <div class="mg-finishline"></div>
        <div class="mg-finish-lbl">여기를 넘어!</div>
        <div class="mg-tree">${TREE_SVG}</div>
      </div>
      <div class="mg-dark" id="mgDark">
        <div class="dk-title">당신은 <b style="color:var(--hl)">술래</b>! 글자를 순서대로 눌러!</div>
        <div class="dk-progress" id="dkProgress"></div>
        <div class="mg-chips" id="mgChips"></div>
        <div class="dk-timer" id="dkHint">순서대로 글자를 눌러서 완성해!</div>
      </div>`;
    c.field = stage.querySelector("#mgField");
    c.statusEl = stage.querySelector("#mgStatus");
    c.dark = stage.querySelector("#mgDark");
    c.dkProgress = stage.querySelector("#dkProgress");
    c.chipsEl = stage.querySelector("#mgChips");

    // 룰렛 오버레이
    const rl = document.createElement("div");
    rl.style.cssText = "position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6rem;background:rgba(250,247,239,.92)";
    rl.innerHTML = `<div style="font-size:1.4rem;color:var(--ink-soft)">술래는 과연…?</div><div id="mgRoulName" class="sketch" style="font-size:2.3rem;font-weight:700;padding:.05em .8em">???</div>`;
    c.field.appendChild(rl);
    c.roulette = rl;
    c.roulName = rl.querySelector("#mgRoulName");
    const names = Object.values(ctx.players()).map(p => p.nick);
    let ri = 0;
    c.roulInt = setInterval(() => {
      c.roulName.textContent = names[ri++ % names.length];
      sfx.tick();
    }, 95);

    const btn = actionBtn(dock, "전진! (꾹 눌러)");
    btn.disabled = true;
    c.btn = btn;
    const down = e => { e.preventDefault(); if (!btn.disabled) c.moving = true; };
    const up = () => {
      if (c.moving && !c.fin && !c.caught) {
        // 멈춘 것도 바로 알림 — 다른 화면에서 계속 걷는 것처럼 보이는 문제 방지
        ctx.writeInput({ x: Math.round(c.myX * 10) / 10, m: 0 });
      }
      c.moving = false;
    };
    btn.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    c.cleanupWin = () => { window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };

    // 이동/판정 루프
    c.stopLoop = gameLoop((t, dt) => this._tickLocal(ctx, dt));
  },

  _layout(ctx) {
    const c = this._c;
    const state = ctx.state();
    if (!c || c.layoutDone || !state || !state.tagger) return;
    c.layoutDone = true;
    c.tagger = state.tagger;
    const players = ctx.players();
    // 술래 캐릭터
    const tp = players[c.tagger];
    const tEl = makeChar({ color: ctx.colorOf(c.tagger), nick: (tp ? tp.nick : "?") + " (술래)", size: 62 });
    tEl.classList.add("mg-tagger");
    if (c.tagger === ctx.uid) tEl.classList.add("me");
    c.field.appendChild(tEl);
    c.taggerEl = tEl;
    // 달리는 참가자들
    const runners = Object.keys(players).filter(id => id !== c.tagger);
    runners.forEach((pid, i) => {
      const el = makeChar({ color: ctx.colorOf(pid), nick: players[pid].nick, size: 46 });
      el.classList.add("mg-runner");
      if (pid === ctx.uid) {
        el.classList.add("me");
        const mk = document.createElement("div");
        mk.className = "you-mark"; mk.textContent = "▼ 나";
        el.appendChild(mk);
      }
      const lane = 12 + (i % 6) * 12.5;
      c.laneOf[pid] = lane;
      el.style.top = lane + "%";
      el.style.left = "8%";
      c.field.appendChild(el);
      c.runnerEls[pid] = el;
    });
    // 내 역할별 버튼
    if (c.tagger === ctx.uid) {
      c.btn.textContent = "당신이 술래!";
      c.btn.disabled = true;
    }
  },

  _tickLocal(ctx, dt) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || state.sub !== "run") return;
    const iAmTagger = state.tagger === ctx.uid;
    if (iAmTagger) return;
    if (c.fin || c.caught) { c.moving = false; return; }

    const cy = state.cycle;
    const nowT = ctx.now();
    const inLook = cy && cy.mode === "look" && nowT >= cy.start + 250 && nowT <= cy.end;

    if (c.moving) {
      if (inLook) {
        // 돌아본 순간 움직였다 → 잡힘!
        c.caught = true;
        c.moving = false;
        ctx.writeInput({ x: Math.round(c.myX * 10) / 10, caught: 1 });
        const el = c.runnerEls[ctx.uid];
        if (el) { setFace(el, "dead"); setMotion(el, "caught"); charSay(el, "잡혔다!!", 1800); }
        sfx.fail(); vibrate(300);
        c.btn.disabled = true;
        c.btn.textContent = "잡혔다… 😵";
        return;
      }
      c.myX = Math.min(100, c.myX + dt * 10.5);
      const el = c.runnerEls[ctx.uid];
      if (el) {
        el.style.left = (8 + c.myX * 0.72) + "%";
        setM(el, "walk");
      }
      if (c.myX >= 100) {
        c.fin = true;
        ctx.writeInput({ x: 100, fin: 1, m: 0 });
        if (el) { setFace(el, "happy"); setM(el, "jump"); el.classList.add("done"); charSay(el, "통과!!", 2000); }
        sfx.win();
        c.btn.disabled = true;
        c.btn.textContent = "탈출 성공!! 🎉";
        return;
      }
      if (nowT - c.lastWrite > 160) {
        c.lastWrite = nowT;
        ctx.writeInput({ x: Math.round(c.myX * 10) / 10, m: 1 });
      }
    } else {
      const el = c.runnerEls[ctx.uid];
      if (el && !c.fin && !c.caught) setM(el, "idle");
    }
  },

  onState(state, ctx) {
    const c = this._c;
    if (!c || !state) return;
    this._layout(ctx);

    // 룰렛 → 시작
    if (state.sub === "run" && !c.rouletteDone) {
      c.rouletteDone = true;
      clearInterval(c.roulInt);
      const tp = ctx.players()[state.tagger];
      c.roulName.textContent = "🚨 " + (tp ? tp.nick : "?") + " 🚨";
      sfx.bbam();
      setTimeout(() => { if (c.roulette) c.roulette.remove(); }, 1200);
      if (state.tagger !== ctx.uid) {
        c.btn.disabled = false;
      } else {
        this._taggerStartDark(ctx);
      }
      this._setStatus("지금 이동해!! (술래가 준비 중) 🏃", "safe");
    }

    // 사이클 표시
    const cy = state.cycle;
    const iAmTagger = state.tagger === ctx.uid;
    if (cy && c.lastCycleKey !== cy.mode + ":" + cy.start) {
      c.lastCycleKey = cy.mode + ":" + cy.start;
      if (cy.mode === "dark") {
        this._setStatus("술래가 외치는 중! 지금 이동해!! 🏃", "safe");
        if (c.taggerEl) c.taggerEl.classList.remove("looking");
      } else if (cy.mode === "look") {
        this._setStatus("돌아봤다!! 멈춰!!! 🚨", "danger");
        if (c.taggerEl) c.taggerEl.classList.add("looking");
        sfx.whistle();
      } else if (cy.mode === "fever") {
        this._setStatus("술래가 틀렸다! 피버타임 3초!! 🔥", "safe");
        if (c.taggerEl) c.taggerEl.classList.remove("looking");
        sfx.tada();
      } else if (cy.mode === "free") {
        this._setStatus("술래가 굼뜨다! 5초 자유이동!! 🎉", "safe");
        if (c.taggerEl) c.taggerEl.classList.remove("looking");
        sfx.pop();
      }
      if (iAmTagger) this._renderDark(ctx);
    }
  },

  _setStatus(text, cls) {
    const c = this._c;
    if (!c || !c.statusEl) return;
    c.statusEl.textContent = text;
    c.statusEl.className = "mg-status sketch " + (cls || "");
  },

  // ── 술래 전용: 글자 사이클 관리 ──
  _taggerStartDark(ctx) {
    const c = this._c;
    if (!c) return;
    const remain = ctx.playEnd - ctx.now();
    if (remain < 2600) return;
    c.order = shuffle(SYL.map((s, i) => i));
    c.progress = 0;
    const id = Math.random().toString(36).slice(2, 7);
    c.cycleId = id;
    ctx.writeState({ cycle: { mode: "dark", start: ctx.now(), end: 0, id } });
  },

  _renderDark(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    const cy = state && state.cycle;
    if (!cy) return;
    if (cy.mode === "look") { c.dark.classList.remove("show"); return; }
    c.dark.classList.add("show");
    const hint = c.dark.querySelector("#dkHint");
    if (cy.mode === "fever") {
      c.dkProgress.innerHTML = `<span style="color:#ff8a75">앗, 순서가 틀렸다!! 🔥</span>`;
      c.chipsEl.innerHTML = "";
      hint.textContent = "3초 뒤에 다시 도전…";
      return;
    }
    if (cy.mode === "free") {
      c.dkProgress.innerHTML = `<span style="color:#ff8a75">너무 늦었다!! 다들 도망간다!!</span>`;
      c.chipsEl.innerHTML = "";
      hint.textContent = "5초 뒤에 다시 도전…";
      return;
    }
    // dark: 진행 상태 + 셔플 칩
    hint.textContent = "순서대로 글자를 눌러서 완성해!";
    this._renderProgress();
    c.chipsEl.innerHTML = "";
    for (const si of c.order) {
      const b = document.createElement("button");
      b.className = "mg-chip";
      b.textContent = SYL[si];
      b.addEventListener("click", () => this._chipClick(ctx, si, b));
      c.chipsEl.appendChild(b);
    }
  },

  _renderProgress() {
    const c = this._c;
    let html = "";
    let k = 0;
    for (const ch of SENTENCE) {
      if (ch === " ") { html += "&nbsp;"; continue; }
      html += `<span class="${k < c.progress ? "done-syl" : "todo-syl"}">${ch}</span>`;
      k++;
    }
    c.dkProgress.innerHTML = html;
  },

  _chipClick(ctx, si, btnEl) {
    const c = this._c;
    if (!c || !c.cycleId) return;
    if (si === c.progress) {
      c.progress++;
      btnEl.disabled = true;
      sfx.correct();
      this._renderProgress();
      if (c.progress >= SYL.length) {
        const id = c.cycleId;
        c.cycleId = null;
        ctx.writeState({ cycle: { mode: "look", start: ctx.now(), end: ctx.now() + 1600, id } });
        c.dark.classList.remove("show");
        c.cycleTimers.push(setTimeout(() => this._taggerStartDark(ctx), 1700));
      }
    } else {
      sfx.wrong();
      const id = c.cycleId;
      c.cycleId = null;
      c.progress = 0;
      ctx.writeState({ cycle: { mode: "fever", start: ctx.now(), end: ctx.now() + 3000, id } });
      c.cycleTimers.push(setTimeout(() => this._taggerStartDark(ctx), 3050));
    }
  },

  onInputs(inputs, ctx) {
    const c = this._c;
    if (!c || !inputs) return;
    this._layout(ctx);
    for (const [pid, v] of Object.entries(inputs)) {
      if (pid === ctx.uid) continue;
      const el = c.runnerEls[pid];
      if (!el) continue;
      const x = typeof v.x === "number" ? v.x : 0;
      el.style.left = (8 + x * 0.72) + "%";
      if (v.caught && !el._caught) {
        el._caught = true;
        setFace(el, "dead"); setM(el, "caught");
        charSay(el, "잡혔다!!", 1500);
        sfx.poof();
      } else if (v.fin && !el._fin) {
        el._fin = true;
        el.classList.add("done");
        setFace(el, "happy"); setM(el, "jump");
        charSay(el, "통과!!", 1500);
        sfx.pop();
      } else if (!v.caught && !v.fin) {
        setM(el, v.m ? "walk" : "idle");
      }
    }
  },

  hostEarlyEnd(ctx, inputs, state) {
    if (!state || state.sub !== "run") return false;
    const runners = Object.keys(ctx.players()).filter(id => id !== state.tagger);
    if (!runners.length) return false;
    const done = runners.every(id => inputs && inputs[id] && (inputs[id].fin || inputs[id].caught));
    return done ? 2000 : false;
  },

  evaluate(ctx, inputs, state) {
    inputs = inputs || {};
    const tagger = state ? state.tagger : null;
    const players = Object.keys(ctx.players());
    const runners = players.filter(id => id !== tagger);
    const outcome = {}, detail = {};
    let fins = 0;
    for (const pid of runners) {
      const v = inputs[pid] || {};
      if (v.fin) { fins++; outcome[pid] = "win"; detail[pid] = "탈출 성공! 🏃"; }
      else if (v.caught) { outcome[pid] = "lose"; detail[pid] = "술래에게 잡혔다…"; }
      else { outcome[pid] = "lose"; detail[pid] = "선을 못 넘었어…"; }
    }
    if (tagger) {
      if (fins < runners.length * 0.5) { outcome[tagger] = "win"; detail[tagger] = "수비 성공! (술래)"; }
      else { outcome[tagger] = "lose"; detail[tagger] = "너무 많이 놓쳤다… (술래)"; }
    }
    return { outcome, detail };
  },

  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    clearInterval(c.roulInt);
    c.timers.forEach(clearTimeout);
    c.cycleTimers.forEach(clearTimeout);
    if (c.cleanupWin) c.cleanupWin();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 3. 빨리 집어!
// ═════════════════════════════════════════════
const grab = {
  id: "grab",
  name: "빨리 집어!",
  tag: "신호음이 들리면 최대한 빨리 클릭해!",
  desc: "카운트다운이 끝나고… 아무 때나 <b>\"지금!\"</b>이 뜬다!<br>뜨는 순간 최대한 빨리 [잡기!]를 눌러!<br>가장 빠른 30%만 성공. 미리 누르면 부정출발 탈락! ⚡",

  duration: () => 16000,
  hostSetup(ctx) {
    return { signalAt: ctx.playStart + 3000 + 1500 + Math.floor(Math.random() * 4500) };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { raf: 0, pressed: false, signalShown: false, lastCount: -1, map: {}, timers: [] };
    stage.innerHTML = `
      <div class="grab-field" id="grabField">
        <div class="grab-center" id="grabCenter"><div class="grab-count" id="grabMsg">3</div></div>
      </div>`;
    c.field = stage.querySelector("#grabField");
    c.center = stage.querySelector("#grabCenter");
    c.msg = stage.querySelector("#grabMsg");

    // 원형 배치
    const players = Object.entries(ctx.players());
    players.forEach(([pid, p], i) => {
      const el = makeChar({ color: ctx.colorOf(pid), nick: p.nick, size: 50, motion: "sit" });
      if (pid === ctx.uid) {
        el.classList.add("me");
        const mk = document.createElement("div");
        mk.className = "you-mark"; mk.textContent = "▼ 나";
        el.appendChild(mk);
      }
      c.map[pid] = el;
      c.field.appendChild(el);
    });
    const layout = () => {
      const w = c.field.clientWidth, h = c.field.clientHeight;
      const rx = Math.max(90, w / 2 - 80), ry = Math.max(70, h / 2 - 66);
      players.forEach(([pid], i) => {
        const a = (i / players.length) * Math.PI * 2 - Math.PI / 2;
        const el = c.map[pid];
        el.style.left = (50 + (rx / w) * 100 * Math.cos(a)) + "%";
        el.style.top = (50 + (ry / h) * 100 * Math.sin(a)) + "%";
      });
    };
    layout();
    window.addEventListener("resize", layout);
    c.cleanupWin = () => window.removeEventListener("resize", layout);

    const btn = actionBtn(dock, "잡기!");
    c.btn = btn;
    btn.addEventListener("click", () => {
      if (c.pressed) return;
      const state = ctx.state();
      if (!state || !state.signalAt) return;
      c.pressed = true;
      btn.disabled = true;
      const t = ctx.now();
      const el = c.map[ctx.uid];
      if (t < state.signalAt) {
        ctx.writeInput({ dt: -1 });
        if (el) { setFace(el, "dead"); setMotion(el, "caught"); charSay(el, "너무 빨랐어!!", 1800); }
        sfx.buzz();
        btn.textContent = "부정출발… 😵";
      } else {
        const dt = Math.round(t - state.signalAt);
        ctx.writeInput({ dt });
        if (el) { setFace(el, "happy"); setMotion(el, "stand"); charSay(el, (dt / 1000).toFixed(3) + "초!", 2600); }
        sfx.pop();
        btn.textContent = (dt / 1000).toFixed(3) + "초!";
      }
    });

    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.signalAt) return;
    const t = ctx.now();
    const cdEnd = ctx.playStart + 3000;
    if (t < cdEnd) {
      const n = Math.ceil((cdEnd - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.msg.className = "grab-count"; c.msg.textContent = n; sfx.beep(); }
    } else if (t < state.signalAt) {
      if (c.msg.textContent !== "・・・") { c.msg.className = "grab-wait"; c.msg.textContent = "・・・"; }
    } else if (!c.signalShown) {
      c.signalShown = true;
      c.msg.className = "grab-now";
      c.msg.textContent = "지금!!";
      c.field.classList.add("flash");
      sfx.go();
      vibrate(200);
    }
  },

  onState() {},
  onInputs(inputs, ctx) {
    const c = this._c;
    if (!c || !inputs) return;
    for (const [pid, v] of Object.entries(inputs)) {
      if (pid === ctx.uid) continue;
      const el = c.map[pid];
      if (!el || el._done) continue;
      el._done = true;
      if (v.dt >= 0) {
        setFace(el, "happy"); setMotion(el, "stand");
        charSay(el, (v.dt / 1000).toFixed(3) + "초!", 2600);
        sfx.pop();
      } else {
        setFace(el, "dead"); setMotion(el, "caught");
        charSay(el, "부정출발!", 1500);
      }
    }
  },
  hostEarlyEnd(ctx, inputs, state) {
    const n = Object.keys(ctx.players()).length;
    if (inputs && Object.keys(inputs).length >= n) return 2200;
    if (state && state.signalAt && ctx.now() > state.signalAt + 6000) return 900;
    return false;
  },
  evaluate(ctx, inputs) {
    inputs = inputs || {};
    const players = Object.keys(ctx.players());
    const valid = players
      .filter(pid => inputs[pid] && inputs[pid].dt >= 0)
      .sort((a, b) => inputs[a].dt - inputs[b].dt);
    const res = tierOutcome(ctx, valid, pid => (inputs[pid].dt / 1000).toFixed(3) + "초", "멍때렸다… 💤");
    for (const pid of players) {
      if (inputs[pid] && inputs[pid].dt < 0) { res.outcome[pid] = "lose"; res.detail[pid] = "부정출발!"; }
    }
    return res;
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    c.timers.forEach(clearTimeout);
    if (c.cleanupWin) c.cleanupWin();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 4. 초세기!
// ═════════════════════════════════════════════
const choseki = {
  id: "choseki",
  name: "초세기!",
  tag: "감으로 N초를 세어라!",
  desc: "목표 시간이 정해지면 시계가 잠깐 보이다가 숨어버려! 🙈<br>마음속으로 초를 세다가 딱 목표 시간에 [멈춰!]를 눌러.<br>가장 정확한 30%가 승리!",

  duration: () => 24000,
  hostSetup(ctx) {
    return { target: 5 + Math.floor(Math.random() * 5), startAt: ctx.playStart + 3000 };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { raf: 0, pressed: false, started: false, lastCount: -1, map: {} };
    stage.innerHTML = `
      <div class="cs-wrap">
        <div class="cs-target" id="csTarget">목표: <b>?초</b></div>
        <div class="cs-clock sketch" id="csClock">3</div>
        <div class="cs-note" id="csNote">시계는 1.2초만 보여! 감으로 세!</div>
        <div class="cs-minirow" id="csRow"></div>
      </div>`;
    c.clock = stage.querySelector("#csClock");
    c.note = stage.querySelector("#csNote");
    c.target = stage.querySelector("#csTarget");
    const row = stage.querySelector("#csRow");
    for (const [pid, p] of Object.entries(ctx.players())) {
      const el = makeChar({ color: ctx.colorOf(pid), nick: p.nick, size: 42 });
      if (pid === ctx.uid) el.classList.add("me");
      c.map[pid] = el;
      row.appendChild(el);
    }

    const btn = actionBtn(dock, "멈춰!");
    btn.disabled = true;
    c.btn = btn;
    btn.addEventListener("click", () => {
      if (c.pressed) return;
      const state = ctx.state();
      if (!state || ctx.now() < state.startAt) return;
      c.pressed = true;
      btn.disabled = true;
      const e = Math.round(ctx.now() - state.startAt);
      ctx.writeInput({ e });
      const el = c.map[ctx.uid];
      if (el) { setMotion(el, "shout"); charSay(el, "지금이다!", 1800); }
      sfx.pop();
      btn.textContent = "제출 완료! 과연…?";
      c.note.textContent = "결과는 잠시 후에! 🤫";
    });

    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.startAt) return;
    c.target.innerHTML = `목표: <b>${state.target}초</b>`;
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.clock.textContent = n; sfx.beep(); }
      return;
    }
    if (!c.started) {
      c.started = true;
      c.btn.disabled = c.pressed;
      sfx.go();
    }
    const e = t - state.startAt;
    if (e < 1200) {
      clearTimeout(c.fadeTimer);
      c.hiding = false;
      c.clock.classList.remove("hidden-time", "cs-fading");
      c.clock.textContent = (e / 1000).toFixed(2);
    } else if (!c.hiding) {
      // 숫자를 바로 끊어버리지 않고, 서서히 페이드아웃한 뒤 가려진 표시로 교체
      c.hiding = true;
      c.clock.classList.add("cs-fading");
      c.fadeTimer = setTimeout(() => {
        if (!c.clock) return;
        c.clock.classList.add("hidden-time");
        c.clock.textContent = "?.?? 🙈";
        c.clock.classList.remove("cs-fading");
      }, 450);
    }
  },

  onState() {},
  onInputs(inputs, ctx) {
    const c = this._c;
    if (!c || !inputs) return;
    for (const pid of Object.keys(inputs)) {
      if (pid === ctx.uid) continue;
      const el = c.map[pid];
      if (!el || el._done) continue;
      el._done = true;
      setMotion(el, "shout");
      charSay(el, "됐다!", 1400);
      sfx.pop();
    }
  },
  hostEarlyEnd(ctx, inputs) {
    const n = Object.keys(ctx.players()).length;
    if (inputs && Object.keys(inputs).length >= n) return 2000;
    return false;
  },
  evaluate(ctx, inputs, state) {
    inputs = inputs || {};
    const targetMs = (state ? state.target : 7) * 1000;
    const players = Object.keys(ctx.players());
    const valid = players
      .filter(pid => inputs[pid] && typeof inputs[pid].e === "number")
      .sort((a, b) => Math.abs(inputs[a].e - targetMs) - Math.abs(inputs[b].e - targetMs));
    return tierOutcome(ctx, valid, pid => (inputs[pid].e / 1000).toFixed(2) + "초", "안 눌렀다… 💤");
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    clearTimeout(c.fadeTimer);
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 5. 두더지 잡기!
// ═════════════════════════════════════════════
const WHACK_START = 3500;
const WHACK_DUR = 30000;

/** 시드로 두더지 스케줄 생성 — 모든 플레이어가 같은 두더지를 본다 */
function genMoles(seed) {
  const rng = mulberry32(seed);
  const events = [];
  const holeBusy = [0, 0, 0, 0, 0, 0];
  let t = 900;
  let idx = 0;
  while (t < WHACK_DUR - 1400) {
    const roll = rng();
    const type = roll < 0.62 ? "normal" : roll < 0.8 ? "gold" : "bomb";
    const ttl = type === "gold" ? 650 : type === "bomb" ? 1200 : 950;
    // 비어있는 구멍 찾기
    let hole = Math.floor(rng() * 6);
    for (let k = 0; k < 6 && holeBusy[hole] > t; k++) hole = (hole + 1) % 6;
    if (holeBusy[hole] <= t) {
      events.push({ i: idx++, at: t, ttl, hole, type });
      holeBusy[hole] = t + ttl + 220;
    }
    t += 380 + rng() * 480;
  }
  return events;
}

const WHACK_PTS = { normal: 1, gold: 3, bomb: -2 };

const whack = {
  id: "whack",
  name: "두더지 잡기!",
  tag: "두더지를 최대한 많이 잡아라!",
  desc: "구멍에서 튀어나오는 두더지를 빠르게 탭! 🔨<br>일반 두더지 <b>+1</b> · 반짝이는 황금 두더지 <b>+3</b> (금방 숨어!) · 폭탄 두더지 <b>-2</b> (누르면 안 돼!)<br>점수가 높은 상위 30%가 승리!",

  stampOnTimeout: false, // 타이머 종료가 정상 종료인 게임
  duration: () => WHACK_START + WHACK_DUR + 2500,
  hostSetup(ctx) {
    return { seed: Math.floor(Math.random() * 1e9), startAt: ctx.playStart + WHACK_START };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { score: 0, lastCount: -1, started: false, lastWrite: 0, moleEls: {}, hitSet: new Set() };
    stage.innerHTML = `
      <div class="wa-top">
        <span class="sketch hud-chip">내 점수: <b id="waScore">0</b>점</span>
        <span class="wa-count" id="waCount"></span>
      </div>
      <div class="wa-board" id="waBoard">
        ${[0, 1, 2, 3, 4, 5].map(i => `<div class="wa-hole" data-hole="${i}"><div class="wa-dirt"></div></div>`).join("")}
      </div>`;
    dock.innerHTML = `<div class="game-note">🔨 두더지가 나오면 바로 탭! (폭탄은 누르지 마!)</div>`;
    c.scoreEl = stage.querySelector("#waScore");
    c.countEl = stage.querySelector("#waCount");
    c.holes = [...stage.querySelectorAll(".wa-hole")];
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.startAt) return;
    if (!c.events) c.events = genMoles(state.seed);
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.countEl.textContent = n + "…"; sfx.beep(); }
      return;
    }
    if (!c.started) { c.started = true; c.countEl.textContent = "잡아라!!"; sfx.go(); setTimeout(() => { if (c.countEl) c.countEl.textContent = ""; }, 900); }
    const e = t - state.startAt;
    for (const ev of c.events) {
      const active = e >= ev.at && e < ev.at + ev.ttl && !c.hitSet.has(ev.i);
      const el = c.moleEls[ev.i];
      if (active && !el) this._spawnMole(ctx, ev);
      else if (!active && el) { el.remove(); delete c.moleEls[ev.i]; }
    }
  },

  _spawnMole(ctx, ev) {
    const c = this._c;
    const hole = c.holes[ev.hole];
    const color = ev.type === "gold" ? "#f5c518" : ev.type === "bomb" ? "#3d3a36" : "#a5713f";
    const mole = makeChar({ color, nick: null, size: 62, face: ev.type === "bomb" ? "dead" : "normal", motion: "none" });
    mole.classList.add("wa-mole", "wa-" + ev.type);
    if (ev.type === "bomb") {
      const mark = document.createElement("div");
      mark.className = "wa-bombmark";
      mark.textContent = "💣";
      mole.appendChild(mark);
    }
    mole.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (c.hitSet.has(ev.i)) return;
      c.hitSet.add(ev.i);
      c.score += WHACK_PTS[ev.type];
      c.scoreEl.textContent = c.score;
      if (ev.type === "bomb") { sfx.buzz(); vibrate(180); mole.classList.add("wa-boomhit"); }
      else if (ev.type === "gold") { sfx.coin(); sfx.sparkle(); mole.classList.add("wa-bonked"); }
      else { sfx.bonk(); mole.classList.add("wa-bonked"); }
      const pop = document.createElement("div");
      pop.className = "plusone" + (WHACK_PTS[ev.type] < 0 ? " minusone" : "");
      pop.textContent = (WHACK_PTS[ev.type] > 0 ? "+" : "") + WHACK_PTS[ev.type];
      mole.appendChild(pop);
      setTimeout(() => { mole.remove(); delete c.moleEls[ev.i]; }, 420);
      const t = ctx.now();
      if (t - c.lastWrite > 500) { c.lastWrite = t; ctx.writeInput({ score: c.score }); }
      else { clearTimeout(c.wTimer); c.wTimer = setTimeout(() => ctx.writeInput({ score: c.score }), 520); }
    });
    hole.appendChild(mole);
    c.moleEls[ev.i] = mole;
  },

  onState() {},
  onInputs() {},
  hostEarlyEnd(ctx, inputs, state) {
    if (state && state.startAt && ctx.now() > state.startAt + WHACK_DUR + 700) return 1400;
    return false;
  },
  evaluate(ctx, inputs) {
    inputs = inputs || {};
    const players = Object.keys(ctx.players());
    const played = players.filter(p => inputs[p] && typeof inputs[p].score === "number")
      .sort((a, b) => inputs[b].score - inputs[a].score);
    return tierOutcome(ctx, played, pid => inputs[pid].score + "점", "멍때렸다… 💤");
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    clearTimeout(c.wTimer);
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 6. 미친 타이핑!
// ═════════════════════════════════════════════
const TYPE_START = 3500;
const TYPE_WORDS = [
  "급식", "축구", "피자", "치킨", "숙제", "시험", "방학", "우유", "딸기", "버스",
  "달리기", "안경", "칠판", "운동장", "종소리", "지우개", "사물함", "떡볶이", "매점", "단소",
  "짝꿍", "야자", "필통", "체육복", "교과서", "간식", "라면", "붕어빵", "슬리퍼", "알림장"
];

export function genWords(seed) {
  const rng = mulberry32(seed);
  const pool = TYPE_WORDS.slice();
  // 셔플
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const words = [];
  let t = 1200;
  for (let i = 0; i < 11; i++) {
    const roll = rng();
    const type = roll < 0.2 ? "bonus" : roll < 0.4 ? "trap" : "normal";
    const ttl = type === "bonus" ? 2300 : 3200;
    words.push({ i, w: pool[i], type, at: t, ttl, pts: type === "bonus" ? 3 : 1 });
    t += ttl + 900;
  }
  return { words, total: t };
}

const typing = {
  id: "typing",
  name: "미친 타이핑!",
  tag: "제일 빨리 치는 사람이 점수를 가져간다!",
  desc: "모두에게 <b>같은 단어</b>가 동시에 떠! 제일 빨리 정확하게 친 사람이 점수 획득 ⌨️<br>일반 단어 <b>+1</b> · 반짝 보너스 단어 <b>+3</b> · <b>함정 단어</b>는 치면 <b>-2</b>!<br>오타 내고 엔터 쳐도 -2! 총점 상위 30%가 승리!",

  stampOnTimeout: false, // 타이머 종료가 정상 종료인 게임
  duration: () => TYPE_START + 47000 + 3000,
  hostSetup(ctx) {
    const seed = Math.floor(Math.random() * 1e9);
    return { seed, startAt: ctx.playStart + TYPE_START };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { lastCount: -1, started: false, pen: 0, activeIdx: -1, claimedShown: {}, myPts: 0 };
    stage.innerHTML = `
      <div class="tw-wrap">
        <div class="tw-top"><span class="sketch hud-chip">내 점수: <b id="twScore">0</b>점</span><span class="wa-count" id="twCount"></span></div>
        <div class="tw-card sketch" id="twCard"><div class="tw-word" id="twWord">준비…</div><div class="tw-sub" id="twSub"></div></div>
        <input id="twInput" class="sketch-input tw-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="여기에 입력! (맞으면 자동 제출)" />
      </div>`;
    dock.innerHTML = `<div class="game-note">⌨️ 정확하게 치면 자동으로 제출돼! 함정 단어는 치지 마!</div>`;
    c.wordEl = stage.querySelector("#twWord");
    c.subEl = stage.querySelector("#twSub");
    c.cardEl = stage.querySelector("#twCard");
    c.scoreEl = stage.querySelector("#twScore");
    c.countEl = stage.querySelector("#twCount");
    c.input = stage.querySelector("#twInput");
    c.input.disabled = true;

    c.input.addEventListener("input", () => this._checkInput(ctx, false));
    c.input.addEventListener("keydown", e => { if (e.key === "Enter") this._checkInput(ctx, true); });
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _schedule(ctx) {
    const c = this._c;
    const state = ctx.state();
    if (!c.words && state && state.seed !== undefined) c.words = genWords(state.seed).words;
    return c.words;
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.startAt) return;
    const words = this._schedule(ctx);
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.countEl.textContent = n + "…"; sfx.beep(); }
      return;
    }
    if (!c.started) { c.started = true; c.input.disabled = false; c.input.focus(); sfx.go(); c.countEl.textContent = ""; }
    const e = t - state.startAt;
    const active = words.find(w => e >= w.at && e < w.at + w.ttl);
    const claims = (ctx.game().claims) || {};
    if (active) {
      if (c.activeIdx !== active.i) {
        c.activeIdx = active.i;
        c.wordEl.textContent = active.w;
        c.cardEl.className = "tw-card sketch tw-" + active.type;
        c.subEl.textContent = active.type === "trap" ? "⚠️ 함정!! 치면 -2점!!" : active.type === "bonus" ? "✨ 보너스 +3!! 빨리!!" : "+1 · 제일 빨리 쳐!";
        c.input.value = "";
        sfx.pop();
      }
      const cl = claims[active.i];
      if (cl && !c.claimedShown[active.i]) {
        c.claimedShown[active.i] = true;
        const p = ctx.players()[cl.u];
        c.subEl.textContent = cl.u === ctx.uid ? "🎉 내가 먹었다!!" : `😢 ${p ? p.nick : "?"}이(가) 가져감!`;
        c.wordEl.classList.add("tw-claimed");
      } else if (!cl) {
        c.wordEl.classList.remove("tw-claimed");
      }
    } else {
      if (c.activeIdx !== -1) {
        c.activeIdx = -1;
        c.wordEl.textContent = "…";
        c.subEl.textContent = "";
        c.cardEl.className = "tw-card sketch";
      }
    }
    // 내 점수 표시
    let pts = -2 * c.pen;
    for (const [i, cl] of Object.entries(claims)) {
      if (cl.u === ctx.uid && c.words[i]) pts += c.words[i].pts;
    }
    if (pts !== c.myPts) { c.myPts = pts; c.scoreEl.textContent = pts; }
  },

  async _checkInput(ctx, isEnter) {
    const c = this._c;
    const state = ctx.state();
    if (!c || !state) return;
    const words = this._schedule(ctx);
    const t = ctx.now() - state.startAt;
    const active = words.find(w => t >= w.at && t < w.at + w.ttl);
    const typed = c.input.value.trim();
    if (!typed) return;
    if (!active) { if (isEnter) c.input.value = ""; return; }

    if (typed === active.w) {
      c.input.value = "";
      if (active.type === "trap") {
        // 함정을 쳐버렸다!
        c.pen++;
        ctx.writeInput({ pen: c.pen });
        c.cardEl.classList.add("tw-shake");
        setTimeout(() => c.cardEl.classList.remove("tw-shake"), 500);
        sfx.wrong(); vibrate(200);
        c.subEl.textContent = "함정에 걸렸다!! -2점 😱";
        return;
      }
      // 선착순 클레임
      const res = await ctx.txn(`game/claims/${active.i}`, cur => (cur === null ? { u: ctx.uid, t: Date.now() } : undefined));
      if (res && res.committed && res.snapshot.val() && res.snapshot.val().u === ctx.uid) {
        sfx.coin(); if (active.type === "bonus") sfx.sparkle();
      } else {
        sfx.click();
      }
    } else if (isEnter) {
      // 오타 확정
      c.pen++;
      ctx.writeInput({ pen: c.pen });
      c.input.value = "";
      c.cardEl.classList.add("tw-shake");
      setTimeout(() => c.cardEl.classList.remove("tw-shake"), 500);
      sfx.wrong();
      c.subEl.textContent = "오타!! -2점 💦";
    }
  },

  onState() {},
  onInputs() {},
  onGame() {},
  hostEarlyEnd(ctx, inputs, state) {
    if (!state) return false;
    const words = this._c && this._c.words;
    if (!words) return false;
    const last = words[words.length - 1];
    if (ctx.now() - state.startAt > last.at + last.ttl + 1200) return 1500;
    return false;
  },
  evaluate(ctx, inputs, state) {
    inputs = inputs || {};
    const claims = (ctx.game().claims) || {};
    const words = state && state.seed !== undefined ? genWords(state.seed).words : [];
    const players = Object.keys(ctx.players());
    const score = {};
    for (const pid of players) score[pid] = -2 * ((inputs[pid] && inputs[pid].pen) || 0);
    for (const [i, cl] of Object.entries(claims)) {
      if (words[i] && score[cl.u] !== undefined) score[cl.u] += words[i].pts;
    }
    const participated = players.filter(p =>
      (inputs[p] && inputs[p].pen !== undefined) || Object.values(claims).some(cl => cl.u === p)
    ).sort((a, b) => score[b] - score[a]);
    return tierOutcome(ctx, participated, pid => score[pid] + "점", "멍때렸다… 💤");
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    this._c = null;
  }
};
// ═════════════════════════════════════════════
// 7. 폭탄 돌리기!
// ═════════════════════════════════════════════
const bomb = {
  id: "bomb",
  name: "폭탄 돌리기!",
  tag: "폭탄을 떠넘겨라! 터지면 아웃!",
  desc: "폭탄을 든 사람은 친구를 눌러서 폭탄을 넘겨! 💣<br>넘길수록 터질 확률이 <b>점점점점</b> 올라간다…<br>절반만 남을 때까지 반복! 끝까지 살아남으면 승리!",

  duration: () => 75000,
  hostSetup(ctx) {
    const ids = Object.keys(ctx.players());
    const holder = ids[Math.floor(Math.random() * ids.length)];
    return { holder, passCount: 0, out: null, tAssign: ctx.playStart, boom: null };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { map: {}, lastBoomKey: "", lastHolder: null };
    stage.innerHTML = `
      <div class="grab-field bomb-field" id="bombField">
        <div class="bomb-token" id="bombToken" style="display:none">💣</div>
        <div class="bomb-bang" id="bombBang" style="display:none">펑!!</div>
      </div>`;
    dock.innerHTML = `<div class="game-note" id="bombNote">폭탄이 누구에게…?</div>`;
    c.field = stage.querySelector("#bombField");
    c.token = stage.querySelector("#bombToken");
    c.bang = stage.querySelector("#bombBang");
    c.note = stage.querySelector("#bombNote");

    for (const [pid, p] of Object.entries(ctx.players())) {
      const el = makeChar({ color: ctx.colorOf(pid), nick: p.nick, size: 54 });
      if (pid === ctx.uid) {
        el.classList.add("me");
        const mk = document.createElement("div");
        mk.className = "you-mark"; mk.textContent = "▼ 나";
        el.appendChild(mk);
      }
      el.addEventListener("click", () => this._tryPass(ctx, pid));
      c.map[pid] = el;
      c.field.appendChild(el);
    }
    c.cleanupWin = circleLayout(c.field, c.map);
    c.stopLoop = gameLoop(() => this._render(ctx));
  },

  _alive(ctx, state) {
    const out = (state && state.out) || {};
    return Object.keys(ctx.players()).filter(id => !out[id]);
  },

  _tryPass(ctx, target) {
    const c = this._c;
    const state = ctx.state();
    if (!c || !state) return;
    const out = state.out || {};
    if (state.holder !== ctx.uid || out[target] || target === ctx.uid) return;
    sfx.swoosh();
    ctx.writeInput({ pass: target, k: state.tAssign });
  },

  _render(ctx) {
    const c = this._c;
    const state = ctx.state();
    if (!c || !state) return;
    const out = state.out || {};
    const iAmHolder = state.holder === ctx.uid && !out[ctx.uid];
    // 아웃 표시
    for (const [pid, el] of Object.entries(c.map)) {
      if (out[pid] && !el._out) {
        el._out = true;
        setFace(el, "dead"); setM(el, "caught");
        el.classList.remove("bomb-target");
      } else if (!out[pid]) {
        const targetable = iAmHolder && pid !== ctx.uid;
        el.classList.toggle("bomb-target", targetable);
      }
    }
    // 폭탄 토큰 위치
    const hEl = c.map[state.holder];
    if (hEl && c.lastHolder !== state.holder) {
      c.lastHolder = state.holder;
      c.token.style.display = "";
      c.token.style.left = hEl.style.left;
      c.token.style.top = `calc(${hEl.style.top} - 52px)`;
      sfx.fuse();
      if (state.holder === ctx.uid) vibrate(120);
    }
    // 확률/안내
    const p = Math.min(55, Math.round((0.01 + state.passCount * 0.045) * 100));
    const hp = ctx.players()[state.holder];
    c.note.innerHTML = iAmHolder
      ? `💣 <b>친구를 눌러서 넘겨!</b> 지금 터질 확률 <b style="color:var(--red)">${p}%</b>`
      : `💣 <b style="color:var(--pc, inherit)">${hp ? hp.nick : "?"}</b>이(가) 폭탄을 들고 있다… (터질 확률 ${p}%)`;
    // 폭발 연출
    const boomKey = state.boom ? state.boom.u + ":" + state.boom.at : "";
    if (state.boom && c.lastBoomKey !== boomKey) {
      c.lastBoomKey = boomKey;
      const vEl = c.map[state.boom.u];
      if (vEl) {
        c.bang.style.left = vEl.style.left;
        c.bang.style.top = vEl.style.top;
        c.bang.style.display = "";
        setTimeout(() => { if (c.bang) c.bang.style.display = "none"; }, 1300);
      }
      c.field.classList.add("flash");
      setTimeout(() => c.field && c.field.classList.remove("flash"), 600);
      sfx.boom(); vibrate(400);
    }
  },

  onState() {},
  onInputs() {},

  // 호스트: 패스 처리 + 봇/타임아웃 자동 패스
  hostTick(ctx, state, inputs) {
    if (!state || !state.holder) return;
    const players = ctx.players();
    const out = state.out || {};
    const alive = Object.keys(players).filter(id => !out[id]);
    if (alive.length <= Math.ceil(Object.keys(players).length / 2)) return; // 종료는 hostEarlyEnd가
    const holder = state.holder;
    const inp = inputs && inputs[holder];
    let target = null;
    if (inp && inp.pass && inp.k === state.tAssign && !out[inp.pass] && inp.pass !== holder && players[inp.pass]) {
      target = inp.pass;
    } else {
      // 봇이거나 너무 오래 들고 있으면 자동 패스
      const isBot = players[holder] && players[holder].bot;
      const limit = isBot ? 1700 : 8000;
      if (ctx.now() - (state.tAssign || 0) > limit) {
        const cands = alive.filter(id => id !== holder);
        target = cands[Math.floor(Math.random() * cands.length)];
      }
    }
    if (!target) return;
    const p = Math.min(0.55, 0.01 + state.passCount * 0.045);
    if (Math.random() < p) {
      // 펑!! 받는 사람 아웃
      const newOut = Object.assign({}, out); newOut[target] = 1;
      const survivors = alive.filter(id => id !== target);
      const nextHolder = survivors[Math.floor(Math.random() * survivors.length)];
      ctx.writeState({ out: newOut, boom: { u: target, at: ctx.now() }, holder: nextHolder, passCount: 0, tAssign: ctx.now() + 1800 });
    } else {
      ctx.writeState({ holder: target, passCount: state.passCount + 1, tAssign: ctx.now() });
    }
  },

  hostEarlyEnd(ctx, inputs, state) {
    if (!state) return false;
    const n = Object.keys(ctx.players()).length;
    const alive = this._aliveCount(ctx, state);
    return alive <= Math.ceil(n / 2) ? 2600 : false;
  },
  _aliveCount(ctx, state) {
    const out = (state && state.out) || {};
    return Object.keys(ctx.players()).filter(id => !out[id]).length;
  },
  evaluate(ctx, inputs, state) {
    const out = (state && state.out) || {};
    const outcome = {}, detail = {};
    for (const pid of Object.keys(ctx.players())) {
      if (out[pid]) { outcome[pid] = "lose"; detail[pid] = "펑!! 💥"; }
      else { outcome[pid] = "win"; detail[pid] = "생존! 🎉"; }
    }
    return { outcome, detail };
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    if (c.cleanupWin) c.cleanupWin();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 8. 최대한 빨리! (연타)
// ═════════════════════════════════════════════
const MASH_COUNT = 4200;
const MASH_DUR = 10000;

const mash = {
  id: "mash",
  name: "최대한 빨리!",
  tag: "그냥 눌러!!!!!!",
  desc: "카운트다운이 끝나면 <b>10초</b> 동안 버튼을 미친 듯이 연타!! 🔥<br>가장 많이 누른 <b>상위 30%는 +1</b> · 중간 30%는 <b>0</b> · 나머지는 <b>-1</b>!",

  stampOnTimeout: false,
  duration: () => MASH_COUNT + MASH_DUR + 2500,
  hostSetup(ctx) {
    return { startAt: ctx.playStart + MASH_COUNT };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { n: 0, lastCount: -1, started: false, ended: false, lastWrite: 0, map: {}, cntEls: {} };
    stage.innerHTML = `
      <div class="mash-top">
        <div class="mash-num" id="mashNum"></div>
        <div class="mash-my sketch alt" id="mashMy" style="display:none">내 연타: <b id="mashN">0</b></div>
      </div>
      <div class="char-field" id="mashField"></div>`;
    const field = stage.querySelector("#mashField");
    c.numEl = stage.querySelector("#mashNum");
    c.myEl = stage.querySelector("#mashMy");
    c.nEl = stage.querySelector("#mashN");
    for (const [pid, p] of Object.entries(ctx.players())) {
      const el = makeChar({ color: ctx.colorOf(pid), nick: p.nick, size: 50 });
      if (pid === ctx.uid) el.classList.add("me");
      const cnt = document.createElement("div");
      cnt.className = "mash-cnt";
      cnt.textContent = "0";
      el.appendChild(cnt);
      c.map[pid] = el;
      c.cntEls[pid] = cnt;
      field.appendChild(el);
    }
    const btn = actionBtn(dock, "준비…");
    btn.disabled = true;
    c.btn = btn;
    btn.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (!c.started || c.ended) return;
      c.n++;
      c.nEl.textContent = c.n;
      c.cntEls[ctx.uid].textContent = c.n;
      sfx.mash();
      const el = c.map[ctx.uid];
      el.classList.remove("mash-pop");
      void el.offsetWidth;
      el.classList.add("mash-pop");
      const t = ctx.now();
      if (t - c.lastWrite > 400) { c.lastWrite = t; ctx.writeInput({ n: c.n }); }
    });
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.startAt) return;
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount && n <= 3) {
        c.lastCount = n;
        c.numEl.textContent = n;
        c.numEl.classList.remove("fg-pop");
        void c.numEl.offsetWidth;
        c.numEl.classList.add("fg-pop");
        sfx.count(n);
      }
      return;
    }
    if (!c.started) {
      c.started = true;
      c.numEl.textContent = "고!!!";
      c.numEl.classList.remove("fg-pop");
      void c.numEl.offsetWidth;
      c.numEl.classList.add("fg-pop");
      c.myEl.style.display = "";
      c.btn.disabled = false;
      c.btn.textContent = "눌러!!!!!!";
      sfx.go();
      setTimeout(() => { if (c.numEl) c.numEl.textContent = ""; }, 1100);
    }
    if (!c.ended && t > state.startAt + MASH_DUR) {
      c.ended = true;
      c.btn.disabled = true;
      c.btn.textContent = "끝!! 손 떼!!";
      ctx.writeInput({ n: c.n });
      sfx.whistle();
    }
  },

  onState() {},
  onInputs(inputs, ctx) {
    const c = this._c;
    if (!c || !inputs) return;
    for (const [pid, v] of Object.entries(inputs)) {
      if (pid === ctx.uid) continue;
      const cnt = c.cntEls[pid];
      if (cnt && typeof v.n === "number" && cnt.textContent !== String(v.n)) {
        cnt.textContent = v.n;
        const el = c.map[pid];
        el.classList.remove("mash-pop");
        void el.offsetWidth;
        el.classList.add("mash-pop");
      }
    }
  },
  hostEarlyEnd(ctx, inputs, state) {
    if (state && state.startAt && ctx.now() > state.startAt + MASH_DUR + 900) return 1600;
    return false;
  },
  evaluate(ctx, inputs) {
    inputs = inputs || {};
    const players = Object.keys(ctx.players());
    const played = players.filter(p => inputs[p] && typeof inputs[p].n === "number" && inputs[p].n > 0)
      .sort((a, b) => inputs[b].n - inputs[a].n);
    return tierOutcome(ctx, played, pid => inputs[pid].n + "번!", "안 눌렀다… 💤");
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 9. 눈치.. 블록!
// ═════════════════════════════════════════════
const BLOCK_TILE_COLORS = ["#e64a3c", "#f07f2d", "#f7d02c", "#58b647", "#3a6fe0", "#8e57c9"];
const BLOCK_PICK_MS = 5000;
const BLOCK_REVEAL_MS = 5400;

const block = {
  id: "block",
  name: "눈치.. 블록!",
  tag: "어디가 가장 많을까..?",
  desc: "5초 안에 타일 하나를 <b>몰래</b> 골라! 🧱<br>두구두구… <b>가장 많은 사람이 모인 타일이 통째로 탈락!</b><br>타일이 하나씩 줄어들어… 40%만 남을 때까지! (안 고르면 바로 탈락)",

  duration: () => 82000,
  hostSetup(ctx) {
    const n = Object.keys(ctx.players()).length;
    return {
      sub: "pick", round: 1, tiles: 6, out: null,
      pickEnd: ctx.playStart + 1600 + BLOCK_PICK_MS,
      target: Math.max(1, Math.ceil(n * 0.4))
    };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { map: {}, myPick: -1, roundKey: "", revealKey: "", timers: [], gridBtns: [] };
    stage.innerHTML = `
      <div class="bk-wrap">
        <div class="bk-status" id="bkStatus">타일을 몰래 골라!</div>
        <div class="bk-grid" id="bkGrid"></div>
        <div class="bk-bench" id="bkBench"></div>
      </div>`;
    dock.innerHTML = `<div class="game-note">🧱 아무도 없을 것 같은 타일로! (남들 선택은 안 보여)</div>`;
    c.statusEl = stage.querySelector("#bkStatus");
    c.grid = stage.querySelector("#bkGrid");
    c.bench = stage.querySelector("#bkBench");
    for (const [pid, p] of Object.entries(ctx.players())) {
      const el = makeChar({ color: ctx.colorOf(pid), nick: p.nick, size: 44 });
      if (pid === ctx.uid) el.classList.add("me");
      c.map[pid] = el;
      c.bench.appendChild(el);
    }
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _renderTiles(ctx, k) {
    const c = this._c;
    c.grid.innerHTML = "";
    c.gridBtns = [];
    for (let i = 0; i < k; i++) {
      const b = document.createElement("button");
      b.className = "bk-tile";
      b.style.setProperty("--tc", BLOCK_TILE_COLORS[i]);
      b.innerHTML = `<div class="bk-slot"></div>`;
      b.addEventListener("click", () => {
        const state = ctx.state();
        const out = (state && state.out) || {};
        if (!state || state.sub !== "pick" || out[ctx.uid]) return;
        c.myPick = i;
        c.gridBtns.forEach((x, xi) => x.classList.toggle("bk-mine", xi === i));
        ctx.writeInput({ ["p" + state.round]: i });
        sfx.click();
      });
      c.grid.appendChild(b);
      c.gridBtns.push(b);
    }
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state) return;
    if (state.sub === "pick") {
      const remain = Math.max(0, Math.ceil((state.pickEnd - ctx.now()) / 1000));
      const out = state.out || {};
      c.statusEl.innerHTML = out[ctx.uid]
        ? `구경 중… 👀 (${remain}초)`
        : `몰래 골라! <b style="color:var(--red)">${remain}</b>초`;
    }
  },

  onState(state, ctx) {
    const c = this._c;
    if (!c || !state) return;
    const out = state.out || {};
    // 아웃된 캐릭터 표시
    for (const [pid, el] of Object.entries(c.map)) {
      if (out[pid] && !el._out) {
        el._out = true;
        setFace(el, "dead");
        el.style.opacity = 0.45;
      }
    }
    // 새 pick 라운드
    const rk = "pick:" + state.round;
    if (state.sub === "pick" && c.roundKey !== rk) {
      c.roundKey = rk;
      c.myPick = -1;
      this._renderTiles(ctx, state.tiles);
      // 전원 벤치로 복귀
      for (const [pid, el] of Object.entries(c.map)) c.bench.appendChild(el);
      if (state.round > 1) sfx.pop();
    }
    // 결과 공개
    if (state.sub === "reveal" && state.reveal && c.revealKey !== "rv:" + state.round) {
      c.revealKey = "rv:" + state.round;
      this._playReveal(ctx, state);
    }
  },

  _playReveal(ctx, state) {
    const c = this._c;
    const rv = state.reveal;
    c.statusEl.innerHTML = "결과는…?!";
    c.gridBtns.forEach(b => b.classList.remove("bk-mine"));
    playDrumroll();
    // 두구두구 후 캐릭터들이 타일 위로 빡!
    c.timers.push(setTimeout(() => {
      if (!this._c) return;
      const picks = rv.picks || {};
      let d = 0;
      for (const [pid, tile] of Object.entries(picks)) {
        const el = c.map[pid];
        const slot = c.gridBtns[tile] && c.gridBtns[tile].querySelector(".bk-slot");
        if (!el || !slot) continue;
        c.timers.push(setTimeout(() => {
          slot.appendChild(el);
          el.classList.remove("bk-land");
          void el.offsetWidth;
          el.classList.add("bk-land");
          sfx.thud();
        }, d));
        d += 140;
      }
      // 탈락 타일 공개
      c.timers.push(setTimeout(() => {
        if (!this._c) return;
        if (rv.tile < 0) {
          c.statusEl.innerHTML = "어라?! 아무도 안 터졌다! 세이프!";
          sfx.pop();
          return;
        }
        const tb = c.gridBtns[rv.tile];
        if (tb) tb.classList.add("bk-elim");
        sfx.buzz();
        for (const [pid, tile] of Object.entries(rv.picks || {})) {
          if (tile === rv.tile) {
            const el = c.map[pid];
            setFace(el, "dead");
            setM(el, "caught");
            el.style.opacity = 0.45;
          }
        }
        c.statusEl.innerHTML = "여기가 제일 많았다!! 💥";
      }, d + 900));
    }, 2100));
  },

  onInputs() {},
  hostTick(ctx, state, inputs) {
    if (!state || !state.sub) return;
    const players = ctx.players();
    const allIds = Object.keys(players);
    const out = state.out || {};
    const alive = allIds.filter(id => !out[id]);

    if (state.sub === "pick" && ctx.now() >= state.pickEnd + 400) {
      const picks = {};
      const newOut = Object.assign({}, out);
      for (const pid of alive) {
        const v = inputs && inputs[pid] && inputs[pid]["p" + state.round];
        if (typeof v === "number" && v >= 0 && v < state.tiles) picks[pid] = v;
        else newOut[pid] = 1; // 안 고르면 탈락
      }
      const counts = new Array(state.tiles).fill(0);
      for (const t of Object.values(picks)) counts[t]++;
      const maxN = Math.max(...counts, 0);
      let elimTile = -1;
      if (maxN > 0) {
        const cands = counts.map((n, i) => [n, i]).filter(([n]) => n === maxN).map(([, i]) => i);
        elimTile = cands[Math.floor(Math.random() * cands.length)];
        const wouldRemain = Object.entries(picks).filter(([, t]) => t !== elimTile).length;
        if (wouldRemain === 0 && Object.keys(picks).length > 1) {
          elimTile = -1; // 전원 몰살 방지 — 이번 판은 세이프
        } else {
          for (const [pid, t] of Object.entries(picks)) if (t === elimTile) newOut[pid] = 1;
        }
      }
      ctx.writeState({ sub: "reveal", reveal: { tile: elimTile, picks, at: ctx.now() }, out: newOut });
    } else if (state.sub === "reveal" && state.reveal && ctx.now() >= state.reveal.at + BLOCK_REVEAL_MS) {
      const aliveNow = allIds.filter(id => !(state.out || {})[id]);
      if (aliveNow.length <= state.target || aliveNow.length <= 1) {
        ctx.writeState({ sub: "done" });
      } else {
        ctx.writeState({
          sub: "pick",
          round: state.round + 1,
          tiles: Math.max(2, state.tiles - 1),
          pickEnd: ctx.now() + 1200 + BLOCK_PICK_MS,
          reveal: null
        });
      }
    }
  },
  hostEarlyEnd(ctx, inputs, state) {
    return state && state.sub === "done" ? 1600 : false;
  },
  evaluate(ctx, inputs, state) {
    const out = (state && state.out) || {};
    const outcome = {}, detail = {};
    for (const pid of Object.keys(ctx.players())) {
      if (out[pid]) { outcome[pid] = "lose"; detail[pid] = "블록과 함께 탈락… 🧱"; }
      else { outcome[pid] = "win"; detail[pid] = "생존! 🧱"; }
    }
    return { outcome, detail };
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    c.timers.forEach(clearTimeout);
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 10. 가라사대!
// ═════════════════════════════════════════════
const SIMON_START = 3000;
const SIMON_ROUND_MS = 2000;
const SIMON_DECIDE_MS = 1500;
const SIMON_ROUNDS = 9;
const SIMON_CMDS = [
  "박수 쳐!", "만세!", "점프해!", "손 들어!", "발 굴러!",
  "뒤로 돌아!", "눈 감아!", "브이!", "하이파이브!", "고개 끄덕!",
  "허리 숙여!", "제자리 뛰기!"
];

function genCommands(seed) {
  const rng = mulberry32(seed);
  const pool = SIMON_CMDS.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const rounds = [];
  let t = 1000;
  for (let i = 0; i < SIMON_ROUNDS; i++) {
    rounds.push({ i, cmd: pool[i], prefixed: rng() < 0.58, at: t, ttl: SIMON_DECIDE_MS });
    t += SIMON_ROUND_MS;
  }
  return { rounds, total: t };
}

const simon = {
  id: "simon",
  name: "가라사대!",
  tag: "선생님이 말씀하시면만 따라해!",
  desc: "명령 앞에 <b>'선생님이 말씀하시길'</b>이 붙으면 [따라하기!]를 눌러!<br>안 붙었는데 누르거나, 붙었는데 안 누르면 그 순간 탈락!<br>제일 오래 살아남은 사람이 승리!",

  duration: () => SIMON_START + SIMON_ROUNDS * SIMON_ROUND_MS + 2500,
  hostSetup(ctx) {
    return { seed: Math.floor(Math.random() * 1e9), startAt: ctx.playStart + SIMON_START };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { lastCount: -1, started: false, roundIdx: -1, answered: {}, resolved: {}, out: {}, map: {} };
    stage.innerHTML = `
      <div class="wa-top">
        <span class="sketch hud-chip">라운드 <b id="smRound">-</b>/${SIMON_ROUNDS}</span>
        <span class="wa-count" id="smCount"></span>
      </div>
      <div class="sm-card sketch" id="smCard">
        <div class="sm-prefix" id="smPrefix">선생님이 말씀하시길</div>
        <div class="sm-cmd" id="smCmd">준비…</div>
      </div>
      <div class="char-field" id="smField"></div>`;
    c.roundEl = stage.querySelector("#smRound");
    c.countEl = stage.querySelector("#smCount");
    c.card = stage.querySelector("#smCard");
    c.prefixEl = stage.querySelector("#smPrefix");
    c.cmdEl = stage.querySelector("#smCmd");
    const field = stage.querySelector("#smField");
    for (const [pid, p] of Object.entries(ctx.players())) {
      const el = makeChar({ color: ctx.colorOf(pid), nick: p.nick, size: 50 });
      if (pid === ctx.uid) el.classList.add("me");
      c.map[pid] = el;
      field.appendChild(el);
    }

    const btn = actionBtn(dock, "따라하기!");
    btn.disabled = true;
    c.btn = btn;
    btn.addEventListener("pointerdown", e => {
      e.preventDefault();
      const state = ctx.state();
      const sched = this._schedule(ctx);
      if (!state || !sched || c.out[ctx.uid]) return;
      const t = ctx.now() - state.startAt;
      const r = sched.rounds.find(x => t >= x.at && t < x.at + x.ttl);
      if (!r || c.answered[r.i]) return;
      c.answered[r.i] = true;
      ctx.writeInput({ ["r" + r.i]: 1 });
      this._localFeedback(r.prefixed);
    });

    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _schedule(ctx) {
    const c = this._c;
    const state = ctx.state();
    if (!c.sched && state && state.seed !== undefined) c.sched = genCommands(state.seed);
    return c.sched;
  },

  _localFeedback(ok) {
    const c = this._c;
    c.card.classList.remove("sm-ok", "sm-bad");
    void c.card.offsetWidth;
    c.card.classList.add(ok ? "sm-ok" : "sm-bad");
    (ok ? sfx.correct : sfx.wrong)();
    if (!ok) vibrate(200);
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.startAt) return;
    const sched = this._schedule(ctx);
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.countEl.textContent = n + "…"; sfx.beep(); }
      return;
    }
    if (!c.started) { c.started = true; c.btn.disabled = false; c.countEl.textContent = ""; sfx.go(); }
    if (!sched) return;
    const e = t - state.startAt;
    const r = sched.rounds.find(x => e >= x.at && e < x.at + x.ttl);
    if (r) {
      if (c.roundIdx !== r.i) {
        c.roundIdx = r.i;
        c.roundEl.textContent = r.i + 1;
        c.cmdEl.textContent = r.cmd;
        c.prefixEl.classList.toggle("show", r.prefixed);
        c.card.className = "sm-card sketch" + (r.prefixed ? " sm-armed" : "");
      }
    } else {
      const prev = c.roundIdx >= 0 ? sched.rounds[c.roundIdx] : null;
      if (prev && !c.resolved[prev.i] && e >= prev.at + prev.ttl) this._resolveRound(ctx, prev);
      if (c.cmdEl.textContent !== "…") {
        c.cmdEl.textContent = "…";
        c.prefixEl.classList.remove("show");
        c.card.className = "sm-card sketch";
      }
    }
  },

  _resolveRound(ctx, r) {
    const c = this._c;
    if (c.resolved[r.i]) return;
    c.resolved[r.i] = true;
    const inputs = ctx.inputs() || {};
    for (const pid of Object.keys(ctx.players())) {
      if (c.out[pid]) continue;
      const tapped = !!(inputs[pid] && inputs[pid]["r" + r.i]);
      if (tapped !== r.prefixed) {
        c.out[pid] = true;
        const el = c.map[pid];
        if (el) { setFace(el, "dead"); setM(el, "caught"); el.style.opacity = 0.4; }
      }
    }
  },

  onState() {},
  onInputs() {},
  hostEarlyEnd(ctx, inputs, state) {
    if (!state || !state.startAt) return false;
    const sched = this._c && this._c.sched;
    if (!sched) return false;
    const last = sched.rounds[sched.rounds.length - 1];
    if (ctx.now() - state.startAt > last.at + last.ttl + 900) return 1400;
    return false;
  },
  evaluate(ctx, inputs, state) {
    inputs = inputs || {};
    const sched = genCommands(state && state.seed !== undefined ? state.seed : 0);
    const players = Object.keys(ctx.players());
    const survived = {};
    for (const pid of players) {
      let s = 0;
      for (const r of sched.rounds) {
        const tapped = !!(inputs[pid] && inputs[pid]["r" + r.i]);
        if (tapped !== r.prefixed) break;
        s++;
      }
      survived[pid] = s;
    }
    const ranked = players.slice().sort((a, b) => survived[b] - survived[a]);
    return tierOutcome(ctx, ranked,
      pid => survived[pid] >= SIMON_ROUNDS ? "완벽 클리어! 🎉" : `${survived[pid]}/${SIMON_ROUNDS}에서 실수`,
      "안 움직였다… 💤");
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 11. 줄다리기!
// ═════════════════════════════════════════════
const TUG_LEAD = 3000;
const TUG_DUR = 15000;
const TUG_WIN = 100;
const TUG_SCALE = 1.4;

const tug = {
  id: "tug",
  name: "줄다리기!",
  tag: "우리 팀이 이길 때까지 당겨랏!",
  desc: "팀을 나눠서 [당겨라!]를 미친 듯이 연타!<br>줄이 우리 쪽 끝까지 넘어오거나, 15초 뒤 더 많이 당긴 팀이 승리!<br>인원이 홀수면 한 명은 깍두기 — 구경만 하고 점수도 없어!",

  duration: () => TUG_LEAD + TUG_DUR + 3000,
  hostSetup(ctx) {
    const ids = shuffle(Object.keys(ctx.players()));
    let spare = null;
    if (ids.length % 2 === 1) spare = ids.pop();
    const half = ids.length / 2;
    return {
      teamA: ids.slice(0, half), teamB: ids.slice(half), spare,
      rope: 0, winner: null, startAt: ctx.playStart + TUG_LEAD
    };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { lastCount: -1, started: false, n: 0, lastWrite: 0, map: {}, lastRope: null, layoutDone: false, dock };
    stage.innerHTML = `
      <div class="tug-wrap">
        <div class="tug-status" id="tugStatus">3</div>
        <div class="tug-arena">
          <div class="tug-team tug-a" id="tugTeamA"></div>
          <div class="tug-track">
            <div class="tug-zone tug-zone-a"></div>
            <div class="tug-zone tug-zone-b"></div>
            <div class="tug-rope-line"></div>
            <div class="tug-knot" id="tugKnot">🔴</div>
          </div>
          <div class="tug-team tug-b" id="tugTeamB"></div>
        </div>
      </div>`;
    c.statusEl = stage.querySelector("#tugStatus");
    c.knot = stage.querySelector("#tugKnot");
    c.fieldA = stage.querySelector("#tugTeamA");
    c.fieldB = stage.querySelector("#tugTeamB");
    this._layout(ctx);
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  // 팀 배정은 호스트가 게임 시작 시 정하는 값(state.teamA/B)이라 mount 시점엔
  // 아직 Firebase에서 안 왔을 수 있음 — onState에서 재시도 (무궁화의 _layout과 동일 패턴)
  _layout(ctx) {
    const c = this._c;
    if (!c || c.layoutDone) return;
    const state = ctx.state();
    if (!state || !state.teamA) return;
    c.layoutDone = true;
    const teamA = state.teamA, teamB = state.teamB || [], spare = state.spare;
    const players = ctx.players();
    for (const pid of teamA) {
      const el = makeChar({ color: "#e0472f", nick: players[pid] ? players[pid].nick : "?", size: 50 });
      if (pid === ctx.uid) el.classList.add("me");
      c.map[pid] = el; c.fieldA.appendChild(el);
    }
    for (const pid of teamB) {
      const el = makeChar({ color: "#3b6fd4", nick: players[pid] ? players[pid].nick : "?", size: 50 });
      if (pid === ctx.uid) el.classList.add("me");
      c.map[pid] = el; c.fieldB.appendChild(el);
    }
    if (spare === ctx.uid) {
      c.dock.innerHTML = `<div class="game-note">🍢 이번 판은 깍두기! 구경만 해도 괜찮아~</div>`;
    } else {
      const btn = actionBtn(c.dock, "당겨라!");
      btn.disabled = true;
      c.btn = btn;
      btn.addEventListener("pointerdown", e => {
        e.preventDefault();
        if (btn.disabled) return;
        c.n++;
        sfx.mash();
        const el = c.map[ctx.uid];
        if (el) { el.classList.remove("tug-pull"); void el.offsetWidth; el.classList.add("tug-pull"); }
        const t = ctx.now();
        if (t - c.lastWrite > 220) { c.lastWrite = t; ctx.writeInput({ n: c.n }); }
      });
    }
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    this._layout(ctx);
    const state = ctx.state();
    if (!state || !state.startAt) return;
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.statusEl.textContent = n; sfx.beep(); }
      return;
    }
    if (!c.started) {
      c.started = true;
      c.statusEl.textContent = "당겨라!!";
      if (c.btn) c.btn.disabled = false;
      sfx.go();
      setTimeout(() => { if (c.statusEl) c.statusEl.textContent = ""; }, 900);
    }
    const rope = state.rope || 0;
    if (rope !== c.lastRope) {
      c.lastRope = rope;
      c.knot.style.left = (50 + rope * 0.4) + "%";
    }
  },

  onState(state, ctx) { this._layout(ctx); },
  onInputs(inputs, ctx) {
    const c = this._c;
    if (!c || !inputs) return;
    this._layout(ctx);
    for (const [pid, v] of Object.entries(inputs)) {
      if (pid === ctx.uid) continue;
      const el = c.map[pid];
      if (!el || typeof v.n !== "number") continue;
      if (el._lastN !== v.n) {
        el._lastN = v.n;
        el.classList.remove("tug-pull");
        void el.offsetWidth;
        el.classList.add("tug-pull");
      }
    }
  },

  // 호스트: 매 틱 팀별 연타 합산 → 줄 위치 갱신 (경계 넘으면 즉시 승부 확정)
  hostTick(ctx, state, inputs) {
    if (!state || !state.startAt || state.winner) return;
    const t = ctx.now();
    if (t < state.startAt) return;
    inputs = inputs || {};
    const sum = ids => ids.reduce((s, pid) => s + ((inputs[pid] && inputs[pid].n) || 0), 0);
    const a = sum(state.teamA || []), b = sum(state.teamB || []);
    const rope = Math.max(-TUG_WIN, Math.min(TUG_WIN, Math.round((b - a) * TUG_SCALE)));
    if (rope === state.rope) return;
    const patch = { rope };
    if (Math.abs(rope) >= TUG_WIN) patch.winner = rope < 0 ? "A" : "B";
    ctx.writeState(patch);
  },
  hostEarlyEnd(ctx, inputs, state) {
    if (!state || !state.startAt) return false;
    const t = ctx.now();
    if (t < state.startAt) return false;
    if (state.winner) return 1800;
    if (t - state.startAt > TUG_DUR) return 1200;
    return false;
  },
  evaluate(ctx, inputs, state) {
    state = state || {};
    const teamA = state.teamA || [], teamB = state.teamB || [];
    const rope = state.rope || 0;
    const winner = state.winner || (rope < 0 ? "A" : rope > 0 ? "B" : null);
    const outcome = {}, detail = {};
    for (const pid of teamA) {
      outcome[pid] = winner === null ? "mid" : winner === "A" ? "win" : "lose";
      detail[pid] = winner === null ? "무승부! (±0)" : winner === "A" ? "우리 팀 승리! 🏆" : "졌다… 😢";
    }
    for (const pid of teamB) {
      outcome[pid] = winner === null ? "mid" : winner === "B" ? "win" : "lose";
      detail[pid] = winner === null ? "무승부! (±0)" : winner === "B" ? "우리 팀 승리! 🏆" : "졌다… 😢";
    }
    if (state.spare) { outcome[state.spare] = "mid"; detail[state.spare] = "깍두기 (구경만 함)"; }
    return { outcome, detail };
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 12. 조심히 깨우기!
// ═════════════════════════════════════════════
const WAKE_LEAD = 3000;
const WAKE_SWING_PERIOD = 900;
const WAKE_TURN_GAP = 700;
const WAKE_AUTO_MS = 3000;
const WAKE_MAX_TURNS = 20;
const WAKE_ZONE_STACK = { green: 1, orange: 2, red: 4 };

/** 바늘이 좌우로 왕복하는 위치 (0~100), 순수 시간의 함수라 모든 클라이언트가 동일하게 봄 */
function wakeSwingPos(elapsed) {
  const phase = ((elapsed % WAKE_SWING_PERIOD) + WAKE_SWING_PERIOD) % WAKE_SWING_PERIOD / WAKE_SWING_PERIOD;
  return (phase < 0.5 ? phase * 2 : 2 - phase * 2) * 100;
}
function wakeZoneAt(pos) {
  if (pos < 12 || pos > 88) return "red";
  if (pos < 32 || pos > 68) return "orange";
  return "green";
}

const wake = {
  id: "wake",
  name: "조심히 깨우기!",
  tag: "들개를 깨우지 마…!",
  desc: "차례가 오면 좌우로 왔다갔다하는 바늘을 [탁!]으로 멈춰!<br>초록은 조금, 주황은 좀 더, 빨강은 많이 — 들개한테 스택이 쌓여!<br>스택이 (매판 랜덤인) 한계를 넘으면 들개가 깨서 그 순간 멈춘 사람이 탈락!",

  duration: () => WAKE_LEAD + WAKE_MAX_TURNS * (WAKE_AUTO_MS + WAKE_TURN_GAP) + 3000,
  hostSetup(ctx) {
    const order = shuffle(Object.keys(ctx.players()));
    const threshold = 8 + Math.floor(Math.random() * 9); // 8~16
    return {
      order, turn: 0, stack: 0, threshold, out: null, awake: false, done: false,
      turnsTaken: 0, lastZone: null, turnStartAt: ctx.playStart + WAKE_LEAD
    };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { map: {}, lastTurn: -1, lastTurnStartAt: 0, answered: {}, wokeShown: false, lastStackShown: undefined, layoutDone: false };
    stage.innerHTML = `
      <div class="wk-wrap">
        <div class="wk-dog" id="wkDog">🐶<span class="wk-zzz">💤</span></div>
        <div class="wk-meter"><div class="wk-meter-fill" id="wkMeterFill"></div></div>
        <div class="wk-status" id="wkStatus">순서 정하는 중…</div>
        <div class="wk-bar" id="wkBar">
          <div class="wk-seg wk-red" style="left:0%;width:12%"></div>
          <div class="wk-seg wk-orange" style="left:12%;width:20%"></div>
          <div class="wk-seg wk-green" style="left:32%;width:36%"></div>
          <div class="wk-seg wk-orange" style="left:68%;width:20%"></div>
          <div class="wk-seg wk-red" style="left:88%;width:12%"></div>
          <div class="wk-needle" id="wkNeedle"></div>
        </div>
        <div class="wk-order" id="wkOrder"></div>
      </div>`;
    c.dog = stage.querySelector("#wkDog");
    c.meterFill = stage.querySelector("#wkMeterFill");
    c.statusEl = stage.querySelector("#wkStatus");
    c.bar = stage.querySelector("#wkBar");
    c.needle = stage.querySelector("#wkNeedle");
    c.orderRow = stage.querySelector("#wkOrder");

    const btn = actionBtn(dock, "탁!");
    btn.disabled = true;
    c.btn = btn;
    const tap = e => { e.preventDefault(); this._tryStop(ctx); };
    btn.addEventListener("pointerdown", tap);
    c.bar.addEventListener("pointerdown", tap);

    this._layout(ctx);
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  // 차례 순서(state.order)는 호스트가 정하는 값이라 mount 시점엔 아직 안 왔을 수
  // 있음 — onState에서 재시도 (무궁화의 _layout과 동일 패턴)
  _layout(ctx) {
    const c = this._c;
    if (!c || c.layoutDone) return;
    const state = ctx.state();
    if (!state || !state.order || !state.order.length) return;
    c.layoutDone = true;
    const players = ctx.players();
    for (const pid of state.order) {
      const el = makeChar({ color: ctx.colorOf(pid), nick: players[pid] ? players[pid].nick : "?", size: 40 });
      if (pid === ctx.uid) el.classList.add("me");
      c.map[pid] = el;
      c.orderRow.appendChild(el);
    }
  },

  _tryStop(ctx) {
    const c = this._c;
    const state = ctx.state();
    if (!c || !state || state.awake || state.done || !state.order || !state.order.length) return;
    if (state.order[state.turn % state.order.length] !== ctx.uid) return;
    if (c.answered[state.turnStartAt]) return;
    c.answered[state.turnStartAt] = true;
    const pos = wakeSwingPos(ctx.now() - state.turnStartAt);
    ctx.writeInput({ pos: Math.round(pos * 10) / 10, turnKey: state.turnStartAt });
    sfx.click();
    if (c.btn) c.btn.disabled = true;
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    this._layout(ctx);
    const state = ctx.state();
    if (!state || !state.turnStartAt || !state.order || !state.order.length) return;
    const t = ctx.now();
    if (t < state.turnStartAt && c.lastTurn === -1) {
      const n = Math.ceil((state.turnStartAt - t) / 1000);
      this._setStatus(`잠시 후 시작… ${n}`);
      return;
    }
    if (state.awake || state.done) {
      c.needle.style.opacity = 0;
      this._setStatus(state.awake ? "들개가 깼다!! 😱" : "다들 무사히 살아남았다! 🎉");
      return;
    }
    const activePid = state.order[state.turn % state.order.length];
    const iAmActive = activePid === ctx.uid;
    if (c.lastTurn !== state.turn || c.lastTurnStartAt !== state.turnStartAt) {
      c.lastTurn = state.turn; c.lastTurnStartAt = state.turnStartAt;
      c.answered = {};
      if (c.btn) c.btn.disabled = !iAmActive;
      [...c.orderRow.children].forEach((el, i) => el.classList.toggle("wk-active", state.order[i] === activePid));
      const nick = (ctx.players()[activePid] || {}).nick || "?";
      this._setStatus(iAmActive ? "내 차례! 안전한 곳에서 멈춰!" : `${nick}의 차례…`);
      sfx.pop();
    }
    c.meterFill.style.width = Math.min(100, (state.stack / (WAKE_MAX_TURNS * WAKE_ZONE_STACK.green)) * 100) + "%";
    if (t >= state.turnStartAt) {
      c.needle.style.opacity = 1;
      c.needle.style.left = wakeSwingPos(t - state.turnStartAt) + "%";
    }
  },

  _setStatus(text) {
    const c = this._c;
    if (c && c.statusEl && c.statusEl.textContent !== text) c.statusEl.textContent = text;
  },

  onState(state, ctx) {
    const c = this._c;
    if (!c || !state) return;
    this._layout(ctx);
    if (typeof state.stack === "number" && c.lastStackShown !== state.stack) {
      c.lastStackShown = state.stack;
      if (state.lastZone) this._flashZone(state.lastZone);
    }
    if (state.awake && !c.wokeShown) {
      c.wokeShown = true;
      c.dog.classList.add("wk-awake");
      sfx.buzz(); vibrate(300);
      const loser = state.order[state.turn % state.order.length];
      const el = c.map[loser];
      if (el) { setFace(el, "dead"); setMotion(el, "caught"); charSay(el, "으악!!", 2000); }
    }
  },
  onInputs() {},

  _flashZone(zone) {
    const c = this._c;
    if (!c || !c.bar) return;
    c.bar.classList.remove("wk-flash-green", "wk-flash-orange", "wk-flash-red");
    void c.bar.offsetWidth;
    c.bar.classList.add("wk-flash-" + zone);
    (zone === "red" ? sfx.wrong : zone === "orange" ? sfx.beep : sfx.correct)();
  },

  // 호스트: 현재 차례인 사람의 입력(또는 타임아웃 시 자동)을 처리 → 스택 갱신, 넘으면 각성
  hostTick(ctx, state, inputs) {
    if (!state || !state.turnStartAt || state.awake || state.done || !state.order || !state.order.length) return;
    const t = ctx.now();
    if (t < state.turnStartAt) return;
    const order = state.order;
    const activePid = order[state.turn % order.length];
    inputs = inputs || {};
    const inp = inputs[activePid];
    let pos = null;
    if (inp && typeof inp.pos === "number" && inp.turnKey === state.turnStartAt) {
      pos = inp.pos;
    } else if (t - state.turnStartAt > WAKE_AUTO_MS) {
      pos = Math.random() * 100; // 너무 오래 끌면 자동으로 아무 데나 멈춤
    }
    if (pos === null) return;
    const zone = wakeZoneAt(pos);
    const stack = state.stack + WAKE_ZONE_STACK[zone];
    if (stack > state.threshold) {
      ctx.writeState({ stack, awake: true, lastZone: zone, out: Object.assign({}, state.out, { [activePid]: 1 }) });
      return;
    }
    const turnsTaken = (state.turnsTaken || 0) + 1;
    if (turnsTaken >= WAKE_MAX_TURNS) {
      ctx.writeState({ stack, done: true, lastZone: zone, turnsTaken });
      return;
    }
    ctx.writeState({ stack, turn: state.turn + 1, turnsTaken, lastZone: zone, turnStartAt: ctx.now() + WAKE_TURN_GAP });
  },
  hostEarlyEnd(ctx, inputs, state) {
    if (!state) return false;
    if (state.awake) return 2400;
    if (state.done) return 1400;
    return false;
  },
  evaluate(ctx, inputs, state) {
    const out = (state && state.out) || {};
    const outcome = {}, detail = {};
    for (const pid of Object.keys(ctx.players())) {
      if (out[pid]) { outcome[pid] = "lose"; detail[pid] = "들개를 깨워버렸다… 😱"; }
      else { outcome[pid] = "win"; detail[pid] = "무사히 통과! 🐶💤"; }
    }
    return { outcome, detail };
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    this._c = null;
  }
};

export const GAME_IDS = ["nunchi", "mugunghwa", "grab", "choseki", "whack", "typing", "bomb", "mash", "block", "simon", "tug", "wake"];
export const GAMES = { nunchi, mugunghwa, grab, choseki, whack, typing, bomb, mash, block, simon, tug, wake };
