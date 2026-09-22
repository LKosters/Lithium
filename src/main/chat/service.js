const { randomUUID } = require('crypto');
const { ChatStore } = require('./store');
const { validateSettings, chatDefaults } = require('../../shared/chat-options');
const { ClaudeAdapter } = require('./claude');
const { CodexAdapter } = require('./codex');

class ChatService {
  constructor({ store = new ChatStore(), adapters = { claude: ClaudeAdapter, codex: CodexAdapter }, getDefaults = () => null } = {}) {
    this.store = store; this.adapters = adapters; this.getDefaults = getDefaults; this.sessions = new Map();
  }
  open(session, owner) {
    if (this.paused) throw new Error('A backup is being restored. Please wait for Lithium to restart.');
    let runtime = this.sessions.get(session.id);
    if (runtime && runtime.owner !== owner && runtime.running) throw new Error('This session is running in another window.');
    if (!runtime) {
      const saved = this.store.load(session.id);
      const doc = saved || { id: session.id, version: 1, settings: chatDefaults(this.getDefaults()), entries: [], nativeId: null, status: 'idle' };
      // Capture defaults even for empty chats so reopening never changes their policy.
      if (!saved) this.store.save(doc);
      doc.status = 'idle'; doc.pending = [];
      for (const entry of doc.entries) if (entry.status === 'running') entry.status = 'interrupted';
      runtime = { doc, directory: session.directory, owner, pending: new Map(), running: false, revision: 0 };
      this.sessions.set(session.id, runtime);
    }
    runtime.owner = owner;
    return this.snapshot(runtime);
  }
  snapshot(r) { return { ...r.doc, revision: r.revision, pending: [...r.pending.values()].map(p => p.request) }; }
  get(id, owner) {
    const r = this.sessions.get(id);
    if (!r || r.owner !== owner) throw new Error('Open this chat in the current window first.');
    return r;
  }
  emit(r, event) {
    r.revision++;
    if (!r.owner.isDestroyed()) r.owner.send('chat:event', { sessionId: r.doc.id, revision: r.revision, ...event });
  }
  flush(r) { clearTimeout(r.timer); r.timer = null; this.store.save(r.doc); }
  schedule(r) { if (!r.timer) r.timer = setTimeout(() => { try { this.flush(r); } catch (error) { this.emit(r, { type: 'persistence-error', error: error.message }); } }, 250); }
  entry(r, entry) {
    let current = r.doc.entries.find(e => e.id === entry.id);
    if (!current) { current = { createdAt: Date.now(), text: '', ...entry }; r.doc.entries.push(current); }
    else Object.assign(current, entry);
    // Bound tool output only; preserve the complete conversational text.
    if (current.kind === 'tool' && current.text?.length > 150000) current.text = '[Earlier output truncated]\n' + current.text.slice(-150000);
    this.emit(r, { type: 'entry', entry: current }); this.schedule(r);
  }
  update(r, values) { Object.assign(r.doc, values); this.emit(r, { type: 'state', state: values }); this.schedule(r); }
  configure(id, owner, settings) {
    if (this.paused) throw new Error('A backup is being restored. Please wait for Lithium to restart.');
    const r = this.get(id, owner);
    if (r.running) throw new Error('Stop the current turn before changing the session settings.');
    const next = validateSettings(settings);
    if (next.provider !== r.doc.settings.provider && (r.doc.nativeId || r.doc.entries.some(e => e.kind === 'user'))) throw new Error('Start a new chat to switch providers. Each provider keeps its own conversation.');
    this.update(r, { settings: next, effective: null }); this.flush(r); return this.snapshot(r);
  }
  ask(r, request, signal) {
    if (!r.running || signal?.aborted) return Promise.resolve({ decision: 'deny' });
    const id = randomUUID(); request = { ...request, id };
    return new Promise(resolve => {
      const settle = answer => {
        signal?.removeEventListener('abort', abort);
        r.pending.delete(id); this.emit(r, { type: 'resolved', id, decision: answer.decision });
        resolve(answer);
      };
      const abort = () => settle({ decision: 'deny' });
      r.pending.set(id, { request, settle });
      signal?.addEventListener('abort', abort, { once: true });
      this.emit(r, { type: 'request', request });
    });
  }
  reply(id, owner, requestId, answer) {
    const r = this.get(id, owner); const pending = r.pending.get(requestId);
    if (!pending) throw new Error('This request is no longer active.');
    if (!['allow', 'deny', 'session'].includes(answer?.decision)) throw new Error('Invalid approval decision.');
    if (answer.decision === 'session' && !pending.request.allowSession) throw new Error('Session-wide approval is not supported for this request.');
    pending.settle(answer);
  }
  send(id, owner, text, attachments = []) {
    if (this.paused) throw new Error('A backup is being restored. Please wait for Lithium to restart.');
    const r = this.get(id, owner);
    if (r.running) throw new Error('This session is already responding.');
    if (typeof text !== 'string' || text.length > 200000 || (!text.trim() && !attachments.length)) throw new Error('Enter a message first (maximum 200,000 characters).');
    if (!Array.isArray(attachments) || attachments.length > 4 || attachments.some(a => !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a.dataUrl) || a.dataUrl.length > 14 * 1024 * 1024 || a.mime !== a.dataUrl.slice(5, a.dataUrl.indexOf(';')))) throw new Error('Attach up to four PNG, JPEG, WebP or GIF images, at most 10 MB each.');
    validateSettings(r.doc.settings);
    r.running = true;
    attachments = attachments.map(a => ({ name: String(a.name || 'Image').slice(0, 300), mime: a.mime, dataUrl: a.dataUrl }));
    this.entry(r, { id: randomUUID(), kind: 'user', text, attachments });
    this.update(r, { status: 'working', error: null });
    try { this.flush(r); }
    catch (error) { r.running = false; this.update(r, { status: 'error', error: `Could not save your message: ${error.message}` }); throw error; }
    const turn = randomUUID(); r.turn = turn;
    const active = () => r.turn === turn;
    const context = {
      id, directory: r.directory, nativeId: r.doc.nativeId, settings: { ...r.doc.settings },
      entry: entry => { if (active()) this.entry(r, entry); },
      delta: (entryId, kind, delta) => {
        if (!active()) return;
        const previous = r.doc.entries.find(e => e.id === entryId);
        this.entry(r, { id: entryId, kind, text: (previous?.text || '') + delta });
      },
      update: values => { if (active()) this.update(r, values); },
      notice: text => { if (active()) this.entry(r, { id: randomUUID(), kind: 'notice', text }); },
      ask: (request, signal) => active() ? this.ask(r, request, signal) : Promise.resolve({ decision: 'deny' }),
    };
    if (!r.adapter) r.adapter = new this.adapters[r.doc.settings.provider](context);
    else r.adapter.ctx = context;
    r.task = (async () => {
      try { await r.adapter.run(text, attachments); }
      catch (error) { if (active() && !r.stopping) this.update(r, { error: error.message, status: 'error' }); }
      finally {
        if (active()) {
          for (const pending of [...r.pending.values()]) pending.settle({ decision: 'deny' });
          for (const entry of r.doc.entries) if (entry.status === 'running') this.entry(r, { id: entry.id, status: r.stopping || r.doc.error ? 'interrupted' : 'completed' });
          r.running = false;
          this.update(r, { status: r.stopping ? 'stopped' : r.doc.error ? 'error' : 'idle' });
          r.stopping = false; this.flush(r);
        }
      }
    })();
    // IPC observes send failures; background persistence failures must not crash Electron.
    r.task.catch(error => this.emit(r, { type: 'persistence-error', error: error.message }));
    return { ok: true };
  }
  async stop(id, owner) {
    const r = this.get(id, owner); if (!r.running) return;
    r.stopping = true; this.update(r, { status: 'stopping' });
    for (const pending of [...r.pending.values()]) pending.settle({ decision: 'deny' });
    await r.adapter?.stop(); await r.task;
  }
  async close(id, owner) {
    const r = this.get(id, owner);
    if (!r.closing) r.closing = (async () => { await this.stop(id, owner); await r.adapter?.stop?.(); this.flush(r); this.sessions.delete(id); })();
    return r.closing;
  }
  async closeOwner(owner) { for (const [id, r] of this.sessions) if (r.owner === owner) await this.close(id, owner); }
}
module.exports = { ChatService };
