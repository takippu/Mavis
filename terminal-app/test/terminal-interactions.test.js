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

