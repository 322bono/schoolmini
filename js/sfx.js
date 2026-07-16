// WebAudio 합성 효과음 — 외부 오디오 파일 없이 전부 코드로 생성
let ctx = null;
let master = null;
let muted = localStorage.getItem("sm_muted") === "1";

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// 첫 사용자 입력에서 오디오 잠금 해제 (모바일 필수)
export function unlockAudio() {
  try { ac(); } catch { /* 오디오 미지원 환경 */ }
  syncBgm(); // 제스처 이후 BGM 재생 재시도
}

export function isMuted() { return muted; }
export function toggleMute() {
  muted = !muted;
  localStorage.setItem("sm_muted", muted ? "1" : "0");
  if (master) master.gain.value = muted ? 0 : 0.5;
  syncBgm();
  return muted;
}

// ── 배경음악 (타이틀/로비 루프) ────────────────
let bgmEl = null;
let bgmWanted = false;

function syncBgm() {
  if (!bgmEl) {
    bgmEl = new Audio("assets/bgm-title.mp3");
    bgmEl.loop = true;
    bgmEl.volume = 0.3;
  }
  if (bgmWanted && !muted) {
    // 사용자 제스처 전에는 브라우저가 거부할 수 있음 → unlockAudio에서 재시도
    bgmEl.play().catch(() => {});
  } else {
    bgmEl.pause();
  }
}

/** 화면에 따라 BGM 켜기/끄기 */
export function setBgm(on) {
  bgmWanted = on;
  syncBgm();
}

/** 두구두구 드럼롤 (눈치블록 결과 연출) */
export function playDrumroll() {
  if (muted) return;
  try {
    const a = new Audio("assets/drumroll.mp3");
    a.volume = 0.65;
    a.play().catch(() => {});
  } catch { /* noop */ }
}

function osc({ type = "sine", freq = 440, to = null, dur = 0.15, vol = 0.5, delay = 0, curve = "exp" }) {
  try {
    const c = ac();
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) {
      if (curve === "exp") o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
      else o.frequency.linearRampToValueAtTime(to, t0 + dur);
    }
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  } catch { /* noop */ }
}

function noise({ dur = 0.2, vol = 0.3, delay = 0, filterFrom = 4000, filterTo = 400 }) {
  try {
    const c = ac();
    const t0 = c.currentTime + delay;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(filterFrom, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
  } catch { /* noop */ }
}

export const sfx = {
  click()   { osc({ type: "square", freq: 640, dur: 0.06, vol: 0.18 }); },
  swoosh()  { noise({ dur: 0.28, vol: 0.2, filterFrom: 600, filterTo: 3200 }); },
  pop()     { osc({ type: "sine", freq: 520, to: 900, dur: 0.09, vol: 0.3 }); },

  // 슬롯머신
  tick()    { osc({ type: "square", freq: 1150, dur: 0.035, vol: 0.12 }); },
  tada() {
    osc({ type: "triangle", freq: 523, dur: 0.14, vol: 0.4 });
    osc({ type: "triangle", freq: 659, dur: 0.14, vol: 0.4, delay: 0.11 });
    osc({ type: "triangle", freq: 784, dur: 0.32, vol: 0.45, delay: 0.22 });
    noise({ dur: 0.35, vol: 0.15, delay: 0.22, filterFrom: 5000, filterTo: 1000 });
  },

  // 룰렛 결정 "빠밤!"
  bbam() {
    osc({ type: "sawtooth", freq: 174, dur: 0.16, vol: 0.4 });
    osc({ type: "sawtooth", freq: 220, dur: 0.16, vol: 0.3 });
    osc({ type: "sawtooth", freq: 233, dur: 0.5, vol: 0.45, delay: 0.2 });
    osc({ type: "sawtooth", freq: 293, dur: 0.5, vol: 0.35, delay: 0.2 });
  },

  beep()    { osc({ type: "sine", freq: 880, dur: 0.12, vol: 0.35 }); },
  go()      { osc({ type: "sine", freq: 1320, dur: 0.4, vol: 0.45 }); },
  // 폴가이즈풍 귀여운 카운트다운 (3→2→1 점점 올라가는 음)
  count(n)  {
    const f = n === 3 ? 587 : n === 2 ? 698 : 880;
    osc({ type: "triangle", freq: f, dur: 0.22, vol: 0.42 });
    osc({ type: "sine", freq: f * 2, dur: 0.1, vol: 0.15 });
  },
  mash()    { osc({ type: "square", freq: 700 + Math.random() * 500, dur: 0.05, vol: 0.14 }); },
  thud()    { osc({ type: "sine", freq: 200, to: 90, dur: 0.16, vol: 0.45 }); noise({ dur: 0.1, vol: 0.2, filterFrom: 1200, filterTo: 300 }); },

  win() {
    osc({ type: "triangle", freq: 523, dur: 0.1, vol: 0.35 });
    osc({ type: "triangle", freq: 659, dur: 0.1, vol: 0.35, delay: 0.09 });
    osc({ type: "triangle", freq: 784, dur: 0.1, vol: 0.35, delay: 0.18 });
    osc({ type: "triangle", freq: 1046, dur: 0.28, vol: 0.4, delay: 0.27 });
  },
  fail()    { osc({ type: "square", freq: 165, to: 110, dur: 0.35, vol: 0.3 }); },
  buzz()    { osc({ type: "sawtooth", freq: 130, dur: 0.2, vol: 0.3 }); },
  poof()    { noise({ dur: 0.3, vol: 0.35, filterFrom: 2600, filterTo: 200 }); },
  coin()    { osc({ type: "square", freq: 1568, dur: 0.06, vol: 0.2 }); osc({ type: "square", freq: 2093, dur: 0.22, vol: 0.2, delay: 0.06 }); },
  timeover() {
    osc({ type: "sawtooth", freq: 260, to: 190, dur: 0.55, vol: 0.45 });
    osc({ type: "sawtooth", freq: 130, to: 95, dur: 0.55, vol: 0.35 });
    noise({ dur: 0.5, vol: 0.15, filterFrom: 1000, filterTo: 150 });
  },
  bonk()    { osc({ type: "square", freq: 340, to: 90, dur: 0.12, vol: 0.4 }); noise({ dur: 0.08, vol: 0.22, filterFrom: 3000, filterTo: 800 }); },
  sparkle() { osc({ type: "sine", freq: 1760, dur: 0.07, vol: 0.2 }); osc({ type: "sine", freq: 2349, dur: 0.12, vol: 0.16, delay: 0.07 }); },
  boom() {
    noise({ dur: 0.75, vol: 0.6, filterFrom: 900, filterTo: 55 });
    osc({ type: "sine", freq: 120, to: 36, dur: 0.75, vol: 0.55 });
  },
  fuse()    { noise({ dur: 0.25, vol: 0.12, filterFrom: 5500, filterTo: 3500 }); },
  correct() { osc({ type: "sine", freq: 990, dur: 0.07, vol: 0.25 }); },
  wrong()   { osc({ type: "square", freq: 180, dur: 0.25, vol: 0.35 }); osc({ type: "square", freq: 120, dur: 0.25, vol: 0.25, delay: 0.02 }); },
  whistle() { osc({ type: "sine", freq: 2200, to: 1400, dur: 0.3, vol: 0.3 }); },
  heartbeat(){ osc({ type: "sine", freq: 70, dur: 0.1, vol: 0.5 }); osc({ type: "sine", freq: 60, dur: 0.12, vol: 0.4, delay: 0.16 }); }
};

// ── 우승 축하 멜로디 (8비트풍 루프) ─────────────
let melTimer = null;
let melStep = 0;
const MEL_LEAD = [523, 659, 784, 659, 440, 523, 659, 523, 349, 440, 523, 440, 392, 494, 587, 784];
const MEL_BASS = [131, 110, 87, 98];

export function startMelody() {
  if (melTimer) return;
  try { ac(); } catch { return; }
  melStep = 0;
  melTimer = setInterval(() => {
    const s = melStep++;
    osc({ type: "square", freq: MEL_LEAD[s % 16], dur: 0.16, vol: 0.12 });
    if (s % 4 === 0) osc({ type: "triangle", freq: MEL_BASS[Math.floor(s / 4) % 4], dur: 0.4, vol: 0.22 });
    if (s % 8 === 6) osc({ type: "sine", freq: 1568, dur: 0.08, vol: 0.1 });
  }, 210);
}

export function stopMelody() {
  clearInterval(melTimer);
  melTimer = null;
}
