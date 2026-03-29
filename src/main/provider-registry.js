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
  },
  {
    id: "cursor-acp",
    label: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    authMethodId: "cursor_login",
  },
  {
    id: "claude-acp",
    label: "Claude",
    command: "npx",
    args: ["@agentclientprotocol/claude-agent-acp"],
    authMethodId: "claude-login",
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
    logPrefix: `[${cfg.id}]`,
  });

  providers[cfg.id] = new BaseACPProvider({
    name: cfg.id,
    label: cfg.label,
    server: servers[cfg.id],
  });
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
  servers,
  providers,
};
