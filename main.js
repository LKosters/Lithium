const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");

// ── Paths ──────────────────────────────────────────────
const DATA_DIR = path.join(os.homedir(), ".synthcode");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ── Resolve claude binary ──────────────────────────────
const CLAUDE_BIN = (() => {
  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".npm-global/bin/claude"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "claude";
})();

// ── Config (recent dirs) ───────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { recentDirs: [] };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function addRecentDir(dir) {
  const config = loadConfig();
  config.recentDirs = [dir, ...config.recentDirs.filter((d) => d !== dir)].slice(0, 10);
  saveConfig(config);
  return config.recentDirs;
}

// ── Session persistence ────────────────────────────────
function loadAllSessions() {
  ensureDirs();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function saveSession(session) {
  ensureDirs();
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${session.id}.json`),
    JSON.stringify(session, null, 2)
  );
}

function deleteSession(sessionId) {
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── PTY processes ──────────────────────────────────────
const ptyProcesses = new Map();

function spawnSession(sessionId, cwd, resume) {
  if (ptyProcesses.has(sessionId)) return;

  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.CLAUDECODE;

  const args = [];
  if (resume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  const proc = pty.spawn(CLAUDE_BIN, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env,
  });

  ptyProcesses.set(sessionId, proc);
  const spawnTime = Date.now();

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty:data", { sessionId, data });
    }
  });

  proc.onExit(({ exitCode }) => {
    ptyProcesses.delete(sessionId);
    const lifetime = Date.now() - spawnTime;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty:exit", { sessionId, exitCode, resume, lifetime });
    }
  });
}

function killSession(sessionId) {
  const proc = ptyProcesses.get(sessionId);
  if (proc) {
    proc.kill();
    ptyProcesses.delete(sessionId);
  }
}

// ── Window ─────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0C0B09",
    icon: path.join(__dirname, "public", "logo.png"),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "src", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
    for (const [, proc] of ptyProcesses) proc.kill();
    ptyProcesses.clear();
  });
}

// ── IPC ────────────────────────────────────────────────
ipcMain.on("pty:input", (_e, { sessionId, data }) => {
  const proc = ptyProcesses.get(sessionId);
  if (proc) proc.write(data);
});

ipcMain.on("pty:resize", (_e, { sessionId, cols, rows }) => {
  const proc = ptyProcesses.get(sessionId);
  if (proc) {
    try { proc.resize(cols, rows); } catch {}
  }
});

ipcMain.on("pty:spawn", (_e, { sessionId, cwd, resume }) => {
  spawnSession(sessionId, cwd, resume);
});

ipcMain.on("pty:kill", (_e, { sessionId }) => {
  killSession(sessionId);
});

ipcMain.handle("sessions:list", () => loadAllSessions());
ipcMain.on("sessions:save", (_e, session) => saveSession(session));
ipcMain.on("sessions:delete", (_e, sessionId) => deleteSession(sessionId));

ipcMain.handle("directory:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const dir = result.filePaths[0];
  const recents = addRecentDir(dir);
  const config = loadConfig();
  return { dir, recents, starred: config.starredDirs || [] };
});

ipcMain.handle("directory:recents", () => {
  const config = loadConfig();
  return { recents: config.recentDirs || [], starred: config.starredDirs || [] };
});

ipcMain.on("directory:add-recent", (_e, dir) => addRecentDir(dir));

ipcMain.handle("music:list", () => {
  const musicDir = path.join(__dirname, "music");
  try {
    return fs.readdirSync(musicDir)
      .filter((f) => /\.(mp3|m4a|ogg|wav|flac)$/i.test(f))
      .map((f) => ({ name: f.replace(/\.[^.]+$/, ""), path: path.join(musicDir, f) }));
  } catch {
    return [];
  }
});

// ── System media (Now Playing) ──────────────────────────
const { execFile } = require("child_process");

function runOsaAsync(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script], { timeout: 3000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

// Single JXA script that detects the active media app and returns all info as JSON
const NOW_PLAYING_SCRIPT = `
var apps = Application("System Events").processes().map(p => p.name());
var result = null;

if (apps.indexOf("Spotify") !== -1) {
  try {
    var sp = Application("Spotify");
    var st = sp.playerState();
    if (st === "playing" || st === "paused") {
      var t = sp.currentTrack;
      result = JSON.stringify({
        title: t.name() + (t.artist() ? " \\u2014 " + t.artist() : ""),
        duration: t.duration() / 1000,
        position: sp.playerPosition(),
        playing: st === "playing",
        app: "Spotify"
      });
    }
  } catch(e) {}
}

if (!result && apps.indexOf("Music") !== -1) {
  try {
    var mu = Application("Music");
    var st = mu.playerState();
    if (st === "playing" || st === "paused") {
      var t = mu.currentTrack;
      result = JSON.stringify({
        title: t.name() + (t.artist() ? " \\u2014 " + t.artist() : ""),
        duration: t.duration(),
        position: mu.playerPosition(),
        playing: st === "playing",
        app: "Music"
      });
    }
  } catch(e) {}
}

result || "null";
`;

let _nowPlayingCache = { data: null, ts: 0 };

ipcMain.handle("media:now-playing", async () => {
  // Debounce: skip if last poll was <800ms ago
  const now = Date.now();
  if (now - _nowPlayingCache.ts < 800) return _nowPlayingCache.data;

  const raw = await runOsaAsync(NOW_PLAYING_SCRIPT);
  let data = null;
  if (raw && raw !== "null") {
    try { data = JSON.parse(raw); } catch {}
  }
  _nowPlayingCache = { data, ts: Date.now() };
  return data;
});

ipcMain.handle("media:control", async (_e, { action, position }) => {
  // Build a single JXA script for the control action
  const script = `
    var apps = Application("System Events").processes().map(function(p){return p.name()});
    var done = false;
    var targets = ["Spotify", "Music"];
    for (var i = 0; i < targets.length; i++) {
      if (apps.indexOf(targets[i]) === -1) continue;
      try {
        var a = Application(targets[i]);
        var st = a.playerState();
        if (st !== "playing" && st !== "paused") continue;
        ${action === "toggle" ? "a.playpause();" : ""}
        ${action === "next" ? "a.nextTrack();" : ""}
        ${action === "prev" ? "a.previousTrack();" : ""}
        ${action === "seek" ? `a.playerPosition = ${position || 0};` : ""}
        done = true; break;
      } catch(e) {}
    }
    done;
  `;
  const result = await runOsaAsync(script);
  return result === "true";
});

ipcMain.on("directory:toggle-star", (_e, dir) => {
  const config = loadConfig();
  if (!config.starredDirs) config.starredDirs = [];
  const idx = config.starredDirs.indexOf(dir);
  if (idx >= 0) config.starredDirs.splice(idx, 1);
  else config.starredDirs.push(dir);
  saveConfig(config);
});

// ── Lifecycle ──────────────────────────────────────────
app.whenReady().then(() => {
  ensureDirs();
  if (process.platform === "darwin" && app.dock) {
    const icon = nativeImage.createFromPath(path.join(__dirname, "public", "logo.png"));
    app.dock.setIcon(icon);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const [, proc] of ptyProcesses) proc.kill();
  ptyProcesses.clear();
  if (process.platform !== "darwin") app.quit();
});
