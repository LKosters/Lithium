const state = {
  sessions: [],
  currentDir: null,
  recentDirs: [],
  starredDirs: [],
  layout: null,
  focusedPaneId: null,
  focusMode: { active: false, sessionId: null, savedLayout: null, savedFocusedPaneId: null },
};

// ── Layout tree utilities ─────────────────────────────
let _paneCounter = 0;
function genPaneId() { return 'pane-' + (++_paneCounter); }

function getAllLeaves(node) {
  if (!node) return [];
  if (node.type === 'leaf') return [node];
  return [...getAllLeaves(node.children[0]), ...getAllLeaves(node.children[1])];
}

function getAllTabs(node) {
  return getAllLeaves(node).flatMap(l => l.tabs);
}

function findLeafById(node, id) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeafById(node.children[0], id) || findLeafById(node.children[1], id);
}

function findLeafBySession(node, sessionId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.tabs.includes(sessionId) ? node : null;
  return findLeafBySession(node.children[0], sessionId) || findLeafBySession(node.children[1], sessionId);
}

function findParent(root, nodeId) {
  if (!root || root.type === 'leaf') return null;
  for (let i = 0; i < 2; i++) {
    if (root.children[i].id === nodeId) return { parent: root, index: i };
  }
  return findParent(root.children[0], nodeId) || findParent(root.children[1], nodeId);
}

function cleanupEmptyLeaves(root) {
  if (!root) return null;
  if (root.type === 'leaf') return root.tabs.length > 0 ? root : null;
  root.children[0] = cleanupEmptyLeaves(root.children[0]);
  root.children[1] = cleanupEmptyLeaves(root.children[1]);
  if (!root.children[0] && !root.children[1]) return null;
  if (!root.children[0]) return root.children[1];
  if (!root.children[1]) return root.children[0];
  return root;
}

// Computed properties (set up after export so findLeafById/getAllTabs are available)
Object.defineProperty(state, 'openTabs', {
  get() { return state.layout ? getAllTabs(state.layout) : []; },
});
Object.defineProperty(state, 'activeId', {
  get() {
    if (!state.focusedPaneId || !state.layout) return null;
    const leaf = findLeafById(state.layout, state.focusedPaneId);
    return leaf ? leaf.activeTab : null;
  },
  set(v) { },
});

const terminals = new Map();
const collapsedDirs = new Set();

module.exports = {
  state, terminals, collapsedDirs,
  genPaneId, getAllLeaves, getAllTabs, findLeafById, findLeafBySession, findParent, cleanupEmptyLeaves,
};
