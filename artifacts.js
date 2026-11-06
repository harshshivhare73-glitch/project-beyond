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
 * P0 path security (Assignment 1.2): verify that a resolved path, after
 * resolving every symlink, still lies inside the workspace boundary.
 * resolveSafePath alone checks the string prefix, which a symlink inside
 * the workspace pointing outside can bypass. This function closes that gap.
 * Throws on any escape. Missing files are handled by the caller, which
 * checks existence before calling this with a real path.
 */
function verifyRealPathInside(baseDir, targetPath) {
  const realBase = fs.realpathSync(path.resolve(baseDir));
  const realTarget = fs.realpathSync(path.resolve(targetPath));
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    throw new Error(`Path escapes the workspace: resolved path "${realTarget}" is outside "${realBase}".`);
  }
  return realTarget;
}

/**
 * P0 path security (Assignment 1.2): resolve an artifact path and verify
 * it completely, for every verification path (not just video tasks).
 * - Rejects backslash (Windows-style) separators, null bytes, absolute
 *   paths and Windows drive letters, before any filesystem access.
 * - Rejects ../ traversal via resolveSafePath.
 * - Rejects missing files, directories, and symlinks that resolve outside
 *   the workspace (via verifyRealPathInside).
 * - Never trusts a caller-supplied absolutePath: only relativePath inside
 *   the workspace is accepted. Callers must not pass absolutePath here.
 * Returns { baseDir, targetPath, realPath, size } or throws.
 */
function getVerifiedArtifactPath(workspaceDir = null, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error('Artifact path must be a non-empty string.');
  }
  if (relativePath.includes('\\')) {
    throw new Error('Backslash path separators are not allowed in artifact paths (Windows-style paths rejected).');
  }
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
  const realPath = verifyRealPathInside(baseDir, targetPath);
  return { baseDir, targetPath, realPath, size: stats.size };
}

/**
 * P0/P2 MP4 structural validation (Assignments 1.2 and 1.4), pure Node, no
 * dependency, no FFmpeg/FFprobe. This validates ISO Base Media File Format
 * box structure only — it does NOT prove the file plays, decodes, or has
 * valid video frames, and it does NOT prove the media data is decodable.
 * Never label this as playback verification.
 * Stricter rules (1.4):
 * - ftyp major brand and every compatible brand must be printable ASCII.
 * - moov must contain mvhd or trak, and every moov child must be a known
 *   moov child type (mvhd, trak, udta, meta, mvex, free, skip). Junk children
 *   such as xxxx are rejected.
 * - At least one mdat box must be present, otherwise the file has no media
 *   data, even if ftyp and moov are present.
 * Bounded-memory file validation (1.4): validateMp4File() does NOT read
 * the whole file. It seeks through box headers, reads only ftyp and moov
 * payloads (moov capped at 16 MB), and skips mdat payloads by seeking.
 * Memory use is therefore bounded by moov size, not by file size, and a
 * large file is not loaded into RAM. A moov larger than 16 MB is rejected
 * with a bounded-validation error, not silently accepted. This is a
 * documented limitation, not a claim of 4 GB support: 4 GB support is not
 * claimed unless a large file is tested with this bounded parser.
 */
const MP4_MOOV_CHILD_TYPES = new Set(['mvhd', 'trak', 'udta', 'meta', 'mvex', 'free', 'skip']);
const MP4_MAX_MOOV_BYTES = 16 * 1024 * 1024;
function isPrintableAscii(str) {
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return str.length > 0;
}
function validateMp4Boxes(topBoxes, ftypPayload, moovPayload) {
  if (topBoxes.length === 0 || topBoxes[0].type !== 'ftyp') {
    return { ok: false, error: 'MP4 file must start with an ftyp box.' };
  }
  const ftyp = topBoxes[0];
  if (ftyp.size < 16 || (ftyp.size - 16) % 4 !== 0) {
    return { ok: false, error: 'MP4 ftyp box is malformed.' };
  }
  if (!ftypPayload || ftypPayload.length < 8) {
    return { ok: false, error: 'MP4 ftyp box is malformed.' };
  }
  const majorBrand = ftypPayload.toString('ascii', 0, 4);
  if (!isPrintableAscii(majorBrand)) {
    return { ok: false, error: 'MP4 ftyp major brand is not printable ASCII.' };
  }
  for (let i = 8; i + 4 <= ftypPayload.length; i += 4) {
    if (!isPrintableAscii(ftypPayload.toString('ascii', i, i + 4))) {
      return { ok: false, error: 'MP4 ftyp compatible brand is not printable ASCII.' };
    }
  }
  const moov = topBoxes.find((b) => b.type === 'moov');
  if (!moov) {
    return { ok: false, error: 'MP4 file has no moov box (only a header or incomplete container).' };
  }
  if (!topBoxes.some((b) => b.type === 'mdat')) {
    return { ok: false, error: 'MP4 file has no mdat box (no media data).' };
  }
  if (!moovPayload || moovPayload.length === 0) {
    return { ok: false, error: 'MP4 moov box is empty.' };
  }
  let childOffset = 0;
  let childCount = 0;
  let hasMediaHeader = false;
  while (childOffset < moovPayload.length) {
    if (moovPayload.length - childOffset < 8) {
      return { ok: false, error: 'MP4 moov child box header truncated.' };
    }
    let csize = moovPayload.readUInt32BE(childOffset);
    const ctype = moovPayload.toString('ascii', childOffset + 4, childOffset + 8);
    let cheader = 8;
    if (csize === 1) {
      if (moovPayload.length - childOffset < 16) return { ok: false, error: 'MP4 moov child largesize header truncated.' };
      const large = moovPayload.readBigUInt64BE(childOffset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'MP4 moov child box size too large.' };
      csize = Number(large); cheader = 16;
    } else if (csize === 0) {
      csize = moovPayload.length - childOffset;
    }
    if (!/^[a-zA-Z0-9]{4}$/.test(ctype) || csize < cheader || childOffset + csize > moovPayload.length) {
      return { ok: false, error: 'MP4 moov child box is truncated or corrupt.' };
    }
    if (!MP4_MOOV_CHILD_TYPES.has(ctype)) {
      return { ok: false, error: `MP4 moov child box type "${ctype}" is not a known moov child.` };
    }
    if (ctype === 'mvhd' || ctype === 'trak') hasMediaHeader = true;
    childCount += 1;
    childOffset += csize;
  }
  if (childCount === 0 || !hasMediaHeader) {
    return { ok: false, error: 'MP4 moov box must contain mvhd or trak.' };
  }
  return { ok: true, boxes: topBoxes.map((b) => b.type) };
}
function parseTopBoxesFromBuffer(buffer) {
  const boxes = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) {
      return { error: `MP4 box header truncated at offset ${offset}.` };
    }
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[a-zA-Z0-9]{4}$/.test(type)) {
      return { error: `MP4 box type invalid at offset ${offset}.` };
    }
    let headerSize = 8;
    if (size === 1) {
      if (buffer.length - offset < 16) return { error: `MP4 largesize box header truncated at offset ${offset}.` };
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { error: `MP4 box size too large at offset ${offset}.` };
      size = Number(large); headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < headerSize) return { error: `MP4 box size ${size} is smaller than its header at offset ${offset}.` };
    if (offset + size > buffer.length) return { error: `MP4 box "${type}" at offset ${offset} claims size ${size} but the file ends at ${buffer.length} (truncated or corrupt).` };
    boxes.push({ type, offset, size, headerSize });
    offset += size;
  }
  return { boxes };
}
function validateMp4Buffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'MP4 file is empty.' };
  }
  const parsed = parseTopBoxesFromBuffer(buffer);
  if (parsed.error) return { ok: false, error: parsed.error };
  const ftyp = parsed.boxes[0];
  const moov = parsed.boxes.find((b) => b.type === 'moov');
  const ftypPayload = ftyp ? buffer.subarray(ftyp.offset + ftyp.headerSize, ftyp.offset + ftyp.size) : null;
  const moovPayload = moov ? buffer.subarray(moov.offset + moov.headerSize, moov.offset + moov.size) : null;
  return validateMp4Boxes(parsed.boxes, ftypPayload, moovPayload);
}
function validateMp4File(targetPath) {
  let fd;
  try {
    fd = fs.openSync(targetPath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize === 0) return { ok: false, error: 'MP4 file is empty.' };
    const boxes = [];
    let offset = 0;
    let ftypPayload = null;
    let moovInfo = null;
    while (offset < fileSize) {
      if (fileSize - offset < 8) return { ok: false, error: `MP4 box header truncated at offset ${offset}.` };
      const header = Buffer.alloc(16);
      const read = fs.readSync(fd, header, 0, 16, offset);
      if (read < 8) return { ok: false, error: `MP4 box header truncated at offset ${offset}.` };
      let size = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      if (!/^[a-zA-Z0-9]{4}$/.test(type)) return { ok: false, error: `MP4 box type invalid at offset ${offset}.` };
      let headerSize = 8;
      if (size === 1) {
        if (read < 16) return { ok: false, error: `MP4 largesize box header truncated at offset ${offset}.` };
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: `MP4 box size too large at offset ${offset}.` };
        size = Number(large); headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (size < headerSize) return { ok: false, error: `MP4 box size ${size} is smaller than its header at offset ${offset}.` };
      if (offset + size > fileSize) return { ok: false, error: `MP4 box "${type}" at offset ${offset} claims size ${size} but the file ends at ${fileSize} (truncated or corrupt).` };
      boxes.push({ type, offset, size, headerSize });
      if (type === 'ftyp') {
        if (size > 4096) return { ok: false, error: 'MP4 ftyp box is too large for bounded validation.' };
        ftypPayload = Buffer.alloc(size - headerSize);
        fs.readSync(fd, ftypPayload, 0, ftypPayload.length, offset + headerSize);
      }
      if (type === 'moov') {
        if (size - headerSize > MP4_MAX_MOOV_BYTES) return { ok: false, error: 'MP4 moov box is too large for bounded validation (over 16 MB).' };
        moovInfo = { offset, size, headerSize };
      }
      offset += size;
    }
    let moovPayload = null;
    if (moovInfo) {
      moovPayload = Buffer.alloc(moovInfo.size - moovInfo.headerSize);
      if (moovPayload.length > 0) fs.readSync(fd, moovPayload, 0, moovPayload.length, moovInfo.offset + moovInfo.headerSize);
    }
    return validateMp4Boxes(boxes, ftypPayload, moovPayload);
  } catch (e) {
    return { ok: false, error: `MP4 file could not be read: ${e.message}` };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * P2 hash verification (Assignment 1.4): compute SHA-256 by reading the
 * file in 64 KB chunks. Memory use is bounded by chunk size, not by file
 * size, so a large MP4 can be hashed without loading it into RAM. Reading
 * the whole file also proves it is actually readable, unlike stat alone.
 * Returns { sha256, size } where size is the number of bytes actually read.
 * Throws on read errors (permission, missing, truncated during read).
 */
function computeFileHashSync(targetPath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(targetPath, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    let read;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, total)) > 0) {
      hash.update(chunk.subarray(0, read));
      total += read;
    }
    return { sha256: hash.digest('hex'), size: total };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
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
  // P0 path security: read through the verified path, so a symlink inside
  // the workspace pointing outside cannot be read through this function.
  const { baseDir, targetPath } = getVerifiedArtifactPath(workspaceDir, relativePath);
  const stats = fs.statSync(targetPath);

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
  verifyRealPathInside,
  getVerifiedArtifactPath,
  validateMp4Buffer,
  validateMp4File,
  computeFileHashSync,
};
