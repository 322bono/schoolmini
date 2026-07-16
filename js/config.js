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
export const MAX_PLAYERS = 20;
export const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 지난 방은 청소

// 캐릭터 색상 20종 (중복 선택 불가)
export const COLORS = [
  "#e64a3c", "#f07f2d", "#f5a623", "#f7d02c", "#b5cc2e",
  "#58b647", "#2fa579", "#35b7c9", "#45a3e5", "#3b6fd4",
  "#5a55d2", "#8e57c9", "#c653c6", "#ef6ea8", "#f7a8c4",
  "#e8506e", "#a5713f", "#9a9a4f", "#8a8a8a", "#4a4a4a"
];
