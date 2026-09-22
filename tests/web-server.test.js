const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { WebServer, addresses } = require('../src/main/web-server');
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
test('web access requires authentication, isolates clients, streams events and revokes access on stop', async t => {
  const calls = [], disconnected = [];
  const server = new WebServer({ dispatch: async (kind, channel, sender, input) => {
    calls.push({ kind, channel, sender, input });
    if (channel === 'chat:send') sender.send('chat:event', { text: 'streamed' });
    return ['session'];
  }, disconnect: async sender => { disconnected.push(sender.id); }, pickDirectory: async dir => ({ dir }) });
  t.after(() => server.stop());
  const port = await freePort(); await server.start(port);
  const origin = `http://127.0.0.1:${port}`;
  let cookie;
  async function post(route, body, extra = {}) {
    return fetch(origin + route, { method: 'POST', headers: { Connection: 'close', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) });
  }
  assert.equal((await post('/api/connect', {})).status, 401);
  assert.equal((await post('/api/login', { code: 'wrong' })).status, 401);
  assert.equal((await post('/api/login', { code: server.code }, { Origin: 'http://evil.test' })).status, 403);
  const login = await post('/api/login', { code: server.code }); assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const client = await (await post('/api/connect', {})).json();
  assert.equal((await (await post('/api/connect', { previous: client.id })).json()).id, client.id);
  const rpc = `/api/rpc?client=${client.id}`;
  assert.equal((await post(rpc, { kind: 'invoke', channel: 'web:stop' })).status, 403);
  assert.equal((await post(rpc, { kind: 'invoke', channel: 'config:get', input: 'secrets' })).status, 403);
  assert.equal((await post(rpc, { kind: 'invoke', channel: 'data:import' })).status, 403);
  assert.equal((await post(rpc, { kind: 'invoke', channel: 'sessions:list' }, { Origin: 'null' })).status, 403);
  assert.deepEqual(await (await post(rpc, { kind: 'invoke', channel: 'sessions:list' })).json(), { value: ['session'] });
  const abort = new AbortController();
  const events = await fetch(origin + `/api/events?client=${client.id}`, { headers: { Cookie: cookie }, signal: abort.signal });
  const reader = events.body.getReader(); await reader.read();
  await post(rpc, { kind: 'invoke', channel: 'chat:send', input: { text: 'hello' } });
  assert.match(new TextDecoder().decode((await reader.read()).value), /streamed/);
  assert.equal(calls[1].sender.isWebClient, true);
  assert.equal((await fetch(origin + '/src/main/config.js')).status, 404);
  assert.equal((await fetch(origin + '/styles/../../main.js')).status, 404);
  assert.equal((await fetch(origin + '/renderer.js')).status, 200);
  assert.match(await (await fetch(origin)).text(), /web.css/);
  const secondLogin = await post('/api/login', { code: server.code });
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await post(rpc, { kind: 'invoke', channel: 'sessions:list' }, { Cookie: secondCookie })).status, 409);
  const oldCode = server.code;
  abort.abort(); await server.stop();
  assert.deepEqual(disconnected, [client.id]);
  assert.equal(calls[0].sender.isDestroyed(), true);
  await server.start(port);
  assert.notEqual(server.code, oldCode);
  assert.equal((await post('/api/connect', {})).status, 401);
  assert.equal((await post('/api/login', { code: oldCode })).status, 401);
});
test('web host reports port conflicts and validates ports; network addresses include Tailscale', async t => {
  const first = new WebServer(), second = new WebServer();
  t.after(async () => { await first.stop(); await second.stop(); });
  await assert.rejects(first.start(80), /port/);
  const port = await freePort(); await first.start(port);
  await assert.rejects(second.start(port), /EADDRINUSE/);
  assert.equal(second.status().running, false);
  assert.equal(second.status().code, null);
  assert.deepEqual(addresses(3210, { en0: [{ family: 'IPv4', address: '192.168.1.5' }], utun: [{ family: 'IPv4', address: '100.100.1.2' }, { family: 'IPv6', address: '::1' }] }).map(a => a.label), ['This computer', 'Local network', 'Tailscale']);
});
