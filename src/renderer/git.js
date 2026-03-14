const app = require("./app");
const { escapeHtml } = require("./helpers");

const gitSidebar = document.querySelector("#git-sidebar");
const btnGit = document.querySelector("#btn-git");
const btnGitClose = document.querySelector("#btn-git-close");
let gitOpen = false;
let pollTimer = null;

const STATUS_MAP = {
  M: { label: "M", cls: "modified" },
  A: { label: "A", cls: "added" },
  D: { label: "D", cls: "deleted" },
  R: { label: "R", cls: "renamed" },
  "?": { label: "U", cls: "untracked" },
};

function statusInfo(code) {
  return STATUS_MAP[code] || { label: code, cls: "modified" };
}

function shortPath(filepath) {
  const parts = filepath.split("/");
  if (parts.length <= 2) return filepath;
  return ".../" + parts.slice(-2).join("/");
}

function getCwd() {
  return app.state?.currentDir;
}

function gitUrlToWeb(url) {
  // Convert git@github.com:user/repo.git or https://github.com/user/repo.git to https URL
  let web = url.replace(/\.git$/, "");
  const sshMatch = web.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) web = `https://${sshMatch[1]}/${sshMatch[2]}`;
  return web;
}

function cleanUrl(url) {
  return url.replace(/\.git$/, "").replace(/^https?:\/\//, "").replace(/^git@([^:]+):/, "$1/");
}

// ── Render ────────────────────────────────────────────

function renderGitData(data) {
  const noRepo = document.querySelector("#git-no-repo");
  const branchName = document.querySelector("#git-branch-name");
  const stagedList = document.querySelector("#git-staged-list");
  const changesList = document.querySelector("#git-changes-list");
  const stagedCount = document.querySelector("#git-staged-count");
  const changesCount = document.querySelector("#git-changes-count");
  const logList = document.querySelector("#git-log-list");
  const scrollable = document.querySelector(".git-scrollable");
  const actionsBar = document.querySelector(".git-actions");
  const repoInfo = document.querySelector("#git-repo-info");
  const repoNameEl = document.querySelector("#git-repo-name");
  const repoUrlEl = document.querySelector("#git-repo-url");

  if (!data) {
    noRepo.classList.remove("hidden");
    repoInfo.classList.add("hidden");
    branchName.textContent = "—";
    stagedList.innerHTML = "";
    changesList.innerHTML = "";
    logList.innerHTML = "";
    stagedCount.textContent = "0";
    changesCount.textContent = "0";
    if (scrollable) scrollable.style.display = "none";
    if (actionsBar) actionsBar.style.display = "none";
    return;
  }

  noRepo.classList.add("hidden");
  if (scrollable) scrollable.style.display = "";
  if (actionsBar) actionsBar.style.display = "";

  // Repo name & URL
  if (data.repoName) {
    repoNameEl.textContent = data.repoName;
    if (data.remoteUrl) {
      const webUrl = gitUrlToWeb(data.remoteUrl);
      repoUrlEl.textContent = cleanUrl(data.remoteUrl);
      repoUrlEl.onclick = (e) => {
        e.preventDefault();
        require("electron").shell.openExternal(webUrl);
      };
      repoUrlEl.style.display = "";
    } else {
      repoUrlEl.style.display = "none";
    }
    repoInfo.classList.remove("hidden");
  } else {
    repoInfo.classList.add("hidden");
  }

  branchName.textContent = data.branch;
  stagedCount.textContent = data.staged.length;
  changesCount.textContent = data.changes.length;

  stagedList.innerHTML = data.staged
    .map((f) => {
      const s = statusInfo(f.status);
      return `<div class="git-file-item clickable" data-unstage="${escapeHtml(f.file)}" title="Click to unstage">
        <span class="git-file-status ${s.cls}">${s.label}</span>
        <span class="git-file-name" title="${escapeHtml(f.file)}">${escapeHtml(shortPath(f.file))}</span>
        <span class="git-file-action">−</span>
      </div>`;
    })
    .join("");

  stagedList.querySelectorAll("[data-unstage]").forEach((el) => {
    el.addEventListener("click", async () => {
      const cwd = getCwd();
      if (!cwd) return;
      await app.ipcRenderer.invoke("git:unstage-file", { cwd, file: el.dataset.unstage });
      refreshGit();
    });
  });

  changesList.innerHTML = data.changes
    .map((f) => {
      const s = statusInfo(f.status);
      return `<div class="git-file-item clickable" data-stage="${escapeHtml(f.file)}" title="Click to stage">
        <span class="git-file-status ${s.cls}">${s.label}</span>
        <span class="git-file-name" title="${escapeHtml(f.file)}">${escapeHtml(shortPath(f.file))}</span>
        <span class="git-file-action">+</span>
      </div>`;
    })
    .join("");

  changesList.querySelectorAll("[data-stage]").forEach((el) => {
    el.addEventListener("click", async () => {
      const cwd = getCwd();
      if (!cwd) return;
      await app.ipcRenderer.invoke("git:stage-file", { cwd, file: el.dataset.stage });
      refreshGit();
    });
  });

  logList.innerHTML = data.log
    .map(
      (c) => `<div class="git-log-item">
        <span class="git-log-msg">${escapeHtml(c.msg)}</span>
        <span class="git-log-meta">
          <span class="git-log-hash">${escapeHtml(c.hash)}</span>
          <span>${escapeHtml(c.time)}</span>
        </span>
      </div>`
    )
    .join("");
}

// ── Actions ───────────────────────────────────────────

async function stageAll() {
  const cwd = getCwd();
  if (!cwd) return;
  await app.ipcRenderer.invoke("git:stage-all", { cwd });
  refreshGit();
}

async function commitChanges() {
  const wrap = document.querySelector("#git-commit-input-wrap");
  const input = document.querySelector("#git-commit-input");

  if (wrap.classList.contains("hidden")) {
    wrap.classList.remove("hidden");
    input.value = "";
    input.focus();
    return;
  }

  const msg = input.value.trim();
  if (!msg) {
    input.focus();
    return;
  }

  const cwd = getCwd();
  if (!cwd) return;
  await app.ipcRenderer.invoke("git:commit", { cwd, message: msg });
  wrap.classList.add("hidden");
  input.value = "";
  refreshGit();
}

async function pushChanges() {
  const cwd = getCwd();
  if (!cwd) return;
  await app.ipcRenderer.invoke("git:push", { cwd });
  refreshGit();
}

// ── Branches ──────────────────────────────────────────

let cachedBranches = [];

function renderBranchList(filter) {
  const list = document.querySelector("#git-branches-list");
  const hint = document.querySelector("#git-branch-create-hint");
  const hintName = document.querySelector("#git-branch-create-name");
  const query = (filter || "").toLowerCase().trim();

  const filtered = query
    ? cachedBranches.filter((b) => b.name.toLowerCase().includes(query))
    : cachedBranches;

  const exactMatch = cachedBranches.some((b) => b.name.toLowerCase() === query);

  list.innerHTML = filtered
    .map(
      (b) => `<div class="git-branch-item ${b.current ? "current" : ""}" data-branch="${escapeHtml(b.name)}">
        ${b.current ? '<span class="branch-indicator"></span>' : ""}
        <span>${escapeHtml(b.name)}</span>
      </div>`
    )
    .join("");

  list.querySelectorAll(".git-branch-item:not(.current)").forEach((el) => {
    el.addEventListener("click", async () => {
      const branch = el.dataset.branch;
      const dropdown = document.querySelector("#git-branches-dropdown");
      await app.ipcRenderer.invoke("git:checkout", { cwd: getCwd(), branch });
      dropdown.classList.add("hidden");
      refreshGit();
    });
  });

  if (query && !exactMatch) {
    hintName.textContent = query;
    hint.classList.remove("hidden");
  } else {
    hint.classList.add("hidden");
  }
}

async function toggleBranches() {
  const dropdown = document.querySelector("#git-branches-dropdown");
  const searchInput = document.querySelector("#git-branch-search");

  if (!dropdown.classList.contains("hidden")) {
    dropdown.classList.add("hidden");
    return;
  }

  const cwd = getCwd();
  if (!cwd) return;
  cachedBranches = await app.ipcRenderer.invoke("git:branches", { cwd });

  searchInput.value = "";
  renderBranchList("");
  dropdown.classList.remove("hidden");
  searchInput.focus();
}

const branchSearchInput = document.querySelector("#git-branch-search");
branchSearchInput.addEventListener("input", () => {
  renderBranchList(branchSearchInput.value);
});

branchSearchInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const query = branchSearchInput.value.trim();
    if (!query) return;
    const cwd = getCwd();
    if (!cwd) return;

    const exactMatch = cachedBranches.some((b) => b.name.toLowerCase() === query.toLowerCase());
    const dropdown = document.querySelector("#git-branches-dropdown");

    if (exactMatch) {
      await app.ipcRenderer.invoke("git:checkout", { cwd, branch: query });
    } else {
      await app.ipcRenderer.invoke("git:create-branch", { cwd, branch: query });
    }
    dropdown.classList.add("hidden");
    refreshGit();
  }
  if (e.key === "Escape") {
    document.querySelector("#git-branches-dropdown").classList.add("hidden");
  }
});

// ── Refresh ───────────────────────────────────────────

async function refreshGit() {
  const cwd = getCwd();
  if (!cwd) {
    renderGitData(null);
    return;
  }
  const data = await app.ipcRenderer.invoke("git:status", { cwd });
  renderGitData(data);
}

// ── Open / Close ──────────────────────────────────────

function openGit() {
  gitOpen = true;
  gitSidebar.classList.remove("hidden");
  btnGit.classList.add("active");
  refreshGit();
  pollTimer = setInterval(refreshGit, 3000);
}

function closeGit() {
  gitOpen = false;
  gitSidebar.classList.add("hidden");
  btnGit.classList.remove("active");
  document.querySelector("#git-branches-dropdown").classList.add("hidden");
  document.querySelector("#git-commit-input-wrap").classList.add("hidden");
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Event listeners ───────────────────────────────────

btnGit.addEventListener("click", () => {
  if (gitOpen) closeGit();
  else openGit();
});

btnGitClose.addEventListener("click", closeGit);

document.querySelector("#btn-git-stage").addEventListener("click", stageAll);
document.querySelector("#btn-git-commit").addEventListener("click", commitChanges);
document.querySelector("#btn-git-push").addEventListener("click", pushChanges);
document.querySelector(".git-branch-bar").addEventListener("click", toggleBranches);

document.querySelector("#git-commit-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitChanges();
  }
  if (e.key === "Escape") {
    document.querySelector("#git-commit-input-wrap").classList.add("hidden");
  }
});

function isGitOpen() {
  return gitOpen;
}

module.exports = { openGit, closeGit, isGitOpen, refreshGit };
