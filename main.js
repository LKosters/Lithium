const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net } = require("electron");
const path = require("path");
const fs = require("fs");

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
const { registerMediaHandlers } = require("./src/main/media");
const { killDevServer } = require("./src/main/dev-server");

// Register git & project IPC handlers (side-effect modules)
require("./src/main/git");
require("./src/main/project");

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
    for (const [sid, entry] of ptyProcesses) {
      if (entry.webContents === wc) {
        entry.proc.kill();
        ptyProcesses.delete(sid);
      }
    }
    killDevServer();
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
ipcMain.on("sessions:save", (_e, session) => saveSession(session));
ipcMain.on("sessions:delete", (_e, sessionId) => deleteSession(sessionId));
ipcMain.on("layout:save", (_e, layoutData) => saveLayoutToDisk(layoutData));
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

app.on("render-process-gone", () => {});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
