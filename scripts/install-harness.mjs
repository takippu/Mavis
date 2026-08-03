#!/usr/bin/env node
// Install Mavis into a harness home: the global invariants (spliced between markers so any
// non-Mavis content in the file survives) and the /mavis prompt.
//
// SAFETY. Every target is OUTSIDE this repo - they are the user's live harness config.
// Therefore:
//   - The default is a DRY RUN. Nothing is written unless --yes is passed explicitly.
//   - Nothing is ever deleted. EVERY existing target is copied to <path>.mavis-bak first,
//     spliced and whole-file alike.
//   - Writes are atomic: a temp sibling is written and renamed into place, so an interruption
//     leaves either the old file or the new one, never a truncated config.
//   - A file's existing line endings are preserved; the untouched region is not rewritten.
//   - ~/.codex/config.toml is never touched. It holds trusted-project entries and MCP server
//     definitions; the two keys Codex needs are PRINTED for the user to paste instead.
//
// Usage:
//   node scripts/install-harness.mjs --harness claude|codex|both [--global] [--dry-run] [--yes]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectHarnesses,
  isDuplicateContract,
  parseFrontmatter,
  resolvePlaceholders,
  spliceMarkers,
  targetsFor,
} from './lib/install-harness-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// The brain whose sources get installed. Normally this script's own repo; overridable so the
// installer can be driven against a scratch brain in tests and so a second clone can install
// its own contract.
const BRAIN_ROOT = process.env.MAVIS_BRAIN_ROOT
  ? path.resolve(process.env.MAVIS_BRAIN_ROOT)
  : ROOT;

const USAGE = `
Install Mavis into a harness home.

  node scripts/install-harness.mjs --harness claude|codex|both [options]

Options:
  --harness <name>  claude, codex, or both. Required.
  --global          Also install the global invariants into the harness's always-on
                    instruction file (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md), spliced
                    between <!-- mavis:begin --> / <!-- mavis:end --> markers.
  --dry-run         Print the diff and write nothing. This is the default.
  --yes             Actually write. Without it nothing outside this repo is touched.
  -h, --help        This text.

Sources (edit these, then re-run):
  mavis/global-invariants.md   the --global payload
  mavis/slash-mavis.md         the /mavis prompt
  mavis/output-style-terse.md  the mavis-terse output style (Claude only)

All are portable: {{USER_NAME}} and {{BRAIN_ROOT}} are resolved at write time from
identity/profile.md and from this brain's location. The committed source stays generic;
the installed copy is personal.

Environment:
  CLAUDE_CONFIG_DIR  override ~/.claude
  CODEX_HOME         override ~/.codex
  MAVIS_BRAIN_ROOT   install the sources from another brain clone instead of this one
  MAVIS_INSTALL_ASSUME_HARNESSES
                     comma list ("claude,codex") that replaces the PATH probe. Exists so
                     the write path can be tested against temp homes on any machine; the
                     run prints loudly when it is in effect.

Exit codes: 0 ok, 1 error (including a refused install), 2 bad usage or a requested
harness is not on PATH.
`.trim();

function parseArgs(argv) {
  const out = { harness: null, global: false, dryRun: false, yes: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--harness') out.harness = argv[++i] ?? null;
    else if (a.startsWith('--harness=')) out.harness = a.slice('--harness='.length);
    else if (a === '--global') out.global = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.unknown.push(a);
  }
  return out;
}

// --- diff ------------------------------------------------------------------------------

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  // Small files (harness config, not source trees). Fall back rather than allocate a
  // gigantic matrix on something unexpected.
  if ((n + 1) * (m + 1) > 4_000_000) {
    return [...a.map(line => ({ t: '-', line })), ...b.map(line => ({ t: '+', line }))];
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
    else { ops.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', line: a[i++] });
  while (j < m) ops.push({ t: '+', line: b[j++] });
  return ops;
}

function unifiedDiff(label, oldText, newText, context = 3) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const ops = lcsOps(a, b);
  if (!ops.some(op => op.t !== ' ')) return null;

  // Mark which context lines to keep.
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t === ' ') continue;
    for (let d = -context; d <= context; d++) {
      const idx = k + d;
      if (idx >= 0 && idx < ops.length) keep[idx] = true;
    }
  }

  const lines = [`--- a/${label}`, `+++ b/${label}`];
  let k = 0;
  let aLine = 1;
  let bLine = 1;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k].t !== '+') aLine++;
      if (ops[k].t !== '-') bLine++;
      k++;
      continue;
    }
    const startA = aLine;
    const startB = bLine;
    const body = [];
    let countA = 0;
    let countB = 0;
    while (k < ops.length && keep[k]) {
      const op = ops[k];
      body.push(`${op.t}${op.line}`);
      if (op.t !== '+') { aLine++; countA++; }
      if (op.t !== '-') { bLine++; countB++; }
      k++;
    }
    lines.push(`@@ -${countA === 0 ? 0 : startA},${countA} +${countB === 0 ? 0 : startB},${countB} @@`);
    lines.push(...body);
  }
  return lines.join('\n');
}

// --- helpers ---------------------------------------------------------------------------

// Windows paths go out with forward slashes - backslashes get eaten when pasted into a shell.
const posix = (p) => p.split(path.sep).join('/');

// The file's dominant existing line ending. Everything downstream works in LF, so without
// this the untouched region of a CRLF file gets silently rewritten to LF - in a file the
// installer explicitly promises to preserve, and invisibly, because the printed diff is
// computed on the already-normalized text. A mixed file is normalized to whichever style
// already dominates it.
function detectEol(raw) {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

const applyEol = (text, eol) => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

function readIfExists(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return { exists: true, text: raw.replace(/\r\n?/g, '\n'), eol: detectEol(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, text: '', eol: '\n' };
    // Anything else is a per-target problem, not a reason to abort the whole run with a raw
    // stack trace. EISDIR is the one that actually happens: a directory sitting where a config
    // file belongs. Rethrown as a plain Error so the loop reports it like any other target
    // error and the other targets still get processed.
    if (err.code === 'EISDIR') {
      throw new Error(`${posix(p)} is a directory, not a file. Move or remove it first.`);
    }
    throw new Error(`cannot read ${posix(p)}: ${err.code || err.message}`);
  }
}

// Write through a temp sibling and rename, so a PROCESS interruption cannot leave a live config
// file truncated: the target itself is only ever touched by rename(), so a killed, crashed or
// erroring run leaves either the old bytes or the new bytes, never half of either.
//
// This is NOT crash durability. There is no fsync of the file or of its directory, so a power
// loss or kernel panic can still lose the new contents, or the rename, after this returns.
// Guarding against the process dying is what this tool needs; guarding against the machine
// dying would cost two fsyncs per target for a config file the user can simply re-install.
//
// The temp path is UNLINKED first. A pre-existing symlink there would otherwise be FOLLOWED by
// the write, landing the payload wherever it points - a known trap in this repo. ENOENT is the
// normal case and is ignored; anything else is a real problem and propagates. 'wx' then refuses
// to write through anything that reappeared between the unlink and the open.
function writeAtomic(file, data, mode) {
  const tmp = `${file}.mavis-tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    // Keep the original's permission bits rather than handing it whatever the umask says.
    if (mode != null) {
      try { fs.chmodSync(tmp, mode); } catch { /* best effort; a no-op on Windows */ }
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// If the target is a symlink - a dotfiles repo checked out elsewhere and linked into place -
// write through to what it points at. writeFileSync used to follow the link for free; a temp
// sibling plus rename would instead REPLACE the link with a regular file and silently strand
// the dotfiles copy.
//
// This is resolved BEFORE the plan is printed, not at write time. The whole safety model here
// is dry-run-then-authorise, and a preview that names the wrong destination defeats the
// mechanism it exists to provide: the user reads "~/.claude/CLAUDE.md" and says yes to a write
// into some other directory entirely.
//
// A BROKEN link is reported rather than swallowed. Applying replaces a dangling link with a
// regular file, which is a reasonable outcome but not one to discover afterwards.
function linkInfo(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { dest: file, symlink: false, broken: false }; // absent, or unreadable: ordinary case
  }
  if (!st.isSymbolicLink()) return { dest: file, symlink: false, broken: false };
  try {
    return { dest: posix(fs.realpathSync(file)), symlink: true, broken: false };
  } catch {
    return { dest: file, symlink: true, broken: true };
  }
}

// Every EXISTING target is backed up before it is written - splice targets included. The old
// reasoning ("content outside the markers survives by construction") only held while the
// construction was sound, and the two targets carrying pre-existing user content were exactly
// the two with no recovery copy. Raw bytes, so the backup is a faithful copy of the original
// including its line endings. Fixed name: overwritten each run rather than accumulating.
function backupExisting(file) {
  const bak = `${file}.mavis-bak`;
  let mode;
  try { mode = fs.statSync(file).mode; } catch { /* keep default */ }
  writeAtomic(bak, fs.readFileSync(file), mode);
  return bak;
}

function readSource(rel) {
  const p = path.join(BRAIN_ROOT, rel);
  try {
    return fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
  } catch {
    console.error(`ERROR: missing source file ${rel} (looked in ${posix(BRAIN_ROOT)})`);
    process.exit(1);
  }
}

// {{USER_NAME}} comes from the brain's own identity file, which is gitignored - so the name
// never enters git while the installed contract still addresses the user by it. No fallback:
// guessing a name, or shipping the literal placeholder, both put wrong text in live config.
function readProfileName() {
  const p = path.join(BRAIN_ROOT, 'identity', 'profile.md');
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    throw new Error(
      `cannot read ${posix(p)}.\n` +
      '  The payload addresses the user by name, and that name lives in the brain\'s\n' +
      '  identity file (gitignored, so a fresh clone has none until setup runs).\n' +
      '  Run the Mavis setup wizard first, or create identity/profile.md with:\n' +
      '    ---\n    name: Your Name\n    ---'
    );
  }
  const name = (parseFrontmatter(text).fields.name || '').trim();
  if (!name) {
    throw new Error(
      `no "name:" field in the frontmatter of ${posix(p)}.\n` +
      '  Add one, for example:\n' +
      '    ---\n    name: Your Name\n    ---'
    );
  }
  return name;
}

function contractBytes() {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      return { name, bytes: fs.statSync(path.join(BRAIN_ROOT, name)).size };
    } catch { /* try the next one */ }
  }
  return null;
}

function codexConfigNotice() {
  const c = contractBytes();
  const measured = c
    ? `${c.name} is ${c.bytes.toLocaleString('en-US')} bytes today`
    : 'the brain contract could not be measured';
  return [
    '',
    'CODEX CONFIG - two keys this installer will NOT write for you',
    '-'.repeat(62),
    '~/.codex/config.toml holds your trusted-project entries and MCP server definitions.',
    'A scripted rewrite of that file is not worth the blast radius, so paste these two',
    'top-level keys yourself. They must sit ABOVE the first [section] header, or TOML',
    'reads them as belonging to that section.',
    '',
    '  # Mavis: no AI attribution trailer. Codex defaults this to',
    '  #   "Codex <noreply@openai.com>" and appends Co-authored-by to every commit.',
    '  # Empty string disables it. The commit-msg git hook stays the real backstop,',
    '  # because this key is machine-local while the hook travels with the brain.',
    '  commit_attribution = ""',
    '',
    '  # Mavis: pin the project-doc cap instead of trusting a per-version default.',
    `  # Codex truncates AGENTS.md SILENTLY past this, which reads as partial amnesia`,
    `  # rather than an error. ${measured}; lint-brain warns at 32 KB.`,
    '  project_doc_max_bytes = 65536',
    '',
  ].join('\n');
}

// Detection, with a test hook. The hook cannot cause a write on its own - --yes is still the
// only thing that writes - and a forced run says so in its first line of output.
function detect() {
  const forced = process.env.MAVIS_INSTALL_ASSUME_HARNESSES;
  if (forced != null && forced.trim() !== '') {
    const set = new Set(forced.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    return { claude: set.has('claude'), codex: set.has('codex'), forced: true };
  }
  return { ...detectHarnesses(), forced: false };
}

// --- main ------------------------------------------------------------------------------

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.unknown.length) {
    console.error(`ERROR: unknown argument(s): ${args.unknown.join(', ')}\n`);
    console.error(USAGE);
    return 2;
  }
  const requested = args.harness === 'both' ? ['claude', 'codex']
    : args.harness === 'claude' ? ['claude']
    : args.harness === 'codex' ? ['codex']
    : null;
  if (!requested) {
    console.error(
      args.harness
        ? `ERROR: --harness must be claude, codex, or both (got "${args.harness}")\n`
        : 'ERROR: --harness is required\n'
    );
    console.error(USAGE);
    return 2;
  }

  // Never assume a harness exists - probe PATH first.
  const detected = detect();
  console.log(detected.forced
    ? 'Harnesses ASSUMED present (MAVIS_INSTALL_ASSUME_HARNESSES is set, PATH not probed):'
    : 'Detected on PATH:');
  console.log(`  claude  ${detected.claude ? 'yes' : 'no'}`);
  console.log(`  codex   ${detected.codex ? 'yes' : 'no'}`);
  const missing = requested.filter(h => !detected[h]);
  if (missing.length) {
    console.error('');
    for (const h of missing) {
      console.error(
        `ERROR: --harness asked for "${h}" but "${h}" is not on PATH, so there is no ` +
        `${h === 'claude' ? '~/.claude' : '~/.codex'} home to install into.`
      );
    }
    console.error(
      `\nInstall it first, or re-run with --harness ${requested.filter(h => detected[h]).join(',') || '<the one you have>'}.`
    );
    return 2;
  }

  // Resolve placeholders BEFORE anything else sees the payload: the duplicate-contract guard
  // keys on headings, and the title heading carries {{USER_NAME}}. Resolving first is also
  // what keeps the operation idempotent - the resolved text has no placeholders left, so a
  // second run produces identical bytes.
  let invariants;
  let slash;
  let outputStyle;
  let userName;
  try {
    userName = readProfileName();
    const values = { USER_NAME: userName, BRAIN_ROOT: posix(BRAIN_ROOT) };
    invariants = resolvePlaceholders(readSource(path.join('mavis', 'global-invariants.md')), values);
    slash = resolvePlaceholders(readSource(path.join('mavis', 'slash-mavis.md')), values);
    outputStyle = resolvePlaceholders(readSource(path.join('mavis', 'output-style-terse.md')), values);
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    console.error('\nNothing was written. An unresolved placeholder must never reach a live');
    console.error('config file, so the install stops here rather than shipping one.');
    return 1;
  }

  const homes = {
    claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    invariants,
    slash,
    outputStyle,
  };

  const apply = args.yes && !args.dryRun;
  if (args.yes && args.dryRun) {
    console.log('\nNOTE: --dry-run and --yes were both passed. Dry run wins; nothing is written.');
  }

  let targets = [];
  for (const h of requested) targets = targets.concat(targetsFor(h, homes));
  if (!args.global) {
    targets = targets.filter(t => t.kind !== 'global');
  }

  console.log(`\nBrain root: ${posix(BRAIN_ROOT)}${BRAIN_ROOT === ROOT ? '' : '  (MAVIS_BRAIN_ROOT)'}`);
  console.log(`Installing for: ${userName}  (from identity/profile.md)`);
  console.log(`Mode:       ${apply ? 'APPLY (--yes)' : 'DRY RUN (default - pass --yes to write)'}`);
  if (!args.global) {
    console.log('Note:       --global not passed, so the always-on instruction files');
    console.log('            (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) are skipped.');
  }

  let changed = 0;
  let failed = 0;
  let written = 0;

  for (const t of targets) {
    // Resolved up front so the DRY RUN names the real destination too, not just the apply.
    const link = linkInfo(t.path);
    let current;
    let next;
    try {
      current = readIfExists(t.path);
      next = t.mode === 'splice'
        ? spliceMarkers(current.text, t.payload)
        : t.payload.endsWith('\n') ? t.payload : `${t.payload}\n`;
    } catch (err) {
      failed++;
      console.log(`\n=== ${t.label} ===`);
      console.log(`  path:  ${t.path}`);
      console.log(`  ERROR: ${err.message}`);
      // Attribute the failure to the file that actually holds the bad markers. A payload
      // problem sends the user to the brain source; a target problem sends them to their own
      // config. Telling them to hand-edit the wrong file is worse than saying nothing.
      if (/^malformed payload/.test(err.message)) {
        console.log('  Source: the PAYLOAD, not this target file. Fix it at');
        console.log(`          ${posix(path.join(BRAIN_ROOT, 'mavis', 'global-invariants.md'))}`);
      } else if (/^malformed mavis markers/.test(err.message)) {
        console.log('  Fix the markers in this target file by hand; this installer will');
        console.log('  not guess which ones are its own.');
      }
      continue;
    }

    console.log(`\n=== ${t.label} ===`);
    console.log(`  path:   ${t.path}`);
    if (link.broken) {
      console.log('  symlink: BROKEN - this path is a symlink whose destination does not');
      console.log('           exist. Applying REPLACES the link with a regular file.');
    } else if (link.symlink) {
      console.log(`  symlink: this path is a link; writes go through to ${link.dest}`);
    }
    console.log(`  status: ${current.exists ? 'exists' : 'does not exist yet (would be created)'}`);
    console.log(`  mode:   ${t.mode === 'splice' ? 'splice between mavis markers (outside content preserved)' : 'whole file'}`);

    // FAIL CLOSED. The file already carries this contract unmarked, so splicing would append a
    // second copy. Two copies of an operating contract in one file is worse than no install.
    if (t.mode === 'splice') {
      const dup = isDuplicateContract(current.text, t.payload);
      if (dup.duplicate) {
        failed++;
        console.log('  REFUSED - nothing written to this file.');
        console.log('');
        console.log('    This file already contains an unmarked copy of the Mavis contract.');
        console.log('    Splicing appends, so applying would leave TWO copies of the operating');
        console.log('    contract in one file. Headings found outside the marker block that also');
        console.log('    appear in the payload:');
        for (const h of dup.headings.slice(0, 8)) console.log(`      ${h}`);
        if (dup.headings.length > 8) console.log(`      ... and ${dup.headings.length - 8} more`);
        console.log('');
        console.log('    Do ONE of these by hand, then re-run:');
        console.log('      1. Delete the old unmarked copy from the file, keeping anything that');
        console.log('         is not part of the Mavis contract; or');
        console.log('      2. Wrap the old copy in <!-- mavis:begin --> / <!-- mavis:end -->');
        console.log('         yourself - the installer then replaces it in place, every run.');
        console.log('');
        console.log('    This installer will not edit that text for you. Guessing which copy to');
        console.log('    drop is a silent rewrite of live config, and a wrong guess deletes your');
        console.log('    own edits.');
        continue;
      }
    }

    const diff = unifiedDiff(t.label, current.text, next);
    if (!diff) {
      console.log('  result: already up to date, nothing to change');
      continue;
    }
    // The bytes that actually land: the diff is line-based and LF, the file keeps its own
    // endings.
    const outText = applyEol(next, current.eol);
    changed++;
    if (current.eol === '\r\n') {
      console.log('  endings: CRLF - the file\'s existing line endings are preserved');
    }
    console.log(`  result: ${Buffer.byteLength(outText, 'utf8')} bytes would be written`);
    console.log('');
    console.log(diff.split('\n').map(l => `  ${l}`).join('\n'));

    if (!apply) continue;

    try {
      fs.mkdirSync(path.dirname(t.path), { recursive: true });
      // Already announced above, in both modes - the dry run promised this exact destination.
      const dest = link.broken ? t.path : link.dest;
      let mode;
      if (current.exists) {
        try { mode = fs.statSync(dest).mode; } catch { /* keep default */ }
        console.log(`\n  backup: ${backupExisting(dest)}`);
      }
      writeAtomic(dest, Buffer.from(outText, 'utf8'), mode);
    } catch (err) {
      failed++;
      console.log(`\n  ERROR:  could not write ${t.path}`);
      console.log(`          ${err.message}`);
      console.log('          The original file is untouched - the new bytes go to a temp');
      console.log('          sibling and are renamed into place only once fully written.');
      continue;
    }
    written++;
    console.log(`  WROTE:  ${t.path}`);
  }

  if (requested.includes('codex')) console.log(codexConfigNotice());

  console.log('');
  console.log('-'.repeat(62));
  console.log(`Targets inspected: ${targets.length}   would change: ${changed}   errors: ${failed}`);
  if (apply) {
    console.log(`Files written:     ${written}`);
    if (failed) {
      console.log('Refused/errored:   resolve the files marked REFUSED or ERROR above; they');
      console.log('                   were NOT written. Re-run once they are fixed.');
    }
  } else {
    console.log('Files written:     0 (dry run)');
    if (failed) {
      console.log('Refused/errored:   resolve the files marked REFUSED or ERROR above first.');
    }
    if (changed && !failed) {
      const flags = ['--harness ' + args.harness, args.global ? '--global' : null, '--yes']
        .filter(Boolean).join(' ');
      console.log(`To apply:          node scripts/install-harness.mjs ${flags}`);
    }
  }
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
