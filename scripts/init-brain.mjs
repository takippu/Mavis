#!/usr/bin/env node
// Seed a fresh brain's three two-tier categories from seeds/. Runnable from any directory:
//   node scripts/init-brain.mjs            preview what would be written (default: no writes)
//   node scripts/init-brain.mjs --write    lay the seeds down
//   node scripts/init-brain.mjs --check    exit 1 if seeding is still needed, 0 if complete
//
// Idempotent: a category whose _index.md already exists is never touched, so re-running after
// Mavis has learned real entries cannot destroy them. Replaces the per-platform shell one-liner
// in SETUP.md, whose PowerShell form silently flattened _details/ (see init-brain-core.mjs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planInit, applyInit, verifyDetailLinks } from './lib/init-brain-core.mjs';

// Self-locate, exactly like sync-contract.mjs and lint-brain.mjs. Resolving from process.cwd()
// would seed whatever directory the user happened to be standing in.
const brainRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');

const plan = planInit(brainRoot);

if (!plan.seedsPresent) {
  console.error('FAIL  seeds/ is missing -- cannot seed.');
  console.error('      Follow the "Header preambles (fallback)" section of SETUP.md instead.');
  process.exit(2);
}

const needsWork = plan.categories.some((c) => c.status === 'seed' || c.mkdirs.length > 0);

// --check is the CI/verification mode: report and set an exit code, never write.
if (check) {
  for (const c of plan.categories) {
    const label = c.status === 'present' ? 'OK   ' : c.status === 'seed' ? 'SEED ' : 'NONE ';
    const detail =
      c.status === 'present'
        ? 'already installed'
        : c.status === 'seed'
          ? `${c.files.length} file(s) to write`
          : 'no seed ships for this category';
    console.log(`${label} ${c.name.padEnd(12)} ${detail}`);
  }
  for (const p of plan.problems) console.log(`WARN  ${p}`);
  process.exit(needsWork ? 1 : 0);
}

if (!needsWork) {
  console.log('OK    All three categories are already installed. Nothing to do.');
} else if (!write) {
  console.log('Dry run -- nothing written. Re-run with --write to apply.\n');
  for (const c of plan.categories) {
    if (c.status === 'seed') {
      console.log(`  ${c.name}/  (seed ${c.files.length} file(s))`);
      for (const f of c.files) console.log(`    + ${path.relative(brainRoot, f.to)}`);
    } else if (c.status === 'present') {
      console.log(`  ${c.name}/  already installed, seed skipped`);
    }
    for (const d of c.mkdirs) console.log(`    + ${path.relative(brainRoot, d)}${path.sep}`);
  }
  for (const p of plan.problems) console.log(`\nWARN  ${p}`);
} else {
  const { created, mkdirs } = applyInit(brainRoot, plan);
  for (const f of created) console.log(`  wrote  ${f}`);
  for (const d of mkdirs) console.log(`  mkdir  ${d}${path.sep}`);
  console.log(`\nOK    ${created.length} file(s), ${mkdirs.length} directory(ies).`);
  for (const p of plan.problems) console.log(`WARN  ${p}`);
}

// Always verify, in every mode including a dry run against an already-installed brain. This is
// the check that catches a flattened _details/ -- the exact corruption the old SETUP.md
// one-liner produced on Windows while exiting 0.
const links = verifyDetailLinks(brainRoot);
const broken = links.filter((l) => !l.ok);
if (links.length > 0) {
  if (broken.length === 0) {
    console.log(`OK    ${links.length} _details link(s) resolve.`);
  } else {
    console.error(`\nFAIL  ${broken.length} of ${links.length} _details link(s) do NOT resolve:`);
    for (const b of broken) console.error(`      ${b.category}/_index.md -> ${b.link}`);
    console.error('      A flattened _details/ is the usual cause. Re-clone the seed or move the');
    console.error('      files back under <category>/_details/.');
    process.exit(1);
  }
}
