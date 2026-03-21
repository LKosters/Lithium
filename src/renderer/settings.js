const { ipcRenderer } = require("electron");
const app = require("./app");

const settingsOverlay = document.querySelector("#settings-overlay");
const btnSettings = document.querySelector("#btn-settings");
const btnSettingsBack = document.querySelector("#btn-settings-back");
let settingsOpen = false;

const navItems = settingsOverlay.querySelectorAll("[data-settings-tab]");
const panels = settingsOverlay.querySelectorAll("[data-settings-panel]");

navItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.settingsTab;
    navItems.forEach((n) => n.classList.toggle("active", n === btn));
    panels.forEach((p) => p.classList.toggle("active", p.dataset.settingsPanel === tab));
  });
});

// ── Player mode setting ──────────────────────────────
const playerModeBtns = document.querySelectorAll("[data-player-mode]");
const previewFull = document.querySelector(".pm-preview-full");
const previewCompact = document.querySelector(".pm-preview-compact");
const previewNone = document.querySelector(".pm-preview-none");
const previews = { full: previewFull, compact: previewCompact, none: previewNone };

function updatePlayerModeUI(mode) {
  playerModeBtns.forEach((b) => b.classList.toggle("active", b.dataset.playerMode === mode));
  Object.entries(previews).forEach(([key, el]) => {
    if (el) el.classList.toggle("hidden", key !== mode);
  });
}

playerModeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.playerMode;
    updatePlayerModeUI(mode);
    if (app.setPlayerMode) app.setPlayerMode(mode);
  });
});

function openSettings() {
  settingsOpen = true;
  settingsOverlay.classList.remove("hidden");
  btnSettings.classList.add("active");

  // Restore current player mode in UI
  const currentMode = localStorage.getItem("playerMode") || "full";
  updatePlayerModeUI(currentMode);

  // Load settings data
  loadProjectsDirSetting();
  loadAgentSettings();
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  btnSettings.classList.remove("active");
  app.animateClose(settingsOverlay, "fadeDown", 180);
}

btnSettings.addEventListener("click", () => {
  if (settingsOpen) closeSettings();
  else openSettings();
});

btnSettingsBack.addEventListener("click", closeSettings);

function isSettingsOpen() {
  return settingsOpen;
}

// ── Projects directory setting ───────────────────────
const settingsProjectsDir = document.querySelector("#settings-projects-dir");
const btnSettingsProjectsDir = document.querySelector("#btn-settings-projects-dir");
const btnCreateProjectsDir = document.querySelector("#btn-create-projects-dir");
const { shortDir } = require("./helpers");

function showProjectsDir(dir) {
  settingsProjectsDir.textContent = shortDir(dir);
  settingsProjectsDir.classList.remove("muted");
  btnCreateProjectsDir.classList.add("hidden");
}

async function loadProjectsDirSetting() {
  try {
    const dir = await ipcRenderer.invoke("config:resolve-projects-dir");
    if (dir) {
      showProjectsDir(dir);
    } else {
      settingsProjectsDir.textContent = "Not set";
      settingsProjectsDir.classList.add("muted");
      btnCreateProjectsDir.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Failed to load projects directory setting:", err.message);
  }
}

btnSettingsProjectsDir.addEventListener("click", async () => {
  try {
    const result = await ipcRenderer.invoke("directory:pick");
    if (result) {
      ipcRenderer.send("config:set", { key: "projectsDir", value: result.dir });
      showProjectsDir(result.dir);
    }
  } catch (err) {
    console.error("Failed to pick projects directory:", err.message);
  }
});

btnCreateProjectsDir.addEventListener("click", async () => {
  try {
    const dir = await ipcRenderer.invoke("config:create-default-projects-dir");
    if (dir) showProjectsDir(dir);
  } catch (err) {
    console.error("Failed to create projects directory:", err.message);
  }
});

// ── Agent API key settings ────────────────────────────
const claudeKeyInput = document.querySelector("#settings-claude-key");
const codexKeyInput = document.querySelector("#settings-codex-key");
const acpEndpointInput = document.querySelector("#settings-acp-endpoint");
const acpKeyInput = document.querySelector("#settings-acp-key");

async function loadAgentSettings() {
  try {
    const claudeCfg = await ipcRenderer.invoke("agent:get-config", "claude");
    if (claudeCfg?.apiKey) claudeKeyInput.value = claudeCfg.apiKey;

    const codexCfg = await ipcRenderer.invoke("agent:get-config", "codex");
    if (codexCfg?.apiKey) codexKeyInput.value = codexCfg.apiKey;

    const acpCfg = await ipcRenderer.invoke("agent:get-config", "acp");
    if (acpCfg?.endpoint) acpEndpointInput.value = acpCfg.endpoint;
    if (acpCfg?.apiKey) acpKeyInput.value = acpCfg.apiKey;
  } catch (err) {
    console.warn("Failed to load agent settings:", err.message);
  }
}

function flashSaved(btn) {
  const orig = btn.textContent;
  btn.textContent = "Saved";
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
}

document.querySelector("#btn-save-claude-key").addEventListener("click", async (e) => {
  const val = claudeKeyInput.value.trim();
  if (val && !val.startsWith("***")) {
    await ipcRenderer.invoke("agent:configure", { provider: "claude", config: { apiKey: val } });
    claudeKeyInput.value = "***" + val.slice(-4);
    flashSaved(e.target);
  }
});

document.querySelector("#btn-save-codex-key").addEventListener("click", async (e) => {
  const val = codexKeyInput.value.trim();
  if (val && !val.startsWith("***")) {
    await ipcRenderer.invoke("agent:configure", { provider: "codex", config: { apiKey: val } });
    codexKeyInput.value = "***" + val.slice(-4);
    flashSaved(e.target);
  }
});

document.querySelector("#btn-save-acp-endpoint").addEventListener("click", async (e) => {
  const val = acpEndpointInput.value.trim();
  if (val) {
    await ipcRenderer.invoke("agent:configure", { provider: "acp", config: { endpoint: val } });
    flashSaved(e.target);
  }
});

document.querySelector("#btn-save-acp-key").addEventListener("click", async (e) => {
  const val = acpKeyInput.value.trim();
  if (val && !val.startsWith("***")) {
    await ipcRenderer.invoke("agent:configure", { provider: "acp", config: { apiKey: val } });
    acpKeyInput.value = "***" + val.slice(-4);
    flashSaved(e.target);
  }
});

// ── IPC: open settings from app menu (Cmd+,) ─────────
ipcRenderer.on("menu:open-settings", () => {
  if (!settingsOpen) openSettings();
});

module.exports = { openSettings, closeSettings, isSettingsOpen };
