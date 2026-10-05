'use strict';

const test = require('node:test');
const assert = require('node:assert');
const interactions = require('../src/renderer/terminal-interactions');

test('OSC-8 handler opens only http(s) through the app-owned callback', () => {
  const opened = [];
  const handler = interactions.createOscLinkHandler((url) => opened.push(url));
  handler.activate({}, 'https://example.com/path');
  handler.activate({}, 'javascript:alert(1)');
  handler.activate({}, 'file:///tmp/a');
  assert.deepStrictEqual(opened, ['https://example.com/path']);
});

test('plain Space is sent exactly once on keydown and prevents the browser path', () => {
  const sent = [];
  let prevented = 0;
  const event = { type: 'keydown', key: ' ', code: 'Space', preventDefault() { prevented++; } };
  assert.strictEqual(interactions.handlePlainSpace(event, (value) => sent.push(value)), true);
  assert.deepStrictEqual(sent, [' ']);
  assert.strictEqual(prevented, 1);
});

test('modified Space and non-keydown events stay with xterm', () => {
  const send = () => { throw new Error('must not send'); };
  assert.strictEqual(interactions.handlePlainSpace({ type: 'keydown', key: ' ', ctrlKey: true }, send), false);
  assert.strictEqual(interactions.handlePlainSpace({ type: 'keypress', key: ' ' }, send), false);
  assert.strictEqual(interactions.handlePlainSpace({ type: 'keydown', key: 'a' }, send), false);
});

test('Codex Alt+arrow sends Alt cursor sequences instead of xterm Windows Ctrl sequences', () => {
  const cases = [
    ['ArrowUp', '\x1b[1;3A'],
    ['ArrowDown', '\x1b[1;3B'],
    ['ArrowRight', '\x1b[1;3C'],
    ['ArrowLeft', '\x1b[1;3D'],
  ];
  for (const [key, sequence] of cases) {
    const sent = [];
    let prevented = 0;
    const event = { type: 'keydown', key, altKey: true, preventDefault() { prevented++; } };
    assert.strictEqual(interactions.handleCodexAltArrow(event, (data) => sent.push(data)), true);
    assert.deepStrictEqual(sent, [sequence]);
    assert.strictEqual(prevented, 1);
  }
});

test('Codex Alt+arrow handler leaves other key combinations to xterm', () => {
  const send = () => { throw new Error('must not send'); };
  const cases = [
    { type: 'keydown', key: 'ArrowUp' },
    { type: 'keydown', key: 'ArrowUp', altKey: true, ctrlKey: true },
    { type: 'keydown', key: 'ArrowUp', altKey: true, shiftKey: true },
    { type: 'keydown', key: 'ArrowUp', altKey: true, metaKey: true },
    { type: 'keyup', key: 'ArrowUp', altKey: true },
    { type: 'keydown', key: 'Enter', altKey: true },
  ];
  for (const event of cases) assert.strictEqual(interactions.handleCodexAltArrow(event, send), false);
});
