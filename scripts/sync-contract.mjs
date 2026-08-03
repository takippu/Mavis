#!/usr/bin/env node
// Render CLAUDE.md from the canonical AGENTS.md. Runnable from any directory:
//   node scripts/sync-contract.mjs --check   exit 0 in sync, 1 on drift, 2 cannot run
//   node scripts/sync-contract.mjs --write   rewrite CLAUDE.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClaude } from './lib/contract-sync-core.mjs';

// Self-locate, exactly like scripts/lint-brain.mjs. Resolving from process.cwd() would
// render the wrong brain's contract.
const brainRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcPath = path.join(brainRoot, 'AGENTS.md');
const outPath = path.join(brainRoot, 'CLAUDE.md');
const write = process.argv.includes('--write');

// ENOENT means the file is missing, which is legitimate drift (CLAUDE.md has never been
// rendered, or was deleted). Anything else -- EISDIR (a directory sitting where the contract
// belongs), EACCES, ... -- is a real failure and must NOT be silently treated as "missing":
// under --write that misclassification is exactly what would trigger overwriting something it
// has no business touching. Returns null for "missing"; throws for everything else, so the
// caller can report it and exit 2 instead of letting the error surface as a raw stack trace.
function readIfPresent(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Write through a temp sibling and rename, so a process interruption, a full disk, or a crash
// mid-write cannot leave the live ~29KB operating contract truncated: the target itself is only
// ever touched by rename(), so a killed, crashed, or erroring run leaves either the old bytes or
// the new bytes, never half of either. This is not crash durability (no fsync of the file or its
// directory) -- it guards against the process dying, which is the failure mode this tool can
// actually hit; guarding against the machine dying would cost two fsyncs for a file that can
// simply be re-rendered.
//
// The temp path is unlinked first. A pre-existing symlink there would otherwise be FOLLOWED by
// the write, landing the payload wherever it points -- a known trap in this repo (see
// scripts/install-harness.mjs, which hit the same trap and solved it the same way; duplicated
// here rather than imported, since coupling this CLI to that installer's core is worse than a
// few repeated lines). ENOENT on the unlink is the normal case and is ignored; anything else is
// a real problem and propagates. 'wx' then refuses to write through anything that reappeared
// between the unlink and the open, e.g. a symlink recreated in that window.
//
// `mode`, when given, is applied to the temp file BEFORE the rename, matching
// install-harness.mjs's approach for the same reason: a plain in-place writeFileSync preserves
// permission bits for free because it writes to the same inode, but a rename-based write creates
// a FRESH inode under the process umask, silently resetting them. The caller passes the
// pre-existing target's mode (or leaves it undefined for a target that does not exist yet, so no
// mode is invented for a new file). Applying it before the rename -- not after -- matters: doing
// it after would leave a window where the file exists at the target path with the wrong
// permissions. This is a no-op on Windows (chmod does not carry POSIX permission semantics
// there), which is fine: there is nothing to preserve.
function writeAtomic(file, data, mode) {
  const tmp = `${file}.tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    if (mode != null) {
      try { fs.chmodSync(tmp, mode); } catch { /* best effort; a no-op on Windows */ }
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

let source;
try {
  source = fs.readFileSync(srcPath, 'utf8');
} catch (err) {
  console.error(`sync-contract: cannot read ${srcPath}: ${err.code || err.message}`);
  process.exit(2);
}

let rendered;
try {
  rendered = renderClaude(source);
} catch (e) {
  console.error(`sync-contract: ${e.message}`);
  process.exit(2);
}

let current;
try {
  current = readIfPresent(outPath);
} catch (err) {
  console.error(`sync-contract: cannot read ${outPath}: ${err.code || err.message}`);
  process.exit(2);
}

if (write) {
  if (current !== rendered) {
    // Only a target that already exists has a mode worth preserving -- `current !== null` is
    // exactly that (readIfPresent above already turned a missing file into null). Stat failing
    // here despite that (e.g. the file was removed in the gap between the read and this line)
    // just falls back to the default mode, same as a brand-new file; not worth failing the write
    // over.
    let mode;
    if (current !== null) {
      try { mode = fs.statSync(outPath).mode; } catch { /* keep default */ }
    }
    try {
      writeAtomic(outPath, rendered, mode);
    } catch (err) {
      console.error(`sync-contract: cannot write ${outPath}: ${err.code || err.message}`);
      process.exit(2);
    }
    console.log('sync-contract: CLAUDE.md rewritten from AGENTS.md');
  } else {
    console.log('sync-contract: already in sync');
  }
  process.exit(0);
}

if (current === rendered) {
  console.log('sync-contract: in sync');
  process.exit(0);
}

console.log(
  current === null
    ? 'sync-contract: CLAUDE.md is missing (AGENTS.md exists and has not been rendered yet)'
    : 'sync-contract: CLAUDE.md has DRIFTED from AGENTS.md',
);
const a = (current === null ? '' : current).split('\n');
const b = rendered.split('\n');
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    console.log(`  first difference at line ${i + 1}`);
    console.log(`    CLAUDE.md : ${a[i] === undefined ? '<missing>' : a[i]}`);
    console.log(`    generated : ${b[i] === undefined ? '<missing>' : b[i]}`);
    break;
  }
}
console.log('  fix: node scripts/sync-contract.mjs --write');
process.exit(1);
