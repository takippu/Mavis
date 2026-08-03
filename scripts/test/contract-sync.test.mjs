// Tests for the contract render core: marker handling, line endings, error cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderClaude, BANNER } from '../lib/contract-sync-core.mjs';

test('strips codex-only blocks entirely', () => {
  const src = [
    'shared one',
    '<!-- harness:codex -->',
    'codex only line',
    '<!-- /harness -->',
    'shared two',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(!out.includes('codex only line'));
  assert.ok(out.includes('shared one'));
  assert.ok(out.includes('shared two'));
});

test('unwraps claude-only blocks, keeping the body and dropping the markers', () => {
  const src = [
    'shared',
    '<!-- harness:claude -->',
    'claude only line',
    '<!-- /harness -->',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('claude only line'));
  assert.ok(!out.includes('harness:claude'));
  assert.ok(!out.includes('/harness'));
});

test('prepends the banner exactly once', () => {
  const out = renderClaude('body');
  assert.ok(out.startsWith(BANNER));
  assert.equal(out.split(BANNER).length - 1, 1);
});

test('is idempotent in output for repeated calls', () => {
  const src = 'a\n<!-- harness:codex -->\nb\n<!-- /harness -->\nc\n';
  assert.equal(renderClaude(src), renderClaude(src));
});

test('normalizes CRLF input to LF output', () => {
  const out = renderClaude('a\r\n<!-- harness:codex -->\r\nb\r\n<!-- /harness -->\r\nc\r\n');
  assert.ok(!out.includes('\r'));
  assert.ok(out.includes('a\nc'));
});

test('collapses the blank gap left by a stripped block', () => {
  const src = 'a\n\n<!-- harness:codex -->\nb\n<!-- /harness -->\n\nc\n';
  const out = renderClaude(src);
  assert.ok(!/\n{3,}/.test(out), 'no run of 3+ newlines should survive');
});

test('throws on an unclosed marker', () => {
  assert.throws(
    () => renderClaude('a\n<!-- harness:codex -->\nb\n'),
    /unclosed/i,
  );
});

test('throws on a close with no open', () => {
  assert.throws(() => renderClaude('a\n<!-- /harness -->\n'), /unmatched/i);
});

test('throws on a nested marker', () => {
  const src = '<!-- harness:codex -->\n<!-- harness:claude -->\nx\n<!-- /harness -->\n<!-- /harness -->';
  assert.throws(() => renderClaude(src), /nested/i);
});

test('throws on an unknown harness name', () => {
  assert.throws(
    () => renderClaude('<!-- harness:gemini -->\nx\n<!-- /harness -->'),
    /unknown harness/i,
  );
});

test('leaves a marker-looking string inside a fenced code block alone', () => {
  const src = [
    'text',
    '```',
    '<!-- harness:codex -->',
    'documented example',
    '<!-- /harness -->',
    '```',
    'end',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('documented example'), 'code fence content must survive verbatim');
});

// --- Fix round 1 regressions -------------------------------------------------
// Both Critical findings were confirmed by running the brief's own Step 3 code:
// a near-miss marker silently passed through as body content instead of
// erroring, and the final blank-line collapse ran with no fence awareness and
// no notion of "only the gap a removal left behind" -- it rewrote arbitrary
// content. These tests pin down the two confirmed failing inputs plus the
// other requested coverage (fence-blank preservation, non-string input).

test('throws on a malformed marker with trailing content after "-->" (confirmed input 1)', () => {
  const src = 'a\n<!-- harness:codex --> keep out\nsecret line\n<!-- /harness --> done\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('throws on the same malformed marker indented by 4 spaces (confirmed input 2)', () => {
  const src = 'a\n    <!-- harness:codex --> keep out\nsecret line\n    <!-- /harness --> done\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('preserves consecutive blank lines inside a fenced code block untouched', () => {
  const src = [
    'a',
    '```',
    'line1',
    '',
    '',
    'line2',
    '```',
    'b',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(
    out.includes('line1\n\n\nline2'),
    'a fenced code block is literal content -- the two blank lines inside it must not be collapsed',
  );
});

test('preserves an intentional multi-blank-line separator in ordinary prose', () => {
  const src = 'a\n\n\n\nb';
  const out = renderClaude(src);
  assert.ok(
    out.includes('a\n\n\n\nb'),
    'blank-line runs that were not created by a stripped block must survive untouched',
  );
});

test('throws on a mismatched close-tag name', () => {
  const src = '<!-- harness:codex -->\nx\n<!-- /harness:claude -->';
  assert.throws(() => renderClaude(src), /mismatched/i);
});

test('accepts a close-tag name that matches the currently open block', () => {
  const src = 'a\n<!-- harness:codex -->\nx\n<!-- /harness:codex -->\nb';
  const out = renderClaude(src);
  assert.ok(!out.includes('x'));
  assert.ok(out.includes('a') && out.includes('b'));
});

test('throws on a non-string input instead of stringifying it', () => {
  assert.throws(() => renderClaude(null), TypeError);
  assert.throws(() => renderClaude(undefined), TypeError);
  assert.throws(() => renderClaude(42), TypeError);
});

// --- Fix round 2 regressions -------------------------------------------------
// Round 1's LOOSE_MARKER_RE was unanchored: it matched "harness" inside a
// "<!--...-->" ANYWHERE on the line, so it also fired on ordinary prose that
// documents the marker syntax -- exactly what the real ~30KB AGENTS.md does in
// its own prose and tables. These pin down the three confirmed false-positive
// lines verbatim, a backtick-led inline-code variant, and a distinct table row,
// while keeping the round-1 malformed-marker throws intact.

test('does not throw on prose that documents the marker syntax with an inline code span', () => {
  const src = 'a\nUse `<!-- harness:codex -->` to mark a Codex-only block.\nb';
  const out = renderClaude(src);
  assert.ok(out.includes('Use `<!-- harness:codex -->` to mark a Codex-only block.'));
});

// SUPERSEDED BY ROUND 3 -- do not "fix" this back to a pass. Round 2's
// positional rule let this line through because it doesn't start with "<!--".
// Round 3 replaced that rule: "Our contract supports <!-- harness:claude -->
// markers for this." has the exact same shape as the round-2 leak
// "- <!-- harness:codex -->" (a marker-shaped, unbackticked comment with a
// non-whitespace prefix) -- no positional test can tell them apart, and the
// leak must throw. So unbackticked prose that contains a marker-shaped
// comment now throws too. This is deliberate: ambiguous input fails loudly
// instead of silently guessing. Wrap the comment in backticks to document it
// literally (see the inline-code-span test above, which still passes).
test('throws on prose that mentions a marker mid-sentence, unbackticked (round 3: deliberate)', () => {
  const src = 'a\nOur contract supports <!-- harness:claude --> markers for this.\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

// SUPERSEDED BY ROUND 3 -- same rationale as above. An unbackticked table
// cell quoting a marker-shaped comment is structurally identical to the
// round-2 leak case and must throw now; a backtick-wrapped table cell (see
// "does not throw on a full markdown table documenting marker syntax" below)
// still passes.
test('throws on a table cell that quotes marker text, unbackticked (round 3: deliberate)', () => {
  const src = 'a\n| marker | <!-- harness:codex --> | strips the block |\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('does not throw when the trimmed line starts with a backtick, not the comment', () => {
  const src = 'a\n`<!-- harness:codex -->` is the marker\nb';
  const out = renderClaude(src);
  assert.ok(out.includes('`<!-- harness:codex -->` is the marker'));
});

test('does not throw on a full markdown table documenting marker syntax', () => {
  const src = [
    '| Marker | Effect |',
    '|--------|--------|',
    '| `<!-- harness:codex -->` | strips the block |',
    '| `<!-- harness:claude -->` | keeps the block, drops the markers |',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('| `<!-- harness:codex -->` | strips the block |'));
  assert.ok(out.includes('| `<!-- harness:claude -->` | keeps the block, drops the markers |'));
});

test('still throws on the round-1 confirmed malformed marker with trailing content', () => {
  const src = 'a\n<!-- harness:codex --> keep out\nsecret line\n<!-- /harness --> done\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('still throws on the round-1 confirmed 4-space-indented malformed marker', () => {
  const src = 'a\n    <!-- harness:codex --> keep out\nsecret line\n    <!-- /harness --> done\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('still strips a correctly formed codex block sitting next to marker-documenting prose', () => {
  const src = [
    'Use `<!-- harness:codex -->` to mark a Codex-only block.',
    '<!-- harness:codex -->',
    'secret line',
    '<!-- /harness -->',
    'end',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('Use `<!-- harness:codex -->` to mark a Codex-only block.'));
  assert.ok(!out.includes('secret line'));
  assert.ok(out.includes('end'));
});

// --- Fix round 3 regressions --------------------------------------------------
// Round 2's positional rule ("only a line whose trimmed content starts with
// '<!--' is a candidate marker") could not separate a real marker with a
// non-whitespace prefix (e.g. a list dash) from prose containing the same
// shape -- so it over-corrected round 1's over-throw into a new silent leak.
// Round 3 replaces it with a SHAPE-based rule: a comment is only an attempted
// marker if its trimmed inner content is exactly "harness", "harness:<name>",
// "/harness", or "/harness:<name>" (MARKER-SHAPED), and it is not inside an
// inline code span. Every row of the coordinator's verification matrix gets
// its own test here, in the matrix's own order, so the mapping from
// requirement to test is auditable line-by-line.

test('matrix: PASS -- a genuine comment that merely contains the word "harness" is not marker-shaped', () => {
  const src = 'a\n<!-- TODO: revisit the harness story later -->\nb';
  const out = renderClaude(src);
  assert.ok(out.includes('<!-- TODO: revisit the harness story later -->'));
});

test('matrix: PASS -- a marker-shaped comment inside an inline code span is literal', () => {
  const src = 'a\nUse `<!-- harness:codex -->` to mark a block.\nb';
  const out = renderClaude(src);
  assert.ok(out.includes('Use `<!-- harness:codex -->` to mark a block.'));
});

test('matrix: PASS -- a fenced block containing marker text is literal', () => {
  const src = ['a', '```', '<!-- harness:codex -->', 'still literal', '```', 'b'].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('<!-- harness:codex -->'));
  assert.ok(out.includes('still literal'));
});

test('matrix: PASS -- an unrelated comment is ordinary content', () => {
  const src = 'a\n<!-- note: nothing to do with this -->\nb';
  const out = renderClaude(src);
  assert.ok(out.includes('<!-- note: nothing to do with this -->'));
});

test('matrix: THROW -- a real marker prefixed by a list dash must not leak (round-2 regression)', () => {
  const src = 'a\n- <!-- harness:codex -->\nsecret\n<!-- /harness -->\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('matrix: THROW -- an unbackticked table cell with the same shape as the leak', () => {
  const src = 'a\n| m | <!-- harness:codex --> | strips |\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('matrix: THROW -- unbackticked prose mentioning a marker (deliberate, see round-3 note above)', () => {
  const src = 'a\nOur contract supports <!-- harness:claude --> markers.\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('matrix: THROW -- a marker with trailing junk after "-->"', () => {
  const src = 'a\n<!-- harness:codex --> keep out\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('matrix: THROW -- a marker indented past the 0-3 space strict-form limit', () => {
  const src = 'a\n    <!-- harness:codex -->\nb';
  assert.throws(() => renderClaude(src), /malformed/i);
});

test('matrix: THROW -- a well-formed marker with an unknown harness name', () => {
  const src = 'a\n<!-- harness:gemini -->\nb';
  assert.throws(() => renderClaude(src), /unknown harness/i);
});

test('matrix: WORKS -- a correctly formed claude block unwraps and a codex block strips', () => {
  const src = [
    'shared',
    '<!-- harness:claude -->',
    'claude only',
    '<!-- /harness -->',
    '<!-- harness:codex -->',
    'codex only',
    '<!-- /harness -->',
    'end',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('claude only'));
  assert.ok(!out.includes('codex only'));
  assert.ok(!out.includes('harness:claude'));
  assert.ok(out.includes('shared') && out.includes('end'));
});

// --- Fix round 4 regressions --------------------------------------------------
// Every check in the render core operates on ONE array line, so an HTML comment
// spanning two lines was invisible to all of them: a marker split across lines
// opened no block, closed no block, and tripped no validator -- the wrapped
// codex content rendered verbatim into the Claude contract with no error. This
// was present since round 1's line-splitting design, not introduced by round 3.
// The fix is a lexical precondition, NOT a multi-line comment parser: outside a
// fenced code block, a comment must open and close on the same line or the
// render throws. The real contract carries zero HTML comments, so this costs
// nothing and turns a silent leak into a loud error.

test('round 4: throws on a marker split across lines instead of leaking the block (confirmed input)', () => {
  const src = ['a', '<!-- harness:codex', '-->', 'secret content', '<!-- /harness', '-->', 'b'].join('\n');
  assert.throws(() => renderClaude(src), /multi-line HTML comments are not supported/i);
  // And, belt-and-braces: the wrapped content must never reach an output at all.
  let leaked = null;
  try {
    leaked = renderClaude(src);
  } catch {
    leaked = null;
  }
  assert.equal(leaked, null, 'a split marker must throw, never render "secret content"');
});

test('round 4: throws when only the OPENING marker is broken across lines', () => {
  const src = ['a', '<!-- harness:codex', '-->', 'secret content', '<!-- /harness -->', 'b'].join('\n');
  assert.throws(() => renderClaude(src), /multi-line HTML comments are not supported/i);
});

test('round 4: throws when only the CLOSING marker is broken across lines', () => {
  const src = ['a', '<!-- harness:codex -->', 'secret content', '<!-- /harness', '-->', 'b'].join('\n');
  // The broken close sits INSIDE an open codex block, so the check has to run
  // before the codex-drop -- otherwise the line is silently discarded and the
  // failure surfaces as a generic "unclosed" at EOF, pointing at the wrong line.
  assert.throws(() => renderClaude(src), /multi-line HTML comments are not supported/i);
});

test('round 4: throws on a stray "-->" with no opener on the same line', () => {
  assert.throws(() => renderClaude('a\n-->\nb'), /stray/i);
  assert.throws(() => renderClaude('a\n-->\nb'), /multi-line HTML comments are not supported/i);
});

test('round 4: a fenced code block containing an unbalanced "<!--" must NOT throw', () => {
  const src = ['a', '```', '<!-- harness:codex', '-->', 'still literal', '```', 'b'].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('<!-- harness:codex\n-->\nstill literal'), 'fence content must survive verbatim');
  assert.ok(out.includes('a') && out.includes('b'));
});

test('round 4: a fenced code block containing a stray "-->" must NOT throw', () => {
  const src = ['a', '~~~', '-->', 'still literal', '~~~', 'b'].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('-->\nstill literal'), 'fence content must survive verbatim');
});

test('round 4: a backtick-quoted comment fragment is literal, not a broken comment', () => {
  // Consistent with the settled round-3 rule that backticks make comment syntax
  // literal: documenting the opener alone must not trip the one-line check.
  const src = 'a\nAn HTML comment opens with `<!--` and closes with `-->`.\nb';
  const out = renderClaude(src);
  assert.ok(out.includes('An HTML comment opens with `<!--` and closes with `-->`.'));
});

test('round 4: masking code spans does not blind the check to a real unbalanced opener', () => {
  const src = 'a\nSee `someCode()` then <!-- harness:codex\n-->\nsecret\nb';
  assert.throws(() => renderClaude(src), /multi-line HTML comments are not supported/i);
});

test('round 4: a well-formed single-line comment on its own is still untouched', () => {
  const src = 'a\n<!-- TODO: revisit the harness story later -->\nb';
  const out = renderClaude(src);
  assert.ok(out.includes('<!-- TODO: revisit the harness story later -->'));
});

// --- Fix round 5 regressions --------------------------------------------------
// The last member of the silent-leak family. Fence content is literal by design,
// so a fence that never closes swallows the whole rest of the document: a real
// codex block inside it is never interpreted and renders verbatim into the
// Claude contract with no error. The fix is an end-of-parse invariant -- if a
// fence is still open when the line loop finishes, the render throws and names
// the line the fence opened on. An unclosed fence is malformed markdown that
// renders badly in every renderer, so no legitimate document is rejected. The
// four "must keep working" cases (tilde fences, over-long closing fences, a
// fence closed on the final line with no trailing newline) are pinned below.

test('round 5: throws on an unclosed fence instead of leaking a codex block inside it (confirmed input)', () => {
  const src = [
    'text',
    '```js',
    'code here',
    '<!-- harness:codex -->',
    'secret in unclosed fence',
    '<!-- /harness -->',
  ].join('\n');
  assert.throws(() => renderClaude(src), /unterminated code fence/i);
  assert.throws(() => renderClaude(src), /unclosed code fence/i);
  // The fence opens on line 2 -- the error must name it, not some later symptom.
  assert.throws(() => renderClaude(src), /line 2/);
  // Belt-and-braces: no output may ever be produced for this input.
  let leaked = null;
  try {
    leaked = renderClaude(src);
  } catch {
    leaked = null;
  }
  assert.equal(leaked, null, 'an unclosed fence must throw, never render "secret in unclosed fence"');
});

test('round 5: throws on an unclosed tilde fence', () => {
  const src = ['text', '~~~', 'code here', '<!-- harness:codex -->', 'secret', '<!-- /harness -->'].join('\n');
  assert.throws(() => renderClaude(src), /unterminated code fence/i);
  assert.throws(() => renderClaude(src), /line 2/);
});

test('round 5: a fence closed on the final line with no trailing newline must NOT throw', () => {
  const src = 'a\n```\ncode here\n```';
  const out = renderClaude(src);
  assert.ok(out.includes('code here'), 'fence content must survive');
  assert.ok(out.endsWith('```'), 'the closing fence is the last line and must survive');
});

test('round 5: a fence closed with MORE backticks than it opened with must NOT throw', () => {
  const src = ['a', '```', 'code here', '`````', 'b'].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('code here'));
  assert.ok(out.includes('b'), 'content after the longer closing fence is outside the fence');
});

test('round 5: a tilde fence closed with more tildes than it opened with must NOT throw', () => {
  const src = ['a', '~~~', 'code here', '~~~~~', 'b'].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('code here'));
  assert.ok(out.includes('b'));
});

test('round 5: an unclosed fence is reported ahead of the unclosed marker it causes', () => {
  // The marker inside the fence is literal, so `open` never gets set -- but if a
  // codex block is opened BEFORE the fence, both invariants are violated at EOF.
  // The fence is the root cause and must be the reported one.
  const src = ['<!-- harness:codex -->', 'x', '```', 'never closed'].join('\n');
  assert.throws(() => renderClaude(src), /unterminated code fence/i);
  assert.throws(() => renderClaude(src), /line 3/);
});

test('round 5: a fence-closed document with a real codex block after it still strips correctly', () => {
  const src = [
    'a',
    '```',
    '<!-- harness:codex -->',
    'literal, inside the fence',
    '```',
    '<!-- harness:codex -->',
    'secret after the fence',
    '<!-- /harness -->',
    'b',
  ].join('\n');
  const out = renderClaude(src);
  assert.ok(out.includes('literal, inside the fence'), 'fence content survives verbatim');
  assert.ok(!out.includes('secret after the fence'), 'the real block after the fence must strip');
  assert.ok(out.includes('a') && out.includes('b'));
});

// --- CLI wrapper (Task 2) -----------------------------------------------------
// These exercise scripts/sync-contract.mjs as a subprocess. The CLI self-locates
// its brain root from import.meta.url (never process.cwd()), so a fixture brain
// must carry its own copy of the script tree -- pointing cwd at a fixture would
// still resolve to the REAL brain root, not the fixture.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'sync-contract.mjs');

// The CLI self-locates its brain root from import.meta.url, so a fixture brain must carry
// its own copy of the script tree - pointing cwd at a fixture would target the REAL brain.
function makeFixtureBrain(agents, claude) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, 'scripts', 'sync-contract.mjs'));
  fs.copyFileSync(
    path.join(here, '..', 'lib', 'contract-sync-core.mjs'),
    path.join(root, 'scripts', 'lib', 'contract-sync-core.mjs'),
  );
  fs.writeFileSync(path.join(root, 'AGENTS.md'), agents);
  if (claude !== null) fs.writeFileSync(path.join(root, 'CLAUDE.md'), claude);
  return root;
}
const runCli = (root, ...args) =>
  spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-contract.mjs'), ...args], {
    encoding: 'utf8',
  });

test('CLI --check exits 0 when in sync', () => {
  const src = 'hello\n';
  const root = makeFixtureBrain(src, renderClaude(src));
  assert.equal(runCli(root, '--check').status, 0);
});

test('CLI --check exits 1 and prints a diff on drift', () => {
  const root = makeFixtureBrain('hello\n', 'stale content\n');
  const r = runCli(root, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /drift|differ/i);
});

test('CLI --check exits 1 when CLAUDE.md is missing', () => {
  const root = makeFixtureBrain('hello\n', null);
  assert.equal(runCli(root, '--check').status, 1);
});

test('CLI --check exits 2 when AGENTS.md is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, 'scripts', 'sync-contract.mjs'));
  fs.copyFileSync(
    path.join(here, '..', 'lib', 'contract-sync-core.mjs'),
    path.join(root, 'scripts', 'lib', 'contract-sync-core.mjs'),
  );
  assert.equal(runCli(root, '--check').status, 2);
});

test('CLI --write makes a drifted brain pass --check', () => {
  const root = makeFixtureBrain('hello\n<!-- harness:codex -->\nx\n<!-- /harness -->\n', 'stale\n');
  assert.equal(runCli(root, '--write').status, 0);
  assert.equal(runCli(root, '--check').status, 0);
  assert.ok(!fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').includes('x'));
});

test('CLI exits 2 on a malformed source rather than writing a broken file', () => {
  const root = makeFixtureBrain('<!-- harness:codex -->\nunclosed\n', 'original\n');
  assert.equal(runCli(root, '--write').status, 2);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'original\n');
});

// --- CLI wrapper, fix round 1 (post-review) -----------------------------------
// The initial --write was a plain truncating writeFileSync onto a live ~29KB operating contract
// that an AI agent reads as its system instructions -- an interrupted write, a full disk, or a
// crash mid-write truncated it with no recovery. Fixed with a temp-sibling-then-rename pattern,
// implemented locally in sync-contract.mjs (not imported from install-harness.mjs's core --
// coupling two independently-reviewed units is worse than a few duplicated lines; recorded as a
// known duplication for a later cleanup pass). Also: any CLAUDE.md read error other than
// "missing" (ENOENT) was silently treated as missing, which under --write becomes the trigger to
// overwrite a file that could not actually be read -- e.g. a directory sitting where CLAUDE.md
// belongs. Now ENOENT is the only case treated as "missing"; anything else is a real failure
// reported with a clear message and exit 2, symmetric across --check and --write. And --check's
// output could not tell "CLAUDE.md is missing" apart from "CLAUDE.md exists but differs" -- both
// rendered a blank first line -- so it now says which one it is.

test('CLI --write produces a correct file and leaves no .tmp artifact behind', () => {
  const src = 'hello\n<!-- harness:codex -->\nx\n<!-- /harness -->\n';
  const root = makeFixtureBrain(src, 'stale\n');
  assert.equal(runCli(root, '--write').status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), renderClaude(src));
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md.tmp')), false);
});

test('CLI --write succeeds despite a stale leftover temp file at the temp path', () => {
  const src = 'hello\n';
  const root = makeFixtureBrain(src, 'stale\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md.tmp'), 'leftover from a crashed run');
  assert.equal(runCli(root, '--write').status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), renderClaude(src));
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md.tmp')), false);
});

test('CLI --write exits 2 with a clear message, not a stack trace, when CLAUDE.md is a directory', () => {
  const root = makeFixtureBrain('hello\n', null);
  fs.mkdirSync(path.join(root, 'CLAUDE.md'));
  const r = runCli(root, '--write');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sync-contract:/);
  assert.ok(!/\n\s+at /.test(r.stderr), 'must not print a raw Node stack trace');
  assert.ok(fs.statSync(path.join(root, 'CLAUDE.md')).isDirectory(), 'the directory must be left untouched');
});

test('CLI --check exits 2 with a clear message, not a stack trace, when CLAUDE.md is a directory', () => {
  const root = makeFixtureBrain('hello\n', null);
  fs.mkdirSync(path.join(root, 'CLAUDE.md'));
  const r = runCli(root, '--check');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sync-contract:/);
  assert.ok(!/\n\s+at /.test(r.stderr), 'must not print a raw Node stack trace');
});

test('CLI --check output distinguishes a missing CLAUDE.md from one that merely differs', () => {
  const src = 'hello\n';

  const missingRoot = makeFixtureBrain(src, null);
  const missing = runCli(missingRoot, '--check');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /missing/i);

  const driftedRoot = makeFixtureBrain(src, 'stale content\n');
  const drifted = runCli(driftedRoot, '--check');
  assert.equal(drifted.status, 1);
  assert.match(drifted.stdout, /drift/i);
  assert.ok(!/is missing/i.test(drifted.stdout), 'a present-but-different file must not be reported as missing');
});

// --- CLI wrapper, fix round 2 (post-review) -----------------------------------
// The round-1 atomic-write fix introduced its own gap: the old in-place writeFileSync preserved
// CLAUDE.md's permission bits for free, because it wrote to the same inode. The rename-based
// replacement creates a FRESH inode via the 'wx' flag, under the process umask -- so any --write
// that actually changes content now silently resets the file's mode. Real on POSIX, inert on
// Windows/NTFS (no POSIX permission bits to reset). This test asserts the fix meaningfully:
// skipped explicitly on win32 (with a stated reason, surfaced by node:test as "skip" rather than
// "pass") rather than run there and get a false pass from an assertion that would hold whether or
// not the mode-preservation code path exists at all, since chmod barely does anything on NTFS.
test(
  'CLI --write preserves the target file mode when content changes (POSIX only)',
  {
    skip: process.platform === 'win32'
      ? 'POSIX permission bits are not meaningful on Windows/NTFS; chmod there does not round-trip a distinctive mode, so this assertion would pass regardless of whether the mode-preservation fix exists'
      : false,
  },
  () => {
    const src = 'hello\n<!-- harness:codex -->\nx\n<!-- /harness -->\n';
    const root = makeFixtureBrain(src, 'stale\n');
    const claudePath = path.join(root, 'CLAUDE.md');
    fs.chmodSync(claudePath, 0o640);
    const before = fs.statSync(claudePath).mode & 0o777;
    assert.equal(before, 0o640, 'precondition: the fixture chmod actually took effect');

    assert.equal(runCli(root, '--write').status, 0);

    // The write must have actually changed the content -- otherwise this would trivially pass
    // via the "already in sync, nothing written" branch instead of exercising writeAtomic.
    assert.equal(fs.readFileSync(claudePath, 'utf8'), renderClaude(src));
    const after = fs.statSync(claudePath).mode & 0o777;
    assert.equal(after, 0o640, 'the file mode must survive a content-changing --write');
  },
);
