const { ipcRenderer } = require("electron");

// ── Shared context ────────────────────────────────────
const app = require("./renderer/app");
app.ipcRenderer = ipcRenderer;

// ── Load modules ──────────────────────────────────────
const { state, terminals } = require("./renderer/state");
const { createTerminal, fitAllVisibleTerminals } = require("./renderer/terminal");
const { renderLayout, refreshLayout, startDragOverlay, stopDragOverlay, getSavedLayout, clearSavedLayout } = require("./renderer/layout");
const { openTab, closeTab, newSession, splitNewSession } = require("./renderer/tabs");
const { renderSessionList, deleteSession } = require("./renderer/sessions");
const { initBrowser } = require("./renderer/browser");
const { initMusicPlayer, updateTrackProgress, setPlayerMode } = require("./renderer/music");
const { closeSettings, isSettingsOpen } = require("./renderer/settings");
const { closeGit, isGitOpen, refreshGit } = require("./renderer/git");
const { pickDirectory, setDirectory, renderRecentDirs, renderProjectsList } = require("./renderer/directory");

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
app.pickDirectory = pickDirectory;
app.setDirectory = setDirectory;
app.renderProjectsList = renderProjectsList;
app.refreshGit = refreshGit;
app.setPlayerMode = setPlayerMode;

// ── Load feature modules (must come after app wiring) ─
const { openSearchBar, closeSearchBar, isSearchBarOpen, updateSearchBarWorkspace } = require("./renderer/search-bar");
const { closeQuickOpen, isQuickOpenVisible } = require("./renderer/quick-open");
const { closeNewProject, isNewProjectVisible } = require("./renderer/new-project");
const { checkDevServerAvailable, restoreDevServer } = require("./renderer/dev-server");

app.updateSearchBarWorkspace = updateSearchBarWorkspace;
app.checkDevServerAvailable = checkDevServerAvailable;

// ── Version tag ──────────────────────────────────────
{
  const pkg = require("../package.json");
  const versionTag = document.getElementById("version-tag");
  if (versionTag) versionTag.textContent = `Alpha v${pkg.version}`;
}

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
    const newWidth = Math.min(600, Math.max(280, e.clientX));
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
document.querySelector("#btn-add-workspace").addEventListener("click", pickDirectory);

// ── Double shift → open search bar ───────────────────
let _lastShiftUp = 0;
document.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const now = Date.now();
    if (now - _lastShiftUp < 350) {
      _lastShiftUp = 0;
      openSearchBar();
    } else {
      _lastShiftUp = now;
    }
  }
});

// ── Global keydown ────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isNewProjectVisible()) { closeNewProject(); return; }
  if (e.key === "Escape" && isSearchBarOpen()) { closeSearchBar(); return; }
  if (e.key === "Escape" && isQuickOpenVisible()) { closeQuickOpen(); return; }
  if (e.key === "Escape" && isSettingsOpen()) { closeSettings(); return; }
  if (e.key === "Escape" && isGitOpen()) { closeGit(); return; }

  if (e.code === "KeyP" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    openSearchBar();
    return;
  }
  // Cmd+Shift+D — split vertical (check shift first)
  if (e.code === "KeyD" && e.metaKey && e.shiftKey) {
    e.preventDefault();
    splitNewSession("vertical");
    return;
  }
  // Cmd+D — split horizontal
  if (e.code === "KeyD" && e.metaKey && !e.shiftKey) {
    e.preventDefault();
    splitNewSession("horizontal");
    return;
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

  const savedDir = localStorage.getItem("currentDir");
  if (savedDir) setDirectory(savedDir);

  state.sessions = await ipcRenderer.invoke("sessions:list");

  // Restore previously open tabs/layout
  let saved = getSavedLayout();
  if (!saved || !saved.layout) {
    saved = await ipcRenderer.invoke("layout:load");
  }
  if (saved && saved.layout) {
    const { getAllLeaves, cleanupEmptyLeaves, findLeafById } = require("./renderer/state");
    const sessionIds = new Set(state.sessions.map((s) => s.id));

    for (const leaf of getAllLeaves(saved.layout)) {
      leaf.tabs = leaf.tabs.filter((id) => sessionIds.has(id));
      if (leaf.activeTab && !sessionIds.has(leaf.activeTab)) {
        leaf.activeTab = leaf.tabs[leaf.tabs.length - 1] || null;
      }
    }
    const cleaned = cleanupEmptyLeaves(saved.layout);

    if (cleaned) {
      for (const leaf of getAllLeaves(cleaned)) {
        for (const sid of leaf.tabs) {
          const s = state.sessions.find((ss) => ss.id === sid);
          if (s && !terminals.has(sid)) {
            createTerminal(sid);
            ipcRenderer.send("pty:spawn", { sessionId: sid, cwd: s.directory, resume: true });
          }
        }
      }
      state.layout = cleaned;
      state.focusedPaneId = findLeafById(cleaned, saved.focusedPaneId)
        ? saved.focusedPaneId
        : getAllLeaves(cleaned)[0].id;
    } else {
      clearSavedLayout();
    }
  }

  renderProjectsList();
  renderSessionList();
  refreshLayout();

  initMusicPlayer().catch((err) => console.error("Music player init failed:", err));

  await restoreDevServer();
}

init();
