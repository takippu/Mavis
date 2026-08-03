'use strict';

// Tests for the two-tier <category>/_index.md + _details/<slug>.md writer ops
// (addEntry / editEntry / supersedeEntry + guardHeadingDelta). Mirrors the seams in
// mavis-config-writer.test.js: pure-transform asserts for the guard, fs asserts (via
// mkdtempSync) for the file-touching ops, with exact-byte + round-trip checks.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../src/mavis-config-writer');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mt-entries-')); }

// build an _index-shaped md with the given slugs as `## <slug>` sections (one trailing blank each)
function mkIndex(slugs) {
  const parts = ['---', 'category: rules', '---', '', '# rules — index', ''];
  slugs.forEach((s) => { parts.push('## ' + s, '', 'body ' + s, ''); });
  return parts.join('\n');
}

const ENTRY = {
  slug: 'no-emojis',
  title: 'No emojis anywhere',
  scope: ['ui', 'workflow'],
  links: [],
  triggers: ['emoji', 'emojis'],
  summary: 'Zero emojis in chat, code, commits.',
  rule: 'No emojis anywhere.',
  why: 'They read as decoration.',
  how: 'Use lucide-react for icons.',
  since: '2026-06-30',
  date: '2026-06-30',
};

// Canonical _details/<slug>.md: front-matter order id, title, category(SINGULAR), scope,
// status, since, updated, links; body starts directly at `## Rule` (no H1 / no preamble),
// Why / How to apply present only when non-empty. Byte-for-byte with the migration emitter.
const EXPECTED_DETAIL = [
  '---',
  'id: no-emojis',
  'title: No emojis anywhere',
  'category: rule',
  'scope: [ui, workflow]',
  'status: active',
  'since: 2026-06-30',
  'updated: 2026-06-30',
  'links: []',
  '---',
  '## Rule',
  'No emojis anywhere.',
  '## Why',
  'They read as decoration.',
  '## How to apply',
  'Use lucide-react for icons.',
  '',
].join('\n');

// Canonical _index.md: `## <slug>` + Triggers + Summary + Detail, sections separated by a
// `---` rule. The skeleton's `category:` is the SINGULAR enum (matches the detail files).
const EXPECTED_INDEX = [
  '---',
  'category: rule',
  '---',
  '',
  '# rule — index',
  '',
  '**Purpose:** retrieval router for the "rule" category. Each `## <slug>` entry carries Triggers + a one-line Summary + a Detail pointer to `_details/<slug>.md` (Rule / Why / How to apply).',
  '',
  '## no-emojis',
  '',
  '**Triggers:** emoji, emojis',
  '',
  '**Summary:** Zero emojis in chat, code, commits.',
  '',
  '**Detail:** [_details/no-emojis.md](_details/no-emojis.md)',
  '',
  '---',
  '',
].join('\n');

// ---------- pure-transform: guardHeadingDelta ----------

test('guardHeadingDelta accepts a single add and a single remove', () => {
  assert.equal(W.guardHeadingDelta(mkIndex(['a']), mkIndex(['a', 'b']), { added: ['b'] }).ok, true);
  assert.equal(W.guardHeadingDelta(mkIndex(['a', 'b']), mkIndex(['a']), { removed: ['b'] }).ok, true);
});

test('guardHeadingDelta with no delta behaves like guard', () => {
  assert.equal(W.guardHeadingDelta(mkIndex(['a', 'b']), mkIndex(['a', 'b']), {}).ok, true);
  assert.equal(W.guardHeadingDelta(mkIndex(['a', 'b']), mkIndex(['a']), {}).ok, false); // undeclared removal
});

test('guardHeadingDelta rejects a 2-heading delta', () => {
  const g = W.guardHeadingDelta(mkIndex(['a']), mkIndex(['a', 'b', 'c']), { added: ['b'] });
  assert.equal(g.ok, false); // c is an unexpected extra heading
});

test('guardHeadingDelta rejects a duplicate add', () => {
  const g = W.guardHeadingDelta(mkIndex(['a', 'b']), mkIndex(['a', 'b', 'b']), { added: ['b'] });
  assert.equal(g.ok, false);
  assert.equal(g.error, 'heading "b" present more than once');
});

test('guardHeadingDelta rejects removing an absent slug', () => {
  const g = W.guardHeadingDelta(mkIndex(['a']), mkIndex(['a']), { removed: ['z'] });
  assert.equal(g.ok, false);
  assert.equal(g.error, 'heading "z" is not present exactly once');
});

// ---------- preview (no write) produces format C ----------

test('previewAddEntry composes exact detail + index bytes and writes nothing', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
  const pv = W.previewAddEntry(dir, 'rules', ENTRY);
  assert.equal(pv.ok, true);
  const detail = pv.files.find((f) => f.key === 'details');
  const index = pv.files.find((f) => f.key === 'index');
  assert.equal(detail.after, EXPECTED_DETAIL);
  assert.equal(index.after, EXPECTED_INDEX);
  // each entry block is closed by a `---` rule (the section separator)
  assert.ok(index.after.includes('\n\n---\n'));
  // pure compose — nothing on disk yet
  assert.equal(fs.existsSync(path.join(dir, 'rules', '_index.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'rules', '_details', 'no-emojis.md')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- addEntry ----------

test('addEntry creates the detail + index files with exact bytes, then refuses overwrite', () => {
  const dir = tmp();
  const r = W.addEntry(dir, 'rules', ENTRY);
  assert.equal(r.ok, true);

  const detailPath = path.join(dir, 'rules', '_details', 'no-emojis.md');
  const indexPath = path.join(dir, 'rules', '_index.md');
  assert.equal(fs.readFileSync(detailPath, 'utf8'), EXPECTED_DETAIL);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), EXPECTED_INDEX);

  // a second add of the same slug is refused (additive law)
  const dup = W.addEntry(dir, 'rules', ENTRY);
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'entry already exists');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('addEntry appends a second entry keeping the first + one-blank spacing', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', ENTRY).ok, true);
  assert.equal(W.addEntry(dir, 'rules', {
    slug: 'verify-truth', triggers: 'verify, premise', summary: 'Verify before patching.',
    rule: 'Read the file first.', why: 'Avoid patching the wrong field.', how: 'Find the display path.', date: '2026-06-30',
  }).ok, true);

  const indexMd = fs.readFileSync(path.join(dir, 'rules', '_index.md'), 'utf8');
  const parsed = W.parseSections(indexMd);
  assert.deepEqual(parsed.sections.map((s) => s.headingText), ['no-emojis', 'verify-truth']);
  // round-trip holds → no spacing drift; the two entries are separated by a `---` rule
  assert.equal(W.emit(W.parseSections(indexMd)), indexMd);
  assert.ok(indexMd.includes('\n---\n\n## verify-truth'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addEntry rejects empties + bad inputs', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, '../evil', ENTRY).error, 'bad category');
  assert.equal(W.addEntry(dir, 'rules', { ...ENTRY, slug: '..' }).error, 'bad slug');
  assert.equal(W.addEntry(dir, 'rules', { ...ENTRY, date: 'nope' }).error, 'bad date');
  assert.equal(W.addEntry(dir, 'rules', { ...ENTRY, rule: '   ' }).error, 'empty rule');
  assert.equal(W.addEntry(dir, 'rules', { ...ENTRY, summary: '' }).error, 'empty summary');
  assert.equal(W.addEntry(dir, 'rules', { ...ENTRY, triggers: [] }).error, 'empty triggers');
  // detail-shape stand-in for guard: a ## line in the body breaks the shape check
  assert.equal(W.addEntry(dir, 'rules', { ...ENTRY, slug: 'sneaky', rule: '## Injected\nhi' }).error, 'detail shape check failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- editEntry ----------

test('editEntry with the same body is unchanged + byte-identical (no write)', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', ENTRY).ok, true);
  const detailPath = path.join(dir, 'rules', '_details', 'no-emojis.md');
  const before = fs.readFileSync(detailPath, 'utf8');

  const r = W.editEntry(dir, 'rules', 'no-emojis', { rule: 'No emojis anywhere.' });
  assert.deepEqual(r, { ok: true, unchanged: true });
  assert.equal(fs.readFileSync(detailPath, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two consecutive no-op editEntry saves are byte-identical (round-trip fix)', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', ENTRY).ok, true);
  const detailPath = path.join(dir, 'rules', '_details', 'no-emojis.md');
  const original = fs.readFileSync(detailPath, 'utf8');
  assert.equal(original, EXPECTED_DETAIL); // sanity: starts at the canonical bytes

  const samePatch = { rule: 'No emojis anywhere.', why: 'They read as decoration.', how: 'Use lucide-react for icons.' };
  const r1 = W.editEntry(dir, 'rules', 'no-emojis', samePatch);
  assert.deepEqual(r1, { ok: true, unchanged: true });
  assert.equal(fs.readFileSync(detailPath, 'utf8'), original); // no blank-line growth

  const r2 = W.editEntry(dir, 'rules', 'no-emojis', samePatch);
  assert.deepEqual(r2, { ok: true, unchanged: true });
  assert.equal(fs.readFileSync(detailPath, 'utf8'), original); // still byte-identical
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editEntry does not de-indent an indented How body (trimmed-equal is a no-op)', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', { ...ENTRY, slug: 'indent-test', how: '    indented step\n    second line' }).ok, true);
  const detailPath = path.join(dir, 'rules', '_details', 'indent-test.md');
  const before = fs.readFileSync(detailPath, 'utf8');
  assert.ok(before.includes('\n    indented step\n')); // indentation is on disk

  // (a) exact-same indented body → unchanged, byte-identical
  const r1 = W.editEntry(dir, 'rules', 'indent-test', { how: '    indented step\n    second line' });
  assert.deepEqual(r1, { ok: true, unchanged: true });
  assert.equal(fs.readFileSync(detailPath, 'utf8'), before);

  // (b) a de-indented but trimmed-EQUAL body must NOT rewrite/strip the leading indent
  const r2 = W.editEntry(dir, 'rules', 'indent-test', { how: 'indented step\n    second line' });
  assert.deepEqual(r2, { ok: true, unchanged: true });
  assert.equal(fs.readFileSync(detailPath, 'utf8'), before); // indentation preserved
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editEntry surgically changes only the target section + updated stamp', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', ENTRY).ok, true);
  const detailPath = path.join(dir, 'rules', '_details', 'no-emojis.md');

  const r = W.editEntry(dir, 'rules', 'no-emojis', { why: 'Fake settings get removed too.', date: '2026-07-01' });
  assert.equal(r.ok, true);
  const md = fs.readFileSync(detailPath, 'utf8');
  const p = W.parseSections(md);
  // Why changed; Rule + How untouched; updated bumped; since + status intact (tight body)
  assert.deepEqual(p.sections.find((s) => s.headingText === 'Why').bodyLines, ['Fake settings get removed too.']);
  assert.deepEqual(p.sections.find((s) => s.headingText === 'Rule').bodyLines, ['No emojis anywhere.']);
  // How to apply is the LAST section, so its body keeps the file's terminating newline (a trailing '')
  assert.deepEqual(p.sections.find((s) => s.headingText === 'How to apply').bodyLines, ['Use lucide-react for icons.', '']);
  assert.ok(p.frontmatter.includes('updated: 2026-07-01'));
  assert.ok(p.frontmatter.includes('since: 2026-06-30'));
  assert.ok(p.frontmatter.includes('status: active'));
  // round-trip still holds
  assert.equal(W.emit(W.parseSections(md)), md);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editEntry guard-aborts an injected heading and leaves the file untouched', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', ENTRY).ok, true);
  const detailPath = path.join(dir, 'rules', '_details', 'no-emojis.md');
  const before = fs.readFileSync(detailPath, 'utf8');

  const r = W.editEntry(dir, 'rules', 'no-emojis', { rule: '## Sneaky\nhi' });
  assert.equal(r.ok, false); // guard catches the heading-set change
  assert.equal(fs.readFileSync(detailPath, 'utf8'), before); // nothing written
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editEntry on a missing detail reports not found', () => {
  const dir = tmp();
  assert.equal(W.editEntry(dir, 'rules', 'ghost', { rule: 'x' }).error, 'detail file not found');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- supersedeEntry ----------

test('supersedeEntry flips the detail front-matter and drops the index line; siblings survive', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', ENTRY).ok, true);
  assert.equal(W.addEntry(dir, 'rules', {
    slug: 'verify-truth', triggers: 'verify', summary: 'Verify before patching.',
    rule: 'Read the file first.', why: 'Avoid wrong field.', how: 'Find the display.', date: '2026-06-30',
  }).ok, true);

  const r = W.supersedeEntry(dir, 'rules', 'no-emojis', { superseded_by: 'verify-truth', date: '2026-07-02' });
  assert.equal(r.ok, true);

  // detail: status flipped + superseded_by inserted after links (canonical order → last key)
  const detailMd = fs.readFileSync(path.join(dir, 'rules', '_details', 'no-emojis.md'), 'utf8');
  const fm = W.parseSections(detailMd).frontmatter;
  assert.ok(fm.includes('status: superseded'));
  assert.ok(fm.includes('superseded_by: verify-truth'));
  assert.ok(fm.includes('updated: 2026-07-02'));
  assert.equal(fm[fm.length - 2], 'links: []');                  // links stays the prior key
  assert.equal(fm[fm.length - 1], 'superseded_by: verify-truth'); // superseded_by right after it
  // detail heading set + round-trip intact (guard held)
  assert.deepEqual(W.parseSections(detailMd).sections.map((s) => s.headingText), ['Rule', 'Why', 'How to apply']);
  assert.equal(W.emit(W.parseSections(detailMd)), detailMd);

  // index: no-emojis gone, verify-truth + spacing survive
  const indexMd = fs.readFileSync(path.join(dir, 'rules', '_index.md'), 'utf8');
  const p = W.parseSections(indexMd);
  assert.deepEqual(p.sections.map((s) => s.headingText), ['verify-truth']);
  assert.ok(!indexMd.includes('## no-emojis'));
  assert.equal(W.emit(W.parseSections(indexMd)), indexMd); // no spacing drift
  fs.rmSync(dir, { recursive: true, force: true });
});

test('supersedeEntry validates the target slug and rejects a bad superseded_by', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'rules', ENTRY).ok, true);
  assert.equal(W.supersedeEntry(dir, 'rules', 'no-emojis', { superseded_by: '../evil' }).error, 'bad superseded_by');
  assert.equal(W.supersedeEntry(dir, 'rules', 'ghost', { superseded_by: 'verify-truth' }).error, 'detail file not found');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addEntry + editEntry build a topic body (Did/Refs/Pre-empt, category: topic) — not Rule/Why/How', () => {
  const dir = tmp();
  const r = W.addEntry(dir, 'topics', {
    slug: 'test-topic', date: '2026-07-01', title: 'Test Topic',
    triggers: ['foo', 'bar'], summary: 'a test topic',
    did: 'built the thing', refs: '- `projects/x/notes.md` (infra)', preempt: 'only X built',
  });
  assert.equal(r.ok, true, r.error);
  const md = fs.readFileSync(path.join(dir, 'topics', '_details', 'test-topic.md'), 'utf8');
  assert.match(md, /category: topic/);
  assert.match(md, /## Did\nbuilt the thing/);
  assert.match(md, /## Refs\n- `projects\/x\/notes\.md`/);
  assert.match(md, /## Pre-empt\nonly X built/);
  assert.doesNotMatch(md, /## Rule/);                 // topic body, not the Rule/Why/How skeleton
  assert.match(fs.readFileSync(path.join(dir, 'topics', '_index.md'), 'utf8'), /## test-topic/);
  // editEntry patches the topic sections (Did + Pre-empt) + bumps updated
  assert.equal(W.editEntry(dir, 'topics', 'test-topic', { did: 'built it, revised', preempt: 'now covers Y', date: '2026-07-02' }).ok, true);
  const md2 = fs.readFileSync(path.join(dir, 'topics', '_details', 'test-topic.md'), 'utf8');
  assert.match(md2, /built it, revised/);
  assert.match(md2, /now covers Y/);
  assert.match(md2, /updated: 2026-07-02/);
  // a topic requires a Did (the primary body), not a Rule
  assert.equal(W.addEntry(dir, 'topics', { slug: 'no-body', date: '2026-07-01', title: 'x', triggers: ['t'], summary: 's' }).error, 'empty did');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('editEntry appends an absent optional section (add a Pre-empt to a topic that lacks one)', () => {
  const dir = tmp();
  assert.equal(W.addEntry(dir, 'topics', { slug: 't', date: '2026-07-01', title: 'T', triggers: ['x'], summary: 's', did: 'did only' }).ok, true);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'topics', '_details', 't.md'), 'utf8'), /## Pre-empt/);
  assert.equal(W.editEntry(dir, 'topics', 't', { preempt: 'the honest scope', date: '2026-07-02' }).ok, true);
  const md = fs.readFileSync(path.join(dir, 'topics', '_details', 't.md'), 'utf8');
  assert.match(md, /## Pre-empt\nthe honest scope/);
  assert.match(md, /## Did\ndid only/);           // existing section survives the append
  assert.match(md, /updated: 2026-07-02/);
  fs.rmSync(dir, { recursive: true, force: true });
});
