const TOKEN_KEY = "dt-organizer-session";
const CONSOLE_KEY = location.pathname.split("/").filter(Boolean)[0] || "";
const REFRESH_MS = 3000;
const REQUEST_TIMEOUT_MS = 20000;

const $ = selector => document.querySelector(selector);
const money = value => {
  const amount = Math.round(Number(value) || 0);
  return `${amount < 0 ? "-" : ""}₹${Math.abs(amount).toLocaleString("en-IN")}`;
};
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const pad = value => String(value).padStart(2, "0");
const ALERT_LABELS = {
  "screenshot-shortcut": "Screenshot key",
  "screenshot-suspected": "Screenshot shortcut",
  "print-attempt": "Print attempt",
  "devtools-shortcut": "Developer tools",
  "tab-hidden": "Left the tab",
  "window-blur": "Left the window",
  "focus-return": "Came back"
};
const FLASH_LABELS = { "not-opened": "Not opened", reading: "Reading", expired: "Time up", read: "Read" };

let refreshTimer = null;
let refreshBusy = false;
let settings = null;
let rounds = 4;
let industries = [];
let teams = [];
let lastTeams = "";
let lastActivities = "";
let seenAlerts = new Set();
let openTeamKey = "";
let lastCreated = [];

const token = () => sessionStorage.getItem(TOKEN_KEY) || "";

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${pad(minutes)}:${pad(total % 60)}`;
}

async function api(path, { method = "GET", body, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Console-Key": CONSOLE_KEY,
        ...(token() ? { Authorization: `Bearer ${token()}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal
    });
    if (raw && response.ok) return response;
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && token()) signOut();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The server took too long to respond.");
    if (error instanceof TypeError) throw new Error("Could not reach the server.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function message(text, tone = "", target = "#dashboardMessage") {
  const el = $(target);
  if (!el) return;
  el.textContent = text;
  el.className = `message ${tone}`;
}

function setConnection(text, ok) {
  const el = $("#connectionState");
  el.textContent = text;
  el.classList.toggle("offline", !ok);
}

function setSignedIn(signedIn) {
  $("#loginPanel").hidden = signedIn;
  $("#dashboard").hidden = !signedIn;
  $("#logoutButton").hidden = !signedIn;
  clearTimeout(refreshTimer);
  if (signedIn) refresh();
}

function signOut() {
  sessionStorage.removeItem(TOKEN_KEY);
  setSignedIn(false);
}

$("#adminLoginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  $("#loginError").textContent = "";
  try {
    const result = await api("/admin/login", { method: "POST", body: { password: $("#adminPassword").value } });
    sessionStorage.setItem(TOKEN_KEY, result.token);
    $("#adminPassword").value = "";
    setSignedIn(true);
  } catch (error) {
    $("#loginError").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#logoutButton").addEventListener("click", signOut);
$("#refreshButton").addEventListener("click", () => { lastTeams = ""; lastActivities = ""; refresh(); });
["#activityKind", "#activityIndustryFilter", "#activityFilter"].forEach(id => $(id).addEventListener("change", () => { lastActivities = ""; refresh(); }));
["#industryFilter", "#statusFilter"].forEach(id => $(id).addEventListener("change", () => { lastTeams = ""; renderTeams(teams); }));
$("#teamSearch").addEventListener("input", () => { lastTeams = ""; renderTeams(teams); });

async function run(button, task, success) {
  if (button) button.disabled = true;
  try {
    const result = await task();
    if (success) message(typeof success === "function" ? success(result) : success, "good");
    lastTeams = "";
    await refresh();
    return result;
  } catch (error) {
    message(error.message, "bad");
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

/* ── Game control ──────────────────────────────────────────── */
function isEditing(selector) {
  return document.activeElement?.matches?.(selector);
}

function renderSettings(next) {
  settings = next;
  const r = next.rounds;
  const open = r.open;
  const current = teams.filter(team => team.round === open && !team.isEliminated);
  const submitted = current.filter(team => team.submitted).length;
  const active = teams.filter(team => !team.isEliminated).length;
  $("#gameStatus").textContent = r.paused ? "PAUSED" : open === 0 ? "NOT STARTED" : `ROUND ${open} OF ${rounds} OPEN`;
  $("#gameStatus").className = `game-status ${r.paused ? "paused" : open ? "live" : ""}`;
  $("#roundTrack").innerHTML = Array.from({ length: rounds }, (_, index) => {
    const n = index + 1;
    const on = teams.filter(team => team.round === n);
    const done = on.filter(team => team.submitted).length;
    const reading = on.filter(team => team.flash === "reading").length;
    const state = n <= open ? "open" : r.scheduledRound === n ? "scheduled" : "closed";
    const opened = r.openedAt?.[n] ? new Date(r.openedAt[n]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="round-step ${state}">
      <span class="round-step-name">Round ${n}</span>
      <b>${state === "open" ? "Open" : state === "scheduled" ? `Opens in <span data-schedule-countdown>${formatDuration(r.scheduledAt - Date.now())}</span>` : "Not open"}</b>
      <small>${on.length} team${on.length === 1 ? "" : "s"} here · ${reading} reading · ${done} submitted${opened ? ` · opened ${opened}` : ""}</small>
    </div>`;
  }).join("");

  const nextRound = open + 1;
  const openButton = $("#openNextButton");
  openButton.hidden = nextRound > rounds;
  openButton.textContent = open === 0 ? "START ROUND 1" : `OPEN ROUND ${nextRound}`;
  $("#closeRoundButton").hidden = open === 0;
  $("#closeRoundButton").textContent = `CLOSE ROUND ${open}`;
  $("#openHint").textContent = open === 0
    ? `Teams can sign in and pick an industry now. Nobody can open a flash until you start Round 1. ${active} team${active === 1 ? "" : "s"} ready.`
    : nextRound > rounds
      ? `All ${rounds} rounds are open. ${submitted} of ${current.length} teams on Round ${open} have submitted.`
      : `${submitted} of ${current.length} teams on Round ${open} have submitted. Teams move to Round ${nextRound} only after you open it.`;
  $("#scheduleButton").disabled = nextRound > rounds;
  const scheduleStatus = $("#scheduleStatus");
  scheduleStatus.hidden = !r.scheduledRound;
  if (r.scheduledRound) {
    const at = new Date(r.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    scheduleStatus.innerHTML = `Round ${r.scheduledRound} opens automatically at ${esc(at)} (in <b data-schedule-countdown>${formatDuration(r.scheduledAt - Date.now())}</b>). <button type="button" class="link-button" id="cancelSchedule">Cancel</button>`;
  }
  if (!isEditing("#waitMinutes")) $("#waitMinutes").value = r.waitMinutes;

  const flash = next.flashTimer;
  if (!isEditing("#flashMinutes")) $("#flashMinutes").value = flash.minutes;
  $("#flashTimerDescription").textContent = flash.enabled
    ? `On: a flash stays open for ${flash.minutes} minute${flash.minutes === 1 ? "" : "s"}, then closes for good.`
    : "Off: teams read at their own pace and close the flash themselves. Each flash can still be opened only once.";
  $("#flashTimerToggle").textContent = flash.enabled ? "TURN TIMER OFF" : "TURN TIMER ON";
  $("#flashTimerToggle").classList.toggle("on", flash.enabled);
  $("#pauseButton").textContent = r.paused ? "RESUME GAME" : "PAUSE GAME";
  $("#pauseButton").classList.toggle("button-danger", !r.paused);
  $("#pauseButton").classList.toggle("button-primary", r.paused);
  $("#announcementNow").textContent = next.announcement.text ? `Showing now: “${next.announcement.text}”` : "No announcement is showing.";
}

async function patchSettings(button, body, success) {
  return run(button, () => api("/admin/settings", { method: "PATCH", body }), success);
}

$("#openNextButton").addEventListener("click", event => {
  const next = settings.rounds.open + 1;
  if (!confirm(`Open Round ${next} now? Teams can start it straight away.`)) return;
  patchSettings(event.currentTarget, { openRound: next }, `Round ${next} is open.`);
});
$("#closeRoundButton").addEventListener("click", event => {
  const open = settings.rounds.open;
  if (!confirm(`Close Round ${open}? Teams that have not opened its flash yet will be told to wait. Teams already in it keep playing.`)) return;
  patchSettings(event.currentTarget, { openRound: open - 1 }, `Round ${open} is closed again.`);
});
$("#scheduleButton").addEventListener("click", event => {
  const minutes = Number($("#scheduleMinutes").value);
  const next = settings.rounds.open + 1;
  patchSettings(event.currentTarget, { schedule: { round: next, minutes } }, `Round ${next} will open in ${minutes} minute${minutes === 1 ? "" : "s"}. Teams see the countdown.`);
});
document.addEventListener("click", event => {
  if (event.target.id === "cancelSchedule") patchSettings(event.target, { schedule: null }, "Schedule cancelled.");
});
$("#waitButton").addEventListener("click", event => {
  const minutes = Number($("#waitMinutes").value);
  patchSettings(event.currentTarget, { waitMinutes: minutes }, minutes ? `Teams now wait ${minutes} minutes after submitting.` : "No wait after submitting.");
});
$("#flashTimerToggle").addEventListener("click", event => {
  const enabled = !settings.flashTimer.enabled;
  patchSettings(event.currentTarget, { flashTimer: enabled }, enabled ? "Flash timer on. Any open flash restarts its countdown." : "Flash timer off. Teams close flashes themselves.");
});
$("#flashMinutesButton").addEventListener("click", event => {
  const minutes = Number($("#flashMinutes").value);
  patchSettings(event.currentTarget, { flashMinutes: minutes }, `Flash timer length set to ${minutes} minutes.`);
});
$("#pauseButton").addEventListener("click", event => {
  const paused = !settings.rounds.paused;
  if (paused && !confirm("Pause the game? Teams cannot open flashes, submit or move on until you resume.")) return;
  patchSettings(event.currentTarget, { paused }, paused ? "Game paused." : "Game resumed.");
});
$("#announceButton").addEventListener("click", event => {
  const text = $("#announcementText").value.trim();
  if (!text) return message("Type the announcement first.", "bad");
  patchSettings(event.currentTarget, { announcement: text }, "Announcement sent to every team.").then(result => { if (result) $("#announcementText").value = ""; });
});
$("#announceClear").addEventListener("click", event => patchSettings(event.currentTarget, { announcement: "" }, "Announcement cleared."));

/* ── Teams table ───────────────────────────────────────────── */
function renderIndustryOptions(capacity) {
  for (const [id, withSeats] of [["#industryFilter", true], ["#activityIndustryFilter", false]]) {
    const select = $(id);
    const selected = select.value;
    select.innerHTML = `<option value="">All industries</option>${capacity.map(item => `<option value="${esc(item.industry)}">${esc(item.industry)}${withSeats ? ` · ${item.assigned}/${item.capacity} teams` : ""}</option>`).join("")}`;
    select.value = [...select.options].some(option => option.value === selected) ? selected : "";
  }
}

function matchesStatus(team, status) {
  switch (status) {
    case "online": return team.online;
    case "offline": return !team.online;
    case "reading": return team.flash === "reading";
    case "submitted": return team.submitted;
    case "not-submitted": return !team.submitted && !team.finished;
    case "alerts": return team.alerts > 0;
    case "no-industry": return !team.industry;
    case "out": return team.isEliminated;
    default: return true;
  }
}

function lastSeen(team) {
  if (team.online) return "ONLINE";
  if (team.lastSeenSeconds === null) return "NEVER SIGNED IN";
  const s = team.lastSeenSeconds;
  return s < 3600 ? `SEEN ${Math.max(1, Math.round(s / 60))} MIN AGO` : `SEEN ${Math.round(s / 3600)} H AGO`;
}

function renderTeams(next) {
  teams = next;
  const query = $("#teamSearch").value.trim().toLowerCase();
  const filter = $("#industryFilter").value;
  const status = $("#statusFilter").value;
  const snapshot = `${JSON.stringify(next)}|${query}|${filter}|${status}`;
  if (snapshot === lastTeams) return;
  lastTeams = snapshot;

  const teamSelect = $("#activityFilter");
  const selectedTeam = teamSelect.value;
  teamSelect.innerHTML = `<option value="">All teams</option>${next.map(team => `<option value="${esc(team.teamId)}">${esc(team.teamId)}</option>`).join("")}`;
  teamSelect.value = [...teamSelect.options].some(option => option.value === selectedTeam) ? selectedTeam : "";

  $("#teamCount").textContent = next.length;
  $("#onlineCount").textContent = next.filter(team => team.online).length;
  $("#combinedBalance").textContent = money(next.reduce((sum, team) => sum + team.companyValue, 0));

  const visible = next
    .map((team, index) => ({ ...team, rank: index + 1 }))
    .filter(team => (!filter || team.industry === filter) && (!query || team.teamId.toLowerCase().includes(query)) && matchesStatus(team, status));
  $("#teamFilterCount").textContent = visible.length === next.length ? `${next.length} teams` : `${visible.length} of ${next.length} teams`;
  if (!visible.length) {
    $("#teamsBody").innerHTML = `<tr><td colspan="10" class="empty">${next.length ? "No team matches this search." : "No teams yet. Use + Add teams to create them."}</td></tr>`;
    return;
  }
  $("#teamsBody").innerHTML = visible.map(team => `<tr class="${team.isEliminated ? "out" : ""}">
    <td class="rank">${team.rank}</td>
    <td class="team-name"><button type="button" class="link-button team-link" data-manage="${esc(team.key)}">${esc(team.teamId)}</button>${team.notice ? '<span class="tag">MESSAGE</span>' : ""}</td>
    <td>${esc(team.industry || "-")}</td>
    <td>${team.isEliminated ? "Disqualified" : team.finished ? "Finished" : `Round ${team.round}${team.submitted ? " · submitted" : ""}`}</td>
    <td><span class="pill flash-${team.flash}">${FLASH_LABELS[team.flash] || team.flash}</span></td>
    <td>${team.dataset ? "Yes" : "-"}</td>
    <td><strong>${money(team.companyValue)}</strong></td>
    <td><span class="status ${team.online ? "online" : ""}">${lastSeen(team)}</span></td>
    <td>${team.alerts ? `<span class="alert-count">${team.alerts}</span>` : "-"}</td>
    <td><button type="button" class="button-secondary small-button" data-manage="${esc(team.key)}">MANAGE</button></td>
  </tr>`).join("");
}

$("#teamsBody").addEventListener("click", event => {
  const button = event.target.closest("[data-manage]");
  if (button) openTeam(button.dataset.manage);
});

/* ── Activity feed ─────────────────────────────────────────── */
function renderActivityItems(items, firstLoad) {
  return items.map(item => {
    const id = `${item.timestamp}|${item.teamId}|${item.kind}`;
    const isNew = !firstLoad && !seenAlerts.has(id);
    seenAlerts.add(id);
    const alert = item.kind in ALERT_LABELS && item.kind !== "focus-return";
    const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const label = ALERT_LABELS[item.kind] || item.kind.replace(/^organizer-/, "organizer · ").replace(/-/g, " ");
    return `<article class="activity-item ${alert ? "alert" : ""} ${item.actor === "organizer" ? "by-organizer" : ""} ${isNew ? "new" : ""}">
      <div class="activity-top"><span class="activity-team">${esc(item.teamId || "Whole game")}</span><time class="activity-time">${esc(time)}</time></div>
      <span class="activity-kind">${esc(label)}${item.industry ? ` · ${esc(item.industry)}` : ""}${item.round ? ` · Round ${esc(item.round)}` : ""}</span>
      <p class="activity-detail">${esc(item.detail)}</p>
    </article>`;
  }).join("");
}

function renderActivities(items) {
  const snapshot = JSON.stringify(items);
  if (snapshot === lastActivities) return;
  const firstLoad = !lastActivities;
  lastActivities = snapshot;
  $("#activityFeed").innerHTML = items.length ? renderActivityItems(items, firstLoad) : `<p class="empty">Nothing to show yet.</p>`;
}

/* ── Refresh loop ──────────────────────────────────────────── */
async function refresh() {
  clearTimeout(refreshTimer);
  if (!token() || refreshBusy) return;
  refreshBusy = true;
  try {
    const params = new URLSearchParams({ kind: $("#activityKind").value });
    if ($("#activityFilter").value) params.set("team", $("#activityFilter").value);
    if ($("#activityIndustryFilter").value) params.set("industry", $("#activityIndustryFilter").value);
    const data = await api(`/admin/dashboard?${params}`);
    rounds = data.rounds || 4;
    industries = data.industries || industries;
    renderIndustryOptions(data.industryCapacity || []);
    renderTeams(data.teams || []);
    renderSettings(data.settings);
    renderActivities(data.activities || []);
    $("#signalCount").textContent = data.recentAlerts ?? 0;
    setConnection("LIVE", true);
    if (openTeamKey && $("#teamDialog").open) loadTeam(openTeamKey, true);
  } catch (error) {
    setConnection("RECONNECTING", false);
    if (token()) message(error.message, "bad");
  } finally {
    refreshBusy = false;
    if (token()) refreshTimer = setTimeout(refresh, document.hidden ? REFRESH_MS * 3 : REFRESH_MS);
  }
}

setInterval(() => {
  if (!settings?.rounds.scheduledRound) return;
  const left = settings.rounds.scheduledAt - Date.now();
  document.querySelectorAll("[data-schedule-countdown]").forEach(el => { el.textContent = formatDuration(left); });
}, 1000);

/* ── Add teams ─────────────────────────────────────────────── */
function parseLines(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [teamId = "", pin = "", industry = ""] = line.split(",").map(part => part.trim());
    return { teamId, pin, industry };
  });
}

function showAddInput() {
  $("#addInput").hidden = false;
  $("#addResult").hidden = true;
}

$("#addTeamsButton").addEventListener("click", () => {
  showAddInput();
  $("#addDialog").showModal();
  $("#addLines").focus();
});
$("#addMore").addEventListener("click", () => { $("#addLines").value = ""; showAddInput(); });
$("#bulkFill").addEventListener("click", () => {
  const count = Math.max(1, Math.min(200, Number($("#bulkCount").value) || 0));
  const prefix = $("#bulkPrefix").value;
  const width = String(count).length < 2 ? 2 : String(count).length;
  $("#addLines").value = Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(width, "0")}`).join("\n");
});
$("#addSubmit").addEventListener("click", async event => {
  const rows = parseLines($("#addLines").value);
  if (!rows.length) return alert("Add at least one team name.");
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "CREATING…";
  try {
    // Small batches keep each request well inside the hosting time limit.
    const result = { created: [], skipped: [] };
    for (let start = 0; start < rows.length; start += 25) {
      button.textContent = `CREATING ${Math.min(start + 25, rows.length)} / ${rows.length}…`;
      const part = await api("/admin/teams", { method: "POST", body: { teams: rows.slice(start, start + 25) } });
      result.created.push(...part.created);
      result.skipped.push(...part.skipped);
    }
    lastCreated = result.created;
    $("#addSummary").textContent = `${result.created.length} team${result.created.length === 1 ? "" : "s"} created. Download or print the PINs now and hand one card to each team.`;
    $("#addResultBody").innerHTML = result.created.map(row => `<tr><td>${esc(row.teamId)}</td><td class="pin-text">${esc(row.pin)}</td><td>${esc(row.industry || "Team chooses")}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">No new teams.</td></tr>`;
    $("#addSkipped").innerHTML = result.skipped.length ? `<b>Not created:</b> ${result.skipped.map(row => `${esc(row.teamId || "(blank)")}: ${esc(row.reason)}`).join("; ")}` : "";
    $("#addInput").hidden = true;
    $("#addResult").hidden = false;
    lastTeams = "";
    refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "CREATE TEAMS";
  }
});

function downloadText(text, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

const csvCell = value => {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

$("#addDownload").addEventListener("click", () => {
  const lines = [["Team name", "PIN", "Industry"], ...lastCreated.map(row => [row.teamId, row.pin, row.industry || ""])];
  downloadText(lines.map(line => line.map(csvCell).join(",")).join("\n"), "data-tycoon-new-team-pins.csv");
});

function printCards(rows) {
  const site = location.origin;
  $("#printCards").innerHTML = rows.map(row => `<article class="print-card">
    <p class="print-brand">DATA TYCOON · TECHTATVA '26</p>
    <p class="print-label">Team name</p><p class="print-value">${esc(row.teamId)}</p>
    <p class="print-label">Team PIN</p><p class="print-value pin">${esc(row.pin)}</p>
    <p class="print-site">Sign in at ${esc(site)}<br>One laptop per team. Keep this card private.</p>
  </article>`).join("");
  document.body.classList.add("printing-cards");
  window.print();
  setTimeout(() => document.body.classList.remove("printing-cards"), 500);
}
$("#addPrint").addEventListener("click", () => printCards(lastCreated));

async function downloadExport(button, kind, filename) {
  await run(button, async () => {
    const response = await api(`/admin/export/${kind}`, { raw: true });
    downloadText(await response.text(), filename);
  }, "Download started.");
}
$("#exportPins").addEventListener("click", event => downloadExport(event.currentTarget, "credentials", "data-tycoon-team-pins.csv"));
$("#exportResults").addEventListener("click", event => downloadExport(event.currentTarget, "results", "data-tycoon-results.csv"));

/* ── Manage one team ───────────────────────────────────────── */
let teamDetail = null;

function openTeam(key) {
  openTeamKey = key;
  teamDetail = null;
  $("#tdMessage").textContent = "";
  $("#tdPin").textContent = "••••••";
  $("#tdPin").dataset.shown = "";
  ["#tdRename", "#tdNewPin", "#tdNotice"].forEach(id => { $(id).value = ""; });
  $("#teamDialog").showModal();
  loadTeam(key, false);
}

async function loadTeam(key, quiet) {
  try {
    const detail = await api(`/admin/team?key=${encodeURIComponent(key)}`);
    if (key !== openTeamKey) return;
    renderTeamDetail(detail, quiet);
  } catch (error) {
    if (!quiet) message(error.message, "bad", "#tdMessage");
  }
}

function renderTeamDetail(team, quiet) {
  teamDetail = team;
  $("#tdEyebrow").textContent = `#${teams.findIndex(row => row.key === team.key) + 1 || "-"} · ${team.online ? "ONLINE" : lastSeen(team)}`;
  $("#tdName").textContent = team.teamId;
  $("#tdFacts").innerHTML = [
    ["Industry", team.industry || "Not chosen"],
    ["Round", team.isEliminated ? "Disqualified" : team.finished ? "Finished" : `Round ${team.round}${team.submitted ? " (submitted)" : ""}`],
    ["Balance", money(team.companyValue)],
    ["Flash", FLASH_LABELS[team.flash] || team.flash],
    ["Data", team.dataset ? "Downloaded" : "Not yet"],
    ["Alerts", String(team.alerts)]
  ].map(([label, value]) => `<div><span>${label}</span><b>${esc(value)}</b></div>`).join("");
  const flashText = {
    "not-opened": `Has not opened the Round ${team.round} flash yet.`,
    reading: `Reading the Round ${team.round} flash now${team.flashRemainingMs ? ` (${formatDuration(team.flashRemainingMs)} left)` : ""}.`,
    expired: "The flash time ran out.",
    read: `Has read the Round ${team.round} flash. Re-enable it to let them open it once more (fresh timer).`
  }[team.flash] || "";
  $("#tdFlashState").textContent = `${flashText}${team.notice ? ` Message showing: “${team.notice}”.` : ""}`;
  if (!document.activeElement?.matches?.("#tdBalance")) $("#tdBalance").value = team.companyValue;
  if (!document.activeElement?.matches?.("#tdRound")) $("#tdRound").value = String(team.round);
  if (!document.activeElement?.matches?.("#tdIndustry")) {
    $("#tdIndustry").innerHTML = `<option value="">No industry</option>${industries.map(name => `<option ${name === team.industry ? "selected" : ""}>${esc(name)}</option>`).join("")}`;
  }
  if ($("#tdPin").dataset.shown) $("#tdPin").textContent = team.pin || "Unknown (set a new PIN)";
  $("#tdEliminate").textContent = team.isEliminated ? "REINSTATE" : "DISQUALIFY";
  $("#tdHistory").innerHTML = team.history.length
    ? team.history.map(item => `<tr><td>Round ${item.round}</td><td>${money(item.budget)}</td><td>${money(item.payout)}</td><td class="${item.netProfit >= 0 ? "up" : "down"}">${item.netProfit >= 0 ? "+" : ""}${money(item.netProfit)}</td><td>${item.submittedAt ? new Date(item.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-"}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No rounds submitted yet.</td></tr>`;
  const snapshot = JSON.stringify(team.activities);
  if ($("#tdActivity").dataset.snapshot !== snapshot) {
    $("#tdActivity").dataset.snapshot = snapshot;
    $("#tdActivity").innerHTML = team.activities.length ? renderActivityItems(team.activities.map(item => ({ ...item, teamId: team.teamId })), true) : `<p class="empty">No activity yet.</p>`;
  }
  if (!quiet) $("#tdMessage").textContent = "";
}

$("#tdClose").addEventListener("click", () => $("#teamDialog").close());
$("#teamDialog").addEventListener("close", () => { openTeamKey = ""; teamDetail = null; });
$("#tdShowPin").addEventListener("click", () => {
  const shown = !$("#tdPin").dataset.shown;
  $("#tdPin").dataset.shown = shown ? "1" : "";
  $("#tdPin").textContent = shown ? (teamDetail?.pin || "Unknown (set a new PIN)") : "••••••";
  $("#tdShowPin").textContent = shown ? "hide" : "show";
});

const ACTIONS = {
  "reopen-flash": team => ({ confirm: `Let ${team.teamId} open the Round ${team.round} flash one more time? It starts with a fresh timer.`, done: "Flash re-enabled. The team can open it again now." }),
  "complete-flash": team => ({ confirm: `Mark the Round ${team.round} flash as read for ${team.teamId}? This closes it and unlocks their data.`, done: "Flash marked as read. Data unlocked." }),
  "undo-submission": team => ({ confirm: `Undo ${team.teamId}'s last submission? Their money goes back to what it was before that round and they can submit again.`, done: "Submission undone." }),
  advance: team => ({ confirm: `Move ${team.teamId} to Round ${team.round + 1} now, skipping the wait and round gate?`, done: "Team moved to the next round." }),
  "set-round": team => ({ value: Number($("#tdRound").value), confirm: `Put ${team.teamId} on Round ${$("#tdRound").value}? Their money and history do not change.`, done: "Round changed." }),
  "set-balance": team => ({ value: Number($("#tdBalance").value), confirm: `Set ${team.teamId}'s balance to ${money($("#tdBalance").value)}?`, done: "Balance updated." }),
  "set-pin": team => ({ value: $("#tdNewPin").value.trim() || undefined, confirm: `Give ${team.teamId} a new PIN? Their current device is signed out.`, done: result => `New PIN for ${team.teamId}: ${result.pin}` }),
  "sign-out": team => ({ confirm: `Sign out ${team.teamId}'s device? Their progress is kept; they sign in again with the same PIN.`, done: "Device signed out." }),
  rename: team => ({ value: $("#tdRename").value.trim(), confirm: `Rename ${team.teamId} to “${$("#tdRename").value.trim()}”? They sign in with the new name and the same PIN.`, done: "Team renamed." }),
  "set-industry": team => ({ value: $("#tdIndustry").value, confirm: `Change ${team.teamId}'s industry to ${$("#tdIndustry").value || "none"}?`, done: "Industry changed." }),
  notice: team => ({ value: $("#tdNotice").value.trim(), done: "Message sent to the team." }),
  "notice-clear": () => ({ action: "notice", value: "", done: "Message cleared." }),
  "set-eliminated": team => ({ value: !team.isEliminated, confirm: team.isEliminated ? `Reinstate ${team.teamId}?` : `Disqualify ${team.teamId}? They can no longer play.`, done: team.isEliminated ? "Team reinstated." : "Team disqualified." }),
  delete: team => ({ typed: team.teamId, done: "Team deleted." })
};

$("#teamDialog").addEventListener("click", async event => {
  const button = event.target.closest("[data-act]");
  if (!button || !teamDetail) return;
  const team = teamDetail;
  const spec = ACTIONS[button.dataset.act](team);
  const action = spec.action || button.dataset.act;
  if ((action === "rename" || (action === "notice" && button.dataset.act === "notice")) && !spec.value) {
    return message(action === "rename" ? "Type the new name first." : "Type the message first.", "bad", "#tdMessage");
  }
  if (spec.typed) {
    const typed = prompt(`This permanently deletes ${team.teamId}, their money and history. Type the team name to confirm:`);
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== spec.typed.toLowerCase()) return message("The name did not match. Nothing was deleted.", "bad", "#tdMessage");
  } else if (spec.confirm && !confirm(spec.confirm)) {
    return;
  }
  button.disabled = true;
  try {
    const result = await api("/admin/team-action", { method: "POST", body: { teamKey: team.key, action, ...(spec.value === undefined ? {} : { value: spec.value }) } });
    const done = typeof spec.done === "function" ? spec.done(result) : spec.done;
    message(done, "good", "#tdMessage");
    message(`${team.teamId}: ${done}`, "good");
    if (action === "delete") {
      $("#teamDialog").close();
    } else {
      if (result.key) openTeamKey = result.key;
      if (action === "set-pin") { $("#tdPin").dataset.shown = "1"; $("#tdShowPin").textContent = "hide"; $("#tdNewPin").value = ""; }
      if (action === "rename") $("#tdRename").value = "";
      if (action === "notice") $("#tdNotice").value = "";
      await loadTeam(openTeamKey, true);
    }
    lastTeams = "";
    refresh();
  } catch (error) {
    message(error.message, "bad", "#tdMessage");
  } finally {
    button.disabled = false;
  }
});

/* ── Danger zone ───────────────────────────────────────────── */
async function wipe(button, scope, phrase, warning, done) {
  const typed = prompt(`${warning}\n\nType ${phrase} to confirm:`);
  if (typed === null) return;
  if (typed.trim() !== phrase) return message(`You typed something else. Nothing was deleted.`, "bad");
  await run(button, () => api("/admin/wipe", { method: "POST", body: { scope, confirm: phrase } }), done);
  lastActivities = "";
}
$("#wipeTeams").addEventListener("click", event => wipe(event.currentTarget, "teams", "DELETE TEAMS", "Delete every team, their money, history and the activity log? Round settings stay as they are.", "Every team was deleted."));
$("#wipeAll").addEventListener("click", event => wipe(event.currentTarget, "all", "RESET", "Reset the whole game? Every team, the activity log and all settings are deleted. Rounds close, the timer turns off.", "The game was reset. Add teams to start again."));

/* ── Boot ──────────────────────────────────────────────────── */
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setConnection(token() ? "CONNECTING" : "SIGNED OUT", true);
fetch("/api/health", { cache: "no-store" })
  .then(response => {
    if (!response.ok) throw new Error();
    if (!token()) setConnection("API READY", true);
  })
  .catch(() => {
    setConnection("API OFFLINE", false);
    if (!token()) $("#loginError").textContent = "Cannot reach the event server. Check the deployment and its database, then reload this page.";
  });
setSignedIn(Boolean(token()));
