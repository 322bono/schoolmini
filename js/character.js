// 손그림 캐릭터 SVG 생성기
// 몸통 A/B 두 프레임을 번갈아 보여줘서 "연필 애니메이션이 부들부들 움직이는" 느낌을 냄

const BODY_A = `
  <path class="body" d="M23 37 C21 30 26 26 33 26 L67 25 C75 25 80 29 79 36 L81 77 C82 86 77 91 69 91 L31 92 C23 92 18 87 20 79 Z"/>
  <path class="ear" d="M30 28 C26 20 28 13 34 14 C39 15 41 21 40 27 Z"/>
  <path class="ear" d="M62 27 C61 20 64 13 69 14 C75 15 76 22 72 28 Z"/>
  <path class="foot" d="M33 91 C32 97 33 101 38 101 C42 101 43 97 42 91 Z"/>
  <path class="foot" d="M59 91 C58 97 59 101 64 101 C68 101 69 97 68 91 Z"/>`;

const BODY_B = `
  <path class="body" d="M22 36 C21 29 25 25 33 26 L68 26 C76 25 81 30 80 37 L80 78 C81 87 76 90 68 90 L30 91 C22 92 19 86 21 78 Z"/>
  <path class="ear" d="M29 28 C26 21 29 14 34 15 C40 15 40 22 39 28 Z"/>
  <path class="ear" d="M61 27 C60 19 65 14 70 15 C75 16 75 21 71 27 Z"/>
  <path class="foot" d="M33 90 C31 96 33 100 37 101 C41 101 43 96 42 91 Z"/>
  <path class="foot" d="M59 90 C58 96 60 101 64 100 C68 100 69 96 68 90 Z"/>`;

const FACE = `
  <g class="eyes eyes-normal">
    <circle class="ink" cx="38" cy="56" r="3.6"/>
    <circle class="ink" cx="62" cy="56" r="3.6"/>
  </g>
  <g class="eyes eyes-happy">
    <path class="stroke" d="M32 58 Q 38 51 44 58"/>
    <path class="stroke" d="M56 58 Q 62 51 68 58"/>
  </g>
  <g class="eyes eyes-sad">
    <path class="stroke" d="M32 54 Q 38 59 44 55"/>
    <path class="stroke" d="M56 55 Q 62 59 68 54"/>
    <ellipse class="tear" cx="34" cy="64" rx="2.4" ry="3.4"/>
    <ellipse class="tear tear2" cx="66" cy="64" rx="2.4" ry="3.4"/>
  </g>
  <g class="eyes eyes-x">
    <path class="stroke" d="M34 52 L42 60 M42 52 L34 60"/>
    <path class="stroke" d="M58 52 L66 60 M66 52 L58 60"/>
  </g>
  <path class="stroke mouth mouth-smile" d="M44 71 Q 50 76 56 71"/>
  <path class="stroke mouth mouth-flat"  d="M43 72 L57 71"/>
  <path class="stroke mouth mouth-frown" d="M44 75 Q 50 70 56 75"/>
  <path class="stroke mouth mouth-wavy"  d="M41 73 Q 45 70 49 73 Q 53 76 57 73 L59 73"/>
  <path class="mouth mouth-open ink" d="M43 70 Q 50 70 57 70 Q 57 80 50 80 Q 43 80 43 70 Z"/>
  <circle class="mouth mouth-o stroke" cx="50" cy="73" r="4"/>`;

let charSeq = 0;

/**
 * 캐릭터 DOM 생성
 * @param {{color:string, nick?:string, size?:number, face?:string, motion?:string}} opts
 */
export function makeChar(opts = {}) {
  const { color = "#f5a623", nick = "", size = 56, face = "normal", motion = "idle" } = opts;
  const el = document.createElement("div");
  el.className = `char f-${face} m-${motion}`;
  el.style.setProperty("--char-color", color);
  el.style.width = size + "px";
  el.style.setProperty("--boil-delay", ((charSeq++ % 5) * 0.09).toFixed(2) + "s");
  el.innerHTML = `
    <div class="char-bubble" hidden></div>
    <div class="char-box">
      <svg viewBox="0 0 100 104" aria-hidden="true">
        <g class="char-inner">
          <g class="cf cf-a">${BODY_A}</g>
          <g class="cf cf-b">${BODY_B}</g>
          <g class="face">${FACE}</g>
        </g>
      </svg>
    </div>
    ${nick !== null ? `<div class="char-label"></div>` : ""}`;
  const label = el.querySelector(".char-label");
  if (label) label.textContent = nick;
  return el;
}

const FACES = ["normal", "happy", "sad", "shock", "dead"];
const MOTIONS = ["idle", "walk", "jump", "cry", "sit", "shout", "dissolve", "caught", "none", "stand"];

export function setFace(el, face) {
  if (!el) return;
  FACES.forEach(f => el.classList.remove("f-" + f));
  el.classList.add("f-" + face);
}

export function setMotion(el, motion) {
  if (!el) return;
  MOTIONS.forEach(m => el.classList.remove("m-" + m));
  el.classList.add("m-" + motion);
}

/** 캐릭터 머리 위 말풍선 */
export function charSay(el, text, ms = 1400) {
  if (!el) return;
  const b = el.querySelector(".char-bubble");
  if (!b) return;
  b.textContent = text;
  b.hidden = false;
  b.classList.remove("bubble-in");
  void b.offsetWidth; // 애니메이션 재시작
  b.classList.add("bubble-in");
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.hidden = true; }, ms);
}
