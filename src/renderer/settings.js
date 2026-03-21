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
const defaultModelGroup = document.querySelector("#settings-default-model-group");
const defaultModelSelect = document.querySelector("#settings-default-model");
const defaultModelLabel = document.querySelector("#settings-default-model-label");

let _providerData = [];
let _selectedDefaultAgent = "terminal";
let _acpStatusInterval = null;

async function loadAgentSettings() {
  try {
    _providerData = await ipcRenderer.invoke("agent:providers");
    _selectedDefaultAgent = await ipcRenderer.invoke("agent:get-default");

    for (const p of _providerData) {
      const statusEl = document.querySelector(`#agent-status-${p.name}`);
      if (statusEl) statusEl.classList.toggle("configured", p.configured);
    }

    updateDefaultAgentUI();
  } catch (err) {
    console.warn("Failed to load agent settings:", err.message);
  }
}

function updateDefaultAgentUI() {
  defaultAgentGrid.querySelectorAll(".agent-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.agent === _selectedDefaultAgent);
  });

  const provData = _providerData.find((p) => p.name === _selectedDefaultAgent);
  if (provData && provData.models && provData.models.length > 0) {
    defaultModelGroup.classList.remove("hidden");
    defaultModelLabel.textContent = `${provData.label} model`;
    defaultModelSelect.innerHTML = provData.models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join("");

    ipcRenderer.invoke("agent:get-default-model", _selectedDefaultAgent).then((savedModel) => {
      if (savedModel) defaultModelSelect.value = savedModel;
      else defaultModelSelect.value = provData.defaultModel;
    });
  } else {
    defaultModelGroup.classList.add("hidden");
  }
}

// Agent card clicks
defaultAgentGrid.querySelectorAll(".agent-card").forEach((card) => {
  card.addEventListener("click", async () => {
    _selectedDefaultAgent = card.dataset.agent;
    updateDefaultAgentUI();
    await ipcRenderer.invoke("agent:set-default", _selectedDefaultAgent);
  });
});

// Default model change
defaultModelSelect.addEventListener("change", async () => {
  await ipcRenderer.invoke("agent:set-default-model", {
    provider: _selectedDefaultAgent,
    model: defaultModelSelect.value,
  });
});

// ── ACP server start/stop toggle ─────────────────────
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

// ── ACP server status polling ────────────────────────
async function updateACPServerStatus() {
  try {
    const result = await ipcRenderer.invoke("agent:acp-server-status");
    const dot = document.querySelector("#acp-server-dot");
    const label = document.querySelector("#acp-server-label");
    const btn = document.querySelector("#btn-acp-server-toggle");
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
  } catch {}
}

function pollACPServerStatus() {
  updateACPServerStatus();
  _acpStatusInterval = setInterval(updateACPServerStatus, 3000);
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
