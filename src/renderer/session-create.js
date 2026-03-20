// Shared logic for creating sessions and rendering directory dropdowns.
// Used by both the quick-open modal and the search-bar to avoid duplication.

const { v4: uuidv4 } = require("uuid");
const app = require("./app");
const { state, terminals: termsMap } = require("./state");
const { escapeHtml, shortDir, persistSession } = require("./helpers");

/**
 * Create a new session and open it.
 * @param {Object} opts
 * @param {string|null} opts.name - Session name (optional)
 * @param {string|null} opts.dir - Working directory
 * @param {Function} opts.onDone - Called after creation
 * @returns {boolean} true if created, false if dir is missing
 */
function createSessionAndOpen({ name, dir, onDone }) {
  if (!dir) return false;

  const id = uuidv4();
  const session = {
    id,
    directory: dir,
    title: name || shortDir(dir),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  state.sessions.unshift(session);
  persistSession(session);
  app.createTerminal(id);
  app.ipcRenderer.send("pty:spawn", { sessionId: id, cwd: dir });
  if (dir !== state.currentDir && app.setDirectory) {
    app.setDirectory(dir);
  }
  app.openTab(id);
  app.renderSessionList();
  if (onDone) onDone();
  return true;
}

/**
 * Render a directory dropdown list (favorites/recent tabs + star buttons).
 * Avoids duplicating this logic between quick-open and search-bar.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.tabsEl - The tabs container element
 * @param {HTMLElement} opts.listEl - The list container element
 * @param {HTMLElement} opts.dropdownEl - The dropdown wrapper element
 * @param {string} opts.tabAttr - The data attribute name for tab buttons (e.g. "qoTab" or "sbTab")
 * @param {string} opts.activeTab - Current active tab ("favorites" or "recent")
 * @param {Function} opts.onSelectDir - Called with dir when user picks one
 * @param {Function} opts.onTabChange - Called with new tab name when user switches tabs
 */
function renderDirDropdown({ tabsEl, listEl, dropdownEl, tabAttr, activeTab, onSelectDir, onTabChange }) {
  const hasFavorites = state.starredDirs.length > 0;
  if (hasFavorites) {
    tabsEl.classList.remove("hidden");
  } else {
    tabsEl.classList.add("hidden");
    activeTab = "recent";
  }

  tabsEl.querySelectorAll(".dropdown-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset[tabAttr] === activeTab);
  });

  const dirs = activeTab === "favorites"
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
    const msg = activeTab === "favorites" ? "No favorites yet" : "No recent directories";
    html = `<div class="dropdown-empty">${msg}</div>`;
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll(".dropdown-item[data-dir]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".star-btn")) return;
      onSelectDir(el.dataset.dir);
      app.animateClose(dropdownEl, "dropOut", 150);
    });
  });
  listEl.querySelectorAll(".star-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dir = btn.dataset.starDir;
      if (state.starredDirs.includes(dir)) {
        state.starredDirs = state.starredDirs.filter((d) => d !== dir);
      } else {
        state.starredDirs.push(dir);
      }
      app.ipcRenderer.send("directory:toggle-star", dir);
      // Re-render after star toggle
      renderDirDropdown({ tabsEl, listEl, dropdownEl, tabAttr, activeTab, onSelectDir, onTabChange });
    });
  });
}

/**
 * Render a session list with "New Session" row + matching sessions.
 * @param {Object} opts
 * @param {string} opts.query - Search query
 * @param {number} opts.selectedIdx - Currently selected index
 * @param {HTMLElement} opts.listEl - Container element
 * @param {string} opts.itemClass - CSS class for session items (e.g. "quick-open-item" or "sb-item")
 * @param {string} opts.newClass - CSS class for new session row
 * @param {string} opts.emptyClass - CSS class for empty state
 * @param {boolean} opts.showWorkspace - Whether to show workspace name on items
 * @param {Function} opts.onNew - Called when "New Session" is clicked
 * @param {Function} opts.onSelect - Called with sessionId when session is selected
 * @param {Function} opts.onHover - Called with index when item is hovered
 */
function renderSessionList({ query, selectedIdx, listEl, itemClass, newClass, emptyClass, showWorkspace, onNew, onSelect, onHover }) {
  const q = query.toLowerCase().trim();
  const matches = state.sessions.filter((s) => {
    const title = (s.title || "").toLowerCase();
    const dir = (s.directory || "").toLowerCase();
    return !q || title.includes(q) || dir.includes(q);
  });

  let html = `<div class="${newClass} ${selectedIdx === 0 ? "selected" : ""}" data-action="new">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span>New Session${q ? ": " + escapeHtml(q) : ""}</span>
  </div>`;

  html += matches.map((s, i) => {
    const t = termsMap.get(s.id);
    const alive = t?.alive ? "alive" : "";
    const idx = i + 1;
    const sel = idx === selectedIdx ? "selected" : "";
    const dirName = s.directory ? s.directory.split("/").pop() : "";
    return `<div class="${itemClass} ${sel}" data-sid="${s.id}">
      <span class="${itemClass}-status ${alive}"></span>
      <span class="${itemClass}-title">${escapeHtml(s.title || "Session")}</span>
      ${showWorkspace && dirName ? `<span class="${itemClass}-workspace">${escapeHtml(dirName)}</span>` : ""}
      ${!showWorkspace ? `<span class="${itemClass}-dir">${escapeHtml(shortDir(s.directory || ""))}</span>` : ""}
    </div>`;
  }).join("");

  if (matches.length === 0 && q) {
    html += `<div class="${emptyClass}">No sessions found</div>`;
  }

  listEl.innerHTML = html;

  const totalItems = 1 + matches.length;

  // New session click
  const newEl = listEl.querySelector("[data-action='new']");
  if (newEl) {
    newEl.addEventListener("click", onNew);
    newEl.addEventListener("mouseenter", () => onHover(0));
  }

  // Session clicks
  listEl.querySelectorAll(`.${itemClass}`).forEach((el, i) => {
    el.addEventListener("click", () => onSelect(el.dataset.sid));
    el.addEventListener("mouseenter", () => onHover(i + 1));
  });

  return { totalItems, matches };
}

module.exports = { createSessionAndOpen, renderDirDropdown, renderSessionList };
