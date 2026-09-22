const { ipcMain, shell, app, BrowserWindow } = require('electron');
const fs = require('fs');
const disk = process.versions.electron ? require('original-fs') : fs;
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { DATA_DIR, getDatabase } = require('./database');
const { RELEASES_URL, latestRelease, download, verifyFile } = require('./update/release');
const { prepareMac, startHelper, installationPath } = require('./update/mac');
const maintenance = require('./maintenance');
const { service } = require('./chat');

const updateDir = path.join(DATA_DIR, 'updates');
let release = null, downloaded = null, operation = false;
let state = { status: 'idle', currentVersion: app.getVersion(), latestVersion: null, percent: 0, error: null, message: 'Check for a new version of Lithium.' };
function publish(values) {
  state = { ...state, ...values };
  for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send('updater:state', state);
  return state;
}
function installRestriction() {
  if (!app.isPackaged) return 'In-app installation is available in the installed Lithium app, not in development mode.';
  if (process.platform === 'darwin') {
    try { installationPath(process.execPath); } catch (error) { return error.code === 'EACCES' ? 'Lithium cannot write to its install folder. Move it to a writable Applications folder first.' : error.message; }
    return null;
  }
  if (process.platform === 'win32') return null;
  return 'Use the release page to install the Linux package.';
}
async function check() {
  if (operation || state.status === 'ready') return state;
  operation = true; publish({ status: 'checking', error: null, message: 'Checking for updates…' });
  try {
    release = await latestRelease(app.getVersion(), process.platform, process.arch);
    const manualReason = release.manualReason || installRestriction();
    publish({ status: release.updateAvailable ? 'available' : 'current', latestVersion: release.latestVersion, updateAvailable: release.updateAvailable, manualReason, releaseUrl: release.releaseUrl, message: release.updateAvailable ? `Lithium ${release.latestVersion} is available.${manualReason ? ` ${manualReason}` : ''}` : `You’re on the latest version (${app.getVersion()}).` });
  } catch (error) { publish({ status: 'error', error: error.message, message: error.message }); }
  finally { operation = false; }
  return state;
}
async function downloadUpdate() {
  if (operation) return state;
  if (!release?.asset || !release.updateAvailable || installRestriction()) throw new Error('Check for an installable update first.');
  operation = true; downloaded = null;
  publish({ status: 'downloading', percent: 0, error: null, message: 'Downloading update. You can keep working.' });
  try {
    const folder = path.join(updateDir, `download-${randomUUID()}`);
    downloaded = await download(release.asset, folder, percent => { if (percent !== state.percent) publish({ percent }); });
    publish({ status: 'ready', percent: 100, message: `Lithium ${release.latestVersion} is ready. Restarting will save your chats and stop active agents.` });
  } catch (error) { publish({ status: 'error', error: error.message, message: error.message }); }
  finally { operation = false; }
  return state;
}
const flushWaiters = new Map();
ipcMain.on('updater:flushed', (event, token) => { const pending = flushWaiters.get(token); if (pending?.id === event.sender.id) pending.resolve(); });
async function flushWindows() {
  await Promise.all(BrowserWindow.getAllWindows().map(window => new Promise((resolve, reject) => {
    const wc = window.webContents; if (wc.isDestroyed()) return resolve();
    const token = randomUUID();
    const timer = setTimeout(() => { flushWaiters.delete(token); reject(new Error('A window could not save its draft. The update was not installed.')); }, 5000);
    flushWaiters.set(token, { id: wc.id, resolve: () => { clearTimeout(timer); flushWaiters.delete(token); resolve(); } });
    wc.send('updater:flush', token);
  })));
}
function resumeWindows() { for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send('updater:resume'); }
async function installUpdate() {
  if (operation) return state;
  if (!downloaded || state.status !== 'ready') throw new Error('Download the update before installing it.');
  const restriction = installRestriction(); if (restriction) throw new Error(restriction);
  const releaseMaintenance = maintenance.acquire('an app update');
  operation = true;
  let job, helper, quit = false;
  publish({ status: 'installing', error: null, message: 'Preparing update and saving your work…' });
  try {
    service.paused = true;
    await flushWindows();
    await verifyFile(downloaded, release.asset);
    if (process.platform === 'darwin') job = await prepareMac(downloaded, release.latestVersion, process.execPath, updateDir);
    for (const [id, runtime] of service.sessions) {
      await service.stop(id, runtime.owner); await runtime.adapter?.stop?.(); service.flush(runtime);
    }
    const backups = path.join(DATA_DIR, 'backups'); fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    const databaseBackup = path.join(backups, `before-update-${Date.now()}.sqlite`);
    await getDatabase().db.backup(databaseBackup); fs.chmodSync(databaseBackup, 0o600);
    if (job) {
      const pending = path.join(updateDir, 'pending.json');
      fs.writeFileSync(`${pending}.tmp`, JSON.stringify({ ...job, databaseBackup }), { mode: 0o600 }); fs.renameSync(`${pending}.tmp`, pending);
      helper = await startHelper(job);
    } else {
      const child = spawn(downloaded, [], { detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    }
    service.sessions.clear();
    const { ptyProcesses, killSession } = require('./pty');
    for (const id of ptyProcesses.keys()) killSession(id);
    require('./dev-server').killDevServer(); require('./browser-bridge').stopBrowserBridge();
    quit = true; app.exit(0);
  } catch (error) {
    helper?.kill();
    if (job) disk.rmSync(job.staged, { recursive: true, force: true });
    publish({ status: 'ready', error: error.message, message: `Update not installed: ${error.message}` });
  } finally {
    if (!quit) { service.paused = false; operation = false; releaseMaintenance(); resumeWindows(); }
  }
  return state;
}
function pendingJob() {
  try {
    const job = JSON.parse(fs.readFileSync(path.join(updateDir, 'pending.json'), 'utf8'));
    if (!/^[a-f0-9-]{36}$/.test(job.token)) return null;
    // Only read/write known files below the app-owned update directory.
    job.result = path.join(updateDir, `result-${job.token}`); job.health = path.join(updateDir, `health-${job.token}`);
    return job;
  } catch { return null; }
}
function reportPreviousInstall() {
  const job = pendingJob(); if (!job || !fs.existsSync(job.result)) return;
  const result = fs.readFileSync(job.result, 'utf8').trim();
  if (['succeeded', 'installed', 'installed-unconfirmed'].includes(result) && job.version === app.getVersion()) {
    publish({ status: 'current', message: `Updated to ${app.getVersion()}. The previous app is kept at ${job.previous}.` });
  } else if (result.startsWith('failed') || result === 'rolled-back') {
    publish({ status: 'error', error: result, message: `The previous update did not finish (${result}). Your earlier app is at ${fs.existsSync(job.previous) ? job.previous : job.target}; your database backup is at ${job.databaseBackup}.` });
  }
}
function registerUpdaterHandlers() {
  const handle = (channel, fn) => ipcMain.handle(channel, async () => { try { return await fn(); } catch (error) { return { ...state, error: error.message, message: error.message }; } });
  handle('updater:state', () => state);
  handle('updater:check', check);
  handle('updater:download', downloadUpdate);
  handle('updater:install', installUpdate);
  handle('updater:get-version', () => app.getVersion());
  handle('updater:open-release', () => shell.openExternal(release?.releaseUrl || RELEASES_URL));
  ipcMain.on('updater:healthy', () => {
    const job = pendingJob();
    if (job?.version === app.getVersion() && process.argv.includes(`--lithium-update-token=${job.token}`)) fs.writeFileSync(job.health, 'ready', { mode: 0o600 });
  });
  app.whenReady().then(reportPreviousInstall);
}
module.exports = { registerUpdaterHandlers };
