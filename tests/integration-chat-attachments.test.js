'use strict';
// Assignment 1.6, Phase 7 — end-to-end tests for conversations, chat and
// attachments. Mock providers only, zero paid API calls, zero real network
// calls to a provider. HTTP tests use a temporary database and a temporary
// attachments directory, and one test restarts the server on the same
// database and attachments directory to prove persistence.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { makeTempDb } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const chat = require('../chat');
const attachments = require('../attachments');
const { PROVIDERS } = require('../providers');

// A real 1x1 PNG, 67 bytes, used for every image test.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x00, 0x01, 0x01, 0x00, 0x05, 0x18, 0xd8, 0x4e, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function mockVision(calls) {
  return {
    id: 'mock-vision',
    supportsVision: true,
    generateContent: async (args = {}) => {
      calls.push(args);
      if (args.images && args.images.length > 0) {
        const decoded = Buffer.from(args.images[0].dataBase64, 'base64');
        if (!decoded.equals(PNG)) return { ok: false, error: 'Mock vision received wrong image bytes.' };
        return { ok: true, text: 'MOCK vision: image bytes received and inspected (1x1 PNG).', model: 'mock-vision' };
      }
      return { ok: true, text: 'MOCK text reply.', model: 'mock-vision' };
    },
  };
}

function mockText(calls) {
  return {
    id: 'mock-text',
    supportsVision: false,
    generateContent: async (args = {}) => {
      calls.push(args);
      return { ok: true, text: 'MOCK text reply.', model: 'mock-text' };
    },
  };
}

async function httpJson(base, method, p, body, extraHeaders = {}) {
  const headers = { 'X-Requested-With': 'beyond', ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}

let _port = 33400;
async function startIntegrationServer(dbPath, attDir) {
  const port = _port++;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, DB_PATH: dbPath, ATTACHMENTS_DIR: attDir, PORT: String(port) },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(baseUrl + '/api/health'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    baseUrl,
    close: async () => {
      try { child.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 300));
      try { child.kill('SIGKILL'); } catch {}
    },
  };
}

describe('1.6 unit: conversations and messages persist in SQLite, in order', () => {
  it('create, list, retrieve, rename, edit and delete', () => {
    const tmp = makeTempDb();
    try {
      chat.initChatTables(tmp.db);
      attachments.initAttachmentsTables(tmp.db);
      const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb16-att-'));
      const c1 = chat.createConversation(tmp.db, 'First chat');
      const c2 = chat.createConversation(tmp.db, 'Second chat');
      assert.ok(c1.id && c2.id && c1.id !== c2.id);
      const m1 = chat.addMessage(tmp.db, c1.id, 'user', 'Hello');
      const m2 = chat.addMessage(tmp.db, c1.id, 'assistant', 'Hi there');
      assert.ok(m1.id < m2.id, 'message order is by id');
      const got = chat.getConversation(tmp.db, c1.id);
      assert.deepEqual(got.messages.map((m) => m.content), ['Hello', 'Hi there']);
      const renamed = chat.renameConversation(tmp.db, c1.id, 'Renamed chat');
      assert.equal(renamed.title, 'Renamed chat');
      const edited = chat.editMessage(tmp.db, c1.id, m1.id, 'Hello, edited');
      assert.equal(edited.content, 'Hello, edited');
      assert.ok(edited.edited_at);
      const list = chat.listConversations(tmp.db);
      assert.equal(list.length, 2);
      assert.equal(list.find((c) => c.id === c1.id).message_count, 2);
      const del = chat.deleteConversation(tmp.db, c2.id);
      assert.equal(del.deleted, true);
      assert.throws(() => chat.getConversation(tmp.db, c2.id), /not found/i);
      fs.rmSync(attDir, { recursive: true, force: true });
    } finally { tmp.cleanup(); }
  });
});

describe('1.6 unit: attachments are validated, hashed and retrieved by bytes', () => {
  it('valid PNG stores with SHA-256 and retrieves byte-identical content', () => {
    const tmp = makeTempDb();
    try {
      chat.initChatTables(tmp.db);
      attachments.initAttachmentsTables(tmp.db);
      const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb16-att-'));
      const conv = chat.createConversation(tmp.db, 'Attach chat');
      const stored = attachments.storeAttachment(tmp.db, attDir, { conversationId: conv.id, originalFilename: 'test.png', declaredContentType: 'image/png', buffer: PNG });
      assert.equal(stored.content_type, 'image/png');
      assert.equal(stored.size, PNG.length);
      assert.equal(stored.sha256, crypto.createHash('sha256').update(PNG).digest('hex'));
      const { meta, buffer } = attachments.getAttachmentBytes(tmp.db, attDir, stored.id);
      assert.ok(buffer.equals(PNG), 'retrieved bytes must equal uploaded bytes');
      assert.equal(meta.sha256, stored.sha256);
      fs.rmSync(attDir, { recursive: true, force: true });
    } finally { tmp.cleanup(); }
  });

  it('invalid files, oversized uploads, path traversal and cross-conversation access are rejected', () => {
    const tmp = makeTempDb();
    try {
      chat.initChatTables(tmp.db);
      attachments.initAttachmentsTables(tmp.db);
      const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb16-att-'));
      const c1 = chat.createConversation(tmp.db, 'A');
      const c2 = chat.createConversation(tmp.db, 'B');
      // Fake EXE magic, declared as PNG: signature mismatch must fail.
      const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
      assert.throws(() => attachments.storeAttachment(tmp.db, attDir, { conversationId: c1.id, originalFilename: 'evil.png', declaredContentType: 'image/png', buffer: exe }), /mismatch|not allowed|signature/i);
      // Oversized: 10 MB + 1 byte.
      const big = Buffer.alloc(attachments.MAX_ATTACHMENT_BYTES + 1, 0);
      assert.throws(() => attachments.storeAttachment(tmp.db, attDir, { conversationId: c1.id, originalFilename: 'big.png', declaredContentType: 'image/png', buffer: big }), /exceeds/);
      // Path traversal in filename is sanitised, never used as a path.
      const stored = attachments.storeAttachment(tmp.db, attDir, { conversationId: c1.id, originalFilename: '../../etc/passwd.png', declaredContentType: 'image/png', buffer: PNG });
      assert.ok(!stored.filename.includes('/'), 'stored filename must not contain a path separator');
      assert.ok(fs.existsSync(path.join(attDir, stored.id)), 'file is stored by id, not by filename');
      assert.ok(!fs.existsSync(path.join(attDir, '..', 'etc', 'passwd.png')));
      // Traversal in attachment id is rejected, not used as a path.
      assert.throws(() => attachments.getAttachment(tmp.db, '../etc/passwd'), /Invalid attachment id/);
      assert.throws(() => attachments.getAttachment(tmp.db, 'att_../../../etc/passwd'), /Invalid attachment id/);
      // Cross-conversation: attachment owned by A cannot be added to B.
      assert.throws(() => chat.addMessage(tmp.db, c2.id, 'user', 'Use A image', [stored.id]), /another conversation/);
      // Unassigned attachment can be claimed by exactly one conversation.
      const unassigned = attachments.storeAttachment(tmp.db, attDir, { conversationId: null, originalFilename: 'free.png', declaredContentType: 'image/png', buffer: PNG });
      const msg = chat.addMessage(tmp.db, c2.id, 'user', 'Claimed', [unassigned.id]);
      assert.deepEqual(msg.attachment_ids, [unassigned.id]);
      assert.throws(() => chat.addMessage(tmp.db, c1.id, 'user', 'Steal', [unassigned.id]), /another conversation/);
      fs.rmSync(attDir, { recursive: true, force: true });
    } finally { tmp.cleanup(); }
  });
});

describe('1.6 unit: image understanding receives actual bytes, and follow-ups reuse them', () => {
  it('vision mock receives base64 image bytes, not just a filename; follow-up without re-upload reuses the image', async () => {
    const tmp = makeTempDb();
    try {
      chat.initChatTables(tmp.db);
      attachments.initAttachmentsTables(tmp.db);
      const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb16-att-'));
      const conv = chat.createConversation(tmp.db, 'Vision chat');
      const stored = attachments.storeAttachment(tmp.db, attDir, { conversationId: conv.id, originalFilename: 'photo.png', declaredContentType: 'image/png', buffer: PNG });
      chat.addMessage(tmp.db, conv.id, 'user', 'What is in this image?', [stored.id]);
      const calls = [];
      const providers = { gemini: mockVision(calls), ollama: mockText([]) };
      const first = await chat.generateReply({ db: tmp.db, attachmentsDir: attDir, conversationId: conv.id, providers, allowPaid: false });
      assert.ok(first.assistant.content.includes('MOCK vision'), 'assistant reply must come from the vision mock');
      assert.deepEqual(first.imagesUsed, [stored.id]);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].images && calls[0].images.length === 1, 'vision provider must receive images');
      assert.equal(calls[0].images[0].mimeType, 'image/png');
      assert.ok(Buffer.from(calls[0].images[0].dataBase64, 'base64').equals(PNG), 'vision provider must receive actual PNG bytes, not a filename');
      assert.ok(!JSON.stringify(calls[0]).includes('photo.png') || JSON.stringify(calls[0]).includes('dataBase64'), 'prompt must not rely on filename alone');
      // Follow-up: only text, no new upload, but history still contains the image.
      chat.addMessage(tmp.db, conv.id, 'user', 'What colour is it?');
      const second = await chat.generateReply({ db: tmp.db, attachmentsDir: attDir, conversationId: conv.id, providers, allowPaid: false });
      assert.ok(second.assistant.content.includes('MOCK vision'));
      assert.deepEqual(second.imagesUsed, [stored.id], 'follow-up must reuse the previously uploaded image');
      assert.equal(calls.length, 2, 'second generation must also call the vision provider with the image');
      fs.rmSync(attDir, { recursive: true, force: true });
    } finally { tmp.cleanup(); }
  });

  it('no vision provider returns an honest capability error and saves no fake answer', async () => {
    const tmp = makeTempDb();
    try {
      chat.initChatTables(tmp.db);
      attachments.initAttachmentsTables(tmp.db);
      const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb16-att-'));
      const conv = chat.createConversation(tmp.db, 'No vision');
      const stored = attachments.storeAttachment(tmp.db, attDir, { conversationId: conv.id, originalFilename: 'photo.png', declaredContentType: 'image/png', buffer: PNG });
      chat.addMessage(tmp.db, conv.id, 'user', 'What is this?', [stored.id]);
      const providers = { gemini: mockText([]), ollama: mockText([]) }; // neither declares vision
      await assert.rejects(
        () => chat.generateReply({ db: tmp.db, attachmentsDir: attDir, conversationId: conv.id, providers, allowPaid: false }),
        (err) => err.code === 'VISION_NOT_AVAILABLE' && err.status === 503
      );
      const got = chat.getConversation(tmp.db, conv.id);
      assert.equal(got.messages.length, 1, 'no fake assistant answer must be saved on vision failure');
      assert.equal(got.messages[0].role, 'user');
      fs.rmSync(attDir, { recursive: true, force: true });
    } finally { tmp.cleanup(); }
  });

  it('retry replaces an assistant message only after successful generation; failed retry keeps the original', async () => {
    const tmp = makeTempDb();
    try {
      chat.initChatTables(tmp.db);
      attachments.initAttachmentsTables(tmp.db);
      const attDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb16-att-'));
      const conv = chat.createConversation(tmp.db, 'Retry chat');
      chat.addMessage(tmp.db, conv.id, 'user', 'Hello');
      const old = chat.addMessage(tmp.db, conv.id, 'assistant', 'Old answer', [], 'mock-text');
      const calls = [];
      const providers = { gemini: mockText(calls), ollama: mockText([]) };
      const retried = await chat.retryAssistantMessage({ db: tmp.db, attachmentsDir: attDir, conversationId: conv.id, messageId: old.id, providers, allowPaid: false });
      assert.equal(retried.assistant.content, 'MOCK text reply.');
      assert.notEqual(retried.assistant.id, old.id);
      const got = chat.getConversation(tmp.db, conv.id);
      assert.deepEqual(got.messages.map((m) => m.content), ['Hello', 'MOCK text reply.']);
      // Failed retry: mock that fails, original must survive.
      const failing = { id: 'mock-fail', supportsVision: false, generateContent: async () => ({ ok: false, error: 'boom' }) };
      const old2 = chat.addMessage(tmp.db, conv.id, 'assistant', 'Keep me', [], 'mock-text');
      await assert.rejects(() => chat.retryAssistantMessage({ db: tmp.db, attachmentsDir: attDir, conversationId: conv.id, messageId: old2.id, providers: { gemini: failing }, allowPaid: false }));
      const got2 = chat.getConversation(tmp.db, conv.id);
      assert.ok(got2.messages.some((m) => m.content === 'Keep me'), 'failed retry must not delete the original answer');
      fs.rmSync(attDir, { recursive: true, force: true });
    } finally { tmp.cleanup(); }
  });
});

describe('1.6 unit: Gemini provider sends image bytes as inlineData, and blocks paid vision models', () => {
  it('generateContent with images sends inlineData, not a filename; paid model is blocked before fetch', async () => {
    const origFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url, opts) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'MOCK gemini vision answer' }] }, finishReason: 'STOP' }] }) };
    };
    try {
      const result = await PROVIDERS.gemini.generateContent({ prompt: 'What is this?', images: [{ mimeType: 'image/png', dataBase64: PNG.toString('base64') }], key: 'test-key' });
      assert.equal(result.ok, true);
      assert.equal(fetchCalls.length, 1);
      const parts = fetchCalls[0].body.contents[0].parts;
      assert.equal(parts[0].text, 'What is this?');
      assert.equal(parts[1].inlineData.mimeType, 'image/png');
      assert.equal(parts[1].inlineData.data, PNG.toString('base64'), 'inlineData must be the actual image bytes');
      // Paid model with images: zero fetch calls.
      fetchCalls.length = 0;
      const blocked = await PROVIDERS.gemini.generateContent({ prompt: 'x', model: 'gemini-2.5-pro', images: [{ mimeType: 'image/png', dataBase64: PNG.toString('base64') }], key: 'test-key', allowPaid: false });
      assert.equal(blocked.ok, false);
      assert.equal(fetchCalls.length, 0, 'paid vision model must be blocked before any provider call');
    } finally { global.fetch = origFetch; }
  });
});

describe('1.6 HTTP: full backend flow, including server restart persistence', () => {
  it('steps 1-5, 8-10: create, message, retrieve, upload, bytes, restart, invalid and cross-conversation cases', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb16-http-'));
    const dbPath = path.join(dir, 'beyond.db');
    const attDir = path.join(dir, 'att');
    let srv = await startIntegrationServer(dbPath, attDir);
    try {
      // 1. Create a conversation.
      const created = await httpJson(srv.baseUrl, 'POST', '/api/conversations', { title: 'HTTP chat' });
      assert.equal(created.status, 201);
      const convId = created.json.conversation.id;
      // 2. Send a message and save it (no provider key in this environment,
      // so /api/chat must return an honest error, not a fake answer).
      const userMsg = await httpJson(srv.baseUrl, 'POST', `/api/conversations/${convId}/messages`, { role: 'user', content: 'Hello HTTP' });
      assert.equal(userMsg.status, 201);
      const chatErr = await httpJson(srv.baseUrl, 'POST', '/api/chat', { conversation_id: convId, content: 'Reply please' });
      assert.equal(chatErr.status, 503, 'without a provider key, chat must return an honest error, not a fake answer');
      assert.ok(chatErr.json.user_message, 'user message must still be saved on provider failure');
      // 3. Refresh and retrieve the same conversation.
      const retrieved = await httpJson(srv.baseUrl, 'GET', `/api/conversations/${convId}/messages`, undefined);
      assert.equal(retrieved.status, 200);
      assert.deepEqual(retrieved.json.messages.map((m) => m.content), ['Hello HTTP', 'Reply please']);
      // 4. Upload an image via multipart FormData.
      const form = new FormData();
      form.append('file', new Blob([PNG], { type: 'image/png' }), 'photo.png');
      form.append('conversation_id', String(convId));
      const upRes = await fetch(srv.baseUrl + '/api/chat/attachments', { method: 'POST', headers: { 'X-Requested-With': 'beyond' }, body: form });
      assert.equal(upRes.status, 201, 'multipart upload must succeed');
      const upJson = await upRes.json();
      const attId = upJson.attachment.id;
      assert.ok(/^att_[0-9a-f]{32}$/.test(attId));
      // 5. Retrieve its actual bytes via the same-origin content URL.
      const contentRes = await fetch(srv.baseUrl + `/api/chat/attachments/${attId}/content`);
      assert.equal(contentRes.status, 200);
      assert.equal(contentRes.headers.get('content-type'), 'image/png');
      assert.equal(contentRes.headers.get('x-content-type-options'), 'nosniff');
      const bytes = Buffer.from(await contentRes.arrayBuffer());
      assert.ok(bytes.equals(PNG), 'content endpoint must return the exact uploaded bytes');
      // CSP: homepage must allow same-origin images.
      const home = await fetch(srv.baseUrl + '/');
      const csp = home.headers.get('content-security-policy') || '';
      assert.ok(csp.includes("img-src 'self'"), 'homepage CSP must allow same-origin image previews');
      // 10a. Invalid file via raw upload.
      const badRes = await fetch(srv.baseUrl + '/api/chat/attachments', { method: 'POST', headers: { 'X-Requested-With': 'beyond', 'Content-Type': 'image/png', 'X-Filename': 'evil.png' }, body: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) });
      assert.equal(badRes.status, 400, 'signature mismatch must be rejected');
      // 10b. Oversized upload via raw upload.
      const bigRes = await fetch(srv.baseUrl + '/api/chat/attachments', { method: 'POST', headers: { 'X-Requested-With': 'beyond', 'Content-Type': 'image/png', 'X-Filename': 'big.png' }, body: Buffer.alloc(attachments.MAX_ATTACHMENT_BYTES + 1, 0) });
      assert.equal(bigRes.status, 413, 'oversized upload must be rejected');
      // 10c. Path traversal in attachment id.
      const trav = await httpJson(srv.baseUrl, 'GET', '/api/chat/attachments/att_..%2F..%2Fetc', undefined);
      assert.ok(trav.status === 400 || trav.status === 404, 'traversal id must not reach the filesystem');
      // 10d. Cross-conversation attachment access.
      const conv2 = await httpJson(srv.baseUrl, 'POST', '/api/conversations', { title: 'Second HTTP chat' });
      const cross = await httpJson(srv.baseUrl, 'POST', `/api/conversations/${conv2.json.conversation.id}/messages`, { role: 'user', content: 'Steal', attachment_ids: [attId] });
      assert.equal(cross.status, 403, 'attachment from another conversation must be rejected');
      // 8. Restart the server on the same database and attachments directory.
      await srv.close();
      srv = await startIntegrationServer(dbPath, attDir);
      const afterRestart = await httpJson(srv.baseUrl, 'GET', `/api/conversations/${convId}`, undefined);
      assert.equal(afterRestart.status, 200);
      assert.equal(afterRestart.json.conversation.title, 'HTTP chat');
      assert.ok(afterRestart.json.conversation.messages.length >= 2, 'messages must survive a restart');
      const contentAfter = await fetch(srv.baseUrl + `/api/chat/attachments/${attId}/content`);
      const bytesAfter = Buffer.from(await contentAfter.arrayBuffer());
      assert.ok(bytesAfter.equals(PNG), 'attachment bytes must survive a restart');
      // 9. Multiple conversations and images are independent.
      const list = await httpJson(srv.baseUrl, 'GET', '/api/conversations', undefined);
      assert.ok(list.json.conversations.length >= 2);
      const attList = await httpJson(srv.baseUrl, 'GET', `/api/chat/attachments?conversation_id=${convId}`, undefined);
      assert.equal(attList.json.attachments.length, 1);
      assert.equal(attList.json.attachments[0].id, attId);
    } finally {
      await srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
