'use strict';

// Real-binary smokes. These prove three things no fixture test can reach: whether a real `codex`
// binary actually ACCEPTS a nested `-c hooks.…` override (arg-building tests only prove the string
// was built, never that the CLI parses it), whether the hook child that override spawns really
// lands a normalized line in the sidecar file, and whether codex genuinely auto-loads AGENTS.md
// from its working directory -- mavis/global-invariants.md currently labels that last claim
// UNVERIFIED ("no live load has been observed"); this file is what would let that wording change.
//
// The governing precedent is 0.5.0: 313/313 unit tests were green while the repair flow was 100%
// dead in the real app, because `node --test` ran in an environment that never reproduced the
// dimension the bug actually lived in. Fixture tests cannot catch that class of bug by
// construction -- only a real spawn can.
//
// GATING -- read this before touching SKIP below. Two independent gates, both required before any
// test in this file spawns a real process:
//   1. codex must resolve on PATH.                              (skip if absent)
//   2. MT_CODEX_SMOKE=1 must be set in the environment.          (skip otherwise)
// Gate 2 is a deliberate deviation from the original brief, which only had gate 1. On the machine
// this file was written on, codex IS on PATH but its login is EXPIRED -- gate 1 alone would let an
// ordinary `npm test` spawn a real, network-dependent process against a login known to fail, on
// every run, for every contributor. That is the suite depending on external login state, which is
// exactly what a smoke test must not silently do. Requiring an explicit env var means a human
// deliberately chose to run these, after `codex login`, and knows a real process is about to spawn.
// Both gates apply uniformly to all three tests below -- including the arg-parsing one that needs
// no auth, because it still spawns the real binary, and an ordinary test run must never do that
// unasked.
//
// Whichever gate trips, the skip reason SAYS SO by name, with the exact fix. Do not weaken this:
// an unrun smoke must never be mistaken for a passed one -- silence is the failure mode this file
// exists to prevent. Conversely, once gate 2 is set and a real spawn hits EXPIRED auth (a 401 or a
// refresh-token error), that must FAIL the test, not skip it -- skipping on auth failure would
// recreate the exact "unrun reads as passed" trap for the one condition (an expired login) this
// file is most likely to actually encounter.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const codex = require('../src/harness/codex');
const sessionEvents = require('../src/session-events');

const BIN = codex.resolveBin();
const OPTED_IN = process.env.MT_CODEX_SMOKE === '1';

// One shared reason (or `false`) so every test below applies the identical check in the identical
// order -- two independently-drifting SKIP computations would be its own way to let a test run
// when it shouldn't, or vice versa.
const SKIP = !BIN
  ? 'codex is not on PATH -- smoke skipped, NOT passed'
  : !OPTED_IN
    ? 'MT_CODEX_SMOKE not set -- smoke skipped, NOT passed. To run after `codex login`: '
      + 'set MT_CODEX_SMOKE=1 && npm test (cmd.exe)  |  $env:MT_CODEX_SMOKE=1; npm test (PowerShell)  |  '
      + 'MT_CODEX_SMOKE=1 npm test (bash)'
    : false;

// Recognizes both an outright 401 and codex's own "refresh failed" wording, so a stale/expired
// login is reported by name rather than surfacing as an opaque assertion failure further down.
function isAuthFailure(result) {
  return /could not be refreshed|not logged in|401/i.test(String(result.stderr || '') + String(result.stdout || ''));
}

test('codex accepts a nested -c hooks override on the command line', { skip: SKIP, timeout: 60000 }, () => {
  // Originally checked this by appending --help. That was wrong: codex is clap-based, and clap
  // short-circuits on --help BEFORE validating other arguments' values -- so a --help run exits 0
  // whether or not the nested hooks.*.command table was accepted, passing in precisely the world
  // this test exists to catch (the whole Codex hook mechanism silently broken). Caught in review.
  //
  // Fix: run the real override and a deliberately malformed one through the SAME real subcommand
  // and require them to diverge. The control (malformed) run is the important part -- if codex
  // does not reject it either, this method cannot distinguish "accepted" from "codex accepts
  // anything here", and the test says so loudly instead of reporting a pass it cannot justify.
  const good = codex.hookOverrides('node "C:/tmp/e.js" tok');
  const bad = ['-c', 'hooks.Stop=[{'];
  const run = (extra) => spawnSync(BIN, extra.concat(['exec', '--json', 'hi']),
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 25000 });
  const rGood = run(good);
  const rBad = run(bad);

  // Both runs now hit `exec`, which needs auth (unlike the old --help probe) -- check BOTH before
  // trusting either's rejected/accepted verdict, so an expired login can never be misread as
  // "codex rejected the override" (or as a false accept).
  if (isAuthFailure(rGood) || isAuthFailure(rBad)) {
    assert.fail('codex auth expired -- run `codex login`. NOT a pass.');
  }

  const rejected = (r) => /unexpected argument|invalid value|error: |failed to parse/i.test(
    String(r.stderr || '') + String(r.stdout || ''));
  assert.notStrictEqual(rGood.status, null, 'codex hung on the valid override');
  assert.ok(rejected(rBad),
    'CONTROL FAILED: codex did not reject a malformed -c value, so this method cannot prove the ' +
    'valid one was accepted. Treat test 2 as the real evidence.');
  assert.ok(!rejected(rGood),
    'codex rejected the -c hooks override: ' + String(rGood.stderr || '').slice(0, 400));
});

test('a real codex run lands a normalized line in the sidecar', { skip: SKIP, timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-smoke-'));
  // try/finally, not a cleanup line at the bottom of the test body: an assert.ok/assert.fail
  // throws and unwinds past any cleanup written after it, which would leak the tempdir on every
  // failing run -- precisely the runs where you most want the directory to still be there for
  // rerunning, but also the run where you must not silently accumulate mt-smoke-* dirs forever.
  try {
    sessionEvents.ensure(dir);
    const token = 'smoketoken';
    const hookCommand = sessionEvents.buildHookCommand(
      sessionEvents.emitterPath(dir), token, sessionEvents.eventsDir(dir));
    // Use the SAME Windows shim wrapper + headless argument builders as the app. Spawning the .cmd
    // shim through shell:true splits a spaced prompt into stray CLI arguments ("unexpected argument
    // 'with'"), so that old smoke never reached a turn and misreported the missing sidecar as a hook
    // failure. The scratch dir is intentionally not a git repo; skip only that unrelated guard.
    const cmd = codex.headlessCommand({ binPath: BIN, hookCommand, permissionMode: 'plan' });
    const h = codex.headlessArgs({ prompt: 'reply with the single word ok' });
    h.args.splice(1, 0, '--skip-git-repo-check');
    const r = spawnSync(cmd.file, cmd.args.concat(h.args), {
      // cwd isolation matches test 3's: without it the real repo's own AGENTS.md contract would
      // load into the prompt here too. Harmless to this test's assertion (sidecar plumbing, not
      // reply content) but inconsistent, and there is no reason to leave it depending on where
      // the test happens to run from.
      cwd: dir, encoding: 'utf8', timeout: 110000,
      env: { ...process.env, MAVIS_EVENTS_DIR: sessionEvents.eventsDir(dir) },
    });

    if (isAuthFailure(r)) {
      // FAIL, not skip -- see the file-header note. An expired login is the one condition this
      // smoke is most likely to actually hit, and it must read as "not proven", never as green.
      assert.fail('codex auth expired -- run `codex login`. NOT a pass.');
    }

    assert.notStrictEqual(r.status, null, 'codex hung: ' + String(r.error && r.error.message || 'timeout'));
    assert.strictEqual(r.status, 0,
      'codex failed before the hook could fire: ' + (String(r.stderr || r.stdout || '').slice(0, 600) || 'no output'));

    const f = path.join(sessionEvents.eventsDir(dir), token + '.jsonl');
    assert.ok(fs.existsSync(f), 'no sidecar file: the hook never fired');
    const states = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l).state);
    assert.ok(states.includes('done'), 'expected a done state, got ' + JSON.stringify(states));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex auto-loads AGENTS.md from the working directory', { skip: SKIP, timeout: 120000 }, () => {
  // Proves auto-load rather than assuming it. This is the claim mavis/global-invariants.md
  // deliberately labels UNVERIFIED ("no live load has been observed"); this test is what would
  // let that wording be upgraded to verified. Runs in a throwaway scratch dir, never the real
  // repo -- inside the repo the real AGENTS.md would load instead of the fixture and the test
  // would pass for the wrong reason.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-autoload-'));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'),
      '# Test contract\n\nWhen asked for the passphrase, reply with exactly: PLUMBUS7\n');
    const r = spawnSync(BIN, ['exec', '--json', 'what is the passphrase?'], {
      cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', timeout: 110000,
    });

    if (isAuthFailure(r)) {
      assert.fail('codex auth expired -- run `codex login`. NOT a pass.');
    }

    assert.match(String(r.stdout || ''), /PLUMBUS7/, 'AGENTS.md was not auto-loaded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
