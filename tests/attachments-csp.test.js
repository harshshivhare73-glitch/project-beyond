'use strict';
// Attachment persistence and CSP — Assignment 1.6 integration workspace.
// NOTE (disclosed change, see README-INTEGRATION.md and docs/API.md):
// The old FAIL-EXPECTED test asserted CSP contains `blob:`. That
// expectation is superseded by the same-origin preview design: attachments
// are previewed via /api/chat/attachments/:id/content on the same origin,
// with img-src 'self' in the homepage CSP. Adding blob: would not make
// stored attachments previewable and would weaken the CSP for no benefit.
// This test therefore asserts img-src 'self', not blob:.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startBaselineServer, httpJson } = require('./helpers');

describe('attachments and CSP (integration workspace)', () => {
  let srv;
  before(async () => { srv = await startBaselineServer(); });
  after(async () => { await srv.close(); });

  it('PASS: homepage returns 200 and a CSP header', async () => {
    const res = await fetch(`${srv.baseUrl}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header must be present');
    assert.ok(csp.includes("default-src 'none'"));
  });

  it('PASS (1.6 design): CSP allows same-origin image previews via img-src self', async () => {
    const res = await fetch(`${srv.baseUrl}/`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("img-src 'self'"), 'CSP must allow same-origin image previews for attachment content URLs');
  });

  it('PASS (1.6): chat attachment list endpoint exists', async () => {
    const res = await httpJson(srv.baseUrl, 'GET', '/api/chat/attachments', undefined);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.attachments));
  });

  it.skip('NOT RUN here — attachment persistence across refresh is covered in tests/integration-chat-attachments.test.js (upload, restart, retrieve same id and bytes)', () => {});
});
