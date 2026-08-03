'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gitRepo = require('../src/git-repo');

// No git is spawned anywhere in this file. Everything here is the non-I/O surface of
// git-repo.js — path validation, arg construction, branch validation — which is exactly
// the trust boundary the spec cares about. Spawning git would test git, not us. The one
// exception is the symlink-escape test, which needs a real link on a real disk to exist at
// all; it builds and removes its own tmpdir.
const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo';

// ---------- safeRel ----------

test('safeRel: accepts a normal relative path', () => {
  assert.strictEqual(gitRepo.safeRel(ROOT, 'src/main.js'), 'src/main.js');
});

test('safeRel: rejects traversal', () => {
  assert.strictEqual(gitRepo.safeRel(ROOT, '../outside.js'), null);
  assert.strictEqual(gitRepo.safeRel(ROOT, 'src/../../outside.js'), null);
});

test('safeRel: rejects an absolute path', () => {
  const abs = process.platform === 'win32' ? 'C:\\Windows\\system32\\x' : '/etc/passwd';
  assert.strictEqual(gitRepo.safeRel(ROOT, abs), null);
});

test('safeRel: rejects a path that would be read as a git option', () => {
  assert.strictEqual(gitRepo.safeRel(ROOT, '--upload-pack=evil'), null);
  assert.strictEqual(gitRepo.safeRel(ROOT, '-x'), null);
});

// The raw '-' check runs on the INPUT, but path.relative() normalizes './' away AFTER it —
// so a './'-prefixed option-lookalike would clear the check and come back out as '-...'.
// The '--' separator is the primary guard; this keeps the returned string honest anyway.
test('safeRel: rejects an option-lookalike that only appears after normalization', () => {
  assert.strictEqual(gitRepo.safeRel(ROOT, './--upload-pack=evil'), null);
  assert.strictEqual(gitRepo.safeRel(ROOT, './-x'), null);
  assert.strictEqual(gitRepo.safeRel(ROOT, 'src/../-x'), null);
});

test('safeRel: rejects a NUL byte', () => {
  assert.strictEqual(gitRepo.safeRel(ROOT, 'src/main.js\0.png'), null);
});

test('safeRel: rejects empty/nullish', () => {
  assert.strictEqual(gitRepo.safeRel(ROOT, ''), null);
  assert.strictEqual(gitRepo.safeRel(ROOT, null), null);
  assert.strictEqual(gitRepo.safeRel(ROOT, undefined), null);
});

test('safeRel: normalizes backslashes to forward slashes for git', { skip: process.platform !== 'win32' ? 'win32-only: a backslash is a legal filename char on POSIX' : false }, () => {
  assert.strictEqual(gitRepo.safeRel(ROOT, 'src\\main.js'), 'src/main.js');
});

// The ONE test here that touches the disk, because the guard it covers cannot be tested any
// other way: the lexical checks above all PASS for a symlink/junction inside the worktree
// that points outside it. `git status --untracked-files=all` descends a junction, so the rail
// lists the out-of-repo file, the diff pane reads it (fs.readFileSync follows links) and
// Discard deletes the real target (fs.unlinkSync resolves THROUGH a junction). fs-browser's
// safeResolve rejects the identical path; safeRel must too.
test('safeRel: rejects a path that escapes the root through a symlink/junction', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-git-safe-'));
  try {
    const root = path.join(tmp, 'repo');
    const outside = path.join(tmp, 'SECRETS');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'id_rsa'), 'ssh-private-key-material');
    // 'junction' is the win32 form that needs no admin rights (`mklink /J`); symlink elsewhere.
    try { fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { return; }   // no link privilege in this environment — nothing to assert
    assert.strictEqual(gitRepo.safeRel(root, 'link/id_rsa'), null, 'must not follow the link out of the repo');
    assert.strictEqual(gitRepo.safeRel(root, 'link'), null);
    // a normal path under the same real root still resolves
    fs.writeFileSync(path.join(root, 'ok.js'), 'x');
    assert.strictEqual(gitRepo.safeRel(root, 'ok.js'), 'ok.js');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });   // removes the link, not its target
  }
});

// ---------- arg construction, verified WITHOUT spawning git ----------

test('buildArgs: diff always carries --no-color and a -- separator before the path', () => {
  const args = gitRepo._buildDiffArgs('src/main.js', false);
  assert.ok(args.includes('--no-color'), 'no-color must be explicit (user color.ui=always would inject ANSI)');
  const sep = args.indexOf('--');
  assert.ok(sep > 0, '-- separator present');
  assert.strictEqual(args[sep + 1], 'src/main.js', 'path comes after --');
  assert.ok(!args.includes('--cached'));
});

test('buildArgs: staged diff uses --cached', () => {
  assert.ok(gitRepo._buildDiffArgs('src/main.js', true).includes('--cached'));
});

// Git runs rename detection AFTER pathspec filtering, so `-- <new>` alone hides the source's
// deletion and the pair never forms — the rename renders as a brand-new file (+N -0).
test('buildArgs: a rename puts BOTH paths on the pathspec, after the --', () => {
  const args = gitRepo._buildDiffArgs('new.js', true, 'old.js');
  const sep = args.indexOf('--');
  assert.deepStrictEqual(args.slice(sep + 1), ['new.js', 'old.js']);
});

// Plain `git diff` on an unmerged path emits a COMBINED diff (`diff --cc` / `@@@`), which is
// not unified text — the parser reads zero hunks and the pane would claim "No textual
// changes." about a file full of conflict markers.
test('buildArgs: the conflict diff goes against HEAD, with --no-color and a -- separator', () => {
  const args = gitRepo._buildConflictDiffArgs('c.txt');
  assert.deepStrictEqual(args, ['diff', '--no-color', '-U3', 'HEAD', '--', 'c.txt']);
});

test('buildArgs: a null/duplicate rename source adds no second path', () => {
  assert.deepStrictEqual(gitRepo._buildDiffArgs('f.js', false, null).slice(-1), ['f.js']);
  assert.deepStrictEqual(gitRepo._buildDiffArgs('f.js', false, 'f.js').slice(-1), ['f.js']);
});

// A staged deletion is in NEITHER the index nor the untracked set, so `restore --` (which
// restores the worktree FROM the index) has nothing to copy. HEAD is the source.
test('buildArgs: restore-from-HEAD carries --staged --worktree and a -- separator', () => {
  const args = gitRepo._buildRestoreFromHeadArgs(['gone.txt']);
  assert.ok(args.includes('--staged') && args.includes('--worktree'));
  assert.deepStrictEqual(args.slice(args.indexOf('--') + 1), ['gone.txt']);
});

// `git restore --staged` resolves HEAD, which does not exist before the first commit.
test('buildArgs: the no-HEAD unstage uses rm --cached, never restore', () => {
  const args = gitRepo._buildUnstageNoHeadArgs(['f.txt']);
  assert.strictEqual(args[0], 'rm');
  assert.ok(args.includes('--cached'));
  assert.ok(!args.includes('restore'));
  assert.deepStrictEqual(args.slice(args.indexOf('--') + 1), ['f.txt']);
});

test('buildArgs: stage puts every path after --', () => {
  const args = gitRepo._buildStageArgs(['a.js', 'b.js']);
  const sep = args.indexOf('--');
  assert.deepStrictEqual(args.slice(sep + 1), ['a.js', 'b.js']);
});

test('buildArgs: unstage and discard also put every path after --', () => {
  for (const args of [gitRepo._buildUnstageArgs(['a.js', 'b.js']), gitRepo._buildDiscardArgs(['a.js', 'b.js'])]) {
    const sep = args.indexOf('--');
    assert.ok(sep > 0, '-- separator present in ' + JSON.stringify(args));
    assert.deepStrictEqual(args.slice(sep + 1), ['a.js', 'b.js']);
  }
});

test('buildArgs: no git arg list ever contains an exec-injection option', () => {
  const banned = ['-c', '--exec-path', '--upload-pack', '--receive-pack', '--output'];
  const lists = [
    gitRepo._buildDiffArgs('a.js', false),
    gitRepo._buildDiffArgs('a.js', true),
    gitRepo._buildDiffArgs('a.js', true, 'old.js'),
    gitRepo._buildConflictDiffArgs('a.js'),
    gitRepo._buildStageArgs(['a.js']),
    gitRepo._buildUnstageArgs(['a.js']),
    gitRepo._buildUnstageNoHeadArgs(['a.js']),
    gitRepo._buildDiscardArgs(['a.js']),
    gitRepo._buildRestoreFromHeadArgs(['a.js']),
    gitRepo._buildCheckoutArgs('main'),
    gitRepo._buildPushArgs('main', 'origin/main'),
    gitRepo._buildPushArgs('main', null),
    gitRepo._buildStatusArgs(),
  ];
  for (const list of lists) {
    for (const b of banned) {
      assert.ok(!list.includes(b), `${b} must never appear in ${JSON.stringify(list)}`);
    }
  }
});

test('buildArgs: status uses porcelain=v1 -z with all untracked files', () => {
  const args = gitRepo._buildStatusArgs();
  assert.ok(args.includes('--porcelain=v1'));
  assert.ok(args.includes('-z'));
  assert.ok(args.includes('--untracked-files=all'));
});

// ---------- branch validation ----------

test('validateBranch: accepts a branch present in the ref list', () => {
  assert.strictEqual(gitRepo._validateBranch('main', ['main', 'dev']), 'main');
});

test('validateBranch: rejects a branch NOT in the ref list (no pass-through to checkout)', () => {
  assert.strictEqual(gitRepo._validateBranch('evil', ['main', 'dev']), null);
  assert.strictEqual(gitRepo._validateBranch('--upload-pack=x', ['main', 'dev']), null);
  assert.strictEqual(gitRepo._validateBranch('', ['main']), null);
  assert.strictEqual(gitRepo._validateBranch(null, ['main']), null);
});

test('validateBranch: rejects when the ref list is missing or not an array', () => {
  assert.strictEqual(gitRepo._validateBranch('main', undefined), null);
  assert.strictEqual(gitRepo._validateBranch('main', null), null);
  assert.strictEqual(gitRepo._validateBranch('main', 'main'), null);
});

// Membership in the ref list does NOT imply the string is not an option: `git update-ref
// refs/heads/--force HEAD` makes a REAL ref named '--force' that for-each-ref lists, so
// _validateBranch accepts it — and bare `git checkout --force` then discards every
// uncommitted change and exits 0. The separator is what makes git read it as a ref.
test('buildArgs: checkout puts --end-of-options before the branch', () => {
  const args = gitRepo._buildCheckoutArgs('main');
  assert.deepStrictEqual(args, ['checkout', '--end-of-options', 'main']);
  assert.deepStrictEqual(gitRepo._buildCheckoutArgs('--force'), ['checkout', '--end-of-options', '--force']);
});

// ---------- push: the command must match the branch the confirm named ----------

// A bare `git push` delegates ref selection to the user's push.default — `matching` (the
// pre-2.0 default) pushes EVERY matching branch while the confirm named exactly one.
test('buildArgs: push is never bare — it names the remote and the refspec', () => {
  const args = gitRepo._buildPushArgs('main', 'origin/main');
  assert.deepStrictEqual(args, ['push', '--end-of-options', 'origin', 'main:main']);
});

test('buildArgs: push honours the upstream REF, not just the local branch name', () => {
  // local `trunk` tracking origin/main must reach origin/main — the ref the confirm printed.
  assert.deepStrictEqual(gitRepo._buildPushArgs('trunk', 'origin/main'),
    ['push', '--end-of-options', 'origin', 'trunk:main']);
});

test('buildArgs: push honours a non-origin upstream remote', () => {
  assert.deepStrictEqual(gitRepo._buildPushArgs('main', 'upstream/main'),
    ['push', '--end-of-options', 'upstream', 'main:main']);
});

test('buildArgs: push with no upstream sets one on origin', () => {
  assert.deepStrictEqual(gitRepo._buildPushArgs('feat', null),
    ['push', '-u', '--end-of-options', 'origin', 'feat']);
});

test('splitUpstream: splits on the FIRST slash (a remote name cannot contain one)', () => {
  assert.deepStrictEqual(gitRepo._splitUpstream('origin/feature/x'), { remote: 'origin', ref: 'feature/x' });
  assert.strictEqual(gitRepo._splitUpstream('origin'), null);
  assert.strictEqual(gitRepo._splitUpstream('origin/'), null);
  assert.strictEqual(gitRepo._splitUpstream('/main'), null);
  assert.strictEqual(gitRepo._splitUpstream(null), null);
});
