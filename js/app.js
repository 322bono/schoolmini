// 스쿨 미니 — 메인 앱 (화면 전환 / 로비 / 호스트 게임 루프 / 연출)
import { COLORS, MAX_PLAYERS, MAX_PLAYERS_MIN, MAX_PLAYERS_MAX } from "./config.js";
import * as net from "./net.js";
import { qrSvg } from "./qr.js";
import { sfx, unlockAudio, toggleMute, isMuted, stopMelody, setBgm, playFahh, playGong, playCheer, playHit, playDrumroll, playPodiumMusic, setRoundMusic, stopRoundMusic, stopSfxTails, resumeAudio } from "./sfx.js";
import { makeChar, setFace, setMotion, charSay } from "./character.js";
import { GAMES, GAME_IDS, genWords, genMoles } from "./games.js";
import { showSideRails, showInterstitial } from "./ads.js";
import { initDebug } from "./debug.js";

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 페이즈 길이 — 너무 빠르게 넘어가지 않도록 여유 있게
const SLOT_MS = 7800;
const INTRO_MS = 8400;
const SPICY_MS = 3800;
const SPICY_CHANCE = 0.10; // 라운드마다 스파이시(점수 3배) 확률

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
  // 감정표현 버튼은 로비(대기실)에서만
  $("btnEmote").style.display = id === "scr-lobby" ? "" : "none";
  $("emotePicker").hidden = true;
  // PC 홈 화면에서만 양쪽 세로 광고
  showSideRails(id === "scr-home");
  if (!silent) sfx.swoosh();
}

function colorOf(pid) {
  const idx = playersCache[pid] ? playersCache[pid].color : -1;
  return COLORS[idx] || "#9a958a";
}

function phaseKeyOf(m) { return m ? `${m.status}:${m.curRound}:${m.phase}` : ""; }

// 정상 플레이어 판별 — 나간 직후 방장의 점수 기록이 레이스로 되살린 "유령"({score}만 있는
// 닉네임 없는 항목)을 화면/순위에서 걸러낸다. 방장은 hostJanitor가 DB에서도 지워준다.
function isRealPlayer(p) { return p && p.nick !== undefined; }
function realIds() { return Object.keys(playersCache).filter(pid => isRealPlayer(playersCache[pid])); }

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
    txn: (path, fn, opts) => net.dbTxn(`rooms/${room}/${path}`, fn, opts),
    spicy: () => !!(meta && meta.spicy)
  }, over);
}

// ── P2P 구조 보강: 화면 꺼짐 방지 / 방장 자동 승계 / 재연결 복구 ──

// 게임 중엔 화면이 꺼지지 않게 (특히 방장 기기가 서버 역할이라 꺼지면 게임 전체가 멈춤)
let wakeLock = null;
async function syncWakeLock() {
  const want = !!(room && meta && meta.status === "playing");
  try {
    if (want && !wakeLock && navigator.wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      const wl = wakeLock;
      wakeLock = null;
      await wl.release();
    }
  } catch { wakeLock = null; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncWakeLock(); });

// 방장 연결이 끊기면(또는 나가면) 가장 먼저 들어온 온라인 플레이어가 자동으로 방장 승계.
// 단일 장애점 제거 — 방장이 사라져도 게임이 이어진다.
let hostDownSince = 0;
setInterval(() => {
  if (!room || !meta || !UID || !playersCache[UID]) return;
  const host = playersCache[meta.hostUid];
  const hostAlive = host && host.online !== false && !host.bot;
  if (hostAlive) { hostDownSince = 0; return; }
  if (!hostDownSince) { hostDownSince = Date.now(); return; }
  if (Date.now() - hostDownSince < 4000) return; // 잠깐 끊긴 건 기다려줌
  // 승계 1순위(온라인 인간 중 최선입)가 나일 때만 시도
  const cands = Object.keys(playersCache)
    .filter(id => playersCache[id] && playersCache[id].online !== false && !playersCache[id].bot)
    .sort((a, b) => (playersCache[a].joined || 0) - (playersCache[b].joined || 0));
  if (!cands.length || cands[0] !== UID) return;
  const oldHost = meta.hostUid;
  hostDownSince = 0;
  net.dbTxn(`rooms/${room}/meta/hostUid`, cur => (cur === oldHost ? UID : undefined)).catch(() => {});
}, 1500);

// 와이파이가 잠깐 끊겼다 돌아오면 online 표시와 접속 감지를 복구
// (이게 없으면 한 번 끊긴 사람은 영원히 "연결 끊김"으로 보이고 방장 승계도 오작동)
net.dbWatch(".info/connected", connected => {
  if (!connected || !room || !UID) return;
  net.dbUpdate(`rooms/${room}/players/${UID}`, { online: true }).catch(() => {});
  net.presence(`rooms/${room}/players/${UID}`); // onDisconnect는 발동 후 사라지므로 재장전
});

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
// 방 만들기 옵션 (마지막 선택 기억)
let createMax = Math.max(MAX_PLAYERS_MIN, Math.min(MAX_PLAYERS_MAX, Number(localStorage.getItem("sm_maxp")) || MAX_PLAYERS));
let createChat = localStorage.getItem("sm_chat") !== "0";
let createEmote = localStorage.getItem("sm_emote") !== "0";

function renderCreateOpts() {
  $("cMaxVal").textContent = createMax;
  const bc = $("btnOptChat"), be = $("btnOptEmote");
  bc.textContent = createChat ? "허용" : "금지";
  bc.classList.toggle("off", !createChat);
  be.textContent = createEmote ? "허용" : "금지";
  be.classList.toggle("off", !createEmote);
}

function openEntry(mode) {
  entryMode = mode;
  $("entryTitle").textContent = mode === "create" ? "게임 만들기" : "게임 참가하기";
  $("entryHint").textContent = mode === "create"
    ? "친구들에게 보여줄 닉네임을 정해줘!"
    : "닉네임이랑 친구가 알려준 방 코드를 입력해!";
  $("inpCode").style.display = mode === "create" ? "none" : "";
  $("createOpts").style.display = mode === "create" ? "" : "none";
  if (mode === "create") renderCreateOpts();
  $("btnEntryGo").textContent = mode === "create" ? "만들기!" : "참가하기!";
  $("inpNick").value = localStorage.getItem("sm_nick") || "";
  showScreen("scr-entry");
  setTimeout(() => $("inpNick").focus(), 250);
}

// 입장하면서 마이크 권한을 미리 받아둠 — 성대모사가 걸렸을 때 권한창 없이 바로 진행되게.
// 결과(허용/거부)는 플레이어 정보에 기록되어, 성대모사 주인공 뽑기에서 마이크 되는 사람만 후보가 된다.
async function checkMicPermission() {
  let ok = false;
  try {
    if (navigator.mediaDevices && window.MediaRecorder) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(tr => tr.stop()); // 권한만 확보하고 즉시 끔
      ok = true;
    }
  } catch { ok = false; }
  resumeAudio();
  if (room && UID) net.dbUpdate(`rooms/${room}/players/${UID}`, { micok: ok }).catch(() => {});
}

async function submitEntry() {
  const nick = $("inpNick").value.trim().slice(0, 8); // maxlength와 별개로 한 번 더 강제
  if (!nick) { toast("닉네임을 입력해줘!", true); return; }
  const btn = $("btnEntryGo");
  btn.disabled = true;
  try {
    localStorage.setItem("sm_nick", nick);
    if (entryMode === "create") {
      const code = await net.createRoom(nick, { maxPlayers: createMax, allowChat: createChat, allowEmote: createEmote });
      enterRoom(code);
    } else {
      const code = net.normalizeCode($("inpCode").value);
      if (code.length !== 4) { toast("방 코드는 4글자야!", true); btn.disabled = false; return; }
      await net.joinRoom(code, nick);
      enterRoom(code);
    }
    checkMicPermission(); // 입장 직후 (터치 제스처 흐름 안에서) 마이크 권한 요청
    showInterstitial();   // 방으로 넘어가는 전환 순간 광고 1개 (모바일/PC 공통)
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
  finalShown = false; finalSig = "";
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
  stopRoundMusic();
  stopSfxTails();
  room = null; meta = null; playersCache = {}; colorsCache = {}; gameCache = {}; historyCache = {};
  isHost = false; lastPhaseKey = ""; lastStatus = "";
  emoteSeen = {}; saySeen = {};
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
let lastHostUid = null;
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
  // 방장 승계 알림
  if (lastHostUid && meta.hostUid !== lastHostUid) {
    const np = playersCache[meta.hostUid];
    toast(isHost ? "방장 연결이 끊겨서 내가 새 방장이 됐어! 👑" : `방장이 ${np ? np.nick : "?"}(으)로 바뀌었어! 👑`);
    renderPlayerList();
    renderLobbyChars();
  }
  lastHostUid = meta.hostUid;
  syncWakeLock();
  if (lastStatus !== meta.status) lastPhaseKey = ""; // 매치 재시작 시 페이즈 키 초기화

  if (meta.status === "lobby") {
    if (lastStatus !== "lobby") {
      unmountGame();
      stopRoundMusic();
      hideOverlays();
      showScreen("scr-lobby");
    }
    renderLobbyMeta();
  } else if (meta.status === "playing") {
    if (lastStatus !== "playing") showScreen("scr-game");
    handlePhase();
  } else if (meta.status === "final") {
    if (lastStatus !== "final") { stopRoundMusic(); stopSfxTails(); showScreen("scr-final"); }
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
  handleEmotesAndChat();
  // 최종 화면에서 늦게 도착한 점수 동기화 반영 (모두 같은 우승자를 보게)
  if (meta && meta.status === "final") renderFinal();
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
  $("lobbyCount").textContent = `${n}/${meta.maxPlayers || MAX_PLAYERS}`;
  $("hostControls").style.display = isHost ? "flex" : "none";
  $("guestNotice").style.display = isHost ? "none" : "";
  $("roundsVal").textContent = meta.rounds || 4;
  // 방 설정에 따라 채팅/감정표현 숨김
  document.querySelector(".lobby-chat").style.display = meta.allowChat === false ? "none" : "";
  $("btnEmote").style.display = meta.allowEmote === false ? "none" : "";
  const start = $("btnStart");
  start.disabled = n < 2;
  start.title = n < 2 ? "2명부터 시작할 수 있어!" : "";
}

function renderPlayerList() {
  const list = $("playerList");
  if (!list) return;
  list.innerHTML = "";
  const ids = realIds().sort((a, b) => (playersCache[a].joined || 0) - (playersCache[b].joined || 0));
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
  const ids = new Set(realIds());
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
      if (w.emoteUntil && t < w.emoteUntil) continue; // 감정표현 중엔 배회 정지
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

// ── 로비 감정표현 + 채팅 ─────────────────────
const EMOTE_CD_MS = 5000;
let emoteSeen = {};   // pid → 마지막으로 재생한 emote.t
let saySeen = {};     // pid → 마지막으로 표시한 say.t
let emoteCdUntil = 0;
let lastChatSent = 0;

function handleEmotesAndChat() {
  if (curScreen !== "scr-lobby") return;
  const emoteOk = !meta || meta.allowEmote !== false;
  const chatOk = !meta || meta.allowChat !== false;
  const nowMs = net.now();
  for (const [pid, p] of Object.entries(playersCache)) {
    const em = p.emote;
    if (em && em.t && emoteSeen[pid] !== em.t) {
      // 입장 전에 쌓여 있던 낡은 값(8초 초과)은 기록만 하고 재생 안 함
      const fresh = emoteSeen[pid] !== undefined || nowMs - em.t < 8000;
      emoteSeen[pid] = em.t;
      if (fresh && emoteOk) playEmote(pid, em.k);
    }
    const sy = p.say;
    if (sy && sy.t && saySeen[pid] !== sy.t) {
      const fresh = saySeen[pid] !== undefined || nowMs - sy.t < 8000;
      saySeen[pid] = sy.t;
      if (fresh && chatOk && wander[pid]) charSay(wander[pid].el, String(sy.m || "").slice(0, 40), 3500);
    }
  }
}

function playEmote(pid, k) {
  const w = wander[pid];
  if (!w) return;
  const el = w.el;
  const t = performance.now();
  if (k === 1) {
    // 웃으면서 점프 (우승 모션)
    w.emoteUntil = t + 1300;
    w.moving = false;
    setFace(el, "happy");
    setMotion(el, "jump");
    sfx.pop();
    setTimeout(() => { if (wander[pid]) { setFace(el, "normal"); setMotion(el, "idle"); } }, 1300);
  } else if (k === 2) {
    // 풍차처럼 360도 돌며 오른쪽으로 이동
    const pg = $("playground");
    const maxX = Math.max(80, pg.clientWidth - 80);
    const dx = Math.min(90, Math.max(0, maxX - w.x));
    w.emoteUntil = t + 950;
    w.moving = false;
    setMotion(el, "none");
    el.style.setProperty("--emdx", dx + "px");
    el.classList.add("em-spin");
    sfx.swoosh();
    setTimeout(() => {
      el.classList.remove("em-spin");
      if (wander[pid]) {
        w.x += dx;
        el.style.left = w.x + "px";
        setMotion(el, "idle");
      }
    }, 950);
  } else if (k === 3) {
    // 물구나무 — 머리가 바닥에
    w.emoteUntil = t + 1650;
    w.moving = false;
    setMotion(el, "none");
    el.classList.add("em-flip");
    sfx.thud();
    setTimeout(() => {
      el.classList.remove("em-flip");
      if (wander[pid]) setMotion(el, "idle");
    }, 1650);
  } else if (k === 4) {
    // FAHHHH — 진동·캐릭터 반응을 소리가 실제로 시작되는 순간에 맞춰 시작 (싱크)
    w.emoteUntil = t + 1400;
    w.moving = false;
    playFahh(() => {
      if (!wander[pid]) return;
      setFace(el, "shock");
      setMotion(el, "shout");
      const pg = $("playground");
      pg.classList.remove("quake");
      void pg.offsetWidth;
      pg.classList.add("quake");
      setTimeout(() => pg.classList.remove("quake"), 700);
      setTimeout(() => { if (wander[pid]) { setFace(el, "normal"); setMotion(el, "idle"); } }, 900);
    });
  }
}

function sendEmote(k) {
  if (!room || curScreen !== "scr-lobby") return;
  if (meta && meta.allowEmote === false) return;
  const nowMs = Date.now();
  if (nowMs < emoteCdUntil) return;
  emoteCdUntil = nowMs + EMOTE_CD_MS;
  $("btnEmote").classList.add("cd");
  $("emotePicker").classList.add("cd");
  setTimeout(() => { $("btnEmote").classList.remove("cd"); $("emotePicker").classList.remove("cd"); }, EMOTE_CD_MS);
  $("emotePicker").hidden = true;
  net.dbUpdate(`rooms/${room}/players/${UID}/emote`, { k, t: net.now() });
}

function sendChat() {
  if (!room || curScreen !== "scr-lobby") return;
  if (meta && meta.allowChat === false) return;
  const inp = $("inpChat");
  const msg = inp.value.trim().slice(0, 40);
  if (!msg) return;
  const nowMs = Date.now();
  if (nowMs - lastChatSent < 1200) return; // 도배 방지
  lastChatSent = nowMs;
  inp.value = "";
  net.dbUpdate(`rooms/${room}/players/${UID}/say`, { m: msg, t: net.now() });
}

// 방장: 게임 시작 (더블탭으로 두 번 시작되지 않게 로비 상태 + 래치 이중 확인)
let startingMatch = false;
async function hostStartGame() {
  if (!isHost || !meta || meta.status !== "lobby" || startingMatch) return;
  startingMatch = true;
  setTimeout(() => { startingMatch = false; }, 2000);
  const n = Math.min(10, Math.max(1, meta.rounds || 4));
  let seq = [];
  while (seq.length < n) seq = seq.concat(shuffleArr(GAME_IDS));
  seq = seq.slice(0, n);
  endedRounds = new Set();
  const spicy = Math.random() < SPICY_CHANCE;
  await net.dbUpdate(`rooms/${room}`, {
    "meta/status": "playing",
    "meta/rounds": n,
    "meta/curRound": 1,
    "meta/seq": seq,
    "meta/curGame": seq[0],
    "meta/spicy": spicy,
    "meta/phase": spicy ? "spicy" : "slot",
    "meta/phaseEnd": net.now() + (spicy ? SPICY_MS : SLOT_MS),
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
  $("ovl-spicy").classList.remove("show");
}

function handlePhase() {
  const key = phaseKeyOf(meta);
  $("hudRound").textContent = `라운드 ${meta.curRound}/${meta.rounds}` + (meta.spicy ? " 🌶️×3" : "");
  $("hudCode").textContent = room;
  if (key === lastPhaseKey) return;
  lastPhaseKey = key;
  earlyEndArmed = false;
  clearTimeout(earlyEndTimer);
  cancelAnimationFrame(slotRaf);

  switch (meta.phase) {
    case "spicy":
      unmountGame();
      stopRoundMusic();
      stopSfxTails(); // 지난 라운드 박수 등 긴 꼬리 끊기
      hideOverlays();
      runSpicy();
      break;
    case "slot":
      unmountGame();
      stopRoundMusic();
      stopSfxTails(); // 두구두구 전에 남은 박수 끊기
      hideOverlays();
      runSlot();
      break;
    case "intro":
      runIntro();
      break;
    case "play":
      hideOverlays();
      // 이번 라운드 음악 예약 — 각 게임이 카운트다운 끝나는 순간 gameStartFx()로 시작
      setRoundMusic(meta.spicy ? "apex" : "sunny");
      mountGame();
      break;
    case "result":
      unmountGame();
      stopRoundMusic();
      runResult(key);
      break;
  }
}

// 스파이시 라운드 등장 연출
function runSpicy() {
  const ovl = $("ovl-spicy");
  ovl.classList.remove("show");
  void ovl.offsetWidth;
  ovl.classList.add("show");
  sfx.bbam();
  vibrate(250);
}

function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* noop */ } }

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
  const DRUM_MS = 3080; // drumroll.mp3 길이 — 멈추는 순간에 딱 끝나게 시작
  const t0 = performance.now();
  let lastIdx = -1;
  let drumStarted = false;
  const loop = t => {
    const p = Math.min(1, (t - t0) / dur);
    const ease = 1 - Math.pow(1 - p, 3);
    const pos = ease * total;
    reel.style.transform = `translateY(${-pos * H}px)`;
    const idx = Math.round(pos);
    if (idx !== lastIdx) { lastIdx = idx; sfx.tick(); }
    if (!drumStarted && t - t0 >= dur - DRUM_MS) {
      drumStarted = true;
      playDrumroll(); // 두구두구… 결정 순간까지 고조
    }
    if (p < 1) {
      slotRaf = requestAnimationFrame(loop);
    } else {
      win.classList.add("hit");
      playHit(); // 딱! 결정 임팩트
    }
  };
  slotRaf = requestAnimationFrame(loop);
}

function runIntro() {
  $("ovl-slot").classList.remove("show");
  const g = GAMES[meta.curGame];
  if (!g) return;
  $("introName").textContent = g.name;
  $("introTag").textContent = `' ${g.tag} '`;
  const demoWrap = $("introDemo");
  demoWrap.innerHTML = "";
  if (g.demo) demoWrap.appendChild(g.demo());
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
  $("resultTitle").textContent = `${(GAMES[meta.curGame] || {}).name || "게임"} — 결과!`;
  ovl.classList.add("show");
  playGong(); // 결과 발표 공소리 (스파이시 포함 항상)

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

  // 스냅샷 — 연출(~10초) 도중 누가 방을 나가도 접근 오류 없이 끝까지 그린다
  const snap = Object.assign({}, playersCache);
  const pOf = pid => playersCache[pid] || snap[pid] || { nick: "?", score: 0 };
  const ids = realIds().sort((a, b) => (pOf(a).joined || 0) - (pOf(b).joined || 0));
  const charMap = {};
  for (const pid of ids) {
    const el = makeChar({ color: colorOf(pid), nick: pOf(pid).nick, size: 62 });
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
    playCheer(); // 환호+박수는 승자들이 점프하는 이 순간에
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

  // 현재 점수판 — 연출 도중 나간 사람은 제외
  const sorted = ids.filter(pid => isRealPlayer(playersCache[pid]))
    .sort((a, b) => (pOf(b).score || 0) - (pOf(a).score || 0));
  scoreEl.innerHTML = "";
  for (const pid of sorted) {
    const chip = document.createElement("span");
    chip.className = "score-chip sketch";
    chip.style.setProperty("--pc", colorOf(pid));
    chip.innerHTML = `<b></b> <span></span>`;
    chip.querySelector("b").textContent = pOf(pid).nick;
    chip.querySelector("span").textContent = `${pOf(pid).score || 0}점`;
    scoreEl.appendChild(chip);
  }
}

// 게임별 짧은 이름 (점수표 헤더용)
const GAME_SHORT = {
  nunchi: "눈치", mugunghwa: "무궁화", grab: "빨리집어", choseki: "초세기",
  whack: "두더지", typing: "타이핑", mash: "연타", block: "블록",
  tug: "줄다리기", wake: "깨우기", avg: "눈치숫자", boss: "막타", spin: "팽이",
  voice: "성대모사", omr: "찍기", balloon: "풍선", bolt: "번개",
  bomb: "폭탄", rps: "가위바위보", vote: "동상이몽", math: "암산", quiz: "퀴즈", syncbtn: "눈치버튼", slot: "슬롯"
};

// 최종 리더보드 — 내용은 데이터가 바뀔 때마다 다시 그림 (첫 렌더 시점에 점수 동기화가
// 덜 끝난 클라이언트가 낡은 순위를 계속 보는 "사람마다 우승자 다름" 버그 방지).
// 팡파레·음악·컨페티만 1회.
let finalSig = "";
let raceAnimating = false;
function rankedFinalIds() {
  return realIds().sort((a, b) =>
    (playersCache[b].score || 0) - (playersCache[a].score || 0) ||
    (playersCache[a].joined || 0) - (playersCache[b].joined || 0)
  );
}
function renderFinal() {
  const ids = rankedFinalIds();
  if (!ids.length) return;
  const sig = ids.map(pid => pid + ":" + (playersCache[pid].score || 0)).join(",");
  // 집계 연출 진행 중엔 데이터 갱신에 의한 재렌더를 무시(최신 sig만 기억).
  // 애니메이션 도중 화면을 갈아엎어 튀는 것 방지.
  if (finalShown && raceAnimating) { finalSig = sig; return; }
  if (finalShown && sig === finalSig) {
    $("btnAgain").style.display = isHost ? "" : "none";
    return;
  }
  finalSig = sig;
  const firstTime = !finalShown;
  finalShown = true;
  hideOverlays();
  unmountGame();

  // 첫 렌더 + 라운드 기록 2개 이상이면 '점수 집계 바 레이스' 연출로 시작
  const rounds = Object.keys(historyCache || {}).map(Number).filter(n => !isNaN(n));
  if (firstTime && rounds.length >= 2) { runFinalRace(ids); return; }
  renderFinalStatic(ids, firstTime);
}

// 최종 정적 화면(배너·시상대·점수표·순위) — 연출 없이 최종값을 그린다.
// celebrate=true 일 때만 팡파레·음악·컨페티 (연출을 거치지 않은 즉시 렌더용).
function renderFinalStatic(ids, celebrate) {
  const champ = ids[0];
  const banner = $("winnerBanner");
  banner.style.display = "";
  banner.innerHTML = "";
  banner.append("🏆 ");
  const nameB = document.createElement("b");
  nameB.textContent = playersCache[champ].nick;
  nameB.style.color = colorOf(champ);
  banner.appendChild(nameB);
  banner.append(" 우승!!");

  const podium = $("podiumRow");
  podium.style.display = "";
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
  list.style.display = "";
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
  if (!celebrate) return;
  sfx.tada();
  setTimeout(() => playPodiumMusic(), 700);
  finalConfetti();
}

// 별 낙서 컨페티 (연출/즉시 공용)
function finalConfetti() {
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

// 점수 집계 바 레이스 — 0점에서 시작해 라운드별 ±점수가 하나씩 얹히며
// 막대가 자라고 순위가 재정렬되다가 마지막에 우승자가 확정되는 연출.
async function runFinalRace(ids) {
  raceAnimating = true;
  for (const id of ["winnerBanner", "podiumRow", "brkWrap", "rankList"]) $(id).style.display = "none";
  $("btnAgain").style.display = "none";

  const stage = $("raceStage"), barsWrap = $("raceBars"), head = $("raceHead");
  stage.style.display = "";
  barsWrap.innerHTML = "";
  head.textContent = "지금까지 점수 집계!";

  const rounds = Object.keys(historyCache || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  const cum = {}; ids.forEach(p => cum[p] = 0);
  const barMax = Math.max(1, ...ids.map(p => playersCache[p].score || 0));
  const rowH = ids.length > 8 ? 34 : 44;
  const bySeat = ids.slice().sort((a, b) => (playersCache[a].joined || 0) - (playersCache[b].joined || 0));

  const bar = {};
  bySeat.forEach(pid => {
    const el = document.createElement("div");
    el.className = "race-bar";
    el.style.setProperty("--pc", colorOf(pid));
    el.style.height = (rowH - 6) + "px";
    el.innerHTML = `<span class="race-rank">–</span><span class="race-ava"></span><span class="race-name"></span><span class="race-track"><span class="race-fill"></span></span><span class="race-val">0</span><span class="race-delta"></span>`;
    el.querySelector(".race-name").textContent = playersCache[pid].nick + (pid === UID ? " (나)" : "");
    const mini = makeChar({ color: colorOf(pid), nick: null, size: 26, motion: "none" });
    mini.classList.add("race-mini");
    el.querySelector(".race-ava").appendChild(mini);
    barsWrap.appendChild(el);
    bar[pid] = el;
  });
  barsWrap.style.height = (ids.length * rowH) + "px";

  const layout = () => {
    const order = ids.slice().sort((a, b) => (cum[b] - cum[a]) || ((playersCache[a].joined || 0) - (playersCache[b].joined || 0)));
    order.forEach((pid, i) => {
      const el = bar[pid];
      el.style.transform = `translateY(${i * rowH}px)`;
      el.style.zIndex = ids.length - i;
      el.querySelector(".race-rank").textContent = i + 1;
      el.classList.toggle("lead", i === 0);
      const w = Math.max(cum[pid] > 0 ? 5 : 0, Math.min(100, cum[pid] / barMax * 100));
      el.querySelector(".race-fill").style.width = w + "%";
      el.querySelector(".race-val").textContent = cum[pid];
    });
  };
  layout();
  await sleep(650);

  for (const r of rounds) {
    if (curScreen !== "scr-final") { raceAnimating = false; return; } // 화면 이탈 시 중단
    const g = historyCache[r].game;
    const delta = historyCache[r].delta || {};
    head.innerHTML = "";
    const rb = document.createElement("b"); rb.textContent = r + "라운드";
    head.appendChild(rb); head.append(" · " + (GAME_SHORT[g] || g));
    let any = false;
    ids.forEach(pid => {
      const d = delta[pid];
      const chip = bar[pid].querySelector(".race-delta");
      if (d === undefined || d === 0) { chip.textContent = ""; chip.className = "race-delta"; }
      else { chip.textContent = (d > 0 ? "+" + d : d); chip.className = "race-delta show " + (d > 0 ? "up" : "down"); any = true; }
      cum[pid] += (d || 0);
    });
    if (any) sfx.coin();
    layout();
    await sleep(1000);
    ids.forEach(pid => { bar[pid].querySelector(".race-delta").className = "race-delta"; });
    await sleep(160);
  }

  // 피날레 — 우승자 확정
  if (curScreen !== "scr-final") { raceAnimating = false; return; }
  head.innerHTML = "";
  const fb = document.createElement("b"); fb.textContent = "최종 결과!"; head.appendChild(fb);
  const champ = ids[0];
  bar[champ].classList.add("champ");
  bar[champ].querySelector(".race-rank").textContent = "👑";
  sfx.tada(); vibrate(200);
  finalConfetti();
  await sleep(800);
  playPodiumMusic();
  await sleep(450);

  raceAnimating = false;
  renderFinalStatic(ids, false); // 배너·시상대·점수표·순위를 아래에 드러냄(연출/소리 없이)
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
      case "spicy":
        await net.dbUpdate(`rooms/${room}/meta`, { phase: "slot", phaseEnd: net.now() + SLOT_MS });
        break;
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
  if (!g) return;
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
  if (!g) return;
  const res = g.evaluate(makeCtx(), (gameCache && gameCache.inputs) || {}, (gameCache && gameCache.state) || null);
  const { outcome, detail } = res;
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
  const mult = meta.spicy ? 3 : 1; // 스파이시 라운드: 점수 3배 (+/- 모두)
  const delta = {};
  for (const pid of realIds()) {
    // 게임이 자체 점수(delta)를 주면 그걸 사용 (예: 보스 막타 +3 독식)
    const base = res.delta && res.delta[pid] !== undefined
      ? res.delta[pid]
      : (outcome[pid] === "win" ? 1 : outcome[pid] === "mid" ? 0 : -1);
    // 게임이 스파이시 전용 점수(spicyDelta)를 주면 ×배율 대신 그 값을 그대로 사용
    // (예: 보스 막타는 ×3=+9이 과해서 스파이시라도 +5 고정)
    const d = (meta.spicy && res.spicyDelta && res.spicyDelta[pid] !== undefined)
      ? res.spicyDelta[pid]
      : base * mult;
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
    const spicy = Math.random() < SPICY_CHANCE;
    await net.dbUpdate(`rooms/${room}`, {
      game: null,
      "meta/curRound": next,
      "meta/curGame": (meta.seq || GAME_IDS)[(next - 1) % (meta.seq || GAME_IDS).length],
      "meta/spicy": spicy,
      "meta/phase": spicy ? "spicy" : "slot",
      "meta/phaseEnd": net.now() + (spicy ? SPICY_MS : SLOT_MS),
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
  // 일부 게임(초세기/암산/퀴즈)은 '남은 초'가 힌트가 되므로 상단 타이머 바 + 숫자 통째로 숨김
  const hideTimer = !!(GAMES[meta.curGame] && GAMES[meta.curGame].hideHudTimer);
  wrap.style.display = hideTimer ? "none" : "";
  sec.style.display = hideTimer ? "none" : "";
  if (hideTimer) { lastBeepSec = -1; return; }
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

// 방장 청소: 점수 기록과 퇴장이 엇갈리며 되살아난 유령 항목({score}만 있는 플레이어)을 제거
let janitorBusy = {};
function hostJanitor() {
  if (!isHost || !room) return;
  for (const [pid, p] of Object.entries(playersCache)) {
    if (isRealPlayer(p) || janitorBusy[pid]) continue;
    janitorBusy[pid] = true;
    const updates = { [`players/${pid}`]: null };
    if (p && p.color >= 0 && colorsCache[p.color] === pid) updates[`colors/${p.color}`] = null;
    net.dbUpdate(`rooms/${room}`, updates)
      .catch(() => {})
      .finally(() => { delete janitorBusy[pid]; });
  }
}

// 호스트 틱 — 조기종료 폴링 + 봇 구동 + 유령 청소
// 주의: botDrive는 반드시 이 인터벌에서만 호출할 것.
// onGameData(입력 변경 이벤트)에서 부르면 "쓰기→이벤트→쓰기" 폭주가 생긴다.
setInterval(() => { hostCheckEarly(); botDrive(); hostJanitor(); }, 450);

// ═════════════════════════════════════════════
// 테스트용 봇 (콘솔에서 __sm.addBots(3))
// ═════════════════════════════════════════════
function botIds() { return Object.keys(playersCache).filter(id => id.startsWith("bot_")); }

let botLastMove = 0;
const slotBotNext = {}; // 슬롯머신 봇별 다음 스핀 시각
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
      // 공유 두더지 선착순 클레임 — 봇도 사람처럼 활성 두더지를 두고 경쟁
      if (state && state.seed !== undefined && state.startAt && t > state.startAt) {
        const e = t - state.startAt;
        const claims = (gameCache && gameCache.claims) || {};
        const active = genMoles(state.seed).find(ev =>
          e >= ev.at && e < ev.at + ev.ttl && !claims[ev.i] &&
          (ev.type !== "bomb" || Math.random() < 0.15));
        if (active && Math.random() < 0.25) {
          net.dbTxn(`rooms/${room}/game/claims/${active.i}`, cur => (cur === null ? { u: pid, t: Date.now() } : undefined)).catch(() => {});
        }
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
    } else if (g === "avg") {
      if (state && state.startAt && t > state.startAt && !inp && Math.random() < 0.15) {
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { v: 20 + Math.floor(Math.random() * 61) });
      }
    } else if (g === "boss") {
      if (state && state.startAt && t > state.startAt && !state.killer && state.hp > 0) {
        const dmg = 2 + Math.floor(Math.random() * 4);
        net.dbTxn(`rooms/${room}/game/state`, cur => {
          if (!cur || cur.killer || cur.hp <= 0) return;
          const nhp = cur.hp - dmg;
          if (nhp <= 0) return Object.assign({}, cur, { hp: 0, killer: pid, killAt: t });
          return Object.assign({}, cur, { hp: nhp });
        }, { applyLocally: false }).catch(() => {});
      }
    } else if (g === "spin") {
      if (state && state.startAt && t > state.startAt + 6200 && !inp) {
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { r: 200 + Math.floor(Math.random() * 800) });
      }
    } else if (g === "block") {
      if (state && state.sub === "pick" && !(state.out || {})[pid]) {
        const key = "p" + state.round;
        if ((!inp || inp[key] === undefined) && Math.random() < 0.45) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { [key]: Math.floor(Math.random() * state.tiles) });
        }
      }
    } else if (g === "omr") {
      if (state && state.sub === "mark" && state.startAt && t > state.startAt) {
        const v = inp || {};
        let qi = 0;
        while (qi < 10 && typeof v["a" + qi] === "number") qi++;
        if (qi < 10 && Math.random() < 0.5) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { ["a" + qi]: Math.floor(Math.random() * 5) });
        }
      }
    } else if (g === "balloon") {
      if (state && state.startAt && t > state.startAt && !(inp && inp.pop)) {
        // 봇은 목표 크기까지만 부풀림 (터지기 전 멈춤 — 다양성 위해 봇마다 다른 목표)
        const cap = (window.__SM_BOT_BALLOON || 55) + (Math.abs(pid.charCodeAt(pid.length - 1)) % 30);
        const cur = (inp && inp.s) || 12;
        if (cur < cap) net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { s: Math.min(cap, cur + 4 + Math.floor(Math.random() * 5)), pop: 0 });
      }
    } else if (g === "bolt") {
      if (state && state.startAt && t > state.startAt && !(inp && inp.dead)) {
        // 봇은 대충 좌우로 왔다갔다 (완벽히 피하진 못함)
        const e = t - state.startAt;
        const x = 50 + Math.sin((e / 700) + pid.charCodeAt(pid.length - 1)) * 42;
        net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { x: Math.round(x * 10) / 10, e: Math.round(e) });
      }
    } else if (g === "bomb") {
      // 봇이 폭탄을 들고 있으면 잠깐 뒤 생존자 아무에게 넘김 (확률 폭발 판정 그대로 적용)
      if (state && state.sub === "live" && state.holder === pid && state.startAt && t > state.startAt) {
        if (t >= (state.holdSince || 0) + 700 + Math.random() * 1100) {
          const survivors = Object.keys(playersCache).filter(id => id !== pid && !(state.out || {})[id]);
          const tgt = survivors[Math.floor(Math.random() * survivors.length)];
          if (tgt) net.dbTxn(`rooms/${room}/game/state`, cur => {
            if (!cur || cur.sub !== "live" || cur.holder !== pid) return;
            if (t < (cur.holdSince || 0) + 400 || (cur.out || {})[tgt]) return;
            const pc = (cur.passCount || 0) + 1;
            const patch = { holder: tgt, lastPasser: pid, holdSince: t, passCount: pc };
            if (pc >= cur.explodeOn) { patch.sub = "boom"; patch.loser = tgt; patch.boomAt = t; }
            return Object.assign({}, cur, patch);
          }).catch(() => {});
        }
      }
    } else if (g === "rps") {
      if (state && state.sub === "pick" && !(state.out || {})[pid] && state.pairs && state.pairs[pid] != null) {
        const key = "h" + state.round;
        if ((!inp || inp[key] === undefined) && Math.random() < 0.4) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { [key]: Math.floor(Math.random() * 3) });
        }
      }
    } else if (g === "vote") {
      if (state && state.sub === "ask" && state.startAt && t > state.startAt) {
        const key = "v" + state.q;
        if ((!inp || inp[key] === undefined) && Math.random() < 0.3) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { [key]: Math.random() < 0.5 ? 0 : 1 });
        }
      }
    } else if (g === "math") {
      if (state && state.sub === "ask" && state.qStart && t > state.qStart + 900) {
        const key = "q" + state.i;
        // 봇: 뒤 문제일수록 가중치가 커지므로 대충 후반에 점수 폭을 키움
        const w = state.i < 3 ? 1 : state.i < 6 ? 1.5 : state.i < 8 ? 2 : 2.5;
        if ((!inp || inp[key] === undefined) && Math.random() < 0.4) {
          const base = Math.random() < 0.5 ? 2 : Math.random() < 0.7 ? 1 : -1;
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { [key]: Math.round(base * w) });
        }
      }
    } else if (g === "quiz") {
      if (state && state.sub === "ask" && state.qStart && t > state.qStart + 700 && (!inp || inp.a === undefined)) {
        if (Math.random() < 0.35) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { a: Math.floor(Math.random() * 4), t: Math.round(t - state.qStart) });
        }
      }
    } else if (g === "syncbtn") {
      if (state && state.startAt && t > state.startAt && t < state.endAt) {
        const ts = (inp && inp.ts) || [];
        const last = ts.length ? ts[ts.length - 1] : 0;
        if (t - last > 400 + Math.random() * 700) {
          ts.push(t);
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { ts: ts.slice(-80) });
        }
      }
    } else if (g === "slot") {
      // 봇은 자기 슬롯을 주기적으로 돌려 ±1~±3 (특수는 생략 — 테스트용)
      const out = (gameCache.out) || {};
      if (state && state.startAt && t > state.startAt && t < state.endAt && !out[pid]) {
        if (t >= (slotBotNext[pid] || 0)) {
          slotBotNext[pid] = t + 2000 + Math.random() * 1600;
          const d = Math.random() < 0.5 ? 1 : Math.random() < 0.65 ? -1 : Math.random() < 0.5 ? 3 : -3;
          net.dbTxn(`rooms/${room}/game/scores/${pid}`, cur => (cur || 0) + d).catch(() => {});
        }
      }
    } else if (g === "mugunghwa") {
      if (!state || state.sub !== "run" || pid === state.tagger) continue;
      const v = inp || { x: 0 };
      if (v.fin || v.caught) continue;
      const cy = state.cycle;
      if (cy && cy.mode === "look") {
        if (t >= cy.start + 600 && t <= cy.end && Math.random() < 0.12) {
          net.dbUpdate(`rooms/${room}/game/inputs/${pid}`, { caught: 1 });
        }
      } else {
        const step = (window.__SM_BOT_STEP || 1.0) + Math.random() * 0.7; // 봇 도망자 속도(사람과 맞춰 더 낮춤). 테스트: __SM_BOT_STEP
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
// iOS에서 마이크·전화·시리 등으로 오디오가 중단됐을 때 터치/화면 복귀 시 자동 복구
document.addEventListener("pointerdown", resumeAudio);
document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeAudio(); });

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
// 방 만들기 옵션들
$("btnCMaxMinus").addEventListener("click", () => {
  sfx.click();
  createMax = Math.max(MAX_PLAYERS_MIN, createMax - 1);
  localStorage.setItem("sm_maxp", createMax);
  renderCreateOpts();
});
$("btnCMaxPlus").addEventListener("click", () => {
  sfx.click();
  createMax = Math.min(MAX_PLAYERS_MAX, createMax + 1);
  localStorage.setItem("sm_maxp", createMax);
  renderCreateOpts();
});
$("btnOptChat").addEventListener("click", () => {
  sfx.click();
  createChat = !createChat;
  localStorage.setItem("sm_chat", createChat ? "1" : "0");
  renderCreateOpts();
});
$("btnOptEmote").addEventListener("click", () => {
  sfx.click();
  createEmote = !createEmote;
  localStorage.setItem("sm_emote", createEmote ? "1" : "0");
  renderCreateOpts();
});

// ── QR 초대 ──────────────────────────────────
$("btnQr").addEventListener("click", () => {
  if (!room) return;
  sfx.click();
  $("qrBox").innerHTML = qrSvg(`${location.origin}${location.pathname}?join=${room}`);
  $("qrCodeLbl").textContent = room;
  $("qrModal").hidden = false;
});
$("btnQrClose").addEventListener("click", () => { $("qrModal").hidden = true; });
$("qrModal").addEventListener("pointerdown", e => {
  if (e.target === $("qrModal")) $("qrModal").hidden = true;
});
// 감정표현 버튼 + 피커
$("btnEmote").addEventListener("click", () => {
  if (Date.now() < emoteCdUntil) return;
  sfx.click();
  $("emotePicker").hidden = !$("emotePicker").hidden;
});
document.querySelectorAll(".emote-opt").forEach(b => {
  b.addEventListener("click", () => sendEmote(Number(b.dataset.k)));
});
document.addEventListener("pointerdown", e => {
  // 피커 밖을 누르면 닫기
  const pk = $("emotePicker");
  if (!pk.hidden && !pk.contains(e.target) && e.target !== $("btnEmote")) pk.hidden = true;
});

// 로비 채팅
$("btnChatSend").addEventListener("click", sendChat);
$("inpChat").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

$("btnStart").addEventListener("click", () => { sfx.tada(); hostStartGame(); });
$("btnLeaveLobby").addEventListener("click", () => { sfx.click(); leaveToHome(); });
$("btnFinalLeave").addEventListener("click", () => { sfx.click(); leaveToHome(); });
$("btnAgain").addEventListener("click", async () => {
  if (!isHost) return;
  sfx.click();
  finalShown = false; finalSig = "";
  const updates = { "meta/status": "lobby", "meta/phase": null, "meta/curRound": 0, game: null, history: null, "meta/timeout": null, "meta/spicy": null };
  for (const pid of Object.keys(playersCache)) updates[`players/${pid}/score`] = 0;
  await net.dbUpdate(`rooms/${room}`, updates);
});

setupMascot();
setBgm(true); // 첫 화면(홈)부터 BGM — 실제 재생은 첫 터치 후 시작됨
showSideRails(curScreen === "scr-home"); // 초기 홈은 이미 활성 상태라 showScreen이 안 불림 → 여기서 한 번

// ── 개발자용 디버그 모드 ──────────────────────────
// 모든 동작은 "내가 방장인 내 방"에만 적용되는 평소 방장 권한의 단축키일 뿐.
// 게임 규칙/점수/일반 사용자에겐 일절 영향 없음 (debug.js 참고).
const debugApi = {
  GAMES, GAME_IDS,
  toast,
  get: () => ({ room, meta, isHost, UID, players: playersCache, game: gameCache, curScreen }),
  addBots: (n) => window.__sm.addBots(n),
  clearBots: () => window.__sm.clearBots(),
  async testRoom() {
    if (room) { toast("이미 방에 있어! 먼저 나가줘", true); return; }
    const nick = localStorage.getItem("sm_nick") || "개발자";
    const code = await net.createRoom(nick, {});
    enterRoom(code);
    await sleep(400);
    await window.__sm.addBots(3);
  },
  _requireHost() {
    if (!room || !meta) { toast("먼저 방에 들어가!", true); return false; }
    if (!isHost) { toast("방장만 가능해 (지금 넌 방장이 아님)", true); return false; }
    return true;
  },
  async startGame(gameId, { spicy = false, skipAnim = false } = {}) {
    if (!this._requireHost() || !GAMES[gameId]) return;
    const cur = (meta.curRound && meta.curRound >= 1) ? meta.curRound : 1;
    const seq = (meta.seq && meta.seq.length) ? meta.seq.slice() : GAME_IDS.slice();
    seq[(cur - 1) % seq.length] = gameId; // 현재 라운드 게임만 교체 (뒤 라운드는 그대로)
    endedRounds.delete(cur);
    const upd = {
      "meta/status": "playing", "meta/curRound": cur,
      "meta/rounds": Math.max(meta.rounds || 4, cur),
      "meta/seq": seq, "meta/curGame": gameId, "meta/spicy": !!spicy,
      "meta/timeout": null, game: null
    };
    if (skipAnim) {
      const g = GAMES[gameId];
      const t0 = net.now() + 300;
      upd["meta/phase"] = "play";
      upd["meta/playStart"] = t0;
      upd["meta/phaseEnd"] = t0 + g.duration(Object.keys(playersCache).length);
      upd.game = { state: g.hostSetup(makeCtx({ playStart: t0 })) };
    } else {
      upd["meta/phase"] = spicy ? "spicy" : "slot";
      upd["meta/phaseEnd"] = net.now() + (spicy ? SPICY_MS : SLOT_MS);
    }
    await net.dbUpdate(`rooms/${room}`, upd);
  },
  async jump(phase) {
    if (!this._requireHost()) return;
    if (phase === "play") { endedRounds.delete(meta.curRound); return hostStartPlay(); }
    if (phase === "result") {
      if (meta.phase !== "play") { toast("플레이 중일 때만 결과로 갈 수 있어", true); return; }
      endedRounds.delete(meta.curRound); return hostEndPlay(false);
    }
    const dur = phase === "spicy" ? SPICY_MS : phase === "slot" ? SLOT_MS : INTRO_MS;
    const patch = { status: "playing", phase, phaseEnd: net.now() + dur };
    if (phase === "spicy") patch.spicy = true;
    if (!meta.curGame) patch.curGame = GAME_IDS[0];
    await net.dbUpdate(`rooms/${room}/meta`, patch);
  },
  async nextRound() { if (this._requireHost()) await hostAfterResult(); },
  async toFinal() {
    if (!this._requireHost()) return;
    await net.dbUpdate(`rooms/${room}`, { "meta/status": "final", "meta/phase": null, "meta/timeout": null });
  },
  async spicyRound(gameId) {
    if (!this._requireHost()) return;
    const g = gameId || meta.curGame || GAME_IDS[Math.floor(Math.random() * GAME_IDS.length)];
    const cur = (meta.curRound && meta.curRound >= 1) ? meta.curRound : 1;
    const seq = (meta.seq && meta.seq.length) ? meta.seq.slice() : GAME_IDS.slice();
    seq[(cur - 1) % seq.length] = g;
    endedRounds.delete(cur);
    await net.dbUpdate(`rooms/${room}`, {
      "meta/status": "playing", "meta/curRound": cur, "meta/rounds": Math.max(meta.rounds || 4, cur),
      "meta/seq": seq, "meta/curGame": g, "meta/spicy": true,
      "meta/phase": "spicy", "meta/phaseEnd": net.now() + SPICY_MS, "meta/timeout": null, game: null
    });
  },
  async setSpicy(v) { if (this._requireHost()) await net.dbUpdate(`rooms/${room}/meta`, { spicy: !!v }); },
  async setRounds(delta) {
    if (!this._requireHost()) return;
    await net.dbUpdate(`rooms/${room}/meta`, { rounds: Math.max(1, Math.min(10, (meta.rounds || 4) + delta)) });
  },
  async randomScores() {
    if (!this._requireHost()) return;
    const up = {};
    for (const pid of realIds()) up[`players/${pid}/score`] = Math.floor(Math.random() * 24) - 4;
    await net.dbUpdate(`rooms/${room}`, up);
    toast("점수 랜덤 세팅 완료");
  },
  async backToLobby() {
    if (!this._requireHost()) return;
    await net.dbUpdate(`rooms/${room}`, {
      "meta/status": "lobby", "meta/phase": null, "meta/curRound": 0,
      game: null, history: null, "meta/timeout": null, "meta/spicy": null
    });
  }
};
initDebug(debugApi);

// 부팅: 익명 로그인 → QR 링크(?join=코드)면 코드 채워진 참가 화면 → 아니면 이전 방 자동 복귀
(async () => {
  // QR로 들어온 경우: 주소에서 코드를 꺼내고 URL은 깨끗하게 (새로고침 시 재발동 방지)
  const qrCode = net.normalizeCode(new URLSearchParams(location.search).get("join") || "");
  if (qrCode) history.replaceState(null, "", location.pathname);

  try {
    UID = await net.ready();
  } catch (e) {
    toast("서버 연결에 실패했어… 인터넷을 확인해줘!", true);
    console.error(e);
    return;
  }

  if (qrCode.length === 4) {
    openEntry("join");
    $("inpCode").value = qrCode;
    toast("방 코드가 자동으로 입력됐어! 닉네임만 쓰면 끝 ✏️");
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
