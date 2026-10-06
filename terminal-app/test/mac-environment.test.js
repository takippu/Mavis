'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restoreMacPath } = require('../src/mac-environment');

test('Dock launch restores login-shell PATH without importing unrelated shell variables', () => {
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', KEEP: 'original' };
  const run = (file, args, options) => {
    assert.equal(file, '/bin/zsh');
    assert.equal(args[0], '-ilc');
    assert.equal(options.timeout, 5000);
    return 'shell startup banner\n\0PATH=/opt/homebrew/bin:/Users/test/.local/bin:/usr/bin\0KEEP=changed\0';
  };
  assert.equal(restoreMacPath({ platform: 'darwin', env, run }), true);
  assert.match(env.PATH, /^\/opt\/homebrew\/bin:/);
  assert.equal(env.KEEP, 'original');
});

test('shell errors and empty PATH leave the existing environment usable', () => {
  const env = { PATH: '/usr/bin' };
  assert.equal(restoreMacPath({ platform: 'darwin', env, run: () => { throw Error('timeout'); } }), false);
  assert.equal(restoreMacPath({ platform: 'darwin', env, run: () => '\0PATH=\0' }), false);
  assert.equal(env.PATH, '/usr/bin');
});

test('Windows does not execute a Unix login shell', () => {
  assert.equal(restoreMacPath({ platform: 'win32', run: () => assert.fail('unexpected shell') }), false);
});
