// Tests for brain-repair shard-notes. Fixtures live in os.tmpdir() only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugifyTitle, splitSections, planShard, applyPlan } from '../lib/brain-repair-core.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'scripts', 'brain-repair.mjs');

function makeBrain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  for (const [r, c] of Object.entries(files)) {
    const p = path.join(root, r);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
  return root;
}

function mdLinks(s) {
  return [...s.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((t) => !/^(https?:|mailto:|#|\/|[A-Za-z]:)/.test(t) && /\.md(#|$)/.test(t));
}
const resolveFrom = (dir, targets) =>
  new Set(targets.map((t) => path.resolve(dir, t.split('#')[0]).replace(/\\/g, '/')));

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

const NOTES = [
  '# p — Notes', '',
  '## Right-edge cutoff',
  '**Discovered:** [2026-06-27](../../daily-memories/2026-06-27.md)',
  'xterm fit bug, see [spec](specs/x/design.md).', '',
  '## Windows toast gotcha',
  'Needs AppUserModelId.', '',
].join('\n');

test('slugifyTitle kebab-cases; dedupe is the caller concern', () => {
  assert.equal(slugifyTitle('PM Kanban + task-detail sheet (skeletons)'), 'pm-kanban-task-detail-sheet-skeletons');
  assert.equal(slugifyTitle('`API_KEY` logging'), 'api-key-logging');
  assert.equal(slugifyTitle('2026-07-17 → [daily memory](../../d.md)'), '2026-07-17-daily-memory');
  assert.equal(slugifyTitle('***'), '');
  assert.equal(slugifyTitle('  Trailing — punctuation!!  '), 'trailing-punctuation');
});

test('splitSections is lossless and CRLF-safe', () => {
  const { header, sections } = splitSections(NOTES);
  assert.equal(header, '# p — Notes\n\n');
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'Right-edge cutoff');
  assert.ok(!sections[0].body.startsWith('## '), 'heading must not leak into the body');
  assert.equal(header + sections.map((s) => s.raw).join(''), NOTES, 'split must be lossless');

  const crlf = '# p\r\n\r\n## A title\r\nbody a\r\n\r\n## B title\r\nbody b\r\n';
  const c = splitSections(crlf);
  assert.equal(c.sections.length, 2);
  assert.equal(c.sections[0].title, 'A title', 'CR must not corrupt the title');
  assert.equal(c.sections[0].body, 'body a\r\n\r\n', 'CRLF heading must be stripped from the body');
  assert.equal(c.header + c.sections.map((s) => s.raw).join(''), crlf);

  assert.deepEqual(splitSections('# p\n\nno sections\n'), { header: '# p\n\nno sections\n', sections: [] });
});

test('planShard turns notes.md into an index and writes details with rewritten links', () => {
  const root = makeBrain({ 'projects/p/notes.md': NOTES });
  const plan = planShard(root, 'p');
  const index = plan.writes.find((w) => w.path === 'projects/p/notes.md');
  const d1 = plan.writes.find((w) => w.path === 'projects/p/notes/_details/right-edge-cutoff.md');
  const d2 = plan.writes.find((w) => w.path === 'projects/p/notes/_details/windows-toast-gotcha.md');
  assert.ok(index && d1 && d2);
  assert.ok(index.after.includes('**Detail:** [notes/_details/right-edge-cutoff.md](notes/_details/right-edge-cutoff.md)'));
  assert.ok(index.after.includes('**Triggers:**'));
  assert.ok(index.after.startsWith('# p — Notes'), 'header is preserved');
  // notes/_details/ is TWO directories below notes.md, so links go up two extra levels.
  assert.ok(d1.after.includes('../../../../daily-memories/2026-06-27.md'));
  assert.ok(d1.after.includes('../../specs/x/design.md'));
  assert.ok(d1.after.startsWith('# Right-edge cutoff'));
  assert.ok(d2.after.includes('AppUserModelId'));
  const { backupDir } = applyPlan(root, plan);
  assert.ok(fs.existsSync(path.join(backupDir, 'projects/p/notes.md')));
  assert.ok(fs.readFileSync(path.join(root, 'projects/p/notes/_details/windows-toast-gotcha.md'), 'utf8').includes('AppUserModelId'));
});

test('sharded detail links resolve to exactly the same files as before the move', () => {
  const root = makeBrain({ 'projects/p/notes.md': NOTES });
  const plan = planShard(root, 'p');
  const before = resolveFrom(path.join(root, 'projects/p'), mdLinks(NOTES));
  assert.ok(before.size > 0);
  for (const w of plan.writes.filter((x) => x.path.includes('notes/_details/'))) {
    const dir = path.dirname(path.join(root, w.path));
    for (const t of resolveFrom(dir, mdLinks(w.after))) {
      assert.ok(before.has(t), `detail link resolves somewhere new: ${t} (in ${w.path})`);
    }
  }
  // The exact targets the fixture pointed at must still be reachable.
  const d1 = plan.writes.find((w) => w.path === 'projects/p/notes/_details/right-edge-cutoff.md');
  const resolved = resolveFrom(path.join(root, 'projects/p/notes/_details'), mdLinks(d1.after));
  assert.ok([...resolved].some((t) => t.endsWith('/daily-memories/2026-06-27.md')), 'daily-memory link must escape projects/');
  assert.ok([...resolved].some((t) => t.endsWith('/projects/p/specs/x/design.md')));
});

test('the index is a real index: pointer metadata and prose bodies move to the details', () => {
  const root = makeBrain({ 'projects/p/notes.md': NOTES });
  const plan = planShard(root, 'p');
  const index = plan.writes.find((w) => w.path === 'projects/p/notes.md');
  assert.ok(!index.after.includes('**Discovered:**'), 'Discovered pointer belongs in the detail file');
  assert.ok(index.after.includes('**Summary:** xterm fit bug'),
    'Summary must be the first line of prose, not the Discovered pointer and not a restatement of the title');
  assert.ok(index.after.includes('**Triggers:** right, edge, cutoff'));
  assert.ok(Buffer.byteLength(index.after) < Buffer.byteLength(NOTES) + 400, 'index stays index-sized');
  const d1 = plan.writes.find((w) => w.path === 'projects/p/notes/_details/right-edge-cutoff.md');
  assert.ok(d1.after.includes('**Discovered:**'), 'Discovered line is kept intact in the detail');
});

test('sharding is lossless: every section title and body reaches a detail file', () => {
  const titles = ['Alpha thing', 'Beta thing', 'Gamma thing'];
  const src = '# p — Notes\n\n' + titles.map((t, i) => `## ${t}\nbody-marker-${i} content here.\n\n`).join('');
  const root = makeBrain({ 'projects/p/notes.md': src });
  const plan = planShard(root, 'p');
  assert.equal(plan.summary.entries, 3);
  const details = plan.writes.filter((w) => w.path.includes('notes/_details/'));
  assert.equal(details.length, 3);
  for (let i = 0; i < titles.length; i++) {
    assert.ok(details.some((d) => d.after.includes(`# ${titles[i]}`)), `title ${titles[i]} lost`);
    assert.ok(details.some((d) => d.after.includes(`body-marker-${i}`)), `body ${i} lost`);
    const index = plan.writes.find((w) => w.path === 'projects/p/notes.md');
    assert.ok(index.after.includes(`## ${titles[i]}`), `index entry ${titles[i]} lost`);
  }
});

test('planShard dedupes duplicate section titles and handles unslugifiable ones', () => {
  const src = '# p\n\n## Dupe\nfirst body\n\n## Dupe\nsecond body\n\n## Dupe\nthird body\n\n## ***\nsymbol body\n\n## ***\nsymbol two\n\n';
  const root = makeBrain({ 'projects/p/notes.md': src });
  const plan = planShard(root, 'p');
  const paths = plan.writes.filter((w) => w.path.includes('_details')).map((w) => w.path);
  assert.deepEqual(paths, [
    'projects/p/notes/_details/dupe.md',
    'projects/p/notes/_details/dupe-2.md',
    'projects/p/notes/_details/dupe-3.md',
    'projects/p/notes/_details/untitled.md',
    'projects/p/notes/_details/untitled-2.md',
  ]);
  assert.equal(new Set(paths).size, paths.length, 'no two sections may share a detail file');
  const byPath = Object.fromEntries(plan.writes.map((w) => [w.path, w.after]));
  assert.ok(byPath['projects/p/notes/_details/dupe.md'].includes('first body'));
  assert.ok(byPath['projects/p/notes/_details/dupe-3.md'].includes('third body'));
  assert.ok(byPath['projects/p/notes/_details/untitled-2.md'].includes('symbol two'));
});

test('planShard handles a CRLF notes.md', () => {
  const src = '# p\r\n\r\n## Right-edge cutoff\r\n**Discovered:** [2026-06-27](../../daily-memories/2026-06-27.md)\r\nxterm fit bug.\r\n\r\n';
  const root = makeBrain({ 'projects/p/notes.md': src });
  const plan = planShard(root, 'p');
  const index = plan.writes.find((w) => w.path === 'projects/p/notes.md');
  const d1 = plan.writes.find((w) => w.path === 'projects/p/notes/_details/right-edge-cutoff.md');
  assert.ok(d1, 'CR must not corrupt the slug');
  assert.ok(!d1.after.includes('## Right-edge cutoff'), 'CRLF heading must not be duplicated into the body');
  assert.ok(d1.after.includes('../../../../daily-memories/2026-06-27.md'));
  assert.ok(index.after.includes('**Summary:** xterm fit bug.'), 'CR must not push the Discovered line into the summary');
  assert.ok(!index.after.includes('**Discovered:**'));
});

test('planShard on a notes.md with no sections is a safe no-op', () => {
  const src = '# p — Notes\n\nJust prose, nothing sharded yet.\n';
  const root = makeBrain({ 'projects/p/notes.md': src });
  const plan = planShard(root, 'p');
  assert.equal(plan.summary.entries, 0);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].after, src, 'a flat notes.md with no sections must come back byte-identical');
});

test('planShard refuses to re-shard an already-sharded notes.md', () => {
  const root = makeBrain({ 'projects/p/notes.md': NOTES });
  const plan = planShard(root, 'p');
  applyPlan(root, plan);
  const afterFirst = fs.readFileSync(path.join(root, 'projects/p/notes.md'), 'utf8');
  assert.throws(() => planShard(root, 'p'), /already sharded/);
  assert.equal(fs.readFileSync(path.join(root, 'projects/p/notes.md'), 'utf8'), afterFirst, 'refusal must not mutate');
});

test('a long body line is truncated in the Summary but kept whole in the detail', () => {
  const long = 'z'.repeat(500);
  const src = `# p\n\n## Long one\n${long}\n\n`;
  const root = makeBrain({ 'projects/p/notes.md': src });
  const plan = planShard(root, 'p');
  const index = plan.writes.find((w) => w.path === 'projects/p/notes.md');
  const detail = plan.writes.find((w) => w.path === 'projects/p/notes/_details/long-one.md');
  assert.ok(index.after.includes(`**Summary:** ${'z'.repeat(200)}\n`));
  assert.ok(!index.after.includes('z'.repeat(201)), 'summary must cap at 200 chars');
  assert.ok(detail.after.includes(long), 'the detail keeps the full line');
});

test('CLI shard-notes --dry-run writes nothing; --apply shards and backs up', () => {
  const root = makeBrain({ 'projects/p/notes.md': NOTES });
  const before = snapshot(root);
  const plan = JSON.parse(execFileSync(process.execPath, [CLI, 'shard-notes', 'p', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(plan.command, 'shard-notes');
  assert.equal(plan.summary.entries, 2);
  assert.deepEqual(snapshot(root), before, '--dry-run must not create, modify, or delete any file');
  assert.ok(!fs.existsSync(path.join(root, '_backup')));

  const applied = JSON.parse(execFileSync(process.execPath, [CLI, 'shard-notes', 'p', '--apply', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(applied.applied, true);
  assert.ok(fs.existsSync(path.join(root, 'projects/p/notes/_details/right-edge-cutoff.md')));
  assert.equal(fs.readFileSync(path.join(applied.backupDir, 'projects/p/notes.md'), 'utf8'), NOTES,
    'the backup must hold the original flat notes.md');
});

test('planShard refuses when a destination detail file already exists', () => {
  const hand = '# Right-edge cutoff\n\nHAND-WRITTEN: three hours of debugging that exists nowhere else.\n';
  const root = makeBrain({
    'projects/p/notes.md': NOTES, // flat: the **Detail:** guard does not fire
    'projects/p/notes/_details/right-edge-cutoff.md': hand,
  });
  assert.throws(() => planShard(root, 'p'), /already exists|refusing/i,
    'a colliding detail file means the two-tier state is inconsistent: refuse rather than clobber');
  try { planShard(root, 'p'); } catch (e) {
    assert.match(e.message, /right-edge-cutoff\.md/, 'the error must name the colliding path');
  }
  assert.equal(fs.readFileSync(path.join(root, 'projects/p/notes/_details/right-edge-cutoff.md'), 'utf8'), hand,
    'the refusal must not mutate anything');
});

test('a hand-started migration cannot be clobbered through the CLI', () => {
  const hand = '# Right-edge cutoff\n\nENRICHED: full root-cause writeup.\n';
  const root = makeBrain({
    'projects/p/notes.md': NOTES,
    'projects/p/notes/_details/right-edge-cutoff.md': hand,
  });
  const before = snapshot(root);
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'shard-notes', 'p', '--apply'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { status = e.status; stderr = e.stderr; }
  assert.equal(status, 1, 'exits 1 rather than destroying irreplaceable, gitignored content');
  assert.match(stderr, /already exists|refusing/i);
  assert.deepEqual(snapshot(root), before, 'the refused shard must leave every file untouched');
});

test('planShard reports an honest before for detail writes', () => {
  const root = makeBrain({ 'projects/p/notes.md': NOTES });
  const plan = planShard(root, 'p');
  for (const w of plan.writes.filter((x) => x.path.includes('notes/_details/'))) {
    assert.equal(w.before, null, 'these details genuinely do not exist yet');
    assert.ok(!fs.existsSync(path.join(root, w.path)), 'before:null must mean "absent from disk", not "unchecked"');
  }
  const index = plan.writes.find((w) => w.path === 'projects/p/notes.md');
  assert.equal(index.before, NOTES, 'the index write carries its real pre-image');
});

test('planShard rewrites relative links in a section title, not just the body', () => {
  const src = '# p\n\n## Regression from [2026-06-27](../../daily-memories/2026-06-27.md)\nbody sees [spec](specs/x.md).\n\n';
  const root = makeBrain({ 'projects/p/notes.md': src });
  const plan = planShard(root, 'p');
  const detail = plan.writes.find((w) => w.path === 'projects/p/notes/_details/regression-from-2026-06-27.md');
  assert.ok(detail, 'the slug still strips the link syntax');
  assert.ok(detail.after.startsWith('# Regression from [2026-06-27](../../../../daily-memories/2026-06-27.md)'),
    'a link in the title must be rebased exactly like one in the body');
  // The title link and the body link must resolve to the same files they did before the move.
  const before = resolveFrom(path.join(root, 'projects/p'), mdLinks(src));
  for (const t of resolveFrom(path.join(root, 'projects/p/notes/_details'), mdLinks(detail.after))) {
    assert.ok(before.has(t), `title/body link resolves somewhere new: ${t}`);
  }
  const index = plan.writes.find((w) => w.path === 'projects/p/notes.md');
  assert.ok(index.after.includes('## Regression from [2026-06-27](../../daily-memories/2026-06-27.md)'),
    'notes.md does not move, so its own title links stay as they were');
});

test('splitSections ignores a "## " line inside a fenced code block', () => {
  const src = '# p\n\n## Real section\nMARK-before\n```markdown\n## Not a heading\nMARK-inside\n```\nMARK-after\n\n';
  const { header, sections } = splitSections(src);
  assert.equal(sections.length, 1, 'a fenced "## " line must not open a section');
  assert.equal(sections[0].title, 'Real section');
  assert.equal(header + sections.map((s) => s.raw).join(''), src, 'split must stay lossless');

  const root = makeBrain({ 'projects/p/notes.md': src });
  const plan = planShard(root, 'p');
  assert.equal(plan.summary.entries, 1, 'one section must not become two entries');
  assert.ok(!plan.writes.some((w) => w.path.includes('not-a-heading')), 'no detail file may be minted from a fenced line');
  const detail = plan.writes.find((w) => w.path === 'projects/p/notes/_details/real-section.md');
  for (const mark of ['MARK-before', 'MARK-inside', 'MARK-after']) {
    assert.ok(detail.after.includes(mark), `${mark} must stay in its section`);
  }
  assert.equal((detail.after.match(/```/g) || []).length, 2, 'the fence must survive balanced');
});

test('CLI exits 1 (not a crash) when shard-notes is re-run on a sharded project', () => {
  const root = makeBrain({ 'projects/p/notes.md': NOTES });
  execFileSync(process.execPath, [CLI, 'shard-notes', 'p', '--apply'], { cwd: root, encoding: 'utf8' });
  const after = snapshot(root);
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'shard-notes', 'p', '--apply'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { status = e.status; stderr = e.stderr; }
  assert.equal(status, 1);
  assert.match(stderr, /already sharded/);
  assert.deepEqual(snapshot(root), after, 'the refused re-shard must leave every file untouched');
});

test('slugifyTitle caps slug length so Windows MAX_PATH cannot be blown', () => {
  // Real title from projects/mavis-terminal/notes.md that produced a 247-char
  // absolute path (MAX_PATH is 260, and applyPlan writes <path>.tmp first).
  const monster = '2-col "vertical ladder" pane (fitPane clamped to MINIMUM_COLS on a tiny host) + fixed: the right-edge cutoff was the floating Ask-Mavis panel, not a fit bug (2026-06-29)';
  const slug = slugifyTitle(monster);
  assert.ok(slug.length <= 60, `slug is ${slug.length} chars, expected <= 60`);
  assert.ok(!slug.endsWith('-'), 'slug must not end on a dash after truncation');
  assert.ok(slug.startsWith('2-col-vertical-ladder'), 'slug keeps the meaningful head');
});

test('planShard dedupes slugs that collide only after truncation', () => {
  const long = (tail) => `## The quick brown fox jumps over the lazy dog and keeps running ${tail}\nbody ${tail}\n`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  fs.mkdirSync(path.join(root, 'projects/p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects/p/notes.md'), '# p\n\n' + long('alpha') + long('beta'));
  const plan = planShard(root, 'p');
  const details = plan.writes.filter(w => w.path.includes('_details/')).map(w => w.path);
  assert.equal(details.length, 2);
  assert.equal(new Set(details).size, 2, 'truncated slugs must not collide: ' + details.join(' | '));
});
