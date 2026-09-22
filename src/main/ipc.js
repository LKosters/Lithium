// Keep native IPC registration and web dispatch on the same implementations.
const { ipcMain: native } = require('electron');
const handlers = new Map();
const listeners = new Map();
const ipcMain = {
  handle(channel, fn) { handlers.set(channel, fn); native.handle(channel, fn); },
  on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel).push(fn); native.on(channel, fn);
  },
};
async function dispatch(kind, channel, sender, input) {
  const event = { sender };
  if (kind === 'invoke' && handlers.has(channel)) return handlers.get(channel)(event, input);
  if (kind === 'send' && listeners.has(channel)) {
    for (const fn of listeners.get(channel)) await fn(event, input);
    return null;
  }
  throw new Error('Unsupported web operation.');
}
module.exports = { ipcMain, dispatch };
