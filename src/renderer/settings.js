const preferences = require('./preferences');
const { ipcRenderer } = require("electron");
const app = require("./app");

const settingsOverlay = document.querySelector("#settings-overlay");
const btnSettings = document.querySelector("#btn-settings");
const btnSettingsBack = document.querySelector("#btn-settings-back");
let settingsOpen = false;
const chatSettings = require('./chat-settings').createChatSettings(ipcRenderer, settingsOverlay);
const dataSettings = require('./data-settings').createDataSettings(ipcRenderer, settingsOverlay);

const webSettings = require('./web-settings').createWebSettings(ipcRenderer, settingsOverlay);

const navItems = settingsOverlay.querySelectorAll("[data-settings-tab]");
const panels = settingsOverlay.querySelectorAll("[data-settings-panel]");

navItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.settingsTab;
    navItems.forEach((n) => n.classList.toggle("active", n === btn));
    panels.forEach((p) => p.classList.toggle("active", p.dataset.settingsPanel === tab));
    if (tab === 'chats') chatSettings.load();
    if (tab === 'data') dataSettings.load();
    if (tab === 'web') webSettings.load();
  });
});

// ── Sidebar view setting ────────────────────────────
const sidebarViewBtns = document.querySelectorAll("[data-sidebar-view]");

function setSidebarView(mode) {
  preferences.setItem("sidebarView", mode);
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
  if (settingsOverlay.querySelector('[data-settings-panel="web"].active')) webSettings.load();
  if (settingsOverlay.querySelector('[data-settings-panel="data"].active')) dataSettings.load();
  if (settingsOverlay.querySelector('[data-settings-panel="chats"].active')) chatSettings.load();
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

// ── IPC: open settings from app menu (Cmd+,) ─────────
ipcRenderer.on("menu:open-settings", () => {
  if (!settingsOpen) openSettings();
});

module.exports = { openSettings, closeSettings, isSettingsOpen };
