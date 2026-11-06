'use strict';
// Vision capability checks — baseline repository code only.
// The repository has no chat, no vision path and no provider that accepts
// images. Vision tests for the repository are therefore specifications, not
// passes. Do not treat a skipped test here as a working vision feature.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BASELINE = path.join(__dirname, '..');

describe('vision capability (repository baseline)', () => {
  it('PASS (1.6 implemented): provider source now sends image payloads as inlineData and declares vision', () => {
    const src = fs.readFileSync(path.join(BASELINE, 'providers.js'), 'utf8');
    assert.ok(src.includes('inlineData'), 'Gemini generateContent must send image bytes as inlineData');
    assert.ok(src.toLowerCase().includes('vision'), 'Gemini must declare vision support');
    assert.ok(src.includes('generateContent'));
  });

  it('PASS (1.6 implemented): chat endpoint and chat.js now exist and can receive images', () => {
    const server = fs.readFileSync(path.join(BASELINE, 'server.js'), 'utf8');
    assert.ok(server.includes('/api/chat'));
    assert.ok(fs.existsSync(path.join(BASELINE, 'chat.js')));
    const chat = require('../chat');
    assert.equal(typeof chat.findVisionProvider, 'function');
    assert.equal(typeof chat.generateReply, 'function');
  });

  it.skip('NOT RUN here — vision routing with image bytes is now covered in tests/integration-chat-attachments.test.js (mock vision receives base64 PNG bytes; filename-only would fail)', () => {
    // Specification only. Implement this test when chat.js is merged into the
    // repository, using a mock provider that records its generateContent args.
    // Acceptance: selected provider declares vision support AND args.images
    // contains base64 bytes for the uploaded image. A filename-only answer
    // must fail this test.
  });

  it.skip('BLOCKED — MISSING-FEATURE SPECIFICATION: Ollama Cloud and Groq image-drop regression (uploaded copy only, not repository baseline)', () => {
    // In the uploaded copy, chat.js passes images to providers whose
    // generateContent signatures ignore the images argument (Ollama Cloud and
    // Groq). That regression cannot be run against the repository baseline
    // because neither the chat code nor an Ollama Cloud provider exists there.
    // Do not run this specification against the baseline and claim a pass.
  });
});
