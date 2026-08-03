#!/usr/bin/env node
// Read back what the session actually did, and propose preferences from it.
//
//   node scripts/observe.mjs stats               counts by tool, by day, by shell verb; session count
//   node scripts/observe.mjs patterns            repeated behaviour worth turning into a preference
//   node scripts/observe.mjs prune [--days N]    delete observation files older than N days (default 30)
//
// Flags: --days N   retention window for prune (and the reporting window elsewhere)
//        --dry-run  prune only: list what would go, delete nothing
//        --json     machine-readable output
//        --dir P    read a different observation directory (tests, or a relocated log)
//        --min N    patterns only: minimum occurrences before something is a candidate (default 5)
//
// Exit: 0 always, except 2 for a usage error. This is a reporting tool; it has no opinion strong
// enough to fail a build.
//
// RUN ON DEMAND, NEVER AUTOMATICALLY. Nothing invokes this on a schedule, at session start, or
// from a hook. Its output is the only part of the observation system that costs tokens, and it
// costs them only in the turn where someone asked. See scripts/hooks/observe-tool.mjs for why the
// capture half is free.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OBSERVATION_DIR,
  resolveObservationDir,
  DEFAULT_RETENTION_DAYS,
  readObservations,
  listDayFiles,
  computeStats,
  detectPatterns,
  filesToPrune,
  pruneObservations,
} from './lib/observation-core.mjs';

const brainRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, fallback = null) => {
  const i = argv.indexOf(f);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};

const cmd = argv.find((a) => !a.startsWith('-')) || 'stats';
const asJson = has('--json');
const dir = resolveObservationDir(brainRoot, valueOf('--dir') || process.env.MAVIS_OBSERVATIONS_DIR);
const days = Number(valueOf('--days', DEFAULT_RETENTION_DAYS)) || DEFAULT_RETENTION_DAYS;
const minCount = Number(valueOf('--min', 5)) || 5;

function usage(msg) {
  console.error(`FAIL  ${msg}`);
  console.error('Usage: node scripts/observe.mjs <stats|patterns|prune> [--days N] [--min N] [--dry-run] [--json] [--dir PATH]');
  process.exit(2);
}

const kb = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const bar = (n, max, width = 24) => '#'.repeat(Math.max(1, Math.round((n / Math.max(1, max)) * width)));

function emptyNotice() {
  console.log(`No observations yet in ${path.relative(brainRoot, dir) || dir}`);
  console.log('');
  console.log('The capture hook writes one line per tool call. If this stays empty, it is not wired up:');
  console.log('  Claude Code : a PostToolUse entry in .claude/settings.json running scripts/hooks/observe-tool.mjs');
  console.log('  Codex       : the same entry in $CODEX_HOME/hooks/hooks.json');
}

if (cmd === 'stats') {
  const { files, records } = readObservations(dir);
  const stats = computeStats(records, files);
  if (asJson) {
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  }
  if (stats.total === 0) {
    emptyNotice();
    process.exit(0);
  }

  console.log(`Observations: ${stats.total} tool call(s) over ${stats.days} day(s), ${stats.sessions} session(s), ${kb(stats.bytes)} on disk.`);
  if (stats.total > 0) {
    console.log(`Average ${(stats.bytes / stats.total).toFixed(1)} bytes per record, ${(stats.total / stats.days).toFixed(0)} calls per active day.`);
  }
  if (stats.errors > 0) console.log(`${stats.errors} call(s) recorded as failed.`);

  const show = (title, rows, limit = 12) => {
    if (rows.length === 0) return;
    console.log(`\n${title}`);
    const max = Math.max(...rows.map((r) => r[1]));
    for (const [name, n] of rows.slice(0, limit)) {
      console.log(`  ${String(name).padEnd(22)} ${String(n).padStart(6)}  ${bar(n, max)}`);
    }
    if (rows.length > limit) console.log(`  ... and ${rows.length - limit} more`);
  };

  show('By tool', stats.byTool);
  show('By shell verb (first word only -- arguments are never recorded)', stats.byVerb);
  show('By area (first path segment only)', stats.byArea);
  show('By file type', stats.byExt);
  show('By day', stats.byDay, 31);

  console.log('\nNext: node scripts/observe.mjs patterns');
  process.exit(0);
}

if (cmd === 'patterns') {
  const { records } = readObservations(dir);
  const result = detectPatterns(records, { minCount });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  if (result.total === 0) {
    emptyNotice();
    process.exit(0);
  }

  console.log(`Pattern candidates from ${result.total} tool call(s) across ${result.sessionCount} session(s).`);
  console.log(`Threshold: ${minCount}+ occurrences. Raise it with --min N.\n`);

  if (result.candidates.length === 0) {
    console.log('Nothing repeated often enough to be a candidate yet. Come back after a few more sessions,');
    console.log(`or lower the bar with --min ${Math.max(2, minCount - 2)}.`);
    process.exit(0);
  }

  let i = 0;
  for (const c of result.candidates) {
    i += 1;
    console.log(`${String(i).padStart(2)}. ${c.observation}`);
    console.log(`    seen in ${c.sessions} of ${result.sessionCount} session(s)`);
    console.log(`    why it matters: ${c.why}`);
    console.log(`    proposed preference entry: preferences/_details/${c.proposal}.md`);
    console.log('');
  }

  // Stated in the output, not only in a comment, because the output is what gets read. The whole
  // point of deriving preferences from telemetry is to remove the assistant's bias from the
  // OBSERVATION step -- it does not remove the human from the DECISION step.
  console.log('These are candidates, not entries. This command writes nothing.');
  console.log('Nothing under preferences/ has been created, edited or proposed to disk.');
  console.log('If one of these is genuinely how you work, say so and it gets written through the normal');
  console.log('entry lifecycle (ADD a preferences/_details/<slug>.md plus its line in preferences/_index.md).');
  console.log('A count is evidence of a habit, not proof that the habit is deliberate -- only you know that.');
  process.exit(0);
}

if (cmd === 'prune') {
  const dryRun = has('--dry-run');
  const present = listDayFiles(dir);
  const doomed = filesToPrune(present, { days, now: new Date() });

  if (asJson) {
    const removed = dryRun ? doomed : pruneObservations(dir, { days, now: new Date() });
    console.log(JSON.stringify({ dir, days, dryRun, present: present.length, removed }, null, 2));
    process.exit(0);
  }

  if (present.length === 0) {
    console.log(`Nothing to prune -- ${path.relative(brainRoot, dir) || dir} holds no observation files.`);
    process.exit(0);
  }
  if (doomed.length === 0) {
    console.log(`OK    ${present.length} day file(s), none older than ${days} days. Nothing to prune.`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`Would delete ${doomed.length} of ${present.length} day file(s) older than ${days} days:`);
    for (const n of doomed) console.log(`  ${n}`);
    console.log('\nRe-run without --dry-run to delete them.');
    process.exit(0);
  }

  const removed = pruneObservations(dir, { days, now: new Date() });
  console.log(`Deleted ${removed.length} day file(s) older than ${days} days.`);
  for (const n of removed) console.log(`  ${n}`);
  console.log(`\n${present.length - removed.length} file(s) remain.`);
  process.exit(0);
}

usage(`unknown command "${cmd}"`);
