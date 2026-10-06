'use strict';
const fs = require('node:fs');
const path = require('node:path');

if (process.platform === 'darwin') {
  // node-pty 1.1's prebuilt spawn-helper arrives without its executable bit.
  // Fix before packaging so every installed copy can launch a real terminal.
  const helper = path.resolve(__dirname, '../node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
  fs.chmodSync(helper, 0o755);
  console.log('[prepare-mac] Native terminal helper is executable.');
}
