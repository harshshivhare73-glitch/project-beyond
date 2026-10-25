'use strict';
// Project Beyond backend: Node built-ins only (http + node:sqlite). No packages, no paid services, no API keys.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PROVIDERS, listProviders, getAllProviderStatuses } = require('./providers');
const {
  initOrchestrator, executeOrchestratedTask, pauseTask,
  validateDependencies, resolveDependencyContext,
  decomposeGoal, createWorkflow, executeSequentialWorkflow, consolidateWorkflow
} = require('./orchestrator');
const { fetchSources } = require('./research');
const { TOOLKIT_CATEGORIES, AUDITED_TOOLKIT, searchHuggingFaceModels, searchHuggingFaceDatasets } = require('./tools');
const { listArtifacts, readArtifact, writeArtifact, resolveWorkspaceDir } = require('./artifacts');
const { buildProject, planProjectManifest, listProjects } = require('./project_builder');
const { detectBlender, generate3DScene, generate3DSceneScript } = require('./blender');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // local only: other devices cannot reach this server
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'beyond.db');
const AGENTS = ['coding', 'graphics', 'video', 'sketch', 'research', 'workflow'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const STATUSES = ['pending', 'queued', 'progress', 'running', 'paused', 'done', 'completed', 'failed'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
try {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
} catch {}
db.exec(`
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, agent TEXT NOT NULL,
  priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, lvl TEXT NOT NULL,
  msg TEXT NOT NULL, sample INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
try { db.exec('ALTER TABLE tasks ADD COLUMN result TEXT;'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN error TEXT;'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN provider TEXT;'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN completed_at INTEGER;'); } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN parent_id INTEGER DEFAULT NULL;'); } catch {}
try { db.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT DEFAULT '[]';"); } catch {}

const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const addLog = (lvl, msg, sample = 0, t = Date.now()) => db.prepare('INSERT INTO logs(t,lvl,msg,sample) VALUES(?,?,?,?)').run(t, lvl, msg, sample);

initOrchestrator(db, PROVIDERS, addLog);

function seed() {
  const now = Date.now();
  db.exec('DELETE FROM tasks; DELETE FROM logs; DELETE FROM settings;');
  const ins = db.prepare('INSERT INTO tasks(title,agent,priority,status,created_at) VALUES(?,?,?,?,?)');
  ins.run('Outline login page layout', 'sketch', 'Medium', 'progress', now);
  ins.run('List free hosting options', 'research', 'High', 'pending', now);
  ins.run('Choose project color palette', 'graphics', 'Low', 'done', now);
  addLog('info', 'Project Beyond started with the local SQLite backend.', 1, now - 600000);
  addLog('ok', 'Free-First mode is enabled.', 1, now - 540000);
  addLog('warn', 'No AI provider configured. Agents are Not Connected.', 1, now - 480000);
  addLog('error', 'Sample error: agent connection failed (no API key set).', 1, now - 300000);
  addLog('error', 'Sample error: task could not be delivered, agent offline.', 1, now - 120000);
  setSetting('freeFirst', 1);
  setSetting('seeded', 1);
}
if (!getSetting('seeded')) seed();

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

async function getOllamaStatus() {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 2000);
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: ac.signal });
    clearTimeout(to);
    if (!r.ok) return { ok: false, connected: false, error: `Ollama returned HTTP ${r.status}`, models: [], host: OLLAMA_HOST };
    const data = await r.json().catch(() => ({}));
    const models = Array.isArray(data.models) ? data.models.map(m => m.name || m.model) : [];
    return {
      ok: true,
      connected: true,
      host: OLLAMA_HOST,
      models,
      hasModels: models.length > 0,
      hasQwen: models.some(m => m.toLowerCase().includes('qwen2.5-coder'))
    };
  } catch (err) {
    const isConnRefused = (err.cause && err.cause.code === 'ECONNREFUSED') || err.code === 'ECONNREFUSED';
    return {
      ok: false,
      connected: false,
      host: OLLAMA_HOST,
      error: isConnRefused ? `Ollama daemon is not running at ${OLLAMA_HOST}` : (err.message || 'Connection failed'),
      models: [],
      hasModels: false,
      hasQwen: false
    };
  }
}

const state = async () => ({
  tasks: db.prepare('SELECT id,title,agent,priority,status,result,error,provider,current_step,completed_steps,progress,retry_count,max_retries,checkpoint_data,parent_id,depends_on,created_at,completed_at,updated_at FROM tasks ORDER BY id DESC').all(),
  logs: db.prepare('SELECT t,lvl,msg,sample FROM logs ORDER BY id DESC LIMIT 150').all(),
  settings: { freeFirst: getSetting('freeFirst') === '1' },
  ollama: await getOllamaStatus(),
  providers: await getAllProviderStatuses(),
  tools: AUDITED_TOOLKIT,
  categories: TOOLKIT_CATEGORIES,
  artifactsCount: listArtifacts().length,
  blender: detectBlender(),
});

const fail = (status, message) => Object.assign(new Error(message), { status });
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 50000) { reject(fail(413, 'Request too large.')); req.destroy(); } });
    req.on('end', () => { if (!raw) return resolve({}); try { const j = JSON.parse(raw); resolve(j && typeof j === 'object' ? j : {}); } catch { reject(fail(400, 'Body must be valid JSON.')); } });
    req.on('error', reject);
  });
}
const cleanTitle = v => { const t = typeof v === 'string' ? v.trim() : ''; if (t.length < 3 || t.length > 80) throw fail(400, 'Title must be 3 to 80 characters.'); return t; };
const cleanGoal = v => { const t = typeof v === 'string' ? v.trim() : ''; if (t.length < 3 || t.length > 4000) throw fail(400, 'Goal must be 3 to 4000 characters.'); return t; };

async function api(req, res, p) {
  const m = req.method;
  if (p === '/api/health' && m === 'GET') return send(res, 200, { app: 'project-beyond', ok: true });
  if (p === '/api/ollama/status' && m === 'GET') return send(res, 200, await getOllamaStatus());
  if (p === '/api/providers' && m === 'GET') return send(res, 200, await getAllProviderStatuses());
  if (p === '/api/tools' && m === 'GET') return send(res, 200, { ok: true, categories: TOOLKIT_CATEGORIES, tools: AUDITED_TOOLKIT });
  if (p === '/api/blender/status' && m === 'GET') return send(res, 200, { ok: true, ...detectBlender() });
  if (p === '/api/tools/hf/models' && m === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const q = u.searchParams.get('q') || 'qwen';
    const limit = Number(u.searchParams.get('limit')) || 5;
    const resData = await searchHuggingFaceModels(q, limit);
    return send(res, 200, resData);
  }
  if (p === '/api/tools/hf/datasets' && m === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const q = u.searchParams.get('q') || 'code';
    const limit = Number(u.searchParams.get('limit')) || 5;
    const resData = await searchHuggingFaceDatasets(q, limit);
    return send(res, 200, resData);
  }
  const pm = p.match(/^\/api\/providers\/([a-z0-9_-]+)$/);
  if (pm) {
    const pId = pm[1], provider = PROVIDERS[pId];
    if (!provider) throw fail(404, 'Provider not found.');
    if (m === 'GET') {
      const health = await provider.checkHealth();
      return send(res, 200, { id: provider.id, name: provider.name, type: provider.type, envVar: provider.envVar, terms: provider.terms, ...health });
    }
    if (m === 'POST') {
      if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
      const health = await provider.checkHealth({ forceRefresh: true });
      addLog(health.connected ? 'ok' : 'warn', `Checked provider "${provider.name}": ${health.status}${health.error ? ` (${health.error})` : ''}`);
      return send(res, 200, { id: provider.id, name: provider.name, type: provider.type, envVar: provider.envVar, terms: provider.terms, ...health });
    }
  }
  if (p === '/api/artifacts' && m === 'GET') {
    const list = listArtifacts();
    return send(res, 200, { ok: true, artifacts: list, count: list.length });
  }
  if (p === '/api/artifacts/content' && m === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const filePath = u.searchParams.get('path');
    if (!filePath) throw fail(400, 'Query param "path" is required.');
    try {
      const art = readArtifact(null, filePath);
      return send(res, 200, art);
    } catch (err) {
      return send(res, err.status || 400, { ok: false, error: err.message });
    }
  }
  if (p === '/api/artifacts' && m === 'POST') {
    if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
    const b = await readBody(req);
    if (!b.path || typeof b.path !== 'string') throw fail(400, 'Field "path" must be a non-empty relative string.');
    if (typeof b.content !== 'string') throw fail(400, 'Field "content" must be a string.');
    try {
      const record = writeArtifact({
        relativePath: b.path,
        content: b.content,
        allowOverwrite: Boolean(b.overwrite),
        expectedType: b.type,
      });
      addLog('ok', `Artifact written: "${record.relativePath}" (${record.size} bytes)`);
      return send(res, 201, record);
    } catch (err) {
      return send(res, err.status || 400, { ok: false, error: err.message, isTruncated: err.isTruncated });
    }
  }
  if (p === '/api/projects' && m === 'GET') {
    const projects = listProjects();
    return send(res, 200, { ok: true, projects, count: projects.length });
  }
  if (p === '/api/projects/plan' && m === 'POST') {
    if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
    const b = await readBody(req);
    const goal = cleanGoal(b.goal || b.title);
    try {
      const manifest = planProjectManifest(goal, { targetDir: b.targetDir });
      return send(res, 200, { ok: true, manifest });
    } catch (err) {
      return send(res, err.status || 400, { ok: false, error: err.message });
    }
  }
  if (p === '/api/projects/build' && m === 'POST') {
    if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
    const b = await readBody(req);
    const goal = cleanGoal(b.goal || b.title);
    try {
      const result = await buildProject({
        goal,
        targetDir: b.targetDir,
        provider: PROVIDERS[b.provider] || PROVIDERS.gemini || null,
        allowOverwrite: Boolean(b.overwrite),
        customTimeoutMs: b.timeoutMs || 15000,
        addLog,
      });
      return send(res, result.ok ? 201 : 400, result);
    } catch (err) {
      if (err.status === 409 || err.code === 'EEXIST') {
        return send(res, 409, { ok: false, error: err.message, code: 'EEXIST' });
      }
      return send(res, err.status || 400, { ok: false, error: err.message });
    }
  }
  if (p === '/api/blender/render' && m === 'POST') {
    if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
    const b = await readBody(req);
    const goal = cleanGoal(b.goal || b.title || '3D Showcase Scene');
    try {
      const result = await generate3DScene({
        goal,
        targetDir: b.targetDir || '3d-scene',
        mode: b.mode || 'auto',
        allowOverwrite: Boolean(b.overwrite),
        customTimeoutMs: b.timeoutMs || 30000,
        addLog,
      });
      return send(res, 200, result);
    } catch (err) {
      return send(res, err.status || 400, { ok: false, error: err.message });
    }
  }
  if (m !== 'GET' && req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
  if (p === '/api/state' && m === 'GET') return send(res, 200, await state());
  if (p === '/api/tasks' && m === 'POST') {
    const b = await readBody(req), title = cleanTitle(b.title);
    if (!AGENTS.includes(b.agent)) throw fail(400, 'Unknown agent.');
    if (!PRIORITIES.includes(b.priority)) throw fail(400, 'Priority must be High, Medium or Low.');

    let parentId = null;
    if (b.parent_id !== undefined && b.parent_id !== null) {
      const pid = Number(b.parent_id);
      if (!Number.isInteger(pid) || pid <= 0) throw fail(400, 'parent_id must be a positive integer.');
      const parentTask = db.prepare('SELECT id FROM tasks WHERE id = ?').get(pid);
      if (!parentTask) throw fail(400, `Parent task #${pid} not found.`);
      parentId = pid;
    }

    let dependsOn = [];
    if (b.depends_on !== undefined && b.depends_on !== null) {
      try {
        validateDependencies(null, b.depends_on, db);
      } catch (err) {
        throw fail(err.status || 400, err.message);
      }
      dependsOn = b.depends_on;
    }

    const r = db.prepare('INSERT INTO tasks(title,agent,priority,status,parent_id,depends_on,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(title, b.agent, b.priority, 'pending', parentId, JSON.stringify(dependsOn), Date.now());
    let note = '';
    if (b.agent === 'coding') {
      const ol = await getOllamaStatus();
      if (!ol.connected) note = ' (Ollama offline: not connected)';
      else if (!ol.hasModels) note = ' (Ollama online, but no models installed. Please pull qwen2.5-coder:3b)';
      else note = ` (Ollama online, models: ${ol.models.join(', ')})`;
    } else {
      note = ' (not executed, agent not connected)';
    }
    addLog('info', `Task created: "${title}" for ${b.agent} agent${note}`);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  const tm = p.match(/^\/api\/tasks\/(\d+)$/);
  if (tm) {
    const id = Number(tm[1]), task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) throw fail(404, 'Task not found.');
    if (m === 'GET') {
      return send(res, 200, task);
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) throw fail(400, 'Status must be pending, progress or done.');
        db.prepare('UPDATE tasks SET status=? WHERE id=?').run(b.status, id);
        addLog('info', `"${task.title}" set to ${b.status}`);
      }
      if (b.parent_id !== undefined) {
        let pid = null;
        if (b.parent_id !== null) {
          pid = Number(b.parent_id);
          if (!Number.isInteger(pid) || pid <= 0) throw fail(400, 'parent_id must be a positive integer.');
          if (pid === id) throw fail(400, 'Task cannot be its own parent.');
          const parentTask = db.prepare('SELECT id FROM tasks WHERE id = ?').get(pid);
          if (!parentTask) throw fail(400, `Parent task #${pid} not found.`);
        }
        db.prepare('UPDATE tasks SET parent_id=? WHERE id=?').run(pid, id);
      }
      if (b.depends_on !== undefined) {
        try {
          validateDependencies(id, b.depends_on, db);
        } catch (err) {
          throw fail(err.status || 400, err.message);
        }
        db.prepare('UPDATE tasks SET depends_on=? WHERE id=?').run(JSON.stringify(b.depends_on), id);
      }
      return send(res, 200, { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(id) });
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM tasks WHERE parent_id=?').run(id);
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      addLog('info', `Task deleted: "${task.title}"`);
      return send(res, 200, { ok: true });
    }
  }
  const em = p.match(/^\/api\/tasks\/(\d+)\/execute$/);
  if (em && m === 'POST') {
    const id = Number(em[1]), task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) throw fail(404, 'Task not found.');
    const b = await readBody(req);
    const providerId = b.provider || 'gemini';

    if (providerId !== 'gemini' && providerId !== 'ollama') {
      throw fail(400, 'Unsupported execution provider. Choose "gemini" or "ollama".');
    }

    try {
      const execResult = await executeOrchestratedTask({
        db,
        taskId: id,
        providers: PROVIDERS,
        addLog,
        requestedProvider: providerId,
        customTimeoutMs: b.timeoutMs,
      });

      if (execResult.ok) {
        return send(res, 200, { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(id) });
      } else {
        return send(res, 400, { ok: false, error: execResult.error });
      }
    } catch (err) {
      if (err.status === 409) {
        return send(res, 409, { ok: false, error: err.message });
      }
      return send(res, err.status || 500, { ok: false, error: err.message });
    }
  }

  const rm = p.match(/^\/api\/tasks\/(\d+)\/resume$/);
  if (rm && m === 'POST') {
    const id = Number(rm[1]), task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) throw fail(404, 'Task not found.');
    const b = await readBody(req);
    try {
      const execResult = await executeOrchestratedTask({
        db,
        taskId: id,
        providers: PROVIDERS,
        addLog,
        resumeOnly: true,
        requestedProvider: b.provider,
        customTimeoutMs: b.timeoutMs,
      });
      if (execResult.ok) {
        return send(res, 200, { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(id) });
      } else {
        return send(res, 400, { ok: false, error: execResult.error });
      }
    } catch (err) {
      if (err.status === 409) {
        return send(res, 409, { ok: false, error: err.message });
      }
      return send(res, err.status || 500, { ok: false, error: err.message });
    }
  }

  const pzm = p.match(/^\/api\/tasks\/(\d+)\/pause$/);
  if (pzm && m === 'POST') {
    const id = Number(pzm[1]);
    try {
      const pauseResult = pauseTask(id, db, addLog);
      return send(res, 200, pauseResult);
    } catch (err) {
      return send(res, err.status || 500, { ok: false, error: err.message });
    }
  }

  const rtm = p.match(/^\/api\/tasks\/(\d+)\/retry$/);
  if (rtm && m === 'POST') {
    const id = Number(rtm[1]), task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) throw fail(404, 'Task not found.');
    const b = await readBody(req);
    db.prepare("UPDATE tasks SET retry_count = 0, error = NULL WHERE id = ?").run(id);
    try {
      const execResult = await executeOrchestratedTask({
        db,
        taskId: id,
        providers: PROVIDERS,
        addLog,
        requestedProvider: b.provider,
        customTimeoutMs: b.timeoutMs,
      });
      if (execResult.ok) {
        return send(res, 200, { ok: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(id) });
      } else {
        return send(res, 400, { ok: false, error: execResult.error });
      }
    } catch (err) {
      if (err.status === 409) {
        return send(res, 409, { ok: false, error: err.message });
      }
      return send(res, err.status || 500, { ok: false, error: err.message });
    }
  }

  if (p === '/api/workflows/decompose' && m === 'POST') {
    const b = await readBody(req);
    const title = cleanGoal(b.title || b.goal);
    const plan = await decomposeGoal(title, { providers: PROVIDERS, priority: b.priority });
    return send(res, 200, { ok: true, goal: title, plan });
  }

  if (p === '/api/workflows' && m === 'POST') {
    const b = await readBody(req);
    const title = cleanGoal(b.title || b.goal);
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'Medium';
    let plan = b.plan;
    if (!plan) {
      plan = await decomposeGoal(title, { providers: PROVIDERS, priority });
    }
    const wf = createWorkflow(db, { title, priority, plan, providers: PROVIDERS, addLog });
    return send(res, 201, wf);
  }

  const wem = p.match(/^\/api\/workflows\/(\d+)\/execute$/);
  if (wem && m === 'POST') {
    const parentId = Number(wem[1]);
    const b = await readBody(req);
    try {
      const result = await executeSequentialWorkflow({
        db,
        parentId,
        providers: PROVIDERS,
        addLog,
        requestedProvider: b.provider || 'gemini',
        customTimeoutMs: b.timeoutMs,
      });
      return send(res, result.ok ? 200 : 400, result);
    } catch (err) {
      if (err.status === 409) return send(res, 409, { ok: false, error: err.message });
      return send(res, err.status || 500, { ok: false, error: err.message });
    }
  }

  const wgm = p.match(/^\/api\/workflows\/(\d+)$/);
  if (wgm && m === 'GET') {
    const parentId = Number(wgm[1]);
    const parent = db.prepare('SELECT * FROM tasks WHERE id=?').get(parentId);
    if (!parent) throw fail(404, 'Workflow not found.');
    const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY id ASC').all(parentId);
    return send(res, 200, { ok: true, parent, subtasks });
  }
  if (p === '/api/providers/gemini/test' && m === 'POST') {
    const b = await readBody(req);
    const result = await PROVIDERS.gemini.testGemini({ key: b.key, model: b.model });
    if (result.ok) {
      addLog('ok', `Gemini cloud test succeeded: "${result.text.trim().slice(0, 60)}"`);
    } else {
      addLog('warn', `Gemini cloud test failed: ${result.error}`);
    }
    return send(res, 200, result);
  }
  if (p === '/api/agents/research/test' && m === 'POST') {
    const b = await readBody(req);
    const topic = b.topic || 'Artificial intelligence';
    const src = await fetchSources(topic, { timeoutMs: 6000 });
    let synthesis = null;
    if (PROVIDERS.gemini) {
      const sourcesBlock = (src.sources || []).map((s, idx) => `[${idx+1}] ${s.title}: ${s.extract} (${s.url})`).join('\n\n');
      const prompt = `You are the Project Beyond Research Agent.\nTopic: "${topic}".\nSources:\n${sourcesBlock}\nProvide a concise 2-sentence summary and list 1 primary source link.`;
      synthesis = await PROVIDERS.gemini.generateContent({ prompt, timeoutMs: 12000 });
    }
    addLog('ok', `Research Agent: gathered ${src.sources.length} genuine sources for "${topic}"`);
    return send(res, 200, {
      ok: true,
      agent: 'research',
      topic,
      sourcesCount: (src.sources || []).length,
      sources: src.sources || [],
      synthesis: synthesis && synthesis.ok ? synthesis.text : null,
    });
  }
  if (p === '/api/logs' && m === 'DELETE') { db.exec('DELETE FROM logs'); return send(res, 200, { ok: true }); }
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    if (typeof b.freeFirst !== 'boolean') throw fail(400, 'freeFirst must be true or false.');
    setSetting('freeFirst', b.freeFirst ? 1 : 0);
    addLog(b.freeFirst ? 'ok' : 'warn', 'Free-First mode ' + (b.freeFirst ? 'enabled' : 'disabled'));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/reset' && m === 'POST') { seed(); return send(res, 200, { ok: true }); }
  throw fail(404, 'Not found.');
}

const PAGE = path.join(__dirname, 'public', 'index.html');
const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== 'localhost' && host !== '127.0.0.1') throw fail(403, 'Unexpected Host header.');
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p.startsWith('/api/')) return await api(req, res, p);
    if ((p === '/' || p === '/index.html') && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      return res.end(fs.readFileSync(PAGE));
    }
    throw fail(404, 'Not found.');
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e); send(res, 500, { error: 'Server error.' });
  }
});
server.listen(PORT, HOST, () => console.log(`Project Beyond running at http://localhost:${PORT}  (database: ${DB_PATH})`));
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
