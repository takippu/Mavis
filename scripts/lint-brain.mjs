#!/usr/bin/env node
// Brain rot detector. Runnable from any directory:  node scripts/lint-brain.mjs [--json]
// Exit 1 when any FAIL-severity flag exists (warn-only = exit 0); exit 2 when the lint
// itself could not run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint } from './lib/brain-lint-core.mjs';

// Self-locate, exactly like the sibling scripts/lint-index.mjs. Resolving from
// process.cwd() made every check degrade to silence when invoked from anywhere else
// (`cd scripts && node lint-brain.mjs` printed "brain clean: no flags" and exited 0 while
// the brain root reported 30 fails) - a rot detector that fails open is worse than none.
const brainRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let report;
try {
  report = lint(brainRoot);
} catch (e) {
  console.error(`lint-brain: ${e.message}`);
  process.exit(2);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (report.flags.length === 0) console.log('brain clean: no flags');
  for (const f of report.flags)
    console.log(`${f.severity.toUpperCase().padEnd(4)} ${f.type.padEnd(13)} ${f.file} — ${f.detail} -> ${f.suggestedAction}`);
  console.log(`\n${report.counts.fail} fail, ${report.counts.warn} warn`);
}
process.exit(report.counts.fail > 0 ? 1 : 0);
