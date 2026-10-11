import { hideFlash, showFlash } from "./flash.js";
import { startGuard, stopGuard } from "./guard.js";

/* ── Constants ─────────────────────────────────────────────── */
const SESSION_KEY = "dt-session-v2";
const POLL_MS = 5000;
const POLL_BACKGROUND_MS = 20000;
const REQUEST_TIMEOUT_MS = 12000;
const LEADERBOARD_REFRESH_MS = 10000;

/* ── State ─────────────────────────────────────────────────── */
let session = loadSession();
let team = null;
let receivedAt = 0;
let lastSignature = "";
let pollTimer = null;
let polling = false;
let pollFailures = 0;
let pendingRender = false;
let flashVisible = false;
let flashClosing = false;
let flashRetryAt = 0;
const ui = { view: session ? "loading" : "login", loginError: "", leaderboard: null, leaderboardAt: 0, waitOpen: false, industryPick: null, online: true };

const $ = selector => document.querySelector(selector);
const page = $("#page");
const money = value => {
  const amount = Math.round(Number(value) || 0);
  return `${amount < 0 ? "-" : ""}₹${Math.abs(amount).toLocaleString("en-IN")}`;
};
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const pad = value => String(value).padStart(2, "0");

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/* ── Session ───────────────────────────────────────────────── */
function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return saved?.token && saved?.teamId ? saved : null;
  } catch {
    return null;
  }
}

function saveSession(value) {
  session = value;
  try {
    if (value?.teamId) localStorage.setItem("dt-last-team", value.teamId);
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* Private mode: the session lasts for this tab only. */ }
}

function endSession(message = "") {
  saveSession(null);
  team = null;
  lastSignature = "";
  ui.view = "login";
  ui.loginError = message;
  clearTimeout(pollTimer);
  closeFlashOverlay();
  render();
}

/* ── Networking ────────────────────────────────────────────── */
class RequestError extends Error {
  constructor(message, { status = 0, payload = {}, network = false } = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.network = network;
  }
}

async function api(path, { method = "GET", body, timeout = REQUEST_TIMEOUT_MS, raw = false, auth = true, keepalive = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && session?.token) headers.Authorization = `Team ${session.token}`;
  try {
    const response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: raw ? "default" : "no-store",
      keepalive
    });
    if (raw && response.ok) return response;
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && auth && session) {
      endSession(payload.error || "Your session ended. Sign in again with your team PIN.");
      throw new RequestError(payload.error || "Signed out.", { status: 401, payload });
    }
    setConnection(true);
    if (!response.ok) throw new RequestError(payload.error || `Something went wrong (${response.status}). Please try again.`, { status: response.status, payload });
    return payload;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    setConnection(false);
    const message = error.name === "AbortError"
      ? "The server is taking too long to respond. Check your connection and try again."
      : "Could not reach the server. Check your connection and try again.";
    throw new RequestError(message, { network: true });
  } finally {
    clearTimeout(timer);
  }
}

function setConnection(ok) {
  ui.online = ok;
  const el = $("#utilityStatus");
  const text = $("#connectionText");
  if (!el || !text) return;
  el.classList.toggle("offline", !ok);
  text.textContent = ok ? "LIVE" : "RECONNECTING…";
}

function reportActivity(kind, detail) {
  if (!session) return;
  api("/team/activity", { method: "POST", body: { kind, detail }, keepalive: true, timeout: 8000 }).catch(() => {});
}

async function poll() {
  clearTimeout(pollTimer);
  if (!session || polling) return;
  polling = true;
  try {
    applyState(await api("/team/state"));
    pollFailures = 0;
  } catch (error) {
    if (error.network) pollFailures += 1;
  } finally {
    polling = false;
    if (session) {
      const base = document.hidden && !flashVisible ? POLL_BACKGROUND_MS : POLL_MS;
      pollTimer = setTimeout(poll, Math.min(base * (1 + pollFailures), 30000));
    }
  }
}

async function refreshLeaderboard(force = false) {
  if (!force && Date.now() - ui.leaderboardAt < LEADERBOARD_REFRESH_MS / 2) return;
  try {
    const rows = await api("/leaderboard", { auth: false });
    const changed = JSON.stringify(rows) !== JSON.stringify(ui.leaderboard);
    ui.leaderboard = Array.isArray(rows) ? rows : [];
    ui.leaderboardAt = Date.now();
    if (changed && ["leaderboard", "round", "results"].includes(ui.view)) requestRender(true);
  } catch { /* Keep showing the last copy. */ }
}

/* ── Derived state ─────────────────────────────────────────── */
function remaining(ms) {
  return Math.max(0, Number(ms || 0) - (Date.now() - receivedAt));
}

function waitRemaining() {
  return team ? remaining(team.roundWaitRemainingMs) : 0;
}

function flashRemaining() {
  if (!team?.activeFlash || !team.settings.flashTimer.enabled || team.flashCompleted) return 0;
  return remaining(team.activeFlash.remainingMs);
}

function myRank() {
  if (!ui.leaderboard || !team) return null;
  const index = ui.leaderboard.findIndex(row => row.teamId.toLowerCase() === team.teamId.toLowerCase());
  return index < 0 ? null : { rank: index + 1, total: ui.leaderboard.length };
}

function stage() {
  if (!team) return "login";
  if (!team.industry) return "industry";
  if (team.finished) return "finished";
  if (team.submitted) return waitRemaining() > 0 ? "waiting" : "next-open";
  if (!team.flashCompleted) return "flash";
  if (!team.datasetDownloaded) return "dataset";
  return "invest";
}

function viewAllowed(view) {
  if (!team) return view === "login";
  if (view === "industry" || view === "leaderboard") return true;
  if (view === "round") return Boolean(team.industry);
  if (view === "results") return team.history.length > 0;
  return false;
}

function defaultView() {
  if (!team) return "login";
  if (!team.industry) return "industry";
  return team.submitted || team.finished ? "results" : "round";
}

function applyState(next) {
  if (!next || typeof next !== "object" || !next.teamId) return;
  const previous = team;
  team = next;
  receivedAt = Date.now();
  if (previous && next.moneyRevision > previous.moneyRevision) {
    toast(`An organizer updated your balance to ${money(next.companyValue)}.`, "info");
  }
  if (!viewAllowed(ui.view)) ui.view = defaultView();
  else if (previous && next.round > previous.round) ui.view = "round";
  else if (previous && !previous.submitted && next.submitted) ui.view = "results";
  ui.waitOpen = waitRemaining() === 0;
  syncFlash();
  const signature = JSON.stringify({ ...next, serverNow: 0, roundWaitRemainingMs: next.roundWaitRemainingMs > 0, activeFlash: next.activeFlash ? next.activeFlash.round : null });
  if (signature !== lastSignature) {
    lastSignature = signature;
    requestRender();
  }
}

/* ── Rendering ─────────────────────────────────────────────── */
function requestRender(soft = false) {
  const editing = document.activeElement?.matches?.("input[data-param]");
  if (editing && soft) return;
  if (editing) {
    pendingRender = true;
    return;
  }
  render();
}

document.addEventListener("focusout", event => {
  if (!pendingRender || !event.target.matches?.("input[data-param]")) return;
  setTimeout(() => {
    if (document.activeElement?.matches?.("input[data-param]")) return;
    pendingRender = false;
    render();
  }, 0);
});

function render() {
  const signedIn = Boolean(team);
  $("#signOut").hidden = !signedIn;
  renderUtility();
  renderWire();
  const steps = $("#steps");
  steps.hidden = !signedIn;
  steps.innerHTML = signedIn ? renderSteps() : "";
  const currentStep = steps.querySelector(".desk-tab.current");
  if (currentStep) {
    const strip = currentStep.parentElement;
    strip.scrollLeft = Math.max(0, currentStep.offsetLeft - (strip.clientWidth - currentStep.offsetWidth) / 2);
  }

  const views = { login: renderLogin, loading: renderLoading, industry: renderIndustry, round: renderRound, results: renderResults, leaderboard: renderLeaderboard };
  const scrollY = window.scrollY;
  const previousView = page.dataset.view;
  page.dataset.view = ui.view;
  page.innerHTML = `${signedIn ? renderNextStep() : ""}${(views[ui.view] || renderLogin)()}`;
  if (ui.view === "round") restoreDraft();
  if (previousView === ui.view) window.scrollTo(0, scrollY);
  tick();
}

function renderUtility() {
  const el = $("#utilityStatus");
  if (!team) {
    el.className = "utility-status";
    el.textContent = "LIVE SIMULATION DESK · VOL. 01";
    return;
  }
  el.className = `utility-status ${ui.online ? "" : "offline"}`;
  el.innerHTML = `<span class="live-dot" aria-hidden="true"></span><span id="connectionText">${ui.online ? "LIVE" : "RECONNECTING…"}</span><span>· ${esc(team.teamId.toUpperCase())}${team.industry ? ` · ${esc(team.industry.toUpperCase())} DESK` : ""}</span>`;
}

function renderWire() {
  const wire = $("#wire");
  if (!team) {
    wire.textContent = "MARKETS MOVE · NEWS SPREADS · DECISIONS COMPOUND";
    return;
  }
  const next = {
    industry: "NEXT: CHOOSE YOUR INDUSTRY DESK",
    flash: `NEXT: READ THE ROUND ${team.round} FLASH`,
    dataset: `NEXT: DOWNLOAD THE ROUND ${team.round} DATASET`,
    invest: `NEXT: INVEST ${money(team.budget)} AND SUBMIT`,
    waiting: `ROUND ${team.round} SUBMITTED · ROUND ${team.round + 1} OPENS SOON`,
    "next-open": `ROUND ${team.round + 1} IS OPEN`,
    finished: team.isEliminated ? "YOUR TEAM IS OUT OF THE GAME" : "ALL FOUR ROUNDS COMPLETE"
  }[stage()];
  const timer = team.settings.flashTimer.enabled ? "FLASH TIMER ON · 5 MIN" : "FLASH TIMER OFF";
  const wait = team.settings.roundWait.enabled ? "30-MIN ROUND WAIT ON" : "ROUND WAIT OFF";
  wire.textContent = [team.industry ? `ROUND ${team.round} OF 0${team.rounds}` : "", next, timer, wait].filter(Boolean).join(" · ");
}

function renderLoading() {
  return `<p class="press-loading">RECONNECTING TO YOUR TEAM…</p>`;
}

function deskTab({ view, number, title, detail, state, disabledReason }) {
  const current = ui.view === view;
  const disabled = Boolean(disabledReason);
  return `<button type="button" class="desk-tab ${state} ${current ? "current" : ""}" data-action="nav" data-view="${view}" ${disabled ? `disabled title="${esc(disabledReason)}"` : ""} ${current ? 'aria-current="page"' : ""}>
    <span class="desk-tab-number" aria-hidden="true">${state === "done" ? "✓" : disabled ? "🔒" : number}</span>
    <span class="desk-tab-text"><strong>${esc(title)}</strong><small>${esc(disabled ? disabledReason : detail)}</small></span>
  </button>`;
}

function renderSteps() {
  const s = stage();
  const roundDetail = {
    flash: "Read the flash", dataset: "Download the dataset", invest: "Invest your budget",
    waiting: "Round submitted", "next-open": "Next round open", finished: "All rounds done"
  }[s] || "";
  const latest = team.history.at(-1);
  return `<div class="desk-tabs-inner">
    ${deskTab({ view: "industry", number: 1, title: "01 · Industry", detail: team.industry ? `${team.industry} (locked)` : "Choose your desk", state: team.industry ? "done" : "todo" })}
    ${deskTab({ view: "round", number: 2, title: `02 · Round ${team.round} of 4`, detail: roundDetail, state: team.finished ? "done" : "todo", disabledReason: team.industry ? "" : "Choose an industry first" })}
    ${deskTab({ view: "results", number: 3, title: "03 · Results", detail: latest ? `Round ${latest.round}: ${money(latest.payout)}` : "", state: "todo", disabledReason: latest ? "" : "Submit a round first" })}
    ${deskTab({ view: "leaderboard", number: 4, title: "🏆 Leaderboard", detail: "Live rankings", state: "todo" })}
  </div>`;
}

function renderNextStep() {
  const s = stage();
  const r = team.round;
  const items = {
    industry: ["Choose your industry desk", "Pick one of the five industries below, then confirm it. It stays locked for all four rounds.", null],
    flash: [`Read the Round ${r} flash`, "Open the storyline flash and read it with your team. The dataset unlocks when you finish.", ["OPEN FLASH", "open-flash"]],
    dataset: [`Download the Round ${r} dataset`, "Use the data to decide where to invest.", ["DOWNLOAD DATASET", "download-dataset"]],
    invest: [`Invest ${money(team.budget)} and submit`, `Split the full budget across the ten parameters, at least ${money(team.minAllocation)} each, then lock it in.`, ui.view === "round" ? ["GO TO THE DESK", "scroll-to-allocation"] : [`GO TO ROUND ${r}`, "nav", "round"]],
    waiting: [`Round ${r} submitted`, `Round ${r + 1} opens in <b data-countdown="wait">${formatDuration(waitRemaining())}</b>. This page updates on its own.`, ui.view === "results" ? null : ["VIEW RESULTS", "nav", "results"]],
    "next-open": [`Round ${r + 1} is open`, "Start the next round when your team is ready.", [`PROCEED TO ROUND ${r + 1} ➔`, "advance"]],
    finished: [team.isEliminated ? "Your team is out of the game" : "All four rounds complete", "See where your team finished.", ui.view === "leaderboard" ? null : ["🏆 VIEW LEADERBOARD", "nav", "leaderboard"]]
  }[s];
  if (!items) return "";
  const [title, body, action] = items;
  const button = action ? `<div class="next-bulletin-action"><button type="button" data-action="${action[1]}" ${action[2] ? `data-view="${action[2]}"` : ""}>${esc(action[0])}</button></div>` : "";
  return `<section class="next-bulletin" aria-live="polite"><span class="next-bulletin-label">NEXT STEP</span><div class="next-bulletin-body"><h3>${esc(title)}</h3><p>${body}</p></div>${button}</section>`;
}

function shellHeading(eyebrow, title) {
  return `<div class="section-heading"><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div>`;
}

/* ── 1. Login ── */
function lastTeamName() {
  try { return localStorage.getItem("dt-last-team") || ""; } catch { return ""; }
}

function renderLogin() {
  return `<section class="front-page">
    <div class="front-copy">
      <div class="breaking-banner">TECHTATVA '26 · DATA TYCOON</div>
      <h2>WELCOME,<br><em>ANALYSTS.</em></h2>
      <p class="lead">Read each industry dataset, then allocate the full round budget across its ten parameters.</p>
      <div class="front-note">
        <span class="article-label">EVENT RULES</span>
        <p>Choose one industry for four rounds. Start with <b>₹10,00,000</b>; your balance carries forward, with a ₹2,50,000 bonus before Round 2 and Round 3. Read each round's flash, download the dataset, and invest the full round budget across ten parameters, with a ₹1,000 minimum per parameter.</p>
        <p class="monitoring-notice">While a flash is open, the organizers are alerted to screenshot shortcuts and to leaving the tab or window. Some operating system screenshot methods cannot be detected by a website.</p>
      </div>
    </div>
    <form class="login-form" id="loginForm" autocomplete="on">
      <div class="article-label">NEWSROOM LOG IN</div>
      <label for="teamId">Team ID / Name</label>
      <input class="text-input" id="teamId" name="teamId" required minlength="2" maxlength="40" autocomplete="username" placeholder="Enter your Team Name (e.g. Team Alpha)" value="${esc(session?.teamId || lastTeamName())}">
      <label for="pin">Access PIN</label>
      <input class="text-input" id="pin" name="pin" type="password" required minlength="4" maxlength="64" autocomplete="current-password" placeholder="Create a PIN or enter your team PIN">
      <small>First sign-in sets the team PIN. Use the same team name and PIN to sign back in.</small>
      <small>One laptop per team: signing in on another device signs this one out. Your saved round resumes after sign-in.</small>
      ${ui.loginError ? `<p class="form-error" role="alert">${esc(ui.loginError)}</p>` : ""}
      <button type="submit">ENTER THE NEWSROOM</button>
    </form>
  </section>`;
}

/* ── 2. Industry selection ── */
function renderIndustry() {
  const locked = Boolean(team.industry);
  const capacity = team.industryCapacity || [];
  const selected = locked ? team.industry : ui.industryPick;
  const cards = locked
    ? [{ industry: team.industry, description: "Your team's industry for all four rounds.", remaining: null, capacity: 20 }]
    : capacity;
  return `${shellHeading("STEP 1", "SELECT YOUR INDUSTRY DESK")}
  <p class="intro-copy">Choose one industry for your company. Confirming your choice locks it for all four rounds. Each industry takes up to 20 teams.</p>
  <div class="selection-strip">
    <div>
      <strong>${selected ? `SELECTED: ${esc(selected.toUpperCase())}` : "NO INDUSTRY SELECTED YET"}</strong>
      <span>${locked ? "YOUR INDUSTRY IS LOCKED FOR ALL FOUR ROUNDS" : selected ? "CLICK CONFIRM TO OPEN YOUR DASHBOARD" : "CHOOSE AN INDUSTRY BELOW"}</span>
    </div>
    ${locked
      ? `<button type="button" data-action="nav" data-view="round">GO TO ROUND ${team.round} DASHBOARD ➔</button>`
      : `<button type="button" data-action="confirm-industry" ${selected ? "" : "disabled"}>CONFIRM &amp; PROCEED TO DASHBOARD ➔</button>`}
  </div>
  <div class="article-grid">
    ${cards.map((item, index) => {
      const full = item.remaining !== null && item.remaining <= 0;
      const isSelected = selected === item.industry;
      const seats = item.remaining === null ? "INDUSTRY LOCKED" : full ? "NO SEATS LEFT" : `${item.remaining} of ${item.capacity} seats remaining`;
      return `<article class="industry-card editorial-choice ${isSelected ? "selected" : ""}">
        <div class="choice-topline"><span class="choice-number">0${locked ? 1 : index + 1}</span><span class="article-label">INDUSTRY DESK</span></div>
        <h3>${esc(item.industry)}</h3>
        <p>${esc(item.description)}</p>
        <p class="industry-seats" aria-live="polite">${seats}</p>
        ${locked ? "" : `<button type="button" class="choice-button ${isSelected ? "ghost" : ""}" data-action="select-industry" data-industry="${esc(item.industry)}" ${full ? "disabled" : ""}>${isSelected ? "✓ SELECTED" : full ? "NO SEATS LEFT" : "CHOOSE THIS INDUSTRY"}</button>`}
      </article>`;
    }).join("")}
  </div>`;
}

/* ── 3. Round dashboard ── */
function stepTag(done, current, label) {
  return `<span class="step-tag ${done ? "done" : current ? "current" : ""}">${label} · ${done ? "COMPLETE ✓" : current ? "DO THIS NOW" : "LOCKED"}</span>`;
}

function companyValueChart() {
  const history = team.history || [];
  const points = [{ round: 0, value: history[0]?.budget || 1_000_000 }, ...history.map(item => ({ round: item.round, value: Math.max(0, item.payout) }))];
  const values = points.map(p => p.value);
  const mn = Math.min(...values), mx = Math.max(...values);
  const pad = Math.max((mx - mn) * 0.22, points[0].value * 0.012, 1);
  const lo = Math.max(0, mn - pad), hi = mx + pad;
  const w = 760, h = 160, l = 48, r = 18, t = 18, b = 33;
  const x = i => l + i * (w - l - r) / Math.max(points.length - 1, 1);
  const y = v => h - b - (v - lo) / (hi - lo || 1) * (h - t - b);
  const coords = points.map((p, i) => `${x(i)},${y(p.value)}`);
  const change = points.length > 1 ? points.at(-1).value - points.at(-2).value : 0;
  const pct = points.length > 1 && points.at(-2).value ? (change / points.at(-2).value) * 100 : 0;
  const trend = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const base = h - b;
  return `<section class="company-chart-card ${trend}">
    <div class="chart-card-head">
      <div><span class="article-label">VALUATION TRAJECTORY</span><h3>NET CAPITAL TREND</h3></div>
      <div class="chart-current">
        <small>${points.length > 1 ? `ROUND ${String(points.at(-1).round).padStart(2, "0")}` : "STARTING CAPITAL"}</small>
        <b>${money(points.at(-1).value)}</b>
        <span class="trend-${trend}">${change > 0 ? "▲ +" : change < 0 ? "▼ " : "± "}${Math.abs(pct).toFixed(1)}%</span>
      </div>
    </div>
    <svg class="value-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Company value after each round">
      <line class="chart-rule" x1="${l}" y1="${t}" x2="${w}" y2="${t}"/>
      <line class="chart-rule" x1="${l}" y1="${(t + base) / 2}" x2="${w}" y2="${(t + base) / 2}"/>
      <line class="chart-rule" x1="${l}" y1="${base}" x2="${w}" y2="${base}"/>
      <polygon class="value-area" points="${x(0)},${base} ${coords.join(" ")} ${x(points.length - 1)},${base}"/>
      <polyline class="value-line" points="${coords.join(" ")}"/>
      ${points.map((p, i) => `<circle class="value-dot" cx="${x(i)}" cy="${y(p.value)}" r="4"/><text class="chart-axis" x="${x(i)}" y="${h - 8}" text-anchor="middle">${i === 0 ? "START" : `RD ${p.round}`}</text>`).join("")}
    </svg>
  </section>`;
}

function renderRound() {
  const s = stage();
  const rank = myRank();
  const flashDone = team.flashCompleted;
  const dataDone = team.datasetDownloaded;
  const canInvest = flashDone && dataDone && !team.submitted && !team.finished;
  const timerOn = team.settings.flashTimer.enabled;
  const waitOn = team.settings.roundWait.enabled;
  const fileType = team.datasetName.split(".").pop().toUpperCase();
  const step = (done, current) => (done ? "done" : current ? "current" : "");
  const head = `<div class="live-label">LIVE MARKET DASHBOARD · ROUND ${String(team.round).padStart(2, "0")} OF 04</div>
  ${shellHeading(`${esc(team.industry.toUpperCase())} INDUSTRY`, `ROUND ${team.round} DASHBOARD`)}
  <div class="market-tape">
    <div><small>ROUND BUDGET</small><b class="tape-budget">${money(team.budget)}</b></div>
    <div><small>LEADERBOARD RANK</small><b class="tape-rank">${rank ? `#${rank.rank} <span>of ${rank.total} teams</span>` : "…"}</b></div>
    <div><small>ROUND PROGRESS</small><b>ROUND ${team.round} / 4</b></div>
    <div><small>SELECTED INDUSTRY</small><b>${esc(team.industry)}</b></div>
  </div>`;
  if (team.finished) {
    return `${head}<section class="analysis-card notice-card"><span class="article-label">${team.isEliminated ? "ROUND DISQUALIFICATION" : "FINAL EDITION"}</span><h3>${team.isEliminated ? "YOUR TEAM IS ELIMINATED" : "ALL FOUR ROUNDS COMPLETE"}</h3><p>${team.isEliminated ? "The zero-return parameter received more than 80% of the round budget. Your team cannot submit more rounds." : `Your final balance is ${money(team.companyValue)}.`}</p><button type="button" data-action="nav" data-view="leaderboard">🏆 VIEW LEADERBOARD</button></section>${companyValueChart()}`;
  }
  const budgetLine = team.bonus
    ? `<p class="bonus-line">Previous round balance: ${money(team.budget - team.bonus)} + Round ${team.round} bonus: ${money(team.bonus)}.</p>`
    : team.round > 1 ? `<p class="bonus-line">Carried forward from the previous round: ${money(team.budget)}.</p>` : "";
  const tooSmall = team.budget < team.minAllocation * team.parameters.length;
  return `${head}
  <section class="analysis-card round-instructions desk-section">
    <span class="article-label">ROUND INSTRUCTIONS</span><h3>HOW TO PLAY THIS ROUND</h3>
    ${budgetLine}
    <ol>
      <li class="${step(flashDone, s === "flash")}">Read the round flash${timerOn ? " (the flash stays locked open for five minutes)" : " (close it when your team has finished reading)"}.</li>
      <li class="${step(dataDone, s === "dataset")}">Download the official dataset for this industry and round.</li>
      <li class="${step(team.submitted, s === "invest")}">Allocate exactly ${money(team.budget)} across the ten parameters, with at least ${money(team.minAllocation)} in each.</li>
      <li class="${step(team.submitted, false)}">Lock in your investments to see your payout${team.round < 4 ? waitOn ? ". The next round opens 30 minutes after you submit." : ". The next round opens as soon as you submit." : "."}</li>
    </ol>
    <div class="settings-line"><span>FLASH TIMER: <b>${timerOn ? "ON · 5 MINUTES" : "OFF · CLOSE WHEN READY"}</b></span><span>ROUND WAIT: <b>${waitOn ? "ON · 30 MINUTES" : "OFF"}</b></span><span>SET BY THE ORGANIZERS</span></div>
  </section>
  <section class="flash-callout desk-section ${flashDone ? "done" : ""}">
    ${stepTag(flashDone, s === "flash", "STEP 1")}
    <span class="article-label" style="display:block">MANDATORY STORYLINE FLASH · ROUND ${team.round}</span>
    <h2>ROUND ${team.round} FLASH</h2>
    <p>${flashDone ? "You have read this round's flash. You can open it again at any time before you submit." : timerOn ? "The flash stays locked open for five minutes, then closes on its own and unlocks the dataset." : "Read the flash with your team, then close it to unlock the dataset."} Screenshots and leaving the tab are reported to the organizers.</p>
    <button type="button" class="${flashDone ? "ghost" : "primary-red"}" data-action="open-flash" ${team.submitted ? "disabled" : ""}>${flashDone ? "READ THE FLASH AGAIN" : "OPEN FLASH"}</button>
  </section>
  <section class="analysis-card dataset-callout desk-section ${flashDone ? "" : "locked"}">
    ${stepTag(dataDone, s === "dataset", "STEP 2")}
    <span class="article-label" style="display:block">ROUND ${team.round} DATASET FILE</span>
    <h3>${esc(team.industry.toUpperCase())} DATASET</h3>
    <p>Download the supplied ${fileType} dataset for this industry and round.</p>
    <button type="button" data-action="download-dataset" ${flashDone ? "" : "disabled"}>${dataDone ? "DATASET DOWNLOADED · DOWNLOAD AGAIN" : `DOWNLOAD ROUND ${team.round} DATASET (${fileType})`}</button>
    ${flashDone ? "" : `<p class="lock-note">Complete the storyline flash to unlock the dataset.</p>`}
  </section>
  ${companyValueChart()}
  ${team.submitted ? "" : tooSmall
    ? `<section class="analysis-card notice-card"><span class="article-label">INVESTMENT ALLOCATION DESK</span><h3>YOUR BUDGET IS TOO SMALL TO INVEST</h3><p>Every parameter needs at least ${money(team.minAllocation)}, so a round needs ${money(team.minAllocation * team.parameters.length)}. Please speak to an organizer.</p></section>`
    : renderAllocation(canInvest, s === "invest")}`;
}

function renderAllocation(enabled, current) {
  const rows = team.parameters.map((name, index) => `<tr>
    <td class="alloc-param"><strong>${esc(name)}</strong><small>${index < 5 ? "COMMON PARAMETER" : "INDUSTRY PARAMETER"}</small></td>
    <td class="alloc-rule">Minimum ₹1,000 <br><span data-share="${index}">0.0%</span> of budget</td>
    <td class="allocation-input-cell align-right"><span class="rupee">₹</span><input type="number" inputmode="numeric" min="${team.minAllocation}" step="1000" data-param="${esc(name)}" aria-label="Amount for ${esc(name)}" placeholder="0" ${enabled ? "" : "disabled"}><button type="button" class="fill-rest" data-action="fill-rest" data-index="${index}" title="Put the amount still left to invest into this parameter" ${enabled ? "" : "disabled"}>+ REST</button></td>
  </tr>`).join("");
  return `<section class="allocation-section desk-section" id="allocation">
    ${stepTag(team.submitted, current, "STEP 3")}
    <div class="article-label">INVESTMENT ALLOCATION DESK</div><h2>INVEST ACROSS THE TEN PARAMETERS</h2>
    <p class="allocation-intro">Invest exactly ${money(team.budget)} in total. Each parameter must receive at least ₹1,000. Allocation bands adjust returns: concentrating heavily in the wrong parameter can create a direct loss, and putting more than 80% into a zero-return parameter disqualifies the round.</p>
    <div class="alloc-tools"><span class="hint">USE THE ARROWS OR ↑ / ↓ KEYS TO CHANGE AMOUNTS IN ₹1,000 STEPS · “+ REST” ADDS WHATEVER IS STILL LEFT</span><button type="button" class="ghost" data-action="clear-allocation" ${enabled ? "" : "disabled"}>CLEAR ALL</button></div>
    <div class="table-scroll"><table class="alloc-table"><thead><tr><th>Industry parameter</th><th>Rule</th><th class="align-right">Investment amount</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="alloc-totals">
      <div><span>REQUIRED ROUND BUDGET:</span><b>${money(team.budget)}</b></div>
      <div><span>TOTAL INVESTED:</span><b id="allocTotal">₹0</b></div>
      <div><span>REMAINING TO ALLOCATE:</span><b id="allocRemaining">${money(team.budget)}</b></div>
    </div>
    <div id="allocMessage" class="total invalid">${enabled ? "" : !team.flashCompleted ? "🔒 COMPLETE THE STORYLINE FLASH TO CONTINUE" : `🔒 DOWNLOAD THE ROUND ${team.round} DATASET TO UNLOCK INVESTMENTS`}</div>
    <button type="button" id="submitRound" class="submit-round" data-action="submit-round" disabled>LOCK &amp; SUBMIT ROUND ${team.round}</button>
  </section>`;
}

/* ── 4. Results ── */
function resultRows(result) {
  return Object.entries(result.allocations || {}).map(([name, amount]) => {
    const returned = Number(result.returns?.[name] || 0);
    return `<tr><td><b>${esc(name)}</b></td><td>${((Number(amount) / (result.budget || 1)) * 100).toFixed(2)}%</td><td>${money(amount)}</td><td class="${returned >= Number(amount) ? "returned-up" : "returned-down"}">${money(returned)}</td></tr>`;
  }).join("");
}

function resultTable(result) {
  return `<div class="table-scroll"><table><thead><tr><th>Investment parameter</th><th>Allocation</th><th>Invested amount</th><th>Amount returned</th></tr></thead><tbody>${resultRows(result)}</tbody></table></div>`;
}

function renderResults() {
  const latest = team.history.at(-1);
  if (!latest) {
    return `${shellHeading("RESULTS", "NO ROUND CLOSED YET")}<button type="button" data-action="nav" data-view="round">RETURN TO DASHBOARD ➔</button>`;
  }
  const s = stage();
  const rank = myRank();
  let next = "";
  if (s === "finished") {
    next = `<button type="button" class="final" data-action="nav" data-view="leaderboard">🏆 VIEW FINAL LEADERBOARD &amp; WINNERS ➔</button>`;
  } else if (s === "waiting") {
    next = `<p class="round-wait-message" role="status">Next flash unlocks in <span data-countdown="wait">${formatDuration(waitRemaining())}</span>.</p>
      <p class="wait-note">Stay on this page. The button unlocks on its own; no need to refresh.</p>
      <button type="button" class="advance" disabled>NEXT FLASH LOCKED · WAIT FOR COUNTDOWN</button>`;
  } else if (s === "next-open") {
    next = `<p class="round-wait-message" role="status">${team.settings.roundWait.enabled ? "The next flash is available now." : "The organizer has removed the 30-minute wait. The next flash is available now."}</p>
      <button type="button" class="advance" data-action="advance">PROCEED TO ROUND ${team.round + 1} DASHBOARD ➔</button>`;
  }
  const older = team.history.slice(0, -1).reverse().map(item => `<details class="past-round"><summary><span>ROUND ${item.round} CLOSE · PAYOUT ${money(item.payout)}</span><span class="${item.netProfit >= 0 ? "returned-up" : "returned-down"}">${item.netProfit >= 0 ? "+" : ""}${money(item.netProfit)}</span></summary>${resultTable(item)}</details>`).join("");
  return `${shellHeading(`ROUND ${String(latest.round).padStart(2, "0")} CLOSE`, latest.eliminated ? "TEAM ELIMINATED" : "INVESTMENT RESULTS")}
  ${companyValueChart()}
  <section class="results-card">
    <div class="article-label">${esc(team.industry.toUpperCase())} PERFORMANCE REPORT</div>
    <h2>ROUND ${latest.round} FINANCIAL CLOSE</h2>
    <div class="result-highlight">
      <span>FINAL ROUND PAYOUT</span>
      <strong>${money(latest.payout)}</strong>
      <span class="${latest.netProfit >= 0 ? "profit-up" : "profit-down"}">NET PROFIT: ${latest.netProfit >= 0 ? "+" : ""}${money(latest.netProfit)}</span>
      ${latest.bonus ? `<span style="margin-top:8px;font-weight:bold;color:var(--green)">PRE-ROUND TEAM BONUS ADDED TO ROUND ${latest.round} BUDGET: +${money(latest.bonus)}</span>` : ""}
      ${latest.payout < 0 ? `<span style="margin-top:8px">BALANCES CANNOT GO BELOW ₹0, SO YOUR BALANCE IS NOW ₹0.</span>` : ""}
      ${latest.eliminated ? `<span class="error" style="margin-top:8px">DISQUALIFIED: MORE THAN 80% OF THE BUDGET WENT INTO A ZERO-RETURN PARAMETER, SO THE PAYOUT IS ZERO.</span>` : ""}
      <span style="margin-top:8px;font-weight:bold;color:var(--red)">CURRENT LEADERBOARD RANK: ${rank ? `#${rank.rank} of ${rank.total} teams` : "…"}</span>
    </div>
    ${resultTable(latest)}
    <div class="next-round-desk">${next}</div>
  </section>
  ${older}`;
}

/* ── 5. Leaderboard ── */
function renderLeaderboard() {
  const rows = ui.leaderboard;
  const body = !rows ? `<tr><td colspan="5" style="text-align:center">Loading rankings…</td></tr>`
    : !rows.length ? `<tr><td colspan="5" style="text-align:center">No teams recorded yet.</td></tr>`
    : rows.map((row, index) => {
      const me = team && row.teamId.toLowerCase() === team.teamId.toLowerCase();
      const badge = index === 0 ? "🥇 1ST" : index === 1 ? "🥈 2ND" : index === 2 ? "🥉 3RD" : `#${index + 1}`;
      return `<tr class="${me ? "me" : ""}"><td><b>${badge}</b></td><td><b>${esc(row.teamId)}</b>${me ? ' <span class="you">(YOU)</span>' : ""}</td><td>${esc(row.industry || "-")}</td><td>${row.isEliminated ? "Eliminated" : `Round ${row.round}`}</td><td class="balance">${money(row.companyValue)}</td></tr>`;
    }).join("");
  return `${shellHeading("TECHTATVA '26", "OFFICIAL LEADERBOARD")}
  <div class="leaderboard-box">
    <div class="table-scroll"><table><thead><tr><th>Rank</th><th>Team Name</th><th>Industry</th><th>Round Reached</th><th>Net Capital Balance</th></tr></thead><tbody>${body}</tbody></table></div>
  </div>
  <div class="leaderboard-actions">
    ${team?.industry ? `<button type="button" data-action="nav" data-view="${team.history.length && (team.submitted || team.finished) ? "results" : "round"}">BACK TO ${team.history.length && (team.submitted || team.finished) ? "RESULTS" : "ROUND DASHBOARD"}</button>` : ""}
    <button type="button" class="ghost" data-action="refresh-leaderboard">REFRESH RANKINGS</button>
    <small data-leaderboard-age>UPDATES AUTOMATICALLY</small>
  </div>`;
}

/* ── Allocation desk ── */
function draftKey() {
  return team ? `dt-draft-${team.teamId.toLowerCase()}-${team.round}-${team.budget}` : "";
}

function readDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || "{}"); } catch { return {}; }
}

function saveDraft() {
  try { localStorage.setItem(draftKey(), JSON.stringify(collectAllocation())); } catch { /* ignore */ }
}

function restoreDraft() {
  const draft = readDraft();
  document.querySelectorAll("input[data-param]").forEach(input => {
    if (draft[input.dataset.param] !== undefined) input.value = draft[input.dataset.param];
  });
  updateAllocation();
}

function collectAllocation() {
  const values = {};
  document.querySelectorAll("input[data-param]").forEach(input => { values[input.dataset.param] = input.value; });
  return values;
}

function allocationTotal() {
  return [...document.querySelectorAll("input[data-param]")].reduce((sum, input) => {
    const value = Number(input.value);
    return input.value.trim() !== "" && Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function updateAllocation() {
  const inputs = [...document.querySelectorAll("input[data-param]")];
  if (!inputs.length || !team) return;
  let allValid = true;
  inputs.forEach((input, index) => {
    const raw = input.value.trim();
    const value = Number(raw);
    const valid = raw !== "" && Number.isInteger(value) && value >= team.minAllocation;
    allValid = allValid && valid;
    input.classList.toggle("invalid", raw !== "" && !valid);
    const share = document.querySelector(`[data-share="${index}"]`);
    if (share) share.textContent = `${Number.isFinite(value) && raw !== "" && team.budget > 0 ? ((value / team.budget) * 100).toFixed(1) : "0.0"}%`;
  });
  const total = allocationTotal();
  const left = team.budget - total;
  $("#allocTotal").textContent = money(total);
  const remainingEl = $("#allocRemaining");
  remainingEl.textContent = money(left);
  remainingEl.className = left === 0 ? "exact" : left < 0 ? "over" : "";
  const enabled = !inputs[0].disabled;
  const message = $("#allocMessage");
  const ready = enabled && allValid && left === 0;
  if (enabled) {
    message.textContent = ready
      ? `ALLOCATIONS VALID · ${money(total)} INVESTED`
      : !allValid
        ? `INVALID · EACH PARAMETER NEEDS A WHOLE AMOUNT OF AT LEAST ${money(team.minAllocation)}`
        : left > 0 ? `${money(left)} STILL TO ALLOCATE · TOTAL MUST EQUAL ${money(team.budget)}` : `OVER BUDGET BY ${money(-left)} · TOTAL MUST EQUAL ${money(team.budget)}`;
    message.className = `total ${ready ? "valid" : "invalid"}`;
  }
  $("#submitRound").disabled = !ready;
}

document.addEventListener("input", event => {
  if (!event.target.matches("input[data-param]")) return;
  updateAllocation();
  saveDraft();
});

/* ── Flash overlay ── */
function syncFlash() {
  if (team?.activeFlash && !flashVisible) openFlashOverlay();
  else if (!team?.activeFlash && flashVisible) closeFlashOverlay();
  if (flashVisible) updateFlashControls();
}

function openFlashOverlay() {
  flashVisible = true;
  const round = team.activeFlash.round;
  $("#flashTitle").textContent = `FLASH ${round} OF 0${team.rounds}`;
  $("#flash").hidden = false;
  $("#appRoot").inert = true;
  document.body.classList.add("flash-open");
  startGuard({ report: reportActivity });
  showFlash({
    round,
    pages: team.flashPages,
    teamId: team.teamId,
    fetchPage: (r, p) => api(`/team/flash/page/${p}?round=${r}`, { raw: true, timeout: 20000 }).then(response => response.blob())
  });
  updateFlashControls();
  $("#flash .flash-document-frame").focus?.();
}

function closeFlashOverlay() {
  if (!flashVisible) return;
  flashVisible = false;
  stopGuard();
  hideFlash();
  $("#flash").hidden = true;
  $("#appRoot").inert = false;
  document.body.classList.remove("flash-open");
}

function updateFlashControls() {
  const timerOn = team.settings.flashTimer.enabled;
  const left = flashRemaining();
  const locked = left > 0;
  const timer = $("#flashTimer");
  timer.textContent = team.flashCompleted ? "READ" : timerOn ? formatDuration(left) : "TIMER OFF";
  timer.classList.toggle("timer-off", !timerOn || team.flashCompleted);
  $("#flashHint").textContent = team.flashCompleted ? "ALREADY READ · OPEN AGAIN" : "READ THE ROUND FLASH";
  $("#flashTimerNotice").textContent = team.flashCompleted
    ? "YOU HAVE ALREADY FINISHED THIS FLASH · CLOSE IT WHEN YOU ARE READY"
    : timerOn
      ? locked ? "SCREEN LOCKED · THIS FLASH ENDS AFTER FIVE MINUTES" : "TIME IS UP · RETURNING YOU TO THE ROUND"
      : "TIMER OFF · CLOSE THIS FLASH WHEN YOU ARE READY";
  const close = $("#flashClose");
  close.hidden = timerOn && !team.flashCompleted;
  close.disabled = locked || flashClosing;
  close.textContent = team.flashCompleted ? "CLOSE FLASH · RETURN TO ROUND" : "DONE READING · RETURN TO ROUND";
  if (!locked && timerOn && !team.flashCompleted && !flashClosing && team.activeFlash && Date.now() >= flashRetryAt) closeFlash(true);
}

async function closeFlash(automatic = false) {
  if (flashClosing) return;
  flashClosing = true;
  try {
    applyState(await api("/team/flash/close", { method: "POST" }));
    if (!automatic || team.flashCompleted) toast(`Flash ${team.round} finished. The dataset is unlocked.`, "good");
  } catch (error) {
    flashRetryAt = Date.now() + 3000;
    if (error.payload?.remainingMs) {
      team.activeFlash.remainingMs = error.payload.remainingMs;
      receivedAt = Date.now();
    } else if (error.status !== 401) {
      toast(error.message, "bad");
    }
  } finally {
    flashClosing = false;
    if (flashVisible) updateFlashControls();
  }
}

/* ── Actions ───────────────────────────────────────────────── */
function toast(message, tone = "info") {
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.classList.add("leaving"), 4500);
  setTimeout(() => el.remove(), 5000);
}

function confirmAction(title, body, okLabel = "CONFIRM") {
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmBody").innerHTML = body;
  $("#confirmOk").textContent = okLabel;
  dialog.returnValue = "";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
  });
}

async function busy(button, label, task) {
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = label; }
  try {
    return await task();
  } catch (error) {
    if (error.payload?.state) applyState(error.payload.state);
    if (error.status !== 401) toast(error.message, "bad");
    return null;
  } finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = original; }
  }
}

async function downloadDataset(button) {
  await busy(button, "DOWNLOADING…", async () => {
    const response = await api("/team/dataset", { raw: true, timeout: 30000 });
    const blob = await response.blob();
    const match = /filename="?([^";]+)"?/i.exec(response.headers.get("Content-Disposition") || "");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = match?.[1] || team.datasetName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 15000);
    toast("Dataset downloaded. The investment table is unlocked.", "good");
    await poll();
  });
}

async function submitRound(button) {
  const values = collectAllocation();
  const allocations = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Number(value)]));
  const ok = await confirmAction(`Submit Round ${team.round}?`, `You are investing <b>${money(team.budget)}</b>. You cannot change your investments after submitting.`, "LOCK & SUBMIT");
  if (!ok) return;
  await busy(button, "SUBMITTING…", async () => {
    const round = team.round;
    const next = await api("/team/submit", { method: "POST", body: { round, allocations } });
    try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
    ui.view = "results";
    applyState(next);
    render();
    refreshLeaderboard(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

async function chooseIndustry(button, industry) {
  const ok = await confirmAction(`Lock in ${industry}?`, `Your team will play all four rounds on the <b>${esc(industry)}</b> desk. This cannot be changed later.`, `LOCK IN ${industry.toUpperCase()}`);
  if (!ok) return;
  await busy(button, "RESERVING INDUSTRY SEAT…", async () => {
    applyState(await api("/team/industry", { method: "POST", body: { industry } }));
    ui.view = "round";
    render();
    toast(`${industry} locked in. Round 1 is ready.`, "good");
  });
}

document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === "home") {
    event.preventDefault();
    if (!team) return;
    ui.view = defaultView();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  if (action === "nav") {
    if (!viewAllowed(button.dataset.view)) return;
    ui.view = button.dataset.view;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (ui.view === "leaderboard") refreshLeaderboard(true);
    return;
  }
  if (action === "sign-out") {
    const ok = await confirmAction("Sign out?", "You can sign back in any time with your team name and PIN.", "SIGN OUT");
    if (ok) endSession("");
    return;
  }
  if (action === "select-industry") {
    if (team?.industry) return;
    ui.industryPick = button.dataset.industry;
    render();
    return;
  }
  if (action === "confirm-industry") {
    if (!ui.industryPick || team?.industry) return;
    return chooseIndustry(button, ui.industryPick);
  }
  if (action === "fill-rest") {
    const input = document.querySelectorAll("input[data-param]")[Number(button.dataset.index)];
    if (!input || input.disabled) return;
    const left = team.budget - allocationTotal();
    const current = Number(input.value) || 0;
    input.value = String(Math.max(team.minAllocation, current + left));
    updateAllocation();
    saveDraft();
    input.focus();
    return;
  }
  if (action === "open-flash") {
    if (ui.view !== "round") { ui.view = "round"; render(); }
    return busy(button, "OPENING…", async () => applyState(await api("/team/flash/open", { method: "POST" })));
  }
  if (action === "close-flash") return closeFlash(false);
  if (action === "download-dataset") return downloadDataset(button);
  if (action === "submit-round") return submitRound(button);
  if (action === "advance") {
    return busy(button, "OPENING…", async () => {
      applyState(await api("/team/advance", { method: "POST", body: { round: team.round } }));
      ui.view = "round";
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  if (action === "scroll-to-allocation") {
    $("#allocation")?.scrollIntoView({ behavior: "smooth", block: "start" });
    $("input[data-param]:not(:disabled)")?.focus({ preventScroll: true });
    return;
  }
  if (action === "clear-allocation") {
    document.querySelectorAll("input[data-param]").forEach(input => { input.value = ""; });
    try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
    updateAllocation();
    return;
  }
  if (action === "refresh-leaderboard") return busy(button, "REFRESHING…", () => refreshLeaderboard(true));
});

document.addEventListener("submit", async event => {
  if (event.target.id !== "loginForm") return;
  event.preventDefault();
  const form = event.target;
  const teamId = form.teamId.value.trim();
  const pin = form.pin.value;
  const button = form.querySelector("button[type=submit]");
  ui.loginError = "";
  form.querySelector(".form-error")?.remove();
  button.disabled = true;
  button.textContent = "CONNECTING…";
  try {
    const result = await api("/team/connect", { method: "POST", body: { teamId, pin }, auth: false, timeout: 20000 });
    saveSession({ teamId: result.state.teamId, token: result.token });
    ui.view = "";
    applyState(result.state);
    ui.view = defaultView();
    render();
    refreshLeaderboard(true);
    poll();
  } catch (error) {
    ui.loginError = error.message;
    const message = document.createElement("p");
    message.className = "form-error";
    message.setAttribute("role", "alert");
    message.textContent = error.message;
    button.before(message);
    button.disabled = false;
    button.textContent = "ENTER THE NEWSROOM";
  }
});

/* ── Timers ────────────────────────────────────────────────── */
function tick() {
  if (!team) return;
  const wait = waitRemaining();
  document.querySelectorAll('[data-countdown="wait"]').forEach(el => { el.textContent = formatDuration(wait); });
  if (!ui.waitOpen && wait === 0 && team.submitted) {
    ui.waitOpen = true;
    render();
    return;
  }
  if (flashVisible) updateFlashControls();
  const age = document.querySelector("[data-leaderboard-age]");
  if (age && ui.leaderboardAt) {
    const seconds = Math.round((Date.now() - ui.leaderboardAt) / 1000);
    age.textContent = seconds < 5 ? "Updated just now" : `Updated ${seconds} s ago`;
  }
}

setInterval(tick, 1000);
setInterval(() => {
  if (team && !document.hidden && ["leaderboard", "round", "results"].includes(ui.view)) refreshLeaderboard();
}, LEADERBOARD_REFRESH_MS);

document.addEventListener("visibilitychange", () => { if (!document.hidden && session) poll(); });
window.addEventListener("online", () => { if (session) poll(); });
window.addEventListener("storage", event => {
  // Another tab signed out or signed in as a different team.
  if (event.key !== SESSION_KEY) return;
  const next = loadSession();
  if (!next) endSession("");
  else if (next.token !== session?.token) { session = next; team = null; ui.view = "loading"; render(); poll(); }
});

/* ── Boot ──────────────────────────────────────────────────── */
render();
if (session) poll().then(() => { if (!team && session) render(); });
