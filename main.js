const { app, BrowserWindow, Menu, ipcMain, dialog, nativeImage } = require("electron");
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

function spawnSession(sessionId, cwd, resume, senderWebContents) {
  if (ptyProcesses.has(sessionId)) return;

  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.CLAUDECODE;

  const args = [];
  if (resume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  let proc;
  try {
    proc = pty.spawn(CLAUDE_BIN, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: cwd || os.homedir(),
      env,
    });
  } catch (err) {
    // Binary not found or spawn failed — notify the renderer immediately
    console.error("Failed to spawn PTY:", err.message);
    if (senderWebContents && !senderWebContents.isDestroyed()) {
      senderWebContents.send("pty:data", {
        sessionId,
        data: `\r\n\x1b[31mFailed to start claude: ${err.message}\x1b[0m\r\n` +
              `\x1b[90mLooked for: ${CLAUDE_BIN}\x1b[0m\r\n`,
      });
      senderWebContents.send("pty:exit", { sessionId, exitCode: 1, resume, lifetime: 0 });
    }
    return;
  }

  ptyProcesses.set(sessionId, { proc, webContents: senderWebContents });
  const spawnTime = Date.now();

  proc.onData((data) => {
    if (senderWebContents && !senderWebContents.isDestroyed()) {
      senderWebContents.send("pty:data", { sessionId, data });
    }
  });

  proc.onExit(({ exitCode }) => {
    ptyProcesses.delete(sessionId);
    const lifetime = Date.now() - spawnTime;
    if (senderWebContents && !senderWebContents.isDestroyed()) {
      senderWebContents.send("pty:exit", { sessionId, exitCode, resume, lifetime });
    }
  });
}

function killSession(sessionId) {
  const entry = ptyProcesses.get(sessionId);
  if (entry) {
    entry.proc.kill();
    ptyProcesses.delete(sessionId);
  }
}

// ── Window ─────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0C0B09",
    icon: path.join(__dirname, "public", "icon.png"),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  win.loadFile(path.join(__dirname, "src", "index.html"));

  const wc = win.webContents;
  win.on("closed", () => {
    // Kill PTY processes owned by this window
    for (const [sid, entry] of ptyProcesses) {
      if (entry.webContents === wc) {
        entry.proc.kill();
        ptyProcesses.delete(sid);
      }
    }
    // Kill dev server if running
    killDevServer();
  });

  return win;
}

// ── IPC ────────────────────────────────────────────────
ipcMain.on("pty:input", (_e, { sessionId, data }) => {
  const entry = ptyProcesses.get(sessionId);
  if (entry) entry.proc.write(data);
});

ipcMain.on("pty:resize", (_e, { sessionId, cols, rows }) => {
  const entry = ptyProcesses.get(sessionId);
  if (entry) {
    try { entry.proc.resize(cols, rows); } catch {}
  }
});

ipcMain.on("pty:spawn", (e, { sessionId, cwd, resume }) => {
  spawnSession(sessionId, cwd, resume, e.sender);
});

ipcMain.on("pty:kill", (_e, { sessionId }) => {
  killSession(sessionId);
});

ipcMain.handle("sessions:list", () => loadAllSessions());
ipcMain.on("sessions:save", (_e, session) => saveSession(session));
ipcMain.on("sessions:delete", (_e, sessionId) => deleteSession(sessionId));

ipcMain.handle("directory:pick", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win, {
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

// ── Config get/set (generic key access) ─────────────────
ipcMain.handle("config:get", (_e, key) => loadConfig()[key] ?? null);
ipcMain.on("config:set", (_e, { key, value }) => {
  const c = loadConfig();
  c[key] = value;
  saveConfig(c);
});

// ── Default projects directory ───────────────────────────
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), "lithium-projects");

ipcMain.handle("config:resolve-projects-dir", () => {
  const config = loadConfig();
  // Already set — return it
  if (config.projectsDir) return config.projectsDir;
  // Not set but default folder exists — auto-adopt it
  if (fs.existsSync(DEFAULT_PROJECTS_DIR)) {
    config.projectsDir = DEFAULT_PROJECTS_DIR;
    saveConfig(config);
    return DEFAULT_PROJECTS_DIR;
  }
  return null;
});

ipcMain.handle("config:create-default-projects-dir", () => {
  fs.mkdirSync(DEFAULT_PROJECTS_DIR, { recursive: true });
  const config = loadConfig();
  config.projectsDir = DEFAULT_PROJECTS_DIR;
  saveConfig(config);
  return DEFAULT_PROJECTS_DIR;
});

// ── Project scaffolding ─────────────────────────────────
const { spawn } = require("child_process");

ipcMain.handle("project:create", async (_e, { framework, name, projectsDir }) => {
  const targetDir = path.join(projectsDir, name);
  if (fs.existsSync(targetDir)) {
    return { ok: false, error: `Directory "${name}" already exists in projects folder.` };
  }

  let cmd, args;
  if (framework === "nextjs") {
    cmd = "npx";
    args = ["create-next-app@latest", name, "--yes"];
  } else {
    return { ok: false, error: `Unknown framework: ${framework}` };
  }

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: projectsDir,
      shell: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(targetDir)) {
        addRecentDir(targetDir);
        resolve({ ok: true, dir: targetDir });
      } else {
        // Filter out noisy npm warn lines (e.g. "npm warn exec package not found")
        const meaningful = stderr
          .split("\n")
          .filter((l) => !/^npm warn\b/i.test(l.trim()))
          .join("\n")
          .trim();
        resolve({ ok: false, error: meaningful || `Process exited with code ${code}` });
      }
    });
  });
});

// ── Dev server ──────────────────────────────────────────
let _devServerProc = null;
let _devServerDir = null;

ipcMain.handle("devserver:has-dev-script", (_e, { cwd }) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
    return !!(pkg.scripts && pkg.scripts.dev);
  } catch {
    return false;
  }
});

ipcMain.handle("devserver:start", (_e, { cwd }) => {
  if (_devServerProc) return { ok: false, error: "Dev server already running" };

  _devServerDir = cwd;
  const proc = spawn("npm", ["run", "dev"], {
    cwd,
    shell: true,
    detached: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  _devServerProc = proc;

  const sender = _e.sender;

  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    // Detect localhost URL from Next.js output (e.g. "- Local: http://localhost:3000")
    const match = text.match(/https?:\/\/localhost:\d+/);
    if (match && sender && !sender.isDestroyed()) {
      sender.send("devserver:url", match[0]);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https?:\/\/localhost:\d+/);
    if (match && sender && !sender.isDestroyed()) {
      sender.send("devserver:url", match[0]);
    }
  });

  proc.on("close", () => {
    _devServerProc = null;
    _devServerDir = null;
    if (sender && !sender.isDestroyed()) {
      sender.send("devserver:stopped");
    }
  });

  proc.on("error", () => {
    _devServerProc = null;
    _devServerDir = null;
    if (sender && !sender.isDestroyed()) {
      sender.send("devserver:stopped");
    }
  });

  return { ok: true };
});

function killDevServer() {
  if (!_devServerProc) return;
  try {
    process.kill(-_devServerProc.pid, "SIGTERM");
  } catch {
    try { _devServerProc.kill(); } catch {}
  }
  _devServerProc = null;
  _devServerDir = null;
}

ipcMain.handle("devserver:stop", () => {
  if (!_devServerProc) return { ok: false };
  killDevServer();
  return { ok: true };
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

// ── Git helpers ─────────────────────────────────────────
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

ipcMain.handle("git:status", async (_e, { cwd }) => {
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!branch) return null;

  const statusRaw = await runGit(["status", "--porcelain"], cwd);
  const staged = [];
  const changes = [];

  if (statusRaw) {
    for (const line of statusRaw.split("\n")) {
      if (!line) continue;
      const x = line[0]; // staged status
      const y = line[1]; // unstaged status
      const file = line.substring(3);

      if (x !== " " && x !== "?") {
        staged.push({ file, status: x });
      }
      if (y !== " " || x === "?") {
        changes.push({ file, status: x === "?" ? "?" : y });
      }
    }
  }

  const logRaw = await runGit(
    ["log", "--oneline", "--format=%h||%s||%cr||%an", "-10"],
    cwd
  );
  const log = logRaw
    ? logRaw.split("\n").filter(Boolean).map((l) => {
        const [hash, msg, time, author] = l.split("||");
        return { hash, msg, time, author };
      })
    : [];

  const topLevel = await runGit(["rev-parse", "--show-toplevel"], cwd);
  const repoName = topLevel ? path.basename(topLevel) : null;
  const remoteUrl = await runGit(["remote", "get-url", "origin"], cwd);

  return { branch, staged, changes, log, repoName, remoteUrl };
});

ipcMain.handle("git:stage-all", async (_e, { cwd }) => {
  const res = await runGit(["add", "-A"], cwd);
  return res !== null;
});

ipcMain.handle("git:stage-file", async (_e, { cwd, file }) => {
  const res = await runGit(["add", "--", file], cwd);
  return res !== null;
});

ipcMain.handle("git:unstage-file", async (_e, { cwd, file }) => {
  const res = await runGit(["reset", "HEAD", "--", file], cwd);
  return res !== null;
});

ipcMain.handle("git:commit", async (_e, { cwd, message }) => {
  const res = await runGit(["commit", "-m", message], cwd);
  return res !== null;
});

ipcMain.handle("git:push", async (_e, { cwd }) => {
  const res = await runGit(["push"], cwd);
  return res !== null;
});

ipcMain.handle("git:branches", async (_e, { cwd }) => {
  const raw = await runGit(["branch", "-a", "--format=%(refname:short)||%(HEAD)"], cwd);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((l) => {
    const [name, head] = l.split("||");
    return { name: name.trim(), current: head.trim() === "*" };
  });
});

ipcMain.handle("git:checkout", async (_e, { cwd, branch }) => {
  const res = await runGit(["checkout", branch], cwd);
  return res !== null;
});

ipcMain.handle("git:create-branch", async (_e, { cwd, branch }) => {
  const res = await runGit(["checkout", "-b", branch], cwd);
  return res !== null;
});

// ── Application menu ───────────────────────────────────
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: "Lithium",
            submenu: [
              { role: "about", label: "About Lithium" },
              { type: "separator" },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  const win = BrowserWindow.getFocusedWindow();
                  if (win) win.webContents.send("menu:open-settings");
                },
              },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ──────────────────────────────────────────
app.whenReady().then(() => {
  app.name = "Lithium";
  ensureDirs();
  buildAppMenu();
  if (process.platform === "darwin" && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: "New Window", click: () => createWindow() },
      ])
    );
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const [, entry] of ptyProcesses) entry.proc.kill();
  ptyProcesses.clear();
  killDevServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killDevServer();
});
