const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('SQLite preferences replace stale mirrors after restore and persist new drafts', t => {
  const dom = new JSDOM('', { url: 'https://lithium.test' });
  const old = { window: global.window, localStorage: global.localStorage };
  global.window = dom.window; global.localStorage = dom.window.localStorage;
  const key = require.resolve('../src/renderer/preferences'); delete require.cache[key];
  const prefs = require(key);
  t.after(() => { prefs.flush(); dom.window.close(); delete require.cache[key]; for (const [key, value] of Object.entries(old)) value === undefined ? delete global[key] : global[key] = value; });
  localStorage.setItem('playerMode', 'full'); localStorage.setItem('lithium-chat-draft-old', 'Old');
  localStorage.setItem('devServerRunning', '1'); localStorage.setItem('layoutState', 'stale'); localStorage.setItem('currentDir', '/old');
  const writes = [];
  prefs.initialize({ sendSync(channel, legacy) {
    assert.equal(channel, 'preferences:bootstrap'); assert.equal(legacy.playerMode, 'full');
    return { ok: true, value: { preferences: { playerMode: 'compact', 'lithium-chat-draft-chat': 'Restored' }, config: { currentDir: '/new' }, layout: null, restoreToken: 'restore-1' } };
  }, send(channel, value) { writes.push({ channel, value }); } });
  assert.equal(localStorage.getItem('playerMode'), 'compact'); assert.equal(localStorage.getItem('lithium-chat-draft-old'), null);
  assert.equal(localStorage.getItem('lithium-chat-draft-chat'), 'Restored'); assert.equal(localStorage.getItem('devServerRunning'), null);
  assert.equal(localStorage.getItem('layoutState'), null); assert.equal(localStorage.getItem('currentDir'), '/new');
  prefs.setItem('lithium-chat-draft-chat', 'New draft'); prefs.flush();
  assert.deepEqual(writes[0], { channel: 'preferences:set', value: { key: 'lithium-chat-draft-chat', value: 'New draft' } });
  prefs.removeItem('lithium-chat-draft-chat'); assert.equal(writes.at(-1).value.value, null);
});
