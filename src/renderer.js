const { ipcRenderer } = require("electron");

// ── Shared context ────────────────────────────────────
const app = require("./renderer/app");
app.ipcRenderer = ipcRenderer;

// ── Load modules ──────────────────────────────────────
const { state, terminals, collapsedDirs } = require("./renderer/state");
const { groupSessionsByDir } = require("./renderer/helpers");
const { createTerminal, fitAllVisibleTerminals } = require("./renderer/terminal");
const { renderLayout, refreshLayout, startDragOverlay, stopDragOverlay } = require("./renderer/layout");
const { openTab, closeTab, newSession, splitNewSession } = require("./renderer/tabs");
const { renderSessionList, deleteSession } = require("./renderer/sessions");
const { initBrowser } = require("./renderer/browser");
const { initMusicPlayer, updateTrackProgress, setPlayerMode } = require("./renderer/music");
const { enterFocusMode, exitFocusMode } = require("./renderer/focus");
const { closeSettings, isSettingsOpen } = require("./renderer/settings");
const { closeGit, isGitOpen, refreshGit } = require("./renderer/git");
const { pickDirectory, setDirectory, renderRecentDirs } = require("./renderer/directory");

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
app.setPlayerMode = setPlayerMode;

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

  const id = uuidv4();
  const session = {
    id,
    directory: _createDir,
    title: name || shortDir(_createDir),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  state.sessions.unshift(session);
  persistSession(session);
  createTerminal(id);
  ipcRenderer.send("pty:spawn", { sessionId: id, cwd: _createDir });
  openTab(id);
  renderSessionList();
  closeQuickOpen();
}

function renderQuickOpenList(query) {
  const q = query.toLowerCase().trim();
  const matches = state.sessions.filter((s) => {
    const title = (s.title || "").toLowerCase();
    const dir = (s.directory || "").toLowerCase();
    return !q || title.includes(q) || dir.includes(q);
  });

  // Build: "New Session" row + matching sessions
  let html = `<div class="quick-open-new ${_selectedIdx === 0 ? "selected" : ""}" data-action="new">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span>New Session${q ? ": " + escapeHtml(q) : ""}</span>
  </div>`;

  html += matches
    .map((s, i) => {
      const t = termsMap.get(s.id);
      const alive = t?.alive ? "alive" : "";
      const idx = i + 1; // offset by 1 for "New Session"
      const sel = idx === _selectedIdx ? "selected" : "";
      return `<div class="quick-open-item ${sel}" data-sid="${s.id}">
        <span class="quick-open-item-status ${alive}"></span>
        <span class="quick-open-item-title">${escapeHtml(s.title || "Session")}</span>
        <span class="quick-open-item-dir">${escapeHtml(shortDir(s.directory || ""))}</span>
      </div>`;
    })
    .join("");

  if (matches.length === 0 && q) {
    html += '<div class="quick-open-empty">No sessions found</div>';
  }

  quickOpenList.innerHTML = html;

  const totalItems = 1 + matches.length;
  if (_selectedIdx >= totalItems) _selectedIdx = totalItems - 1;

  // New session click
  const newEl = quickOpenList.querySelector("[data-action='new']");
  if (newEl) {
    newEl.addEventListener("click", showCreateForm);
    newEl.addEventListener("mouseenter", () => {
      _selectedIdx = 0;
      updateSelection();
    });
  }

  // Session clicks
  quickOpenList.querySelectorAll(".quick-open-item").forEach((el, i) => {
    el.addEventListener("click", () => {
      openTab(el.dataset.sid);
      closeQuickOpen();
    });
    el.addEventListener("mouseenter", () => {
      _selectedIdx = i + 1;
      updateSelection();
    });
  });
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
  const hasFavorites = state.starredDirs.length > 0;
  if (hasFavorites) {
    qoDropdownTabs.classList.remove("hidden");
  } else {
    qoDropdownTabs.classList.add("hidden");
    _qoActiveTab = "recent";
  }

  qoDropdownTabs.querySelectorAll(".dropdown-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.qoTab === _qoActiveTab);
  });

  const dirs = _qoActiveTab === "favorites"
    ? state.recentDirs.filter((d) => state.starredDirs.includes(d))
    : state.recentDirs.filter((d) => !state.starredDirs.includes(d));

  let html = "";
  for (const dir of dirs) {
    const isStarred = state.starredDirs.includes(dir);
    const starClass = isStarred ? "star-btn starred" : "star-btn";
    html += `<div class="dropdown-item" data-dir="${escapeHtml(dir)}">
      <button class="${starClass}" data-star-dir="${escapeHtml(dir)}" title="${isStarred ? "Unstar" : "Star"}">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="${isStarred ? "currentColor" : "none"}">
          <path d="M8 1.5l2 4.5 5 .5-3.8 3.3L12.4 15 8 12.5 3.6 15l1.2-5.2L1 6.5l5-.5L8 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
      </button>
      <span class="dropdown-item-text">${escapeHtml(shortDir(dir))}</span>
    </div>`;
  }
  if (dirs.length === 0) {
    const msg = _qoActiveTab === "favorites" ? "No favorites yet" : "No recent directories";
    html = `<div class="dropdown-empty">${msg}</div>`;
  }
  qoDirsList.innerHTML = html;

  qoDirsList.querySelectorAll(".dropdown-item[data-dir]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".star-btn")) return;
      _createDir = el.dataset.dir;
      quickOpenDirLabel.textContent = shortDir(el.dataset.dir);
      app.animateClose(qoDirDropdown, "dropOut", 150);
    });
  });
  qoDirsList.querySelectorAll(".star-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dir = btn.dataset.starDir;
      if (state.starredDirs.includes(dir)) {
        state.starredDirs = state.starredDirs.filter((d) => d !== dir);
      } else {
        state.starredDirs.push(dir);
      }
      ipcRenderer.send("directory:toggle-star", dir);
      renderQoDirList();
    });
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
      openQuickOpen();
    } else {
      _lastShiftUp = now;
    }
  }
});

// ── Global keydown ────────────────────────────────────
document.addEventListener("keydown", (e) => {
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
