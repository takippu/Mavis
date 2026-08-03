'use strict';

const test = require('node:test');
const assert = require('node:assert');
const codex = require('../src/harness/codex');

test('ptyCommand wraps the .cmd shim exactly like claude does', () => {
  const c = codex.ptyCommand({ binPath: 'C:/npm/codex.cmd', permissionMode: 'default' });
  assert.match(c.file, /cmd\.exe$/i);
  assert.deepStrictEqual(c.args.slice(0, 2), ['/c', 'C:/npm/codex.cmd']);
});

test('ptyCommand runs a real .exe directly', () => {
  const c = codex.ptyCommand({ binPath: 'C:/tools/codex.exe', permissionMode: 'default' });
  assert.strictEqual(c.file, 'C:/tools/codex.exe');
});

test('resolveBin selects .cmd shim from where codex output (Windows preference)', () => {
  // Simulate `where codex` output: extension-less shim first, then .cmd — pick .cmd
  const { pickBinLine } = require('../src/harness/claude');
  const output = ['C:/npm/codex', 'C:/npm/codex.cmd'];
  const picked = pickBinLine(output, 'win32');
  assert.strictEqual(picked, 'C:/npm/codex.cmd', 'prefers .cmd over bare shim');
});

test('permissionArgs maps the four Mavis modes onto sandbox + approval policy', () => {
  assert.deepStrictEqual(codex.permissionArgs('default'),
    ['--sandbox', 'workspace-write', '--approval-policy', 'on-request']);
  assert.deepStrictEqual(codex.permissionArgs('acceptEdits'),
    ['--sandbox', 'workspace-write', '--approval-policy', 'on-failure']);
  assert.deepStrictEqual(codex.permissionArgs('plan'),
    ['--sandbox', 'read-only', '--approval-policy', 'untrusted']);
  assert.deepStrictEqual(codex.permissionArgs('yolo'),
    ['--dangerously-bypass-approvals-and-sandbox']);
});

test('permissionArgs rejects auto and unknown values back to default', () => {
  assert.deepStrictEqual(codex.permissionArgs('auto'), codex.permissionArgs('default'));
  assert.deepStrictEqual(codex.permissionArgs('nonsense'), codex.permissionArgs('default'));
});

test('ptyCommand injects hook config via -c overrides, not a project-local config file', () => {
  const c = codex.ptyCommand({ binPath: 'c.exe', permissionMode: 'default', hookCommand: 'node "C:/u/e.js" tok' });
  const i = c.args.indexOf('-c');
  assert.ok(i >= 0, 'uses a -c override');
  // -c overrides are user-supplied and therefore NOT subject to the project trust gate, which is
  // the entire reason we do not write a project-local .codex/config.toml.
  assert.match(c.args[i + 1], /^hooks\./, 'override targets the hooks table');
  assert.ok(c.args[i + 1].includes('e.js'), 'carries the emitter command');
});

test('headlessCommand reuses ptyCommand UNCHANGED — codex still needs sandbox/approval flags headlessly (Finding 1, 2026-07-26 review, deliberately not touched)', () => {
  const h = codex.headlessCommand({ binPath: 'c.exe', permissionMode: 'plan' });
  const p = codex.ptyCommand({ binPath: 'c.exe', permissionMode: 'plan' });
  assert.deepStrictEqual(h, p, 'headlessCommand delegates straight to ptyCommand, no divergence');
  assert.deepStrictEqual(h.args, ['--sandbox', 'read-only', '--approval-policy', 'untrusted']);
});

test('headlessArgs passes the prompt as a positional arg, not stdin', () => {
  const first = codex.headlessArgs({ prompt: 'hi' });
  assert.deepStrictEqual(first.args.slice(0, 2), ['exec', '--json']);
  assert.ok(first.args.includes('hi'), 'prompt is positional');
  assert.strictEqual(first.stdin, null, 'codex exec takes no stdin prompt');
  assert.strictEqual(first.streaming, true, 'emits JSONL, parsed line by line');
});

test('headlessArgs resumes by server-assigned id', () => {
  const next = codex.headlessArgs({ prompt: 'again', sessionId: 'thr_123', resume: true });
  assert.deepStrictEqual(next.args.slice(0, 4), ['exec', 'resume', 'thr_123', '--json']);
  assert.ok(next.args.includes('again'));
});

test('headlessArgs falls back to a single-turn run when no session id was ever assigned', () => {
  const next = codex.headlessArgs({ prompt: 'again', sessionId: null, resume: true });
  assert.deepStrictEqual(next.args.slice(0, 2), ['exec', '--json'], 'no resume without an id, no crash');
});

test('a resume with no assigned id degrades to a fresh run rather than throwing', () => {
  assert.doesNotThrow(() => codex.headlessArgs({ prompt: 'x', sessionId: undefined, resume: true }));
  const a = codex.headlessArgs({ prompt: 'x', sessionId: undefined, resume: true });
  assert.ok(!a.args.includes('resume'), 'no resume subcommand without an id');
});

test('parseEvent understands the observed exec --json vocabulary', () => {
  const started = codex.parseEvent(JSON.stringify({ type: 'thread.started', thread_id: 'thr_9' }));
  assert.strictEqual(started.type, 'thread.started');
  assert.strictEqual(started.sessionId, 'thr_9');

  const failed = codex.parseEvent(JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } }));
  assert.strictEqual(failed.isError, true);
  assert.strictEqual(failed.text, 'nope');

  const err = codex.parseEvent(JSON.stringify({ type: 'error', message: 'boom' }));
  assert.strictEqual(err.isError, true);
  assert.strictEqual(err.text, 'boom');
});

test('parseEvent ignores unknown event types and junk without throwing', () => {
  const unknown = codex.parseEvent(JSON.stringify({ type: 'turn.started' }));
  assert.strictEqual(unknown.type, 'turn.started');
  assert.strictEqual(unknown.isError, false);
  assert.strictEqual(codex.parseEvent('half a line {'), null);
  assert.strictEqual(codex.parseEvent(''), null);
});

test('sessionIdFrom captures the SERVER-assigned id and ignores ours', () => {
  const parsed = codex.parseEvent(JSON.stringify({ type: 'thread.started', thread_id: 'thr_9' }));
  assert.strictEqual(codex.sessionIdFrom(parsed, 'our-uuid'), 'thr_9');
  const other = codex.parseEvent(JSON.stringify({ type: 'turn.started' }));
  assert.strictEqual(codex.sessionIdFrom(other, 'our-uuid'), null, 'only thread.started assigns');
});
