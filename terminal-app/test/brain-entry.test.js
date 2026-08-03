'use strict';

// Unit tests for the additive two-tier category readers in brain-stats.js:
//   parseIndexFile / parseEntryFile (pure) + readCategoryIndex / readEntry (memoized fs)
// plus the legacy-fallback contract (empty []/null when the <category>/ dir is absent).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseIndexFile,
  parseEntryFile,
  readCategoryIndex,
  readEntry,
  listCategoryEntries,
  invalidate,
} = require('../src/brain-stats');

// ---------- parseIndexFile (pure) ----------

test('parseIndexFile: parses slug + triggers + summary + detail link', () => {
  const md = [
    '# Preferences index',
    '',
    '## no-emojis',
    // The last trigger is punctuation, not a word: triggers are split on commas and trimmed, so a
    // token with no letters in it must still survive the split. (It used to be a literal emoji
    // glyph here, which the project's own no-emoji rule forbids in source.)
    '**Triggers:** emoji, emojis, unicode icon, :-)',
    '**Summary:** Zero emojis anywhere — chat, code, commits.',
    '**Detail:** [no-emojis](_details/no-emojis.md)',
    '',
    '## ship-all',
    '**Triggers:** audit, ranked list',
    '**Summary:** Execute the whole ranked list top-down.',
    '**Detail:** [ship-all](_details/ship-all.md)',
  ].join('\n');

  const rows = parseIndexFile(md);
  assert.strictEqual(rows.length, 2);

  assert.deepStrictEqual(rows[0], {
    slug: 'no-emojis',
    triggers: ['emoji', 'emojis', 'unicode icon', ':-)'],
    summary: 'Zero emojis anywhere — chat, code, commits.',
    detailRel: '_details/no-emojis.md',
  });
  assert.deepStrictEqual(rows[1].triggers, ['audit', 'ranked list']);
  assert.strictEqual(rows[1].detailRel, '_details/ship-all.md');
});

test('parseIndexFile: defaults for missing markers', () => {
  const rows = parseIndexFile('## lonely-slug\nsome prose with no markers\n');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    slug: 'lonely-slug',
    triggers: [],
    summary: '',
    detailRel: null,
  });
});

test('parseIndexFile: skips template-placeholder sections (slug with <)', () => {
  const md = [
    '## <slug>',
    '**Triggers:** placeholder, example',
    '## real-one',
    '**Triggers:** a, b',
  ].join('\n');
  const rows = parseIndexFile(md);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].slug, 'real-one');
});

test('parseIndexFile: drops empty triggers and trims', () => {
  const rows = parseIndexFile('## s\n**Triggers:** a ,, b , , c\n');
  assert.deepStrictEqual(rows[0].triggers, ['a', 'b', 'c']);
});

test('parseIndexFile: non-string / empty input → []', () => {
  assert.deepStrictEqual(parseIndexFile(''), []);
  assert.deepStrictEqual(parseIndexFile(null), []);
  assert.deepStrictEqual(parseIndexFile(undefined), []);
  assert.deepStrictEqual(parseIndexFile(42), []);
});

// ---------- parseEntryFile (pure) ----------

test('parseEntryFile: full frontmatter (inline arrays) + Rule/Why/How body', () => {
  const md = [
    '---',
    'id: PREF-001',
    'title: No emojis anywhere',
    'category: preferences',
    'scope: [chat, code, commits]',
    'status: active',
    'since: 2026-01-10',
    'updated: 2026-05-20',
    'links: [identity/communication.md, projects/northwind/notes.md]',
    '---',
    '',
    '## Rule',
    'Never use emojis.',
    'For UI icons use lucide-react / SVG.',
    '',
    '## Why',
    'Emoji decoration reads as noise on sight.',
    '',
    '## How to apply',
    'Audit chat, code, comments, commits.',
  ].join('\n');

  const { frontmatter, body } = parseEntryFile(md);
  assert.strictEqual(frontmatter.id, 'PREF-001');
  assert.strictEqual(frontmatter.title, 'No emojis anywhere');
  assert.strictEqual(frontmatter.category, 'preferences');
  assert.deepStrictEqual(frontmatter.scope, ['chat', 'code', 'commits']);
  assert.strictEqual(frontmatter.status, 'active');
  assert.strictEqual(frontmatter.since, '2026-01-10');
  assert.strictEqual(frontmatter.updated, '2026-05-20');
  assert.deepStrictEqual(frontmatter.links, ['identity/communication.md', 'projects/northwind/notes.md']);
  // superseded_by absent → key omitted entirely (no undefined leak).
  assert.ok(!('superseded_by' in frontmatter));

  assert.strictEqual(body.rule, 'Never use emojis.\nFor UI icons use lucide-react / SVG.');
  assert.strictEqual(body.why, 'Emoji decoration reads as noise on sight.');
  assert.strictEqual(body.how, 'Audit chat, code, comments, commits.');
});

test('parseEntryFile: superseded_by emitted only when present', () => {
  const md = [
    '---',
    'id: PREF-009',
    'superseded_by: PREF-010',
    '---',
    '## Rule',
    'old rule',
  ].join('\n');
  const { frontmatter } = parseEntryFile(md);
  assert.strictEqual(frontmatter.superseded_by, 'PREF-010');
});

test('parseEntryFile: block-form scope/links lists', () => {
  const md = [
    '---',
    'id: R1',
    'scope:',
    '  - all-projects',
    '  - global',
    'links:',
    '  - "CLAUDE.md"',
    "  - 'SETUP.md'",
    '---',
    '## Rule',
    'r',
  ].join('\n');
  const { frontmatter } = parseEntryFile(md);
  assert.deepStrictEqual(frontmatter.scope, ['all-projects', 'global']);
  assert.deepStrictEqual(frontmatter.links, ['CLAUDE.md', 'SETUP.md']);
});

test('parseEntryFile: case-insensitive headings + missing sections default to empty', () => {
  const md = [
    '---',
    'id: X',
    '---',
    '## RULE',
    'shouty rule',
  ].join('\n');
  const { frontmatter, body } = parseEntryFile(md);
  assert.strictEqual(frontmatter.id, 'X');
  assert.deepStrictEqual(frontmatter.scope, []);
  assert.deepStrictEqual(frontmatter.links, []);
  assert.strictEqual(body.rule, 'shouty rule');
  assert.strictEqual(body.why, '');
  assert.strictEqual(body.how, '');
});

test('parseEntryFile: no frontmatter → scalar defaults, lists empty', () => {
  const { frontmatter, body } = parseEntryFile('## Rule\njust a body');
  assert.deepStrictEqual(frontmatter, {
    id: '', title: '', category: '', scope: [], status: '', since: '', updated: '', links: [],
  });
  assert.strictEqual(body.rule, 'just a body');
});

// ---------- parseEntryFile: generic `sections` (every `## ` h2 in body order) ----------

test('parseEntryFile: topic-shaped body (Did/Refs/Pre-empt) → 3 sections, verbatim labels + content', () => {
  const md = [
    '---',
    'id: TOP-001',
    'title: Arabic text rendering',
    'category: topics',
    'status: active',
    '---',
    '# Topic: arabic-text-rendering',
    '',
    '## Did',
    'bluebird — Arabic ligature rendering.',
    'Used U+FDFD for the ligature.',
    '',
    '## Refs',
    '- `projects/bluebird/notes.md`',
    '- `daily-memories/2026-05-11.md`',
    '',
    '## Pre-empt',
    'Only bluebird so far.',
  ].join('\n');

  const { body, sections } = parseEntryFile(md);

  // topic headings map to none of rule/why/how → legacy body buckets stay empty.
  assert.strictEqual(body.rule, '');
  assert.strictEqual(body.why, '');
  assert.strictEqual(body.how, '');

  // generic capture: exactly the three h2s, in order, with verbatim labels.
  assert.strictEqual(sections.length, 3);
  assert.deepStrictEqual(sections.map((s) => s.label), ['Did', 'Refs', 'Pre-empt']);
  assert.strictEqual(sections[0].content, 'bluebird — Arabic ligature rendering.\nUsed U+FDFD for the ligature.');
  assert.strictEqual(sections[1].content, '- `projects/bluebird/notes.md`\n- `daily-memories/2026-05-11.md`');
  assert.strictEqual(sections[2].content, 'Only bluebird so far.');

  // the h1 `# Topic:` line is NOT an h2 → excluded from sections.
  assert.ok(!sections.some((s) => s.label.startsWith('Topic:')));
});

test('parseEntryFile: preference-shaped body still yields rule/why/how AND the 3 sections', () => {
  const md = [
    '---',
    'id: PREF-001',
    'category: preferences',
    '---',
    '## Rule',
    'Never use emojis.',
    '',
    '## Why',
    'Emoji decoration reads as noise.',
    '',
    '## How to apply',
    'Audit chat, code, commits.',
  ].join('\n');

  const { body, sections } = parseEntryFile(md);

  // legacy layout preserved.
  assert.strictEqual(body.rule, 'Never use emojis.');
  assert.strictEqual(body.why, 'Emoji decoration reads as noise.');
  assert.strictEqual(body.how, 'Audit chat, code, commits.');

  // AND the generic sections mirror the same h2s with verbatim labels.
  assert.strictEqual(sections.length, 3);
  assert.deepStrictEqual(sections.map((s) => s.label), ['Rule', 'Why', 'How to apply']);
  assert.strictEqual(sections[0].content, 'Never use emojis.');
  assert.strictEqual(sections[1].content, 'Emoji decoration reads as noise.');
  assert.strictEqual(sections[2].content, 'Audit chat, code, commits.');
});

test('parseEntryFile: body with no h2 → sections is []', () => {
  const { sections } = parseEntryFile('---\nid: X\n---\nprose with no heading at all\n');
  assert.deepStrictEqual(sections, []);
});

test('listCategoryEntries: carries sections through per entry', () => {
  invalidate();
  const root = mkBrain();
  const dir = path.join(root, 'topics', '_details');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sample-topic.md'),
    '---\nid: T1\ncategory: topics\nstatus: active\nsince: 2026-04-01\n---\n## Did\ndid a thing\n## Refs\n- `projects/x/notes.md`\n## Pre-empt\nnarrow scope\n',
    'utf8'
  );
  const rows = listCategoryEntries(root, 'topics');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].sections.map((s) => s.label), ['Did', 'Refs', 'Pre-empt']);
  assert.strictEqual(rows[0].sections[0].content, 'did a thing');
});

// ---------- readCategoryIndex / readEntry: legacy fallback + fs round-trip ----------

function mkBrain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-brain-'));
  return root;
}

test('readCategoryIndex: legacy fallback → [] when category dir absent', () => {
  invalidate();
  const root = mkBrain(); // empty brain, no preferences/ dir
  assert.deepStrictEqual(readCategoryIndex(root, 'preferences'), []);
  assert.deepStrictEqual(readCategoryIndex(root, 'rules'), []);
  assert.deepStrictEqual(readCategoryIndex(root, 'topics'), []);
});

test('readCategoryIndex: invalid category → [] (whitelist only)', () => {
  invalidate();
  const root = mkBrain();
  assert.deepStrictEqual(readCategoryIndex(root, 'identity'), []);
  assert.deepStrictEqual(readCategoryIndex(root, '../etc'), []);
  assert.deepStrictEqual(readCategoryIndex(root, ''), []);
});

test('readCategoryIndex: reads + parses a real <category>/_index.md', () => {
  invalidate();
  const root = mkBrain();
  fs.mkdirSync(path.join(root, 'preferences'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'preferences', '_index.md'),
    '## no-emojis\n**Triggers:** emoji, emojis\n**Summary:** none.\n**Detail:** [x](_details/no-emojis.md)\n',
    'utf8'
  );
  const rows = readCategoryIndex(root, 'preferences');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].slug, 'no-emojis');
  assert.deepStrictEqual(rows[0].triggers, ['emoji', 'emojis']);
  assert.strictEqual(rows[0].detailRel, '_details/no-emojis.md');
});

test('readEntry: legacy fallback → null when file/dir absent', () => {
  invalidate();
  const root = mkBrain();
  assert.strictEqual(readEntry(root, 'preferences', 'no-emojis'), null);
});

test('readEntry: invalid category or slug → null', () => {
  invalidate();
  const root = mkBrain();
  assert.strictEqual(readEntry(root, 'identity', 'x'), null);     // bad category
  assert.strictEqual(readEntry(root, 'preferences', '../x'), null); // bad slug
  assert.strictEqual(readEntry(root, 'preferences', '..'), null);
  assert.strictEqual(readEntry(root, 'preferences', ''), null);
});

test('readEntry: reads + parses a real <category>/_details/<slug>.md', () => {
  invalidate();
  const root = mkBrain();
  fs.mkdirSync(path.join(root, 'rules', '_details'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'rules', '_details', 'never-commit.md'),
    '---\nid: R-NC\ntitle: Never commit until asked\ncategory: rules\nscope: [all-projects]\nstatus: active\n---\n## Rule\nMake edits, verify, stop.\n## Why\nCommits are the author\'s alone.\n## How\nWait for an explicit ask.\n',
    'utf8'
  );
  const entry = readEntry(root, 'rules', 'never-commit');
  assert.ok(entry);
  assert.strictEqual(entry.frontmatter.id, 'R-NC');
  assert.strictEqual(entry.frontmatter.category, 'rules');
  assert.deepStrictEqual(entry.frontmatter.scope, ['all-projects']);
  assert.strictEqual(entry.body.rule, 'Make edits, verify, stop.');
  assert.strictEqual(entry.body.why, "Commits are the author's alone.");
  assert.strictEqual(entry.body.how, 'Wait for an explicit ask.');
});

// ---------- listCategoryEntries: legacy fallback + ordering + superseded inclusion ----------

test('listCategoryEntries: legacy fallback → [] when _details dir absent', () => {
  invalidate();
  const root = mkBrain(); // empty brain, no preferences/_details dir
  assert.deepStrictEqual(listCategoryEntries(root, 'preferences'), []);
  assert.deepStrictEqual(listCategoryEntries(root, 'rules'), []);
  assert.deepStrictEqual(listCategoryEntries(root, 'topics'), []);
});

test('listCategoryEntries: invalid category → [] (whitelist only)', () => {
  invalidate();
  const root = mkBrain();
  assert.deepStrictEqual(listCategoryEntries(root, 'identity'), []);
  assert.deepStrictEqual(listCategoryEntries(root, '../etc'), []);
  assert.deepStrictEqual(listCategoryEntries(root, ''), []);
});

function writeEntry(root, category, slug, fm) {
  const dir = path.join(root, category, '_details');
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(k + ': ' + v);
  lines.push('---', '## Rule', 'rule for ' + slug, '');
  fs.writeFileSync(path.join(dir, slug + '.md'), lines.join('\n'), 'utf8');
}

test('listCategoryEntries: active-first, then newest since, slug tiebreak; superseded included', () => {
  invalidate();
  const root = mkBrain();
  // two superseded (one of them omitted from any _index.md), three active across dates.
  writeEntry(root, 'preferences', 'old-rule', { id: 'P1', status: 'superseded', since: '2026-01-01', superseded_by: 'new-rule' });
  writeEntry(root, 'preferences', 'newer-superseded', { id: 'P2', status: 'superseded', since: '2026-03-01', superseded_by: 'x' });
  writeEntry(root, 'preferences', 'active-jan', { id: 'P3', status: 'active', since: '2026-01-15' });
  writeEntry(root, 'preferences', 'active-jun-b', { id: 'P4', status: 'active', since: '2026-06-01' });
  writeEntry(root, 'preferences', 'active-jun-a', { id: 'P5', status: 'active', since: '2026-06-01' });

  const rows = listCategoryEntries(root, 'preferences');
  assert.strictEqual(rows.length, 5);
  // active block first, ordered newest-since then slug; superseded block after, newest-since first.
  assert.deepStrictEqual(rows.map((r) => r.slug), [
    'active-jun-a', 'active-jun-b', // same since → slug tiebreak (a before b)
    'active-jan',
    'newer-superseded', // 2026-03 before 2026-01 within superseded block
    'old-rule',
  ]);
  // superseded entries carry their superseded_by pointer through.
  const old = rows.find((r) => r.slug === 'old-rule');
  assert.strictEqual(old.frontmatter.superseded_by, 'new-rule');
  assert.strictEqual(old.frontmatter.status, 'superseded');
  // active entries omit superseded_by entirely.
  assert.ok(!('superseded_by' in rows[0].frontmatter));
  // shape: { slug, frontmatter, body } with the parsed body.
  assert.strictEqual(rows[0].body.rule, 'rule for active-jun-a');
});

test('listCategoryEntries: skips non-slug filenames + unreadable entries, keeps going', () => {
  invalidate();
  const root = mkBrain();
  writeEntry(root, 'rules', 'good', { id: 'R1', status: 'active', since: '2026-02-02' });
  // a stray non-.md file (ignored by the .md filter) + a directory masquerading shouldn't crash.
  fs.writeFileSync(path.join(root, 'rules', '_details', 'README.txt'), 'not an entry', 'utf8');
  const rows = listCategoryEntries(root, 'rules');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].slug, 'good');
});
