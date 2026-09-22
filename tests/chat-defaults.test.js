const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ChatService } = require('../src/main/chat/service');
const { ChatStore } = require('../src/main/chat/store');
const { DEFAULT_CHAT_SETTINGS, chatDefaults } = require('../src/shared/chat-options');

test('new chats snapshot defaults; existing and reopened empty chats retain their policy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lithium-defaults-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let defaults = { provider: 'codex', model: 'test-model', effort: 'high', permissionMode: 'fullAccess' };
  const service = new ChatService({ store: new ChatStore(root), getDefaults: () => defaults });
  const owner = { isDestroyed: () => false, send() {} };
  const session = id => ({ id, directory: root });
  const first = service.open(session('first'), owner);
  assert.deepEqual(first.settings, defaults);
  defaults = { ...DEFAULT_CHAT_SETTINGS, permissionMode: 'plan' };
  assert.equal(service.open(session('first'), owner).settings.permissionMode, 'fullAccess');
  const second = service.open(session('second'), owner);
  assert.deepEqual(second.settings, defaults);
  await service.close('first', owner);
  const restored = new ChatService({ store: new ChatStore(root), getDefaults: () => defaults });
  assert.equal(restored.open(session('first'), owner).settings.permissionMode, 'fullAccess');
  defaults = { provider: 'claude', permissionMode: 'fullAccess' };
  assert.deepEqual(service.open(session('invalid'), owner).settings, DEFAULT_CHAT_SETTINGS);
  assert.deepEqual(chatDefaults(null), DEFAULT_CHAT_SETTINGS);
});

test('defaults UI handles provider catalog races, effort choices, explicit saving and offline saved models', async t => {
  const dom = new JSDOM('<div id="settings-overlay"><nav class="settings-nav"><button data-settings-tab="appearance"></button></nav><div class="settings-main"></div></div>');
  const original = global.document; global.document = dom.window.document;
  t.after(() => { dom.window.close(); if (original === undefined) delete global.document; else global.document = original; });
  const catalogs = [], saves = [];
  const stored = { provider: 'claude', model: 'saved-model', effort: 'high', permissionMode: 'plan' };
  const ipc = { invoke: async (channel, input) => {
    if (channel === 'chat:defaults:get') return { ok: true, value: { ...stored } };
    if (channel === 'chat:defaults:catalog') return new Promise(resolve => catalogs.push({ provider: input.provider, resolve }));
    if (channel === 'chat:defaults:set') { saves.push(input); return { ok: true, value: input }; }
    throw new Error(channel);
  } };
  const overlay = document.querySelector('#settings-overlay');
  const ui = require('../src/renderer/chat-settings').createChatSettings(ipc, overlay);
  const field = name => overlay.querySelector(`[name="${name}"]`);
  const change = (name, value) => { field(name).value = value; field(name).dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await ui.load();
  assert.equal(field('model').value, 'saved-model');
  change('provider', 'codex');
  catalogs[1].resolve({ ok: true, value: { account: 'ChatGPT', models: [{ id: 'codex-test', label: 'Codex test', efforts: ['low', 'high'] }] } });
  await tick();
  catalogs[0].resolve({ ok: true, value: { account: 'Stale Claude result', models: [{ id: 'wrong', label: 'Wrong' }] } });
  await tick();
  assert.equal(field('model').querySelector('[value="wrong"]'), null);
  change('model', 'codex-test'); change('effort', 'high'); change('permissionMode', 'auto');
  assert.equal(saves.length, 0);
  overlay.querySelector('[data-save]').click(); await tick();
  assert.deepEqual(saves[0], { provider: 'codex', model: 'codex-test', effort: 'high', permissionMode: 'auto' });
  assert.match(overlay.querySelector('[data-status]').textContent, /Saved/);
  change('model', ''); assert.equal(field('effort').value, ''); assert.equal(field('effort').disabled, true);
  change('provider', 'claude');
  catalogs[2].resolve({ ok: false, error: 'Offline' }); await tick();
  assert.equal(field('model').value, 'saved-model');
  assert.equal(field('permissionMode').value, 'plan');
  assert.match(overlay.querySelector('[data-connection]').textContent, /Offline/);
});
