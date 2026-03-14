// Shared context object — modules register functions here to avoid circular deps.
// Other modules call app.functionName() which resolves at call time.
const app = {
  ipcRenderer: null,
  // DOM refs, state, terminals, etc. are attached by other modules
};

module.exports = app;
