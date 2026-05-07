// Generic ACP server factory — creates a stdio JSON-RPC process manager
// for any ACP-compatible agent. Each call returns an independent server instance.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { getBridgePort } = require("./browser-bridge");
const { loadConfig } = require("./config");

function createACPServerManager(config) {
  const { name, command, args, authMethodId, modelEnvVar, logPrefix } = config;
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
  let currentSpawnModel = null;
  let startupPromise = null;

  function start(cwd, model) {
    if (proc && !proc.killed) return;

    const spawnCwd = cwd || process.cwd();
    currentSpawnCwd = spawnCwd;
    currentSpawnModel = model || null;
    const env = { ...process.env };
    if (modelEnvVar && model) {
      env[modelEnvVar] = model;
    }
    console.log(`${prefix} Starting in cwd:`, spawnCwd, model ? `(${modelEnvVar}=${model})` : "");

    proc = spawn(command, args, {
      env,
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

  async function ensureCwd(cwd, model) {
    if (!cwd) return;
    const modelChanged = !!modelEnvVar && (model || null) !== (currentSpawnModel || null);
    if (proc && !proc.killed && currentSpawnCwd === cwd && !modelChanged) {
      if (startupPromise) await startupPromise;
      return;
    }
    if (proc && !proc.killed) {
      if (currentSpawnCwd !== cwd) {
        console.log(`${prefix} Project directory changed from`, currentSpawnCwd, "to", cwd, "— restarting");
      } else if (modelChanged) {
        console.log(`${prefix} Model changed from`, currentSpawnModel, "to", model, "— restarting");
      }
      stop();
    }
    start(cwd, model);
    if (startupPromise) await startupPromise;
  }

  async function doStartup() {
    try {
      const initResult = await sendRequest("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          permissions: { supported: true },
          _meta: { terminal_output: true },
        },
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

  // ── Per-project tool approval ──────────────────────
  // Generic/default names that should never be auto-approved or saved
  const GENERIC_TOOL_NAMES = ["Tool call", "Unknown", "tool_call"];

  function getApprovedToolsPath(cwd) {
    if (!cwd) return null;
    return path.join(cwd, ".lithium", "approved-tools.json");
  }

  function loadApprovedTools(cwd) {
    const p = getApprovedToolsPath(cwd);
    if (!p) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return [];
    }
  }

  function saveApprovedTool(cwd, toolName) {
    if (!cwd || !toolName) return;
    // Never save generic/default tool names
    if (GENERIC_TOOL_NAMES.includes(toolName)) return;
    const dirPath = path.join(cwd, ".lithium");
    fs.mkdirSync(dirPath, { recursive: true });
    const approved = loadApprovedTools(cwd);
    // Also clean out any stale generic entries
    const cleaned = approved.filter(a => !GENERIC_TOOL_NAMES.includes(a));
    if (!cleaned.includes(toolName)) {
      cleaned.push(toolName);
    }
    fs.writeFileSync(getApprovedToolsPath(cwd), JSON.stringify(cleaned, null, 2));
  }

  function isToolApproved(cwd, title) {
    if (!cwd || !title) return false;
    const toolName = title.split(":")[0].split("(")[0].trim();
    // Never auto-approve generic/default names
    if (GENERIC_TOOL_NAMES.includes(toolName)) return false;
    const approved = loadApprovedTools(cwd);
    return approved.some(a => !GENERIC_TOOL_NAMES.includes(a) && (toolName.startsWith(a) || a === toolName));
  }

  // Gate a direct tool operation behind the approval UI
  function requireToolApproval(msgId, toolTitle, description, kind) {
    const cfg = loadConfig();
    const mode = cfg.toolApprovalMode || "manual";

    if (mode === "auto") {
      console.log(`${prefix} Auto-approving ${toolTitle} (auto mode)`);
      sendRaw({ jsonrpc: "2.0", id: msgId, result: {} });
      return;
    }

    if (isToolApproved(currentSpawnCwd, toolTitle)) {
      console.log(`${prefix} "${toolTitle}" is project-approved, auto-allowing`);
      sendRaw({ jsonrpc: "2.0", id: msgId, result: {} });
      return;
    }

    // Manual mode — require user approval
    const options = [
      { optionId: "allow_once", kind: "allow_once", label: "Allow" },
      { optionId: "allow_always", kind: "allow_always", label: "Always Allow" },
      { optionId: "deny", kind: "deny", label: "Deny" },
    ];
    pendingPermissions.set(msgId, { msgId, options, title: toolTitle, directAck: true });
    console.log(`${prefix} Tool "${toolTitle}" pending approval, permId:`, msgId);

    if (onPermissionCallback) {
      onPermissionCallback({
        permissionId: msgId,
        title: toolTitle,
        description,
        kind,
        options,
      });
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
      const logLen = msg.method === "session/request_permission" ? 2000 : 500;
      console.log(`${prefix} Agent request:`, msg.method, JSON.stringify(msg.params).slice(0, logLen));

      if (msg.method === "session/request_permission") {
        const cfg = loadConfig();
        const mode = cfg.toolApprovalMode || "manual";
        const options = msg.params?.options || [];
        const toolCall = msg.params?.toolCall || {};
        const title = toolCall.title || msg.params?.title || msg.params?.name || "Tool call";
        const kind = toolCall.kind || msg.params?.kind || "";
        const content = toolCall.content || msg.params?.content || [];

        // Build a readable description from toolCall content
        let description = msg.params?.description || toolCall.description || "";
        if (!description && content.length > 0) {
          description = content
            .map(c => {
              if (c.type === "text") return c.text;
              if (c.type === "code") return c.code;
              if (typeof c === "string") return c;
              return "";
            })
            .filter(Boolean)
            .join("\n");
        }
        // If still no description, try to extract from params directly
        if (!description && msg.params?.command) {
          description = msg.params.command;
        }

        console.log(`${prefix} Permission — title: "${title}", kind: "${kind}", description: "${(description || "").slice(0, 200)}"`);

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
        } else if (isToolApproved(currentSpawnCwd, title)) {
          // Tool is approved for this project — auto-allow
          const allowOpt = options.find(o => o.kind === "allow_always")
            || options.find(o => o.kind === "allow_once")
            || options[0];
          const optionId = allowOpt ? allowOpt.optionId : "allow_once";
          console.log(`${prefix} Tool "${title}" is project-approved, auto-allowing`);
          sendRaw({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "selected", optionId } },
          });
        } else {
          // Manual mode — store pending and notify UI
          const permId = msg.id;
          pendingPermissions.set(permId, { msgId: msg.id, options, title });
          console.log(`${prefix} Permission request pending (manual mode), permId:`, permId);
          if (onPermissionCallback) {
            onPermissionCallback({
              permissionId: permId,
              title,
              description,
              kind,
              options,
            });
          }
        }
      } else if (msg.method === "terminal/create") {
        // Terminal create — requires approval (this runs a command)
        const cmdParts = [];
        if (msg.params?.command) cmdParts.push(msg.params.command);
        if (msg.params?.args) cmdParts.push(...(Array.isArray(msg.params.args) ? msg.params.args : [msg.params.args]));
        if (msg.params?.cmd) cmdParts.push(msg.params.cmd);
        const cmdDesc = cmdParts.join(" ") || JSON.stringify(msg.params || {}).slice(0, 500);
        const toolTitle = "Terminal";

        requireToolApproval(msg.id, toolTitle, cmdDesc, "command");
      } else if (msg.method === "fs/write_text_file") {
        // File write — requires approval
        const filePath = msg.params?.path || "Unknown file";
        const contentPreview = (msg.params?.content || "").slice(0, 500);
        const toolTitle = "Write File";
        const desc = `${filePath}\n\n${contentPreview}${(msg.params?.content || "").length > 500 ? "\n..." : ""}`;

        requireToolApproval(msg.id, toolTitle, desc, "edit");
      } else if (msg.method === "fs/read_text_file") {
        // File read — auto-approve (safe, read-only)
        console.log(`${prefix} File read (auto-ack):`, msg.params?.path || "");
        sendRaw({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "terminal/output" || msg.method === "terminal/release"
        || msg.method === "terminal/wait_for_exit" || msg.method === "terminal/kill") {
        // Terminal lifecycle ops — auto-ack (the create was already approved)
        console.log(`${prefix} Terminal op (auto-ack):`, msg.method);
        sendRaw({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else {
        console.log(`${prefix} Unknown agent request (auto-ack):`, msg.method);
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

  function respondPermission(permissionId, optionId, alwaysAllow) {
    const pending = pendingPermissions.get(permissionId);
    if (!pending) {
      console.warn(`${prefix} No pending permission for id:`, permissionId);
      return;
    }
    pendingPermissions.delete(permissionId);
    console.log(`${prefix} Responding to permission ${permissionId} with optionId:`, optionId, alwaysAllow ? "(always allow)" : "");

    // If "always allow" was chosen, save the tool name to the project's approved list
    if (alwaysAllow && currentSpawnCwd && pending.title) {
      const toolName = pending.title.split(":")[0].split("(")[0].trim();
      saveApprovedTool(currentSpawnCwd, toolName);
      console.log(`${prefix} Saved "${toolName}" as approved tool for project:`, currentSpawnCwd);
    }

    if (pending.directAck) {
      // Direct tool operation (terminal/create, fs/write_text_file) — send simple ack or error
      if (optionId === "deny") {
        sendRaw({
          jsonrpc: "2.0",
          id: pending.msgId,
          error: { code: -32000, message: "User denied the operation" },
        });
      } else {
        sendRaw({ jsonrpc: "2.0", id: pending.msgId, result: {} });
      }
    } else {
      // Standard session/request_permission response
      sendRaw({
        jsonrpc: "2.0",
        id: pending.msgId,
        result: { outcome: { outcome: "selected", optionId } },
      });
    }
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

  function abortPendingRequests() {
    for (const [id, req] of pendingRequests) {
      req.reject(new Error("Request aborted by user"));
    }
    pendingRequests.clear();
    pendingPermissions.clear();
  }

  return {
    start,
    stop,
    ensureCwd,
    isRunning,
    getStatus,
    getLastError,
    createSession,
    sendPrompt,
    setUpdateCallback,
    setPermissionCallback,
    respondPermission,
    abortPendingRequests,
  };
}

module.exports = { createACPServerManager };
