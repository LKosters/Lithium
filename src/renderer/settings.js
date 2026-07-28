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
  ipcRenderer.send("config:set", { key: "sidebarView", value: mode });
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
(async function restoreSidebarView() {
  const saved = await ipcRenderer.invoke("config:get", "sidebarView") || localStorage.getItem("sidebarView") || "default";
  setSidebarView(saved);
  updateSidebarViewUI(saved);
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

// ── Update checker ───────────────────────────────────
const aboutVersion = document.querySelector("#about-version");
const updateStatus = document.querySelector("#update-status");
const btnCheckUpdate = document.querySelector("#btn-check-update");
const btnDownloadUpdate = document.querySelector("#btn-download-update");
let _updateResult = null;

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
        _updateResult = result;
        btnDownloadUpdate.textContent = "Download & Install";
        btnDownloadUpdate.disabled = false;
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
  btnDownloadUpdate.addEventListener("click", async () => {
    if (!_updateResult) return;
    if (_updateResult.downloadUrl) {
      btnDownloadUpdate.disabled = true;
      btnDownloadUpdate.textContent = "Downloading 0%";
      updateStatus.textContent = "Downloading update...";
      ipcRenderer.on("updater:download-progress", (_e, percent) => {
        btnDownloadUpdate.textContent = `Downloading ${percent}%`;
      });
      const res = await ipcRenderer.invoke("updater:download-and-install", {
        downloadUrl: _updateResult.downloadUrl,
        assetName: _updateResult.assetName,
      });
      if (res.error) {
        updateStatus.textContent = `Download failed: ${res.error}`;
        btnDownloadUpdate.textContent = "Retry";
        btnDownloadUpdate.disabled = false;
      } else {
        updateStatus.textContent = "Installing update...";
        btnDownloadUpdate.textContent = "Installing...";
      }
    } else {
      // Fallback if no matching asset
      ipcRenderer.send("updater:open-release", _updateResult.releaseUrl);
    }
  });
}

// ── IPC: open settings from app menu (Cmd+,) ─────────
ipcRenderer.on("menu:open-settings", () => {
  if (!settingsOpen) openSettings();
});

module.exports = { openSettings, closeSettings, isSettingsOpen };
