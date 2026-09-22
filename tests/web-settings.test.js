const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createWebSettings } = require('../src/renderer/web-settings');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for UI update.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('desktop web settings show saved port, connection addresses and recover after start failure', async t => {
  const QRCode = require('qrcode');
  const generate = t.mock.method(QRCode, 'toDataURL');
  const dom = new JSDOM('<div id="settings"><nav class="settings-nav"></nav><main class="settings-main"></main></div>');
  const previous = global.document; global.document = dom.window.document;
  t.after(() => { global.document = previous; dom.window.close(); });
  const calls = [];
  let fail = true;
  const ui = createWebSettings({ async invoke(channel, input) {
    calls.push({ channel, input });
    if (channel === 'config:get') return 4567;
    if (channel === 'web:start' && fail) throw new Error('Port is already in use.');
    return { running: channel === 'web:start', port: input?.port || 3210, addresses: channel === 'web:start' ? [{ label: 'Tailscale', url: 'http://100.100.1.2:4567' }] : [], code: channel === 'web:start' ? 'test-code' : null };
  } }, document.querySelector('#settings'));
  await ui.load();
  const button = document.querySelector('[data-web-toggle]');
  assert.equal(document.querySelector('#web-port').value, '4567');
  button.click(); await tick();
  assert.match(document.querySelector('[data-web-status]').textContent, /already in use/);
  assert.equal(button.disabled, false);
  fail = false; button.click(); await tick();
  assert.equal(document.querySelector('#web-port').disabled, true);
  assert.equal(document.querySelector('[data-web-code]').value, 'test-code');
  assert.match(document.querySelector('[data-web-addresses]').textContent, /Tailscale/);
  assert.equal(button.textContent, 'Stop web version');
  const qrToggle = document.querySelector('.web-qr-toggle');
  qrToggle.click(); await tick();
  assert.equal(qrToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(qrToggle.textContent, 'Hide QR');
  await waitFor(() => document.querySelector('.web-address-qr img').src);
  assert.equal(generate.mock.calls[0].arguments[0], 'http://100.100.1.2:4567/#code=test-code');
  assert.match(document.querySelector('.web-address-qr img').src, /^data:image\/png;base64,/);
  qrToggle.click();
  assert.equal(qrToggle.getAttribute('aria-expanded'), 'false');
  assert.ok(document.querySelector('.web-address-qr').classList.contains('hidden'));
  button.click(); await tick();
  assert.equal(calls.at(-1).channel, 'web:stop');
  assert.equal(document.querySelector('[data-web-code]').value, '');
  assert.ok(document.querySelector('[data-web-details]').classList.contains('hidden'));
});
