'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseFrontmatter,
  parseTasksProgress,
  parseDailyHeadlines,
  parseProgressCheckpoints,
  parseNotesEntries,
  makeSnippet,
  searchBrain,
  contractFiles,
} = require('../src/brain-stats');

// ---- contractFiles ----
// AGENTS.md is the canonical contract post-contract-layer; CLAUDE.md is generated from it.
// A legacy brain (no AGENTS.md yet) still reports its lone CLAUDE.md, treated as canonical.

test('contract stats report BOTH contract files, canonical first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# canonical\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# generated\n');
  const s = contractFiles(dir);
  assert.deepStrictEqual(s.map((f) => f.name), ['AGENTS.md', 'CLAUDE.md']);
  assert.strictEqual(s[0].canonical, true);
  assert.strictEqual(s[1].generated, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a legacy brain with only CLAUDE.md still reports one contract file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# legacy\n');
  const s = contractFiles(dir);
  assert.deepStrictEqual(s.map((f) => f.name), ['CLAUDE.md']);
  assert.strictEqual(s[0].canonical, true);
  assert.strictEqual(s[0].generated, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('contractFiles returns [] when neither contract file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  assert.deepStrictEqual(contractFiles(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- parseFrontmatter ----

// A deliberately fake Windows path — the fixture exists to prove backslashes survive verbatim,
// so it must not be anyone's real home directory.
const FRONTMATTER = [
  '---',
  'path: C:\\projects\\bluebird',
  'last_accessed: 2026-06-24',
  'status: in-progress',
  '---',
  '',
  '# bluebird',
].join('\n');

test('parseFrontmatter extracts path, last_accessed, and status', () => {
  const fm = parseFrontmatter(FRONTMATTER);
  assert.strictEqual(fm.path, 'C:\\projects\\bluebird');
  assert.strictEqual(fm.last_accessed, '2026-06-24');
  assert.strictEqual(fm.status, 'in-progress');
});

test('parseFrontmatter strips surrounding double quotes', () => {
  const md = '---\npath: "C:\\some\\dir"\nstatus: "active"\n---\n';
  const fm = parseFrontmatter(md);
  assert.strictEqual(fm.path, 'C:\\some\\dir');
  assert.strictEqual(fm.status, 'active');
});

test('parseFrontmatter strips surrounding single quotes', () => {
  const md = "---\nstatus: 'in-progress'\n---\n";
  assert.strictEqual(parseFrontmatter(md).status, 'in-progress');
});

test('parseFrontmatter returns {} when there is no leading frontmatter', () => {
  assert.deepStrictEqual(parseFrontmatter('# just a heading\n'), {});
  assert.deepStrictEqual(parseFrontmatter('some prose\n---\npath: x\n---\n'), {});
});

test('parseFrontmatter returns {} for empty / non-string input', () => {
  assert.deepStrictEqual(parseFrontmatter(''), {});
  assert.deepStrictEqual(parseFrontmatter(null), {});
  assert.deepStrictEqual(parseFrontmatter(undefined), {});
});

test('parseFrontmatter does not read keys after the closing ---', () => {
  const md = '---\npath: C:\\real\n---\nstatus: after-close\nlast_accessed: 2099-01-01\n';
  const fm = parseFrontmatter(md);
  assert.strictEqual(fm.path, 'C:\\real');
  assert.strictEqual(fm.status, undefined);
  assert.strictEqual(fm.last_accessed, undefined);
});

// ---- parseTasksProgress ----

test('parseTasksProgress reads total and completed', () => {
  const md = 'Progress Summary\n**Total Tasks**: 12\n**Completed**: 5\n';
  assert.deepStrictEqual(parseTasksProgress(md), { total: 12, completed: 5 });
});

test('parseTasksProgress defaults completed to 0 when missing', () => {
  const md = '**Total Tasks**: 8\n';
  assert.deepStrictEqual(parseTasksProgress(md), { total: 8, completed: 0 });
});

test('parseTasksProgress returns null when no Total Tasks line', () => {
  assert.strictEqual(parseTasksProgress('**Completed**: 3\n'), null);
  assert.strictEqual(parseTasksProgress('no progress markers here\n'), null);
});

test('parseTasksProgress returns null for empty / non-string input', () => {
  assert.strictEqual(parseTasksProgress(''), null);
  assert.strictEqual(parseTasksProgress(null), null);
  assert.strictEqual(parseTasksProgress(undefined), null);
});

// ---- parseDailyHeadlines ----

const DAILY = [
  '# 2026-06-24',
  '',
  '## bluebird — shipped the MP3 player',
  'body text that should be ignored',
  '',
  '## mavis — rebuilt the topic index',
  '',
  '## Notes (no project)',
  'loose notes that are not a project',
].join('\n');

test('parseDailyHeadlines maps "## proj — headline" headings', () => {
  const out = parseDailyHeadlines(DAILY);
  assert.deepStrictEqual(out, [
    { project: 'bluebird', headline: 'shipped the MP3 player' },
    { project: 'mavis', headline: 'rebuilt the topic index' },
  ]);
});

test('parseDailyHeadlines skips the "## Notes (no project)" heading', () => {
  const out = parseDailyHeadlines(DAILY);
  assert.ok(!out.some((h) => /Notes/.test(h.project)));
});

test('parseDailyHeadlines falls back headline to project when no em-dash', () => {
  const out = parseDailyHeadlines('## standalone-project\n');
  assert.deepStrictEqual(out, [{ project: 'standalone-project', headline: 'standalone-project' }]);
});

test('parseDailyHeadlines returns [] for empty / non-string input', () => {
  assert.deepStrictEqual(parseDailyHeadlines(''), []);
  assert.deepStrictEqual(parseDailyHeadlines(null), []);
  assert.deepStrictEqual(parseDailyHeadlines(undefined), []);
});

test('parseDailyHeadlines returns [] when there are no headings', () => {
  assert.deepStrictEqual(parseDailyHeadlines('# title\n\njust prose, no h2\n'), []);
});

// ---- review-fix regressions ----

test('parseDailyHeadlines skips a heading whose project segment is empty (leading em-dash)', () => {
  assert.deepStrictEqual(parseDailyHeadlines('## — orphan headline\n'), []);
});

test('parseFrontmatter does not corrupt a value that is a single quote character', () => {
  assert.strictEqual(parseFrontmatter("---\nq: '\n---\n").q, "'");
});

// ---- brain-panels helpers ----

test('parseProgressCheckpoints returns newest-first capped blocks with joined bullets', () => {
  const md = '# P\n\n## 2026-06-01\n- a\n- b\n\n## 2026-06-02\n- c\n';
  const out = parseProgressCheckpoints(md);
  assert.strictEqual(out[0].when, '2026-06-02');
  assert.strictEqual(out[1].when, '2026-06-01');
  assert.match(out[1].text, /a/);
});

test('parseNotesEntries lists section headings, empty on none', () => {
  assert.deepStrictEqual(parseNotesEntries('# N\n\n## one\nx\n## two\n'), [{ text: 'one' }, { text: 'two' }]);
  assert.deepStrictEqual(parseNotesEntries('no headings'), []);
});

test('makeSnippet trims around the hit with ellipses', () => {
  const long = 'x'.repeat(60) + 'NEEDLE' + 'y'.repeat(60);
  const s = makeSnippet(long, 'needle');
  assert.ok(s.includes('NEEDLE'));
  assert.ok(s.startsWith('…'));
});

test('searchBrain finds a term in daily memories and bails under 2 chars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(root, 'daily-memories'));
  fs.writeFileSync(path.join(root, 'daily-memories', '2026-06-24.md'), '# d\n\nthe ZEBRA crossed\n');
  fs.writeFileSync(path.join(root, 'topic_index.md'), 'nothing here');
  fs.mkdirSync(path.join(root, 'projects'));
  fs.writeFileSync(path.join(root, 'projects', '_index.md'), '# Projects\n\n## Active\n');
  const hits = searchBrain(root, 'zebra');
  assert.ok(hits.some((h) => /ZEBRA/.test(h.snippet) && h.file === '2026-06-24.md'));
  assert.deepStrictEqual(searchBrain(root, 'z'), []);
});

test('listDailyMemories returns dates newest-first with project sections', () => {
  const { listDailyMemories } = require('../src/brain-stats');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(root, 'daily-memories'));
  fs.writeFileSync(path.join(root, 'daily-memories', '2026-06-23.md'), '# 2026-06-23\n\n## alpha — did x\nwork\n');
  fs.writeFileSync(path.join(root, 'daily-memories', '2026-06-24.md'), '# 2026-06-24\n\n## alpha — y\n\n## beta — z\n');
  const days = listDailyMemories(root);
  assert.deepStrictEqual(days.map((d) => d.date), ['2026-06-24', '2026-06-23']);
  assert.deepStrictEqual(days[0].projects, ['alpha', 'beta']);
  assert.strictEqual(days[0].count, 2);
});

test('getDailyMemory reads one day, empties on missing, rejects a bad date', () => {
  const { getDailyMemory } = require('../src/brain-stats');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(root, 'daily-memories'));
  fs.writeFileSync(path.join(root, 'daily-memories', '2026-06-24.md'), 'hello day');
  assert.strictEqual(getDailyMemory(root, '2026-06-24').content, 'hello day');
  assert.strictEqual(getDailyMemory(root, '2026-06-25').content, '');
  assert.strictEqual(getDailyMemory(root, 'nope'), null);
});

// ---- dashboard aggregates ----

const { computeStreak, weekStats, aggregateProjectActivity } = require('../src/brain-stats');
const isoOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

test('computeStreak finds the longest run (best), 0 current when the run is old', () => {
  const r = computeStreak([
    { date: '2020-01-01', count: 1 }, { date: '2020-01-02', count: 3 }, { date: '2020-01-03', count: 2 },
    { date: '2020-01-05', count: 1 },
  ]);
  assert.strictEqual(r.best, 3);
  assert.strictEqual(r.current, 0);
});

test('computeStreak counts a current run ending today/yesterday', () => {
  const today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const r = computeStreak([{ date: isoOf(today), count: 2 }, { date: isoOf(yest), count: 1 }]);
  assert.ok(r.current >= 2, 'current streak should include today + yesterday');
  assert.ok(r.best >= 2);
});

test('computeStreak ignores zero-count days and empty input', () => {
  assert.deepStrictEqual(computeStreak([]), { current: 0, best: 0 });
  assert.deepStrictEqual(computeStreak([{ date: '2020-01-01', count: 0 }]), { current: 0, best: 0 });
  assert.deepStrictEqual(computeStreak(null), { current: 0, best: 0 });
});

test('weekStats sums by Sunday-week and reports the peak week', () => {
  const r = weekStats([
    { date: '2020-03-02', count: 4 }, { date: '2020-03-03', count: 6 }, // one week → 10
    { date: '2020-03-10', count: 4 }, // another week → 4
  ]);
  assert.strictEqual(r.peak, 10);
  assert.deepStrictEqual(weekStats([]), { current: 0, peak: 0 });
});

test('weekStats current reflects the current week total', () => {
  const today = new Date();
  const r = weekStats([{ date: isoOf(today), count: 5 }]);
  assert.strictEqual(r.current, 5);
});

test('aggregateProjectActivity counts mentions, sorts desc, flags status, caps', () => {
  const daily = [
    { headlines: [{ project: 'alpha' }, { project: 'beta' }, { project: 'alpha' }] },
    { headlines: [{ project: 'alpha' }, { project: 'gamma' }] },
  ];
  const projects = [
    { name: 'alpha', slug: 'alpha', status: 'active' },
    { name: 'beta', slug: 'beta', status: 'paused' },
  ];
  const out = aggregateProjectActivity(daily, projects, 10);
  assert.deepStrictEqual(out[0], { name: 'alpha', count: 3, active: true });
  const beta = out.find((p) => p.name === 'beta');
  assert.strictEqual(beta.active, false);
  const gamma = out.find((p) => p.name === 'gamma'); // unknown project → defaults active
  assert.strictEqual(gamma.active, true);
  assert.strictEqual(aggregateProjectActivity(daily, projects, 2).length, 2);
});

test('listTopics reads slug+triggers from the index and substance from topic_details/<slug>.md (two-tier)', () => {
  const { listTopics } = require('../src/brain-stats');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  const index = [
    '# Topic Index', '', 'intro text', '',
    '## Topic: payment-gateway', '', '**Triggers:** stripe, payex, billplz', '', '**Detail:** [topic_details/payment-gateway.md](topic_details/payment-gateway.md)', '', '---', '',
    '## Topic: auth', '', '**Triggers:** jwt, oauth', '', '**Detail:** [topic_details/auth.md](topic_details/auth.md)', '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'topic_index.md'), index);
  fs.mkdirSync(path.join(root, 'topic_details'));
  fs.writeFileSync(path.join(root, 'topic_details', 'payment-gateway.md'), [
    '# Topic: payment-gateway', '',
    '**Index:** [topic_index.md → Topic: payment-gateway](../topic_index.md)', '',
    '**Did:** integrated PayEx on northwind', '',
    '**Refs:**', '- `projects/northwind/notes.md` (PayEx infra)', '',
    '**Pre-empt:** only PayEx done so far', '',
    '**Settlement IPN note (added 2026-06-03):** PayEx pushes an undocumented settlement callback.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'topic_details', 'auth.md'), [
    '# Topic: auth', '', '**Index:** [topic_index.md](../topic_index.md)', '', '**Did:** signed cookies', '',
  ].join('\n'));
  const topics = listTopics(root);
  assert.strictEqual(topics.length, 2);
  assert.strictEqual(topics[0].slug, 'payment-gateway');
  assert.match(topics[0].triggers, /payex/);                          // triggers come from the lean index
  assert.strictEqual(topics[0].did, 'integrated PayEx on northwind');   // substance comes from the detail file
  assert.deepStrictEqual(topics[0].refs, ['`projects/northwind/notes.md` (PayEx infra)']);
  assert.match(topics[0].preempt, /only PayEx/);
  assert.strictEqual(topics[0].addendums.length, 1);
  assert.strictEqual(topics[0].addendums[0].date, '2026-06-03');
  assert.strictEqual(topics[1].slug, 'auth');
  assert.strictEqual(topics[1].did, 'signed cookies');
});

test('listTopics reads the new two-tier topics/ (index + _details with ## Did/Refs/Pre-empt)', () => {
  const { listTopics } = require('../src/brain-stats');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(root, 'topics', '_details'), { recursive: true });
  fs.writeFileSync(path.join(root, 'topics', '_index.md'), [
    '# Topics', '',
    '## payment-gateway', '**Triggers:** stripe, payex, billplz', '**Summary:** PayEx on northwind', '**Detail:** [_details/payment-gateway.md](_details/payment-gateway.md)', '',
    '## auth', '**Triggers:** jwt, oauth', '**Summary:** signed cookies', '**Detail:** [_details/auth.md](_details/auth.md)', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'topics', '_details', 'payment-gateway.md'), [
    '---', 'id: payment-gateway', 'title: Payment gateway', 'category: topic', 'scope: [payments]', 'status: active', 'since: 2026-03-12', 'updated: 2026-03-12', 'links: []', '---',
    '## Did', 'integrated PayEx on northwind', '## Refs', '- `projects/northwind/notes.md` (PayEx infra)', '## Pre-empt', 'only PayEx built; adapt for Stripe.',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'topics', '_details', 'auth.md'), [
    '---', 'id: auth', 'title: Auth', 'category: topic', 'scope: [auth]', 'status: active', 'since: 2026-01-01', 'updated: 2026-01-01', 'links: []', '---',
    '## Did', 'signed cookies',
  ].join('\n'));
  const topics = listTopics(root);
  assert.strictEqual(topics.length, 2);
  const pg = topics.find((t) => t.slug === 'payment-gateway');
  assert.ok(pg, 'payment-gateway present');
  assert.strictEqual(pg.triggers, 'stripe, payex, billplz');
  assert.match(pg.did, /integrated PayEx/);
  assert.deepStrictEqual(pg.refs, ['`projects/northwind/notes.md` (PayEx infra)']);
  assert.match(pg.preempt, /only PayEx built/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('listTopics falls back to the inline index body when topic_details/ is absent (old layout)', () => {
  const { listTopics } = require('../src/brain-stats');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  const md = [
    '# Topic Index', '', 'intro text', '',
    '## Topic: payment-gateway', '', '**Triggers:** stripe, payex, billplz', '', '**Did:** integrated PayEx on northwind', '', '**Refs:**', '- `projects/northwind/notes.md`', '', '**Pre-empt:** only PayEx done so far', '', 'body line', '', '---', '',
    '## Topic: auth', '', '**Triggers:** jwt, oauth', '', '**Did:** signed cookies', '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'topic_index.md'), md);
  const topics = listTopics(root);
  assert.strictEqual(topics.length, 2);
  assert.strictEqual(topics[0].slug, 'payment-gateway');
  assert.match(topics[0].triggers, /payex/);
  assert.strictEqual(topics[0].did, 'integrated PayEx on northwind');
  assert.deepStrictEqual(topics[0].refs, ['`projects/northwind/notes.md`']);
  assert.ok(topics[0].body.includes('body line'));
  assert.strictEqual(topics[1].slug, 'auth');
});

// ---- getIdentityFacets ----

const { getIdentityFacets } = require('../src/brain-stats');

// Built against a tmpdir fixture, NOT the repo's own identity/ folder. identity/ is gitignored,
// so asserting profile.name.length > 0 against the real brain passed only on a machine that had
// already run the setup wizard — on a fresh clone getIdentityFacets correctly returns empty
// arrays (the very next test pins that), so this went red on the first `npm test` a contributor
// ever ran. The contract being checked here is the facet SHAPE, which a synthetic brain proves
// just as well and on every machine.
test('getIdentityFacets parses a populated brain into non-empty facet arrays (contract shape)', () => {
  const realBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(realBrain, 'identity'));
  fs.writeFileSync(
    path.join(realBrain, 'identity', 'profile.md'),
    '---\nname: Ada\npronouns: they/them\n---\n# Profile\n'
  );
  fs.writeFileSync(path.join(realBrain, 'identity', 'personality.md'), [
    '# Mavis — Personality', '',
    '## Core traits', '- Direct.', '- Curious.', '',
    '## Tone', 'Talk like a senior engineer.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(realBrain, 'identity', 'communication.md'), [
    '# Mavis — Communication', '',
    '## How to address Ada', 'Call them **Ada**.', '',
    '## Language', 'Write in **English**.', '',
  ].join('\n'));
  const f = getIdentityFacets(realBrain);
  assert.ok(f.profile.name.length > 0, 'profile.name should be populated from profile.md');
  assert.ok(f.personality.length > 0, 'personality facets should be > 0');
  assert.ok(f.communication.length > 0, 'communication facets should be > 0');
  assert.ok(f.coreOaths.length > 0, 'coreOaths should be > 0');
  // every facet honours the {key,label,detail} contract, keys unique within each array
  for (const arr of [f.personality, f.communication, f.coreOaths]) {
    const keys = new Set();
    for (const x of arr) {
      assert.ok(x.key && x.label, 'facet needs a key + label');
      assert.strictEqual(typeof x.detail, 'string', 'facet detail is a string');
      assert.ok(!keys.has(x.key), 'facet keys are unique within their array');
      keys.add(x.key);
    }
  }
});

test('getIdentityFacets degrades to empty arrays (never throws) when identity files are missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  const f = getIdentityFacets(root);
  assert.deepStrictEqual(f.profile, { name: '', pronouns: '' });
  assert.deepStrictEqual(f.personality, []);
  assert.deepStrictEqual(f.communication, []);
  assert.ok(f.coreOaths.length > 0, 'coreOaths is a curated constant, present even on a legacy brain');
});

test('getIdentityFacets skips "Who you are", expands Core traits per-bullet, strips the name from comm headings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(root, 'identity'));
  fs.writeFileSync(path.join(root, 'identity', 'profile.md'), '---\nname: Ada\npronouns: they/them\n---\n# Profile\n');
  fs.writeFileSync(path.join(root, 'identity', 'personality.md'), [
    '# Mavis — Personality', '',
    '## Who you are', 'subtitle prose, not a facet', '',
    '## Core traits', '- Direct.', '- Quietly sharp.', '',
    '## Tone', 'talk like a senior engineer', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'identity', 'communication.md'), [
    '# Mavis — Communication', '',
    '## How to address Ada', 'Call them **Ada**.', '',
    '## Language', 'Write in **English**.', '',
  ].join('\n'));
  const f = getIdentityFacets(root);
  assert.deepStrictEqual(f.profile, { name: 'Ada', pronouns: 'they/them' });
  // "Who you are" dropped; two trait bullets + the Tone section = 3 personality facets
  assert.deepStrictEqual(f.personality.map((p) => p.label), ['Direct', 'Quietly sharp', 'Tone']);
  assert.strictEqual(f.personality[0].key, 'direct');
  assert.strictEqual(f.personality[0].detail, 'Direct.');                 // bullet detail keeps the period
  assert.strictEqual(f.personality[1].key, 'quietly-sharp');
  assert.strictEqual(f.personality[2].detail, 'talk like a senior engineer'); // section body
  // communication: name stripped from the label, key keeps the original-heading slug
  assert.strictEqual(f.communication[0].label, 'How to address');
  assert.strictEqual(f.communication[0].key, 'how-to-address-ada');
  assert.strictEqual(f.communication[1].label, 'Language');
});

test('searchBrain scans topic_details/*.md so the two-tier topic substance stays findable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(root, 'daily-memories'));
  fs.writeFileSync(path.join(root, 'topic_index.md'), '## Topic: payment-gateway\n**Triggers:** payex\n**Detail:** [topic_details/payment-gateway.md](topic_details/payment-gateway.md)\n');
  fs.mkdirSync(path.join(root, 'topic_details'));
  fs.writeFileSync(path.join(root, 'topic_details', 'payment-gateway.md'), '# Topic: payment-gateway\n\n**Did:** integrated PayEx with QUOKKA reconciliation\n');
  fs.mkdirSync(path.join(root, 'projects'));
  fs.writeFileSync(path.join(root, 'projects', '_index.md'), '# Projects\n\n## Active\n');
  const hits = searchBrain(root, 'quokka');
  assert.ok(hits.some((h) => /QUOKKA/.test(h.snippet) && h.file === 'topic_details/payment-gateway.md'));
});

// The repaired on-disk layout (brain-repair rotate / shard-notes): rotated checkpoints move to
// projects/<slug>/progress-archive/<year>.md and notes sections shard into
// projects/<slug>/notes/_details/<slug>.md. Both are OPTIONAL — a project with neither must not throw.

test('searchBrain scans progress-archive/*.md and notes/_details/*.md so repaired projects stay findable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-brain-'));
  fs.mkdirSync(path.join(root, 'daily-memories'));
  fs.mkdirSync(path.join(root, 'projects'));
  fs.writeFileSync(path.join(root, 'projects', '_index.md'), [
    '# Projects', '', '## Active',
    '- [repaired](repaired/index.md) — tool, active — has the new layout.',
    '- [plain](plain/index.md) — tool, active — legacy flat layout.',
  ].join('\n') + '\n');

  fs.mkdirSync(path.join(root, 'projects', 'repaired', 'progress-archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'repaired', 'progress.md'), '# repaired\n\n## 2026-07-17\n- hot checkpoint\n');
  fs.writeFileSync(path.join(root, 'projects', 'repaired', 'progress-archive', '2026.md'),
    '# repaired — Progress Archive 2026\n\n## 2026-01-04\n- shipped the WOMBAT migration\n');
  fs.mkdirSync(path.join(root, 'projects', 'repaired', 'notes', '_details'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'repaired', 'notes.md'), '# repaired — Notes\n\n## Right-edge cutoff\n**Detail:** [notes/_details/right-edge-cutoff.md](notes/_details/right-edge-cutoff.md)\n');
  fs.writeFileSync(path.join(root, 'projects', 'repaired', 'notes', '_details', 'right-edge-cutoff.md'),
    '# Right-edge cutoff\n\nthe NARWHAL gotcha bites on resize\n');

  // `plain` has neither new dir — absent dirs must be skipped silently, not throw.
  fs.mkdirSync(path.join(root, 'projects', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'plain', 'notes.md'), '# plain — Notes\n\n## thing\nordinary AXOLOTL note\n');

  const archived = searchBrain(root, 'wombat');
  assert.ok(archived.some((h) => h.file === 'repaired/progress-archive/2026.md' && h.slug === 'repaired' && h.project === 'repaired'),
    'archived checkpoint should be searchable, labelled <slug>/progress-archive/<year>.md');

  const sharded = searchBrain(root, 'narwhal');
  assert.ok(sharded.some((h) => h.file === 'repaired/notes/_details/right-edge-cutoff.md' && h.slug === 'repaired'),
    'sharded notes detail should be searchable, labelled <slug>/notes/_details/<slug>.md');

  // the project without the new dirs still works
  assert.ok(searchBrain(root, 'axolotl').some((h) => h.file === 'plain/notes.md'));
});
