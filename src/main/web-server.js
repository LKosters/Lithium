const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes, timingSafeEqual } = require('crypto');

const INVOKE = new Set([
  'sessions:list', 'directory:recents', 'project:detect-framework',
  'config:resolve-projects-dir', 'config:create-default-projects-dir',
  'project:get-settings', 'project:set-settings', 'project:create',
  'chat:defaults:get', 'chat:defaults:set', 'chat:defaults:catalog',
  'chat:open', 'chat:configure', 'chat:send', 'chat:stop', 'chat:close', 'chat:reply', 'chat:catalog',
  'git:init', 'git:add-remote', 'git:status', 'git:branches', 'git:checkout', 'git:create-branch',
  'git:stage-all', 'git:stage-file', 'git:unstage-file', 'git:discard-file', 'git:commit', 'git:push', 'git:pull', 'git:fetch',
  'devserver:start-commands', 'devserver:start', 'devserver:stop',
]);
const SEND = new Set(['sessions:save', 'sessions:delete', 'directory:add-recent', 'directory:toggle-star', 'pty:spawn', 'pty:input', 'pty:resize', 'pty:kill']);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const secret = () => randomBytes(32).toString('base64url');
function sameSecret(a, b) {
  return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
async function readJSON(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON.');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 58 * 1024 * 1024) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function addresses(port, interfaces = os.networkInterfaces()) {
  const result = [{ label: 'This computer', url: `http://127.0.0.1:${port}` }];
  for (const list of Object.values(interfaces)) for (const entry of list || []) {
    if (entry.internal || entry.family !== 'IPv4') continue;
    const parts = entry.address.split('.').map(Number);
    const tailscale = parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
    result.push({ label: tailscale ? 'Tailscale' : 'Local network', url: `http://${entry.address}:${port}` });
  }
  return result;
}
class WebServer {
  constructor({ root = path.resolve(__dirname, '../..'), dispatch, disconnect = async () => {}, validate = () => {}, pickDirectory } = {}) {
    this.root = root; this.dispatch = dispatch; this.disconnect = disconnect; this.validate = validate; this.pickDirectory = pickDirectory;
    this.server = null; this.clients = new Map(); this.tokens = new Map(); this.error = null;
  }
  status() { return { running: !!this.server?.listening, port: this.port || 3210, code: this.code || null, addresses: this.server?.listening ? addresses(this.port) : [], error: this.error }; }
  async start(port = 3210) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
    if (this.server) { if (this.port === port) return this.status(); throw new Error('Stop the web version before changing its port.'); }
    if (!fs.existsSync(path.join(this.root, 'src/web/app.bundle.js'))) throw new Error('Web assets are missing. Run npm run web:build and restart Lithium.');
    this.error = null; this.code = secret(); this.port = port;
    const server = http.createServer((req, res) => this.route(req, res).catch(error => {
      if (!res.headersSent) this.json(res, 400, { error: error.message }); else res.end();
    }));
    server.requestTimeout = 60000;
    this.server = server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
      server.on('error', error => { this.error = error.message; });
      this.sweep = setInterval(() => {
        const now = Date.now();
        for (const [id, client] of this.clients) if (!client.stream && now - client.seen > 30000) this.removeClient(id);
        for (const [token, expiry] of this.tokens) if (expiry < now) this.tokens.delete(token);
      }, 10000);
      this.sweep.unref();
      return this.status();
    } catch (error) { this.server = null; this.code = null; this.error = error.message; throw error; }
  }
  async removeClient(id) {
    const client = this.clients.get(id); if (!client) return;
    this.clients.delete(id); client.destroyed = true; client.stream?.end();
    await this.disconnect(client.sender).catch(console.error);
  }
  async stop() {
    clearInterval(this.sweep);
    const server = this.server; this.server = null; this.code = null; this.tokens.clear();
    await Promise.all([...this.clients.keys()].map(id => this.removeClient(id)));
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    return this.status();
  }
  json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
  async route(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const url = new URL(req.url, 'http://localhost');
    const origin = `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== origin) return this.json(res, 403, { error: 'Cross-origin requests are not allowed.' });
    if (req.method === 'POST' && req.headers.origin !== origin) return this.json(res, 403, { error: 'A same-origin request is required.' });
    const cookie = (req.headers.cookie || '').split('; ').find(c => c.startsWith('lithium-web='))?.slice(12);
    const authorized = (this.tokens.get(cookie) || 0) > Date.now();
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { code } = await readJSON(req);
      if (!this.code || !sameSecret(code, this.code)) return this.json(res, 401, { error: 'Incorrect access code. Copy it from Settings → Web access on the host.' });
      const token = secret(); this.tokens.set(token, Date.now() + 24 * 60 * 60 * 1000);
      res.setHeader('Set-Cookie', `lithium-web=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      return this.json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth') return this.json(res, 200, { authorized });
    if (url.pathname.startsWith('/api/')) {
      if (!authorized) return this.json(res, 401, { error: 'Please connect again using the host’s access code.' });
      if (req.method === 'POST' && url.pathname === '/api/connect') {
        const { previous } = await readJSON(req);
        const existing = this.clients.get(previous);
        if (existing && !existing.stream && existing.token === cookie) { existing.seen = Date.now(); return this.json(res, 200, { id: previous, home: os.homedir() }); }
        if (this.clients.size >= 32) return this.json(res, 429, { error: 'Too many connected browser tabs.' });
        const id = secret();
        const client = { token: cookie, stream: null, seen: Date.now(), destroyed: false, queue: [], queueBytes: 0 };
        client.sender = {
          id, isWebClient: true, isDestroyed: () => client.destroyed,
          send: (channel, payload) => {
            const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
            if (client.stream) {
              if (client.stream.writableLength > 4 * 1024 * 1024) client.stream.destroy();
              else client.stream.write(data);
            } else { client.queue.push(data); client.queueBytes += Buffer.byteLength(data); if (client.queueBytes > 4 * 1024 * 1024) this.removeClient(id); }
          },
        };
        this.clients.set(id, client); return this.json(res, 200, { id, home: os.homedir() });
      }
      const client = this.clients.get(url.searchParams.get('client'));
      if (!client || client.token !== cookie) return this.json(res, 409, { error: 'Connection expired. Reload this page to reconnect.' });
      client.seen = Date.now();
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (client.stream) client.stream.end();
        client.stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n'); for (const data of client.queue.splice(0)) res.write(data); client.queueBytes = 0;
        const timer = setInterval(() => {
          if ((this.tokens.get(cookie) || 0) < Date.now()) { res.end(); return; }
          res.write(': heartbeat\n\n');
        }, 15000);
        res.on('close', () => { clearInterval(timer); if (client.stream === res) { client.stream = null; client.seen = Date.now(); } });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/rpc') {
        const { kind, channel, input } = await readJSON(req);
        if (kind === 'invoke' && channel === 'directory:pick') return this.json(res, 200, { value: await this.pickDirectory(input) });
        if (!(kind === 'invoke' ? INVOKE : kind === 'send' ? SEND : new Set()).has(channel)) return this.json(res, 403, { error: 'This action is only available in the desktop app.' });
        await this.validate(channel, input, client.sender);
        const value = await this.dispatch(kind, channel, client.sender, input);
        return this.json(res, 200, { value: value ?? null });
      }
      return this.json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.json(res, 405, { error: 'Method not allowed.' });
    // Explicit public asset roots only. Never serve host files or main-process code.
    let relative;
    if (url.pathname === '/' || url.pathname === '/index.html') relative = 'src/index.html';
    else if (url.pathname === '/renderer.js') relative = 'src/web/app.bundle.js';
    else if (url.pathname === '/web.css') relative = 'src/web/web.css';
    else if (url.pathname === '/node_modules/@xterm/xterm/css/xterm.css') relative = 'node_modules/@xterm/xterm/css/xterm.css';
    else if (/^\/styles\/[a-z-]+\.css$/.test(url.pathname)) relative = `src${url.pathname}`;
    else if (/^\/assets\/framework-icons\/[a-z-]+\.svg$/.test(url.pathname)) relative = `src${url.pathname}`;
    if (!relative) return this.json(res, 404, { error: 'Not found.' });
    let body;
    try { body = await fs.promises.readFile(path.join(this.root, relative)); }
    catch { return this.json(res, 404, { error: 'Not found.' }); }
    if (relative === 'src/index.html') body = body.toString().replace('</head>', '<link rel="stylesheet" href="/web.css"></head>');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(relative)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}
module.exports = { WebServer, addresses };
