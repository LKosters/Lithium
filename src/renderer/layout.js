const app = require("./app");
const { state, terminals, findLeafById, findLeafBySession, getAllLeaves, cleanupEmptyLeaves, genPaneId, getAllTabs } = require("./state");
const { escapeHtml, getSession, persistSession } = require("./helpers");

// ── Drag overlay ──────────────────────────────────────
const dragOverlay = document.querySelector("#drag-overlay");
function startDragOverlay(cursor) {
  dragOverlay.className = 'active' + (cursor === 'row-resize' ? ' row-resize' : '');
}
function stopDragOverlay() {
  dragOverlay.className = '';
}

let _dragSessionId = null;

// ── Tab context menu ────────────────────────────────
let _ctxMenu = null;

function dismissCtxMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  document.removeEventListener('mousedown', _onCtxOutside, true);
}

function _onCtxOutside(e) {
  if (_ctxMenu && !_ctxMenu.contains(e.target)) dismissCtxMenu();
}

function showTabCtxMenu(x, y, paneId, sessionId) {
  dismissCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';

  const leaf = findLeafById(state.layout, paneId);

  // If right-clicked on a specific tab, show close-tab option
  if (sessionId) {
    const closeItem = document.createElement('div');
    closeItem.className = 'tab-context-menu-item';
    closeItem.textContent = 'Close Tab';
    closeItem.addEventListener('click', () => { dismissCtxMenu(); app.closeTab(sessionId); });
    menu.appendChild(closeItem);

    if (leaf && leaf.tabs.length > 1) {
      const closeOthers = document.createElement('div');
      closeOthers.className = 'tab-context-menu-item';
      closeOthers.textContent = 'Close Other Tabs';
      closeOthers.addEventListener('click', () => {
        dismissCtxMenu();
        const toClose = leaf.tabs.filter(id => id !== sessionId);
        toClose.forEach(id => app.closeTab(id));
      });
      menu.appendChild(closeOthers);
    }

    const sep = document.createElement('div');
    sep.className = 'tab-context-menu-sep';
    menu.appendChild(sep);
  }

  // Close all tabs in this pane
  if (leaf && leaf.tabs.length > 0) {
    const closePane = document.createElement('div');
    closePane.className = 'tab-context-menu-item destructive';
    closePane.textContent = 'Close All Tabs in Pane';
    closePane.addEventListener('click', () => {
      dismissCtxMenu();
      const toClose = [...leaf.tabs];
      toClose.forEach(id => app.closeTab(id));
    });
    menu.appendChild(closePane);
  }

  // Close all tabs everywhere
  const allTabs = state.layout ? getAllTabs(state.layout) : [];
  if (allTabs.length > 0) {
    const closeAll = document.createElement('div');
    closeAll.className = 'tab-context-menu-item destructive';
    closeAll.textContent = 'Close All Tabs';
    closeAll.addEventListener('click', () => {
      dismissCtxMenu();
      const toClose = [...allTabs];
      toClose.forEach(id => app.closeTab(id));
    });
    menu.appendChild(closeAll);
  }

  document.body.appendChild(menu);
  _ctxMenu = menu;

  // Clamp position to viewport
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  setTimeout(() => document.addEventListener('mousedown', _onCtxOutside, true), 0);
}

function renderLayout(node, parentEl) {
  if (!node) return;

  if (node.type === 'leaf') {
    const container = document.createElement('div');
    container.className = 'pane-container' + (node.id === state.focusedPaneId ? ' focused' : '');
    container.dataset.paneId = node.id;

    const tabBar = document.createElement('div');
    tabBar.className = 'pane-tab-bar';
    for (const sid of node.tabs) {
      const s = getSession(sid);
      if (!s) continue;
      const t = terminals.get(sid);
      const tab = document.createElement('div');
      tab.className = 'pane-tab' + (sid === node.activeTab ? ' active' : '');
      tab.dataset.sessionId = sid;
      tab.dataset.paneId = node.id;
      tab.draggable = true;
      tab.innerHTML = `
        <span class="pane-tab-status ${t?.alive ? 'alive' : ''}"></span>
        <span class="pane-tab-title">${escapeHtml(s.title || 'Session')}</span>
        <button class="pane-tab-rename" data-rename-session="${sid}" title="Rename">
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
            <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="pane-tab-close" data-close-session="${sid}">&times;</button>`;

      tab.addEventListener('click', (e) => {
        if (e.target.closest('.pane-tab-close') || e.target.closest('.pane-tab-rename')) return;
        node.activeTab = sid;
        state.focusedPaneId = node.id;
        // Switch workspace to match the selected tab's directory
        if (s.directory && s.directory !== state.currentDir && app.setDirectory) {
          app.setDirectory(s.directory);
        }
        refreshLayout();
      });

      tab.querySelector('.pane-tab-rename').addEventListener('click', (e) => {
        e.stopPropagation();
        startTabRename(tab, sid);
      });

      tab.querySelector('.pane-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        app.closeTab(sid);
      });

      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabCtxMenu(e.clientX, e.clientY, node.id, sid);
      });

      tab.addEventListener('dragstart', (e) => {
        _dragSessionId = sid;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', sid);
        requestAnimationFrame(() => showDropOverlays(node.id));
      });
      tab.addEventListener('dragend', () => {
        _dragSessionId = null;
        hideDropOverlays();
      });

      tabBar.appendChild(tab);
    }
    tabBar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabCtxMenu(e.clientX, e.clientY, node.id, null);
    });

    container.appendChild(tabBar);

    const termArea = document.createElement('div');
    termArea.className = 'pane-terminal';

    if (node.activeTab) {
      const t = terminals.get(node.activeTab);
      if (t) {
        t.paneEl.classList.add('active');
        termArea.appendChild(t.paneEl);
      }
    }
    container.appendChild(termArea);

    const overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.dataset.paneId = node.id;
    for (const zone of ['center', 'left', 'right', 'top', 'bottom']) {
      const dz = document.createElement('div');
      dz.className = 'drop-zone ' + zone;
      dz.dataset.zone = zone;
      dz.dataset.paneId = node.id;

      dz.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dz.classList.add('drag-over');
      });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('drag-over');
        if (_dragSessionId) {
          handleTabDrop(_dragSessionId, node.id, zone);
          _dragSessionId = null;
          hideDropOverlays();
        }
      });

      overlay.appendChild(dz);
    }
    container.appendChild(overlay);

    container.addEventListener('mousedown', () => {
      if (state.focusedPaneId !== node.id) {
        state.focusedPaneId = node.id;
        document.querySelectorAll('.pane-container.focused').forEach(el => el.classList.remove('focused'));
        container.classList.add('focused');
        // Switch workspace to match the focused pane's active session
        if (node.activeTab && app.setDirectory) {
          const activeSession = getSession(node.activeTab);
          if (activeSession?.directory && activeSession.directory !== state.currentDir) {
            app.setDirectory(activeSession.directory);
          }
        }
        app.renderSessionList();
      }
    });

    parentEl.appendChild(container);
    return;
  }

  const splitContainer = document.createElement('div');
  splitContainer.className = 'split-container ' + node.direction;

  const child0Wrapper = document.createElement('div');
  child0Wrapper.style.flex = String(node.ratio);
  child0Wrapper.style.overflow = 'hidden';
  child0Wrapper.style.display = 'flex';
  child0Wrapper.style.minWidth = '0';
  child0Wrapper.style.minHeight = '0';
  renderLayout(node.children[0], child0Wrapper);
  splitContainer.appendChild(child0Wrapper);

  const handle = document.createElement('div');
  handle.className = 'split-handle ' + node.direction;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';
    startDragOverlay(cursor);

    const onMove = (me) => {
      const rect = splitContainer.getBoundingClientRect();
      let ratio;
      if (node.direction === 'horizontal') {
        ratio = (me.clientX - rect.left) / rect.width;
      } else {
        ratio = (me.clientY - rect.top) / rect.height;
      }
      ratio = Math.max(0.1, Math.min(0.9, ratio));
      node.ratio = ratio;
      child0Wrapper.style.flex = String(ratio);
      child1Wrapper.style.flex = String(1 - ratio);
      app.fitAllVisibleTerminals();
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      stopDragOverlay();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      app.fitAllVisibleTerminals();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  splitContainer.appendChild(handle);

  const child1Wrapper = document.createElement('div');
  child1Wrapper.style.flex = String(1 - node.ratio);
  child1Wrapper.style.overflow = 'hidden';
  child1Wrapper.style.display = 'flex';
  child1Wrapper.style.minWidth = '0';
  child1Wrapper.style.minHeight = '0';
  renderLayout(node.children[1], child1Wrapper);
  splitContainer.appendChild(child1Wrapper);

  parentEl.appendChild(splitContainer);
}

function refreshLayout() {
  const terminalArea = app.dom.terminalArea;
  const welcomeEl = app.dom.welcomeEl;
  const tabBar = app.dom.tabBar;

  for (const [, t] of terminals) {
    if (t.paneEl.parentNode) t.paneEl.parentNode.removeChild(t.paneEl);
    t.paneEl.classList.remove('active');
  }

  const children = Array.from(terminalArea.children);
  for (const child of children) {
    if (child !== welcomeEl) terminalArea.removeChild(child);
  }

  tabBar.classList.add('split-mode');

  if (state.layout) {
    welcomeEl.classList.add('hidden');
    renderLayout(state.layout, terminalArea);
  } else {
    welcomeEl.classList.remove('hidden');
  }

  // Double-rAF: wait two frames so the browser finishes flex layout
  // before fitAddon measures the container dimensions.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      app.fitAllVisibleTerminals();
      if (state.focusedPaneId && state.layout) {
        const leaf = findLeafById(state.layout, state.focusedPaneId);
        if (leaf?.activeTab) {
          const t = terminals.get(leaf.activeTab);
          if (t) t.term.focus();
        }
      }
    });
  });

  app.renderSessionList();
  if (app.updateSearchBarWorkspace) app.updateSearchBarWorkspace();

  // Persist open tabs layout for restore on relaunch
  saveLayoutState();
}

function saveLayoutState() {
  try {
    if (state.layout) {
      const layoutJson = JSON.stringify(state.layout);
      localStorage.setItem("layoutState", layoutJson);
      localStorage.setItem("focusedPaneId", state.focusedPaneId || "");
      // Also persist to disk via main process so state survives crashes
      app.ipcRenderer.send("layout:save", {
        layout: state.layout,
        focusedPaneId: state.focusedPaneId || "",
      });
    } else {
      localStorage.removeItem("layoutState");
      localStorage.removeItem("focusedPaneId");
      app.ipcRenderer.send("layout:save", null);
    }
  } catch (err) {
    console.error("Failed to save layout state:", err.message);
  }
}

function getSavedLayout() {
  try {
    const raw = localStorage.getItem("layoutState");
    if (!raw) return null;
    const layout = JSON.parse(raw);
    const focusedPaneId = localStorage.getItem("focusedPaneId") || null;
    return { layout, focusedPaneId };
  } catch {
    return null;
  }
}

function clearSavedLayout() {
  localStorage.removeItem("layoutState");
  localStorage.removeItem("focusedPaneId");
}

function showDropOverlays(excludePaneId) {
  document.querySelectorAll('.drop-overlay').forEach(el => {
    el.classList.add('visible');
  });
}

function hideDropOverlays() {
  document.querySelectorAll('.drop-overlay').forEach(el => el.classList.remove('visible'));
  document.querySelectorAll('.drop-zone.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function handleTabDrop(sessionId, targetPaneId, zone) {
  if (!state.layout) return;

  const sourceLeaf = findLeafBySession(state.layout, sessionId);
  if (!sourceLeaf) return;

  if (zone === 'center') {
    if (sourceLeaf.id === targetPaneId) return;
    sourceLeaf.tabs = sourceLeaf.tabs.filter(id => id !== sessionId);
    if (sourceLeaf.activeTab === sessionId) {
      sourceLeaf.activeTab = sourceLeaf.tabs[sourceLeaf.tabs.length - 1] || null;
    }
    const targetLeaf = findLeafById(state.layout, targetPaneId);
    if (targetLeaf) {
      targetLeaf.tabs.push(sessionId);
      targetLeaf.activeTab = sessionId;
      state.focusedPaneId = targetLeaf.id;
    }
  } else {
    const direction = (zone === 'left' || zone === 'right') ? 'horizontal' : 'vertical';
    const targetLeaf = findLeafById(state.layout, targetPaneId);
    if (!targetLeaf) return;

    sourceLeaf.tabs = sourceLeaf.tabs.filter(id => id !== sessionId);
    if (sourceLeaf.activeTab === sessionId) {
      sourceLeaf.activeTab = sourceLeaf.tabs[sourceLeaf.tabs.length - 1] || null;
    }

    const newPaneId = genPaneId();
    const newLeaf = { type: 'leaf', id: newPaneId, tabs: [sessionId], activeTab: sessionId };

    const oldLeafCopy = { ...targetLeaf };
    const newSplitId = genPaneId();
    const first = (zone === 'left' || zone === 'top') ? newLeaf : oldLeafCopy;
    const second = (zone === 'left' || zone === 'top') ? oldLeafCopy : newLeaf;

    targetLeaf.type = 'split';
    targetLeaf.direction = direction;
    targetLeaf.ratio = 0.5;
    targetLeaf.children = [first, second];
    delete targetLeaf.tabs;
    delete targetLeaf.activeTab;
    targetLeaf.id = newSplitId;

    state.focusedPaneId = newPaneId;
  }

  state.layout = cleanupEmptyLeaves(state.layout);
  if (state.layout && !findLeafById(state.layout, state.focusedPaneId)) {
    const leaves = getAllLeaves(state.layout);
    state.focusedPaneId = leaves.length > 0 ? leaves[0].id : null;
  }

  refreshLayout();
}

function startTabRename(tabEl, sessionId) {
  const s = getSession(sessionId);
  if (!s) return;

  const titleEl = tabEl.querySelector('.pane-tab-title');
  if (!titleEl) return;

  const oldTitle = s.title || 'Session';

  const input = document.createElement('input');
  input.className = 'pane-tab-rename-input';
  input.value = oldTitle;
  input.setAttribute('spellcheck', 'false');
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newTitle = input.value.trim() || oldTitle;
    s.title = newTitle;
    persistSession(s);
    app.refreshLayout();
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldTitle; input.blur(); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

module.exports = { renderLayout, refreshLayout, showDropOverlays, hideDropOverlays, handleTabDrop, startDragOverlay, stopDragOverlay, getSavedLayout, clearSavedLayout };
