const app = require("./app");
const { state, terminals, collapsedDirs } = require("./state");
const { escapeHtml, shortDir, timeAgo, getSession, groupSessionsByDir, persistSession } = require("./helpers");

function dirName(dir) {
  if (!dir || dir === "Unknown") return "Unknown";
  const parts = dir.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

function renderSessionList() {
  const sessionListEl = app.dom.sessionListEl;
  const groups = groupSessionsByDir(state.sessions);
  let html = "";

  for (const [dir, sessions] of groups) {
    const collapsed = collapsedDirs.has(dir);
    const chevronClass = collapsed ? "group-chevron collapsed" : "group-chevron";
    const count = sessions.length;
    html += `<div class="chat-group" data-group-dir="${escapeHtml(dir)}">
      <div class="chat-group-label" title="${escapeHtml(shortDir(dir))}">
        <svg class="${chevronClass}" width="8" height="8" viewBox="0 0 16 16" fill="none">
          <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="group-label-text">${escapeHtml(dirName(dir))}</span>
        <span class="group-count">${count}</span>
      </div>`;
    if (!collapsed) {
      for (const s of sessions) {
        const active = s.id === state.activeId ? "active" : "";
        const t = terminals.get(s.id);
        const alive = t?.alive ? "alive" : "";
        html += `
          <div class="session-item ${active}" data-session-id="${s.id}">
            <span class="session-item-status ${alive}"></span>
            <span class="session-item-title">${escapeHtml(s.title || "Session")}</span>
            <span class="session-item-meta">${timeAgo(s.updatedAt)}</span>
            <div class="session-item-actions">
              <button class="session-item-btn" data-focus-id="${s.id}" title="Focus Mode">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="session-item-btn" data-rename-id="${s.id}" title="Rename">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="session-item-btn" data-delete-id="${s.id}" title="Delete">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>`;
      }
    }
    html += `</div>`;
  }

  if (state.sessions.length === 0) {
    html = `<div class="session-empty">No sessions yet</div>`;
  }

  sessionListEl.innerHTML = html;

  sessionListEl.querySelectorAll(".chat-group[data-group-dir]").forEach((el) => {
    el.querySelector(".chat-group-label").addEventListener("click", () => {
      const dir = el.dataset.groupDir;
      if (collapsedDirs.has(dir)) collapsedDirs.delete(dir);
      else collapsedDirs.add(dir);
      renderSessionList();
    });
  });
  sessionListEl.querySelectorAll(".session-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".session-item-actions")) return;
      app.openTab(el.dataset.sessionId);
    });
  });
  sessionListEl.querySelectorAll("[data-focus-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      app.enterFocusMode(btn.dataset.focusId);
    });
  });
  sessionListEl.querySelectorAll("[data-rename-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(btn.dataset.renameId);
    });
  });
  sessionListEl.querySelectorAll("[data-delete-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(btn.dataset.deleteId);
    });
  });
}

function deleteSession(id) {
  app.closeTab(id);
  app.ipcRenderer.send("sessions:delete", id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  renderSessionList();
}

function startRename(sessionId) {
  const s = getSession(sessionId);
  if (!s) return;

  const sessionListEl = app.dom.sessionListEl;
  const itemEl = sessionListEl.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (!itemEl) return;

  const titleEl = itemEl.querySelector(".session-item-title");
  const oldTitle = s.title || "Session";

  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = oldTitle;
  input.setAttribute("spellcheck", "false");
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newTitle = input.value.trim() || oldTitle;
    s.title = newTitle;
    persistSession(s);
    app.refreshLayout();
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.value = oldTitle; input.blur(); }
  });
}

module.exports = { renderSessionList, deleteSession, startRename };
