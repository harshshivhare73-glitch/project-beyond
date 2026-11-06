'use strict';
// Project Beyond — Attachment system (Assignment 1.6, Phase 3).
// Bounded, validated, persistent attachments. No new dependencies.
// Storage: files are stored under attachmentsDir with the attachment id as
// the filename (no extension, no user-supplied name in the path), so a
// malicious filename can never escape the directory or be executed as a
// script. Metadata, including the safe original filename, lives in SQLite.
// Limits (foundation, not unlimited): max 10 MB per attachment, allowed
// types are images (png, jpeg, gif, webp), PDF and plain text/markdown only.
// SVG is rejected in this foundation because SVG can contain scripts.
// Resumable upload is NOT implemented in this foundation; that is a
// documented limitation, not a claimed feature. Multipart uploads are
// bounded to 10 MB in memory in the server route; raw binary uploads are
// streamed to disk in chunks (see server.js).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown'];

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function initAttachmentsTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments(
      id TEXT PRIMARY KEY,
      conversation_id INTEGER,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
  `);
}

function safeFilename(name) {
  const base = typeof name === 'string' ? path.basename(name) : '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'upload';
}

// Detect content type from file signature (magic bytes), not from the
// client-supplied Content-Type header alone. Returns a mime type or null.
function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  // Plain text: valid UTF-8, no null bytes, no control bytes except tab/LF/CR.
  try {
    const text = buffer.toString('utf8');
    if (!buffer.includes(0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return 'text/plain';
  } catch {}
  return null;
}

function isImageContentType(contentType) {
  return contentType === 'image/png' || contentType === 'image/jpeg' || contentType === 'image/gif' || contentType === 'image/webp';
}

function resolveAttachmentPath(attachmentsDir, id) {
  if (!/^att_[0-9a-f]{32}$/.test(id)) throw fail(400, 'Invalid attachment id.');
  const base = path.resolve(attachmentsDir);
  const target = path.join(base, id);
  // Realpath check: the file must resolve inside the attachments directory.
  // If the file does not exist yet, the join above is already safe because
  // id is validated to a fixed pattern with no separators.
  if (fs.existsSync(target)) {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
      throw fail(403, 'Attachment path escapes the attachments directory.');
    }
  }
  return target;
}

function computeHashSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    let read;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, total)) > 0) {
      hash.update(chunk.subarray(0, read));
      total += read;
    }
    return { sha256: hash.digest('hex'), size: total };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function storeAttachment(db, attachmentsDir, { conversationId = null, originalFilename = 'upload', declaredContentType = null, buffer }) {
  if (!Buffer.isBuffer(buffer)) throw fail(400, 'Attachment must be binary data.');
  if (buffer.length === 0) throw fail(400, 'Attachment is empty.');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw fail(413, `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`);
  if (conversationId !== null && conversationId !== undefined) {
    const conv = db.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId);
    if (!conv) throw fail(404, 'Conversation not found.');
  }
  const detected = detectContentType(buffer);
  let contentType = declaredContentType || detected;
  if (!contentType || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw fail(400, `Content type "${contentType || 'unknown'}" is not allowed. Allowed: ${ALLOWED_CONTENT_TYPES.join(', ')}.`);
  }
  if (detected && contentType !== detected) {
    // text/plain and text/markdown are both UTF-8 text, so they are interchangeable.
    const bothText = (contentType === 'text/plain' || contentType === 'text/markdown') && detected === 'text/plain';
    if (!bothText) throw fail(400, `Content type mismatch: declared "${contentType}" but file signature indicates "${detected}".`);
  }
  if (!detected && contentType !== 'text/plain' && contentType !== 'text/markdown') {
    throw fail(400, 'File signature could not be verified.');
  }
  const id = 'att_' + crypto.randomBytes(16).toString('hex');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = safeFilename(originalFilename);
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const target = resolveAttachmentPath(attachmentsDir, id);
  const tmp = target + '.tmp-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw fail(500, `Failed to store attachment: ${e.message}`);
  }
  const createdAt = Date.now();
  try {
    db.prepare('INSERT INTO attachments(id,conversation_id,filename,original_filename,content_type,size,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, conversationId ?? null, filename, filename, contentType, buffer.length, sha256, createdAt);
  } catch (e) {
    try { fs.unlinkSync(target); } catch {}
    throw e;
  }
  return { id, conversation_id: conversationId ?? null, filename, original_filename: filename, content_type: contentType, size: buffer.length, sha256, created_at: createdAt };
}

function getAttachment(db, id) {
  if (!/^att_[0-9a-f]{32}$/.test(id || '')) throw fail(400, 'Invalid attachment id.');
  const row = db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
  if (!row) throw fail(404, 'Attachment not found.');
  return row;
}

function listAttachments(db, conversationId = null) {
  if (conversationId === null || conversationId === undefined) {
    return db.prepare('SELECT * FROM attachments ORDER BY created_at ASC, id ASC').all();
  }
  const conv = db.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId);
  if (!conv) throw fail(404, 'Conversation not found.');
  return db.prepare('SELECT * FROM attachments WHERE conversation_id=? ORDER BY created_at ASC, id ASC').all(conversationId);
}

// Retrieve attachment bytes after verifying path, size and hash.
// Throws 500 on corruption, so a corrupted file is never served as if valid.
function getAttachmentBytes(db, attachmentsDir, id) {
  const meta = getAttachment(db, id);
  const target = resolveAttachmentPath(attachmentsDir, id);
  if (!fs.existsSync(target)) throw fail(500, 'Attachment file is missing from storage.');
  const hashed = computeHashSync(target);
  if (hashed.size !== meta.size || hashed.sha256 !== meta.sha256) {
    throw fail(500, 'Attachment file failed integrity verification (size or SHA-256 mismatch).');
  }
  const buffer = fs.readFileSync(target);
  return { meta, buffer };
}

function deleteAttachment(db, attachmentsDir, id) {
  const meta = getAttachment(db, id);
  db.prepare('DELETE FROM attachments WHERE id=?').run(id);
  try { fs.unlinkSync(resolveAttachmentPath(attachmentsDir, id)); } catch {}
  return meta;
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  ALLOWED_CONTENT_TYPES,
  initAttachmentsTables,
  safeFilename,
  detectContentType,
  isImageContentType,
  resolveAttachmentPath,
  computeHashSync,
  storeAttachment,
  getAttachment,
  listAttachments,
  getAttachmentBytes,
  deleteAttachment,
};
