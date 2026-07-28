const path = require("path");
const fs = require("fs");
const app = require("./app");
const { state } = require("./state");
const { shortDir, escapeHtml, dirName } = require("./helpers");

// ── Framework icons from devicon/simple-icons ───────────
const ICONS_DIR = path.join(__dirname, "..", "assets", "framework-icons");
const FOLDER_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 1.5H12.5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-9C2.67 13.5 2 12.83 2 12V4.5z" stroke="currentColor" stroke-width="1.2"/></svg>`;

const ICON_FILES = [
  "nextjs", "nuxtjs", "react", "vue", "vuejs", "angular", "svelte", "sveltekit",
  "php", "symfony", "laravel", "typescript", "javascript", "nodejs", "python",
  "rust", "go", "ruby", "astro", "gatsby", "remix", "tanstack",
];

// Load and cache all icon SVGs at startup
const iconCache = {};
for (const name of ICON_FILES) {
  try {
    const svgPath = path.join(ICONS_DIR, `${name}.svg`);
    let svg = fs.readFileSync(svgPath, "utf8");
    svg = svg.replace(/<svg([^>]*)>/, (match, attrs) => {
      attrs = attrs.replace(/\s(width|height)="[^"]*"/g, "");
      return `<svg width="14" height="14"${attrs}>`;
    });
    iconCache[name] = svg;
  } catch {
    // Icon file not found, skip
  }
}
if (iconCache.vuejs && !iconCache.vue) iconCache.vue = iconCache.vuejs;
if (iconCache.vue && !iconCache.vuejs) iconCache.vuejs = iconCache.vue;

function getProjectIcon(framework) {
  return iconCache[framework] || FOLDER_ICON;
}

const frameworkCache = new Map();

const currentDirLabel = document.querySelector("#current-dir-label");
const recentDirsDropdown = document.querySelector("#recent-dirs-dropdown");
const recentDirsList = document.querySelector("#recent-dirs-list");
const dropdownTabs = document.querySelector("#dropdown-tabs");
const btnPickDir = document.querySelector("#btn-pick-dir");
const btnOpenFinder = document.querySelector("#btn-open-finder");
const projectsListEl = document.querySelector("#projects-list");
const projectsSearchEl = document.querySelector("#projects-search");

const confirmModal = document.querySelector("#confirm-remove-modal");
const confirmText = document.querySelector("#confirm-remove-text");
const confirmCancel = document.querySelector("#confirm-remove-cancel");
const confirmOk = document.querySelector("#confirm-remove-ok");
const confirmBackdrop = confirmModal ? confirmModal.querySelector(".np-backdrop") : null;

const scModal = document.querySelector("#start-commands-modal");
const scProjectName = document.querySelector("#sc-project-name");
const scCommands = document.querySelector("#sc-commands");
const scCancel = document.querySelector("#sc-cancel");
const scSave = document.querySelector("#sc-save");
const scBackdrop = scModal ? scModal.querySelector(".np-backdrop") : null;
let _scDir = null;

let pendingRemoveDir = null;
let activeDropdownTab = "favorites";

async function pickDirectory() {
  const result = await app.ipcRenderer.invoke("directory:pick");
  if (!result) return;
  setDirectory(result.dir);
  state.recentDirs = result.recents;
  state.starredDirs = result.starred || [];
  renderRecentDirs();
  renderProjectsList();
}

function setDirectory(dir) {
  state.currentDir = dir;
  currentDirLabel.textContent = shortDir(dir);
  localStorage.setItem("currentDir", dir);
  app.ipcRenderer.send("config:set", { key: "currentDir", value: dir });
  app.ipcRenderer.send("directory:add-recent", dir);
  if (app.refreshGit) app.refreshGit();
  if (app.checkDevServerAvailable) app.checkDevServerAvailable();
  if (app.updateSearchBarWorkspace) app.updateSearchBarWorkspace();
  // Re-render projects to highlight active + re-render sessions for this workspace
  renderProjectsList();
  if (app.renderSessionList) app.renderSessionList();
}

async function detectFrameworks(dirs) {
  const uncached = dirs.filter((d) => !frameworkCache.has(d));
  if (uncached.length > 0) {
    await Promise.all(
      uncached.map(async (d) => {
        const fw = await app.ipcRenderer.invoke("project:detect-framework", d);
        frameworkCache.set(d, fw);
      }),
    );
  }
}

async function renderProjectsList() {
  if (!projectsListEl) return;

  // Show starred dirs first, then recent dirs (deduped)
  const seen = new Set();
  const allDirs = [];

  // Also collect dirs from sessions
  const sessionDirs = new Set(
    state.sessions.map((s) => s.directory).filter(Boolean),
  );

  // Starred first
  for (const d of state.starredDirs) {
    if (!seen.has(d)) {
      seen.add(d);
      allDirs.push(d);
    }
  }
  // Recent dirs
  for (const d of state.recentDirs) {
    if (!seen.has(d)) {
      seen.add(d);
      allDirs.push(d);
    }
  }
  // Session dirs that aren't in recent/starred
  for (const d of sessionDirs) {
    if (!seen.has(d)) {
      seen.add(d);
      allDirs.push(d);
    }
  }

  // Filter by search term
  const searchTerm = projectsSearchEl ? projectsSearchEl.value.trim().toLowerCase() : "";
  const filteredDirs = searchTerm
    ? allDirs.filter((d) => dirName(d).toLowerCase().includes(searchTerm) || d.toLowerCase().includes(searchTerm))
    : allDirs;

  // Detect frameworks for uncached dirs
  await detectFrameworks(filteredDirs);

  let html = "";
  for (const dir of filteredDirs) {
    const isActive = dir === state.currentDir;
    const activeClass = isActive ? "active" : "";
    const sessionCount = state.sessions.filter(
      (s) => s.directory === dir,
    ).length;
    const icon = getProjectIcon(frameworkCache.get(dir));
    html += `<div class="project-item ${activeClass}" data-project-dir="${escapeHtml(dir)}" title="${escapeHtml(shortDir(dir))}">
      <span class="project-item-icon">
        ${icon}
      </span>
      <span class="project-item-name">${escapeHtml(dirName(dir))}</span>
      ${sessionCount > 0 ? `<span class="project-item-count">${sessionCount}</span>` : ""}
      <span class="project-item-actions">
        <button class="project-item-btn" data-commands-dir="${escapeHtml(dir)}" title="Start commands">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" stroke="currentColor" stroke-width="1.8"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.8"/>
          </svg>
        </button>
        <button class="project-item-btn" data-remove-dir="${escapeHtml(dir)}" title="Remove workspace">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </span>
    </div>`;
  }

  if (filteredDirs.length === 0) {
    html = `<div class="session-empty" style="padding:20px 8px;font-size:11px">No workspaces yet</div>`;
  }

  projectsListEl.innerHTML = html;

  // Click to switch workspace
  projectsListEl
    .querySelectorAll(".project-item[data-project-dir]")
    .forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".project-item-actions")) return;
        setDirectory(el.dataset.projectDir);
      });
    });

  // Click gear icon → edit this project's start commands
  projectsListEl
    .querySelectorAll("[data-commands-dir]")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openStartCommands(btn.dataset.commandsDir);
      });
    });

  // Click trash icon → show confirmation modal
  projectsListEl
    .querySelectorAll("[data-remove-dir]")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        showRemoveConfirm(btn.dataset.removeDir);
      });
    });
}

function renderRecentDirs() {
  const hasFavorites = state.starredDirs.length > 0;

  if (hasFavorites) {
    dropdownTabs.classList.remove("hidden");
  } else {
    dropdownTabs.classList.add("hidden");
    activeDropdownTab = "recent";
  }

  dropdownTabs.querySelectorAll(".dropdown-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.dropdownTab === activeDropdownTab);
  });

  const dirs =
    activeDropdownTab === "favorites"
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
    const msg =
      activeDropdownTab === "favorites"
        ? "No favorites yet"
        : "No recent directories";
    html = `<div class="dropdown-empty">${msg}</div>`;
  }
  recentDirsList.innerHTML = html;

  recentDirsList.querySelectorAll(".dropdown-item[data-dir]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".star-btn")) return;
      setDirectory(el.dataset.dir);
      app.animateClose(recentDirsDropdown, "dropOut", 150);
    });
  });
  recentDirsList.querySelectorAll(".star-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dir = btn.dataset.starDir;
      if (state.starredDirs.includes(dir)) {
        state.starredDirs = state.starredDirs.filter((d) => d !== dir);
      } else {
        state.starredDirs.push(dir);
      }
      app.ipcRenderer.send("directory:toggle-star", dir);
      renderRecentDirs();
      renderProjectsList();
    });
  });
}

// Dropdown tab switching
dropdownTabs.querySelectorAll(".dropdown-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    activeDropdownTab = tab.dataset.dropdownTab;
    renderRecentDirs();
  });
});

// Directory button events
btnPickDir.addEventListener("click", (e) => {
  e.stopPropagation();
  const isHidden = recentDirsDropdown.classList.contains("hidden");
  if (isHidden) {
    activeDropdownTab = state.starredDirs.length > 0 ? "favorites" : "recent";
    renderRecentDirs();
    recentDirsDropdown.classList.remove("hidden");
  } else {
    app.animateClose(recentDirsDropdown, "dropOut", 150);
  }
});

btnOpenFinder.addEventListener("click", (e) => {
  e.stopPropagation();
  pickDirectory();
});

// Filter projects on search input
if (projectsSearchEl) {
  projectsSearchEl.addEventListener("input", () => renderProjectsList());
}

// Close dropdown on outside click
document.addEventListener("click", () => {
  app.animateClose(recentDirsDropdown, "dropOut", 150);
});

// ── Confirm-remove modal ────────────────────────────

function showRemoveConfirm(dir) {
  pendingRemoveDir = dir;
  if (confirmText) confirmText.textContent = `Remove "${dirName(dir)}" from your workspaces?`;
  if (confirmModal) confirmModal.classList.remove("hidden");
}

function hideRemoveConfirm() {
  if (confirmModal) confirmModal.classList.add("hidden");
  pendingRemoveDir = null;
}

function removeWorkspace(dir) {
  state.recentDirs = state.recentDirs.filter((d) => d !== dir);
  state.starredDirs = state.starredDirs.filter((d) => d !== dir);
  frameworkCache.delete(dir);
  app.ipcRenderer.send("directory:remove", dir);
  if (state.currentDir === dir) {
    state.currentDir = null;
    currentDirLabel.textContent = "";
    localStorage.removeItem("currentDir");
    app.ipcRenderer.send("config:set", { key: "currentDir", value: null });
  }
  renderProjectsList();
  renderRecentDirs();
  if (app.renderSessionList) app.renderSessionList();
}

if (confirmCancel) confirmCancel.addEventListener("click", hideRemoveConfirm);
if (confirmBackdrop) confirmBackdrop.addEventListener("click", hideRemoveConfirm);
if (confirmOk) {
  confirmOk.addEventListener("click", () => {
    if (pendingRemoveDir) removeWorkspace(pendingRemoveDir);
    hideRemoveConfirm();
  });
}

// ── Start-commands editor (per-project) ─────────────
// Each project's start commands (what the play button runs) are edited from the
// gear on its row, not app settings, since they belong to the project. Stored in
// <project>/.lithium/settings.json via project:get/set-settings.

async function openStartCommands(dir) {
  if (!dir || !scModal) return;
  _scDir = dir;
  scProjectName.textContent = dirName(dir);
  scCommands.value = "";
  try {
    const settings = await app.ipcRenderer.invoke("project:get-settings", dir);
    scCommands.value = (settings.startCommands || []).join("\n");
  } catch (err) {
    console.error("Failed to load start commands:", err.message);
  }
  scModal.classList.remove("hidden");
  scCommands.focus();
}

function closeStartCommands() {
  if (!scModal) return;
  app.animateClose(scModal, "fadeDown", 160);
  _scDir = null;
}

async function saveStartCommands() {
  if (!_scDir) return;
  const startCommands = scCommands.value
    .split("\n")
    .map((c) => c.trim())
    .filter(Boolean);
  try {
    await app.ipcRenderer.invoke("project:set-settings", { dir: _scDir, settings: { startCommands } });
  } catch (err) {
    console.error("Failed to save start commands:", err.message);
  }
  // The play button follows the configured commands for the current workspace.
  if (_scDir === state.currentDir && app.refreshDevServerButton) app.refreshDevServerButton();
  closeStartCommands();
}

function isStartCommandsOpen() {
  return scModal && !scModal.classList.contains("hidden");
}

if (scModal) {
  scCancel.addEventListener("click", closeStartCommands);
  scSave.addEventListener("click", saveStartCommands);
  if (scBackdrop) scBackdrop.addEventListener("click", closeStartCommands);
  scCommands.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeStartCommands(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveStartCommands(); }
  });
}

module.exports = {
  pickDirectory,
  setDirectory,
  renderRecentDirs,
  renderProjectsList,
  getProjectIcon,
  frameworkCache,
  detectFrameworks,
  closeStartCommands,
  isStartCommandsOpen,
};
