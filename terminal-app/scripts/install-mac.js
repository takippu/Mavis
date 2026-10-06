'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

function dockEntry(appPath) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const url = pathToFileURL(appPath + path.sep).href;
  return '<dict><key>tile-data</key><dict><key>file-data</key><dict>'
    + '<key>_CFURLString</key><string>' + escape(url) + '</string>'
    + '<key>_CFURLStringType</key><integer>15</integer></dict>'
    + '<key>file-label</key><string>Mavis-Terminal</string>'
    + '</dict><key>tile-type</key><string>file-tile</string></dict>';
}

function dockHasApp(text, appPath) {
  const url = pathToFileURL(appPath + path.sep).href;
  // defaults has used both percent-encoded and decoded file URLs across macOS versions.
  return [url, decodeURI(url)].some((value) => String(text).includes(value));
}

function install() {
  if (process.platform !== 'darwin') throw Error('Mac installation must run on macOS.');
  const source = path.resolve(__dirname, '../dist/mac-arm64/Mavis-Terminal.app');
  if (!fs.existsSync(source)) throw Error('Build the Apple Silicon app first: npm run dist:mac');
  const apps = path.join(os.homedir(), 'Applications');
  const destination = path.join(apps, 'Mavis-Terminal.app');
  const staging = path.join(apps, '.Mavis-Terminal-install-' + process.pid + '.app');
  const backup = path.join(apps, '.Mavis-Terminal-backup-' + process.pid + '.app');
  fs.mkdirSync(apps, { recursive: true });
  // macOS ditto preserves the bundle's permissions and framework symlinks.
  execFileSync('/usr/bin/ditto', [source, staging]);
  let previous = false;
  try {
    const executable = path.join(destination, 'Contents/MacOS/Mavis-Terminal');
    let running = false;
    try { running = !!execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').some((line) => line.trim() === executable); } catch { /* not running */ }
    if (running) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw Error('Close Mavis-Terminal, then run npm run install:mac to install this build.');
    }
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); previous = true; }
    fs.renameSync(staging, destination);
  } catch (error) {
    if (previous && !fs.existsSync(destination)) fs.renameSync(backup, destination);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  if (previous) console.log('[install-mac] Previous build retained for rollback: ' + backup);
  console.log('[install-mac] Installed ' + destination);

  let dock = '';
  try { dock = execFileSync('/usr/bin/defaults', ['read', 'com.apple.dock', 'persistent-apps'], { encoding: 'utf8' }); }
  catch { throw Error('App installed, but Dock preferences could not be read. Drag the app into the Dock manually.'); }
  if (!dockHasApp(dock, destination)) {
    execFileSync('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', dockEntry(destination)]);
    execFileSync('/usr/bin/killall', ['Dock']);
    console.log('[install-mac] Pinned to Dock.');
  } else {
    console.log('[install-mac] Existing Dock shortcut kept; no duplicate added.');
  }
}

if (require.main === module) {
  try { install(); } catch (error) { console.error('[install-mac] ' + error.message); process.exitCode = 1; }
}
module.exports = { dockEntry, dockHasApp };
