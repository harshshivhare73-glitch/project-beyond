'use strict';
// Assignment 1.2 regression tests. All tests use temporary workspaces and
// temporary databases only. No paid calls, no real providers, no production data.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startBaselineServer, httpJson } = require('./helpers');
const { verifyTaskCompletion, verifyArtifactFile } = require('../orchestrator');
const { getVerifiedArtifactPath, validateMp4Buffer, validateMp4File, resolveWorkspaceDir } = require('../artifacts');
const { isVerifiedFreeModel, assertFreeModel, PROVIDERS } = require('../providers');
const { buildProjectFile } = require('../project_builder');

function validMp4Buffer() {
  const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4); ftyp.write('isom', 8); ftyp.writeUInt32BE(0, 12); ftyp.write('isom', 16); ftyp.write('iso2', 20);
  const mvhd = Buffer.alloc(12); mvhd.writeUInt32BE(12, 0); mvhd.write('mvhd', 4);
  const moov = Buffer.alloc(20); moov.writeUInt32BE(20, 0); moov.write('moov', 4); mvhd.copy(moov, 8);
  const mdat = Buffer.alloc(12); mdat.writeUInt32BE(12, 0); mdat.write('mdat', 4);
  return Buffer.concat([ftyp, moov, mdat]);
}

describe('P0 artifact path security', () => {
  let dir;
  before(() => { dir = resolveWorkspaceDir(); });
  after(() => { for (const f of ['a12-normal.txt', 'a12-inside.txt', 'a12-link-inside.txt', 'a12-link-outside.txt']) { try { fs.unlinkSync(path.join(dir, f)); } catch {} } });

  it('PASS: normal relative file path verifies', () => {
    fs.writeFileSync(path.join(dir, 'a12-normal.txt'), 'hello');
    assert.equal(verifyArtifactFile({ relativePath: 'a12-normal.txt', size: 5 }).ok, true);
  });
  it('PASS: ../ traversal is rejected', () => {
    assert.equal(verifyArtifactFile({ relativePath: '../outside.txt', size: 5 }).ok, false);
  });
  it('PASS: absolute external path is rejected (relativePath must be used, absolutePath is never trusted)', () => {
    const outside = path.join(os.tmpdir(), 'a12-outside.txt'); fs.writeFileSync(outside, 'outside');
    try {
      assert.equal(verifyArtifactFile({ relativePath: 'a12-normal.txt', absolutePath: outside, size: 5 }).ok, true, 'a valid relative file still passes even if an absolutePath field is present, because absolutePath is ignored and the recorded size matches the real file');
      assert.equal(verifyArtifactFile({ relativePath: 'a12-missing.txt', absolutePath: outside, size: 7 }).ok, false, 'absolutePath alone must not satisfy verification when the relative file is missing');
    } finally { try { fs.unlinkSync(outside); } catch {} }
  });
  it('PASS: symlink pointing outside workspace is rejected', () => {
    const outside = path.join(os.tmpdir(), 'a12-outside2.txt'); fs.writeFileSync(outside, 'outside');
    const link = path.join(dir, 'a12-link-outside.txt');
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(outside, link);
    try { assert.equal(verifyArtifactFile({ relativePath: 'a12-link-outside.txt', size: 7 }).ok, false); } finally { try { fs.unlinkSync(link); fs.unlinkSync(outside); } catch {} }
  });
  it('PASS: symlink pointing inside workspace is allowed', () => {
    fs.writeFileSync(path.join(dir, 'a12-inside.txt'), 'inside');
    const link = path.join(dir, 'a12-link-inside.txt');
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(path.join(dir, 'a12-inside.txt'), link);
    assert.equal(verifyArtifactFile({ relativePath: 'a12-link-inside.txt', size: 6 }).ok, true);
  });
  it('PASS: missing file is rejected safely', () => {
    assert.equal(verifyArtifactFile({ relativePath: 'a12-does-not-exist.txt', size: 5 }).ok, false);
  });
  it('PASS: Windows-style paths are rejected', () => {
    assert.throws(() => getVerifiedArtifactPath(null, '..\\outside.txt'));
    assert.throws(() => getVerifiedArtifactPath(null, 'C:\\temp\\evil.txt'));
    assert.throws(() => getVerifiedArtifactPath(null, 'C:/temp/evil.txt'));
    assert.throws(() => getVerifiedArtifactPath(null, 'folder\\file.txt'));
  });
});

describe('P0 MP4 structural validation (not playback verification)', () => {
  it('PASS: structurally valid MP4 (ftyp + moov, correct box sizes) passes', () => {
    assert.equal(validateMp4Buffer(validMp4Buffer()).ok, true);
  });
  it('PASS: plain text renamed to .mp4 is rejected', () => {
    assert.equal(validateMp4Buffer(Buffer.from('Hello world, this is a text file')) .ok, false);
  });
  it('PASS: random corrupt bytes are rejected', () => {
    assert.equal(validateMp4Buffer(Buffer.from('this is definitely not a video file, just random text bytes')).ok, false);
  });
  it('PASS: truncated MP4 (moov box size exceeds file length) is rejected', () => {
    const full = validMp4Buffer();
    assert.equal(validateMp4Buffer(full.subarray(0, full.length - 10)).ok, false);
  });
  it('PASS: ftyp-only file (minimal fake header, no moov) is rejected', () => {
    const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4); ftyp.write('isom', 8);
    assert.equal(validateMp4Buffer(ftyp).ok, false);
  });
  it('PASS: empty file is rejected', () => {
    assert.equal(validateMp4Buffer(Buffer.alloc(0)).ok, false);
  });
  it('PASS: video completion gate rejects text-as-MP4 and accepts valid MP4', () => {
    const dir = resolveWorkspaceDir();
    const badPath = path.join(dir, 'a12-bad.mp4'); fs.writeFileSync(badPath, 'not a video');
    const goodPath = path.join(dir, 'a12-good.mp4'); const good = validMp4Buffer(); fs.writeFileSync(goodPath, good);
    try {
      assert.equal(verifyTaskCompletion({ agent: 'video', finalResult: 'Storyboard', checkpointData: { artifacts: [{ relativePath: 'a12-bad.mp4', size: 11 }] } }).ok, false);
      assert.equal(verifyTaskCompletion({ agent: 'video', finalResult: 'Storyboard', checkpointData: { artifacts: [{ relativePath: 'a12-good.mp4', size: good.length }] } }).ok, true);
      assert.equal(validateMp4File(goodPath).ok, true);
    } finally { try { fs.unlinkSync(badPath); fs.unlinkSync(goodPath); } catch {} }
  });
});

describe('P0 file-task completion', () => {
  it('PASS: file task with empty artifact list fails, text-only task with real text passes', () => {
    assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'console.log(1);', checkpointData: { fileTaskExpected: true, artifacts: [] } }).ok, false);
    assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'console.log(1);', checkpointData: { artifacts: [] } }).ok, true);
  });
  it('PASS: wrong file type fails when expected type is recorded', () => {
    const dir = resolveWorkspaceDir();
    const p = path.join(dir, 'a12-wrong.txt'); fs.writeFileSync(p, 'console.log(1);');
    try {
      assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'code', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a12-wrong.txt', size: 15, expectedType: 'javascript' }] } }).ok, false);
    } finally { try { fs.unlinkSync(p); } catch {} }
  });
  it('PASS: text claiming a file without a real file fails', () => {
    assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'File saved: a12-claimed.js', checkpointData: { fileTaskExpected: true, artifacts: [] } }).ok, false);
  });
  it('PASS: recorded size mismatch fails', () => {
    const dir = resolveWorkspaceDir();
    const p = path.join(dir, 'a12-size.js'); fs.writeFileSync(p, 'console.log(1);');
    try {
      assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'code', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a12-size.js', size: 999, expectedType: 'javascript' }] } }).ok, false);
      assert.equal(verifyTaskCompletion({ agent: 'coding', finalResult: 'code', checkpointData: { fileTaskExpected: true, artifacts: [{ relativePath: 'a12-size.js', size: 15, expectedType: 'javascript' }] } }).ok, true);
    } finally { try { fs.unlinkSync(p); } catch {} }
  });
});

describe('P1 allowPaid and OpenRouter guard', () => {
  it('PASS: OpenRouter generation is not enabled and throws a clear guard error', async () => {
    await assert.rejects(() => PROVIDERS.openrouter.generateContent({ prompt: 'hi' }), /not implemented/);
  });
  it('PASS: only verified :free models pass the model check, unknown and paid models fail closed', () => {
    assert.equal(isVerifiedFreeModel('deepseek-r1:free'), true);
    assert.equal(isVerifiedFreeModel('gpt-4o'), false);
    assert.equal(isVerifiedFreeModel('unknown-model'), false);
    assert.equal(isVerifiedFreeModel(null), false);
    assert.throws(() => assertFreeModel('gpt-4o'));
    assert.doesNotThrow(() => assertFreeModel('llama-3.3-70b:free'));
  });
  it('PASS: project builder never calls a paid provider when allowPaid is false, and falls back to a template', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-a12-'));
    let calls = 0;
    const paid = { id: 'deepseek', generateContent: async () => { calls += 1; return { ok: true, text: 'paid code' }; } };
    try {
      const rec = await buildProjectFile({ fileItem: { path: 'a12-template.js', type: 'js', description: 'test file', dependencies: [] }, projectSpec: { goal: 'test project', projectName: 'test' }, provider: paid, workspaceDir: tmp, allowOverwrite: true, allowPaid: false });
      assert.equal(calls, 0);
      assert.equal(rec.size > 0, true);
      assert.equal(fs.existsSync(path.join(tmp, 'a12-template.js')), true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('P1 backup restore (temporary database only)', () => {
  let srv;
  before(async () => { srv = await startBaselineServer(); });
  after(async () => { await srv.close(); });

  it('PASS: valid restore returns the old tasks and a pre-restore backup that can restore back', async () => {
    const created = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Restore target task', agent: 'coding', priority: 'High' });
    assert.equal(created.status, 201);
    const bk = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    assert.equal(bk.status, 200);
    assert.ok(!(JSON.stringify(bk.json.backup).includes('API_KEY') || JSON.stringify(bk.json.backup).includes('api_key')), 'backup must not expose provider keys');
    assert.ok(bk.json.backup.settings.every((s) => s.key === 'freeFirst' || s.key === 'seeded'));
    await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Task to be undone by restore', agent: 'coding', priority: 'Medium' });
    const bk2 = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const restore = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk2.json.backupToken, backup: bk.json.backup });
    assert.equal(restore.status, 200);
    assert.ok((restore.json.preRestoreBackup.tasks || []).some((t) => t.title === 'Task to be undone by restore'));
    const state = await httpJson(srv.baseUrl, 'GET', '/api/state');
    assert.ok((state.json.tasks || []).some((t) => t.title === 'Restore target task'));
    assert.ok(!(state.json.tasks || []).some((t) => t.title === 'Task to be undone by restore'));
  });
  it('PASS: invalid backup, missing confirm, missing header and reused token are all rejected without changing data', async () => {
    const before = await httpJson(srv.baseUrl, 'GET', '/api/state');
    const beforeTitles = (before.json.tasks || []).map((t) => t.title).sort();
    const bk = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const badBackup = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk.json.backupToken, backup: { createdAt: Date.now(), tasks: 'not-an-array', logs: [], settings: [] } });
    assert.equal(badBackup.status, 400);
    const badConfirm = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'YES', backupToken: bk.json.backupToken, backup: bk.json.backup });
    assert.equal(badConfirm.status, 403);
    const noHeader = await fetch(`${srv.baseUrl}/api/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESTORE', backupToken: bk.json.backupToken, backup: bk.json.backup }) });
    assert.equal(noHeader.status, 403);
    const bk2 = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    const ok = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk2.json.backupToken, backup: bk2.json.backup });
    assert.equal(ok.status, 200);
    const reuse = await httpJson(srv.baseUrl, 'POST', '/api/restore', { confirm: 'RESTORE', backupToken: bk2.json.backupToken, backup: bk2.json.backup });
    assert.equal(reuse.status, 403);
    const after = await httpJson(srv.baseUrl, 'GET', '/api/state');
    // The valid restore in this test restored the same data, so titles must match the before list (plus the restore log, which is not a task).
    assert.deepEqual((after.json.tasks || []).map((t) => t.title).sort(), beforeTitles);
  });
});
