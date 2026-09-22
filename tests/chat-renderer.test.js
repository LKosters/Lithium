const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { JSDOM } = require('jsdom');

test('chat renders safely, preserves pending answers, switches native modes, and blocks duplicate sends', async t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://lithium.test', pretendToBeVisual: true });
  const original = {};
  let pane;
  for (const key of ['window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'FileReader']) {
    original[key] = global[key]; global[key] = typeof dom.window[key] === 'function' && /AnimationFrame/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
  }
  t.after(() => { pane?.dispose(); dom.window.close(); for (const [key, value] of Object.entries(original)) value === undefined ? delete global[key] : global[key] = value; });
  const { renderMarkdown } = require('../src/renderer/chat-markdown');
  const safe = document.createElement('div');
  safe.innerHTML = renderMarkdown('<script>require("fs").writeFileSync("bad", "bad")</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](https://example.org/track.png)\n\n```js\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.equal(safe.querySelector('script,iframe,img,[onerror]'), null);
  assert.equal([...safe.querySelectorAll('a')].some(a => a.protocol === 'javascript:'), false);
  assert.ok(safe.querySelector('pre code .hljs-keyword'));
  assert.ok(safe.querySelector('table'));

  const app = require('../src/renderer/app');
  const ipc = new EventEmitter();
  const calls = [];
  let snapshot = { id: 'ui-test', revision: 0, settings: { provider: 'claude', model: '', effort: '', permissionMode: 'default' }, entries: [], pending: [], status: 'idle' };
  ipc.invoke = async (channel, input) => {
    calls.push({ channel, input });
    if (channel === 'chat:open') return { ok: true, value: structuredClone(snapshot) };
    if (channel === 'chat:catalog') return { ok: true, value: { connected: true, account: 'Claude test subscription', models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'high'] }] } };
    if (channel === 'chat:configure') { snapshot.settings = input.settings; return { ok: true, value: structuredClone(snapshot) }; }
    return { ok: true, value: {} };
  };
  ipc.send = () => {};
  app.ipcRenderer = ipc; app.renderSessionList = () => {}; app.refreshLayout = () => {};
  const { createChatPane } = require('../src/renderer/chat');
  pane = createChatPane({ id: 'ui-test', title: 'Test', directory: '/tmp' });
  document.body.appendChild(pane.paneEl);
  const waitFrame = () => new Promise(resolve => setTimeout(resolve, 35));
  await waitFrame();
  const $ = s => pane.paneEl.querySelector(s);
  assert.match($('.chat-account-label').textContent, /subscription/);
  $('[data-menu="permission"]').click();
  $('[data-option="auto"]').click(); await waitFrame();
  assert.equal(calls.find(c => c.channel === 'chat:configure').input.settings.permissionMode, 'auto');
  let revision = 0;
  const emit = event => ipc.emit('chat:event', {}, { sessionId: 'ui-test', revision: ++revision, ...event });
  emit({ type: 'entry', entry: { id: 'answer', kind: 'assistant', text: '**Working**\n\n```js\nconst x = 1;\n```', createdAt: Date.now() } });
  await waitFrame();
  assert.ok($('.chat-entry-body strong'));
  assert.ok($('.chat-code-copy'));
  emit({ type: 'request', request: { id: 'question', kind: 'question', title: 'Choose', description: 'Your input', questions: [{ id: 'q', question: 'Name?', options: [{ label: '" autofocus onfocus="alert(1)', description: '<script>bad</script>' }] }] } });
  assert.equal(pane.paneEl.querySelector('[onfocus], [autofocus], script'), null);
  $('.chat-answer-text').value = 'Keep my input';
  emit({ type: 'request', request: { id: 'approval', kind: 'approval', title: 'Run command', description: 'Approve?', details: 'ls' } });
  assert.equal($('.chat-answer-text').value, 'Keep my input');
  emit({ type: 'resolved', id: 'approval', decision: 'deny' });
  assert.equal($('.chat-answer-text').value, 'Keep my input');
  emit({ type: 'resolved', id: 'question', decision: 'allow' });
  $('.chat-input').value = 'Hello'; $('.chat-input').dispatchEvent(new dom.window.Event('input'));
  $('.chat-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  $('.chat-input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFrame();
  assert.equal(calls.filter(c => c.channel === 'chat:send').length, 1);
  assert.equal($('.chat-send').getAttribute('aria-label'), 'Stop response');
  assert.equal($('[data-menu="permission"]').disabled, true);
  $('.chat-send').click(); await waitFrame();
  assert.equal(calls.filter(c => c.channel === 'chat:stop').length, 1);
});
