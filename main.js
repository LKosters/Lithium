const { app, BrowserWindow, Menu, dialog, protocol, net } = require("electron");
const { ipcMain } = require("./src/main/ipc");
const path = require("path");
const fs = require("fs");
if (process.env.LITHIUM_DATA_DIR) app.setPath('userData', path.join(process.env.LITHIUM_DATA_DIR, 'electron'));
// One process owns app data and updates; additional windows remain available in-app.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  const show = () => {
    const win = BrowserWindow.getAllWindows()[0] || createWindow();
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  };
  if (app.isReady()) show();
});

// Fix PATH before loading any module that spawns child processes — GUI-launched
// Electron apps don't inherit the login shell's PATH, which breaks `env node`
// shebangs used by claude / npx. Must run before pty / dev-server load.
require("./src/main/shell-env").fixPath();

// ── Load modules ──────────────────────────────────────
const {
  ensureDirs,
  loadConfig,
  saveConfig,
  addRecentDir,
  loadAllSessions,
  saveSession,
  deleteSession,
  saveLayoutToDisk,
  loadLayoutFromDisk,
  DEFAULT_PROJECTS_DIR,
} = require("./src/main/config");

const { ptyProcesses, spawnSession, killSession } = require("./src/main/pty");
const { service: chatService } = require("./src/main/chat");
const { isRestoring } = require("./src/main/data");
const { registerMediaHandlers } = require("./src/main/media");
const { killDevServer } = require("./src/main/dev-server");
const { webServer } = require("./src/main/web");

// Register git & project IPC handlers (side-effect modules)
require("./src/main/git");
require("./src/main/project");

const { startBrowserBridge, stopBrowserBridge, registerBridgeIPC } = require("./src/main/browser-bridge");
const { registerUpdaterHandlers } = require("./src/main/updater");
registerUpdaterHandlers();

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
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, "src", "index.html"));

  const wc = win.webContents;
  win.on("closed", () => {
    chatService.closeOwner(wc).catch(console.error);
    for (const [sid, entry] of ptyProcesses) {
      if (entry.webContents === wc) {
        entry.proc.kill();
        ptyProcesses.delete(sid);
      }
    }
    if (!webServer.status().running) killDevServer();
  });

  return win;
}

// ── IPC: PTY ──────────────────────────────────────────
ipcMain.on("pty:input", (_e, { sessionId, data }) => {
  const entry = ptyProcesses.get(sessionId);
  if (entry) entry.proc.write(data);
});

ipcMain.on("pty:resize", (_e, { sessionId, cols, rows }) => {
  const entry = ptyProcesses.get(sessionId);
  if (entry) {
    try { entry.proc.resize(cols, rows); } catch (err) {
      console.error(`PTY resize failed for ${sessionId}:`, err.message);
    }
  }
});

ipcMain.on("pty:spawn", (e, { sessionId, cwd, resume }) => {
  spawnSession(sessionId, cwd, resume, e.sender);
});

ipcMain.on("pty:kill", (_e, { sessionId }) => {
  killSession(sessionId);
});

// ── IPC: Sessions & Layout ────────────────────────────
ipcMain.handle("sessions:list", () => loadAllSessions());
ipcMain.on("sessions:save", (_e, session) => { if (!isRestoring()) saveSession(session); });
ipcMain.on("sessions:delete", async (e, sessionId) => {
  if (isRestoring()) return;
  try {
    if (chatService.sessions.has(sessionId)) await chatService.close(sessionId, e.sender);
    deleteSession(sessionId);
    chatService.store.delete(sessionId);
  } catch (error) { console.error('Could not delete session:', error); }
});
ipcMain.on("layout:save", (_e, layoutData) => { if (!isRestoring()) saveLayoutToDisk(layoutData); });
ipcMain.handle("layout:load", () => loadLayoutFromDisk());

// ── IPC: Directory ────────────────────────────────────
ipcMain.handle("directory:pick", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
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

// ── Framework detection ──────────────────────────────────
function detectFramework(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps["next"]) return "nextjs";
    if (allDeps["nuxt"] || allDeps["nuxt3"]) return "nuxtjs";
    if (allDeps["@tanstack/start"]) return "tanstack";
    if (allDeps["@sveltejs/kit"]) return "sveltekit";
    if (allDeps["@remix-run/react"] || allDeps["remix"]) return "remix";
    if (allDeps["gatsby"]) return "gatsby";
    if (allDeps["astro"]) return "astro";
    if (allDeps["svelte"]) return "svelte";
    if (allDeps["@angular/core"]) return "angular";
    if (allDeps["vue"]) return "vue";
    if (allDeps["react"]) return "react";
    if (allDeps["typescript"]) return "typescript";
    return "javascript";
  } catch {}

  try {
    const composer = JSON.parse(fs.readFileSync(path.join(dir, "composer.json"), "utf-8"));
    const req = { ...composer.require, ...composer["require-dev"] };
    if (Object.keys(req).some((k) => k.startsWith("symfony/"))) return "symfony";
    if (Object.keys(req).some((k) => k.startsWith("laravel/"))) return "laravel";
    return "php";
  } catch {}

  if (fs.existsSync(path.join(dir, "tsconfig.json"))) return "typescript";
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) return "rust";
  if (fs.existsSync(path.join(dir, "go.mod"))) return "go";
  if (fs.existsSync(path.join(dir, "pyproject.toml")) ||
      fs.existsSync(path.join(dir, "requirements.txt")) ||
      fs.existsSync(path.join(dir, "setup.py"))) return "python";
  if (fs.existsSync(path.join(dir, "Gemfile"))) return "ruby";

  return null;
}

ipcMain.handle("project:detect-framework", (_e, dir) => {
  try {
    return detectFramework(dir);
  } catch {
    return null;
  }
});

ipcMain.on("directory:toggle-star", (_e, dir) => {
  const config = loadConfig();
  if (!config.starredDirs) config.starredDirs = [];
  const idx = config.starredDirs.indexOf(dir);
  if (idx >= 0) config.starredDirs.splice(idx, 1);
  else config.starredDirs.push(dir);
  saveConfig(config);
});

// ── IPC: Music ────────────────────────────────────────
ipcMain.handle("music:list", () => {
  const musicDir = path.join(__dirname, "music");
  try {
    return fs.readdirSync(musicDir)
      .filter((f) => /\.(mp3|m4a|ogg|wav|flac)$/i.test(f))
      .map((f) => ({ name: f.replace(/\.[^.]+$/, ""), path: path.join(musicDir, f) }));
  } catch (err) {
    console.error("Failed to list music directory:", err.message);
    return [];
  }
});

registerMediaHandlers();

// ── IPC: Config ───────────────────────────────────────
ipcMain.handle("config:get", (_e, key) => loadConfig()[key] ?? null);

ipcMain.on("config:set", (_e, { key, value }) => {
  if (isRestoring()) return;
  const c = loadConfig();
  c[key] = value;
  saveConfig(c);
});

ipcMain.handle("config:resolve-projects-dir", () => {
  const config = loadConfig();
  if (config.projectsDir) return config.projectsDir;
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

// ── Application menu ───────────────────────────────────
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [{
          label: "Lithium",
          submenu: [
            { role: "about", label: "About Lithium" },
            { type: "separator" },
            {
              label: "Settings\u2026",
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
        }]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
        { type: "separator" },
        { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" }, { role: "zoom" }, { role: "close" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Custom protocol for streaming local audio ─────────
protocol.registerSchemesAsPrivileged([{
  scheme: "media",
  privileges: { stream: true, standard: true, supportFetchAPI: true },
}]);

// ── Lifecycle ──────────────────────────────────────────
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  app.name = "Lithium";

  protocol.handle("media", (request) => {
    const url = new URL(request.url);
    return net.fetch("file://" + decodeURIComponent(url.pathname));
  });

  ensureDirs();
  try { require('./src/main/database').getDatabase(); }
  catch (error) { dialog.showErrorBox('Could not open Lithium data', `${error.message}\n\nYour existing files have been preserved.`); app.quit(); return; }
  buildAppMenu();

  // Start browser bridge for MCP tool server
  startBrowserBridge().catch((err) => {
    console.error("[main] Browser bridge failed to start:", err.message);
  });
  registerBridgeIPC();

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
  if (webServer.status().running) return;
  for (const [, entry] of ptyProcesses) entry.proc.kill();
  ptyProcesses.clear();
  killDevServer();
  stopBrowserBridge();
  if (process.platform !== "darwin") app.quit();
});

let chatShutdown = false;
app.on("before-quit", (event) => {
  webServer.stop().catch(console.error);
  if (!chatShutdown && chatService.sessions.size) {
    event.preventDefault();
    chatShutdown = true;
    const owners = new Set([...chatService.sessions.values()].map(r => r.owner));
    Promise.all([...owners].map(owner => chatService.closeOwner(owner))).catch(console.error).finally(() => app.quit());
  }
  killDevServer();
  stopBrowserBridge();
});

app.on("render-process-gone", () => {});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
