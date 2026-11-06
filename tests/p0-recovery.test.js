'use strict';
// P0 recovery tests, added by Assignment 1 (not part of the original QA set).
// These prove the new protections actually work, on a temporary database,
// with mocked providers only. No paid calls, no production data.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startBaselineServer, httpJson } = require('./helpers');
const { verifyTaskCompletion } = require('../orchestrator');
const { resolveWorkspaceDir } = require('../artifacts');

describe('P0 recovery: backup, reset, explicit cascade', () => {
  let srv;
  before(async () => { srv = await startBaselineServer(); });
  after(async () => { await srv.close(); });

  it('PASS: backup then confirmed reset wipes, but the backup contains the original task, and the token is single-use', async () => {
    const created = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Task to back up', agent: 'coding', priority: 'High' });
    assert.equal(created.status, 201);
    const backup = await httpJson(srv.baseUrl, 'GET', '/api/backup');
    assert.equal(backup.status, 200);
    assert.ok(backup.json.backupToken, 'backup must issue a token');
    assert.ok((backup.json.backup.tasks || []).some((t) => t.title === 'Task to back up'));
    const reset = await httpJson(srv.baseUrl, 'POST', '/api/reset', { confirm: 'RESET', backupToken: backup.json.backupToken });
    assert.equal(reset.status, 200);
    assert.ok((reset.json.backup.tasks || []).some((t) => t.title === 'Task to back up'));
    const state = await httpJson(srv.baseUrl, 'GET', '/api/state');
    assert.ok(!(state.json.tasks || []).some((t) => t.title === 'Task to back up'), 'after a confirmed reset the original task is gone, as intended');
    const reuse = await httpJson(srv.baseUrl, 'POST', '/api/reset', { confirm: 'RESET', backupToken: backup.json.backupToken });
    assert.equal(reuse.status, 403, 'backup token must be single-use');
  });

  it('PASS: explicit cascade delete removes parent and children only when both flags are present', async () => {
    const parent = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Cascade parent', agent: 'workflow', priority: 'Medium' });
    const parentId = parent.json.id;
    const child = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Cascade child', agent: 'coding', priority: 'Medium', parent_id: parentId });
    assert.equal(child.status, 201);
    const blocked = await httpJson(srv.baseUrl, 'DELETE', `/api/tasks/${parentId}`, { deleteChildren: true });
    assert.equal(blocked.status, 409, 'deleteChildren without confirm must still be blocked');
    const ok = await httpJson(srv.baseUrl, 'DELETE', `/api/tasks/${parentId}`, { deleteChildren: true, confirm: 'DELETE_CHILDREN' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.deletedChildren, [child.json.id]);
    const state = await httpJson(srv.baseUrl, 'GET', '/api/state');
    assert.ok(!(state.json.tasks || []).some((t) => t.title === 'Cascade child'));
  });
});

describe('P0 completion gate: verifyTaskCompletion unit checks', () => {
  it('PASS: video with a real MP4 artifact on disk passes, video without one fails', () => {
    // Updated for Assignment 1.2: the fixture must now be a structurally
    // valid MP4 (ftyp + moov with valid box sizes), not just 16 zero bytes,
    // because the gate now validates MP4 structure. This is a stricter
    // fixture, not a weakened test.
    const dir = resolveWorkspaceDir();
    const tmpFile = path.join(dir, 'p0-test-video.mp4');
    const ftyp = Buffer.alloc(24); ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4); ftyp.write('isom', 8); ftyp.writeUInt32BE(0, 12); ftyp.write('isom', 16); ftyp.write('iso2', 20);
    const mvhd = Buffer.alloc(12); mvhd.writeUInt32BE(12, 0); mvhd.write('mvhd', 4);
    const moov = Buffer.alloc(20); moov.writeUInt32BE(20, 0); moov.write('moov', 4); mvhd.copy(moov, 8);
    const mdat = Buffer.alloc(12); mdat.writeUInt32BE(12, 0); mdat.write('mdat', 4);
    const mp4 = Buffer.concat([ftyp, moov, mdat]);
    fs.writeFileSync(tmpFile, mp4);
    try {
      const ok = verifyTaskCompletion({ agent: 'video', finalResult: 'Storyboard text', checkpointData: { artifacts: [{ relativePath: 'p0-test-video.mp4', size: mp4.length }] } });
      assert.equal(ok.ok, true);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
    const bad = verifyTaskCompletion({ agent: 'video', finalResult: 'Storyboard text', checkpointData: { artifacts: [] } });
    assert.equal(bad.ok, false);
  });

  it('PASS: file task with a missing recorded file fails, text task with real text passes', () => {
    const bad = verifyTaskCompletion({ agent: 'coding', finalResult: 'console.log(1);', checkpointData: { artifacts: [{ relativePath: 'p0-does-not-exist.js', size: 10 }] } });
    assert.equal(bad.ok, false);
    const ok = verifyTaskCompletion({ agent: 'coding', finalResult: 'console.log(1);', checkpointData: { artifacts: [] } });
    assert.equal(ok.ok, true);
    const empty = verifyTaskCompletion({ agent: 'research', finalResult: 'Task completed successfully.', checkpointData: {} });
    assert.equal(empty.ok, false, 'generic fallback string is not a valid result');
  });

  it('PASS: paid provider ids are classified as paid, free ids as free, unknown as paid', () => {
    const { isPaidProvider } = require('../providers');
    assert.equal(isPaidProvider('deepseek'), true);
    assert.equal(isPaidProvider('openai'), true);
    assert.equal(isPaidProvider('anthropic'), true);
    assert.equal(isPaidProvider('gemini'), false);
    assert.equal(isPaidProvider('ollama'), false);
    assert.equal(isPaidProvider('unknown-provider-xyz'), true, 'unknown providers must fail closed');
  });
});
