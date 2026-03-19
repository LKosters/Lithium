const app = require("./app");
const { state } = require("./state");
const { shortDir, escapeHtml } = require("./helpers");

const currentDirLabel = document.querySelector("#current-dir-label");
const recentDirsDropdown = document.querySelector("#recent-dirs-dropdown");
const recentDirsList = document.querySelector("#recent-dirs-list");
const dropdownTabs = document.querySelector("#dropdown-tabs");
const btnPickDir = document.querySelector("#btn-pick-dir");
const btnOpenFinder = document.querySelector("#btn-open-finder");
const projectsListEl = document.querySelector("#projects-list");

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
  app.ipcRenderer.send("directory:add-recent", dir);
  if (app.refreshGit) app.refreshGit();
  if (app.checkDevServerAvailable) app.checkDevServerAvailable();
  if (app.updateSearchBarWorkspace) app.updateSearchBarWorkspace();
  // Re-render projects to highlight active + re-render sessions for this workspace
  renderProjectsList();
  if (app.renderSessionList) app.renderSessionList();
}

function dirName(dir) {
  if (!dir || dir === "Unknown") return "Unknown";
  const parts = dir.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

function renderProjectsList() {
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

  let html = "";
  for (const dir of allDirs) {
    const isActive = dir === state.currentDir;
    const activeClass = isActive ? "active" : "";
    const sessionCount = state.sessions.filter(
      (s) => s.directory === dir,
    ).length;
    html += `<button class="project-item ${activeClass}" data-project-dir="${escapeHtml(dir)}" title="${escapeHtml(shortDir(dir))}">
      <span class="project-item-icon">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 1.5H12.5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-9C2.67 13.5 2 12.83 2 12V4.5z" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </span>
      <span class="project-item-name">${escapeHtml(dirName(dir))}</span>
      ${sessionCount > 0 ? `<span class="project-item-count">${sessionCount}</span>` : ""}
    </button>`;
  }

  if (allDirs.length === 0) {
    html = `<div class="session-empty" style="padding:20px 8px;font-size:11px">No workspaces yet</div>`;
  }

  projectsListEl.innerHTML = html;

  // Click to switch workspace
  projectsListEl
    .querySelectorAll(".project-item[data-project-dir]")
    .forEach((el) => {
      el.addEventListener("click", () => {
        setDirectory(el.dataset.projectDir);
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

// Close dropdown on outside click
document.addEventListener("click", () => {
  app.animateClose(recentDirsDropdown, "dropOut", 150);
});

module.exports = {
  pickDirectory,
  setDirectory,
  renderRecentDirs,
  renderProjectsList,
};
