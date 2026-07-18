// Firebase RTDB 통신 레이어 (익명 인증 + 방 관리)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getDatabase, ref, get, set, update, remove, onValue, onDisconnect,
  runTransaction, serverTimestamp, query, orderByChild, endAt, limitToFirst
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { firebaseConfig, MAX_PLAYERS, MAX_PLAYERS_MIN, MAX_PLAYERS_MAX, ROOM_TTL_MS, COLORS } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let _uid = null;
let _offset = 0;

// 탭 식별자 — 같은 브라우저(같은 익명 UID)에서 탭을 여러 개 열면
// 마지막에 입장한 탭만 유효하고 나머지는 스스로 물러난다 (유령 방장 방지)
export const TAB_ID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

onValue(ref(db, ".info/serverTimeOffset"), s => { _offset = s.val() || 0; });

/** 익명 로그인 완료 후 uid 반환 */
export function ready() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, user => {
      if (user) { _uid = user.uid; resolve(_uid); }
    });
    signInAnonymously(auth).catch(reject);
  });
}

export const uid = () => _uid;
/** 서버 기준 현재 시각(ms) */
export const now = () => Date.now() + _offset;
export const ts = serverTimestamp;

// ── 저수준 헬퍼 ──────────────────────────────
const r = path => ref(db, path);
export const dbSet = (path, val) => set(r(path), val);
export const dbUpdate = (path, obj) => update(r(path), obj);
export const dbRemove = path => remove(r(path));
export const dbGet = async path => (await get(r(path))).val();
export const dbTxn = (path, fn, opts) => runTransaction(r(path), fn, opts);
export function dbWatch(path, cb) {
  return onValue(r(path), snap => cb(snap.val()));
}
export function presence(path) {
  // 접속 끊기면 online=false
  onDisconnect(r(path + "/online")).set(false);
}
export function cancelPresence(path) {
  onDisconnect(r(path + "/online")).cancel().catch(() => {});
}

// ── 방 관리 ─────────────────────────────────
// 손글씨 폰트에서 모양이 겹치는 글자·숫자 쌍(S↔5, Z↔2, B↔8, G↔6, O↔0, I/L↔1,
// Q↔O, U↔V)과 발음이 비슷한 N(↔M)을 전부 빼고, 헷갈릴 수 없는 글자만 사용
const CODE_CHARS = "ACDEFHJKMPRTUWXY";

function genCode() {
  let c = "";
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

/** 6시간 지난 방 최대 5개 청소 (실패해도 무시) */
async function cleanupOldRooms() {
  try {
    const q = query(r("rooms"), orderByChild("meta/createdAt"), endAt(now() - ROOM_TTL_MS), limitToFirst(5));
    const snap = await get(q);
    const val = snap.val();
    if (!val) return;
    await Promise.all(Object.keys(val).map(code => remove(r("rooms/" + code)).catch(() => {})));
  } catch { /* 인덱스/권한 문제 시 조용히 무시 */ }
}

export async function createRoom(nick, opts = {}) {
  cleanupOldRooms();
  let code = null;
  for (let i = 0; i < 6; i++) {
    const c = genCode();
    if (!(await dbGet(`rooms/${c}/meta`))) { code = c; break; }
  }
  if (!code) throw new Error("방 코드를 만들지 못했어. 다시 시도해줘!");
  const maxPlayers = Math.max(MAX_PLAYERS_MIN, Math.min(MAX_PLAYERS_MAX, opts.maxPlayers || MAX_PLAYERS));
  await dbSet(`rooms/${code}`, {
    meta: {
      createdAt: serverTimestamp(),
      hostUid: _uid,
      status: "lobby",
      rounds: 4,
      maxPlayers,
      allowChat: opts.allowChat !== false,
      allowEmote: opts.allowEmote !== false,
      curRound: 0,
      phase: null
    },
    players: {
      [_uid]: { nick, color: 0, score: 0, online: true, joined: serverTimestamp(), tab: TAB_ID }
    },
    colors: { 0: _uid }
  });
  presence(`rooms/${code}/players/${_uid}`);
  return code;
}

/** 입력한 방 코드 정리: 전각 문자→반각, 공백 제거, 대문자화 */
export function normalizeCode(raw) {
  return (raw || "")
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, "")
    .toUpperCase();
}

export async function joinRoom(code, nick) {
  code = normalizeCode(code);
  const meta = await dbGet(`rooms/${code}/meta`);
  if (!meta) throw new Error("그런 방 코드는 없어! 한 글자씩 다시 확인해줘 🙈");

  const me = await dbGet(`rooms/${code}/players/${_uid}`);
  if (me) {
    // 재접속 (새로고침 등) — 점수 유지, 이 탭이 최신 탭이 됨
    await dbUpdate(`rooms/${code}/players/${_uid}`, { online: true, nick: nick || me.nick, tab: TAB_ID });
    presence(`rooms/${code}/players/${_uid}`);
    return { code, rejoin: true };
  }

  if (meta.status !== "lobby") throw new Error("이미 게임이 시작된 방이야! 끝날 때까지 기다려줘");

  const cap = meta.maxPlayers || MAX_PLAYERS;
  const res = await dbTxn(`rooms/${code}/players`, players => {
    if (players && Object.keys(players).length >= cap) return; // abort
    players = players || {};
    players[_uid] = { nick, color: -1, score: 0, online: true, joined: Date.now(), tab: TAB_ID };
    return players;
  });
  if (!res.committed) throw new Error(`방이 꽉 찼어! (최대 ${cap}명)`);

  presence(`rooms/${code}/players/${_uid}`);
  await claimFirstFreeColor(code);
  return { code, rejoin: false };
}

export async function claimFirstFreeColor(code) {
  for (let i = 0; i < COLORS.length; i++) {
    if (await claimColor(code, i)) return i;
  }
  return -1;
}

/** 색 선택 (중복 불가, 트랜잭션). 성공 시 true */
export async function claimColor(code, idx) {
  const res = await dbTxn(`rooms/${code}/colors/${idx}`, cur => {
    if (cur === null || cur === _uid) return _uid;
    return; // 이미 다른 사람 것 → abort
  });
  if (!res.committed) return false;
  const old = await dbGet(`rooms/${code}/players/${_uid}/color`);
  const updates = { [`players/${_uid}/color`]: idx };
  if (old !== null && old !== undefined && old >= 0 && old !== idx) {
    updates[`colors/${old}`] = null;
  }
  await dbUpdate(`rooms/${code}`, updates);
  return true;
}

export async function leaveRoom(code, isHost, myColor, status) {
  cancelPresence(`rooms/${code}/players/${_uid}`);
  try {
    if (isHost && status === "lobby") {
      await dbRemove(`rooms/${code}`); // 로비에서 방장이 나가면 방 해산
    } else {
      const updates = { [`players/${_uid}`]: null };
      if (myColor >= 0) updates[`colors/${myColor}`] = null;
      await dbUpdate(`rooms/${code}`, updates);
    }
  } catch { /* noop */ }
}
