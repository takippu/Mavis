'use strict';

// Composes the exact command line brain-chat.js's and dailyops-agent.js's runTurn() build for a
// headless turn: `cmd.args.concat(h.args)` where `cmd = adapter.headlessCommand({ binPath,
// permissionMode: 'plan' })` and `h = adapter.headlessArgs({...})`. Pure composition only — no
// process spawning, no CLI execution (forbidden in this environment); this mirrors runTurn's own
// two lines rather than importing brain-chat.js/dailyops-agent.js, because those modules spawn a
// real child on the first call with no injection seam.
//
// This test exists BECAUSE none did before: the 2026-07-26 whole-branch review found brain-chat.js
// and dailyops-agent.js routing their headless spawn through ptyCommand (the INTERACTIVE TUI arg
// builder), which unconditionally appends --permission-mode. That silently forced Claude into plan
// mode on every headless turn (DailyOps generate, Ask Mavis) — plan mode's system prompt requires
// proposing a plan via ExitPlanMode, a tool absent from the headless --allowedTools, so the reply
// never carried a parseable result. No test asserted the composed command line, so the regression
// reached the final review gate undetected. See Finding 1.

const test = require('node:test');
const assert = require('node:assert');
const claude = require('../src/harness/claude');
const codex = require('../src/harness/codex');

test('claude headless command line: no --permission-mode (the substance of the fix)', () => {
  const h = claude.headlessArgs({ prompt: 'hi', sessionId: 'abc-123', resume: false, allowedTools: 'Read,Glob,Grep' });
  const cmd = claude.headlessCommand({ binPath: 'C:/npm/claude.cmd', permissionMode: 'plan' });
  const args = cmd.args.concat(h.args);

  // Pre-branch (git show ed5a413:terminal-app/src/brain-chat.js): the composed spawn was
  // `cmd.exe /c claude -p --session-id <uuid> --output-format json --allowedTools Read,Glob,Grep`
  // — no permission flag at all, via a hand-built argv that never resolved a binary path (it
  // trusted cmd.exe's own PATHEXT lookup of the literal word `claude`). Post-fix goes through the
  // same resolveBin()+headlessCommand() plumbing the interactive path already used, so for a
  // .cmd-resolved install the `/c` arg below is the RESOLVED PATH, not the literal word `claude` —
  // functionally equivalent to pre-branch, not textually identical. What IS identical, and is what
  // this test actually exists to prove, is that no --permission-mode/plan reaches the line at all.
  assert.match(cmd.file, /cmd\.exe$/i);
  assert.deepStrictEqual(args, [
    '/c', 'C:/npm/claude.cmd',
    '-p', '--session-id', 'abc-123', '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep',
  ]);
  assert.ok(!args.includes('--permission-mode'), 'headless Claude must never carry a permission flag');
  assert.ok(!args.includes('plan'), 'plan mode must never reach the headless command line');
});

test('claude headless command line on --resume carries no permission flag either', () => {
  const h = claude.headlessArgs({ prompt: 'again', sessionId: 'abc-123', resume: true, allowedTools: 'Read,Glob,Grep' });
  const cmd = claude.headlessCommand({ binPath: 'C:/tools/claude.exe', permissionMode: 'plan' });
  const args = cmd.args.concat(h.args);
  assert.strictEqual(cmd.file, 'C:/tools/claude.exe', 'a real .exe spawns directly, no cmd.exe wrapper');
  assert.deepStrictEqual(args, ['-p', '--resume', 'abc-123', '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep']);
  assert.ok(!args.includes('--permission-mode'));
});

test('codex headless command line: sandbox/approval flags UNCHANGED (Finding 1 says do not touch this mapping)', () => {
  const h = codex.headlessArgs({ prompt: 'hi' });
  const cmd = codex.headlessCommand({ binPath: 'C:/npm/codex.cmd', permissionMode: 'plan' });
  const args = cmd.args.concat(h.args);

  assert.match(cmd.file, /cmd\.exe$/i);
  assert.deepStrictEqual(args, [
    '/c', 'C:/npm/codex.cmd',
    '--sandbox', 'read-only', '--approval-policy', 'untrusted',
    'exec', '--json', 'hi',
  ]);
});

test('codex headless resume carries the server-assigned thread id, sandbox flags still unchanged', () => {
  const h = codex.headlessArgs({ prompt: 'again', sessionId: 'thr_9', resume: true });
  const cmd = codex.headlessCommand({ binPath: 'C:/tools/codex.exe', permissionMode: 'plan' });
  const args = cmd.args.concat(h.args);
  assert.deepStrictEqual(args, [
    '--sandbox', 'read-only', '--approval-policy', 'untrusted',
    'exec', 'resume', 'thr_9', '--json', 'again',
  ]);
});
