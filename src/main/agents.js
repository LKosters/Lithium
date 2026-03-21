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

function loadChatData(sessionId) {
  try {
    const p = path.join(CHAT_DIR, `${sessionId}.json`);
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    // Backward compat: old format was plain array
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

// In-memory context usage per session
const contextUsage = new Map();

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
      const data = loadChatData(sessionId);
      chatHistories.set(sessionId, data.messages);
      contextUsage.set(sessionId, { used: data.contextUsed, size: data.contextSize });
    }
    const history = chatHistories.get(sessionId);
    history.push({ role: "user", content: message, timestamp: Date.now() });
    const usage = contextUsage.get(sessionId) || { used: 0, size: 0 };
    saveChatData(sessionId, { messages: history, contextUsed: usage.used, contextSize: usage.size });

    // Notify start
    sender.send("agent:stream-start", { sessionId });

    try {
      const result = await p.sendMessage(
        sessionId,
        history,
        { model: model || undefined, cwd: cwd || undefined },
        (chunk) => {
          // Track context usage from usage chunks
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
