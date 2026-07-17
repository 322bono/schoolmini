// Firebase 프로젝트 설정 (dreamlot-a2768)
// RTDB 인스턴스: asia-southeast1
export const firebaseConfig = {
  apiKey: "AIzaSyAmfhuT6Yr_AFjDV0nDpZPidkeJvSEYBD0",
  authDomain: "dreamlot-a2768.firebaseapp.com",
  databaseURL: "https://dreamlot-a2768-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "dreamlot-a2768",
  storageBucket: "dreamlot-a2768.firebasestorage.app",
  messagingSenderId: "649743325485",
  appId: "1:649743325485:web:774992c251f2f7baed1ba4"
};

// 방 설정
export const MAX_PLAYERS = 20;       // 기본 최대 인원 (방장이 3~40으로 조절 가능)
export const MAX_PLAYERS_MIN = 3;
export const MAX_PLAYERS_MAX = 40;
export const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 지난 방은 청소

// 캐릭터 색상 40종 (중복 선택 불가 — 최대 인원 40명 대응)
export const COLORS = [
  "#e64a3c", "#f07f2d", "#f5a623", "#f7d02c", "#b5cc2e",
  "#58b647", "#2fa579", "#35b7c9", "#45a3e5", "#3b6fd4",
  "#5a55d2", "#8e57c9", "#c653c6", "#ef6ea8", "#f7a8c4",
  "#e8506e", "#a5713f", "#9a9a4f", "#8a8a8a", "#4a4a4a",
  "#8c2d2d", "#b0621c", "#c4a01e", "#8f9c20", "#3f7d33",
  "#1f7a5c", "#1f89a0", "#2d6db0", "#274b8f", "#4a3fa3",
  "#6b32a0", "#963297", "#b03b77", "#d97b9c", "#a05656",
  "#6e5a2e", "#5c7a52", "#527a7a", "#5a5a8f", "#2e2e2e"
];
