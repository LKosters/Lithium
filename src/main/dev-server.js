const { ipcMain } = require("./ipc");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadProjectSettings } = require("./config");

const LOCALHOST_URL_RE = /https?:\/\/localhost:\d+/;

let _devServerProcs = [];
let _devServerDir = null;

function hasDevScript(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
    return !!(pkg.scripts && pkg.scripts.dev);
  } catch {
    return false;
  }
}

// What the play button runs for a project: the project's own configured start
// commands (Settings → Project), falling back to the conventional `npm run dev`
// when the package defines one. An empty result hides the play button.
function resolveStartCommands(cwd) {
  if (!cwd) return [];
  const { startCommands } = loadProjectSettings(cwd);
  if (startCommands.length) return startCommands;
  return hasDevScript(cwd) ? ["npm run dev"] : [];
}

ipcMain.handle("devserver:start-commands", (_e, { cwd }) => resolveStartCommands(cwd));

ipcMain.handle("devserver:start", (_e, { cwd }) => {
  if (_devServerProcs.length) return { ok: false, error: "Dev server already running" };

  const commands = resolveStartCommands(cwd);
  if (!commands.length) return { ok: false, error: "No start command configured for this project" };

  _devServerDir = cwd;
  const sender = _e.sender;

  function detectAndSendUrl(chunk) {
    const match = chunk.toString().match(LOCALHOST_URL_RE);
    if (match && sender && !sender.isDestroyed()) {
      sender.send("devserver:url", match[0]);
    }
  }

  // Every configured command is part of one logical "dev server" — the renderer
  // only sees it as stopped once the last process is gone, and only once (a
  // manual stop empties the list before the `close` events arrive).
  let reportedStopped = false;
  function handleDevServerExit(proc) {
    _devServerProcs = _devServerProcs.filter((p) => p !== proc);
    if (_devServerProcs.length || reportedStopped) return;
    reportedStopped = true;
    _devServerDir = null;
    if (sender && !sender.isDestroyed()) {
      sender.send("devserver:stopped");
    }
  }

  for (const command of commands) {
    const proc = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    _devServerProcs.push(proc);

    proc.stdout.on("data", detectAndSendUrl);
    proc.stderr.on("data", detectAndSendUrl);
    proc.on("close", () => handleDevServerExit(proc));
    proc.on("error", () => handleDevServerExit(proc));
  }

  return { ok: true, commands };
});

function killDevServer() {
  const procs = _devServerProcs;
  _devServerProcs = [];
  _devServerDir = null;
  for (const proc of procs) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try { proc.kill(); } catch (err) {
        console.error("Failed to kill dev server process:", err.message);
      }
    }
  }
}

ipcMain.handle("devserver:stop", () => {
  if (!_devServerProcs.length) return { ok: false };
  killDevServer();
  return { ok: true };
});

module.exports = { killDevServer };
