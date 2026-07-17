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
import { sfx, playDrumroll, cdTick, gameStartFx, loadUrlBuffer, decodeB64Audio, playBuffer } from "./sfx.js";

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
  tag: "10초 안에 눈치를 발휘해라!",
  desc: "아무도 안 누를 때 <b>혼자</b> [외치기!]를 눌러야 성공!<br>누군가와 동시에(0.5초 안에) 누르면 같이 누른 사람 전부 탈락.<br>누가 언제 눌렀는지는 결과에서 공개! 끝까지 안 누르면 탈락이야! 👀",
  WINDOW: 500,

  duration: () => 10000,
  hostSetup: () => ({ on: true }),

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { pressed: false, timers: [] };
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
    gameStartFx();
  },
  onState() {},
  // 다른 사람이 언제 눌렀는지는 결과 전까지 비밀 — 실시간 표시 없음
  onInputs() {},
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
// 술래는 단어 하나씩 3번에 나눠서 글자를 맞춘다: 무궁화 → 꽃이 → 피었습니다
const MG_WORDS = [["무", "궁", "화"], ["꽃", "이"], ["피", "었", "습", "니", "다"]];
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
  desc: "술래가 글자를 외치는 동안 [전진!]을 꾹 눌러 달려!<br>술래가 돌아보는 순간 움직이면 잡힌다!! 🚨<br>빨간 선을 넘으면 성공! 술래는 <b>무궁화→꽃이→피었습니다</b> 순서로 글자를 맞춰!",

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
      cycle: null, cycleTimers: [], order: [], progress: 0, wordIdx: 0, rouletteDone: false,
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
        <div class="dk-timer" id="dkHint">단어 하나씩! 순서대로 글자를 눌러서 완성해!</div>
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
    // 돌아본 직후 600ms는 유예 — 네트워크 지연으로 억울하게 잡히는 것 방지
    const inLook = cy && cy.mode === "look" && nowT >= cy.start + 600 && nowT <= cy.end;

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
      c.myX = Math.min(100, c.myX + dt * 8);
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
      gameStartFx();
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

  // ── 술래 전용: 글자 사이클 관리 (단어 하나씩 3번) ──
  _taggerStartDark(ctx) {
    const c = this._c;
    if (!c) return;
    const remain = ctx.playEnd - ctx.now();
    if (remain < 2600) return;
    c.wordIdx = 0;
    c.progress = 0;
    c.order = shuffle(MG_WORDS[0].map((s, i) => i));
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
    // dark: 진행 상태 + 현재 단어의 셔플 칩
    hint.textContent = "단어 하나씩! 순서대로 글자를 눌러서 완성해!";
    this._renderProgress();
    this._renderChips(ctx);
  },

  _renderChips(ctx) {
    const c = this._c;
    c.chipsEl.innerHTML = "";
    for (const si of c.order) {
      const b = document.createElement("button");
      b.className = "mg-chip";
      b.textContent = MG_WORDS[c.wordIdx][si];
      b.addEventListener("click", () => this._chipClick(ctx, si, b));
      c.chipsEl.appendChild(b);
    }
  },

  _renderProgress() {
    const c = this._c;
    // 완성한 단어들 + 현재 단어에서 맞춘 글자 수 = 전체 진행도
    let done = c.progress;
    for (let w = 0; w < c.wordIdx; w++) done += MG_WORDS[w].length;
    let html = "";
    let k = 0;
    for (const ch of SENTENCE) {
      if (ch === " ") { html += "&nbsp;"; continue; }
      html += `<span class="${k < done ? "done-syl" : "todo-syl"}">${ch}</span>`;
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
      if (c.progress >= MG_WORDS[c.wordIdx].length) {
        if (c.wordIdx < MG_WORDS.length - 1) {
          // 다음 단어로 — 칩을 새로 섞어서 배치
          c.wordIdx++;
          c.progress = 0;
          c.order = shuffle(MG_WORDS[c.wordIdx].map((s, i) => i));
          sfx.pop();
          this._renderProgress();
          this._renderChips(ctx);
          return;
        }
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
      c.wordIdx = 0;
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
      if (n !== c.lastCount) { c.lastCount = n; c.msg.className = "grab-count"; c.msg.textContent = n; cdTick(); }
    } else if (t < state.signalAt) {
      if (c.msg.textContent !== "・・・") { c.msg.className = "grab-wait"; c.msg.textContent = "・・・"; gameStartFx(); }
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
      if (n !== c.lastCount) { c.lastCount = n; c.clock.textContent = n; cdTick(); }
      return;
    }
    if (!c.started) {
      c.started = true;
      c.btn.disabled = c.pressed;
      gameStartFx();
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

/** 시드로 두더지 스케줄 생성 — 모든 플레이어가 같은 두더지를 본다 (봇 구동용으로 export) */
export function genMoles(seed) {
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

/** 두더지 점수 집계: claims(선착순 클레임)에서 플레이어별 합산 */
function whackScores(ctx, state) {
  const claims = (ctx.game().claims) || {};
  const events = state && state.seed !== undefined ? genMoles(state.seed) : [];
  const byIdx = {};
  for (const ev of events) byIdx[ev.i] = ev;
  const score = {};
  for (const pid of Object.keys(ctx.players())) score[pid] = 0;
  for (const [i, cl] of Object.entries(claims)) {
    if (!cl || score[cl.u] === undefined) continue;
    const ev = byIdx[i];
    if (ev) score[cl.u] += WHACK_PTS[ev.type];
  }
  return score;
}

const whack = {
  id: "whack",
  name: "두더지 잡기!",
  tag: "제일 빨리 잡는 사람이 임자!",
  desc: "모두가 <b>같은 두더지</b>를 봐! 제일 빨리 탭한 <b>한 명만</b> 점수를 가져가 🔨<br>일반 <b>+1</b> · 황금 <b>+3</b> (금방 숨어!) · 폭탄은 누른 사람만 <b>-2</b>!<br>점수가 높은 상위 30%가 승리!",

  stampOnTimeout: false, // 타이머 종료가 정상 종료인 게임
  duration: () => WHACK_START + WHACK_DUR + 2500,
  hostSetup(ctx) {
    return { seed: Math.floor(Math.random() * 1e9), startAt: ctx.playStart + WHACK_START };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { lastCount: -1, started: false, moleEls: {}, claimShown: {}, myScore: 0 };
    stage.innerHTML = `
      <div class="wa-top">
        <span class="sketch hud-chip">내 점수: <b id="waScore">0</b>점</span>
        <span class="wa-count" id="waCount"></span>
      </div>
      <div class="wa-board" id="waBoard">
        ${[0, 1, 2, 3, 4, 5].map(i => `<div class="wa-hole" data-hole="${i}"><div class="wa-dirt"></div></div>`).join("")}
      </div>`;
    dock.innerHTML = `<div class="game-note">🔨 다른 친구보다 빨리 탭해야 점수! (폭탄은 누르지 마!)</div>`;
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
      if (n !== c.lastCount) { c.lastCount = n; c.countEl.textContent = n + "…"; cdTick(); }
      return;
    }
    if (!c.started) { c.started = true; c.countEl.textContent = "잡아라!!"; gameStartFx(); setTimeout(() => { if (c.countEl) c.countEl.textContent = ""; }, 900); }
    const e = t - state.startAt;
    const claims = (ctx.game().claims) || {};
    for (const ev of c.events) {
      const el = c.moleEls[ev.i];
      const cl = claims[ev.i];
      // 누군가 잡은 두더지: 모두의 화면에서 획득 연출 후 제거
      if (cl && !c.claimShown[ev.i]) {
        c.claimShown[ev.i] = true;
        if (el) this._showClaim(ctx, ev, el, cl);
        continue;
      }
      const active = e >= ev.at && e < ev.at + ev.ttl && !cl;
      if (active && !el) this._spawnMole(ctx, ev);
      else if (!active && el && !c.claimShown[ev.i]) { el.remove(); delete c.moleEls[ev.i]; }
    }
    // 내 점수 = 내가 클레임한 두더지들의 합
    const myScore = whackScores(ctx, state)[ctx.uid] || 0;
    if (myScore !== c.myScore) { c.myScore = myScore; c.scoreEl.textContent = myScore; }
  },

  _showClaim(ctx, ev, el, cl) {
    const c = this._c;
    const mine = cl.u === ctx.uid;
    const p = ctx.players()[cl.u];
    if (ev.type === "bomb") { if (mine) { sfx.buzz(); vibrate(180); } el.classList.add("wa-boomhit"); }
    else if (ev.type === "gold") { sfx.coin(); if (mine) sfx.sparkle(); el.classList.add("wa-bonked"); }
    else { sfx.bonk(); el.classList.add("wa-bonked"); }
    const pop = document.createElement("div");
    pop.className = "plusone" + (WHACK_PTS[ev.type] < 0 ? " minusone" : "");
    pop.textContent = `${mine ? "나" : (p ? p.nick : "?")} ${WHACK_PTS[ev.type] > 0 ? "+" : ""}${WHACK_PTS[ev.type]}`;
    el.appendChild(pop);
    setTimeout(() => { el.remove(); delete c.moleEls[ev.i]; }, 500);
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
      const claims = (ctx.game().claims) || {};
      if (claims[ev.i] || c.claimShown[ev.i]) return;
      // 선착순 클레임 — 제일 빨리 누른 한 명만 점수 (폭탄이면 감점도 그 한 명만)
      ctx.txn(`game/claims/${ev.i}`, cur => (cur === null ? { u: ctx.uid, t: Date.now() } : undefined)).catch(() => {});
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
  evaluate(ctx, inputs, state) {
    const score = whackScores(ctx, state);
    const players = Object.keys(ctx.players());
    const ranked = players.slice().sort((a, b) => score[b] - score[a]);
    return tierOutcome(ctx, ranked, pid => score[pid] + "점", "멍때렸다… 💤");
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
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
      if (n !== c.lastCount) { c.lastCount = n; c.countEl.textContent = n + "…"; cdTick(); }
      return;
    }
    if (!c.started) { c.started = true; c.input.disabled = false; c.input.focus(); gameStartFx(); c.countEl.textContent = ""; }
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
      // 클레임 표시는 소유자가 바뀔 때마다 갱신 — 트랜잭션이 로컬에 먼저 낙관 적용됐다가
      // 서버에서 다른 사람 승리로 뒤집히는 경우 "내가 먹었다" 오표시가 남지 않게
      const cl = claims[active.i];
      const owner = cl ? cl.u : null;
      if (c.claimedShown[active.i] !== owner) {
        c.claimedShown[active.i] = owner;
        if (owner) {
          const p = ctx.players()[owner];
          c.subEl.textContent = owner === ctx.uid ? "🎉 내가 먹었다!!" : `😢 ${p ? p.nick : "?"}이(가) 가져감!`;
          c.wordEl.classList.add("tw-claimed");
        } else {
          c.wordEl.classList.remove("tw-claimed");
        }
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
        cdTick();
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
      gameStartFx();
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
    gameStartFx();
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
// 10. 줄다리기!
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
      if (n !== c.lastCount) { c.lastCount = n; c.statusEl.textContent = n; cdTick(); }
      return;
    }
    if (!c.started) {
      c.started = true;
      c.statusEl.textContent = "당겨라!!";
      if (c.btn) c.btn.disabled = false;
      gameStartFx();
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
// 11. 조심히 깨우기!
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
    const c = this._c = { map: {}, lastTurn: -1, lastTurnStartAt: 0, answered: {}, wokeShown: false, lastStackShown: undefined, layoutDone: false, freezeKey: 0, freezePos: null };
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

  /**
   * 멈춘 위치를 게임 상태에 직접 트랜잭션으로 적용.
   * 방장 릴레이를 안 거치므로 방장이 아니어도 지연 없이 판정된다.
   * turnKey(턴 시작 시각) 검증으로 같은 턴이 두 번 처리될 수 없음.
   */
  _applyStop(ctx, pid, pos, turnKey) {
    return ctx.txn("game/state", cur => {
      if (!cur || cur.awake || cur.done || !cur.order || !cur.order.length) return;
      if (cur.turnStartAt !== turnKey) return; // 이미 처리된 턴
      if (cur.order[cur.turn % cur.order.length] !== pid) return;
      const zone = wakeZoneAt(pos);
      const stack = cur.stack + WAKE_ZONE_STACK[zone];
      if (stack > cur.threshold) {
        return Object.assign({}, cur, {
          stack, lastZone: zone, awake: true,
          out: Object.assign({}, cur.out, { [pid]: 1 })
        });
      }
      const turnsTaken = (cur.turnsTaken || 0) + 1;
      if (turnsTaken >= WAKE_MAX_TURNS) {
        return Object.assign({}, cur, { stack, lastZone: zone, done: true, turnsTaken });
      }
      return Object.assign({}, cur, {
        stack, lastZone: zone, turn: cur.turn + 1, turnsTaken,
        turnStartAt: ctx.now() + WAKE_TURN_GAP
      });
    });
  },

  _tryStop(ctx) {
    const c = this._c;
    const state = ctx.state();
    if (!c || !state || state.awake || state.done || !state.order || !state.order.length) return;
    if (state.order[state.turn % state.order.length] !== ctx.uid) return;
    if (c.answered[state.turnStartAt]) return;
    c.answered[state.turnStartAt] = true;
    const pos = Math.round(wakeSwingPos(ctx.now() - state.turnStartAt) * 10) / 10;
    // 즉각 로컬 피드백: 바늘을 그 자리에 바로 멈춤 (판정 결과는 트랜잭션으로 공유)
    c.freezeKey = state.turnStartAt;
    c.freezePos = pos;
    sfx.click();
    if (c.btn) c.btn.disabled = true;
    ctx.writeInput({ pos, turnKey: state.turnStartAt }); // 예비 경로 (방장 릴레이)
    this._applyStop(ctx, ctx.uid, pos, state.turnStartAt).catch(() => {});
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
      if (n !== c.cdLast) { c.cdLast = n; cdTick(); }
      this._setStatus(`잠시 후 시작… ${n}`);
      return;
    }
    if (!c.started) { c.started = true; gameStartFx(); }
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
      // 내가 멈췄으면 그 자리에 고정 표시 (다음 턴이 오면 자동 해제)
      const frozen = c.freezeKey === state.turnStartAt && typeof c.freezePos === "number";
      c.needle.style.left = (frozen ? c.freezePos : wakeSwingPos(t - state.turnStartAt)) + "%";
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

  // 호스트: 예비 릴레이(트랜잭션 실패 시) + 잠수/봇 타임아웃 자동 처리
  hostTick(ctx, state, inputs) {
    if (!state || !state.turnStartAt || state.awake || state.done || !state.order || !state.order.length) return;
    const t = ctx.now();
    if (t < state.turnStartAt) return;
    const activePid = state.order[state.turn % state.order.length];
    inputs = inputs || {};
    const inp = inputs[activePid];
    if (inp && typeof inp.pos === "number" && inp.turnKey === state.turnStartAt) {
      this._applyStop(ctx, activePid, inp.pos, state.turnStartAt).catch(() => {});
    } else if (t - state.turnStartAt > WAKE_AUTO_MS) {
      // 너무 오래 끌면 자동으로 아무 데나 멈춤
      this._applyStop(ctx, activePid, Math.random() * 100, state.turnStartAt).catch(() => {});
    }
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

// ═════════════════════════════════════════════
// 12. 눈치.. 숫자!
// ═════════════════════════════════════════════
const AVG_START = 3000;
const AVG_PICK = 15000;

const avg = {
  id: "avg",
  name: "눈치.. 숫자!",
  tag: "모두의 평균에 가장 가까우면 승리!",

  duration: () => AVG_START + AVG_PICK + 2500,
  hostSetup(ctx) {
    return { startAt: ctx.playStart + AVG_START };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { lastCount: -1, started: false, submitted: false, map: {} };
    stage.innerHTML = `
      <div class="avg-wrap">
        <div class="avg-val sketch" id="avgVal">3</div>
        <input type="range" min="0" max="100" value="50" class="avg-slider" id="avgSlider" disabled />
        <div class="game-note">슬라이더로 0~100 숫자를 정하고 제출! 남들이 뭘 낼지 눈치싸움 👀</div>
        <div class="cs-minirow" id="avgRow"></div>
      </div>`;
    c.valEl = stage.querySelector("#avgVal");
    c.slider = stage.querySelector("#avgSlider");
    const row = stage.querySelector("#avgRow");
    for (const [pid, p] of Object.entries(ctx.players())) {
      const el = makeChar({ color: ctx.colorOf(pid), nick: p.nick, size: 42 });
      if (pid === ctx.uid) el.classList.add("me");
      c.map[pid] = el;
      row.appendChild(el);
    }
    c.slider.addEventListener("input", () => {
      if (c.started && !c.submitted) c.valEl.textContent = c.slider.value;
    });
    const btn = actionBtn(dock, "제출!");
    btn.disabled = true;
    c.btn = btn;
    btn.addEventListener("click", () => {
      if (!c.started || c.submitted) return;
      c.submitted = true;
      btn.disabled = true;
      c.slider.disabled = true;
      btn.textContent = `${c.slider.value} 제출 완료!`;
      ctx.writeInput({ v: Number(c.slider.value) });
      const el = c.map[ctx.uid];
      if (el) { setMotion(el, "shout"); charSay(el, "냈다!", 1500); }
      sfx.pop();
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
      if (n !== c.lastCount) { c.lastCount = n; c.valEl.textContent = n; cdTick(); }
      return;
    }
    if (!c.started) {
      c.started = true;
      c.slider.disabled = false;
      c.btn.disabled = false;
      c.valEl.textContent = c.slider.value;
      gameStartFx();
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
      charSay(el, "냈다!", 1400);
      sfx.pop();
    }
  },
  hostEarlyEnd(ctx, inputs) {
    const n = Object.keys(ctx.players()).length;
    if (inputs && Object.keys(inputs).length >= n) return 1800;
    return false;
  },
  evaluate(ctx, inputs) {
    inputs = inputs || {};
    const players = Object.keys(ctx.players());
    const subs = players.filter(p => inputs[p] && typeof inputs[p].v === "number");
    if (!subs.length) {
      const outcome = {}, detail = {};
      for (const pid of players) { outcome[pid] = "lose"; detail[pid] = "아무도 안 냈다… 💤"; }
      return { outcome, detail };
    }
    const avgV = subs.reduce((s, p) => s + inputs[p].v, 0) / subs.length;
    const ranked = subs.slice().sort((a, b) =>
      Math.abs(inputs[a].v - avgV) - Math.abs(inputs[b].v - avgV));
    return tierOutcome(ctx, ranked,
      pid => `${inputs[pid].v} (평균 ${avgV.toFixed(1)})`,
      "안 냈다… 💤");
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 13. 보스 막타 치기!
// ═════════════════════════════════════════════
const BOSS_START = 3000;
const BOSS_HP_PER = 150;

const boss = {
  id: "boss",
  name: "보스 막타 치기!",
  tag: "마지막 한 방의 주인공은 +3 독식!",

  stampOnTimeout: false,
  duration: () => BOSS_START + 45000 + 2500,
  hostSetup(ctx) {
    const n = Object.keys(ctx.players()).length;
    const hp = BOSS_HP_PER * n;
    return { hp, hpMax: hp, killer: null, startAt: ctx.playStart + BOSS_START };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = { lastCount: -1, started: false, pending: 0, lastFlush: 0, flushing: false, killShown: false };
    stage.innerHTML = `
      <div class="boss-wrap">
        <div class="boss-hpbar sketch">
          <div class="boss-hpfill" id="bossFill"></div>
          <span class="boss-hptxt" id="bossTxt">100%</span>
        </div>
        <div class="wa-count" id="bossCount"></div>
        <div class="boss-jar" id="bossJar">🏺</div>
        <div class="boss-kill" id="bossKill" style="display:none"></div>
      </div>`;
    dock.innerHTML = `<div class="game-note">🏺 미친 듯이 연타! <b>마지막 타격</b>을 넣은 1명만 <b>+3</b>, 나머지는 0점!</div>`;
    c.fill = stage.querySelector("#bossFill");
    c.txt = stage.querySelector("#bossTxt");
    c.jar = stage.querySelector("#bossJar");
    c.kill = stage.querySelector("#bossKill");
    c.countEl = stage.querySelector("#bossCount");

    c.jar.addEventListener("pointerdown", e => {
      e.preventDefault();
      const state = ctx.state();
      if (!c.started || !state || state.killer || this._dispHp(state) <= 0) return;
      c.pending++;
      c.jar.classList.remove("boss-hit");
      void c.jar.offsetWidth;
      c.jar.classList.add("boss-hit");
      sfx.bonk();
      // 막타 눈치 구간(5% 미만)에선 즉시 반영, 평소엔 모아서 반영
      const low = this._dispHp(state) / state.hpMax < 0.05;
      if (low || ctx.now() - c.lastFlush > 350) this._flush(ctx);
    });
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _dispHp(state) {
    const c = this._c;
    return Math.max(0, (state.hp || 0) - (c ? c.pending : 0));
  },

  /** 쌓인 내 타격을 공유 HP에 트랜잭션으로 반영 — 0을 만든 사람이 막타 */
  _flush(ctx) {
    const c = this._c;
    if (!c || !c.pending || c.flushing) return;
    const dmg = c.pending;
    c.flushing = true;
    c.lastFlush = ctx.now();
    ctx.txn("game/state", cur => {
      if (!cur || cur.killer || cur.hp <= 0) return; // 이미 끝남
      const nhp = cur.hp - dmg;
      if (nhp <= 0) return Object.assign({}, cur, { hp: 0, killer: ctx.uid, killAt: ctx.now() });
      return Object.assign({}, cur, { hp: nhp });
    }).then(res => {
      c.flushing = false;
      if (res && res.committed) c.pending = Math.max(0, c.pending - dmg);
      else c.pending = 0; // 이미 죽었으면 버림
    }).catch(() => { c.flushing = false; });
  },

  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.startAt) return;
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.countEl.textContent = n + "…"; cdTick(); }
      return;
    }
    if (!c.started) { c.started = true; c.countEl.textContent = ""; gameStartFx(); }
    if (c.pending && t - c.lastFlush > 350) this._flush(ctx);
    const hp = this._dispHp(state);
    const pct = Math.max(0, Math.min(100, (hp / state.hpMax) * 100));
    c.fill.style.width = pct + "%";
    c.txt.textContent = state.killer ? "0%" : Math.ceil(pct) + "%";
    c.fill.classList.toggle("low", pct < 15);
    // 막타 연출
    if (state.killer && !c.killShown) {
      c.killShown = true;
      const p = ctx.players()[state.killer];
      c.jar.textContent = "💥";
      c.jar.classList.add("boss-dead");
      c.kill.style.display = "";
      c.kill.innerHTML = `막타!!! <b>${p ? p.nick : "?"}</b> +3`;
      sfx.boom();
      if (state.killer === ctx.uid) { sfx.win(); vibrate(300); }
    }
  },

  onState() {},
  onInputs() {},
  hostEarlyEnd(ctx, inputs, state) {
    return state && state.killer ? 2400 : false;
  },
  evaluate(ctx, inputs, state) {
    const killer = state ? state.killer : null;
    const outcome = {}, detail = {}, delta = {};
    for (const pid of Object.keys(ctx.players())) {
      if (pid === killer) { outcome[pid] = "win"; detail[pid] = "막타!!! 👑 +3"; delta[pid] = 3; }
      else { outcome[pid] = "mid"; detail[pid] = killer ? "아깝다! (±0)" : "항아리가 버텼다… (±0)"; delta[pid] = 0; }
    }
    return { outcome, detail, delta };
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 14. 팽이 스핀!
// ═════════════════════════════════════════════
const SPIN_START = 3000;
const SPIN_DUR = 7000;

const SPINNER_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <g stroke="#33312e" stroke-width="3.4">
    <circle cx="50" cy="22" r="15" fill="#e0472f"/>
    <circle cx="26" cy="64" r="15" fill="#3b6fd4"/>
    <circle cx="74" cy="64" r="15" fill="#f5a623"/>
    <circle cx="50" cy="50" r="11" fill="#fffdf6"/>
    <circle cx="50" cy="50" r="4.5" fill="#33312e" stroke="none"/>
  </g>
</svg>`;

const spin = {
  id: "spin",
  name: "팽이 스핀!",
  tag: "쓸어내려서 제일 빠르게 돌려라!",

  stampOnTimeout: false,
  duration: () => SPIN_START + SPIN_DUR + 2500,
  hostSetup(ctx) {
    return { startAt: ctx.playStart + SPIN_START };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = {
      lastCount: -1, started: false, ended: false,
      vel: 0, rot: 0, lastY: null, dragging: false, best: 0
    };
    stage.innerHTML = `
      <div class="sp-wrap" id="spWrap">
        <div class="sp-top">
          <span class="sketch hud-chip">내 RPM: <b id="spRpm">0</b></span>
          <span class="wa-count" id="spCount"></span>
        </div>
        <div class="sp-spinner" id="spSpinner">${SPINNER_SVG}</div>
        <div class="sp-arrow">⬇ ⬇ ⬇</div>
      </div>`;
    dock.innerHTML = `<div class="game-note">🌀 화면을 아래로 미친 듯이 쓸어내려! 7초 뒤 RPM이 높을수록 승리!</div>`;
    c.wrap = stage.querySelector("#spWrap");
    c.spinner = stage.querySelector("#spSpinner");
    c.rpmEl = stage.querySelector("#spRpm");
    c.countEl = stage.querySelector("#spCount");

    const down = e => { e.preventDefault(); c.dragging = true; c.lastY = e.clientY; };
    const move = e => {
      if (!c.dragging || !c.started || c.ended) return;
      const dy = e.clientY - c.lastY;
      c.lastY = e.clientY;
      if (dy > 0) c.vel = Math.min(9000, c.vel + dy * 14); // 아래로 쓸수록 가속
    };
    const up = () => { c.dragging = false; c.lastY = null; };
    c.wrap.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    c.cleanupWin = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    c.stopLoop = gameLoop((t, dt) => this._tick(ctx, dt));
  },

  _tick(ctx, dt) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.startAt) return;
    const t = ctx.now();
    if (t < state.startAt) {
      const n = Math.ceil((state.startAt - t) / 1000);
      if (n !== c.lastCount) { c.lastCount = n; c.countEl.textContent = n + "…"; cdTick(); }
      return;
    }
    if (!c.started) { c.started = true; c.countEl.textContent = ""; gameStartFx(); }
    // 마찰 감속 + 회전
    c.vel *= Math.exp(-dt / 1.6);
    c.rot = (c.rot + c.vel * dt) % 360000;
    c.spinner.style.transform = `rotate(${c.rot}deg)`;
    const rpm = Math.round(c.vel / 6); // deg/s → rpm
    c.rpmEl.textContent = rpm;
    // 종료: 그 순간의 RPM을 한 번만 기록
    if (!c.ended && t > state.startAt + SPIN_DUR) {
      c.ended = true;
      ctx.writeInput({ r: rpm });
      c.countEl.textContent = "끝!! 손 떼!!";
      sfx.whistle();
    }
  },

  onState() {},
  onInputs() {},
  hostEarlyEnd(ctx, inputs, state) {
    if (state && state.startAt && ctx.now() > state.startAt + SPIN_DUR + 1200) return 1500;
    return false;
  },
  evaluate(ctx, inputs) {
    inputs = inputs || {};
    const players = Object.keys(ctx.players());
    const played = players.filter(p => inputs[p] && typeof inputs[p].r === "number" && inputs[p].r > 0)
      .sort((a, b) => inputs[b].r - inputs[a].r);
    return tierOutcome(ctx, played, pid => inputs[pid].r + " RPM", "안 돌렸다… 💤");
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
// 15. 성대모사!
// ═════════════════════════════════════════════
const VOICE_CLIPS = [
  { file: "assets/voice1.mp3", dur: 1900 },
  { file: "assets/voice2.mp3", dur: 6450 },
  { file: "assets/voice3.mp3", dur: 1900 },
  { file: "assets/voice4.mp3", dur: 1550 }
];
const VOICE_PASS = 70;
// 채점 요소: [키, 라벨, 만점]
const VOICE_ELEMS = [["p", "음높이", 30], ["i", "억양", 30], ["r", "리듬", 25], ["l", "길이", 15]];

function voiceRecDur(clip) { return Math.max(4000, VOICE_CLIPS[clip].dur + 2000); }
function voiceSubLens(clip) {
  const dur = VOICE_CLIPS[clip].dur;
  const rec = voiceRecDur(clip);
  return {
    roulette: 4200, listen1: dur + 1200, listen2: dur + 1200, count: 3200,
    record: rec + 400, waitrec: 8000, playback: rec + 800, overlay: rec + 800, score: 11500
  };
}
const VOICE_SUB_ORDER = ["roulette", "listen1", "listen2", "count", "record", "waitrec", "playback", "overlay", "score"];

/** AudioBuffer → 16kHz 모노 Float32 (분석·전송 공용 포맷) */
async function voiceTo16k(buf) {
  const sr = 16000;
  const len = Math.max(1, Math.ceil(buf.duration * sr));
  const oc = new OfflineAudioContext(1, len, sr);
  const src = oc.createBufferSource();
  src.buffer = buf;
  src.connect(oc.destination);
  src.start();
  const out = await oc.startRendering();
  return out.getChannelData(0);
}

/** 16kHz 모노 Float32 → WAV 바이트 → base64 (모든 기기에서 재생 가능한 공용 포맷) */
function voiceWavB64(f32) {
  const sr = 16000;
  const n = f32.length;
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  wstr(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); wstr(8, "WAVE");
  wstr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 32767, true);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 프레임별 에너지 + 피치(자기상관) 추출 */
function voiceFeatures(f32) {
  const sr = 16000;
  const win = 640, hop = 320; // 40ms 창, 20ms 이동
  const energies = [], pitches = [];
  for (let s = 0; s + win <= f32.length; s += hop) {
    let rms = 0;
    for (let i = s; i < s + win; i++) rms += f32[i] * f32[i];
    energies.push(Math.sqrt(rms / win));
    pitches.push(0);
  }
  const maxE = Math.max(1e-6, ...energies);
  const minLag = Math.floor(sr / 500), maxLag = Math.floor(sr / 70);
  for (let fi = 0; fi < energies.length; fi++) {
    if (energies[fi] < maxE * 0.18) continue; // 무성 구간은 스킵
    const s = fi * hop;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < win - lag; i++) sum += f32[s + i] * f32[s + i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    if (bestLag) pitches[fi] = sr / bestLag;
  }
  return { energies, pitches, maxE };
}

function voiceResampleSeq(arr, n) {
  if (!arr.length) return new Array(n).fill(0);
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.min(arr.length - 1, Math.floor(i * arr.length / n))]);
  return out;
}

function voiceCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function voiceMedian(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 원본 vs 성대모사 채점: 음높이/억양/리듬/길이 → 100점 만점 */
function computeVoiceScores(ref, rec) {
  const clamp = x => Math.max(0, Math.min(1, x));
  const A = voiceFeatures(ref), B = voiceFeatures(rec);
  const vA = A.pitches.filter(p => p > 0), vB = B.pitches.filter(p => p > 0);
  const spA = A.energies.filter((e, i) => e > A.maxE * 0.18).length;
  const spB = B.energies.filter((e, i) => e > B.maxE * 0.18).length;

  // 아예 말을 안 했으면 전부 0점
  if (!spB || !vB.length) {
    return { p: 0, i: 0, r: 0, l: 0, total: 0 };
  }

  // 1) 음높이(30): 목소리 높이 중앙값 비교 (한 옥타브 차이면 0점 근처)
  const pRatio = Math.abs(Math.log2(voiceMedian(vA) / voiceMedian(vB)));
  const p = Math.round(30 * clamp(1 - pRatio / 1.0));

  // 2) 억양(30): 피치 곡선 상관 + 높낮이 변화폭 비교
  const contour = voiceCorr(voiceResampleSeq(vA, 40), voiceResampleSeq(vB, 40));
  const rangeA = Math.max(...vA) - Math.min(...vA), rangeB = Math.max(...vB) - Math.min(...vB);
  const rangeSim = clamp(1 - Math.abs(rangeA - rangeB) / Math.max(rangeA, rangeB, 1));
  const i = Math.round(30 * clamp(0.6 * (contour * 0.5 + 0.5) + 0.4 * rangeSim));

  // 3) 리듬(25): 소리 크기 흐름(엔벨로프) 상관
  const rr = voiceCorr(voiceResampleSeq(A.energies, 50), voiceResampleSeq(B.energies, 50));
  const r = Math.round(25 * clamp(rr * 0.65 + 0.35));

  // 4) 길이(15): 발화 길이 비율
  const l = Math.round(15 * clamp(Math.min(spA, spB) / Math.max(spA, spB, 1)));

  return { p, i, r, l, total: p + i + r + l };
}

const voice = {
  id: "voice",
  name: "성대모사!",
  tag: "똑같이 따라하면 +2! 못하면 -1!",

  stampOnTimeout: false,
  noStartFx: true, // 이 게임은 라운드 음악/예이 없음 (신호음만)
  duration: () => 72500,
  hostSetup(ctx) {
    const players = ctx.players();
    const humans = Object.keys(players).filter(id => !players[id].bot);
    const pool = humans.length ? humans : Object.keys(players);
    return {
      perf: pool[Math.floor(Math.random() * pool.length)],
      clip: Math.floor(Math.random() * VOICE_CLIPS.length),
      sub: "roulette",
      subAt: ctx.playStart
    };
  },

  _c: null,
  mount(stage, dock, ctx) {
    const c = this._c = {
      lastSub: "", cdLast: -1, srcs: [], timers: [],
      clipBufP: null, recBufP: null,
      stream: null, recorder: null, chunks: [], micFail: false, processed: false
    };
    stage.innerHTML = `
      <div class="vc-wrap">
        <div class="vc-status sketch" id="vcStatus">성대모사 주인공은…?</div>
        <div class="vc-main" id="vcMain"></div>
        <div class="vc-board" id="vcBoard" style="display:none"></div>
      </div>`;
    dock.innerHTML = `<div class="game-note" id="vcNote">🎤 룰렛으로 뽑힌 한 명이 도전! 나머지는 심사위원!</div>`;
    c.statusEl = stage.querySelector("#vcStatus");
    c.main = stage.querySelector("#vcMain");
    c.board = stage.querySelector("#vcBoard");
    c.note = stage.querySelector("#vcNote");
    c.stopLoop = gameLoop(() => this._tick(ctx));
  },

  _setStatus(text) {
    const c = this._c;
    if (c && c.statusEl && c.statusEl.textContent !== text) c.statusEl.textContent = text;
  },

  // 재생은 전부 Web Audio 버퍼 경로 — iOS에서도 제스처 없이 확실히 들린다
  _playClip(ctx, seekMs = 0) {
    const c = this._c;
    const state = ctx.state();
    if (!c || !state || !c.clipBufP) return;
    const sub = c.lastSub;
    c.clipBufP.then(buf => {
      if (!buf || this._c !== c || c.lastSub !== sub) return; // 이미 다음 단계로 넘어감
      c.srcs.push(playBuffer(buf, 1, seekMs / 1000));
    });
  },

  _playRec(ctx) {
    const c = this._c;
    const state = ctx.state();
    const inp = state && ctx.inputs() && ctx.inputs()[state.perf];
    if (!c || !inp || !inp.rec) return;
    if (!c.recBufP) c.recBufP = decodeB64Audio(inp.rec).catch(() => null);
    const sub = c.lastSub;
    c.recBufP.then(buf => {
      if (!buf || this._c !== c || c.lastSub !== sub) return;
      c.srcs.push(playBuffer(buf, 1));
    });
  },

  _stopAudios() {
    const c = this._c;
    if (!c) return;
    for (const s of c.srcs) { try { s.stop(); } catch { /* noop */ } }
    c.srcs = [];
  },

  // ── 주인공 전용: 마이크 준비/녹음/분석 ──
  async _prepMic() {
    const c = this._c;
    if (!c || c.stream || c.micFail) return;
    try {
      if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error("unsupported");
      c.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch { c.micFail = true; }
  },

  _startRec(ctx) {
    const c = this._c;
    if (!c) return;
    if (c.micFail || !c.stream) { ctx.writeInput({ recfail: 1 }); return; }
    try {
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""].find(m => !m || MediaRecorder.isTypeSupported(m));
      c.recorder = new MediaRecorder(c.stream, mime ? { mimeType: mime } : undefined);
      c.chunks = [];
      c.recorder.ondataavailable = e => { if (e.data && e.data.size) c.chunks.push(e.data); };
      c.recorder.onstop = () => this._processRec(ctx).catch(() => ctx.writeInput({ recfail: 1 }));
      c.recorder.start();
    } catch { ctx.writeInput({ recfail: 1 }); }
  },

  _stopRec() {
    const c = this._c;
    if (c && c.recorder && c.recorder.state === "recording") {
      try { c.recorder.stop(); } catch { /* noop */ }
    }
  },

  async _processRec(ctx) {
    const c = this._c;
    const state = ctx.state();
    if (!c || c.processed || !state) return;
    c.processed = true;
    const blob = new Blob(c.chunks);
    if (!blob.size) { ctx.writeInput({ recfail: 1 }); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    try {
      const recBuf = await ac.decodeAudioData(await blob.arrayBuffer());
      // 원본은 듣기 단계에서 이미 디코딩해 둔 버퍼 재사용
      const refBuf = await (c.clipBufP || loadUrlBuffer(VOICE_CLIPS[state.clip].file));
      if (!refBuf) throw new Error("ref decode fail");
      // 녹음은 게임 시간 한도까지만 사용
      const rec16 = (await voiceTo16k(recBuf)).slice(0, Math.ceil(voiceRecDur(state.clip) / 1000 * 16000));
      const ref16 = await voiceTo16k(refBuf);
      const sc = computeVoiceScores(ref16, rec16);
      ctx.writeInput({ rec: voiceWavB64(rec16), sc });
    } finally {
      ac.close().catch(() => {});
    }
  },

  // ── 진행 (state.sub 기준 화면 전환) ──
  _tick(ctx) {
    const c = this._c;
    if (!c) return;
    const state = ctx.state();
    if (!state || !state.sub) return;
    // 원본 클립을 미리 디코딩해 둠 — 듣기 단계 진입 즉시 소리가 나게
    if (!c.clipBufP && typeof state.clip === "number") {
      c.clipBufP = loadUrlBuffer(VOICE_CLIPS[state.clip].file).catch(() => null);
    }
    const t = ctx.now();
    const iAmPerf = state.perf === ctx.uid;
    const perfNick = (ctx.players()[state.perf] || {}).nick || "?";

    if (state.sub !== c.lastSub) {
      const prev = c.lastSub;
      c.lastSub = state.sub;
      this._stopAudios();
      if (prev === "record") this._stopRec();
      this._enterSub(ctx, state, iAmPerf, perfNick);
    }

    // 진행 중 갱신이 필요한 sub들
    if (state.sub === "roulette") {
      if (t - state.subAt > 3300 && !c.rouletteDone) {
        c.rouletteDone = true;
        clearInterval(c.roulInt);
        c.main.innerHTML = "";
        const el = makeChar({ color: ctx.colorOf(state.perf), nick: perfNick, size: 84, face: "shock" });
        c.main.appendChild(el);
        this._setStatus(`🎤 ${iAmPerf ? "내가 주인공!!" : perfNick + " 당첨!!"}`);
        sfx.bbam();
        if (iAmPerf) this._prepMic(); // 마이크 권한 미리 요청
      }
    } else if (state.sub === "count") {
      const n = Math.ceil((state.subAt + 3200 - t) / 1000);
      if (n >= 1 && n <= 3 && n !== c.cdLast) { c.cdLast = n; cdTick(); this._setStatus(`${n}…`); }
    } else if (state.sub === "record") {
      const remain = Math.max(0, (state.subAt + voiceRecDur(state.clip)) - t);
      const bar = c.main.querySelector(".vc-recbar-fill");
      if (bar) bar.style.width = (remain / voiceRecDur(state.clip) * 100) + "%";
    } else if (state.sub === "score") {
      this._tickScore(ctx, state, t - state.subAt, perfNick);
    }
  },

  _enterSub(ctx, state, iAmPerf, perfNick) {
    const c = this._c;
    const dur = VOICE_CLIPS[state.clip].dur;
    c.main.innerHTML = "";
    c.board.style.display = "none";
    switch (state.sub) {
      case "roulette": {
        this._setStatus("성대모사 주인공은…?");
        c.main.innerHTML = `<div class="vc-roul sketch" id="vcRoul">???</div>`;
        const names = Object.values(ctx.players()).map(p => p.nick);
        let ri = 0;
        c.roulInt = setInterval(() => {
          const el = c.main.querySelector("#vcRoul");
          if (el) { el.textContent = names[ri++ % names.length]; sfx.tick(); }
        }, 95);
        c.timers.push(c.roulInt);
        break;
      }
      case "listen1":
      case "listen2": {
        const nth = state.sub === "listen1" ? 1 : 2;
        this._setStatus(`잘 들어봐! (${nth}/2)`);
        c.note.textContent = iAmPerf ? "🎧 이걸 그대로 따라하는 거야!" : `🎧 ${perfNick}이(가) 따라할 소리!`;
        c.main.innerHTML = `<div class="vc-speaker">🔊</div>`;
        this._playClip(ctx, ctx.now() - state.subAt);
        break;
      }
      case "count":
        this._setStatus("3…");
        c.cdLast = -1;
        c.note.textContent = iAmPerf ? "🎙 곧 녹음 시작! 목 가다듬어!" : "🤫 조용! 곧 시작해!";
        c.main.innerHTML = `<div class="vc-speaker">🎙</div>`;
        break;
      case "record":
        if (iAmPerf) {
          this._setStatus("지금 따라해!! 🎙");
          c.note.textContent = "🔴 녹음 중!! 최대한 똑같이!";
          this._startRec(ctx);
        } else {
          this._setStatus(`${perfNick}이(가) 성대모사 중…!`);
          c.note.textContent = "🤫 절대 조용!! 웃음 참기!!";
        }
        c.main.innerHTML = `
          <div class="vc-mic${iAmPerf ? " vc-recing" : ""}">🎙</div>
          <div class="vc-recbar sketch"><div class="vc-recbar-fill" style="width:100%"></div></div>`;
        break;
      case "waitrec":
        this._setStatus("녹음 정리 중… 📼");
        c.note.textContent = "잠시만!";
        c.main.innerHTML = `<div class="vc-speaker">📼</div>`;
        break;
      case "playback":
        this._setStatus("들어보자!! 🔊");
        c.note.textContent = `🎧 ${perfNick}의 성대모사!`;
        c.main.innerHTML = `<div class="vc-speaker">🔊</div>`;
        this._playRec(ctx);
        break;
      case "overlay":
        this._setStatus("동시 재생!! 얼마나 비슷할까?");
        c.note.textContent = "🎧 원본 + 성대모사 동시에!";
        c.main.innerHTML = `<div class="vc-speaker">🔊🔊</div>`;
        this._playClip(ctx, 0);
        this._playRec(ctx);
        break;
      case "score":
        c.scoreShown = {};
        c.note.textContent = "과연 결과는…?!";
        this._setStatus("채점 중…");
        c.main.innerHTML = "";
        c.board.style.display = "";
        c.board.innerHTML = VOICE_ELEMS.map(([k, label, max]) =>
          `<div class="vc-row" data-k="${k}"><span class="vc-lbl">${label}</span><span class="vc-pts" id="vcPts-${k}">?? / ${max}</span></div>`
        ).join("") + `<div class="vc-total" id="vcTotal"></div><div class="vc-verdict" id="vcVerdict"></div>`;
        playDrumroll();
        break;
    }
  },

  /** 점수 공개 연출: 두구두구 → 요소별 순차 공개 → 총점 → +2/-1 판정 */
  _tickScore(ctx, state, e, perfNick) {
    const c = this._c;
    const inp = ctx.inputs() && ctx.inputs()[state.perf];
    const sc = (inp && inp.sc) || { p: 0, i: 0, r: 0, l: 0, total: 0 };
    VOICE_ELEMS.forEach(([k, label, max], idx) => {
      const at = 2200 + idx * 1600;
      if (e >= at && !c.scoreShown[k]) {
        c.scoreShown[k] = true;
        const el = c.board.querySelector(`#vcPts-${k}`);
        if (el) {
          el.textContent = `${sc[k]} / ${max}`;
          el.parentElement.classList.add("vc-revealed");
        }
        sfx.pop();
      }
    });
    if (e >= 2200 + VOICE_ELEMS.length * 1600 + 400 && !c.scoreShown.total) {
      c.scoreShown.total = true;
      const pass = sc.total >= VOICE_PASS;
      c.board.querySelector("#vcTotal").textContent = `총점 ${sc.total} / 100`;
      const v = c.board.querySelector("#vcVerdict");
      v.textContent = pass ? `합격!! ${perfNick} +2 🎉` : `기준 미달… ${perfNick} -1 😭`;
      v.classList.add(pass ? "vc-pass" : "vc-fail");
      this._setStatus(pass ? "인정!! 👏" : "아쉽다…!");
      (pass ? sfx.tada : sfx.fail)();
    }
  },

  onState() {},
  onInputs() {},

  // 호스트: 시간표대로 sub 진행 (녹음 업로드는 도착하는 대로)
  hostTick(ctx, state, inputs) {
    if (!state || !state.sub) return;
    const t = ctx.now();
    const lens = voiceSubLens(state.clip);
    const inp = inputs && inputs[state.perf];
    if (state.sub === "waitrec") {
      if (inp && inp.recfail) { ctx.writeState({ sub: "score", subAt: t }); return; }
      if (inp && inp.rec) { ctx.writeState({ sub: "playback", subAt: t }); return; }
    }
    if (t < state.subAt + lens[state.sub]) return;
    if (state.sub === "score") return; // 종료는 hostEarlyEnd가
    const idx = VOICE_SUB_ORDER.indexOf(state.sub);
    let next = VOICE_SUB_ORDER[idx + 1];
    if (state.sub === "waitrec") next = "score"; // 업로드가 끝내 안 오면 0점 처리
    if (!next) return;
    ctx.writeState({ sub: next, subAt: t });
  },
  hostEarlyEnd(ctx, inputs, state) {
    if (!state || state.sub !== "score") return false;
    return ctx.now() > state.subAt + 11000 ? 900 : false;
  },
  evaluate(ctx, inputs, state) {
    inputs = inputs || {};
    const perf = state ? state.perf : null;
    const sc = perf && inputs[perf] && inputs[perf].sc;
    const total = sc ? sc.total : 0;
    const pass = total >= VOICE_PASS;
    const outcome = {}, detail = {}, delta = {};
    for (const pid of Object.keys(ctx.players())) {
      if (pid === perf) {
        outcome[pid] = pass ? "win" : "lose";
        detail[pid] = `${total}점 — ${pass ? "성대모사 인정!! 🎤 +2" : "기준 미달… -1"}`;
        delta[pid] = pass ? 2 : -1;
      } else {
        outcome[pid] = "mid";
        detail[pid] = "심사위원 (±0)";
        delta[pid] = 0;
      }
    }
    return { outcome, detail, delta };
  },
  unmount() {
    const c = this._c;
    if (!c) return;
    if (c.stopLoop) c.stopLoop();
    c.timers.forEach(clearInterval);
    clearInterval(c.roulInt);
    this._stopAudios();
    this._stopRec();
    if (c.stream) { try { c.stream.getTracks().forEach(tr => tr.stop()); } catch { /* noop */ } }
    this._c = null;
  }
};

// ═════════════════════════════════════════════
// 게임 소개 데모 — 진행 방식을 짧은 그림 애니메이션으로 보여줌
// (게임 소개 오버레이에서 글 설명 대신 사용)
// ═════════════════════════════════════════════
const DM_COLORS = ["#e64a3c", "#45a3e5", "#f5a623", "#58b647"];

function dmStage(cls) {
  const d = document.createElement("div");
  d.className = "demo " + cls;
  return d;
}
function dmChar(i, cls, size = 44, opts = {}) {
  const el = makeChar(Object.assign({ color: DM_COLORS[i % 4], nick: "", size, motion: "none" }, opts));
  if (cls) el.classList.add(...cls.split(" "));
  return el;
}
function dmProp(cls, text) {
  const s = document.createElement("div");
  s.className = "demo-prop " + cls;
  if (text !== undefined) s.textContent = text;
  return s;
}
function dmAt(el, left, top) {
  el.style.left = left;
  el.style.top = top;
  return el;
}

nunchi.demo = () => {
  const d = dmStage("dm-nunchi");
  d.appendChild(dmAt(dmChar(1), "14%", "52%"));
  d.appendChild(dmAt(dmChar(0, "dm-n-hero"), "42%", "52%"));
  d.appendChild(dmAt(dmChar(2), "70%", "52%"));
  d.appendChild(dmAt(dmProp("dm-n-bubble", "얍!!"), "50%", "18%"));
  d.appendChild(dmAt(dmProp("dm-n-ok", "✓ 혼자 성공!"), "50%", "2%"));
  return d;
};

mugunghwa.demo = () => {
  const d = dmStage("dm-mg");
  d.appendChild(dmAt(dmProp("dm-mg-line"), "78%", "10%"));
  d.appendChild(dmAt(dmChar(0, "dm-mg-runner"), "6%", "48%"));
  d.appendChild(dmAt(dmChar(3, "dm-mg-tagger", 50), "82%", "40%"));
  d.appendChild(dmAt(dmProp("dm-mg-alert", "🚨 멈춰!"), "40%", "8%"));
  return d;
};

grab.demo = () => {
  const d = dmStage("dm-grab");
  d.appendChild(dmAt(dmProp("dm-g-wait", "・・・"), "50%", "16%"));
  d.appendChild(dmAt(dmProp("dm-g-now", "지금!!"), "50%", "10%"));
  d.appendChild(dmAt(dmChar(1), "24%", "46%"));
  d.appendChild(dmAt(dmProp("dm-g-btn demo-btn", "잡기!"), "62%", "58%"));
  d.appendChild(dmAt(dmProp("dm-g-tap", "👆"), "64%", "74%"));
  return d;
};

choseki.demo = () => {
  const d = dmStage("dm-cs");
  d.appendChild(dmAt(dmProp("dm-c-open", "⏱ 2.00…"), "50%", "12%"));
  d.appendChild(dmAt(dmProp("dm-c-hidden", "?.?? 🙈"), "50%", "12%"));
  d.appendChild(dmAt(dmChar(2), "24%", "46%"));
  d.appendChild(dmAt(dmProp("dm-c-btn demo-btn", "멈춰!"), "62%", "58%"));
  d.appendChild(dmAt(dmProp("dm-c-tap", "👆"), "64%", "74%"));
  return d;
};

whack.demo = () => {
  const d = dmStage("dm-whack");
  for (const l of ["14%", "42%", "70%"]) d.appendChild(dmAt(dmProp("dm-w-hole"), l, "62%"));
  const wrap = dmAt(dmProp("dm-w-molewrap"), "42%", "24%");
  wrap.appendChild(dmChar(0, "dm-w-mole", 40, { color: "#a5713f" }));
  d.appendChild(wrap);
  d.appendChild(dmAt(dmProp("dm-w-tap", "👆"), "52%", "40%"));
  d.appendChild(dmAt(dmProp("dm-w-pop", "제일 빨리! +1"), "50%", "4%"));
  return d;
};

typing.demo = () => {
  const d = dmStage("dm-type");
  d.appendChild(dmAt(dmProp("dm-t-card", "떡볶이"), "50%", "10%"));
  const line = dmAt(dmProp("dm-t-inputline"), "50%", "58%");
  line.appendChild(dmProp("dm-t-typed", "떡볶이"));
  d.appendChild(line);
  d.appendChild(dmAt(dmProp("dm-t-ok", "빨리 치면 획득! ✓"), "50%", "82%"));
  return d;
};
mash.demo = () => {
  const d = dmStage("dm-mash");
  d.appendChild(dmAt(dmChar(3), "24%", "46%"));
  d.appendChild(dmAt(dmProp("dm-m-btn demo-btn", "눌러!!"), "60%", "56%"));
  d.appendChild(dmAt(dmProp("dm-m-tap", "👆"), "62%", "72%"));
  d.appendChild(dmAt(dmProp("dm-m-p1", "+1"), "58%", "36%"));
  d.appendChild(dmAt(dmProp("dm-m-p2", "+1"), "70%", "42%"));
  return d;
};

block.demo = () => {
  const d = dmStage("dm-block");
  d.appendChild(dmAt(dmProp("dm-bk-tile dm-bk-left"), "30%", "56%"));
  d.appendChild(dmAt(dmProp("dm-bk-tile dm-bk-right"), "76%", "56%"));
  d.appendChild(dmAt(dmChar(0, "dm-bk-fall1", 36), "20%", "36%"));
  d.appendChild(dmAt(dmChar(2, "dm-bk-fall2", 36), "32%", "36%"));
  d.appendChild(dmAt(dmChar(1, "dm-bk-safe", 36), "70%", "36%"));
  d.appendChild(dmAt(dmProp("dm-bk-boom", "💥 많은 쪽 탈락!"), "28%", "6%"));
  return d;
};

tug.demo = () => {
  const d = dmStage("dm-tug");
  d.appendChild(dmAt(dmProp("dm-tg-rope"), "50%", "56%"));
  d.appendChild(dmAt(dmProp("dm-tg-knot", "🔴"), "50%", "56%"));
  d.appendChild(dmAt(dmChar(0, "dm-tg-l", 40, { color: "#e0472f" }), "8%", "40%"));
  d.appendChild(dmAt(dmChar(0, "dm-tg-l", 40, { color: "#e0472f" }), "22%", "44%"));
  d.appendChild(dmAt(dmChar(1, "dm-tg-r", 40, { color: "#3b6fd4" }), "76%", "40%"));
  d.appendChild(dmAt(dmChar(1, "dm-tg-r", 40, { color: "#3b6fd4" }), "90%", "44%"));
  d.appendChild(dmAt(dmProp("dm-tg-win", "🏆"), "14%", "8%"));
  return d;
};

wake.demo = () => {
  const d = dmStage("dm-wake");
  d.appendChild(dmAt(dmProp("dm-wk-dog", "🐶"), "50%", "2%"));
  d.appendChild(dmAt(dmProp("dm-wk-zzz", "💤"), "62%", "0%"));
  const bar = dmAt(dmProp("dm-wk-bar"), "50%", "52%");
  bar.appendChild(dmProp("dm-wk-green"));
  bar.appendChild(dmProp("dm-wk-needle"));
  d.appendChild(bar);
  d.appendChild(dmAt(dmProp("dm-wk-tap", "👆"), "52%", "74%"));
  d.appendChild(dmAt(dmProp("dm-wk-hint", "초록에서 멈춰!"), "50%", "88%"));
  return d;
};

avg.demo = () => {
  const d = dmStage("dm-avg");
  d.appendChild(dmAt(dmProp("dm-av-num1", "37"), "50%", "4%"));
  d.appendChild(dmAt(dmProp("dm-av-num2", "62"), "50%", "4%"));
  const track = dmAt(dmProp("dm-av-track"), "50%", "44%");
  track.appendChild(dmProp("dm-av-knob"));
  d.appendChild(track);
  d.appendChild(dmAt(dmProp("dm-av-btn demo-btn", "제출!"), "50%", "62%"));
  d.appendChild(dmAt(dmProp("dm-av-hint", "모두의 평균에 제일 가까우면 승리!"), "50%", "86%"));
  return d;
};

boss.demo = () => {
  const d = dmStage("dm-boss");
  const bar = dmAt(dmProp("dm-bs-hp"), "50%", "4%");
  bar.appendChild(dmProp("dm-bs-hpfill"));
  d.appendChild(bar);
  d.appendChild(dmAt(dmProp("dm-bs-jar", "🏺"), "50%", "26%"));
  d.appendChild(dmAt(dmProp("dm-bs-tap dm-bs-t1", "👆"), "28%", "48%"));
  d.appendChild(dmAt(dmProp("dm-bs-tap dm-bs-t2", "👆"), "50%", "70%"));
  d.appendChild(dmAt(dmProp("dm-bs-tap dm-bs-t3", "👆"), "72%", "48%"));
  d.appendChild(dmAt(dmProp("dm-bs-boom", "💥"), "50%", "28%"));
  d.appendChild(dmAt(dmProp("dm-bs-win", "막타 +3!!"), "50%", "84%"));
  return d;
};

spin.demo = () => {
  const d = dmStage("dm-spin");
  const sp = dmAt(dmProp("dm-sp-spinner"), "50%", "8%");
  sp.innerHTML = SPINNER_SVG;
  d.appendChild(sp);
  d.appendChild(dmAt(dmProp("dm-sp-hand", "👆"), "74%", "20%"));
  d.appendChild(dmAt(dmProp("dm-sp-hint", "아래로 쓸어내려서 돌려!"), "50%", "86%"));
  return d;
};

voice.demo = () => {
  const d = dmStage("dm-voice");
  d.appendChild(dmAt(dmProp("dm-vc-spk", "🔊"), "22%", "12%"));
  d.appendChild(dmAt(dmProp("dm-vc-note", "♪"), "34%", "6%"));
  d.appendChild(dmAt(dmChar(2, "dm-vc-singer", 48), "56%", "30%"));
  d.appendChild(dmAt(dmProp("dm-vc-mic", "🎙"), "76%", "34%"));
  d.appendChild(dmAt(dmProp("dm-vc-score", "채점: 똑같으면 +2!"), "50%", "84%"));
  return d;
};

export const GAME_IDS = ["nunchi", "mugunghwa", "grab", "choseki", "whack", "typing", "mash", "block", "tug", "wake", "avg", "boss", "spin", "voice"];
export const GAMES = { nunchi, mugunghwa, grab, choseki, whack, typing, mash, block, tug, wake, avg, boss, spin, voice };
