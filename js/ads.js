// 애드센스 광고 배치 — 스쿨 미니
// ────────────────────────────────────────────────────────────────
// 배치 규칙 (요청 사항):
//   · 모바일 홈 화면: 광고 없음
//   · PC 홈 화면: 양쪽 세로 광고 2개 (스카이스크래퍼)
//   · 모바일/PC 공통: 방 만들기·참가로 "방에 입장"하는 전환 순간에 광고 1개
//
// ▶ 슬롯 ID 넣는 법 (이걸 채워야 실제 광고가 나옵니다):
//   1) AdSense 대시보드 → 광고 → "광고 단위 기준" 에서 광고 단위 3개를 만든다.
//      - "디스플레이 광고" 세로형 2개  (PC 왼쪽/오른쪽)
//      - "디스플레이 광고" 1개        (방 입장 전환)
//   2) 각 단위의 data-ad-slot 값(10자리 숫자)을 아래 slots에 붙여넣는다.
//   비워두면(기본값) 광고 자리는 표시되지 않고 사이트는 그대로 동작한다.
//   ?adpreview=1 을 주소 뒤에 붙이면 슬롯이 없어도 광고 위치를 회색 박스로 미리 볼 수 있다.
export const ADS = {
  client: "ca-pub-9136879719243756",
  slots: {
    pcSideLeft: "",    // PC 홈 왼쪽 세로 광고
    pcSideRight: "",   // PC 홈 오른쪽 세로 광고
    interstitial: ""   // 방 입장 전환 광고
  }
};

const PREVIEW = /[?&]adpreview=1/.test(location.search);
const isDesktop = () => window.matchMedia("(min-width: 1100px)").matches;
const validSlot = s => /^\d{6,}$/.test(s || "");

/** adsbygoogle에 광고 요청 — 스크립트가 안 실려도(오프라인/차단) 조용히 무시 */
function requestAd() {
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
  catch { /* noop */ }
}

/** 실제 <ins> 광고 태그 생성 (display 광고) */
function makeIns(slot, style, extra = {}) {
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.cssText = style;
  ins.setAttribute("data-ad-client", ADS.client);
  ins.setAttribute("data-ad-slot", slot);
  for (const [k, v] of Object.entries(extra)) ins.setAttribute(k, v);
  return ins;
}

/** 미리보기용 회색 자리 박스 */
function makePreviewBox(label, w, h) {
  const d = document.createElement("div");
  d.className = "ad-preview-box";
  if (w) d.style.width = w + "px";
  if (h) d.style.height = h + "px";
  d.textContent = label;
  return d;
}

// ── PC 홈 양쪽 세로 광고 ──────────────────────────
let railsBuilt = false;
function buildRail(el, slot, label) {
  el.innerHTML = "";
  if (PREVIEW && !validSlot(slot)) { el.appendChild(makePreviewBox(label, 160, 600)); return; }
  el.appendChild(makeIns(slot, "display:inline-block;width:160px;height:600px"));
  requestAd();
}

/**
 * 홈 화면일 때만 PC 양쪽 세로 광고를 보여준다.
 * 모바일(좁은 화면)에서는 CSS/JS 양쪽에서 절대 뜨지 않음.
 * @param {boolean} onHome 지금 홈 화면인가
 */
export function showSideRails(onHome) {
  const L = document.getElementById("adRailLeft");
  const R = document.getElementById("adRailRight");
  if (!L || !R) return;
  const haveAny = PREVIEW || validSlot(ADS.slots.pcSideLeft) || validSlot(ADS.slots.pcSideRight);
  const on = !!onHome && isDesktop() && haveAny;
  L.hidden = !on;
  R.hidden = !on;
  if (on && !railsBuilt) {
    railsBuilt = true; // 광고 요청은 <ins>당 한 번만
    buildRail(L, ADS.slots.pcSideLeft, "광고 (세로)");
    buildRail(R, ADS.slots.pcSideRight, "광고 (세로)");
  }
}

// ── 방 입장 전환 광고 (인터스티셜) ────────────────
let interShown = false;
/**
 * 방 입장 순간 한 번, 광고 오버레이를 띄운다.
 * 슬롯이 없고 미리보기도 아니면 아무 것도 안 하고 넘어간다(사이트 흐름 유지).
 */
export function showInterstitial() {
  const ov = document.getElementById("adInterstitial");
  const slotEl = document.getElementById("adInterSlot");
  if (!ov || !slotEl) return;
  const has = PREVIEW || validSlot(ADS.slots.interstitial);
  if (!has) return; // 슬롯 미설정 → 광고 없이 바로 입장

  slotEl.innerHTML = "";
  if (PREVIEW && !validSlot(ADS.slots.interstitial)) {
    slotEl.appendChild(makePreviewBox("광고 (방 입장)", 300, 250));
  } else {
    slotEl.appendChild(makeIns(
      ADS.slots.interstitial,
      "display:block;width:100%;min-height:250px",
      { "data-ad-format": "auto", "data-full-width-responsive": "true" }
    ));
  }
  ov.hidden = false;
  if (!PREVIEW || validSlot(ADS.slots.interstitial)) requestAd();

  // 닫기/입장 배선은 한 번만
  if (!interShown) {
    interShown = true;
    const close = () => { ov.hidden = true; };
    document.getElementById("adInterGo").addEventListener("click", close);
    document.getElementById("adInterClose").addEventListener("click", close);
    ov.addEventListener("pointerdown", e => { if (e.target === ov) ov.hidden = true; });
  }
  // 안전장치: 15초 지나도 안 닫으면 자동으로 닫아 입장 흐름을 막지 않음
  clearTimeout(showInterstitial._t);
  showInterstitial._t = setTimeout(() => { ov.hidden = true; }, 15000);
}
