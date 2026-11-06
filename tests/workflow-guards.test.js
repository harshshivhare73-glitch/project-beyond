'use strict';
// Workflow dependency and consolidation guards — baseline repository code.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDb, insertTask, getTask } = require('./helpers');
const { initOrchestrator, consolidateWorkflow, validateDependencies, pauseTask } = require('../orchestrator');

describe('workflow guards', () => {
  let ctx;
  before(() => { ctx = makeTempDb(); initOrchestrator(ctx.db, {}, ctx.addLog); });
  after(() => ctx.cleanup());

  it('PASS: consolidation does not complete a parent while a subtask is incomplete', () => {
    const parent = insertTask(ctx.db, { title: 'Parent workflow', agent: 'workflow', status: 'running' });
    const child = insertTask(ctx.db, { title: 'Subtask one', agent: 'coding', status: 'pending', parent_id: parent });
    const result = consolidateWorkflow(ctx.db, parent, ctx.addLog);
    const afterParent = getTask(ctx.db, parent);
    assert.notEqual(afterParent.status, 'completed', 'parent must not complete with an incomplete subtask');
    assert.equal(result, null, 'consolidate must return null when a subtask is incomplete');
    void child;
  });

  it('PASS: dependency validation rejects a missing dependency task', () => {
    const id = insertTask(ctx.db, { title: 'Dependent task', agent: 'coding' });
    assert.throws(() => validateDependencies(id, [999999], ctx.db));
  });

  it('PASS: dependency validation rejects a self-dependency', () => {
    const id = insertTask(ctx.db, { title: 'Self dependent task', agent: 'coding' });
    assert.throws(() => validateDependencies(id, [id], ctx.db));
  });

  it('PASS: pauseTask on an already-paused task returns ok, and on a pending task it throws (pause is for running tasks only)', () => {
    const pausedId = insertTask(ctx.db, { title: 'Already paused task', agent: 'coding', status: 'paused' });
    const res = pauseTask(pausedId, ctx.db, ctx.addLog);
    assert.equal(res.ok, true);
    const pendingId = insertTask(ctx.db, { title: 'Pending task to pause', agent: 'coding', status: 'pending' });
    assert.throws(() => pauseTask(pendingId, ctx.db, ctx.addLog), /not currently running/);
  });

  it.skip('NOT RUN — MISSING-FEATURE SPECIFICATION: workflow editing (title, goal or prompt) must invalidate stale checkpoints and must not silently start an unrelated workflow', () => {
    // Repository PATCH on a task only changes status, parent_id and
    // depends_on. Title/goal/prompt editing does not exist, so this
    // specification cannot run against the baseline. Do not mark it passed.
  });
});
