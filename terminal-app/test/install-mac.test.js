'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dockEntry, dockHasApp } = require('../scripts/install-mac');

test('Dock update recognizes its stable app URL and leaves other applications alone', () => {
  const app = '/Users/test/Applications/Mavis-Terminal.app';
  assert.equal(dockHasApp('"_CFURLString" = "file:///Users/test/Applications/Mavis-Terminal.app/";', app), true);
  assert.equal(dockHasApp('file:///Applications/Other.app/', app), false);
});

test('Dock entry escapes paths and recognizes encoded or decoded spaces', () => {
  const app = '/Users/Test User/Applications/Mavis-Terminal.app';
  assert.equal(dockHasApp('file:///Users/Test%20User/Applications/Mavis-Terminal.app/', app), true);
  assert.equal(dockHasApp('file:///Users/Test User/Applications/Mavis-Terminal.app/', app), true);
  assert.match(dockEntry('/Users/a&b/Applications/Mavis-Terminal.app'), /a&amp;b/);
  assert.match(dockEntry(app), /file:\/\/\/Users\/Test%20User/);
});
