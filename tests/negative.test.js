'use strict';
// Negative tests: missing providers, failed generation, timeouts, missing
// output files, invalid input — baseline repository code, mocked providers only.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDb, insertTask, getTask, mockProvider, startBaselineServer, httpJson } = require('./helpers');
const { initOrchestrator, executeOrchestratedTask } = require('../orchestrator');

describe('negative cases (orchestrator)', () => {
  let ctx;
  before(() => { ctx = makeTempDb(); });
  after(() => ctx.cleanup());

  it('PASS: missing provider fails the task instead of completing it', async () => {
    const providers = {};
    initOrchestrator(ctx.db, providers, ctx.addLog);
    const id = insertTask(ctx.db, { title: 'Task with no provider', agent: 'coding' });
    const res = await executeOrchestratedTask({ db: ctx.db, taskId: id, providers, addLog: ctx.addLog, requestedProvider: 'gemini', customTimeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.equal(getTask(ctx.db, id).status, 'failed');
  });

  it('PASS: failed generation with no healthy fallback fails the task instead of completing it', async () => {
    const providers = {
      gemini: mockProvider('gemini', { fail: 'Generation failed' }),
      groq: mockProvider('groq', { connected: false, models: [] }),
      openrouter: mockProvider('openrouter', { connected: false, models: [] }),
      deepseek: mockProvider('deepseek', { connected: false, models: [] }),
      ollama: mockProvider('ollama', { connected: false, models: [] }),
    };
    const id = insertTask(ctx.db, { title: 'Task with failing provider', agent: 'coding' });
    const res = await executeOrchestratedTask({ db: ctx.db, taskId: id, providers, addLog: ctx.addLog, requestedProvider: 'gemini', customTimeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.equal(getTask(ctx.db, id).status, 'failed');
  });

  it('PASS: a provider that throws (simulated timeout/network error) does not produce a completed task when no fallback is healthy', async () => {
    const throwing = {
      id: 'gemini',
      name: 'Mock gemini throwing',
      checkHealth: async () => ({ connected: false, models: [] }),
      generateContent: async () => { throw new Error('Network timeout'); },
    };
    const providers = { gemini: throwing, groq: mockProvider('groq', { connected: false, models: [] }), openrouter: mockProvider('openrouter', { connected: false, models: [] }), deepseek: mockProvider('deepseek', { connected: false, models: [] }), ollama: mockProvider('ollama', { connected: false, models: [] }) };
    const id = insertTask(ctx.db, { title: 'Task with throwing provider', agent: 'coding' });
    const res = await executeOrchestratedTask({ db: ctx.db, taskId: id, providers, addLog: ctx.addLog, requestedProvider: 'gemini', customTimeoutMs: 5000 });
    assert.equal(res.ok, false);
    assert.notEqual(getTask(ctx.db, id).status, 'completed');
  });

  it.skip('NOT RUN — MISSING-FEATURE SPECIFICATION: missing output file must block completion for media tasks (see task-completion FAIL-EXPECTED test for the video case)', () => {
    // Kept as a specification here so the negative matrix is explicit:
    // a task that claims a file output must be verified by existence and
    // size on disk before completion. The repository task path does not do
    // this for non-project tasks.
  });
});

describe('negative cases (HTTP)', () => {
  let srv;
  before(async () => { srv = await startBaselineServer(); });
  after(async () => { await srv.close(); });

  it('PASS: unknown agent is rejected with 400', async () => {
    const res = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Bad agent task', agent: 'unknown-agent', priority: 'High' });
    assert.equal(res.status, 400);
  });

  it('PASS: invalid task status is rejected with 400', async () => {
    const created = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Status test task', agent: 'coding', priority: 'Medium' });
    assert.equal(created.status, 201);
    const res = await httpJson(srv.baseUrl, 'PATCH', `/api/tasks/${created.json.id}`, { status: 'not-a-status' });
    assert.equal(res.status, 400);
  });

  it('PASS: unknown task id returns 404', async () => {
    const res = await httpJson(srv.baseUrl, 'GET', '/api/tasks/999999');
    assert.equal(res.status, 404);
  });
});
