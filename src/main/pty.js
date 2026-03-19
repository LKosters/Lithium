const os = require("os");
const path = require("path");
const fs = require("fs");
const pty = require("node-pty");

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

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
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: cwd || os.homedir(),
      env,
    });
  } catch (err) {
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

module.exports = { ptyProcesses, spawnSession, killSession };
