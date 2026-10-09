import { industries } from "./data/industries.js";
import { datasetFor, parametersByIndustry, payoutMultipliers } from "./data/round-rules.js";
import { EVENT_DURATION_MS, events } from "./data/events.js";
import { getLeaderboard, getTeamRank, replaceLeaderboard, updateTeamInLeaderboard } from "./data/leaderboard.js";

/* ── Keys & State Defaults ───────────────────────────────── */
const STATE_KEY = "data-tycoon-game-v5";
const EVENT_KEY_PREFIX = "data-tycoon-active-event-v6";
const BASE_ROUND_BUDGET = 1_000_000;
const ROUND_BONUS = 250_000;

function roundBonusFor(round = state?.round ?? 1) {
  return [2, 3].includes(Number(round)) ? ROUND_BONUS : 0;
}

function roundBudget(round = state?.round ?? 1) {
  const carryover = state?.companyValue ?? BASE_ROUND_BUDGET;
  return Math.max(0, Math.floor(Number(carryover) || 0)) + roundBonusFor(round);
}

const defaults = {
  page: "login",
  teamId: "",
  industry: null,
  pendingIndustry: null,
  round: 1,
  scoringVersion: 2,
  companyValue: BASE_ROUND_BUDGET,
  moneyRevision: 0,
  // Direct rupee amounts invested across the selected industry parameters
  allocations: {},
  allocationRound: 1,
  allocationBudget: 0,
  allocationSetupVersion: 2,
  history: [],
  flashCompletedRounds: {},
  datasetDownloadedRounds: {},
  offlineBonusClaimed: { round3: false, round4: false },
  round2GrantApplied: false
};

let state = loadState();
let timer = null;
let renderedEventId = null;
let allocationSaveTimer = null;
let teamSyncTimer = null;
let remoteMoneyPollBusy = false;
let lastBlurActivityAt = 0;
let teamLoginNotice = "";

/* ── Persistence ─────────────────────────────────────────── */
function loadState() {
  return readState(STATE_KEY);
}

function teamSlug(teamId) {
  return String(teamId || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "anonymous";
}

function teamStateKey(teamId) {
  return `data-tycoon-team-${teamSlug(teamId)}`;
}

function eventStorageKey(teamId = state.teamId) {
  return `${EVENT_KEY_PREFIX}-${teamSlug(teamId)}`;
}

function savedActiveFlash(teamId = state.teamId) {
  try {
    const saved = JSON.parse(localStorage.getItem(eventStorageKey(teamId)) || "null");
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null;
  }
}

function readState(key) {
  try {
    const loaded = JSON.parse(localStorage.getItem(key) || "{}");
    if (!Object.keys(loaded).length) return structuredClone(defaults);
    if (loaded.scoringVersion !== 2) return { ...structuredClone(defaults), teamId: loaded.teamId || "", page: loaded.teamId ? "industries" : "login" };
    return {
      ...defaults,
      ...loaded,
      allocationSetupVersion: loaded.allocationSetupVersion ?? 0,
      allocations: { ...defaults.allocations, ...(loaded.allocations || {}) },
      flashCompletedRounds: { ...defaults.flashCompletedRounds, ...(loaded.flashCompletedRounds || {}) },
      datasetDownloadedRounds: { ...defaults.datasetDownloadedRounds, ...(loaded.datasetDownloadedRounds || {}) },
      offlineBonusClaimed: { ...defaults.offlineBonusClaimed, ...(loaded.offlineBonusClaimed || {}) }
    };
  } catch {
    return structuredClone(defaults);
  }
}

function apiBase() {
  const host = location.hostname.toLowerCase();
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const vercelDev = localHost && location.port === "3000";
  const fallback = localHost && !vercelDev ? "http://127.0.0.1:8000/api" : `${location.origin}/api`;
  return String(window.DATA_TYCOON_API_BASE || fallback).replace(/\/$/, "");
}

function usesLegacyLocalApi() {
  const host = location.hostname.toLowerCase();
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  return location.protocol === "file:" || (localHost && location.port !== "3000");
}

function teamTokenKey(teamId = state.teamId) {
  const normalized = String(teamId || "").trim().replace(/\s+/g, " ").slice(0, 80).toLowerCase();
  return `data-tycoon-team-token-${normalized}`;
}

function teamAuthHeaders(teamId = state.teamId) {
  const token = localStorage.getItem(teamTokenKey(teamId));
  return token ? { Authorization: `Team ${token}` } : {};
}

function hasTeamSession(teamId = state.teamId) {
  return usesLegacyLocalApi() || Boolean(localStorage.getItem(teamTokenKey(teamId)));
}

function expireTeamSession() {
  if (!state.teamId || usesLegacyLocalApi()) return;
  localStorage.removeItem(teamTokenKey());
  teamLoginNotice = "Your team session expired. Enter the team PIN to reconnect and continue.";
  state.page = "login";
  persistState({ sync: false });
  render();
}

function scheduleTeamSync() {
  if (!state.teamId || !hasTeamSession()) return;
  clearTimeout(teamSyncTimer);
  teamSyncTimer = setTimeout(() => {
    teamSyncTimer = null;
    const snapshot = {
      teamId: state.teamId,
      industry: state.industry,
      round: state.round,
      companyValue: state.companyValue,
      moneyRevision: state.moneyRevision || 0,
      allocations: state.allocations,
      history: state.history,
      pendingIndustry: state.pendingIndustry,
      allocationRound: state.allocationRound,
      allocationBudget: state.allocationBudget,
      allocationSetupVersion: state.allocationSetupVersion,
      flashCompletedRounds: state.flashCompletedRounds,
      datasetDownloadedRounds: state.datasetDownloadedRounds,
      offlineBonusClaimed: state.offlineBonusClaimed,
      round2GrantApplied: state.round2GrantApplied,
      activeFlash: savedActiveFlash(),
      page: state.page,
      isEliminated: state.isEliminated
    };
    fetch(`${apiBase()}/team/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...teamAuthHeaders() },
      body: JSON.stringify(snapshot),
      keepalive: true
    }).then(response => {
      if (response.status === 401) {
        expireTeamSession();
        throw new Error("Team session expired; sign in with the team PIN again.");
      }
      if (!response.ok) throw new Error(`Team sync failed (${response.status})`);
    }).catch(error => {
      console.warn("Data Tycoon could not sync this team to the organizer server; retrying.", error);
      if (state.teamId) teamSyncTimer = setTimeout(scheduleTeamSync, 5000);
    });
  }, 180);
}

function persistState({ sync = true } = {}) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  if (state.teamId) localStorage.setItem(teamStateKey(state.teamId), JSON.stringify(state));
  if (sync) scheduleTeamSync();
}

function save() {
  persistState();
  if (state.teamId && state.industry) {
    updateTeamInLeaderboard({
      teamId: state.teamId,
      industry: state.industry,
      round: state.round,
      companyValue: state.companyValue,
      history: state.history
    });
  }
}

/* ── Formatting & Helper Utilities ────────────────────────── */
const page = document.querySelector("#page");
const overlay = document.querySelector("#newsOverlay");
const money = v => `₹${Math.round(Number(v) || 0).toLocaleString("en-IN")}`;
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const investmentRuleText = () => `Invest exactly ${money(roundBudget())} in total. Each parameter must receive at least ₹1,000.`;

function roundParameters() {
  return parametersByIndustry[state.industry] || parametersByIndustry.Food;
}

function datasetRoundKey() {
  return `${state.industry || "Food"}-${state.round}`;
}

function ensureRoundAllocations() {
  const parameters = roundParameters();
  const budget = roundBudget();
  if (!state.allocations || state.allocationRound !== state.round || state.allocationBudget !== budget || state.allocationSetupVersion !== 2 || parameters.some(name => !Object.hasOwn(state.allocations, name))) {
    state.allocations = Object.fromEntries(parameters.map(name => [name, 0]));
    state.allocationRound = state.round;
    state.allocationBudget = budget;
    state.allocationSetupVersion = 2;
    save();
  }
}

function scheduleAllocationSave() {
  clearTimeout(allocationSaveTimer);
  allocationSaveTimer = setTimeout(() => {
    allocationSaveTimer = null;
    persistState();
  }, 250);
}

function trackActivity(kind, detail) {
  if (!state.teamId || !hasTeamSession()) return;
  fetch(`${apiBase()}/team/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...teamAuthHeaders() },
    body: JSON.stringify({ teamId: state.teamId, kind, detail }),
    keepalive: true
  }).catch(() => {});
}

async function syncOrganizerMoney() {
  if (!state.teamId || !hasTeamSession() || remoteMoneyPollBusy) return;
  remoteMoneyPollBusy = true;
  try {
    const response = await fetch(`${apiBase()}/team/${encodeURIComponent(state.teamId)}`, {
      cache: "no-store",
      headers: teamAuthHeaders()
    });
    if (response.status === 401) { expireTeamSession(); return; }
    if (!response.ok) return;
    const remote = await response.json();
    if (Number(remote.moneyRevision || 0) <= Number(state.moneyRevision || 0)) return;
    state.moneyRevision = Number(remote.moneyRevision);
    state.companyValue = Number(remote.companyValue) || 0;
    persistState({ sync: false });
    updateTeamInLeaderboard({ teamId: state.teamId, industry: state.industry, round: state.round, companyValue: state.companyValue, history: state.history });
    if (state.page === "game") render();
    trackActivity("organizer-balance-applied", `Organizer updated the team's balance to ${money(state.companyValue)}.`);
  } catch {
    // The game stays playable if the organizer service is temporarily offline.
  } finally {
    remoteMoneyPollBusy = false;
  }
}

async function refreshSharedLeaderboard() {
  try {
    const response = await fetch(`${apiBase()}/leaderboard`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Leaderboard request failed (${response.status})`);
    const teams = await response.json();
    const before = JSON.stringify(getLeaderboard());
    replaceLeaderboard(teams);
    if (state.page === "leaderboard" && before !== JSON.stringify(getLeaderboard())) render();
  } catch (error) {
    console.warn("Could not load the shared leaderboard; showing this browser's saved copy.", error);
  }
}

async function loadRemoteTeam(teamId) {
  const runningLocally = usesLegacyLocalApi();
  const pin = document.querySelector("#pin").value;
  const response = runningLocally
    ? await fetch(`${apiBase()}/team/${encodeURIComponent(teamId)}`, { cache: "no-store" })
    : await fetch(`${apiBase()}/team/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId, pin }),
      cache: "no-store"
    });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && response.status === 404 && runningLocally) return null;
  if (!response.ok) throw new Error(payload.error || `Could not connect to team (${response.status})`);
  if (!runningLocally) {
    if (!payload.token || !payload.team) throw new Error("The team sign-in response was incomplete.");
    localStorage.setItem(teamTokenKey(teamId), payload.token);
    return payload.team;
  }
  return payload;
}

async function sendTeamHeartbeat() {
  if (!state.teamId || !hasTeamSession()) return;
  fetch(`${apiBase()}/team/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...teamAuthHeaders() },
    body: JSON.stringify({ teamId: state.teamId }),
    keepalive: true
  }).then(response => { if (response.status === 401) expireTeamSession(); }).catch(() => {});
}

function showPage(id) {
  state.page = id;
  save();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function shellHeading(eyebrow, title) {
  return `<div class="section-heading"><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div>`;
}

/* ── Navigation Bar ──────────────────────────────────────── */
const phases = [
  ["industries", "01 · CHOOSE INDUSTRY"],
  ["game", "02 · ROUND DASHBOARD"],
  ["results", "03 · ROUND RESULTS"],
  ["leaderboard", "🏆 LEADERBOARD"]
];

function renderPhaseBar() {
  if (state.page === "login") return "";
  const cur = phases.findIndex(([id]) => id === state.page);
  return `<div class="phasebar">
    <div class="phaselist">
      ${phases.map(([id, label], i) => {
    const status = i === cur ? "now" : i < cur ? "done" : "";
    return id !== "industries"
      ? `<button type="button" class="phase-nav ${status}" data-action="nav" data-page="${id}">${label}</button>`
      : `<span class="${status}">${label}</span>`;
  }).join("")}
    </div>
    <span class="phase-edition">${state.industry ? esc(state.industry.toUpperCase()) + " DESK" : "NO INDUSTRY CHOSEN"}</span>
  </div>`;
}

/* ── SVG Company Valuation Trajectory Chart ──────────────── */
function companyValueChart() {
  const hist = state.history || [];
  const op = hist[0]?.previousValue || BASE_ROUND_BUDGET;
  const pts = [{ round: 0, value: op }];
  hist.forEach(r => pts.push({ round: r.round, value: r.newValue }));
  const vals = pts.map(p => p.value);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const pad = Math.max((mx - mn) * 0.22, op * 0.012);
  const lo = Math.max(0, mn - pad), hi = mx + pad;
  const w = 760, h = 160, l = 48, r = 18, t = 18, b = 33;
  const x = i => l + i * (w - l - r) / Math.max(pts.length - 1, 1);
  const y = v => h - b - (v - lo) / (hi - lo || 1) * (h - t - b);
  const coords = pts.map((p, i) => `${x(i)},${y(p.value)}`);
  const cc = pts.length > 1 ? pts.at(-1).value - pts.at(-2).value : 0;
  const pct = pts.length > 1 && pts.at(-2).value ? (cc / pts.at(-2).value) * 100 : 0;
  const trend = cc > 0 ? "up" : cc < 0 ? "down" : "flat";
  const bl = h - b;

  return `<section class="company-chart-card ${trend}">
    <div class="chart-card-head">
      <div><span class="article-label">VALUATION TRAJECTORY</span><h3>NET CAPITAL TREND</h3></div>
      <div class="chart-current">
        <small>${pts.length > 1 ? `ROUND ${String(pts.at(-1).round).padStart(2, "0")}` : "STARTING CAPITAL"}</small>
        <b>${money(pts.at(-1).value)}</b>
        <span class="trend-${trend}">${cc > 0 ? "▲ +" : cc < 0 ? "▼ " : "— "}${Math.abs(pct).toFixed(1)}%</span>
      </div>
    </div>
    <svg class="value-chart" viewBox="0 0 ${w} ${h}" role="img">
      <line class="chart-rule" x1="${l}" y1="${t}" x2="${w}" y2="${t}"/>
      <line class="chart-rule" x1="${l}" y1="${(t + bl) / 2}" x2="${w}" y2="${(t + bl) / 2}"/>
      <line class="chart-rule" x1="${l}" y1="${bl}" x2="${w}" y2="${bl}"/>
      <polygon class="value-area" points="${x(0)},${bl} ${coords.join(" ")} ${x(pts.length - 1)},${bl}"/>
      <polyline class="value-line" points="${coords.join(" ")}"/>
      ${pts.map((p, i) => `<circle class="value-dot" cx="${x(i)}" cy="${y(p.value)}" r="4"/><text class="chart-axis" x="${x(i)}" y="${h - 8}" text-anchor="middle">${i === 0 ? "START" : `RD ${p.round}`}</text>`).join("")}
    </svg>
  </section>`;
}

/* ── 1. LOGIN PAGE ───────────────────────────────────────── */
function renderLogin() {
  return `<section class="front-page">
    <div class="front-copy">
      <div class="breaking-banner">TECHTATVA '26 · DATA TYCOON</div>
      <h2>WELCOME,<br><em>ANALYSTS.</em></h2>
      <p class="lead">Read each industry dataset, then allocate the fixed round budget across its ten parameters.</p>
      <div class="front-note">
        <span class="article-label">EVENT RULES</span>
        <p>Choose one industry for four rounds. Start with <b>₹1,000,000</b>; your balance carries forward, with a ₹250,000 bonus before Flash 2 and Flash 3. Download each industry dataset and invest the full round budget across ten parameters, with a ₹1,000 minimum per parameter.</p>
        <p class="monitoring-notice">Event integrity notice: team activity, window focus changes, and detected screenshot shortcuts are logged for organizer review. The site does not capture your screen, camera, or audio.</p>
      </div>
    </div>
    <form class="login-form" id="loginForm">
      <div class="article-label">NEWSROOM LOG IN</div>
      <label for="teamId">Team ID / Name</label>
      <input class="text-input" id="teamId" name="teamId" required placeholder="Enter your Team Name (e.g. Team Alpha)" value="${esc(state.teamId)}">
      <label for="pin">Access PIN</label>
      <input class="text-input" id="pin" name="pin" type="password" required minlength="4" maxlength="64" autocomplete="current-password" placeholder="Create a PIN or enter your team PIN">
      <small>First sign-in sets the team PIN. Returning teammates must use the same team name and PIN.</small>
      ${teamLoginNotice ? `<p id="teamConnectionError" role="alert">${esc(teamLoginNotice)}</p>` : ""}
      <button type="submit">ENTER THE NEWSROOM</button>
    </form>
  </section>`;
}

/* ── 2. INDUSTRY SELECTION ───────────────────────────────── */
function renderIndustries() {
  const sel = state.pendingIndustry || state.industry;
  return `${shellHeading("STEP 1", "SELECT YOUR INDUSTRY DESK")}
  <p class="intro-copy">Choose 1 industry for your company. You can change your choice anytime before submitting Round 1 investments.</p>
  <div class="selection-strip">
    <div>
      <strong>${sel ? `SELECTED: ${esc(sel.toUpperCase())}` : "NO INDUSTRY SELECTED YET"}</strong>
      <span>${sel ? "CLICK CONFIRM TO OPEN YOUR DASHBOARD" : "CHOOSE AN INDUSTRY BELOW"}</span>
    </div>
    <button data-action="confirm-industry" ${sel ? "" : "disabled"}>CONFIRM & PROCEED TO DASHBOARD ➔</button>
  </div>
  <div class="article-grid">
    ${industries.map((ind, i) => {
    const isSelected = sel === ind.name;
    return `<article class="industry-card editorial-choice ${isSelected ? "selected" : ""}">
        <div class="choice-topline">
          <span class="choice-number">0${i + 1}</span>
          <span class="article-label">INDUSTRY DESK</span>
        </div>
        <h3>${esc(ind.name)}</h3>
        <p>${esc(ind.description)}</p>
        <button class="choice-button ${isSelected ? "ghost" : ""}" data-action="select-industry" data-industry="${esc(ind.name)}">
          ${isSelected ? "✓ SELECTED" : "CHOOSE THIS INDUSTRY"}
        </button>
      </article>`;
  }).join("")}
  </div>`;
}

/* ── Dynamic CSV Dataset File Generator & Downloader ─────── */
function downloadRoundDataset() {
  const filePath = datasetFor(state.industry || "Food", state.round);
  const link = document.createElement("a");
  link.href = filePath;
  link.download = filePath.split("/").at(-1);
  document.body.appendChild(link);
  link.click();
  link.remove();
  state.datasetDownloadedRounds = { ...state.datasetDownloadedRounds, [datasetRoundKey()]: true };
  trackActivity("dataset-downloaded", `Downloaded ${state.industry || "Food"} Flash ${state.round} dataset.`);
  save();
  render();
}

/* ── 3. ROUND DASHBOARD ──────────────────────────────────── */
function renderGame() {
  if (!state.industry) {
    return `${shellHeading("STEP 1 REQUIRED", "NO INDUSTRY SELECTED")}
    <p class="lead">Please select an industry first before accessing the dashboard.</p>
    <button data-action="nav" data-page="industries">GO TO INDUSTRY SELECTION</button>`;
  }
  if (state.isEliminated) {
    return `${shellHeading("ROUND DISQUALIFICATION", "YOUR TEAM IS ELIMINATED")}
      <p class="lead">The zero-return subsystem received more than 80% of the round budget. Your team cannot submit more rounds.</p>
      <button data-action="nav" data-page="leaderboard">VIEW LEADERBOARD</button>`;
  }

  ensureRoundAllocations();
  const alloc = state.allocations;
  const parameters = roundParameters();
  const datasetPath = datasetFor(state.industry, state.round);
  const dataFileName = datasetPath.split("/").at(-1);
  const currentCap = roundBudget();
  const totalInvested = parameters.reduce((sum, name) => sum + Number(alloc[name] || 0), 0);
  const remainingCash = currentCap - totalInvested;
  const valid = allocationValid();
  const rankInfo = getTeamRank(state.teamId);
  const flashComplete = Boolean(state.flashCompletedRounds?.[state.round]);
  const datasetDownloaded = Boolean(state.datasetDownloadedRounds?.[datasetRoundKey()]);
  const roundSubmitted = state.history.some(result => result.round === state.round);
  const investmentUnlocked = flashComplete && datasetDownloaded && !roundSubmitted;
  const rows = parameters.map((name, index) => `<tr>
    <td><strong>${esc(name)}</strong><small style="display:block;color:var(--muted);font-size:9px">${index < 5 ? "Common parameter" : "Industry parameter"}</small></td>
    <td style="font-size:10px;color:var(--muted)">Minimum ₹1,000</td>
    <td class="allocation-input-cell"><span style="font-weight:bold">₹</span><input id="alloc-${index}" type="number" min="1000" max="${currentCap}" step="1" value="${Number(alloc[name] ?? 0)}" data-allocation="${esc(name)}" ${investmentUnlocked ? "" : "disabled"} style="width:110px;text-align:right;padding:8px;font-weight:bold;"></td>
  </tr>`).join("");

  return `<div class="live-label">LIVE MARKET DASHBOARD · ROUND ${String(state.round).padStart(2, "0")} OF 04</div>
  ${shellHeading(`${esc(state.industry.toUpperCase())} INDUSTRY`, `ROUND ${state.round} DASHBOARD`)}
  <div class="market-tape" style="grid-template-columns: repeat(4, 1fr); margin-bottom:20px">
    <div><small>ROUND BUDGET</small><b style="font-size:18px;color:var(--green)">${money(currentCap)}</b></div>
    <div><small>LEADERBOARD RANK</small><b style="font-size:18px;color:var(--red)">${rankInfo.rank} <span style="font-size:10px;font-weight:normal;color:var(--muted)">of ${rankInfo.total} teams</span></b></div>
    <div><small>ROUND PROGRESS</small><b>ROUND ${state.round} / 4</b></div>
    <div><small>SELECTED INDUSTRY</small><b>${esc(state.industry)}</b></div>
  </div>
  <section class="analysis-card" style="margin-bottom:20px;border-left:4px solid var(--red);background:#fbf7ec">
    <span class="article-label" style="color:var(--red)">ROUND INSTRUCTIONS</span><h3 style="margin:8px 0 12px">HOW TO PLAY THIS ROUND</h3>
    ${roundBonusFor() ? `<p style="font-weight:bold;color:var(--green)">Previous round balance: ${money(roundBudget() - roundBonusFor())} + Flash ${state.round} bonus: ${money(roundBonusFor())}.</p>` : state.round > 1 ? `<p style="font-weight:bold;color:var(--green)">Carried forward from the previous round: ${money(roundBudget())}.</p>` : ""}
    <ol style="font-size:12px;line-height:1.8;margin:0;padding-left:20px">
    <li>Open the round flash whenever needed; every opening starts a five-minute screen lock.</li>
      <li>Download the official dataset for this industry and round.</li>
      <li>Allocate exactly ${money(currentCap)} across the ten parameters, with at least ₹1,000 in each.</li>
      <li>Submit to calculate your payout and round score.</li>
    </ol>
  </section>
  <section style="border:2px solid var(--red);background:#fdf2f0;padding:20px;margin-bottom:24px;text-align:center">
    <span class="article-label" style="color:var(--red);font-size:11px">MANDATORY STORYLINE FLASH · ROUND ${state.round}</span>
    <h2 style="font-family:'Playfair Display',serif;font-size:24px;margin:10px 0 6px">ROUND ${state.round} FLASH</h2>
    <p style="font-size:13px;color:#555;max-width:700px;margin:0 auto 16px">Every time you open this flash, your screen will be locked for five minutes. You can reopen it after the timer ends.</p>
    <button data-action="open-flash" style="background:var(--red);border-color:var(--red);color:white;padding:16px 32px;font-size:13px;letter-spacing:.12em">
      OPEN FLASH · START 5-MINUTE LOCK
    </button>
  </section>
  <section class="analysis-card" style="margin-bottom:24px;text-align:center;padding:24px">
    <span class="article-label">ROUND ${state.round} DATASET FILE</span>
    <h3 style="margin:8px 0 10px">${esc(state.industry.toUpperCase())} DATASET</h3>
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px">Download the supplied dataset for this industry and round.</p>
    <button data-action="download-dataset" ${flashComplete ? "" : "disabled"} style="background:var(--ink);color:var(--paper);padding:14px 28px;font-size:12px;letter-spacing:.1em">
      ${datasetDownloaded ? "DATASET DOWNLOADED · DOWNLOAD AGAIN" : `DOWNLOAD ROUND ${state.round} DATASET (${dataFileName.split(".").at(-1).toUpperCase()})`}
    </button>
    ${flashComplete ? "" : `<p class="error" style="font-size:11px;margin:12px 0 0">Complete the storyline flash to unlock the dataset.</p>`}
  </section>
  ${companyValueChart()}
  <section class="allocation-section">
    <div class="article-label">INVESTMENT ALLOCATION DESK</div><h2>INVEST ACROSS THE TEN PARAMETERS</h2>
    <p class="allocation-intro">${investmentRuleText()} Allocation bands adjust returns. Concentrating more than 40% in the loss trap can create a direct loss; putting more than 80% in the zero-return trap disqualifies the round.</p>
    <div class="table-scroll"><table class="alloc-table"><thead><tr><th>Industry parameter</th><th>Rule</th><th class="align-right">Investment amount</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="background:#e9e1cf;border:1px solid var(--ink);padding:16px;margin:16px 0;font-family:'DM Mono',monospace;font-size:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>REQUIRED ROUND BUDGET:</span><b>${money(currentCap)}</b></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>TOTAL INVESTED:</span><b id="totalInvestedAmount">${money(totalInvested)}</b></div>
      <div style="display:flex;justify-content:space-between;border-top:1px solid var(--rule);padding-top:6px;font-size:14px;font-weight:bold;color:var(--green)"><span>REMAINING TO ALLOCATE:</span><b id="remainingCashAmount">${money(remainingCash)}</b></div>
    </div>
    <div id="allocationTotal" class="total ${valid ? "valid" : "invalid"}" style="font-size:13px">
      ${roundSubmitted ? `ROUND ${state.round} ALREADY SUBMITTED` : !flashComplete ? "COMPLETE THE STORYLINE FLASH TO CONTINUE" : !datasetDownloaded ? `DOWNLOAD THE ROUND ${state.round} DATASET TO UNLOCK INVESTMENTS` : valid ? `ALLOCATIONS VALID · ${money(totalInvested)} INVESTED` : `INVALID · TOTAL MUST EQUAL ${money(currentCap)}; EACH PARAMETER MUST BE AT LEAST ₹1,000`}
    </div>
    <button id="submitAllocation" data-action="submit-round" ${valid && investmentUnlocked ? "" : "disabled"} style="width:100%;padding:16px;font-size:13px;margin-top:12px">LOCK & SUBMIT ROUND ${state.round}</button>
  </section>`;
}

/* ── 4. ROUND RESULTS VIEW ───────────────────────────────── */
function renderResults() {
  const result = state.history.at(-1);
  if (!result) {
    return `${shellHeading("RESULTS", "NO ROUND CLOSED YET")}
    <button data-action="nav" data-page="game">RETURN TO DASHBOARD ➔</button>`;
  }

  const rows = Object.entries(result.investedAmounts || {}).map(([name, amount]) => `<tr>
    <td><b>${esc(name)}</b></td>
    <td>${(Number(amount) / (result.roundBudget || BASE_ROUND_BUDGET) * 100).toFixed(2)}%</td>
    <td>${money(amount)}</td>
    <td><b>${money(result.departmentRevenues?.[name] || 0)}</b></td>
  </tr>`).join("");

  const rankInfo = getTeamRank(state.teamId);

  return `${shellHeading(`ROUND ${String(result.round).padStart(2, "0")} CLOSE`, result.eliminated ? "TEAM ELIMINATED" : "INVESTMENT RESULTS")}
  ${companyValueChart()}

  <section class="results-card">
    <div class="article-label">${esc(state.industry || "INDUSTRY")} PERFORMANCE REPORT</div>
    <h2>ROUND ${result.round} FINANCIAL CLOSE</h2>
    <div class="result-highlight">
      <span>FINAL ROUND PAYOUT</span>
      <strong>${money(result.finalPayout ?? result.newValue)}</strong>
      <span>NET PROFIT: ${money(result.netProfit ?? (result.newValue - (result.roundBudget || BASE_ROUND_BUDGET)))}</span>
      ${result.roundBonus ? `<span style="margin-top:8px;font-weight:bold;color:var(--green)">PRE-ROUND TEAM BONUS ADDED TO FLASH ${result.round} BUDGET: +${money(result.roundBonus)}</span>` : ""}
      ${result.eliminated ? `<span class="error">DISQUALIFIED: the zero-return trap exceeded the 80% limit. Investment payout is zero; any round bonus is still credited.</span>` : ""}
      <span style="margin-top:8px;font-weight:bold;color:var(--red)">CURRENT LEADERBOARD RANK: ${rankInfo.rank} of ${rankInfo.total} Teams</span>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Investment parameter</th>
            <th>Allocation</th>
            <th>Invested amount</th>
            <th>Amount returned</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>

    <div style="margin-top: 24px; text-align: center;">
      ${result.eliminated ? `
        <button data-action="nav" data-page="leaderboard" style="padding:16px 32px;font-size:13px;background:var(--red);border-color:var(--red)">VIEW LEADERBOARD</button>
      ` : result.round < 4 ? `
        <button data-action="next-round" style="padding: 16px 32px; font-size: 13px; background: var(--green); border-color: var(--green);">
          PROCEED TO ROUND ${result.round + 1} DASHBOARD ➔
        </button>
      ` : `
        <button data-action="nav" data-page="leaderboard" style="padding: 16px 32px; font-size: 13px; background: var(--red); border-color: var(--red);">
          🏆 VIEW FINAL LEADERBOARD & WINNERS ➔
        </button>
      `}
    </div>
  </section>`;
}

/* ── 5. LEADERBOARD VIEW ─────────────────────────────────── */
function renderLeaderboard() {
  const board = getLeaderboard();
  const rows = board.map((t, i) => {
    const badge = i === 0 ? "🥇 1ST" : i === 1 ? "🥈 2ND" : i === 2 ? "🥉 3RD" : `#${i + 1}`;
    const isMe = t.teamId.toLowerCase() === state.teamId.toLowerCase();
    return `<tr style="${isMe ? "background:#fdf6e7;font-weight:bold;" : ""}">
      <td><b>${badge}</b></td>
      <td><b>${esc(t.teamId)}</b>${isMe ? ' <span style="color:var(--red)">(YOU)</span>' : ""}</td>
      <td>${esc(t.industry || "—")}</td>
      <td>Round ${t.round || 1}</td>
      <td><b style="font-size:14px;color:var(--green);">${money(t.companyValue ?? BASE_ROUND_BUDGET)}</b></td>
    </tr>`;
  }).join("");

  return `${shellHeading("TECHTATVA '26", "OFFICIAL LEADERBOARD")}
  <div style="border: 1px solid var(--ink); padding: 20px; background: var(--paper);">
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Team Name</th>
            <th>Industry</th>
            <th>Round Reached</th>
            <th>Net Capital Balance</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="5" style="text-align:center">No teams recorded yet. Log in to start!</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
  <div style="margin-top: 18px; display: flex; gap: 12px;">
    <button data-action="nav" data-page="game">BACK TO ROUND DASHBOARD</button>
    <button data-action="refresh-leaderboard" class="ghost">REFRESH RANKINGS</button>
  </div>`;
}

/* ── Main Render Function ────────────────────────────────── */
function render() {
  if (activeEvent()) return;
  document.querySelector("#returnToLogin").hidden = state.page === "login";
  const pages = {
    login: renderLogin,
    industries: renderIndustries,
    game: renderGame,
    results: renderResults,
    leaderboard: renderLeaderboard
  };
  page.innerHTML = `${renderPhaseBar()}${(pages[state.page] || renderLogin)()}`;
  page.focus({ preventScroll: true });
}

/* ── Allocation Validation (full round budget, ₹1,000 minimum) ── */
function allocationValid() {
  ensureRoundAllocations();
  const parameters = roundParameters();
  const totalInvested = parameters.reduce((sum, name) => sum + Number(state.allocations[name] || 0), 0);
  const allParametersMeetMinimum = parameters.every(name => {
    const amount = Number(state.allocations[name]);
    return Number.isInteger(amount) && amount >= 1_000;
  });
  return allParametersMeetMinimum && totalInvested === roundBudget();
}

function computeEffectiveMultiplier(baseMultiplier, allocation) {
  const percentage = allocation / roundBudget() * 100;
  if (baseMultiplier === 0) return { multiplier: 0, eliminated: percentage > 80 };
  if (baseMultiplier === 0.3) return { multiplier: percentage > 40 ? -0.9 : 0.3, eliminated: false };
  if ([1.0, 0.8, 0.7, 0.5].includes(baseMultiplier)) return { multiplier: baseMultiplier, eliminated: false };
  if (baseMultiplier === 2.7) {
    if (percentage <= 20) return { multiplier: 2.7 * 0.8, eliminated: false };
    if (percentage <= 40) return { multiplier: 2.7, eliminated: false };
    if (percentage <= 60) return { multiplier: 2.7 * 0.9, eliminated: false };
    if (percentage <= 80) return { multiplier: 2.7 * 0.7, eliminated: false };
    return { multiplier: 2.7 * 0.6, eliminated: false };
  }
  if ([1.8, 1.5, 1.2].includes(baseMultiplier)) {
    if (percentage <= 40) return { multiplier: baseMultiplier, eliminated: false };
    if (percentage <= 60) return { multiplier: baseMultiplier * 0.9, eliminated: false };
    if (percentage <= 80) return { multiplier: baseMultiplier * 0.7, eliminated: false };
    return { multiplier: baseMultiplier * 0.6, eliminated: false };
  }
  return { multiplier: baseMultiplier, eliminated: false };
}

function closeRound() {
  const roundReady = state.flashCompletedRounds?.[state.round] && state.datasetDownloadedRounds?.[datasetRoundKey()];
  const roundAlreadySubmitted = state.history.some(result => result.round === state.round);
  if (!allocationValid() || !roundReady || roundAlreadySubmitted || state.isEliminated) return;

  const parameters = roundParameters();
  const currentBudget = roundBudget();
  const baseMultipliers = payoutMultipliers[state.industry || "Food"]?.[state.round] || {};
  const allocations = Object.fromEntries(parameters.map(name => [name, Number(state.allocations[name]) || 0]));
  const subsystemResults = {};
  let eliminated = false;
  let computedPayout = 0;

  parameters.forEach(name => {
    const allocation = allocations[name];
    const baseMultiplier = baseMultipliers[name] ?? 0;
    const { multiplier: effectiveMultiplier, eliminated: subsystemEliminated } = computeEffectiveMultiplier(baseMultiplier, allocation);
    const payout = allocation * effectiveMultiplier;
    if (subsystemEliminated) eliminated = true;
    subsystemResults[name] = { allocation, allocationPercentage: allocation / currentBudget * 100, payout };
    computedPayout += payout;
  });

  const roundBonus = roundBonusFor();
  const finalPayout = eliminated ? 0 : Math.round(computedPayout);
  const netProfit = finalPayout - currentBudget;
  const ev = events.find(event => event.round === state.round) || events[0];
  const result = {
    round: state.round,
    allocations,
    investedAmounts: allocations,
    departmentRevenues: Object.fromEntries(parameters.map(name => [name, eliminated ? 0 : subsystemResults[name].payout])),
    subsystemResults,
    previousValue: currentBudget,
    newValue: finalPayout,
    finalPayout,
    roundBudget: currentBudget,
    roundBonus,
    netProfit,
    eliminated,
    change: netProfit / currentBudget * 100,
    headline: ev.headline
  };
  state.history.push(result);
  state.companyValue = finalPayout;
  state.isEliminated = eliminated;
  trackActivity("round-submitted", `Submitted Flash ${state.round}; reported balance ${money(finalPayout)}.`);
  save();
  showPage(state.round === 4 ? "leaderboard" : "results");
}

/* ── 5-Minute Storyline Flash Lock System ─────────────────── */
function activeEvent() {
  try {
    const saved = JSON.parse(localStorage.getItem(eventStorageKey()) || "null");
    if (!saved) return null;
    const ev = events.find(e => e.id === saved.id);
    if (!ev) {
      localStorage.removeItem(eventStorageKey());
      return null;
    }
    // Older saves may have a pause marker from the previous flash behavior. Clear it
    // and let the five-minute clock continue from the original start time.
    if (saved.pausedAt) {
      delete saved.pausedAt;
      localStorage.setItem(eventStorageKey(), JSON.stringify(saved));
    }
    const remaining = saved.startedAt + EVENT_DURATION_MS - Date.now();
    if (remaining <= 0) {
      localStorage.removeItem(eventStorageKey());
      state.flashCompletedRounds = {
        ...state.flashCompletedRounds,
        [ev.round]: true
      };
      state.page = hasTeamSession() ? "game" : "login";
      trackActivity("flash-completed", `Completed Flash ${ev.round}.`);
      save();
      return null;
    }
    return { ...saved, event: ev, remaining };
  } catch {
    localStorage.removeItem(eventStorageKey());
    return null;
  }
}

function formatCountdown(ms) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function syncEventOverlay() {
  const eventWasVisible = renderedEventId !== null;
  const active = activeEvent();
  if (!active) {
    if (overlay) {
      overlay.hidden = true;
      overlay.setAttribute("hidden", "true");
      overlay.style.display = "none";
    }
    document.body.style.overflow = "";
    const appRoot = document.querySelector("#appRoot");
    if (appRoot) appRoot.inert = false;
    renderedEventId = null;
    if (timer) { clearInterval(timer); timer = null; }
    if (eventWasVisible) render();
    return;
  }

  const { event } = active;
  const appRoot = document.querySelector("#appRoot");
  if (appRoot) appRoot.inert = true;
  document.body.style.overflow = "hidden";

  if (renderedEventId !== event.id) {
    document.querySelector("#flashNumber").textContent = `FLASH ${event.round} OF 04`;
    const documentFrame = document.querySelector("#eventDocument");
    const flashUrl = new URL(event.document, location.href);
    flashUrl.hash = "toolbar=0&navpanes=0&scrollbar=0";
    documentFrame.src = flashUrl.href;
    documentFrame.title = `Flash ${event.round} reading document`;
    renderedEventId = event.id;
  }

  document.querySelector("#countdown").textContent = formatCountdown(active.remaining);
  overlay.hidden = false;
  overlay.removeAttribute("hidden");
  overlay.style.display = "grid";

  if (!timer) timer = setInterval(syncEventOverlay, 200);
}

function startEvent(id) {
  const ev = events.find(e => e.id === id);
  if (!ev) return;

  const existing = activeEvent();
  if (existing) {
    if (existing.event.id === id) syncEventOverlay();
    return;
  }
  const durationMs = EVENT_DURATION_MS;
  state.page = "game";
  localStorage.setItem(eventStorageKey(), JSON.stringify({ id: ev.id, startedAt: Date.now(), duration: durationMs }));
  trackActivity("flash-started", `Opened Flash ${ev.round}.`);
  save();
  renderedEventId = null;
  syncEventOverlay();
}

function coverFlashContent(covered) {
  document.body.classList.toggle("anti-cheat-cover", Boolean(covered && activeEvent()));
}

/* ── Anti-Cheat Listener ─────────────────────────────────── */
document.addEventListener("contextmenu", e => { if (activeEvent()) e.preventDefault(); });
document.addEventListener("copy", e => { if (activeEvent()) e.preventDefault(); });
document.addEventListener("cut", e => { if (activeEvent()) e.preventDefault(); });
document.addEventListener("paste", e => { if (activeEvent()) e.preventDefault(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    trackActivity("tab-hidden", "Game tab became hidden; this can indicate a tab switch or capture tool.");
    coverFlashContent(true);
  } else {
    coverFlashContent(false);
    syncEventOverlay();
  }
});
window.addEventListener("blur", () => {
  if (state.teamId && Date.now() - lastBlurActivityAt > 2500) {
    lastBlurActivityAt = Date.now();
    trackActivity("window-blur", "Game window lost focus; this can indicate a tab switch or capture tool.");
  }
});
window.addEventListener("focus", () => {
  if (document.hidden) return;
  syncEventOverlay();
});
document.addEventListener("keydown", event => {
  const key = event.key.toLowerCase();
  const printShortcut = (event.ctrlKey || event.metaKey) && key === "p";
  const screenshotShortcut = event.key === "PrintScreen" || (event.metaKey && event.shiftKey && key === "s");
  if (!printShortcut && !screenshotShortcut) return;
  event.preventDefault();
  if (activeEvent()) {
    trackActivity(
      printShortcut ? "print-shortcut" : "screenshot-shortcut",
      printShortcut
        ? "Detected a print or save-as-PDF shortcut during a flash."
        : `Detected ${event.key === "PrintScreen" ? "Print Screen" : "Windows/Meta + Shift + S"} shortcut.`
    );
  }
}, true);

window.addEventListener("beforeprint", () => {
  if (activeEvent()) trackActivity("print-dialog", "The browser opened its print dialog during a flash.");
});

/* ── Global Event Delegation ─────────────────────────────── */
document.addEventListener("copy", event => event.preventDefault(), true);
document.addEventListener("cut", event => event.preventDefault(), true);
document.addEventListener("paste", event => event.preventDefault(), true);
document.addEventListener("contextmenu", event => event.preventDefault(), true);
document.addEventListener("selectstart", event => event.preventDefault(), true);
document.addEventListener("dragstart", event => event.preventDefault(), true);
document.addEventListener("keydown", event => {
  const key = event.key.toLowerCase();
  const copyPasteShortcut = (event.ctrlKey || event.metaKey) && ["c", "v", "x"].includes(key);
  const legacyClipboardShortcut = event.ctrlKey && key === "insert"
    || event.shiftKey && key === "insert";
  if (copyPasteShortcut || legacyClipboardShortcut) {
    event.preventDefault();
    trackActivity("clipboard-shortcut", `Blocked clipboard shortcut: ${key.toUpperCase()}.`);
  }
}, true);

document.addEventListener("click", event => {
  const btn = event.target.closest("[data-action]");
  if (!btn) return;

  const act = btn.dataset.action;

  if (act === "home" || act === "login") { event.preventDefault(); showPage("login"); return; }
  if (act === "nav") { showPage(btn.dataset.page); return; }

  if (act === "select-industry") {
    state.pendingIndustry = btn.dataset.industry;
    state.industry = btn.dataset.industry;
    save();
    render();
    return;
  }
  if (act === "confirm-industry") {
    if (state.pendingIndustry) state.industry = state.pendingIndustry;
    state.allocations = {};
    ensureRoundAllocations();
    save();
    showPage("game");
    return;
  }
  // Open Flash modal guarantees modal triggers
  if (act === "open-flash") {
    event.preventDefault();
    startEvent(`flash-${state.round}`);
    return;
  }

  // Download Dataset CSV
  if (act === "download-dataset") {
    downloadRoundDataset();
    return;
  }

  // Submit Allocations
  if (act === "submit-round") {
    closeRound();
    return;
  }

  // Round progression
  if (act === "next-round") {
    if (state.isEliminated || state.round >= 4) return;
    state.round += 1;
    trackActivity("round-opened", `Moved to Flash ${state.round}.`);
    save();
    showPage("game");
    return;
  }

  if (act === "refresh-leaderboard") {
    refreshSharedLeaderboard();
    return;
  }


});

// Form submission handler
document.addEventListener("submit", async event => {
  if (event.target.id !== "loginForm") return;
  event.preventDefault();
  const formData = new FormData(event.target);
  const teamId = formData.get("teamId").trim() || "Team Alpha";
  const submitButton = event.target.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "CONNECTING…";

  try {
    teamLoginNotice = "";
    const remoteTeam = await loadRemoteTeam(teamId);

    if (timer) { clearInterval(timer); timer = null; }
    renderedEventId = null;
    document.body.classList.remove("anti-cheat-cover");

    if (state.teamId && hasTeamSession()) save();
    localStorage.setItem("data-tycoon-active-team", teamSlug(teamId));
    const savedTeam = localStorage.getItem(teamStateKey(teamId));
    state = savedTeam ? readState(teamStateKey(teamId)) : structuredClone(defaults);
    if (remoteTeam) {
      const browserHistory = state.history;
      const restoredHistory = (remoteTeam.history || []).map(remoteResult => {
        const localResult = browserHistory.find(result => result.round === remoteResult.round && result.subsystemResults);
        return localResult ? { ...localResult, ...remoteResult, subsystemResults: localResult.subsystemResults } : remoteResult;
      });
      state = {
        ...state,
        ...remoteTeam,
        history: restoredHistory,
        // Progress stored on the server is authoritative; defaults fill older saved records.
        flashCompletedRounds: remoteTeam.flashCompletedRounds ?? state.flashCompletedRounds,
        datasetDownloadedRounds: remoteTeam.datasetDownloadedRounds ?? state.datasetDownloadedRounds,
        offlineBonusClaimed: remoteTeam.offlineBonusClaimed ?? state.offlineBonusClaimed
      };
      if (Object.hasOwn(remoteTeam, "activeFlash")) {
        if (remoteTeam.activeFlash) {
          localStorage.setItem(eventStorageKey(teamId), JSON.stringify(remoteTeam.activeFlash));
        } else {
          localStorage.removeItem(eventStorageKey(teamId));
        }
      }
    }
    state.teamId = remoteTeam?.teamId || teamId;
    state.page = remoteTeam?.page || (savedTeam ? (state.page || "industries") : "industries");
    if (state.page === "login") state.page = "industries";
    trackActivity("team-connected", "Team joined or resumed the simulation.");
    save();
    showPage(state.page);
    syncEventOverlay();
  } catch (error) {
    let message = document.querySelector("#teamConnectionError");
    if (!message) {
      message = document.createElement("p");
      message.id = "teamConnectionError";
      message.setAttribute("role", "alert");
      event.target.append(message);
    }
    message.textContent = `Could not connect to the event database: ${error.message}. Please try again.`;
    submitButton.disabled = false;
    submitButton.textContent = "ENTER THE NEWSROOM";
  }
});

// Input change handler for rupee investments (minimum ₹1,000 per parameter)
document.addEventListener("input", event => {
  const an = event.target.dataset.allocation;
  if (an) {
    state.allocations[an] = event.target.value === "" ? 0 : Number(event.target.value);
    scheduleAllocationSave();
    const currentCap = roundBudget();
    const totalInvested = roundParameters().reduce((sum, d) => sum + Number(state.allocations[d] || 0), 0);
    const remainingCash = currentCap - totalInvested;
    const v = allocationValid();
    const investedAmount = document.querySelector("#totalInvestedAmount");
    const remainingAmount = document.querySelector("#remainingCashAmount");
    if (investedAmount) investedAmount.textContent = money(totalInvested);
    if (remainingAmount) remainingAmount.textContent = money(remainingCash);
    const roundReady = Boolean(state.flashCompletedRounds?.[state.round]
      && state.datasetDownloadedRounds?.[datasetRoundKey()]);
    const roundSubmitted = state.history.some(result => result.round === state.round);

    const msg = document.querySelector("#allocationTotal");
    if (msg) {
      if (roundSubmitted) {
        msg.textContent = `✓ ROUND ${state.round} INVESTMENTS ALREADY SUBMITTED`;
        msg.className = "total valid";
      } else if (!state.flashCompletedRounds?.[state.round]) {
        msg.textContent = "🔒 COMPLETE THE STORYLINE FLASH TO CONTINUE";
        msg.className = "total invalid";
      } else if (!state.datasetDownloadedRounds?.[datasetRoundKey()]) {
        msg.textContent = `🔒 DOWNLOAD THE ROUND ${state.round} DATASET TO UNLOCK INVESTMENTS`;
        msg.className = "total invalid";
      } else if (v) {
        msg.textContent = `ALLOCATIONS VALID · ${money(totalInvested)} INVESTED`;
        msg.className = "total valid";
      } else {
        msg.textContent = `INVALID · TOTAL MUST EQUAL ${money(currentCap)}; EACH PARAMETER MUST BE AT LEAST ₹1,000`;
        msg.className = "total invalid";
      }
    }
    const sub = document.querySelector("#submitAllocation");
    if (sub) sub.disabled = !v || !roundReady || roundSubmitted;
  }
});

document.addEventListener("change", event => {
  if (!event.target.dataset.allocation) return;
  clearTimeout(allocationSaveTimer);
  allocationSaveTimer = null;
  persistState();
  const parameter = event.target.dataset.allocation;
  trackActivity("allocation-updated", `Set ${parameter} allocation to ${money(state.allocations[parameter])}.`);
});

/* ── Boot Initializer ────────────────────────────────────── */
if (!state.page) state = { ...defaults };
if (state.teamId && !hasTeamSession()) state.page = "login";
render();
syncEventOverlay();
if (state.teamId) {
  scheduleTeamSync();
  sendTeamHeartbeat();
}
refreshSharedLeaderboard();
setInterval(refreshSharedLeaderboard, 5000);
setInterval(syncOrganizerMoney, 2500);
setInterval(sendTeamHeartbeat, 5000);

