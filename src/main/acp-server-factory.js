// Generic ACP server factory — creates a stdio JSON-RPC process manager
// for any ACP-compatible agent. Each call returns an independent server instance.
const { spawn } = require("child_process");
const path = require("path");
const { getBridgePort } = require("./browser-bridge");
const { loadConfig, isCommandAllowed, addAllowedCommand } = require("./config");

function createACPServerManager(config) {
  const { name, command, args, authMethodId, logPrefix } = config;
  const prefix = logPrefix || `[${name}]`;

  let proc = null;
  let ready = false;
  let authenticated = false;
  let pendingRequests = new Map();
  let pendingPermissions = new Map();
  let nextId = 1;
  let stdoutBuffer = "";
  let onUpdateCallback = null;
  let onPermissionCallback = null;
  let lastError = null;
  let currentSpawnCwd = null;
  let startupPromise = null;

  function start(cwd) {
    if (proc && !proc.killed) return;

    const spawnCwd = cwd || process.cwd();
    currentSpawnCwd = spawnCwd;
    console.log(`${prefix} Starting in cwd:`, spawnCwd);

    proc = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      cwd: spawnCwd,
    });

    ready = false;
    authenticated = false;
    stdoutBuffer = "";
    lastError = null;

    const thisProc = proc;

    proc.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      processBuffer();
    });

    proc.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      console.error(`${prefix}:stderr`, msg);
      if (msg) lastError = msg;
    });

    proc.on("error", (err) => {
      console.error(`${prefix} Failed to start:`, err.message);
      lastError = err.message;
      if (proc === thisProc) {
        proc = null;
        ready = false;
      }
    });

    proc.on("exit", (code, signal) => {
      console.log(`${prefix} Process exited (code=${code}, signal=${signal})`);
      if (proc === thisProc) {
        proc = null;
        ready = false;
        authenticated = false;
        for (const [, req] of pendingRequests) {
          req.reject(new Error(`${name} process exited`));
        }
        pendingRequests.clear();
      }
    });

    startupPromise = doStartup();
  }

  function stop() {
    if (!proc) return;

    console.log(`${prefix} Stopping...`);

    for (const [, req] of pendingRequests) {
      req.reject(new Error(`${name} server restarting`));
    }
    pendingRequests.clear();

    try {
      proc.stdin.end();
      proc.kill("SIGTERM");
    } catch (err) {
      console.error(`${prefix} Error killing process:`, err.message);
    }

    const old = proc;
    setTimeout(() => {
      try { if (old && !old.killed) old.kill("SIGKILL"); } catch {}
    }, 3000);

    proc = null;
    ready = false;
    authenticated = false;
  }

  async function ensureCwd(cwd) {
    if (!cwd) return;
    if (proc && !proc.killed && currentSpawnCwd === cwd) {
      if (startupPromise) await startupPromise;
      return;
    }
    if (proc && !proc.killed && currentSpawnCwd !== cwd) {
      console.log(`${prefix} Project directory changed from`, currentSpawnCwd, "to", cwd, "— restarting");
      stop();
    }
    start(cwd);
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
      console.log(`${prefix} Initialized, agent:`, initResult.agentInfo?.name, initResult.agentInfo?.version);

      if (authMethodId) {
        console.log(`${prefix} Authenticating...`);
        const authResult = await sendRequest("authenticate", {
          method_id: authMethodId,
        });
        console.log(`${prefix} Authenticated:`, JSON.stringify(authResult));
        authenticated = true;
      }
      ready = true;
    } catch (err) {
      console.error(`${prefix} Startup failed:`, err.message);
      if (!lastError) lastError = err.message;
      ready = true;
    }
  }

  function processBuffer() {
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleMessage(JSON.parse(trimmed));
      } catch {
        // Not valid JSON
      }
    }
  }

  function handleMessage(msg) {
    if (msg.id != null && pendingRequests.has(msg.id)) {
      const req = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      if (msg.error) {
        console.error(`${prefix} Request error:`, JSON.stringify(msg.error));
        req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    if (msg.method === "session/update" && msg.params) {
      const update = msg.params.update;
      console.log(`${prefix} session/update:`, update?.sessionUpdate, JSON.stringify(update).slice(0, 200));
      if (update && onUpdateCallback) {
        onUpdateCallback(msg.params.sessionId, update);
      }
      return;
    }

    if (msg.method && msg.id == null) {
      console.log(`${prefix} Notification:`, msg.method, JSON.stringify(msg.params).slice(0, 200));
      return;
    }

    if (msg.method && msg.id != null) {
      console.log(`${prefix} Agent request:`, msg.method, JSON.stringify(msg.params).slice(0, 500));

      if (msg.method === "session/request_permission") {
        const cfg = loadConfig();
        const mode = cfg.toolApprovalMode || "manual";
        const options = msg.params?.options || [];
        const description = msg.params?.description || "";

        if (mode === "auto") {
          const allowOpt = options.find(o => o.kind === "allow_always")
            || options.find(o => o.kind === "allow_once")
            || options[0];
          const optionId = allowOpt ? allowOpt.optionId : "allow_once";
          console.log(`${prefix} Auto-approving permission, optionId:`, optionId);
          sendRaw({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId } },
          });
        } else if (currentSpawnCwd && isCommandAllowed(currentSpawnCwd, description)) {
          // Command is in project's allowed list — auto-approve
          const allowOpt = options.find(o => o.kind === "allow_always")
            || options.find(o => o.kind === "allow_once")
            || options[0];
          const optionId = allowOpt ? allowOpt.optionId : "allow_once";
          console.log(`${prefix} Project-allowed command, auto-approving:`, description);
          sendRaw({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId } },
          });
        } else {
          // Manual mode — store pending and notify UI
          const permId = msg.id;
          pendingPermissions.set(permId, { msgId: msg.id, options });
          console.log(`${prefix} Permission request pending (manual mode), permId:`, permId);
          if (onPermissionCallback) {
            onPermissionCallback({
              permissionId: permId,
              title: msg.params?.title || "Tool call",
              description: msg.params?.description || "",
              options,
            });
          }
        }
      } else {
        sendRaw({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
    }
  }

  function sendRaw(obj) {
    if (!proc || proc.killed) return;
    try {
      proc.stdin.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      console.error(`${prefix} Write error:`, err.message);
    }
  }

  function sendRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!proc || proc.killed) {
        return reject(new Error(`${name} is not running`));
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
    console.log(`${prefix} Creating session with cwd:`, resolvedCwd);

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
    console.log(`${prefix} Session created:`, result.sessionId, "cwd:", resolvedCwd);
    return result.sessionId;
  }

  async function sendPrompt(sessionId, promptOrText) {
    const prompt = typeof promptOrText === "string"
      ? [{ type: "text", text: promptOrText }]
      : promptOrText;
    return sendRequest("session/prompt", { sessionId, prompt });
  }

  function setUpdateCallback(cb) {
    onUpdateCallback = cb;
  }

  function setPermissionCallback(cb) {
    onPermissionCallback = cb;
  }

  function respondPermission(permissionId, optionId, allowAlwaysCommand) {
    const pending = pendingPermissions.get(permissionId);
    if (!pending) {
      console.warn(`${prefix} No pending permission for id:`, permissionId);
      return;
    }
    pendingPermissions.delete(permissionId);
    console.log(`${prefix} Responding to permission ${permissionId} with optionId:`, optionId);

    // If "allow always" was chosen, save command to project settings
    if (allowAlwaysCommand && currentSpawnCwd) {
      addAllowedCommand(currentSpawnCwd, allowAlwaysCommand);
      console.log(`${prefix} Added to project allowed commands:`, allowAlwaysCommand);
    }

    sendRaw({
      jsonrpc: "2.0",
      id: pending.msgId,
      result: { outcome: { outcome: "selected", optionId } },
    });
  }

  function getCwd() {
    return currentSpawnCwd;
  }

  function isRunning() {
    return !!(proc && !proc.killed);
  }

  function getStatus() {
    if (!proc || proc.killed) return "stopped";
    if (ready) return "running";
    return "starting";
  }

  function getLastError() {
    return lastError;
  }

  return {
    start,
    stop,
    ensureCwd,
    isRunning,
    getStatus,
    getLastError,
    getCwd,
    createSession,
    sendPrompt,
    setUpdateCallback,
    setPermissionCallback,
    respondPermission,
  };
}

module.exports = { createACPServerManager };
