const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { object, validId, validateChat } = require('./database');
const { validPreference } = require('../shared/preferences');
const { validateSettings } = require('../shared/chat-options');
const FORMAT = 'lithium-backup';
const MAX_BYTES = 512 * 1024 * 1024;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateSnapshot(data) {
  if (!object(data) || !object(data.config) || !object(data.preferences) || !Array.isArray(data.sessions) || !Array.isArray(data.chats) || !Array.isArray(data.assets)) throw new Error('Invalid backup contents.');
  if (data.layout !== null && !object(data.layout)) throw new Error('Invalid layout.');
  function layoutNode(node, depth = 0) {
    if (!object(node) || depth > 64 || !validId(node.id)) throw new Error('Invalid layout tree.');
    if (node.type === 'leaf') {
      if (!Array.isArray(node.tabs) || node.tabs.some(id => !validId(id)) || (node.activeTab != null && !validId(node.activeTab))) throw new Error('Invalid layout tabs.');
    } else if (node.type === 'split' && ['horizontal', 'vertical'].includes(node.direction) && Array.isArray(node.children) && node.children.length === 2) {
      node.children.forEach(child => layoutNode(child, depth + 1));
    } else throw new Error('Invalid layout node.');
  }
  if (data.layout?.layout) layoutNode(data.layout.layout);
  if (data.instructions !== null && typeof data.instructions !== 'string') throw new Error('Invalid instructions.');
  for (const [key, value] of Object.entries(data.preferences)) if (!validPreference(key, value)) throw new Error('Invalid preference in backup.');
  if (!Array.isArray(data.config.recentDirs) || data.config.recentDirs.some(dir => typeof dir !== 'string')) throw new Error('Invalid recent projects.');
  for (const key of ['currentDir', 'projectsDir']) if (data.config[key] != null && typeof data.config[key] !== 'string') throw new Error('Invalid project setting.');
  if (data.config.starredDirs !== undefined && (!Array.isArray(data.config.starredDirs) || data.config.starredDirs.some(dir => typeof dir !== 'string'))) throw new Error('Invalid favorite projects.');
  if (data.config.chatDefaults !== undefined) validateSettings(data.config.chatDefaults);
  const ids = new Set();
  for (const session of data.sessions) {
    if (!object(session) || !validId(session.id) || ids.has(session.id) || typeof session.directory !== 'string' || typeof session.title !== 'string') throw new Error('Invalid or duplicate session.');
    ids.add(session.id);
  }
  const chats = new Set();
  for (const chat of data.chats) { validateChat(chat); if (chats.has(chat.id)) throw new Error('Duplicate chat.'); chats.add(chat.id); }
  const assets = new Map();
  for (const asset of data.assets) {
    if (!object(asset) || !validId(asset.chatId) || !validId(asset.id) || !chats.has(asset.chatId) || typeof asset.base64 !== 'string' || asset.base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.base64) || Buffer.from(asset.base64, 'base64').toString('base64') !== asset.base64) throw new Error('Invalid image data in backup.');
    const key = `${asset.chatId}/${asset.id}`;
    if (assets.has(key)) throw new Error('Duplicate image in backup.');
    assets.set(key, asset);
  }
  for (const chat of data.chats) for (const entry of chat.entries) for (const image of entry.attachments || []) {
    if (image.assetId && !image.missing && !assets.has(`${chat.id}/${image.assetId}`)) throw new Error('An image is missing from this backup.');
    if (image.dataUrl) {
      if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith(`data:${image.mime};base64,`) || image.dataUrl.length > 14 * 1024 * 1024) throw new Error('Invalid inline image.');
      const encoded = image.dataUrl.split(',')[1];
      if (Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('Invalid inline image encoding.');
    }
  }
  return data;
}
function exportData(database) {
  const data = database.snapshot(); data.assets = [];
  const instructions = path.join(database.root, 'instructions.md');
  data.instructions = fs.existsSync(instructions) ? fs.readFileSync(instructions, 'utf8') : null;
  const included = new Set();
  for (const chat of data.chats) for (const entry of chat.entries) for (const image of entry.attachments || []) {
    if (!image.assetId) continue;
    const key = `${chat.id}/${image.assetId}`;
    if (included.has(key)) continue;
    try {
      const base64 = fs.readFileSync(path.join(database.root, 'chats', 'images', chat.id, image.assetId)).toString('base64');
      data.assets.push({ chatId: chat.id, id: image.assetId, base64 }); included.add(key); delete image.missing;
    } catch (error) { if (error.code !== 'ENOENT') throw error; image.missing = true; }
  }
  validateSnapshot(data);
  return { format: FORMAT, version: 1, createdAt: new Date().toISOString(), checksum: digest(data), data };
}
function writeBackup(database, file) {
  const backup = exportData(database), text = JSON.stringify(backup);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('This backup exceeds the 512 MB export limit.');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  }
  finally { fs.rmSync(temp, { force: true }); }
  return backup;
}
function readBackup(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('Backup exceeds the 512 MB import limit.');
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (backup.format !== FORMAT || backup.version !== 1) throw new Error('Unsupported Lithium backup format or version.');
  if (backup.checksum !== digest(backup.data)) throw new Error('Backup checksum does not match. The file may be damaged.');
  validateSnapshot(backup.data); return backup;
}
function restoreBackup(database, backup) {
  // Validate again even when invoked outside IPC. Never use archive paths directly.
  if (backup.format !== FORMAT || backup.version !== 1 || backup.checksum !== digest(backup.data)) throw new Error('Invalid backup.');
  const data = structuredClone(validateSnapshot(backup.data));
  const created = [], replacements = new Map();
  try {
    // New immutable filenames leave all existing images intact if the transaction fails.
    for (const asset of data.assets) {
      const id = randomUUID(), dir = path.join(database.root, 'chats', 'images', asset.chatId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, id); created.push(file);
      fs.writeFileSync(file, Buffer.from(asset.base64, 'base64'), { flag: 'wx', mode: 0o600 });
      replacements.set(`${asset.chatId}/${asset.id}`, id);
    }
    for (const chat of data.chats) {
      chat.status = 'idle'; chat.pending = []; chat.error = null;
      for (const entry of chat.entries) {
        if (entry.status === 'running') entry.status = 'interrupted';
        for (const image of entry.attachments || []) if (image.assetId) {
          image.assetId = replacements.get(`${chat.id}/${image.assetId}`) || randomUUID();
        }
      }
    }
    database.db.transaction(() => {
      database.replace(data);
      database.set('instructionsRestore', { text: data.instructions });
      database.set('restoreToken', randomUUID());
      database.set('preferencesMigrated', true);
    })();
  } catch (error) { for (const file of created) fs.rmSync(file, { force: true }); throw error; }
}
module.exports = { exportData, writeBackup, readBackup, restoreBackup, validateSnapshot };
