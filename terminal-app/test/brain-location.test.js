'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isBrainRoot } = require('../src/brain-location');

test('split memory accepts a registered code contract without copying it into memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-location-'));
  try {
    const code = path.join(root, 'code'), brain = path.join(root, 'brain');
    fs.mkdirSync(code); fs.writeFileSync(path.join(code, 'AGENTS.md'), 'contract');
    fs.mkdirSync(path.join(brain, 'identity'), { recursive: true });
    fs.writeFileSync(path.join(brain, 'identity/profile.md'), 'profile');
    fs.mkdirSync(path.join(brain, 'projects')); fs.writeFileSync(path.join(brain, 'projects/_index.md'), 'index');
    assert.equal(isBrainRoot(brain, code), true);
    assert.equal(isBrainRoot(brain, path.join(root, 'missing')), false);
    assert.equal(isBrainRoot(code, code), false);
    fs.writeFileSync(path.join(code, 'SETUP.md'), 'setup');
    assert.equal(isBrainRoot(code), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
