'use strict';

const test = require('node:test');
const assert = require('node:assert');
const claude = require('../src/harness/claude');

test('ptyCommand wraps a .cmd shim through the shell', () => {
  const c = claude.ptyCommand({ binPath: 'C:/npm/claude.cmd', permissionMode: 'default' });
  assert.match(c.file, /cmd\.exe$/i);
  assert.deepStrictEqual(c.args.slice(0, 2), ['/c', 'C:/npm/claude.cmd']);
});

test('ptyCommand runs a real .exe directly', () => {
  const c = claude.ptyCommand({ binPath: 'C:/tools/claude.exe', permissionMode: 'default' });
  assert.strictEqual(c.file, 'C:/tools/claude.exe');
  assert.ok(!c.args.includes('/c'), 'no shell wrapper for a real exe');
});

test('ptyCommand maps permission modes, and yolo is the skip-all flag', () => {
  const def = claude.ptyCommand({ binPath: 'c.exe', permissionMode: 'default' });
  assert.deepStrictEqual(def.args, ['--permission-mode', 'default']);

  const plan = claude.ptyCommand({ binPath: 'c.exe', permissionMode: 'plan' });
  assert.deepStrictEqual(plan.args, ['--permission-mode', 'plan']);

  const yolo = claude.ptyCommand({ binPath: 'c.exe', permissionMode: 'yolo' });
  assert.deepStrictEqual(yolo.args, ['--dangerously-skip-permissions']);
});

test('ptyCommand rejects auto and unknown modes back to default (auto = dead-pane mode)', () => {
  const auto = claude.ptyCommand({ binPath: 'c.exe', permissionMode: 'auto' });
  assert.deepStrictEqual(auto.args, ['--permission-mode', 'default']);
  const junk = claude.ptyCommand({ binPath: 'c.exe', permissionMode: 'nonsense' });
  assert.deepStrictEqual(junk.args, ['--permission-mode', 'default']);
});

test('ptyCommand appends the hooks settings file when one is given', () => {
  const c = claude.ptyCommand({ binPath: 'c.exe', permissionMode: 'default', hookSettingsPath: 'C:/u/h.json' });
  const i = c.args.indexOf('--settings');
  assert.ok(i >= 0, 'passes --settings');
  assert.strictEqual(c.args[i + 1], 'C:/u/h.json');
});

test('headlessCommand carries NO permission flag, unlike ptyCommand (Finding 1, 2026-07-26 review)', () => {
  // headlessCommand is the binary-invocation-only builder for brain-chat.js/dailyops-agent.js.
  // Passing the same permissionMode ptyCommand would turn into --permission-mode must produce NO
  // such flag here — a headless `-p` turn has no TTY to gate, and forcing plan mode made Claude
  // require ExitPlanMode (not in --allowedTools), so a headless turn never returned a usable reply.
  const h = claude.headlessCommand({ binPath: 'c.exe', permissionMode: 'plan' });
  assert.deepStrictEqual(h.args, [], 'no --permission-mode, no --settings — just the binary');
  assert.ok(!h.args.includes('--permission-mode'));
});

test('headlessCommand wraps a .cmd shim through the shell exactly like ptyCommand does', () => {
  const h = claude.headlessCommand({ binPath: 'C:/npm/claude.cmd' });
  assert.match(h.file, /cmd\.exe$/i);
  assert.deepStrictEqual(h.args, ['/c', 'C:/npm/claude.cmd']);
});

test('headlessCommand runs a real .exe directly, no shell wrapper', () => {
  const h = claude.headlessCommand({ binPath: 'C:/tools/claude.exe' });
  assert.strictEqual(h.file, 'C:/tools/claude.exe');
  assert.deepStrictEqual(h.args, []);
});

test('headlessArgs uses --session-id on the first turn and --resume after', () => {
  const first = claude.headlessArgs({ prompt: 'hi', sessionId: 'abc', resume: false, allowedTools: 'Read,Glob,Grep' });
  assert.deepStrictEqual(first.args, ['-p', '--session-id', 'abc', '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep']);
  assert.strictEqual(first.stdin, 'hi', 'prompt goes on stdin');

  const next = claude.headlessArgs({ prompt: 'again', sessionId: 'abc', resume: true, allowedTools: 'Read,Glob,Grep' });
  assert.deepStrictEqual(next.args.slice(0, 3), ['-p', '--resume', 'abc']);
});

test('parseEvent reads the single JSON result object', () => {
  const ev = claude.parseEvent(JSON.stringify({ result: 'the answer', is_error: false, session_id: 'abc' }));
  assert.strictEqual(ev.text, 'the answer');
  assert.strictEqual(ev.isError, false);
  assert.strictEqual(ev.sessionId, 'abc');
});

test('parseEvent surfaces is_error and never throws on junk', () => {
  const bad = claude.parseEvent(JSON.stringify({ result: 'rate limited', is_error: true }));
  assert.strictEqual(bad.isError, true);
  assert.strictEqual(claude.parseEvent('not json'), null);
  assert.strictEqual(claude.parseEvent(''), null);
});

test('sessionIdFrom echoes the id we supplied (Claude ids are client-supplied)', () => {
  assert.strictEqual(claude.sessionIdFrom({ sessionId: 'abc' }, 'abc'), 'abc');
  assert.strictEqual(claude.sessionIdFrom(null, 'abc'), 'abc', 'falls back to ours when the reply omits it');
});

test('pickBinLine on win32: .cmd wins when extension-less shim is listed first', () => {
  const lines = ['C:/npm/claude', 'C:/npm/claude.cmd'];
  assert.strictEqual(claude.pickBinLine(lines, 'win32'), 'C:/npm/claude.cmd');
});

test('pickBinLine on win32: .exe is preferred when there is no .cmd', () => {
  const lines = ['C:/npm/claude', 'C:/tools/claude.exe'];
  assert.strictEqual(claude.pickBinLine(lines, 'win32'), 'C:/tools/claude.exe');
});

test('pickBinLine on win32: .bat is preferred when there is neither .cmd nor .exe', () => {
  const lines = ['C:/npm/claude', 'C:/tools/claude.bat'];
  assert.strictEqual(claude.pickBinLine(lines, 'win32'), 'C:/tools/claude.bat');
});

test('pickBinLine on win32: falls back to first line when none of the preferred extensions are present', () => {
  const lines = ['C:/npm/claude'];
  assert.strictEqual(claude.pickBinLine(lines, 'win32'), 'C:/npm/claude');
});

test('pickBinLine on non-win32: first line wins, no extension preference', () => {
  const lines = ['/usr/local/bin/claude', '/usr/bin/claude.cmd'];
  assert.strictEqual(claude.pickBinLine(lines, 'linux'), '/usr/local/bin/claude');
});

test('pickBinLine returns null for empty list or null input', () => {
  assert.strictEqual(claude.pickBinLine([], 'win32'), null);
  assert.strictEqual(claude.pickBinLine(null, 'win32'), null);
});

test('pty-session exports the harness-generic spawners (session-manager defaults _spawn to startAgentPty)', () => {
  const ps = require('../src/pty-session');
  assert.strictEqual(typeof ps.startAgentPty, 'function');
  assert.strictEqual(typeof ps.startShellPty, 'function');
  // startClaudePty / resolveClaude were Claude-only wrappers pty-session.js carried before Task 4
  // generalized spawning to startAgentPty(harness). Neither had a production caller left afterward —
  // this was their only test, and it merely asserted the symbol existed rather than exercising any
  // behaviour — so both were deleted rather than kept with a corrected comment. See Finding 4,
  // 2026-07-26 whole-branch review.
  assert.strictEqual(ps.startClaudePty, undefined, 'deleted dead code stays deleted');
  assert.strictEqual(ps.resolveClaude, undefined, 'deleted dead code stays deleted');
});
