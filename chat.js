'use strict';
// Project Beyond — Persistent conversations and chat generation
// (Assignment 1.6, Phases 2 and 4). No new dependencies.
// Conversations and messages live in SQLite, not in browser localStorage,
// so history survives page refreshes and server restarts. Message order is
// by auto-increment id, which is the authoritative order.
// Generation is dependency-injected: generateReply takes a providers object,
// so unit tests can pass mock providers and prove that actual image bytes
// are delivered to a vision provider, without any paid or real API call.
// The server route passes the real PROVIDERS object.
const { getAttachment, getAttachmentBytes, isImageContentType } = require('./attachments');

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  if (message && message.includes('VISION_NOT_AVAILABLE')) err.code = 'VISION_NOT_AVAILABLE';
  if (message && message.includes('PROVIDER_UNAVAILABLE')) err.code = 'PROVIDER_UNAVAILABLE';
  return err;
}

function initChatTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      attachment_ids TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
  `);
}

function validateTitle(title) {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t.length < 1 || t.length > 100) throw fail(400, 'Conversation title must be 1 to 100 characters.');
  return t;
}

function parseAttachmentIds(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

function toMessage(row) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    attachment_ids: parseAttachmentIds(row.attachment_ids),
    model: row.model || null,
    created_at: row.created_at,
    edited_at: row.edited_at || null,
  };
}

function createConversation(db, title) {
  const t = title === undefined || title === null || title === '' ? 'New conversation' : validateTitle(title);
  const now = Date.now();
  const r = db.prepare('INSERT INTO conversations(title,created_at,updated_at) VALUES(?,?,?)').run(t, now, now);
  return { id: Number(r.lastInsertRowid), title: t, created_at: now, updated_at: now };
}

function listConversations(db) {
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c ORDER BY c.updated_at DESC, c.id DESC
  `).all();
  return rows.map((r) => ({ id: r.id, title: r.title, created_at: r.created_at, updated_at: r.updated_at, message_count: r.message_count }));
}

function getConversation(db, id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  if (!conv) throw fail(404, 'Conversation not found.');
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC').all(id).map(toMessage);
  return { id: conv.id, title: conv.title, created_at: conv.created_at, updated_at: conv.updated_at, messages };
}

function renameConversation(db, id, title) {
  const t = validateTitle(title);
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  if (!conv) throw fail(404, 'Conversation not found.');
  const now = Date.now();
  db.prepare('UPDATE conversations SET title=?, updated_at=? WHERE id=?').run(t, now, id);
  return { id, title: t, created_at: conv.created_at, updated_at: now };
}

// Delete a conversation and its messages in one transaction, and return
// the attachment ids owned by it so the caller can delete their files
// after the commit (file deletion is best-effort, DB deletion is atomic).
function deleteConversation(db, id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  if (!conv) throw fail(404, 'Conversation not found.');
  let attachmentIds = [];
  try {
    attachmentIds = db.prepare('SELECT id FROM attachments WHERE conversation_id=?').all(id).map((r) => r.id);
  } catch {}
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    try { db.prepare('DELETE FROM attachments WHERE conversation_id=?').run(id); } catch {}
    db.prepare('DELETE FROM conversations WHERE id=?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
  return { deleted: true, id, attachmentIds };
}

function addMessage(db, conversationId, role, content, attachmentIds = [], model = null) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
  if (!conv) throw fail(404, 'Conversation not found.');
  if (role !== 'user' && role !== 'assistant' && role !== 'system') throw fail(400, 'Message role must be user, assistant or system.');
  const text = typeof content === 'string' ? content : '';
  if (!text.trim() && (!Array.isArray(attachmentIds) || attachmentIds.length === 0)) {
    throw fail(400, 'Message content must not be empty unless attachments are present.');
  }
  if (text.length > 20000) throw fail(400, 'Message content exceeds 20000 characters.');
  const ids = Array.isArray(attachmentIds) ? attachmentIds : [];
  // Attachment ownership: an attachment owned by another conversation
  // cannot be attached here (cross-conversation access is rejected).
  // An unassigned attachment (conversation_id NULL) is claimed by this
  // conversation in the same transaction as the message insert.
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const attId of ids) {
      const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(attId);
      if (!att) throw fail(404, `Attachment not found: ${attId}`);
      if (att.conversation_id !== null && att.conversation_id !== conversationId) {
        throw fail(403, `Attachment ${attId} belongs to another conversation.`);
      }
      if (att.conversation_id === null) {
        db.prepare('UPDATE attachments SET conversation_id=? WHERE id=?').run(conversationId, attId);
      }
    }
    const r = db.prepare('INSERT INTO messages(conversation_id,role,content,attachment_ids,model,created_at) VALUES(?,?,?,?,?,?)')
      .run(conversationId, role, text, JSON.stringify(ids), model, now);
    db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
    db.exec('COMMIT');
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(Number(r.lastInsertRowid));
    return toMessage(row);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

function editMessage(db, conversationId, messageId, newContent) {
  const msg = db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=?').get(messageId, conversationId);
  if (!msg) throw fail(404, 'Message not found in this conversation.');
  const text = typeof newContent === 'string' ? newContent.trim() : '';
  if (!text || text.length > 20000) throw fail(400, 'Edited message content must be 1 to 20000 characters.');
  const now = Date.now();
  db.prepare('UPDATE messages SET content=?, edited_at=? WHERE id=?').run(text, now, messageId);
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
  const row = db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
  return toMessage(row);
}

function getHistory(db, conversationId, limit = 20) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId);
  if (!conv) throw fail(404, 'Conversation not found.');
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?').all(conversationId, limit).reverse().map(toMessage);
  return rows;
}

function buildPrompt(history, lastUserContent) {
  const lines = history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  return `You are Project Beyond, a helpful assistant. Answer from the conversation history below, and if images are attached, describe or answer about the actual image content, not just filenames.\n\n${lines.join('\n')}\n\nUser: ${lastUserContent}`;
}

function findVisionProvider(providers) {
  if (!providers) return null;
  // A provider is vision-capable only if it explicitly declares it and
  // its generateContent accepts images. Never assume vision from a name.
  for (const key of ['gemini', 'openrouter', 'ollama']) {
    const p = providers[key];
    if (p && p.supportsVision === true && typeof p.generateContent === 'function') return p;
  }
  return null;
}

async function generateText({ db, attachmentsDir, history, lastUserMessage, providers, allowPaid = false }) {
  if (!lastUserMessage || lastUserMessage.role !== 'user') {
    throw fail(400, 'No user message to reply to.');
  }
  const imageIds = [];
  for (const m of history) {
    for (const attId of m.attachment_ids || []) {
      if (!imageIds.includes(attId)) imageIds.push(attId);
    }
  }
  const images = [];
  if (imageIds.length > 0 && attachmentsDir) {
    for (const attId of imageIds) {
      let meta;
      try { meta = getAttachment(db, attId); } catch { continue; }
      if (!isImageContentType(meta.content_type)) continue;
      const { buffer } = getAttachmentBytes(db, attachmentsDir, attId);
      images.push({ attachmentId: attId, mimeType: meta.content_type, dataBase64: buffer.toString('base64'), size: meta.size, sha256: meta.sha256 });
    }
  }
  const prompt = buildPrompt(history, lastUserMessage.content);
  let result = null;
  let modelUsed = null;
  if (images.length > 0) {
    const vision = findVisionProvider(providers);
    if (!vision) {
      const err = new Error('VISION_NOT_AVAILABLE: No vision-capable provider is configured. The image bytes were saved, but no provider that can actually inspect images is available, so no image answer can be generated. Do not treat a filename-only answer as an image inspection.');
      err.status = 503;
      err.code = 'VISION_NOT_AVAILABLE';
      throw err;
    }
    result = await vision.generateContent({ prompt, images, model: 'gemini-flash-lite-latest', allowPaid, timeoutMs: 30000 });
    modelUsed = (result && result.model) || vision.id || 'gemini';
    if (!result || !result.ok) {
      const err = new Error(`Vision provider failed: ${(result && result.error) || 'unknown error'}`);
      err.status = 502;
      err.code = 'PROVIDER_ERROR';
      throw err;
    }
  } else {
    const gemini = providers && providers.gemini;
    if (gemini && typeof gemini.generateContent === 'function') {
      result = await gemini.generateContent({ prompt, model: 'gemini-flash-lite-latest', allowPaid, timeoutMs: 30000 });
      modelUsed = (result && result.model) || 'gemini';
      if (result && result.ok) {
        // success
      } else if (result && result.status === 'missing_key' && providers.ollama && typeof providers.ollama.generateContent === 'function') {
        result = await providers.ollama.generateContent({ prompt, timeoutMs: 30000 });
        modelUsed = (result && result.model) || 'ollama';
      }
    } else if (providers && providers.ollama && typeof providers.ollama.generateContent === 'function') {
      result = await providers.ollama.generateContent({ prompt, timeoutMs: 30000 });
      modelUsed = (result && result.model) || 'ollama';
    }
    if (!result || !result.ok) {
      const err = new Error(`PROVIDER_UNAVAILABLE: No text provider could generate a reply. ${(result && result.error) || 'No provider configured.'} The user message was saved; no fake assistant answer was saved.`);
      err.status = 503;
      err.code = 'PROVIDER_UNAVAILABLE';
      throw err;
    }
  }
  return { text: result.text, model: modelUsed, imagesUsed: images.map((i) => i.attachmentId) };
}

async function generateReplyWithHistory({ db, attachmentsDir, conversationId, history, lastUserMessage, providers, allowPaid = false }) {
  const generated = await generateText({ db, attachmentsDir, history, lastUserMessage, providers, allowPaid });
  const assistant = addMessage(db, conversationId, 'assistant', generated.text, [], generated.model);
  return { assistant, imagesUsed: generated.imagesUsed, model: generated.model };
}

async function generateReply({ db, attachmentsDir, conversationId, providers, allowPaid = false }) {
  const history = getHistory(db, conversationId, 20);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw fail(400, 'No user message to reply to.');
  return generateReplyWithHistory({ db, attachmentsDir, conversationId, history, lastUserMessage: lastUser, providers, allowPaid });
}

async function retryAssistantMessage({ db, attachmentsDir, conversationId, messageId, providers, allowPaid = false }) {
  const target = db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=?').get(messageId, conversationId);
  if (!target) throw fail(404, 'Message not found in this conversation.');
  if (target.role !== 'assistant') throw fail(400, 'Only assistant messages can be retried.');
  const all = getHistory(db, conversationId, 100);
  const index = all.findIndex((m) => m.id === messageId);
  if (index < 0) throw fail(404, 'Message not found in history.');
  const historyBefore = all.slice(0, index);
  const lastUser = [...historyBefore].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw fail(400, 'No user message before this assistant message to retry from.');
  // Generate first, delete only on success, so a failed retry does not
  // lose the original answer.
  const generated = await generateText({ db, attachmentsDir, history: historyBefore, lastUserMessage: lastUser, providers, allowPaid });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM messages WHERE id=?').run(messageId);
    const now = Date.now();
    const r = db.prepare('INSERT INTO messages(conversation_id,role,content,attachment_ids,model,created_at) VALUES(?,?,?,?,?,?)')
      .run(conversationId, 'assistant', generated.text, '[]', generated.model, now);
    db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
    db.exec('COMMIT');
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(Number(r.lastInsertRowid));
    return { assistant: toMessage(row), imagesUsed: generated.imagesUsed, model: generated.model };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

module.exports = {
  initChatTables,
  createConversation,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
  addMessage,
  editMessage,
  getHistory,
  buildPrompt,
  findVisionProvider,
  generateReply,
  generateReplyWithHistory,
  generateText,
  retryAssistantMessage,
};
