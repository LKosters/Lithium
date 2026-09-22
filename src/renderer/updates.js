const { ipcRenderer } = require('electron');
const preferences = require('./preferences');
const $ = selector => document.querySelector(selector);
let state = { status: 'idle', message: 'Check for a new version of Lithium.' };
let dismissed = null;
function render(next) {
  state = next;
  const working = ['checking', 'downloading', 'installing'].includes(state.status);
  const available = state.status === 'available' || state.status === 'ready';
  const manual = !!state.manualReason;
  const action = state.status === 'ready' ? 'Restart and install' : manual ? 'View release' : 'Download update';
  $('#update-status').textContent = state.message || state.error || '';
  $('#btn-check-update').disabled = working || state.status === 'ready';
  $('#btn-check-update').textContent = state.status === 'checking' ? 'Checking…' : 'Check for Updates';
  for (const button of [$('#btn-download-update'), $('#btn-toast-update')]) {
    button.textContent = state.status === 'downloading' ? `Downloading ${state.percent}%` : state.status === 'installing' ? 'Installing…' : action;
    button.disabled = working;
  }
  $('#btn-download-update').classList.toggle('hidden', !available && !['downloading', 'installing'].includes(state.status));
  $('#update-toast-version').textContent = state.error || (state.status === 'ready' ? `v${state.latestVersion} downloaded · restart when ready` : state.status === 'downloading' ? `Downloading v${state.latestVersion} · ${state.percent}%` : state.status === 'installing' ? 'Saving your work and installing…' : `v${state.latestVersion} is available`);
  const showToast = available || ['downloading', 'installing'].includes(state.status);
  $('#update-toast').classList.toggle('hidden', !showToast || dismissed === `${state.latestVersion}:${state.status}`);
  $('#btn-toast-dismiss').disabled = state.status === 'installing';
}
async function invoke(channel) {
  try { const result = await ipcRenderer.invoke(channel); if (result) render(result); }
  catch (error) { render({ ...state, status: 'error', error: error.message, message: error.message }); }
}
function initialize() {
  ipcRenderer.on('updater:state', (_event, next) => render(next));
  ipcRenderer.on('updater:flush', (_event, token) => {
    preferences.flush();
    document.body.inert = true;
    ipcRenderer.send('updater:flushed', token);
  });
  ipcRenderer.on('updater:resume', () => { document.body.inert = false; });
  $('#btn-check-update').addEventListener('click', () => invoke('updater:check'));
  const action = () => {
    if (state.status === 'ready') { preferences.flush(); return invoke('updater:install'); }
    if (state.manualReason) return ipcRenderer.invoke('updater:open-release');
    return invoke('updater:download');
  };
  $('#btn-download-update').addEventListener('click', action);
  $('#btn-toast-update').addEventListener('click', action);
  $('#btn-toast-dismiss').addEventListener('click', () => { dismissed = `${state.latestVersion}:${state.status}`; render(state); });
  ipcRenderer.invoke('updater:get-version').then(version => { $('#about-version').textContent = version; }).catch(() => {});
  invoke('updater:state');
}
async function onAppReady() {
  ipcRenderer.send('updater:healthy');
  // Let restore/install results remain visible; check normal startup in the background.
  const current = await ipcRenderer.invoke('updater:state');
  if (current.status === 'idle') await invoke('updater:check');
  else if (current.status === 'current') setTimeout(() => invoke('updater:check'), 15000);
}
module.exports = { initialize, onAppReady };
