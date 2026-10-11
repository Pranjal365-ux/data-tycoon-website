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
const ui = { view: session ? "loading" : "login", loginError: "", leaderboard: null, leaderboardAt: 0, waitOpen: false };

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
  const el = $("#connection");
  if (!el) return;
  el.classList.toggle("offline", !ok);
  $("#connectionText").textContent = ok ? "Live" : "Reconnecting…";
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
  $("#teamChip").hidden = !signedIn;
  $("#connection").hidden = !session;
  if (signedIn) $("#teamChip").textContent = team.industry ? `${team.teamId} · ${team.industry}` : team.teamId;
  const steps = $("#steps");
  steps.hidden = !signedIn;
  steps.innerHTML = signedIn ? renderSteps() : "";
  const currentStep = steps.querySelector(".step.current");
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

function renderLoading() {
  return `<section class="card center"><p class="loading">Reconnecting to your team…</p></section>`;
}

function stepButton({ view, number, title, detail, state, disabledReason }) {
  const current = ui.view === view;
  const disabled = Boolean(disabledReason);
  return `<button type="button" class="step ${state} ${current ? "current" : ""}" data-action="nav" data-view="${view}" ${disabled ? `disabled title="${esc(disabledReason)}"` : ""} ${current ? 'aria-current="page"' : ""}>
    <span class="step-number" aria-hidden="true">${state === "done" ? "✓" : disabled ? "🔒" : number}</span>
    <span class="step-text"><strong>${esc(title)}</strong><small>${esc(disabled ? disabledReason : detail)}</small></span>
  </button>`;
}

function renderSteps() {
  const s = stage();
  const roundDetail = {
    flash: "Read the flash", dataset: "Download the dataset", invest: "Invest your budget",
    waiting: "Submitted", "next-open": "Submitted", finished: "All rounds done"
  }[s] || "";
  const latest = team.history.at(-1);
  return `<div class="steps-inner">
    ${stepButton({ view: "industry", number: 1, title: "Industry", detail: team.industry ? `${team.industry} (locked)` : "Choose your sector", state: team.industry ? "done" : "todo" })}
    ${stepButton({ view: "round", number: 2, title: `Round ${team.round} of ${team.rounds}`, detail: roundDetail, state: team.finished ? "done" : team.industry ? "todo" : "locked", disabledReason: team.industry ? "" : "Choose an industry first" })}
    ${stepButton({ view: "results", number: 3, title: "Results", detail: latest ? `Round ${latest.round}: ${money(latest.payout)}` : "", state: latest ? "todo" : "locked", disabledReason: latest ? "" : "Submit a round to see results" })}
    ${stepButton({ view: "leaderboard", number: 4, title: "Leaderboard", detail: "Live rankings", state: "todo" })}
  </div>`;
}

function renderNextStep() {
  const s = stage();
  const r = team.round;
  const items = {
    industry: ["Choose your industry", "Pick one of the five industries below and confirm it. It stays locked for all four rounds.", ui.view === "industry" ? null : ["Choose industry", "nav", "industry"]],
    flash: [`Open the Round ${r} flash`, "Read the news flash for this round. The dataset unlocks when you finish reading.", ["Open flash", "open-flash"]],
    dataset: [`Download the Round ${r} dataset`, "Use it to decide where to invest.", ["Download dataset", "download-dataset"]],
    invest: [`Invest ${money(team.budget)} and submit`, `Split the full budget across the ten parameters (at least ${money(team.minAllocation)} each), then submit.`, ui.view === "round" ? ["Go to the table", "scroll-to-allocation"] : ["Go to Round " + r, "nav", "round"]],
    waiting: [`Round ${r} submitted`, `Round ${r + 1} opens in <b data-countdown="wait">${formatDuration(waitRemaining())}</b>.`, ui.view === "results" ? null : ["View results", "nav", "results"]],
    "next-open": [`Round ${r + 1} is open`, "Start the next round when your team is ready.", ["Start Round " + (r + 1), "advance"]],
    finished: [team.isEliminated ? "Your team is out of the game" : "You've finished all four rounds", "See where your team placed.", ui.view === "leaderboard" ? null : ["View leaderboard", "nav", "leaderboard"]]
  }[s];
  if (!items) return "";
  const [title, body, action] = items;
  const button = action ? `<button type="button" class="button button-primary" data-action="${action[1]}" ${action[2] ? `data-view="${action[2]}"` : ""}>${esc(action[0])}</button>` : "";
  return `<section class="next-step" aria-live="polite"><div><span class="next-label">Next step</span><h2>${esc(title)}</h2><p>${body}</p></div>${button}</section>`;
}

function renderLogin() {
  return `<section class="login">
    <div class="login-intro">
      <p class="eyebrow">TechTatva '26 · Business simulation</p>
      <h1>Data Tycoon</h1>
      <p class="lead">Read the market news, analyse the data, and invest your company's budget across four rounds. The team with the highest balance wins.</p>
      <ul class="rules">
        <li><b>Pick one industry</b> for all four rounds (20 teams per industry).</li>
        <li><b>Start with ₹10,00,000.</b> Your balance carries forward, plus a ₹2,50,000 bonus before Rounds 2 and 3.</li>
        <li><b>Each round:</b> read the flash, download the dataset, then invest the full budget across ten parameters (minimum ₹1,000 each).</li>
        <li><b>While a flash is open</b>, screenshots and leaving the tab are reported to the organizers.</li>
      </ul>
    </div>
    <form class="card login-card" id="loginForm" autocomplete="on">
      <h2>Sign in</h2>
      <label for="teamId">Team name</label>
      <input class="input" id="teamId" name="teamId" required minlength="2" maxlength="40" autocomplete="username" placeholder="e.g. Team Alpha" value="${esc(session?.teamId || "")}">
      <label for="pin">Team PIN</label>
      <input class="input" id="pin" name="pin" type="password" required minlength="4" maxlength="64" autocomplete="current-password" placeholder="4 or more characters">
      <p class="hint">New team? Your first sign-in creates the team and sets this PIN. Teammates sign in with the same name and PIN.</p>
      ${ui.loginError ? `<p class="form-error" role="alert">${esc(ui.loginError)}</p>` : ""}
      <button class="button button-primary button-block" type="submit">Enter the game</button>
    </form>
  </section>`;
}

function renderIndustry() {
  if (team.industry) {
    return `<section class="card center">
      <p class="eyebrow">Industry locked</p>
      <h1>${esc(team.industry)}</h1>
      <p>Your team plays all four rounds in ${esc(team.industry)}.</p>
      <button type="button" class="button button-primary" data-action="nav" data-view="round">Go to Round ${team.round}</button>
    </section>`;
  }
  const capacity = team.industryCapacity || [];
  return `<section class="section-head"><p class="eyebrow">Step 1</p><h1>Choose your industry</h1><p class="lead">This choice is locked for all four rounds. Each industry takes up to 20 teams.</p></section>
  <div class="industry-grid">
    ${capacity.map(item => {
      const full = item.remaining <= 0;
      const used = Math.min(100, Math.round((item.assigned / item.capacity) * 100));
      return `<article class="card industry ${full ? "full" : ""}">
        <h2>${esc(item.industry)}</h2>
        <p>${esc(item.description)}</p>
        <div class="seats"><div class="seat-bar"><span style="width:${used}%"></span></div><small>${full ? "Full" : `${item.remaining} of ${item.capacity} seats left`}</small></div>
        <button type="button" class="button ${full ? "" : "button-primary"} button-block" data-action="choose-industry" data-industry="${esc(item.industry)}" ${full ? "disabled" : ""}>${full ? "No seats left" : `Choose ${esc(item.industry)}`}</button>
      </article>`;
    }).join("")}
  </div>`;
}

function taskState(done, current) {
  return done ? "done" : current ? "current" : "locked";
}

function renderRound() {
  const s = stage();
  const rank = myRank();
  const flashDone = team.flashCompleted;
  const dataDone = team.datasetDownloaded;
  const canInvest = flashDone && dataDone && !team.submitted && !team.finished;
  const previous = team.budget - team.bonus;
  const budgetNote = team.bonus
    ? `Your balance ${money(previous)} plus the Round ${team.round} bonus of ${money(team.bonus)}.`
    : team.round === 1 ? "Every team starts with the same budget." : "Carried forward from your last round.";
  return `<section class="round-head">
    <div><p class="eyebrow">${esc(team.industry)} · Round ${team.round} of ${team.rounds}</p><h1>Round ${team.round}</h1></div>
    <dl class="stats">
      <div><dt>Budget to invest</dt><dd>${money(team.budget)}</dd></div>
      <div><dt>Leaderboard rank</dt><dd>${rank ? `#${rank.rank} <small>of ${rank.total}</small>` : "…"}</dd></div>
    </dl>
  </section>
  <p class="budget-note">${esc(budgetNote)}</p>
  ${team.finished ? `<section class="card center"><h2>${team.isEliminated ? "Your team is out of the game" : "All rounds complete"}</h2><button type="button" class="button button-primary" data-action="nav" data-view="leaderboard">View leaderboard</button></section>` : `
  <ol class="tasks">
    <li class="task ${taskState(flashDone, s === "flash")}">
      <span class="task-number">${flashDone ? "✓" : "1"}</span>
      <div><h3>Read the flash</h3><p>${team.settings.flashTimer.enabled ? "The flash stays open for five minutes." : "Close it when your team has read it."} Screenshots and tab switches are reported.</p></div>
      <button type="button" class="button ${flashDone ? "" : "button-primary"}" data-action="open-flash" ${team.submitted ? "disabled" : ""}>${flashDone ? "Read again" : "Open flash"}</button>
    </li>
    <li class="task ${taskState(dataDone, s === "dataset")}">
      <span class="task-number">${dataDone ? "✓" : "2"}</span>
      <div><h3>Download the dataset</h3><p>${flashDone ? `${esc(team.datasetName.split(".").pop().toUpperCase())} file for ${esc(team.industry)}, Round ${team.round}.` : "Unlocks after you finish the flash."}</p></div>
      <button type="button" class="button ${flashDone && !dataDone ? "button-primary" : ""}" data-action="download-dataset" ${flashDone ? "" : "disabled"}>${dataDone ? "Download again" : "Download"}</button>
    </li>
    <li class="task ${taskState(team.submitted, s === "invest")}">
      <span class="task-number">${team.submitted ? "✓" : "3"}</span>
      <div><h3>Invest and submit</h3><p>${team.submitted ? "Submitted. See your results." : canInvest ? "Fill in the table below." : "Unlocks after steps 1 and 2."}</p></div>
      ${team.submitted ? `<button type="button" class="button" data-action="nav" data-view="results">View results</button>` : ""}
    </li>
  </ol>
  ${team.submitted ? "" : team.budget < team.minAllocation * team.parameters.length
    ? `<section class="card center"><h2>Your budget is too small to invest this round</h2><p>Every parameter needs at least ${money(team.minAllocation)}, so a round needs ${money(team.minAllocation * team.parameters.length)}. Please speak to an organizer.</p></section>`
    : renderAllocation(canInvest)}`}`;
}

function renderAllocation(enabled) {
  const rows = team.parameters.map((name, index) => `<tr>
      <th scope="row"><span class="param">${esc(name)}</span><small>${index < 5 ? "Common" : `${esc(team.industry)} specific`}</small></th>
      <td class="amount"><label class="money-input"><span aria-hidden="true">₹</span><input type="number" inputmode="numeric" min="${team.minAllocation}" step="1" data-param="${esc(name)}" aria-label="Amount for ${esc(name)}" ${enabled ? "" : "disabled"} placeholder="Min ${team.minAllocation}"></label></td>
      <td class="share" data-share="${index}">0%</td>
    </tr>`).join("");
  return `<section class="card allocation" id="allocation">
    <div class="card-head"><div><h2>Investment table</h2><p>Invest exactly <b>${money(team.budget)}</b>. Every parameter needs at least ${money(team.minAllocation)}. Very heavy bets on one parameter can backfire.</p></div>
      <button type="button" class="button button-quiet" data-action="clear-allocation" ${enabled ? "" : "disabled"}>Clear</button></div>
    <div class="table-wrap"><table class="alloc-table">
      <thead><tr><th>Parameter</th><th class="amount">Amount</th><th class="share">Share</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="alloc-summary">
      <div><span>Invested</span><b id="allocTotal">₹0</b></div>
      <div><span>Left to invest</span><b id="allocRemaining">${money(team.budget)}</b></div>
    </div>
    <p id="allocMessage" class="alloc-message">${enabled ? "" : "Finish steps 1 and 2 to unlock the table."}</p>
    <button type="button" id="submitRound" class="button button-primary button-block button-large" data-action="submit-round" disabled>Submit Round ${team.round}</button>
  </section>`;
}

function valueChart() {
  const points = [{ label: "Start", value: 1_000_000 }, ...team.history.map(item => ({ label: `R${item.round}`, value: item.payout }))];
  const w = 640, h = 180, left = 16, right = 16, top = 22, bottom = 30;
  const values = points.map(p => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * 0.15, max * 0.02, 1);
  const lo = Math.max(0, min - padding), hi = max + padding;
  const x = i => left + i * (w - left - right) / Math.max(points.length - 1, 1);
  const y = v => h - bottom - (v - lo) / (hi - lo) * (h - top - bottom);
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  return `<svg class="value-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Balance after each round">
    <polygon class="chart-area" points="${x(0)},${h - bottom} ${line} ${x(points.length - 1)},${h - bottom}"/>
    <polyline class="chart-line" points="${line}"/>
    ${points.map((p, i) => `<circle class="chart-dot" cx="${x(i)}" cy="${y(p.value)}" r="4"/><text class="chart-label" x="${x(i)}" y="${h - 10}" text-anchor="middle">${p.label}</text><text class="chart-value" x="${x(i)}" y="${y(p.value) - 9}" text-anchor="middle">${(p.value / 100000).toFixed(1)}L</text>`).join("")}
  </svg>`;
}

function resultTable(result) {
  const rows = Object.entries(result.allocations || {}).map(([name, amount]) => {
    const returned = Number(result.returns?.[name] || 0);
    return `<tr><th scope="row">${esc(name)}</th><td>${money(amount)}</td><td>${((Number(amount) / (result.budget || 1)) * 100).toFixed(1)}%</td><td class="${returned >= amount ? "good" : "bad"}">${money(returned)}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table class="result-table"><thead><tr><th>Parameter</th><th>Invested</th><th>Share</th><th>Returned</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderResults() {
  const latest = team.history.at(-1);
  if (!latest) return `<section class="card center"><h2>No results yet</h2><p>Submit Round 1 to see how your investments did.</p></section>`;
  const s = stage();
  const profit = latest.netProfit;
  let next = "";
  if (s === "finished") {
    next = `<section class="card center next-round"><h2>${team.isEliminated ? "Your team is out of the game" : "Game complete"}</h2><p>Final balance: <b>${money(team.companyValue)}</b></p><button type="button" class="button button-primary" data-action="nav" data-view="leaderboard">View final leaderboard</button></section>`;
  } else if (s === "waiting") {
    next = `<section class="card center next-round"><p class="eyebrow">Next round</p><h2>Round ${team.round + 1} opens in <span data-countdown="wait">${formatDuration(waitRemaining())}</span></h2><p>Stay on this page. The button unlocks automatically.</p><button type="button" class="button button-primary button-large" disabled>Start Round ${team.round + 1}</button></section>`;
  } else if (s === "next-open") {
    next = `<section class="card center next-round"><p class="eyebrow">Next round</p><h2>Round ${team.round + 1} is open</h2><button type="button" class="button button-primary button-large" data-action="advance">Start Round ${team.round + 1}</button></section>`;
  }
  const older = team.history.slice(0, -1).reverse().map(item => `<details class="card past-round"><summary>Round ${item.round}: ${money(item.payout)} <span class="${item.netProfit >= 0 ? "good" : "bad"}">${item.netProfit >= 0 ? "+" : ""}${money(item.netProfit)}</span></summary>${resultTable(item)}</details>`).join("");
  return `<section class="section-head"><p class="eyebrow">${esc(team.industry)}</p><h1>Round ${latest.round} results</h1></section>
  ${next}
  <section class="card result-card">
    <div class="result-numbers">
      <div><span>Round payout</span><b class="${latest.payout < 0 ? "bad" : ""}">${money(latest.payout)}</b></div>
      <div><span>Profit this round</span><b class="${profit >= 0 ? "good" : "bad"}">${profit >= 0 ? "+" : ""}${money(profit)}</b></div>
      <div><span>Budget invested</span><b>${money(latest.budget)}</b></div>
    </div>
    ${latest.payout < 0 ? `<p class="muted">Balances cannot go below ₹0, so your balance is now ₹0.</p>` : ""}
    ${latest.bonus ? `<p class="muted">Includes the ${money(latest.bonus)} round bonus in the budget.</p>` : ""}
    ${latest.eliminated ? `<p class="form-error">More than 80% of the budget went into a parameter with no return, so the payout is zero and the team is out of the game.</p>` : ""}
    <h3>Balance over time</h3>
    ${valueChart()}
    <h3>Where the money went</h3>
    ${resultTable(latest)}
  </section>
  ${older}`;
}

function renderLeaderboard() {
  const rows = ui.leaderboard;
  const body = !rows ? `<tr><td colspan="5" class="center muted">Loading rankings…</td></tr>`
    : !rows.length ? `<tr><td colspan="5" class="center muted">No teams yet.</td></tr>`
    : rows.map((row, index) => {
      const me = team && row.teamId.toLowerCase() === team.teamId.toLowerCase();
      const medal = ["🥇", "🥈", "🥉"][index] || "";
      return `<tr class="${me ? "me" : ""}"><td class="rank">${medal} ${index + 1}</td><td><b>${esc(row.teamId)}</b>${me ? ' <span class="you">You</span>' : ""}</td><td>${esc(row.industry || "Not chosen")}</td><td>${row.isEliminated ? "Out" : `Round ${row.round}`}</td><td class="num">${money(row.companyValue)}</td></tr>`;
    }).join("");
  return `<section class="section-head row"><div><p class="eyebrow">Live</p><h1>Leaderboard</h1><p class="muted" data-leaderboard-age>Updated ${ui.leaderboardAt ? "just now" : "…"}</p></div>
    <button type="button" class="button" data-action="refresh-leaderboard">Refresh</button></section>
  <section class="card"><div class="table-wrap"><table class="leaderboard"><thead><tr><th>Rank</th><th>Team</th><th>Industry</th><th>Progress</th><th class="num">Balance</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

/* ── Allocation table ──────────────────────────────────────── */
function draftKey() {
  return team ? `dt-draft-${team.teamId.toLowerCase()}-${team.round}-${team.budget}` : "";
}

function readDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || "{}"); } catch { return {}; }
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

function updateAllocation() {
  const inputs = [...document.querySelectorAll("input[data-param]")];
  if (!inputs.length || !team) return;
  let total = 0;
  let allValid = true;
  inputs.forEach((input, index) => {
    const raw = input.value.trim();
    const value = Number(raw);
    const valid = raw !== "" && Number.isInteger(value) && value >= team.minAllocation;
    if (raw !== "" && Number.isFinite(value)) total += value;
    allValid = allValid && valid;
    input.classList.toggle("invalid", raw !== "" && !valid);
    const share = document.querySelector(`[data-share="${index}"]`);
    if (share) share.textContent = `${Number.isFinite(value) && raw !== "" && team.budget > 0 ? ((value / team.budget) * 100).toFixed(1) : "0"}%`;
  });
  const left = team.budget - total;
  $("#allocTotal").textContent = money(total);
  const remainingEl = $("#allocRemaining");
  remainingEl.textContent = money(left);
  remainingEl.className = left === 0 ? "good" : left < 0 ? "bad" : "";
  const enabled = !inputs[0].disabled;
  const message = $("#allocMessage");
  const ready = enabled && allValid && left === 0;
  if (enabled) {
    message.textContent = ready ? "Ready to submit." : !allValid
      ? `Every parameter needs a whole amount of at least ${money(team.minAllocation)}.`
      : left > 0 ? `${money(left)} still to invest.` : `You are ${money(-left)} over budget.`;
    message.className = `alloc-message ${ready ? "good" : ""}`;
  }
  $("#submitRound").disabled = !ready;
}

document.addEventListener("input", event => {
  if (!event.target.matches("input[data-param]")) return;
  updateAllocation();
  try { localStorage.setItem(draftKey(), JSON.stringify(collectAllocation())); } catch { /* ignore */ }
});

/* ── Flash overlay ─────────────────────────────────────────── */
function syncFlash() {
  if (team?.activeFlash && !flashVisible) openFlashOverlay();
  else if (!team?.activeFlash && flashVisible) closeFlashOverlay();
  if (flashVisible) updateFlashControls();
}

function openFlashOverlay() {
  flashVisible = true;
  const round = team.activeFlash.round;
  $("#flashTitle").textContent = `Flash ${round} of ${team.rounds}`;
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
  $("#flashClose").focus();
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
  const left = flashRemaining();
  const locked = left > 0;
  const timer = $("#flashTimer");
  timer.textContent = locked ? `Locked · ${formatDuration(left)}` : team.settings.flashTimer.enabled && !team.flashCompleted ? "Time's up" : "";
  timer.hidden = !timer.textContent;
  const close = $("#flashClose");
  close.disabled = locked || flashClosing;
  close.textContent = team.flashCompleted ? "Close" : locked ? "Reading time…" : "Done reading";
  $("#flashHint").textContent = team.flashCompleted
    ? "You have already finished this flash."
    : locked ? "The flash closes automatically when the timer ends." : "Close the flash when your team has finished reading.";
  if (!locked && team.settings.flashTimer.enabled && !team.flashCompleted && !flashClosing && team.activeFlash && Date.now() >= flashRetryAt) closeFlash(true);
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
    toast("Dataset downloaded. The investment table is unlocked.", "good");
    await poll();
  });
}

async function submitRound(button) {
  const values = collectAllocation();
  const allocations = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Number(value)]));
  const ok = await confirmAction(`Submit Round ${team.round}?`, `You are investing <b>${money(team.budget)}</b>. You cannot change your investments after submitting.`, "Submit");
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
  const ok = await confirmAction(`Choose ${industry}?`, `Your team will play all four rounds in <b>${esc(industry)}</b>. This cannot be changed later.`, `Lock in ${industry}`);
  if (!ok) return;
  await busy(button, "Reserving…", async () => {
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
  if (action === "choose-industry") return chooseIndustry(button, button.dataset.industry);
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
    button.textContent = "Enter the game";
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
