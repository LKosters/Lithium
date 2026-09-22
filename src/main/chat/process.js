const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

function binary(name) {
  const dirs = [path.join(os.homedir(), '.local', 'bin'), ...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global', 'bin')];
  for (const dir of dirs) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const candidate = path.join(dir, name + suffix);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  throw new Error(`${name} is not installed. Install the official CLI and sign in, then retry.`);
}
function providerEnv() { const env = { ...process.env }; delete env.CLAUDECODE; return env; }
function execJson(name, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(binary(name), args, { cwd, env: providerEnv(), timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      try { const result = JSON.parse(stdout); resolve(result); } catch { reject(error || new Error(`Could not read ${name} account status.`)); }
    });
  });
}

// Every RPC is settled on exit. Unknown server requests must be rejected by the adapter.
class JsonRpcProcess extends EventEmitter {
  constructor(command, args, options = {}) {
    super(); this.pending = new Map(); this.sequence = 0; this.closed = false; this.stderr = '';
    this.child = spawn(command, args, { ...options, env: options.env || providerEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method) this.emit(msg.id !== undefined ? 'request' : 'notification', msg);
      else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-3000); });
    this.child.stdin.on('error', error => this.finish(error));
    this.child.on('error', error => this.finish(error));
    this.child.on('exit', (code, signal) => this.finish(new Error(`Agent process stopped (${signal || code}). ${this.stderr}`)));
  }
  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Agent is disconnected.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out. Please retry.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) { this.send({ id, result }); }
  reject(id, message) { this.send({ id, error: { code: -32601, message } }); }
  finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.lines.close(); this.emit('closed', error);
  }
  close() { this.finish(new Error('Agent stopped.')); this.child.kill(); const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 1500); timer.unref(); }
}
module.exports = { binary, providerEnv, execJson, JsonRpcProcess };
