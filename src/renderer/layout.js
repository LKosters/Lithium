const app = require("./app");
const { state, terminals, findLeafById, findLeafBySession, getAllLeaves, cleanupEmptyLeaves, genPaneId } = require("./state");
const { escapeHtml, getSession } = require("./helpers");

// ── Drag overlay ──────────────────────────────────────
const dragOverlay = document.querySelector("#drag-overlay");
function startDragOverlay(cursor) {
  dragOverlay.className = 'active' + (cursor === 'row-resize' ? ' row-resize' : '');
}
function stopDragOverlay() {
  dragOverlay.className = '';
}

let _dragSessionId = null;

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
        <button class="pane-tab-close" data-close-session="${sid}">&times;</button>`;

      tab.addEventListener('click', (e) => {
        if (e.target.closest('.pane-tab-close')) return;
        node.activeTab = sid;
        state.focusedPaneId = node.id;
        refreshLayout();
      });

      tab.querySelector('.pane-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        app.closeTab(sid);
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
  } catch {}
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

module.exports = { renderLayout, refreshLayout, showDropOverlays, hideDropOverlays, handleTabDrop, startDragOverlay, stopDragOverlay, getSavedLayout, clearSavedLayout };
