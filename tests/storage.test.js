const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { LithiumDatabase } = require('../src/main/database');
const { ChatStore } = require('../src/main/chat/store');
const { exportData, writeBackup, readBackup, restoreBackup } = require('../src/main/backup');
const { DEFAULT_CHAT_SETTINGS } = require('../src/shared/chat-options');
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lithium-db-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function open(t, root) { const db = new LithiumDatabase(root); t.after(() => db.close()); return db; }
function chat(id = 'chat') { return { id, settings: { ...DEFAULT_CHAT_SETTINGS }, nativeId: 'provider-resume-id', entries: [{ id: 'm1', kind: 'assistant', text: 'Hello' }] }; }
const session = id => ({ id, title: 'Conversation', directory: '/project', createdAt: 1, updatedAt: 2, mode: 'chat' });
function resign(backup) { backup.checksum = createHash('sha256').update(JSON.stringify(backup.data)).digest('hex'); return backup; }

test('legacy migration backs up originals, preserves settings/history and runs only once across updates', t => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'sessions')); fs.mkdirSync(path.join(root, 'chats'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ recentDirs: ['/project'], chatDefaults: { ...DEFAULT_CHAT_SETTINGS, permissionMode: 'plan' } }));
  fs.writeFileSync(path.join(root, 'sessions/chat.json'), JSON.stringify(session('chat')));
  fs.writeFileSync(path.join(root, 'chats/chat.json'), JSON.stringify(chat()));
  const db = open(t, root);
  assert.ok(fs.existsSync(path.join(db.migrationBackup, 'chats/chat.json')));
  assert.equal(db.get('config').chatDefaults.permissionMode, 'plan');
  assert.equal(db.loadChat('chat').nativeId, 'provider-resume-id');
  db.saveChat({ ...chat(), entries: [...chat().entries, { id: 'm2', kind: 'user', text: 'Persist me' }] });
  db.set('config', { recentDirs: [], marker: 'updated' }); db.close();
  const reopened = open(t, root);
  assert.equal(reopened.loadChat('chat').entries.length, 2);
  assert.equal(reopened.get('config').marker, 'updated');
  reopened.deleteSession('chat'); reopened.close();
  const again = open(t, root);
  assert.equal(again.loadChat('chat'), null);
  assert.equal(again.sessions().length, 0); // Stale JSON cannot resurrect deleted chats.
  assert.ok(fs.existsSync(path.join(root, 'chats/chat.json')));
});

test('malformed legacy data aborts migration without partial imports or deleting originals', t => {
  const root = temp(t); fs.mkdirSync(path.join(root, 'chats'));
  fs.writeFileSync(path.join(root, 'config.json'), '{"recentDirs":[]}');
  fs.writeFileSync(path.join(root, 'chats/broken.json'), '{bad');
  assert.throws(() => new LithiumDatabase(root), /Cannot migrate/);
  assert.equal(fs.readFileSync(path.join(root, 'chats/broken.json'), 'utf8'), '{bad');
  const inspect = new LithiumDatabase(root, { migrate: false });
  assert.equal(inspect.get('legacyMigrated'), null); assert.equal(inspect.get('config'), null); inspect.close();
  fs.writeFileSync(path.join(root, 'chats/broken.json'), JSON.stringify(chat('broken')));
  assert.equal(open(t, root).loadChat('broken').entries[0].text, 'Hello');
});

test('database transaction rolls back a failed chat update, skips unchanged messages and rejects newer schema', t => {
  const root = temp(t), db = open(t, root); db.saveChat(chat());
  const changes = () => db.db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes(); db.saveChat(chat()); assert.equal(changes(), before);
  db.db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages WHEN NEW.entry_id='fail' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => db.saveChat({ ...chat(), nativeId: 'bad', entries: [...chat().entries, { id: 'fail', kind: 'user', text: 'fail' }] }), /test failure/);
  assert.deepEqual(db.loadChat('chat'), chat());
  db.db.pragma('user_version = 999'); db.close();
  assert.throws(() => new LithiumDatabase(root), /newer version/);
});

test('portable backup roundtrips images, drafts, settings and instructions; native IDs remain intact', t => {
  const source = open(t, temp(t)); source.saveSession(session('chat'));
  const store = new ChatStore(path.join(source.root, 'chats'), source);
  const doc = chat(); doc.entries.push({ id: 'image', kind: 'user', attachments: [{ name: 'image.png', mime: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }] });
  store.save(doc); source.set('preferences', { playerMode: 'compact', 'lithium-chat-draft-chat': 'A draft' });
  source.set('config', { recentDirs: ['/project'], chatDefaults: { ...DEFAULT_CHAT_SETTINGS, permissionMode: 'plan' } });
  fs.writeFileSync(path.join(source.root, 'instructions.md'), 'My instructions');
  const file = path.join(source.root, 'export.json'); writeBackup(source, file);
  const backup = readBackup(file); assert.equal(backup.data.assets.length, 1);
  const target = open(t, temp(t)); target.saveSession(session('old')); target.saveChat(chat('old'));
  restoreBackup(target, backup);
  assert.equal(target.loadChat('old'), null); assert.equal(target.sessions().length, 1);
  const restored = new ChatStore(path.join(target.root, 'chats'), target).load('chat');
  assert.equal(restored.nativeId, 'provider-resume-id');
  assert.equal(restored.entries[1].attachments[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
  assert.notEqual(restored.entries[1].attachments[0].assetId, doc.entries[1].attachments[0].assetId);
  assert.equal(target.get('preferences')['lithium-chat-draft-chat'], 'A draft');
  target.close(); const restarted = open(t, target.root);
  assert.equal(fs.readFileSync(path.join(target.root, 'instructions.md'), 'utf8'), 'My instructions');
  assert.equal(restarted.get('instructionsRestore'), null);
  assert.equal(restarted.get('config').chatDefaults.permissionMode, 'plan');
});

test('invalid backup and path traversal leave existing data intact; failed restore cleans staged images', t => {
  const db = open(t, temp(t)); db.saveSession(session('chat')); db.saveChat(chat());
  const original = exportData(db);
  const corrupt = structuredClone(original); corrupt.data.config.recentDirs.push('/tampered');
  assert.throws(() => restoreBackup(db, corrupt), /Invalid backup/);
  const invalid = structuredClone(original); invalid.data.assets.push({ chatId: '../outside', id: 'image', base64: 'aGVsbG8=' }); resign(invalid);
  assert.throws(() => restoreBackup(db, invalid), /Invalid image/);
  assert.deepEqual(db.loadChat('chat'), chat());
  const valid = structuredClone(original); valid.data.assets.push({ chatId: 'chat', id: 'image', base64: 'aGVsbG8=' }); resign(valid);
  db.db.exec("CREATE TRIGGER prevent_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  assert.throws(() => restoreBackup(db, valid), /disk failure/);
  assert.equal(fs.readdirSync(path.join(db.root, 'chats/images/chat')).length, 0);
  assert.equal(db.sessions().length, 1); assert.equal(db.get('restoreToken'), null);
});

test('backup rejects malformed layout and settings before changing any records', t => {
  const db = open(t, temp(t)); db.saveSession(session('chat')); db.saveChat(chat());
  const badLayout = exportData(db); badLayout.data.layout = { layout: { id: 'pane-1', type: 'split', direction: 'horizontal', children: [] } };
  assert.throws(() => restoreBackup(db, resign(badLayout)), /layout/);
  const badSettings = exportData(db); badSettings.data.config.starredDirs = 'invalid';
  assert.throws(() => restoreBackup(db, resign(badSettings)), /favorite/);
  assert.deepEqual(db.loadChat('chat'), chat());
});

test('historical messages and ACP chat directories migrate without losing history or orphaned chats', t => {
  const root = temp(t);
  for (const dir of ['sessions', 'chats', 'chat']) fs.mkdirSync(path.join(root, dir));
  const standalone = { id: 'standalone', sessionId: 'old-provider-session', directory: '/old-project', title: 'Old chat', messages: [{ role: 'user', content: 'Original question' }, { role: 'assistant', content: [{ type: 'text', text: 'Original reply' }] }], createdAt: 10, updatedAt: 20 };
  const acp = { messages: [{ role: 'assistant', content: 'ACP reply', timestamp: 123 }], contextUsed: 10, contextSize: 100 };
  fs.writeFileSync(path.join(root, 'chats/standalone.json'), JSON.stringify(standalone));
  fs.writeFileSync(path.join(root, 'chat/acp.json'), JSON.stringify(acp));
  fs.writeFileSync(path.join(root, 'sessions/acp.json'), JSON.stringify({ ...session('acp'), provider: 'claude-acp' }));
  const db = open(t, root);
  assert.equal(db.get('legacyMigrated'), true);
  assert.equal(db.sessions().length, 2);
  assert.equal(db.sessions().find(s => s.id === 'standalone').directory, '/old-project');
  assert.deepEqual(db.loadChat('standalone').messages, standalone.messages);
  assert.deepEqual(db.loadChat('standalone').entries.map(e => e.text), ['Original question', 'Original reply']);
  assert.equal(db.loadChat('standalone').nativeId, null);
  assert.equal(db.loadChat('acp').settings.provider, 'claude');
  assert.deepEqual(db.loadChat('acp').entries[0].legacyMessage, acp.messages[0]);
  assert.equal(db.loadChat('acp').entries[0].createdAt, 123);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(db.migrationBackup, 'chat/acp.json'), 'utf8')), acp);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'chats/standalone.json'), 'utf8')), standalone);
  db.close();
  assert.equal(open(t, root).loadChat('acp').entries.length, 1);
});

test('unsupported legacy messages report their source and roll back without marking migration complete', t => {
  const root = temp(t); fs.mkdirSync(path.join(root, 'chats'));
  fs.writeFileSync(path.join(root, 'chats/old.json'), JSON.stringify({ id: 'old', messages: [{ role: 'user', content: { unexpected: true } }] }));
  assert.throws(() => new LithiumDatabase(root), /Cannot migrate chats\/old.json: Unsupported legacy message content/);
  const db = new LithiumDatabase(root, { migrate: false }); t.after(() => db.close());
  assert.equal(db.get('legacyMigrated'), null); assert.equal(db.sessions().length, 0);
  assert.equal(db.loadChat('old'), null);
});
