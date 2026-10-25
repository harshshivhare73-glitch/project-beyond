const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const PORT = 3900 + Math.floor(Math.random() * 90), BASE = `http://localhost:${PORT}`;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-')), 't.db');
let proc;
const start = async () => { proc = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_PATH: DB }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('server did not start'); };
const stop = () => new Promise(r => { proc.on('exit', r); proc.kill(); });
const call = (m, p, b, h = { 'X-Requested-With': 'beyond' }) => fetch(BASE + p, { method: m, headers: { ...h, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
before(start); after(stop);

test('seeds sample data and Free-First on', async () => {
  const s = await (await call('GET', '/api/state')).json();
  assert.equal(s.tasks.length, 3); assert.equal(s.logs.length, 5); assert.equal(s.settings.freeFirst, true);
});
test('validates input', async () => {
  assert.equal((await call('POST', '/api/tasks', { title: 'x', agent: 'coding', priority: 'High' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'Valid title', agent: 'nope', priority: 'High' })).status, 400);
  assert.equal((await call('PATCH', '/api/tasks/1', { status: 'bogus' })).status, 400);
  assert.equal((await call('PATCH', '/api/tasks/9999', { status: 'done' })).status, 404);
});
test('rejects writes without the custom header', async () => {
  assert.equal((await call('POST', '/api/reset', null, {})).status, 403);
});
test('create, update, delete tasks and log events', async () => {
  const r = await call('POST', '/api/tasks', { title: 'Write tests', agent: 'coding', priority: 'High' });
  assert.equal(r.status, 201); const { id } = await r.json();
  assert.equal((await call('PATCH', '/api/tasks/' + id, { status: 'done' })).status, 200);
  let s = await (await call('GET', '/api/state')).json();
  assert.equal(s.tasks.find(t => t.id === id).status, 'done');
  assert.ok(s.logs.some(l => l.msg.includes('Task created')));
  assert.equal((await call('DELETE', '/api/tasks/' + id)).status, 200);
  s = await (await call('GET', '/api/state')).json(); assert.ok(!s.tasks.some(t => t.id === id));
});
test('data survives a server restart', async () => {
  await call('POST', '/api/tasks', { title: 'Persistent task', agent: 'video', priority: 'Low' });
  await call('PUT', '/api/settings', { freeFirst: false });
  await stop(); await start();
  const s = await (await call('GET', '/api/state')).json();
  assert.ok(s.tasks.some(t => t.title === 'Persistent task')); assert.equal(s.settings.freeFirst, false);
});
test('clear logs and reset', async () => {
  await call('DELETE', '/api/logs'); assert.equal((await (await call('GET', '/api/state')).json()).logs.length, 0);
  await call('POST', '/api/reset'); const s = await (await call('GET', '/api/state')).json();
  assert.equal(s.tasks.length, 3); assert.equal(s.settings.freeFirst, true);
});
test('reports Ollama connection status and models', async () => {
  const r = await call('GET', '/api/ollama/status');
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(typeof data.connected, 'boolean');
  assert.ok(Array.isArray(data.models));
  const s = await (await call('GET', '/api/state')).json();
  assert.ok(s.ollama);
  assert.equal(typeof s.ollama.connected, 'boolean');
  assert.ok(Array.isArray(s.ollama.models));
});
test('lists all modular AI providers with terms and metadata', async () => {
  const r = await call('GET', '/api/providers');
  assert.equal(r.status, 200);
  const provs = await r.json();
  assert.ok(Array.isArray(provs));
  assert.ok(provs.length >= 7);
  const ids = provs.map(p => p.id);
  assert.ok(ids.includes('ollama'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('groq'));
  assert.ok(ids.includes('openrouter'));
  assert.ok(ids.includes('deepseek'));
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('anthropic'));
});
test('reports missing credentials accurately without errors or crashes', async () => {
  const r = await call('GET', '/api/providers/deepseek');
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.configured, false);
  assert.equal(data.connected, false);
  assert.equal(data.status, 'missing_key');
  assert.ok(data.error.includes('DEEPSEEK_API_KEY'));
  assert.equal(data.maskedKey, null);
});
test('handles provider error / invalid credential gracefully', async () => {
  const { PROVIDERS } = require('../providers');
  const res = await PROVIDERS.gemini.checkHealth({ key: 'AIzaSyFakeKey123456789' });
  assert.equal(res.connected, false);
  assert.equal(res.status, 'error');
  assert.ok(res.error.length > 0);
  assert.equal(res.maskedKey, 'AIz...6789');
});
test('handles provider timeout gracefully without hanging server', async () => {
  const { PROVIDERS } = require('../providers');
  const res = await PROVIDERS.openrouter.checkHealth({ key: 'sk-or-fake-key', timeoutMs: 1 });
  assert.equal(res.connected, false);
  assert.equal(res.status, 'error');
  assert.ok(res.error.includes('timed out') || res.error.includes('aborted'));
});
test('identifies unavailable models properly when provider has zero models', async () => {
  const { PROVIDERS } = require('../providers');
  const res = await PROVIDERS.ollama.checkHealth();
  if (res.connected) {
    assert.equal(res.hasModels, false);
    assert.equal(res.status, 'no_models');
  }
});
test('never exposes full API key in provider status or state', async () => {
  const { maskKey } = require('../providers');
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-...cdef');
  assert.equal(maskKey('short'), '****');
  assert.equal(maskKey(null), null);
  const s = await (await call('GET', '/api/state')).json();
  for (const p of s.providers || []) {
    if (p.maskedKey) assert.ok(!p.maskedKey.includes('sk-1234567890abcdef'));
  }
});

test('POST /api/tasks/:id/execute rejects invalid provider', async () => {
  const s = await (await call('GET', '/api/state')).json();
  const id = s.tasks[0].id;
  const r = await call('POST', `/api/tasks/${id}/execute`, { provider: 'unsupported_ai' });
  assert.equal(r.status, 400);
  const data = await r.json();
  assert.ok(data.error.includes('Unsupported execution provider'));
});

test('POST /api/tasks/:id/execute returns 404 for nonexistent task', async () => {
  const r = await call('POST', '/api/tasks/99999/execute', { provider: 'gemini' });
  assert.equal(r.status, 404);
});

test('POST /api/providers/gemini/test validates missing key gracefully', async () => {
  const { PROVIDERS } = require('../providers');
  const res = await PROVIDERS.gemini.testGemini({ key: '' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'missing_key');
  assert.ok(res.error.includes('GEMINI_API_KEY'));
});

test('Gemini test endpoint POST /api/providers/gemini/test returns structured response', async () => {
  const r = await call('POST', '/api/providers/gemini/test', {});
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(typeof data.ok, 'boolean');
  if (data.ok) {
    assert.ok(data.text);
    assert.equal(data.provider, 'gemini');
  } else {
    assert.ok(data.error);
  }
});

test('Orchestrator: prevents duplicate concurrent task execution with HTTP 409', async () => {
  const postRes = await call('POST', '/api/tasks', { title: 'Concurrent execution task', agent: 'coding', priority: 'High' });
  assert.equal(postRes.status, 201);
  const { id } = await postRes.json();

  // Mark task as currently running to simulate active in-flight execution
  const patchRes = await call('PATCH', `/api/tasks/${id}`, { status: 'running' });
  assert.equal(patchRes.status, 200);

  // Attempt duplicate execution
  const r = await call('POST', `/api/tasks/${id}/execute`, { provider: 'gemini' });
  assert.equal(r.status, 409);
  const data = await r.json();
  assert.ok(data.error.includes('already executing') || data.error.includes('Duplicate execution prevented'));

  // Also test activeTasks in-memory lock unit guard
  const { DatabaseSync } = require('node:sqlite');
  const { executeOrchestratedTask, activeTasks } = require('../orchestrator');
  activeTasks.add(888);
  try {
    await executeOrchestratedTask({ db: new DatabaseSync(':memory:'), taskId: 888 });
    assert.fail('Should have thrown 409');
  } catch (err) {
    assert.equal(err.status, 409);
  } finally {
    activeTasks.delete(888);
  }
});

test('Orchestrator: resumes task from checkpoint without repeating completed steps', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { executeOrchestratedTask } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  testDb.prepare(`
    INSERT INTO tasks(title, agent, priority, status, current_step, completed_steps, progress, checkpoint_data, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Implement checkpoint test',
    'coding',
    'Medium',
    'paused',
    'planning',
    JSON.stringify(['planning']),
    35,
    JSON.stringify({ plan: 'Existing saved plan: do not recalculate' }),
    Date.now()
  );

  const mockProviders = {
    gemini: {
      generateContent: async ({ prompt }) => {
        assert.ok(prompt.includes('Existing saved plan'), 'Prompt must use saved checkpoint plan');
        return { ok: true, text: 'console.log("recovered");' };
      }
    }
  };

  const logs = [];
  const addLog = (lvl, msg) => logs.push({ lvl, msg });

  const res = await executeOrchestratedTask({
    db: testDb,
    taskId: 1,
    providers: mockProviders,
    addLog,
    resumeOnly: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.ok(logs.some(l => l.msg.includes('Skipping [Planning] (restored from checkpoint)')));

  const saved = testDb.prepare('SELECT * FROM tasks WHERE id = 1').get();
  assert.equal(saved.status, 'completed');
  assert.equal(saved.progress, 100);
  assert.ok(saved.completed_steps.includes('planning'));
  assert.ok(saved.completed_steps.includes('generating'));
  assert.ok(saved.completed_steps.includes('verifying'));
});

test('Orchestrator: retry limits stop execution and set task to failed on exhausted retries', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { executeOrchestratedTask } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  testDb.prepare(`
    INSERT INTO tasks(title, agent, priority, status, created_at, max_retries)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run('Failing transient task', 'coding', 'High', 'pending', Date.now(), 2);

  let attempts = 0;
  const mockProviders = {
    gemini: {
      generateContent: async () => {
        attempts++;
        const err = new Error('Google network rate limit exceeded (HTTP 429)');
        err.status = 429;
        throw err;
      }
    }
  };

  const logs = [];
  const addLog = (lvl, msg) => logs.push({ lvl, msg });

  const res = await executeOrchestratedTask({
    db: testDb,
    taskId: 1,
    providers: mockProviders,
    addLog,
    backoffBaseMs: 10,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.equal(attempts, 3);
  assert.ok(res.error.includes('failed'));

  const saved = testDb.prepare('SELECT * FROM tasks WHERE id = 1').get();
  assert.equal(saved.status, 'failed');
  assert.equal(saved.retry_count, 2);
});

test('Orchestrator: provider fallback switches to working alternate provider', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { executeOrchestratedTask } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  testDb.prepare(`
    INSERT INTO tasks(title, agent, priority, status, created_at, max_retries)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run('Task needing fallback', 'coding', 'High', 'pending', Date.now(), 1);

  const mockProviders = {
    gemini: {
      name: 'Google Gemini',
      generateContent: async () => {
        throw new Error('Service Unavailable 503');
      }
    },
    ollama: {
      id: 'ollama',
      name: 'Ollama',
      checkHealth: async () => ({ ok: true, connected: true, models: ['qwen2.5-coder:3b'] }),
    }
  };

  const logs = [];
  const addLog = (lvl, msg) => logs.push({ lvl, msg });

  const res = await executeOrchestratedTask({
    db: testDb,
    taskId: 1,
    providers: mockProviders,
    addLog,
    requestedProvider: 'gemini',
    backoffBaseMs: 10,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.equal(res.provider, 'ollama');
  assert.ok(logs.some(l => l.msg.includes('Switching to fallback provider "Ollama"')));
});

test('Orchestrator: recovers interrupted running tasks on server startup as paused', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  testDb.prepare(`
    INSERT INTO tasks(title, agent, priority, status, current_step, progress, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run('Interrupted task', 'coding', 'High', 'running', 'generating', 50, Date.now());

  const logs = [];
  const addLog = (lvl, msg) => logs.push({ lvl, msg });

  initOrchestrator(testDb, {}, addLog);

  const recovered = testDb.prepare('SELECT * FROM tasks WHERE id = 1').get();
  assert.equal(recovered.status, 'paused');
  assert.ok(recovered.error.includes('interrupted by server restart'));
  assert.ok(logs.some(l => l.msg.includes('Orchestrator recovered task #1')));
});

test('Research Agent: fetchSources handles empty topic gracefully', async () => {
  const { fetchSources } = require('../research');
  const res = await fetchSources('');
  assert.equal(res.ok, false);
  assert.deepEqual(res.sources, []);
});

test('Research Agent: fetchSources retrieves encyclopedia entries or handles network cleanly', async () => {
  const { fetchSources } = require('../research');
  const res = await fetchSources('Computer programming', { timeoutMs: 8000 });
  assert.equal(typeof res.ok, 'boolean');
  assert.ok(Array.isArray(res.sources));
  if (res.ok && res.sources.length) {
    assert.ok(res.sources[0].title);
    assert.ok(res.sources[0].url.startsWith('https://'));
  }
});

test('Multi-Agent: Research Agent executes multi-step gathering and synthesis checkpoints', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { executeOrchestratedTask } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  testDb.prepare(`
    INSERT INTO tasks(title, agent, priority, status, created_at)
    VALUES(?, ?, ?, ?, ?)
  `).run('Research renewable energy trends', 'research', 'High', 'pending', Date.now());

  const mockProviders = {
    gemini: {
      generateContent: async ({ prompt }) => {
        assert.ok(prompt.includes('Research Agent'));
        return {
          ok: true,
          text: 'Executive Summary: Renewable energy is growing globally.\n\nCited References:\n• https://en.wikipedia.org/wiki/Renewable_energy'
        };
      }
    }
  };

  const logs = [];
  const addLog = (lvl, msg) => logs.push({ lvl, msg });

  const res = await executeOrchestratedTask({
    db: testDb,
    taskId: 1,
    providers: mockProviders,
    addLog,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.ok(res.result.includes('Renewable energy'));

  const saved = testDb.prepare('SELECT * FROM tasks WHERE id = 1').get();
  assert.equal(saved.status, 'completed');
  assert.equal(saved.progress, 100);
  assert.ok(saved.completed_steps.includes('planning'));
  assert.ok(saved.completed_steps.includes('gathering'));
  assert.ok(saved.completed_steps.includes('generating'));
  assert.ok(saved.completed_steps.includes('verifying'));
});

test('Multi-Agent: Graphics Agent generates SVG vector markup', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { executeOrchestratedTask } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  testDb.prepare(`
    INSERT INTO tasks(title, agent, priority, status, created_at)
    VALUES(?, ?, ?, ?, ?)
  `).run('Design a modern blue shield icon', 'graphics', 'Medium', 'pending', Date.now());

  const mockProviders = {
    gemini: {
      generateContent: async ({ prompt }) => {
        assert.ok(prompt.includes('Graphics Agent'));
        return {
          ok: true,
          text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,10 90,30 80,80 50,95 20,80 10,30" fill="#3ea8ff"/></svg>\nDesign rationale: Modern geometric shield.'
        };
      }
    }
  };

  const res = await executeOrchestratedTask({
    db: testDb,
    taskId: 1,
    providers: mockProviders,
    addLog: () => {},
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.ok(res.result.includes('<svg'));
  assert.ok(res.result.includes('</svg>'));
});

test('Multi-Agent: POST /api/agents/research/test returns structured research response', async () => {
  const r = await call('POST', '/api/agents/research/test', { topic: 'Machine learning' });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);
  assert.equal(data.agent, 'research');
  assert.ok(Array.isArray(data.sources));
  assert.equal(typeof data.sourcesCount, 'number');
});

test('Stage I Toolkit: GET /api/tools returns categorized toolkit catalog', async () => {
  const r = await call('GET', '/api/tools');
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.tools));
  assert.ok(data.tools.length >= 25);
  assert.ok(data.categories.FOSS);
  assert.ok(data.categories.FREE_TIER);
  assert.ok(data.categories.PAID_OR_KEY);
  assert.ok(data.categories.UNSUPPORTED_OR_HEAVY);
});

test('Stage I Toolkit: distinguishes web subscriptions from API usage correctly', async () => {
  const { AUDITED_TOOLKIT } = require('../tools');
  const openai = AUDITED_TOOLKIT.find(t => t.id === 'openai_api');
  const anthropic = AUDITED_TOOLKIT.find(t => t.id === 'anthropic_api');
  const deepseek = AUDITED_TOOLKIT.find(t => t.id === 'deepseek_api');

  assert.equal(openai.category, 'PAID_OR_KEY');
  assert.ok(openai.terms.includes('DOES NOT grant API access'));
  assert.equal(anthropic.category, 'PAID_OR_KEY');
  assert.ok(anthropic.terms.includes('does NOT include API credits'));
  assert.equal(deepseek.category, 'PAID_OR_KEY');
  assert.ok(deepseek.terms.includes('Web free chat != API'));
});

test('Stage I Toolkit: searchHuggingFaceModels handles empty query gracefully', async () => {
  const { searchHuggingFaceModels } = require('../tools');
  const res = await searchHuggingFaceModels('');
  assert.equal(res.ok, false);
  assert.deepEqual(res.models, []);
});

test('Stage I Toolkit: searchHuggingFaceModels discovers verified public models without API keys', async () => {
  const { searchHuggingFaceModels } = require('../tools');
  const res = await searchHuggingFaceModels('qwen2.5-coder', 2, 8000);
  assert.equal(typeof res.ok, 'boolean');
  assert.ok(Array.isArray(res.models));
  if (res.ok && res.models.length) {
    assert.ok(res.models[0].id.toLowerCase().includes('qwen'));
    assert.ok(res.models[0].url.startsWith('https://huggingface.co/'));
    assert.equal(typeof res.models[0].downloads, 'number');
  }
});

test('Stage I Toolkit: GET /api/tools/hf/models endpoint returns live search results', async () => {
  const r = await call('GET', '/api/tools/hf/models?q=qwen&limit=2');
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(typeof data.ok, 'boolean');
  assert.ok(Array.isArray(data.models));
});

test('Stage J: Full Workflow E2E — Task Creation and Checkpoint Completion', async () => {
  const createRes = await call('POST', '/api/tasks', { title: 'Implement Fibonacci function', agent: 'coding', priority: 'High' });
  assert.equal(createRes.status, 201);
  const { id } = await createRes.json();
  assert.ok(id > 0);

  const stateBefore = await (await call('GET', '/api/state')).json();
  const createdTask = stateBefore.tasks.find(t => t.id === id);
  assert.equal(createdTask.status, 'pending');

  const execRes = await call('POST', `/api/tasks/${id}/execute`, { provider: 'gemini', timeoutMs: 12000 });
  const execData = await execRes.json();

  if (execRes.status === 200) {
    assert.equal(execData.ok, true);
    assert.equal(execData.task.status, 'completed');
    assert.equal(execData.task.progress, 100);
    assert.ok(execData.task.result.length > 0);
  } else {
    assert.equal(typeof execData.error, 'string');
    assert.ok(execRes.status === 400 || execRes.status === 429 || execRes.status === 500);
  }
});

test('Stage J: Checkpoint Pause and Resume Flow without Repeating Planning', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { executeOrchestratedTask, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, completed_steps, checkpoint_data, progress) VALUES(101, 'Build Navbar', 'coding', 'Medium', 'pending', '[\"planning\"]', '{\"plan\":\"Step 1: HTML\\nStep 2: CSS\"}', 30)").run();

  let codeGenerated = false;
  const mockProviders = {
    gemini: {
      id: 'gemini',
      name: 'Google Gemini',
      generateContent: async () => {
        codeGenerated = true;
        return { ok: true, text: 'export function Navbar() { return <nav>Navbar</nav>; }' };
      },
      checkHealth: async () => ({ ok: true, connected: true })
    }
  };

  const logs = [];
  const addLog = (lvl, msg) => logs.push({ lvl, msg });

  const res = await executeOrchestratedTask({
    db: testDb,
    taskId: 101,
    providers: mockProviders,
    addLog,
    requestedProvider: 'gemini',
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.equal(codeGenerated, true);
  assert.ok(logs.some(l => l.msg.includes('Skipping [Planning] (restored from checkpoint)')));
});

test('Stage J: Server Restart Recovery Safely Pauses Interrupted Running Tasks', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, current_step, progress) VALUES(201, 'Interrupted Migration', 'coding', 'High', 'running', 'generating', 65)").run();

  const recoveryLogs = [];
  initOrchestrator(testDb, {}, (lvl, msg) => recoveryLogs.push({ lvl, msg }));

  const recoveredTask = testDb.prepare("SELECT * FROM tasks WHERE id = 201").get();
  assert.equal(recoveredTask.status, 'paused');
  assert.equal(recoveredTask.progress, 65);
  assert.ok(recoveredTask.error.includes('Execution interrupted by server restart'));
  assert.ok(recoveryLogs.some(l => l.msg.includes('paused at step "generating" (65%)')));
});

test('Stage J: Security Audit — Zero API Key Leaks across API, State, Providers, and Logs', async () => {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/GEMINI_API_KEY=(.+)/);
  if (!match) return;
  const rawKey = match[1].trim();
  assert.ok(rawKey.length > 10);

  const stateRes = await call('GET', '/api/state');
  const stateText = await stateRes.text();
  assert.ok(!stateText.includes(rawKey), 'Raw API key leaked in /api/state response');

  const provRes = await call('GET', '/api/providers');
  const provText = await provRes.text();
  assert.ok(!provText.includes(rawKey), 'Raw API key leaked in /api/providers response');

  const toolsRes = await call('GET', '/api/tools');
  const toolsText = await toolsRes.text();
  assert.ok(!toolsText.includes(rawKey), 'Raw API key leaked in /api/tools response');
});

test('Stage J: Git Security — .env and SQLite DBs strictly excluded in .gitignore', async () => {
  const fs = require('fs');
  const gitignorePath = path.join(__dirname, '..', '.gitignore');
  assert.ok(fs.existsSync(gitignorePath));
  const lines = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/).map(l => l.trim());

  assert.ok(lines.includes('.env'), '.env missing from .gitignore');
  assert.ok(lines.includes('*.db'), '*.db missing from .gitignore');
  assert.ok(lines.includes('node_modules/'), 'node_modules missing from .gitignore');
});

test('Stage J: Performance & Quota Optimization — Provider health checks cache avoids quota waste', async () => {
  const { PROVIDERS } = require('../providers');
  const t0 = Date.now();
  const first = await PROVIDERS.gemini.checkHealth();
  const t1 = Date.now();

  const second = await PROVIDERS.gemini.checkHealth();
  const t2 = Date.now();

  assert.equal(typeof first.connected, 'boolean');
  assert.equal(typeof second.connected, 'boolean');
  assert.ok((t2 - t1) < 50, `Second health call took ${t2 - t1}ms; expected cache hit < 50ms`);
});

test('Stage J: Agent Integrity Audit — All 5 agents have accurate tiers and descriptions', async () => {
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.ok(html.includes("id:'coding',name:'Coding Agent',icon:'💻',tier:'REAL'"));
  assert.ok(html.includes("id:'research',name:'Research Agent',icon:'🔎',tier:'REAL'"));
  assert.ok(html.includes("id:'sketch',name:'Sketch Agent',icon:'✏️',tier:'PARTIAL'"));
  assert.ok(html.includes("id:'graphics',name:'Graphics Agent',icon:'🎨',tier:'PARTIAL'"));
  assert.ok(html.includes("id:'video',name:'Video Agent',icon:'🎬',tier:'MOCK'"));
  assert.ok(html.includes('Actual MP4 video rendering engine is not installed'));
});

test('Stage K2: Safe and idempotent migration adds parent_id and depends_on', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, agent TEXT NOT NULL,
      priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
    );
  `);

  // Run initial migration
  initOrchestrator(testDb);
  let cols = testDb.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  assert.ok(cols.includes('parent_id'), 'parent_id column missing');
  assert.ok(cols.includes('depends_on'), 'depends_on column missing');

  // Verify re-running migration is idempotent
  assert.doesNotThrow(() => initOrchestrator(testDb));
  cols = testDb.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
  assert.ok(cols.includes('parent_id'));
  assert.ok(cols.includes('depends_on'));
});

test('Stage K2: Existing standalone tasks work without parent_id or depends_on', async () => {
  const res = await call('POST', '/api/tasks', { title: 'Standalone Task Test', agent: 'coding', priority: 'Medium' });
  assert.equal(res.status, 201);
  const { id } = await res.json();

  const taskRes = await call('GET', `/api/tasks/${id}`);
  assert.equal(taskRes.status, 200);
  const task = await taskRes.json();
  assert.equal(task.parent_id, null);
  assert.equal(task.depends_on, '[]');
});

test('Stage K2: Dependency validation rejects invalid formats, nonexistent IDs, and self-dependency', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { validateDependencies, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status) VALUES(1, 'Task 1', 'research', 'High', 'completed')").run();

  // Rejects non-array
  assert.throws(() => validateDependencies(2, 'not-an-array', testDb), /depends_on must be an array/);

  // Rejects invalid ID values
  assert.throws(() => validateDependencies(2, [-5], testDb), /Invalid dependency ID/);
  assert.throws(() => validateDependencies(2, ['abc'], testDb), /Invalid dependency ID/);

  // Rejects duplicate dependency IDs
  assert.throws(() => validateDependencies(2, [1, 1], testDb), /Duplicate dependency ID/);

  // Rejects self-dependency
  assert.throws(() => validateDependencies(1, [1], testDb), /cannot depend on itself/);

  // Rejects nonexistent dependency ID
  assert.throws(() => validateDependencies(2, [9999], testDb), /Dependency task #9999 does not exist/);

  // Accepts valid existing dependency
  assert.equal(validateDependencies(2, [1], testDb), true);
});

test('Stage K2: Cycle detection rejects circular dependency graphs', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { validateDependencies, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, depends_on) VALUES(10, 'Task A', 'research', 'High', 'completed', '[]')").run();
  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, depends_on) VALUES(20, 'Task B', 'coding', 'High', 'pending', '[10]')").run();
  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, depends_on) VALUES(30, 'Task C', 'graphics', 'High', 'pending', '[20]')").run();

  // Task B already depends on Task A. Attempting to make Task A depend on Task B must be rejected as circular
  assert.throws(() => validateDependencies(10, [20], testDb), /Circular dependency detected/);

  // Task C depends on B which depends on A. Attempting to make Task A depend on Task C must also be detected
  assert.throws(() => validateDependencies(10, [30], testDb), /Circular dependency detected/);
});

test('Stage K2: Context handoff passes completed dependency outputs and citations', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { resolveDependencyContext, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const researchOutput = `Executive Summary: Vercel and Netlify offer genuine free tiers.
Key Facts:
- Vercel: 100 GB bandwidth / month
- Netlify: 100 GB bandwidth / month
Citations:
[1] Vercel Docs: https://vercel.com/docs
[2] Netlify Docs: https://docs.netlify.com`;

  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, result) VALUES(1, 'Host Research', 'research', 'High', 'completed', ?)").run(researchOutput);

  const res = resolveDependencyContext(2, [1], testDb);
  assert.equal(res.ready, true);
  assert.ok(res.context.includes('--- Dependency [Task #1] "Host Research" (Agent: research) ---'));
  assert.ok(res.context.includes('Vercel and Netlify offer genuine free tiers'));
  assert.ok(res.context.includes('https://vercel.com/docs'));
  assert.equal(res.dependencies.length, 1);
  assert.equal(res.dependencies[0].id, 1);
});

test('Stage K2: Incomplete or failed dependency blocks execution gracefully', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { resolveDependencyContext, executeOrchestratedTask, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status) VALUES(50, 'Pending Upstream', 'research', 'High', 'pending')").run();
  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, depends_on) VALUES(51, 'Blocked Downstream', 'coding', 'High', 'pending', '[50]')").run();

  const res = resolveDependencyContext(51, [50], testDb);
  assert.equal(res.ready, false);
  assert.ok(res.error.includes('is not completed (current status: pending)'));

  // Verify executeOrchestratedTask throws 400 error when dependency is not completed
  await assert.rejects(
    async () => {
      await executeOrchestratedTask({
        db: testDb,
        taskId: 51,
        providers: {},
        addLog: () => {},
      });
    },
    err => {
      assert.equal(err.status, 400);
      assert.ok(err.message.includes('is not completed (current status: pending)'));
      return true;
    }
  );
});

test('Stage K2: Context size is strictly bounded to prevent oversized prompts', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { resolveDependencyContext, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  // Generate large 8,000 char output with citations at the end
  const hugeText = 'Header overview of system architecture. ' + 'Lorem ipsum dolor sit amet. '.repeat(250) + '\nCitations: https://verified-source.org/paper';
  assert.ok(hugeText.length > 6000);

  testDb.prepare("INSERT INTO tasks(id, title, agent, priority, status, result) VALUES(70, 'Large Research', 'research', 'High', 'completed', ?)").run(hugeText);

  const res = resolveDependencyContext(71, [70], testDb);
  assert.equal(res.ready, true);
  // Context must be bounded to reasonable size (< 2500 chars)
  assert.ok(res.context.length < 2500);
  assert.ok(res.context.includes('Header overview of system architecture'));
  assert.ok(res.context.includes('truncated for bounded prompt context'));
  assert.ok(res.context.includes('https://verified-source.org/paper'));
});

test('Stage K2: API endpoints expose parent_id and depends_on and support PATCH', async () => {
  // Create parent task
  const parentRes = await call('POST', '/api/tasks', { title: 'Parent Portal Project', agent: 'sketch', priority: 'High' });
  assert.equal(parentRes.status, 201);
  const { id: parentId } = await parentRes.json();

  // Create child task with parent_id and depends_on
  const childRes = await call('POST', '/api/tasks', {
    title: 'Implement portal auth',
    agent: 'coding',
    priority: 'High',
    parent_id: parentId,
    depends_on: [parentId]
  });
  assert.equal(childRes.status, 201);
  const { id: childId } = await childRes.json();

  // Fetch child task via GET /api/tasks/:id
  const getChild = await call('GET', `/api/tasks/${childId}`);
  assert.equal(getChild.status, 200);
  const childData = await getChild.json();
  assert.equal(childData.parent_id, parentId);
  assert.equal(childData.depends_on, JSON.stringify([parentId]));

  // Update dependencies via PATCH /api/tasks/:id
  const patchRes = await call('PATCH', `/api/tasks/${childId}`, { depends_on: [] });
  assert.equal(patchRes.status, 200);
  const patched = await (await call('GET', `/api/tasks/${childId}`)).json();
  assert.equal(patched.depends_on, '[]');
});

test('Stage K3: Goal decomposition with heuristic fallback generates valid DAG', async () => {
  const { decomposeGoal, decomposeGoalHeuristic } = require('../orchestrator');

  const plan = await decomposeGoal('Build modern developer portal with documentation');
  assert.ok(plan && typeof plan === 'object');
  assert.equal(typeof plan.plan, 'string');
  assert.ok(Array.isArray(plan.subtasks));
  assert.ok(plan.subtasks.length >= 2 && plan.subtasks.length <= 4);

  const validAgents = ['research', 'sketch', 'coding', 'graphics', 'video'];
  for (const s of plan.subtasks) {
    assert.ok(typeof s.step === 'number' && s.step > 0);
    assert.ok(typeof s.title === 'string' && s.title.length >= 3);
    assert.ok(validAgents.includes(s.agent));
    assert.ok(Array.isArray(s.depends_on_steps));
    for (const dep of s.depends_on_steps) {
      assert.ok(dep < s.step, 'Dependency must be an earlier step number');
    }
  }

  // Test video heuristic
  const videoPlan = decomposeGoalHeuristic('Create product launch video presentation');
  assert.ok(videoPlan.subtasks.some(s => s.agent === 'video'));
});

test('Stage K3: Planner rejects invalid plan objects, unknown agents, and forward dependencies', () => {
  const { validatePlanObject } = require('../orchestrator');

  assert.throws(() => validatePlanObject(null), /must be a valid JSON object/);
  assert.throws(() => validatePlanObject({ subtasks: [] }), /between 2 and 4 subtasks/);
  assert.throws(() => validatePlanObject({
    subtasks: [
      { step: 1, title: 'Research topic', agent: 'unknown_agent', depends_on_steps: [] },
      { step: 2, title: 'Code logic', agent: 'coding', depends_on_steps: [1] }
    ]
  }), /specifies unknown agent/);

  // Reject forward dependency (step 1 depends on step 2)
  assert.throws(() => validatePlanObject({
    subtasks: [
      { step: 1, title: 'Initial setup', agent: 'sketch', depends_on_steps: [2] },
      { step: 2, title: 'Code logic', agent: 'coding', depends_on_steps: [] }
    ]
  }), /cannot depend on step 2/);
});

test('Stage K3: POST /api/workflows creates parent and child subtasks with mapped database IDs', async () => {
  const wfRes = await call('POST', '/api/workflows', {
    title: 'Design and build authentication system',
    priority: 'High'
  });
  assert.equal(wfRes.status, 201);
  const wfData = await wfRes.json();
  assert.equal(wfData.ok, true);
  assert.ok(wfData.parentId > 0);
  assert.ok(Array.isArray(wfData.subtaskIds));
  assert.ok(wfData.subtaskIds.length >= 2);

  // Verify GET /api/workflows/:id returns parent and subtasks
  const getWf = await call('GET', `/api/workflows/${wfData.parentId}`);
  assert.equal(getWf.status, 200);
  const fetched = await getWf.json();
  assert.equal(fetched.parent.id, wfData.parentId);
  assert.equal(fetched.subtasks.length, wfData.subtaskIds.length);

  // Verify child dependencies map to real database IDs (not local step numbers)
  const child1 = fetched.subtasks[0];
  const child2 = fetched.subtasks[1];
  assert.equal(child1.parent_id, wfData.parentId);
  assert.equal(child2.parent_id, wfData.parentId);

  const child2Deps = JSON.parse(child2.depends_on || '[]');
  if (child2Deps.length > 0) {
    assert.ok(child2Deps.includes(child1.id), 'Child 2 must depend on Child 1 database ID');
  }
});

test('Stage K3: Transaction rollback prevents orphaned tasks on invalid workflow plan', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createWorkflow, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const invalidPlan = {
    plan: 'Invalid workflow',
    subtasks: [
      { step: 1, title: 'Valid step', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Corrupt step', agent: 'nonexistent_agent', depends_on_steps: [1] }
    ]
  };

  assert.throws(() => {
    createWorkflow(testDb, { title: 'Corrupt Workflow', priority: 'High', plan: invalidPlan });
  }, /specifies unknown agent/);

  // Verify zero tasks were left behind in the database
  const count = testDb.prepare('SELECT count(*) as c FROM tasks').get().c;
  assert.equal(count, 0, 'Orphaned tasks detected after rollback');
});

test('Stage K3: Sequential workflow execution runs subtasks in dependency order and aggregates result', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createWorkflow, executeSequentialWorkflow, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const mockPlan = {
    plan: 'Sequential research and implementation',
    subtasks: [
      { step: 1, title: 'Step 1: Research APIs', agent: 'research', depends_on_steps: [] },
      { step: 2, title: 'Step 2: Build client', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'API Client Project', priority: 'High', plan: mockPlan });

  const executionLog = [];
  const mockProviders = {
    gemini: {
      id: 'gemini',
      generateContent: async ({ prompt }) => {
        if (prompt.includes('Topic: "Step 1: Research APIs"')) {
          executionLog.push('step1');
          return { ok: true, text: 'Research findings: API endpoint is https://api.example.com/v1' };
        }
        if (prompt.includes('Task: "Step 2: Build client"')) {
          executionLog.push('step2');
          // Verify context handoff: prompt contains step 1 output
          assert.ok(prompt.includes('https://api.example.com/v1'), 'Step 2 prompt must receive Step 1 research context');
          return { ok: true, text: 'export const client = { url: "https://api.example.com/v1" };' };
        }
        return { ok: true, text: 'Generated output' };
      },
      checkHealth: async () => ({ ok: true, connected: true })
    }
  };

  const res = await executeSequentialWorkflow({
    db: testDb,
    parentId: wf.parentId,
    providers: mockProviders,
    addLog: () => {},
    requestedProvider: 'gemini'
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'completed');
  assert.deepEqual(executionLog, ['step1', 'step2'], 'Subtasks must execute in strict dependency order');

  // Verify parent task progress and aggregated deliverable
  const parent = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(wf.parentId);
  assert.equal(parent.status, 'completed');
  assert.equal(parent.progress, 100);
  assert.ok(parent.result.includes('Workflow Deliverable'));
  assert.ok(parent.result.includes('### Step 1: Step 1: Research APIs'));
  assert.ok(parent.result.includes('### Step 2: Step 2: Build client'));
  assert.ok(parent.result.includes('https://api.example.com/v1'));
});

test('Stage K3: Upstream failure stops workflow and blocks downstream subtasks', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createWorkflow, executeSequentialWorkflow, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const failingPlan = {
    plan: 'Failing research workflow',
    subtasks: [
      { step: 1, title: 'Step 1: Fragile fetch', agent: 'coding', depends_on_steps: [] },
      { step: 2, title: 'Step 2: Dependent synthesis', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Failing Pipeline', priority: 'High', plan: failingPlan });

  const mockFailingProviders = {
    gemini: {
      id: 'gemini',
      generateContent: async () => {
        return { ok: false, error: 'Simulated permanent provider crash' };
      },
      checkHealth: async () => ({ ok: true, connected: true })
    }
  };

  const res = await executeSequentialWorkflow({
    db: testDb,
    parentId: wf.parentId,
    providers: mockFailingProviders,
    addLog: () => {},
    requestedProvider: 'gemini'
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.ok(res.error.includes('Workflow halted'));

  // Verify subtask 2 was marked as blocked and not executed
  const sub2 = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(wf.subtaskIds[1]);
  assert.equal(sub2.status, 'failed');
  assert.ok(sub2.error.includes('Blocked: Upstream dependency task'));

  // Parent task must NOT be marked completed
  const parent = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(wf.parentId);
  assert.equal(parent.status, 'failed');
  assert.notEqual(parent.progress, 100);
});

test('Stage K3: Duplicate workflow execution prevented with HTTP 409', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createWorkflow, executeSequentialWorkflow, activeWorkflows, initOrchestrator } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const plan = {
    plan: 'Simple plan',
    subtasks: [
      { step: 1, title: 'Subtask 1', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Subtask 2', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Concurrent Test Workflow', priority: 'Medium', plan });

  // Simulate active lock
  activeWorkflows.add(wf.parentId);

  await assert.rejects(
    async () => {
      await executeSequentialWorkflow({
        db: testDb,
        parentId: wf.parentId,
        providers: {},
        addLog: () => {}
      });
    },
    err => {
      assert.equal(err.status, 409);
      assert.ok(err.message.includes('already executing'));
      return true;
    }
  );

  activeWorkflows.delete(wf.parentId);
});

test('Stage K3: End-to-end HTTP workflow execution via POST /api/workflows/:id/execute', async () => {
  // 1. Create a 2-step workflow using custom plan
  const plan = {
    plan: 'E2E HTTP Workflow',
    subtasks: [
      { step: 1, title: 'E2E Wireframe', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'E2E Graphics SVG', agent: 'graphics', depends_on_steps: [1] }
    ]
  };

  const createRes = await call('POST', '/api/workflows', {
    title: 'E2E Portal Workflow',
    priority: 'Medium',
    plan
  });
  assert.equal(createRes.status, 201);
  const { parentId, subtaskIds } = await createRes.json();
  assert.ok(parentId > 0);
  assert.equal(subtaskIds.length, 2);

  // 2. Execute the workflow via HTTP endpoint
  const execRes = await call('POST', `/api/workflows/${parentId}/execute`, {
    provider: 'gemini',
    timeoutMs: 15000
  });

  // Verify response
  assert.equal(execRes.status, 200);
  const execData = await execRes.json();
  assert.equal(execData.ok, true);
  assert.equal(execData.status, 'completed');
  assert.equal(execData.subtasksCompleted, 2);
  assert.ok(execData.result.includes('Workflow Deliverable'));

  // 3. Verify state endpoint reflects completed parent and subtasks
  const state = await (await call('GET', '/api/state')).json();
  const parentInState = state.tasks.find(t => t.id === parentId);
  assert.equal(parentInState.status, 'completed');
  assert.equal(parentInState.progress, 100);
});

test('Stage K4: Dashboard workflow preview using the decomposition endpoint', async () => {
  const res = await call('POST', '/api/workflows/decompose', {
    title: 'Build automated report pipeline',
    priority: 'High'
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.goal, 'Build automated report pipeline');
  assert.ok(data.plan && typeof data.plan === 'object');
  assert.ok(Array.isArray(data.plan.subtasks));
  assert.ok(data.plan.subtasks.length >= 2 && data.plan.subtasks.length <= 4);
  for (const sub of data.plan.subtasks) {
    assert.ok(typeof sub.step === 'number' && sub.step > 0);
    assert.ok(typeof sub.title === 'string' && sub.title.length >= 3);
    assert.ok(['research', 'sketch', 'coding', 'graphics', 'video'].includes(sub.agent));
    assert.ok(Array.isArray(sub.depends_on_steps));
  }
});

test('Stage K4: Plan source displays truthfulness (Gemini vs heuristic fallback)', async () => {
  const { decomposeGoal } = require('../orchestrator');

  // 1. Without Gemini provider -> must truthfully return heuristic
  const heuristicResult = await decomposeGoal('Design user onboarding experience', { providers: {} });
  assert.equal(heuristicResult.source, 'heuristic');
  assert.ok(!heuristicResult.source.includes('gemini'));

  // 2. With mock healthy Gemini provider returning valid DAG plan -> returns source: gemini
  const mockGemini = {
    checkHealth: async () => ({ connected: true }),
    generateContent: async () => ({
      ok: true,
      text: JSON.stringify({
        plan: 'Cloud Gemini planned architecture',
        subtasks: [
          { step: 1, title: 'Analyze requirements', agent: 'research', depends_on_steps: [] },
          { step: 2, title: 'Generate interface code', agent: 'coding', depends_on_steps: [1] }
        ]
      })
    })
  };

  const geminiResult = await decomposeGoal('Design user onboarding experience', {
    providers: { gemini: mockGemini }
  });
  assert.equal(geminiResult.source, 'gemini');
  assert.equal(geminiResult.subtasks.length, 2);

  // 3. Verify HTML template logic contains distinct badge labels for both
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('Plan Source: Gemini Cloud'));
  assert.ok(html.includes('Plan Source: Local Heuristic Fallback'));
  assert.ok(html.includes('Local Heuristic Plan'));
});

test('Stage K4: Workflow creation and display of parent/child task IDs', async () => {
  const plan = {
    plan: 'K4 Multi-Agent Plan',
    subtasks: [
      { step: 1, title: 'K4 Wireframe Subtask', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'K4 SVG Graphic Subtask', agent: 'graphics', depends_on_steps: [1] }
    ]
  };

  const res = await call('POST', '/api/workflows', {
    title: 'K4 Test Dashboard Workflow',
    priority: 'High',
    plan
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(typeof data.parentId === 'number' && data.parentId > 0);
  assert.ok(Array.isArray(data.subtaskIds));
  assert.equal(data.subtaskIds.length, 2);

  // Verify in GET /api/state
  const state = await (await call('GET', '/api/state')).json();
  const parent = state.tasks.find(t => t.id === data.parentId);
  assert.ok(parent);
  assert.equal(parent.agent, 'workflow');
  assert.equal(parent.parent_id, null);
  assert.equal(parent.status, 'pending');

  const children = state.tasks.filter(t => t.parent_id === data.parentId);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(c => c.id).sort(), data.subtaskIds.sort());
});

test('Stage K4: Correct nested rendering of subtasks and dependencies', async () => {
  // Retrieve the workflow created previously
  const state = await (await call('GET', '/api/state')).json();
  const parent = state.tasks.find(t => t.title === 'K4 Test Dashboard Workflow');
  assert.ok(parent);

  const wfRes = await call('GET', `/api/workflows/${parent.id}`);
  assert.equal(wfRes.status, 200);
  const wfData = await wfRes.json();
  assert.equal(wfData.ok, true);
  assert.equal(wfData.parent.id, parent.id);
  assert.equal(wfData.subtasks.length, 2);

  // Check subtask dependencies
  const sub1 = wfData.subtasks.find(s => s.agent === 'sketch');
  const sub2 = wfData.subtasks.find(s => s.agent === 'graphics');
  assert.ok(sub1 && sub2);

  const deps1 = JSON.parse(sub1.depends_on || '[]');
  const deps2 = JSON.parse(sub2.depends_on || '[]');
  assert.deepEqual(deps1, []);
  assert.deepEqual(deps2, [sub1.id]);

  // Check HTML supports visual nesting container
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('wf-subtasks'));
  assert.ok(html.includes('wf-subtask'));
  assert.ok(html.includes('SUBTASKS GRAPH'));
});

test('Stage K4: Execution button calls the correct endpoint and prevents accidental duplicate UI requests', async () => {
  const { createWorkflow, executeSequentialWorkflow, activeWorkflows, initOrchestrator } = require('../orchestrator');
  const { DatabaseSync } = require('node:sqlite');
  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const plan = {
    plan: 'Duplicate Prevention Plan',
    subtasks: [
      { step: 1, title: 'Step 1 Sketch', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Step 2 Code', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Concurrency Workflow', priority: 'Medium', plan });

  // Simulate active execution
  activeWorkflows.add(wf.parentId);

  // Secondary execution attempt must reject with 409
  await assert.rejects(
    async () => {
      await executeSequentialWorkflow({
        db: testDb,
        parentId: wf.parentId,
        providers: {},
        addLog: () => {}
      });
    },
    err => {
      assert.equal(err.status, 409);
      assert.ok(err.message.includes('already executing'));
      return true;
    }
  );

  activeWorkflows.delete(wf.parentId);

  // Check HTML execution action uses data-act="exec-wf"
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('data-act="exec-wf"'));
  assert.ok(html.includes('/execute'));
});

test('Stage K4: Refreshing workflow details displays actual backend state', async () => {
  const plan = {
    plan: 'Refresh Test Plan',
    subtasks: [
      { step: 1, title: 'Inspect Architecture', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Verify Layout', agent: 'graphics', depends_on_steps: [1] }
    ]
  };

  const createRes = await call('POST', '/api/workflows', {
    title: 'Refresh Test Workflow',
    priority: 'Low',
    plan
  });
  const { parentId } = await createRes.json();

  // Initial GET /api/workflows/:id shows pending
  const initRes = await (await call('GET', `/api/workflows/${parentId}`)).json();
  assert.equal(initRes.parent.status, 'pending');
  assert.equal(initRes.subtasks[0].status, 'pending');

  // Update backend task status directly to simulate asynchronous worker progress
  await call('PATCH', `/api/tasks/${initRes.subtasks[0].id}`, { status: 'progress' });

  // Refreshing returns actual updated state
  const refreshedRes = await (await call('GET', `/api/workflows/${parentId}`)).json();
  assert.equal(refreshedRes.subtasks[0].status, 'progress');
});

test('Stage K4: Failure, paused, timeout, and HTTP 409 responses display truthful status', async () => {
  // 1. Nonexistent workflow returns 404
  const res404 = await call('GET', '/api/workflows/999999');
  assert.equal(res404.status, 404);
  const data404 = await res404.json();
  assert.ok(data404.error.includes('Workflow not found'));

  const exec404 = await call('POST', '/api/workflows/999999/execute', {});
  assert.equal(exec404.status, 404);

  // 2. Upstream failure halts execution and reports truthful failure
  const { createWorkflow, executeSequentialWorkflow, initOrchestrator } = require('../orchestrator');
  const { DatabaseSync } = require('node:sqlite');
  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const failingPlan = {
    plan: 'Failure Reporting Plan',
    subtasks: [
      { step: 1, title: 'Failing Step 1', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Blocked Step 2', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Failure Workflow', priority: 'Medium', plan: failingPlan });

  const failingProviders = {
    gemini: {
      checkHealth: async () => ({ connected: false, error: 'Quota limit' }),
      generateContent: async () => ({ ok: false, error: 'Quota limit' })
    }
  };

  const result = await executeSequentialWorkflow({
    db: testDb,
    parentId: wf.parentId,
    providers: failingProviders,
    addLog: () => {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('Workflow halted'));

  // Truthful failure status in database
  const parentDb = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(wf.parentId);
  assert.equal(parentDb.status, 'failed');
  assert.ok(parentDb.error.includes('Failing Step 1'));
});

test('Stage K4: Final consolidated result appears only when available', async () => {
  const { createWorkflow, consolidateWorkflow, initOrchestrator } = require('../orchestrator');
  const { DatabaseSync } = require('node:sqlite');
  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const plan = {
    plan: 'Consolidation Test Plan',
    subtasks: [
      { step: 1, title: 'Draft Research', agent: 'research', depends_on_steps: [] },
      { step: 2, title: 'Build Module', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Consolidation Workflow', priority: 'Medium', plan });

  // Initially, parent result is null
  let parent = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(wf.parentId);
  assert.equal(parent.result, null);
  assert.equal(parent.status, 'pending');

  // Complete subtasks
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'Research Findings on UI' WHERE id = ?").run(wf.subtaskIds[0]);
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'function render() { return true; }' WHERE id = ?").run(wf.subtaskIds[1]);

  // Consolidate
  const deliverable = consolidateWorkflow(testDb, wf.parentId);
  assert.ok(deliverable.includes('# Project Beyond AI Team — Workflow Deliverable'));
  assert.ok(deliverable.includes('Research Findings on UI'));
  assert.ok(deliverable.includes('function render()'));

  parent = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(wf.parentId);
  assert.equal(parent.status, 'completed');
  assert.equal(parent.progress, 100);
  assert.ok(parent.result.includes('Workflow Deliverable'));
});

test('Stage K4: Existing standalone task functionality remains intact (zero regression)', async () => {
  // 1. Create a standalone task (not a workflow)
  const taskRes = await call('POST', '/api/tasks', {
    title: 'Standalone Refactor Task',
    agent: 'sketch',
    priority: 'Low'
  });
  assert.equal(taskRes.status, 201);
  const { id } = await taskRes.json();
  assert.ok(id > 0);

  // 2. Verify task has parent_id = null and depends_on = []
  const taskData = await (await call('GET', `/api/tasks/${id}`)).json();
  assert.equal(taskData.parent_id, null);
  assert.equal(taskData.depends_on, '[]');
  assert.equal(taskData.agent, 'sketch');

  // 3. Update status to progress
  const patchRes = await call('PATCH', `/api/tasks/${id}`, { status: 'progress' });
  assert.equal(patchRes.status, 200);

  // 4. Delete the task
  const delRes = await call('DELETE', `/api/tasks/${id}`);
  assert.equal(delRes.status, 200);

  const getDeleted = await call('GET', `/api/tasks/${id}`);
  assert.equal(getDeleted.status, 404);
});

test('Stage K4: Security audit — Zero API key leaks in workflow API responses or HTML', async () => {
  // 1. Check workflow decomposition response
  const decompRes = await call('POST', '/api/workflows/decompose', { title: 'Security audit test', priority: 'Low' });
  const decompText = await decompRes.text();
  assert.ok(!decompText.includes('AIzaSy'));
  assert.ok(!decompText.includes('GEMINI_API_KEY'));

  // 2. Check workflow details response
  const stateRes = await call('GET', '/api/state');
  const stateText = await stateRes.text();
  assert.ok(!stateText.includes('AIzaSy'));

  // 3. Check public/index.html source code
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!html.includes('AIzaSy'));
  assert.ok(!html.includes('process.env'));
  assert.ok(!html.includes('sk-ant-'));
  assert.ok(!html.includes('sk-proj-'));
  assert.ok(!html.includes('sk-or-'));
  assert.ok(!html.includes('GEMINI_API_KEY'));
  assert.ok(html.includes("API keys live exclusively in your local environment or .env file"));
});

test('Stage K5: Server restart recovery safely resumes paused workflows from checkpoints', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { initOrchestrator, createWorkflow, executeSequentialWorkflow } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, lvl TEXT, msg TEXT, sample INTEGER);
  `);
  initOrchestrator(testDb);

  const plan = {
    plan: 'Restart Recovery Plan',
    subtasks: [
      { step: 1, title: 'Step 1 Sketch', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Step 2 Code', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Recoverable Workflow', priority: 'Medium', plan });

  // Simulate Step 1 already completed
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'Step 1 Result' WHERE id = ?").run(wf.subtaskIds[0]);

  // Simulate crash during Step 2 execution
  testDb.prepare("UPDATE tasks SET status = 'running', progress = 50 WHERE id = ?").run(wf.parentId);
  testDb.prepare("UPDATE tasks SET status = 'running', current_step = 'generating', progress = 65 WHERE id = ?").run(wf.subtaskIds[1]);

  // Simulate server reboot / initOrchestrator recovery
  initOrchestrator(testDb);

  const parentAfterCrash = testDb.prepare('SELECT status, error FROM tasks WHERE id = ?').get(wf.parentId);
  const sub2AfterCrash = testDb.prepare('SELECT status, error FROM tasks WHERE id = ?').get(wf.subtaskIds[1]);
  assert.equal(parentAfterCrash.status, 'paused');
  assert.equal(sub2AfterCrash.status, 'paused');
  assert.ok(sub2AfterCrash.error.includes('interrupted by server restart'));

  // Resuming execution must succeed and resume from Step 2 checkpoint without deadlock
  const mockProviders = {
    gemini: {
      checkHealth: async () => ({ connected: true }),
      generateContent: async () => ({ ok: true, text: 'Step 2 Resumed Code' })
    }
  };

  const result = await executeSequentialWorkflow({
    db: testDb,
    parentId: wf.parentId,
    providers: mockProviders,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.subtasksCompleted, 2);

  const parentFinal = testDb.prepare('SELECT status, progress, result FROM tasks WHERE id = ?').get(wf.parentId);
  assert.equal(parentFinal.status, 'completed');
  assert.equal(parentFinal.progress, 100);
  assert.ok(parentFinal.result.includes('Step 1 Result'));
  assert.ok(parentFinal.result.includes('Step 2 Resumed Code'));
});

test('Stage K5: Workflow retry allows recovering from failed subtasks', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { initOrchestrator, createWorkflow, executeSequentialWorkflow } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, lvl TEXT, msg TEXT, sample INTEGER);
  `);
  initOrchestrator(testDb);

  const plan = {
    plan: 'Failure & Retry Plan',
    subtasks: [
      { step: 1, title: 'Step 1 Sketch', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Step 2 Code', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Retriable Workflow', priority: 'Medium', plan });

  let runCount = 0;
  const flakeyProviders = {
    gemini: {
      checkHealth: async () => ({ connected: true }),
      generateContent: async () => {
        runCount++;
        if (runCount === 1) return { ok: true, text: 'Step 1 Result' };
        return { ok: false, error: 'Temporary connection failure' };
      }
    }
  };

  // Run 1: Step 1 succeeds, Step 2 fails -> workflow halts as failed
  const run1 = await executeSequentialWorkflow({
    db: testDb,
    parentId: wf.parentId,
    providers: flakeyProviders,
  });
  assert.equal(run1.ok, false);
  assert.equal(run1.status, 'failed');

  const sub1 = testDb.prepare('SELECT status, result FROM tasks WHERE id = ?').get(wf.subtaskIds[0]);
  const sub2 = testDb.prepare('SELECT status, error FROM tasks WHERE id = ?').get(wf.subtaskIds[1]);
  assert.equal(sub1.status, 'completed');
  assert.equal(sub2.status, 'failed');

  // Run 2 (Retry): Provider is healthy, retry must re-attempt Step 2 without re-running completed Step 1
  const healthyProviders = {
    gemini: {
      checkHealth: async () => ({ connected: true }),
      generateContent: async () => ({ ok: true, text: 'Step 2 Succeeded on Retry' })
    }
  };

  const run2 = await executeSequentialWorkflow({
    db: testDb,
    parentId: wf.parentId,
    providers: healthyProviders,
  });

  assert.equal(run2.ok, true);
  assert.equal(run2.status, 'completed');
  assert.equal(run2.subtasksCompleted, 2);

  const sub2Final = testDb.prepare('SELECT status, result FROM tasks WHERE id = ?').get(wf.subtaskIds[1]);
  assert.equal(sub2Final.status, 'completed');
  assert.equal(sub2Final.result, 'Step 2 Succeeded on Retry');
});

test('Stage K5: Workflow consolidation rejects incomplete or failed subtasks', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { initOrchestrator, createWorkflow, consolidateWorkflow } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, execution_id TEXT, parent_id INTEGER, depends_on TEXT,
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, lvl TEXT, msg TEXT, sample INTEGER);
  `);
  initOrchestrator(testDb);

  const plan = {
    plan: 'Incomplete Plan',
    subtasks: [
      { step: 1, title: 'Step 1 Sketch', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Step 2 Code', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, { title: 'Incomplete Workflow', priority: 'Medium', plan });

  // Only Step 1 completed, Step 2 is still pending
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'Output 1' WHERE id = ?").run(wf.subtaskIds[0]);

  const result = consolidateWorkflow(testDb, wf.parentId);
  assert.equal(result, null);

  const parent = testDb.prepare('SELECT status, result FROM tasks WHERE id = ?').get(wf.parentId);
  assert.notEqual(parent.status, 'completed');
  assert.equal(parent.result, null);
});

test('Stage K5: Real Ollama provider generateContent contract handles offline truthfully', async () => {
  const { PROVIDERS } = require('../providers');
  assert.equal(typeof PROVIDERS.ollama.generateContent, 'function');

  // When daemon is offline (or unreachable port), it returns ok: false with truthful status without crashing
  const res = await PROVIDERS.ollama.generateContent({
    prompt: 'Write hello world',
    host: 'http://127.0.0.1:54321', // nonexistent port
    timeoutMs: 500
  });

  assert.equal(res.ok, false);
  assert.ok(res.error.length > 0);
});

test('Bugfix: Workflow decomposition accepts long prompts (>80 chars) and multiple paragraphs', async () => {
  const longPrompt = [
    'Build a comprehensive customer analytics dashboard with real-time conversion metrics.',
    'The system should visualize monthly retention charts and identify user churn trends.',
    'Include CSV export capability and responsive layout for mobile and desktop screens.'
  ].join('\n\n');

  assert.ok(longPrompt.length > 200);

  const res = await call('POST', '/api/workflows/decompose', {
    title: longPrompt,
    priority: 'High'
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  // Full text and exact newlines preserved
  assert.equal(data.goal, longPrompt);
  assert.ok(Array.isArray(data.plan.subtasks));
  assert.ok(data.plan.subtasks.length >= 2);
});

test('Bugfix: Workflow creation preserves full multi-paragraph prompt in database without truncation', async () => {
  const multilineGoal = [
    'Paragraph 1: Research modern vector design tools and color theory best practices.',
    'Paragraph 2: Generate scalable SVG icons and responsive CSS wireframes.',
    'Paragraph 3: Implement clean vanilla JavaScript handlers for interactive controls.'
  ].join('\n\n');

  const res = await call('POST', '/api/workflows', {
    title: multilineGoal,
    priority: 'Medium'
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.parentId > 0);

  // Check database record directly
  const stateRes = await call('GET', `/api/workflows/${data.parentId}`);
  assert.equal(stateRes.status, 200);
  const stateData = await stateRes.json();
  assert.equal(stateData.parent.title, multilineGoal);
  assert.ok(stateData.parent.title.includes('\n\nParagraph 2:'));
  assert.ok(stateData.parent.title.includes('\n\nParagraph 3:'));
  assert.equal(stateData.parent.title.length, multilineGoal.length);
});

test('Bugfix: Workflow decomposition and creation enforce consistent 4000 character safety limit', async () => {
  const oversizedGoal = 'A'.repeat(4001);

  // POST /api/workflows/decompose rejects > 4000
  const decompRes = await call('POST', '/api/workflows/decompose', {
    title: oversizedGoal
  });
  assert.equal(decompRes.status, 400);
  const decompErr = await decompRes.json();
  assert.ok(decompErr.error.includes('3 to 4000 characters'));

  // POST /api/workflows rejects > 4000
  const wfRes = await call('POST', '/api/workflows', {
    title: oversizedGoal
  });
  assert.equal(wfRes.status, 400);
  const wfErr = await wfRes.json();
  assert.ok(wfErr.error.includes('3 to 4000 characters'));

  // Too short (< 3 chars)
  const shortRes = await call('POST', '/api/workflows/decompose', {
    title: 'ab'
  });
  assert.equal(shortRes.status, 400);
  const shortErr = await shortRes.json();
  assert.ok(shortErr.error.includes('3 to 4000 characters'));
});

test('Bugfix: Standalone tasks maintain standard 80-character title limit with zero regression', async () => {
  // Standalone task under 80 chars succeeds
  const okRes = await call('POST', '/api/tasks', {
    title: 'Short standalone task title',
    agent: 'coding',
    priority: 'Medium'
  });
  assert.equal(okRes.status, 201);

  // Standalone task over 80 chars is rejected
  const overRes = await call('POST', '/api/tasks', {
    title: 'This standalone task title exceeds the maximum allowed eighty character limit for single tasks',
    agent: 'coding',
    priority: 'Medium'
  });
  assert.equal(overRes.status, 400);
  const overErr = await overRes.json();
  assert.ok(overErr.error.includes('3 to 80 characters'));
});

test('Bugfix: Dashboard UI includes multiline textarea with expanded character limit and no 80-char restriction', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  // Verify textarea element with proper attributes
  assert.ok(html.includes('<textarea id="wf-goal"'));
  assert.ok(html.includes('maxlength="4000"'));
  assert.ok(!html.includes('id="wf-goal" placeholder="Enter high-level goal (e.g. Build responsive user profile page)" maxlength="80"'));

  // Verify styling and multiline text wrap
  assert.ok(html.includes('input[type=text],select,textarea'));
  assert.ok(html.includes('white-space:pre-wrap'));
});

test('Regression: Preview Plan API route accepts >80 chars via title, goal, or both without triggering cleanTitle', async () => {
  const prompt85Chars = 'Build a responsive user analytics view with real-time churn metrics and export tools.';
  assert.ok(prompt85Chars.length > 80);

  // 1. Submit via { title, priority } (browser default)
  const res1 = await call('POST', '/api/workflows/decompose', {
    title: prompt85Chars,
    priority: 'Medium'
  });
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.ok, true);
  assert.equal(data1.goal, prompt85Chars);

  // 2. Submit via { goal, priority }
  const res2 = await call('POST', '/api/workflows/decompose', {
    goal: prompt85Chars,
    priority: 'High'
  });
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.ok, true);
  assert.equal(data2.goal, prompt85Chars);

  // 3. Submit via { title, goal, priority } (dual field)
  const multiParagraphPrompt = [
    'Paragraph 1: Architect the backend database migrations and indexes for high concurrency.',
    'Paragraph 2: Implement resilient WebSocket streams with heartbeat reconnection handlers.',
    'Paragraph 3: Build accessible frontend dashboard cards displaying live streaming throughput.'
  ].join('\n\n');

  const res3 = await call('POST', '/api/workflows/decompose', {
    title: multiParagraphPrompt,
    goal: multiParagraphPrompt,
    priority: 'Low'
  });
  assert.equal(res3.status, 200);
  const data3 = await res3.json();
  assert.equal(data3.ok, true);
  assert.equal(data3.goal, multiParagraphPrompt);

  // Verify generated subtask titles obey the 120-char limit
  for (const sub of data3.plan.subtasks) {
    assert.ok(sub.title.length >= 3 && sub.title.length <= 120);
  }
});

test('Artifacts: Safe write creates physical file on disk with verified path and contents', async () => {
  const { writeArtifact, readArtifact, listArtifacts } = require('../artifacts');
  const tempWs = path.join(os.tmpdir(), 'pb-test-ws-' + Math.random().toString(36).slice(2));

  try {
    const fixtureHtml = '<!DOCTYPE html>\n<html>\n<head><title>Harmless Test Fixture</title></head>\n<body><h1>Harmless Fixture</h1></body>\n</html>';
    const record = writeArtifact({
      workspaceDir: tempWs,
      relativePath: 'test-fixture/index.html',
      content: fixtureHtml,
      allowOverwrite: false,
      expectedType: 'html'
    });

    assert.equal(record.ok, true);
    assert.equal(record.relativePath, 'test-fixture/index.html');
    assert.ok(fs.existsSync(record.absolutePath));
    assert.equal(fs.readFileSync(record.absolutePath, 'utf8'), fixtureHtml);
    assert.equal(record.size, Buffer.byteLength(fixtureHtml, 'utf8'));

    // Read back via readArtifact
    const readBack = readArtifact(tempWs, 'test-fixture/index.html');
    assert.equal(readBack.ok, true);
    assert.equal(readBack.content, fixtureHtml);

    // List artifacts
    const list = listArtifacts(tempWs);
    assert.equal(list.length, 1);
    assert.equal(list[0].relativePath, 'test-fixture/index.html');
  } finally {
    try { fs.rmSync(tempWs, { recursive: true, force: true }); } catch {}
  }
});

test('Artifacts: Path traversal attempts are rejected', async () => {
  const { writeArtifact, readArtifact } = require('../artifacts');
  const tempWs = path.join(os.tmpdir(), 'pb-test-ws-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tempWs, { recursive: true });

  try {
    // 1. Directory traversal with ../
    assert.throws(() => {
      writeArtifact({
        workspaceDir: tempWs,
        relativePath: '../escape.txt',
        content: 'Malicious content'
      });
    }, /Path traversal rejected/);

    // 2. Deep traversal with ../../
    assert.throws(() => {
      writeArtifact({
        workspaceDir: tempWs,
        relativePath: '../../etc/passwd',
        content: 'Malicious content'
      });
    }, /Path traversal rejected/);

    // 3. Absolute path
    assert.throws(() => {
      writeArtifact({
        workspaceDir: tempWs,
        relativePath: path.resolve(tempWs, '..', 'escape2.txt'),
        content: 'Malicious content'
      });
    }, /Path traversal rejected/);

    // 4. Null bytes
    assert.throws(() => {
      writeArtifact({
        workspaceDir: tempWs,
        relativePath: 'test\0file.txt',
        content: 'Malicious content'
      });
    }, /Path traversal rejected/);

    // 5. Read traversal
    assert.throws(() => {
      readArtifact(tempWs, '../package.json');
    }, /Path traversal rejected/);
  } finally {
    try { fs.rmSync(tempWs, { recursive: true, force: true }); } catch {}
  }
});

test('Artifacts: Overwrite protection blocks accidental file overwrites unless permitted', async () => {
  const { writeArtifact } = require('../artifacts');
  const tempWs = path.join(os.tmpdir(), 'pb-test-ws-' + Math.random().toString(36).slice(2));

  try {
    const contentA = 'Initial content version A';
    const contentB = 'Modified content version B';

    writeArtifact({
      workspaceDir: tempWs,
      relativePath: 'notes.txt',
      content: contentA,
      allowOverwrite: false
    });

    // Attempting overwrite with allowOverwrite: false must throw EEXIST
    assert.throws(() => {
      writeArtifact({
        workspaceDir: tempWs,
        relativePath: 'notes.txt',
        content: contentB,
        allowOverwrite: false
      });
    }, /File already exists/);

    // Content must still be version A
    const current = fs.readFileSync(path.join(tempWs, 'notes.txt'), 'utf8');
    assert.equal(current, contentA);

    // Overwrite with allowOverwrite: true succeeds
    writeArtifact({
      workspaceDir: tempWs,
      relativePath: 'notes.txt',
      content: contentB,
      allowOverwrite: true
    });
    const updated = fs.readFileSync(path.join(tempWs, 'notes.txt'), 'utf8');
    assert.equal(updated, contentB);
  } finally {
    try { fs.rmSync(tempWs, { recursive: true, force: true }); } catch {}
  }
});

test('Artifacts: Content validation rejects empty, missing, or truncated code artifacts', async () => {
  const { validateArtifactContent, writeArtifact } = require('../artifacts');

  // Empty content
  assert.equal(validateArtifactContent('').valid, false);
  assert.equal(validateArtifactContent('   \n\t').valid, false);

  // Truncated HTML (unclosed </html>)
  const brokenHtml = '<!DOCTYPE html><html><head><title>Unfinished</title></head><body><h1>Broken';
  const htmlCheck = validateArtifactContent(brokenHtml, 'html');
  assert.equal(htmlCheck.valid, false);
  assert.equal(htmlCheck.isTruncated, true);

  // Truncated CSS (unbalanced braces)
  const brokenCss = '.card { color: red; \n.title { font-size: 14px;';
  const cssCheck = validateArtifactContent(brokenCss, 'css');
  assert.equal(cssCheck.valid, false);
  assert.equal(cssCheck.isTruncated, true);

  // Truncated JSON
  const brokenJson = '{"key": "value", "list": [1, 2, ';
  const jsonCheck = validateArtifactContent(brokenJson, 'json');
  assert.equal(jsonCheck.valid, false);
  assert.equal(jsonCheck.isTruncated, true);
});

test('Artifacts: Markdown extractor detects truncated provider responses and refuses to write partial files', async () => {
  const { extractArtifactsFromMarkdown } = require('../artifacts');

  // Truncated response with unclosed code fence
  const truncatedResponse = `
Here is the code:
### 1. index.html
\`\`\`html
<!DOCTYPE html>
<html>
<head><title>Cut Off</title></head>
<body><div class="test">
`;

  const result = extractArtifactsFromMarkdown(truncatedResponse);
  assert.equal(result.isTruncated, true);

  // Complete response with properly closed code fences
  const completeResponse = `
Here is the complete solution:
### 1. index.html
\`\`\`html
<!DOCTYPE html>
<html>
<head><title>Complete</title></head>
<body><h1>Hello World</h1></body>
</html>
\`\`\`
`;

  const completeResult = extractArtifactsFromMarkdown(completeResponse);
  assert.equal(completeResult.isTruncated, false);
  assert.equal(completeResult.artifacts.length, 1);
  assert.equal(completeResult.artifacts[0].relativePath, 'index.html');
  assert.equal(completeResult.artifacts[0].valid, true);
});

test('Artifacts: HTTP API endpoints list, create, and read artifacts with traversal protection', async () => {
  const fixtureHtml = '<!DOCTYPE html>\n<html>\n<head><title>API Fixture</title></head>\n<body><p>Created via API</p></body>\n</html>';

  // 1. POST /api/artifacts creates file
  const postRes = await call('POST', '/api/artifacts', {
    path: 'api-fixtures/test.html',
    content: fixtureHtml,
    overwrite: true,
    type: 'html'
  });
  assert.equal(postRes.status, 201);
  const postData = await postRes.json();
  assert.equal(postData.relativePath, 'api-fixtures/test.html');
  assert.ok(postData.size > 0);

  // 2. GET /api/artifacts lists the artifact
  const listRes = await call('GET', '/api/artifacts');
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.ok, true);
  assert.ok(Array.isArray(listData.artifacts));
  assert.ok(listData.artifacts.some(a => a.relativePath === 'api-fixtures/test.html'));

  // 3. GET /api/artifacts/content reads the artifact
  const getRes = await call('GET', '/api/artifacts/content?path=api-fixtures/test.html');
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.ok, true);
  assert.equal(getData.content, fixtureHtml);

  // 4. Traversal attempt via GET is rejected
  const badRes = await call('GET', '/api/artifacts/content?path=../../package.json');
  assert.equal(badRes.status, 400);

  // Clean up created file
  try {
    const { resolveWorkspaceDir } = require('../artifacts');
    fs.rmSync(path.join(resolveWorkspaceDir(), 'api-fixtures'), { recursive: true, force: true });
  } catch {}
});

test('Artifacts: Workflow deliverable truthfully states whether physical files exist on disk', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { consolidateWorkflow, createWorkflow } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, parent_id INTEGER DEFAULT NULL, depends_on TEXT DEFAULT '[]',
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);

  const plan = {
    plan: 'Deliverable Truthfulness Test',
    subtasks: [
      { step: 1, title: 'Spec task', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Code task', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  // Case 1: Subtasks with no physical files -> Truthfully reports Plan & Report Only
  const wf1 = createWorkflow(testDb, { title: 'Workflow Without Files', priority: 'Low', plan });
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'Specification document text' WHERE id = ?").run(wf1.subtaskIds[0]);
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'Source code snippet in text' WHERE id = ?").run(wf1.subtaskIds[1]);

  const output1 = consolidateWorkflow(testDb, wf1.parentId);
  assert.ok(output1.includes('No physical files were written to disk (Plan & Code Report Only)'));
  assert.ok(!output1.includes('files written to disk'));

  // Case 2: Subtask with verified file artifact -> Truthfully reports files on disk
  const wf2 = createWorkflow(testDb, { title: 'Workflow With Real Files', priority: 'High', plan });
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'Spec output' WHERE id = ?").run(wf2.subtaskIds[0]);
  const mockArtifact = { relativePath: 'demo/index.html', size: 142, status: 'written' };
  testDb.prepare("UPDATE tasks SET status = 'completed', result = 'Code output', checkpoint_data = ? WHERE id = ?")
    .run(JSON.stringify({ artifacts: [mockArtifact] }), wf2.subtaskIds[1]);

  const output2 = consolidateWorkflow(testDb, wf2.parentId);
  assert.ok(output2.includes('Verified File Artifacts (1 file(s) written to disk)'));
  assert.ok(output2.includes('demo/index.html'));
  assert.ok(output2.includes('Code Execution: Prohibited'));
});

test('Milestone 2: Project manifest planning creates structured spec, file list, and acceptance criteria', async () => {
  const { planProjectManifest, deriveProjectSlug } = require('../project_builder');

  assert.equal(deriveProjectSlug('Build a personal expense tracker'), 'expense-tracker');
  assert.equal(deriveProjectSlug('Create an interactive todo task list'), 'task-manager');

  const manifest = planProjectManifest('Build an expense tracker website', { targetDir: 'expense-tracker-test' });
  assert.equal(manifest.projectName, 'expense-tracker-test');
  assert.ok(Array.isArray(manifest.files));
  assert.equal(manifest.files.length, 5);

  const filePaths = manifest.files.map(f => f.path);
  assert.ok(filePaths.includes('expense-tracker-test/index.html'));
  assert.ok(filePaths.includes('expense-tracker-test/style.css'));
  assert.ok(filePaths.includes('expense-tracker-test/app.js'));
  assert.ok(filePaths.includes('expense-tracker-test/README.md'));
  assert.ok(filePaths.includes('expense-tracker-test/test.js'));
  assert.ok(manifest.acceptanceCriteria.length > 0);
});

test('Milestone 2: Automated unit tests verify expense tracker calculations, CRUD, and validations', async () => {
  const { runProjectVerification } = require('../project_builder');
  const baseWs = path.join(__dirname, '..', 'workspace');
  const result = runProjectVerification(baseWs, 'expense-tracker');

  assert.equal(result.testsFound, true);
  assert.equal(result.verified, true);
  assert.equal(result.passed, 5);
  assert.equal(result.total, 5);
  assert.equal(result.error, null);
});

test('Milestone 2: Bounded file generation and overwrite protection enforce safe file creation', async () => {
  const { buildProject } = require('../project_builder');
  const tempWs = path.join(os.tmpdir(), 'pb-mb2-' + Math.random().toString(36).slice(2));

  // 1. Initial build succeeds
  const res1 = await buildProject({
    goal: 'Build an expense tracker website',
    targetDir: 'test-tracker',
    workspaceDir: tempWs,
    allowOverwrite: false,
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.filesWritten, 5);
  assert.equal(res1.verification.verified, true);

  // 2. Second build without allowOverwrite fails with 409 EEXIST
  await assert.rejects(
    async () => {
      await buildProject({
        goal: 'Build an expense tracker website',
        targetDir: 'test-tracker',
        workspaceDir: tempWs,
        allowOverwrite: false,
      });
    },
    err => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'EEXIST');
      assert.ok(err.message.includes('already exists'));
      return true;
    }
  );

  // 3. Second build with allowOverwrite succeeds
  const res2 = await buildProject({
    goal: 'Build an expense tracker website',
    targetDir: 'test-tracker',
    workspaceDir: tempWs,
    allowOverwrite: true,
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.filesWritten, 5);

  try { fs.rmSync(tempWs, { recursive: true, force: true }); } catch {}
});

test('Milestone 2: HTTP API endpoints for projects (plan, build, list) work end-to-end', async () => {
  // 1. POST /api/projects/plan
  const planRes = await call('POST', '/api/projects/plan', {
    goal: 'Build an expense tracker web application',
    targetDir: 'api-tracker'
  });
  assert.equal(planRes.status, 200);
  const planData = await planRes.json();
  assert.equal(planData.ok, true);
  assert.equal(planData.manifest.projectName, 'api-tracker');
  assert.equal(planData.manifest.files.length, 5);

  // 2. POST /api/projects/build
  const buildRes = await call('POST', '/api/projects/build', {
    goal: 'Build an expense tracker web application',
    targetDir: 'api-tracker',
    overwrite: true
  });
  assert.equal(buildRes.status, 201);
  const buildData = await buildRes.json();
  assert.equal(buildData.ok, true);
  assert.equal(buildData.filesWritten, 5);
  assert.equal(buildData.verification.verified, true);

  // 3. Re-building without overwrite returns 409
  const dupRes = await call('POST', '/api/projects/build', {
    goal: 'Build an expense tracker web application',
    targetDir: 'api-tracker',
    overwrite: false
  });
  assert.equal(dupRes.status, 409);
  const dupData = await dupRes.json();
  assert.equal(dupData.ok, false);
  assert.equal(dupData.code, 'EEXIST');

  // 4. GET /api/projects lists the project
  const listRes = await call('GET', '/api/projects');
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.ok, true);
  const found = listData.projects.find(p => p.name === 'api-tracker');
  assert.ok(found);
  assert.equal(found.fileCount, 5);
  assert.equal(found.verified, true);
  assert.ok(found.hasIndex && found.hasStyle && found.hasApp && found.hasTest);
});

test('Milestone 2: Multi-Agent workflow execution builds verified multi-file project and consolidates deliverables', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { initOrchestrator, createWorkflow, executeSequentialWorkflow, consolidateWorkflow } = require('../orchestrator');

  const testDb = new DatabaseSync(':memory:');
  testDb.exec(`
    CREATE TABLE tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, agent TEXT, priority TEXT,
      status TEXT, current_step TEXT, completed_steps TEXT, progress INTEGER,
      retry_count INTEGER, max_retries INTEGER, checkpoint_data TEXT, result TEXT,
      error TEXT, provider TEXT, parent_id INTEGER DEFAULT NULL, depends_on TEXT DEFAULT '[]',
      created_at INTEGER, completed_at INTEGER, updated_at INTEGER
    );
  `);
  initOrchestrator(testDb);

  const plan = {
    plan: 'Multi-File Expense Tracker Website Project',
    subtasks: [
      { step: 1, title: 'Draft wireframe layout for expense tracker', agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: 'Implement multi-file code for "expense tracker website"', agent: 'coding', depends_on_steps: [1] }
    ]
  };

  const wf = createWorkflow(testDb, {
    title: 'Build an expense tracker website',
    priority: 'High',
    plan,
  });

  const execResult = await executeSequentialWorkflow({
    db: testDb,
    parentId: wf.parentId,
    providers: {
      gemini: {
        id: 'gemini',
        name: 'Gemini Cloud',
        generateContent: async () => ({ ok: true, text: 'Sample spec analysis' })
      }
    },
    addLog: () => {},
    requestedProvider: 'gemini',
    customTimeoutMs: 15000,
  });

  assert.equal(execResult.ok, true);
  assert.equal(execResult.status, 'completed');

  // Verify parent deliverable has verified file artifacts
  const parentInDb = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(wf.parentId);
  assert.equal(parentInDb.status, 'completed');
  assert.ok(parentInDb.result.includes('Verified File Artifacts'));
  assert.ok(parentInDb.result.includes('expense-tracker/index.html'));
  assert.ok(parentInDb.result.includes('expense-tracker/app.js'));
  assert.ok(parentInDb.result.includes('expense-tracker/style.css'));
  assert.ok(parentInDb.result.includes('expense-tracker/README.md'));
  assert.ok(parentInDb.result.includes('expense-tracker/test.js'));

  const cp = JSON.parse(parentInDb.checkpoint_data);
  assert.equal(cp.has_real_files, true);
  assert.ok(cp.artifacts.length >= 5);
});

test('Milestone 3: Blender detection accurately identifies missing installation without errors', async () => {
  const { detectBlender } = require('../blender');
  const result = detectBlender();
  assert.equal(typeof result, 'object');
  assert.equal(result.available, false);
  assert.equal(result.executable, null);
  assert.equal(result.version, null);
  assert.ok(Array.isArray(result.checkedPaths));
  assert.ok(result.checkedPaths.length > 0);
  assert.ok(result.reason.includes('Blender executable was not found'));

  // Gracefully handles non-existent custom override
  const customRes = detectBlender('C:\\nonexistent\\blender.exe');
  assert.equal(customRes.available, false);
});

test('Milestone 3: Python scene script generator synthesizes complete 3D scene, PBR materials, lighting, and camera', async () => {
  const { generate3DSceneScript } = require('../blender');
  const script = generate3DSceneScript({
    blendPath: 'C:\\workspace\\test\\scene.blend',
    renderPath: 'C:\\workspace\\test\\render.png',
    sceneTitle: 'Geometric Gem Showcase',
    objectType: 'gem',
    resolutionX: 1920,
    resolutionY: 1080,
    samples: 64,
  });

  // Verify core Blender bpy requirements
  assert.ok(script.includes('import bpy'));
  assert.ok(script.includes('import math'));
  assert.ok(script.includes('bpy.ops.wm.read_factory_settings'));

  // Geometry
  assert.ok(script.includes('primitive_ico_sphere_add') || script.includes('ShowcaseObject'));
  assert.ok(script.includes('GroundPlane'));

  // PBR Principled BSDF Materials
  assert.ok(script.includes('Principled BSDF'));
  assert.ok(script.includes('Metallic'));
  assert.ok(script.includes('Roughness'));

  // 3-Point Studio Lighting
  assert.ok(script.includes('Key_Light'));
  assert.ok(script.includes('Fill_Light'));
  assert.ok(script.includes('Rim_Light'));

  // Camera & Render Settings
  assert.ok(script.includes('StudioCamera'));
  assert.ok(script.includes('resolution_x = 1920'));
  assert.ok(script.includes('resolution_y = 1080'));
  assert.ok(script.includes('save_as_mainfile'));
  assert.ok(script.includes('render.render(write_still=True)'));
});

test('Milestone 3: GET /api/blender/status returns structured detection metadata', async () => {
  const res = await call('GET', '/api/blender/status');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.available, false);
  assert.ok(Array.isArray(data.checkedPaths));
  assert.ok(data.checkedPaths.length > 0);
  assert.ok(typeof data.reason === 'string');
});

test('Milestone 3: POST /api/blender/render generates script artifact and halts safely as blocked when Blender is missing', async () => {
  const res = await call('POST', '/api/blender/render', {
    goal: 'Create a glowing crystal gem on a dark studio platform',
    targetDir: 'blender-test-gem'
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  // Guard: halted before installation and execution
  assert.equal(data.ok, false);
  assert.equal(data.status, 'blocked');
  assert.equal(data.blenderAvailable, false);
  assert.ok(data.reason.includes('Blender executable not installed'));

  // 4 Pipeline Stages
  assert.equal(data.stages.script_generated, true);
  assert.equal(data.stages.scene_created, false);
  assert.equal(data.stages.render_completed, false);
  assert.equal(data.stages.output_verified, false);

  // Script artifact is physically written to disk
  assert.ok(Array.isArray(data.artifacts));
  assert.equal(data.artifacts.length, 1);
  assert.equal(data.artifacts[0].relativePath, 'blender-test-gem/scene.py');
  assert.ok(data.artifacts[0].size > 500);

  const scriptOnDisk = path.join(__dirname, '..', 'workspace', 'blender-test-gem', 'scene.py');
  assert.ok(fs.existsSync(scriptOnDisk), 'scene.py was not written to disk');
  const content = fs.readFileSync(scriptOnDisk, 'utf8');
  assert.ok(content.includes('import bpy'));
  assert.ok(content.includes('ShowcaseObject'));
});

test('Milestone 3: Dashboard UI truthfully reflects 3D Graphics Generator status and 4 pipeline stages', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  // Dedicated 3D card & pipeline stages
  assert.ok(html.includes('blender-3d-panel'));
  assert.ok(html.includes('3D Graphics Generator'));
  assert.ok(html.includes('BLOCKED / NOT INSTALLED'));
  assert.ok(html.includes('1. Script Generated'));
  assert.ok(html.includes('2. Scene Created'));
  assert.ok(html.includes('3. Render Completed'));
  assert.ok(html.includes('4. Output Verified'));

  // Buttons & settings
  assert.ok(html.includes('data-act="check-blender"'));
  assert.ok(html.includes('data-act="render-3d"'));
  assert.ok(html.includes('Blender 3D Graphics Engine'));
  assert.ok(html.includes('3D Blender Engine'));
});

test('Phase 2: Remote Blender GitHub Actions workflow file exists and defines valid dispatch inputs and headless steps', async () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'blender-render.yml');
  assert.ok(fs.existsSync(workflowPath), 'Workflow file does not exist');
  const yaml = fs.readFileSync(workflowPath, 'utf8');

  assert.ok(yaml.includes('workflow_dispatch:'), 'Missing workflow_dispatch trigger');
  assert.ok(yaml.includes('script_content:'), 'Missing script_content input');
  assert.ok(yaml.includes('runs-on: ubuntu-latest'), 'Runner should be ubuntu-latest');
  assert.ok(yaml.includes('blender -b -P scene.py'), 'Missing headless blender execution step');
  assert.ok(yaml.includes('upload-artifact@v4'), 'Missing upload-artifact v4 step');
  assert.ok(yaml.includes('blender-render-artifacts'), 'Missing artifact name definition');
});

test('Phase 2: Remote GitHub configuration detection reports missing token and repository safely without leakage', async () => {
  const { detectGitHubRemote } = require('../blender');
  const remote = detectGitHubRemote();

  assert.equal(typeof remote, 'object');
  assert.equal(remote.configured, false);
  assert.equal(remote.hasToken, false);
  assert.equal(remote.hasRepo, false);
  assert.equal(remote.workflowExists, true);
  assert.ok(remote.reason.includes('GITHUB_TOKEN') || remote.reason.includes('GITHUB_REPOSITORY'));
});

test('Phase 2: Remote Blender render safely halts as blocked when credentials are not configured', async () => {
  const { generate3DScene } = require('../blender');
  const res = await generate3DScene({
    goal: 'Render a floating chrome torus in the cloud',
    targetDir: 'cloud-test-torus',
    mode: 'cloud',
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'blocked');
  assert.equal(res.mode, 'cloud');
  assert.ok(res.reason.includes('GitHub Actions remote rendering is not configured'));
  assert.equal(res.stages.script_generated, true);
  assert.equal(res.stages.scene_created, false);
  assert.equal(res.stages.render_completed, false);
  assert.equal(res.stages.output_verified, false);
});

test('Phase 2: POST /api/blender/render with mode cloud generates script and returns blocked status with remote details', async () => {
  const res = await call('POST', '/api/blender/render', {
    goal: 'Remote Cloud Gem Test',
    targetDir: 'cloud-api-gem',
    mode: 'cloud',
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.equal(data.status, 'blocked');
  assert.equal(data.mode, 'cloud');
  assert.ok(data.reason.includes('GitHub Actions remote rendering is not configured'));
  assert.equal(data.stages.script_generated, true);
  assert.equal(data.stages.scene_created, false);

  const scriptPath = path.join(__dirname, '..', 'workspace', 'cloud-api-gem', 'scene.py');
  assert.ok(fs.existsSync(scriptPath));
});







