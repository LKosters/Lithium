const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { validateSettings, DEFAULT_CHAT_SETTINGS } = require('../shared/chat-options');
const DATA_DIR = process.env.LITHIUM_DATA_DIR || path.join(os.homedir(), '.synthcode');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(id);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function validateChat(doc) {
  if (!object(doc) || !validId(doc.id) || !Array.isArray(doc.entries)) throw new Error('Invalid chat document.');
  validateSettings(doc.settings);
  const ids = new Set();
  for (const entry of doc.entries) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.kind !== 'string') throw new Error('Invalid or duplicate chat entry.');
    ids.add(entry.id);
    if (entry.text !== undefined && typeof entry.text !== 'string') throw new Error('Invalid message text.');
    if (entry.attachments !== undefined && !Array.isArray(entry.attachments)) throw new Error('Invalid chat attachments.');
    for (const image of entry.attachments || []) {
      if (!object(image) || (image.assetId && !validId(image.assetId)) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime)) throw new Error('Invalid chat image.');
    }
  }
}

// Convert only known historical formats; malformed current documents still fail.
// Keep original message objects and document metadata for lossless recovery.
function migrateLegacyChat(doc, session) {
  if (doc.entries !== undefined || !Array.isArray(doc.messages)) return doc;
  const provider = session?.provider || doc.provider;
  const entries = doc.messages.map((message, index) => {
    if (!object(message) || !['user', 'assistant', 'system'].includes(message.role)) throw new Error(`Unsupported legacy message ${index + 1}`);
    let text = message.content;
    if (Array.isArray(text) && text.every(block => object(block) && block.type === 'text' && typeof block.text === 'string')) text = text.map(block => block.text).join('\n');
    if (typeof text !== 'string') throw new Error(`Unsupported legacy message content at position ${index + 1}`);
    return { id: `legacy-${index}`, kind: message.role === 'system' ? 'notice' : message.role, text, ...(Number.isFinite(message.timestamp) ? { createdAt: message.timestamp } : {}), legacyMessage: message };
  });
  return {
    ...doc, version: 1, entries, status: 'idle',
    settings: { ...DEFAULT_CHAT_SETTINGS, provider: ['codex', 'codex-acp'].includes(provider) ? 'codex' : 'claude' },
    // A legacy sessionId was not necessarily a resumable native provider ID.
    nativeId: null, legacyFormat: 'messages',
  };
}

class LithiumDatabase {
  constructor(root = DATA_DIR, { migrate = true } = {}) {
    this.root = root; this.file = path.join(root, 'lithium.sqlite');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new Database(this.file);
    try {
      fs.chmodSync(this.file, 0o600);
      const version = this.db.pragma('user_version', { simple: true });
      if (version > 1) throw new Error('This database needs a newer version of Lithium. Your data has not been changed.');
      this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('synchronous = FULL');
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, directory TEXT, updated_at INTEGER, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
          CREATE INDEX IF NOT EXISTS sessions_directory ON sessions(directory);
          CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, position INTEGER NOT NULL, entry_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(chat_id, position), UNIQUE(chat_id, entry_id));
          PRAGMA user_version = 1;
        `);
      })();
      if (migrate) this.migrateLegacy();
      this.applyPendingInstructions();
    } catch (error) { this.db.close(); throw error; }
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  sessions() { return this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC').all().map(r => JSON.parse(r.data)); }
  saveSession(session) {
    if (!object(session) || !validId(session.id)) throw new Error('Invalid session.');
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET directory=excluded.directory, updated_at=excluded.updated_at, data=excluded.data').run(session.id, session.directory || '', Number(session.updatedAt) || 0, JSON.stringify(session));
  }
  deleteSession(id) { this.db.transaction(() => { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); this.deleteChat(id); const preferences = this.get('preferences', {}); delete preferences[`lithium-chat-draft-${id}`]; this.set('preferences', preferences); })(); }
  loadChat(id) {
    if (!validId(id)) throw new Error('Invalid session ID.');
    const row = this.db.prepare('SELECT data FROM chats WHERE id=?').get(id);
    if (!row) return null;
    const doc = { ...JSON.parse(row.data), entries: this.db.prepare('SELECT data FROM messages WHERE chat_id=? ORDER BY position').all(id).map(r => JSON.parse(r.data)) };
    validateChat(doc); return doc;
  }
  saveChat(doc) {
    validateChat(doc);
    this.db.transaction(() => {
      const { entries, ...header } = doc;
      this.db.prepare('INSERT INTO chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE data != excluded.data').run(doc.id, JSON.stringify(header));
      // Rows keep their stable timeline positions; unchanged messages cause no disk writes.
      const put = this.db.prepare('INSERT INTO messages VALUES (?,?,?,?) ON CONFLICT(chat_id,position) DO UPDATE SET entry_id=excluded.entry_id, data=excluded.data WHERE data != excluded.data');
      entries.forEach((entry, i) => put.run(doc.id, i, entry.id, JSON.stringify(entry)));
      this.db.prepare('DELETE FROM messages WHERE chat_id=? AND position>=?').run(doc.id, entries.length);
    })();
  }
  deleteChat(id) { if (!validId(id)) throw new Error('Invalid session ID.'); this.db.prepare('DELETE FROM chats WHERE id=?').run(id); }
  snapshot() {
    return this.db.transaction(() => ({ config: this.get('config', { recentDirs: [] }), layout: this.get('layout'), preferences: this.get('preferences', {}), sessions: this.sessions(), chats: this.db.prepare('SELECT id FROM chats ORDER BY id').all().map(r => this.loadChat(r.id)) }))();
  }
  replace(snapshot) {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM messages; DELETE FROM chats; DELETE FROM sessions;');
      this.set('config', snapshot.config); this.set('layout', snapshot.layout); this.set('preferences', snapshot.preferences);
      for (const session of snapshot.sessions) this.saveSession(session);
      for (const chat of snapshot.chats) this.saveChat(chat);
    })();
  }
  migrateLegacy() {
    if (this.get('legacyMigrated')) return;
    const names = ['config.json', 'layout.json', 'sessions', 'chats', 'chat', 'instructions.md'].filter(name => fs.existsSync(path.join(this.root, name)));
    if (names.length) {
      const backup = path.join(this.root, 'backups', `before-sqlite-${Date.now()}`);
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      for (const name of names) fs.cpSync(path.join(this.root, name), path.join(backup, name), { recursive: true, dereference: false });
      this.migrationBackup = backup;
    }
    const read = (name, fallback) => {
      const file = path.join(this.root, name);
      if (!fs.existsSync(file)) return fallback;
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { throw new Error(`Cannot migrate ${file}: ${error.message}. Original files are preserved.`); }
    };
    const documents = dir => fs.existsSync(path.join(this.root, dir)) ? fs.readdirSync(path.join(this.root, dir)).filter(f => f.endsWith('.json')).map(file => {
      const source = path.join(dir, file);
      const doc = read(source);
      // The original ACP store used chat/<session-id>.json without an id field.
      const id = dir === 'chat' && object(doc) && doc.id === undefined ? path.basename(file, '.json') : doc?.id;
      if (!validId(id) || file !== `${id}.json`) throw new Error(`Invalid ID in ${source}. Original files are preserved.`);
      return { doc: { ...doc, id }, source };
    }) : [];
    const config = read('config.json', { recentDirs: [] });
    if (!object(config)) throw new Error('Invalid legacy config. Original files are preserved.');
    const sessions = documents('sessions').map(({ doc }) => doc);
    const chats = [];
    const sources = new Map();
    for (const { doc, source } of [...documents('chats'), ...documents('chat')]) {
      try {
        if (sources.has(doc.id)) throw new Error(`Duplicate chat ID, also present in ${sources.get(doc.id)}`);
        sources.set(doc.id, source);
        let session = sessions.find(session => session.id === doc.id);
        const converted = migrateLegacyChat(doc, session);
        validateChat(converted);
        chats.push(converted);
        // Older standalone chats did not necessarily have a session-list record.
        if (!session) {
          session = { id: doc.id, directory: typeof doc.directory === 'string' ? doc.directory : '', title: typeof doc.title === 'string' ? doc.title : 'Imported chat', createdAt: doc.createdAt || 0, updatedAt: doc.updatedAt || 0, mode: 'chat' };
          sessions.push(session);
        } else session.mode = 'chat';
      } catch (error) { throw new Error(`Cannot migrate ${source}: ${error.message}. Original files are preserved.`); }
    }
    const snapshot = { config: { recentDirs: [], ...config }, layout: read('layout.json', null), preferences: {}, sessions, chats };
    this.db.transaction(() => { this.replace(snapshot); this.set('legacyMigrated', true); })();
  }
  applyPendingInstructions() {
    const pending = this.get('instructionsRestore');
    if (!pending) return;
    const file = path.join(this.root, 'instructions.md');
    if (pending.text === null) fs.rmSync(file, { force: true });
    else { fs.writeFileSync(`${file}.restore`, pending.text, { mode: 0o600 }); fs.renameSync(`${file}.restore`, file); }
    this.db.prepare("DELETE FROM settings WHERE key='instructionsRestore'").run();
  }
  close() { if (this.db.open) this.db.close(); }
}
let singleton;
function getDatabase() { return singleton ||= new LithiumDatabase(); }
module.exports = { LithiumDatabase, getDatabase, DATA_DIR, validId, object, validateChat };
