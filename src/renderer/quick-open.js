const app = require("./app");
const { state } = require("./state");
const { shortDir } = require("./helpers");
const { createSessionAndOpen, renderDirDropdown, renderSessionList: renderSharedSessionList } = require("./session-create");

// ── DOM elements ─────────────────────────────────────
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

let _selectedIdx = -1;
let _createMode = false;
let _createDir = null;
let _qoActiveTab = "favorites";

// ── Functions ────────────────────────────────────────
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

function isQuickOpenVisible() {
  return !quickOpen.classList.contains("hidden");
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
    onSelect: (sid) => { app.openTab(sid); closeQuickOpen(); },
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

// ── Event listeners ──────────────────────────────────
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
        app.openTab(sel.dataset.sid);
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

qoDropdownTabs.querySelectorAll(".dropdown-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    _qoActiveTab = tab.dataset.qoTab;
    renderQoDirList();
  });
});

qoDirDropdown.addEventListener("click", (e) => { e.stopPropagation(); });

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
  const result = await app.ipcRenderer.invoke("directory:pick");
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

module.exports = { openQuickOpen, closeQuickOpen, isQuickOpenVisible };
