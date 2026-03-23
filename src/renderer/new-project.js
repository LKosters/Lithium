const { ipcRenderer } = require("electron");
const app = require("./app");
const { state } = require("./state");
const { shortDir } = require("./helpers");

// ── DOM elements ─────────────────────────────────────
const npModal = document.querySelector("#new-project-modal");
const npForm = document.querySelector("#np-form");
const npProgress = document.querySelector("#np-progress");
const npNameInput = document.querySelector("#np-name");
const npDirPath = document.querySelector("#np-dir-path");
const npError = document.querySelector("#np-error");
const npFwCards = document.querySelectorAll(".np-fw-card");

let _npFramework = null;
let _npProjectsDir = null;

// ── Functions ────────────────────────────────────────
async function openNewProject() {
  _npProjectsDir = await ipcRenderer.invoke("config:resolve-projects-dir");
  npDirPath.textContent = _npProjectsDir ? shortDir(_npProjectsDir) : "Not set";
  npDirPath.classList.toggle("muted", !_npProjectsDir);

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

function isNewProjectVisible() {
  return !npModal.classList.contains("hidden");
}

// ── Event listeners ──────────────────────────────────
npFwCards.forEach((card) => {
  card.addEventListener("click", () => {
    npFwCards.forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    _npFramework = card.dataset.framework;
  });
});

document.querySelector("#np-dir-change").addEventListener("click", async () => {
  const result = await ipcRenderer.invoke("directory:pick");
  if (result) {
    _npProjectsDir = result.dir;
    npDirPath.textContent = shortDir(result.dir);
    npDirPath.classList.remove("muted");
    ipcRenderer.send("config:set", { key: "projectsDir", value: result.dir });
    state.recentDirs = result.recents;
    state.starredDirs = result.starred || [];
  }
});

document.querySelector("#np-cancel").addEventListener("click", closeNewProject);
document.querySelector("#np-close").addEventListener("click", closeNewProject);
document.querySelector(".np-backdrop").addEventListener("click", closeNewProject);

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
    _npProjectsDir = await ipcRenderer.invoke("config:create-default-projects-dir");
    npDirPath.textContent = shortDir(_npProjectsDir);
    npDirPath.classList.remove("muted");
  }

  npForm.classList.add("hidden");
  npProgress.classList.remove("hidden");

  const result = await ipcRenderer.invoke("project:create", {
    framework: _npFramework,
    name,
    projectsDir: _npProjectsDir,
  });

  if (result.ok) {
    // Ensure the new project appears in the projects list
    if (!state.recentDirs.includes(result.dir)) {
      state.recentDirs.unshift(result.dir);
    }
    app.setDirectory(result.dir);
    app.newSession();
    closeNewProject();
    document.querySelector("#btn-dev-server").classList.remove("hidden");
  } else {
    npProgress.classList.add("hidden");
    npForm.classList.remove("hidden");
    npError.textContent = result.error;
    npError.classList.remove("hidden");
  }
});

document.querySelector("#btn-new-project").addEventListener("click", openNewProject);

module.exports = { openNewProject, closeNewProject, isNewProjectVisible };
