'use strict';

// Brain health monitor: spawns the brain's own scripts/lint-brain.mjs and caches its JSON.
//
// THE LOAD-BEARING GOTCHA (locked in by the first test): lint-brain.mjs EXITS 1 whenever any
// FAIL-severity flag exists. Exit 1 WITH parseable stdout is a VALID REPORT, not an error. The
// real brain currently has 30 fails, so a runLint that treats exit 1 as failure is dead on
// arrival -- the card would render empty forever. Exit 2 (the lint itself could not run) IS a
// real error and must surface as one.
//
// FIXTURE NOTE (why we copy the script instead of pointing at the real one): lint-brain.mjs
// SELF-LOCATES its brain root from import.meta.url -- `path.dirname(path.dirname(fileURLToPath(...)))`
// -- and deliberately ignores process.cwd() (a rot detector that fails open is worse than none).
// So spawning the REAL scripts/lint-brain.mjs with cwd=<tmp fixture> lints the REAL BRAIN, not the
// fixture. That would make the "fail" test pass for the wrong reason and the "clean" test fail
// outright. Copying the script + its lib into the fixture makes self-location resolve to the fixture.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runLint, createHealthMonitor, runRepair, createRepairGate } = require('../src/brain-health');

const BRAIN_SCRIPTS = path.resolve(__dirname, '..', '..', 'scripts');

// Build a self-contained mini-brain that carries its own copy of the linter, so the linter's
// self-location lands on the fixture root. Returns the fixture root.
function tmpBrain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-health-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(BRAIN_SCRIPTS, 'lint-brain.mjs'), path.join(root, 'scripts', 'lint-brain.mjs'));
  fs.copyFileSync(
    path.join(BRAIN_SCRIPTS, 'lib', 'brain-lint-core.mjs'),
    path.join(root, 'scripts', 'lib', 'brain-lint-core.mjs')
  );
  // contract-sync-core.mjs is imported by brain-lint-core.mjs, so it must be copied into the fixture
  // too. Without it, module resolution fails and the linter can't run in the fixture.
  fs.copyFileSync(
    path.join(BRAIN_SCRIPTS, 'lib', 'contract-sync-core.mjs'),
    path.join(root, 'scripts', 'lib', 'contract-sync-core.mjs')
  );
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

const scriptIn = (root) => path.join(root, 'scripts', 'lint-brain.mjs');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('runLint treats exit-code 1 (FAIL flags present) as a VALID report, not an error', async () => {
  // 100KB progress.md is over the 96KB fail budget -> one fail flag -> lint exits 1.
  const root = tmpBrain({ 'projects/x/progress.md': '#'.repeat(100 * 1024) });
  try {
    const report = await new Promise((resolve, reject) => {
      runLint(root, { scriptPath: scriptIn(root) }, (err, r) => (err ? reject(err) : resolve(r)));
    });
    assert.ok(report, 'expected a parsed report despite the child exiting 1');
    assert.ok(report.counts.fail >= 1, `expected >= 1 fail, got ${report.counts.fail}`);
    // Prove the linter actually ran against the FIXTURE and not the real brain.
    assert.equal(report.root, root.replace(/\\/g, '/'));
    assert.ok(report.flags.some((f) => f.file === 'projects/x/progress.md' && f.severity === 'fail'));
    assert.equal(report.flags.find((f) => f.file === 'projects/x/progress.md').suggestedAction, 'rotate x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runLint on a clean brain reports zero fails (exit 0)', async () => {
  const root = tmpBrain({ 'projects/ok/progress.md': '# ok\n' });
  try {
    const report = await new Promise((resolve, reject) => {
      runLint(root, { scriptPath: scriptIn(root) }, (err, r) => (err ? reject(err) : resolve(r)));
    });
    assert.equal(report.counts.fail, 0);
    assert.equal(report.root, root.replace(/\\/g, '/'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runLint surfaces a genuine failure (missing script) as an error', async () => {
  const root = tmpBrain({});
  try {
    const err = await new Promise((resolve) => {
      runLint(root, { scriptPath: path.join(root, 'scripts', 'does-not-exist.mjs') }, (e) => resolve(e));
    });
    assert.ok(err, 'a missing lint script must surface as an error, not a silent empty report');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runLint defaults scriptPath to <brainRoot>/scripts/lint-brain.mjs', async () => {
  const root = tmpBrain({ 'projects/x/progress.md': '#'.repeat(100 * 1024) });
  try {
    const report = await new Promise((resolve, reject) => {
      runLint(root, {}, (err, r) => (err ? reject(err) : resolve(r))); // no scriptPath
    });
    assert.equal(report.counts.fail, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createHealthMonitor debounces: two schedule() calls inside the window produce ONE run', async () => {
  const root = tmpBrain({ 'projects/ok/progress.md': '# ok\n' });
  const updates = [];
  try {
    const mon = createHealthMonitor({
      brainRoot: root,
      scriptPath: scriptIn(root),
      debounceMs: 40,
      onUpdate: (r) => updates.push(r),
    });
    mon.schedule();
    await settle(10);
    mon.schedule(); // inside the 40ms window -> must collapse into the first
    await settle(2500); // generous: a real node spawn on Windows is slow
    assert.equal(updates.length, 1, `expected exactly 1 run from 2 debounced schedules, got ${updates.length}`);
    assert.ok(mon.last(), 'last() should expose the cached report');
    assert.equal(mon.last().counts.fail, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createHealthMonitor COALESCES a run requested while one is in flight (never drops the newest)', async () => {
  // Regression guard for the 2026-07-17 git-badge bug: a plain `if (inFlight) return` silently
  // discards the newest request and leaves stale data on screen. The monitor must instead set
  // pending and re-run on land, so a brain edit during an in-flight lint is never lost.
  const root = tmpBrain({ 'projects/ok/progress.md': '# ok\n' });
  const updates = [];
  try {
    const mon = createHealthMonitor({
      brainRoot: root,
      scriptPath: scriptIn(root),
      debounceMs: 5,
      onUpdate: (r) => updates.push(r),
    });
    mon.run();
    mon.run(); // arrives while the first spawn is in flight -> must coalesce into a re-run
    await settle(3000);
    assert.equal(updates.length, 2, `expected the in-flight request to be coalesced into a re-run, got ${updates.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createHealthMonitor.last() is null before the first successful run', () => {
  const root = tmpBrain({});
  try {
    const mon = createHealthMonitor({ brainRoot: root, scriptPath: scriptIn(root), onUpdate: () => {} });
    assert.equal(mon.last(), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runRepair / createRepairGate -- the gated Fix flow.
//
// THIS IS THE ONLY CODE IN THE APP THAT CAN REWRITE THE USER'S BRAIN. The brain's personal
// data is GITIGNORED, so git is NOT a safety net for it: _backup/repair-<stamp>/ is. Every
// test below exists to keep one of those guarantees honest.
//
// WHY THESE FIXTURES POINT AT THE REAL scripts/brain-repair.mjs (and the lint ones do not):
// brain-repair.mjs takes its root from process.cwd() -- unlike lint-brain.mjs, which self-locates
// from import.meta.url and ignores cwd. So for REPAIR, cwd IS the safety boundary, and copying the
// script into the fixture would buy nothing (a copy still reads cwd). Pointing at the real script
// with cwd=<fixture> both confines the blast radius to the fixture AND tests the real CLI contract.
// A cwd bug here fails loudly (projects/<p> does not exist under terminal-app/) rather than
// silently repairing the real brain.

const REPAIR_SCRIPT = path.join(BRAIN_SCRIPTS, 'brain-repair.mjs');

// A bare project brain -- no linter needed, the repairer is the subject here.
function tmpRepairBrain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-repair-'));
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

// A rotatable progress.md: 30 dated checkpoints, ~56KB, over the 96KB-fail/48KB-warn budgets'
// rotation target of 32KB, so planRotation always has blocks to move.
function bigProgress() {
  let s = '# demo progress\n\n';
  for (let i = 30; i >= 1; i--) {
    const d = `2026-06-${String(i).padStart(2, '0')}`;
    s += `## ${d} -> [daily memory](../../daily-memories/${d}.md)\n- shipped thing ${i}\n${'- filler '.repeat(200)}\n\n`;
  }
  return s;
}

// Snapshot every file under `dir` as rel -> content, so a mutation of ANY kind is detectable.
function snapshot(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(abs, base, out);
    else out[path.relative(base, abs).replace(/\\/g, '/')] = fs.readFileSync(abs, 'utf8');
  }
  return out;
}

const repair = (root, opts) =>
  new Promise((resolve) => runRepair(root, { scriptPath: REPAIR_SCRIPT, ...opts }, (err, r) => resolve({ err, r })));

// A stand-in for the repair script that PROVES whether a spawn happened: it writes a sentinel the
// instant it runs. Validation that rejects before spawning leaves the sentinel absent. Asserting
// "no spawn" any other way (timing, error text) would pass even if the real script had already run
// and mutated the tree -- which is the exact thing the trust boundary exists to prevent.
function canary(root) {
  const script = path.join(root, 'canary.mjs');
  const sentinel = path.join(root, 'SPAWNED');
  fs.writeFileSync(script, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(sentinel)}, 'yes');\nconsole.log('{}');\n`);
  return { script, spawned: () => fs.existsSync(sentinel) };
}

test('runRepair --dry-run returns a plan and mutates NOTHING on disk', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const before = snapshot(root);
    const { err, r } = await repair(root, { command: 'rotate', project: 'demo' });
    assert.equal(err, null, err && err.message);
    assert.equal(r.command, 'rotate');
    assert.equal(r.project, 'demo');
    assert.ok(Array.isArray(r.writes) && r.writes.length >= 2, 'expected writes[] for the hot file + an archive');
    assert.ok(r.summary.moved > 0, 'expected the plan to move at least one checkpoint');
    assert.ok(r.summary.hotBytesAfter < r.summary.hotBytesBefore);
    // The whole point of a dry run: byte-for-byte identical tree, and no _backup, no archive.
    assert.deepEqual(snapshot(root), before, 'dry-run must not touch a single byte on disk');
    assert.ok(!fs.existsSync(path.join(root, '_backup')));
    assert.ok(!fs.existsSync(path.join(root, 'projects/demo/progress-archive')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRepair --apply writes the hot file + archive AND backs the original up first', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const original = fs.readFileSync(path.join(root, 'projects/demo/progress.md'), 'utf8');
    const { r: plan } = await repair(root, { command: 'rotate', project: 'demo' });
    const { err, r } = await repair(root, { command: 'rotate', project: 'demo', apply: true, plan });
    assert.equal(err, null, err && err.message);
    assert.equal(r.applied, true);
    assert.ok(r.backupDir, 'apply must report where the originals went');

    const hot = fs.readFileSync(path.join(root, 'projects/demo/progress.md'), 'utf8');
    assert.ok(Buffer.byteLength(hot) < Buffer.byteLength(original), 'the hot file must shrink');
    assert.ok(fs.existsSync(path.join(root, 'projects/demo/progress-archive/2026.md')), 'archive must exist');

    // The backup is the ONLY net for gitignored data: it must hold the exact pre-image.
    const backed = path.join(r.backupDir, 'projects/demo/progress.md');
    assert.ok(fs.existsSync(backed), `expected a backup copy at ${backed}`);
    assert.equal(fs.readFileSync(backed, 'utf8'), original, 'the backup must be the byte-exact original');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRepair rejects an unknown command WITHOUT spawning anything', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const c = canary(root);
    for (const command of ['rm -rf', 'rotate; whoami', 'ROTATE', 'rotate ', '', null, undefined, 'shard', '--apply']) {
      const { err, r } = await repair(root, { command, project: 'demo', scriptPath: c.script });
      assert.ok(err, `command ${JSON.stringify(command)} must be rejected`);
      assert.equal(err.code, 'EBADCMD');
      assert.equal(r, undefined);
    }
    assert.equal(c.spawned(), false, 'validation must reject BEFORE any process is spawned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRepair rejects a traversal / non-existent project WITHOUT spawning anything', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const c = canary(root);
    // Traversal + separators + absolute paths + shell metachars: all must die on the regex.
    const bad = ['..', '../..', '../../etc', 'demo/../..', 'demo/x', 'demo\\x', 'C:/Windows',
      '/etc/passwd', '.hidden', 'Demo', 'demo;rm', 'demo x', '-demo', '', null, undefined, 42, {}];
    for (const project of bad) {
      const { err } = await repair(root, { command: 'rotate', project, scriptPath: c.script });
      assert.ok(err, `project ${JSON.stringify(project)} must be rejected`);
      assert.equal(err.code, 'EBADPROJ', `project ${JSON.stringify(project)} -> ${err.code}`);
    }
    // Regex-clean but no such directory under projects/ -- still rejected, still no spawn.
    const { err } = await repair(root, { command: 'rotate', project: 'ghost', scriptPath: c.script });
    assert.ok(err);
    assert.equal(err.code, 'EBADPROJ');
    assert.equal(c.spawned(), false, 'validation must reject BEFORE any process is spawned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRepair rejects a project that is a FILE rather than a directory (no spawn)', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress(), 'projects/notadir': 'x' });
  try {
    const c = canary(root);
    const { err } = await repair(root, { command: 'rotate', project: 'notadir', scriptPath: c.script });
    assert.ok(err);
    assert.equal(err.code, 'EBADPROJ');
    assert.equal(c.spawned(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createRepairGate refuses to apply a repair that was never previewed', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const gate = createRepairGate({ brainRoot: root, scriptPath: REPAIR_SCRIPT });
    const res = await gate.apply({ command: 'rotate', project: 'demo' });
    assert.match(res.error || '', /^ENOPLAN/, 'apply without a preview must be refused');
    // NO AUTO-APPLY, EVER: the tree must be untouched.
    assert.ok(!fs.existsSync(path.join(root, '_backup')));
    assert.ok(!fs.existsSync(path.join(root, 'projects/demo/progress-archive')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createRepairGate applies the exact plan that was previewed, then forgets it', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const gate = createRepairGate({ brainRoot: root, scriptPath: REPAIR_SCRIPT });
    const plan = await gate.preview({ command: 'rotate', project: 'demo' });
    assert.ok(plan.writes, plan.error);
    const applied = await gate.apply({ command: 'rotate', project: 'demo' });
    assert.equal(applied.applied, true, applied.error);
    assert.ok(applied.backupDir);
    // The plan is consumed: a second apply must not silently re-run against the new tree.
    const again = await gate.apply({ command: 'rotate', project: 'demo' });
    assert.match(again.error || '', /^ENOPLAN/, 'a consumed plan must not be reusable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createRepairGate refuses to apply when the file drifted after the preview', async () => {
  // The approved diff must be the diff that runs. If another session (or Mavis itself) writes the
  // file between preview and apply, the human approved bytes that no longer exist -- refuse.
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const gate = createRepairGate({ brainRoot: root, scriptPath: REPAIR_SCRIPT });
    await gate.preview({ command: 'rotate', project: 'demo' });
    fs.appendFileSync(path.join(root, 'projects/demo/progress.md'), '\n## 2026-07-17 -> drifted\n- new\n');
    const res = await gate.apply({ command: 'rotate', project: 'demo' });
    assert.ok(res.error, 'a drifted file must not be silently overwritten');
    assert.match(res.error, /drift/i);
    assert.ok(!fs.existsSync(path.join(root, 'projects/demo/progress-archive')), 'nothing may be written on a refused apply');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createRepairGate caches previews PER KEY (a second project does not evict the first)', async () => {
  // Single-slot cache trap: previewing B then applying A must still work.
  const root = tmpRepairBrain({
    'projects/alpha/progress.md': bigProgress(),
    'projects/beta/progress.md': bigProgress(),
  });
  try {
    const gate = createRepairGate({ brainRoot: root, scriptPath: REPAIR_SCRIPT });
    await gate.preview({ command: 'rotate', project: 'alpha' });
    await gate.preview({ command: 'rotate', project: 'beta' });
    const a = await gate.apply({ command: 'rotate', project: 'alpha' });
    assert.equal(a.applied, true, a.error);
    const b = await gate.apply({ command: 'rotate', project: 'beta' });
    assert.equal(b.applied, true, b.error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createRepairGate.preview surfaces a bad command as an error sentinel, not a throw', async () => {
  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const gate = createRepairGate({ brainRoot: root, scriptPath: REPAIR_SCRIPT });
    const res = await gate.preview({ command: 'nope', project: 'demo' });
    assert.match(res.error || '', /^EBADCMD/);
    const res2 = await gate.preview({ command: 'rotate', project: '../..' });
    assert.match(res2.error || '', /^EBADPROJ/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRepair shard-notes plans a two-tier split without writing', async () => {
  const root = tmpRepairBrain({
    'projects/demo/notes.md': '# demo notes\n\n## A gotcha about MT_DIAG\n\n**Discovered:** [2026-07-01](../../daily-memories/2026-07-01.md)\n\nThe thing broke.\n\n## Another one\n\nProse here.\n',
  });
  try {
    const before = snapshot(root);
    const { err, r } = await repair(root, { command: 'shard-notes', project: 'demo' });
    assert.equal(err, null, err && err.message);
    assert.equal(r.command, 'shard-notes');
    assert.equal(r.summary.entries, 2);
    assert.ok(r.writes.some((w) => w.path === 'projects/demo/notes/_details/a-gotcha-about-mt-diag.md'));
    assert.deepEqual(snapshot(root), before, 'dry-run must not touch a single byte on disk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REGRESSION (2026-07-17): the repair flow hung forever in the REAL app while every
// test here passed. Cause: in the packaged app `process.execPath` is electron.exe, not
// node. `electron.exe script.mjs` boots a full Electron app with that file as the entry,
// and the Electron event loop keeps the process alive until the script calls process.exit()
// itself. lint-brain.mjs ends with an unconditional `process.exit(fail ? 1 : 0)` so it always
// terminated -- masking the problem. brain-repair.mjs only exits explicitly on its ERROR
// paths; both SUCCESS paths console.log and fall off the end. Under plain `node` (which is
// what `node --test` gives us) that exits cleanly, so preview/apply looked healthy in tests
// and hung forever in production.
//
// These tests pin the fix from BOTH directions: the options contract, and the real binary.
// ---------------------------------------------------------------------------

test('spawnOpts sets ELECTRON_RUN_AS_NODE=1 (electron.exe must behave as node) and keeps the env', () => {
  const { spawnOpts } = require('../src/brain-health');
  process.env.__MT_SPAWNOPTS_PROBE = 'keep-me';
  try {
    const o = spawnOpts('/some/brain', 1234);
    assert.equal(o.env.ELECTRON_RUN_AS_NODE, '1',
      'without this, electron.exe runs the .mjs as an APP and never exits -> callback never fires');
    assert.equal(o.env.__MT_SPAWNOPTS_PROBE, 'keep-me', 'must inherit the parent env, not replace it');
    assert.equal(o.cwd, '/some/brain');
    assert.equal(o.maxBuffer, 1234);
    assert.equal(o.windowsHide, true);
  } finally {
    delete process.env.__MT_SPAWNOPTS_PROBE;
  }
});

test('the real electron binary + ELECTRON_RUN_AS_NODE runs brain-repair.mjs to completion', async (t) => {
  // The only test that actually exercises production's interpreter. Unit tests run under node,
  // where this bug is INVISIBLE by construction -- so a node-only suite can never protect this.
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    return t.skip('electron not installed');
  }
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    return t.skip('electron binary not resolvable');
  }

  const root = tmpRepairBrain({ 'projects/demo/progress.md': bigProgress() });
  try {
    const { execFile } = require('node:child_process');
    const res = await new Promise((resolve) => {
      const child = execFile(
        electronPath,
        [REPAIR_SCRIPT, 'rotate', 'demo', '--dry-run', '--json'],
        {
          cwd: root,
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 30000, // if the fix regresses the child never exits; fail loudly, don't hang the suite
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
        (err, stdout) => resolve({ err, stdout })
      );
      child.on('error', (err) => resolve({ err, stdout: '' }));
    });

    assert.equal(res.err, null,
      'electron.exe must run the repair script to completion and exit; a timeout here means ' +
      'ELECTRON_RUN_AS_NODE regressed and the app hangs on Preview fix again');
    const plan = JSON.parse(res.stdout);
    assert.equal(plan.command, 'rotate');
    assert.ok(plan.summary.hotBytesAfter < plan.summary.hotBytesBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
