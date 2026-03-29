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

// ── Sidebar view setting ────────────────────────────
const sidebarViewBtns = document.querySelectorAll("[data-sidebar-view]");

function setSidebarView(mode) {
  localStorage.setItem("sidebarView", mode);
  const sidebar = document.querySelector("#sidebar");
  if (sidebar) {
    sidebar.classList.toggle("sidebar-compact", mode === "compact");
  }
}

function updateSidebarViewUI(mode) {
  sidebarViewBtns.forEach((b) => b.classList.toggle("active", b.dataset.sidebarView === mode));
}

sidebarViewBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.sidebarView;
    updateSidebarViewUI(mode);
    setSidebarView(mode);
  });
});

// Restore sidebar view on load
(function restoreSidebarView() {
  const saved = localStorage.getItem("sidebarView") || "default";
  setSidebarView(saved);
})();

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

  // Restore current sidebar view in UI
  const currentSidebarView = localStorage.getItem("sidebarView") || "default";
  updateSidebarViewUI(currentSidebarView);

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

let _selectedMode = "terminal"; // "terminal" or "acp"
let _acpStatusInterval = null;

async function loadAgentSettings() {
  try {
    _selectedMode = await ipcRenderer.invoke("agent:get-default");
    if (_selectedMode !== "terminal") _selectedMode = "acp";

    // Load enabled ACPs and set toggles dynamically
    const enabled = await ipcRenderer.invoke("agent:get-enabled-acps");
    document.querySelectorAll("[data-acp-toggle]").forEach((toggle) => {
      toggle.checked = enabled.includes(toggle.dataset.acpToggle);
    });

    // Load tool approval mode
    const approvalMode = await ipcRenderer.invoke("agent:get-tool-approval-mode");
    const approvalToggle = document.querySelector("#toggle-tool-approval");
    if (approvalToggle) {
      approvalToggle.checked = approvalMode !== "auto";
    }

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

// ACP provider toggles — driven by data-acp-toggle attribute
document.querySelectorAll("[data-acp-toggle]").forEach((toggle) => {
  toggle.addEventListener("change", async () => {
    await ipcRenderer.invoke("agent:set-acp-enabled", {
      provider: toggle.dataset.acpToggle,
      enabled: toggle.checked,
    });
  });
});

// Tool approval mode toggle
const toolApprovalToggle = document.querySelector("#toggle-tool-approval");
if (toolApprovalToggle) {
  toolApprovalToggle.addEventListener("change", async () => {
    const mode = toolApprovalToggle.checked ? "manual" : "auto";
    await ipcRenderer.invoke("agent:set-tool-approval-mode", mode);
  });
}

// ACP server start/stop toggles — driven by data-acp-server attribute
document.querySelectorAll("[data-acp-server]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const providerId = btn.dataset.acpServer;
    const status = await ipcRenderer.invoke(`agent:${providerId}-server-status`);
    if (status.running) {
      await ipcRenderer.invoke(`agent:${providerId}-server-stop`);
    } else {
      await ipcRenderer.invoke(`agent:${providerId}-server-start`);
    }
    setTimeout(() => updateServerStatus(providerId), 1500);
  });
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

async function updateServerStatus(providerId) {
  try {
    const result = await ipcRenderer.invoke(`agent:${providerId}-server-status`);
    updateServerStatusUI(
      result,
      `#${providerId}-server-dot`,
      `#${providerId}-server-label`,
      `#btn-${providerId}-server-toggle`,
      `#${providerId}-server-error`
    );
  } catch {}
}

function pollACPServerStatus() {
  // Poll all providers with data-acp-server buttons
  const providerIds = [...document.querySelectorAll("[data-acp-server]")].map(b => b.dataset.acpServer);
  providerIds.forEach(id => updateServerStatus(id));
  _acpStatusInterval = setInterval(() => {
    providerIds.forEach(id => updateServerStatus(id));
  }, 3000);
}

function stopACPStatusPolling() {
  if (_acpStatusInterval) {
    clearInterval(_acpStatusInterval);
    _acpStatusInterval = null;
  }
}

// ── Update checker ───────────────────────────────────
const aboutVersion = document.querySelector("#about-version");
const updateStatus = document.querySelector("#update-status");
const btnCheckUpdate = document.querySelector("#btn-check-update");
const btnDownloadUpdate = document.querySelector("#btn-download-update");
let _releaseUrl = null;

// Show current version in about panel
(async () => {
  try {
    const version = await ipcRenderer.invoke("updater:get-version");
    if (aboutVersion) aboutVersion.textContent = version;
  } catch {}
})();

if (btnCheckUpdate) {
  btnCheckUpdate.addEventListener("click", async () => {
    btnCheckUpdate.disabled = true;
    btnCheckUpdate.textContent = "Checking...";
    updateStatus.textContent = "Checking for updates...";
    btnDownloadUpdate.classList.add("hidden");

    try {
      const result = await ipcRenderer.invoke("updater:check");
      if (result.error) {
        updateStatus.textContent = `Failed to check: ${result.error}`;
      } else if (result.updateAvailable) {
        updateStatus.textContent = `New version available: v${result.latestVersion}`;
        _releaseUrl = result.releaseUrl;
        btnDownloadUpdate.classList.remove("hidden");
      } else {
        updateStatus.textContent = `You're on the latest version (v${result.currentVersion})`;
      }
    } catch (err) {
      updateStatus.textContent = `Failed to check: ${err.message}`;
    }

    btnCheckUpdate.disabled = false;
    btnCheckUpdate.textContent = "Check for Updates";
  });
}

if (btnDownloadUpdate) {
  btnDownloadUpdate.addEventListener("click", () => {
    if (_releaseUrl) ipcRenderer.send("updater:open-release", _releaseUrl);
  });
}

// ── IPC: open settings from app menu (Cmd+,) ─────────
ipcRenderer.on("menu:open-settings", () => {
  if (!settingsOpen) openSettings();
});

module.exports = { openSettings, closeSettings, isSettingsOpen };
