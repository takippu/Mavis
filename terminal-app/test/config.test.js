'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mt-cfg-'));

test('defaults: Claude autoruns /mavis, delay 1500, font 13', () => {
  const c = config.load(null);
  assert.strictEqual(c.AUTORUN_COMMAND, '/mavis');
  assert.strictEqual(c.AUTORUN_DELAY_MS, 1500);
  assert.strictEqual(c.TERMINAL_FONT_SIZE, 13);
});

test('Codex defaults to its namespaced Mavis prompt', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ harness: 'codex' }));
  const c = config.load(d);
  assert.strictEqual(c.HARNESS, 'codex');
  assert.strictEqual(c.AUTORUN_COMMAND, '/prompts:mavis');
  assert.strictEqual(c.autorunCommandForHarness('claude'), '/mavis');
  assert.strictEqual(c.autorunCommandForHarness('codex'), '/prompts:mavis');
  fs.rmSync(d, { recursive: true, force: true });
});

test('an explicitly configured autorun command overrides harness defaults', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ harness: 'codex', autorunCommand: '/my-mavis' }));
  assert.strictEqual(config.load(d).AUTORUN_COMMAND, '/my-mavis');
  fs.rmSync(d, { recursive: true, force: true });
});

// A genuinely custom command is one setting for both CLIs — it is the user's string, so neither
// harness gets to substitute its own.
test('a custom autorun command applies to every harness', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ autorunCommand: '/my-mavis' }));
  const c = config.load(d);
  assert.strictEqual(c.autorunCommandForHarness('claude'), '/my-mavis');
  assert.strictEqual(c.autorunCommandForHarness('codex'), '/my-mavis');
  fs.rmSync(d, { recursive: true, force: true });
});

// The 2026-07-30 bug: settings.json kept Codex's namespaced command after harness went back to
// claude, so every Claude pane autoran "/prompts:mavis <project>" -> "Unknown command".
test('a stale OTHER-harness built-in is ignored, not typed at the wrong CLI', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ harness: 'claude', autorunCommand: '/prompts:mavis' }));
  const c = config.load(d);
  assert.strictEqual(c.AUTORUN_COMMAND, '/mavis', 'claude pane gets claude\'s command');
  assert.strictEqual(c.autorunCommandForHarness('codex'), '/prompts:mavis', 'codex pane still gets its own');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the mirror case is ignored too: claude built-in pinned while harness is codex', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ harness: 'codex', autorunCommand: '/mavis' }));
  const c = config.load(d);
  assert.strictEqual(c.AUTORUN_COMMAND, '/prompts:mavis');
  assert.strictEqual(c.autorunCommandForHarness('claude'), '/mavis');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a built-in pinned via env is ignored the same way as one from settings.json', () => {
  const prev = process.env.MAVIS_AUTORUN_COMMAND;
  process.env.MAVIS_AUTORUN_COMMAND = '/prompts:mavis';
  try { assert.strictEqual(config.load(null).AUTORUN_COMMAND, '/mavis'); }
  finally { if (prev === undefined) delete process.env.MAVIS_AUTORUN_COMMAND; else process.env.MAVIS_AUTORUN_COMMAND = prev; }
});

test('env overrides default', () => {
  const prev = process.env.MAVIS_AUTORUN_COMMAND;
  process.env.MAVIS_AUTORUN_COMMAND = '/mavis-env';
  try { assert.strictEqual(config.load(null).AUTORUN_COMMAND, '/mavis-env'); }
  finally { if (prev === undefined) delete process.env.MAVIS_AUTORUN_COMMAND; else process.env.MAVIS_AUTORUN_COMMAND = prev; }
});

test('settings.json file wins over env + default', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ autorunCommand: '/mavis-file', terminalFontSize: 18 }));
  const prev = process.env.MAVIS_AUTORUN_COMMAND;
  process.env.MAVIS_AUTORUN_COMMAND = '/mavis-env';
  try {
    const c = config.load(d);
    assert.strictEqual(c.AUTORUN_COMMAND, '/mavis-file');
    assert.strictEqual(c.TERMINAL_FONT_SIZE, 18);
  } finally { if (prev === undefined) delete process.env.MAVIS_AUTORUN_COMMAND; else process.env.MAVIS_AUTORUN_COMMAND = prev; }
});

test('corrupt settings.json falls back to env/default', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), '{not valid json');
  assert.strictEqual(config.load(d).AUTORUN_COMMAND, '/mavis');
});

test('HARNESS defaults to claude and is normalized from settings.json', () => {
  const dir = tmp();
  assert.strictEqual(config.load(dir).HARNESS, 'claude', 'no settings -> claude');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ harness: 'codex' }));
  assert.strictEqual(config.load(dir).HARNESS, 'codex');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ harness: 'gemini' }));
  assert.strictEqual(config.load(dir).HARNESS, 'claude', 'junk falls back rather than propagating');
  fs.rmSync(dir, { recursive: true, force: true });
});
