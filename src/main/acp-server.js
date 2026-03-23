// codex-acp process manager — spawns codex-acp as a stdio child process
// and communicates via JSON-RPC over stdin/stdout (ACP protocol)
const { spawn } = require("child_process");
const path = require("path");
const { getBridgePort } = require("./browser-bridge");

let acpProcess = null;
let acpReady = false;
let acpAuthenticated = false;
let pendingRequests = new Map(); // id -> { resolve, reject }
let nextId = 1;
let stdoutBuffer = "";
let onUpdateCallback = null;
let lastError = null;
let currentSpawnCwd = null; // track the cwd used to spawn the process
let startupPromise = null; // resolves when doStartup finishes

function startACPServer(cwd) {
  if (acpProcess && !acpProcess.killed) return;

  const spawnCwd = cwd || process.cwd();
  currentSpawnCwd = spawnCwd;
  console.log("[acp-server] Starting codex-acp in cwd:", spawnCwd);

  acpProcess = spawn("npx", ["@zed-industries/codex-acp"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    cwd: spawnCwd,
  });

  acpReady = false;
  acpAuthenticated = false;
  stdoutBuffer = "";
  lastError = null;

  acpProcess.stdout.on("data", (data) => {
    stdoutBuffer += data.toString();
    processBuffer();
  });

  acpProcess.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    console.error("[acp-server:stderr]", msg);
    if (msg) lastError = msg;
  });

  acpProcess.on("error", (err) => {
    console.error("[acp-server] Failed to start:", err.message);
    lastError = err.message;
    if (acpProcess === thisProcess) {
      acpProcess = null;
      acpReady = false;
    }
  });

  const thisProcess = acpProcess;
  acpProcess.on("exit", (code, signal) => {
    console.log(`[acp-server] Process exited (code=${code}, signal=${signal})`);
    // Only clear state if this is still the current process (not a stale one after restart)
    if (acpProcess === thisProcess) {
      acpProcess = null;
      acpReady = false;
      acpAuthenticated = false;
      for (const [, req] of pendingRequests) {
        req.reject(new Error("codex-acp process exited"));
      }
      pendingRequests.clear();
    }
  });

  // Initialize then authenticate
  startupPromise = doStartup();
}

// Restart the server with a new cwd if it changed, returns promise that resolves when ready
async function ensureACPServerCwd(cwd) {
  if (!cwd) return;
  if (acpProcess && !acpProcess.killed && currentSpawnCwd === cwd) {
    if (startupPromise) await startupPromise;
    return;
  }
  if (acpProcess && !acpProcess.killed && currentSpawnCwd !== cwd) {
    console.log("[acp-server] Project directory changed from", currentSpawnCwd, "to", cwd, "— restarting");
    stopACPServer();
  }
  startACPServer(cwd);
  if (startupPromise) await startupPromise;
}

async function doStartup() {
  try {
    // Step 1: Initialize
    const initResult = await sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "lithium",
        title: "Lithium",
        version: "1.0.0",
      },
    }, 30000);
    console.log("[acp-server] Initialized, agent:", initResult.agentInfo?.name, initResult.agentInfo?.version);

    // Step 2: Authenticate with ChatGPT (opens browser for OAuth)
    console.log("[acp-server] Authenticating with ChatGPT (browser will open)...");
    const authResult = await sendRequest("authenticate", {
      method_id: "chatgpt",
    });
    console.log("[acp-server] Authenticated:", JSON.stringify(authResult));
    acpAuthenticated = true;
    acpReady = true;
  } catch (err) {
    console.error("[acp-server] Startup failed:", err.message);
    if (!lastError) lastError = err.message;
    acpReady = true;
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
  // Response to a request we sent
  if (msg.id != null && pendingRequests.has(msg.id)) {
    const req = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    if (msg.error) {
      console.error("[acp-server] Request error:", JSON.stringify(msg.error));
      req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      req.resolve(msg.result);
    }
    return;
  }

  // Notification from the agent (session/update)
  if (msg.method === "session/update" && msg.params) {
    const update = msg.params.update;
    console.log("[acp-server] session/update:", update?.sessionUpdate, JSON.stringify(update).slice(0, 200));
    if (update && onUpdateCallback) {
      onUpdateCallback(msg.params.sessionId, update);
    }
    return;
  }

  // Any other notification (no id)
  if (msg.method && msg.id == null) {
    console.log("[acp-server] Notification:", msg.method, JSON.stringify(msg.params).slice(0, 200));
    return;
  }

  // Agent-initiated requests (e.g. tool approval, file access)
  if (msg.method && msg.id != null) {
    console.log("[acp-server] Agent request:", msg.method, JSON.stringify(msg.params).slice(0, 500));

    if (msg.method === "session/request_permission") {
      // ACP spec: discriminated union with "outcome" as discriminator property
      // Selected variant: { outcome: "selected", optionId: "<id>" }
      const options = msg.params?.options || [];
      const allowOpt = options.find(o => o.kind === "allow_always")
        || options.find(o => o.kind === "allow_once")
        || options[0];

      const optionId = allowOpt ? allowOpt.optionId : "allow_once";
      console.log("[acp-server] Auto-approving permission, optionId:", optionId, "from", options.length, "options");
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
      // Generic acknowledgement for other agent requests
      sendRaw({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
}

function sendRaw(obj) {
  if (!acpProcess || acpProcess.killed) return;
  try {
    acpProcess.stdin.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    console.error("[acp-server] Write error:", err.message);
  }
}

function sendRequest(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!acpProcess || acpProcess.killed) {
      return reject(new Error("codex-acp is not running"));
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

async function createSession(cwd) {
  const resolvedCwd = cwd || currentSpawnCwd || process.cwd();
  console.log("[acp-server] Creating session with cwd:", resolvedCwd);

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
  console.log("[acp-server] Session created:", result.sessionId, "cwd:", resolvedCwd);
  return result.sessionId;
}

async function sendPrompt(sessionId, promptOrText) {
  const prompt = typeof promptOrText === "string"
    ? [{ type: "text", text: promptOrText }]
    : promptOrText;
  return sendRequest("session/prompt", {
    sessionId,
    prompt,
  });
}

function setUpdateCallback(cb) {
  onUpdateCallback = cb;
}

function stopACPServer() {
  if (!acpProcess) return;

  console.log("[acp-server] Stopping codex-acp...");

  // Reject any pending requests from the old process
  for (const [, req] of pendingRequests) {
    req.reject(new Error("codex-acp server restarting"));
  }
  pendingRequests.clear();

  try {
    acpProcess.stdin.end();
    acpProcess.kill("SIGTERM");
  } catch (err) {
    console.error("[acp-server] Error killing process:", err.message);
  }

  const proc = acpProcess;
  setTimeout(() => {
    try {
      if (proc && !proc.killed) proc.kill("SIGKILL");
    } catch {}
  }, 3000);

  acpProcess = null;
  acpReady = false;
  acpAuthenticated = false;
}

function isACPServerRunning() {
  return !!(acpProcess && !acpProcess.killed);
}

function getACPServerStatus() {
  if (!acpProcess || acpProcess.killed) return "stopped";
  if (acpReady) return "running";
  return "starting";
}

function getACPLastError() {
  return lastError;
}

function getACPSpawnCwd() {
  return currentSpawnCwd;
}

module.exports = {
  startACPServer,
  stopACPServer,
  ensureACPServerCwd,
  isACPServerRunning,
  getACPServerStatus,
  getACPLastError,
  getACPSpawnCwd,
  createSession,
  sendPrompt,
  setUpdateCallback,
};
