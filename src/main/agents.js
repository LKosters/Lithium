// Agent manager — coordinates provider instances and IPC for chat mode
const { ipcMain } = require("electron");
const { loadConfig, saveConfig } = require("./config");
const { ClaudeAgentProvider } = require("./providers/claude-agent");
const { OpenAICodexProvider } = require("./providers/openai-codex");
const { ACPProvider } = require("./providers/acp");

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
  const cfg = getProviderConfig();

  providers.claude = new ClaudeAgentProvider(cfg.claude?.apiKey);
  providers.codex = new OpenAICodexProvider(cfg.codex?.apiKey);
  providers.acp = new ACPProvider({
    endpoint: cfg.acp?.endpoint || "http://localhost:3001",
    apiKey: cfg.acp?.apiKey,
  });
}

function getProvider(name) {
  if (!providers[name]) initProviders();
  return providers[name] || null;
}

function registerAgentHandlers() {
  initProviders();

  // List available providers and their status
  ipcMain.handle("agent:providers", () => {
    const cfg = getProviderConfig();
    return [
      {
        name: "claude",
        label: "Claude",
        configured: !!cfg.claude?.apiKey,
        models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250506"],
        defaultModel: "claude-sonnet-4-20250514",
      },
      {
        name: "codex",
        label: "ChatGPT Codex",
        configured: !!cfg.codex?.apiKey,
        models: ["gpt-4o", "gpt-4o-mini", "o3", "o4-mini", "codex-mini"],
        defaultModel: "gpt-4o",
      },
      {
        name: "acp",
        label: "ACP Agent",
        configured: !!cfg.acp?.endpoint,
        models: [],
        defaultModel: "",
      },
      {
        name: "terminal",
        label: "Claude Code (Terminal)",
        configured: true,
        models: [],
        defaultModel: "",
      },
    ];
  });

  // Configure a provider
  ipcMain.handle("agent:configure", (_e, { provider, config }) => {
    const cfg = getProviderConfig();
    cfg[provider] = { ...cfg[provider], ...config };
    saveProviderConfig(cfg);

    // Re-init providers
    initProviders();
    return true;
  });

  // Get provider config (masking API keys)
  ipcMain.handle("agent:get-config", (_e, providerName) => {
    const cfg = getProviderConfig();
    const pc = cfg[providerName] || {};
    return {
      ...pc,
      apiKey: pc.apiKey ? "***" + pc.apiKey.slice(-4) : "",
    };
  });

  // Send a chat message
  ipcMain.on("agent:send", async (e, { sessionId, provider: providerName, message, model }) => {
    const sender = e.sender;
    const p = getProvider(providerName);

    if (!p) {
      sender.send("agent:error", { sessionId, error: `Unknown provider: ${providerName}` });
      return;
    }

    if (!p.isAvailable()) {
      sender.send("agent:error", {
        sessionId,
        error: `${p.label} is not configured. Add your API key in Settings.`,
      });
      return;
    }

    // Add user message to history
    if (!chatHistories.has(sessionId)) chatHistories.set(sessionId, []);
    const history = chatHistories.get(sessionId);
    history.push({ role: "user", content: message, timestamp: Date.now() });

    // Notify start
    sender.send("agent:stream-start", { sessionId });

    try {
      const result = await p.sendMessage(
        sessionId,
        history,
        { model: model || undefined },
        (chunk) => {
          if (!sender.isDestroyed()) {
            sender.send("agent:chunk", { sessionId, chunk });
          }
        }
      );

      if (!result.aborted) {
        history.push({ role: "assistant", content: result.content, timestamp: Date.now() });
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

  // Get chat history for a session
  ipcMain.handle("agent:history", (_e, sessionId) => {
    return chatHistories.get(sessionId) || [];
  });

  // Clear chat history
  ipcMain.on("agent:clear-history", (_e, sessionId) => {
    chatHistories.delete(sessionId);
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
