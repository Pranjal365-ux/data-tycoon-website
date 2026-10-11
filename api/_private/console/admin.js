const TOKEN_KEY = "dt-organizer-session";
const CONSOLE_KEY = location.pathname.split("/").filter(Boolean)[0] || "";
const REFRESH_MS = 3000;
const REQUEST_TIMEOUT_MS = 10000;

const $ = selector => document.querySelector(selector);
const money = value => {
  const amount = Math.round(Number(value) || 0);
  return `${amount < 0 ? "-" : ""}₹${Math.abs(amount).toLocaleString("en-IN")}`;
};
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const ALERT_LABELS = {
  "screenshot-shortcut": "Screenshot key",
  "screenshot-suspected": "Screenshot shortcut",
  "print-attempt": "Print attempt",
  "devtools-shortcut": "Developer tools",
  "tab-hidden": "Left the tab",
  "window-blur": "Left the window",
  "focus-return": "Came back"
};

let refreshTimer = null;
let refreshBusy = false;
let settings = null;
let teams = [];
let lastTeams = "";
let lastActivities = "";
let seenAlerts = new Set();

const token = () => sessionStorage.getItem(TOKEN_KEY) || "";

async function api(path, { method = "GET", body } = {}) {
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

function message(text, tone = "") {
  const el = $("#dashboardMessage");
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
["#activityKind", "#activityIndustryFilter", "#activityFilter"].forEach(id => $(id).addEventListener("change", () => { lastActivities = ""; refresh(); }));
$("#industryFilter").addEventListener("change", () => { lastTeams = ""; renderTeams(teams); });

function renderSettings(next) {
  settings = next;
  const flash = next.flashTimer.enabled;
  $("#flashTimerStatus").textContent = flash ? "On · 5-minute lock" : "Off · players close it";
  $("#flashTimerStatus").classList.toggle("off", !flash);
  $("#flashTimerDescription").textContent = flash
    ? "Players must keep the flash open for five minutes. Turning it off lets them close it straight away."
    : "Players close the flash when they are done. Turning it on starts a fresh five-minute lock for any open flash.";
  $("#flashTimerToggle").textContent = flash ? "Turn timer off" : "Turn timer on";
  $("#flashTimerToggle").disabled = false;
  const wait = next.roundWait.enabled;
  $("#roundWaitStatus").textContent = wait ? "On · 30 minutes" : "Off · next round opens at once";
  $("#roundWaitStatus").classList.toggle("off", !wait);
  $("#roundWaitDescription").textContent = wait
    ? "Teams wait 30 minutes after submitting before the next round opens."
    : "Teams can start the next round as soon as they submit.";
  $("#roundWaitToggle").textContent = wait ? "Remove the wait" : "Turn the wait on";
  $("#roundWaitToggle").disabled = false;
}

async function toggleSetting(button, field) {
  if (!settings) return;
  const enabled = !settings[field].enabled;
  button.disabled = true;
  try {
    renderSettings(await api("/admin/settings", { method: "PATCH", body: { [field]: enabled } }));
    message(field === "flashTimer"
      ? (enabled ? "Flash timer on. Open flashes restart a five-minute countdown." : "Flash timer off. Players can close flashes now.")
      : (enabled ? "Round wait on." : "Round wait removed. Waiting teams can move on now."), "good");
  } catch (error) {
    message(error.message, "bad");
    button.disabled = false;
  }
}

$("#flashTimerToggle").addEventListener("click", event => toggleSetting(event.currentTarget, "flashTimer"));
$("#roundWaitToggle").addEventListener("click", event => toggleSetting(event.currentTarget, "roundWait"));

function renderIndustryOptions(capacity) {
  for (const [id, withSeats] of [["#industryFilter", true], ["#activityIndustryFilter", false]]) {
    const select = $(id);
    const selected = select.value;
    select.innerHTML = `<option value="">All industries</option>${capacity.map(item => `<option value="${esc(item.industry)}">${esc(item.industry)}${withSeats ? ` · ${item.assigned}/${item.capacity} teams` : ""}</option>`).join("")}`;
    select.value = [...select.options].some(option => option.value === selected) ? selected : "";
  }
}

function renderTeams(next) {
  teams = next;
  const snapshot = `${JSON.stringify(next)}|${$("#industryFilter").value}`;
  const editing = $("#teamsBody").contains(document.activeElement) && document.activeElement.matches("input");
  if (snapshot === lastTeams || editing) return;
  lastTeams = snapshot;

  const teamSelect = $("#activityFilter");
  const selectedTeam = teamSelect.value;
  teamSelect.innerHTML = `<option value="">All teams</option>${next.map(team => `<option value="${esc(team.teamId)}">${esc(team.teamId)}</option>`).join("")}`;
  teamSelect.value = [...teamSelect.options].some(option => option.value === selectedTeam) ? selectedTeam : "";

  $("#teamCount").textContent = next.length;
  $("#onlineCount").textContent = next.filter(team => team.online).length;
  $("#combinedBalance").textContent = money(next.reduce((sum, team) => sum + team.companyValue, 0));

  const filter = $("#industryFilter").value;
  const visible = filter ? next.filter(team => team.industry === filter) : next;
  if (!visible.length) {
    $("#teamsBody").innerHTML = `<tr><td colspan="7" class="empty">No teams yet.</td></tr>`;
    return;
  }
  $("#teamsBody").innerHTML = visible.map((team, index) => `<tr>
    <td class="rank">${index + 1}</td>
    <td class="team-name">${esc(team.teamId)}${team.hasPin ? "" : ' <span class="tag">PIN reset</span>'}</td>
    <td>${esc(team.industry || "Not chosen")}</td>
    <td>${team.isEliminated ? '<span class="tag bad">Out</span>' : `Round ${team.round}${team.submitted ? " · submitted" : ""}`}</td>
    <td><span class="status ${team.online ? "online" : ""}">${team.online ? "Online" : "Offline"}</span></td>
    <td class="num">${money(team.companyValue)}</td>
    <td class="actions">
      <form class="money-form" data-key="${esc(team.key)}" data-name="${esc(team.teamId)}"><input aria-label="New balance for ${esc(team.teamId)}" type="number" min="0" step="1" value="${team.companyValue}" required><button class="button" type="submit">Set</button></form>
      <button class="button button-quiet" type="button" data-reset="${esc(team.key)}" data-name="${esc(team.teamId)}">Reset PIN</button>
    </td>
  </tr>`).join("");
}

function renderActivities(items) {
  const snapshot = JSON.stringify(items);
  if (snapshot === lastActivities) return;
  const firstLoad = !lastActivities;
  lastActivities = snapshot;
  if (!items.length) {
    $("#activityFeed").innerHTML = `<p class="empty">Nothing reported yet.</p>`;
    return;
  }
  $("#activityFeed").innerHTML = items.map(item => {
    const id = `${item.timestamp}|${item.teamId}|${item.kind}`;
    const isNew = !firstLoad && !seenAlerts.has(id);
    seenAlerts.add(id);
    const alert = item.kind in ALERT_LABELS && item.kind !== "focus-return";
    const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `<article class="activity-item ${alert ? "alert" : ""} ${isNew ? "new" : ""}">
      <div class="activity-top"><strong>${esc(item.teamId)}</strong><time>${esc(time)}</time></div>
      <div class="activity-kind">${esc(ALERT_LABELS[item.kind] || item.kind)}${item.industry ? ` · ${esc(item.industry)}` : ""} · Round ${esc(item.round)}</div>
      <p>${esc(item.detail)}</p>
    </article>`;
  }).join("");
}

async function refresh() {
  clearTimeout(refreshTimer);
  if (!token() || refreshBusy) return;
  refreshBusy = true;
  try {
    const params = new URLSearchParams({ kind: $("#activityKind").value });
    if ($("#activityFilter").value) params.set("team", $("#activityFilter").value);
    if ($("#activityIndustryFilter").value) params.set("industry", $("#activityIndustryFilter").value);
    const data = await api(`/admin/dashboard?${params}`);
    renderIndustryOptions(data.industryCapacity || []);
    renderTeams(data.teams || []);
    renderActivities(data.activities || []);
    renderSettings(data.settings);
    $("#signalCount").textContent = data.recentAlerts ?? 0;
    setConnection("Live", true);
  } catch (error) {
    setConnection("Reconnecting…", false);
    if (token()) message(error.message, "bad");
  } finally {
    refreshBusy = false;
    if (token()) refreshTimer = setTimeout(refresh, document.hidden ? REFRESH_MS * 3 : REFRESH_MS);
  }
}

$("#teamsBody").addEventListener("submit", async event => {
  const form = event.target.closest("form[data-key]");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button");
  const amount = Number(form.querySelector("input").value);
  if (!confirm(`Set ${form.dataset.name}'s balance to ${money(amount)}?`)) return;
  button.disabled = true;
  try {
    await api("/admin/team-balance", { method: "PATCH", body: { teamKey: form.dataset.key, companyValue: amount } });
    message(`${form.dataset.name}'s balance is now ${money(amount)}.`, "good");
    document.activeElement?.blur();
    lastTeams = "";
    await refresh();
  } catch (error) {
    message(error.message, "bad");
  } finally {
    button.disabled = false;
  }
});

$("#teamsBody").addEventListener("click", async event => {
  const button = event.target.closest("button[data-reset]");
  if (!button) return;
  if (!confirm(`Reset ${button.dataset.name}'s PIN? Every device signed in as this team is signed out, and the next PIN entered becomes the team's new PIN.`)) return;
  button.disabled = true;
  try {
    await api("/admin/team-reset-pin", { method: "POST", body: { teamKey: button.dataset.reset } });
    message(`${button.dataset.name}'s PIN was reset. Ask the team to sign in again now with a new PIN.`, "good");
    lastTeams = "";
    await refresh();
  } catch (error) {
    message(error.message, "bad");
    button.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setConnection(token() ? "Connecting…" : "Signed out", true);
setSignedIn(Boolean(token()));
