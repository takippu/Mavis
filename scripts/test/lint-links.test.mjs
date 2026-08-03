// Tests for link integrity: relative .md link extraction, heading slugs, dangling + anchor flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractLinks, slugifyHeading, headingSlugs, checkLinks, lint } from '../lib/brain-lint-core.mjs';

// Records every path handed to the fs calls checkLinks makes against link targets,
// so a test can assert a target was never touched (not merely that it was flagged).
function spyFs(fn) {
  const calls = [];
  const realExists = fs.existsSync, realRead = fs.readFileSync;
  fs.existsSync = (p, ...a) => { calls.push(String(p)); return realExists(p, ...a); };
  fs.readFileSync = (p, ...a) => { calls.push(String(p)); return realRead(p, ...a); };
  try { return { result: fn(), calls }; }
  finally { fs.existsSync = realExists; fs.readFileSync = realRead; }
}

function makeBrain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  for (const [r, c] of Object.entries(files)) {
    const p = path.join(root, r);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
  return root;
}

test('extractLinks finds relative md links, skips http/absolute/wikilinks/anchors-only', () => {
  const links = extractLinks([
    'See [daily](../../daily-memories/2026-07-01.md) and [sec](notes.md#payment).',
    'Skip [web](https://x.com/a.md), [abs](/foo/a.md), [win](C:/x/a.md), [[wikilink]], [same](#local).',
  ].join('\n'));
  assert.deepEqual(links, [
    { target: '../../daily-memories/2026-07-01.md', anchor: null, line: 1 },
    { target: 'notes.md', anchor: 'payment', line: 1 },
  ]);
});

test('extractLinks reports correct line numbers across many lines (no regex lastIndex leak)', () => {
  const links = extractLinks([
    '[a](a.md) [b](b.md)',   // line 1: two links
    'no links here',
    '[c](c.md)',             // line 3
    '[d](d.md) [e](e.md)',   // line 4
  ].join('\n'));
  assert.deepEqual(links.map(l => [l.target, l.line]), [
    ['a.md', 1], ['b.md', 1], ['c.md', 3], ['d.md', 4], ['e.md', 4],
  ]);
});

test('extractLinks handles CRLF content', () => {
  const links = extractLinks('[a](x.md)\r\n[b](y.md#sec)\r\n');
  assert.deepEqual(links, [
    { target: 'x.md', anchor: null, line: 1 },
    { target: 'y.md', anchor: 'sec', line: 2 },
  ]);
});

test('extractLinks skips non-md targets and empty content', () => {
  assert.deepEqual(extractLinks(''), []);
  assert.deepEqual(extractLinks('[img](../pic.png) [dir](../notes/) [code](x.mjs)'), []);
});

test('extractLinks ignores links inside inline code spans (format templates)', () => {
  // rules/_details/daily-memory-format.md documents the skeleton inside backticks.
  // A link inside a code span renders literally - it is illustrative, not a real link.
  const links = extractLinks(
    'each with a `**Project:** [<name>](../projects/<name>/index.md)` pointer line');
  assert.deepEqual(links, []);
});

test('extractLinks ignores links inside fenced code blocks but resumes after', () => {
  const links = extractLinks([
    '[before](before.md)',    // line 1
    '```markdown',            // line 2
    '[fenced](../fake/<slug>.md)',
    '```',                    // line 4
    '[after](after.md)',      // line 5
  ].join('\n'));
  assert.deepEqual(links, [
    { target: 'before.md', anchor: null, line: 1 },
    { target: 'after.md', anchor: null, line: 5 },
  ]);
});

test('extractLinks keeps real links on a line that also has a code span', () => {
  const links = extractLinks('see `[x](fake.md)` but really [real](real.md)');
  assert.deepEqual(links, [{ target: 'real.md', anchor: null, line: 1 }]);
});

test('extractLinks handles tilde fences and an unterminated fence', () => {
  assert.deepEqual(extractLinks('~~~\n[a](a.md)\n~~~\n[b](b.md)'),
    [{ target: 'b.md', anchor: null, line: 4 }]);
  assert.deepEqual(extractLinks('```\n[a](a.md)\n'), []);
});

test('slugifyHeading matches GitHub-style anchors incl. embedded links', () => {
  assert.equal(slugifyHeading('PM Kanban + task-detail sheet'), 'pm-kanban--task-detail-sheet');
  assert.equal(slugifyHeading('2026-07-17 → [daily memory](../../d.md)  SHIPPED'),
    '2026-07-17--daily-memory--shipped');
});

test('slugifyHeading strips a trailing CR (CRLF files) rather than turning it into a dash', () => {
  assert.equal(slugifyHeading('Real Section\r'), 'real-section');
});

test('slugifyHeading preserves literal underscores (GitHub keeps them)', () => {
  // Identifier-style headings are common in the brain (RESERVED_HANDLES, NEXT_DIST_DIR,
  // `period_count`). GitHub's slugger has no underscore in its punctuation class, so the
  // anchor keeps them; stripping them false-flagged 108 real headings.
  assert.equal(slugifyHeading('snake_case naming'), 'snake_case-naming');
  assert.equal(slugifyHeading('NEXT_DIST_DIR'), 'next_dist_dir');
  assert.equal(slugifyHeading('Dev-server build isolation: NEXT_DIST_DIR (2026-07-10)'),
    'dev-server-build-isolation-next_dist_dir-2026-07-10');
  // Backticks/asterisks are still emphasis/code markers and must still go.
  assert.equal(slugifyHeading('`period_count` is denormalized from `period_times` JSON'),
    'period_count-is-denormalized-from-period_times-json');
  assert.equal(slugifyHeading('**bold** and *ital*'), 'bold-and-ital');
});

test('slugifyHeading preserves non-ASCII letters and digits, strips symbols', () => {
  assert.equal(slugifyHeading('Café notes'), 'café-notes');   // was 'caf-notes' under \w
  assert.equal(slugifyHeading('日本語 heading'), '日本語-heading');
  assert.equal(slugifyHeading('cost control (how we hold ≤$5/mo)'), 'cost-control-how-we-hold-5mo');
});

test('headingSlugs ignores headings inside fenced code blocks', () => {
  // Symmetric with extractLinks: a '# ...' inside a fence renders literally and produces
  // no anchor, so certifying a link to it would be a false negative.
  const slugs = headingSlugs('# Real\n\n```markdown\n# YYYY-MM-DD\n## Fenced Skeleton\n```\n\n## After\n');
  assert.deepEqual([...slugs].sort(), ['after', 'real']);
});

test('checkLinks rejects an anchor into a fenced heading', () => {
  const root = makeBrain({
    'projects/p/notes.md': '# Real\n\n```markdown\n# YYYY-MM-DD\n```\n',
    'projects/p/index.md': '[bogus](notes.md#yyyy-mm-dd)\n',
  });
  const flags = checkLinks(root);
  assert.equal(flags.length, 1, 'a link to a heading that only exists inside a fence must flag');
  assert.equal(flags[0].type, 'anchor');
});

test('checkLinks resolves an underscore anchor that GitHub would resolve', () => {
  const root = makeBrain({
    'projects/p/notes.md': '## Dev-server build isolation: NEXT_DIST_DIR\nbody\n',
    'projects/p/index.md': '[x](notes.md#dev-server-build-isolation-next_dist_dir)\n',
  });
  assert.deepEqual(checkLinks(root), [], 'correct GitHub anchor must not be flagged');
});

test('checkLinks tolerates a UTF-8 BOM before the first heading', () => {
  const root = makeBrain({
    'projects/p/notes.md': '﻿# Title\n\n## Real Section\nbody\n',
    'projects/p/index.md': '[a](notes.md#title)\n[b](notes.md#real-section)\n',
  });
  assert.deepEqual(checkLinks(root), [], 'a BOM must not hide the first heading from the anchor set');
});

test('checkLinks never opens a target outside the brain root', () => {
  const root = makeBrain({ 'topics/_details/probe.md': '[hit](../../../outside-secret.md#api-key)\n' });
  // A real, readable file outside the root, with the heading the link asks for: without a
  // containment check the anchor "resolves" and the linter silently reads out-of-root.
  const outside = path.join(root, '..', 'outside-secret.md');
  fs.writeFileSync(outside, '## api-key\nsensitive\n');
  const { result: flags, calls } = spyFs(() => checkLinks(root));
  assert.equal(flags.length, 1, 'an out-of-root target must be flagged, not read');
  assert.match(flags[0].detail, /escapes brain root/);
  assert.ok(!calls.some(p => p.includes('outside-secret')),
    `no fs call may touch an out-of-root target: ${calls.filter(p => p.includes('outside-secret'))}`);
});

test('checkLinks flags a backslash UNC target without any SMB call', () => {
  // '\\host\share\x.md' matches none of extractLinks' remote/absolute alternatives, so it
  // reaches fs.existsSync and blocks ~21s on an outbound SMB connect (NTLM leak vector).
  const root = makeBrain({ 'topics/_details/t.md': 'see [ref](\\\\10.255.255.1\\share\\x.md)\n' });
  const { result: flags, calls } = spyFs(() => checkLinks(root));
  assert.equal(flags.length, 1, 'a UNC target must be flagged');
  const unc = calls.filter(p => p.startsWith('\\\\') || p.startsWith('//'));
  assert.deepEqual(unc, [], `no fs call may target a UNC path: ${unc}`);
});

test('checkLinks flags dangling files (fail) and bad anchors (warn)', () => {
  const root = makeBrain({
    'topics/_details/a.md': '[ok](../../projects/p/notes.md)\n[gone](../../projects/p/missing.md)\n',
    'projects/p/notes.md': '## Real Section\nbody\n',
    'projects/p/index.md': '[bad-anchor](notes.md#not-a-heading)\n[good-anchor](notes.md#real-section)\n',
  });
  const flags = checkLinks(root);
  const dangling = flags.filter(f => f.type === 'dangling-link');
  const anchors = flags.filter(f => f.type === 'anchor');
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].severity, 'fail');
  assert.ok(dangling[0].detail.includes('missing.md'));
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].severity, 'warn');
});

test('checkLinks resolves anchors in a CRLF target file', () => {
  const root = makeBrain({
    'projects/p/notes.md': '# p — Notes\r\n\r\n## Right-edge cutoff\r\nbody\r\n',
    'daily-memories/2026-07-17.md': '[s](../projects/p/notes.md#right-edge-cutoff)\r\n',
  });
  assert.deepEqual(checkLinks(root), [], 'CRLF headings must still slugify to a matching anchor');
});

test('checkLinks does not let a blank heading swallow the next line', () => {
  // '##' with no text followed by a real heading: a \s+ separator would capture '## Other'.
  const root = makeBrain({
    'projects/p/notes.md': '##\n## Other\nbody\n',
    'projects/p/index.md': '[x](notes.md#other)\n',
  });
  assert.deepEqual(checkLinks(root), []);
});

test('checkLinks scans all brain dirs and reports source file + line', () => {
  const root = makeBrain({
    'rules/_details/r.md': 'line one\n[gone](../../nope.md)\n',
    'preferences/_details/p.md': '[gone](../../nope.md)\n',
    'daily-memories/2026-07-17.md': '[gone](../nope.md)\n',
  });
  const flags = checkLinks(root);
  assert.equal(flags.length, 3);
  assert.ok(flags.every(f => f.type === 'dangling-link' && f.severity === 'fail'));
  const r = flags.find(f => f.file === 'rules/_details/r.md');
  assert.ok(r.detail.startsWith('line 2:'), `expected line 2, got: ${r.detail}`);
});

test('lint merges size + link flags into one report', () => {
  const root = makeBrain({
    'projects/p/progress.md': '#'.repeat(100 * 1024) + '\n[gone](missing.md)\n',
  });
  const r = lint(root);
  assert.equal(r.counts.fail, 2); // 1 size fail + 1 dangling fail
  assert.deepEqual([...new Set(r.flags.map(f => f.type))].sort(), ['dangling-link', 'size']);
});
