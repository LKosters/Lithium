const app = require("./app");
const { state } = require("./state");
const { shortDir, escapeHtml, dirName } = require("./helpers");
const { createSessionAndOpen, renderSessionList: renderSharedSessionList } = require("./session-create");
const { getProjectIcon, frameworkCache, detectFrameworks } = require("./directory");

// ── DOM elements ─────────────────────────────────────
const searchBar = document.querySelector("#search-bar");
const searchBarInput = document.querySelector("#search-bar-input");
const searchBarWorkspace = document.querySelector("#search-bar-workspace");
const searchBarResults = document.querySelector("#search-bar-results");
const sbList = document.querySelector("#sb-list");
const sbCreate = document.querySelector("#sb-create");
const sbCreateName = document.querySelector("#sb-create-name");
const sbCreateBtn = document.querySelector("#sb-create-btn");
const sbProjectList = document.querySelector("#sb-project-list");
const sbBrowseBtn = document.querySelector("#sb-browse-btn");

const sbProviderSelector = document.querySelector("#sb-provider-selector");
const sbModelRow = document.querySelector("#sb-model-row");
const sbModelSelect = document.querySelector("#sb-model-select");

let _sbSelectedIdx = 0;
let _sbCreateMode = false;
let _sbCreateDir = null;
let _sbKeyboardNav = false;
let _sbSelectedProvider = "terminal";
let _sbProviderData = [];

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

async function sbShowCreateForm() {
  _sbCreateMode = true;
  sbCreate.classList.remove("hidden");
  sbCreateName.value = searchBarInput.value.trim();
  sbCreateName.focus();
  sbCreateName.select();

  // Render the project list
  await renderSbProjectList();

  // Load default agent from settings
  try {
    _sbSelectedProvider = await app.ipcRenderer.invoke("agent:get-default") || "terminal";
  } catch {
    _sbSelectedProvider = "terminal";
  }
  await sbLoadProviders();

  // If a non-terminal default has a saved model, pre-select it
  if (_sbSelectedProvider !== "terminal") {
    try {
      const savedModel = await app.ipcRenderer.invoke("agent:get-default-model", _sbSelectedProvider);
      if (savedModel && sbModelSelect) sbModelSelect.value = savedModel;
    } catch {}
  }
}

function sbDoCreate() {
  const name = sbCreateName.value.trim();
  if (!_sbCreateDir) {
    // Flash the project list to indicate selection needed
    sbProjectList.style.borderColor = "var(--primary)";
    setTimeout(() => sbProjectList.style.borderColor = "", 1000);
    return;
  }
  const model = (_sbSelectedProvider !== "terminal" && sbModelSelect.value) ? sbModelSelect.value : null;
  createSessionAndOpen({
    name,
    dir: _sbCreateDir,
    provider: _sbSelectedProvider,
    model,
    onDone: closeSearchBar,
  });
}

function sbUpdateProviderUI() {
  sbProviderSelector.querySelectorAll(".provider-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.provider === _sbSelectedProvider);
  });

  const provData = _sbProviderData.find((p) => p.name === _sbSelectedProvider);
  if (provData && provData.models && provData.models.length > 0) {
    sbModelRow.classList.remove("hidden");
    sbModelSelect.innerHTML = provData.models
      .map((m) => `<option value="${m}"${m === provData.defaultModel ? " selected" : ""}>${m}</option>`)
      .join("");
  } else {
    sbModelRow.classList.add("hidden");
  }

  // Mark configured providers
  for (const p of _sbProviderData) {
    const btn = sbProviderSelector.querySelector(`[data-provider="${p.name}"]`);
    if (btn) btn.classList.toggle("configured", p.configured);
  }
}

async function sbLoadProviders() {
  try {
    _sbProviderData = await app.ipcRenderer.invoke("agent:providers");
    sbUpdateProviderUI();
  } catch (err) {
    console.warn("Failed to load providers:", err.message);
  }
}

async function renderSbProjectList() {
  if (!sbProjectList) return;

  // Build project list same as sidebar: starred first, then recent, then session dirs
  const seen = new Set();
  const allDirs = [];
  const sessionDirs = new Set(
    state.sessions.map((s) => s.directory).filter(Boolean),
  );

  for (const d of state.starredDirs) {
    if (!seen.has(d)) { seen.add(d); allDirs.push(d); }
  }
  for (const d of state.recentDirs) {
    if (!seen.has(d)) { seen.add(d); allDirs.push(d); }
  }
  for (const d of sessionDirs) {
    if (!seen.has(d)) { seen.add(d); allDirs.push(d); }
  }

  // Move current project to the top
  if (state.currentDir && allDirs.includes(state.currentDir)) {
    const idx = allDirs.indexOf(state.currentDir);
    allDirs.splice(idx, 1);
    allDirs.unshift(state.currentDir);
  }

  // Detect frameworks for uncached dirs
  await detectFrameworks(allDirs);

  let html = "";
  for (const dir of allDirs) {
    const isSelected = dir === _sbCreateDir;
    const selectedClass = isSelected ? "selected" : "";
    const icon = getProjectIcon(frameworkCache.get(dir));
    const sessionCount = state.sessions.filter((s) => s.directory === dir).length;
    html += `<div class="sb-project-item ${selectedClass}" data-dir="${escapeHtml(dir)}" title="${escapeHtml(shortDir(dir))}">
      <span class="sb-project-item-icon">${icon}</span>
      <span class="sb-project-item-name">${escapeHtml(dirName(dir))}</span>
      ${sessionCount > 0 ? `<span class="sb-project-item-count">${sessionCount}</span>` : ""}
    </div>`;
  }

  if (allDirs.length === 0) {
    html = `<div class="sb-project-empty">No projects yet</div>`;
  }

  sbProjectList.innerHTML = html;

  // Click to select project
  sbProjectList.querySelectorAll(".sb-project-item[data-dir]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      _sbCreateDir = el.dataset.dir;
      // Update selection
      sbProjectList.querySelectorAll(".sb-project-item").forEach((item) => {
        item.classList.toggle("selected", item.dataset.dir === _sbCreateDir);
      });
    });
  });
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

sbBrowseBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const result = await app.ipcRenderer.invoke("directory:pick");
  if (result) {
    _sbCreateDir = result.dir;
    state.recentDirs = result.recents;
    state.starredDirs = result.starred || [];
    await renderSbProjectList();
  }
});

sbCreateBtn.addEventListener("click", sbDoCreate);

sbProviderSelector.querySelectorAll(".provider-option").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    _sbSelectedProvider = btn.dataset.provider;
    sbUpdateProviderUI();
  });
});

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
