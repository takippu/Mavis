'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parsePorcelain, statusFor } = require('../src/git-diff');

test('parsePorcelain: modified + added + deleted', () => {
  const buf = 'M  src/main.js\0A  src/new.js\0 D src/gone.js\0';
  assert.deepStrictEqual(parsePorcelain(buf), [
    { rel: 'src/main.js', status: 'M', oldPath: null, staged: true, unstaged: false, unmerged: false, x: 'M', y: ' ' },
    { rel: 'src/new.js', status: 'A', oldPath: null, staged: true, unstaged: false, unmerged: false, x: 'A', y: ' ' },
    { rel: 'src/gone.js', status: 'D', oldPath: null, staged: false, unstaged: true, unmerged: false, x: ' ', y: 'D' },
  ]);
});

test('parsePorcelain: untracked', () => {
  const buf = '?? src/brand-new.js\0';
  assert.deepStrictEqual(parsePorcelain(buf), [
    { rel: 'src/brand-new.js', status: 'U', oldPath: null, staged: false, unstaged: true, unmerged: false, x: '?', y: '?' },
  ]);
});

// THE off-by-one: a rename's old path is its OWN NUL-terminated field, and the
// entry AFTER it must not be shallowed by the parser.
test('parsePorcelain: rename consumes the old-path field without eating the next entry', () => {
  const buf = 'R  src/new-name.js\0src/old-name.js\0M  src/after.js\0';
  assert.deepStrictEqual(parsePorcelain(buf), [
    { rel: 'src/new-name.js', status: 'R', oldPath: 'src/old-name.js', staged: true, unstaged: false, unmerged: false, x: 'R', y: ' ' },
    { rel: 'src/after.js', status: 'M', oldPath: null, staged: true, unstaged: false, unmerged: false, x: 'M', y: ' ' },
  ]);
});

test('parsePorcelain: copy record also consumes an old-path field', () => {
  const buf = 'C  src/copy.js\0src/src.js\0M  src/after.js\0';
  const out = parsePorcelain(buf);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].oldPath, 'src/src.js');
  assert.strictEqual(out[1].rel, 'src/after.js');
});

test('parsePorcelain: staged AND unstaged changes to one file (MM)', () => {
  const buf = 'MM src/both.js\0';
  assert.deepStrictEqual(parsePorcelain(buf), [
    { rel: 'src/both.js', status: 'M', oldPath: null, staged: true, unstaged: true, unmerged: false, x: 'M', y: 'M' },
  ]);
});

// 'MM' is the only two-sided record where X === Y, which is exactly why it hides this bug.
// X and Y are INDEPENDENT: a record in both lists needs a per-SIDE letter, or the worktree
// row shows the index's letter — a green 'A' on a file that is gone from the disk.
test('parsePorcelain: a mixed record keeps BOTH columns (AD = added to index, deleted on disk)', () => {
  const [e] = parsePorcelain('AD src/added.js\0');
  assert.strictEqual(e.staged, true);
  assert.strictEqual(e.unstaged, true);
  assert.strictEqual(e.x, 'A');
  assert.strictEqual(e.y, 'D');
});

test('statusFor: each side of a mixed record reports its OWN letter', () => {
  const [ad] = parsePorcelain('AD src/added.js\0');
  assert.strictEqual(statusFor(ad, true), 'A');    // Staged row
  assert.strictEqual(statusFor(ad, false), 'D');   // Changes row — NOT 'A'
  const [md] = parsePorcelain('MD src/mod.js\0');
  assert.strictEqual(statusFor(md, true), 'M');
  assert.strictEqual(statusFor(md, false), 'D');
  const [rm] = parsePorcelain('RM src/new.js\0src/old.js\0');
  assert.strictEqual(statusFor(rm, true), 'R');
  assert.strictEqual(statusFor(rm, false), 'M');
});

test('statusFor: untracked keeps its U sentinel on both sides', () => {
  const [u] = parsePorcelain('?? src/stray.js\0');
  assert.strictEqual(statusFor(u, false), 'U');
  assert.strictEqual(statusFor(u, true), 'U');
});

// An unmerged path is NOT a staged change: reporting staged:true gave it a ticked "Unstage"
// box whose one click ran `git restore --staged`, collapsing the conflict to HEAD and
// dropping git's "you have unmerged files" commit guard with the markers still on disk.
test('parsePorcelain: unmerged records are flagged and never reported as staged', () => {
  for (const code of ['UU', 'AA', 'DD', 'AU', 'UA', 'UD', 'DU']) {
    const [e] = parsePorcelain(code + ' src/c.txt\0');
    assert.strictEqual(e.unmerged, true, code + ' must be unmerged');
    assert.strictEqual(e.staged, false, code + ' must not be staged');
    assert.strictEqual(e.unstaged, true, code + ' must list as a worktree change');
  }
});

test('parsePorcelain: an ordinary A/D record is NOT mistaken for unmerged', () => {
  assert.strictEqual(parsePorcelain('A  src/new.js\0')[0].unmerged, false);
  assert.strictEqual(parsePorcelain('D  src/gone.js\0')[0].unmerged, false);
  assert.strictEqual(parsePorcelain('AD src/x.js\0')[0].unmerged, false);
  assert.strictEqual(parsePorcelain('MM src/y.js\0')[0].unmerged, false);
});

test('parsePorcelain: paths with spaces survive -z (no quoting)', () => {
  const buf = 'M  src/my file.js\0';
  assert.strictEqual(parsePorcelain(buf)[0].rel, 'src/my file.js');
});

test('parsePorcelain: empty input', () => {
  assert.deepStrictEqual(parsePorcelain(''), []);
  assert.deepStrictEqual(parsePorcelain(null), []);
});

const { parseUnifiedDiff } = require('../src/git-diff');

const D = (...lines) => lines.join('\n') + '\n';

test('parseUnifiedDiff: 1 deletion + 3 additions aligns to 3 rows, 2 gapped on the old side', () => {
  const text = D(
    '--- a/src/f.js', '+++ b/src/f.js',
    '@@ -212,3 +212,5 @@',
    ' const host = pane.hostEl;',
    '-  if (!host.offsetParent) return;',
    '+  if (!host.offsetParent) return;',
    '+  if (host.clientWidth < 40) return;',
    '+  if (host.clientHeight < 24) return;',
    ' const cell = measureCell(pane.term);',
  );
  const out = parseUnifiedDiff(text);
  assert.strictEqual(out.hunks.length, 1);
  const rows = out.hunks[0].rows;
  // ctx, then 3 aligned change rows (1 del paired w/ 1 add + 2 add-only), then ctx
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows[0].type, 'ctx');
  assert.strictEqual(rows[1].type, 'del');       // paired: old text AND new text present
  assert.strictEqual(rows[1].oldText, '  if (!host.offsetParent) return;');
  assert.strictEqual(rows[1].newText, '  if (!host.offsetParent) return;');
  assert.strictEqual(rows[2].type, 'add');
  assert.strictEqual(rows[2].oldText, null);     // gap on the old side
  assert.strictEqual(rows[3].type, 'add');
  assert.strictEqual(rows[3].oldText, null);
  assert.strictEqual(rows[4].type, 'ctx');
  assert.strictEqual(out.added, 3);
  assert.strictEqual(out.removed, 1);
});

test('parseUnifiedDiff: 3 deletions + 1 addition gaps the NEW side', () => {
  const text = D(
    '--- a/f', '+++ b/f', '@@ -1,4 +1,2 @@',
    ' keep',
    '-a', '-b', '-c',
    '+z',
  );
  const rows = parseUnifiedDiff(text).hunks[0].rows;
  assert.strictEqual(rows.length, 4);            // 1 ctx + max(3,1)=3
  assert.strictEqual(rows[1].oldText, 'a');
  assert.strictEqual(rows[1].newText, 'z');      // paired
  assert.strictEqual(rows[2].newText, null);     // gapped
  assert.strictEqual(rows[3].newText, null);
});

test('parseUnifiedDiff: line numbers track both sides', () => {
  const text = D('--- a/f', '+++ b/f', '@@ -10,3 +20,3 @@', ' x', '-y', '+Y', ' z');
  const rows = parseUnifiedDiff(text).hunks[0].rows;
  assert.deepStrictEqual([rows[0].oldNum, rows[0].newNum], [10, 20]);
  assert.deepStrictEqual([rows[1].oldNum, rows[1].newNum], [11, 21]);
  assert.deepStrictEqual([rows[2].oldNum, rows[2].newNum], [12, 22]);
});

test('parseUnifiedDiff: added file (/dev/null old side)', () => {
  const text = D('--- /dev/null', '+++ b/src/new.js', '@@ -0,0 +1,2 @@', "+'use strict';", '+const x = 1;');
  const out = parseUnifiedDiff(text);
  assert.strictEqual(out.oldPath, null);
  assert.strictEqual(out.newPath, 'src/new.js');
  assert.strictEqual(out.hunks[0].rows.every((r) => r.type === 'add' && r.oldText === null), true);
});

test('parseUnifiedDiff: deleted file (/dev/null new side)', () => {
  const text = D('--- a/src/gone.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b');
  const out = parseUnifiedDiff(text);
  assert.strictEqual(out.newPath, null);
  assert.strictEqual(out.hunks[0].rows.every((r) => r.type === 'del' && r.newText === null), true);
});

test('parseUnifiedDiff: multi-hunk keeps each hunk separate with its own numbering', () => {
  const text = D(
    '--- a/f', '+++ b/f',
    '@@ -1,2 +1,2 @@', ' a', '-b', '+B',
    '@@ -50,2 +50,2 @@', ' x', '-y', '+Y',
  );
  const out = parseUnifiedDiff(text);
  assert.strictEqual(out.hunks.length, 2);
  assert.strictEqual(out.hunks[1].rows[0].oldNum, 50);
});

test('parseUnifiedDiff: "\\ No newline at end of file" is a marker, not a row', () => {
  const text = D('--- a/f', '+++ b/f', '@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b');
  const rows = parseUnifiedDiff(text).hunks[0].rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].oldText, 'a');
  assert.strictEqual(rows[0].newText, 'b');
});

test('parseUnifiedDiff: binary marker short-circuits', () => {
  const out = parseUnifiedDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n');
  assert.strictEqual(out.binary, true);
  assert.deepStrictEqual(out.hunks, []);
});

test('parseUnifiedDiff: empty/unchanged input', () => {
  assert.deepStrictEqual(parseUnifiedDiff('').hunks, []);
  assert.deepStrictEqual(parseUnifiedDiff(null).hunks, []);
});

// A diff OF a diff: '+++'/'---'/'@@' appear as CONTENT. Only the header pair before
// the first @@ are headers; after that the 1-char prefix rules.
test('parseUnifiedDiff: diff-of-a-diff does not mistake content for headers', () => {
  const text = D(
    '--- a/spec.md', '+++ b/spec.md',
    '@@ -1,3 +1,4 @@',
    ' text',
    '+--- a/inner.js',
    '+@@ -1 +1 @@',
  );
  const out = parseUnifiedDiff(text);
  assert.strictEqual(out.newPath, 'spec.md');
  assert.strictEqual(out.hunks.length, 1);
  assert.strictEqual(out.hunks[0].rows.length, 3);
  assert.strictEqual(out.hunks[0].rows[1].newText, '--- a/inner.js');
  assert.strictEqual(out.hunks[0].rows[2].newText, '@@ -1 +1 @@');
});

test('parseUnifiedDiff: CRLF content keeps the \\r as content', () => {
  const text = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\r\n+b\r\n';
  const rows = parseUnifiedDiff(text).hunks[0].rows;
  assert.strictEqual(rows[0].oldText, 'a\r');
  assert.strictEqual(rows[0].newText, 'b\r');
});

test('parseUnifiedDiff: rename headers are picked up', () => {
  const text = D(
    'diff --git a/old.js b/new.js', 'similarity index 95%',
    'rename from old.js', 'rename to new.js',
    '--- a/old.js', '+++ b/new.js', '@@ -1 +1 @@', '-a', '+b',
  );
  const out = parseUnifiedDiff(text);
  assert.strictEqual(out.oldPath, 'old.js');
  assert.strictEqual(out.newPath, 'new.js');
});
