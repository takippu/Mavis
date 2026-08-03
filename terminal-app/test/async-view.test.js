'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeSeq, makeController } = require('../src/renderer/async-view.js');

test('seq: begin increments and isCurrent tracks the latest token', () => {
  const s = makeSeq();
  const a = s.begin();
  assert.equal(s.isCurrent(a), true);
  const b = s.begin();
  assert.equal(s.isCurrent(a), false);
  assert.equal(s.isCurrent(b), true);
  assert.equal(s.value(), 2);
});

test('seq: invalidate drops the current token without a usable new one', () => {
  const s = makeSeq();
  const a = s.begin();
  s.invalidate();
  assert.equal(s.isCurrent(a), false);
});

test('controller.run resolves ok with the result', async () => {
  const c = makeController();
  const r = await c.run(async () => 42);
  assert.deepEqual(r, { ok: true, result: 42 });
});

test('controller.run captures a thrown error', async () => {
  const c = makeController();
  const err = new Error('boom');
  const r = await c.run(async () => { throw err; });
  assert.equal(r.ok, false);
  assert.equal(r.error, err);
});

test('controller.run drops a result superseded by a newer run', async () => {
  const c = makeController();
  let release;
  const gate = new Promise((res) => { release = res; });
  const slow = c.run(async () => { await gate; return 'old'; }); // token 1, suspended on gate
  const fast = await c.run(async () => 'new');                    // token 2, completes first
  release();
  const slowR = await slow;
  assert.deepEqual(fast, { ok: true, result: 'new' });
  assert.deepEqual(slowR, { superseded: true });
});

test('controller.run drops a result superseded by invalidate', async () => {
  const c = makeController();
  let release;
  const gate = new Promise((res) => { release = res; });
  const p = c.run(async () => { await gate; return 'x'; });
  c.invalidate();
  release();
  assert.deepEqual(await p, { superseded: true });
});

test('controller.run accepts a plain value (not just a thunk)', async () => {
  const c = makeController();
  const r = await c.run(Promise.resolve('v'));
  assert.deepEqual(r, { ok: true, result: 'v' });
});

test('controller.state is a stable mutable object', () => {
  const c = makeController({ phase: 'idle', n: 0 });
  c.state.phase = 'busy'; c.state.n = 5;
  assert.equal(c.state.phase, 'busy');
  assert.equal(c.state.n, 5);
});

test('controller.isBusy reflects busyWhen over the live state', () => {
  const c = makeController({ phase: 'idle' }, { busyWhen: (s) => s.phase === 'busy' });
  assert.equal(c.isBusy(), false);
  c.state.phase = 'busy';
  assert.equal(c.isBusy(), true);
});

test('controller without busyWhen is never busy', () => {
  const c = makeController({});
  assert.equal(c.isBusy(), false);
});
