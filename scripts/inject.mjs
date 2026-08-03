#!/usr/bin/env node
// Manage the context injectors -- the few lines of live state that get re-stated to the model on
// every single turn.
//
//   node scripts/inject.mjs list                 show every injector and its current value
//   node scripts/inject.mjs set <name> <text>    write a state file
//   node scripts/inject.mjs clear <name>         remove one
//   node scripts/inject.mjs cost                 the measured per-turn token cost of what is set
//
// Exit: 0 fine, 1 bad usage or a failed write.
//
// See scripts/lib/injector-core.mjs for why per-turn injection is the right home for volatile
// state, and mavis/injectors/README.md for the harness config that actually wires the hook up.
//
// This is the CLI half of the pair: it owns argv, printing and exit codes, and does no thinking.
// The core is pure enough to test without a terminal.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INJECT_DIR,
  MAX_CONTEXT_CHARS,
  buildContext,
  clearState,
  estimateTokens,
  injectDir,
  listInjectors,
  normalizeValue,
  writeState,
} from './lib/injector-core.mjs';

// Self-located, never cwd-derived. This script is run from the brain root, from a subdirectory,
// from a hook, and from an editor's task runner -- resolving state relative to whatever cwd
// happened to be would put a `.mavis-inject/` in a random directory and the hook would then read
// an empty one, which fails silently and looks like the feature simply not working.
const brainRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'list').toLowerCase();

// One turn's cost times an assumed session length. 40 is a deliberately unremarkable working
// session; the point of the multiplier is to make the compounding visible, since the per-turn
// number is small enough on its own to feel free when it is not.
const TURNS_PER_SESSION = 40;

function usage(stream = console.log) {
  stream(`Usage:
  node scripts/inject.mjs list                 show every injector and its current value
  node scripts/inject.mjs set <name> <text>    write a state file (one line)
  node scripts/inject.mjs clear <name>         remove one
  node scripts/inject.mjs cost                 measured per-turn token cost of what is set

State lives in ${INJECT_DIR}/<name>.txt at the brain root, one line each, gitignored.
Names: letters, digits, "_" and "-", 32 characters max.`);
}

function reportCost(label = 'Per turn') {
  const entries = listInjectors(brainRoot);
  const built = buildContext(entries, MAX_CONTEXT_CHARS);
  console.log(`${label}: ${built.chars} characters, ~${built.tokens} tokens (${entries.length} injector(s) set).`);
  console.log(`Per ${TURNS_PER_SESSION}-turn session: ~${built.tokens * TURNS_PER_SESSION} tokens.`);
  if (built.truncated) {
    console.log(`Capped at ${MAX_CONTEXT_CHARS} characters -- ${built.dropped} line(s) did not fit and are NOT being emitted.`);
  }
  return built;
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(0);
}

if (cmd === 'list') {
  const entries = listInjectors(brainRoot);
  if (entries.length === 0) {
    console.log(`No injectors set. ${path.join(brainRoot, INJECT_DIR)} is empty or absent.`);
    console.log('Set one with:  node scripts/inject.mjs set focus "shipping the payments migration"');
    process.exit(0);
  }
  const width = Math.max(...entries.map((e) => e.name.length));
  for (const e of entries) {
    console.log(`  ${e.name.toUpperCase().padEnd(width)}  ${e.value}`);
  }
  console.log('');
  // Always print the cost with the list. Showing what is set without showing what it costs is how
  // a per-turn budget quietly triples: each individual line looks obviously worth it.
  reportCost('Emitted');
  console.log(`\nDirectory: ${injectDir(brainRoot)}`);
  process.exit(0);
}

if (cmd === 'cost') {
  const built = reportCost('Emitted');
  if (built.chars === 0) {
    console.log('Nothing is set, so the hook emits nothing and costs nothing.');
  } else {
    console.log('\nWhat would actually be injected:');
    for (const line of built.text.split('\n')) console.log(`  ${line}`);
  }
  process.exit(0);
}

if (cmd === 'set') {
  const name = argv[1];
  // Everything after the name is the value, so quoting is optional at the shell. A user typing
  // `inject set tone terse and blunt` without quotes gets what they obviously meant rather than
  // the word "terse" and two ignored arguments.
  const value = normalizeValue(argv.slice(2).join(' '));
  if (!name || !value) {
    console.error('FAIL  set needs a name and a value:  node scripts/inject.mjs set tone "terse, no preamble"');
    process.exit(1);
  }
  let result;
  try {
    result = writeState(brainRoot, name, value);
  } catch (err) {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  }
  console.log(`OK    ${result.name.toUpperCase()}: ${result.value}`);
  if (result.clamped) {
    console.log(`      (clamped to ${MAX_CONTEXT_CHARS} characters -- injected context is capped there)`);
  }
  console.log(`      ${result.file}`);
  // The cost of THIS line, not the whole set, so the tradeoff is attached to the decision that
  // just created it.
  const lineChars = `${result.name.toUpperCase()}: ${result.value}`.length;
  console.log(`      +${lineChars} chars / ~${estimateTokens(lineChars)} tokens on every turn.`);
  reportCost('\nEmitted');
  process.exit(0);
}

if (cmd === 'clear') {
  const name = argv[1];
  if (!name) {
    console.error('FAIL  clear needs a name:  node scripts/inject.mjs clear tone');
    process.exit(1);
  }
  let removed;
  try {
    removed = clearState(brainRoot, name);
  } catch (err) {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  }
  console.log(removed ? `OK    cleared ${String(name).toUpperCase()}.` : `OK    ${String(name).toUpperCase()} was not set.`);
  process.exit(0);
}

console.error(`FAIL  unknown command "${cmd}".\n`);
usage(console.error);
process.exit(1);
