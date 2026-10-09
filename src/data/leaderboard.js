const LEADERBOARD_KEY = "data-tycoon-leaderboard-v2";

export function getLeaderboard() {
  try {
    const stored = JSON.parse(localStorage.getItem(LEADERBOARD_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter(team => team && typeof team.teamId === "string") : [];
  } catch {
    return [];
  }
}

export function saveLeaderboard(data) {
  localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(data));
}

export function replaceLeaderboard(data) {
  const current = Array.isArray(data) ? data.filter(team => team && typeof team.teamId === "string") : [];
  current.sort((a, b) => (Number(b.companyValue) || 0) - (Number(a.companyValue) || 0)
    || a.teamId.localeCompare(b.teamId, undefined, { sensitivity: "base" }));
  saveLeaderboard(current);
  return current;
}

export function updateTeamInLeaderboard(teamRecord) {
  const current = getLeaderboard();
  const index = current.findIndex(t => t.teamId.toLowerCase() === String(teamRecord.teamId).toLowerCase());
  if (index >= 0) {
    current[index] = { ...current[index], ...teamRecord, lastUpdated: Date.now() };
  } else {
    current.push({ ...teamRecord, lastUpdated: Date.now() });
  }
  // Sort descending by companyValue (net balance)
  current.sort((a, b) => (b.companyValue || 0) - (a.companyValue || 0));
  saveLeaderboard(current);
  return current;
}

export function getTeamRank(teamId) {
  if (!teamId) return { rank: "-", total: 0 };
  const board = getLeaderboard();
  const index = board.findIndex(t => t.teamId.toLowerCase() === String(teamId).toLowerCase());
  if (index === -1) return { rank: "-", total: board.length || 1 };
  return { rank: `#${index + 1}`, total: board.length };
}

export function clearLeaderboard() {
  localStorage.removeItem(LEADERBOARD_KEY);
}
