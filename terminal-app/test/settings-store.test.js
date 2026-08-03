'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCHEMA, read, write } = require('../src/settings-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mt-set-'));

test('SCHEMA carries live/restart flags', () => {
  assert.strictEqual(SCHEMA.terminalFontSize.applies, 'live');
  assert.strictEqual(SCHEMA.brainRoot.applies, 'restart');
});

test('write clamps font size to 8..32', () => {
  const d = tmp();
  assert.strictEqual(write(d, { terminalFontSize: 99 }).terminalFontSize, 32);
  assert.strictEqual(write(d, { terminalFontSize: 2 }).terminalFontSize, 8);
});

test('write rejects unknown keys + bad enum values', () => {
  const d = tmp();
  const r = write(d, { nope: 'x', terminalTheme: 'purple' });
  assert.ok(!('nope' in r));
  assert.notStrictEqual(r.terminalTheme, 'purple');
});

test('partial writes merge', () => {
  const d = tmp();
  write(d, { terminalFontSize: 16 });
  const r = write(d, { autorunDelayMs: 500 });
  assert.strictEqual(r.terminalFontSize, 16);
  assert.strictEqual(r.autorunDelayMs, 500);
});

test('read of a corrupt file returns {}', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'settings.json'), 'nope');
  assert.deepStrictEqual(read(d), {});
});

test('dailyOpsOffDays defaults to Sat+Sun', () => {
  assert.strictEqual(SCHEMA.dailyOpsOffDays.type, 'weekdays');
  assert.strictEqual(SCHEMA.dailyOpsOffDays.default, '6,0');
});

test('weekdays coercion sorts, de-dupes, drops out-of-range, normalizes', () => {
  const d = tmp();
  assert.strictEqual(write(d, { dailyOpsOffDays: '0,6,6' }).dailyOpsOffDays, '0,6'); // sorted + de-duped
  assert.strictEqual(write(d, { dailyOpsOffDays: '5' }).dailyOpsOffDays, '5');         // Friday only
  assert.strictEqual(write(d, { dailyOpsOffDays: '9,abc,-1' }).dailyOpsOffDays, '6,0'); // all invalid → default
  assert.strictEqual(write(d, { dailyOpsOffDays: '' }).dailyOpsOffDays, '6,0');          // empty → default
});

test('harness is a schema key with claude as the default', () => {
  assert.ok(SCHEMA.harness, 'schema carries harness');
  assert.strictEqual(SCHEMA.harness.default, 'claude');
  assert.deepStrictEqual(SCHEMA.harness.enum, ['claude', 'codex']);
});

test('coerce rejects a harness value outside the enum', () => {
  assert.strictEqual(write(tmp(), { harness: 'codex' }).harness, 'codex');
  assert.strictEqual(write(tmp(), { harness: 'gemini' }).harness, undefined, 'invalid value is dropped, not stored');
});
