// 개발자용 디버그 모드 — 스쿨 미니
// ════════════════════════════════════════════════════════════════
// ★ 격리 원칙 (일반 사용자에게 절대 영향 없음) ★
//  · 이 파일은 app.js가 넘겨준 api만 호출한다. 게임 규칙/점수/호스트 루프는 건드리지 않음.
//  · 활성화 여부는 이 기기의 localStorage 플래그(sm_debug)일 뿐, DB에 절대 안 쓴다.
//    → 다른 접속자는 디버그가 켜졌는지조차 알 수 없고 게임에 아무 변화도 없다.
//  · 모든 디버그 동작은 "지금 내가 방장인 내 방"에만 적용된다(=평소 방장 권한과 동일).
//  · 켜는 방법은 홈에서 비밀 시퀀스(adminbono)+비밀번호(0322) 뿐 → 일반 유저는 못 켠다.
//  · 평상시(미활성) 코드 경로는 홈 화면의 키 입력 감시 하나뿐 — 아무 부작용 없음.

const SECRET = "adminbono";
const PASSWORD = "0322";
const LS_KEY = "sm_debug";

let api = null;
let on = false;

export function initDebug(a) {
  api = a;
  injectStyle();
  // 홈에서 비밀 시퀀스 타이핑 감지 (입력창에 포커스 중이면 무시 → 닉네임/채팅과 무관)
  let buf = "";
  document.addEventListener("keydown", e => {
    if (on) return;
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key && e.key.length === 1) {
      buf = (buf + e.key.toLowerCase()).slice(-SECRET.length);
      if (buf === SECRET) { buf = ""; askPassword(); }
    }
  });
  // 모바일 대비 숨은 진입점 — 홈 부제(작은 글씨)를 7번 빠르게 탭
  let taps = [], t0 = 0;
  document.addEventListener("pointerdown", e => {
    if (on) return;
    const sub = e.target.closest && e.target.closest(".home-sub, .home-foot");
    if (!sub) return;
    const now = Date.now();
    if (now - t0 > 600) taps = [];
    t0 = now; taps.push(now);
    if (taps.length >= 7) { taps = []; askPassword(); }
  });
  // 이 기기에서 예전에 켜뒀으면 자동 복원 (개발 편의, 기기 로컬 한정)
  if (localStorage.getItem(LS_KEY) === "1") enable(true);
}

// ── 비밀번호 모달 ──────────────────────────────
function askPassword() {
  if (document.getElementById("dbgPass")) return;
  const wrap = el("div", "dbg-modal", { id: "dbgPass" });
  wrap.innerHTML = `
    <div class="dbg-box">
      <div class="dbg-title">🛠 개발자 모드</div>
      <input id="dbgPassInp" class="dbg-input" type="password" inputmode="numeric" placeholder="비밀번호" autocomplete="off" />
      <div class="dbg-row">
        <button id="dbgPassOk" class="dbg-btn dbg-primary">확인</button>
        <button id="dbgPassCancel" class="dbg-btn">취소</button>
      </div>
      <div id="dbgPassErr" class="dbg-err"></div>
    </div>`;
  document.body.appendChild(wrap);
  const inp = wrap.querySelector("#dbgPassInp");
  inp.focus();
  const close = () => wrap.remove();
  const submit = () => {
    if (inp.value === PASSWORD) { close(); enable(false); }
    else { wrap.querySelector("#dbgPassErr").textContent = "비밀번호가 틀렸어"; inp.value = ""; inp.focus(); }
  };
  wrap.querySelector("#dbgPassOk").addEventListener("click", submit);
  wrap.querySelector("#dbgPassCancel").addEventListener("click", close);
  inp.addEventListener("keydown", e => { if (e.key === "Enter") submit(); if (e.key === "Escape") close(); });
  wrap.addEventListener("pointerdown", e => { if (e.target === wrap) close(); });
}

function enable(silent) {
  on = true;
  localStorage.setItem(LS_KEY, "1");
  buildPanel();
  if (!silent && api) api.toast("🛠 디버그 모드 ON");
}

function disable() {
  on = false;
  localStorage.removeItem(LS_KEY);
  const b = document.getElementById("dbgFab"); if (b) b.remove();
  const p = document.getElementById("dbgPanel"); if (p) p.remove();
  if (api) api.toast("디버그 모드 OFF");
}

// ── 플로팅 버튼 + 패널 ─────────────────────────
let refreshTimer = 0;
function buildPanel() {
  if (document.getElementById("dbgFab")) return;
  const fab = el("button", "dbg-fab", { id: "dbgFab" });
  fab.textContent = "🛠";
  fab.title = "디버그 패널";
  document.body.appendChild(fab);

  const panel = el("div", "dbg-panel", { id: "dbgPanel" });
  panel.hidden = true;
  document.body.appendChild(panel);
  fab.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { renderPanel(panel); startRefresh(); }
    else stopRefresh();
  });
  renderPanel(panel);
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(updateStatus, 500);
}
function stopRefresh() { clearInterval(refreshTimer); refreshTimer = 0; }

function updateStatus() {
  const s = document.getElementById("dbgStatus");
  if (!s || !api) return;
  const g = api.get();
  s.textContent = g.room
    ? `방 ${g.room} · ${g.isHost ? "방장👑" : "게스트"} · ${g.meta ? g.meta.status : "?"} · R${g.meta ? g.meta.curRound || 0 : 0}/${g.meta ? g.meta.rounds || 0 : 0} · ${g.meta && g.meta.curGame || "-"} · ${g.meta && g.meta.phase || "-"}${g.meta && g.meta.spicy ? " 🌶️" : ""} · 인원 ${Object.keys(g.players || {}).length}`
    : "방에 안 들어감 — [테스트 방 만들기]로 시작";
}

let flagSkip = false, flagSpicy = false;

function renderPanel(panel) {
  panel.innerHTML = "";
  const head = el("div", "dbg-head");
  head.innerHTML = `<span>🛠 디버그</span>`;
  const x = el("button", "dbg-btn dbg-x"); x.textContent = "✕";
  x.addEventListener("click", () => { panel.hidden = true; stopRefresh(); });
  head.appendChild(x);
  panel.appendChild(head);

  const status = el("div", "dbg-status", { id: "dbgStatus" });
  panel.appendChild(status);
  updateStatus();

  // 방 / 봇
  section(panel, "방 · 봇", [
    btn("🧪 테스트 방 만들기+봇3", () => api.testRoom()),
    btn("+1 봇", () => api.addBots(1)),
    btn("+3 봇", () => api.addBots(3)),
    btn("+10 봇", () => api.addBots(10)),
    btn("봇 모두 제거", () => api.clearBots()),
    btn("↩ 로비로", () => api.backToLobby())
  ]);

  // 토글 + 게임 선택
  const tog = el("div", "dbg-toggles");
  tog.appendChild(toggle("연출 스킵(바로 플레이)", flagSkip, v => flagSkip = v));
  tog.appendChild(toggle("🌶️ 스파이시로", flagSpicy, v => flagSpicy = v));
  panel.appendChild(labeled("특정 게임 시작", tog));
  const grid = el("div", "dbg-grid");
  for (const id of api.GAME_IDS) {
    const g = api.GAMES[id];
    grid.appendChild(btn(g.name.replace(/!$/, ""), () => api.startGame(id, { spicy: flagSpicy, skipAnim: flagSkip })));
  }
  panel.appendChild(grid);

  // 진행 제어 / 연출
  section(panel, "진행 · 연출 점프", [
    btn("🎰 슬롯 연출", () => api.jump("slot")),
    btn("🎬 인트로 연출", () => api.jump("intro")),
    btn("🌶️ 스파이시 연출", () => api.jump("spicy")),
    btn("▶ 바로 플레이", () => api.jump("play")),
    btn("⏩ 결과로(이 판 종료)", () => api.jump("result")),
    btn("⏭ 다음 라운드", () => api.nextRound()),
    btn("🏁 최종 화면", () => api.toFinal())
  ]);

  // 스파이시 / 점수 / 라운드
  section(panel, "옵션", [
    btn("🌶️ 스파이시 라운드 시작", () => api.spicyRound()),
    btn("스파이시 ON(이번 판)", () => api.setSpicy(true)),
    btn("스파이시 OFF", () => api.setSpicy(false)),
    btn("라운드 -", () => api.setRounds(-1)),
    btn("라운드 +", () => api.setRounds(1)),
    btn("🎲 점수 랜덤(최종 테스트)", () => api.randomScores())
  ]);

  // 종료
  const foot = el("div", "dbg-foot");
  foot.appendChild(btn("디버그 모드 끄기", () => disable(), "dbg-danger"));
  panel.appendChild(foot);
}

// ── 작은 헬퍼 ─────────────────────────────────
function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function btn(label, fn, extra = "") {
  const b = el("button", "dbg-btn " + extra);
  b.textContent = label;
  b.addEventListener("click", async () => {
    try { await fn(); } catch (e) { console.error("[dbg]", e); if (api) api.toast("에러: " + (e.message || e), true); }
  });
  return b;
}
function section(panel, title, buttons) {
  const wrap = el("div", "dbg-sec");
  wrap.appendChild(el("div", "dbg-sec-t")).textContent = title;
  const row = el("div", "dbg-btns");
  buttons.forEach(b => row.appendChild(b));
  wrap.appendChild(row);
  panel.appendChild(wrap);
}
function labeled(title, node) {
  const wrap = el("div", "dbg-sec");
  wrap.appendChild(el("div", "dbg-sec-t")).textContent = title;
  wrap.appendChild(node);
  return wrap;
}
function toggle(label, init, fn) {
  const l = el("label", "dbg-toggle");
  const c = el("input"); c.type = "checkbox"; c.checked = init;
  c.addEventListener("change", () => fn(c.checked));
  l.appendChild(c);
  l.appendChild(document.createTextNode(" " + label));
  return l;
}

function injectStyle() {
  if (document.getElementById("dbgStyle")) return;
  const s = el("style", null, { id: "dbgStyle" });
  s.textContent = `
  .dbg-fab{position:fixed;right:12px;bottom:12px;z-index:9000;width:48px;height:48px;border-radius:50%;
    border:2px solid #fff;background:#1e1e28;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.4)}
  .dbg-panel{position:fixed;right:12px;bottom:70px;z-index:9000;width:min(340px,92vw);max-height:78vh;overflow:auto;
    background:#1b1b24;color:#eee;border:2px solid #444;border-radius:12px;padding:10px;
    font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  .dbg-panel[hidden]{display:none}
  .dbg-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:15px;margin-bottom:6px}
  .dbg-status{background:#000;border-radius:7px;padding:6px 8px;font-size:11px;line-height:1.5;color:#8fe;margin-bottom:8px;word-break:break-all}
  .dbg-sec{margin:8px 0}
  .dbg-sec-t{font-size:11px;color:#9a9;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}
  .dbg-btns,.dbg-grid,.dbg-toggles{display:flex;flex-wrap:wrap;gap:5px}
  .dbg-grid{display:grid;grid-template-columns:repeat(3,1fr);margin-top:5px}
  .dbg-btn{background:#2c2c3a;color:#eee;border:1px solid #4a4a5a;border-radius:7px;padding:7px 9px;
    font-size:12px;cursor:pointer;font-family:inherit}
  .dbg-btn:hover{background:#3a3a4c}
  .dbg-btn:active{transform:translateY(1px)}
  .dbg-primary{background:#2f6fed;border-color:#2f6fed}
  .dbg-danger{background:#7a2530;border-color:#a33}
  .dbg-x{padding:2px 8px}
  .dbg-foot{margin-top:10px;display:flex;justify-content:center}
  .dbg-toggle{display:flex;align-items:center;gap:4px;font-size:12px;background:#26263200;padding:3px 4px}
  .dbg-modal{position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
  .dbg-box{background:#1b1b24;color:#eee;border:2px solid #555;border-radius:12px;padding:18px;width:min(300px,88vw);
    display:flex;flex-direction:column;gap:10px;font-family:system-ui,sans-serif}
  .dbg-title{font-size:17px;font-weight:700;text-align:center}
  .dbg-input{background:#000;border:1px solid #555;border-radius:8px;color:#fff;padding:10px;font-size:16px;text-align:center;letter-spacing:.3em}
  .dbg-row{display:flex;gap:8px}
  .dbg-row .dbg-btn{flex:1;text-align:center;padding:9px}
  .dbg-err{color:#f77;font-size:12px;text-align:center;min-height:14px}`;
  document.head.appendChild(s);
}
