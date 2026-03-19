const app = require("./app");
const { state } = require("./state");
const { shortDir, escapeHtml } = require("./helpers");

const currentDirLabel = document.querySelector("#current-dir-label");
const recentDirsDropdown = document.querySelector("#recent-dirs-dropdown");
const recentDirsList = document.querySelector("#recent-dirs-list");
const dropdownTabs = document.querySelector("#dropdown-tabs");
const btnPickDir = document.querySelector("#btn-pick-dir");
const btnOpenFinder = document.querySelector("#btn-open-finder");

let activeDropdownTab = "favorites";

async function pickDirectory() {
  const result = await app.ipcRenderer.invoke("directory:pick");
  if (!result) return;
  setDirectory(result.dir);
  state.recentDirs = result.recents;
  state.starredDirs = result.starred || [];
  renderRecentDirs();
}

function setDirectory(dir) {
  state.currentDir = dir;
  currentDirLabel.textContent = shortDir(dir);
  localStorage.setItem("currentDir", dir);
  app.ipcRenderer.send("directory:add-recent", dir);
  if (app.refreshGit) app.refreshGit();
  if (app.checkDevServerAvailable) app.checkDevServerAvailable();
  if (app.updateSearchBarWorkspace) app.updateSearchBarWorkspace();
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

  const dirs = activeDropdownTab === "favorites"
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
    const msg = activeDropdownTab === "favorites" ? "No favorites yet" : "No recent directories";
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

module.exports = { pickDirectory, setDirectory, renderRecentDirs };
