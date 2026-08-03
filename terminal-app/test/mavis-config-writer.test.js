'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../src/mavis-config-writer');

const PROJ_INDEX = ['---', 'name: demo', 'type: tool', 'status: active', 'path: C:/x/demo', '---', '', '# Demo', '', '## Notes', '- a note', ''].join('\n');

// A synthetic identity/profile.md. The name and pronouns are placeholders (`Ada`, they/them) —
// nothing here reads the real brain, and the setFrontmatterKey test below relies on the pronouns
// value actually CHANGING, so keep the seed value different from what that test writes.
const SAMPLE = [
  '---',
  'name: Ada',
  'pronouns: they/them',
  '---',
  '',
  '# Profile',
  '',
  'intro line.',
  '',
  '## Core traits',
  '- Direct.',
  '- Curious.',
  '',
  '## Tone',
  '',
  'Talk like a peer.',
  '',
].join('\n');

const PREFS = ['# Prefs', '', '## Domain', '- **2026-05-04** — Full-stack.', '', '## Git', '', '- **2026-05-29** — No co-author.', ''].join('\n');

test('parseSections splits frontmatter, preBody, and ## sections', () => {
  const p = W.parseSections(SAMPLE);
  assert.deepEqual(p.frontmatter, ['name: Ada', 'pronouns: they/them']);
  assert.equal(p.sections.length, 2);
  assert.deepEqual(p.sections.map((s) => s.headingText), ['Core traits', 'Tone']);
});

test('emit(parseSections(md)) round-trips byte-identical', () => {
  assert.equal(W.emit(W.parseSections(SAMPLE)), SAMPLE);
  assert.equal(W.emit(W.parseSections(PREFS)), PREFS);
});

test('replaceSectionBody with the SAME body is byte-identical (surgical, no drift)', () => {
  const r = W.replaceSectionBody(SAMPLE, 'Tone', 'Talk like a peer.');
  assert.equal(r.ok, true);
  assert.equal(r.md, SAMPLE);
});

test('replaceSectionBody edits only the target; all else verbatim', () => {
  const r = W.replaceSectionBody(SAMPLE, 'Tone', 'New tone.');
  assert.equal(r.ok, true);
  const p = W.parseSections(r.md);
  assert.deepEqual(p.frontmatter, ['name: Ada', 'pronouns: they/them']);
  assert.deepEqual(p.sections[0].bodyLines, ['- Direct.', '- Curious.', '']); // Core traits untouched
  assert.ok(r.md.includes('New tone.'));
  assert.ok(!r.md.includes('Talk like a peer.'));
});

test('replaceSectionBody fails on an unknown heading', () => {
  assert.equal(W.replaceSectionBody(SAMPLE, 'Nope', 'x').ok, false);
});

test('setFrontmatterKey updates an existing key', () => {
  const r = W.setFrontmatterKey(SAMPLE, 'pronouns', 'she/her');
  assert.equal(r.ok, true);
  assert.deepEqual(W.parseSections(r.md).frontmatter, ['name: Ada', 'pronouns: she/her']);
});

test('appendPreferenceEntry appends a schema-correct bullet under the bucket', () => {
  const r = W.appendPreferenceEntry(PREFS, 'Domain', '2026-06-26', 'Likes themes.', 'because pretty');
  assert.equal(r.ok, true);
  assert.ok(r.md.includes('- **2026-06-26** — Likes themes.'));
  assert.ok(r.md.includes('  **Why:** because pretty'));
  // Git bucket + its entry untouched
  assert.ok(r.md.includes('- **2026-05-29** — No co-author.'));
  assert.equal(W.parseSections(r.md).sections.length, 2);
});

test('appendPreferenceEntry rejects a bad date', () => {
  assert.equal(W.appendPreferenceEntry(PREFS, 'Domain', 'nope', 'x').ok, false);
});

test('guard aborts when an edit would introduce a new ## heading', () => {
  const sneaky = W.replaceSectionBody(SAMPLE, 'Tone', '## Sneaky\nhi');
  assert.equal(sneaky.ok, true); // the transform itself succeeds...
  const g = W.guard(SAMPLE, sneaky.md); // ...but the guard catches the heading-set change
  assert.equal(g.ok, false);
});

test('guard passes a clean same-heading-set edit', () => {
  const r = W.replaceSectionBody(SAMPLE, 'Tone', 'A perfectly normal new tone.');
  assert.equal(W.guard(SAMPLE, r.md).ok, true);
});

test('removeFrontmatterKey drops only the named key', () => {
  const r = W.removeFrontmatterKey(SAMPLE, 'pronouns');
  assert.equal(r.ok, true);
  assert.deepEqual(W.parseSections(r.md).frontmatter, ['name: Ada']);
});

test('saveProjectColor writes a quoted hex, clears it, and guards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-color-'));
  const slug = 'demo';
  fs.mkdirSync(path.join(dir, 'projects', slug), { recursive: true });
  const idx = path.join(dir, 'projects', slug, 'index.md');
  fs.writeFileSync(idx, PROJ_INDEX);

  // set
  let r = W.saveProjectColor(dir, slug, '#97243B');
  assert.equal(r.ok, true);
  let after = fs.readFileSync(idx, 'utf8');
  assert.ok(after.includes('color: "#97243B"'), 'hex is quoted (valid YAML)');
  assert.equal(W.parseSections(after).sections.length, 1); // headings intact (guard held)

  // clear → removes the key
  r = W.saveProjectColor(dir, slug, '');
  assert.equal(r.ok, true);
  after = fs.readFileSync(idx, 'utf8');
  assert.ok(!/\bcolor:/.test(after), 'color key removed on clear');

  // rejects bad input
  assert.equal(W.saveProjectColor(dir, slug, 'red').ok, false);
  assert.equal(W.saveProjectColor(dir, '../evil', '#fff').ok, false);

  fs.rmSync(dir, { recursive: true, force: true });
});
