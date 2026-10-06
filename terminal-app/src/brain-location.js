'use strict';
const fs = require('node:fs');
const path = require('node:path');

function isBrainRoot(dir, codeRoot) {
  if (!dir) return false;
  const has = (root, ...parts) => !!root && fs.existsSync(path.join(root, ...parts));
  const contract = has(dir, 'AGENTS.md') || has(dir, 'CLAUDE.md');
  const brainish = has(dir, 'SETUP.md') || has(dir, 'identity') || has(dir, 'projects') || has(dir, 'daily-memories');
  if (contract && brainish) return true;
  // Split-root installations deliberately keep the contract in the code checkout.
  return (has(codeRoot, 'AGENTS.md') || has(codeRoot, 'CLAUDE.md'))
    && has(dir, 'identity', 'profile.md') && has(dir, 'projects', '_index.md');
}

module.exports = { isBrainRoot };
