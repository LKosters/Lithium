// Agent manager — coordinates provider instances and IPC for chat mode
const { ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadConfig, saveConfig } = require("./config");
const {
  getProvider,
  getServer,
  getAllProviderIds,
  getProviderLabel,
  getAllProviderConfigs,
} = require("./provider-registry");

// Chat history persistence
const CHAT_DIR = path.join(os.homedir(), ".synthcode", "chat");

function ensureChatDir() {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
}

function loadChatData(sessionId) {
  try {
    const p = path.join(CHAT_DIR, `${sessionId}.json`);
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (Array.isArray(raw)) return { messages: raw, contextUsed: 0, contextSize: 0 };
    return raw;
  } catch {
    return { messages: [], contextUsed: 0, contextSize: 0 };
  }
}

function saveChatData(sessionId, data) {
  try {
    ensureChatDir();
    const p = path.join(CHAT_DIR, `${sessionId}.json`);
    fs.writeFileSync(p, JSON.stringify(data));
  } catch (err) {
    console.error("[agents] Failed to save chat history:", err.message);
  }
}

const contextUsage = new Map();

function deleteChatHistory(sessionId) {
  try {
    const p = path.join(CHAT_DIR, `${sessionId}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

const chatHistories = new Map();

function registerAgentHandlers() {
  // ACP servers start lazily on first chat message (ensures correct project directory)

  // List available providers and their status
  ipcMain.handle("agent:providers", () => {
    const providerList = getAllProviderConfigs().map(cfg => ({
      name: cfg.id,
      label: cfg.label,
      configured: getServer(cfg.id).isRunning(),
      models: [],
      defaultModel: "",
    }));
    // Always include terminal
    providerList.push({
      name: "terminal",
      label: "Terminal",
      configured: true,
      models: [],
      defaultModel: "",
    });
    return providerList;
  });

  // Dynamic IPC handlers for each ACP provider's server
  for (const cfg of getAllProviderConfigs()) {
    const server = getServer(cfg.id);

    ipcMain.handle(`agent:${cfg.id}-server-status`, () => ({
      running: server.isRunning(),
      status: server.getStatus(),
      lastError: server.getLastError(),
    }));

    ipcMain.handle(`agent:${cfg.id}-server-start`, () => {
      server.start();
      return true;
    });

    ipcMain.handle(`agent:${cfg.id}-server-stop`, () => {
      server.stop();
      return true;
    });
  }

  // Configure a provider (kept for future use)
  ipcMain.handle("agent:configure", (_e, { provider, config }) => {
    const cfg = getProviderConfig();
    cfg[provider] = { ...cfg[provider], ...config };
    saveProviderConfig(cfg);
    return true;
  });

  // Get provider config
  ipcMain.handle("agent:get-config", (_e, providerName) => {
    const cfg = getProviderConfig();
    return cfg[providerName] || {};
  });

  // Send a chat message
  ipcMain.on("agent:send", async (e, { sessionId, provider: providerName, message, images, model, cwd }) => {
    console.log("[agents] agent:send received — provider:", providerName, "cwd:", cwd, "sessionId:", sessionId);
    const sender = e.sender;
    const p = getProvider(providerName);

    if (!p) {
      sender.send("agent:error", { sessionId, error: `Unknown provider: ${providerName}` });
      return;
    }

    // If no cwd and server not running, tell user to start it manually
    if (!p.isAvailable() && !cwd) {
      sender.send("agent:error", {
        sessionId,
        error: `${p.label || providerName} is not running. Start the server in Settings > Agents.`,
      });
      return;
    }

    // Add user message to history
    if (!chatHistories.has(sessionId)) {
      const data = loadChatData(sessionId);
      chatHistories.set(sessionId, data.messages);
      contextUsage.set(sessionId, { used: data.contextUsed, size: data.contextSize });
    }
    const history = chatHistories.get(sessionId);
    const userMsg = { role: "user", content: message, timestamp: Date.now() };
    if (images && images.length > 0) userMsg.images = images;
    history.push(userMsg);
    const usage = contextUsage.get(sessionId) || { used: 0, size: 0 };
    saveChatData(sessionId, { messages: history, contextUsed: usage.used, contextSize: usage.size });

    sender.send("agent:stream-start", { sessionId });

    try {
      const result = await p.sendMessage(
        sessionId,
        history,
        { model: model || undefined, cwd: cwd || undefined },
        (chunk) => {
          if (chunk.type === "usage") {
            contextUsage.set(sessionId, { used: chunk.used, size: chunk.size });
          }
          if (!sender.isDestroyed()) {
            sender.send("agent:chunk", { sessionId, chunk });
          }
        }
      );

      if (!result.aborted) {
        history.push({ role: "assistant", content: result.content, timestamp: Date.now() });
        const u = contextUsage.get(sessionId) || { used: 0, size: 0 };
        saveChatData(sessionId, { messages: history, contextUsed: u.used, contextSize: u.size });
      }

      if (!sender.isDestroyed()) {
        sender.send("agent:stream-end", { sessionId, aborted: !!result.aborted });
      }
    } catch (err) {
      if (!sender.isDestroyed()) {
        sender.send("agent:error", { sessionId, error: err.message });
      }
    }
  });

  // Abort a streaming response
  ipcMain.on("agent:abort", (_e, { sessionId, provider: providerName }) => {
    const p = getProvider(providerName);
    if (p) p.abort(sessionId);
  });

  // Get chat history + context usage for a session
  ipcMain.handle("agent:history", (_e, sessionId) => {
    if (chatHistories.has(sessionId)) {
      const u = contextUsage.get(sessionId) || { used: 0, size: 0 };
      return { messages: chatHistories.get(sessionId), contextUsed: u.used, contextSize: u.size };
    }
    const data = loadChatData(sessionId);
    if (data.messages.length > 0) {
      chatHistories.set(sessionId, data.messages);
      contextUsage.set(sessionId, { used: data.contextUsed, size: data.contextSize });
    }
    return data;
  });

  // Clear chat history
  ipcMain.on("agent:clear-history", (_e, sessionId) => {
    chatHistories.delete(sessionId);
    contextUsage.delete(sessionId);
    deleteChatHistory(sessionId);
    for (const id of getAllProviderIds()) {
      const p = getProvider(id);
      if (p && typeof p.clearSession === "function") {
        p.clearSession(sessionId);
      }
    }
  });

  // Permission response from renderer
  ipcMain.on("agent:permission-response", (_e, { permissionId, optionId, provider: providerName }) => {
    console.log("[agents] Permission response — provider:", providerName, "permId:", permissionId, "optionId:", optionId);
    const p = getProvider(providerName);
    if (p && typeof p.respondPermission === "function") {
      p.respondPermission(permissionId, optionId);
    } else {
      console.warn("[agents] No provider or respondPermission for:", providerName);
    }
  });

  // Get/set tool approval mode
  ipcMain.handle("agent:get-tool-approval-mode", () => {
    const config = loadConfig();
    return config.toolApprovalMode || "manual";
  });

  ipcMain.handle("agent:set-tool-approval-mode", (_e, mode) => {
    const config = loadConfig();
    config.toolApprovalMode = mode;
    saveConfig(config);
    return true;
  });

  // Get/set default mode ("terminal" or provider id)
  ipcMain.handle("agent:get-default", () => {
    const config = loadConfig();
    return config.defaultAgent || "terminal";
  });

  ipcMain.handle("agent:set-default", (_e, mode) => {
    const config = loadConfig();
    config.defaultAgent = mode;
    saveConfig(config);
    return true;
  });

  // Get/set enabled ACP providers
  ipcMain.handle("agent:get-enabled-acps", () => {
    const config = loadConfig();
    return config.enabledACPs || ["acp"];
  });

  ipcMain.handle("agent:set-acp-enabled", (_e, { provider, enabled }) => {
    const config = loadConfig();
    if (!config.enabledACPs) config.enabledACPs = ["acp"];
    if (enabled && !config.enabledACPs.includes(provider)) {
      config.enabledACPs.push(provider);
    } else if (!enabled) {
      config.enabledACPs = config.enabledACPs.filter(p => p !== provider);
    }
    saveConfig(config);
    return true;
  });

  // Get/set default model for a provider
  ipcMain.handle("agent:get-default-model", (_e, providerName) => {
    const cfg = getProviderConfig();
    return cfg[providerName]?.defaultModel || null;
  });

  ipcMain.handle("agent:set-default-model", (_e, { provider, model }) => {
    const cfg = getProviderConfig();
    if (!cfg[provider]) cfg[provider] = {};
    cfg[provider].defaultModel = model;
    saveProviderConfig(cfg);
    return true;
  });

  // Get provider labels (for renderer to use dynamically)
  ipcMain.handle("agent:get-provider-labels", () => {
    const labels = {};
    for (const cfg of getAllProviderConfigs()) {
      labels[cfg.id] = cfg.label;
    }
    return labels;
  });
}

function getProviderConfig() {
  const config = loadConfig();
  return config.agentProviders || {};
}

function saveProviderConfig(providerConfig) {
  const config = loadConfig();
  config.agentProviders = providerConfig;
  saveConfig(config);
}

// Stop all servers (called on app quit)
function stopAllServers() {
  for (const id of getAllProviderIds()) {
    const server = getServer(id);
    if (server) server.stop();
  }
}

module.exports = { registerAgentHandlers, chatHistories, stopAllServers };
