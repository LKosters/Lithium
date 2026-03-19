const { Terminal } = require("@xterm/xterm");
const { FitAddon } = require("@xterm/addon-fit");
const { WebLinksAddon } = require("@xterm/addon-web-links");
const app = require("./app");
const theme = require("./theme");
const { state, terminals, getAllLeaves } = require("./state");

function createTerminal(sessionId) {
  const term = new Terminal({
    theme,
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 14,
    lineHeight: 1.4,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    drawBoldTextInBrightColors: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());

  const paneEl = document.createElement("div");
  paneEl.className = "terminal-pane";
  paneEl.dataset.sessionId = sessionId;

  term.open(paneEl);

  term.onData((data) => app.ipcRenderer.send("pty:input", { sessionId, data }));
  term.onResize(({ cols, rows }) => app.ipcRenderer.send("pty:resize", { sessionId, cols, rows }));

  terminals.set(sessionId, { term, fitAddon, paneEl, alive: true });
  return terminals.get(sessionId);
}

let _fitRetryTimer = null;

function _doFit() {
  if (!state.layout) return;
  const leaves = getAllLeaves(state.layout);
  for (const leaf of leaves) {
    if (leaf.activeTab) {
      const t = terminals.get(leaf.activeTab);
      if (t && t.paneEl.offsetParent !== null) {
        try { t.fitAddon.fit(); } catch (_) {}
      }
    }
  }
}

function fitAllVisibleTerminals() {
  _doFit();

  // Schedule retries. The browser may not have finished layout computation
  // on the first call, so we retry at increasing intervals to catch cases
  // where the container dimensions settle after the initial render.
  clearTimeout(_fitRetryTimer);
  _fitRetryTimer = setTimeout(() => {
    _doFit();
    // One more retry at a longer interval for complex layout changes
    _fitRetryTimer = setTimeout(_doFit, 150);
  }, 50);
}

module.exports = { createTerminal, fitAllVisibleTerminals };
