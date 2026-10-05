import { departments, industries } from "./data/industries.js";
import { industryDatasets } from "./data/industry-datasets.js";
import { EVENT_DURATION_MS, events } from "./data/events.js";
import { miniGamesByEvent } from "./data/minigames.js";
import { mountMiniGame } from "./minigame-ui.js";
import { getLeaderboard, getTeamRank, updateTeamInLeaderboard } from "./data/leaderboard.js";

/* ── Keys & State Defaults ───────────────────────────────── */
const STATE_KEY = "data-tycoon-game-v4";
const EVENT_KEY_PREFIX = "data-tycoon-active-event-v6";

// Sub-departments available for direct dollar investments
const subDepartments = ["Production", "Marketing", "Logistics", "Research", "Human Resources"];

const defaults = {
  page: "login",
  teamId: "",
  industry: null,
  pendingIndustry: null,
  round: 1,
  companyValue: 100000,
  // Direct dollar amounts invested in each sub-department
  allocations: { Production: 20000, Marketing: 20000, Logistics: 20000, Research: 20000, "Human Resources": 10000 },
  history: [],
  flashCompletedRounds: {},
  datasetDownloadedRounds: {},
  offlineBonusClaimed: { round3: false, round4: false },
  round2GrantApplied: false
};

let state = loadState();
let timer = null;
let renderedEventId = null;

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

function readState(key) {
  try {
    const loaded = JSON.parse(localStorage.getItem(key) || "{}");
    return {
      ...defaults,
      ...loaded,
      allocations: { ...defaults.allocations, ...(loaded.allocations || {}) },
      flashCompletedRounds: { ...defaults.flashCompletedRounds, ...(loaded.flashCompletedRounds || {}) },
      datasetDownloadedRounds: { ...defaults.datasetDownloadedRounds, ...(loaded.datasetDownloadedRounds || {}) },
      offlineBonusClaimed: { ...defaults.offlineBonusClaimed, ...(loaded.offlineBonusClaimed || {}) }
    };
  } catch {
    return structuredClone(defaults);
  }
}

function save() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  if (state.teamId) localStorage.setItem(teamStateKey(state.teamId), JSON.stringify(state));
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
const money = v => `$${Math.round(v).toLocaleString("en-US")}`;
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const investmentRuleText = "Each subsystem must receive at least $100, and every investment must be a multiple of $100.";

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
  const op = hist[0]?.previousValue || 100000;
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
      <p class="lead">Analyze the storyline flashes & dataset CSV files to allocate your capital strategically across company subsystems.</p>
      <div class="front-note">
        <span class="article-label">EVENT RULES</span>
        <p>Choose 1 industry across 4 rounds. Starting Balance: <b>$100,000</b>. Invest in dollar amounts (multiples of $100). The storyline flashes contain the true subsection multiplier hints!</p>
      </div>
    </div>
    <form class="login-form" id="loginForm">
      <div class="article-label">NEWSROOM LOG IN</div>
      <label for="teamId">Team ID / Name</label>
      <input class="text-input" id="teamId" name="teamId" required placeholder="Enter your Team Name (e.g. Team Alpha)" value="${esc(state.teamId)}">
      <label for="pin">Access PIN</label>
      <input class="text-input" id="pin" name="pin" type="password" required placeholder="Enter PIN">
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
function downloadDatasetCSV() {
  const ind = state.industry || "Pharma";
  const dataset = industryDatasets[ind] || {
    companyName: `${ind} Team Dataset`,
    profile: "Replace this placeholder with the dataset provided by the event organizers.",
    history: [],
    market: { inputCosts: "Provided externally", demand: "Provided externally", logistics: "Provided externally", technology: "Provided externally" }
  };
  const round = state.round;

  let csvContent = `DATA TYCOON OFFICIAL DATASET - ${ind.toUpperCase()} (ROUND ${round})\n`;
  csvContent += `Company Name: ${dataset.companyName}\n`;
  csvContent += `Market Profile: ${dataset.profile}\n`;
  csvContent += `Organizer Note: Replace this downloadable placeholder with the official dataset file when it is provided.\n\n`;
  csvContent += `Quarter,Revenue,Demand_Index_%,Operating_Costs_%,Market_Index\n`;

  dataset.history.forEach(row => {
    csvContent += `"${row.quarter}","${row.revenue}",${row.demand},${row.costs},${row.index}\n`;
  });

  csvContent += `\nSECTOR INDICATORS (ROUND ${round}):\n`;
  csvContent += `Input Costs,${dataset.market.inputCosts}\n`;
  csvContent += `Consumer Demand,${dataset.market.demand}\n`;
  csvContent += `Logistics,${dataset.market.logistics}\n`;
  csvContent += `Technology,${dataset.market.technology}\n`;

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `DataTycoon_${ind}_Round${round}_Dataset.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);

  state.datasetDownloadedRounds = {
    ...state.datasetDownloadedRounds,
    [round]: true
  };
  save();
  render();
}

/* ── 3. ROUND DASHBOARD ──────────────────────────────────── */
function renderGame() {
  if (!state.industry) {
    return `${shellHeading("STEP 1 REQUIRED", "NO INDUSTRY SELECTED")}
    <p class="lead">Please select an industry first before accessing the dashboard.</p>
    <button data-action="nav" data-page="industries">GO TO INDUSTRY SELECTION ➔</button>`;
  }

  const alloc = state.allocations;
  let currentCap = state.companyValue;
  const totalInvested = subDepartments.reduce((sum, d) => sum + Number(alloc[d] || 0), 0);
  let remainingCash = currentCap - totalInvested;
  const valid = allocationValid();
  const currentEvent = events.find(e => e.round === state.round) || events[0];
  const rankInfo = getTeamRank(state.teamId);
  const flashComplete = Boolean(state.flashCompletedRounds?.[state.round]);
  const datasetDownloaded = Boolean(state.datasetDownloadedRounds?.[state.round]);
  const roundSubmitted = state.history.some(result => result.round === state.round);
  const investmentUnlocked = flashComplete && datasetDownloaded && !roundSubmitted;

  // Government Grant in Round 2
  let grantBanner = "";
  if (state.round === 2 && !state.round2GrantApplied) {
    state.companyValue += 10000;
    state.round2GrantApplied = true;
    save();
    grantBanner = `<div style="background:#23652c;color:#fff;padding:12px 18px;font:700 12px 'DM Mono',monospace;letter-spacing:.05em;margin-bottom:14px">🏛️ GOVERNMENT RELIEF GRANT APPLIED: +$10,000 Credited for Round 2!</div>`;
  } else if (state.round === 2) {
    grantBanner = `<div style="background:#23652c;color:#fff;padding:12px 18px;font:700 12px 'DM Mono',monospace;letter-spacing:.05em;margin-bottom:14px">🏛️ GOVERNMENT GRANT APPLIED · +$10,000 CREDITED</div>`;
  }
  currentCap = state.companyValue;
  remainingCash = currentCap - totalInvested;

  // Offline Bonus for Rounds 3 & 4
  let offlineCard = "";
  const rk = state.round === 3 ? "round3" : "round4";
  if ((state.round === 3 || state.round === 4) && !state.offlineBonusClaimed[rk]) {
    offlineCard = `<div style="border:2px dashed #8e211b;background:#fdf6e7;padding:16px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <div>
        <b style="color:#8e211b;display:block">🎯 OPTIONAL ROOM CHALLENGE (+$15,000 BONUS)</b>
        <span style="font-size:11px;color:#555">Complete the live offline challenge to claim +$15,000 bonus.</span>
      </div>
      <button data-action="claim-offline-bonus" style="background:#8e211b;border-color:#8e211b;white-space:nowrap">CLAIM $15,000 BONUS</button>
    </div>`;
  } else if ((state.round === 3 || state.round === 4) && state.offlineBonusClaimed[rk]) {
    offlineCard = `<div style="background:#23652c;color:#fff;padding:12px 18px;font:700 12px 'DM Mono',monospace;letter-spacing:.05em;margin-bottom:14px">🎯 OFFLINE ROOM BONUS CLAIMED · +$15,000 CREDITED</div>`;
  }

  const rows = subDepartments.map(name => {
    const val = Number(alloc[name] ?? 0);
    return `<tr>
      <td>
        <strong>${name}</strong>
        <small style="display:block;color:var(--muted);font-size:9px">${name} operations & subsystem capital</small>
      </td>
      <td style="font-size:10px;color:var(--muted)">Minimum $100, multiples of $100</td>
      <td class="allocation-input-cell">
        <span style="font-weight:bold">$</span>
        <input id="alloc-${name.replaceAll(" ", "-")}" type="number" min="100" max="${currentCap}" step="100" value="${val}" data-allocation="${name}" ${investmentUnlocked ? "" : "disabled"} style="width:110px;text-align:right;padding:8px;font-weight:bold;">
      </td>
    </tr>`;
  }).join("");

  return `<div class="live-label">● LIVE MARKET DASHBOARD · ROUND ${String(state.round).padStart(2, "0")} OF 04</div>
  ${shellHeading(`${esc(state.industry.toUpperCase())} INDUSTRY`, `ROUND ${state.round} DASHBOARD`)}
  
  ${grantBanner}
  ${offlineCard}

  <!-- TOP METRICS STRIP -->
  <div class="market-tape" style="grid-template-columns: repeat(4, 1fr); margin-bottom: 20px;">
    <div>
      <small>TOTAL CAPITAL BALANCE</small>
      <b style="font-size: 18px; color: var(--green);">${money(currentCap)}</b>
    </div>
    <div>
      <small>LEADERBOARD RANK</small>
      <b style="font-size: 18px; color: var(--red);">${rankInfo.rank} <span style="font-size:10px;font-weight:normal;color:var(--muted)">of ${rankInfo.total} teams</span></b>
    </div>
    <div>
      <small>ROUND PROGRESS</small>
      <b>ROUND ${state.round} / 4</b>
    </div>
    <div>
      <small>SELECTED INDUSTRY</small>
      <b>${esc(state.industry)}</b>
    </div>
  </div>

  <!-- SECTION 1: INSTRUCTIONS -->
  <section class="analysis-card" style="margin-bottom: 20px; border-left: 4px solid var(--red); background: #fbf7ec;">
    <span class="article-label" style="color: var(--red);">📋 ROUND INSTRUCTIONS & RULES</span>
    <h3 style="margin: 8px 0 12px;">HOW TO PLAY THIS ROUND</h3>
    <ol style="font-size: 12px; line-height: 1.8; margin: 0; padding-left: 20px;">
      <li><b>Read the Storyline Flash</b>: Complete the <b>5-Minute Story Flash</b>. You will return to this dashboard automatically.</li>
      <li><b>Download Dataset</b>: Download the provided CSV dataset file for Round ${state.round} using the download button below.</li>
      <li><b>Strategic Investment</b>: Invest dollar amounts in multiples of $100 into all 5 sub-departments (Production, Marketing, Logistics, R&D, HR). Any unallocated funds will be held safely in Cash.</li>
      <li><b>Lock & Submit</b>: Click <b>LOCK & SUBMIT ROUND INVESTMENTS</b> when ready!</li>
    </ol>
  </section>

  <!-- SECTION 2: STORYLINE FLASH LAUNCHER (GUARANTEED OPENING) -->
  <section style="border: 2px solid var(--red); background: #fdf2f0; padding: 20px; margin-bottom: 24px; text-align: center;">
    <span class="article-label" style="color: var(--red); font-size: 11px;">📰 MANDATORY STORYLINE FLASH · ROUND ${state.round}</span>
    <h2 style="font-family: 'Playfair Display', serif; font-size: 24px; margin: 10px 0 6px;">${esc(currentEvent.headline)}</h2>
    <p style="font-size: 13px; color: #555; max-width: 700px; margin: 0 auto 16px;">${esc(currentEvent.subheadline)}</p>
    <button data-action="open-flash" ${flashComplete ? "disabled" : ""} style="background: var(--red); border-color: var(--red); color: white; padding: 16px 32px; font-size: 13px; letter-spacing: .12em; box-shadow: 0 4px 12px rgba(142,33,27,0.3); cursor: pointer;">
      ${flashComplete ? `✓ ROUND ${state.round} FLASH COMPLETED` : `⚡ READ ROUND ${state.round} STORY FLASH (5 MIN LOCK TIMER)`}
    </button>
  </section>

  <!-- SECTION 3: DOWNLOADABLE DATASET FILE BUTTON -->
  <section class="analysis-card" style="margin-bottom: 24px; text-align: center; padding: 24px;">
    <span class="article-label">ROUND ${state.round} DATASET FILE</span>
    <h3 style="margin: 8px 0 10px;">${esc(state.industry.toUpperCase())} QUARTERLY DATASET</h3>
    <p style="font-size: 12px; color: var(--muted); margin-bottom: 16px;">Download the Round ${state.round} dataset file. The organizers can replace this downloadable CSV with the provided official dataset.</p>
    <button data-action="download-dataset" ${flashComplete ? "" : "disabled"} style="background: var(--ink); color: var(--paper); padding: 14px 28px; font-size: 12px; letter-spacing: .1em;">
      ${datasetDownloaded ? `✓ DATASET DOWNLOADED · DOWNLOAD AGAIN` : `📥 DOWNLOAD ROUND ${state.round} DATASET (.CSV)`}
    </button>
    ${flashComplete ? "" : `<p class="error" style="font-size:11px;margin:12px 0 0;">Complete the storyline flash to unlock the dataset.</p>`}
  </section>

  <!-- SECTION 4: CAPITAL ALLOCATION FORM (IN MULTIPLES OF $100) -->
  <section class="allocation-section">
    <div class="article-label">INVESTMENT ALLOCATION DESK</div>
    <h2>INVESTMENT IN SUB-DEPARTMENTS ($ AMOUNT)</h2>
    <p class="allocation-intro">${investmentRuleText} Unallocated funds automatically remain as Cash.</p>
    
    <div class="table-scroll">
      <table class="alloc-table">
        <thead>
          <tr>
            <th>Sub-Department / Sector</th>
            <th>Rule</th>
            <th class="align-right">Investment ($ Amount)</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>

    <!-- LIVE CAPITAL TICKER SUMMARY -->
    <div style="background:#e9e1cf; border:1px solid var(--ink); padding:16px; margin:16px 0; font-family:'DM Mono',monospace; font-size:12px;">
      <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
        <span>STARTING CAPITAL BALANCE:</span>
        <b>${money(currentCap)}</b>
      </div>
      <div style="display:flex; justify-content:space-between; margin-bottom:6px; color:var(--red);">
        <span>TOTAL INVESTED IN SUBSYSTEMS:</span>
        <b>-${money(totalInvested)}</b>
      </div>
      <div style="display:flex; justify-content:space-between; border-top:1px solid var(--rule); padding-top:6px; font-size:14px; font-weight:bold; color:var(--green);">
        <span>REMAINING UNALLOCATED CASH RESERVE:</span>
        <b>${money(remainingCash)}</b>
      </div>
    </div>

    <div id="allocationTotal" class="total ${valid ? "valid" : "invalid"}" style="font-size:13px;">
      ${roundSubmitted
      ? `✓ ROUND ${state.round} INVESTMENTS ALREADY SUBMITTED`
      : !flashComplete
        ? `🔒 COMPLETE THE STORYLINE FLASH TO CONTINUE`
        : !datasetDownloaded
          ? `🔒 DOWNLOAD THE ROUND ${state.round} DATASET TO UNLOCK INVESTMENTS`
          : valid
            ? `✅ ALLOCATIONS VALID · $${totalInvested.toLocaleString()} INVESTED, $${remainingCash.toLocaleString()} CASH RESERVE`
            : `❌ INVALID ALLOCATION · ${investmentRuleText.toUpperCase()} TOTAL CANNOT EXCEED BALANCE ($${currentCap.toLocaleString()})`}
    </div>

    <button id="submitAllocation" data-action="submit-round" ${valid && investmentUnlocked ? "" : "disabled"} style="width: 100%; padding: 16px; font-size: 13px; margin-top: 12px;">
      🔒 LOCK & SUBMIT ROUND ${state.round} INVESTMENTS ➔
    </button>
  </section>`;
}

/* ── 4. ROUND RESULTS VIEW ───────────────────────────────── */
function renderResults() {
  const result = state.history.at(-1);
  if (!result) {
    return `${shellHeading("RESULTS", "NO ROUND CLOSED YET")}
    <button data-action="nav" data-page="game">RETURN TO DASHBOARD ➔</button>`;
  }

  const rows = subDepartments.map(name => `<tr>
    <td><b>${name}</b></td>
    <td>${money(result.investedAmounts?.[name] || 0)}</td>
    <td><b style="color:var(--red);">${(result.multipliers?.[name] || 1).toFixed(2)}x</b></td>
    <td><b>${money(result.departmentRevenues?.[name] || 0)}</b></td>
  </tr>`).join("");

  const rankInfo = getTeamRank(state.teamId);

  return `${shellHeading(`ROUND ${String(result.round).padStart(2, "0")} CLOSE`, "INVESTMENT RESULTS & REVENUE")}
  ${companyValueChart()}

  <section class="results-card">
    <div class="article-label">${esc(state.industry || "INDUSTRY")} PERFORMANCE REPORT</div>
    <h2>ROUND ${result.round} FINANCIAL CLOSE</h2>
    <div class="result-highlight">
      <span>NET CAPITAL CHANGE: ${money(result.previousValue)} → ${money(result.newValue)}</span>
      <strong>${money(result.newValue)}</strong>
      <span style="margin-top:8px;font-weight:bold;color:var(--red)">CURRENT LEADERBOARD RANK: ${rankInfo.rank} of ${rankInfo.total} Teams</span>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Sub-Department</th>
            <th>Invested Amount ($)</th>
            <th>Flash Multiplier</th>
            <th>Generated Revenue ($)</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr style="background:#ded3bd; font-weight:bold;">
            <td>Cash Reserve (Unallocated)</td>
            <td>${money(result.cashReserve || 0)}</td>
            <td>${(result.cashMultiplier ?? result.multipliers?.Cash ?? 1).toFixed(2)}x</td>
            <td>${money(result.cashRevenue ?? result.cashReserve ?? 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div style="margin-top: 24px; text-align: center;">
      ${result.round < 4 ? `
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
      <td><b style="font-size:14px;color:var(--green);">${money(t.companyValue || 100000)}</b></td>
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

/* ── Allocation Validation (Multiples of $100) ───────────── */
function allocationValid() {
  const a = state.allocations;
  const currentCap = state.companyValue;
  const totalInvested = subDepartments.reduce((sum, d) => sum + Number(a[d] || 0), 0);

  // Validation rules:
  // 1. Every subsystem must receive a positive amount in multiples of 100
  const allSubsystemsFundedInHundreds = subDepartments.every(n => {
    const val = Number(a[n] || 0);
    return Number.isFinite(val) && val >= 100 && val % 100 === 0;
  });

  // 2. Total invested cannot exceed total available capital balance
  const withinBalance = totalInvested <= currentCap;

  return allSubsystemsFundedInHundreds && withinBalance;
}

/* ── Close Round & Revenue Calculation ──────────────────── */
function closeRound() {
  const roundReady = state.flashCompletedRounds?.[state.round]
    && state.datasetDownloadedRounds?.[state.round];
  const roundAlreadySubmitted = state.history.some(result => result.round === state.round);
  if (!allocationValid() || !roundReady || roundAlreadySubmitted) return;
  const ev = events.find(e => e.round === state.round) || events[0];
  const ind = state.industry || "Pharma";
  const flashMults = ev.flashMultipliers[ind] || {};
  const startingBal = state.companyValue;
  const alloc = state.allocations;

  const investedAmounts = {};
  let totalInvestedInSubsystems = 0;
  subDepartments.forEach(name => {
    const amt = Number(alloc[name] || 0);
    investedAmounts[name] = amt;
    totalInvestedInSubsystems += amt;
  });

  // Remaining unallocated balance is scored with the flash's Cash multiplier.
  const cashReserve = startingBal - totalInvestedInSubsystems;

  // Penalty modifier (set to 1.0)
  const penaltyModifier = 1.0;

  // revenue = Σ(investment_i × flashMultiplier_i) × penaltyModifier
  const deptRevenues = {};
  let grossRevenueFromInvestments = 0;
  subDepartments.forEach(name => {
    const mult = flashMults[name] || 1.0;
    const rev = investedAmounts[name] * mult * penaltyModifier;
    deptRevenues[name] = rev;
    grossRevenueFromInvestments += rev;
  });

  const cashMultiplier = flashMults.Cash ?? 1.0;
  const cashRevenue = cashReserve * cashMultiplier;

  // new_balance = subsystem revenue + multiplier-adjusted cash reserve
  const newBalance = cashRevenue + grossRevenueFromInvestments;

  state.history.push({
    round: state.round,
    allocations: { ...alloc },
    investedAmounts,
    cashReserve,
    cashMultiplier,
    cashRevenue,
    multipliers: flashMults,
    departmentRevenues: deptRevenues,
    previousValue: startingBal,
    newValue: newBalance,
    change: ((newBalance - startingBal) / startingBal) * 100,
    headline: ev.headline
  });

  state.companyValue = newBalance;
  save();
  showPage("results");
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
    const effectiveNow = saved.pausedAt || Date.now();
    const remaining = saved.startedAt + (saved.duration || EVENT_DURATION_MS) - effectiveNow;
    if (remaining <= 0) {
      localStorage.removeItem(eventStorageKey());
      state.flashCompletedRounds = {
        ...state.flashCompletedRounds,
        [ev.round]: true
      };
      state.page = "game";
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
    document.querySelector("#eventCategory").textContent = event.category;
    document.querySelector("#eventHeadline").textContent = event.headline;
    document.querySelector("#eventSubheadline").textContent = event.subheadline;
    const content = document.querySelector("#eventContent");
    content.replaceChildren();
    event.content.split(/\n\n+/).forEach(txt => {
      const p = document.createElement("p");
      p.className = "event-story";
      p.textContent = txt.trim();
      content.append(p);
    });
    document.querySelector("#eventDepartments").textContent = event.affectedDepartments.join(", ");
    document.querySelector("#eventEffect").textContent = "Read the story carefully to deduce high-multiplier sub-sections!";
    try {
      mountMiniGame(document.querySelector("#eventMiniGame"), miniGamesByEvent[event.id] || miniGamesByEvent["flash-1"], event.id);
    } catch (error) {
      console.error("Mini game failed to load, keeping flash open:", error);
      const miniGame = document.querySelector("#eventMiniGame");
      if (miniGame) miniGame.innerHTML = `<section class="mini-game"><div class="mini-game-head"><span class="article-label">PUZZLE UNAVAILABLE</span><span class="puzzle-status">FLASH TIMER STILL RUNNING</span></div><p class="mini-game-prompt">Continue reading the flash. The story lock remains active.</p></section>`;
    }
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
  if (state.flashCompletedRounds?.[ev.round]) return;

  const durationMs = (ev.duration || 300) * 1000;
  state.page = "game";
  localStorage.setItem(eventStorageKey(), JSON.stringify({ id: ev.id, startedAt: Date.now(), duration: durationMs }));
  save();
  renderedEventId = null;
  syncEventOverlay();
}

function bypassActiveFlash() {
  try {
    const saved = JSON.parse(localStorage.getItem(eventStorageKey()) || "null");
    const ev = saved && events.find(item => item.id === saved.id);
    if (!ev) return;

    localStorage.removeItem(eventStorageKey());
    state.flashCompletedRounds = {
      ...state.flashCompletedRounds,
      [ev.round]: true
    };
    state.page = "game";
    save();
    syncEventOverlay();
  } catch {
    localStorage.removeItem(eventStorageKey());
    syncEventOverlay();
  }
}

function pauseActiveEvent() {
  try {
    const saved = JSON.parse(localStorage.getItem(eventStorageKey()) || "null");
    if (!saved || saved.pausedAt) return;
    saved.pausedAt = Date.now();
    localStorage.setItem(eventStorageKey(), JSON.stringify(saved));
  } catch {
    localStorage.removeItem(eventStorageKey());
  }
}

function resumeActiveEvent() {
  try {
    const saved = JSON.parse(localStorage.getItem(eventStorageKey()) || "null");
    if (!saved?.pausedAt) return;
    saved.startedAt += Date.now() - saved.pausedAt;
    delete saved.pausedAt;
    localStorage.setItem(eventStorageKey(), JSON.stringify(saved));
  } catch {
    localStorage.removeItem(eventStorageKey());
  }
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
    pauseActiveEvent();
    coverFlashContent(true);
  } else {
    resumeActiveEvent();
    coverFlashContent(false);
    syncEventOverlay();
  }
});
window.addEventListener("blur", () => {
  pauseActiveEvent();
  coverFlashContent(true);
});
window.addEventListener("focus", () => {
  if (document.hidden) return;
  resumeActiveEvent();
  coverFlashContent(false);
  syncEventOverlay();
});
document.addEventListener("keydown", event => {
  if (!activeEvent() || event.key !== "PrintScreen") return;
  event.preventDefault();
  coverFlashContent(true);
  setTimeout(() => {
    if (!document.hidden && document.hasFocus()) coverFlashContent(false);
  }, 1200);
}, true);

/* ── Global Event Delegation ─────────────────────────────── */
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

  if (act === "bypass-flash") {
    bypassActiveFlash();
    return;
  }

  // Download Dataset CSV
  if (act === "download-dataset") {
    downloadDatasetCSV();
    return;
  }

  // Submit Allocations
  if (act === "submit-round") {
    closeRound();
    return;
  }

  // Round progression
  if (act === "next-round") {
    state.round += 1;
    save();
    showPage("game");
    return;
  }

  if (act === "refresh-leaderboard") {
    render();
    return;
  }

  if (act === "claim-offline-bonus") {
    const rk = state.round === 3 ? "round3" : "round4";
    if (!state.offlineBonusClaimed[rk]) {
      state.companyValue += 15000;
      state.offlineBonusClaimed[rk] = true;
      save();
      render();
    }
    return;
  }
});

// Form submission handler
document.addEventListener("submit", event => {
  if (event.target.id !== "loginForm") return;
  event.preventDefault();
  const teamId = new FormData(event.target).get("teamId").trim() || "Team Alpha";

  if (timer) { clearInterval(timer); timer = null; }
  renderedEventId = null;
  document.body.classList.remove("anti-cheat-cover");

  if (state.teamId) save();
  localStorage.setItem("data-tycoon-active-team", teamSlug(teamId));
  const savedTeam = localStorage.getItem(teamStateKey(teamId));
  state = savedTeam ? readState(teamStateKey(teamId)) : structuredClone(defaults);
  state.teamId = teamId;
  state.page = savedTeam ? (state.page || "industries") : "industries";
  save();
  showPage(state.page);
  syncEventOverlay();
});

// Input change handler for dollar investments (multiples of $100)
document.addEventListener("input", event => {
  const an = event.target.dataset.allocation;
  if (an) {
    state.allocations[an] = event.target.value === "" ? 0 : Number(event.target.value);
    save();
    const currentCap = state.companyValue;
    const totalInvested = subDepartments.reduce((sum, d) => sum + Number(state.allocations[d] || 0), 0);
    const remainingCash = currentCap - totalInvested;
    const v = allocationValid();
    const roundReady = Boolean(state.flashCompletedRounds?.[state.round]
      && state.datasetDownloadedRounds?.[state.round]);
    const roundSubmitted = state.history.some(result => result.round === state.round);

    const msg = document.querySelector("#allocationTotal");
    if (msg) {
      if (roundSubmitted) {
        msg.textContent = `✓ ROUND ${state.round} INVESTMENTS ALREADY SUBMITTED`;
        msg.className = "total valid";
      } else if (!state.flashCompletedRounds?.[state.round]) {
        msg.textContent = "🔒 COMPLETE THE STORYLINE FLASH TO CONTINUE";
        msg.className = "total invalid";
      } else if (!state.datasetDownloadedRounds?.[state.round]) {
        msg.textContent = `🔒 DOWNLOAD THE ROUND ${state.round} DATASET TO UNLOCK INVESTMENTS`;
        msg.className = "total invalid";
      } else if (v) {
        msg.textContent = `✅ ALLOCATIONS VALID · $${totalInvested.toLocaleString()} INVESTED, $${remainingCash.toLocaleString()} CASH RESERVE`;
        msg.className = "total valid";
      } else {
        msg.textContent = `❌ INVALID ALLOCATION · ${investmentRuleText.toUpperCase()} TOTAL CANNOT EXCEED BALANCE ($${currentCap.toLocaleString()})`;
        msg.className = "total invalid";
      }
    }
    const sub = document.querySelector("#submitAllocation");
    if (sub) sub.disabled = !v || !roundReady || roundSubmitted;
  }
});

/* ── Boot Initializer ────────────────────────────────────── */
if (!state.page) state = { ...defaults };
render();
syncEventOverlay();
