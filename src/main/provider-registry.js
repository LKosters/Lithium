// Provider registry — single source of truth for all ACP providers.
// To add a new provider, just add an entry here.
const { createACPServerManager } = require("./acp-server-factory");
const { BaseACPProvider } = require("./providers/base-acp-provider");

const PROVIDER_CONFIGS = [
  {
    id: "acp",
    label: "Codex",
    command: "npx",
    args: ["@zed-industries/codex-acp"],
    authMethodId: "chatgpt",
    modelEnvVar: "OPENAI_MODEL",
    models: [
      { id: "gpt-5", label: "GPT-5" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
    ],
    defaultModel: "gpt-5",
  },
  {
    id: "cursor-acp",
    label: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    authMethodId: "cursor_login",
    modelEnvVar: "CURSOR_MODEL",
    models: [
      { id: "auto", label: "Auto" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "gpt-5", label: "GPT-5" },
    ],
    defaultModel: "auto",
  },
  {
    id: "claude-acp",
    label: "Claude",
    command: "npx",
    args: ["@agentclientprotocol/claude-agent-acp"],
    authMethodId: "claude-login",
    modelEnvVar: "ANTHROPIC_MODEL",
    models: [
      { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
    defaultModel: "claude-sonnet-4-6",
  },
];

// Build server managers and provider instances from config
const servers = {};
const providers = {};

for (const cfg of PROVIDER_CONFIGS) {
  servers[cfg.id] = createACPServerManager({
    name: cfg.id,
    command: cfg.command,
    args: cfg.args,
    authMethodId: cfg.authMethodId,
    modelEnvVar: cfg.modelEnvVar,
    logPrefix: `[${cfg.id}]`,
  });

  providers[cfg.id] = new BaseACPProvider({
    name: cfg.id,
    label: cfg.label,
    server: servers[cfg.id],
  });
}

function getProviderModels(id) {
  const cfg = PROVIDER_CONFIGS.find(c => c.id === id);
  if (!cfg) return { models: [], defaultModel: null };
  return { models: cfg.models || [], defaultModel: cfg.defaultModel || null };
}

function getProvider(id) {
  return providers[id] || null;
}

function getServer(id) {
  return servers[id] || null;
}

function getAllProviderIds() {
  return PROVIDER_CONFIGS.map(c => c.id);
}

function getProviderLabel(id) {
  const cfg = PROVIDER_CONFIGS.find(c => c.id === id);
  return cfg ? cfg.label : id;
}

function getAllProviderConfigs() {
  return PROVIDER_CONFIGS;
}

module.exports = {
  getProvider,
  getServer,
  getAllProviderIds,
  getProviderLabel,
  getAllProviderConfigs,
  getProviderModels,
  servers,
  providers,
};
