// Tests for the context injectors.
//
// Two things are being pinned here, and they pull in opposite directions.
//
// The first is that the hook NEVER breaks a turn. It runs on the user's prompt path, so a throw,
// a hang or a non-zero exit costs the user their message. Every degenerate input therefore has a
// test: no directory, no file, an empty file, a directory where a file should be, a file with a
// hostile name. All of them must produce silence, not an error.
//
// The second is that it never quietly grows. Per-turn context is paid on every turn of every
// session forever, so the character cap is the feature, not a safety valve -- a state file edited
// by hand (which never passes through the CLI's own clamp) must still be unable to blow the
// budget. The truncation tests assert an exact ceiling, not an approximate one.
//
// Name sanitisation gets its own block because these names become filenames. `../../etc/passwd`
// must not escape, in either direction: not on write, and not on read either, since a hostile
// name can also arrive as a file dropped into the directory by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  INJECT_DIR,
  MAX_CONTEXT_CHARS,
  TRUNCATION_NOTICE,
  buildContext,
  clearState,
  estimateTokens,
  injectDir,
  listInjectors,
  normalizeValue,
  readState,
  sanitizeName,
  stateFile,
  writeState,
} from '../lib/injector-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(here));

// A throwaway brain root. Only the injector directory matters, so there is nothing else to seed.
function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-inject-'));
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

function put(root, relName, body) {
  const dir = path.join(root, INJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, relName), body);
}

// ---- emission ----

test('a set injector is emitted as an uppercased NAME: value line', () => {
  const root = makeRoot();
  try {
    writeState(root, 'tone', 'terse, no preamble');
    const built = buildContext(listInjectors(root));
    assert.equal(built.text, 'TONE: terse, no preamble');
    assert.equal(built.truncated, false);
  } finally {
    rm(root);
  }
});

test('several injectors emit one line each, in a stable alphabetical order', () => {
  const root = makeRoot();
  try {
    // Written out of order on purpose: the emitted block must not depend on filesystem or write
    // order, or the prefix on every user message churns turn to turn.
    writeState(root, 'tone', 'terse');
    writeState(root, 'focus', 'the payments migration');
    writeState(root, 'mood', 'heads-down');
    const built = buildContext(listInjectors(root));
    assert.equal(built.text, 'FOCUS: the payments migration\nMOOD: heads-down\nTONE: terse');
    assert.equal(built.text.split('\n').length, 3);
  } finally {
    rm(root);
  }
});

test('emission carries no header, framing or preamble -- only the state lines', () => {
  // Pinned deliberately. Any framing sentence is a fixed cost on every turn forever, and the
  // temptation to add "The following is the current state:" is exactly what this asserts against.
  const built = buildContext([{ name: 'focus', value: 'shipping the injector' }]);
  assert.equal(built.text, 'FOCUS: shipping the injector');
});

test('the reported token cost is the emitted characters over four', () => {
  const built = buildContext([{ name: 'tone', value: 'terse' }]);
  assert.equal(built.chars, 'TONE: terse'.length);
  assert.equal(built.tokens, estimateTokens(built.chars));
  assert.equal(estimateTokens(400), 100);
});

// ---- nothing set / degenerate state ----

test('a missing injector directory emits nothing and does not throw', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(listInjectors(root), []);
    assert.equal(buildContext(listInjectors(root)).text, '');
  } finally {
    rm(root);
  }
});

test('a missing state file reads as empty', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(injectDir(root), { recursive: true });
    assert.equal(readState(root, 'tone'), '');
  } finally {
    rm(root);
  }
});

test('an empty or whitespace-only state file means unset, not a blank line', () => {
  const root = makeRoot();
  try {
    put(root, 'tone.txt', '');
    put(root, 'mood.txt', '   \n\n  ');
    put(root, 'focus.txt', 'the only real one\n');
    const names = listInjectors(root).map((e) => e.name);
    assert.deepEqual(names, ['focus']);
    assert.equal(buildContext(listInjectors(root)).text, 'FOCUS: the only real one');
  } finally {
    rm(root);
  }
});

test('a directory where a state file should be is skipped, not read', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, INJECT_DIR, 'tone.txt'), { recursive: true });
    put(root, 'focus.txt', 'still fine');
    assert.equal(readState(root, 'tone'), '');
    assert.deepEqual(listInjectors(root).map((e) => e.name), ['focus']);
  } finally {
    rm(root);
  }
});

test('a non-.txt file in the directory is ignored', () => {
  const root = makeRoot();
  try {
    put(root, 'notes.md', 'this is not an injector');
    put(root, 'tone.txt', 'terse');
    assert.deepEqual(listInjectors(root).map((e) => e.name), ['tone']);
  } finally {
    rm(root);
  }
});

test('one unreadable injector does not take the others down with it', () => {
  // The fail-open promise is per-file, not just per-run: a single corrupt state file must degrade
  // to that one line missing, never to a thrown hook.
  const root = makeRoot();
  try {
    put(root, 'tone.txt', 'terse');
    fs.mkdirSync(path.join(root, INJECT_DIR, 'broken.txt'), { recursive: true });
    const built = buildContext(listInjectors(root));
    assert.equal(built.text, 'TONE: terse');
  } finally {
    rm(root);
  }
});

// ---- the character cap ----

test('the emitted total never exceeds the cap, and says so when it bites', () => {
  const root = makeRoot();
  try {
    // Five files, each near the cap on its own, all written by hand rather than through the CLI
    // so its write-time clamp is bypassed entirely. This is the hand-edited-file case.
    for (const n of ['aaa', 'bbb', 'ccc', 'ddd', 'eee']) put(root, `${n}.txt`, 'x'.repeat(300));
    const built = buildContext(listInjectors(root));
    assert.equal(built.truncated, true);
    assert.equal(built.chars, MAX_CONTEXT_CHARS, 'the cap is exact, not approximate');
    assert.ok(built.text.endsWith(TRUNCATION_NOTICE), 'truncation is announced, never silent');
    assert.ok(built.dropped > 0, 'the count of dropped lines is reported');
  } finally {
    rm(root);
  }
});

test('a single pathological state file cannot blow the per-turn budget', () => {
  const root = makeRoot();
  try {
    put(root, 'tone.txt', 'y'.repeat(500000));
    const built = buildContext(listInjectors(root));
    assert.ok(built.chars <= MAX_CONTEXT_CHARS, `emitted ${built.chars} chars`);
    assert.equal(built.truncated, true);
  } finally {
    rm(root);
  }
});

test('a cap too small to hold the truncation notice still caps hard', () => {
  const built = buildContext([{ name: 'tone', value: 'a'.repeat(100) }], 8);
  assert.equal(built.chars, 8);
});

test('content exactly at the cap is not truncated', () => {
  // Off-by-one guard: the cap is a ceiling that may be reached, not one that must be undercut.
  const value = 'z'.repeat(MAX_CONTEXT_CHARS - 'TONE: '.length);
  const built = buildContext([{ name: 'tone', value }]);
  assert.equal(built.chars, MAX_CONTEXT_CHARS);
  assert.equal(built.truncated, false);
});

// ---- one line each ----

test('a multi-line value collapses to one line instead of being cut at the first newline', () => {
  // Cutting at the first newline would be silent data loss; smuggling the newline through would
  // break the one-line-per-injector contract the emitted block depends on.
  assert.equal(normalizeValue('first\nsecond\r\nthird'), 'first second third');
  const root = makeRoot();
  try {
    put(root, 'focus.txt', 'line one\nline two\n');
    assert.equal(readState(root, 'focus'), 'line one line two');
    assert.equal(buildContext(listInjectors(root)).text.split('\n').length, 1);
  } finally {
    rm(root);
  }
});

test('control characters are stripped from a value', () => {
  // These reach a JSON hook payload and then a prompt. An embedded NUL or ESC has no business
  // in either, and building them with fromCharCode keeps this source file plain ASCII -- a
  // literal control character in source is invisible in a diff and in review.
  const NUL = String.fromCharCode(0);
  const ESC = String.fromCharCode(27);
  const clean = normalizeValue(`terse${NUL}and${ESC}[31m blunt`);
  assert.equal(clean, 'terse and [31m blunt');
  assert.ok(!new RegExp('[\\u0000-\\u001f\\u007f]').test(clean));
});

// ---- name sanitisation ----

test('a traversal name is rejected outright rather than sanitised into something', () => {
  const root = makeRoot();
  try {
    for (const bad of ['../../etc/passwd', '..', '.', 'a/b', 'a\\b', '.hidden', '-flag', '', '   ', 'a'.repeat(40)]) {
      assert.equal(sanitizeName(bad), null, `sanitizeName rejects ${JSON.stringify(bad)}`);
      assert.equal(stateFile(root, bad), null, `stateFile refuses ${JSON.stringify(bad)}`);
      assert.throws(() => writeState(root, bad, 'x'), `writeState refuses ${JSON.stringify(bad)}`);
    }
    // And nothing was created anywhere near the brain root while trying.
    assert.equal(fs.existsSync(path.join(root, INJECT_DIR)), false);
  } finally {
    rm(root);
  }
});

test('a state file with a hostile name on disk is skipped by the reader', () => {
  // The write path is not the only way a name arrives -- a file can be dropped in by hand, by a
  // sync tool, or by an archive extraction.
  const root = makeRoot();
  try {
    put(root, '..evil.txt', 'should never be emitted');
    put(root, '-flag.txt', 'nor this');
    put(root, 'tone.txt', 'terse');
    const built = buildContext(listInjectors(root));
    assert.equal(built.text, 'TONE: terse');
    assert.ok(!built.text.includes('evil'));
  } finally {
    rm(root);
  }
});

test('names are case-folded so TONE and tone are one injector, not two', () => {
  const root = makeRoot();
  try {
    writeState(root, 'TONE', 'first');
    writeState(root, 'tone', 'second');
    const entries = listInjectors(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, 'second');
    assert.equal(buildContext(entries).text, 'TONE: second');
  } finally {
    rm(root);
  }
});

test('a state file is written inside the injector directory and nowhere else', () => {
  const root = makeRoot();
  try {
    const { file } = writeState(root, 'focus', 'the payments migration');
    assert.equal(path.dirname(file), injectDir(root));
    assert.equal(path.basename(file), 'focus.txt');
  } finally {
    rm(root);
  }
});

// ---- clearing ----

test('clear removes an injector and clearing an unset one is not an error', () => {
  const root = makeRoot();
  try {
    writeState(root, 'tone', 'terse');
    assert.equal(clearState(root, 'tone'), true);
    assert.equal(readState(root, 'tone'), '');
    assert.equal(clearState(root, 'tone'), false, 'absent is a no-op, not a failure');
    assert.throws(() => clearState(root, '../../etc/passwd'));
  } finally {
    rm(root);
  }
});

// ---- the hook end to end ----

// The hook resolves its brain root from its own location, so it always reads the REAL repo's
// .mavis-inject/. These tests therefore run against the repo and are careful to leave it exactly
// as they found it -- including not creating the directory if it was not already there.
function runHook(dir, stdin = '{"hook_event_name":"UserPromptSubmit","prompt":"hello"}') {
  return execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'hooks', 'inject-context.mjs')], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, MAVIS_INJECT_DIR: dir },
  });
}

// Every subprocess test below runs against an ISOLATED directory, never the live
// `.mavis-inject/`. The earlier version drove the real one and asserted it was empty first, which
// turned "the user set an injector" into five red tests. A guard that fails is still a broken
// suite; isolation is the actual fix.
function withRepoInjector(entries, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-inject-'));
  try {
    for (const [name, value] of Object.entries(entries)) fs.writeFileSync(path.join(dir, `${name}.txt`), value);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the hook emits the Claude Code / Codex hook JSON shape', () => {
  const out = withRepoInjector({ tone: 'terse, no preamble\n' }, (d) => runHook(d));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'TONE: terse, no preamble');
});

test('the hook emits absolutely nothing when no injector is set', () => {
  const out = withRepoInjector({}, (d) => runHook(d));
  assert.equal(out, '', 'an empty additionalContext still costs JSON framing on every turn');
});

test('the hook exits 0 and stays silent on garbage stdin', () => {
  // A harness that changes its payload shape, or passes none at all, must not cost a turn.
  const out = withRepoInjector({}, (d) => runHook(d, 'not json at all {{{'));
  assert.equal(out, '');
  const out2 = withRepoInjector({ focus: 'shipping\n' }, (d) => runHook(d, ''));
  assert.equal(JSON.parse(out2).hookSpecificOutput.additionalContext, 'FOCUS: shipping');
});

test('the hook never lets an injector exceed the per-turn cap', () => {
  const out = withRepoInjector({ tone: 'q'.repeat(5000) }, (d) => runHook(d));
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= MAX_CONTEXT_CHARS, `hook emitted ${ctx.length} chars`);
  assert.ok(ctx.endsWith(TRUNCATION_NOTICE));
});

// ---- the CLI ----

function runCli(args, dir) {
  return execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'inject.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, MAVIS_INJECT_DIR: dir },
  });
}

test('the CLI round-trips set / list / cost / clear in an isolated directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-inject-cli-'));
  try {
    const set = runCli(['set', 'focus', 'the', 'payments', 'migration'], dir);
    assert.match(set, /FOCUS: the payments migration/);
    assert.match(set, /tokens on every turn/, 'setting an injector states its per-turn cost');

    assert.match(runCli(['list'], dir), /FOCUS\s+the payments migration/);
    const cost = runCli(['cost'], dir);
    assert.match(cost, /~\d+ tokens/);
    assert.match(cost, /FOCUS: the payments migration/);

    assert.match(runCli(['clear', 'focus'], dir), /cleared FOCUS/);
    assert.match(runCli(['list'], dir), /No injectors set/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI rejects a traversal name with a non-zero exit', () => {
  assert.throws(
    () => runCli(['set', '../../etc/passwd', 'pwned']),
    (err) => /invalid injector name/.test(String(err.stderr || '')),
  );
  assert.equal(fs.existsSync(path.join(repoRoot, '..', '..', 'etc', 'passwd.txt')), false);
});

test('an unknown CLI command exits non-zero with usage', () => {
  assert.throws(
    () => runCli(['frobnicate']),
    (err) => err.status === 1 && /unknown command/.test(String(err.stderr || '')),
  );
});

// ---- the isolation the live-state failure taught ----
//
// These five subprocess tests originally drove the real `.mavis-inject/` and asserted it was empty
// first. That guard turned "the user set an injector" into five red tests within the hour of the
// feature going in. A guard that FAILS is still a broken suite; isolation is the fix, and the
// override that makes isolation possible needs the same absolute-path discipline as the
// observation system's, for the same reason.

test('MAVIS_INJECT_DIR honours an absolute override and ignores anything else', () => {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-inject-res-'));
  const fallback = path.join(brain, INJECT_DIR);
  try {
    for (const bad of [undefined, null, '', 'undefined', 'relative/dir', './here', '..']) {
      assert.equal(injectDir(brain, bad), fallback, `override ${JSON.stringify(bad)} must fall back`);
    }
    const good = path.join(os.tmpdir(), 'mavis-inject-explicit');
    assert.equal(injectDir(brain, good), good, 'an absolute override is honoured');
  } finally {
    fs.rmSync(brain, { recursive: true, force: true });
  }
});

test('the live .mavis-inject/ is never touched by the suite', () => {
  // The regression in one assertion: whatever the user has set stays set.
  const live = injectDir(repoRoot, null);
  const before = fs.existsSync(live) ? fs.readdirSync(live).sort() : null;
  withRepoInjector({ tone: 'scratch\n' }, (d) => runHook(d));
  const after = fs.existsSync(live) ? fs.readdirSync(live).sort() : null;
  assert.deepEqual(after, before, 'running the suite must not add, remove or alter live injectors');
});
