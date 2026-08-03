#!/usr/bin/env node
// Block personal content from reaching files that will be published.
//
//   node scripts/check-leaks.mjs --staged        scan staged changes (used by the pre-commit hook)
//   node scripts/check-leaks.mjs --all           audit every tracked file
//   node scripts/check-leaks.mjs --file <path>   scan one file (used by the write-time hook)
//   node scripts/check-leaks.mjs --explain       list the derived terms and where each came from
//
// Exit: 0 clean, 1 blocking findings, 2 cannot run.
//
// See scripts/lib/leak-guard-core.mjs for why this exists and why the term list is derived from
// the user's own gitignored brain rather than shipped as a constant.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveIdentifiers, scanFile, isBrainRoot } from './lib/leak-guard-core.mjs';

const brainRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const mode = has('--all') ? 'all' : has('--file') ? 'file' : has('--explain') ? 'explain' : 'staged';
const quiet = has('--quiet');

function git(args, opts = {}) {
  try {
    return execFileSync('git', args, { cwd: brainRoot, encoding: 'utf8', ...opts }).trim();
  } catch {
    return null;
  }
}

// The hook is installed through GLOBAL core.hooksPath, so it fires in every repo on the machine.
// Scanning a user's client repo for that user's own client names would fire constantly on the one
// place those names belong, and the guard would be switched off within a day. No-op elsewhere.
const repoTop = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() });
if (mode === 'staged' && repoTop && !isBrainRoot(repoTop)) {
  process.exit(0);
}

const identifiers = deriveIdentifiers(brainRoot, {
  gitUserName: git(['config', 'user.name']),
  gitUserEmail: git(['config', 'user.email']),
});

if (mode === 'explain') {
  console.log(`Derived ${identifiers.terms.length} personal term(s) for this machine.`);
  console.log('Nothing here is hardcoded -- it all comes from your own gitignored brain.\n');
  const bySource = new Map();
  for (const t of identifiers.terms) {
    if (!bySource.has(t.source)) bySource.set(t.source, []);
    bySource.get(t.source).push(t.term);
  }
  for (const [source, list] of [...bySource].sort()) {
    console.log(`  ${source}`);
    console.log(`    ${list.sort().join(', ')}`);
  }
  if (identifiers.allow.size > 0) {
    console.log(`\nAllowed (silenced in .mavis-private): ${[...identifiers.allow].sort().join(', ')}`);
  }
  console.log('\nAdd more with `deny: <term>` or silence one with `allow: <term>` in .mavis-private.');
  process.exit(0);
}

// Collect { file, content } pairs. For --staged we read the STAGED blob, not the working tree:
// the working tree may have been fixed already, and it is the staged bytes that are about to be
// committed.
let targets = [];
if (mode === 'file') {
  const f = valueOf('--file');
  if (!f) {
    console.error('FAIL  --file needs a path');
    process.exit(2);
  }
  const abs = path.isAbsolute(f) ? f : path.resolve(process.cwd(), f);
  const rel = path.relative(brainRoot, abs).split(path.sep).join('/');
  // A file inside a gitignored directory cannot leak -- that is the whole point of the brain
  // living in ignored directories. Say so rather than silently passing.
  const ignored = git(['check-ignore', '-q', rel]) !== null || (() => {
    try {
      execFileSync('git', ['check-ignore', '-q', rel], { cwd: brainRoot });
      return true;
    } catch {
      return false;
    }
  })();
  if (ignored) {
    if (!quiet) console.log(`OK    ${rel} is gitignored - it cannot reach the public repo.`);
    process.exit(0);
  }
  if (!fs.existsSync(abs)) process.exit(0);
  targets = [{ file: rel, content: fs.readFileSync(abs) }];
} else if (mode === 'all') {
  const list = git(['ls-files']) || '';
  targets = list
    .split('\n')
    .filter(Boolean)
    .map((rel) => {
      try {
        return { file: rel, content: fs.readFileSync(path.join(brainRoot, rel)) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
} else {
  const list = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']) || '';
  targets = list
    .split('\n')
    .filter(Boolean)
    .map((rel) => {
      // Read the staged blob so a later working-tree edit cannot mask what is being committed.
      try {
        const buf = execFileSync('git', ['show', `:${rel}`], { cwd: brainRoot, maxBuffer: 64 * 1024 * 1024 });
        return { file: rel, content: buf };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const findings = [];
for (const t of targets) findings.push(...scanFile(t.file, identifiers, t.content));

const blocking = findings.filter((f) => f.severity === 'block');
const advisory = findings.filter((f) => f.severity === 'advisory');

if (findings.length === 0) {
  if (!quiet) console.log(`OK    leak guard: ${targets.length} file(s) scanned, nothing personal found.`);
  process.exit(0);
}

const render = (f) => {
  const where = f.binary ? `${f.file} (binary)` : `${f.file}:${f.line}`;
  return `  ${where}\n      matched: ${f.term}   [${f.source}]\n      ${f.excerpt}`;
};

if (advisory.length > 0 && !quiet) {
  console.log(`\nAdvisory (${advisory.length}) - looks like a path shape, but not yours:`);
  for (const f of advisory.slice(0, 20)) console.log(render(f));
}

if (blocking.length === 0) {
  if (!quiet) console.log('\nOK    no blocking findings.');
  process.exit(0);
}

console.error(`\nBLOCKED: ${blocking.length} personal identifier(s) in content that would be published.\n`);
for (const f of blocking.slice(0, 40)) console.error(render(f));
if (blocking.length > 40) console.error(`\n  ... and ${blocking.length - 40} more.`);

console.error(`
What to do:
  - If it is a real leak, replace it with a synthetic example and commit again.
  - If the term is an ordinary word that happens to be one of your project slugs,
    silence it permanently:        echo "allow: <term>" >> .mavis-private
  - If one line legitimately needs it, add a "leak-guard-allow" comment on that line.
  - To override once:              git commit --no-verify

Run \`node scripts/check-leaks.mjs --explain\` to see every term and where it came from.
`);
process.exit(1);
