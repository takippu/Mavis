'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('../src/project-writer');

function tmpBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-pw-'));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

test('slugify produces a clean kebab slug', () => {
  assert.equal(pw.slugify('My Cool Project!!'), 'my-cool-project');
  assert.equal(pw.slugify('  Edge--Case  '), 'edge-case');
  assert.equal(pw.slugify('bluebird'), 'bluebird'); // an already-clean slug passes through unchanged
  assert.equal(pw.slugify(''), '');
});

test('validateNew rejects an empty / invalid slug', () => {
  const b = tmpBrain();
  assert.equal(pw.validateNew(b, '').ok, false);
  assert.equal(pw.validateNew(b, '-bad').ok, false);
  assert.equal(pw.validateNew(b, 'Good').ok, false); // uppercase isn't a slug
  assert.equal(pw.validateNew(b, 'good-one').ok, true);
});

test('validateNew rejects a slug whose projects/<slug>/ already exists', () => {
  const b = tmpBrain();
  fs.mkdirSync(path.join(b, 'projects', 'taken'));
  const r = pw.validateNew(b, 'taken');
  assert.equal(r.ok, false);
  assert.match(r.reason, /already exists/);
});

test('validateNew rejects a slug already listed in _index.md', () => {
  const b = tmpBrain();
  fs.writeFileSync(path.join(b, 'projects', '_index.md'), '# Projects\n\n## Active\n- [listed](listed/index.md) — tool, active — x\n');
  assert.equal(pw.validateNew(b, 'listed').ok, false);
  assert.equal(pw.validateNew(b, 'notlisted').ok, true);
});

test('planLines reflects the chosen options (new + git + remote)', () => {
  const lines = pw.planLines({ mode: 'new', slug: 'x', path: 'C:/p/x', createFolder: true, gitInit: true, remote: { provider: 'github', private: true } });
  assert.ok(lines.some((l) => /Create folder/.test(l)));
  assert.ok(lines.some((l) => /Initialize git/.test(l)));
  assert.ok(lines.some((l) => /private repo on github\.com/.test(l)));
  assert.ok(lines.some((l) => /projects\/x\/\{index,progress,notes\}/.test(l)));
});

test('planLines for existing mode only links + writes brain', () => {
  const lines = pw.planLines({ mode: 'existing', slug: 'y', path: 'C:/p/y' });
  assert.ok(lines.some((l) => /Link existing folder/.test(l)));
  assert.ok(!lines.some((l) => /Initialize git/.test(l)));
});

test('indexMd carries the contract frontmatter', () => {
  const md = pw.indexMd({ slug: 'demo', name: 'Demo', type: 'web-app', description: 'A thing', dirPath: 'C:/p/demo', tags: 'a, b' });
  assert.match(md, /^---\nname: Demo\ntype: web-app\nstatus: active\npath: C:\/p\/demo\ncreated: \d{4}-\d{2}-\d{2}\nlast_accessed: \d{4}-\d{2}-\d{2}\ntags: \[a, b\]\n---/);
  assert.match(md, /# Demo/);
  assert.match(md, /A thing/);
});

test('appendToIndex inserts as the last Active bullet, leaving other sections stable', () => {
  const idx = [
    '# Projects', '', '## Active',
    '- [a](a/index.md) — tool, active — A',
    '- [b](b/index.md) — web-app, active — B',
    '', '## Paused', '- [z](z/index.md) — tool, paused — Z', '',
  ].join('\n');
  const next = pw.appendToIndex(idx, pw.indexEntry({ slug: 'c', type: 'bot', description: 'C' }));
  const lines = next.split('\n');
  // c lands right after b (index 4), before the blank + ## Paused
  assert.equal(lines[4], '- [b](b/index.md) — web-app, active — B');
  assert.equal(lines[5], '- [c](c/index.md) — bot, active — C');
  assert.ok(next.indexOf('## Paused') > next.indexOf('- [c]'));
  assert.ok(next.includes('- [z](z/index.md) — tool, paused — Z')); // paused section untouched
});

test('appendToIndex creates an Active section when none exists', () => {
  const next = pw.appendToIndex('# Projects\n', pw.indexEntry({ slug: 'first', type: 'tool', description: 'First' }));
  assert.match(next, /## Active\n- \[first\]\(first\/index\.md\)/);
});

test('createProject (existing mode) writes the brain entry pointing at the folder', async () => {
  const b = tmpBrain();
  fs.writeFileSync(path.join(b, 'projects', '_index.md'), '# Projects\n\n## Active\n');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-existing-'));
  const r = await pw.createProject(b, { mode: 'existing', name: 'Linked App', type: 'tool', description: 'desc', path: folder });
  assert.equal(r.ok, true);
  assert.equal(r.slug, 'linked-app');
  assert.ok(fs.existsSync(path.join(b, 'projects', 'linked-app', 'index.md')));
  assert.ok(fs.existsSync(path.join(b, 'projects', 'linked-app', 'progress.md')));
  assert.ok(fs.existsSync(path.join(b, 'projects', 'linked-app', 'references')));
  const idx = fs.readFileSync(path.join(b, 'projects', '_index.md'), 'utf8');
  assert.match(idx, /- \[linked-app\]\(linked-app\/index\.md\) — tool, active — desc/);
  const md = fs.readFileSync(path.join(b, 'projects', 'linked-app', 'index.md'), 'utf8');
  assert.ok(md.includes(`path: ${folder}`));
});

test('createProject refuses a duplicate slug without writing anything', async () => {
  const b = tmpBrain();
  fs.mkdirSync(path.join(b, 'projects', 'dup'));
  const r = await pw.createProject(b, { mode: 'existing', name: 'dup', path: os.tmpdir() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already exists/);
});
