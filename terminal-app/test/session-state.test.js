'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ss = require('../src/session-state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mt-ss-'));

test('write then read round-trips sessions + activeCwd in order (default layout)', () => {
  const d = tmp();
  ss.write(d, { sessions: [{ cwd: 'C:/a', label: 'a' }, { cwd: 'C:/b', label: 'b' }], activeCwd: 'C:/b' });
  const r = ss.read(d);
  assert.strictEqual(r.sessions.length, 2);
  assert.strictEqual(r.sessions[0].cwd, 'C:/a');
  assert.deepStrictEqual(r.sessions[0].layout, { leaf: { kind: 'mavis' } }); // default when none given
  assert.strictEqual(r.activeCwd, 'C:/b');
});

test('write then read round-trips color + a split layout', () => {
  const d = tmp();
  const layout = { dir: 'row', sizes: [0.6, 0.4], children: [{ leaf: { kind: 'mavis' } }, { leaf: { kind: 'shell' } }] };
  ss.write(d, { sessions: [{ cwd: 'C:/a', label: 'a', color: '#97243b', layout }], activeCwd: 'C:/a' });
  const r = ss.read(d);
  assert.strictEqual(r.sessions[0].color, '#97243b');
  assert.deepStrictEqual(r.sessions[0].layout, layout);
});

test('read of a missing file returns null', () => {
  assert.strictEqual(ss.read(tmp()), null);
});

test('read of corrupt / non-array sessions returns null', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'session-state.json'), '{bad');
  assert.strictEqual(ss.read(d), null);
  fs.writeFileSync(path.join(d, 'session-state.json'), JSON.stringify({ version: 2, sessions: 'nope' }));
  assert.strictEqual(ss.read(d), null);
});

test('read filters entries without a cwd', () => {
  const d = tmp();
  ss.write(d, { sessions: [{ cwd: 'C:/a', label: 'a' }, { label: 'no-cwd' }], activeCwd: null });
  assert.strictEqual(ss.read(d).sessions.length, 1);
});

test('round-trips a cross-project Mavis leaf (cwd + label + color)', () => {
  const d = tmp();
  const layout = { dir: 'row', sizes: [0.5, 0.5], children: [
    { leaf: { kind: 'mavis' } },
    { leaf: { kind: 'mavis', cwd: 'C:/proj/other', label: 'Other', color: '#2f6d4f' } },
  ] };
  ss.write(d, { sessions: [{ cwd: 'C:/a', label: 'a', layout }], activeCwd: 'C:/a' });
  const r = ss.read(d);
  assert.deepStrictEqual(r.sessions[0].layout, layout);
});

test('sanitizeLayout keeps a cross-project leaf but drops cwd on a shell leaf + defaults a missing label', () => {
  // shell leaves never carry a cwd
  assert.deepStrictEqual(ss.sanitizeLayout({ leaf: { kind: 'shell', cwd: 'C:/x' } }), { leaf: { kind: 'shell' } });
  // a mavis leaf with cwd but no label defaults the label to the cwd; non-string colour dropped
  assert.deepStrictEqual(
    ss.sanitizeLayout({ leaf: { kind: 'mavis', cwd: 'C:/x', color: 5 } }),
    { leaf: { kind: 'mavis', cwd: 'C:/x', label: 'C:/x' } }
  );
});

test('sanitizeLayout collapses an invalid child and clamps bad sizes', () => {
  const lay = { dir: 'col', sizes: [-1, 0], children: [{ leaf: { kind: 'shell' } }, { junk: true }] };
  // one child invalid → collapses to the valid leaf
  assert.deepStrictEqual(ss.sanitizeLayout(lay), { leaf: { kind: 'shell' } });
  assert.strictEqual(ss.sanitizeLayout({ nope: 1 }), null);
});

test('a restored record with no harness field defaults to claude', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify({
    version: 2,
    sessions: [{ cwd: 'C:/p/one', label: 'one' }],   // legacy: predates the harness field
    activeCwd: 'C:/p/one',
  }));
  const st = ss.read(dir);
  assert.strictEqual(st.sessions[0].harness, 'claude',
    'a missing field MUST default to claude or every persisted tab breaks on first launch after upgrade');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('harness round-trips through write -> read', () => {
  const dir = tmp();
  ss.write(dir, { sessions: [{ cwd: 'C:/p/two', label: 'two', harness: 'codex' }], activeCwd: 'C:/p/two' });
  assert.strictEqual(ss.read(dir).sessions[0].harness, 'codex');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a junk harness value is normalized rather than trusted through', () => {
  const dir = tmp();
  ss.write(dir, { sessions: [{ cwd: 'C:/p/3', label: '3', harness: 'gemini' }], activeCwd: null });
  assert.strictEqual(ss.read(dir).sessions[0].harness, 'claude');
  fs.rmSync(dir, { recursive: true, force: true });
});
