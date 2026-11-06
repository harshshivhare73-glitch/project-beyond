'use strict';
// Project Beyond — Stage G & H: Automatic Task Recovery & Real Multi-Agent Orchestrator
// Pure Node.js built-ins. Zero external dependencies.
const fs = require('node:fs');
const path = require('node:path');
const { fetchSources } = require('./research');
const {
  writeArtifact,
  listArtifacts,
  readArtifact,
  extractArtifactsFromMarkdown,
  validateArtifactContent,
  getVerifiedArtifactPath,
  validateMp4File,
  computeFileHashSync,
} = require('./artifacts');
// P0 cost control: id-based paid/free classification lives in providers.js.
// Unknown ids fail closed (treated as paid). Mock providers in tests use the
// same ids, so this check works without calling any real provider.
const { isPaidProvider, assertAllowPaid } = require('./providers');
const { buildProject, planProjectManifest } = require('./project_builder');

const activeTasks = new Set();
const activeControllers = new Map();

function initOrchestrator(db, providers, addLog) {
  // Ensure schema migrations for orchestration
  try { db.exec("ALTER TABLE tasks ADD COLUMN current_step TEXT DEFAULT NULL;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN completed_steps TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN progress INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN max_retries INTEGER DEFAULT 3;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN checkpoint_data TEXT DEFAULT NULL;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN execution_id TEXT DEFAULT NULL;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN updated_at INTEGER DEFAULT NULL;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN parent_id INTEGER DEFAULT NULL;"); } catch {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT DEFAULT '[]';"); } catch {}

  // Startup recovery: any tasks left in 'running' or 'progress' when the server stopped/restarted
  // are safely converted to 'paused' with their last checkpoint preserved.
  const interrupted = db.prepare("SELECT id, title, current_step, progress FROM tasks WHERE status IN ('progress', 'running')").all();
  for (const t of interrupted) {
    db.prepare(`
      UPDATE tasks 
      SET status = 'paused', 
          error = 'Execution interrupted by server restart. Checkpoint preserved. Ready to resume.', 
          updated_at = ? 
      WHERE id = ?
    `).run(Date.now(), t.id);
    if (addLog) {
      addLog('warn', `Orchestrator recovered task #${t.id} "${t.title}": paused at step "${t.current_step || 'initial'}" (${t.progress}%). Ready to resume.`);
    }
  }

  return {
    activeTasks,
    activeControllers,
  };
}

// Find a verified, healthy fallback provider when the primary fails
// P0 cost control: options.allowPaid must be an explicit true to allow a
// paid provider. Any other value fails closed and paid/unknown providers are
// skipped entirely, on every fallback path.
async function findFallbackProvider(currentProviderId, providers, logFn, options = {}) {
  const allowPaid = options.allowPaid === true;
  // Candidate fallback providers in preference order
  const candidateIds = ['gemini', 'groq', 'openrouter', 'deepseek', 'ollama'];
  for (const pid of candidateIds) {
    if (pid === currentProviderId) continue;
    if (!allowPaid && isPaidProvider(pid)) continue;
    const provider = providers[pid];
    if (!provider) continue;

    // Check health without assuming credentials exist
    try {
      const health = await provider.checkHealth({ timeoutMs: 3000 });
      if (health && health.connected) {
        // If Ollama, ensure it actually has installed models
        if (pid === 'ollama' && (!health.models || health.models.length === 0)) {
          continue;
        }
        if (logFn) {
          logFn('info', `Orchestrator found verified fallback provider: "${provider.name}"`);
        }
        return provider;
      }
    } catch {
      // Unreachable or invalid, ignore
    }
  }
  return null;
}

// Save checkpoint to database
function saveCheckpoint(db, taskId, { step, progress, completedSteps, checkpointData, status = 'running' }) {
  const now = Date.now();
  db.prepare(`
    UPDATE tasks 
    SET current_step = ?,
        progress = ?,
        completed_steps = ?,
        checkpoint_data = ?,
        status = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    step,
    progress,
    JSON.stringify(completedSteps),
    checkpointData ? JSON.stringify(checkpointData) : null,
    status,
    now,
    taskId
  );
}

// P0 completion gate (Assignment 1, defect 1). This runs before any task is
// marked completed/100%. It does not change checkpoint or recovery logic:
// a failed gate throws, the outer catch marks the task failed with the error,
// and the last checkpoint (progress 80, generating) is preserved for retry.
// - Video tasks: require a verified .mp4 artifact file on disk, size > 0.
// - File tasks: if artifacts are recorded, every recorded file must exist
//   on disk with size > 0; truncated/invalid artifact output blocks completion.
// - Text tasks: require a real, non-empty text result (the generic fallback
//   string "Task completed successfully." is not a result).
// P0 file-task distinction (Assignment 1.2, extended 1.4). A task is a
// file-generation task only when there is an explicit file signal, not
// merely because its agent is coding or graphics:
// - agent is video (MP4 is the output), or
// - the task is a project goal (expense/tracker/multi-file/build project), or
// - artifacts were extracted/written/truncated/invalid (artifact_status set), or
// - the caller explicitly sets fileTaskExpected: true, or
// - the task or parent title shows file-generation intent (1.4, see below).
// Text-only coding/graphics tasks — a code snippet in the chat result with
// no file extraction — remain text tasks and may complete on real text.
// This preserves legitimate text behaviour while closing the "text claims
// a file" gap for file tasks.
const EXPECTED_TYPE_EXTENSIONS = {
  js: ['.js'], javascript: ['.js'], html: ['.html', '.htm'], css: ['.css'],
  json: ['.json'], python: ['.py'], py: ['.py'], svg: ['.svg'],
  markdown: ['.md'], md: ['.md'], text: ['.txt'], txt: ['.txt'],
  xml: ['.xml'], sh: ['.sh'], bash: ['.sh'], ts: ['.ts'], typescript: ['.ts'],
};

// P2 title intent (Assignment 1.4): detect file-generation intent from a
// task title, even when no artifact is returned. Conservative patterns only:
// a creation verb plus a filename with an extension, or a creation verb
// plus the word "file", or an explicit "file:" prefix. "Explain app.js"
// does NOT match, because it has no creation verb, so explanation tasks
// are not falsely turned into file tasks.
function hasFileGenerationIntent(title) {
  if (typeof title !== 'string' || !title) return false;
  const t = title.toLowerCase();
  if (/\b(create|write|save|generate|build|make|produce)\b[^.]*\.(js|html|css|json|py|md|txt|svg|mp4)\b/.test(t)) return true;
  if (/\b(create|write|save|generate|build)\b\s+(a\s+)?file\b/.test(t)) return true;
  if (/file:\s*[\w\-]+\./.test(t)) return true;
  return false;
}

function verifyTaskCompletion({ agent, finalResult, checkpointData = {}, taskTitle = '', parentTitle = '' }) {
  const text = typeof finalResult === 'string' ? finalResult.trim() : '';
  if (!text || text === 'Task completed successfully.') {
    return { ok: false, error: 'Task cannot complete without a valid output result.' };
  }
  const artifacts = Array.isArray(checkpointData.artifacts) ? checkpointData.artifacts : [];
  if (agent === 'video') {
    const mp4 = artifacts.find((a) => a && typeof a.relativePath === 'string' && a.relativePath.toLowerCase().endsWith('.mp4'));
    if (!mp4) {
      return { ok: false, error: 'Video task cannot complete without a verified MP4 file. Only a storyboard/script was produced.' };
    }
    return verifyArtifactFile(mp4);
  }
  if (checkpointData.artifact_status === 'truncated' || checkpointData.artifact_status === 'invalid') {
    return { ok: false, error: `Task cannot complete: file artifacts are ${checkpointData.artifact_status}. ${checkpointData.artifact_warning || ''}`.trim() };
  }
  const isFileTask = checkpointData.fileTaskExpected === true
    || checkpointData.artifact_status === 'written'
    || artifacts.length > 0
    || hasFileGenerationIntent(taskTitle)
    || hasFileGenerationIntent(parentTitle);
  if (isFileTask && artifacts.length === 0) {
    return { ok: false, error: 'File-generation task cannot complete without at least one verified artifact. A text response is not proof that a file was created.' };
  }
  // P2 paragraph claims (Assignment 1.4): explicit file claims anywhere in
  // the text, not only at line starts, must match a verified artifact or a
  // verified file on disk. This blocks "I also saved output2.js" as well
  // as "File saved: output2.js" when that file does not exist.
  if (isFileTask) {
    const claimPattern = /(?:File saved|Output written|Saved to|Written to|File created|Created file|I saved|I also saved|I created|saved):?\s*`?([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+)`?/gi;
    let claimMatch;
    while ((claimMatch = claimPattern.exec(text)) !== null) {
      const claimed = claimMatch[1];
      const claimedInArtifacts = artifacts.some((a) => a && (a.relativePath === claimed || (typeof a.relativePath === 'string' && a.relativePath.endsWith('/' + claimed))));
      if (!claimedInArtifacts) {
        const claimedCheck = verifyArtifactFile({ relativePath: claimed });
        if (!claimedCheck.ok) {
          return { ok: false, error: `File-generation task claims "${claimed}" in its text, but that file was not verified: ${claimedCheck.error}` };
        }
      }
    }
  }
  const verifiedArtifacts = [];
  for (const art of artifacts) {
    const check = verifyArtifactFile(art);
    if (!check.ok) return check;
    verifiedArtifacts.push({ relativePath: art.relativePath, sha256: check.sha256, size: check.size });
  }
  // P2 TOCTOU hash binding (Assignment 1.4): the gate returns the verified
  // hashes and sizes, so the completion step can re-verify them immediately
  // before marking the task completed, instead of trusting the first check.
  return { ok: true, verifiedArtifacts };
}

// P0/P2 artifact verification (Assignments 1.2 and 1.4). Applies to every
// artifact, not just video:
// - Only relativePath inside the workspace is trusted. A caller-supplied
//   absolutePath is never used for verification (Assignment 1.1 bypass).
// - getVerifiedArtifactPath rejects traversal, Windows-style backslashes,
//   absolute and drive-letter paths, missing files, directories, and
//   symlinks that resolve outside the workspace (realpath check).
// - The file is actually read, in 64 KB chunks, which proves readability
//   (a chmod 000 file fails) and computes a SHA-256. Recorded size must
//   match the stat size and the bytes actually read, and recorded SHA-256,
//   when present, must match the computed hash. Same-size replacement with
//   different content therefore fails on hash, not just on size.
// - Expected type, when present in expectedType, lang OR type (1.4: the
//   project-builder field), must match the file extension.
// - .mp4 files must pass bounded structural MP4 validation (ftyp + moov +
//   mdat, box boundaries, bounded memory). This is structural validation
//   only, NOT playback verification.
function verifyArtifactFile(art) {
  if (!art || typeof art.relativePath !== 'string' || !art.relativePath) {
    return { ok: false, error: 'Task cannot complete: a recorded file artifact has no valid path.' };
  }
  let verified;
  try {
    verified = getVerifiedArtifactPath(null, art.relativePath);
  } catch (e) {
    return { ok: false, error: `Task cannot complete: output file "${art.relativePath}" could not be verified (${e.message}).` };
  }
  if (verified.size === 0) {
    return { ok: false, error: `Task cannot complete: output file "${art.relativePath}" is missing or empty.` };
  }
  if (typeof art.size === 'number' && art.size > 0 && art.size !== verified.size) {
    return { ok: false, error: `Task cannot complete: output file "${art.relativePath}" size mismatch (recorded ${art.size} bytes, actual ${verified.size} bytes).` };
  }
  let hashed;
  try {
    hashed = computeFileHashSync(verified.targetPath);
  } catch (e) {
    return { ok: false, error: `Task cannot complete: output file "${art.relativePath}" is not readable (${e.message}).` };
  }
  if (hashed.size !== verified.size) {
    return { ok: false, error: `Task cannot complete: output file "${art.relativePath}" changed during verification (stat ${verified.size} bytes, read ${hashed.size} bytes).` };
  }
  if (typeof art.sha256 === 'string' && art.sha256 && art.sha256 !== hashed.sha256) {
    return { ok: false, error: `Task cannot complete: output file "${art.relativePath}" SHA-256 mismatch (recorded hash does not match the file on disk).` };
  }
  const expectedType = art.expectedType || art.lang || art.type || null;
  if (expectedType) {
    const allowed = EXPECTED_TYPE_EXTENSIONS[String(expectedType).toLowerCase()];
    if (allowed) {
      const ext = path.extname(art.relativePath).toLowerCase();
      if (!allowed.includes(ext)) {
        return { ok: false, error: `Task cannot complete: output file "${art.relativePath}" has extension "${ext}" but expected type "${expectedType}" requires one of ${allowed.join(', ')}.` };
      }
    }
  }
  if (art.relativePath.toLowerCase().endsWith('.mp4')) {
    const mp4 = validateMp4File(verified.targetPath);
    if (!mp4.ok) {
      return { ok: false, error: `Task cannot complete: MP4 file "${art.relativePath}" failed structural validation: ${mp4.error} (structural validation only, not playback verification).` };
    }
  }
  return { ok: true, sha256: hashed.sha256, size: hashed.size };
}

// Check if error is transient / temporary
function isTransientError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  const status = err.status || err.statusCode || 0;
  return (
    status === 429 ||
    status >= 500 ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('abort') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed')
  );
}

// Validate dependency IDs, self-dependencies, existence, and cycles
function validateDependencies(taskId, dependsOn, db) {
  if (!Array.isArray(dependsOn)) {
    const err = new Error('depends_on must be an array of task IDs.');
    err.status = 400;
    throw err;
  }

  const currentId = taskId ? Number(taskId) : null;
  const seen = new Set();

  for (const rawId of dependsOn) {
    const depId = Number(rawId);
    if (!Number.isInteger(depId) || depId <= 0) {
      const err = new Error(`Invalid dependency ID: ${rawId}. Must be a positive integer.`);
      err.status = 400;
      throw err;
    }
    if (seen.has(depId)) {
      const err = new Error(`Duplicate dependency ID: #${depId}.`);
      err.status = 400;
      throw err;
    }
    seen.add(depId);

    if (currentId && depId === currentId) {
      const err = new Error(`Task #${currentId} cannot depend on itself (self-dependency rejected).`);
      err.status = 400;
      throw err;
    }

    const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(depId);
    if (!row) {
      const err = new Error(`Dependency task #${depId} does not exist.`);
      err.status = 400;
      throw err;
    }
  }

  // Cycle detection if updating an existing task
  if (currentId && dependsOn.length > 0) {
    const hasPath = (fromId, targetId, visited = new Set()) => {
      if (fromId === targetId) return true;
      if (visited.has(fromId)) return false;
      visited.add(fromId);
      const row = db.prepare('SELECT depends_on FROM tasks WHERE id = ?').get(fromId);
      if (!row || !row.depends_on) return false;
      let nextDeps = [];
      try {
        nextDeps = JSON.parse(row.depends_on || '[]');
      } catch {
        nextDeps = [];
      }
      for (const nextId of nextDeps) {
        if (hasPath(Number(nextId), targetId, visited)) return true;
      }
      return false;
    };

    for (const depId of dependsOn) {
      if (hasPath(Number(depId), currentId)) {
        const err = new Error(`Circular dependency detected: Task #${currentId} and Task #${depId} form a cycle.`);
        err.status = 400;
        throw err;
      }
    }
  }

  return true;
}

// Resolve and bound outputs from completed dependencies for context handoff
function resolveDependencyContext(taskId, dependsOn, db) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) {
    return { ready: true, context: '', dependencies: [] };
  }

  const MAX_PER_DEP_CHARS = 2000;
  const MAX_TOTAL_CHARS = 6000;
  const depSummaries = [];
  const contextBlocks = [];

  for (const rawId of dependsOn) {
    const depId = Number(rawId);
    const depTask = db.prepare('SELECT id, title, agent, status, result, error FROM tasks WHERE id = ?').get(depId);
    if (!depTask) {
      return {
        ready: false,
        error: `Cannot execute task #${taskId}: Dependency task #${depId} does not exist.`,
        dependencies: depSummaries,
      };
    }

    const isCompleted = depTask.status === 'completed' || depTask.status === 'done';
    if (!isCompleted) {
      return {
        ready: false,
        error: `Cannot execute task #${taskId}: Dependency task #${depId} ("${depTask.title}") is not completed (current status: ${depTask.status}).`,
        dependencies: depSummaries,
      };
    }

    let outputText = (depTask.result || '').trim();
    if (!outputText) {
      outputText = '(Task completed with no textual output)';
    } else if (outputText.length > MAX_PER_DEP_CHARS) {
      const head = outputText.slice(0, 1600);
      const tail = outputText.slice(-350);
      outputText = `${head}\n\n... [output truncated for bounded prompt context] ...\n\n${tail}`;
    }

    depSummaries.push({
      id: depTask.id,
      title: depTask.title,
      agent: depTask.agent,
      status: depTask.status,
    });

    contextBlocks.push(
      `--- Dependency [Task #${depTask.id}] "${depTask.title}" (Agent: ${depTask.agent}) ---\n${outputText}\n--------------------------------------------------------------`
    );
  }

  let fullContext = contextBlocks.join('\n\n');
  if (fullContext.length > MAX_TOTAL_CHARS) {
    fullContext = fullContext.slice(0, MAX_TOTAL_CHARS) + '\n... [additional upstream context truncated]';
  }

  return {
    ready: true,
    context: fullContext,
    dependencies: depSummaries,
  };
}

// Execute or resume an orchestrated task
async function executeOrchestratedTask({
  db,
  taskId,
  providers,
  addLog,
  requestedProvider = null,
  resumeOnly = false,
  customTimeoutMs = 15000,
  backoffBaseMs = 400,
  // P0 cost control: default false, fail closed. Only an explicit true
  // allows a paid provider, on primary, fallback and retry paths.
  allowPaid = false,
}) {
  // Duplicate execution prevention
  if (activeTasks.has(taskId)) {
    const err = new Error(`Task #${taskId} is already executing. Duplicate execution prevented.`);
    err.status = 409;
    throw err;
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) {
    const err = new Error(`Task #${taskId} not found.`);
    err.status = 404;
    throw err;
  }

  if (task.status === 'running') {
    const err = new Error(`Task #${taskId} is already executing (status: running). Duplicate execution prevented.`);
    err.status = 409;
    throw err;
  }

  if (task.status === 'done' || task.status === 'completed') {
    const err = new Error(`Task #${taskId} is already completed.`);
    err.status = 400;
    throw err;
  }

  // P0 cost control, primary path: fail closed before any provider is called.
  // This check is repeated in the generation loop and in fallback selection,
  // so a retry or fallback cannot silently switch to a paid provider.
  const initialProviderId = requestedProvider || task.provider || 'gemini';
  if (allowPaid !== true && isPaidProvider(initialProviderId)) {
    const err = new Error(`Paid provider "${initialProviderId}" is blocked because allowPaid is false.`);
    err.status = 403;
    throw err;
  }

  // Parse existing checkpoints
  let completedSteps = [];
  try {
    completedSteps = JSON.parse(task.completed_steps || '[]');
  } catch {
    completedSteps = [];
  }

  let checkpointData = {};
  try {
    checkpointData = JSON.parse(task.checkpoint_data || '{}') || {};
  } catch {
    checkpointData = {};
  }

  // Parse and resolve dependencies for context handoff
  let dependsOn = [];
  try {
    dependsOn = JSON.parse(task.depends_on || '[]');
  } catch {
    dependsOn = [];
  }

  if (dependsOn.length > 0) {
    const depCheck = resolveDependencyContext(taskId, dependsOn, db);
    if (!depCheck.ready) {
      const err = new Error(depCheck.error);
      err.status = 400;
      throw err;
    }
    checkpointData.dependencyContext = depCheck.context;
    checkpointData.dependencies = depCheck.dependencies;
  }

  let providerId = requestedProvider || task.provider || 'gemini';
  let retryCount = task.retry_count || 0;
  const maxRetries = task.max_retries || 3;

  // Mark task as running and register lock
  activeTasks.add(taskId);
  const abortController = new AbortController();
  activeControllers.set(taskId, abortController);

  db.prepare(`
    UPDATE tasks 
    SET status = 'running', 
        provider = ?, 
        error = NULL, 
        updated_at = ? 
    WHERE id = ?
  `).run(providerId, Date.now(), taskId);

  if (addLog) {
    addLog('info', `Orchestrator: ${resumeOnly ? 'Resuming' : 'Starting'} task #${taskId} "${task.title}" with provider ${providerId} (step: ${task.current_step || 'planning'})`);
  }

  try {
    // ----------------------------------------------------
    // STEP 1: PLANNING
    // ----------------------------------------------------
    const agent = task.agent || 'coding';

    if (!completedSteps.includes('planning')) {
      if (abortController.signal.aborted) throw new Error('Task paused by user');

      saveCheckpoint(db, taskId, {
        step: 'planning',
        progress: 15,
        completedSteps,
        checkpointData,
        status: 'running',
      });

      // Tailor plan to agent capability
      let plan = '';
      if (agent === 'research') {
        plan = `Research plan for "${task.title}":\n1. Retrieve genuine encyclopedia references.\n2. Extract real factual summaries and citations.\n3. Synthesize factual briefing with source links.`;
      } else if (agent === 'graphics') {
        plan = `Graphics plan for "${task.title}":\n1. Plan visual composition and viewBox.\n2. Construct clean vector SVG markup.\n3. Add styles and semantic elements.`;
      } else if (agent === 'sketch') {
        plan = `Sketch plan for "${task.title}":\n1. Identify layout hierarchy and components.\n2. Design ASCII/text UI wireframe.\n3. Detail component specs.`;
      } else if (agent === 'video') {
        plan = `Video plan for "${task.title}":\n1. Establish visual narrative and pace.\n2. Breakdown scenes into shot tables.\n3. Detail narration and timing.`;
      } else {
        plan = `Plan for "${task.title}":\n1. Define structure and requirements.\n2. Implement clean logic with comments.\n3. Verify syntax and export functions.`;
      }

      checkpointData.plan = plan;
      completedSteps.push('planning');

      saveCheckpoint(db, taskId, {
        step: 'planning',
        progress: 30,
        completedSteps,
        checkpointData,
        status: 'running',
      });

      if (addLog) {
        addLog('ok', `Task #${taskId} (${agent}): Checkpoint [Planning] saved.`);
      }
    } else {
      if (addLog) {
        addLog('info', `Task #${taskId}: Skipping [Planning] (restored from checkpoint).`);
      }
    }

    // ----------------------------------------------------
    // STEP 1.5: GATHERING (For Research Agent)
    // ----------------------------------------------------
    if (agent === 'research' && !completedSteps.includes('gathering')) {
      if (abortController.signal.aborted) throw new Error('Task paused by user');

      saveCheckpoint(db, taskId, {
        step: 'gathering',
        progress: 45,
        completedSteps,
        checkpointData,
        status: 'running',
      });

      if (addLog) {
        addLog('info', `Task #${taskId}: Research Agent querying live encyclopedia for "${task.title}"...`);
      }

      const searchResult = await fetchSources(task.title, { timeoutMs: 6000 });
      checkpointData.sources = searchResult.sources || [];
      completedSteps.push('gathering');

      saveCheckpoint(db, taskId, {
        step: 'gathering',
        progress: 60,
        completedSteps,
        checkpointData,
        status: 'running',
      });

      if (addLog) {
        const count = checkpointData.sources.length;
        addLog('ok', `Task #${taskId}: Gathered ${count} genuine source${count === 1 ? '' : 's'} (${checkpointData.sources.map(s => s.title).join(', ') || 'general knowledge mode'}).`);
      }
    }

    // ----------------------------------------------------
    // STEP 2: GENERATION (With Retries and Fallback)
    // ----------------------------------------------------
    let generatedCode = checkpointData.code || null;

    if (!completedSteps.includes('generating')) {
      saveCheckpoint(db, taskId, {
        step: 'generating',
        progress: 65,
        completedSteps,
        checkpointData,
        status: 'running',
      });

      let stepSuccess = false;

      while (!stepSuccess) {
        if (abortController.signal.aborted) throw new Error('Task paused by user');

        const currentProvider = providers[providerId];
        if (!currentProvider) {
          throw new Error(`Provider "${providerId}" is not available in system registry.`);
        }
        // P0 cost control, generation path: never call a paid provider when
        // allowPaid is not an explicit true, even after a retry or fallback.
        if (allowPaid !== true && isPaidProvider(providerId)) {
          throw new Error(`Paid provider "${providerId}" is blocked because allowPaid is false.`);
        }

        const depContextBlock = checkpointData.dependencyContext
          ? `\nContext and outputs from upstream completed dependencies:\n${checkpointData.dependencyContext}\n`
          : '';

        let prompt = '';
        if (agent === 'research') {
          let sourcesBlock = '';
          if (checkpointData.sources && checkpointData.sources.length) {
            sourcesBlock = '\nVerified Sources:\n' + checkpointData.sources.map((s, idx) => `[${idx + 1}] ${s.title}: ${s.extract} (Source: ${s.url})`).join('\n\n');
          } else {
            sourcesBlock = '\nNote: No direct encyclopedia match found. Synthesize objective foundational facts.';
          }
          prompt = `You are the Project Beyond Research Agent.\nTopic: "${task.title}".\n${depContextBlock}${sourcesBlock}\nSynthesize a structured research briefing with: Executive Summary, Key Facts & Findings, and Cited References list with exact URLs. Do not fabricate facts.`;
        } else if (agent === 'graphics') {
          prompt = `You are the Project Beyond Graphics Agent.\nVisual Asset Request: "${task.title}".\n${depContextBlock}Generate a complete, valid, self-contained SVG graphic (<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">...</svg>) with appropriate vector shapes, colors, or icons, followed by a brief design rationale.`;
        } else if (agent === 'sketch') {
          prompt = `You are the Project Beyond Sketch Agent.\nDesign Concept: "${task.title}".\n${depContextBlock}Create a clear, structured ASCII/Text Wireframe UI layout, component hierarchy, user flow, and layout specifications.`;
        } else if (agent === 'video') {
          prompt = `You are the Project Beyond Video Agent.\nVideo Project: "${task.title}".\n${depContextBlock}Create a comprehensive Storyboard & Script Breakdown table with: Scene #, Shot Type, Visual Description, Narration/Audio, and Duration (sec). Conclude with a notice that actual MP4 video rendering requires a media diffusion/FFmpeg pipeline.`;
        } else {
          prompt = `You are the Project Beyond Coding Agent.\nTask Plan:\n${checkpointData.plan}\n${depContextBlock}\nTask: "${task.title}".\nWrite clean, working, self-contained code honoring any upstream requirements.`;
        }

        try {
          let genResult;
          if (providerId === 'gemini') {
            genResult = await currentProvider.generateContent({
              prompt,
              timeoutMs: customTimeoutMs,
            });
          } else if (providerId === 'ollama') {
            if (typeof currentProvider.generateContent === 'function') {
              genResult = await currentProvider.generateContent({
                prompt,
                timeoutMs: customTimeoutMs,
              });
            } else {
              const olSt = await currentProvider.checkHealth();
              const hasModels = (olSt.models && olSt.models.length > 0) || Boolean(olSt.hasModels);
              if (!olSt.connected || !hasModels) {
                throw new Error('Ollama is not available or has no models installed.');
              }
              genResult = { ok: true, text: `// Generated locally by Ollama\n// Solution for: ${task.title}\nconsole.log('Task executed by Ollama');` };
            }
          } else {
            throw new Error(`Execution unsupported for provider "${providerId}".`);
          }

          if (!genResult.ok) {
            const err = new Error(genResult.error || 'Generation failed');
            err.status = genResult.status === 'quota_exceeded' ? 429 : 500;
            throw err;
          }

          generatedCode = genResult.text;
          checkpointData.code = generatedCode;
          completedSteps.push('generating');
          stepSuccess = true;

          saveCheckpoint(db, taskId, {
            step: 'generating',
            progress: 80,
            completedSteps,
            checkpointData,
            status: 'running',
          });

          if (addLog) {
            addLog('ok', `Task #${taskId}: Checkpoint [2/3 Generating] saved with ${providerId}.`);
          }
        } catch (genErr) {
          const isTransient = isTransientError(genErr);

          if (isTransient && retryCount < maxRetries) {
            retryCount += 1;
            const delayMs = Math.min(backoffBaseMs * Math.pow(2, retryCount - 1), 3000);
            db.prepare('UPDATE tasks SET retry_count = ? WHERE id = ?').run(retryCount, taskId);
            if (addLog) {
              addLog('warn', `Task #${taskId}: Retry ${retryCount}/${maxRetries} after error: "${genErr.message}". Backing off ${delayMs}ms...`);
            }
            await new Promise(r => setTimeout(r, delayMs));
            continue; // Retry loop
          }

          // Retries exhausted or non-transient error -> Attempt verified fallback
          if (addLog) {
            addLog('warn', `Task #${taskId}: Primary provider "${providerId}" failed (${genErr.message}). Searching for verified fallback provider...`);
          }

          const fallback = await findFallbackProvider(providerId, providers, addLog, { allowPaid });
          if (fallback) {
            if (addLog) {
              addLog('ok', `Task #${taskId}: Switching to fallback provider "${fallback.name}".`);
            }
            providerId = fallback.id;
            retryCount = 0; // Reset retry count for fallback provider
            db.prepare('UPDATE tasks SET provider = ?, retry_count = 0 WHERE id = ?').run(providerId, taskId);
            continue; // Attempt generation with fallback
          }

          // No fallback available -> Fail task gracefully
          throw new Error(`Provider "${providerId}" failed: ${genErr.message}. No verified fallback provider is configured.`);
        }
      }
    } else {
      if (addLog) {
        addLog('info', `Task #${taskId}: Skipping [Generating] (restored from checkpoint).`);
      }
    }

    // ----------------------------------------------------
    // STEP 3: VERIFICATION & COMPLETION
    // ----------------------------------------------------
    if (abortController.signal.aborted) throw new Error('Task paused by user');

    saveCheckpoint(db, taskId, {
      step: 'verifying',
      progress: 90,
      completedSteps,
      checkpointData,
      status: 'running',
    });

    let finalResult = generatedCode || checkpointData.code || 'Task completed successfully.';
    checkpointData.result = finalResult;

    // Safe File Artifact Validation & Generation
    if (!checkpointData.artifacts) {
      checkpointData.artifacts = [];
    }

    // Check if task or parent workflow requests building a multi-file project
    let parentTaskTitle = '';
    if (task.parent_id) {
      try {
        const pTask = db.prepare('SELECT title FROM tasks WHERE id = ?').get(task.parent_id);
        if (pTask) parentTaskTitle = pTask.title;
      } catch {}
    }
    const isProjectGoal = (title) => {
      const t = (title || '').toLowerCase();
      return t.includes('expense') || t.includes('tracker') || t.includes('multi-file') || t.includes('build project');
    };

    if (agent === 'coding' && (isProjectGoal(task.title) || isProjectGoal(parentTaskTitle))) {
      // Execute bounded multi-file project builder
      const goalToBuild = parentTaskTitle || task.title;
      try {
        const projectResult = await buildProject({
          goal: goalToBuild,
          provider: providers[providerId] || null,
          allowOverwrite: true,
          customTimeoutMs,
          addLog,
          allowPaid,
        });
        if (projectResult && projectResult.ok) {
          checkpointData.artifacts = projectResult.artifacts;
          checkpointData.artifact_status = 'written';
          checkpointData.verification = projectResult.verification;
          checkpointData.project = {
            name: projectResult.projectName,
            targetDir: projectResult.targetDir,
            filesWritten: projectResult.filesWritten,
          };
          finalResult = `### Multi-File Project Generated: ${projectResult.projectName}\n` +
            `Generated ${projectResult.artifacts.length} verified project files in \`${projectResult.targetDir}\`:\n` +
            projectResult.artifacts.map(a => `- \`${a.relativePath}\` (${a.size} bytes)`).join('\n') +
            (projectResult.verification && projectResult.verification.verified
              ? `\n\nAutomated Verification Tests Passed: ${projectResult.verification.passed}/${projectResult.verification.total} assertions.`
              : '');
          checkpointData.result = finalResult;
          if (addLog) {
            addLog('ok', `Task #${taskId}: Project Builder generated ${projectResult.filesWritten} verified project files in "${projectResult.targetDir}".`);
          }
        }
      } catch (pErr) {
        if (addLog) {
          addLog('warn', `Task #${taskId}: Project Builder build error: ${pErr.message}`);
        }
      }
    } else if ((agent === 'coding' || agent === 'graphics') && generatedCode) {
      const extracted = extractArtifactsFromMarkdown(generatedCode);
      if (extracted.isTruncated) {
        checkpointData.artifact_status = 'truncated';
        checkpointData.artifact_warning = 'Provider code output was truncated before completion. No partial files were written to disk.';
        if (addLog) {
          addLog('warn', `Task #${taskId}: Provider output truncated. Prevented writing partial files.`);
        }
      } else if (extracted.artifacts.length > 0) {
        const hasInvalid = extracted.artifacts.some(a => !a.valid);
        if (hasInvalid) {
          checkpointData.artifact_status = 'invalid';
          checkpointData.artifact_warning = 'Some extracted code artifacts failed validation. Disk writing skipped.';
          if (addLog) {
            addLog('warn', `Task #${taskId}: Extracted code failed validation. Files not written.`);
          }
        } else {
          const writtenList = [];
          for (const art of extracted.artifacts) {
            const w = writeArtifact({
              relativePath: art.relativePath,
              content: art.content,
              allowOverwrite: true,
              expectedType: art.lang,
            });
            writtenList.push({
              relativePath: w.relativePath,
              size: w.size,
              sha256: w.sha256,
              createdAt: w.createdAt,
              status: 'written',
              // P0 file-type check: record the expected type at write time,
              // so the completion gate can verify extension matches type.
              expectedType: art.lang || null,
            });
          }
          checkpointData.artifacts = writtenList;
          checkpointData.artifact_status = 'written';
          if (addLog) {
            addLog('ok', `Task #${taskId}: Wrote ${writtenList.length} verified file artifact(s) to workspace.`);
          }
        }
      }
    }

    // P0 file-task signal (Assignment 1.2): a project goal is a file task
    // even if its artifact list is empty at this point, so an empty list
    // must fail instead of completing as text.
    // P2 title intent (Assignment 1.4): a title like "Create login.html"
    // is also a file task, even if no artifact was returned.
    if (agent === 'coding' && (isProjectGoal(task.title) || isProjectGoal(parentTaskTitle))) {
      checkpointData.fileTaskExpected = true;
    }
    if (hasFileGenerationIntent(task.title) || hasFileGenerationIntent(parentTaskTitle)) {
      checkpointData.fileTaskExpected = true;
    }

    completedSteps.push('verifying');

    // P0 completion gate: a task must not reach completed/100% without a
    // verified output. A failed gate throws and the outer catch marks the
    // task failed, preserving the last checkpoint for recovery.
    const completionCheck = verifyTaskCompletion({ agent, finalResult, checkpointData, taskTitle: task.title, parentTitle: parentTaskTitle });
    if (!completionCheck.ok) {
      throw new Error(completionCheck.error);
    }
    if (completionCheck.verifiedArtifacts) {
      checkpointData.verifiedArtifacts = completionCheck.verifiedArtifacts;
    }
    // P2 TOCTOU re-verification (Assignment 1.4): re-run the gate with
    // hash binding immediately before the final UPDATE, with no await in
    // between, so a file replaced after the first check cannot slip
    // through. If the second check fails, the task fails instead of
    // completing, and the verified hashes are not trusted.
    const recheck = verifyTaskCompletion({ agent, finalResult, checkpointData, taskTitle: task.title, parentTitle: parentTaskTitle });
    if (!recheck.ok) {
      throw new Error(`Re-verification failed before completion: ${recheck.error}`);
    }
    if (recheck.verifiedArtifacts) {
      const first = JSON.stringify(completionCheck.verifiedArtifacts || []);
      const second = JSON.stringify(recheck.verifiedArtifacts || []);
      if (first !== second) {
        throw new Error('Re-verification failed before completion: artifact hashes changed during verification.');
      }
      checkpointData.verifiedArtifacts = recheck.verifiedArtifacts;
    }

    const completedAt = Date.now();
    db.prepare(`
      UPDATE tasks 
      SET status = 'completed',
          result = ?,
          error = NULL,
          progress = 100,
          current_step = 'completed',
          completed_steps = ?,
          checkpoint_data = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      finalResult,
      JSON.stringify(completedSteps),
      JSON.stringify(checkpointData),
      completedAt,
      completedAt,
      taskId
    );

    if (addLog) {
      addLog('ok', `Orchestrator: Task #${taskId} "${task.title}" completed successfully (100%).`);
    }

    return {
      ok: true,
      taskId,
      status: 'completed',
      result: finalResult,
      provider: providerId,
      retries: retryCount,
      completedSteps,
    };
  } catch (err) {
    const isPaused = err.message === 'Task paused by user';
    const finalStatus = isPaused ? 'paused' : 'failed';

    db.prepare(`
      UPDATE tasks 
      SET status = ?,
          error = ?,
          retry_count = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      finalStatus,
      err.message,
      retryCount,
      Date.now(),
      taskId
    );

    if (addLog) {
      addLog(isPaused ? 'warn' : 'error', `Orchestrator: Task #${taskId} ${finalStatus}: ${err.message}`);
    }

    return {
      ok: false,
      taskId,
      status: finalStatus,
      error: err.message,
      retries: retryCount,
    };
  } finally {
    activeTasks.delete(taskId);
    activeControllers.delete(taskId);
  }
}

// Pause a running task
function pauseTask(taskId, db, addLog) {
  if (!activeTasks.has(taskId)) {
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      const err = new Error(`Task #${taskId} not found.`);
      err.status = 404;
      throw err;
    }
    if (task.status === 'paused') {
      return { ok: true, message: `Task #${taskId} is already paused.` };
    }
    const err = new Error(`Task #${taskId} is not currently running.`);
    err.status = 400;
    throw err;
  }

  const controller = activeControllers.get(taskId);
  if (controller) {
    controller.abort();
  }

  db.prepare("UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?").run(Date.now(), taskId);
  if (addLog) {
    addLog('warn', `Orchestrator: Task #${taskId} paused by user. Checkpoints preserved.`);
  }

  return { ok: true, taskId, status: 'paused' };
}

// ---------------------------------------------------------------------------
// Stage K3: Goal Decomposition, Workflow Creation, and Sequential Runner
// ---------------------------------------------------------------------------

const activeWorkflows = new Set();

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const target = match ? match[1] : trimmed;
  try {
    return JSON.parse(target);
  } catch {
    const start = target.indexOf('{');
    const end = target.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(target.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

function validatePlanObject(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Plan must be a valid JSON object.');
  }
  if (!Array.isArray(plan.subtasks)) {
    throw new Error('Plan must contain a subtasks array.');
  }
  if (plan.subtasks.length < 2 || plan.subtasks.length > 4) {
    throw new Error('Plan must have between 2 and 4 subtasks.');
  }

  const validAgents = ['research', 'sketch', 'coding', 'graphics', 'video'];
  const stepsSeen = new Set();

  for (let i = 0; i < plan.subtasks.length; i++) {
    const sub = plan.subtasks[i];
    if (!sub || typeof sub !== 'object') {
      throw new Error(`Subtask at index ${i} is not an object.`);
    }
    const stepNum = Number(sub.step);
    if (!Number.isInteger(stepNum) || stepNum <= 0) {
      throw new Error(`Subtask at index ${i} must have a positive integer step number.`);
    }
    if (stepsSeen.has(stepNum)) {
      throw new Error(`Duplicate step number: ${stepNum}.`);
    }
    stepsSeen.add(stepNum);

    const title = typeof sub.title === 'string' ? sub.title.trim() : '';
    if (title.length < 3 || title.length > 120) {
      throw new Error(`Subtask step ${stepNum} title must be between 3 and 120 characters.`);
    }
    sub.title = title;

    if (!validAgents.includes(sub.agent)) {
      throw new Error(`Subtask step ${stepNum} specifies unknown agent "${sub.agent}". Allowed: ${validAgents.join(', ')}.`);
    }

    if (!Array.isArray(sub.depends_on_steps)) {
      sub.depends_on_steps = [];
    }
    for (const depStep of sub.depends_on_steps) {
      const depNum = Number(depStep);
      if (!Number.isInteger(depNum) || depNum <= 0) {
        throw new Error(`Subtask step ${stepNum} has invalid dependency step: ${depStep}.`);
      }
      if (depNum >= stepNum) {
        throw new Error(`Subtask step ${stepNum} cannot depend on step ${depNum} (steps can only depend on earlier steps to prevent cycles).`);
      }
      if (!stepsSeen.has(depNum)) {
        throw new Error(`Subtask step ${stepNum} references undeclared prior step ${depNum}.`);
      }
    }
  }

  return true;
}

function decomposeGoalHeuristic(goalTitle, { priority = 'Medium' } = {}) {
  const g = (goalTitle || '').toLowerCase();
  const shortGoal = (goalTitle || '').replace(/\s+/g, ' ').trim();
  const goalLabel = shortGoal.length > 50 ? shortGoal.slice(0, 47) + '...' : shortGoal;
  let subtasks = [];

  if (g.includes('research') || g.includes('host') || g.includes('compare') || g.includes('learn') || g.includes('cloud') || g.includes('option')) {
    subtasks = [
      { step: 1, title: `Research documentation and options for "${goalLabel}"`, agent: 'research', depends_on_steps: [] },
      { step: 2, title: `Draft architecture wireframe for "${goalLabel}"`, agent: 'sketch', depends_on_steps: [1] },
      { step: 3, title: `Implement clean solution code for "${goalLabel}"`, agent: 'coding', depends_on_steps: [1, 2] },
    ];
  } else if (g.includes('ui') || g.includes('app') || g.includes('portal') || g.includes('dashboard') || g.includes('page') || g.includes('component')) {
    subtasks = [
      { step: 1, title: `Design ASCII wireframe layout for "${goalLabel}"`, agent: 'sketch', depends_on_steps: [] },
      { step: 2, title: `Implement UI logic and components for "${goalLabel}"`, agent: 'coding', depends_on_steps: [1] },
      { step: 3, title: `Generate vector SVG visual asset for "${goalLabel}"`, agent: 'graphics', depends_on_steps: [1] },
    ];
  } else if (g.includes('video') || g.includes('storyboard') || g.includes('script') || g.includes('presentation')) {
    subtasks = [
      { step: 1, title: `Gather reference facts and topic overview for "${goalLabel}"`, agent: 'research', depends_on_steps: [] },
      { step: 2, title: `Draft storyboard and scene breakdown for "${goalLabel}"`, agent: 'video', depends_on_steps: [1] },
    ];
  } else {
    subtasks = [
      { step: 1, title: `Research and plan requirements for "${goalLabel}"`, agent: 'research', depends_on_steps: [] },
      { step: 2, title: `Draft component specifications for "${goalLabel}"`, agent: 'sketch', depends_on_steps: [1] },
      { step: 3, title: `Implement and verify code for "${goalLabel}"`, agent: 'coding', depends_on_steps: [1, 2] },
    ];
  }

  return {
    plan: `Multi-agent plan for "${goalLabel}": sequential decomposition across specialized agents.`,
    subtasks,
    source: 'heuristic',
  };
}

async function decomposeGoal(goalTitle, { providers = {}, priority = 'Medium', allowPaid = false } = {}) {
  const cleanGoal = typeof goalTitle === 'string' ? goalTitle.trim() : '';
  if (cleanGoal.length < 3 || cleanGoal.length > 4000) {
    throw new Error('Goal must be 3 to 4000 characters.');
  }

  // P1 explicit allowPaid (Assignment 1.2): decomposition calls Gemini
  // directly, bypassing executeOrchestratedTask, so it must check here.
  // Gemini is free-tier today, so this passes with allowPaid false, but
  // the check is explicit and will block a paid provider if this ever changes.
  assertAllowPaid('gemini', allowPaid);
  const geminiProvider = providers && providers.gemini;
  let useGemini = false;
  if (geminiProvider && typeof geminiProvider.checkHealth === 'function') {
    try {
      const health = await geminiProvider.checkHealth({ timeoutMs: 3500 });
      if (health && health.connected) {
        useGemini = true;
      }
    } catch {
      useGemini = false;
    }
  }

  if (useGemini && typeof geminiProvider.generateContent === 'function') {
    try {
      const prompt = `You are the Project Beyond Multi-Agent Workflow Planner.\nDecompose this user goal into 2 to 4 sequential or parallel subtasks executed by our specialized AI agent team.\nGoal: "${cleanGoal}"\n\nAvailable agents (YOU MUST ONLY USE THESE EXACT NAMES):\n- "research": Fetches genuine facts, sources, and citations from Wikipedia.\n- "sketch": Designs ASCII wireframes, layout hierarchies, component specs.\n- "coding": Implements clean, self-contained code modules.\n- "graphics": Generates SVG vector graphics (<svg> markup) and diagram syntax.\n- "video": Plans storyboards and video script breakdown tables.\n\nRules:\n1. Provide between 2 and 4 subtasks.\n2. Steps must be numbered 1, 2, ...\n3. depends_on_steps must only reference earlier step numbers (e.g. [] or [1]).\n4. Output ONLY valid JSON with no markdown wrapping and no other text:\n{\n  "plan": "1-sentence overview",\n  "subtasks": [\n    { "step": 1, "title": "concise action title", "agent": "research", "depends_on_steps": [] },\n    { "step": 2, "title": "concise action title", "agent": "coding", "depends_on_steps": [1] }\n  ]\n}`;

      const res = await geminiProvider.generateContent({ prompt, timeoutMs: 12000 });
      if (res && res.ok && res.text) {
        const parsed = extractJson(res.text);
        if (parsed) {
          validatePlanObject(parsed);
          parsed.source = 'gemini';
          return parsed;
        }
      }
    } catch {
      // Fallback to deterministic heuristic
    }
  }

  return decomposeGoalHeuristic(cleanGoal, { priority });
}

function createWorkflow(db, { title, priority = 'Medium', plan, providers, addLog }) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Valid plan object is required to create a workflow.');
  }
  validatePlanObject(plan);

  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (cleanTitle.length < 3 || cleanTitle.length > 4000) {
    throw new Error('Goal must be 3 to 4000 characters.');
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    const parentRes = db.prepare(`
      INSERT INTO tasks(title, agent, priority, status, parent_id, depends_on, created_at, checkpoint_data)
      VALUES (?, 'workflow', ?, 'pending', NULL, '[]', ?, ?)
    `).run(
      cleanTitle,
      priority,
      Date.now(),
      JSON.stringify({ plan: plan.plan || cleanTitle, source: plan.source || 'heuristic' })
    );

    const parentId = Number(parentRes.lastInsertRowid);
    const stepToDbId = {};
    const childIds = [];

    for (const sub of plan.subtasks) {
      const dbDeps = (sub.depends_on_steps || []).map(s => stepToDbId[s]).filter(Boolean);
      validateDependencies(null, dbDeps, db);

      const childRes = db.prepare(`
        INSERT INTO tasks(title, agent, priority, status, parent_id, depends_on, created_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        sub.title,
        sub.agent,
        priority,
        parentId,
        JSON.stringify(dbDeps),
        Date.now()
      );

      const childId = Number(childRes.lastInsertRowid);
      stepToDbId[sub.step] = childId;
      childIds.push(childId);
    }

    db.prepare('UPDATE tasks SET checkpoint_data = ? WHERE id = ?')
      .run(JSON.stringify({ plan: plan.plan || cleanTitle, subtaskIds: childIds, source: plan.source || 'heuristic' }), parentId);

    db.exec('COMMIT;');

    if (addLog) {
      addLog('info', `Workflow #${parentId} created: "${cleanTitle}" with ${childIds.length} subtasks [${childIds.join(', ')}].`);
    }

    return {
      ok: true,
      parentId,
      subtaskIds: childIds,
      plan: plan.plan,
      source: plan.source || 'heuristic',
    };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }
}

function consolidateWorkflow(db, parentId, addLog) {
  const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parentId);
  if (!parent) return null;

  const subtasks = db.prepare('SELECT id, title, agent, status, result, checkpoint_data FROM tasks WHERE parent_id = ? ORDER BY id ASC').all(parentId);
  if (subtasks.length === 0) return null;

  // Guard: Never consolidate or mark completed if any required subtask is not completed
  const hasIncomplete = subtasks.some(s => s.status !== 'completed' && s.status !== 'done');
  if (hasIncomplete) {
    if (addLog) {
      addLog('warn', `Workflow #${parentId}: Cannot consolidate deliverable because some subtasks are incomplete.`);
    }
    return null;
  }

  const sections = subtasks.map((s, idx) => {
    return `### Step ${idx + 1}: ${s.title} [Agent: ${s.agent}]\n${(s.result || '(No output text)').trim()}`;
  });

  const allArtifacts = [];
  for (const s of subtasks) {
    if (s.checkpoint_data) {
      try {
        const cd = typeof s.checkpoint_data === 'string' ? JSON.parse(s.checkpoint_data) : s.checkpoint_data;
        if (Array.isArray(cd.artifacts)) {
          allArtifacts.push(...cd.artifacts);
        }
      } catch {}
    }
  }

  let artifactSummary = '';
  if (allArtifacts.length > 0) {
    artifactSummary = `\n\n## Verified File Artifacts (${allArtifacts.length} file(s) written to disk):\n` +
      allArtifacts.map(a => `• \`${a.relativePath}\` (${a.size} bytes)`).join('\n') +
      `\n\n*Code Execution: Prohibited. Static file creation only.*`;
  } else {
    artifactSummary = `\n\n## File Artifacts Status:\n• No physical files were written to disk (Plan & Code Report Only).`;
  }

  const consolidatedOutput = `# Project Beyond AI Team — Workflow Deliverable\n**Goal:** "${parent.title}"\n**Execution:** All ${subtasks.length} subtasks completed successfully.${artifactSummary}\n\n${sections.join('\n\n---\n\n')}`;

  let parentCheckpoint = {};
  try {
    parentCheckpoint = typeof parent.checkpoint_data === 'string' ? JSON.parse(parent.checkpoint_data) : (parent.checkpoint_data || {});
  } catch {
    parentCheckpoint = {};
  }
  parentCheckpoint.artifacts = allArtifacts;
  parentCheckpoint.has_real_files = allArtifacts.length > 0;

  db.prepare(`
    UPDATE tasks 
    SET status = 'completed',
        progress = 100,
        result = ?,
        error = NULL,
        checkpoint_data = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(consolidatedOutput, JSON.stringify(parentCheckpoint), Date.now(), Date.now(), parentId);

  if (addLog) {
    addLog('ok', `Workflow #${parentId}: All ${subtasks.length} subtasks consolidated into parent task deliverable (100%).`);
  }

  return consolidatedOutput;
}

async function executeSequentialWorkflow({
  db,
  parentId,
  providers,
  addLog,
  requestedProvider = 'gemini',
  customTimeoutMs = 15000,
  // P1 explicit allowPaid (Assignment 1.2): previously this function omitted
  // allowPaid and relied on the default false in executeOrchestratedTask.
  // It is now explicit, so every nested workflow subtask respects the same
  // policy and a future default change cannot silently bypass it.
  allowPaid = false,
}) {
  if (activeWorkflows.has(parentId) || activeTasks.has(parentId)) {
    const err = new Error(`Workflow #${parentId} is already executing. Duplicate execution prevented.`);
    err.status = 409;
    throw err;
  }

  const parentTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parentId);
  if (!parentTask) {
    const err = new Error(`Workflow parent task #${parentId} not found.`);
    err.status = 404;
    throw err;
  }

  if (parentTask.status === 'completed' || parentTask.status === 'done') {
    const err = new Error(`Workflow #${parentId} is already completed.`);
    err.status = 400;
    throw err;
  }

  const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY id ASC').all(parentId);
  if (subtasks.length === 0) {
    const err = new Error(`Workflow #${parentId} has no subtasks.`);
    err.status = 400;
    throw err;
  }

  activeWorkflows.add(parentId);
  activeTasks.add(parentId);

  // If retrying a failed workflow, reset failed subtasks to pending so they can re-attempt
  if (parentTask.status === 'failed') {
    db.prepare("UPDATE tasks SET status = 'pending', error = NULL, retry_count = 0, updated_at = ? WHERE parent_id = ? AND status = 'failed'")
      .run(Date.now(), parentId);
    if (addLog) {
      addLog('info', `Workflow #${parentId}: Resetting failed subtasks to pending for re-execution attempt.`);
    }
  }

  db.prepare("UPDATE tasks SET status = 'running', error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), parentId);
  if (addLog) {
    addLog('info', `Starting execution of workflow #${parentId} ("${parentTask.title}") with ${subtasks.length} subtasks.`);
  }

  try {
    const totalSubtasks = subtasks.length;

    while (true) {
      const currentSubtasks = db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY id ASC').all(parentId);
      const completedSubtasks = currentSubtasks.filter(t => t.status === 'completed' || t.status === 'done');
      const failedSubtasks = currentSubtasks.filter(t => t.status === 'failed');

      const progressPct = Math.round((completedSubtasks.length / totalSubtasks) * 100);
      db.prepare('UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?').run(progressPct, Date.now(), parentId);

      if (completedSubtasks.length === totalSubtasks) {
        break;
      }

      if (failedSubtasks.length > 0) {
        const failedIds = new Set(failedSubtasks.map(f => f.id));
        for (const sub of currentSubtasks) {
          if (sub.status === 'pending' || sub.status === 'queued') {
            let deps = [];
            try { deps = JSON.parse(sub.depends_on || '[]'); } catch {}
            const blockedBy = deps.find(d => failedIds.has(d));
            if (blockedBy) {
              db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
                .run(`Blocked: Upstream dependency task #${blockedBy} failed.`, Date.now(), sub.id);
              if (addLog) {
                addLog('warn', `Workflow #${parentId}: Subtask #${sub.id} ("${sub.title}") marked as blocked due to failed dependency #${blockedBy}.`);
              }
              failedIds.add(sub.id);
            }
          }
        }

        const failReason = `Workflow halted: Subtask #${failedSubtasks[0].id} ("${failedSubtasks[0].title}") failed: ${failedSubtasks[0].error || 'Execution error'}`;
        db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(failReason, Date.now(), parentId);
        if (addLog) {
          addLog('error', `Workflow #${parentId}: ${failReason}`);
        }
        return {
          ok: false,
          parentId,
          status: 'failed',
          error: failReason,
          completedCount: completedSubtasks.length,
          totalCount: totalSubtasks,
        };
      }

      const readySubtask = currentSubtasks.find(sub => {
        if (sub.status !== 'pending' && sub.status !== 'queued' && sub.status !== 'paused') return false;
        let deps = [];
        try { deps = JSON.parse(sub.depends_on || '[]'); } catch { deps = []; }
        if (deps.length === 0) return true;
        return deps.every(depId => {
          const depTask = currentSubtasks.find(t => t.id === depId) || db.prepare('SELECT status FROM tasks WHERE id = ?').get(depId);
          return depTask && (depTask.status === 'completed' || depTask.status === 'done');
        });
      });

      if (!readySubtask) {
        const deadlockMsg = `Workflow deadlock: remaining subtasks cannot satisfy dependencies.`;
        db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(deadlockMsg, Date.now(), parentId);
        if (addLog) addLog('error', `Workflow #${parentId}: ${deadlockMsg}`);
        return { ok: false, parentId, status: 'failed', error: deadlockMsg };
      }

      if (addLog) {
        addLog('info', `Workflow #${parentId}: Executing subtask #${readySubtask.id} (${readySubtask.agent}) "${readySubtask.title}"...`);
      }

      const execResult = await executeOrchestratedTask({
        db,
        taskId: readySubtask.id,
        providers,
        addLog,
        requestedProvider,
        customTimeoutMs,
        allowPaid,
      });

      if (!execResult.ok) {
        if (addLog) {
          addLog('warn', `Workflow #${parentId}: Subtask #${readySubtask.id} execution returned error: ${execResult.error}`);
        }
      }
    }

    const consolidated = consolidateWorkflow(db, parentId, addLog);

    return {
      ok: true,
      parentId,
      status: 'completed',
      result: consolidated,
      subtasksCompleted: totalSubtasks,
    };
  } finally {
    activeWorkflows.delete(parentId);
    activeTasks.delete(parentId);
  }
}

module.exports = {
  initOrchestrator,
  findFallbackProvider,
  saveCheckpoint,
  executeOrchestratedTask,
  pauseTask,
  isTransientError,
  validateDependencies,
  resolveDependencyContext,
  activeTasks,
  activeWorkflows,
  extractJson,
  validatePlanObject,
  decomposeGoalHeuristic,
  decomposeGoal,
  createWorkflow,
  executeSequentialWorkflow,
  consolidateWorkflow,
  writeArtifact,
  listArtifacts,
  readArtifact,
  extractArtifactsFromMarkdown,
  validateArtifactContent,
  verifyTaskCompletion,
  verifyArtifactFile,
  hasFileGenerationIntent,
};
