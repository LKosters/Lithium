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

function fitAllVisibleTerminals() {
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

  // Schedule a second fit after a short delay. The first fit may run before
  // the browser has fully resolved flex/grid layout, producing wrong
  // dimensions. This retry catches those cases without a visible flicker.
  clearTimeout(_fitRetryTimer);
  _fitRetryTimer = setTimeout(() => {
    if (!state.layout) return;
    const leaves2 = getAllLeaves(state.layout);
    for (const leaf of leaves2) {
      if (leaf.activeTab) {
        const t = terminals.get(leaf.activeTab);
        if (t && t.paneEl.offsetParent !== null) {
          try { t.fitAddon.fit(); } catch (_) {}
        }
      }
    }
  }, 80);
}

module.exports = { createTerminal, fitAllVisibleTerminals };
