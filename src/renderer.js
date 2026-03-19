const { ipcRenderer } = require("electron");

// ── Shared context ────────────────────────────────────
const app = require("./renderer/app");
app.ipcRenderer = ipcRenderer;

// ── Load modules ──────────────────────────────────────
const { state, terminals, collapsedDirs } = require("./renderer/state");
const { groupSessionsByDir } = require("./renderer/helpers");
const { createTerminal, fitAllVisibleTerminals } = require("./renderer/terminal");
const { renderLayout, refreshLayout, startDragOverlay, stopDragOverlay, getSavedLayout, clearSavedLayout } = require("./renderer/layout");
const { openTab, closeTab, newSession, splitNewSession } = require("./renderer/tabs");
const { renderSessionList, deleteSession } = require("./renderer/sessions");
const { initBrowser } = require("./renderer/browser");
const { initMusicPlayer, updateTrackProgress, setPlayerMode } = require("./renderer/music");
const { enterFocusMode, exitFocusMode } = require("./renderer/focus");
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
app.enterFocusMode = enterFocusMode;
app.exitFocusMode = exitFocusMode;
app.pickDirectory = pickDirectory;
app.setDirectory = setDirectory;
app.renderProjectsList = renderProjectsList;
app.refreshGit = refreshGit;
app.setPlayerMode = setPlayerMode;

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

// ── Quick open (double shift) ─────────────────────────
const quickOpen = document.querySelector("#quick-open");
const quickOpenInput = document.querySelector("#quick-open-input");
const quickOpenList = document.querySelector("#quick-open-list");
const quickOpenCreate = document.querySelector("#quick-open-create");
const quickOpenNameInput = document.querySelector("#quick-open-name");
const quickOpenDirBtn = document.querySelector("#quick-open-dir-btn");
const quickOpenDirLabel = document.querySelector("#quick-open-dir-label");
const quickOpenCreateBtn = document.querySelector("#quick-open-create-btn");
const qoDirDropdown = document.querySelector("#quick-open-dir-dropdown");
const qoDropdownTabs = document.querySelector("#qo-dropdown-tabs");
const qoDirsList = document.querySelector("#qo-dirs-list");
const qoBrowseBtn = document.querySelector("#qo-browse-btn");
let _lastShiftUp = 0;
let _selectedIdx = -1;
let _createMode = false;
let _createDir = null;
let _qoActiveTab = "favorites";

const { escapeHtml, shortDir, persistSession } = require("./renderer/helpers");
const { terminals: termsMap } = require("./renderer/state");
const { v4: uuidv4 } = require("uuid");
const { createSessionAndOpen, renderDirDropdown, renderSessionList: renderSharedSessionList } = require("./renderer/session-create");

function openQuickOpen() {
  quickOpen.classList.remove("hidden");
  quickOpenInput.value = "";
  _selectedIdx = 0;
  _createMode = false;
  quickOpenCreate.classList.add("hidden");
  _createDir = state.currentDir;
  renderQuickOpenList("");
  quickOpenInput.focus();
}

function closeQuickOpen() {
  if (quickOpen.classList.contains("hidden")) return;
  _createMode = false;
  qoDirDropdown.classList.add("hidden");
  const modal = quickOpen.querySelector(".quick-open-modal");
  const backdrop = quickOpen.querySelector(".quick-open-backdrop");
  modal.style.animation = "dropOut 150ms var(--ease-smooth) forwards";
  backdrop.style.animation = "fadeOut 150ms var(--ease-smooth) forwards";
  setTimeout(() => {
    quickOpen.classList.add("hidden");
    quickOpenCreate.classList.add("hidden");
    modal.style.animation = "";
    backdrop.style.animation = "";
  }, 150);
}

function showCreateForm() {
  _createMode = true;
  quickOpenCreate.classList.remove("hidden");
  quickOpenDirLabel.textContent = _createDir ? shortDir(_createDir) : "Select directory...";
  quickOpenNameInput.value = quickOpenInput.value.trim();
  quickOpenNameInput.focus();
  quickOpenNameInput.select();
}

function doCreateSession() {
  const name = quickOpenNameInput.value.trim();
  if (!_createDir) {
    quickOpenDirBtn.style.borderColor = "var(--primary)";
    setTimeout(() => quickOpenDirBtn.style.borderColor = "", 1000);
    return;
  }
  createSessionAndOpen({ name, dir: _createDir, onDone: closeQuickOpen });
}

function renderQuickOpenList(query) {
  const { totalItems } = renderSharedSessionList({
    query,
    selectedIdx: _selectedIdx,
    listEl: quickOpenList,
    itemClass: "quick-open-item",
    newClass: "quick-open-new",
    emptyClass: "quick-open-empty",
    showWorkspace: false,
    onNew: showCreateForm,
    onSelect: (sid) => { openTab(sid); closeQuickOpen(); },
    onHover: (idx) => { _selectedIdx = idx; updateSelection(); },
  });
  if (_selectedIdx >= totalItems) _selectedIdx = totalItems - 1;
}

function updateSelection() {
  const newEl = quickOpenList.querySelector("[data-action='new']");
  if (newEl) newEl.classList.toggle("selected", _selectedIdx === 0);
  quickOpenList.querySelectorAll(".quick-open-item").forEach((el, i) => {
    el.classList.toggle("selected", i + 1 === _selectedIdx);
  });
}

quickOpenInput.addEventListener("input", () => {
  _selectedIdx = 0;
  _createMode = false;
  quickOpenCreate.classList.add("hidden");
  renderQuickOpenList(quickOpenInput.value);
});

quickOpenInput.addEventListener("keydown", (e) => {
  if (_createMode) return;
  const newEl = quickOpenList.querySelector("[data-action='new']");
  const items = quickOpenList.querySelectorAll(".quick-open-item");
  const total = (newEl ? 1 : 0) + items.length;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    _selectedIdx = Math.min(_selectedIdx + 1, total - 1);
    updateSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _selectedIdx = Math.max(_selectedIdx - 1, 0);
    updateSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (_selectedIdx === 0) {
      showCreateForm();
    } else {
      const sel = items[_selectedIdx - 1];
      if (sel) {
        openTab(sel.dataset.sid);
        closeQuickOpen();
      }
    }
  } else if (e.key === "Escape") {
    closeQuickOpen();
  }
});

quickOpenNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    doCreateSession();
  }
  if (e.key === "Escape") {
    _createMode = false;
    quickOpenCreate.classList.add("hidden");
    quickOpenInput.focus();
  }
});

function renderQoDirList() {
  renderDirDropdown({
    tabsEl: qoDropdownTabs,
    listEl: qoDirsList,
    dropdownEl: qoDirDropdown,
    tabAttr: "qoTab",
    activeTab: _qoActiveTab,
    onSelectDir: (dir) => {
      _createDir = dir;
      quickOpenDirLabel.textContent = shortDir(dir);
    },
    onTabChange: (tab) => { _qoActiveTab = tab; },
  });
}

qoDropdownTabs.querySelectorAll(".dropdown-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    _qoActiveTab = tab.dataset.qoTab;
    renderQoDirList();
  });
});

qoDirDropdown.addEventListener("click", (e) => {
  e.stopPropagation();
});

quickOpenDirBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isHidden = qoDirDropdown.classList.contains("hidden");
  if (isHidden) {
    _qoActiveTab = state.starredDirs.length > 0 ? "favorites" : "recent";
    renderQoDirList();
    qoDirDropdown.classList.remove("hidden");
  } else {
    app.animateClose(qoDirDropdown, "dropOut", 150);
  }
});

qoBrowseBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const result = await ipcRenderer.invoke("directory:pick");
  if (result) {
    _createDir = result.dir;
    quickOpenDirLabel.textContent = shortDir(result.dir);
    state.recentDirs = result.recents;
    state.starredDirs = result.starred || [];
  }
  app.animateClose(qoDirDropdown, "dropOut", 150);
});

quickOpenCreateBtn.addEventListener("click", doCreateSession);

document.querySelector(".quick-open-backdrop").addEventListener("click", closeQuickOpen);

document.querySelector(".quick-open-modal").addEventListener("click", () => {
  app.animateClose(qoDirDropdown, "dropOut", 150);
});

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

// ── Search bar (VS Code style — unified quick open) ───
const searchBar = document.querySelector("#search-bar");
const searchBarInput = document.querySelector("#search-bar-input");
const searchBarWorkspace = document.querySelector("#search-bar-workspace");
const searchBarResults = document.querySelector("#search-bar-results");
const sbList = document.querySelector("#sb-list");
const sbCreate = document.querySelector("#sb-create");
const sbCreateName = document.querySelector("#sb-create-name");
const sbDirBtn = document.querySelector("#sb-dir-btn");
const sbDirLabel = document.querySelector("#sb-dir-label");
const sbCreateBtn = document.querySelector("#sb-create-btn");
const sbDirDropdown = document.querySelector("#sb-dir-dropdown");
const sbDropdownTabs = document.querySelector("#sb-dropdown-tabs");
const sbDirsList = document.querySelector("#sb-dirs-list");
const sbBrowseBtn = document.querySelector("#sb-browse-btn");

let _sbSelectedIdx = 0;
let _sbCreateMode = false;
let _sbCreateDir = null;
let _sbActiveTab = "favorites";
let _sbKeyboardNav = false;

function updateSearchBarWorkspace() {
  const dir = state.currentDir;
  searchBarWorkspace.textContent = dir ? dir.split("/").pop() : "Lithium";
}

function openSearchBar() {
  searchBar.classList.add("focused");
  searchBarWorkspace.classList.add("hidden");
  searchBarInput.value = "";
  _sbSelectedIdx = 0;
  _sbCreateMode = false;
  _sbCreateDir = state.currentDir;
  sbCreate.classList.add("hidden");
  renderSbList("");
  searchBarResults.classList.remove("hidden");
  searchBarInput.focus();
}

function closeSearchBar() {
  if (_sbCreateMode) {
    sbDirDropdown.classList.add("hidden");
  }
  searchBar.classList.remove("focused");
  searchBarInput.value = "";
  searchBarResults.classList.add("hidden");
  sbCreate.classList.add("hidden");
  _sbSelectedIdx = 0;
  _sbCreateMode = false;
  searchBarWorkspace.classList.remove("hidden");
  searchBarInput.blur();
}

function isSearchBarOpen() {
  return searchBar.classList.contains("focused");
}

function sbShowCreateForm() {
  _sbCreateMode = true;
  sbCreate.classList.remove("hidden");
  sbDirLabel.textContent = _sbCreateDir ? shortDir(_sbCreateDir) : "Select directory...";
  sbCreateName.value = searchBarInput.value.trim();
  sbCreateName.focus();
  sbCreateName.select();
}

function sbDoCreate() {
  const name = sbCreateName.value.trim();
  if (!_sbCreateDir) {
    sbDirBtn.style.borderColor = "var(--primary)";
    setTimeout(() => sbDirBtn.style.borderColor = "", 1000);
    return;
  }
  createSessionAndOpen({ name, dir: _sbCreateDir, onDone: closeSearchBar });
}

function renderSbList(query) {
  const { totalItems } = renderSharedSessionList({
    query,
    selectedIdx: _sbSelectedIdx,
    listEl: sbList,
    itemClass: "sb-item",
    newClass: "sb-new",
    emptyClass: "sb-empty",
    showWorkspace: true,
    onNew: sbShowCreateForm,
    onSelect: (sid) => { openTab(sid); closeSearchBar(); },
    onHover: (idx) => { _sbSelectedIdx = idx; updateSbSelection(); },
  });
  if (_sbSelectedIdx >= totalItems) _sbSelectedIdx = totalItems - 1;
}

function updateSbSelection() {
  const newEl = sbList.querySelector("[data-action='new']");
  if (newEl) newEl.classList.toggle("selected", _sbSelectedIdx === 0);
  sbList.querySelectorAll(".sb-item").forEach((el, i) => {
    el.classList.toggle("selected", i + 1 === _sbSelectedIdx);
  });
  if (_sbKeyboardNav) {
    const sel = sbList.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
    _sbKeyboardNav = false;
  }
}

// Directory dropdown for create form
function renderSbDirList() {
  renderDirDropdown({
    tabsEl: sbDropdownTabs,
    listEl: sbDirsList,
    dropdownEl: sbDirDropdown,
    tabAttr: "sbTab",
    activeTab: _sbActiveTab,
    onSelectDir: (dir) => {
      _sbCreateDir = dir;
      sbDirLabel.textContent = shortDir(dir);
    },
    onTabChange: (tab) => { _sbActiveTab = tab; },
  });
}

// Event bindings — search bar open/close
searchBar.addEventListener("click", () => {
  if (!searchBar.classList.contains("focused")) openSearchBar();
});

searchBarInput.addEventListener("focus", () => {
  if (!searchBar.classList.contains("focused")) openSearchBar();
});

searchBarInput.addEventListener("input", () => {
  _sbSelectedIdx = 0;
  _sbCreateMode = false;
  sbCreate.classList.add("hidden");
  renderSbList(searchBarInput.value);
});

searchBarInput.addEventListener("keydown", (e) => {
  if (_sbCreateMode) return;
  const newEl = sbList.querySelector("[data-action='new']");
  const items = sbList.querySelectorAll(".sb-item");
  const total = (newEl ? 1 : 0) + items.length;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    _sbKeyboardNav = true;
    _sbSelectedIdx = Math.min(_sbSelectedIdx + 1, total - 1);
    updateSbSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _sbKeyboardNav = true;
    _sbSelectedIdx = Math.max(_sbSelectedIdx - 1, 0);
    updateSbSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (_sbSelectedIdx === 0) {
      sbShowCreateForm();
    } else {
      const sel = items[_sbSelectedIdx - 1];
      if (sel) {
        openTab(sel.dataset.sid);
        closeSearchBar();
      }
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearchBar();
  }
});

sbCreateName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sbDoCreate();
  }
  if (e.key === "Escape") {
    _sbCreateMode = false;
    sbCreate.classList.add("hidden");
    searchBarInput.focus();
  }
});

sbDirBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isHidden = sbDirDropdown.classList.contains("hidden");
  if (isHidden) {
    _sbActiveTab = state.starredDirs.length > 0 ? "favorites" : "recent";
    renderSbDirList();
    sbDirDropdown.classList.remove("hidden");
  } else {
    app.animateClose(sbDirDropdown, "dropOut", 150);
  }
});

sbDropdownTabs.querySelectorAll(".dropdown-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    _sbActiveTab = tab.dataset.sbTab;
    renderSbDirList();
  });
});

sbDirDropdown.addEventListener("click", (e) => { e.stopPropagation(); });

sbBrowseBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const result = await ipcRenderer.invoke("directory:pick");
  if (result) {
    _sbCreateDir = result.dir;
    sbDirLabel.textContent = shortDir(result.dir);
    state.recentDirs = result.recents;
    state.starredDirs = result.starred || [];
  }
  app.animateClose(sbDirDropdown, "dropOut", 150);
});

sbCreateBtn.addEventListener("click", sbDoCreate);

// Close search bar when clicking outside
document.addEventListener("mousedown", (e) => {
  if (searchBar.classList.contains("focused") && !searchBar.contains(e.target)) {
    closeSearchBar();
  }
});

// Also close on blur (catches titlebar drag area clicks that swallow mousedown)
searchBarInput.addEventListener("blur", () => {
  // Delay to allow clicks on results to register first
  setTimeout(() => {
    if (searchBar.classList.contains("focused") && !searchBar.contains(document.activeElement)) {
      closeSearchBar();
    }
  }, 150);
});

// Update workspace display when directory changes
app.updateSearchBarWorkspace = updateSearchBarWorkspace;

// Initial workspace display
updateSearchBarWorkspace();

// ── New Project modal ─────────────────────────────
const npModal = document.querySelector("#new-project-modal");
const npForm = document.querySelector("#np-form");
const npProgress = document.querySelector("#np-progress");
const npNameInput = document.querySelector("#np-name");
const npDirPath = document.querySelector("#np-dir-path");
const npError = document.querySelector("#np-error");
const npFwCards = document.querySelectorAll(".np-fw-card");
let _npFramework = null;
let _npProjectsDir = null;

async function openNewProject() {
  // Resolve projects dir (auto-detects ~/lithium-projects)
  _npProjectsDir = await ipcRenderer.invoke("config:resolve-projects-dir");
  npDirPath.textContent = _npProjectsDir ? shortDir(_npProjectsDir) : "Not set";
  npDirPath.classList.toggle("muted", !_npProjectsDir);

  // Reset state
  _npFramework = null;
  npNameInput.value = "";
  npError.classList.add("hidden");
  npFwCards.forEach((c) => c.classList.remove("selected"));
  npForm.classList.remove("hidden");
  npProgress.classList.add("hidden");

  npModal.classList.remove("hidden");
  npNameInput.focus();
}

function closeNewProject() {
  if (npModal.classList.contains("hidden")) return;
  const dialog = npModal.querySelector(".np-dialog");
  const backdrop = npModal.querySelector(".np-backdrop");
  dialog.style.animation = "dropOut 150ms var(--ease-smooth) forwards";
  backdrop.style.animation = "fadeOut 150ms var(--ease-smooth) forwards";
  setTimeout(() => {
    npModal.classList.add("hidden");
    dialog.style.animation = "";
    backdrop.style.animation = "";
  }, 150);
}

// Framework card clicks
npFwCards.forEach((card) => {
  card.addEventListener("click", () => {
    npFwCards.forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    _npFramework = card.dataset.framework;
  });
});

// Change directory
document.querySelector("#np-dir-change").addEventListener("click", async () => {
  const result = await ipcRenderer.invoke("directory:pick");
  if (result) {
    _npProjectsDir = result.dir;
    npDirPath.textContent = shortDir(result.dir);
    npDirPath.classList.remove("muted");
    // Also persist as projectsDir config
    ipcRenderer.send("config:set", { key: "projectsDir", value: result.dir });
    state.recentDirs = result.recents;
    state.starredDirs = result.starred || [];
  }
});

// Cancel
document.querySelector("#np-cancel").addEventListener("click", closeNewProject);
document.querySelector("#np-close").addEventListener("click", closeNewProject);
document.querySelector(".np-backdrop").addEventListener("click", closeNewProject);

// Create
document.querySelector("#np-create").addEventListener("click", async () => {
  npError.classList.add("hidden");

  const name = npNameInput.value.trim();
  if (!_npFramework) {
    npError.textContent = "Please select a framework.";
    npError.classList.remove("hidden");
    return;
  }
  if (!name) {
    npError.textContent = "Please enter a project name.";
    npError.classList.remove("hidden");
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    npError.textContent = "Name can only contain letters, numbers, dashes and underscores.";
    npError.classList.remove("hidden");
    return;
  }
  if (!_npProjectsDir) {
    // Auto-create ~/lithium-projects when user tries to create without a dir set
    _npProjectsDir = await ipcRenderer.invoke("config:create-default-projects-dir");
    npDirPath.textContent = shortDir(_npProjectsDir);
    npDirPath.classList.remove("muted");
  }

  // Show progress
  npForm.classList.add("hidden");
  npProgress.classList.remove("hidden");

  const result = await ipcRenderer.invoke("project:create", {
    framework: _npFramework,
    name,
    projectsDir: _npProjectsDir,
  });

  if (result.ok) {
    // Switch workspace to the new project dir and open a new session
    setDirectory(result.dir);
    newSession();
    closeNewProject();
    // Show the dev server button
    btnDevServer.classList.remove("hidden");
  } else {
    // Show error, return to form
    npProgress.classList.add("hidden");
    npForm.classList.remove("hidden");
    npError.textContent = result.error;
    npError.classList.remove("hidden");
  }
});

// Wire titlebar button
document.querySelector("#btn-new-project").addEventListener("click", openNewProject);

// ── Dev server play/stop ──────────────────────────
const btnDevServer = document.querySelector("#btn-dev-server");
const devPlayIcon = document.querySelector("#dev-server-play");
const devStopIcon = document.querySelector("#dev-server-stop");
let _devServerRunning = false;

function setDevServerUI(running) {
  _devServerRunning = running;
  btnDevServer.classList.toggle("running", running);
  btnDevServer.title = running ? "Stop Dev Server" : "Start Dev Server";
  devPlayIcon.classList.toggle("hidden", running);
  devStopIcon.classList.toggle("hidden", !running);
  localStorage.setItem("devServerRunning", running ? "1" : "");
  if (running) {
    localStorage.setItem("devServerDir", state.currentDir || "");
  } else {
    localStorage.removeItem("devServerDir");
  }
}

async function stopDevServer() {
  if (!_devServerRunning) return;
  await ipcRenderer.invoke("devserver:stop");
  setDevServerUI(false);
  if (app.closeBrowser) app.closeBrowser();
}

btnDevServer.addEventListener("click", async () => {
  if (_devServerRunning) {
    await stopDevServer();
  } else {
    if (!state.currentDir) return;
    const result = await ipcRenderer.invoke("devserver:start", { cwd: state.currentDir });
    if (result.ok) setDevServerUI(true);
  }
});

// Listen for dev server URL → open in browser sidebar
ipcRenderer.on("devserver:url", (_e, url) => {
  if (app.openBrowserUrl) app.openBrowserUrl(url);
});

// Listen for dev server stopped (e.g. process crashed)
ipcRenderer.on("devserver:stopped", () => {
  setDevServerUI(false);
  if (app.closeBrowser) app.closeBrowser();
});

// Check if current workspace has a dev script → show/hide button
// Also stops running dev server when switching workspaces
async function checkDevServerAvailable() {
  // Stop any running dev server on workspace switch
  if (_devServerRunning) await stopDevServer();

  if (!state.currentDir) {
    btnDevServer.classList.add("hidden");
    return;
  }
  const has = await ipcRenderer.invoke("devserver:has-dev-script", { cwd: state.currentDir });
  btnDevServer.classList.toggle("hidden", !has);
}

// Expose for use after setDirectory calls
app.checkDevServerAvailable = checkDevServerAvailable;

// ── Global keydown ────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !npModal.classList.contains("hidden")) {
    closeNewProject();
    return;
  }
  if (e.key === "Escape" && isSearchBarOpen()) {
    closeSearchBar();
    return;
  }
  if (e.key === "Escape" && !quickOpen.classList.contains("hidden")) {
    closeQuickOpen();
    return;
  }
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
    return;
  }
  // Cmd+P — focus search bar
  if (e.code === "KeyP" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    openSearchBar();
    return;
  }
  // Cmd+Shift+D — split vertical (top/bottom) — check shift first
  if (e.code === "KeyD" && e.metaKey && e.shiftKey) {
    e.preventDefault();
    splitNewSession("vertical");
    return;
  }
  // Cmd+D — split horizontal (left/right)
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

  // Restore last selected workspace
  const savedDir = localStorage.getItem("currentDir");
  if (savedDir) setDirectory(savedDir);

  state.sessions = await ipcRenderer.invoke("sessions:list");

  // Restore previously open tabs/layout (try localStorage first, then disk backup)
  let saved = getSavedLayout();
  if (!saved || !saved.layout) {
    saved = await ipcRenderer.invoke("layout:load");
  }
  if (saved && saved.layout) {
    const { getAllLeaves, cleanupEmptyLeaves, findLeafById } = require("./renderer/state");
    const sessionIds = new Set(state.sessions.map((s) => s.id));

    // Strip deleted sessions from saved layout leaves
    for (const leaf of getAllLeaves(saved.layout)) {
      leaf.tabs = leaf.tabs.filter((id) => sessionIds.has(id));
      if (leaf.activeTab && !sessionIds.has(leaf.activeTab)) {
        leaf.activeTab = leaf.tabs[leaf.tabs.length - 1] || null;
      }
    }
    const cleaned = cleanupEmptyLeaves(saved.layout);

    if (cleaned) {
      // Create terminals and spawn PTYs (resume) for each tab
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

  // Restore dev server if it was running before quit
  const savedDevDir = localStorage.getItem("devServerDir");
  const savedDevRunning = localStorage.getItem("devServerRunning") === "1";
  if (savedDevRunning && savedDevDir && state.currentDir === savedDevDir) {
    btnDevServer.classList.remove("hidden");
    const result = await ipcRenderer.invoke("devserver:start", { cwd: savedDevDir });
    if (result.ok) setDevServerUI(true);
  }

}

init();
