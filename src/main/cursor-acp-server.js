// cursor-acp process manager — spawns cursor agent acp as a stdio child process
// and communicates via JSON-RPC over stdin/stdout (ACP protocol)
const { spawn } = require("child_process");
const path = require("path");
const { getBridgePort } = require("./browser-bridge");

let cursorProcess = null;
let cursorReady = false;
let cursorAuthenticated = false;
let pendingRequests = new Map();
let nextId = 1;
let stdoutBuffer = "";
let onUpdateCallback = null;
let lastError = null;
let currentSpawnCwd = null; // track the cwd used to spawn the process
let startupPromise = null; // resolves when doStartup finishes

function startCursorACPServer(cwd) {
  if (cursorProcess && !cursorProcess.killed) return;

  const spawnCwd = cwd || process.cwd();
  currentSpawnCwd = spawnCwd;
  console.log("[cursor-acp] Starting cursor agent acp in cwd:", spawnCwd);

  cursorProcess = spawn("cursor-agent", ["acp"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    cwd: spawnCwd,
  });

  cursorReady = false;
  cursorAuthenticated = false;
  stdoutBuffer = "";
  lastError = null;

  cursorProcess.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();
    processBuffer();
  });

  cursorProcess.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    console.error("[cursor-acp:stderr]", msg);
    if (msg) lastError = msg;
  });

  cursorProcess.on("error", (err) => {
    console.error("[cursor-acp] Failed to start:", err.message);
    lastError = err.message;
    if (cursorProcess === thisProcess) {
      cursorProcess = null;
      cursorReady = false;
    }
  });

  const thisProcess = cursorProcess;
  cursorProcess.on("exit", (code, signal) => {
    console.log(`[cursor-acp] Process exited (code=${code}, signal=${signal})`);
    // Only clear state if this is still the current process (not a stale one after restart)
    if (cursorProcess === thisProcess) {
      cursorProcess = null;
      cursorReady = false;
      cursorAuthenticated = false;
      for (const [, req] of pendingRequests) {
        req.reject(new Error("cursor-acp process exited"));
      }
      pendingRequests.clear();
    }
  });

  startupPromise = doStartup();
}

// Restart the server with a new cwd if it changed, returns promise that resolves when ready
async function ensureCursorACPServerCwd(cwd) {
  if (!cwd) return;
  if (cursorProcess && !cursorProcess.killed && currentSpawnCwd === cwd) {
    if (startupPromise) await startupPromise;
    return;
  }
  if (cursorProcess && !cursorProcess.killed && currentSpawnCwd !== cwd) {
    console.log("[cursor-acp] Project directory changed from", currentSpawnCwd, "to", cwd, "— restarting");
    stopCursorACPServer();
  }
  startCursorACPServer(cwd);
  if (startupPromise) await startupPromise;
}

async function doStartup() {
  try {
    const initResult = await sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "lithium",
        title: "Lithium",
        version: "1.0.0",
      },
    }, 30000);
    console.log("[cursor-acp] Initialized, agent:", initResult.agentInfo?.name, initResult.agentInfo?.version);

    console.log("[cursor-acp] Authenticating with Cursor (browser will open)...");
    const authResult = await sendRequest("authenticate", {
      method_id: "cursor_login",
    });
    console.log("[cursor-acp] Authenticated:", JSON.stringify(authResult));
    cursorAuthenticated = true;
    cursorReady = true;
  } catch (err) {
    console.error("[cursor-acp] Startup failed:", err.message);
    if (!lastError) lastError = err.message;
    cursorReady = true;
  }
}

function processBuffer() {
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const msg = JSON.parse(trimmed);
      handleMessage(msg);
    } catch {
      // Not valid JSON, skip
    }
  }
}

function handleMessage(msg) {
  if (msg.id != null && pendingRequests.has(msg.id)) {
    const req = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    if (msg.error) {
      console.error("[cursor-acp] Request error:", JSON.stringify(msg.error));
      req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      req.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "session/update" && msg.params) {
    const update = msg.params.update;
    console.log("[cursor-acp] session/update:", update?.sessionUpdate, JSON.stringify(update).slice(0, 200));
    if (update && onUpdateCallback) {
      onUpdateCallback(msg.params.sessionId, update);
    }
    return;
  }

  if (msg.method && msg.id == null) {
    console.log("[cursor-acp] Notification:", msg.method, JSON.stringify(msg.params).slice(0, 200));
    return;
  }

  if (msg.method && msg.id != null) {
    console.log("[cursor-acp] Agent request:", msg.method, JSON.stringify(msg.params).slice(0, 500));

    if (msg.method === "session/request_permission") {
      const options = msg.params?.options || [];
      const allowOpt = options.find(o => o.kind === "allow_always")
        || options.find(o => o.kind === "allow_once")
        || options[0];

      const optionId = allowOpt ? allowOpt.optionId : "allow_once";
      console.log("[cursor-acp] Auto-approving permission, optionId:", optionId);
      sendRaw({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          outcome: {
            outcome: "selected",
            optionId: optionId,
          },
        },
      });
    } else {
      sendRaw({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
}

function sendRaw(obj) {
  if (!cursorProcess || cursorProcess.killed) return;
  try {
    cursorProcess.stdin.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    console.error("[cursor-acp] Write error:", err.message);
  }
}

function sendRequest(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!cursorProcess || cursorProcess.killed) {
      return reject(new Error("cursor-acp is not running"));
    }
    const id = nextId++;
    pendingRequests.set(id, { resolve, reject });
    sendRaw({ jsonrpc: "2.0", id, method, params });

    if (timeoutMs) {
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, timeoutMs);
    }
  });
}

async function createCursorSession(cwd) {
  const resolvedCwd = cwd || currentSpawnCwd || process.cwd();
  console.log("[cursor-acp] Creating session with cwd:", resolvedCwd);

  const bridgePort = getBridgePort();
  const mcpServers = bridgePort
    ? [{
        name: "browser",
        command: "node",
        args: [path.join(__dirname, "browser-mcp-server.js")],
        env: [{ name: "BROWSER_BRIDGE_PORT", value: String(bridgePort) }],
      }]
    : [];

  const result = await sendRequest("session/new", {
    cwd: resolvedCwd,
    mcpServers,
  }, 15000);
  console.log("[cursor-acp] Session created:", result.sessionId, "cwd:", resolvedCwd);
  return result.sessionId;
}

async function sendCursorPrompt(sessionId, promptOrText) {
  const prompt = typeof promptOrText === "string"
    ? [{ type: "text", text: promptOrText }]
    : promptOrText;
  return sendRequest("session/prompt", {
    sessionId,
    prompt,
  });
}

function setCursorUpdateCallback(cb) {
  onUpdateCallback = cb;
}

function stopCursorACPServer() {
  if (!cursorProcess) return;

  console.log("[cursor-acp] Stopping cursor-acp...");

  // Reject any pending requests from the old process
  for (const [, req] of pendingRequests) {
    req.reject(new Error("cursor-acp server restarting"));
  }
  pendingRequests.clear();

  try {
    cursorProcess.stdin.end();
    cursorProcess.kill("SIGTERM");
  } catch (err) {
    console.error("[cursor-acp] Error killing process:", err.message);
  }

  const proc = cursorProcess;
  setTimeout(() => {
    try {
      if (proc && !proc.killed) proc.kill("SIGKILL");
    } catch {}
  }, 3000);

  cursorProcess = null;
  cursorReady = false;
  cursorAuthenticated = false;
}

function isCursorACPRunning() {
  return !!(cursorProcess && !cursorProcess.killed);
}

function getCursorACPStatus() {
  if (!cursorProcess || cursorProcess.killed) return "stopped";
  if (cursorReady) return "running";
  return "starting";
}

function getCursorACPLastError() {
  return lastError;
}

module.exports = {
  startCursorACPServer,
  stopCursorACPServer,
  ensureCursorACPServerCwd,
  isCursorACPRunning,
  getCursorACPStatus,
  getCursorACPLastError,
  createCursorSession,
  sendCursorPrompt,
  setCursorUpdateCallback,
};
