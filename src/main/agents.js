// Agent manager — coordinates provider instances and IPC for chat mode
const { ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadConfig, saveConfig } = require("./config");
const { ACPProvider } = require("./providers/acp");
const { startACPServer, stopACPServer, isACPServerRunning, getACPServerStatus } = require("./acp-server");

// Chat history persistence
const CHAT_DIR = path.join(os.homedir(), ".synthcode", "chat");

function ensureChatDir() {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
}

function loadChatHistory(sessionId) {
  try {
    const p = path.join(CHAT_DIR, `${sessionId}.json`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function saveChatHistory(sessionId, messages) {
  try {
    ensureChatDir();
    const p = path.join(CHAT_DIR, `${sessionId}.json`);
    fs.writeFileSync(p, JSON.stringify(messages));
  } catch (err) {
    console.error("[agents] Failed to save chat history:", err.message);
  }
}

function deleteChatHistory(sessionId) {
  try {
    const p = path.join(CHAT_DIR, `${sessionId}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

// In-memory chat histories keyed by sessionId
const chatHistories = new Map();

// Provider instances (lazy-init)
let providers = {};

function getProviderConfig() {
  const config = loadConfig();
  return config.agentProviders || {};
}

function saveProviderConfig(providerConfig) {
  const config = loadConfig();
  config.agentProviders = providerConfig;
  saveConfig(config);
}

function initProviders() {
  providers.acp = new ACPProvider();
}

function getProvider(name) {
  if (!providers[name]) initProviders();
  return providers[name] || null;
}

function registerAgentHandlers() {
  initProviders();

  // Auto-start ACP server if it's the default agent
  const config = loadConfig();
  if ((config.defaultAgent || "terminal") === "acp") {
    console.log("[agents] Default agent is ACP — auto-starting codex-acp server");
    startACPServer();
  }

  // List available providers and their status
  ipcMain.handle("agent:providers", () => {
    return [
      {
        name: "acp",
        label: "Codex",
        configured: isACPServerRunning(),
        models: [],
        defaultModel: "",
      },
      {
        name: "terminal",
        label: "Terminal",
        configured: true,
        models: [],
        defaultModel: "",
      },
    ];
  });

  // Configure a provider (kept for future use)
  ipcMain.handle("agent:configure", (_e, { provider, config }) => {
    const cfg = getProviderConfig();
    cfg[provider] = { ...cfg[provider], ...config };
    saveProviderConfig(cfg);
    initProviders();
    return true;
  });

  // Get provider config
  ipcMain.handle("agent:get-config", (_e, providerName) => {
    const cfg = getProviderConfig();
    return cfg[providerName] || {};
  });

  // ACP server status
  ipcMain.handle("agent:acp-server-status", () => {
    return {
      running: isACPServerRunning(),
      status: getACPServerStatus(),
    };
  });

  // ACP server start/stop
  ipcMain.handle("agent:acp-server-start", () => {
    startACPServer();
    return true;
  });

  ipcMain.handle("agent:acp-server-stop", () => {
    stopACPServer();
    return true;
  });

  // Send a chat message
  ipcMain.on("agent:send", async (e, { sessionId, provider: providerName, message, model, cwd }) => {
    const sender = e.sender;
    const p = getProvider(providerName);

    if (!p) {
      sender.send("agent:error", { sessionId, error: `Unknown provider: ${providerName}` });
      return;
    }

    if (!p.isAvailable()) {
      sender.send("agent:error", {
        sessionId,
        error: `Codex is not running. Start the server in Settings > Agents.`,
      });
      return;
    }

    // Add user message to history (load from disk if needed)
    if (!chatHistories.has(sessionId)) {
      chatHistories.set(sessionId, loadChatHistory(sessionId));
    }
    const history = chatHistories.get(sessionId);
    history.push({ role: "user", content: message, timestamp: Date.now() });
    saveChatHistory(sessionId, history);

    // Notify start
    sender.send("agent:stream-start", { sessionId });

    try {
      const result = await p.sendMessage(
        sessionId,
        history,
        { model: model || undefined, cwd: cwd || undefined },
        (chunk) => {
          if (!sender.isDestroyed()) {
            sender.send("agent:chunk", { sessionId, chunk });
          }
        }
      );

      if (!result.aborted) {
        history.push({ role: "assistant", content: result.content, timestamp: Date.now() });
        saveChatHistory(sessionId, history);
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

  // Get chat history for a session (memory first, then disk)
  ipcMain.handle("agent:history", (_e, sessionId) => {
    if (chatHistories.has(sessionId)) return chatHistories.get(sessionId);
    const saved = loadChatHistory(sessionId);
    if (saved.length > 0) chatHistories.set(sessionId, saved);
    return saved;
  });

  // Clear chat history
  ipcMain.on("agent:clear-history", (_e, sessionId) => {
    chatHistories.delete(sessionId);
    deleteChatHistory(sessionId);
    for (const p of Object.values(providers)) {
      if (typeof p.clearSession === "function") {
        p.clearSession(sessionId);
      }
    }
  });

  // Get/set default agent
  ipcMain.handle("agent:get-default", () => {
    const config = loadConfig();
    return config.defaultAgent || "terminal";
  });

  ipcMain.handle("agent:set-default", (_e, providerName) => {
    const config = loadConfig();
    config.defaultAgent = providerName;
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
}

module.exports = { registerAgentHandlers, chatHistories };
