// Tests for brain-repair rotate. Fixtures live in os.tmpdir() only — this
// module mutates user data under --apply, so nothing here may touch the real brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rewriteRelativeLinks, splitCheckpoints, planRotation, applyPlan } from '../lib/brain-repair-core.mjs';

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

const block = (date, kb) =>
  `## ${date} → [daily memory](../../daily-memories/${date}.md)\n` +
  `- did stuff, see [spec](specs/x/proposal.md) and [notes](notes.md)\n` +
  `- filler ${'x'.repeat(kb * 1024)}\n\n`;

// Local link extractor — deliberately NOT imported from brain-lint-core so these
// tests stay independent of the linter tasks.
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

test('rewriteRelativeLinks prepends ../ to relative md links only', () => {
  const src = '[a](../../daily-memories/d.md) [b](specs/x.md) [c](https://a.com/x.md) [d](/abs/x.md) [[wiki]] [e](#anchor)';
  assert.equal(rewriteRelativeLinks(src),
    '[a](../../../daily-memories/d.md) [b](../specs/x.md) [c](https://a.com/x.md) [d](/abs/x.md) [[wiki]] [e](#anchor)');
});

test('rewriteRelativeLinks honours a levels argument (shard needs two)', () => {
  assert.equal(rewriteRelativeLinks('[a](../../daily-memories/d.md) [b](specs/x.md)', 2),
    '[a](../../../../daily-memories/d.md) [b](../../specs/x.md)');
  assert.equal(rewriteRelativeLinks('[a](x.md)', 0), '[a](x.md)');
});

test('rewriteRelativeLinks keeps anchors and non-md targets intact', () => {
  assert.equal(rewriteRelativeLinks('[a](notes.md#pay) ![i](img.png) [d](dir/)'),
    '[a](../notes.md#pay) ![i](img.png) [d](dir/)');
});

test('splitCheckpoints separates header and dated blocks', () => {
  const src = '# P — Progress\n\n' + block('2026-07-17', 1) + block('2026-06-01', 1);
  const { header, blocks } = splitCheckpoints(src);
  assert.ok(header.startsWith('# P'));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].date, '2026-07-17');
  assert.equal(blocks[1].year, '2026');
});

test('splitCheckpoints handles CRLF, no blocks, and undated blocks', () => {
  const crlf = '# P\r\n\r\n## 2026-07-17 → x\r\nbody\r\n\r\n## Backlog\r\nitems\r\n';
  const { header, blocks } = splitCheckpoints(crlf);
  assert.equal(header, '# P\r\n\r\n');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].date, '2026-07-17', 'CR must not corrupt the date capture');
  assert.equal(blocks[1].date, null);
  assert.equal(blocks[1].year, null);
  assert.equal(header + blocks.map((b) => b.raw).join(''), crlf, 'split must be lossless');

  const none = splitCheckpoints('# P\n\njust prose\n');
  assert.equal(none.blocks.length, 0);
  assert.equal(none.header, '# P\n\njust prose\n');
});

test('planRotation keeps newest-5 minimum and rotates the rest by year, rewriting links', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 8; i++) src += block(`2026-0${Math.min(7, 8 - i)}-1${i}`, 6); // 8 blocks x ~6KB
  src += block('2025-12-01', 6);
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const hot = plan.writes.find((w) => w.path === 'projects/p/progress.md');
  const arch26 = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2026.md');
  const arch25 = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2025.md');
  assert.ok(hot && arch26 && arch25);
  assert.ok(Buffer.byteLength(hot.after) <= 40 * 1024); // 5 x ~6KB + footer
  assert.equal((hot.after.match(/^## /gm) || []).length, 5); // exactly keepMin kept (6th tripped target)
  assert.ok(arch26.after.includes('../../../daily-memories/')); // links rewritten one level deeper
  assert.ok(hot.after.includes('progress-archive/')); // footer pointer present
});

test('rotation is lossless: every original checkpoint survives in hot or archive', () => {
  let src = '# P — Progress\n\n';
  const dates = [];
  for (let i = 0; i < 8; i++) { const d = `2026-0${Math.min(7, 8 - i)}-1${i}`; dates.push(d); src += block(d, 6); }
  dates.push('2025-12-01');
  src += block('2025-12-01', 6);
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const all = plan.writes.map((w) => w.after).join('\n');
  for (const d of dates) assert.ok(all.includes(`## ${d} `), `checkpoint ${d} vanished`);

  // Every original block body must be recoverable byte-for-byte somewhere.
  const originalBlocks = splitCheckpoints(src).blocks;
  const hot = plan.writes.find((w) => w.path === 'projects/p/progress.md').after;
  const archives = plan.writes.filter((w) => w.path.includes('progress-archive')).map((w) => w.after);
  for (const b of originalBlocks) {
    const filler = b.raw.match(/- filler (x+)/)[1];
    const found = hot.includes(filler) || archives.some((a) => a.includes(filler));
    assert.ok(found, `body of ${b.date} lost`);
  }
  assert.equal(originalBlocks.length,
    (hot.match(/^## /gm) || []).length + archives.reduce((n, a) => n + (a.match(/^## /gm) || []).length, 0),
    'block count must be conserved');
});

test('rotated links resolve to exactly the same files as before the move', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 9; i++) src += block(`2026-01-0${i + 1}`, 6);
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const before = resolveFrom(path.join(root, 'projects/p'), mdLinks(src));
  const arch = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2026.md');
  // Links inside the MOVED blocks must still point at the same files. The generated
  // head's own back-pointer to progress.md is a new link, not a moved one — exclude it.
  const movedContent = arch.after.slice(arch.after.search(/^## /m));
  const after = resolveFrom(path.join(root, 'projects/p/progress-archive'), mdLinks(movedContent));
  assert.ok(after.size > 0);
  for (const t of after) assert.ok(before.has(t), `archive link resolves to a new place: ${t}`);
  // and the archive's own back-pointer must reach the hot file
  assert.ok(fs.existsSync(path.join(root, 'projects/p/progress.md')));
  assert.ok(arch.after.includes('[progress.md](../progress.md)'));
});

test('rotation of a CRLF progress.md preserves content and dates', () => {
  const crlfBlock = (d) => `## ${d} → [daily memory](../../daily-memories/${d}.md)\r\n- ${'y'.repeat(6 * 1024)}\r\n\r\n`;
  let src = '# P — Progress\r\n\r\n';
  const dates = [];
  for (let i = 0; i < 9; i++) { const d = `2026-02-0${i + 1}`; dates.push(d); src += crlfBlock(d); }
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const all = plan.writes.map((w) => w.after).join('\n');
  for (const d of dates) assert.ok(all.includes(`## ${d} `), `CRLF checkpoint ${d} vanished`);
  const arch = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2026.md');
  assert.ok(arch, 'CRLF file must still rotate (year parsed despite CR)');
  assert.ok(arch.after.includes('../../../daily-memories/'), 'CRLF links must still be rewritten');
});

test('planRotation keeps undated blocks hot and never moves fewer than keepMin', () => {
  const src = '# P\n\n## Backlog\n- always hot\n\n' +
    Array.from({ length: 3 }, (_, i) => block(`2026-03-0${i + 1}`, 40)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const hot = plan.writes.find((w) => w.path === 'projects/p/progress.md');
  assert.equal(plan.summary.moved, 0, 'only 3 dated blocks — keepMin 5 protects them all');
  assert.ok(hot.after.includes('## Backlog'));
  assert.equal(plan.writes.length, 1);
});

test('planRotation merges into an existing archive without dropping its content', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 9; i++) src += block(`2026-05-0${i + 1}`, 6);
  const root = makeBrain({
    'projects/p/progress.md': src,
    'projects/p/progress-archive/2026.md':
      '# p — Progress Archive 2026\n\n*Rotated out of [progress.md](../progress.md) — newest first.*\n\n' +
      '## 2026-01-01 → [daily memory](../../../daily-memories/2026-01-01.md)\n- ancient history\n\n',
  });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const arch = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2026.md');
  assert.ok(arch.after.includes('ancient history'), 'pre-existing archive content must survive');
  assert.ok(arch.after.includes('## 2026-01-01'));
  assert.equal((arch.after.match(/^# p — Progress Archive/gm) || []).length, 1, 'header must not duplicate');
  assert.ok(arch.after.indexOf('## 2026-05-') < arch.after.indexOf('## 2026-01-01'), 'newer blocks on top');
  assert.equal(arch.before, fs.readFileSync(path.join(root, 'projects/p/progress-archive/2026.md'), 'utf8'));
});

test('re-rotating an already-rotated project is a no-op that keeps the footer', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 9; i++) src += block(`2026-06-0${i + 1}`, 6);
  const root = makeBrain({ 'projects/p/progress.md': src });
  applyPlan(root, planRotation(root, 'p', { targetKB: 32, keepMin: 5 }));
  const afterFirst = fs.readFileSync(path.join(root, 'projects/p/progress.md'), 'utf8');
  assert.ok(afterFirst.includes('progress-archive/'), 'footer written on first rotation');

  const plan2 = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  assert.equal(plan2.summary.moved, 0);
  const hot2 = plan2.writes.find((w) => w.path === 'projects/p/progress.md');
  assert.ok(hot2.after.includes('progress-archive/'), 'footer must not be dropped on a no-op rotation');
  assert.equal(hot2.after, afterFirst, 'second rotation must be byte-identical (idempotent)');
});

test('applyPlan writes atomically and backs up originals', () => {
  const src = '# P — Progress\n\n' + Array.from({ length: 9 }, (_, i) => block(`2026-01-0${i + 1}`, 6)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p');
  const { backupDir } = applyPlan(root, plan);
  assert.ok(fs.existsSync(path.join(root, 'projects/p/progress-archive/2026.md')));
  assert.ok(fs.existsSync(path.join(backupDir, 'projects/p/progress.md'))); // pre-apply copy
  const hotNow = fs.readFileSync(path.join(root, 'projects/p/progress.md'), 'utf8');
  assert.equal(hotNow, plan.writes.find((w) => w.path === 'projects/p/progress.md').after);
});

test('applyPlan backup holds the ORIGINAL bytes, proving it copies before writing', () => {
  const src = '# P — Progress\n\n' + Array.from({ length: 9 }, (_, i) => block(`2026-04-0${i + 1}`, 6)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p');
  const { backupDir } = applyPlan(root, plan);
  const backed = fs.readFileSync(path.join(backupDir, 'projects/p/progress.md'), 'utf8');
  assert.equal(backed, src, 'backup must be the pre-write content, not the rewritten file');
  assert.notEqual(fs.readFileSync(path.join(root, 'projects/p/progress.md'), 'utf8'), src);
  // Backup + live archive together must still hold every checkpoint: nothing is lost.
  const archive = fs.readFileSync(path.join(root, 'projects/p/progress-archive/2026.md'), 'utf8');
  const live = fs.readFileSync(path.join(root, 'projects/p/progress.md'), 'utf8');
  for (let i = 0; i < 9; i++) assert.ok((live + archive).includes(`## 2026-04-0${i + 1} `));
  // A file created fresh (no `before`) must NOT appear in the backup dir.
  assert.ok(!fs.existsSync(path.join(backupDir, 'projects/p/progress-archive/2026.md')));
  assert.ok(!fs.existsSync(path.join(root, 'projects/p/progress.md.tmp')), 'no temp file left behind');
});

test('applyPlan backs up every original before it writes any of them', () => {
  const root = makeBrain({ 'projects/p/a.md': 'A', 'projects/p/b.md': 'B' });
  const plan = {
    command: 'rotate', project: 'p', summary: {},
    writes: [
      { path: 'projects/p/a.md', before: 'A', after: 'A2' },
      { path: 'projects/p/b.md', before: 'B', after: 'B2' },
      { path: 'projects/p/a.md/impossible.md', before: null, after: 'x' }, // parent is a file -> throws
    ],
  };
  let threw = false;
  let backupDir;
  try { applyPlan(root, plan); } catch { threw = true; }
  assert.ok(threw, 'write phase must surface the error');
  backupDir = fs.readdirSync(path.join(root, '_backup'))[0];
  const bak = path.join(root, '_backup', backupDir);
  assert.equal(fs.readFileSync(path.join(bak, 'projects/p/a.md'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(bak, 'projects/p/b.md'), 'utf8'), 'B',
    'b.md must be backed up even though the run died before/at a later write');
});

test('CLI --dry-run writes absolutely nothing', () => {
  const src = '# P — Progress\n\n' + Array.from({ length: 9 }, (_, i) => block(`2026-01-0${i + 1}`, 6)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const before = snapshot(root);
  const out = execFileSync(process.execPath, [CLI, 'rotate', 'p', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const plan = JSON.parse(out);
  assert.equal(plan.command, 'rotate');
  assert.ok(plan.writes.length >= 2);
  assert.ok(plan.writes.every((w) => typeof w.after === 'string'));
  assert.deepEqual(snapshot(root), before, '--dry-run must not create, modify, or delete any file');
  assert.ok(!fs.existsSync(path.join(root, '_backup')), '--dry-run must not even make a backup dir');
});

test('CLI --dry-run human output is readable and CLI --apply writes + reports the backup', () => {
  const src = '# P — Progress\n\n' + Array.from({ length: 9 }, (_, i) => block(`2026-01-0${i + 1}`, 6)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const human = execFileSync(process.execPath, [CLI, 'rotate', 'p', '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.ok(human.includes('would write projects/p/progress.md'));
  assert.deepEqual(Object.keys(snapshot(root)), ['projects/p/progress.md']);

  const applied = JSON.parse(execFileSync(process.execPath, [CLI, 'rotate', 'p', '--apply', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(applied.applied, true);
  assert.ok(applied.backupDir.includes('/_backup/repair-'));
  assert.ok(!applied.backupDir.includes('\\'), 'backupDir must use forward slashes');
  assert.ok(fs.existsSync(path.join(root, 'projects/p/progress-archive/2026.md')));
});

test('rewriteRelativeLinks leaves links inside a code fence literal', () => {
  const src = 'real [a](x.md)\n```markdown\n## YYYY-MM-DD → [daily memory](../../daily-memories/YYYY-MM-DD.md)\n```\nreal [b](y.md)\n';
  const out = rewriteRelativeLinks(src, 1);
  assert.ok(out.includes('[daily memory](../../daily-memories/YYYY-MM-DD.md)'),
    'a fenced link is an illustrative template, not a link: it must never be rebased');
  assert.ok(out.includes('[a](../x.md)') && out.includes('[b](../y.md)'), 'real links outside the fence still rebase');
});

test('splitCheckpoints ignores a "## " line inside a fenced code block', () => {
  const src = '# P\n\n' +
    '## 2026-01-05 → x\n- shipped the format doc\n```markdown\n## <project> — <headline>\n**Project:** [x](../x.md)\n```\n- Files: docs\n\n' +
    '## 2026-01-04 → y\n- other\n\n';
  const { header, blocks } = splitCheckpoints(src);
  assert.equal(blocks.length, 2, 'a fenced "## " line must not open a checkpoint');
  assert.equal(blocks[0].date, '2026-01-05');
  assert.equal(blocks[1].date, '2026-01-04');
  assert.ok(blocks[0].raw.includes('## <project> — <headline>'), 'the fenced line stays inside its parent block');
  assert.equal(header + blocks.map((b) => b.raw).join(''), src, 'split must stay lossless');
});

test('planRotation never tears a code fence across the hot file and the archive', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 6; i++) src += block(`2026-02-0${i + 1}`, 6);
  src += '## 2026-01-05 → [daily memory](../../daily-memories/2026-01-05.md)\n' +
    '- shipped the format doc\n```markdown\n' +
    '## YYYY-MM-DD → [daily memory](../../daily-memories/YYYY-MM-DD.md)\n- Files: <touched>\n```\n' +
    `- filler ${'x'.repeat(6 * 1024)}\n\n`;
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const hot = plan.writes.find((w) => w.path === 'projects/p/progress.md').after;
  const arch = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2026.md').after;
  assert.ok(arch.includes('## 2026-01-05'), 'the dated checkpoint rotates out');
  assert.ok(!hot.includes('YYYY-MM-DD'), 'no fragment of the fenced block may be stranded in the hot file');
  assert.ok(arch.includes('- Files: <touched>'), 'the whole fenced body travels with its checkpoint');
  assert.equal((arch.match(/```/g) || []).length % 2, 0, 'fences stay balanced in the archive');
  assert.equal((hot.match(/```/g) || []).length % 2, 0, 'fences stay balanced in the hot file');
  assert.ok(arch.includes('](../../daily-memories/YYYY-MM-DD.md)'),
    'the fenced template link is literal and must not be rebased');
  assert.ok(arch.includes('](../../../daily-memories/2026-01-05.md)'), 'the real heading link is still rebased');
});

test('planRotation keeps hand-written prose in an existing archive header', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 9; i++) src += block(`2026-05-0${i + 1}`, 6);
  const root = makeBrain({
    'projects/p/progress.md': src,
    'projects/p/progress-archive/2026.md':
      '# p — Progress Archive 2026\n\n*Rotated out of [progress.md](../progress.md) — newest first.*\n\n' +
      'NOTE FROM ADA: Q3 numbers below are wrong, see audit.\n\n' +
      '## 2026-01-01 → [daily memory](../../../daily-memories/2026-01-01.md)\n- ancient work\n\n',
  });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const arch = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2026.md');
  assert.ok(arch.after.includes('NOTE FROM ADA'), 'hand-written header prose must survive re-rotation');
  assert.ok(arch.after.includes('ancient work'), 'archived checkpoints still survive');
  assert.equal((arch.after.match(/^# p — Progress Archive/gm) || []).length, 1, 'header must not duplicate');
});

test('planRotation keeps a hand-written archive that has no checkpoints at all', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 9; i++) src += block(`2026-05-0${i + 1}`, 6);
  const root = makeBrain({
    'projects/p/progress.md': src,
    'projects/p/progress-archive/2026.md': 'Free prose I wrote by hand, no headings at all.\n',
  });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const arch = plan.writes.find((w) => w.path === 'projects/p/progress-archive/2026.md');
  assert.ok(arch.after.includes('Free prose I wrote by hand'),
    'an archive with no "## " blocks must not be replaced wholesale');
});

test('a trailing blank line must not duplicate the footer', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 9; i++) src += block(`2026-06-0${i + 1}`, 6);
  const root = makeBrain({ 'projects/p/progress.md': src });
  const hotPath = path.join(root, 'projects/p/progress.md');
  applyPlan(root, planRotation(root, 'p', { targetKB: 32, keepMin: 5 }));
  assert.equal((fs.readFileSync(hotPath, 'utf8').match(/Older checkpoints/g) || []).length, 1);

  // An editor (or a hand paired-write) leaves one extra newline at EOF.
  fs.writeFileSync(hotPath, `${fs.readFileSync(hotPath, 'utf8')}\n`);
  applyPlan(root, planRotation(root, 'p', { targetKB: 32, keepMin: 5 }));
  assert.equal((fs.readFileSync(hotPath, 'utf8').match(/Older checkpoints/g) || []).length, 1,
    'the footer is script-owned and must appear exactly once, not stack up');
});

test('a stale footer never travels into the archive', () => {
  let src = '# P — Progress\n\n';
  for (let i = 0; i < 9; i++) src += block(`2026-06-0${i + 1}`, 6);
  const root = makeBrain({ 'projects/p/progress.md': src });
  const hotPath = path.join(root, 'projects/p/progress.md');
  applyPlan(root, planRotation(root, 'p', { targetKB: 32, keepMin: 5 }));
  fs.writeFileSync(hotPath, `${fs.readFileSync(hotPath, 'utf8')}\n`);
  applyPlan(root, planRotation(root, 'p', { targetKB: 32, keepMin: 5 }));

  // Age the (possibly polluted) blocks out with fresh checkpoints on top.
  let fresh = '# P — Progress\n\n';
  for (let i = 0; i < 6; i++) fresh += block(`2026-07-0${i + 1}`, 6);
  const hot = fs.readFileSync(hotPath, 'utf8');
  fs.writeFileSync(hotPath, fresh + hot.slice(hot.indexOf('## ')));
  applyPlan(root, planRotation(root, 'p', { targetKB: 32, keepMin: 5 }));
  const arch = fs.readFileSync(path.join(root, 'projects/p/progress-archive/2026.md'), 'utf8');
  assert.equal((arch.match(/Older checkpoints/g) || []).length, 0,
    'the hot-file footer must never be archived: from the archive it resolves nowhere');
});

test('keepMin counts checkpoints only, so undated blocks cannot evict the newest 5', () => {
  const src = '# P\n\n## Backlog\n- always hot\n\n' +
    Array.from({ length: 6 }, (_, i) => block(`2026-06-0${6 - i}`, 40)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const hot = plan.writes.find((w) => w.path === 'projects/p/progress.md').after;
  for (const d of ['2026-06-06', '2026-06-05', '2026-06-04', '2026-06-03', '2026-06-02']) {
    assert.ok(hot.includes(`## ${d} `), `the newest-5 guarantee is broken: ${d} was archived`);
  }
  assert.ok(hot.includes('## Backlog'), 'undated blocks always stay hot');
  assert.equal(plan.summary.kept, 5, 'summary.kept counts checkpoints, not undated blocks');
  assert.equal(plan.summary.keptUndated, 1);
});

test('keepMin survives more undated blocks than keepMin itself', () => {
  const undated = ['Backlog', 'Ideas', 'Risks', 'Owners', 'Links']
    .map((t) => `## ${t}\n- hot\n\n`).join('');
  const src = `# P\n\n${undated}` + Array.from({ length: 6 }, (_, i) => block(`2026-06-0${6 - i}`, 40)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const plan = planRotation(root, 'p', { targetKB: 32, keepMin: 5 });
  const hot = plan.writes.find((w) => w.path === 'projects/p/progress.md').after;
  assert.ok(hot.includes('## 2026-06-06 '), 'the newest checkpoint must never be archived');
  assert.equal(plan.summary.kept, 5, '5 undated blocks must not consume all 5 checkpoint slots');
});

test('applyPlan aborts when a target drifted from the approved plan', () => {
  const root = makeBrain({ 'projects/p/a.md': 'A' });
  const plan = { command: 'rotate', project: 'p', summary: {}, writes: [{ path: 'projects/p/a.md', before: 'A', after: 'A2' }] };
  fs.writeFileSync(path.join(root, 'projects/p/a.md'), 'A-changed-by-another-session');
  assert.throws(() => applyPlan(root, plan), /drifted|re-preview/i,
    'the approved bytes are gone: applying would clobber a write nobody previewed');
  assert.equal(fs.readFileSync(path.join(root, 'projects/p/a.md'), 'utf8'), 'A-changed-by-another-session',
    'a drifted plan must not write anything at all');
});

test('applyPlan aborts when a plan claims a new file that now exists', () => {
  const root = makeBrain({ 'projects/p/a.md': 'hand-written, predates the plan' });
  const plan = { command: 'shard-notes', project: 'p', summary: {}, writes: [{ path: 'projects/p/a.md', before: null, after: 'scaffold' }] };
  assert.throws(() => applyPlan(root, plan), /drifted|re-preview|exists/i);
  assert.equal(fs.readFileSync(path.join(root, 'projects/p/a.md'), 'utf8'), 'hand-written, predates the plan');
});

test('applyPlan backs up any file it is about to overwrite, even if the plan claims before:null', () => {
  const root = makeBrain({ 'projects/p/a.md': 'irreplaceable' });
  // A planner that lies about `before` must not be able to construct an unbacked destructive write.
  const plan = { command: 'rotate', project: 'p', summary: {}, writes: [{ path: 'projects/p/a.md', before: null, after: 'new' }] };
  const { backupDir } = applyPlan(root, plan, { verify: false });
  assert.equal(fs.readFileSync(path.join(backupDir, 'projects/p/a.md'), 'utf8'), 'irreplaceable',
    'the backup is decided from disk, not from what the plan claims');
});

test('CLI --apply --plan= executes the approved plan and refuses a drifted one', () => {
  const src = '# P — Progress\n\n' + Array.from({ length: 9 }, (_, i) => block(`2026-01-0${i + 1}`, 6)).join('');
  const root = makeBrain({ 'projects/p/progress.md': src });
  const planFile = path.join(root, 'plan.json');
  const previewed = execFileSync(process.execPath, [CLI, 'rotate', 'p', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(planFile, previewed);

  // Another session appends a checkpoint while the diff modal is open.
  fs.writeFileSync(path.join(root, 'projects/p/progress.md'), block('2026-02-99', 6) + src);
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'rotate', 'p', '--apply', `--plan=${planFile}`], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { status = e.status; stderr = e.stderr; }
  assert.equal(status, 1, 'a plan whose preconditions no longer hold must not be applied');
  assert.match(stderr, /re-preview/i, 'the caller is told to preview again');

  // Re-previewing against the current disk state applies cleanly.
  const fresh = execFileSync(process.execPath, [CLI, 'rotate', 'p', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(planFile, fresh);
  execFileSync(process.execPath, [CLI, 'rotate', 'p', '--apply', `--plan=${planFile}`], { cwd: root, encoding: 'utf8' });
  const hot = fs.readFileSync(path.join(root, 'projects/p/progress.md'), 'utf8');
  assert.equal(hot, JSON.parse(fresh).writes.find((w) => w.path === 'projects/p/progress.md').after,
    'the applied bytes must be exactly the previewed bytes');
});

test('CLI rejects bad usage without touching disk', () => {
  const root = makeBrain({ 'projects/p/progress.md': '# P\n' });
  const run = (args) => {
    try {
      execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (e) { return e.status; }
  };
  assert.equal(run(['rotate', 'p']), 2, 'neither --dry-run nor --apply');
  assert.equal(run(['bogus', 'p', '--dry-run']), 2, 'unknown command');
  assert.equal(run(['rotate', '../../etc', '--dry-run']), 2, 'path traversal in project name');
  assert.equal(run(['rotate', '--dry-run']), 2, 'missing project');
  assert.deepEqual(Object.keys(snapshot(root)), ['projects/p/progress.md']);
});
