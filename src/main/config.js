const path = require("path");
const fs = require("fs");
const os = require("os");

const MAX_RECENT_DIRS = 10;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

const DATA_DIR = path.join(os.homedir(), ".synthcode");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LAYOUT_PATH = path.join(DATA_DIR, "layout.json");
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), "lithium-projects");

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ── Config (cached in memory) ────────────────────────
let _configCache = null;

function loadConfig() {
  if (_configCache) return _configCache;
  try {
    _configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    _configCache = { recentDirs: [] };
  }
  return _configCache;
}

function saveConfig(config) {
  _configCache = config;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function isValidSessionId(id) {
  return typeof id === "string" && id.length > 0 && id.length < 256 && SESSION_ID_RE.test(id);
}

function addRecentDir(dir) {
  const config = loadConfig();
  config.recentDirs = [dir, ...config.recentDirs.filter((d) => d !== dir)].slice(0, MAX_RECENT_DIRS);
  saveConfig(config);
  return config.recentDirs;
}

// ── Session persistence ──────────────────────────────
function loadAllSessions() {
  ensureDirs();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
      } catch (err) {
        console.error(`Failed to load session file ${f}:`, err.message);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function saveSession(session) {
  if (!session || !isValidSessionId(session.id)) return;
  ensureDirs();
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${session.id}.json`),
    JSON.stringify(session, null, 2)
  );
}

function deleteSession(sessionId) {
  if (!isValidSessionId(sessionId)) return;
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── Layout state persistence ─────────────────────────
function saveLayoutToDisk(layoutData) {
  try {
    fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layoutData));
  } catch (err) {
    console.error("Failed to save layout to disk:", err.message);
  }
}

function loadLayoutFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(LAYOUT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_PROJECTS_DIR,
  ensureDirs,
  loadConfig,
  saveConfig,
  isValidSessionId,
  addRecentDir,
  loadAllSessions,
  saveSession,
  deleteSession,
  saveLayoutToDisk,
  loadLayoutFromDisk,
};
