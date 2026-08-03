'use strict';

// postdist hook: drop the freshly-built PORTABLE exe into the brain root so it's one
// double-click away instead of buried in terminal-app/dist/.
//
// Copied under a STABLE name (Mavis-Terminal.exe), not the versioned one electron-builder
// emits: the root should always hold "the latest build", not accumulate a new file every
// version. dist/ keeps the versioned originals + the NSIS installer. The app's own version
// is visible in its sidebar footer, so nothing is lost by dropping it from the filename.
//
// The root copy is gitignored (see the repo-root .gitignore). Packaged mode resolves
// MAVIS_BRAIN_ROOT itself (main.js, app.isPackaged), so running from the root is fine.

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const BRAIN_ROOT = path.resolve(__dirname, '..', '..');
const DEST = path.join(BRAIN_ROOT, 'Mavis-Terminal.exe');

function main() {
  let entries;
  try { entries = fs.readdirSync(DIST); }
  catch { fail('dist/ not found - run `npm run dist` first'); return; }

  // The portable target emits "Mavis-Terminal <ver>.exe"; NSIS emits "Mavis-Terminal Setup
  // <ver>.exe". Match the portable one by EXCLUDING "Setup" rather than by guessing the
  // version, so a version bump never silently breaks the copy (and never ships the installer
  // as if it were the portable build).
  const portable = entries
    .filter((f) => /^Mavis-Terminal .*\.exe$/i.test(f) && !/Setup/i.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(DIST, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);

  if (!portable.length) { fail('no portable exe in dist/ (looked for "Mavis-Terminal <ver>.exe")'); return; }

  const src = path.join(DIST, portable[0].f);
  fs.copyFileSync(src, DEST);
  const mb = (fs.statSync(DEST).size / (1024 * 1024)).toFixed(1);
  console.log('[copy-portable] ' + portable[0].f + ' -> ' + DEST + ' (' + mb + ' MB)');
}

// Never fail the build over the convenience copy — the real artifacts are already in dist/.
function fail(msg) { console.warn('[copy-portable] skipped: ' + msg); }

try { main(); } catch (e) { fail(e && e.message ? e.message : String(e)); }
