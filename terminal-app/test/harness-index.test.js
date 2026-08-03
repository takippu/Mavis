'use strict';

const test = require('node:test');
const assert = require('node:assert');
const harness = require('../src/harness');

test('normalizeId defaults anything unrecognised to claude', () => {
  assert.strictEqual(harness.normalizeId('claude'), 'claude');
  assert.strictEqual(harness.normalizeId('codex'), 'codex');
  assert.strictEqual(harness.normalizeId('CODEX'), 'codex', 'case-insensitive');
  assert.strictEqual(harness.normalizeId(undefined), 'claude', 'legacy record with no harness field');
  assert.strictEqual(harness.normalizeId(null), 'claude');
  assert.strictEqual(harness.normalizeId('gemini'), 'claude', 'unknown id is not trusted through');
});

test('get returns the adapter for an id and throws on an unknown one', () => {
  assert.strictEqual(harness.get('claude').id, 'claude');
  assert.strictEqual(harness.get('codex').id, 'codex');
  assert.throws(() => harness.get('gemini'), /unknown harness/);
});

test('available() filters to harnesses whose binary resolves, and caches', () => {
  harness._resetCache();
  let calls = 0;
  const fake = (id) => { calls++; return id === 'claude' ? 'C:/npm/claude.cmd' : null; };
  assert.deepStrictEqual(harness.available(fake), ['claude'], 'codex absent -> not offered');
  const before = calls;
  harness.available(fake);
  assert.strictEqual(calls, before, 'second call is cached, no re-resolution');
});

test('available() offers both when both resolve', () => {
  harness._resetCache();
  assert.deepStrictEqual(harness.available(() => 'C:/npm/x.cmd'), ['claude', 'codex']);
});

// resolveInstalled reconciles a CONFIGURED/requested harness id against what is ACTUALLY on PATH.
// normalizeId alone only checks the id is known ('claude'|'codex'), never that the CLI still
// resolves — the gap that let cfg.HARNESS='codex' keep defaulting every new/restored session to
// Codex forever after Codex left PATH, with Settings hiding the row that would let a user change it
// back. See Finding 2, 2026-07-26 whole-branch review.
test('resolveInstalled keeps the requested id when it is actually installed', () => {
  harness._resetCache();
  const fake = () => 'C:/npm/x.cmd'; // both resolve
  assert.strictEqual(harness.resolveInstalled('codex', fake), 'codex');
  assert.strictEqual(harness.resolveInstalled('claude', fake), 'claude');
});

test('resolveInstalled falls back to claude when the configured harness vanished from PATH', () => {
  harness._resetCache();
  const claudeOnly = (id) => (id === 'claude' ? 'C:/npm/claude.cmd' : null);
  assert.strictEqual(harness.resolveInstalled('codex', claudeOnly), 'claude',
    'the exact claude-only-machine scenario: a machine with only claude installed must default to claude, not stay stuck on a vanished codex');
});

test('resolveInstalled falls back to the sole installed harness when it is not the default', () => {
  harness._resetCache();
  // Pathological but shouldn't crash: claude itself is missing, only codex resolves.
  const codexOnly = (id) => (id === 'codex' ? 'C:/npm/codex.cmd' : null);
  assert.strictEqual(harness.resolveInstalled('claude', codexOnly), 'codex');
  assert.strictEqual(harness.resolveInstalled(undefined, codexOnly), 'codex', 'no-override default also reconciles');
});

test('resolveInstalled returns the requested id unchanged when NOTHING is installed (still a clear "not found" error, not a silent wrong substitution)', () => {
  harness._resetCache();
  const nothing = () => null;
  assert.strictEqual(harness.resolveInstalled('codex', nothing), 'codex');
});

test('resolveInstalled normalizes an unknown id before reconciling', () => {
  harness._resetCache();
  const claudeOnly = (id) => (id === 'claude' ? 'C:/npm/claude.cmd' : null);
  assert.strictEqual(harness.resolveInstalled('gemini', claudeOnly), 'claude');
});
