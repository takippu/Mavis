'use strict';
const fs = require('fs'), path = require('path');
module.exports = root => {
  fs.mkdirSync(path.join(root, 'projects', 'fixture'), { recursive: true });
  fs.mkdirSync(path.join(root, 'identity'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Disposable fixture brain\n');
  fs.writeFileSync(path.join(root, 'identity', 'profile.md'), '# Test\n');
  fs.writeFileSync(path.join(root, 'projects', '_index.md'), '## Active\n- [fixture](fixture/index.md) — tool, active — Disposable test project.\n');
  fs.writeFileSync(path.join(root, 'projects', 'fixture', 'index.md'), '# Fixture\n');
  return root;
};
