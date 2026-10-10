const TOKEN_KEY = "data-tycoon-organizer-session";
const host = location.hostname.toLowerCase();
const localPage = location.protocol === "file:" || host === "localhost" || host === "127.0.0.1" || host === "[::1]";
const fallbackApi = localPage ? "http://127.0.0.1:8000/api" : `${location.origin}/api`;
const API_BASE = String(window.DATA_TYCOON_API_BASE || fallbackApi).replace(/\/$/, "");
const loginPanel = document.querySelector("#loginPanel");
const dashboard = document.querySelector("#dashboard");
const loginForm = document.querySelector("#adminLoginForm");
const loginError = document.querySelector("#loginError");
const dashboardError = document.querySelector("#dashboardError");
const connectionState = document.querySelector("#connectionState");
const teamsBody = document.querySelector("#teamsBody");
const activityFeed = document.querySelector("#activityFeed");
const activityFilter = document.querySelector("#activityFilter");
const industryFilter = document.querySelector("#industryFilter");
const flashTimerStatus = document.querySelector("#flashTimerStatus");
const flashTimerDescription = document.querySelector("#flashTimerDescription");
const flashTimerToggle = document.querySelector("#flashTimerToggle");
let refreshBusy = false;
let refreshTimer = null;
let lastTeamsSnapshot = "";
let lastActivitiesSnapshot = "";
let flashTimerEnabled = null;
let currentTeams = [];

const money = amount => `₹${Math.round(Number(amount) || 0).toLocaleString("en-IN")}`;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const getToken = () => sessionStorage.getItem(TOKEN_KEY) || "";

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers
    },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && getToken()) signOut();
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function setSignedIn(signedIn) {
  loginPanel.hidden = signedIn;
  dashboard.hidden = !signedIn;
  if (signedIn) refreshDashboard();
  else if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

function signOut() {
  sessionStorage.removeItem(TOKEN_KEY);
  setSignedIn(false);
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  button.disabled = true;
  loginError.textContent = "";
  try {
    const response = await fetch(`${API_BASE}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.querySelector("#adminPassword").value })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Organizer sign-in failed.");
    sessionStorage.setItem(TOKEN_KEY, payload.token);
    document.querySelector("#adminPassword").value = "";
    setSignedIn(true);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logoutButton").addEventListener("click", signOut);
document.querySelector("#refreshButton").addEventListener("click", refreshDashboard);
activityFilter.addEventListener("change", refreshDashboard);
industryFilter.addEventListener("change", () => { lastTeamsSnapshot = ""; renderTeams(currentTeams); });

function renderFlashTimer(setting) {
  if (typeof setting?.enabled !== "boolean") return;
  flashTimerEnabled = setting.enabled;
  flashTimerStatus.textContent = flashTimerEnabled ? "ON · FIVE-MINUTE LOCK" : "OFF · MANUAL CLOSE";
  flashTimerStatus.classList.toggle("off", !flashTimerEnabled);
  flashTimerDescription.textContent = flashTimerEnabled
    ? "Players are timed while reading a flash. Turning this off lets them close it manually."
    : "Players can read each flash and close it manually. Turn the five-minute lock back on whenever needed.";
  flashTimerToggle.textContent = flashTimerEnabled ? "TURN TIMER OFF" : "TURN TIMER ON";
  flashTimerToggle.setAttribute("aria-pressed", String(flashTimerEnabled));
  flashTimerToggle.disabled = false;
}

flashTimerToggle.addEventListener("click", async () => {
  if (typeof flashTimerEnabled !== "boolean") return;
  flashTimerToggle.disabled = true;
  dashboardError.textContent = "";
  try {
    const setting = await api("/admin/settings/flash-timer", {
      method: "PATCH",
      body: JSON.stringify({ enabled: !flashTimerEnabled })
    });
    renderFlashTimer(setting);
    dashboardError.textContent = setting.enabled
      ? "Flash timer enabled. Open flashes will start a fresh five-minute countdown."
      : "Flash timer disabled. Players can close open flashes manually.";
  } catch (error) {
    dashboardError.textContent = error.message;
  } finally {
    flashTimerToggle.disabled = false;
  }
});

function renderIndustryOptions(capacity = []) {
  const selected = industryFilter.value;
  industryFilter.innerHTML = `<option value="">All industries</option>${capacity.map(item => `<option value="${escapeHtml(item.industry)}">${escapeHtml(item.industry)} · ${Number(item.remaining) || 0} seats left</option>`).join("")}`;
  if ([...industryFilter.options].some(option => option.value === selected)) industryFilter.value = selected;
}

function renderTeams(teams, force = false) {
  currentTeams = teams;
  const snapshot = `${JSON.stringify(teams)}|${industryFilter.value}`;
  if (!force && snapshot === lastTeamsSnapshot) return;
  // Polling runs every two seconds; don't replace the row while an organizer is typing,
  // or their input and cursor disappear before they can apply the new balance.
  const focusedInput = teamsBody.contains(document.activeElement)
    && document.activeElement.matches(".money-form input");
  if (focusedInput) return;
  lastTeamsSnapshot = snapshot;

  const selectedFilter = activityFilter.value;
  activityFilter.innerHTML = `<option value="">All teams</option>${teams.map(team => `<option value="${escapeHtml(team.teamId)}">${escapeHtml(team.teamId)}</option>`).join("")}`;
  if ([...activityFilter.options].some(option => option.value === selectedFilter)) activityFilter.value = selectedFilter;
  document.querySelector("#teamCount").textContent = teams.length;
  document.querySelector("#onlineCount").textContent = teams.filter(team => team.online).length;
  document.querySelector("#combinedBalance").textContent = money(teams.reduce((sum, team) => sum + Number(team.companyValue || 0), 0));

  const visibleTeams = industryFilter.value ? teams.filter(team => team.industry === industryFilter.value) : teams;
  if (!visibleTeams.length) {
    teamsBody.innerHTML = `<tr><td colspan="7" class="empty">No teams have connected yet.</td></tr>`;
    return;
  }

  teamsBody.innerHTML = visibleTeams.map((team, index) => `<tr>
    <td class="rank">${index + 1}</td>
    <td class="team-name">${escapeHtml(team.teamId)}</td>
    <td>${escapeHtml(team.industry || "—")}</td>
    <td>${team.isEliminated ? "Eliminated" : `Flash ${Number(team.round || 1)} / 4`}</td>
    <td><strong>${money(team.companyValue)}</strong></td>
    <td><span class="status ${team.online ? "online" : ""}">${team.online ? "ONLINE" : "OFFLINE"}</span></td>
    <td><form class="money-form" data-team="${escapeHtml(team.teamId)}"><input aria-label="New balance for ${escapeHtml(team.teamId)}" type="number" min="0" step="1" value="${Math.round(Number(team.companyValue) || 0)}" required><button type="submit">APPLY</button></form></td>
  </tr>`).join("");
}

function renderActivities(items) {
  const snapshot = JSON.stringify(items);
  if (snapshot === lastActivitiesSnapshot) return;
  lastActivitiesSnapshot = snapshot;
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  const recentSignals = items.filter(item => item.kind === "window-blur" && Date.parse(item.timestamp) >= tenMinutesAgo).length;
  document.querySelector("#signalCount").textContent = recentSignals;
  if (!items.length) {
    activityFeed.innerHTML = `<p class="empty">No activity has been reported yet.</p>`;
    return;
  }
  activityFeed.innerHTML = items.map(item => {
    const alert = item.kind === "window-blur";
    const time = Date.parse(item.timestamp);
    const timeText = Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    return `<article class="activity-item ${alert ? "alert" : ""}">
      <div class="activity-top"><span class="activity-team">${escapeHtml(item.teamId || "Team")}</span><time class="activity-time">${escapeHtml(timeText)}</time></div>
      <span class="activity-kind">${alert ? "Screenshot" : escapeHtml(item.kind || "activity")}</span>
      <p class="activity-detail">${escapeHtml(item.detail || "")}</p>
    </article>`;
  }).join("");
}

async function refreshDashboard() {
  if (!getToken() || refreshBusy) return;
  refreshBusy = true;
  try {
    const dashboard = await api(`/admin/dashboard${activityFilter.value ? `?teamId=${encodeURIComponent(activityFilter.value)}` : ""}`);
    renderIndustryOptions(dashboard.industryCapacity || []);
    renderTeams(dashboard.teams || []);
    renderActivities(dashboard.activities || []);
    renderFlashTimer(dashboard.flashTimer);
    connectionState.textContent = "LIVE";
    connectionState.classList.remove("offline");
    dashboardError.textContent = "";
  } catch (error) {
    connectionState.textContent = "RECONNECTING";
    connectionState.classList.add("offline");
    dashboardError.textContent = `${error.message} (API: ${API_BASE})`;
  } finally {
    refreshBusy = false;
    if (getToken()) refreshTimer = setTimeout(refreshDashboard, 2000);
  }
}

teamsBody.addEventListener("submit", async event => {
  const form = event.target.closest("form[data-team]");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button");
  const input = form.querySelector("input");
  button.disabled = true;
  try {
    await api(`/admin/teams/${encodeURIComponent(form.dataset.team)}/money`, {
      method: "PATCH",
      body: JSON.stringify({ companyValue: Number(input.value) })
    });
    dashboardError.textContent = `Updated ${form.dataset.team}'s balance.`;
    await refreshDashboard();
  } catch (error) {
    dashboardError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

fetch(`${API_BASE}/health`, { cache: "no-store" })
  .then(response => { if (!response.ok) throw new Error(); connectionState.textContent = "API READY"; })
  .catch(() => {
    connectionState.textContent = "API OFFLINE";
    connectionState.classList.add("offline");
    loginError.textContent = `Cannot reach ${API_BASE}. Start the Data Tycoon server with “python server.py” and reload this page.`;
  });

setSignedIn(Boolean(getToken()));
