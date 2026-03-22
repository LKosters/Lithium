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
  pollACPServerStatus();
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  btnSettings.classList.remove("active");
  app.animateClose(settingsOverlay, "fadeDown", 180);
  stopACPStatusPolling();
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

// ── Agent settings ───────────────────────────────────
const defaultAgentGrid = document.querySelector("#settings-default-agent");
const acpProvidersSection = document.querySelector("#settings-acp-providers");
const toggleCodex = document.querySelector("#toggle-acp-codex");
const toggleCursor = document.querySelector("#toggle-acp-cursor");

let _selectedMode = "terminal"; // "terminal" or "acp"
let _acpStatusInterval = null;

async function loadAgentSettings() {
  try {
    _selectedMode = await ipcRenderer.invoke("agent:get-default");
    // Normalize: any ACP provider maps to "acp" mode
    if (_selectedMode !== "terminal") _selectedMode = "acp";

    // Load enabled ACPs
    const enabled = await ipcRenderer.invoke("agent:get-enabled-acps");
    toggleCodex.checked = enabled.includes("acp");
    toggleCursor.checked = enabled.includes("cursor-acp");

    updateModeUI();
  } catch (err) {
    console.warn("Failed to load agent settings:", err.message);
  }
}

function updateModeUI() {
  defaultAgentGrid.querySelectorAll(".agent-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.agent === _selectedMode);
  });
  acpProvidersSection.classList.toggle("hidden", _selectedMode !== "acp");
}

// Mode card clicks
defaultAgentGrid.querySelectorAll(".agent-card").forEach((card) => {
  card.addEventListener("click", async () => {
    _selectedMode = card.dataset.agent;
    updateModeUI();
    await ipcRenderer.invoke("agent:set-default", _selectedMode === "acp" ? "acp" : "terminal");
  });
});

// ACP provider toggles
toggleCodex.addEventListener("change", async () => {
  await ipcRenderer.invoke("agent:set-acp-enabled", { provider: "acp", enabled: toggleCodex.checked });
});

toggleCursor.addEventListener("change", async () => {
  await ipcRenderer.invoke("agent:set-acp-enabled", { provider: "cursor-acp", enabled: toggleCursor.checked });
});

// ── ACP server start/stop toggles (debug) ────────────
const btnACPToggle = document.querySelector("#btn-acp-server-toggle");

btnACPToggle.addEventListener("click", async () => {
  const status = await ipcRenderer.invoke("agent:acp-server-status");
  if (status.running) {
    await ipcRenderer.invoke("agent:acp-server-stop");
  } else {
    await ipcRenderer.invoke("agent:acp-server-start");
  }
  setTimeout(updateACPServerStatus, 1500);
});

const btnCursorACPToggle = document.querySelector("#btn-cursor-acp-server-toggle");

btnCursorACPToggle.addEventListener("click", async () => {
  const status = await ipcRenderer.invoke("agent:cursor-acp-server-status");
  if (status.running) {
    await ipcRenderer.invoke("agent:cursor-acp-server-stop");
  } else {
    await ipcRenderer.invoke("agent:cursor-acp-server-start");
  }
  setTimeout(updateCursorACPServerStatus, 1500);
});

// ── ACP server status polling ────────────────────────
function updateServerStatusUI(result, dotId, labelId, btnId, errorId) {
  const dot = document.querySelector(dotId);
  const label = document.querySelector(labelId);
  const btn = document.querySelector(btnId);
  const errorEl = errorId ? document.querySelector(errorId) : null;
  if (!dot || !label || !btn) return;

  if (result.status === "running") {
    dot.style.background = "var(--secondary)";
    label.textContent = "Running";
    btn.textContent = "Stop";
  } else if (result.status === "starting") {
    dot.style.background = "#E8A838";
    label.textContent = "Starting...";
    btn.textContent = "Stop";
  } else {
    dot.style.background = "var(--muted)";
    label.textContent = "Stopped";
    btn.textContent = "Start";
  }

  if (errorEl) {
    if (result.lastError && result.status === "stopped") {
      errorEl.textContent = result.lastError;
      errorEl.classList.remove("hidden");
    } else {
      errorEl.classList.add("hidden");
    }
  }
}

async function updateACPServerStatus() {
  try {
    const result = await ipcRenderer.invoke("agent:acp-server-status");
    updateServerStatusUI(result, "#acp-server-dot", "#acp-server-label", "#btn-acp-server-toggle", "#acp-server-error");
  } catch {}
}

async function updateCursorACPServerStatus() {
  try {
    const result = await ipcRenderer.invoke("agent:cursor-acp-server-status");
    updateServerStatusUI(result, "#cursor-acp-server-dot", "#cursor-acp-server-label", "#btn-cursor-acp-server-toggle", "#cursor-acp-server-error");
  } catch {}
}

function pollACPServerStatus() {
  updateACPServerStatus();
  updateCursorACPServerStatus();
  _acpStatusInterval = setInterval(() => {
    updateACPServerStatus();
    updateCursorACPServerStatus();
  }, 3000);
}

function stopACPStatusPolling() {
  if (_acpStatusInterval) {
    clearInterval(_acpStatusInterval);
    _acpStatusInterval = null;
  }
}

// ── IPC: open settings from app menu (Cmd+,) ─────────
ipcRenderer.on("menu:open-settings", () => {
  if (!settingsOpen) openSettings();
});

module.exports = { openSettings, closeSettings, isSettingsOpen };
