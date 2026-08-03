'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/renderer/tile-layout');

test('leaf creates a leaf node', () => {
  assert.deepStrictEqual(T.leaf('a'), { type: 'leaf', paneId: 'a' });
});

test('splitPane right → row split with [old, new]', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'right');
  assert.strictEqual(r.type, 'split');
  assert.strictEqual(r.dir, 'row');
  assert.deepStrictEqual(r.sizes, [0.5, 0.5]);
  assert.deepStrictEqual(T.collectPaneIds(r), ['a', 'b']);
});

test('splitPane left → row split with [new, old]', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'left');
  assert.strictEqual(r.dir, 'row');
  assert.deepStrictEqual(T.collectPaneIds(r), ['b', 'a']);
});

test('splitPane down → col split with [old, new]', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'down');
  assert.strictEqual(r.dir, 'col');
  assert.deepStrictEqual(T.collectPaneIds(r), ['a', 'b']);
});

test('splitPane up → col split with [new, old]', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'up');
  assert.strictEqual(r.dir, 'col');
  assert.deepStrictEqual(T.collectPaneIds(r), ['b', 'a']);
});

test('splitPane targets a nested leaf, leaving siblings intact', () => {
  let r = T.splitPane(T.leaf('a'), 'a', 'b', 'right'); // [a,b]
  r = T.splitPane(r, 'b', 'c', 'down');                // b → [b,c]
  assert.deepStrictEqual(T.collectPaneIds(r), ['a', 'b', 'c']);
  // a's branch unchanged; b's branch is now a col split
  assert.strictEqual(r.children[0].type, 'leaf');
  assert.strictEqual(r.children[1].type, 'split');
  assert.strictEqual(r.children[1].dir, 'col');
});

test('splitPane with an unknown direction is a no-op', () => {
  const a = T.leaf('a');
  assert.strictEqual(T.splitPane(a, 'a', 'b', 'sideways'), a);
});

test('splitPane does not mutate the input tree', () => {
  const a = T.leaf('a');
  T.splitPane(a, 'a', 'b', 'right');
  assert.deepStrictEqual(a, { type: 'leaf', paneId: 'a' });
});

test('removePane collapses the parent split to the sibling', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'right'); // [a,b]
  const after = T.removePane(r, 'b');
  assert.deepStrictEqual(after, T.leaf('a'));
});

test('removePane on the only pane returns null', () => {
  assert.strictEqual(T.removePane(T.leaf('a'), 'a'), null);
});

test('removePane from a deep tree promotes the surviving sibling', () => {
  let r = T.splitPane(T.leaf('a'), 'a', 'b', 'right'); // [a,b]
  r = T.splitPane(r, 'b', 'c', 'down');                // [a, [b,c]]
  const after = T.removePane(r, 'b');                  // [a, c]
  assert.deepStrictEqual(T.collectPaneIds(after), ['a', 'c']);
  assert.strictEqual(after.children[1].type, 'leaf');
  assert.strictEqual(after.children[1].paneId, 'c');
});

test('removePane of a missing id leaves the tree shape intact', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'right');
  assert.deepStrictEqual(T.collectPaneIds(T.removePane(r, 'zz')), ['a', 'b']);
});

test('setSizes updates the addressed split only', () => {
  let r = T.splitPane(T.leaf('a'), 'a', 'b', 'right'); // root split [a,b]
  r = T.splitPane(r, 'b', 'c', 'down');                // root [a, split[b,c]]
  const after = T.setSizes(r, [1], [0.7, 0.3]);        // resize the nested split
  assert.deepStrictEqual(after.sizes, [0.5, 0.5]);     // root untouched
  assert.deepStrictEqual(after.children[1].sizes, [0.7, 0.3]);
});

test('setSizes at the root resizes the root split', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'right');
  const after = T.setSizes(r, [], [0.25, 0.75]);
  assert.deepStrictEqual(after.sizes, [0.25, 0.75]);
});

test('movePane relocates a pane next to a target', () => {
  let r = T.splitPane(T.leaf('a'), 'a', 'b', 'right'); // [a,b]
  r = T.splitPane(r, 'b', 'c', 'right');               // [a, [b,c]]
  const after = T.movePane(r, 'a', 'c', 'down');       // a moves under c
  assert.deepStrictEqual(T.collectPaneIds(after).sort(), ['a', 'b', 'c']);
  // 'a' should now be a sibling of 'c' in a col split
  const ids = T.collectPaneIds(after);
  assert.strictEqual(ids.length, 3);
});

test('movePane onto itself is a no-op', () => {
  const r = T.splitPane(T.leaf('a'), 'a', 'b', 'right');
  assert.strictEqual(T.movePane(r, 'a', 'a', 'down'), r);
});

test('movePane preserves the pane count', () => {
  let r = T.splitPane(T.leaf('a'), 'a', 'b', 'right');
  r = T.splitPane(r, 'b', 'c', 'down');
  const after = T.movePane(r, 'a', 'b', 'right');
  assert.strictEqual(T.countPanes(after), 3);
});

test('firstPaneId / countPanes', () => {
  let r = T.leaf('only');
  assert.strictEqual(T.firstPaneId(r), 'only');
  assert.strictEqual(T.countPanes(r), 1);
  r = T.splitPane(r, 'only', 'x', 'right');
  assert.strictEqual(T.firstPaneId(r), 'only');
  assert.strictEqual(T.countPanes(r), 2);
});
