const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, BrowserWindow, shell } = require('electron');
const { ChatService } = require('./chat/service');
const { loadAllSessions, loadConfig, saveConfig } = require('./config');
const { chatDefaults, validateSettings } = require('../shared/chat-options');
const service = new ChatService({ getDefaults: () => loadConfig().chatDefaults });

function session(id) {
  const s = loadAllSessions().find(s => s.id === id && s.mode === 'chat');
  if (!s || typeof s.directory !== 'string') throw new Error('Chat session is missing.');
  return s;
}
// Return explicit errors instead of Electron's lossy invoke error serialization.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, input) => {
    try { return { ok: true, value: await fn(event, input) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
handle('chat:defaults:get', () => chatDefaults(loadConfig().chatDefaults));
handle('chat:defaults:set', (_e, settings) => {
  const value = validateSettings(settings);
  saveConfig({ ...loadConfig(), chatDefaults: value });
  return value;
});
handle('chat:defaults:catalog', (_e, { provider }) => {
  if (!['claude', 'codex'].includes(provider)) throw new Error('Unknown provider.');
  return require(`./chat/${provider}`).catalog(require('os').homedir());
});
handle('chat:open', async (e, { sessionId }) => {
  await service.sessions.get(sessionId)?.closing;
  return service.open(session(sessionId), e.sender);
});
handle('chat:configure', (e, { sessionId, settings }) => service.configure(sessionId, e.sender, settings));
handle('chat:send', (e, { sessionId, text, attachments }) => {
  const directory = session(sessionId).directory;
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('The original project folder is missing. Restore it to continue this chat. Your history is still available.');
  return service.send(sessionId, e.sender, text, attachments);
});
handle('chat:stop', (e, { sessionId }) => service.stop(sessionId, e.sender));
handle('chat:close', (e, { sessionId }) => service.close(sessionId, e.sender));
handle('chat:reply', (e, { sessionId, requestId, answer }) => service.reply(sessionId, e.sender, requestId, answer));
handle('chat:catalog', async (e, { sessionId, provider }) => {
  const r = service.get(sessionId, e.sender);
  if (!['claude', 'codex'].includes(provider)) throw new Error('Unknown provider.');
  return require(`./chat/${provider}`).catalog(r.directory);
});
handle('chat:pick-images', async e => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
  if (result.canceled) return [];
  if (result.filePaths.length > 4) throw new Error('Attach up to four images.');
  return result.filePaths.map(file => {
    if (fs.statSync(file).size > 10 * 1024 * 1024) throw new Error('Each image must be smaller than 10 MB.');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(file).toLowerCase()];
    if (!mime) throw new Error('Unsupported image.');
    return { name: path.basename(file), mime, dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` };
  });
});
handle('chat:open-link', (_e, { url }) => {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only web links can be opened.');
  return shell.openExternal(parsed.href);
});
module.exports = { service };
