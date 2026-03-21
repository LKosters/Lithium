const app = require("./app");
const { state } = require("./state");
const { shortDir } = require("./helpers");
const { createSessionAndOpen, renderDirDropdown, renderSessionList: renderSharedSessionList } = require("./session-create");

// ── DOM elements ─────────────────────────────────────
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

// ── Functions ────────────────────────────────────────
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
    onSelect: (sid) => {
      const s = state.sessions.find((se) => se.id === sid);
      if (s && s.directory && s.directory !== state.currentDir && app.setDirectory) {
        app.setDirectory(s.directory);
      }
      app.openTab(sid);
      closeSearchBar();
    },
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

// ── Event listeners ──────────────────────────────────
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
        const s = state.sessions.find((se) => se.id === sel.dataset.sid);
        if (s && s.directory && s.directory !== state.currentDir && app.setDirectory) {
          app.setDirectory(s.directory);
        }
        app.openTab(sel.dataset.sid);
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
  const result = await app.ipcRenderer.invoke("directory:pick");
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
  setTimeout(() => {
    if (searchBar.classList.contains("focused") && !searchBar.contains(document.activeElement)) {
      closeSearchBar();
    }
  }, 150);
});

// Initial workspace display
updateSearchBarWorkspace();

module.exports = { openSearchBar, closeSearchBar, isSearchBarOpen, updateSearchBarWorkspace };
