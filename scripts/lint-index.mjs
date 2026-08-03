#!/usr/bin/env node
// Guards projects/_index.md against the changelog-bloat that this file is prone to.
// The index is a POINTER — one line per project, one current-state sentence, one date.
// Narrative belongs in each project's progress.md / notes.md + the daily-memories.
//
// Run from the brain root:  node scripts/lint-index.mjs
// Exit 0 = clean, 1 = at least one ERROR. WARN never fails the run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Tunables — a healthy project line sits ~150-540 chars with exactly one date.
const MAX_LEN = 600; // hard bloat backstop
const DATE_RE = /\d{4}-\d{2}-\d{2}/g; // YYYY-MM-DD
const BOLD_RE = /\*\*/g; // milestone-bolding creeping in

const brainRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const indexPath = join(brainRoot, "projects", "_index.md");

const lines = readFileSync(indexPath, "utf8").split(/\r?\n/);

const errors = [];
const warnings = [];

lines.forEach((line, i) => {
  // Only project entries: "- [slug](slug/index.md) — ..."
  if (!/^- \[[^\]]+\]\([^)]*index\.md\)/.test(line)) return;

  const n = i + 1;
  const slug = line.match(/^- \[([^\]]+)\]/)?.[1] ?? "?";

  if (line.length > MAX_LEN) {
    errors.push(`line ${n} [${slug}]: ${line.length} chars (max ${MAX_LEN}) — trim Now: to one sentence, move detail to progress.md`);
  }

  const distinctDates = new Set(line.match(DATE_RE) ?? []);
  if (distinctDates.size > 1) {
    errors.push(`line ${n} [${slug}]: ${distinctDates.size} dates [${[...distinctDates].join(", ")}] — a 2nd date = changelog; keep only the trailing (YYYY-MM-DD), REPLACE the Now: state in place`);
  }

  const bolds = (line.match(BOLD_RE) ?? []).length;
  if (bolds > 0) {
    warnings.push(`line ${n} [${slug}]: ${bolds / 2 | 0} bold run(s) — the index carries no **milestones**; plain prose only`);
  }
});

const rule = "projects/_index.md is a pointer: one line per project, one current-state sentence, exactly one trailing date, no **bold**. Detail lives in progress.md / notes.md / daily-memories.";

if (errors.length === 0 && warnings.length === 0) {
  console.log(`OK  projects/_index.md is clean (${lines.filter(l => l.startsWith("- [")).length} project lines).`);
  process.exit(0);
}

if (warnings.length) {
  console.log(`\nWARN (${warnings.length}):`);
  warnings.forEach(w => console.log("  - " + w));
}
if (errors.length) {
  console.log(`\nERROR (${errors.length}):`);
  errors.forEach(e => console.log("  - " + e));
  console.log("\n" + rule);
  process.exit(1);
}

console.log("\n" + rule);
process.exit(0);
