const app = require("./app");
const { state, terminals } = require("./state");
const { escapeHtml, timeAgo, getSession, persistSession } = require("./helpers");

const expandedDoneDirs = new Set();
let renderedDir = null;
let renderedSearch = false;
const sessionsSearchEl = document.getElementById("sessions-search");
if (sessionsSearchEl) {
  sessionsSearchEl.addEventListener("input", renderSessionList);
}

function renderSessionList() {
  const sessionListEl = app.dom.sessionListEl;
  const previousDoneGroup = sessionListEl.querySelector(".session-done-group");
  if (previousDoneGroup && !renderedSearch) {
    if (previousDoneGroup.open) expandedDoneDirs.add(renderedDir);
    else expandedDoneDirs.delete(renderedDir);
  }
  const btnNewSession = document.getElementById("btn-new-session");
  if (btnNewSession) btnNewSession.style.display = state.currentDir ? "" : "none";

  // Filter sessions to only show those matching the current workspace
  const currentDir = state.currentDir;
  const searchTerm = sessionsSearchEl ? sessionsSearchEl.value.trim().toLowerCase() : "";
  const filtered = currentDir
    ? state.sessions.filter((s) => s.directory === currentDir
      && (!searchTerm || (s.title || "Session").toLowerCase().includes(searchTerm)))
    : [];

  const sorted = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);

  function renderSession(s) {
    const active = s.id === state.activeId ? "active" : "";
    const t = terminals.get(s.id);
    const alive = t?.alive ? "alive" : "";
    const done = s.done ? "done" : "";
    const snoozed = s.snoozed ? "snoozed" : "";
    return `
      <div class="session-item ${active} ${done} ${snoozed}" data-session-id="${s.id}">
        <span class="session-item-status ${alive}"></span>
        <span class="session-item-title">${escapeHtml(s.title || "Session")}</span>
        <span class="session-item-meta">${timeAgo(s.updatedAt)}</span>
        <div class="session-item-actions">
          <button class="session-item-btn" data-done-id="${s.id}" title="${s.done ? "Mark as not done" : "Mark as done"}">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="session-item-btn" data-snooze-id="${s.id}" title="${s.snoozed ? "Unsnooze session" : "Snooze session"}" aria-label="${s.snoozed ? "Unsnooze session" : "Snooze session"}" aria-pressed="${!!s.snoozed}">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13 9.2A5.5 5.5 0 0 1 6.8 3a5.5 5.5 0 1 0 6.2 6.2Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M10 2h3l-3 3h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
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

  let html = sorted.filter((s) => !s.done).map(renderSession).join("");
  const doneSessions = sorted.filter((s) => s.done);
  if (doneSessions.length > 0) {
    html += `
      <details class="session-done-group${searchTerm ? " search-results" : ""}"${searchTerm || expandedDoneDirs.has(currentDir) ? " open" : ""}>
        <summary class="chat-group-label">
          <span class="group-chevron" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="group-label-text">Done</span>
          <span class="group-count">${doneSessions.length}</span>
        </summary>
        ${doneSessions.map(renderSession).join("")}
      </details>`;
  }

  if (sorted.length === 0) {
    html = currentDir
      ? `<div class="session-empty">${searchTerm ? "No matching sessions" : "No sessions in this workspace"}</div>`
      : `<div class="session-empty">Select a project to view sessions</div>`;
  }

  sessionListEl.innerHTML = html;
  renderedDir = currentDir;
  renderedSearch = !!searchTerm;

  sessionListEl.querySelectorAll(".session-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".session-item-actions")) return;
      app.openTab(el.dataset.sessionId);
    });
  });
  sessionListEl.querySelectorAll("[data-done-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSessionDone(btn.dataset.doneId);
    });
  });
  sessionListEl.querySelectorAll("[data-snooze-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSessionSnooze(btn.dataset.snoozeId);
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

// Marks a session done (or undoes it). Purely a bookkeeping flag — the session
// keeps working; it just reads as finished in the sidebar and the tab bar.
function toggleSessionDone(id) {
  const s = getSession(id);
  if (!s) return;
  s.done = !s.done;
  persistSession(s);
  renderSessionList();
  app.refreshLayout();
}

function toggleSessionSnooze(id) {
  const s = getSession(id);
  if (!s) return;
  s.snoozed = !s.snoozed;
  // Keep the session's position and activity timestamp unchanged.
  app.ipcRenderer.send("sessions:save", s);
  renderSessionList();
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

module.exports = { renderSessionList, deleteSession, toggleSessionDone, startRename };
