'use strict';

// Pure line-level detection of Claude Code's TUI states. These strings drift across CLI
// versions (auto/plan modes, borderless vs bordered prompt) and have repeatedly broken the
// completion notification — so they're pinned here. The auto-mode idle line is the regression
// that left notifications dead in 0.2.x: the turn finished, the input prompt was back, but the
// old isReady (only "? for shortcuts" / "│ > ") never matched it, so no chime/toast ever fired
// AND the tab dot stayed stuck "busy".
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/renderer/tui-detect');

test('isWorkingLine matches the working footer', () => {
  assert.strictEqual(D.isWorkingLine('✶ Cogitating… (esc to interrupt)'), true);
  assert.strictEqual(D.isWorkingLine('  ✻ Thinking · 12s · esc to interrupt'), true);
  assert.strictEqual(D.isWorkingLine('? for shortcuts'), false);
});

test('isAwaitingLine matches mid-turn user prompts', () => {
  assert.strictEqual(D.isAwaitingLine('❯ 1. Yes'), true);
  assert.strictEqual(D.isAwaitingLine('Do you want to proceed?'), true);
  assert.strictEqual(D.isAwaitingLine('Would you like to proceed?'), true);
  assert.strictEqual(D.isAwaitingLine('● Done.'), false);
});

test('isReadyLine matches the default "? for shortcuts" idle hint', () => {
  assert.strictEqual(D.isReadyLine('? for shortcuts'), true);
  assert.strictEqual(D.isReadyLine('  ? for shortcuts · / for commands'), true);
});

test('isReadyLine matches the borderless mode hint (auto/plan/etc.) — the 0.2.x regression', () => {
  assert.strictEqual(D.isReadyLine('  ▶▶ auto mode on (shift+tab to cycle) · ← for history'), true);
  assert.strictEqual(D.isReadyLine('plan mode on (shift+tab to cycle)'), true);
  assert.strictEqual(D.isReadyLine('accept edits on (shift + tab to cycle)'), true);
  assert.strictEqual(D.isReadyLine('bypass permissions on (shift+tab  to  cycle)'), true);
});

test('isReadyLine still matches the older bordered input box', () => {
  assert.strictEqual(D.isReadyLine('│ > '), true);
  assert.strictEqual(D.isReadyLine('┃ >  some queued text'), true);
});

test('isReadyLine does NOT match mid-turn output (no false "complete")', () => {
  assert.strictEqual(D.isReadyLine('● Reading the brain files now'), false);
  assert.strictEqual(D.isReadyLine('  > a blockquote in a response'), false); // borderless ">" alone must not count
  assert.strictEqual(D.isReadyLine('esc to interrupt'), false);
  assert.strictEqual(D.isReadyLine(''), false);
});
