'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { hiddenTestRun } = require('../src/test-window-mode');

test('ordinary development and packaged apps retain normal window behavior', () => {
  assert.equal(hiddenTestRun({ isPackaged: false }, {}), false);
  assert.equal(hiddenTestRun({ isPackaged: false }, { MAVIS_TEST_SHOW_WINDOW: '0' }), false);
  assert.equal(hiddenTestRun({ isPackaged: true }, { MAVIS_TEST_USER_DATA: '/fixture', MAVIS_TEST_SHOW_WINDOW: '0' }), false);
});
test('isolated fixtures stay hidden unless explicitly opted into visible testing', () => {
  assert.equal(hiddenTestRun({ isPackaged: false }, { MAVIS_TEST_USER_DATA: '/fixture' }), true);
  assert.equal(hiddenTestRun({ isPackaged: false }, { MAVIS_TEST_USER_DATA: '/fixture', MAVIS_TEST_SHOW_WINDOW: '0' }), true);
  assert.equal(hiddenTestRun({ isPackaged: false }, { MAVIS_TEST_USER_DATA: '/fixture', MAVIS_TEST_SHOW_WINDOW: '1' }), false);
});
