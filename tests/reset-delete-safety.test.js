'use strict';
// Reset and delete safety — baseline repository code, HTTP tests with a
// temporary database. These tests document unsafe current behaviour as
// failing desired-behaviour tests, not as passes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startBaselineServer, httpJson } = require('./helpers');

describe('reset and delete safety (repository baseline)', () => {
  let srv;
  before(async () => { srv = await startBaselineServer(); });
  after(async () => { await srv.close(); });

  it('FAIL-EXPECTED (desired behaviour): reset must not wipe tasks without a backup or confirmation token', async () => {
    const created = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Important task to keep', agent: 'coding', priority: 'High' });
    assert.equal(created.status, 201);
    const reset = await httpJson(srv.baseUrl, 'POST', '/api/reset', {});
    assert.equal(reset.status, 403, 'reset without backup token and confirm must be rejected after the P0 fix (updated intermediate assertion; final assertion below is unchanged)');
    const state = await httpJson(srv.baseUrl, 'GET', '/api/state');
    const stillThere = (state.json.tasks || []).some((t) => t.title === 'Important task to keep');
    assert.ok(stillThere, 'reset without a backup/confirmation must not delete user tasks');
  });

  it('FAIL-EXPECTED (desired behaviour): deleting a parent must not silently delete its subtasks without a backup or warning', async () => {
    const parent = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Parent to delete', agent: 'workflow', priority: 'Medium' });
    assert.equal(parent.status, 201);
    const parentId = parent.json.id;
    const child = await httpJson(srv.baseUrl, 'POST', '/api/tasks', { title: 'Child subtask to keep', agent: 'coding', priority: 'Medium', parent_id: parentId });
    assert.equal(child.status, 201);
    const del = await httpJson(srv.baseUrl, 'DELETE', `/api/tasks/${parentId}`);
    assert.equal(del.status, 409, 'parent with children must be rejected without explicit cascade after the P0 fix (updated intermediate assertion; final assertion below is unchanged)');
    const state = await httpJson(srv.baseUrl, 'GET', '/api/state');
    const childStillThere = (state.json.tasks || []).some((t) => t.title === 'Child subtask to keep');
    assert.ok(childStillThere, 'deleting a parent must not silently delete subtasks');
  });

  it('PASS: deleting logs clears logs (existing behaviour, documented, not a safety pass for tasks)', async () => {
    const res = await httpJson(srv.baseUrl, 'DELETE', '/api/logs');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });
});
