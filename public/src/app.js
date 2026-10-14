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
  text.textContent = ok ? "Live" : "Reconnecting…";
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
    if (changed) {
      renderStatusStrip();
      if (["leaderboard", "round", "results"].includes(ui.view)) requestRender(true);
    }
  } catch { /* Keep showing the last copy. */ }
}

/* ── Derived state ─────────────────────────────────────────── */
function remaining(ms) {
  return Math.max(0, Number(ms || 0) - (Date.now() - receivedAt));
}

function waitRemaining() {
  return team ? remaining(team.roundWaitRemainingMs) : 0;
}

function scheduleRemaining() {
  return team?.scheduledRound ? remaining(team.scheduledInMs) : 0;
}

function flashMinutes() {
  return team?.settings.flashTimer.minutes || 5;
}

function minutesLabel(value) {
  return `${value} minute${value === 1 ? "" : "s"}`;
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
  if (team.submitted) {
    if (!team.nextRoundOpen) return "next-closed";
    return waitRemaining() > 0 ? "waiting" : "next-open";
  }
  if (!team.roundOpen) return "not-started";
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
  const note = next.settings.announcement;
  if (previous && note.text && note.at !== previous.settings.announcement.at) toast(`From the organizers: ${note.text}`, "info");
  if (previous && next.notice?.text && next.notice.at !== previous.notice?.at) toast(`Message for your team: ${next.notice.text}`, "info");
  if (previous && !previous.roundOpen && next.roundOpen && !next.submitted) toast(`Round ${next.round} has started. Open the news flash.`, "good");
  if (previous && !previous.nextRoundOpen && next.nextRoundOpen && next.submitted && !next.finished) toast(`Round ${next.round + 1} is now open.`, "good");
  if (!viewAllowed(ui.view)) ui.view = defaultView();
  else if (previous && next.round > previous.round) ui.view = "round";
  else if (previous && !previous.submitted && next.submitted) ui.view = "results";
  ui.waitOpen = waitRemaining() === 0;
  syncFlash();
  const signature = JSON.stringify({ ...next, serverNow: 0, roundWaitRemainingMs: next.roundWaitRemainingMs > 0, scheduledInMs: next.scheduledInMs > 0, activeFlash: next.activeFlash ? next.activeFlash.round : null });
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
  renderStatusStrip();
  renderDateline();
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
  page.innerHTML = `${signedIn ? renderNotices() + renderNextStep() : ""}${(views[ui.view] || renderLogin)()}`;
  if (ui.view === "round") restoreDraft();
  if (previousView === ui.view) window.scrollTo(0, scrollY);
  tick();
}

function renderUtility() {
  const el = $("#utilityStatus");
  if (!team) {
    el.className = "utility-status";
    el.textContent = "";
    return;
  }
  el.className = `utility-status ${ui.online ? "" : "offline"}`;
  el.innerHTML = `<span class="live-dot" aria-hidden="true"></span><span id="connectionText">${ui.online ? "Live" : "Reconnecting…"}</span><span class="utility-team">${esc(team.teamId)}${team.industry ? ` · ${esc(team.industry)}` : ""}</span>`;
}

function renderStatusStrip() {
  const strip = $("#statusStrip");
  if (!team) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  const items = [];
  (ui.leaderboard || []).slice(0, 5).forEach((row, index) => {
    const me = row.teamId.toLowerCase() === team.teamId.toLowerCase();
    items.push(`<span class="${me ? "ticker-me" : ""}"><b>${index + 1}. ${esc(row.teamId)}</b> ${money(row.companyValue)}</span>`);
  });
  const rank = myRank();
  if (rank && rank.rank > 5) items.push(`<span class="ticker-me"><b>${rank.rank}. ${esc(team.teamId)}</b> ${money(team.companyValue)}</span>`);
  if (team.settings.announcement.text) items.push(`<span>From the organizers: <b>${esc(team.settings.announcement.text)}</b></span>`);
  items.push(`<span>Flash timer: <b>${team.settings.flashTimer.enabled ? `On (${flashMinutes()} min)` : "Off"}</b></span>`);
  const html = items.join('<i aria-hidden="true">◆</i>');
  const track = $("#statusText");
  if (track.dataset.html === html) return;
  track.dataset.html = html;
  // Two copies make the scroll loop seamless; the second is hidden from screen readers.
  track.innerHTML = `<span class="ticker-run">${html}<i aria-hidden="true">◆</i></span><span class="ticker-run" aria-hidden="true">${html}<i aria-hidden="true">◆</i></span>`;
}

function renderDateline() {
  const date = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("#datelineDate").textContent = date;
  $("#datelineEdition").textContent = team?.industry ? `${team.industry} edition · Round ${team.round} of ${team.rounds}` : "TechTatva '26 · MIT Manipal";
}

function renderLoading() {
  return `<p class="press-loading">Reconnecting to your team…</p>`;
}

function deskTab({ view, number, title, detail, state, disabledReason }) {
  const current = ui.view === view;
  const disabled = Boolean(disabledReason);
  return `<button type="button" class="desk-tab ${state} ${current ? "current" : ""}" data-action="nav" data-view="${view}" ${disabled ? `disabled title="${esc(disabledReason)}"` : ""} ${current ? 'aria-current="page"' : ""}>
    <span class="desk-tab-number" aria-hidden="true">${state === "done" ? "✓" : number}</span>
    <span class="desk-tab-text"><strong>${esc(title)}</strong><small>${esc(disabled ? disabledReason : detail)}</small></span>
  </button>`;
}

function renderSteps() {
  const s = stage();
  const roundDetail = {
    flash: "Next: read the flash", dataset: "Next: get the data", invest: "Next: invest",
    waiting: "Submitted", "next-open": "Next round is open", "next-closed": "Submitted", "not-started": "Starts soon", finished: "All rounds done"
  }[s] || "";
  const latest = team.history.at(-1);
  return `<div class="desk-tabs-inner">
    ${deskTab({ view: "industry", number: 1, title: "Industry", detail: team.industry ? team.industry : "Choose one", state: team.industry ? "done" : "todo" })}
    ${deskTab({ view: "round", number: 2, title: `Round ${team.round} of 4`, detail: roundDetail, state: team.finished ? "done" : "todo", disabledReason: team.industry ? "" : "Choose an industry first" })}
    ${deskTab({ view: "results", number: 3, title: "Results", detail: latest ? `Round ${latest.round}: ${money(latest.payout)}` : "", state: "todo", disabledReason: latest ? "" : "After your first round" })}
    ${deskTab({ view: "leaderboard", number: 4, title: "Leaderboard", detail: "Live rankings", state: "todo" })}
  </div>`;
}

function renderNotices() {
  const parts = [];
  if (team.paused) parts.push(`<section class="press-notice paused" role="status"><span class="press-notice-label">Game paused</span><p>The organizers have paused the game. Everything is saved. Please wait for them to resume.</p></section>`);
  const note = team.settings.announcement;
  if (note.text) parts.push(`<section class="press-notice" role="status"><span class="press-notice-label">From the organizers</span><p>${esc(note.text)}</p></section>`);
  if (team.notice?.text) parts.push(`<section class="press-notice team" role="status"><span class="press-notice-label">Message for ${esc(team.teamId)}</span><p>${esc(team.notice.text)}</p></section>`);
  return parts.join("");
}

function nextRoundText(r) {
  return team.scheduledRound === r
    ? `Round ${r} opens in <b data-countdown="schedule">${formatDuration(scheduleRemaining())}</b>.`
    : `Round ${r} opens when the organizers start it.`;
}

function renderNextStep() {
  const s = stage();
  const r = team.round;
  // Only point somewhere else: if this page already shows the next action, skip the bulletin.
  const shownHere = (ui.view === "industry" && s === "industry")
    || (ui.view === "round" && ["flash", "dataset", "invest", "not-started"].includes(s))
    || (ui.view === "results" && ["waiting", "next-open", "next-closed", "finished"].includes(s));
  if (shownHere) return "";
  const items = {
    industry: ["Choose your industry", "Pick one of the five industries below and confirm it. You keep it for all four rounds.", null],
    "not-started": [`Round ${r} starts soon`, `${nextRoundText(r)} This page updates by itself.`, ui.view === "round" ? null : [`Go to Round ${r}`, "nav", "round"]],
    flash: [`Read the Round ${r} news flash`, "Read it together with your team: it can only be opened once. The data file unlocks when you finish.", ui.view === "round" ? null : [`Go to Round ${r}`, "nav", "round"]],
    dataset: [`Download the Round ${r} data`, "Use it to decide where to invest.", ["Download data", "download-dataset"]],
    invest: [`Invest ${money(team.budget)}`, `Split it across the ten areas below (at least ${money(team.minAllocation)} each), then submit.`, ui.view === "round" ? ["Go to the table", "scroll-to-allocation"] : [`Go to Round ${r}`, "nav", "round"]],
    "next-closed": [`Round ${r} submitted`, `${nextRoundText(r + 1)} This page updates by itself.`, ui.view === "results" ? null : ["See results", "nav", "results"]],
    waiting: [`Round ${r} submitted`, `Round ${r + 1} opens in <b data-countdown="wait">${formatDuration(waitRemaining())}</b>. This page updates on its own.`, ui.view === "results" ? null : ["See results", "nav", "results"]],
    "next-open": [`Round ${r + 1} is open`, "Start whenever your team is ready.", [`Start Round ${r + 1}`, "advance"]],
    finished: [team.isEliminated ? "Your team is out of the game" : "You've finished all four rounds", "See where your team ranks.", ui.view === "leaderboard" ? null : ["See leaderboard", "nav", "leaderboard"]]
  }[s];
  if (!items) return "";
  const [title, body, action] = items;
  const button = action ? `<div class="next-bulletin-action"><button type="button" data-action="${action[1]}" ${action[2] ? `data-view="${action[2]}"` : ""}>${esc(action[0])}</button></div>` : "";
  return `<section class="next-bulletin" aria-live="polite"><span class="next-bulletin-label">Next step</span><div class="next-bulletin-body"><h3>${esc(title)}</h3><p>${body}</p></div>${button}</section>`;
}

function pageHeading(eyebrow, title) {
  return `<div class="section-heading"><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div>`;
}

/* ── 1. Login ── */
function lastTeamName() {
  try { return localStorage.getItem("dt-last-team") || ""; } catch { return ""; }
}

function renderLogin() {
  return `<section class="front-page">
    <div class="front-copy">
      <div class="breaking-banner">TechTatva '26 · Data Tycoon</div>
      <h2>Welcome,<br><em>analysts.</em></h2>
      <p class="lead">Read the news, study the data, and invest your company's money over four rounds. The richest team wins.</p>
      <div class="front-note">
        <span class="article-label">How it works</span>
        <ul class="rules-list">
          <li>Pick <b>one industry</b> for the whole game.</li>
          <li>Start with <b>₹10,00,000</b>. Whatever you end a round with carries into the next round.</li>
          <li>Each round: <b>read the news flash</b>, <b>download the data</b>, then <b>invest all of your money</b> across ten areas (at least ₹1,000 each).</li>
        </ul>
        <p class="monitoring-notice">While a news flash is open, screenshots and switching away from the tab are reported to the organizers.</p>
      </div>
    </div>
    <form class="login-form" id="loginForm" autocomplete="on">
      <div class="article-label">Team sign in</div>
      <label for="teamId">Team name</label>
      <input class="text-input" id="teamId" name="teamId" required minlength="2" maxlength="40" autocomplete="username" placeholder="e.g. Team Alpha" value="${esc(session?.teamId || lastTeamName())}">
      <label for="pin">Team PIN</label>
      <input class="text-input" id="pin" name="pin" type="password" required minlength="4" maxlength="64" autocomplete="current-password" placeholder="From your team card">
      <small>Use the team name and PIN on the card the organizers gave you.</small>
      <small>One laptop per team. Signing in somewhere else signs this one out. Your progress is saved.</small>
      ${ui.loginError ? `<p class="form-error" role="alert">${esc(ui.loginError)}</p>` : ""}
      <button type="submit">Sign in</button>
    </form>
  </section>`;
}

/* ── 2. Industry ── */
function renderIndustry() {
  const locked = Boolean(team.industry);
  const capacity = team.industryCapacity || [];
  const selected = locked ? team.industry : ui.industryPick;
  const cards = locked
    ? [{ industry: team.industry, description: "Your team's industry for all four rounds.", remaining: null, capacity: 20 }]
    : capacity;
  return `${pageHeading("Step 1", locked ? "Your industry" : "Choose your industry")}
  <p class="intro-copy">${locked ? "Your industry is locked in for the whole game." : "Pick one industry, then confirm. You keep it for all four rounds. Each industry has room for 20 teams."}</p>
  <div class="selection-strip">
    <div>
      <strong>${selected ? `Selected: ${esc(selected)}` : "Nothing selected yet"}</strong>
      <span>${locked ? "Locked for all four rounds" : selected ? "Press confirm to lock it in" : "Choose an industry below"}</span>
    </div>
    ${locked
      ? `<button type="button" data-action="nav" data-view="round">Go to Round ${team.round}</button>`
      : `<button type="button" data-action="confirm-industry" ${selected ? "" : "disabled"}>Confirm ${selected ? esc(selected) : "industry"}</button>`}
  </div>
  <div class="article-grid">
    ${cards.map((item, index) => {
      const full = item.remaining !== null && item.remaining <= 0;
      const isSelected = selected === item.industry;
      const seats = item.remaining === null ? "Locked in" : full ? "Full" : `${item.remaining} of ${item.capacity} places left`;
      return `<article class="industry-card editorial-choice ${isSelected ? "selected" : ""}">
        <div class="choice-topline"><span class="choice-number">0${locked ? 1 : index + 1}</span><h3>${esc(item.industry)}</h3></div>
        <p>${esc(item.description)}</p>
        <p class="industry-seats ${full ? "full" : ""}" aria-live="polite">${seats}</p>
        ${locked ? "" : `<button type="button" class="choice-button ${isSelected ? "ghost" : ""}" data-action="select-industry" data-industry="${esc(item.industry)}" ${full ? "disabled" : ""}>${isSelected ? "✓ Selected" : full ? "Full" : `Choose ${esc(item.industry)}`}</button>`}
      </article>`;
    }).join("")}
  </div>`;
}

/* ── 3. Round ── */
function companyValueChart(title = "Your company's value") {
  const history = team.history || [];
  const points = [{ round: 0, value: history[0]?.budget || 1_000_000 }, ...history.map(item => ({ round: item.round, value: Math.max(0, item.payout) }))];
  const values = points.map(p => p.value);
  const mn = Math.min(...values), mx = Math.max(...values);
  const pad = Math.max((mx - mn) * 0.22, points[0].value * 0.012, 1);
  const lo = Math.max(0, mn - pad), hi = mx + pad;
  const w = 760, h = 170, l = 30, r = 30, t = 26, b = 34;
  const x = i => l + i * (w - l - r) / Math.max(points.length - 1, 1);
  const y = v => h - b - (v - lo) / (hi - lo || 1) * (h - t - b);
  const coords = points.map((p, i) => `${x(i)},${y(p.value)}`);
  const change = points.length > 1 ? points.at(-1).value - points.at(-2).value : 0;
  const pct = points.length > 1 && points.at(-2).value ? (change / points.at(-2).value) * 100 : 0;
  const trend = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const base = h - b;
  return `<section class="company-chart-card ${trend}">
    <div class="chart-card-head">
      <div><span class="article-label">After each round</span><h3>${title}</h3></div>
      <div class="chart-current">
        <small>${points.length > 1 ? `After Round ${points.at(-1).round}` : "Starting money"}</small>
        <b>${money(points.at(-1).value)}</b>
        ${points.length > 1 ? `<span class="trend-${trend}">${change > 0 ? "▲ +" : change < 0 ? "▼ " : "± "}${Math.abs(pct).toFixed(1)}% vs last round</span>` : ""}
      </div>
    </div>
    <svg class="value-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Company value after each round">
      <line class="chart-rule" x1="${l}" y1="${t}" x2="${w - r}" y2="${t}"/>
      <line class="chart-rule" x1="${l}" y1="${base}" x2="${w - r}" y2="${base}"/>
      <polygon class="value-area" points="${x(0)},${base} ${coords.join(" ")} ${x(points.length - 1)},${base}"/>
      <polyline class="value-line" points="${coords.join(" ")}"/>
      ${points.map((p, i) => `<circle class="value-dot" cx="${x(i)}" cy="${y(p.value)}" r="5"/><text class="chart-value" x="${x(i)}" y="${y(p.value) - 11}" text-anchor="${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}">${(p.value / 100000).toFixed(2)}L</text><text class="chart-axis" x="${x(i)}" y="${h - 8}" text-anchor="${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}">${i === 0 ? "Start" : `Round ${p.round}`}</text>`).join("")}
    </svg>
  </section>`;
}

function stepHeader(number, title, done, current) {
  const state = done ? "done" : current ? "current" : "locked";
  const label = done ? "Done" : current ? "Do this now" : "Locked";
  return `<div class="step-head ${state}"><span class="step-badge">${done ? "✓" : number}</span><div class="step-title"><span class="step-kicker">Step ${number} of 3</span><h3>${title}</h3></div><span class="step-state">${label}</span></div>`;
}

function renderRound() {
  const s = stage();
  const rank = myRank();
  const flashDone = team.flashCompleted;
  const dataDone = team.datasetDownloaded;
  const canInvest = flashDone && dataDone && !team.submitted && !team.finished;
  const timerOn = team.settings.flashTimer.enabled;
  const waitMinutes = team.settings.waitMinutes;
  const fileType = team.datasetName.split(".").pop().toUpperCase();
  const budgetNote = team.bonus
    ? `${money(team.budget - team.bonus)} + ${money(team.bonus)} bonus`
    : team.round === 1 ? "Same for every team" : "Carried from last round";
  const deck = team.finished ? "" : team.submitted
    ? "Your investments for this round are locked in."
    : `Read the news, check the data, then decide where your ${money(team.budget)} goes.`;
  const head = `${pageHeading(`${esc(team.industry)} · Round ${team.round} of 4`, `Round ${team.round}`)}
  ${deck ? `<p class="standfirst">${deck}</p>` : ""}
  <div class="market-tape">
    <div><small>Money to invest</small><b class="tape-budget">${money(team.budget)}</b><em>${budgetNote}</em></div>
    <div><small>Your rank</small><b class="tape-rank">${rank ? `#${rank.rank}` : "…"}</b><em>${rank ? `of ${rank.total} team${rank.total === 1 ? "" : "s"}` : "Loading"}</em></div>
    <div><small>Flash timer</small><b>${timerOn ? minutesLabel(flashMinutes()) : "Off"}</b><em>${timerOn ? "Or close it early when done" : "Close it when you're done"}</em></div>
    <div><small>Wait after you submit</small><b>${waitMinutes ? minutesLabel(waitMinutes) : "None"}</b><em>Next round starts when organizers open it</em></div>
  </div>`;
  if (team.finished) {
    return `${head}<section class="analysis-card notice-card"><h3>${team.isEliminated ? "Your team is out of the game" : "All four rounds complete"}</h3><p>${team.isEliminated ? "More than 80% of a round's money went into an area that returns nothing, so your team was disqualified." : `You finished with ${money(team.companyValue)}.`}</p><button type="button" data-action="nav" data-view="leaderboard">See leaderboard</button></section>${team.history.length ? companyValueChart() : ""}`;
  }
  if (s === "not-started") {
    return `${head}<section class="analysis-card notice-card round-closed" role="status"><span class="article-label">Please wait</span><h3>Round ${team.round} has not started yet</h3><p>${nextRoundText(team.round)} The news flash, data and investment table appear here as soon as it starts.</p></section>${team.history.length ? companyValueChart() : ""}`;
  }
  const tooSmall = team.budget < team.minAllocation * team.parameters.length;
  const reading = team.activeFlash && !flashDone;
  return `${head}
  <section class="flash-callout desk-section ${flashDone ? "done" : ""}">
    ${stepHeader(1, "Read the news flash", flashDone, s === "flash")}
    <p>${flashDone
      ? "Done. Each flash can only be read once, so it is now closed."
      : timerOn
        ? `<b>You can open it only once.</b> You have ${minutesLabel(flashMinutes())} to read it. It closes for good when the time runs out or when you finish early, then the data unlocks. Gather your team before you open it.`
        : "<b>You can open it only once.</b> Read it together, then close it to unlock the data. Once closed, it cannot be opened again."}</p>
    ${flashDone ? "" : `<button type="button" class="primary-red" data-action="open-flash" ${team.submitted || team.paused ? "disabled" : ""}>${reading ? "Continue reading" : "Open the flash"}</button>`}
  </section>
  <section class="analysis-card dataset-callout desk-section ${flashDone ? "" : "locked"}">
    ${stepHeader(2, "Download the data", dataDone, s === "dataset")}
    <p>${flashDone ? `${esc(team.industry)} data for Round ${team.round} (${fileType} file).` : "Unlocks after you read the flash."}</p>
    <button type="button" class="${dataDone ? "ghost" : ""}" data-action="download-dataset" ${flashDone ? "" : "disabled"}>${dataDone ? "Download again" : `Download ${fileType}`}</button>
  </section>
  ${team.submitted ? "" : tooSmall
    ? `<section class="analysis-card notice-card"><h3>Not enough money to invest</h3><p>Each of the ten areas needs at least ${money(team.minAllocation)}, so a round needs ${money(team.minAllocation * team.parameters.length)}. Please speak to an organizer.</p></section>`
    : renderAllocation(canInvest, s === "invest")}
  ${team.history.length ? companyValueChart() : ""}`;
}

function renderAllocation(enabled, current) {
  const rows = team.parameters.map((name, index) => `<tr>
    <td class="alloc-param"><strong>${esc(name)}</strong><small>${index < 5 ? "All industries" : `${esc(team.industry)} only`}</small></td>
    <td class="alloc-rule"><span class="pretty" data-pretty="${index}">₹0</span><span class="share-line"><span data-share="${index}">0.0%</span> of your money</span></td>
    <td class="allocation-input-cell align-right"><span class="rupee">₹</span><input type="number" inputmode="numeric" min="${team.minAllocation}" step="1000" data-param="${esc(name)}" aria-label="Amount for ${esc(name)}" placeholder="0" ${enabled ? "" : "disabled"}><button type="button" class="fill-rest" data-action="fill-rest" data-index="${index}" title="Add everything that is still left to invest to this area" ${enabled ? "" : "disabled"}>+ Rest</button></td>
  </tr>`).join("");
  return `<section class="allocation-section desk-section" id="allocation">
    ${stepHeader(3, `Invest ${money(team.budget)}`, team.submitted, current)}
    <p class="allocation-intro">Put money into all ten areas, at least ${money(team.minAllocation)} each, so the total is exactly ${money(team.budget)}. Some areas pay off more than others this round, and piling too much into one area can backfire.</p>
    <div class="alloc-tools"><span class="hint">Arrows change amounts by ₹1,000. “+ Rest” adds whatever is left.</span><span class="alloc-tool-buttons"><button type="button" class="ghost" data-action="split-evenly" ${enabled ? "" : "disabled"}>Split evenly</button><button type="button" class="ghost" data-action="clear-allocation" ${enabled ? "" : "disabled"}>Clear all</button></span></div>
    <div class="table-scroll"><table class="alloc-table"><thead><tr><th>Area</th><th>Share</th><th class="align-right">Amount</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="alloc-sticky">
      <div class="alloc-totals">
        <div><span>Money to invest</span><b>${money(team.budget)}</b></div>
        <div><span>Invested so far</span><b id="allocTotal">₹0</b></div>
        <div><span>Left to invest</span><b id="allocRemaining">${money(team.budget)}</b></div>
      </div>
      <div class="alloc-submit-row">
        <div id="allocMessage" class="total invalid">${enabled ? "" : !team.flashCompleted ? "Read the news flash first (Step 1)." : `Download the Round ${team.round} data first (Step 2).`}</div>
        <button type="button" id="submitRound" class="submit-round" data-action="submit-round" disabled>Submit Round ${team.round}</button>
      </div>
    </div>
  </section>`;
}

/* ── 4. Results ── */
function resultExtremes(result) {
  const rows = Object.entries(result.allocations || {}).map(([name, amount]) => ({ name, amount: Number(amount), returned: Number(result.returns?.[name] || 0) }));
  if (!rows.length || result.eliminated) return { best: null, worst: null };
  const ratio = row => (row.amount ? row.returned / row.amount : 0);
  const sorted = [...rows].sort((x, y) => ratio(y) - ratio(x) || y.returned - x.returned);
  return { best: sorted[0], worst: sorted.at(-1) };
}

function resultRows(result) {
  const { best, worst } = resultExtremes(result);
  return Object.entries(result.allocations || {}).map(([name, amount]) => {
    const returned = Number(result.returns?.[name] || 0);
    const tag = best?.name === name ? '<span class="row-tag best">Best</span>' : worst?.name === name ? '<span class="row-tag worst">Weakest</span>' : "";
    return `<tr><td><b>${esc(name)}</b>${tag}</td><td>${((Number(amount) / (result.budget || 1)) * 100).toFixed(1)}%</td><td>${money(amount)}</td><td class="${returned >= Number(amount) ? "returned-up" : "returned-down"}">${money(returned)}</td></tr>`;
  }).join("");
}

function resultTable(result) {
  return `<div class="table-scroll"><table class="result-table"><thead><tr><th>Area</th><th>Share</th><th>Invested</th><th>Got back</th></tr></thead><tbody>${resultRows(result)}</tbody></table></div>`;
}

function resultStory(result) {
  const pct = result.budget ? Math.abs(result.netProfit / result.budget * 100).toFixed(1) : "0.0";
  const { best, worst } = resultExtremes(result);
  const headline = result.eliminated
    ? `${team.teamId} disqualified in Round ${result.round}`
    : result.netProfit > 0 ? `${team.teamId} grows its money by ${pct}% in Round ${result.round}`
    : result.netProfit < 0 ? `A tough Round ${result.round}: ${team.teamId} slips ${pct}%`
    : `${team.teamId} breaks even in Round ${result.round}`;
  let lede = `Round ${result.round} has closed. ${team.teamId} invested ${money(result.budget)} across ten areas of the ${team.industry} market and got back ${money(result.payout)}.`;
  if (result.eliminated) lede += " More than 80% of the money went into an area that returns nothing, so the round paid nothing.";
  else if (best && worst) lede += ` The best call was ${best.name}, which turned ${money(best.amount)} into ${money(best.returned)}. ${worst.name} was the weakest, returning ${money(worst.returned)}.`;
  return `<article class="news-story results-story">
    <span class="article-label">${esc(team.industry)} · Round ${result.round} report</span>
    <h2 class="story-headline">${esc(headline)}</h2>
    <p class="byline">By the Data Tycoon desk · ${new Date(result.submittedAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
    <p class="lede">${esc(lede)}</p>
  </article>`;
}

function renderResults() {
  const latest = team.history.at(-1);
  if (!latest) {
    return `${pageHeading("Results", "No results yet")}<p class="intro-copy">Submit Round 1 to see how your investments did.</p><button type="button" data-action="nav" data-view="round">Go to Round 1</button>`;
  }
  const s = stage();
  const rank = myRank();
  let next = "";
  if (s === "finished") {
    next = `<p class="round-wait-message">${team.isEliminated ? "Your team is out of the game." : "That was the final round."}</p><button type="button" class="final" data-action="nav" data-view="leaderboard">See the final leaderboard</button>`;
  } else if (s === "waiting") {
    next = `<p class="round-wait-message" role="status">Round ${team.round + 1} opens in <span data-countdown="wait">${formatDuration(waitRemaining())}</span></p>
      <p class="wait-note">Stay on this page. The button unlocks by itself.</p>
      <button type="button" class="advance" disabled>Waiting for Round ${team.round + 1}</button>`;
  } else if (s === "next-closed") {
    next = `<p class="round-wait-message" role="status">${nextRoundText(team.round + 1)}</p>
      <p class="wait-note">Stay on this page. The button unlocks by itself.</p>
      <button type="button" class="advance" disabled>Waiting for Round ${team.round + 1}</button>`;
  } else if (s === "next-open") {
    next = `<p class="round-wait-message" role="status">Round ${team.round + 1} is open.</p>
      <button type="button" class="advance" data-action="advance">Start Round ${team.round + 1}</button>`;
  }
  const profit = latest.netProfit;
  const older = team.history.slice(0, -1).reverse().map(item => `<details class="past-round"><summary><span>Round ${item.round} · got back ${money(item.payout)}</span><span class="${item.netProfit >= 0 ? "returned-up" : "returned-down"}">${item.netProfit >= 0 ? "+" : ""}${money(item.netProfit)}</span></summary>${resultTable(item)}</details>`).join("");
  return `${pageHeading(`${esc(team.industry)} · Round ${latest.round}`, latest.eliminated ? "Disqualified" : `Round ${latest.round} results`)}
  <section class="results-card">
    ${resultStory(latest)}
    <div class="result-highlight">
      <div class="result-figures">
        <div><span>You got back</span><strong>${money(latest.payout)}</strong></div>
        <div><span>Profit</span><strong class="${profit >= 0 ? "profit-up" : "profit-down"}">${profit >= 0 ? "+" : ""}${money(profit)}</strong></div>
        <div><span>Your rank</span><strong>${rank ? `#${rank.rank}` : "…"}</strong><em>${rank ? `of ${rank.total} team${rank.total === 1 ? "" : "s"}` : ""}</em></div>
      </div>
      <p class="result-notes">You invested ${money(latest.budget)}${latest.bonus ? `, including the ${money(latest.bonus)} bonus` : ""}.${latest.payout < 0 ? " Balances can't go below ₹0, so you now have ₹0." : ""}</p>
    </div>
    ${companyValueChart("Your company's value")}
    <div class="next-round-desk">${next}</div>
    <h3 class="table-title">Where your money went</h3>
    ${resultTable(latest)}
  </section>
  ${older ? `<h3 class="table-title">Earlier rounds</h3>${older}` : ""}`;
}

/* ── 5. Leaderboard ── */
function renderLeaderboard() {
  const rows = ui.leaderboard;
  const body = !rows ? `<tr><td colspan="5" class="empty-cell">Loading rankings…</td></tr>`
    : !rows.length ? `<tr><td colspan="5" class="empty-cell">No teams yet.</td></tr>`
    : rows.map((row, index) => {
      const me = team && row.teamId.toLowerCase() === team.teamId.toLowerCase();
      const badge = index < 3 ? `<span class="medal medal-${index + 1}">${["1st", "2nd", "3rd"][index]}</span>` : `<b>#${index + 1}</b>`;
      return `<tr class="${me ? "me" : ""}"><td class="rank-cell">${badge}</td><td><b>${esc(row.teamId)}</b>${me ? ' <span class="you">You</span>' : ""}</td><td>${esc(row.industry || "-")}</td><td>${row.isEliminated ? "Out" : `Round ${row.round}`}</td><td class="balance">${money(row.companyValue)}</td></tr>`;
    }).join("");
  const leader = rows?.[0];
  const rank = myRank();
  const story = leader ? `<article class="news-story lead-story">
    <span class="article-label">Live standings</span>
    <h2 class="story-headline">${esc(leader.teamId)} leads the field with ${money(leader.companyValue)}</h2>
    <p class="lede">There ${rows.length === 1 ? "is one team" : `are ${rows.length} teams`} in the game so far.${rank ? rank.rank === 1 ? " Your team is on top. Keep it there." : ` Your team is #${rank.rank}, ${money(Math.max(0, leader.companyValue - team.companyValue))} behind the leader.` : ""}</p>
  </article>` : "";
  return `${pageHeading("TechTatva '26", "Leaderboard")}
  ${story}
  <div class="leaderboard-box">
    <div class="table-scroll"><table><thead><tr><th>Rank</th><th>Team</th><th>Industry</th><th>Progress</th><th class="align-right">Money</th></tr></thead><tbody>${body}</tbody></table></div>
  </div>
  <div class="leaderboard-actions">
    <button type="button" class="ghost" data-action="refresh-leaderboard">Refresh</button>
    <small data-leaderboard-age>Updates automatically</small>
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
    const pretty = document.querySelector(`[data-pretty="${index}"]`);
    if (pretty) pretty.textContent = raw !== "" && Number.isFinite(value) ? money(value) : "₹0";
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
      ? `✓ Ready to submit. All ${money(total)} is invested.`
      : !allValid
        ? `Every area needs a whole amount of at least ${money(team.minAllocation)}.`
        : left > 0 ? `${money(left)} still to invest.` : `That's ${money(-left)} too much. Take some away.`;
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
  $("#flashTitle").textContent = `News flash · Round ${round} of ${team.rounds}`;
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
  const running = left > 0;
  const timer = $("#flashTimer");
  timer.textContent = team.flashCompleted ? "Already read" : timerOn ? formatDuration(left) : "No timer";
  timer.classList.toggle("timer-off", !timerOn || team.flashCompleted);
  $("#flashHint").textContent = team.flashCompleted ? "You've read this one" : timerOn ? "Time left" : "Read at your own pace";
  $("#flashTimerNotice").textContent = team.flashCompleted
    ? "You've already finished this flash. Close it when you're ready."
    : timerOn
      ? running ? `Closes for good when the timer ends, or when you press Done reading. It cannot be opened again.` : "Time's up. Taking you back to the round…"
      : "Once you close the flash, it cannot be opened again.";
  const close = $("#flashClose");
  close.hidden = false;
  close.disabled = flashClosing;
  close.textContent = team.flashCompleted ? "Close" : "Done reading (closes for good)";
  if (!running && timerOn && !team.flashCompleted && !flashClosing && team.activeFlash && Date.now() >= flashRetryAt) closeFlash(true);
}

async function closeFlash(automatic = false) {
  if (flashClosing) return;
  if (!automatic && !team.flashCompleted) {
    const timeLeft = team.settings.flashTimer.enabled && flashRemaining() > 0 ? ` You still have <b>${formatDuration(flashRemaining())}</b> on the timer.` : "";
    const ok = await confirmAction("Finished reading?", `The flash closes for good. Your team cannot open it again.${timeLeft}`, "Close the flash");
    if (!ok) return;
  }
  flashClosing = true;
  try {
    applyState(await api("/team/flash/close", { method: "POST" }));
    if (!automatic || team.flashCompleted) toast("Flash closed. You can download the data now.", "good");
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

function confirmAction(title, body, okLabel = "Confirm") {
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
  await busy(button, "Downloading…", async () => {
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
    toast("Data downloaded. You can invest now.", "good");
    await poll();
  });
}

async function submitRound(button) {
  const values = collectAllocation();
  const allocations = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Number(value)]));
  const ok = await confirmAction(`Submit Round ${team.round}?`, `You're investing <b>${money(team.budget)}</b>. You can't change it after you submit.`, "Submit");
  if (!ok) return;
  await busy(button, "Submitting…", async () => {
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
  const ok = await confirmAction(`Lock in ${industry}?`, `Your team will play all four rounds in <b>${esc(industry)}</b>. You can't change this later.`, `Lock in ${industry}`);
  if (!ok) return;
  await busy(button, "Saving…", async () => {
    applyState(await api("/team/industry", { method: "POST", body: { industry } }));
    ui.view = "round";
    render();
    toast(team.roundOpen ? `${industry} is locked in. Round ${team.round} is ready.` : `${industry} is locked in. Round ${team.round} starts when the organizers open it.`, "good");
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
    const ok = await confirmAction("Sign out?", "You can sign back in any time with your team name and PIN.", "Sign out");
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
    return busy(button, "Opening…", async () => applyState(await api("/team/flash/open", { method: "POST" })));
  }
  if (action === "close-flash") return closeFlash(false);
  if (action === "download-dataset") return downloadDataset(button);
  if (action === "submit-round") return submitRound(button);
  if (action === "advance") {
    return busy(button, "Opening…", async () => {
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
  if (action === "split-evenly") {
    const inputs = [...document.querySelectorAll("input[data-param]")];
    if (!inputs.length || inputs[0].disabled) return;
    const each = Math.floor(team.budget / inputs.length / 1000) * 1000;
    inputs.forEach((input, index) => { input.value = String(index === 0 ? team.budget - each * (inputs.length - 1) : each); });
    updateAllocation();
    saveDraft();
    return;
  }
  if (action === "clear-allocation") {
    document.querySelectorAll("input[data-param]").forEach(input => { input.value = ""; });
    try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
    updateAllocation();
    return;
  }
  if (action === "refresh-leaderboard") return busy(button, "Refreshing…", () => refreshLeaderboard(true));
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
  button.textContent = "Signing in…";
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
    button.textContent = "Sign in";
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
  const scheduled = scheduleRemaining();
  document.querySelectorAll('[data-countdown="schedule"]').forEach(el => { el.textContent = formatDuration(scheduled); });
  if (team.scheduledRound && scheduled === 0 && !polling && Date.now() - receivedAt > 1500) poll();
  if (flashVisible) updateFlashControls();
  const age = document.querySelector("[data-leaderboard-age]");
  if (age && ui.leaderboardAt) {
    const seconds = Math.round((Date.now() - ui.leaderboardAt) / 1000);
    age.textContent = seconds < 5 ? "Updated just now" : `Updated ${seconds} s ago`;
  }
}

setInterval(tick, 1000);
setInterval(() => {
  if (team && !document.hidden) refreshLeaderboard();
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
