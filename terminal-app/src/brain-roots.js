'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
module.exports = function roots(brainRoot) {
  const bundledCheckout = path.resolve(__dirname, '../..');
  let code = process.env.MAVIS_CODE_ROOT || bundledCheckout;
  // Packaged Terminal locates the registered checkout before loading the shared resolver.
  const machine = process.env.MAVIS_SYNC_HOME || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Mavis/brain-sync')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/Mavis/brain-sync')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mavis/brain-sync'));
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(machine, 'config.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!fs.existsSync(path.join(code, 'scripts/lib/brain-sync/roots.cjs'))) code = config.codeRoot || brainRoot || code;
  const resolver = path.join(code, 'scripts/lib/brain-sync/roots.cjs');
  if (fs.existsSync(resolver)) return require(resolver).resolveRoots({brainRoot,sourceRoot:code});
  return {codeRoot:code,brainRoot:brainRoot || process.env.MAVIS_DATA_ROOT || config.brainRoot || bundledCheckout,machineRoot:machine,config,migrationBlocker:'Configure a Mavis code checkout containing the shared root resolver before migrating this packaged Terminal.'};
};
