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
let refreshBusy = false;
let refreshTimer = null;
let lastTeamsSnapshot = "";
let lastActivitiesSnapshot = "";

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

function renderTeams(teams) {
  const snapshot = JSON.stringify(teams);
  if (snapshot === lastTeamsSnapshot) return;
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

  if (!teams.length) {
    teamsBody.innerHTML = `<tr><td colspan="7" class="empty">No teams have connected yet.</td></tr>`;
    return;
  }

  teamsBody.innerHTML = teams.map((team, index) => `<tr>
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
  const signalKinds = new Set(["screenshot-shortcut", "window-blur", "tab-hidden", "clipboard-shortcut"]);
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  const recentSignals = items.filter(item => signalKinds.has(item.kind) && Date.parse(item.timestamp) >= tenMinutesAgo).length;
  document.querySelector("#signalCount").textContent = recentSignals;
  if (!items.length) {
    activityFeed.innerHTML = `<p class="empty">No activity has been reported yet.</p>`;
    return;
  }
  activityFeed.innerHTML = items.map(item => {
    const alert = signalKinds.has(item.kind);
    const time = Date.parse(item.timestamp);
    const timeText = Number.isFinite(time) ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    return `<article class="activity-item ${alert ? "alert" : ""}">
      <div class="activity-top"><span class="activity-team">${escapeHtml(item.teamId || "Team")}</span><time class="activity-time">${escapeHtml(timeText)}</time></div>
      <span class="activity-kind">${escapeHtml(item.kind || "activity")}</span>
      <p class="activity-detail">${escapeHtml(item.detail || "")}</p>
    </article>`;
  }).join("");
}

async function refreshDashboard() {
  if (!getToken() || refreshBusy) return;
  refreshBusy = true;
  try {
    const [teams, activities] = await Promise.all([
      api("/admin/teams"),
      api(`/admin/activities${activityFilter.value ? `?teamId=${encodeURIComponent(activityFilter.value)}` : ""}`)
    ]);
    renderTeams(teams);
    renderActivities(activities);
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
