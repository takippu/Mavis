'use strict';

// Pure parsers for git plumbing output. NO I/O, NO child_process, NO DOM — everything
// here is text-in/data-out so it can be unit-tested directly (the same reasoning as
// tui-detect.js and tile-layout.js: the fiddly logic lives where tests can reach it).

// `git status --porcelain=v1 -z` emits NUL-terminated records. Split, dropping the
// trailing empty produced by the final NUL.
function splitZ(text) {
  if (text == null) return [];
  const parts = String(text).split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// The seven porcelain-v1 UNMERGED codes. 'U' in either column always means unmerged;
// 'AA' and 'DD' are unmerged too even though neither column carries a 'U'.
function isUnmergedPair(x, y) {
  if (x === 'U' || y === 'U') return true;
  return (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
}

// Record format: XY <path>, where X = index (staged) state, Y = worktree state.
// '??' = untracked. R/C records are followed by a SEPARATE NUL field holding the
// ORIGINAL path — it must be consumed, or every subsequent entry shifts by one.
//
// X and Y are INDEPENDENT states, so the entry carries both raw columns: 'AD' is an
// addition in the index AND a deletion in the worktree, and the row's letter must be the
// one for the side it is listed on. Collapsing them into a single `status` put the INDEX
// letter on the WORKTREE row (a green 'A' on a file deleted from disk).
function parsePorcelain(text) {
  const parts = splitZ(text);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;      // 'XY p' is the shortest legal record
    const x = rec[0], y = rec[1];
    const rel = rec.slice(3);                  // skip 'XY '
    if (x === '?' && y === '?') {
      out.push({ rel, status: 'U', oldPath: null, staged: false, unstaged: true, unmerged: false, x, y });
      continue;
    }
    let oldPath = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') { oldPath = parts[++i] != null ? parts[i] : null; }
    // An unmerged path is NOT a staged change: 'U' is not an index state you can unstage.
    // Reporting staged:true for it gave the row a ticked "Unstage" box whose one click ran
    // `git restore --staged`, collapsing the conflict to HEAD and removing git's own
    // "Committing is not possible because you have unmerged files" guard while the markers
    // were still in the worktree. It lists as a worktree change; the renderer draws it inert.
    const unmerged = isUnmergedPair(x, y);
    const staged = !unmerged && x !== ' ' && x !== '?';
    const unstaged = unmerged || (y !== ' ' && y !== '?');
    // Kept for callers that want ONE letter: the index state when staged, else the worktree
    // state. Per-side rows must read `x`/`y` through statusFor() instead.
    const status = normStatus(staged ? x : y);
    out.push({ rel, status, oldPath, staged, unstaged, unmerged, x, y });
  }
  return out;
}

function normStatus(ch) {
  if (ch === 'M' || ch === 'A' || ch === 'D' || ch === 'R' || ch === 'C') return ch;
  return 'M';
}

// The letter for ONE side of a record. Untracked keeps its 'U' sentinel on both sides
// (it only ever lists as a worktree change anyway).
function statusFor(e, staged) {
  if (e.status === 'U') return 'U';
  return normStatus(staged ? e.x : e.y);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Unified diff text -> hunks of ALIGNED rows. The alignment (pairing a run of
// deletions against the following run of additions, gap-padding the shorter side)
// is the whole reason this is a separate pure module: the renderer just walks rows.
function parseUnifiedDiff(text) {
  const out = { binary: false, oldPath: null, newPath: null, added: 0, removed: 0, hunks: [] };
  if (text == null || text === '') return out;
  const lines = String(text).split('\n');

  let i = 0;
  let sawHunk = false;
  let hunk = null;
  let oldNum = 0, newNum = 0;
  let delBuf = [], addBuf = [];

  const flush = () => {
    if (!delBuf.length && !addBuf.length) return;
    const n = Math.max(delBuf.length, addBuf.length);
    for (let k = 0; k < n; k++) {
      const d = k < delBuf.length ? delBuf[k] : null;
      const a = k < addBuf.length ? addBuf[k] : null;
      hunk.rows.push({
        type: d ? 'del' : 'add',
        oldNum: d ? d.num : null,
        newNum: a ? a.num : null,
        oldText: d ? d.text : null,
        newText: a ? a.text : null,
      });
    }
    delBuf = []; addBuf = [];
  };

  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === '' && i === lines.length - 1) break;      // trailing newline artifact

    if (!sawHunk) {
      // Header zone: only here do '---'/'+++' mean paths.
      if (/^Binary files .* differ$/.test(ln) || /^GIT binary patch$/.test(ln)) { out.binary = true; return out; }
      if (ln.startsWith('rename from ')) { out.oldPath = ln.slice(12); continue; }
      if (ln.startsWith('rename to ')) { out.newPath = ln.slice(10); continue; }
      if (ln.startsWith('--- ')) { out.oldPath = stripPath(ln.slice(4)); continue; }
      if (ln.startsWith('+++ ')) { out.newPath = stripPath(ln.slice(4)); continue; }
    }

    const m = HUNK_RE.exec(ln);
    if (m) {
      flush();
      sawHunk = true;
      oldNum = parseInt(m[1], 10);
      newNum = parseInt(m[3], 10);
      hunk = { header: ln, rows: [] };
      out.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;                                  // pre-hunk noise (index/mode lines)

    const tag = ln[0];
    const body = ln.slice(1);
    if (ln.startsWith('\\')) continue;                    // '\ No newline at end of file'
    if (tag === '+') { addBuf.push({ num: newNum++, text: body }); out.added++; continue; }
    if (tag === '-') { delBuf.push({ num: oldNum++, text: body }); out.removed++; continue; }
    if (tag === ' ' || ln === '') {
      flush();
      hunk.rows.push({ type: 'ctx', oldNum: oldNum++, newNum: newNum++, oldText: body, newText: body });
      continue;
    }
    // anything else (a new 'diff --git' for the next file) ends this file's diff
    break;
  }
  flush();
  return out;
}

// 'a/src/f.js' -> 'src/f.js'; '/dev/null' -> null. Tabs may terminate the path.
function stripPath(p) {
  let s = String(p == null ? '' : p);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2);
  return s;
}

module.exports = { splitZ, parsePorcelain, parseUnifiedDiff, statusFor, isUnmergedPair };
