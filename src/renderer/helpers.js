const os = require("os");
const app = require("./app");

function shortDir(dir) {
  if (!dir) return "Select directory...";
  const home = os.homedir();
  return dir.startsWith(home) ? "~" + dir.slice(home.length) : dir;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

function groupSessionsByDir(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const dir = s.directory || "Unknown";
    if (!map.has(dir)) map.set(dir, []);
    map.get(dir).push(s);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return [...map.entries()].sort((a, b) => b[1][0].updatedAt - a[1][0].updatedAt);
}

function getSession(id) {
  return app.state.sessions.find((s) => s.id === id);
}

function persistSession(s) {
  s.updatedAt = Date.now();
  app.ipcRenderer.send("sessions:save", s);
}

function dirName(dir) {
  if (!dir || dir === "Unknown") return "Unknown";
  const parts = dir.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { shortDir, timeAgo, escapeHtml, dirName, groupSessionsByDir, getSession, persistSession, shuffleArray };
