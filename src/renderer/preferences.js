const { preferenceKey } = require('../shared/preferences');
let ipc;
const pending = new Map();
let timer;
function flush() {
  clearTimeout(timer);
  if (!ipc) return;
  for (const [key, value] of pending) ipc.send('preferences:set', { key, value });
  pending.clear();
}
function initialize(renderer) {
  ipc = renderer;
  const legacy = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i); if (preferenceKey(key)) legacy[key] = localStorage.getItem(key);
  }
  const result = ipc.sendSync('preferences:bootstrap', legacy);
  if (!result?.ok) throw new Error(result?.error || 'Could not load app preferences.');
  const { preferences, config, layout, restoreToken } = result.value;
  if (restoreToken && restoreToken !== localStorage.getItem('lithium-restore-token')) {
    localStorage.removeItem('devServerRunning'); localStorage.removeItem('devServerDir');
    localStorage.setItem('lithium-restore-token', restoreToken);
  }
  for (const key of Object.keys(legacy)) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(preferences)) if (value !== null) localStorage.setItem(key, value);
  if (config.currentDir) localStorage.setItem('currentDir', config.currentDir); else localStorage.removeItem('currentDir');
  if (layout?.layout) {
    localStorage.setItem('layoutState', JSON.stringify(layout.layout)); localStorage.setItem('focusedPaneId', layout.focusedPaneId || '');
  } else { localStorage.removeItem('layoutState'); localStorage.removeItem('focusedPaneId'); }
  window.addEventListener('beforeunload', flush);
}
function setItem(key, value) {
  localStorage.setItem(key, value);
  if (preferenceKey(key)) { pending.set(key, String(value)); clearTimeout(timer); timer = setTimeout(flush, 200); }
}
function removeItem(key) {
  localStorage.removeItem(key);
  if (preferenceKey(key)) { pending.set(key, null); flush(); }
}
module.exports = { initialize, flush, setItem, removeItem, getItem: key => localStorage.getItem(key) };
