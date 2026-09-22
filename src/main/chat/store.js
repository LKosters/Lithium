const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { validId: isValidSessionId, DATA_DIR, getDatabase, LithiumDatabase } = require('../database');

class ChatStore {
  constructor(root = path.join(DATA_DIR, 'chats'), database) {
    this.root = root;
    this.database = database || (root === path.join(DATA_DIR, 'chats') ? null : new LithiumDatabase(root, { migrate: false }));
  }
  get db() { return this.database || getDatabase(); }
  load(id) {
    const doc = this.db.loadChat(id);
    if (!doc) return null;
    for (const entry of doc.entries) for (const image of entry.attachments || []) {
      if (!image.assetId) continue; // Previous inline-image documents still load.
      if (!isValidSessionId(image.assetId)) throw new Error('Invalid image reference in chat history.');
      try { image.dataUrl = `data:${image.mime};base64,${fs.readFileSync(path.join(this.root, 'images', id, image.assetId)).toString('base64')}`; }
      catch (error) { if (error.code !== 'ENOENT') throw error; image.missing = true; }
    }
    return doc;
  }
  save(doc) {
    if (!isValidSessionId(doc.id)) throw new Error('Invalid session ID.');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const entries = doc.entries.map(entry => {
      if (!entry.attachments?.length) return entry;
      const attachments = entry.attachments.map(image => {
        if (!image.assetId && image.dataUrl) {
          const assetId = randomUUID();
          const dir = path.join(this.root, 'images', doc.id);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(dir, assetId), Buffer.from(image.dataUrl.split(',')[1], 'base64'), { mode: 0o600 });
          image.assetId = assetId;
        }
        const { dataUrl, ...reference } = image;
        return reference;
      });
      return { ...entry, attachments };
    });
    this.db.saveChat({ ...doc, entries });
  }
  delete(id) { this.db.deleteChat(id); fs.rmSync(path.join(this.root, 'images', id), { recursive: true, force: true }); }
}
module.exports = { ChatStore };
