const { v4: uuidv4 } = require("uuid");
const app = require("./app");
const { state, terminals, findLeafById, findLeafBySession, getAllLeaves, cleanupEmptyLeaves, genPaneId, findParent } = require("./state");
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
      if (s.mode === "chat" && app.createChatPane) {
        app.createChatPane(sessionId, s.provider, s.model);
      } else {
        app.createTerminal(sessionId);
        app.ipcRenderer.send("pty:spawn", { sessionId, cwd: s.directory, resume: true });
      }
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
  const t = terminals.get(sessionId);

  if (t && t.isChat) {
    // Chat mode — clean up chat state
    t.paneEl.remove();
    terminals.delete(sessionId);
    if (app.deleteChatState) app.deleteChatState(sessionId);
    app.ipcRenderer.send("agent:clear-history", sessionId);
  } else {
    // Terminal mode — kill PTY
    app.ipcRenderer.send("pty:kill", { sessionId });
    if (t) {
      t.term.dispose();
      t.paneEl.remove();
      terminals.delete(sessionId);
    }
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

// direction: "horizontal" (left/right) or "vertical" (top/bottom)
function splitNewSession(direction) {
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

  if (!state.layout) {
    const paneId = genPaneId();
    state.layout = { type: "leaf", id: paneId, tabs: [id], activeTab: id };
    state.focusedPaneId = paneId;
  } else {
    const currentLeaf = findLeafById(state.layout, state.focusedPaneId)
      || getAllLeaves(state.layout)[0];
    if (!currentLeaf) {
      openTab(id);
      return;
    }

    const newPaneId = genPaneId();
    const newLeaf = { type: "leaf", id: newPaneId, tabs: [id], activeTab: id };
    const oldCopy = { ...currentLeaf };
    const splitId = genPaneId();

    currentLeaf.type = "split";
    currentLeaf.direction = direction;
    currentLeaf.ratio = 0.5;
    currentLeaf.children = [oldCopy, newLeaf];
    delete currentLeaf.tabs;
    delete currentLeaf.activeTab;
    currentLeaf.id = splitId;

    state.focusedPaneId = newPaneId;
  }

  app.refreshLayout();
  app.renderSessionList();
}

module.exports = { openTab, closeTab, newSession, splitNewSession };
