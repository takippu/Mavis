'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseProjectsIndex, extractFrontmatterPath } = require('../src/index-parser');

const SAMPLE = [
  '# Projects',
  '',
  '## Active',
  '- [mavis-brain](mavis-brain/index.md) — meta, active — The Mavis brain itself',
  '- [bluebird](bluebird/index.md) — web-app, active — Astro 6 static site — live at bluebird.example.com',
  '',
  '## Paused',
  '- [northwind](northwind/index.md) — web-app, paused — Northwind meeting assistant',
  '',
  '## Archived',
  '',
  '*Format:*',
  '```',
  '- [<name>](<name>/index.md) — <type>, <status> — <one-line description>',
  '```',
  '',
].join('\n');

test('parses projects across Active and Paused groups', () => {
  const names = parseProjectsIndex(SAMPLE).map((p) => p.name);
  assert.ok(names.includes('mavis-brain'));
  assert.ok(names.includes('bluebird'));
  assert.ok(names.includes('northwind'));
});

test('extracts name, slug, type, status, group, and full description', () => {
  const bb = parseProjectsIndex(SAMPLE).find((p) => p.name === 'bluebird');
  assert.strictEqual(bb.slug, 'bluebird');
  assert.strictEqual(bb.type, 'web-app');
  assert.strictEqual(bb.status, 'active');
  assert.strictEqual(bb.group, 'Active');
  // the description keeps its own em-dash — the parser must not split on the SECOND one
  assert.match(bb.description, /Astro 6 static site — live at bluebird\.example\.com/);
});

test('ignores the <name> placeholder inside the code fence', () => {
  const projects = parseProjectsIndex(SAMPLE);
  assert.ok(!projects.some((p) => p.name.includes('<')));
});

test('empty / non-string input returns an empty array', () => {
  assert.deepStrictEqual(parseProjectsIndex(''), []);
  assert.deepStrictEqual(parseProjectsIndex(null), []);
  assert.deepStrictEqual(parseProjectsIndex(undefined), []);
});

test('input with no project lines returns an empty array', () => {
  assert.deepStrictEqual(parseProjectsIndex('# Projects\n\nsome prose, no list\n'), []);
});

// ---- extractFrontmatterPath ----

// A deliberately fake Windows path: the point of the fixture is the backslashes (they must survive
// verbatim, not get read as escapes), so any absolute-looking path does the job.
const INDEX_WITH_PATH = [
  '---',
  'name: bluebird',
  'type: web',
  'status: active',
  'path: C:\\projects\\bluebird',
  'created: 2026-05-11',
  '---',
  '',
  '# bluebird',
].join('\n');

test('extracts the frontmatter path', () => {
  assert.strictEqual(
    extractFrontmatterPath(INDEX_WITH_PATH),
    'C:\\projects\\bluebird'
  );
});

test('strips surrounding quotes from the path', () => {
  const md = '---\nname: x\npath: "C:\\some\\dir"\n---\n';
  assert.strictEqual(extractFrontmatterPath(md), 'C:\\some\\dir');
});

test('returns null when frontmatter has no path', () => {
  assert.strictEqual(extractFrontmatterPath('---\nname: x\nstatus: active\n---\n'), null);
});

test('returns null when there is no frontmatter or bad input', () => {
  assert.strictEqual(extractFrontmatterPath('# just a heading\n'), null);
  assert.strictEqual(extractFrontmatterPath(''), null);
  assert.strictEqual(extractFrontmatterPath(null), null);
});

test('does not read a path that lives after the frontmatter block', () => {
  const md = '---\nname: x\n---\n\nsome body text\npath: C:\\not\\frontmatter\n';
  assert.strictEqual(extractFrontmatterPath(md), null);
});
