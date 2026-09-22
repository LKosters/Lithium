const fs = require('fs');
const path = require('path');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const { getDatabase } = require('./database');
const { writeBackup, readBackup, restoreBackup } = require('./backup');
const { validPreference } = require('../shared/preferences');
const { service } = require('./chat');
const maintenance = require('./maintenance');
let busy = false;
let restoring = false;
const isRestoring = () => restoring || maintenance.isBusy();
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, input) => {
    try { return { ok: true, value: await fn(event, input) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
ipcMain.on('preferences:bootstrap', (event, legacy) => {
  try {
    const db = getDatabase();
    if (!db.get('preferencesMigrated')) {
      const preferences = {};
      for (const [key, value] of Object.entries(legacy || {})) if (validPreference(key, value)) preferences[key] = value;
      db.db.transaction(() => { db.set('preferences', preferences); db.set('preferencesMigrated', true); })();
    }
    event.returnValue = { ok: true, value: { preferences: db.get('preferences', {}), config: db.get('config', {}), layout: db.get('layout'), restoreToken: db.get('restoreToken') } };
  } catch (error) { event.returnValue = { ok: false, error: error.message }; }
});
ipcMain.on('preferences:set', (_event, { key, value }) => {
  if (restoring || !validPreference(key, value)) return;
  const db = getDatabase(), preferences = db.get('preferences', {});
  if (value === null) delete preferences[key]; else preferences[key] = value;
  db.set('preferences', preferences);
});
handle('data:info', () => {
  const db = getDatabase();
  return { file: db.file, sessions: db.db.prepare('SELECT count(*) AS n FROM sessions').get().n, chats: db.db.prepare('SELECT count(*) AS n FROM chats').get().n, messages: db.db.prepare('SELECT count(*) AS n FROM messages').get().n };
});
handle('data:export', async e => {
  if (busy || maintenance.isBusy()) throw new Error('Another backup or update operation is already in progress.');
  busy = true;
  try {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Export Lithium data', defaultPath: `Lithium-${new Date().toISOString().slice(0, 10)}.lithium-backup.json`, filters: [{ name: 'Lithium backup', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    for (const runtime of service.sessions.values()) service.flush(runtime);
    const db = getDatabase();
    // A user-selected destination must not replace the active database or its sidecars.
    if ([db.file, `${db.file}-wal`, `${db.file}-shm`].includes(path.resolve(result.filePath))) throw new Error('Choose a different export location.');
    writeBackup(db, result.filePath);
    return { file: result.filePath };
  } finally { busy = false; }
});
handle('data:import', async e => {
  let releaseMaintenance;
  if (busy || maintenance.isBusy()) throw new Error('Another backup or update operation is already in progress.');
  busy = true;
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    const pick = await dialog.showOpenDialog(win, { title: 'Import Lithium backup', properties: ['openFile'], filters: [{ name: 'Lithium backup', extensions: ['json'] }] });
    if (pick.canceled) return { canceled: true };
    const backup = readBackup(pick.filePaths[0]);
    const missing = new Set(backup.data.sessions.map(s => s.directory).filter(dir => !fs.existsSync(dir))).size;
    const confirm = await dialog.showMessageBox(win, { type: 'warning', title: 'Restore Lithium backup', message: `Restore ${backup.data.sessions.length} sessions and ${backup.data.chats.length} chats?`, detail: `This replaces your current Lithium chats, sessions and app settings. Active agents will stop and Lithium will restart. A recovery backup of your current data is saved first.\n\nProject files and provider logins are not changed.${missing ? `\n\n${missing} project folder(s) are missing on this computer. Their history is retained, but continuing those chats requires the original folder.` : ''}`, buttons: ['Cancel', 'Restore and restart'], defaultId: 0, cancelId: 0 });
    if (confirm.response !== 1) return { canceled: true };
    releaseMaintenance = maintenance.acquire('a backup restore');
    restoring = true; service.paused = true;
    for (const [id, runtime] of service.sessions) { await service.stop(id, runtime.owner); await runtime.adapter?.stop?.(); service.flush(runtime); }
    const db = getDatabase(), recoveryDir = path.join(db.root, 'backups');
    fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    const recovery = path.join(recoveryDir, `before-import-${Date.now()}.lithium-backup.json`);
    writeBackup(db, recovery); // A failed recovery backup prevents all replacement.
    const { ptyProcesses, killSession } = require('./pty');
    for (const id of ptyProcesses.keys()) killSession(id);
    require('./dev-server').killDevServer();
    require('./browser-bridge').stopBrowserBridge();
    restoreBackup(db, backup);
    service.sessions.clear(); // Never flush pre-import runtime state over restored records.
    try { app.relaunch(); } finally { app.exit(0); }
    return { recovery };
  } finally { restoring = false; if (releaseMaintenance) service.paused = false; busy = false; releaseMaintenance?.(); }
});
module.exports = { isRestoring };
