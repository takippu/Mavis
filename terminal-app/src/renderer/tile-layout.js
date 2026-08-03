'use strict';

// MT.tile — pure binary tile-tree for split-pane terminal layouts. No DOM, no I/O,
// so it's unit-tested (test/tile-layout.test.js). A tab's panes are arranged as a
// binary tree:
//   leaf:  { type:'leaf', paneId }
//   split: { type:'split', dir:'row'|'col', sizes:[a,b], children:[nodeA, nodeB] }
// dir 'row' = children laid left→right; 'col' = stacked top→bottom.
// Every op returns a NEW tree and never mutates its input (untouched subtrees may be
// shared by reference — callers must treat nodes as immutable).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node (tests)
  if (typeof window !== 'undefined') (window.MT = window.MT || {}).tile = api;  // renderer
})(this, function () {
  function leaf(paneId) { return { type: 'leaf', paneId }; }

  // direction → which axis the new split uses + whether the new pane goes first.
  const DIR = {
    left: { axis: 'row', first: true },
    right: { axis: 'row', first: false },
    up: { axis: 'col', first: true },
    down: { axis: 'col', first: false },
  };

  // Replace the leaf `targetPaneId` with a split holding the old leaf + a new leaf.
  function splitPane(node, targetPaneId, newPaneId, direction) {
    const d = DIR[direction];
    if (!d || !node) return node;
    function rec(n) {
      if (n.type === 'leaf') {
        if (n.paneId !== targetPaneId) return leaf(n.paneId);
        const children = d.first ? [leaf(newPaneId), leaf(targetPaneId)] : [leaf(targetPaneId), leaf(newPaneId)];
        return { type: 'split', dir: d.axis, sizes: [0.5, 0.5], children };
      }
      return { type: 'split', dir: n.dir, sizes: n.sizes.slice(), children: [rec(n.children[0]), rec(n.children[1])] };
    }
    return rec(node);
  }

  // Remove a leaf; its parent split collapses to the surviving sibling subtree.
  // Returns the new root, or null if that was the only pane.
  function removePane(node, paneId) {
    if (!node) return null;
    function rec(n) {
      if (n.type === 'leaf') return n.paneId === paneId ? null : leaf(n.paneId);
      const a = rec(n.children[0]);
      const b = rec(n.children[1]);
      if (a === null && b === null) return null;
      if (a === null) return b;          // child0 gone → promote child1
      if (b === null) return a;          // child1 gone → promote child0
      return { type: 'split', dir: n.dir, sizes: n.sizes.slice(), children: [a, b] };
    }
    return rec(node);
  }

  // Update the sizes of the split addressed by `path` (array of 0/1 from the root).
  function setSizes(node, path, sizes) {
    if (!node) return node;
    if (!path || path.length === 0) {
      if (node.type !== 'split') return node;
      return { type: 'split', dir: node.dir, sizes: [Number(sizes[0]), Number(sizes[1])], children: node.children };
    }
    if (node.type !== 'split') return node;
    const idx = path[0];
    const child = setSizes(node.children[idx], path.slice(1), sizes);
    const children = idx === 0 ? [child, node.children[1]] : [node.children[0], child];
    return { type: 'split', dir: node.dir, sizes: node.sizes.slice(), children };
  }

  // Move src next to target in `direction` (remove src, re-split target with it).
  function movePane(node, srcPaneId, targetPaneId, direction) {
    if (!node || srcPaneId === targetPaneId || !DIR[direction]) return node;
    const without = removePane(node, srcPaneId);
    if (!without) return node;
    if (!collectPaneIds(without).includes(targetPaneId)) return node; // target vanished
    return splitPane(without, targetPaneId, srcPaneId, direction);
  }

  function collectPaneIds(node) {
    const out = [];
    (function rec(n) { if (!n) return; if (n.type === 'leaf') out.push(n.paneId); else { rec(n.children[0]); rec(n.children[1]); } })(node);
    return out;
  }

  function firstPaneId(node) { const ids = collectPaneIds(node); return ids.length ? ids[0] : null; }
  function countPanes(node) { return collectPaneIds(node).length; }

  return { leaf, splitPane, removePane, setSizes, movePane, collectPaneIds, firstPaneId, countPanes, DIR };
});
