'use strict';

// Map view backing: status + rebuild of the existing brain-viz (viz/) cytoscape
// app. Reads viz/dist; rebuild shells out to viz's own npm scripts (single-flight).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let building = false;

function mapStatus(vizRoot) {
  try {
    const indexPath = path.join(vizRoot, 'dist', 'index.html');
    const st = fs.statSync(indexPath);
    return { ready: true, builtAt: st.mtimeMs, indexPath };
  } catch {
    return { ready: false };
  }
}

function rebuild(vizRoot) {
  return new Promise((resolve) => {
    if (building) { resolve({ ok: false, reason: 'in-progress' }); return; }
    building = true;
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // viz's own pipeline: build:data then build. shell:true so the && chain runs.
    const child = spawn(npm + ' run build:data && ' + npm + ' run build', { cwd: vizRoot, shell: true });
    let err = '';
    child.on('error', () => { building = false; resolve({ ok: false, reason: 'no-npm' }); });
    if (child.stderr) child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      building = false;
      if (child.stderr) child.stderr.removeAllListeners('data');
      if (code === 0) { const s = mapStatus(vizRoot); resolve({ ok: true, builtAt: s.builtAt }); }
      else resolve({ ok: false, reason: 'build-failed', stderrTail: err.slice(-400) });
    });
  });
}

module.exports = { mapStatus, rebuild };
