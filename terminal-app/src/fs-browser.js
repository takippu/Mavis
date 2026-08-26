'use strict';

// Root-confined file browser for the Files view. Every list/read/write resolves its
// target UNDER an absolute `root` (the active session's cwd, or the brain root) and
// rejects anything that escapes it — `../` traversal, absolute paths, and symlinks that
// point outside. This is the load-bearing security guard (unit-tested); it is NOT a brain
// writer (separate concern from mavis-config-writer.js) and `root` is never the whole
// filesystem. Runs in the Electron main process. Pure Node fs/path, no deps.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// heavy/noise dirs skipped by listDir unless the caller overrides opts.ignore. Dotfiles
// are otherwise shown; this denylist is names-only (matched against each entry basename).
const IGNORE = new Set(['.git', 'node_modules', 'dist', '.next', 'build', 'coverage', '.superpowers']);

const DEFAULT_LIST_LIMIT = 2000;          // listDir entry cap → truncated=true past this
const MAX_READ_BYTES = 2 * 1024 * 1024;   // ~2 MB read cap → { tooLarge:true }
const SNIFF_BYTES = 8 * 1024;             // NUL-byte binary sniff window (first 8 KB)
const DEFAULT_SEARCH_LIMIT = 200;         // result cap; caller gets truncated=true past this
const MAX_SEARCH_FILES = 10000;           // traversal ceiling so a broad root stays bounded

// ---------- path confinement ----------

// case-fold the comparison on win32 (NTFS is case-insensitive; realpath may re-case the
// drive letter / components), byte-exact elsewhere.
function withinRoot(base, target) {
  const b = process.platform === 'win32' ? base.toLowerCase() : base;
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// realpath the deepest EXISTING ancestor of p (p itself when it exists). The non-existing
// tail can't be a symlink, so resolving the deepest real ancestor is enough to catch a
// symlink escape while still allowing a not-yet-created write target.
function realDeepestAncestor(p) {
  let cur = p;
  for (;;) {
    try {
      return fs.realpathSync(cur);
    } catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) throw e; // walked to the fs root and nothing existed
      cur = parent;
    }
  }
}

// Resolve `rel` under `root` and return the absolute path IFF it stays inside root, else
// throw. Rejects absolute `rel`, `../` escapes (lexical), AND symlink escapes (realpath the
// deepest existing ancestor and re-check). `rel` defaults to '.' (the root itself).
function safeResolve(root, rel) {
  const base = path.resolve(String(root == null ? '' : root));
  const r = String(rel == null || rel === '' ? '.' : rel);
  if (path.isAbsolute(r)) throw new Error('EPATH: absolute path rejected: ' + r);
  const target = path.resolve(base, r);
  if (!withinRoot(base, target)) throw new Error('EPATH: path escapes root: ' + r);
  // symlink guard: the lexical target is inside root, but a symlink on the way could point
  // out. Re-check via realpath of the deepest existing ancestor against realpath(root).
  const realBase = fs.realpathSync(base);
  const realTarget = realDeepestAncestor(target);
  if (!withinRoot(realBase, realTarget)) throw new Error('EPATH: path escapes root via symlink: ' + r);
  return target;
}

// Resolve a user-submitted browser root. Unlike safeResolve(), this accepts an absolute
// path, but only when the directory already exists and its real path remains beneath the
// configured Projects ceiling. Returning the real path also prevents an approved symlink
// from being retargeted after approval.
function resolveBrowsableRoot(ceiling, requested) {
  const raw = String(requested == null ? '' : requested).trim();
  const unquoted = ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ? raw.slice(1, -1).trim()
    : raw;
  if (!unquoted) throw new Error('EPATH: enter a directory path');
  const realCeiling = fs.realpathSync(path.resolve(String(ceiling == null ? '' : ceiling)));
  const candidate = path.resolve(unquoted);
  const realCandidate = fs.realpathSync(candidate);
  if (!withinRoot(realCeiling, realCandidate)) throw new Error('EPATH: directory is outside the configured Projects folder');
  const st = fs.statSync(realCandidate);
  if (!st.isDirectory()) throw new Error('ENOTDIR: path is not a directory');
  return realCandidate;
}

// ---------- list ----------

// listDir(root, rel) → { path, entries:[{name,type,size}], truncated }.
// dirs-first then files, both alpha (locale, case-insensitive); applies the ignore denylist;
// caps at opts.limit (default 2000) → truncated=true. Entries that vanish/error mid-scan are
// skipped so a churning dir never throws.
async function listDir(root, rel = '.', opts = {}) {
  const dir = safeResolve(root, rel);
  const limit = opts.limit || DEFAULT_LIST_LIMIT;
  const ignore = opts.ignore || IGNORE;
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (ignore.has(d.name)) continue;
    let st;
    try { st = await fsp.stat(path.join(dir, d.name)); }
    catch { continue; } // dangling symlink / removed mid-scan → skip
    entries.push({ name: d.name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
  });
  const truncated = entries.length > limit;
  return { path: rel, entries: truncated ? entries.slice(0, limit) : entries, truncated };
}

// ---------- read ----------

// readFile(root, rel) → { text, binary, tooLarge, size }. Over the ~2 MB cap → tooLarge (no
// read of the body). NUL byte in the first 8 KB → binary (no text). Never streams a huge or
// binary file into the renderer.
async function readFile(root, rel) {
  const target = safeResolve(root, rel);
  const st = await fsp.stat(target);
  if (!st.isFile()) throw new Error('ENOTFILE: not a regular file: ' + rel);
  const size = st.size;
  if (size > MAX_READ_BYTES) return { text: '', binary: false, tooLarge: true, size };
  const buf = await fsp.readFile(target);
  const sniff = buf.length > SNIFF_BYTES ? buf.subarray(0, SNIFF_BYTES) : buf;
  if (sniff.includes(0)) return { text: '', binary: true, tooLarge: false, size };
  return { text: buf.toString('utf8'), binary: false, tooLarge: false, size };
}

// ---------- search ----------

// searchFiles(root, query, { mode:'files'|'content', limit }) searches the whole confined
// root, not only folders already expanded in the renderer. File mode matches relative paths;
// content mode returns one result per matching line. The same heavy-directory denylist and
// 2 MB/binary guards as list/read apply. No external `rg` dependency: packaged builds behave
// identically on machines that do not have developer tools installed.
async function searchFiles(root, query, opts = {}) {
  const needle = String(query == null ? '' : query).trim().toLocaleLowerCase();
  const mode = opts.mode === 'content' ? 'content' : 'files';
  const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT));
  if (!needle) return { results: [], truncated: false, scanned: 0 };

  const base = safeResolve(root, '.');
  const stack = [{ abs: base, rel: '.' }];
  const results = [];
  let scanned = 0;
  let truncated = false;

  while (stack.length && scanned < MAX_SEARCH_FILES) {
    const current = stack.pop();
    let dirents;
    try { dirents = await fsp.readdir(current.abs, { withFileTypes: true }); }
    catch { continue; }
    // Reverse alpha because this is a LIFO stack; results still walk alpha top-down.
    dirents.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: 'accent' }));
    for (const d of dirents) {
      if (IGNORE.has(d.name)) continue;
      // Never descend through a symlink/junction. safeResolve rejects links that leave the root,
      // but an in-root link back to an ancestor is still a recursive cycle.
      if (d.isSymbolicLink()) continue;
      const rel = current.rel === '.' ? d.name : current.rel + '/' + d.name;
      let abs;
      try { abs = safeResolve(root, rel); }
      catch { continue; } // dangling/out-of-root symlink or a churning path
      let st;
      try { st = await fsp.stat(abs); }
      catch { continue; }
      if (st.isDirectory()) { stack.push({ abs, rel }); continue; }
      if (!st.isFile()) continue;
      scanned++;

      if (mode === 'files') {
        if (rel.toLocaleLowerCase().includes(needle)) {
          const baseLower = d.name.toLocaleLowerCase();
          const score = baseLower === needle ? 0 : baseLower.startsWith(needle) ? 1 : baseLower.includes(needle) ? 2 : 3;
          results.push({ rel, name: d.name, score });
        }
        continue;
      }

      if (st.size > MAX_READ_BYTES) continue;
      let buf;
      try { buf = await fsp.readFile(abs); }
      catch { continue; }
      const sniff = buf.length > SNIFF_BYTES ? buf.subarray(0, SNIFF_BYTES) : buf;
      if (sniff.includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const at = lines[i].toLocaleLowerCase().indexOf(needle);
        if (at < 0) continue;
        const start = Math.max(0, at - 120);
        const end = Math.min(lines[i].length, start + 360);
        const preview = (start ? '…' : '') + lines[i].slice(start, end) + (end < lines[i].length ? '…' : '');
        results.push({ rel, name: d.name, line: i + 1, column: at + 1, text: preview });
        if (results.length > limit) { truncated = true; break; }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  if (stack.length || scanned >= MAX_SEARCH_FILES) truncated = true;
  if (mode === 'files') {
    results.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel, undefined, { sensitivity: 'accent' }));
    if (results.length > limit) truncated = true;
    return { results: results.slice(0, limit).map(({ score, ...r }) => r), truncated, scanned };
  }
  return { results: results.slice(0, limit), truncated, scanned };
}

// ---------- write ----------

// writeFile(root, rel, text) → { ok, size } | throws. Atomic (write `<target>.tmp` then
// rename). Confined to root, and (v1) the target must be an EXISTING regular file OR sit
// inside an EXISTING directory — no implicit new trees. safeResolve already refuses a
// symlink that escapes root.
async function writeFile(root, rel, text) {
  const target = safeResolve(root, rel);
  let exists = false;
  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) throw new Error('EISDIR: target is not a regular file: ' + rel);
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // a real stat error (incl. the EISDIR above) propagates
  }
  if (!exists) {
    // no creating new trees: the parent dir must already exist and be a directory.
    const pst = await fsp.stat(path.dirname(target)); // ENOENT here → refuses the write
    if (!pst.isDirectory()) throw new Error('ENOTDIR: parent is not a directory: ' + rel);
  }
  const data = String(text == null ? '' : text);
  const tmp = target + '.tmp';
  // safeResolve vetted `target` but NOT this `.tmp` sibling. A symlink pre-placed at `<target>.tmp`
  // would be FOLLOWED by the write and land it outside root (on Windows even 'wx'/O_EXCL creates
  // straight through a dangling symlink). unlink never follows a link — it removes the link itself
  // (and clears any stale crash leftover), so the subsequent write always creates a fresh real file
  // confined to root.
  try { await fsp.unlink(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fsp.writeFile(tmp, data, 'utf8');
  try {
    await fsp.rename(tmp, target);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* best-effort tmp cleanup */ }
    throw e;
  }
  return { ok: true, size: Buffer.byteLength(data, 'utf8') };
}

module.exports = {
  safeResolve,
  resolveBrowsableRoot,
  listDir,
  readFile,
  searchFiles,
  writeFile,
  IGNORE,
  MAX_READ_BYTES,
  SNIFF_BYTES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_FILES,
};
