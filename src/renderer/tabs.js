const { v4: uuidv4 } = require("uuid");
const app = require("./app");
const { state, terminals, findLeafById, findLeafBySession, getAllLeaves, cleanupEmptyLeaves, genPaneId } = require("./state");
const { shortDir, getSession, persistSession } = require("./helpers");

function openTab(sessionId) {
  if (state.layout) {
    const existing = findLeafBySession(state.layout, sessionId);
    if (existing) {
      existing.activeTab = sessionId;
      state.focusedPaneId = existing.id;
      app.refreshLayout();
      return;
    }
  }

  if (!terminals.has(sessionId)) {
    const s = getSession(sessionId);
    if (s) {
      app.createTerminal(sessionId);
      app.ipcRenderer.send("pty:spawn", { sessionId, cwd: s.directory, resume: true });
    }
  }

  if (!state.layout) {
    const paneId = genPaneId();
    state.layout = { type: 'leaf', id: paneId, tabs: [sessionId], activeTab: sessionId };
    state.focusedPaneId = paneId;
  } else {
    const leaf = findLeafById(state.layout, state.focusedPaneId);
    if (leaf) {
      leaf.tabs.push(sessionId);
      leaf.activeTab = sessionId;
    } else {
      const leaves = getAllLeaves(state.layout);
      if (leaves.length > 0) {
        leaves[0].tabs.push(sessionId);
        leaves[0].activeTab = sessionId;
        state.focusedPaneId = leaves[0].id;
      }
    }
  }

  app.refreshLayout();
}

function closeTab(sessionId) {
  app.ipcRenderer.send("pty:kill", { sessionId });

  const t = terminals.get(sessionId);
  if (t) {
    t.term.dispose();
    t.paneEl.remove();
    terminals.delete(sessionId);
  }

  if (state.layout) {
    const leaf = findLeafBySession(state.layout, sessionId);
    if (leaf) {
      leaf.tabs = leaf.tabs.filter(id => id !== sessionId);
      if (leaf.activeTab === sessionId) {
        leaf.activeTab = leaf.tabs[leaf.tabs.length - 1] || null;
      }
    }

    state.layout = cleanupEmptyLeaves(state.layout);

    if (state.layout && !findLeafById(state.layout, state.focusedPaneId)) {
      const leaves = getAllLeaves(state.layout);
      state.focusedPaneId = leaves.length > 0 ? leaves[0].id : null;
    }
    if (!state.layout) {
      state.focusedPaneId = null;
    }
  }

  app.refreshLayout();
}

function newSession() {
  if (!state.currentDir) {
    app.pickDirectory();
    return;
  }

  const id = uuidv4();
  const session = {
    id,
    directory: state.currentDir,
    title: shortDir(state.currentDir),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  state.sessions.unshift(session);
  persistSession(session);

  app.createTerminal(id);
  app.ipcRenderer.send("pty:spawn", { sessionId: id, cwd: state.currentDir });
  openTab(id);
}

module.exports = { openTab, closeTab, newSession };
