'use strict';
// Task completion and progress verification — baseline repository code only.
// Mock providers only. No network, no paid calls, temporary SQLite only.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDb, insertTask, getTask, mockProvider } = require('./helpers');
const { initOrchestrator, executeOrchestratedTask } = require('../orchestrator');

describe('task completion', () => {
  let ctx;
  before(() => { ctx = makeTempDb(); });
  after(() => ctx.cleanup());

  it('PASS: coding task with a mock provider completes with a result and 100% progress', async () => {
    const providers = { gemini: mockProvider('gemini', { text: 'console.log("hello");' }) };
    initOrchestrator(ctx.db, providers, ctx.addLog);
    const id = insertTask(ctx.db, { title: 'Write a hello function', agent: 'coding' });
    const res = await executeOrchestratedTask({ db: ctx.db, taskId: id, providers, addLog: ctx.addLog, requestedProvider: 'gemini', customTimeoutMs: 5000 });
    assert.equal(res.ok, true);
    const task = getTask(ctx.db, id);
    assert.equal(task.status, 'completed');
    assert.equal(task.progress, 100);
    assert.ok(task.result && task.result.length > 0);
  });

  it('FIXED-BEHAVIOUR (updated from CURRENT-BEHAVIOUR after P0 fix): video task does NOT complete as text with 100% and no MP4 file', async () => {
    const providers = { gemini: mockProvider('gemini', { text: 'Scene 1 | Wide shot | A dog runs | Narration | 5 sec' }) };
    const id = insertTask(ctx.db, { title: 'Make a 15 second wildlife video', agent: 'video' });
    const res = await executeOrchestratedTask({ db: ctx.db, taskId: id, providers, addLog: ctx.addLog, requestedProvider: 'gemini', customTimeoutMs: 5000 });
    assert.equal(res.ok, false, 'video task with no verified MP4 must fail, not complete');
    const task = getTask(ctx.db, id);
    assert.notEqual(task.status, 'completed');
    assert.notEqual(task.progress, 100);
  });

  it('FAIL-EXPECTED (desired behaviour): video task must NOT complete without a verified MP4 file', async () => {
    const providers = { gemini: mockProvider('gemini', { text: 'Scene 1 | Wide shot | A dog runs | Narration | 5 sec' }) };
    const id = insertTask(ctx.db, { title: 'Make a 15 second wildlife video for acceptance', agent: 'video' });
    await executeOrchestratedTask({ db: ctx.db, taskId: id, providers, addLog: ctx.addLog, requestedProvider: 'gemini', customTimeoutMs: 5000 });
    const task = getTask(ctx.db, id);
    // Desired: no MP4 on disk, therefore not completed. This fails against current code.
    assert.notEqual(task.status, 'completed', 'A video task with no verified MP4 file must not be marked completed');
  });

  it('PASS: progress checkpoints are recorded, not only a final 100%', async () => {
    const providers = { gemini: mockProvider('gemini', { text: 'x = 1;' }) };
    const id = insertTask(ctx.db, { title: 'Checkpoint progress task', agent: 'coding' });
    await executeOrchestratedTask({ db: ctx.db, taskId: id, providers, addLog: ctx.addLog, requestedProvider: 'gemini', customTimeoutMs: 5000 });
    const task = getTask(ctx.db, id);
    const steps = JSON.parse(task.completed_steps || '[]');
    assert.ok(steps.includes('planning'));
    assert.ok(steps.includes('generating'));
    assert.ok(steps.includes('verifying'));
  });
});
