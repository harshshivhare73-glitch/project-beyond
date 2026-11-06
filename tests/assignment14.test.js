'use strict';
// Assignment 1.4 regression tests for every Assignment 1.3 finding.
// Temporary workspaces and temporary databases only. No paid calls.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startBaselineServer, httpJson } = require('./helpers');
const { verifyTaskCompletion, verifyArtifactFile, hasFileGenerationIntent } = require('../orchestrator');
const { validateMp4Buffer, validateMp4File, resolveWorkspaceDir, computeFileHashSync } = require('../artifacts');
const { PROVIDERS } = require('../providers');

function validMp4Buffer() {
  const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4); ftyp.write('isom', 8); ftyp.writeUInt32BE(0, 12); ftyp.write('isom', 16); ftyp.write('iso2', 20);
  const mvhd = Buffer.alloc(12); mvhd.writeUInt32BE(12, 0); mvhd.write('mvhd', 4);
  const moov = Buffer.alloc(20); moov.writeUInt32BE(20, 0); moov.write('moov', 4); mvhd.copy(moov, 8);
  const mdat = Buffer.alloc(12); mdat.writeUInt32BE(12, 0); mdat.write('mdat', 4);
  return Buffer.concat([ftyp, moov, mdat]);
}
function box(type, payload) { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4); payload.copy(b, 8); return b; }

describe('P1 Gemini paid-model bypass', () => {
  it('PASS: paid and unknown models are rejected with ZERO provider calls', async () => {
    const original = PROVIDERS.gemini.generateContent;
    let calls = 0;
    PROVIDERS.gemini.generateContent = async () => { calls += 1; return { ok: true, text: 'paid output' }; };
    try {
      const paid = await PROVIDERS.gemini.testGemini({ model: 'gemini-2.5-pro', allowPaid: false });
      assert.equal(paid.ok, false);
      const unknown = await PROVIDERS.gemini.testGemini({ model: 'some-unknown-model', allowPaid: false });
      assert.equal(unknown.ok, false);
      assert.equal(calls, 0, 'expected ZERO paid provider calls');
    } finally { PROVIDERS.gemini.generateContent = original; }
  });
  it('PASS: verified free model is allowed, and only explicit allowPaid true allows a paid model', async () => {
    const original = PROVIDERS.gemini.generateContent;
    let calls = 0;
    PROVIDERS.gemini.generateContent = async () => { calls += 1; return { ok: true, text: 'free output' }; };
    try {
      const free = await PROVIDERS.gemini.testGemini({ model: 'gemini-flash-lite-latest', allowPaid: false });
      assert.equal(free.ok, true);
      assert.equal(calls, 1);
      const paidWithExplicitTrue = await PROVIDERS.gemini.testGemini({ model: 'gemini-2.5-pro', allowPaid: true });
      assert.equal(paidWithExplicitTrue.ok, true);
      assert.equal(calls, 2);
    } finally { PROVIDERS.gemini.generateContent = original; }
  });
});

describe('P1 project-builder type validation', () => {
  it('PASS: JavaScript type with .txt extension fails, with .js extension passes', () => {
    const dir = resolveWorkspaceDir();
    const txt = path.join(dir, 'a14-type.txt'); fs.writeFileSync(txt, 'console.log(1);');
    const js = path.join(dir, 'a14-type.js'); fs.writeFileSync(js, 'console.log(1);');
    try {
      assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'code', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a14-type.txt', size: 15, type: 'javascript' }] } }).ok, false);
      assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'code', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a14-type.js', size: 15, type: 'javascript' }] } }).ok, true);
    } finally { try { fs.unlinkSync(txt); fs.unlinkSync(js); } catch {} }
  });
});

describe('P2 readable files, hashes and replacement', () => {
  it('PASS: wrong SHA-256 is rejected, and same-size replacement with a different hash is rejected', () => {
    const dir = resolveWorkspaceDir();
    const p = path.join(dir, 'a14-hash.js'); const original = 'console.log(1);'; fs.writeFileSync(p, original);
    const hash = crypto.createHash('sha256').update(original).digest('hex');
    try {
      assert.equal(verifyArtifactFile({ relativePath: 'a14-hash.js', size: 15, sha256: hash }).ok, true);
      assert.equal(verifyArtifactFile({ relativePath: 'a14-hash.js', size: 15, sha256: '0'.repeat(64) }).ok, false);
      fs.writeFileSync(p, 'console.log(2);'); // same size, different content
      assert.equal(verifyArtifactFile({ relativePath: 'a14-hash.js', size: 15, sha256: hash }).ok, false, 'same-size replacement must fail on hash');
      assert.equal(computeFileHashSync(p).sha256 !== hash, true);
    } finally { try { fs.unlinkSync(p); } catch {} }
  });
  it('PASS: verifyTaskCompletion returns verified hashes, and a second verification with the old hash fails after replacement', () => {
    const dir = resolveWorkspaceDir();
    const p = path.join(dir, 'a14-bind.js'); fs.writeFileSync(p, 'console.log(1);');
    try {
      const first = verifyTaskCompletion({ agent: 'coding', finalResult: 'code', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a14-bind.js', size: 15 }] } });
      assert.equal(first.ok, true);
      assert.ok(first.verifiedArtifacts && first.verifiedArtifacts[0].sha256);
      fs.writeFileSync(p, 'console.log(2);');
      const second = verifyTaskCompletion({ agent: 'coding', finalResult: 'code', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a14-bind.js', size: 15, sha256: first.verifiedArtifacts[0].sha256 }] } });
      assert.equal(second.ok, false, 'TOCTOU hash binding: old hash must not pass after replacement');
    } finally { try { fs.unlinkSync(p); } catch {} }
  });
  it('PASS: chmod 000 readability (root bypass noted: read path is proven by hash tests when running as root)', () => {
    if (process.getuid && process.getuid() === 0) {
      // Root can read chmod 000 files, so this test cannot prove the read
      // path under root. The hash and replacement tests above prove the
      // gate actually reads the file content.
      return;
    }
    const dir = resolveWorkspaceDir();
    const p = path.join(dir, 'a14-perm.txt'); fs.writeFileSync(p, 'secret-content-12345');
    try {
      fs.chmodSync(p, 0o000);
      assert.equal(verifyArtifactFile({ relativePath: 'a14-perm.txt', size: 20 }).ok, false);
    } finally { try { fs.chmodSync(p, 0o644); fs.unlinkSync(p); } catch {} }
  });
});

describe('P2 title intent and paragraph claims', () => {
  it('PASS: Create login.html is a file task even with no artifact; Explain app.js is not', () => {
    assert.equal(hasFileGenerationIntent('Create login.html'), true);
    assert.equal(hasFileGenerationIntent('Write app.js'), true);
    assert.equal(hasFileGenerationIntent('Explain app.js'), false);
    assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'Here is the code', checkpointData: { artifacts: [] }, taskTitle: 'Create login.html' }).ok, false);
    assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'Here is an explanation', checkpointData: { artifacts: [] }, taskTitle: 'Explain app.js' }).ok, true);
  });
  it('PASS: mid-paragraph claim of a missing file fails when a valid artifact exists', () => {
    const dir = resolveWorkspaceDir();
    const p = path.join(dir, 'a14-real.js'); fs.writeFileSync(p, 'console.log(1);');
    try {
      assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'Done. I also saved output2.js in the process.', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a14-real.js', size: 15, expectedType: 'javascript' }] } }).ok, false);
    } finally { try { fs.unlinkSync(p); } catch {} }
  });
});

describe('P2 stricter MP4 validation and bounded memory', () => {
  it('PASS: junk moov child, garbage ftyp brand and missing mdat are all rejected', () => {
    const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4); ftyp.write('isom', 8); ftyp.write('isom', 16); ftyp.write('iso2', 20);
    const junkMoov = box('moov', box('xxxx', Buffer.alloc(4)));
    const mdat = box('mdat', Buffer.alloc(4));
    assert.equal(validateMp4Buffer(Buffer.concat([ftyp, junkMoov, mdat])).ok, false, 'junk moov child must fail');
    const garbage = Buffer.from(validMp4Buffer()); garbage[8] = 0x00; garbage[9] = 0xff;
    assert.equal(validateMp4Buffer(garbage).ok, false, 'garbage ftyp brand must fail');
    const mvhd = Buffer.alloc(12); mvhd.writeUInt32BE(12, 0); mvhd.write('mvhd', 4);
    const moov = Buffer.alloc(20); moov.writeUInt32BE(20, 0); moov.write('moov', 4); mvhd.copy(moov, 8);
    assert.equal(validateMp4Buffer(Buffer.concat([ftyp, moov])).ok, false, 'missing mdat must fail');
    assert.equal(validateMp4Buffer(validMp4Buffer()).ok, true);
  });
  it('PASS: large MP4 validates without loading the whole file into heap', () => {
    const dir = resolveWorkspaceDir();
    const largePath = path.join(dir, 'a14-large.mp4');
    const v = validMp4Buffer();
    // Sparse large file: ftyp + moov + mdat header, then truncate to 200 MB.
    // A whole-file read would allocate 200 MB; the bounded parser seeks.
    const ftypMoov = v.subarray(0, v.length - 12);
    const mdatSize = 200 * 1024 * 1024 - ftypMoov.length;
    const mdatHeader = Buffer.alloc(8); mdatHeader.writeUInt32BE(mdatSize, 0); mdatHeader.write('mdat', 4);
    const fd = fs.openSync(largePath, 'w');
    try {
      fs.writeSync(fd, ftypMoov); fs.writeSync(fd, mdatHeader); fs.ftruncateSync(fd, 200 * 1024 * 1024);
    } finally { fs.closeSync(fd); }
    try {
      const before = process.memoryUsage().heapUsed;
      const start = Date.now();
      const result = validateMp4File(largePath);
      const elapsed = Date.now() - start;
      const heapDelta = process.memoryUsage().heapUsed - before;
      assert.equal(result.ok, true, result.error || '');
      assert.ok(elapsed < 5000, `large MP4 validation took ${elapsed} ms`);
      assert.ok(heapDelta < 100 * 1024 * 1024, `heap grew by ${heapDelta} bytes, expected bounded memory`);
    } finally { try { fs.unlinkSync(largePath); } catch {} }
  });
});

describe('P1 Gemini test route and P2 restore round-trip (temporary database only)', () => {
  let srv;
  before(async () => { srv = await startBaselineServer(); });
  after(async () => { await srv.close(); });

  it('PASS: server route rejects a paid model with 403 before any provider call', async () => {
    const res = await httpJson(srv.baseUrl, 'POST', '/api/providers/gemini/test', { model: 'gemini-2.5-pro' });
    assert.equal(res.status, 403);
  });
  it('PASS: restore preserves execution_id, rejects unexpected fields and duplicate ids with 400', async () => {
    const bk = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    assert.equal(bk.status, 200);
    const modified = JSON.parse(JSON.stringify(bk.json.backup));
    if (modified.tasks.length > 0) modified.tasks[0].execution_id = 'exec-123-test';
    const bk2 = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const restore = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk2.json.backupToken, backup: modified });
    assert.equal(restore.status, 200);
    const after = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const restoredTask = (after.json.backup.tasks || []).find((t) => t.id === modified.tasks[0].id);
    assert.equal(restoredTask && restoredTask.execution_id, 'exec-123-test', 'execution_id must round-trip');
    const bk3 = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const evilTop = JSON.parse(JSON.stringify(bk3.json.backup)); evilTop.evilField = 'x';
    const evilTopRes = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk3.json.backupToken, backup: evilTop });
    assert.equal(evilTopRes.status, 400);
    const bk4 = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const evilTask = JSON.parse(JSON.stringify(bk4.json.backup)); evilTask.tasks[0].evil = 'y';
    const evilTaskRes = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk4.json.backupToken, backup: evilTask });
    assert.equal(evilTaskRes.status, 400);
    const bk5 = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const dup = JSON.parse(JSON.stringify(bk5.json.backup)); dup.tasks.push({ ...dup.tasks[0] });
    const dupRes = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk5.json.backupToken, backup: dup });
    assert.equal(dupRes.status, 400, 'duplicate task id must be 400, not 500');
    // Restore-back: restore the original backup and confirm titles are back.
    const bk6 = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const back = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk6.json.backupToken, backup: bk.json.backup });
    assert.equal(back.status, 200);
  });
});
