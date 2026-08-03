// Tests for the brain lint core: classification + size budgets + lint aggregation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, checkSizes, lint, checkCheckpointBullets, BUDGETS } from '../lib/brain-lint-core.mjs';

// Bullet bodies of an exact length, so a test asserts on the threshold and not on prose that
// somebody later reflows. 'x'.repeat(n) keeps the total = n + the '- ' prefix.
const bullet = (n) => `- ${'x'.repeat(n - 2)}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'lint-brain.mjs');
const BRAIN_ROOT = path.resolve(here, '..', '..');

function makeBrain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

test('classify maps files to classes and budgets', () => {
  assert.equal(classify('CLAUDE.md').cls, 'boot');
  assert.equal(classify('rules/_index.md').cls, 'boot');
  assert.equal(classify('topics/_index.md').cls, 'index');
  assert.equal(classify('preferences/_index.md').cls, 'index');
  assert.deepEqual(classify('projects/acme-portal/progress.md'),
    { cls: 'progress', warnKB: 48, failKB: 96, action: 'rotate acme-portal' });
  assert.equal(classify('projects/acme-portal/notes.md').cls, 'notes');
  assert.equal(classify('daily-memories/2026-07-17.md'), null);
  assert.equal(classify('topics/_details/x.md'), null);
  assert.equal(classify('projects/acme-portal/notes/_details/x.md'), null);
  assert.equal(classify('projects/acme-portal/progress-archive/2026.md'), null);
});

// --- checkpoint bullet length ---------------------------------------------------------------

test('flags a checkpoint bullet over the limit and leaves a short one alone', () => {
  const root = makeBrain({
    'projects/a/progress.md': `## 2026-07-29 -> x\n${bullet(401)}\n${bullet(400)}\n`,
  });
  const flags = checkCheckpointBullets(root);
  assert.equal(flags.length, 1, 'exactly the 401 bullet');
  assert.equal(flags[0].type, 'checkpoint-bullet');
  assert.equal(flags[0].severity, 'warn');
  assert.equal(flags[0].file, 'projects/a/progress.md');
  assert.match(flags[0].detail, /line 2: 401 chars \(max 400\)/);
});

test('only the newest block is checked - settled history is not flagged', () => {
  // progress.md is newest-first and rotates. Flagging archived blocks would bury the one
  // bullet somebody can still fix under a wall of ones they cannot.
  const root = makeBrain({
    'projects/a/progress.md': `## 2026-07-29 -> x\n${bullet(50)}\n\n## 2026-07-25 -> y\n${bullet(900)}\n`,
  });
  assert.deepEqual(checkCheckpointBullets(root), []);
});

test('a wrapped bullet is measured whole, not by its first line', () => {
  // The failure this prevents: any paragraph passes simply by pressing Enter.
  const root = makeBrain({
    'projects/a/progress.md': `## d -> x\n- ${'x'.repeat(200)}\n  ${'y'.repeat(200)}\n`,
  });
  const flags = checkCheckpointBullets(root);
  assert.equal(flags.length, 1);
  assert.match(flags[0].detail, /40[0-9] chars/);
});

test('a blank line ends a bullet rather than swallowing the rest of the block', () => {
  const root = makeBrain({
    'projects/a/progress.md': `## d -> x\n- ${'x'.repeat(200)}\n\n${'y'.repeat(300)}\n`,
  });
  assert.deepEqual(checkCheckpointBullets(root), []);
});

test('a "## " inside a code fence does not end the newest block', () => {
  // Treating it as a heading would end the block early and silently skip what follows.
  const root = makeBrain({
    'projects/a/progress.md': `## d -> x\n\`\`\`sh\n## not a heading\n\`\`\`\n${bullet(500)}\n`,
  });
  const flags = checkCheckpointBullets(root);
  assert.equal(flags.length, 1, 'the bullet after the fence is still in the newest block');
  assert.match(flags[0].detail, /500 chars/);
});

test('non-bullet lines are ignored however long', () => {
  const root = makeBrain({
    'projects/a/progress.md': `## d -> x\n**Topics:** ${'t'.repeat(600)}\n${'p'.repeat(600)}\n`,
  });
  assert.deepEqual(checkCheckpointBullets(root), []);
});

test('horizontal rules and frontmatter dashes are not bullets', () => {
  const root = makeBrain({
    'projects/a/progress.md': `## d -> x\n---\n***\n- short\n`,
  });
  assert.deepEqual(checkCheckpointBullets(root), []);
});

test('degrades to silence on a missing projects dir or a project with no progress.md', () => {
  assert.deepEqual(checkCheckpointBullets(makeBrain({ 'CLAUDE.md': '# x' })), []);
  assert.deepEqual(checkCheckpointBullets(makeBrain({ 'projects/a/notes.md': 'x' })), []);
  assert.deepEqual(checkCheckpointBullets(makeBrain({ 'projects/a/progress.md': 'no heading\n' })), []);
});

test('reports every offending project, not just the first', () => {
  const root = makeBrain({
    'projects/a/progress.md': `## d -> x\n${bullet(500)}\n`,
    'projects/b/progress.md': `## d -> x\n${bullet(600)}\n`,
  });
  const files = checkCheckpointBullets(root).map(f => f.file).sort();
  assert.deepEqual(files, ['projects/a/progress.md', 'projects/b/progress.md']);
});

test('lint() surfaces checkpoint-bullet flags as warnings, not failures', () => {
  const root = makeBrain({
    'CLAUDE.md': '# c', 'SETUP.md': '# s',
    'projects/a/progress.md': `## d -> x\n${bullet(500)}\n`,
  });
  const res = lint(root);
  const mine = res.flags.filter(f => f.type === 'checkpoint-bullet');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].severity, 'warn');
});

test('classify accepts windows-style backslash paths', () => {
  assert.equal(classify('projects\\acme-portal\\progress.md').cls, 'progress');
  assert.equal(classify('rules\\_index.md').cls, 'boot');
});

test('checkSizes flags warn and fail tiers', () => {
  const root = makeBrain({
    'projects/big/progress.md': '#'.repeat(100 * 1024),   // > 96KB -> fail
    'projects/mid/progress.md': '#'.repeat(60 * 1024),    // > 48KB -> warn
    'projects/ok/progress.md': '# fine\n',
  });
  const flags = checkSizes(root);
  const big = flags.find(f => f.file === 'projects/big/progress.md');
  const mid = flags.find(f => f.file === 'projects/mid/progress.md');
  assert.equal(big.severity, 'fail');
  assert.equal(big.suggestedAction, 'rotate big');
  assert.equal(mid.severity, 'warn');
  assert.equal(flags.find(f => f.file === 'projects/ok/progress.md'), undefined);
});

test('checkSizes measures BYTES, not string length (unicode)', () => {
  // 20480 em-dashes = 20KB of string, 60KB of UTF-8 -> must warn (48/96 budget).
  const root = makeBrain({ 'projects/uni/progress.md': '—'.repeat(20 * 1024) });
  const flags = checkSizes(root);
  const f = flags.find(x => x.file === 'projects/uni/progress.md');
  assert.ok(f, 'unicode-heavy progress.md must be measured in bytes and flagged');
  assert.equal(f.severity, 'warn');
});

test('checkSizes covers boot + index classes and reports root-relative forward-slash paths', () => {
  const root = makeBrain({
    'CLAUDE.md': 'x'.repeat(70 * 1024),          // > 64KB -> fail
    'rules/_index.md': 'x'.repeat(40 * 1024),    // > 32KB -> warn
    'topics/_index.md': 'x'.repeat(260 * 1024),  // > 256KB -> fail
    'preferences/_index.md': 'x'.repeat(10 * 1024),
  });
  const flags = checkSizes(root);
  const byFile = Object.fromEntries(flags.map(f => [f.file, f]));
  assert.equal(byFile['CLAUDE.md'].severity, 'fail');
  assert.equal(byFile['CLAUDE.md'].cls, undefined); // cls is reported inside detail, not top-level
  assert.ok(byFile['CLAUDE.md'].detail.includes('boot'));
  assert.equal(byFile['rules/_index.md'].severity, 'warn');
  assert.equal(byFile['topics/_index.md'].severity, 'fail');
  assert.equal(byFile['preferences/_index.md'], undefined);
  for (const f of flags) assert.ok(!f.file.includes('\\'), `file must use forward slashes: ${f.file}`);
});

test('checkSizes ignores unclassified files and tolerates a missing brain', () => {
  const root = makeBrain({
    'projects/_index.md': 'x'.repeat(300 * 1024),
    'projects/p/index.md': 'x'.repeat(300 * 1024),
    'projects/p/progress-archive/2026.md': 'x'.repeat(300 * 1024),
    'daily-memories/2026-07-17.md': 'x'.repeat(300 * 1024),
  });
  assert.deepEqual(checkSizes(root), []);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-empty-'));
  assert.deepEqual(checkSizes(empty), []);
});

test('lint aggregates counts', () => {
  const root = makeBrain({ 'projects/big/notes.md': '#'.repeat(100 * 1024) });
  const r = lint(root);
  assert.equal(r.counts.fail, 1);
  assert.ok(r.flags[0].suggestedAction.includes('shard-notes big'));
});

test('lint returns the frozen report shape', () => {
  const root = makeBrain({ 'projects/ok/progress.md': '# fine\n' });
  const r = lint(root);
  assert.deepEqual(Object.keys(r).sort(), ['counts', 'flags', 'generatedAt', 'root']);
  assert.equal(r.counts.fail, 0);
  assert.equal(r.counts.warn, 0);
  assert.deepEqual(r.flags, []);
  assert.ok(!r.root.includes('\\'), 'root must use forward slashes');
  assert.ok(!Number.isNaN(Date.parse(r.generatedAt)));
});

test('lint refuses a root that is not a brain rather than reporting it clean', () => {
  // Every check degrades to silence on a wrong root (walkMd swallows readdir errors,
  // checkSizes skips missing candidates), so composed they render a confident green.
  // A rot detector must fail closed.
  const notABrain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-brain-'));
  assert.throws(() => lint(notABrain), /not a brain root/i);
});

test('lint rejects a bare CLAUDE.md with no corroborating marker, but accepts projects/ alone', () => {
  // A bare contract file (CLAUDE.md or AGENTS.md) is a cross-tool convention that shows up in
  // repos unrelated to this brain, so it is no longer sufficient on its own (round 3: the
  // symmetric fix to the same looseness already closed for AGENTS.md in round 2). projects/
  // remains sufficient alone - it can only exist on a set-up brain.
  assert.throws(() => lint(makeBrain({ 'CLAUDE.md': '# c\n' })), /not a brain root/i);
  assert.equal(lint(makeBrain({ 'projects/ok/progress.md': '# fine\n' })).counts.fail, 0);
});

test('lint-brain.mjs self-locates the brain root and is cwd-independent', () => {
  const run = (cwd) => {
    const r = spawnSync(process.execPath, [CLI, '--json'], { cwd, encoding: 'utf8' });
    assert.ok(r.stdout.trim().startsWith('{'), `expected JSON from cwd=${cwd}, got: ${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const fromRoot = run(BRAIN_ROOT);
  const fromScripts = run(path.join(BRAIN_ROOT, 'scripts'));
  assert.equal(fromRoot.root, BRAIN_ROOT.replace(/\\/g, '/'));
  assert.equal(fromScripts.root, fromRoot.root, 'root must not depend on cwd');
  assert.deepEqual(fromScripts.counts, fromRoot.counts, 'counts must not depend on cwd');
});

test('BUDGETS is the single source of the size constants', () => {
  assert.deepEqual(BUDGETS, {
    boot: { warnKB: 32, failKB: 64 },
    index: { warnKB: 200, failKB: 256 },
    progress: { warnKB: 48, failKB: 96 },
    notes: { warnKB: 48, failKB: 96 },
  });
});
