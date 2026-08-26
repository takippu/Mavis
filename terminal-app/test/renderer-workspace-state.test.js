'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const read = (name) => fs.readFileSync(path.join(rendererDir, name), 'utf8');

test('Files and Changes renderers remain valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(read('files-view.js')));
  assert.doesNotThrow(() => new Function(read('changes-view.js')));
  assert.doesNotThrow(() => new Function(read('app.js')));
});

test('router retains the Files and Changes work surfaces across navigation', () => {
  const source = read('app.js');
  assert.match(source, /view === 'files' \|\| view === 'changes'/);
  assert.match(source, /retainedViews\.get\(view\)/);
  assert.match(source, /viewHost\.replaceChildren\(retained\)/);
});

test('Files view searches the open editor and exposes copyable directory navigation', () => {
  const source = read('files-view.js');
  assert.match(source, /searchOpenEditor\(query\)/);
  assert.match(source, /cm\.getValue\(\)\.split\('\\n'\)/);
  assert.match(source, /cm\.markText\(/);
  assert.match(source, /navigator\.clipboard\.writeText\(root\)/);
  assert.match(source, /window\.mavis\.filesOpenRoot\(requested\)/);
});
