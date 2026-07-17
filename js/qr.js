// 초경량 QR 코드 생성기 — 버전 3 (29×29), 에러정정 L, 바이트 모드 전용.
// 방 입장 URL(약 41자, 최대 53자)을 담기에 충분하며 외부 라이브러리가 필요 없다.

// GF(256) 테이블 (다항식 0x11d)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

/** 리드-솔로몬 생성 다항식 (최고차항부터) */
function rsGen(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j]; // ×x 항
      ng[j + 1] ^= g[j] ? EXP[(LOG[g[j]] + i) % 255] : 0; // ×α^i 항
    }
    g = ng;
  }
  return g;
}

/** 에러정정 코드워드 계산 (다항식 나눗셈) */
function rsEC(data, deg) {
  const gen = rsGen(deg);
  const res = data.concat(new Array(deg).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = res[i];
    if (!c) continue;
    const lc = LOG[c];
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gen[j] ? EXP[(lc + LOG[gen[j]]) % 255] : 0;
    }
  }
  return res.slice(data.length);
}

const SIZE = 29;        // 버전 3
const DATA_CW = 55;     // 데이터 코드워드 수 (3-L)
const EC_CW = 15;       // 에러정정 코드워드 수 (3-L, 단일 블록)
// 포맷 정보 15비트 (에러정정 L, 마스크 0~7) — 규격 부록의 사전 계산 값
const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

/** 텍스트 → 29×29 불리언 매트릭스 (true = 검정) */
export function qrMatrix(text, maskId = 0) {
  const bytes = [];
  for (const ch of new TextEncoder().encode(text)) bytes.push(ch);
  if (bytes.length > DATA_CW - 2) throw new Error("QR 용량 초과");

  // ── 비트스트림: 모드(0100) + 길이(8비트) + 데이터 + 종단 + 패딩 ──
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, DATA_CW * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < DATA_CW; i++) data.push(pads[i % 2]);
  const codewords = data.concat(rsEC(data, EC_CW));

  // ── 매트릭스 + 기능 패턴 ──
  const m = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));
  const fn = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false)); // 기능 모듈 표시

  const setFn = (r, c, v) => { m[r][c] = v; fn[r][c] = true; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
        const inSq = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inSq && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setFn(rr, cc, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, SIZE - 7);
  finder(SIZE - 7, 0);
  // 타이밍 패턴
  for (let i = 8; i < SIZE - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  // 정렬 패턴 (버전 3: 중심 22,22)
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      setFn(22 + r, 22 + c, dark);
    }
  }
  // 다크 모듈 + 포맷 영역 예약
  setFn(SIZE - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!fn[8][i]) { fn[8][i] = true; }
    if (!fn[i][8]) { fn[i][8] = true; }
  }
  for (let i = 0; i < 7; i++) fn[SIZE - 1 - i][8] = true;
  for (let i = 0; i < 8; i++) fn[8][SIZE - 1 - i] = true;

  // ── 데이터 배치 (오른쪽 아래부터 지그재그) ──
  let bi = 0;
  const totalBits = codewords.length * 8;
  const bitAt = k => (codewords[k >> 3] >> (7 - (k & 7))) & 1;
  let upward = true;
  for (let col = SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < SIZE; i++) {
      const r = upward ? SIZE - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (fn[r][c]) continue;
        const v = bi < totalBits ? bitAt(bi) === 1 : false;
        bi++;
        m[r][c] = MASKS[maskId](r, c) ? !v : v;
      }
    }
    upward = !upward;
  }

  // ── 포맷 정보 배치 ──
  const f = FORMAT_L[maskId];
  const fbit = i => ((f >> (14 - i)) & 1) === 1; // i = 0(MSB)..14(LSB)
  for (let i = 0; i < 15; i++) {
    const v = fbit(i);
    // 사본 A: 왼쪽 위 파인더 주변
    if (i < 6) m[8][i] = v;
    else if (i === 6) m[8][7] = v;
    else if (i === 7) m[8][8] = v;
    else if (i === 8) m[7][8] = v;
    else m[14 - i][8] = v;
    // 사본 B: 왼쪽 아래 7칸 + 오른쪽 위 8칸
    if (i < 7) m[SIZE - 1 - i][8] = v;
    else m[8][SIZE - 15 + i] = v;
  }
  return m;
}

/** 매트릭스 → SVG 문자열 (조용한 영역 포함) */
export function qrSvg(text, px = 4) {
  const m = qrMatrix(text);
  const q = 4; // quiet zone
  const dim = (SIZE + q * 2) * px;
  let rects = "";
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (m[r][c]) rects += `<rect x="${(c + q) * px}" y="${(r + q) * px}" width="${px}" height="${px}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
