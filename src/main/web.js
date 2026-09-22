const fs = require('fs');
const path = require('path');
const { ipcMain, dispatch } = require('./ipc');
const { WebServer } = require('./web-server');
const { loadConfig, saveConfig, addRecentDir, isValidSessionId } = require('./config');
const { service } = require('./chat');
const { ptyProcesses, killSession } = require('./pty');
const { isRestoring } = require('./data');
const webServer = new WebServer({
  dispatch,
  pickDirectory(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || !fs.statSync(input).isDirectory()) throw new Error('Enter an existing absolute folder path on the host computer.');
    return { dir: input, recents: addRecentDir(input), starred: loadConfig().starredDirs || [] };
  },
  validate(channel, input, sender) {
    if (isRestoring()) throw new Error('The host is updating or restoring data. Please reconnect when it is ready.');
    const id = channel === 'sessions:delete' ? input : channel === 'sessions:save' ? input?.id : input?.sessionId;
    if (channel.startsWith('pty:') || channel.startsWith('sessions:') && channel !== 'sessions:list') {
      if (!isValidSessionId(id)) throw new Error('Invalid session.');
      const owner = ptyProcesses.get(id)?.webContents || service.sessions.get(id)?.owner;
      if (owner && owner !== sender) throw new Error('This session is open on another device or window. Close it there first.');
    }
    if (channel === 'pty:spawn' && (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || !fs.statSync(input.cwd).isDirectory())) throw new Error('The project folder is missing on the host.');
  },
  async disconnect(sender) {
    await service.closeOwner(sender);
    for (const [id, entry] of ptyProcesses) if (entry.webContents === sender) killSession(id);
  },
});
// Hosting controls deliberately remain desktop-only (absent from the web allowlist).
let pending = Promise.resolve();
function control(fn) {
  const result = pending.then(fn); pending = result.catch(() => {}); return result;
}
ipcMain.handle('web:status', () => webServer.status());
ipcMain.handle('web:start', (_event, { port } = {}) => control(async () => {
  const status = await webServer.start(port);
  saveConfig({ ...loadConfig(), webPort: status.port });
  return status;
}));
ipcMain.handle('web:stop', () => control(() => webServer.stop()));
module.exports = { webServer };
