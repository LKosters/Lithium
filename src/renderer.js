const { ipcRenderer } = require("electron");

// ── Shared context ────────────────────────────────────
const app = require("./renderer/app");
app.ipcRenderer = ipcRenderer;

// ── Load modules ──────────────────────────────────────
const { state, terminals, collapsedDirs } = require("./renderer/state");
const { groupSessionsByDir } = require("./renderer/helpers");
const { createTerminal, fitAllVisibleTerminals } = require("./renderer/terminal");
const { renderLayout, refreshLayout, startDragOverlay, stopDragOverlay } = require("./renderer/layout");
const { openTab, closeTab, newSession } = require("./renderer/tabs");
const { renderSessionList, deleteSession } = require("./renderer/sessions");
const { initBrowser } = require("./renderer/browser");
const { initMusicPlayer, updateTrackProgress } = require("./renderer/music");
const { enterFocusMode, exitFocusMode } = require("./renderer/focus");
const { closeSettings, isSettingsOpen } = require("./renderer/settings");
const { closeGit, isGitOpen, refreshGit } = require("./renderer/git");
const { pickDirectory, renderRecentDirs } = require("./renderer/directory");

// ── Wire functions onto app for cross-module calls ────
app.state = state;
app.dom = {
  sessionListEl: document.querySelector("#session-list"),
  tabsEl: document.querySelector("#tabs"),
  tabBar: document.querySelector("#tab-bar"),
  terminalArea: document.querySelector("#terminal-area"),
  welcomeEl: document.querySelector("#welcome"),
};
app.createTerminal = createTerminal;
app.fitAllVisibleTerminals = fitAllVisibleTerminals;
app.renderLayout = renderLayout;
app.refreshLayout = refreshLayout;
app.openTab = openTab;
app.closeTab = closeTab;
app.newSession = newSession;
app.renderSessionList = renderSessionList;
app.deleteSession = deleteSession;
app.enterFocusMode = enterFocusMode;
app.exitFocusMode = exitFocusMode;
app.pickDirectory = pickDirectory;
app.refreshGit = refreshGit;

// ── Sidebar resize ────────────────────────────────────
{
  const sidebar = document.querySelector("#sidebar");
  const resizeHandle = document.querySelector("#sidebar-resize-handle");
  let dragging = false;
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    resizeHandle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    startDragOverlay("col-resize");
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const newWidth = Math.min(500, Math.max(180, e.clientX));
    sidebar.style.width = newWidth + "px";
    fitAllVisibleTerminals();
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    stopDragOverlay();
  });
}

// ── Event bindings ────────────────────────────────────
document.querySelector("#btn-new-session").addEventListener("click", newSession);

// ── Global keydown ────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isSettingsOpen()) {
    closeSettings();
    return;
  }
  if (e.key === "Escape" && isGitOpen()) {
    closeGit();
    return;
  }
  if (e.key === "Escape" && state.focusMode.active) {
    exitFocusMode();
  }
});

// ── PTY events from main ──────────────────────────────
ipcRenderer.on("pty:data", (_e, { sessionId, data }) => {
  const t = terminals.get(sessionId);
  if (t) t.term.write(data);
});

ipcRenderer.on("pty:exit", (_e, { sessionId, exitCode, resume, lifetime }) => {
  if (resume && lifetime < 5000 && exitCode !== 0) {
    deleteSession(sessionId);
    return;
  }

  const t = terminals.get(sessionId);
  if (t) {
    t.alive = false;
    t.term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
  }
  refreshLayout();
});

// Focus mode auto-exit on pty:exit
ipcRenderer.on("pty:exit", (_e, { sessionId }) => {
  if (state.focusMode.active && state.focusMode.sessionId === sessionId) {
    exitFocusMode();
  }
});

// ── Resize observer ───────────────────────────────────
const ro = new ResizeObserver(() => {
  requestAnimationFrame(() => fitAllVisibleTerminals());
});
ro.observe(app.dom.terminalArea);

// ── Start track progress animation ────────────────────
requestAnimationFrame(updateTrackProgress);

// ── Browser panel ─────────────────────────────────────
initBrowser();

// ── Init ──────────────────────────────────────────────
async function init() {
  const dirData = await ipcRenderer.invoke("directory:recents");
  state.recentDirs = dirData.recents || [];
  state.starredDirs = dirData.starred || [];
  renderRecentDirs();

  state.sessions = await ipcRenderer.invoke("sessions:list");
  renderSessionList();
  refreshLayout();

  initMusicPlayer();

  const sessionListEl = app.dom.sessionListEl;
  requestAnimationFrame(() => {
    const listEl = sessionListEl.parentElement;
    if (listEl.scrollHeight > listEl.clientHeight) {
      const groups = groupSessionsByDir(state.sessions);
      for (const [dir] of groups) {
        collapsedDirs.add(dir);
      }
      renderSessionList();
    }
  });
}

init();
