'use strict';
// Project Beyond QA helpers — read-only test support, no production code.
// Every database created here lives in a temporary directory and is deleted
// by the caller. No real provider is ever called: all providers below are
// deterministic mocks whose generateContent/checkHealth never touch a network
// or a paid API. Mock responses are clearly labelled and must never be
// mistaken for real production results.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const BASELINE = path.join(__dirname, '..'); // dev workspace root

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-qa-'));
  const dbPath = path.join(dir, 'beyond.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, agent TEXT NOT NULL,
      priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT,
      provider TEXT, current_step TEXT, completed_steps TEXT DEFAULT '[]', progress INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, checkpoint_data TEXT,
      parent_id INTEGER DEFAULT NULL, depends_on TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL, completed_at INTEGER, updated_at INTEGER);
    CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, lvl TEXT NOT NULL,
      msg TEXT NOT NULL, sample INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const addLog = (lvl, msg) => {
    try { db.prepare('INSERT INTO logs(t,lvl,msg,sample) VALUES(?,?,?,0)').run(Date.now(), lvl, msg); } catch {}
  };
  return { db, dir, dbPath, addLog, cleanup: () => { try { db.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function insertTask(db, { title, agent, priority = 'Medium', status = 'pending', provider = null, parent_id = null, depends_on = [] } = {}) {
  const r = db.prepare('INSERT INTO tasks(title,agent,priority,status,provider,parent_id,depends_on,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(title, agent, priority, status, provider, parent_id, JSON.stringify(depends_on), Date.now());
  return Number(r.lastInsertRowid);
}

function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

// Deterministic mock provider. `calls` records every generateContent call so a
// test can prove whether an image payload was actually delivered or dropped.
function mockProvider(id, { connected = true, models = ['mock-model'], text = 'MOCK provider response', fail = null, calls = null } = {}) {
  return {
    id,
    name: `Mock ${id}`,
    checkHealth: async () => ({ ok: connected, connected, models: connected ? models : [], hasModels: connected && models.length > 0 }),
    generateContent: async (args = {}) => {
      if (calls) calls.push({ provider: id, args });
      if (fail) return { ok: false, error: fail, status: 'error' };
      return { ok: true, text, model: models[0] };
    },
  };
}

function mockProviders(map) {
  // map: { gemini: mockProvider(...), ... } — keys must match provider ids used by the code under test.
  return map;
}

// Start the baseline server as a separate process on a fixed test port with
// a temporary database. This is necessary because repository server.js calls
// server.listen() unconditionally on import (see baseline/server.js, last
// lines), so it cannot be imported and listened on an ephemeral port in-process.
// The subprocess uses only the isolated baseline copy and a temporary DB; it
// does not touch the user's real data/beyond.db or any production server.
const { spawn } = require('node:child_process');
let _testPort = 33100;
async function startBaselineServer() {
  const tmp = makeTempDb();
  tmp.db.close();
  const port = _testPort++;
  const child = spawn(process.execPath, [path.join(BASELINE, 'server.js')], {
    env: { ...process.env, DB_PATH: tmp.dbPath, PORT: String(port) },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  // Wait for /api/health, up to 10 seconds.
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) { up = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) { try { child.kill('SIGTERM'); } catch {} throw new Error('baseline test server did not become healthy'); }
  const close = async () => {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    try { child.kill('SIGKILL'); } catch {}
    tmp.cleanup();
  };
  return { baseUrl, db: null, close, tmpDir: tmp.dir, child };
}

async function httpJson(baseUrl, method, p, body, headers = {}) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'beyond', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

module.exports = { BASELINE, makeTempDb, insertTask, getTask, mockProvider, mockProviders, startBaselineServer, httpJson };
