'use strict';
// Project Beyond — Artifact Generation & Filesystem Security Service
// Safe, verifiable file-artifact creation strictly bounded to a designated workspace directory.
// Zero external dependencies. Uses Node.js native fs, path, and crypto modules.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_WORKSPACE_DIR = path.resolve(__dirname, 'workspace');

/**
 * Resolves and creates the workspace directory safely.
 * @param {string} [customDir]
 * @returns {string} Absolute normalized workspace path
 */
function resolveWorkspaceDir(customDir) {
  const target = customDir || process.env.ARTIFACTS_DIR || DEFAULT_WORKSPACE_DIR;
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Resolves a relative path inside baseDir and verifies that it does not escape.
 * Throws security errors on path traversal, absolute paths, or invalid characters.
 * @param {string} baseDir
 * @param {string} relativePath
 * @returns {string} Safe absolute path
 */
function resolveSafePath(baseDir, relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Relative path must be a non-empty string.');
  }

  // Reject null bytes
  if (relativePath.includes('\0')) {
    throw new Error('Path traversal rejected: path contains null bytes.');
  }

  // Reject absolute paths
  if (path.isAbsolute(relativePath)) {
    throw new Error('Path traversal rejected: absolute paths are prohibited.');
  }

  // Reject Windows drive letters (e.g. C:file or C:\file)
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new Error('Path traversal rejected: drive letter references are prohibited.');
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativePath);

  // Strict boundary check: resolved path must be inside resolvedBase
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error(`Path traversal rejected: "${relativePath}" escapes the workspace.`);
  }

  return resolvedTarget;
}

/**
 * Normalizes a relative path to standard forward-slash format for cross-platform consistency.
 * @param {string} baseDir
 * @param {string} absolutePath
 * @returns {string}
 */
function toRelativePosix(baseDir, absolutePath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(absolutePath));
  return rel.split(path.sep).join('/');
}

/**
 * Validates file content and checks for signs of provider truncation.
 * @param {string} content
 * @param {string} [expectedType]
 * @returns {{ valid: boolean, error?: string, isTruncated?: boolean, detectedType: string }}
 */
function validateArtifactContent(content, expectedType = null) {
  if (typeof content !== 'string') {
    return { valid: false, error: 'Artifact content must be a string.', detectedType: 'unknown' };
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return { valid: false, error: 'Artifact content cannot be empty.', detectedType: 'empty' };
  }

  // Check 1: Unclosed markdown code fences in content
  const fenceMatches = content.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    return {
      valid: false,
      isTruncated: true,
      error: 'Content contains an unclosed markdown code fence (truncated output).',
      detectedType: 'truncated_markdown',
    };
  }

  // Determine or verify type
  let detectedType = expectedType || 'text';
  if (!expectedType) {
    if (/^\s*<!DOCTYPE\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
      detectedType = 'html';
    } else if (/^\s*\{[\s\S]*\}\s*$/.test(trimmed) || /^\s*\[[\s\S]*\]\s*$/.test(trimmed)) {
      detectedType = 'json';
    } else if (/<svg[\s>]/i.test(trimmed)) {
      detectedType = 'svg';
    }
  }

  // Check 2: HTML structural completeness
  if (detectedType === 'html') {
    const hasHtmlTag = /<[a-z][\s\S]*>/i.test(trimmed);
    if (!hasHtmlTag) {
      return {
        valid: false,
        error: 'HTML content does not contain valid HTML element markup.',
        detectedType: 'html',
      };
    }
    const hasHtmlOpen = /<html[\s>]/i.test(trimmed);
    const hasHtmlClose = /<\/html\s*>/i.test(trimmed);
    const hasBodyClose = /<\/body\s*>/i.test(trimmed);

    if (hasHtmlOpen && (!hasHtmlClose || !hasBodyClose)) {
      return {
        valid: false,
        isTruncated: true,
        error: 'HTML document is incomplete (missing closing </body> or </html> tag). Truncated generation detected.',
        detectedType: 'html',
      };
    }
  }

  // Check 3: JSON validity
  if (detectedType === 'json') {
    try {
      JSON.parse(trimmed);
    } catch (err) {
      return {
        valid: false,
        isTruncated: true,
        error: `JSON artifact is syntactically invalid or truncated: ${err.message}`,
        detectedType: 'json',
      };
    }
  }

  // Check 4: CSS balanced braces check
  if (detectedType === 'css') {
    let openCount = 0;
    let hasBraces = false;
    for (const ch of trimmed) {
      if (ch === '{') { openCount++; hasBraces = true; }
      else if (ch === '}') { openCount--; hasBraces = true; }
      if (openCount < 0) break;
    }
    if (openCount !== 0) {
      return {
        valid: false,
        isTruncated: true,
        error: `CSS content has unbalanced curly braces (${openCount} unclosed). Truncated generation detected.`,
        detectedType: 'css',
      };
    }
    if (!hasBraces) {
      return {
        valid: false,
        error: 'CSS content does not contain any rule block declarations.',
        detectedType: 'css',
      };
    }
  }

  // Check 5: JavaScript syntax check
  if (detectedType === 'js' || detectedType === 'javascript') {
    try {
      const vm = require('node:vm');
      new vm.Script(trimmed);
    } catch (err) {
      return {
        valid: false,
        isTruncated: true,
        error: `JavaScript syntax error: ${err.message}`,
        detectedType: 'js',
      };
    }
  }

  return { valid: true, detectedType };
}

/**
 * Writes an artifact safely to the designated workspace.
 * Prevents path traversal, overwrites (unless allowOverwrite is true), and truncated content.
 *
 * @param {object} options
 * @param {string} [options.workspaceDir] Base workspace directory
 * @param {string} options.relativePath Relative file path inside workspace
 * @param {string} options.content File content
 * @param {boolean} [options.allowOverwrite=false]
 * @param {string} [options.expectedType]
 * @returns {object} Artifact metadata record
 */
function writeArtifact({
  workspaceDir = null,
  relativePath,
  content,
  allowOverwrite = false,
  expectedType = null,
}) {
  const baseDir = resolveWorkspaceDir(workspaceDir);
  const targetPath = resolveSafePath(baseDir, relativePath);

  // Overwrite protection
  if (!allowOverwrite && fs.existsSync(targetPath)) {
    const err = new Error(`File already exists and overwrite protection is enabled: "${relativePath}".`);
    err.code = 'EEXIST';
    err.status = 409;
    throw err;
  }

  // Content validation
  const validation = validateArtifactContent(content, expectedType);
  if (!validation.valid) {
    const err = new Error(`Artifact validation failed: ${validation.error}`);
    err.status = 400;
    err.isTruncated = Boolean(validation.isTruncated);
    throw err;
  }

  // Ensure parent directory exists safely
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Write file atomically/synchronously with UTF-8 encoding
  fs.writeFileSync(targetPath, content, 'utf8');

  const stats = fs.statSync(targetPath);
  const relPosix = toRelativePosix(baseDir, targetPath);
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

  return {
    ok: true,
    relativePath: relPosix,
    absolutePath: targetPath,
    size: stats.size,
    type: validation.detectedType,
    sha256,
    createdAt: stats.birthtimeMs || Date.now(),
    modifiedAt: stats.mtimeMs || Date.now(),
    status: 'written',
  };
}

/**
 * Lists all verified file artifacts currently present in the workspace.
 * @param {string} [workspaceDir]
 * @returns {Array<object>}
 */
function listArtifacts(workspaceDir = null) {
  const baseDir = resolveWorkspaceDir(workspaceDir);
  const results = [];

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile()) {
        const stats = fs.statSync(fullPath);
        results.push({
          relativePath: toRelativePosix(baseDir, fullPath),
          absolutePath: fullPath,
          size: stats.size,
          modifiedAt: stats.mtimeMs,
          createdAt: stats.birthtimeMs,
        });
      }
    }
  }

  walk(baseDir);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Reads an artifact safely from the workspace.
 * @param {string} [workspaceDir]
 * @param {string} relativePath
 * @returns {object} Content and metadata
 */
function readArtifact(workspaceDir = null, relativePath) {
  const baseDir = resolveWorkspaceDir(workspaceDir);
  const targetPath = resolveSafePath(baseDir, relativePath);

  if (!fs.existsSync(targetPath)) {
    const err = new Error(`Artifact "${relativePath}" not found.`);
    err.status = 404;
    throw err;
  }

  const stats = fs.statSync(targetPath);
  if (!stats.isFile()) {
    const err = new Error(`Path "${relativePath}" is a directory, not a file.`);
    err.status = 400;
    throw err;
  }

  const content = fs.readFileSync(targetPath, 'utf8');
  return {
    ok: true,
    relativePath: toRelativePosix(baseDir, targetPath),
    absolutePath: targetPath,
    size: stats.size,
    content,
    modifiedAt: stats.mtimeMs,
  };
}

/**
 * Parses markdown text to extract proposed code file artifacts.
 * Looks for patterns like:
 *   ### 1. `index.html`
 *   ```html
 *   ...
 *   ```
 * or
 *   ```html <!-- filename: index.html -->
 *
 * @param {string} text
 * @returns {{ artifacts: Array<object>, isTruncated: boolean, summary: string }}
 */
function extractArtifactsFromMarkdown(text) {
  if (!text || typeof text !== 'string') {
    return { artifacts: [], isTruncated: false, summary: 'No text provided' };
  }

  // Check overall truncation
  const fenceCount = (text.match(/```/g) || []).length;
  const isTruncated = fenceCount % 2 !== 0;

  const artifacts = [];
  // Regex pattern matching filename markers followed by code fences
  // Examples:
  // ### 1. `index.html`\n```html\n<code>\n```
  // ### File: `style.css`\n```css\n<code>\n```
  const fileSectionRegex = /(?:###?\s*(?:\d+\.|\bFile:)?\s*[`"]?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)[`"]?)[^`]*?```([a-zA-Z0-9_\-]+)?\r?\n([\s\S]*?)```/gi;

  let match;
  while ((match = fileSectionRegex.exec(text)) !== null) {
    const fileName = match[1].trim();
    const lang = (match[2] || '').trim().toLowerCase();
    const codeContent = match[3];

    // Only accept clean relative paths with valid extensions
    if (fileName && !fileName.includes('..') && /\.(html|css|js|json|svg|md|txt)$/i.test(fileName)) {
      const validation = validateArtifactContent(codeContent, lang);
      artifacts.push({
        relativePath: fileName,
        content: codeContent,
        lang,
        valid: validation.valid,
        error: validation.error,
        isTruncated: Boolean(validation.isTruncated),
      });
    }
  }

  return {
    artifacts,
    isTruncated,
    summary: `Extracted ${artifacts.length} potential artifact(s). Overall truncated: ${isTruncated}`,
  };
}

module.exports = {
  DEFAULT_WORKSPACE_DIR,
  resolveWorkspaceDir,
  resolveSafePath,
  toRelativePosix,
  validateArtifactContent,
  writeArtifact,
  listArtifacts,
  readArtifact,
  extractArtifactsFromMarkdown,
};
