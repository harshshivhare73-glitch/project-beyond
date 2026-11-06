'use strict';
// Project Beyond backend: Node built-ins only (http + node:sqlite). No packages, no paid services, no API keys.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PROVIDERS, listProviders, getAllProviderStatuses, assertAllowPaid, isVerifiedFreeGeminiModel } = require('./providers');
const {
  initOrchestrator, executeOrchestratedTask, pauseTask,
  validateDependencies, resolveDependencyContext,
  decomposeGoal, createWorkflow, executeSequentialWorkflow, consolidateWorkflow
} = require('./orchestrator');
const { fetchSources } = require('./research');
const { TOOLKIT_CATEGORIES, AUDITED_TOOLKIT, searchHuggingFaceModels, searchHuggingFaceDatasets } = require('./tools');
const { listArtifacts, readArtifact, writeArtifact, resolveWorkspaceDir } = require('./artifacts');
const { buildProject, planProjectManifest, listProjects } = require('./project_builder');
const chat = require('./chat');
const attachments = require('./attachments');
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, 'attachments');
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
const { detectBlender, generate3DScene, generate3DSceneScript } = require('./blender');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0'; // listen on all interfaces; the Host-header check below still restricts who is served (localhost + private Tailscale network only)
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
chat.initChatTables(db);
attachments.initAttachmentsTables(db);

// P0 reset protection (Assignment 1, defect 3): a reset is only allowed
// after a backup has been issued and explicitly confirmed. Backup tokens are
// single-use, in-memory only, and expire after 10 minutes. They contain
// tasks/logs/settings only — never provider keys, which are not stored in
// this database.
const backupTokens = new Map();
function createBackup() {
  return {
    createdAt: Date.now(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id ASC').all(),
    logs: db.prepare('SELECT * FROM logs ORDER BY id ASC').all(),
    settings: db.prepare('SELECT * FROM settings ORDER BY key ASC').all(),
  };
}
function issueBackupToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const backup = createBackup();
  backupTokens.set(token, { backup, expiresAt: Date.now() + 10 * 60 * 1000 });
  return { token, backup };
}

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
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        // Do NOT destroy the request: destroying the socket would prevent
        // the 413 response from reaching the client. Instead, stop
        // collecting and drain the rest, so the outer handler can send 413.
        rejected = true;
        reject(fail(413, `Request exceeds the ${maxBytes} byte limit.`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!rejected) reject(e); });
  });
}
// Minimal multipart/form-data parser for a single file part plus optional
// text fields. Body is bounded by readRawBody (10 MB), so this parser is
// bounded-memory for the foundation. Returns { file: { filename, contentType, buffer } | null, fields: {} }.
function parseMultipart(buffer, boundary) {
  const sep = Buffer.from('--' + boundary);
  const fields = {};
  let file = null;
  let start = buffer.indexOf(sep);
  if (start < 0) return { file, fields };
  start += sep.length;
  while (start < buffer.length) {
    if (buffer[start] === 45 && buffer[start + 1] === 45) break; // -- terminator
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd < 0) break;
    const headers = buffer.toString('utf8', start, headerEnd);
    let bodyStart = headerEnd + 4;
    let nextSep = buffer.indexOf(sep, bodyStart);
    if (nextSep < 0) break;
    let bodyEnd = nextSep;
    if (buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) bodyEnd -= 2;
    const nameMatch = headers.match(/name="([^"]*)"/);
    const fileMatch = headers.match(/filename="([^"]*)"/);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    const name = nameMatch ? nameMatch[1] : '';
    if (fileMatch) {
      file = { filename: fileMatch[1], contentType: typeMatch ? typeMatch[1].trim() : null, buffer: buffer.subarray(bodyStart, bodyEnd) };
    } else if (name) {
      fields[name] = buffer.toString('utf8', bodyStart, bodyEnd);
    }
    start = nextSep + sep.length;
  }
  return { file, fields };
}

const cleanTitle = v => { const t = typeof v === 'string' ? v.trim() : ''; if (t.length < 3 || t.length > 4000) throw fail(400, 'Title must be 3 to 4000 characters.'); return t; };
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
      // P0 deletion protection (Assignment 1, defect 4): never silently
      // delete child subtasks or break dependencies. By default a parent
      // with children, or a task that other tasks depend on, is not deleted
      // at all. Explicit cascade requires both deleteChildren:true and
      // confirm:"DELETE_CHILDREN" in the request body.
      const b = await readBody(req);
      const children = db.prepare('SELECT id, title FROM tasks WHERE parent_id=? ORDER BY id ASC').all(id);
      const dependents = db.prepare('SELECT id, title, depends_on FROM tasks WHERE id != ?').all(id).filter((t) => {
        try { return JSON.parse(t.depends_on || '[]').includes(id); } catch { return false; }
      }).map((t) => ({ id: t.id, title: t.title }));
      const explicitCascade = b.deleteChildren === true && b.confirm === 'DELETE_CHILDREN';
      if ((children.length > 0 || dependents.length > 0) && !explicitCascade) {
        throw fail(409, `Task #${id} cannot be deleted: it has ${children.length} child subtask(s) and ${dependents.length} dependent task(s). Delete the children/dependents first, or resend with deleteChildren:true and confirm:"DELETE_CHILDREN" for an explicit cascade.`);
      }
      if (explicitCascade) {
        db.prepare('DELETE FROM tasks WHERE parent_id=?').run(id);
      }
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      addLog('info', `Task deleted: "${task.title}"${explicitCascade ? ' (explicit child cascade)' : ''}`);
      return send(res, 200, { ok: true, deletedChildren: explicitCascade ? children.map((c) => c.id) : [] });
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
        allowPaid: false, // P0: server-side zero-cost enforcement, not a client toggle
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
        allowPaid: false, // P0: server-side zero-cost enforcement, not a client toggle
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
        allowPaid: false, // P0: server-side zero-cost enforcement, not a client toggle
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
    const plan = await decomposeGoal(title, { providers: PROVIDERS, priority: b.priority, allowPaid: false }); // P1 explicit
    return send(res, 200, { ok: true, goal: title, plan });
  }

  if (p === '/api/workflows' && m === 'POST') {
    const b = await readBody(req);
    const title = cleanGoal(b.title || b.goal);
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'Medium';
    let plan = b.plan;
    if (!plan) {
      plan = await decomposeGoal(title, { providers: PROVIDERS, priority, allowPaid: false }); // P1 explicit
    }
    const wf = createWorkflow(db, { title, priority, plan, providers: PROVIDERS, addLog });
    return send(res, 201, wf);
  }

  const wem = p.match(/^\/api\/workflows\/(\d+)\/execute$/);
  if (wem && m === 'POST') {
    const parentId = Number(wem[1]);
    const b = await readBody(req);
    try {
      // P1 explicit allowPaid: workflow execute validates the provider
      // like task execute does, and passes allowPaid false explicitly.
      if (b.provider && b.provider !== 'gemini' && b.provider !== 'ollama') {
        throw fail(400, 'Unsupported execution provider. Choose "gemini" or "ollama".');
      }
      const result = await executeSequentialWorkflow({
        db,
        parentId,
        providers: PROVIDERS,
        addLog,
        requestedProvider: b.provider || 'gemini',
        customTimeoutMs: b.timeoutMs,
        allowPaid: false,
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
    // P1 Gemini paid-model bypass fix (Assignment 1.4): the client must
    // never be able to choose a paid model. allowPaid is always false on
    // this route, regardless of anything in the body, and only the verified
    // free model is allowed. Rejected before any provider call.
    if (b.model && !isVerifiedFreeGeminiModel(b.model)) {
      throw fail(403, `Gemini model "${b.model}" is not a verified free model. Only gemini-flash-lite-latest is allowed.`);
    }
    const result = await PROVIDERS.gemini.testGemini({ key: b.key, model: b.model, allowPaid: false });
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
      assertAllowPaid('gemini', false); // P1 explicit: research synthesis calls Gemini directly, so it must check here.
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
  if (p === '/api/backup' && m === 'GET') {
    if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
    const { token, backup } = issueBackupToken();
    return send(res, 200, { ok: true, backupToken: token, backup, expiresInSec: 600, message: 'Use this backupToken with confirm:"RESET" on POST /api/reset within 10 minutes. The token is single-use.' });
  }
  // P1 backup restore design (Assignment 1.2): restore is available only
  // in this isolated workspace, only from a validated backup, only with
  // explicit confirmation and a fresh single-use backup token, and only
  // after a fresh pre-restore backup is created and returned, so the
  // restore itself is reversible. It never touches production data, never
  // restores provider keys (settings are allow-listed to freeFirst/seeded
  // only), and it runs inside a transaction so a failed restore rolls back.
  function validateBackupStructure(backup) {
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return 'Backup must be an object.';
    // P2 restore round-trip (Assignment 1.4): reject unexpected fields.
    // A backup created by this server has exactly these top-level keys,
    // and each record has exactly the known database columns. Extra fields
    // are not silently dropped any more, because a tampered backup must not
    // be accepted as if it were clean.
    const topKeys = Object.keys(backup).sort().join(',');
    if (topKeys !== 'createdAt,logs,settings,tasks') return 'Backup has unexpected top-level fields.';
    if (typeof backup.createdAt !== 'number') return 'Backup must have a numeric createdAt.';
    if (!Array.isArray(backup.tasks) || !Array.isArray(backup.logs) || !Array.isArray(backup.settings)) return 'Backup must have tasks, logs and settings arrays.';
    if (backup.tasks.length > 10000 || backup.logs.length > 10000) return 'Backup is too large.';
    const taskFields = new Set(['id','title','agent','priority','status','result','error','provider','current_step','completed_steps','progress','retry_count','max_retries','checkpoint_data','parent_id','depends_on','created_at','completed_at','updated_at','execution_id']);
    const seenTaskIds = new Set();
    for (const t of backup.tasks) {
      if (!t || typeof t !== 'object') return 'Backup task must be an object.';
      for (const k of Object.keys(t)) { if (!taskFields.has(k)) return `Backup task has unexpected field "${k}".`; }
      if (!Number.isInteger(t.id) || t.id <= 0) return 'Backup task id must be a positive integer.';
      if (seenTaskIds.has(t.id)) return `Backup has duplicate task id ${t.id}.`;
      seenTaskIds.add(t.id);
      if (typeof t.title !== 'string' || !t.title.trim()) return 'Backup task title must be a non-empty string.';
      if (typeof t.agent !== 'string' || !t.agent) return 'Backup task agent must be a non-empty string.';
      if (typeof t.priority !== 'string' || !PRIORITIES.includes(t.priority)) return 'Backup task priority is invalid.';
      if (typeof t.status !== 'string' || !STATUSES.includes(t.status)) return 'Backup task status is invalid.';
      if (typeof t.created_at !== 'number') return 'Backup task created_at must be a number.';
      if (t.parent_id !== undefined && t.parent_id !== null && !Number.isInteger(t.parent_id)) return 'Backup task parent_id is invalid.';
    }
    const logFields = new Set(['id','t','lvl','msg','sample']);
    const seenLogIds = new Set();
    for (const l of backup.logs) {
      if (!l || typeof l !== 'object' || typeof l.t !== 'number' || typeof l.lvl !== 'string' || typeof l.msg !== 'string') return 'Backup log entry is invalid.';
      for (const k of Object.keys(l)) { if (!logFields.has(k)) return `Backup log has unexpected field "${k}".`; }
      if (l.id !== undefined && l.id !== null) { if (seenLogIds.has(l.id)) return `Backup has duplicate log id ${l.id}.`; seenLogIds.add(l.id); }
    }
    const seenSettingKeys = new Set();
    for (const st of backup.settings) {
      if (!st || typeof st !== 'object' || typeof st.key !== 'string' || typeof st.value !== 'string') return 'Backup setting is invalid.';
      for (const k of Object.keys(st)) { if (k !== 'key' && k !== 'value') return `Backup setting has unexpected field "${k}".`; }
      if (st.key !== 'freeFirst' && st.key !== 'seeded') return `Backup setting key "${st.key}" is not allowed.`;
      if (seenSettingKeys.has(st.key)) return `Backup has duplicate setting key "${st.key}".`;
      seenSettingKeys.add(st.key);
    }
    return null;
  }
  if (p === '/api/restore' && m === 'POST') {
    if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
    const b = await readBody(req);
    if (b.confirm !== 'RESTORE') throw fail(403, 'Restore requires explicit confirm:"RESTORE". No data was changed.');
    const entry = typeof b.backupToken === 'string' ? backupTokens.get(b.backupToken) : undefined;
    if (!entry || entry.expiresAt < Date.now()) throw fail(403, 'Restore requires a valid backup token from GET /api/backup (valid 10 minutes). No data was changed.');
    const validationError = validateBackupStructure(b.backup);
    if (validationError) throw fail(400, `Invalid backup: ${validationError} No data was changed.`);
    const preRestoreBackup = createBackup();
    backupTokens.delete(b.backupToken);
    try {
      db.exec('BEGIN');
      db.exec('DELETE FROM tasks; DELETE FROM logs; DELETE FROM settings;');
      const insTask = db.prepare('INSERT INTO tasks(id,title,agent,priority,status,result,error,provider,current_step,completed_steps,progress,retry_count,max_retries,checkpoint_data,parent_id,depends_on,created_at,completed_at,updated_at,execution_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const t of b.backup.tasks) {
        insTask.run(t.id, t.title, t.agent, t.priority, t.status, t.result ?? null, t.error ?? null, t.provider ?? null, t.current_step ?? null, t.completed_steps ?? '[]', t.progress ?? 0, t.retry_count ?? 0, t.max_retries ?? 3, t.checkpoint_data ?? null, t.parent_id ?? null, t.depends_on ?? '[]', t.created_at, t.completed_at ?? null, t.updated_at ?? null, t.execution_id ?? null);
      }
      const insLog = db.prepare('INSERT INTO logs(id,t,lvl,msg,sample) VALUES(?,?,?,?,?)');
      for (const l of b.backup.logs) {
        insLog.run(l.id ?? null, l.t, l.lvl, l.msg, l.sample ?? 0);
      }
      for (const st of b.backup.settings) {
        setSetting(st.key, st.value);
      }
      db.exec('COMMIT');
    } catch (restoreErr) {
      try { db.exec('ROLLBACK'); } catch {}
      throw fail(500, `Restore failed and was rolled back: ${restoreErr.message}`);
    }
    addLog('warn', 'Database restored from backup.');
    return send(res, 200, { ok: true, preRestoreBackup, restored: { tasks: b.backup.tasks.length, logs: b.backup.logs.length, settings: b.backup.settings.length } });
  }
  if (p === '/api/reset' && m === 'POST') {
    // P0 reset protection: no silent wipe. Requires X-Requested-With header,
    // explicit confirm:"RESET", and a valid, unexpired, single-use backup
    // token from GET /api/backup. Without all three, nothing is deleted.
    if (req.headers['x-requested-with'] !== 'beyond') throw fail(403, 'Missing X-Requested-With header.');
    const b = await readBody(req);
    if (b.confirm !== 'RESET') throw fail(403, 'Reset requires explicit confirm:"RESET". No data was deleted.');
    const entry = typeof b.backupToken === 'string' ? backupTokens.get(b.backupToken) : undefined;
    if (!entry || entry.expiresAt < Date.now()) throw fail(403, 'Reset requires a valid backup token from GET /api/backup (valid 10 minutes). No data was deleted.');
    backupTokens.delete(b.backupToken);
    const backup = entry.backup;
    seed();
    addLog('warn', 'Database reset after backup confirmation.');
    return send(res, 200, { ok: true, backup });
  }
  // --- Assignment 1.6: Conversations, Chat and Attachments (API v1) ---
  // See docs/API.md for the full contract. All routes are served only to
  // allowed Hosts (localhost + private Tailscale network — see
  // isAllowedHost), same as every other route here.
  const convMatch = p.match(/^\/api\/conversations\/(\d+)$/);
  const convMsgMatch = p.match(/^\/api\/conversations\/(\d+)\/messages$/);
  const convMsgIdMatch = p.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)$/);
  const convMsgRetryMatch = p.match(/^\/api\/conversations\/(\d+)\/messages\/(\d+)\/retry$/);
  const attMatch = p.match(/^\/api\/chat\/attachments\/(att_[0-9a-f]{32})$/);
  const attContentMatch = p.match(/^\/api\/chat\/attachments\/(att_[0-9a-f]{32})\/content$/);
  if (p === '/api/conversations' && m === 'POST') {
    const b = await readBody(req);
    const conv = chat.createConversation(db, b.title);
    return send(res, 201, { ok: true, conversation: conv });
  }
  if (p === '/api/conversations' && m === 'GET') {
    return send(res, 200, { ok: true, conversations: chat.listConversations(db) });
  }
  if (convMatch && m === 'GET') {
    return send(res, 200, { ok: true, conversation: chat.getConversation(db, Number(convMatch[1])) });
  }
  if (convMatch && m === 'PATCH') {
    const b = await readBody(req);
    return send(res, 200, { ok: true, conversation: chat.renameConversation(db, Number(convMatch[1]), b.title) });
  }
  if (convMatch && m === 'DELETE') {
    const result = chat.deleteConversation(db, Number(convMatch[1]));
    // chat.deleteConversation already deleted the attachment rows in its
    // transaction; here only the files are removed, best-effort, by id.
    for (const attId of result.attachmentIds || []) {
      try { fs.unlinkSync(attachments.resolveAttachmentPath(ATTACHMENTS_DIR, attId)); } catch {}
    }
    return send(res, 200, { ok: true, deleted: result });
  }
  if (convMsgMatch && m === 'GET') {
    const conv = chat.getConversation(db, Number(convMsgMatch[1]));
    return send(res, 200, { ok: true, conversation_id: conv.id, messages: conv.messages });
  }
  if (convMsgMatch && m === 'POST') {
    const b = await readBody(req);
    const msg = chat.addMessage(db, Number(convMsgMatch[1]), b.role || 'user', b.content || '', b.attachment_ids || [], b.model || null);
    return send(res, 201, { ok: true, message: msg });
  }
  if (convMsgIdMatch && m === 'PATCH') {
    const b = await readBody(req);
    const msg = chat.editMessage(db, Number(convMsgIdMatch[1]), Number(convMsgIdMatch[2]), b.content);
    return send(res, 200, { ok: true, message: msg });
  }
  if (convMsgRetryMatch && m === 'POST') {
    const result = await chat.retryAssistantMessage({ db, attachmentsDir: ATTACHMENTS_DIR, conversationId: Number(convMsgRetryMatch[1]), messageId: Number(convMsgRetryMatch[2]), providers: PROVIDERS, allowPaid: false });
    return send(res, 200, { ok: true, message: result.assistant, images_used: result.imagesUsed, model: result.model });
  }
  if (p === '/api/chat' && m === 'POST') {
    const b = await readBody(req);
    let conversationId = b.conversation_id;
    if (!conversationId) {
      const conv = chat.createConversation(db, b.title);
      conversationId = conv.id;
    }
    const userMsg = chat.addMessage(db, Number(conversationId), 'user', b.content || '', b.attachment_ids || [], null);
    try {
      const result = await chat.generateReply({ db, attachmentsDir: ATTACHMENTS_DIR, conversationId: Number(conversationId), providers: PROVIDERS, allowPaid: false });
      return send(res, 200, { ok: true, conversation_id: Number(conversationId), user_message: userMsg, assistant_message: result.assistant, images_used: result.imagesUsed, model: result.model });
    } catch (genErr) {
      // User message is saved, assistant answer is NOT saved on failure.
      // The client can retry /api/chat or the retry endpoint later.
      const status = genErr.status || 503;
      return send(res, status, { ok: false, error: genErr.message, code: genErr.code || 'PROVIDER_ERROR', conversation_id: Number(conversationId), user_message: userMsg });
    }
  }
  if (p === '/api/chat/attachments' && m === 'POST') {
    // Fast path: reject oversized uploads from Content-Length before
    // reading the body, so a 413 is returned without draining a huge body.
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > attachments.MAX_ATTACHMENT_BYTES) {
      throw fail(413, `Attachment exceeds the ${attachments.MAX_ATTACHMENT_BYTES} byte limit.`);
    }
    const contentTypeHeader = (req.headers['content-type'] || '').toLowerCase();
    const raw = await readRawBody(req, attachments.MAX_ATTACHMENT_BYTES);
    let file = null;
    let conversationId = null;
    if (contentTypeHeader.includes('multipart/form-data')) {
      // Boundary is case-sensitive: do NOT use the lowercased header here.
      const boundaryMatch = (req.headers['content-type'] || '').match(/boundary=([^;]+)/i);
      if (!boundaryMatch) throw fail(400, 'Multipart upload requires a boundary.');
      const boundary = boundaryMatch[1].trim().replace(/^"|"$/g, '');
      const parsed = parseMultipart(raw, boundary);
      file = parsed.file;
      if (parsed.fields.conversation_id) conversationId = Number(parsed.fields.conversation_id) || null;
    } else {
      const query = new URL(req.url, 'http://localhost').searchParams;
      file = { filename: req.headers['x-filename'] || 'upload', contentType: contentTypeHeader.split(';')[0].trim() || null, buffer: raw };
      if (req.headers['x-conversation-id']) conversationId = Number(req.headers['x-conversation-id']) || null;
      if (query.get('conversation_id')) conversationId = Number(query.get('conversation_id')) || null;
    }
    if (!file || !file.buffer || file.buffer.length === 0) throw fail(400, 'No file part found in upload.');
    const stored = attachments.storeAttachment(db, ATTACHMENTS_DIR, { conversationId, originalFilename: file.filename, declaredContentType: file.contentType, buffer: Buffer.from(file.buffer) });
    return send(res, 201, { ok: true, attachment: stored });
  }
  if (p === '/api/chat/attachments' && m === 'GET') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const convId = query.get('conversation_id');
    const list = attachments.listAttachments(db, convId ? Number(convId) : null);
    return send(res, 200, { ok: true, attachments: list });
  }
  if (attContentMatch && m === 'GET') {
    const { meta, buffer } = attachments.getAttachmentBytes(db, ATTACHMENTS_DIR, attContentMatch[1]);
    const query = new URL(req.url, 'http://localhost').searchParams;
    const disposition = query.get('download') === '1' ? `attachment; filename="${meta.filename}"` : `inline; filename="${meta.filename}"`;
    res.writeHead(200, {
      'Content-Type': meta.content_type,
      'Content-Length': buffer.length,
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    return res.end(buffer);
  }
  if (attMatch && m === 'GET') {
    return send(res, 200, { ok: true, attachment: attachments.getAttachment(db, attMatch[1]) });
  }
  if (attMatch && m === 'DELETE') {
    const meta = attachments.deleteAttachment(db, ATTACHMENTS_DIR, attMatch[1]);
    return send(res, 200, { ok: true, deleted: meta.id });
  }
  throw fail(404, 'Not found.');
}

const PAGE = path.join(__dirname, 'public', 'index.html');
// Hosts this server answers to. Localhost for on-machine use; the
// 100.64.0.0/10 range and *.ts.net / MagicDNS short names for the private
// Tailscale network (this PC's tailnet IP is 100.64.x.x). Any other Host
// (public hostnames, LAN IPs) is rejected with 403. Binding 0.0.0.0
// listens on all interfaces, but only these Host values are served, and
// Tailscale only routes traffic between your own tailnet devices — the
// server is NOT exposed to the public internet by this change.
function isAllowedHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  if (h.endsWith('.ts.net')) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-9])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h)) return true; // MagicDNS short name, e.g. laptop-0m83l1ol
  return false;
}
const server = http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').split(':')[0];
    if (!isAllowedHost(host)) throw fail(403, 'Unexpected Host header.');
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p.startsWith('/api/')) return await api(req, res, p);
    if ((p === '/' || p === '/index.html') && req.method === 'GET') {
      // Read the file BEFORE writeHead: if index.html is missing, this
      // throws before headers are sent instead of crashing the process.
      const page = fs.readFileSync(PAGE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'",
      });
      return res.end(page);
    }
    throw fail(404, 'Not found.');
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e); send(res, 500, { error: 'Server error.' });
  }
});
server.listen(PORT, HOST, () => console.log(`Project Beyond running on ${HOST}:${PORT} (database: ${DB_PATH}) — open http://localhost:${PORT} locally or http://<tailnet-IP>:${PORT} from your Tailscale network`));
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
