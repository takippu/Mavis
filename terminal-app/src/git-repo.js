'use strict';

// The ONLY place git is invoked. Everything here is execFile with an ARRAY of args —
// never a shell string — so nothing user-supplied can become a shell metacharacter.
//
// THE TRUST BOUNDARY (see docs/superpowers/specs/2026-07-17-git-changes-view-design.md):
// the renderer NEVER names a repo. It sends the active session's cwd; main validates that
// against trustedFilesRoot()'s allowlist, and then WE derive the repo root via
// `git rev-parse --show-toplevel`. The repo path is main's own computation.
//
// Git args can themselves be attacks: a path or branch beginning with '-' can be read as
// an option, and --upload-pack= / --exec-path= reach code execution. Hence: every path is
// validated by safeRel() and placed after a '--' separator; every branch is validated
// against the REAL ref list rather than passed through.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parsePorcelain, parseUnifiedDiff, statusFor } = require('./git-diff');

const MAX_BUFFER = 24 * 1024 * 1024;   // a big diff shouldn't kill the call
const TIMEOUT_MS = 20000;
const MAX_DIFF_ROWS = 4000;            // beyond this the renderer janks; truncate LOUDLY
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;  // same cap fs-browser uses
const MAX_MESSAGE = 20000;

// ---- pure helpers (exported for tests) ----

// case-fold the comparison on win32 (NTFS is case-insensitive; realpath may re-case the
// drive letter / components), byte-exact elsewhere. Mirrors fs-browser.withinRoot.
function withinRoot(base, target) {
  const b = process.platform === 'win32' ? base.toLowerCase() : base;
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// realpath the deepest EXISTING ancestor of p (p itself when it exists). The non-existing
// tail can't be a symlink, so the deepest real ancestor is enough to catch an escape.
// Mirrors fs-browser.realDeepestAncestor.
function realDeepestAncestor(p) {
  let cur = p;
  for (;;) {
    try { return fs.realpathSync(cur); }
    catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) throw e;      // walked to the fs root and nothing existed
      cur = parent;
    }
  }
}

// A renderer-supplied path is only usable if it stays inside the repo AND can't be read
// as an option. Returns a '/'-joined repo-relative path, or null.
function safeRel(root, rel) {
  if (rel == null || rel === '') return null;
  const s = String(rel);
  if (s.startsWith('-')) return null;                 // would parse as a git option
  if (s.includes('\0')) return null;
  if (path.isAbsolute(s)) return null;
  const abs = path.resolve(root, s);
  const rootAbs = path.resolve(root);
  const inside = abs === rootAbs || abs.startsWith(rootAbs + path.sep);
  if (!inside) return null;
  const out = path.relative(rootAbs, abs).split(path.sep).join('/');
  // Re-check the NORMALIZED result, not just the input: './--upload-pack=evil' clears the
  // raw check above, but path.relative strips the './' and hands back '--upload-pack=evil'.
  // The '--' separator is the primary guard; this keeps the returned string honest anyway.
  if (out.startsWith('-')) return null;
  // SYMLINK GUARD — the lexical check above proves nothing on its own. A symlink (or a
  // Windows directory junction, which `mklink /J` plants with no admin rights) inside the
  // worktree passes it while pointing outside, and `git status --untracked-files=all`
  // descends a junction, so the rail LISTS the out-of-repo file. Both consumers then follow
  // the link: untrackedDiff's readFileSync leaks its contents into the diff pane, and
  // discard's unlinkSync deletes the real target. Same posture as fs-browser.safeResolve:
  // realpath the deepest existing ancestor of both and re-check containment.
  let realBase, realTarget;
  try { realBase = realDeepestAncestor(rootAbs); realTarget = realDeepestAncestor(abs); }
  catch { return null; }
  if (!withinRoot(realBase, realTarget)) return null;
  return out;
}

function _buildStatusArgs() { return ['status', '--porcelain=v1', '-z', '--untracked-files=all']; }
// `oldRel` is the rename SOURCE. Git runs rename detection AFTER pathspec filtering, so a
// single-path pathspec drops the old path's deletion, the pair can never form, and a rename
// renders as a brand-new file (+N -0) — a one-line edit reads as a whole-file creation in
// the pre-commit review pane. Both paths on the pathspec is what lets git pair them.
function _buildDiffArgs(rel, staged, oldRel) {
  const a = ['diff', '--no-color', '-U3'];
  if (staged) a.push('--cached');
  a.push('--', rel);
  if (oldRel && oldRel !== rel) a.push(oldRel);
  return a;
}
// An unmerged path makes plain `git diff` emit a COMBINED diff (`diff --cc`, `@@@` hunks) —
// not unified text at all, so the parser reads zero hunks and the pane would claim "No
// textual changes." about a file that visibly holds conflict markers. Diffing against HEAD
// gives ordinary unified text: the worktree (markers and all) vs the committed version.
// 'HEAD' is a literal here, never renderer input.
function _buildConflictDiffArgs(rel) { return ['diff', '--no-color', '-U3', 'HEAD', '--', rel]; }
function _buildStageArgs(rels) { return ['add', '--'].concat(rels); }
function _buildUnstageArgs(rels) { return ['restore', '--staged', '--'].concat(rels); }
// Before the first commit there is no HEAD for `restore --staged` to resolve, so unstaging
// is `rm --cached` — which is also the semantically right end state (no HEAD version exists
// to restore to; the file becomes untracked).
function _buildUnstageNoHeadArgs(rels) { return ['rm', '--cached', '--quiet', '--'].concat(rels); }
function _buildDiscardArgs(rels) { return ['restore', '--'].concat(rels); }
// A STAGED DELETION is gone from the index but still in HEAD, so `restore --` (which
// restores the worktree FROM the index) has nothing to copy. Discarding it means putting
// both the index entry and the worktree file back — that is HEAD -> --staged --worktree.
function _buildRestoreFromHeadArgs(rels) { return ['restore', '--staged', '--worktree', '--'].concat(rels); }

// Membership in the ref list does NOT imply the string is not an option: `git update-ref
// refs/heads/--force HEAD` creates a REAL ref named '--force', for-each-ref lists it, and
// `git checkout --force` then silently discards every uncommitted change and exits 0.
// '--end-of-options' (git >= 2.24) makes git read the next arg as a ref, so the branch both
// validates AND checks out correctly.
function _buildCheckoutArgs(branch) { return ['checkout', '--end-of-options', branch]; }

// NEVER a bare `git push`. It delegates ref selection to the user's push.default: under
// `matching` (the pre-2.0 default, still alive in long-lived configs) it pushes EVERY
// matching branch, and under `current` it pushes to a same-named remote branch — while the
// confirm dialog named exactly one target. Name the remote and the refspec explicitly so
// the command matches the text the user approved.
function _buildPushArgs(branch, upstream) {
  const u = _splitUpstream(upstream);
  if (!u) return ['push', '-u', '--end-of-options', 'origin', branch];
  // <local>:<remote-ref>, not a bare branch name: a local `trunk` tracking `origin/main`
  // must push to origin/main — the ref the confirm printed — not create origin/trunk.
  return ['push', '--end-of-options', u.remote, branch + ':' + u.ref];
}

// 'origin/main' -> { remote:'origin', ref:'main' }; 'origin/feature/x' -> ref 'feature/x'.
// Split on the FIRST '/': git forbids a slash in a remote name, so this is unambiguous.
function _splitUpstream(upstream) {
  const s = String(upstream == null ? '' : upstream);
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return null;
  return { remote: s.slice(0, i), ref: s.slice(i + 1) };
}

function _validateBranch(name, list) {
  if (name == null || name === '') return null;
  const s = String(name);
  if (!Array.isArray(list) || list.indexOf(s) === -1) return null;   // must be a REAL ref
  return s;
}

// ---- the runner ----

function run(root, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: root,
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      encoding: o.encoding || 'utf8',
      // Keep git non-interactive: no credential/editor prompt can hang the app.
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }),
    }, (err, stdout, stderr) => {
      if (err) resolve({ error: cleanErr(stderr, err), code: err.code });
      else resolve({ out: stdout });
    });
  });
}

// Surface git's OWN message — never an invented interpretation of it.
function cleanErr(stderr, err) {
  const s = String(stderr || '').trim();
  if (s) return s;
  if (err && err.killed) return 'git timed out';
  return (err && err.message) ? err.message : 'git failed';
}

// ---- API ----

async function resolveRepo(cwd) {
  const top = await run(cwd, ['rev-parse', '--show-toplevel']);
  if (top.error) return { error: 'Not a git repository' };
  const root = String(top.out).trim();
  if (!root) return { error: 'Not a git repository' };

  const br = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let branch = br.error ? null : String(br.out).trim();
  let detached = false;
  if (branch === 'HEAD') {                     // detached: show the short sha instead
    detached = true;
    const sha = await run(root, ['rev-parse', '--short', 'HEAD']);
    branch = sha.error ? 'HEAD' : String(sha.out).trim();
  }
  if (!branch) branch = null;                  // no commits yet

  // NOTE: `ahead` is measured against the LAST-FETCHED upstream ref. v1 has no fetch,
  // so it means "local commits since the last fetch", NOT "commits the remote lacks".
  // The UI copy must say exactly that (spec §Risks).
  let ahead = 0, upstream = null;
  const up = await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.error) {
    upstream = String(up.out).trim();
    const cnt = await run(root, ['rev-list', '--count', '@{u}..HEAD']);
    if (!cnt.error) ahead = parseInt(String(cnt.out).trim(), 10) || 0;
  }
  return { root, branch, detached, ahead, upstream };
}

async function status(root) {
  const r = await run(root, _buildStatusArgs());
  if (r.error) return { error: r.error };
  const entries = parsePorcelain(r.out);
  const staged = [], unstaged = [];
  for (const e of entries) {
    // A file can be in BOTH lists (porcelain 'MM'); each row diffs its own side — and
    // must carry its OWN side's letter, which is why decorate() takes the side.
    if (e.staged) staged.push(decorate(e, true));
    if (e.unstaged) unstaged.push(decorate(e, false));
  }
  return { staged, unstaged };
}

function decorate(e, staged) {
  const i = e.rel.lastIndexOf('/');
  return {
    rel: e.rel,
    name: i >= 0 ? e.rel.slice(i + 1) : e.rel,
    dir: i >= 0 ? e.rel.slice(0, i + 1) : '',
    status: statusFor(e, staged),
    oldPath: e.oldPath,
    untracked: e.status === 'U',
    unmerged: !!e.unmerged,
  };
}

// Is this path GENUINELY untracked — i.e. git has no history for it at all?
// `ls-files --others` asks exactly that. The older `ls-files --error-unmatch` probe asked
// "is it in the index?", which is a DIFFERENT question: a staged deletion has already left
// the index while HEAD still holds the file, so it was misclassified as untracked and fell
// into the fs read/unlink path (ENOENT -> "Could not read this file" / a no-op Discard).
async function isUntracked(root, safe) {
  const r = await run(root, ['ls-files', '--others', '--exclude-standard', '--error-unmatch', '--', safe]);
  return !r.error;
}

// The rename SOURCE for `safe` on the given side, or null. Derived main-side from porcelain
// status — this is main's own computation, never renderer input — and still put through
// safeRel() before it can reach a git arg list.
async function renameSource(root, safe, staged) {
  const r = await run(root, _buildStatusArgs());
  if (r.error) return null;
  for (const e of parsePorcelain(r.out)) {
    if (e.rel !== safe || !e.oldPath) continue;
    if (staged ? e.staged : e.unstaged) return safeRel(root, e.oldPath);
  }
  return null;
}

async function diffFile(root, rel, staged) {
  const safe = safeRel(root, rel);
  if (!safe) return { error: 'Invalid path' };

  // Untracked files have no git diff — git doesn't track them. Synthesize an
  // all-additions diff, through the same guards fs-browser uses so a huge stray
  // artifact can't be slurped into the renderer.
  if (await isUntracked(root, safe)) return untrackedDiff(root, safe);

  const r = await run(root, _buildDiffArgs(safe, !!staged));
  if (r.error) return { error: r.error };

  // Combined output means an unmerged path. Re-run against HEAD for parseable text rather
  // than reporting the empty parse as "no changes". Detected from the output, so an
  // ordinary diff pays no extra probe.
  if (/^diff --(?:cc|combined) /m.test(String(r.out))) {
    const rc = await run(root, _buildConflictDiffArgs(safe));
    if (!rc.error) return finish(parseUnifiedDiff(rc.out));
  }

  const d = parseUnifiedDiff(r.out);

  // A rename always parses as a NEW file here (no old side), because the single-path
  // pathspec hid the deletion of the source. We only learn that after parsing, so re-run
  // with the pair when a rename source exists. The common modified-file case pays nothing.
  if (!d.binary && d.oldPath === null && d.newPath) {
    const oldRel = await renameSource(root, safe, !!staged);
    if (oldRel) {
      const r2 = await run(root, _buildDiffArgs(safe, !!staged, oldRel));
      if (!r2.error) return finish(parseUnifiedDiff(r2.out));
    }
  }
  return finish(d);
}

async function untrackedDiff(root, safe) {
  const abs = path.join(root, safe);
  let st;
  try { st = fs.statSync(abs); } catch { return { error: 'Could not read this file' }; }
  if (!st.isFile()) return { error: 'Not a regular file' };
  if (st.size > MAX_UNTRACKED_BYTES) return { binary: false, tooLarge: true, size: st.size, hunks: [], added: 0, removed: 0, oldPath: null, newPath: safe };
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return { error: 'Could not read this file' }; }
  if (buf.includes(0)) return { binary: true, hunks: [], added: 0, removed: 0, oldPath: null, newPath: safe };
  const lines = buf.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((text, k) => ({ type: 'add', oldNum: null, newNum: k + 1, oldText: null, newText: text }));
  return finish({
    binary: false, oldPath: null, newPath: safe, added: rows.length, removed: 0,
    hunks: rows.length ? [{ header: '@@ -0,0 +1,' + rows.length + ' @@', rows }] : [],
  });
}

// Cap the rendered rows — 5000 rows x 2 cells janks the DOM. Truncate LOUDLY:
// the renderer shows "N more rows" rather than silently cutting (no silent caps).
function finish(d) {
  let n = 0, truncated = false;
  const hunks = [];
  for (const h of d.hunks) {
    if (n >= MAX_DIFF_ROWS) { truncated = true; break; }
    const room = MAX_DIFF_ROWS - n;
    if (h.rows.length > room) { hunks.push({ header: h.header, rows: h.rows.slice(0, room) }); truncated = true; n = MAX_DIFF_ROWS; break; }
    hunks.push(h); n += h.rows.length;
  }
  return Object.assign({}, d, { hunks, truncated });
}

function mapRels(root, rels) {
  if (!Array.isArray(rels) || !rels.length) return null;
  const out = [];
  for (const r of rels) { const s = safeRel(root, r); if (!s) return null; out.push(s); }
  return out;
}

async function stage(root, rels) {
  const safe = mapRels(root, rels); if (!safe) return { error: 'Invalid path' };
  const r = await run(root, _buildStageArgs(safe));
  return r.error ? { error: r.error } : { ok: true };
}
async function unstage(root, rels) {
  const safe = mapRels(root, rels); if (!safe) return { error: 'Invalid path' };
  // `git restore --staged` resolves HEAD as its source, which does not exist before the
  // first commit — it dies with "fatal: could not resolve HEAD" and the checkbox becomes a
  // dead control in a fresh `git init` repo. Fall back only when HEAD really is unborn:
  // `rm --cached` in a repo WITH commits would untrack the file rather than unstage it.
  const head = await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const r = await run(root, head.error ? _buildUnstageNoHeadArgs(safe) : _buildUnstageArgs(safe));
  return r.error ? { error: r.error } : { ok: true };
}

// Whole-file only (spec non-goal: no hunk-level discard). Three states, not two: `git
// restore` won't touch an untracked file (those are unlinked — behind the SAME confirm,
// which the renderer owns), and a staged deletion is in NEITHER the index nor the untracked
// set, so it needs HEAD as the restore source.
async function discard(root, rels) {
  const safe = mapRels(root, rels); if (!safe) return { error: 'Invalid path' };
  const untracked = [], fromIndex = [], fromHead = [];
  for (const s of safe) {
    if (await isUntracked(root, s)) { untracked.push(s); continue; }
    const inIndex = await run(root, ['ls-files', '--error-unmatch', '--', s]);
    if (!inIndex.error) fromIndex.push(s);
    else fromHead.push(s);          // staged deletion: gone from the index, still in HEAD
  }
  if (fromIndex.length) {
    const r = await run(root, _buildDiscardArgs(fromIndex));
    if (r.error) return { error: r.error };
  }
  if (fromHead.length) {
    const r = await run(root, _buildRestoreFromHeadArgs(fromHead));
    if (r.error) return { error: r.error };
  }
  for (const u of untracked) {
    try { fs.unlinkSync(path.join(root, u)); } catch (e) { return { error: 'Could not delete ' + u }; }
  }
  return { ok: true };
}

async function commit(root, message) {
  const msg = String(message == null ? '' : message).trim();
  if (!msg) return { error: 'Commit message is empty' };
  if (msg.length > MAX_MESSAGE) return { error: 'Commit message is too long' };
  // execFile passes args as an array — no shell, so the message needs no escaping.
  const r = await run(root, ['commit', '-m', msg]);
  if (r.error) return { error: r.error };
  const sha = await run(root, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, sha: sha.error ? null : String(sha.out).trim() };
}

async function push(root) {
  const info = await resolveRepo(root);
  if (info.error) return { error: info.error };
  if (info.detached) return { error: 'Detached HEAD — nothing to push to' };
  if (!info.branch) return { error: 'No commits yet' };
  const r = await run(root, _buildPushArgs(info.branch, info.upstream));
  if (r.error) return { error: r.error };   // non-fast-forward etc. surfaces git's own text
  return { ok: true, output: String(r.out || '').trim() };
}

async function branches(root) {
  const r = await run(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (r.error) return { error: r.error };
  const list = String(r.out).split('\n').map((s) => s.trim()).filter(Boolean);
  const info = await resolveRepo(root);
  return { current: info.error ? null : info.branch, list };
}

async function checkout(root, name) {
  const b = await branches(root);
  if (b.error) return { error: b.error };
  const safe = _validateBranch(name, b.list);
  if (!safe) return { error: 'Unknown branch' };
  const r = await run(root, _buildCheckoutArgs(safe));
  // On refusal, git's OWN stderr goes back untouched. No auto-stash, no retry,
  // no interpretation (spec §Decisions).
  return r.error ? { error: r.error } : { ok: true };
}

module.exports = {
  resolveRepo, status, diffFile, stage, unstage, discard, commit, push, branches, checkout,
  safeRel, MAX_DIFF_ROWS,
  _buildStatusArgs, _buildDiffArgs, _buildConflictDiffArgs, _buildStageArgs, _buildUnstageArgs, _buildUnstageNoHeadArgs,
  _buildDiscardArgs, _buildRestoreFromHeadArgs, _buildCheckoutArgs, _buildPushArgs, _splitUpstream,
  _validateBranch,
};
