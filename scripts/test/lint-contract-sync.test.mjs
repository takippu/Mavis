// Tests for the contract-sync lint check and AGENTS.md classification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, checkContractSync, checkSizes, lint } from '../lib/brain-lint-core.mjs';
import { renderClaude } from '../lib/contract-sync-core.mjs';

// Self-located, same technique as lint-core.test.mjs's BRAIN_ROOT: scripts/test/ -> scripts/ ->
// brain root. Used only to assert lint() does not throw on the real root - never to assert
// specific counts/flags, since another agent is actively editing AGENTS.md in this checkout.
const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_BRAIN_ROOT = path.resolve(here, '..', '..');

function makeBrain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cs-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

test('classify puts AGENTS.md in the boot class with the 32KB warn', () => {
  const c = classify('AGENTS.md');
  assert.equal(c.cls, 'boot');
  assert.equal(c.warnKB, 32);
});

test('no flag when CLAUDE.md matches the render of AGENTS.md', () => {
  const src = 'contract body\n';
  const root = makeBrain({ 'AGENTS.md': src, 'CLAUDE.md': renderClaude(src) });
  assert.deepEqual(checkContractSync(root), []);
});

test('fail flag when CLAUDE.md has drifted', () => {
  const root = makeBrain({ 'AGENTS.md': 'a\n', 'CLAUDE.md': 'stale\n' });
  const flags = checkContractSync(root);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].type, 'contract-sync');
  assert.equal(flags[0].severity, 'fail');
  assert.equal(flags[0].file, 'CLAUDE.md');
  assert.match(flags[0].suggestedAction, /sync-contract\.mjs --write/);
});

test('fail flag when CLAUDE.md is missing entirely', () => {
  // Assert on the flag's identity (type/file/detail), not just that one flag appeared -- a
  // count-only assertion is exactly the weakness that let the dead checkSizes AGENTS.md budget
  // pass its first test (round 1 finding). Nothing else in this fixture could produce a flag,
  // but pin the identity anyway so this test still means something once that stops being true.
  const root = makeBrain({ 'AGENTS.md': 'a\n' });
  const flags = checkContractSync(root);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].type, 'contract-sync');
  assert.equal(flags[0].severity, 'fail');
  assert.equal(flags[0].file, 'CLAUDE.md');
  assert.match(flags[0].detail, /missing/i);
});

test('fail flag when AGENTS.md is malformed, without throwing', () => {
  const root = makeBrain({ 'AGENTS.md': '<!-- harness:codex -->\nunclosed\n', 'CLAUDE.md': 'x\n' });
  const flags = checkContractSync(root);
  assert.equal(flags.length, 1);
  assert.match(flags[0].detail, /unclosed/i);
});

test('fail flag distinguishes an unreadable AGENTS.md from a malformed one', () => {
  // AGENTS.md replaced by a directory produces a real fs error (EISDIR), not a syntax
  // problem -- the message must say so, not send the reader hunting for a marker/fence
  // defect that does not exist. mkdirSync-as-a-file is the portable way to force a genuine
  // fs.readFileSync failure without relying on permission bits (Windows/NTFS has none).
  const root = makeBrain({ 'CLAUDE.md': 'x\n' });
  fs.mkdirSync(path.join(root, 'AGENTS.md'));
  const flags = checkContractSync(root);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].type, 'contract-sync');
  assert.match(flags[0].detail, /could not be read/i);
  assert.ok(!/malformed/i.test(flags[0].detail),
    'a read failure must not be reported as a malformed/syntax problem');
});

test('silent on a legacy brain with no AGENTS.md', () => {
  const root = makeBrain({ 'CLAUDE.md': 'legacy\n' });
  assert.deepEqual(checkContractSync(root), []);
});

test('lint() accepts a brain rooted by a contract file + SETUP.md, with no projects/', () => {
  // SETUP.md is the corroborating marker the root assertion now requires alongside a bare
  // contract file (round 3) -- without it this fixture would no longer pass the root
  // assertion at all, which is a different thing from what this test exists to check
  // (that checkContractSync's output actually reaches lint()'s composed flags).
  const root = makeBrain({
    'AGENTS.md': 'a\n',
    'CLAUDE.md': renderClaude('a\n'),
    'SETUP.md': '# Mavis - Setup & Reset\n',
  });
  assert.doesNotThrow(() => lint(root));
});

test('lint() composes contract-sync into its flags', () => {
  const root = makeBrain({
    'AGENTS.md': 'a\n',
    'CLAUDE.md': 'drifted\n',
    'SETUP.md': '# Mavis - Setup & Reset\n',
  });
  const report = lint(root);
  assert.ok(report.flags.some(f => f.type === 'contract-sync'));
  assert.ok(report.counts.fail >= 1);
});

// checkSizes() built its candidate list by hand and never included AGENTS.md, so
// classify('AGENTS.md') returning the boot class was inert in practice: nothing ever called
// classify() with 'AGENTS.md' as input. AGENTS.md is the file Codex actually reads and
// silently truncates past project_doc_max_bytes, so this budget existing on paper but never
// firing is exactly the failure the boot class exists to catch. These assert on the flag's
// `file` field specifically -- a test that only counted flags would already have passed via
// the unrelated CLAUDE.md entry in the same fixture and proven nothing.
test('checkSizes flags an oversized AGENTS.md by name at the warn tier', () => {
  const root = makeBrain({ 'AGENTS.md': 'x'.repeat(40 * 1024) }); // > 32KB, <= 64KB -> warn
  const flags = checkSizes(root);
  const f = flags.find(x => x.file === 'AGENTS.md');
  assert.ok(f, `expected a flag naming AGENTS.md; got: ${JSON.stringify(flags)}`);
  assert.equal(f.severity, 'warn');
  assert.equal(f.type, 'size');
});

test('checkSizes flags an oversized AGENTS.md by name at the fail tier', () => {
  const root = makeBrain({ 'AGENTS.md': 'x'.repeat(70 * 1024) }); // > 64KB -> fail
  const flags = checkSizes(root);
  const f = flags.find(x => x.file === 'AGENTS.md');
  assert.ok(f, `expected a flag naming AGENTS.md; got: ${JSON.stringify(flags)}`);
  assert.equal(f.severity, 'fail');
  assert.equal(f.type, 'size');
});

test('checkSizes does not flag an AGENTS.md under the 32KB warn threshold', () => {
  const root = makeBrain({ 'AGENTS.md': 'x'.repeat(10 * 1024) });
  assert.equal(checkSizes(root).find(x => x.file === 'AGENTS.md'), undefined);
});

// --- Root assertion (round 2 + round 3) ---------------------------------------------------
// Round 2: AGENTS.md is a cross-tool convention (Codex and others), not Mavis-specific, so
// round 1's literal transcription of the brief ("add AGENTS.md to the OR") let an arbitrary
// directory that merely has one pass as a brain root and then fail downstream with a
// confusing contract-sync flag instead of a clear rejection. Fixed by requiring AGENTS.md be
// paired with SETUP.md, the brain's own committed bootstrap file.
//
// Round 3: that fix was asymmetric -- CLAUDE.md remained bare-accepted, which is the SAME
// cross-tool-convention looseness (CLAUDE.md is a generic Claude Code project-instructions
// convention, not exclusively a Mavis marker either) with no principled reason to treat it
// differently from AGENTS.md. Closed by requiring EITHER contract file to be paired with
// SETUP.md; projects/ remains sufficient on its own (only a set-up brain has it -- it's
// gitignored, so it can't exist on a fresh clone by accident).
//
// projects/, identity/, rules/, topics/, preferences/ are all gitignored (see .gitignore), so
// a fresh clone before setup ships none of them -- what it DOES ship is a contract file
// (CLAUDE.md and/or AGENTS.md) alongside SETUP.md. A pre-rename (legacy) brain ships CLAUDE.md
// + SETUP.md with no AGENTS.md yet, and must still lint -- SETUP.md's own Recalibrate offer
// depends on being able to run against exactly that shape. The seven cases below are exactly
// the ones named in the round-3 fix request, each with its own assertion.

test('root assertion: the real brain is accepted', () => {
  // Self-located, not hardcoded, and asserts only non-throw -- never specific counts/flags --
  // because another agent is actively editing AGENTS.md in this same checkout.
  assert.doesNotThrow(() => lint(REAL_BRAIN_ROOT));
});

test('root assertion: a simulated fresh clone (full committed file set) is accepted', () => {
  // Exactly the root-level files `git ls-files` reports as committed today (AGENTS.md,
  // CLAUDE.md, CONTRIBUTING.md, LICENSE, README.md, SETUP.md, .gitignore) -- no gitignored
  // dirs (projects/, identity/, rules/, topics/, preferences/, daily-memories/) present.
  const root = makeBrain({
    'AGENTS.md': 'contract\n',
    'CLAUDE.md': renderClaude('contract\n'),
    'SETUP.md': '# Mavis - Setup & Reset\n',
    'README.md': '# Mavis\n',
    'CONTRIBUTING.md': '# Contributing\n',
    'LICENSE': 'MIT\n',
  });
  assert.doesNotThrow(() => lint(root));
});

test('root assertion: a simulated fresh clone (AGENTS.md + SETUP.md only) is accepted', () => {
  // Isolates the branch specifically: proves AGENTS.md paired with the Mavis-specific
  // SETUP.md is sufficient on its own, not merely riding along on the pre-existing CLAUDE.md
  // acceptance the fuller fresh-clone fixture above also happens to satisfy.
  const root = makeBrain({ 'AGENTS.md': 'contract\n', 'SETUP.md': '# Mavis - Setup & Reset\n' });
  assert.doesNotThrow(() => lint(root));
});

test('root assertion: a simulated legacy (pre-rename) brain is accepted', () => {
  // CLAUDE.md + SETUP.md, no AGENTS.md at all -- the shape of a brain that has not migrated
  // onto the AGENTS.md-canonical layout yet. Must still lint, or `recalibrate` cannot use lint
  // output to diagnose it in the first place.
  const root = makeBrain({ 'CLAUDE.md': 'legacy\n', 'SETUP.md': '# Mavis - Setup & Reset\n' });
  assert.doesNotThrow(() => lint(root));
});

test('root assertion: projects/ alone is accepted', () => {
  // A set-up brain -- projects/ is gitignored, so its mere existence already implies setup ran.
  const root = makeBrain({ 'projects/ok/progress.md': '# fine\n' });
  assert.doesNotThrow(() => lint(root));
});

test('root assertion: a directory with ONLY a generic AGENTS.md is REJECTED', () => {
  const root = makeBrain({ 'AGENTS.md': 'some unrelated agent instructions, nothing to do with Mavis\n' });
  assert.throws(() => lint(root), /not a brain root/i);
});

test('root assertion: a directory with ONLY a generic CLAUDE.md is REJECTED', () => {
  // Symmetric with the AGENTS.md case above -- round 3's whole point. A bare CLAUDE.md with no
  // SETUP.md and no projects/ must be rejected exactly like a bare AGENTS.md is.
  const root = makeBrain({ 'CLAUDE.md': 'some unrelated project instructions, nothing to do with Mavis\n' });
  assert.throws(() => lint(root), /not a brain root/i);
});

test('root assertion: an empty directory is REJECTED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cs-empty-'));
  assert.throws(() => lint(root), /not a brain root/i);
});

// ---- line endings are not drift ----
//
// Git for Windows ships core.autocrlf=true as a SYSTEM default, so a plain `git checkout`
// rewrites the working-copy CLAUDE.md to CRLF while renderClaude() always emits LF. A byte
// comparison then reports permanent drift on a contract that is character-for-character
// correct, and `sync-contract.mjs --write` cannot clear it -- the next checkout converts the
// file straight back. Observed live in this repo on 2026-08-03.

test('a CRLF CLAUDE.md against an LF render is NOT reported as drift', () => {
  const source = fs.readFileSync(path.join(REAL_BRAIN_ROOT, 'AGENTS.md'), 'utf8');
  const rendered = renderClaude(source);
  const root = makeBrain({
    'AGENTS.md': source,
    'SETUP.md': '# Mavis - Setup & Reset\n',
    'CLAUDE.md': rendered.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'),
  });
  assert.deepEqual(checkContractSync(root), [], 'CRLF alone must not flag contract drift');
});

test('a CRLF CLAUDE.md with REAL content drift is still reported', () => {
  // The normalization must not become a blanket pass. Same CRLF conversion, one word changed.
  const source = fs.readFileSync(path.join(REAL_BRAIN_ROOT, 'AGENTS.md'), 'utf8');
  const rendered = renderClaude(source);
  const tampered = (rendered + '\nAN EXTRA LINE THAT AGENTS.md DOES NOT HAVE\n')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n');
  const root = makeBrain({
    'AGENTS.md': source,
    'SETUP.md': '# Mavis - Setup & Reset\n',
    'CLAUDE.md': tampered,
  });
  const flags = checkContractSync(root);
  assert.equal(flags.length, 1, 'real drift must still flag even when both files are CRLF');
  assert.match(flags[0].detail, /drifted/i);
});
