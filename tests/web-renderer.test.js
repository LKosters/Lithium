const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(require.resolve('../src/index.html'), 'utf8').replace('<script src="renderer.js"></script>', '');
const bundle = () => fs.readFileSync(require.resolve('../src/web/app.bundle.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

for (const linkCode of [null, 'test-code', 'expired-code']) {
test(`browser authenticates with ${linkCode || 'manual login'}, opens settings and creates a chat`, async t => {
  const errors = [], calls = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'http://lithium.test/' + (linkCode ? `#code=${linkCode}` : ''), runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
  window.visualViewport = Object.assign(new window.EventTarget(), { height: window.innerHeight, scale: 1, offsetTop: 0 });
  window.EventSource = class {
    constructor() { setTimeout(() => this.onopen?.(), 0); }
    close() {}
  };
  let authenticated = false;
  window.fetch = async (url, options) => {
    assert.equal(window.location.hash, '', 'access code is removed before network requests');
    const body = options?.body ? JSON.parse(options.body) : null;
    if (url === '/api/auth') return { ok: true, json: async () => ({ authorized: authenticated }) };
    if (url === '/api/login') { authenticated = body.code === 'test-code'; return { ok: authenticated, status: authenticated ? 200 : 401, json: async () => authenticated ? { ok: true } : { error: 'Incorrect access code.' } }; }
    if (url === '/api/connect') return { ok: true, json: async () => ({ id: 'client', home: '/home/test' }) };
    calls.push(body);
    const values = {
      'directory:recents': { recents: ['/tmp/project'], starred: [] },
      'sessions:list': [], 'project:detect-framework': 'react', 'devserver:start-commands': [],
      'config:resolve-projects-dir': '/tmp',
      'chat:defaults:get': { ok: true, value: { provider: 'claude', mode: 'default', model: null, effort: null } },
      'chat:open': { ok: true, value: { id: body.input?.sessionId, settings: { provider: 'claude', mode: 'default' }, entries: [], pending: [], status: 'idle', revision: 0 } },
      'chat:catalog': { ok: true, value: { models: [], modes: [] } },
    };
    return { ok: true, json: async () => ({ value: values[body.channel] ?? null }) };
  };
  window.eval(bundle()); await tick();
  if (linkCode !== 'test-code') {
  assert.ok(window.document.querySelector('#web-login'));
  if (linkCode) assert.match(window.document.querySelector('#web-login [role=status]').textContent, /Incorrect/);
  const code = window.document.querySelector('#web-access-code'); code.value = 'wrong';
  window.document.querySelector('#web-login form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.match(window.document.querySelector('#web-login [role=status]').textContent, /Incorrect/);
  code.value = 'test-code'; window.document.querySelector('#web-login form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  }
  await tick(); await tick();
  assert.equal(window.document.querySelector('#web-login'), null);
  assert.ok(window.document.body.classList.contains('web-client'));
  assert.equal(window.document.documentElement.style.getPropertyValue('--visible-height'), '');
  window.visualViewport.height = 320;
  window.visualViewport.dispatchEvent(new window.Event('resize'));
  assert.equal(window.document.documentElement.style.getPropertyValue('--visible-height'), '320px');
  window.visualViewport.height = window.innerHeight;
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(window.document.documentElement.style.getPropertyValue('--visible-height'), '', 'normal resizing uses dynamic viewport height');
  const nav = window.document.querySelector('#navigation-toggle');
  const tab = name => window.document.querySelector(`#mobile-tab-bar [data-mobile-screen="${name}"]`);
  tab('projects').click();
  assert.equal(window.document.body.dataset.mobileScreen, 'projects');
  assert.equal(window.document.querySelector('#sidebar').inert, false);
  tab('settings').click();
  assert.equal(window.document.body.dataset.mobileScreen, 'settings');
  window.document.querySelector('[data-settings-tab=appearance]').click();
  assert.ok(window.document.querySelector('#settings-overlay').classList.contains('settings-detail-open'));
  window.document.querySelector('.settings-detail-back').click();
  assert.ok(!window.document.querySelector('#settings-overlay').classList.contains('settings-detail-open'));
  tab('chats').click();
  assert.equal(window.document.body.dataset.mobileScreen, 'chats');
  assert.equal(window.document.querySelector('[data-settings-tab=data]').hidden, true);
  window.document.querySelector('#btn-settings').click();
  window.document.querySelector('[data-settings-tab=web]').click(); await tick();
  assert.match(window.document.querySelector('[data-web-status]').textContent, /Manage web access in the desktop app/);
  assert.equal(window.document.querySelector('[data-web-toggle]').disabled, true);
  assert.ok(calls.some(call => call.channel === 'sessions:list'));
  assert.ok(!calls.some(call => call.channel.startsWith('updater:')));
  window.document.querySelector('#btn-settings-back').click();
  window.document.querySelector('[data-project-dir="/tmp/project"]').click();
  window.document.querySelector('#btn-new-session').click();
  await tick(); await tick();
  assert.ok(window.document.querySelector('.chat-input'));
  assert.equal(window.document.body.dataset.mobileScreen, 'conversation');
  assert.equal(window.document.querySelector('#sidebar').inert, true);
  nav.click();
  assert.equal(window.document.body.dataset.mobileScreen, 'chats');
  window.document.querySelector('[data-session-id]').click();
  assert.equal(window.document.body.dataset.mobileScreen, 'conversation');
  const saveIndex = calls.findIndex(call => call.channel === 'sessions:save');
  const openIndex = calls.findIndex(call => call.channel === 'chat:open');
  assert.ok(saveIndex >= 0 && openIndex > saveIndex, 'session persists before chat opens');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'd', code: 'KeyD', metaKey: true, bubbles: true }));
  await tick(); await tick();
  const chooser = window.document.querySelector('#compact-pane-select');
  assert.equal(chooser.options.length, 2);
  assert.equal(chooser.hidden, false);
  chooser.value = chooser.options[0].value;
  chooser.dispatchEvent(new window.Event('change'));
  assert.equal(window.document.querySelectorAll('.pane-container').length, 2, 'compact switching preserves the split layout');
  assert.equal(window.document.querySelectorAll('.pane-container.focused').length, 1);
  assert.deepEqual(errors, []);
});
}
