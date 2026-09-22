const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JSDOM } = require('jsdom');
function evaluate(file, dependencies) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(file, 'utf8'))(name => name in dependencies ? dependencies[name] : require(name), module, module.exports, path.dirname(file));
  return module.exports;
}

test('About and toast share download/restart state; window flush is acknowledged and can recover', async t => {
  const dom = new JSDOM('<span id="about-version"></span><span id="update-status"></span><button id="btn-check-update"></button><button id="btn-download-update"></button><div id="update-toast"><span id="update-toast-version"></span><button id="btn-toast-update"></button><button id="btn-toast-dismiss"></button></div>');
  const previous = global.document; global.document = dom.window.document;
  t.after(() => { dom.window.close(); previous === undefined ? delete global.document : global.document = previous; });
  const ipc = new EventEmitter(), calls = [], sent = []; let flushed = 0;
  let state = { status: 'idle', message: 'Ready' };
  ipc.invoke = async channel => {
    calls.push(channel);
    if (channel === 'updater:get-version') return '1.0.0';
    if (channel === 'updater:download') state = { status: 'ready', latestVersion: '1.1.0', message: 'Restart when ready' };
    return state;
  };
  ipc.send = (...args) => sent.push(args);
  const ui = evaluate(path.join(__dirname, '../src/renderer/updates.js'), { electron: { ipcRenderer: ipc }, './preferences': { flush: () => flushed++ } });
  const tick = () => new Promise(r => setImmediate(r));
  ui.initialize(); await tick();
  ipc.emit('updater:state', {}, { status: 'available', latestVersion: '1.1.0', message: 'Available' });
  assert.equal(document.querySelector('#btn-download-update').textContent, 'Download update');
  document.querySelector('#btn-toast-update').click(); await tick();
  assert.equal(document.querySelector('#btn-download-update').textContent, 'Restart and install');
  assert.equal(calls.includes('updater:install'), false);
  document.querySelector('#btn-download-update').click(); await tick();
  assert.equal(calls.at(-1), 'updater:install');
  ipc.emit('updater:flush', {}, 'token'); assert.equal(document.body.inert, true); assert.ok(flushed >= 2);
  assert.deepEqual(sent.at(-1), ['updater:flushed', 'token']);
  ipc.emit('updater:resume'); assert.equal(document.body.inert, false);
  assert.equal(ipc.listenerCount('updater:state'), 1);
});

test('install waits for draft/chat persistence and a database backup; save failure leaves the app running', { skip: process.platform !== 'darwin' }, async t => {
  for (const failSave of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lithium-update-control-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ipc = new EventEmitter(), handlers = new Map(), events = [], runtime = { owner: {}, adapter: { stop: async () => events.push('adapter-stop') } };
    ipc.handle = (name, handler) => handlers.set(name, handler);
    const wc = { id: 1, isDestroyed: () => false, send(channel, input) {
      if (channel === 'updater:flush') { events.push('draft-flush'); ipc.emit('updater:flushed', { sender: wc }, input); }
      if (channel === 'updater:resume') events.push('resume');
    } };
    const service = { sessions: new Map([['chat', runtime]]), paused: false, stop: async () => events.push('chat-stop'), flush() { events.push('chat-flush'); if (failSave) throw Error('Disk full'); } };
    const app = { isPackaged: true, getVersion: () => '1.0.0', whenReady: () => Promise.resolve(), exit: () => events.push('exit') };
    const module = evaluate(path.join(__dirname, '../src/main/updater.js'), {
      electron: { ipcMain: ipc, app, shell: {}, BrowserWindow: { getAllWindows: () => [{ webContents: wc }] } },
      './database': { DATA_DIR: root, getDatabase: () => ({ db: { backup: async file => { events.push('database-backup'); fs.writeFileSync(file, 'backup'); } } }) },
      './update/release': { RELEASES_URL: 'https://github.com/lkosters/lithium/releases', latestRelease: async () => ({ latestVersion: '1.1.0', updateAvailable: true, asset: {} }), download: async (_a, folder) => { fs.mkdirSync(folder, { recursive: true }); return path.join(folder, 'update.zip'); }, verifyFile: async () => {} },
      './update/mac': { installationPath: () => '/Applications/Lithium.app', prepareMac: async (_a, _b, _c, dir) => ({ token: 'test', staged: path.join(dir, 'staged.app') }), startHelper: async () => { events.push('helper-ready'); return { kill() {} }; } },
      './maintenance': { acquire: () => () => events.push('unlock') }, './chat': { service },
      './pty': { ptyProcesses: new Map(), killSession() {} }, './dev-server': { killDevServer() {} }, './browser-bridge': { stopBrowserBridge() {} },
    });
    module.registerUpdaterHandlers();
    await handlers.get('updater:check')(); await handlers.get('updater:download')();
    const result = await handlers.get('updater:install')();
    if (failSave) { assert.match(result.error, /Disk full/); assert.equal(events.includes('helper-ready'), false); assert.equal(events.includes('exit'), false); assert.equal(service.paused, false); assert.equal(events.at(-1), 'resume'); }
    else assert.deepEqual(events, ['draft-flush', 'chat-stop', 'adapter-stop', 'chat-flush', 'database-backup', 'helper-ready', 'exit']);
  }
});
