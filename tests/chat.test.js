const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ChatStore } = require('../src/main/chat/store');
const { ChatService } = require('../src/main/chat/service');
const { JsonRpcProcess } = require('../src/main/chat/process');
const { CodexAdapter } = require('../src/main/chat/codex');
const { ClaudeAdapter } = require('../src/main/chat/claude');
const { codexPolicy, validateSettings } = require('../src/shared/chat-options');

function setup(t, Adapter) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lithium-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  t.after(() => store.db.close());
  const service = new ChatService({ store, adapters: { claude: Adapter, codex: Adapter } });
  const events = [];
  const owner = { isDestroyed: () => false, send: (_channel, event) => events.push(structuredClone(event)) };
  const session = { id: 'test-session', directory: root };
  service.open(session, owner);
  return { store, service, events, owner, session };
}
test('explicit Codex policies never silently turn Auto into Full access', () => {
  assert.equal(codexPolicy('auto').approvalsReviewer, 'auto_review');
  assert.equal(codexPolicy('auto').sandbox, 'workspace-write');
  assert.equal(codexPolicy('workspace').approvalPolicy, 'on-request');
  assert.equal(codexPolicy('readOnly').sandbox, 'read-only');
  assert.equal(codexPolicy('fullAccess').sandbox, 'danger-full-access');
  assert.equal(codexPolicy('fullAccess').approvalPolicy, 'never');
  assert.throws(() => codexPolicy('anything', '/project'));
  assert.throws(() => validateSettings({ provider: 'claude', permissionMode: 'fullAccess', model: '' }));
});
test('approval pauses until explicitly answered, persists transcript and native resume ID', async t => {
  let allowed = false;
  class Adapter {
    constructor(c) { this.c = c; }
    async run() {
      const result = await this.c.ask({ title: 'Run command', kind: 'approval' });
      allowed = result.decision === 'allow';
      this.c.delta('assistant', 'assistant', 'Hello '); this.c.delta('assistant', 'assistant', 'world');
      this.c.update({ nativeId: 'native-session' });
    }
  }
  const { service, owner, events, store, session } = setup(t, Adapter);
  service.send(session.id, owner, 'Hi');
  assert.equal(allowed, false);
  assert.throws(() => service.send(session.id, owner, 'Duplicate'));
  assert.throws(() => service.configure(session.id, owner, { provider: 'claude', model: '', permissionMode: 'bypassPermissions' }));
  const request = events.find(e => e.type === 'request').request;
  assert.throws(() => service.reply(session.id, {}, request.id, { decision: 'allow' }));
  assert.throws(() => service.reply(session.id, owner, request.id, { decision: 'session' }));
  service.reply(session.id, owner, request.id, { decision: 'allow' });
  await service.sessions.get(session.id).task;
  assert.equal(allowed, true);
  assert.equal(store.load(session.id).entries.at(-1).text, 'Hello world');
  assert.equal(store.load(session.id).nativeId, 'native-session');
  await service.close(session.id, owner);
  assert.equal(service.open(session, owner).nativeId, 'native-session');
});
test('stopping denies pending permissions and never reports an interrupted tool as completed', async t => {
  let decision;
  class Adapter {
    constructor(c) { this.c = c; }
    async run() { this.c.entry({ id: 'tool', kind: 'tool', status: 'running' }); decision = await this.c.ask({ kind: 'approval', title: 'Write file' }); }
    async stop() {}
  }
  const { service, owner, session, store, events } = setup(t, Adapter);
  service.send(session.id, owner, 'Work');
  const request = events.find(e => e.type === 'request').request;
  await service.stop(session.id, owner);
  assert.equal(decision.decision, 'deny');
  assert.equal(store.load(session.id).status, 'stopped');
  assert.equal(store.load(session.id).entries.at(-1).status, 'interrupted');
  assert.throws(() => service.reply(session.id, owner, request.id, { decision: 'allow' }));
});
test('corrupt histories are not overwritten and IDs cannot escape the storage directory', t => {
  const { store } = setup(t, class {});
  assert.throws(() => store.load('../outside'));
  store.db.db.prepare('INSERT INTO chats VALUES (?,?)').run('bad', '{invalid');
  assert.throws(() => store.load('bad'));
  assert.equal(store.db.db.prepare('SELECT data FROM chats WHERE id=?').get('bad').data, '{invalid');
});
test('image payloads are stored once outside the streaming transcript and restored with history', t => {
  const { store } = setup(t, class {});
  const dataUrl = 'data:image/png;base64,aW1hZ2U=';
  const doc = { id: 'image-session', settings: { provider: 'claude', model: '', effort: '', permissionMode: 'default' }, entries: [{ id: 'message', kind: 'user', attachments: [{ name: 'test.png', mime: 'image/png', dataUrl }] }] };
  store.save(doc);
  const assetId = doc.entries[0].attachments[0].assetId;
  store.save(doc);
  assert.equal(fs.readdirSync(path.join(store.root, 'images', doc.id)).length, 1);
  assert.equal(JSON.stringify(store.db.loadChat(doc.id)).includes('base64'), false);
  assert.equal(store.load(doc.id).entries[0].attachments[0].dataUrl, dataUrl);
  fs.rmSync(path.join(store.root, 'images', doc.id, assetId));
  assert.equal(store.load(doc.id).entries[0].attachments[0].missing, true);
  store.delete(doc.id);
  assert.equal(fs.existsSync(path.join(store.root, 'images', doc.id)), false);
});
test('JSON-RPC handles split lines, server requests and process termination', async () => {
  const source = `const rl = require('readline').createInterface({input: process.stdin}); rl.on('line', l => { const m=JSON.parse(l); if(m.method==='echo') {const s=JSON.stringify({id:m.id,result:m.params})+'\\n';process.stdout.write(s.slice(0,5));setTimeout(()=>process.stdout.write(s.slice(5)),5);} if(m.method==='die') process.exit(2); });`;
  const rpc = new JsonRpcProcess(process.execPath, ['-e', source]);
  assert.deepEqual(await rpc.request('echo', { value: 'line\nbreak' }), { value: 'line\nbreak' });
  await assert.rejects(rpc.request('die'), /stopped/);
  assert.equal(rpc.pending.size, 0);
  rpc.close();
});
test('Codex resume resets a previous Full access session to freshly resolved native defaults', async () => {
  class Rpc extends EventEmitter {
    constructor() { super(); this.calls = []; }
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native' }, model: 'configured-model', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted', approvalsReviewer: 'user' };
      if (method === 'turn/start') { setImmediate(() => this.emit('notification', { method: 'turn/completed', params: { threadId: 'native', turn: { id: 'turn' } } })); return { turn: { id: 'turn' } }; }
    }
    close() { this.closed = true; }
  }
  const rpc = new Rpc();
  const adapter = new CodexAdapter({ directory: '/project', nativeId: 'native', settings: { permissionMode: 'default', model: '', effort: '' }, update() {}, entry() {} }, { connect: async (_cwd, created) => { created(rpc); return rpc; } });
  await adapter.run('Hello', []);
  const resume = rpc.calls.find(c => c.method === 'thread/resume').params;
  assert.equal(resume.sandbox, 'read-only'); assert.equal(resume.approvalPolicy, 'untrusted');
  const turn = rpc.calls.find(c => c.method === 'turn/start').params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turn.approvalPolicy, 'untrusted');
});
test('unsupported Codex server requests fail closed', async () => {
  let rejected = false, approved = false;
  const adapter = new CodexAdapter({ notice() {}, ask() { approved = true; } });
  adapter.rpc = { reject() { rejected = true; } };
  await adapter.approval({ id: 1, method: 'unknown/permission', params: {} });
  assert.equal(rejected, true); assert.equal(approved, false);
});
test('Codex does not start a turn if native policy differs from the selected mode', async () => {
  let started = false;
  class Rpc extends EventEmitter {
    async request(method) {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'thread/start') return { thread: { id: 'native' }, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' };
      if (method === 'turn/start') started = true;
    }
    close() { this.closed = true; }
  }
  const rpc = new Rpc();
  const adapter = new CodexAdapter({ directory: '/project', settings: { permissionMode: 'readOnly' } }, { connect: async (_cwd, created) => { created(rpc); return rpc; } });
  await assert.rejects(adapter.run('Work', []), /did not accept/);
  assert.equal(started, false);
});
test('Claude streaming snapshots replace deltas without duplicate text or tools', () => {
  const entries = new Map();
  const c = { entry: e => entries.set(e.id, { ...entries.get(e.id), ...e }), delta: (id, kind, delta) => entries.set(id, { id, kind, text: (entries.get(id)?.text || '') + delta }) };
  const a = new ClaudeAdapter(c);
  for (const event of [{ type: 'message_start', message: { id: 'm' } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }]) a.message({ type: 'stream_event', event });
  a.message({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'Hello world' }] } });
  assert.equal(entries.size, 1); assert.equal(entries.get('m-0').text, 'Hello world');
});

test('every Claude mode reaches the native SDK, retains project rules, and honors an explicit denial', async () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
    let options, decision;
    const context = { id: 'session', directory: '/project', settings: { permissionMode: mode, model: '', effort: '' }, update() {}, entry() {}, ask: async () => ({ decision: 'deny' }) };
    const adapter = new ClaudeAdapter(context, {
      account: async () => ({}), executable: () => 'mock-claude',
      sdk: async () => ({ query: input => {
        options = input.options;
        return {
          initializationResult: async () => ({ account: { apiKeySource: 'none' } }), close() {},
          async *[Symbol.asyncIterator]() {
            await input.prompt.next();
            yield { type: 'system', subtype: 'init', session_id: 'native', permissionMode: mode };
            decision = await options.canUseTool('Edit', { file_path: '/project/index.js' }, { signal: new AbortController().signal });
            yield { type: 'result', session_id: 'native', is_error: false };
          },
        };
      } }),
    });
    await adapter.run('Work', []);
    assert.equal(options.permissionMode, mode);
    assert.equal(options.allowDangerouslySkipPermissions, mode === 'bypassPermissions');
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.equal(decision.behavior, 'deny');
  }
});

test('Claude refuses to silently downgrade an unavailable Auto mode', async () => {
  let reachedTools = false;
  const adapter = new ClaudeAdapter({ id: 'session', directory: '/project', settings: { permissionMode: 'auto' }, update() {} }, {
    account: async () => ({}), executable: () => 'mock-claude', sdk: async () => ({ query: input => ({
      initializationResult: async () => ({ account: { apiKeySource: 'none' } }), close() {},
      async *[Symbol.asyncIterator]() {
        await input.prompt.next();
        yield { type: 'system', subtype: 'init', session_id: 'native', permissionMode: 'default' };
        reachedTools = true;
      },
    }) }),
  });
  await assert.rejects(adapter.run('Work', []), /instead of auto/);
  assert.equal(reachedTools, false);
});
