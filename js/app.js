// 스쿨 미니 — 메인 앱 (화면 전환 / 로비 / 호스트 게임 루프 / 연출)
import { COLORS, MAX_PLAYERS } from "./config.js";
import * as net from "./net.js";
import { sfx, unlockAudio, toggleMute, isMuted, startMelody, stopMelody, setBgm } from "./sfx.js";
import { makeChar, setFace, setMotion, charSay } from "./character.js";
import { GAMES, GAME_IDS, genWords } from "./games.js";

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 페이즈 길이 — 너무 빠르게 넘어가지 않도록 여유 있게
const SLOT_MS = 7800;
const INTRO_MS = 8400;

// ── 전역 상태 ────────────────────────────────
let UID = null;
let room = null;
let meta = null;
let playersCache = {};
let colorsCache = {};
let gameCache = {};
let historyCache = {};
let isHost = false;
let unsubs = [];
let lastPhaseKey = "";
let lastStatus = "";
let hostTimer = null;
let earlyEndTimer = null;
let earlyEndArmed = false;
let endedRounds = new Set();
let slotRaf = 0;
let resultToken = "";
let finalShown = false;
let entryMode = "create";

// ── 유틸 ─────────────────────────────────────
function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  $("toast-wrap").appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

const SCREENS = ["scr-home", "scr-entry", "scr-lobby", "scr-game", "scr-final"];
let curScreen = "scr-home";
function showScreen(id, silent = false) {
  if (curScreen === id) return;
  curScreen = id;
  for (const s of SCREENS) {
    const el = $(s);
    el.classList.toggle("active", s === id);
    el.classList.remove("enter");
  }
  const el = $(id);
  void el.offsetWidth;
  el.classList.add("enter");
  if (id !== "scr-final") stopMelody();
  // 타이틀·입장·로비에서는 BGM 재생
  setBgm(id === "scr-home" || id === "scr-entry" || id === "scr-lobby");
  if (!silent) sfx.swoosh();
}

function colorOf(pid) {
  const idx = playersCache[pid] ? playersCache[pid].color : -1;
  return COLORS[idx] || "#9a958a";
}

function phaseKeyOf(m) { return m ? `${m.status}:${m.curRound}:${m.phase}` : ""; }

function makeCtx(over = {}) {
  return Object.assign({
    code: room,
    uid: UID,
    isHost,
    players: () => playersCache || {},
    colorOf,
    now: net.now,
    playStart: meta ? meta.playStart || 0 : 0,
    playEnd: meta ? meta.phaseEnd || 0 : 0,
    state: () => (gameCache && gameCache.state) || null,
    inputs: () => (gameCache && gameCache.inputs) || null,
    game: () => gameCache || {},
    tsSentinel: net.ts,
    writeInput: fields => net.dbUpdate(`rooms/${room}/game/inputs/${UID}`, fields),
    writeState: patch => net.dbUpdate(`rooms/${room}/game/state`, patch),
    txn: (path, fn) => net.dbTxn(`rooms/${room}/${path}`, fn)
  }, over);
}

// ── 홈 화면 마스코트 ──────────────────────────
const MASCOT_LINES = ["안녕!", "같이 놀자~", "한 판 고?", "심심해…", "나 귀엽지?", "쉬는시간이다!!"];
function setupMascot() {
  const wrap = $("homeMascot");
  const m = makeChar({ color: "#f5a623", nick: "", size: 118 });
  wrap.appendChild(m);
  setInterval(() => {
    if (curScreen !== "scr-home") return;
    if (Math.random() < 0.5) {
      charSay(m, MASCOT_LINES[Math.floor(Math.random() * MASCOT_LINES.length)], 1600);
    } else {
      setMotion(m, "jump");
      setTimeout(() => setMotion(m, "idle"), 1300);
    }
  }, 3600);
}

// ── 입장(만들기/참가) ─────────────────────────
function openEntry(mode) {
  entryMode = mode;
  $("entryTitle").textContent = mode === "create" ? "게임 만들기" : "게임 참가하기";
  $("entryHint").textContent = mode === "create"
    ? "친구들에게 보여줄 닉네임을 정해줘!"
    : "닉네임이랑 친구가 알려준 방 코드를 입력해!";
  $("inpCode").style.display = mode === "create" ? "none" : "";
  $("btnEntryGo").textContent = mode === "create" ? "만들기!" : "참가하기!";
  $("inpNick").value = localStorage.getItem("sm_nick") || "";
  showScreen("scr-entry");
  setTimeout(() => $("inpNick").focus(), 250);
}

async function submitEntry() {
  const nick = $("inpNick").value.trim();
  if (!nick) { toast("닉네임을 입력해줘!", true); return; }
  const btn = $("btnEntryGo");
  btn.disabled = true;
  try {
    localStorage.setItem("sm_nick", nick);
    if (entryMode === "create") {
      const code = await net.createRoom(nick);
      enterRoom(code);
    } else {
      const code = $("inpCode").value.trim().toUpperCase();
      if (code.length !== 4) { toast("방 코드는 4글자야!", true); btn.disabled = false; return; }
      await net.joinRoom(code, nick);
      enterRoom(code);
    }
  } catch (e) {
    toast(e.message || "문제가 생겼어… 다시 시도해줘!", true);
    btn.disabled = false;
  }
}

// ── 방 입장/퇴장 ─────────────────────────────
function enterRoom(code) {
  room = code;
  localStorage.setItem("sm_room", code);
  $("btnEntryGo").disabled = false;
  lastPhaseKey = "";
  lastStatus = "";
  finalShown = false;
  endedRounds = new Set();

  unsubs.push(net.dbWatch(`rooms/${code}/meta`, v => { meta = v; onMeta(); }));
  unsubs.push(net.dbWatch(`rooms/${code}/players`, v => { playersCache = v || {}; onPlayers(); }));
  unsubs.push(net.dbWatch(`rooms/${code}/colors`, v => { colorsCache = v || {}; renderColors(); renderLobbyChars(); }));
  unsubs.push(net.dbWatch(`rooms/${code}/game`, v => { gameCache = v || {}; onGameData(); }));
  unsubs.push(net.dbWatch(`rooms/${code}/history`, v => { historyCache = v || {}; }));
}

function cleanupRoom(keepSaved = false) {
  unsubs.forEach(u => { try { u(); } catch { /* noop */ } });
  unsubs = [];
  clearTimeout(hostTimer);
  clearTimeout(earlyEndTimer);
  cancelAnimationFrame(slotRaf);
  unmountGame();
  wanderStop();
  if (!keepSaved) localStorage.removeItem("sm_room");
  stopMelody();
  room = null; meta = null; playersCache = {}; colorsCache = {}; gameCache = {}; historyCache = {};
  isHost = false; lastPhaseKey = ""; lastStatus = "";
}

// 같은 브라우저의 다른 탭이 이 방에 새로 들어오면(같은 UID),
// 이 탭은 조용히 물러난다 — 호스트 루프가 중복 실행되는 사고 방지
function detachSuperseded() {
  const code = room;
  net.cancelPresence(`rooms/${code}/players/${UID}`);
  cleanupRoom(true);
  showScreen("scr-home");
  toast("다른 탭에서 이 방에 접속했어! 이 탭은 쉬는 중 😴", true);
}

async function leaveToHome() {
  const myColor = playersCache[UID] ? playersCache[UID].color : -1;
  const st = meta ? meta.status : "lobby";
  const wasHost = isHost;
  const code = room;
  cleanupRoom();
  showScreen("scr-home");
  if (code) net.leaveRoom(code, wasHost, myColor, st);
}

// ── 메타 변화 → 화면 라우팅 ───────────────────
function onMeta() {
  if (!room) return;
  if (!meta) {
    // 방이 삭제됨
    cleanupRoom();
    showScreen("scr-home");
    toast("방이 사라졌어! (방장이 방을 닫았나 봐)", true);
    return;
  }
  isHost = meta.hostUid === UID;
  if (lastStatus !== meta.status) lastPhaseKey = ""; // 매치 재시작 시 페이즈 키 초기화

  if (meta.status === "lobby") {
    if (lastStatus !== "lobby") {
      unmountGame();
      hideOverlays();
      showScreen("scr-lobby");
    }
    renderLobbyMeta();
  } else if (meta.status === "playing") {
    if (lastStatus !== "playing") showScreen("scr-game");
    handlePhase();
  } else if (meta.status === "final") {
    if (lastStatus !== "final") showScreen("scr-final");
    renderFinal();
  }
  lastStatus = meta.status;
  hostSchedule();
}

function onPlayers() {
  if (!room) return;
  const me = playersCache[UID];
  if (me && me.tab && me.tab !== net.TAB_ID) { detachSuperseded(); return; }
  renderLobbyChars();
  renderPlayerList();
  renderColors();
  renderLobbyMeta();
}

function onGameData() {
  if (!room || !meta) return;
  if (currentGameMod && meta.status === "playing" && meta.phase === "play") {
    const ctx = makeCtx();
    currentGameMod.onState(gameCache.state || null, ctx);
    currentGameMod.onInputs(gameCache.inputs || null, ctx);
    if (currentGameMod.onGame) currentGameMod.onGame(gameCache, ctx);
  }
  hostCheckEarly();
}

// ═════════════════════════════════════════════
// 로비
// ═════════════════════════════════════════════
let wander = {};
let wanderRaf = 0;
let wanderPrev = 0;

function renderLobbyMeta() {
  if (!meta || meta.status !== "lobby") return;
  $("roomCodeChip").textContent = room || "----";
  const n = Object.keys(playersCache).length;
  $("lobbyCount").textContent = `${n}/${MAX_PLAYERS}`;
  $("hostControls").style.display = isHost ? "flex" : "none";
  $("guestNotice").style.display = isHost ? "none" : "";
  $("roundsVal").textContent = meta.rounds || 4;
  const start = $("btnStart");
  start.disabled = n < 2;
  start.title = n < 2 ? "2명부터 시작할 수 있어!" : "";
}

function renderPlayerList() {
  const list = $("playerList");
  if (!list) return;
  list.innerHTML = "";
  const ids = Object.keys(playersCache).sort((a, b) => (playersCache[a].joined || 0) - (playersCache[b].joined || 0));
  for (const pid of ids) {
    const p = playersCache[pid];
    const row = document.createElement("div");
    row.className = "player-row" + (p.online === false ? " offline" : "");
    row.style.setProperty("--pc", colorOf(pid));
    row.innerHTML = `<span class="p-name"></span>`;
    row.querySelector(".p-name").textContent = p.nick;
    if (meta && meta.hostUid === pid) row.innerHTML += `<span class="p-tag">👑 방장</span>`;
    if (pid === UID) row.innerHTML += `<span class="p-tag">(나)</span>`;
    if (p.online === false) row.innerHTML += `<span class="p-tag">연결 끊김</span>`;
    list.appendChild(row);
  }
}

function renderColors() {
  const grid = $("colorGrid");
  if (!grid) return;
  if (!grid.childElementCount) {
    COLORS.forEach((hex, i) => {
      const b = document.createElement("button");
      b.className = "color-dot";
      b.style.setProperty("--c", hex);
      b.addEventListener("click", async () => {
        if (!room) return;
        const owner = colorsCache[i];
        if (owner && owner !== UID) { toast("이미 다른 친구가 고른 색이야!", true); return; }
        if (owner === UID) return;
        sfx.click();
        const ok = await net.claimColor(room, i);
        if (!ok) toast("한발 늦었어! 다른 색을 골라봐", true);
      });
      grid.appendChild(b);
    });
  }
  [...grid.children].forEach((b, i) => {
    const owner = colorsCache[i];
    b.classList.toggle("taken", !!owner && owner !== UID);
    b.classList.toggle("mine", owner === UID);
  });
}

function renderLobbyChars() {
  if (!meta || meta.status !== "lobby") return;
  const pg = $("playground");
  const ids = new Set(Object.keys(playersCache));
  // 나간 사람 제거
  for (const pid of Object.keys(wander)) {
    if (!ids.has(pid)) { wander[pid].el.remove(); delete wander[pid]; }
  }
  // 새 사람 추가 / 갱신
  for (const pid of ids) {
    const p = playersCache[pid];
    if (!wander[pid]) {
      const el = makeChar({ color: colorOf(pid), nick: p.nick, size: 64 });
      if (pid === UID) {
        el.classList.add("me");
        const mk = document.createElement("div");
        mk.className = "you-mark"; mk.textContent = "▼ 나";
        el.appendChild(mk);
      }
      pg.appendChild(el);
      const W = Math.max(80, pg.clientWidth - 80), H = Math.max(60, pg.clientHeight - 100);
      wander[pid] = {
        el,
        x: 20 + Math.random() * W, y: 20 + Math.random() * H,
        tx: 0, ty: 0, waitUntil: performance.now() + Math.random() * 1500, moving: false,
        speed: 42 + Math.random() * 40
      };
      el.style.left = wander[pid].x + "px";
      el.style.top = wander[pid].y + "px";
    }
    const w = wander[pid];
    w.el.style.setProperty("--char-color", colorOf(pid));
    const lbl = w.el.querySelector(".char-label");
    if (lbl && lbl.textContent !== p.nick) lbl.textContent = p.nick;
    w.el.style.opacity = p.online === false ? 0.35 : 1;
    // 방장 왕관
    const hasCrown = !!w.el.querySelector(".crown");
    if (meta.hostUid === pid && !hasCrown) {
      const c = document.createElement("div");
      c.className = "crown"; c.textContent = "👑";
      w.el.appendChild(c);
    } else if (meta.hostUid !== pid && hasCrown) {
      w.el.querySelector(".crown").remove();
    }
  }
  wanderStart();
}

function wanderStart() {
  if (wanderRaf) return;
  wanderPrev = performance.now();
  const loop = t => {
    if (window.__SM_FROZEN) { wanderRaf = 0; return; } // freeze 시 rAF 예약 중단 (unfreeze가 재시작)
    wanderRaf = requestAnimationFrame(loop);
    if (curScreen !== "scr-lobby") return;
    const dt = Math.min(0.05, (t - wanderPrev) / 1000);
    wanderPrev = t;
    const pg = $("playground");
    const W = Math.max(80, pg.clientWidth - 78), H = Math.max(60, pg.clientHeight - 105);
    for (const w of Object.values(wander)) {
      if (w.moving) {
        const dx = w.tx - w.x, dy = w.ty - w.y;
        const d = Math.hypot(dx, dy);
        if (d < 4) {
          w.moving = false;
          w.waitUntil = t + 700 + Math.random() * 2400;
          setMotion(w.el, "idle");
        } else {
          w.x += (dx / d) * w.speed * dt;
          w.y += (dy / d) * w.speed * dt;
          w.el.style.left = w.x + "px";
          w.el.style.top = w.y + "px";
        }
      } else if (t >= w.waitUntil) {
        w.tx = 10 + Math.random() * W;
        w.ty = 10 + Math.random() * H;
        w.moving = true;
        setMotion(w.el, "walk");
      }
    }
  };
  wanderRaf = requestAnimationFrame(loop);
}

function wanderStop() {
  cancelAnimationFrame(wanderRaf);
  wanderRaf = 0;
  for (const w of Object.values(wander)) w.el.remove();
  wander = {};
}

// 방장: 게임 시작
async function hostStartGame() {
  if (!isHost || !meta) return;
  const n = Math.min(10, Math.max(1, meta.rounds || 4));
  let seq = [];
  while (seq.length < n) seq = seq.concat(shuffleArr(GAME_IDS));
  seq = seq.slice(0, n);
  endedRounds = new Set();
  await net.dbUpdate(`rooms/${room}`, {
    "meta/status": "playing",
    "meta/rounds": n,
    "meta/curRound": 1,
    "meta/seq": seq,
    "meta/curGame": seq[0],
    "meta/phase": "slot",
    "meta/phaseEnd": net.now() + SLOT_MS,
    "meta/timeout": null,
    game: null,
    history: null
  });
}

function shuffleArr(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

// ═════════════════════════════════════════════
// 게임 진행 (클라이언트 연출)
// ═════════════════════════════════════════════
let currentGameMod = null;

function hideOverlays() {
  $("ovl-slot").classList.remove("show");
  $("ovl-intro").classList.remove("show");
  $("ovl-result").classList.remove("show");
}

function handlePhase() {
  const key = phaseKeyOf(meta);
  $("hudRound").textContent = `라운드 ${meta.curRound}/${meta.rounds}`;
  $("hudCode").textContent = room;
  if (key === lastPhaseKey) return;
  lastPhaseKey = key;
  earlyEndArmed = false;
  clearTimeout(earlyEndTimer);
  cancelAnimationFrame(slotRaf);

  switch (meta.phase) {
    case "slot":
      unmountGame();
      hideOverlays();
      runSlot();
      break;
    case "intro":
      runIntro();
      break;
    case "play":
      hideOverlays();
      mountGame();
      break;
    case "result":
      unmountGame();
      runResult(key);
      break;
  }
}

function mountGame() {
  const g = GAMES[meta.curGame];
  if (!g) return;
  unmountGame();
  const stage = $("gameStage"), dock = $("actionDock");
  stage.innerHTML = ""; dock.innerHTML = "";
  currentGameMod = g;
  const ctx = makeCtx();
  g.mount(stage, dock, ctx);
  g.onState(gameCache.state || null, ctx);
  g.onInputs(gameCache.inputs || null, ctx);
}

function unmountGame() {
  if (currentGameMod) {
    try { currentGameMod.unmount(); } catch { /* noop */ }
    currentGameMod = null;
  }
  const stage = $("gameStage"), dock = $("actionDock");
  if (stage) stage.innerHTML = "";
  if (dock) dock.innerHTML = "";
}

// 슬롯머신 연출
function runSlot() {
  const ovl = $("ovl-slot");
  ovl.classList.add("show");
  const reel = $("slotReel");
  const win = reel.parentElement;
  win.classList.remove("hit");
  const target = meta.curGame;
  const names = GAME_IDS.map(id => GAMES[id].name);
  const tIdx = GAME_IDS.indexOf(target);
  const items = [];
  for (let l = 0; l < 6; l++) items.push(...names);
  items.push(...names.slice(0, tIdx + 1));
  reel.innerHTML = items.map(n => `<div class="slot-item">${n}</div>`).join("");
  const H = 108;
  const total = items.length - 1;
  const dur = 6300;
  const t0 = performance.now();
  let lastIdx = -1;
  const loop = t => {
    const p = Math.min(1, (t - t0) / dur);
    const ease = 1 - Math.pow(1 - p, 3);
    const pos = ease * total;
    reel.style.transform = `translateY(${-pos * H}px)`;
    const idx = Math.round(pos);
    if (idx !== lastIdx) { lastIdx = idx; sfx.tick(); }
    if (p < 1) {
      slotRaf = requestAnimationFrame(loop);
    } else {
      win.classList.add("hit");
      sfx.tada();
    }
  };
  slotRaf = requestAnimationFrame(loop);
}

function runIntro() {
  $("ovl-slot").classList.remove("show");
  const g = GAMES[meta.curGame];
  $("introName").textContent = g.name;
  $("introTag").textContent = `' ${g.tag} '`;
  $("introDesc").innerHTML = g.desc;
  $("ovl-intro").classList.add("show");
  sfx.pop();
}

/** 소멸 위치에 잉크 파티클 뿌리기 */
function spawnPoof(el) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < 7; i++) {
    const d = document.createElement("span");
    d.className = "poof-dot";
    const a = Math.random() * Math.PI * 2;
    const dist = 26 + Math.random() * 40;
    d.style.left = cx + "px";
    d.style.top = cy + "px";
    d.style.setProperty("--dx", Math.cos(a) * dist + "px");
    d.style.setProperty("--dy", Math.sin(a) * dist - 14 + "px");
    d.style.animationDelay = (Math.random() * 0.08) + "s";
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 900);
  }
}

// 결과 연출: 시간초과 도장 → 탈락자 하나씩 소멸 → 승자 +1
async function runResult(token) {
  resultToken = token;
  const ovl = $("ovl-result");
  const stamp = $("stampTimeover");
  const field = $("resultField");
  const scoreEl = $("resultScore");
  stamp.style.display = "none";
  field.innerHTML = "";
  scoreEl.innerHTML = "";
  $("resultTitle").textContent = `${GAMES[meta.curGame].name} — 결과!`;
  ovl.classList.add("show");

  // 결과 데이터 대기 (호스트 쓰기 반영 레이스 대비)
  let waited = 0;
  while ((!gameCache.outcome) && waited < 3000) { await sleep(120); waited += 120; }
  if (resultToken !== token) return;
  const outcome = gameCache.outcome || {};
  const detail = gameCache.detail || {};

  if (meta && meta.timeout) {
    stamp.style.display = "";
    sfx.timeover();
    await sleep(2400);
    if (resultToken !== token) return;
  }

  const ids = Object.keys(playersCache).sort((a, b) => (playersCache[a].joined || 0) - (playersCache[b].joined || 0));
  const charMap = {};
  for (const pid of ids) {
    const el = makeChar({ color: colorOf(pid), nick: playersCache[pid].nick, size: 62 });
    if (pid === UID) el.classList.add("me");
    const d = document.createElement("div");
    d.className = "char-detail";
    d.textContent = detail[pid] || "";
    el.appendChild(d);
    charMap[pid] = el;
    field.appendChild(el);
  }
  await sleep(1400);
  if (resultToken !== token) return;

  const losers = ids.filter(pid => outcome[pid] !== "win" && outcome[pid] !== "mid");
  const mids = ids.filter(pid => outcome[pid] === "mid");
  const winners = ids.filter(pid => outcome[pid] === "win");

  // 탈락자 하나씩 소멸
  for (const pid of losers) {
    if (resultToken !== token) return;
    const el = charMap[pid];
    setFace(el, "sad");
    setMotion(el, "cry");
    await sleep(620);
    if (resultToken !== token) return;
    setMotion(el, "dissolve");
    spawnPoof(el);
    sfx.poof();
    await sleep(520);
  }
  await sleep(800);
  if (resultToken !== token) return;

  // 중간층은 그대로 (±0), 승자는 +1 한꺼번에
  for (const pid of mids) {
    const el = charMap[pid];
    const zero = document.createElement("div");
    zero.className = "plusone zeropop";
    zero.textContent = "±0";
    el.appendChild(zero);
  }
  if (winners.length) {
    sfx.win();
    sfx.coin();
    for (const pid of winners) {
      const el = charMap[pid];
      setFace(el, "happy");
      setMotion(el, "jump");
      const plus = document.createElement("div");
      plus.className = "plusone";
      plus.textContent = "+1";
      el.appendChild(plus);
    }
  }

  // 현재 점수판
  const sorted = ids.slice().sort((a, b) => (playersCache[b].score || 0) - (playersCache[a].score || 0));
  scoreEl.innerHTML = "";
  for (const pid of sorted) {
    const chip = document.createElement("span");
    chip.className = "score-chip sketch";
    chip.style.setProperty("--pc", colorOf(pid));
    chip.innerHTML = `<b></b> <span></span>`;
    chip.querySelector("b").textContent = playersCache[pid].nick;
    chip.querySelector("span").textContent = `${playersCache[pid].score || 0}점`;
    scoreEl.appendChild(chip);
  }
}

// 게임별 짧은 이름 (점수표 헤더용)
const GAME_SHORT = {
  nunchi: "눈치", mugunghwa: "무궁화", grab: "빨리집어", choseki: "초세기",
  whack: "두더지", typing: "타이핑", bomb: "폭탄", mash: "연타", block: "블록",
  simon: "가라사대"
};

// 최종 리더보드
function renderFinal() {
  if (finalShown) {
    $("btnAgain").style.display = isHost ? "" : "none";
    return;
  }
  finalShown = true;
  hideOverlays();
  unmountGame();
  const ids = Object.keys(playersCache).sort((a, b) =>
    (playersCache[b].score || 0) - (playersCache[a].score || 0) ||
    (playersCache[a].joined || 0) - (playersCache[b].joined || 0)
  );

  // 우승자 배너 + 춤
  const champ = ids[0];
  const banner = $("winnerBanner");
  banner.innerHTML = "";
  banner.append("🏆 ");
  const nameB = document.createElement("b");
  nameB.textContent = playersCache[champ].nick;
  nameB.style.color = colorOf(champ);
  banner.appendChild(nameB);
  banner.append(" 우승!!");

  const podium = $("podiumRow");
  podium.innerHTML = "";
  const top3 = ids.slice(0, 3);
  const order = [top3[1], top3[0], top3[2]].filter(Boolean);
  for (const pid of order) {
    const rank = ids.indexOf(pid) + 1;
    const div = document.createElement("div");
    div.className = "podium p" + rank;
    const ch = makeChar({
      color: colorOf(pid), nick: playersCache[pid].nick,
      size: rank === 1 ? 88 : 66,
      face: rank === 1 ? "happy" : "normal",
      motion: rank === 1 ? "dance" : "idle"
    });
    if (rank === 1) {
      const c = document.createElement("div");
      c.className = "crown"; c.textContent = "👑";
      ch.appendChild(c);
    }
    div.appendChild(ch);
    const block = document.createElement("div");
    block.className = "podium-block";
    block.textContent = rank;
    div.appendChild(block);
    const sc = document.createElement("div");
    sc.className = "p-score";
    sc.textContent = `${playersCache[pid].score || 0}점`;
    div.appendChild(sc);
    podium.appendChild(div);
  }

  // 게임별 점수표 (히스토리 매트릭스)
  buildBreakdown(ids);

  const list = $("rankList");
  list.innerHTML = "";
  ids.forEach((pid, i) => {
    const row = document.createElement("div");
    row.className = "rank-row";
    row.style.setProperty("--pc", colorOf(pid));
    row.innerHTML = `<span class="rk">${i + 1}위</span><span class="nm"></span><span class="sc">${playersCache[pid].score || 0}점</span>`;
    row.querySelector(".nm").textContent = playersCache[pid].nick + (pid === UID ? " (나)" : "");
    list.appendChild(row);
  });
  $("btnAgain").style.display = isHost ? "" : "none";
  sfx.tada();
  setTimeout(() => startMelody(), 700);
  // 별 낙서 컨페티
  let n = 0;
  const conf = setInterval(() => {
    if (n++ > 24 || curScreen !== "scr-final") { clearInterval(conf); return; }
    const s = document.createElement("span");
    s.className = "scribble-star";
    s.textContent = ["✦", "★", "✏️", "🎉", "⭐"][Math.floor(Math.random() * 5)];
    s.style.left = Math.random() * 96 + "vw";
    s.style.animationDuration = (2.4 + Math.random() * 2) + "s";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 4600);
  }, 220);
}

/** 최종 화면: 라운드×플레이어 ±1 매트릭스 */
function buildBreakdown(rankedIds) {
  const wrap = $("brkWrap");
  const scroll = $("brkScroll");
  const rounds = Object.keys(historyCache || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (!rounds.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const table = document.createElement("table");
  table.className = "brk-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.innerHTML = `<th class="brk-corner"></th>`;
  for (const r of rounds) {
    const g = historyCache[r].game;
    const th = document.createElement("th");
    th.className = "brk-gh";
    const span = document.createElement("span");
    span.textContent = `${r}. ${GAME_SHORT[g] || g}`;
    th.appendChild(span);
    hr.appendChild(th);
  }
  const thT = document.createElement("th");
  thT.className = "brk-totalh";
  thT.textContent = "합계";
  hr.appendChild(thT);
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let rowIdx = 0;
  for (const pid of rankedIds) {
    const tr = document.createElement("tr");
    tr.style.animationDelay = (0.25 + rowIdx++ * 0.16) + "s";
    const nameTd = document.createElement("td");
    nameTd.className = "brk-name";
    const mini = makeChar({ color: colorOf(pid), nick: null, size: 30, motion: "none" });
    mini.classList.add("brk-mini");
    nameTd.appendChild(mini);
    const nm = document.createElement("span");
    nm.textContent = playersCache[pid].nick;
    nm.style.color = colorOf(pid);
    nameTd.appendChild(nm);
    tr.appendChild(nameTd);
    for (const r of rounds) {
      const d = (historyCache[r].delta || {})[pid];
      const td = document.createElement("td");
      td.className = "brk-cell " + (d > 0 ? "plus" : d < 0 ? "minus" : "");
      td.textContent = d === undefined ? "–" : (d > 0 ? "+" + d : d);
      tr.appendChild(td);
    }
    const tot = document.createElement("td");
    tot.className = "brk-cell brk-total";
    tot.textContent = (playersCache[pid].score || 0) + "점";
    tr.appendChild(tot);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.innerHTML = "";
  scroll.appendChild(table);
}

// ═════════════════════════════════════════════
// 호스트 게임 루프
// ═════════════════════════════════════════════
function hostSchedule() {
  clearTimeout(hostTimer);
  if (!isHost || !meta || meta.status !== "playing" || !meta.phase || !meta.phaseEnd) return;
  const key = phaseKeyOf(meta);
  const delay = Math.max(0, meta.phaseEnd - net.now()) + 80;
  hostTimer = setTimeout(() => hostAdvance(key), delay);
}

async function hostAdvance(key) {
  if (!isHost || !meta || phaseKeyOf(meta) !== key) return;
  if (net.now() < (meta.phaseEnd || 0) - 30) { hostSchedule(); return; }
  try {
    switch (meta.phase) {
      case "slot":
        await net.dbUpdate(`rooms/${room}/meta`, { phase: "intro", phaseEnd: net.now() + INTRO_MS });
        break;
      case "intro":
        await hostStartPlay();
        break;
      case "play":
        await hostEndPlay(true);
        break;
      case "result":
        await hostAfterResult();
        break;
    }
  } catch (e) {
    console.error("hostAdvance", e);
    hostSchedule();
  }
}

async function hostStartPlay() {
  const g = GAMES[meta.curGame];
  const t0 = net.now() + 400;
  const nPlayers = Object.keys(playersCache).length;
  const state = g.hostSetup(makeCtx({ playStart: t0 }));
  await net.dbUpdate(`rooms/${room}`, {
    "game/state": state,
    "meta/phase": "play",
    "meta/playStart": t0,
    "meta/phaseEnd": t0 + g.duration(nPlayers)
  });
}

async function hostEndPlay(byTimer) {
  if (!meta || meta.phase !== "play") return;
  const rk = meta.curRound;
  if (endedRounds.has(rk)) return;
  endedRounds.add(rk);
  const g = GAMES[meta.curGame];
  const { outcome, detail } = g.evaluate(makeCtx(), (gameCache && gameCache.inputs) || {}, (gameCache && gameCache.state) || null);
  const losers = Object.values(outcome).filter(v => v !== "win" && v !== "mid").length;
  const showStamp = !!byTimer && g.stampOnTimeout !== false;
  const resultMs = (showStamp ? 2800 : 1200) + 1900 + losers * 1150 + 5600;
  const updates = {
    "game/outcome": outcome,
    "game/detail": detail,
    "meta/phase": "result",
    "meta/phaseEnd": net.now() + resultMs,
    "meta/timeout": showStamp
  };
  const delta = {};
  for (const pid of Object.keys(playersCache)) {
    const d = outcome[pid] === "win" ? 1 : outcome[pid] === "mid" ? 0 : -1;
    delta[pid] = d;
    updates[`players/${pid}/score`] = (playersCache[pid].score || 0) + d;
  }
  // 라운드별 기록 → 최종 리더보드의 게임별 점수표에 사용
  updates[`history/${rk}`] = { game: meta.curGame, delta };
  await net.dbUpdate(`rooms/${room}`, updates);
}

async function hostAfterResult() {
  if (meta.curRound < meta.rounds) {
    const next = meta.curRound + 1;
    await net.dbUpdate(`rooms/${room}`, {
      game: null,
      "meta/curRound": next,
      "meta/curGame": (meta.seq || GAME_IDS)[(next - 1) % (meta.seq || GAME_IDS).length],
      "meta/phase": "slot",
      "meta/phaseEnd": net.now() + SLOT_MS,
      "meta/timeout": null
    });
  } else {
    await net.dbUpdate(`rooms/${room}`, {
      game: null,
      "meta/status": "final",
      "meta/phase": null,
      "meta/timeout": null
    });
  }
}

function hostCheckEarly() {
  if (!isHost || !meta || meta.status !== "playing" || meta.phase !== "play") return;
  const g = GAMES[meta.curGame];
  if (!g) return;
  const ctx = makeCtx();
  if (g.hostTick) { try { g.hostTick(ctx, (gameCache && gameCache.state) || null, (gameCache && gameCache.inputs) || null, gameCache || {}); } catch { /* noop */ } }
  if (earlyEndArmed) return;
  let d = false;
  try { d = g.hostEarlyEnd(ctx, (gameCache && gameCache.inputs) || null, (gameCache && gameCache.state) || null); } catch { /* noop */ }
  if (d !== false) {
    earlyEndArmed = true;
    const key = phaseKeyOf(meta);
    earlyEndTimer = setTimeout(() => {
      if (phaseKeyOf(meta) === key) hostEndPlay(false);
    }, d);
  }
}

// ── HUD 타이머 ───────────────────────────────
let lastBeepSec = -1;
setInterval(() => {
  if (!meta || meta.status !== "playing") return;
  const fill = $("hudTimerFill"), sec = $("hudSec"), wrap = $("hudTimerWrap");
  if (meta.phase === "play" && meta.phaseEnd && meta.playStart) {
    const total = meta.phaseEnd - meta.playStart;
    const remain = Math.max(0, meta.phaseEnd - net.now());
    fill.style.width = (remain / total * 100) + "%";
    const s = Math.ceil(remain / 1000);
    sec.textContent = s;
    wrap.classList.toggle("urgent", remain < 10000);
    if (s <= 3 && s >= 1 && s !== lastBeepSec) { lastBeepSec = s; sfx.beep(); }
  } else {
    fill.style.width = "100%";
    sec.textContent = "–";
    wrap.classList.remove("urgent");
    lastBeepSec = -1;
  }
}, 250);

// 호스트 틱 — 조기종료 폴링 + 봇 구동
// 주의: botDrive는 반드시 이 인터벌에서만 호출할 것.
// onGameData(입력 변경 이벤트)에서 부르면 "쓰기→이벤트→쓰기" 폭주가 생긴다.
setInterval(() => { hostCheckEarly(); botDrive(); }, 450);

// ═════════════════════════════════════════════
// 테스트용 봇 (콘솔에서 __sm.addBots(3))
// ═════════════════════════════════════════════
function botIds() { return Object.keys(playersCache).filter(id => id.startsWith("bot_")); }

let botLastMove = 0;
function botDrive() {
  if (!isHost || !room || !meta || meta.phase !== "play") return;
  const nowMs = Date.now();
  if (nowMs - botLastMove < 380) return;
  botLastMove = nowMs;
  const state = (gameCache && gameCache.state) || null;
  const inputs = (gameCache && gameCache.inputs) || {};
  const g = meta.curGame;
  const t = net.now();
  for (const pid of botIds()) {
    const inp = inputs[pid];
    if (g === "nunchi") {
      if (!inp && Math.random() < 0.035) net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { t });
    } else if (g === "grab") {
      if (state && state.signalAt && t > state.signalAt && !inp && Math.random() < 0.35) {
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { dt: Math.round(t - state.signalAt) });
      }
    } else if (g === "choseki") {
      if (state && state.startAt && t > state.startAt + state.target * 1000 - 1200 && !inp && Math.random() < 0.3) {
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { e: Math.round(state.target * 1000 + (Math.random() * 1800 - 900)) });
      }
    } else if (g === "whack") {
      if (state && state.startAt && t > state.startAt && t < state.startAt + 30000 && Math.random() < 0.3) {
        const cur = (inp && inp.score) || 0;
        const roll = Math.random();
        const d = roll < 0.12 ? -2 : roll < 0.3 ? 3 : 1;
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { score: cur + d });
      }
    } else if (g === "typing") {
      if (state && state.seed !== undefined && state.startAt && t > state.startAt) {
        const words = genWords(state.seed).words;
        const e = t - state.startAt;
        const active = words.find(w => e >= w.at && e < w.at + w.ttl && w.type !== "trap");
        const claims = (gameCache && gameCache.claims) || {};
        if (active && !claims[active.i] && Math.random() < 0.12) {
          net.dbTxn(`rooms/${room}/game/claims/${active.i}`, cur => (cur === null ? { u: pid, t: Date.now() } : undefined)).catch(() => {});
        }
      }
    } else if (g === "mash") {
      if (state && state.startAt && t > state.startAt && t < state.startAt + 10000) {
        const cur = (inp && inp.n) || 0;
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { n: cur + 2 + Math.floor(Math.random() * 4) });
      }
    } else if (g === "block") {
      if (state && state.sub === "pick" && !(state.out || {})[pid]) {
        const key = "p" + state.round;
        if ((!inp || inp[key] === undefined) && Math.random() < 0.45) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { [key]: Math.floor(Math.random() * state.tiles) });
        }
      }
    } else if (g === "mugunghwa") {
      if (!state || state.sub !== "run" || pid === state.tagger) continue;
      const v = inp || { x: 0 };
      if (v.fin || v.caught) continue;
      const cy = state.cycle;
      if (cy && cy.mode === "look") {
        if (t >= cy.start + 250 && t <= cy.end && Math.random() < 0.12) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { caught: 1 });
        }
      } else {
        const step = (window.__SM_BOT_STEP || 2.6) + Math.random() * 1.6; // 테스트: __SM_BOT_STEP로 속도 조절
        const nx = Math.min(100, (v.x || 0) + step);
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`,
          nx >= 100 ? { x: 100, fin: 1 } : { x: Math.round(nx * 10) / 10 });
      }
    }
  }
}

window.__sm = {
  async addBots(n = 3) {
    if (!room) { console.warn("방에 먼저 들어가!"); return; }
    const existing = botIds().length;
    for (let i = 0; i < n; i++) {
      const id = `bot_${existing + i + 1}`;
      let colorIdx = -1;
      for (let ci = 0; ci < COLORS.length; ci++) {
        if (!colorsCache[ci]) { colorIdx = ci; colorsCache[ci] = id; break; }
      }
      await net.dbUpdate(`rooms/${room}`, {
        [`players/${id}`]: { nick: "봇" + (existing + i + 1), color: colorIdx, score: 0, online: true, bot: true, joined: Date.now() },
        [`colors/${colorIdx}`]: id
      });
    }
    console.log(n + "명의 봇 추가 완료");
  },
  async clearBots() {
    const updates = {};
    for (const pid of botIds()) {
      updates[`players/${pid}`] = null;
      const ci = playersCache[pid].color;
      if (ci >= 0) updates[`colors/${ci}`] = null;
    }
    await net.dbUpdate(`rooms/${room}`, updates);
  },
  state: () => ({ room, meta, playersCache, colorsCache, gameCache, isHost, UID }),
  net, // 테스트/디버깅용 (콘솔에서 직접 DB 조작)
  // 스크린샷/디버깅용: 모든 애니메이션 일시정지
  freeze() {
    window.__SM_FROZEN = true;
    stopMelody();
    if (!document.getElementById("freezeStyle")) {
      const st = document.createElement("style");
      st.id = "freezeStyle";
      st.textContent = "*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }";
      document.head.appendChild(st);
    }
  },
  unfreeze() {
    window.__SM_FROZEN = false;
    const st = document.getElementById("freezeStyle");
    if (st) st.remove();
    wanderPrev = performance.now();
    wanderStart();
  }
};

// ═════════════════════════════════════════════
// 초기화 / 이벤트 연결
// ═════════════════════════════════════════════
document.addEventListener("pointerdown", unlockAudio, { once: true });

$("btnMute").textContent = isMuted() ? "🔇" : "🔊";
$("btnMute").addEventListener("click", () => {
  $("btnMute").textContent = toggleMute() ? "🔇" : "🔊";
});

$("btnGoCreate").addEventListener("click", () => { sfx.click(); openEntry("create"); });
$("btnGoJoin").addEventListener("click", () => { sfx.click(); openEntry("join"); });
$("btnEntryBack").addEventListener("click", () => { sfx.click(); showScreen("scr-home"); $("btnEntryGo").disabled = false; });
$("btnEntryGo").addEventListener("click", submitEntry);
$("inpNick").addEventListener("keydown", e => { if (e.key === "Enter") { entryMode === "create" ? submitEntry() : $("inpCode").focus(); } });
$("inpCode").addEventListener("keydown", e => { if (e.key === "Enter") submitEntry(); });

$("roomCodeChip").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(room || "");
    toast("방 코드 복사 완료! 친구에게 붙여넣기 해줘 📋");
  } catch { toast("코드: " + room); }
});

$("btnRoundMinus").addEventListener("click", () => {
  if (!isHost || !meta) return;
  sfx.click();
  net.dbUpdate(`rooms/${room}/meta`, { rounds: Math.max(1, (meta.rounds || 4) - 1) });
});
$("btnRoundPlus").addEventListener("click", () => {
  if (!isHost || !meta) return;
  sfx.click();
  net.dbUpdate(`rooms/${room}/meta`, { rounds: Math.min(10, (meta.rounds || 4) + 1) });
});
$("btnStart").addEventListener("click", () => { sfx.tada(); hostStartGame(); });
$("btnLeaveLobby").addEventListener("click", () => { sfx.click(); leaveToHome(); });
$("btnFinalLeave").addEventListener("click", () => { sfx.click(); leaveToHome(); });
$("btnAgain").addEventListener("click", async () => {
  if (!isHost) return;
  sfx.click();
  finalShown = false;
  const updates = { "meta/status": "lobby", "meta/phase": null, "meta/curRound": 0, game: null, history: null, "meta/timeout": null };
  for (const pid of Object.keys(playersCache)) updates[`players/${pid}/score`] = 0;
  await net.dbUpdate(`rooms/${room}`, updates);
});

setupMascot();
setBgm(true); // 첫 화면(홈)부터 BGM — 실제 재생은 첫 터치 후 시작됨

// 부팅: 익명 로그인 → (있으면) 이전 방 자동 복귀
(async () => {
  try {
    UID = await net.ready();
  } catch (e) {
    toast("서버 연결에 실패했어… 인터넷을 확인해줘!", true);
    console.error(e);
    return;
  }
  const savedRoom = localStorage.getItem("sm_room");
  const savedNick = localStorage.getItem("sm_nick");
  if (savedRoom && savedNick) {
    try {
      const m = await net.dbGet(`rooms/${savedRoom}/meta`);
      const me = m ? await net.dbGet(`rooms/${savedRoom}/players/${UID}`) : null;
      if (m && me) {
        await net.joinRoom(savedRoom, savedNick);
        enterRoom(savedRoom);
        toast("아까 하던 방으로 다시 들어왔어! 👋");
      } else {
        localStorage.removeItem("sm_room");
      }
    } catch { localStorage.removeItem("sm_room"); }
  }
})();
