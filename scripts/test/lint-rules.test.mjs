// Tests for the Refs-rule (no refs into rotating files) and the projects/_index.md line rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRefRules, checkProjectsIndex, lint } from '../lib/brain-lint-core.mjs';

function makeBrain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  for (const [r, c] of Object.entries(files)) {
    const p = path.join(root, r);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
  return root;
}

test('checkRefRules flags concrete progress.md path refs in topics/preferences details only', () => {
  const root = makeBrain({
    'topics/_details/t.md': '- `projects/acme-portal/progress.md` (2026-05-26 checkpoint)\n',
    'preferences/_details/p.md': 'see projects/bluebird/progress-archive/2026.md\n',
    'rules/_details/r.md': 'the paired write goes to progress.md\n', // meta-description: allowed
    'topics/_details/ok.md': '- `projects/acme-portal/notes.md` (fine)\n',
  });
  const flags = checkRefRules(root);
  assert.equal(flags.length, 2);
  assert.ok(flags.every(f => f.severity === 'fail' && f.type === 'ref-rule'));
});

test('checkRefRules flags concrete standups refs but not prose about standups (spec 3.1.3)', () => {
  const root = makeBrain({
    'topics/_details/concrete.md': 'see [standup](../../standups/2026-05-26.md)\n',
    'topics/_details/prose.md': 'the daily-standup skill writes `standups/<date>.md` entries\n',
    'topics/_details/word.md': 'we discussed standups at length; see notes.md\n',
  });
  const flags = checkRefRules(root);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].file, 'topics/_details/concrete.md');
});

test('checkRefRules allows durable refs and reports file + line', () => {
  const root = makeBrain({
    'topics/_details/durable.md': [
      'ok: `daily-memories/2026-05-26.md` (acme-portal section)',
      'ok: `projects/acme-portal/notes.md`',
      'ok: `projects/acme-portal/index.md`',
      'bad: `projects/acme-portal/progress.md`',
    ].join('\n') + '\n',
  });
  const flags = checkRefRules(root);
  assert.equal(flags.length, 1);
  assert.ok(flags[0].detail.startsWith('line 4:'), `expected line 4, got: ${flags[0].detail}`);
  assert.equal(flags[0].suggestedAction, 'repoint to the daily memory for that date');
});

test('checkRefRules handles CRLF and an empty details tree', () => {
  const root = makeBrain({
    'topics/_details/crlf.md': 'intro\r\n- `projects/acme-portal/progress.md` (checkpoint)\r\n',
  });
  const flags = checkRefRules(root);
  assert.equal(flags.length, 1);
  assert.ok(flags[0].detail.startsWith('line 2:'));
  assert.ok(!flags[0].detail.includes('\r'), 'detail must not carry a raw CR');
  assert.deepEqual(checkRefRules(makeBrain({})), []);
});

// The router is IDENTITY-ONLY since the `Now:` split: slug, type, status, one clause on what the
// thing is. State lives in projects/<slug>/index.md under `## Now`. So a date in a project line is
// no longer "a second date creeping in" — ANY date is state that has come back to a file paid for
// on every turn.
test('checkProjectsIndex flags ANY date, bold, and overlong project lines', () => {
  const root = makeBrain({
    'projects/_index.md': [
      '# Projects', '## Active',
      '- [ok](ok/index.md) — tool, active — a perfectly fine identity line.',
      '- [dated](dated/index.md) — tool, active — state crept back in (2026-07-17).',
      '- [bold](bold/index.md) — tool, active — **MILESTONE** creep.',
    ].join('\n') + '\n',
  });
  const flags = checkProjectsIndex(root);
  assert.equal(flags.length, 2, 'the dateless, unbolded line is clean; the other two are not');
  assert.ok(flags.every(f => f.type === 'index-line' && f.severity === 'warn'));
  assert.ok(flags[0].detail.includes('2026-07-17'), 'the date flag names the offending date');
  assert.ok(flags[0].detail.includes('## Now'), 'and says where the state belongs');
});

test('checkProjectsIndex mirrors lint-index.mjs: DISTINCT dates, project lines only', () => {
  const root = makeBrain({
    'projects/_index.md': [
      '# Projects',
      '- [dup](dup/index.md) — tool, active — same date twice (2026-07-17) and (2026-07-17).',
      '- [bare](bare/index.md) — tool, active — bare 2026-07-01 plus (2026-07-02).',
      '- [notproj](../some/other.md) — not a project line (2026-07-01) (2026-07-02).',
      'prose line with (2026-07-01) and (2026-07-02) dates',
    ].join('\n') + '\n',
  });
  const flags = checkProjectsIndex(root);
  // Both project lines now flag — one distinct date is still a date. The non-project link and the
  // prose line are still skipped, which is the part of the old behaviour that must NOT change:
  // the check is scoped to project lines, not to every date in the file.
  assert.equal(flags.length, 2);
  assert.ok(flags[0].detail.startsWith('line 2:'), `expected line 2, got: ${flags[0].detail}`);
  assert.ok(flags[0].detail.includes('1 date(s)'));
  assert.ok(flags[1].detail.startsWith('line 3:'), `expected line 3, got: ${flags[1].detail}`);
  assert.ok(flags[1].detail.includes('2 date(s)'));
});

test('checkProjectsIndex flags >400 char lines and is CRLF-safe on length', () => {
  // Cap tightened from 600 to 400 with the split: measured across 44 real lines afterwards the
  // max was 341, so 400 has headroom and still catches a line growing a status report.
  const long = '- [big](big/index.md) — tool, active — ' + 'x'.repeat(420) + ' a long identity clause.';
  const root = makeBrain({ 'projects/_index.md': '# Projects\r\n' + long + '\r\n' });
  const flags = checkProjectsIndex(root);
  assert.equal(flags.length, 1);
  assert.ok(flags[0].detail.includes('chars'));
  // The CR must not be counted in the line length.
  assert.ok(flags[0].detail.includes(`${long.length} chars`),
    `length must exclude the CR; got: ${flags[0].detail}`);
});

test('checkProjectsIndex tolerates a missing projects/_index.md', () => {
  assert.deepEqual(checkProjectsIndex(makeBrain({})), []);
});

test('lint runs all four checks and aggregates severities', () => {
  const root = makeBrain({
    'projects/big/progress.md': '#'.repeat(100 * 1024),                 // size fail
    'topics/_details/t.md': '- `projects/big/progress.md` (checkpoint)\n', // ref-rule fail
    'rules/_details/r.md': '[gone](../../nope.md)\n',                   // dangling fail
    'projects/_index.md': '- [b](b/index.md) — **bold** (2026-07-17).\n', // index-line warn
    'projects/b/index.md': '# b\n', // real target, so the _index link is not also dangling
  });
  const r = lint(root);
  assert.equal(r.counts.fail, 3);
  assert.equal(r.counts.warn, 1);
  assert.deepEqual([...new Set(r.flags.map(f => f.type))].sort(),
    ['dangling-link', 'index-line', 'ref-rule', 'size']);
});
