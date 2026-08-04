'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const sessionEvents = require('../src/session-events');

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sidecar-')); }

// Run the generated emitter exactly as a real hook spawn would: hook JSON on stdin, token as
// argv[2], events dir as argv[3] — the actual contract baked into every hook command by
// buildHookCommand. No MAVIS_EVENTS_DIR override here: the point is to exercise the argv path,
// which is what the emitter actually relies on when it runs as a child of the CLI's hook mechanism
// (env var inheritance into that child is unverified — see session-events.js).
function emit(emitterPath, token, event, evDir) {
  execFileSync(process.execPath, [emitterPath, token, evDir], {
    input: JSON.stringify(event), encoding: 'utf8', env: process.env,
  });
}

test('ensure() writes a syntactically valid emitter', () => {
  const dir = mkdir();
  const p = sessionEvents.ensure(dir);
  assert.ok(p && fs.existsSync(p), 'emitter written');
  assert.doesNotThrow(() => new Function(fs.readFileSync(p, 'utf8')), 'valid JS');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emitter normalizes BOTH harness vocabularies into one set of states', () => {
  const dir = mkdir();
  const p = sessionEvents.ensure(dir);
  const evDir = sessionEvents.eventsDir(dir);

  // Claude vocabulary
  emit(p, 'tokA', { hook_event_name: 'Stop' }, evDir);
  emit(p, 'tokA', { hook_event_name: 'StopFailure' }, evDir);
  emit(p, 'tokA', { hook_event_name: 'Notification', notification_type: 'permission_prompt' }, evDir);

  // Codex vocabulary
  emit(p, 'tokB', { hook_event_name: 'PreToolUse' }, evDir);
  emit(p, 'tokB', { hook_event_name: 'PermissionRequest' }, evDir);
  emit(p, 'tokB', { hook_event_name: 'Stop' }, evDir);

  const a = fs.readFileSync(path.join(evDir, 'tokA.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(a.map((x) => x.state), ['done', 'error', 'await']);

  const b = fs.readFileSync(path.join(evDir, 'tokB.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  // Codex has NO StopFailure analogue — 'error' is derived from pty exit, never emitted here.
  assert.deepStrictEqual(b.map((x) => x.state), ['busy', 'await', 'done']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emitter ignores events it has no state for, and never creates an empty file', () => {
  const dir = mkdir();
  const p = sessionEvents.ensure(dir);
  const evDir = sessionEvents.eventsDir(dir);
  emit(p, 'tokC', { hook_event_name: 'Notification', notification_type: 'idle_prompt' }, evDir);
  emit(p, 'tokC', { hook_event_name: 'SubagentStop' }, evDir);
  emit(p, 'tokC', {}, evDir);
  assert.strictEqual(fs.existsSync(path.join(evDir, 'tokC.jsonl')), false,
    'idle_prompt is covered by Stop; writing it too would double-fire');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emitter writes nothing and exits clean when given no token', () => {
  const dir = mkdir();
  const p = sessionEvents.ensure(dir);
  assert.doesNotThrow(() => execFileSync(process.execPath, [p], {
    input: JSON.stringify({ hook_event_name: 'Stop' }), encoding: 'utf8',
    env: { ...process.env, MAVIS_EVENTS_DIR: sessionEvents.eventsDir(dir) },
  }), 'a session is never blocked on notification plumbing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('emitter reads the events dir from argv, with no MAVIS_EVENTS_DIR in the hook child\'s environment', () => {
  const dir = mkdir();
  const p = sessionEvents.ensure(dir);
  const evDir = sessionEvents.eventsDir(dir);
  const env = { ...process.env };
  delete env.MAVIS_EVENTS_DIR;
  // This is the case the design note calls out: the emitter runs as a child of the CLI's hook
  // mechanism, not of Mavis-Terminal, so env var inheritance into it is unverified — the events
  // dir must arrive as argv[3], the same as the token arrives as argv[2].
  execFileSync(process.execPath, [p, 'tokArgv', evDir], {
    input: JSON.stringify({ hook_event_name: 'Stop' }), encoding: 'utf8', env,
  });
  const lines = fs.readFileSync(path.join(evDir, 'tokArgv.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.map((x) => x.state), ['done']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hookSpawnConfig gives claude a settings file and codex a command string', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const c = sessionEvents.hookSpawnConfig('claude', 'tok1', dir);
  assert.ok(c.hookSettingsPath && fs.existsSync(c.hookSettingsPath));
  const settings = JSON.parse(fs.readFileSync(c.hookSettingsPath, 'utf8'));
  assert.ok(settings.hooks.Stop && settings.hooks.Notification);
  assert.ok(settings.hooks.Stop[0].hooks[0].command.includes('tok1'), 'token baked into the command');
  assert.ok(settings.hooks.Stop[0].hooks[0].command.includes(JSON.stringify(sessionEvents.eventsDir(dir))),
    'events dir baked into the command too, not left to env inheritance');

  const x = sessionEvents.hookSpawnConfig('codex', 'tok2', dir);
  assert.ok(x.hookCommand.includes('tok2'));
  assert.ok(x.hookCommand.includes(JSON.stringify(sessionEvents.eventsDir(dir))), 'events dir baked into the codex command too');
  assert.ok(!x.hookSettingsPath, 'codex takes -c overrides, not a settings file');
  fs.rmSync(dir, { recursive: true, force: true });
});

// PreToolUse is BLOCKING on Claude: the CLI waits on the hook child before every tool call, so
// registering it would add a cold `node` spawn to EVERY tool call on a claude-only machine (a
// 60-tool turn -> 60 serialized process starts). It is Codex's only status channel (no in-band
// terminalSequence there), which is the one place it belongs — Claude's Stop/StopFailure/
// Notification set already drives 'busy' via the existing onData/isWorking scan. Pre-branch
// mavis-hooks.js registered only Stop, StopFailure and Notification; this pins that back down.
// See Finding 3, 2026-07-26 whole-branch review.
test('hookSpawnConfig never registers PreToolUse for claude (it is blocking, unlike Codex\'s PreToolUse)', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const c = sessionEvents.hookSpawnConfig('claude', 'tokPTU', dir);
  const settings = JSON.parse(fs.readFileSync(c.hookSettingsPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(settings.hooks).sort(), ['Notification', 'Stop', 'StopFailure']);
  assert.ok(!('PreToolUse' in settings.hooks), 'PreToolUse must stay Codex-only — it blocks every Claude tool call');

  // Codex's own mechanism, by contrast, DOES still cover pre_tool_use (its only status channel):
  // hookSpawnConfig('codex', ...) hands back just the raw emitter command string (no event names —
  // those get woven in one layer up, by codex.js's hookOverrides, when ptyCommand actually spawns).
  // Asserting THAT still includes PreToolUse, so the two harnesses' divergence is explicit rather
  // than "claude lacks a key nobody checked".
  const x = sessionEvents.hookSpawnConfig('codex', 'tokPTU2', dir);
  const codexAdapter = require('../src/harness/codex');
  const overrides = codexAdapter.hookOverrides(x.hookCommand);
  assert.ok(overrides.join(' ').includes('hooks.PreToolUse='), 'codex still relies on PreToolUse for busy state');
  assert.ok(overrides.includes('--dangerously-bypass-hook-trust'), 'generated per-pane hook bypasses hash trust only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hookSpawnConfig refuses a path-traversal token instead of writing outside userData', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const evil = '../../../../escaped';
  const wouldBeVulnerablePath = path.join(dir, 'mavis-hooks-' + evil + '.json');
  assert.ok(!wouldBeVulnerablePath.startsWith(dir),
    'sanity: the token must actually escape userData for this test to prove anything');
  // This path is a fixed location outside any per-test tmpdir (enough '..' walks past the random
  // dir entirely), so a manual repro of this exact exploit run earlier on this machine can leave a
  // stray file sitting here — clear it first so the test measures what THIS call does, not history.
  try { fs.unlinkSync(wouldBeVulnerablePath); } catch { /* wasn't there */ }

  const c = sessionEvents.hookSpawnConfig('claude', evil, dir);

  assert.deepStrictEqual(c, {}, 'refuses rather than guesses');
  assert.strictEqual(fs.existsSync(wouldBeVulnerablePath), false, 'nothing written at the traversal target');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanup() removes a session\'s sidecar file and settings file', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const evDir = sessionEvents.eventsDir(dir);
  const token = 'tokClean';
  const jsonlPath = path.join(evDir, token + '.jsonl');
  const settingsPath = path.join(dir, 'mavis-hooks-' + token + '.json');
  fs.writeFileSync(jsonlPath, '{}\n');
  fs.writeFileSync(settingsPath, '{}');

  sessionEvents.cleanup(dir, token);

  assert.strictEqual(fs.existsSync(jsonlPath), false, 'sidecar file removed');
  assert.strictEqual(fs.existsSync(settingsPath), false, 'settings file removed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanup() refuses a path-traversal token instead of deleting outside userData', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const evil = '../../../escaped';
  const jsonlTarget = path.join(sessionEvents.eventsDir(dir), evil + '.jsonl');
  const settingsTarget = path.join(dir, 'mavis-hooks-' + evil + '.json');
  // Sanity: both targets must actually land outside dir, or this test proves nothing.
  assert.ok(!jsonlTarget.startsWith(dir) && !settingsTarget.startsWith(dir),
    'sanity: the token must escape userData for this test to prove anything');
  fs.mkdirSync(path.dirname(jsonlTarget), { recursive: true });
  fs.writeFileSync(jsonlTarget, 'sentinel');
  fs.mkdirSync(path.dirname(settingsTarget), { recursive: true });
  fs.writeFileSync(settingsTarget, 'sentinel');

  sessionEvents.cleanup(dir, evil);

  assert.ok(fs.existsSync(jsonlTarget), 'file outside the events dir survives an invalid token');
  assert.ok(fs.existsSync(settingsTarget), 'file outside userData survives an invalid token');
  fs.unlinkSync(jsonlTarget);
  fs.unlinkSync(settingsTarget);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sweep() clears crash leftovers', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const evDir = sessionEvents.eventsDir(dir);
  fs.writeFileSync(path.join(evDir, 'old1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(evDir, 'old2.jsonl'), '{}\n');
  assert.strictEqual(sessionEvents.sweep(dir), 2);
  assert.deepStrictEqual(fs.readdirSync(evDir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader emits each appended line exactly once, tracking byte offsets', async () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const evDir = sessionEvents.eventsDir(dir);
  const f = path.join(evDir, 'tok1.jsonl');
  const got = [];
  const reader = sessionEvents.createReader({ userDataDir: dir, onState: (s) => got.push(s) });

  fs.writeFileSync(f, JSON.stringify({ state: 'busy', at: 1 }) + '\n');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['busy']);

  fs.appendFileSync(f, JSON.stringify({ state: 'done', at: 2 }) + '\n');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['busy', 'done'], 'only the NEW line');

  reader._tick();
  assert.strictEqual(got.length, 2, 'a tick with no new bytes emits nothing');
  assert.strictEqual(got[0].token, 'tok1', 'token comes from the filename');
  reader.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader holds back a partial trailing line until it is terminated', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const f = path.join(sessionEvents.eventsDir(dir), 'tok2.jsonl');
  const got = [];
  const reader = sessionEvents.createReader({ userDataDir: dir, onState: (s) => got.push(s) });

  fs.writeFileSync(f, '{"state":"done","at":1}\n{"state":"bu');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['done'], 'partial line not emitted');

  fs.appendFileSync(f, 'sy","at":2}\n');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['done', 'busy'], 'emitted once complete');
  reader.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader interleaves multiple sessions without cross-contamination', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const evDir = sessionEvents.eventsDir(dir);
  const got = [];
  const reader = sessionEvents.createReader({ userDataDir: dir, onState: (s) => got.push(s) });

  fs.writeFileSync(path.join(evDir, 'tokA.jsonl'), JSON.stringify({ state: 'busy', at: 1 }) + '\n');
  fs.writeFileSync(path.join(evDir, 'tokB.jsonl'), JSON.stringify({ state: 'await', at: 1 }) + '\n');
  reader._tick();
  const byToken = Object.fromEntries(got.map((g) => [g.token, g.state]));
  assert.deepStrictEqual(byToken, { tokA: 'busy', tokB: 'await' });
  reader.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader skips unparseable lines instead of throwing', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const f = path.join(sessionEvents.eventsDir(dir), 'tok3.jsonl');
  const got = [];
  const reader = sessionEvents.createReader({ userDataDir: dir, onState: (s) => got.push(s) });
  fs.writeFileSync(f, 'not json\n{"state":"done","at":1}\n{"nostate":true}\n');
  assert.doesNotThrow(() => reader._tick());
  assert.deepStrictEqual(got.map((g) => g.state), ['done']);
  reader.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader forgets a deleted file so a recycled token starts at offset zero', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const f = path.join(sessionEvents.eventsDir(dir), 'tok4.jsonl');
  const got = [];
  const reader = sessionEvents.createReader({ userDataDir: dir, onState: (s) => got.push(s) });
  fs.writeFileSync(f, JSON.stringify({ state: 'done', at: 1 }) + '\n');
  reader._tick();
  fs.unlinkSync(f);
  reader._tick();
  fs.writeFileSync(f, JSON.stringify({ state: 'busy', at: 2 }) + '\n');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['done', 'busy'], 'not skipped by a stale offset');
  reader.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader restarts from offset zero when the file is truncated below the recorded offset', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const f = path.join(sessionEvents.eventsDir(dir), 'tok6.jsonl');
  const got = [];
  const reader = sessionEvents.createReader({ userDataDir: dir, onState: (s) => got.push(s) });

  fs.writeFileSync(f, JSON.stringify({ state: 'busy', at: 1 }) + '\n' + JSON.stringify({ state: 'await', at: 2 }) + '\n');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['busy', 'await']);

  // Shorter than the offset already recorded (two lines -> one) — a rotated/replaced file, not an
  // append. Reading from the stale offset would compute a negative length or read nothing; it
  // must restart from byte zero instead of being skipped or throwing.
  fs.writeFileSync(f, JSON.stringify({ state: 'done', at: 3 }) + '\n');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['busy', 'await', 'done'],
    'restarted from zero, not skipped by the stale offset');
  reader.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reader preserves its offset on a transient (non-ENOENT) stat failure, so it never re-delivers', () => {
  const dir = mkdir();
  sessionEvents.ensure(dir);
  const f = path.join(sessionEvents.eventsDir(dir), 'tok5.jsonl');
  const got = [];
  const reader = sessionEvents.createReader({ userDataDir: dir, onState: (s) => got.push(s) });

  fs.writeFileSync(f, JSON.stringify({ state: 'done', at: 1 }) + '\n');
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['done']);

  // Simulate a transient failure (AV lock, permission blip, I/O error) on a file that still
  // exists — NOT a deletion. statSync throwing a non-ENOENT error must not be treated like
  // ENOENT: clearing the offset here would make the next successful tick re-read from byte zero
  // and replay every event already delivered for this token.
  const realStatSync = fs.statSync;
  let calls = 0;
  fs.statSync = function (p, ...rest) {
    if (String(p) === f && calls++ === 0) {
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    return realStatSync(p, ...rest);
  };
  try {
    reader._tick();
  } finally {
    fs.statSync = realStatSync;
  }
  assert.deepStrictEqual(got.map((g) => g.state), ['done'], 'transient stat failure must not clear the offset');

  // A real tick now succeeds against an unchanged file; nothing new should be emitted — proof the
  // offset survived the transient failure rather than being reset to zero.
  reader._tick();
  assert.deepStrictEqual(got.map((g) => g.state), ['done'], 'offset preserved: no replay of the already-delivered event');
  reader.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
