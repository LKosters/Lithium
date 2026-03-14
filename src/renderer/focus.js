const app = require("./app");
const { state, terminals, genPaneId, findLeafById, findLeafBySession } = require("./state");
const { getSession } = require("./helpers");

const btnExitFocus = document.querySelector("#btn-exit-focus");

function enterFocusMode(sessionId) {
  if (state.focusMode.active) return;

  if (!terminals.has(sessionId)) {
    const s = getSession(sessionId);
    if (!s) return;
    app.createTerminal(sessionId);
    app.ipcRenderer.send("pty:spawn", { sessionId, cwd: s.directory, resume: true });
  }

  state.focusMode.savedLayout = JSON.parse(JSON.stringify(state.layout));
  state.focusMode.savedFocusedPaneId = state.focusedPaneId;
  state.focusMode.sessionId = sessionId;
  state.focusMode.active = true;

  const paneId = genPaneId();
  state.layout = { type: 'leaf', id: paneId, tabs: [sessionId], activeTab: sessionId };
  state.focusedPaneId = paneId;

  document.body.classList.add('focus-mode');
  btnExitFocus.classList.remove('hidden');

  app.refreshLayout();
}

function exitFocusMode() {
  if (!state.focusMode.active) return;

  document.body.classList.remove('focus-mode');
  btnExitFocus.classList.add('hidden');

  if (state.focusMode.savedLayout) {
    state.layout = state.focusMode.savedLayout;
    state.focusedPaneId = state.focusMode.savedFocusedPaneId;

    const focusSid = state.focusMode.sessionId;
    if (focusSid && !findLeafBySession(state.layout, focusSid)) {
      const leaf = findLeafById(state.layout, state.focusedPaneId);
      if (leaf) {
        leaf.tabs.push(focusSid);
        leaf.activeTab = focusSid;
      }
    }
  }

  state.focusMode.active = false;
  state.focusMode.sessionId = null;
  state.focusMode.savedLayout = null;
  state.focusMode.savedFocusedPaneId = null;

  app.refreshLayout();
}

btnExitFocus.addEventListener("click", exitFocusMode);

module.exports = { enterFocusMode, exitFocusMode };
