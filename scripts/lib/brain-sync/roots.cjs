'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const codeRoot = path.resolve(__dirname, '../../..');
function machineRoot(env = process.env, platform = process.platform) {
  if (env.MAVIS_SYNC_HOME) return path.resolve(env.MAVIS_SYNC_HOME);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Mavis/brain-sync');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Mavis/brain-sync');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mavis/brain-sync');
}
function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function resolveRoots({ brainRoot, env = process.env, sourceRoot = codeRoot } = {}) {
  const machine = machineRoot(env), config = readJSON(path.join(machine, 'config.json'), {});
  const data = path.resolve(brainRoot || env.MAVIS_DATA_ROOT || config.brainRoot || sourceRoot);
  return { codeRoot: sourceRoot, brainRoot: data, machineRoot: machine, config };
}
module.exports = { codeRoot, machineRoot, readJSON, resolveRoots };
