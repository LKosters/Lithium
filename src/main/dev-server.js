const { ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const LOCALHOST_URL_RE = /https?:\/\/localhost:\d+/;

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

  function detectAndSendUrl(chunk) {
    const match = chunk.toString().match(LOCALHOST_URL_RE);
    if (match && sender && !sender.isDestroyed()) {
      sender.send("devserver:url", match[0]);
    }
  }

  function handleDevServerExit() {
    _devServerProc = null;
    _devServerDir = null;
    if (sender && !sender.isDestroyed()) {
      sender.send("devserver:stopped");
    }
  }

  proc.stdout.on("data", detectAndSendUrl);
  proc.stderr.on("data", detectAndSendUrl);
  proc.on("close", handleDevServerExit);
  proc.on("error", handleDevServerExit);

  return { ok: true };
});

function killDevServer() {
  if (!_devServerProc) return;
  try {
    process.kill(-_devServerProc.pid, "SIGTERM");
  } catch {
    try { _devServerProc.kill(); } catch (err) {
      console.error("Failed to kill dev server process:", err.message);
    }
  }
  _devServerProc = null;
  _devServerDir = null;
}

ipcMain.handle("devserver:stop", () => {
  if (!_devServerProc) return { ok: false };
  killDevServer();
  return { ok: true };
});

module.exports = { killDevServer };
