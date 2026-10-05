import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBootContext, comparablePath, dailyHeadings, newestCheckpoint, parseProjectRouter } from '../lib/boot-context-core.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-boot-'));
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('identity/profile.md', 'name: FixtureUser\n');
  write('identity/personality.md', 'clear and curious\n');
  write('identity/communication.md', 'brief\n');
  write('rules/_index.md', '# Rules\n');
  write('projects/_index.md', '# Projects\n- [alpha](alpha/index.md) — app, active — Alpha.\n- [beta](beta/index.md) — app, active — Beta.\n');
  write('projects/alpha/index.md', '---\nname: Alpha\npath: C:\\Users\\FixtureUser\\Alpha\n---\n## Now\nAlpha now.\n');
  write('projects/alpha/notes.md', 'Alpha notes.\n');
  write('projects/alpha/progress.md', '## New\n- New work\n\n## Old\n- Old work\n');
  write('projects/beta/index.md', '---\nname: Beta\npath: C:\\Users\\FixtureUser\\Beta\n---\n## Now\nBeta now.\n');
  write('projects/beta/notes.md', 'Beta notes.\n');
  write('daily-memories/2026-09-26.md', '# Day\n## alpha — did work\n## beta — did work\n');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('router parses only safe one-line project entries', () => {
  assert.deepEqual(parseProjectRouter('- [alpha](alpha/index.md) — app, active — Alpha.\n- [../bad](../bad/index.md) — bad\n').map((r) => r.slug), ['alpha']);
});

test('path comparison handles Windows slash and case forms', () => {
  assert.equal(comparablePath('C:\\Users\\FixtureUser\\Alpha\\'), comparablePath('c:/users/fixtureuser/alpha'));
});

test('checkpoint and daily headings are bounded', () => {
  assert.equal(newestCheckpoint('preamble\n## New\n- one\n## Old\n- two'), '## New\n- one');
  assert.deepEqual(dailyHeadings('# day\n## alpha — one\nbody\n## beta — two'), ['## alpha — one', '## beta — two']);
});

test('setup detection stops before all normal memory reads', () => {
  const { root, cleanup } = fixture();
  try {
    fs.rmSync(path.join(root, 'identity', 'profile.md'));
    assert.deepEqual(buildBootContext({ root, today: '2026-09-26' }).status, 'setup_required');
  } finally { cleanup(); }
});

test('explicit project wins and returns only its project files', () => {
  const { root, cleanup } = fixture();
  try {
    const result = buildBootContext({ root, cwd: 'C:/Users/FixtureUser/Beta', explicitProject: 'Alpha', today: '2026-09-26' });
    assert.equal(result.selection, 'explicit');
    assert.equal(result.project.slug, 'alpha');
    assert.equal(result.project.newestProgress, '## New\n- New work');
    assert.deepEqual(result.todayHeadings, []);
    assert.ok(!JSON.stringify(result.project).includes('Beta notes'));
  } finally { cleanup(); }
});

test('unknown explicit project never silently uses cwd project', () => {
  const { root, cleanup } = fixture();
  try {
    const result = buildBootContext({ root, cwd: 'C:/Users/FixtureUser/Beta', explicitProject: 'missing', today: '2026-09-26' });
    assert.equal(result.status, 'unknown_project');
    assert.equal(result.project, null);
  } finally { cleanup(); }
});

test('cwd detection works without an explicit project', () => {
  const { root, cleanup } = fixture();
  try {
    const result = buildBootContext({ root, cwd: 'c:/users/fixtureuser/beta', today: '2026-09-26' });
    assert.equal(result.selection, 'cwd');
    assert.equal(result.project.slug, 'beta');
    assert.deepEqual(result.todayHeadings, []);
  } finally { cleanup(); }
});

test('generic boot returns only the last three daily headings', () => {
  const { root, cleanup } = fixture();
  try {
    fs.writeFileSync(path.join(root, 'daily-memories', '2026-09-26.md'), '# Day\n## one — a\n## two — b\n## three — c\n## four — d\n');
    const result = buildBootContext({ root, cwd: 'C:/Users/FixtureUser/Other', today: '2026-09-26' });
    assert.deepEqual(result.todayHeadings, ['## two — b', '## three — c', '## four — d']);
  } finally { cleanup(); }
});
