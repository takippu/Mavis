// Tests for scripts/lib/init-brain-core.mjs.
//
// The load-bearing test is "seeding preserves the _details/ subdirectory": that is the exact
// regression the PowerShell one-liner in SETUP.md shipped, and it exited 0 while doing it, so
// nothing caught it until a fresh clone was run by hand. Everything else here guards the
// idempotence promise -- re-running must never clobber learned entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planInit, applyInit, verifyDetailLinks, CATEGORIES } from '../lib/init-brain-core.mjs';

// Build a throwaway brain root carrying a seeds/ tree shaped like the real one: rules ships an
// _index.md plus two _details/ files, preferences and topics ship a header-only _index.md.
function makeBrain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-init-'));
  const w = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w(
    'seeds/rules/_index.md',
    '# Rules\n\n## entry-lifecycle\n\n**Detail:** [_details/entry-lifecycle.md](_details/entry-lifecycle.md)\n\n' +
      '## reference-resolution\n\n**Detail:** [_details/reference-resolution.md](_details/reference-resolution.md)\n'
  );
  w('seeds/rules/_details/entry-lifecycle.md', '# entry-lifecycle\n');
  w('seeds/rules/_details/reference-resolution.md', '# reference-resolution\n');
  w('seeds/preferences/_index.md', '# Preferences\n\n---\n');
  w('seeds/topics/_index.md', '# Topics\n\n---\n');
  return root;
}

const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

test('planInit marks every category for seeding on a fresh clone', () => {
  const root = makeBrain();
  try {
    const plan = planInit(root);
    assert.equal(plan.seedsPresent, true);
    assert.deepEqual(
      plan.categories.map((c) => c.status),
      ['seed', 'seed', 'seed']
    );
    assert.deepEqual(plan.problems, []);
  } finally {
    rm(root);
  }
});

test('seeding PRESERVES the _details/ subdirectory (regression: PowerShell Copy-Item flattened it)', () => {
  const root = makeBrain();
  try {
    applyInit(root, planInit(root));
    // The bug put these at rules/entry-lifecycle.md. Assert the nested path exists AND that the
    // flattened path does not, so a future "fix" that writes both still fails.
    assert.ok(fs.existsSync(path.join(root, 'rules', '_details', 'entry-lifecycle.md')));
    assert.ok(fs.existsSync(path.join(root, 'rules', '_details', 'reference-resolution.md')));
    assert.ok(!fs.existsSync(path.join(root, 'rules', 'entry-lifecycle.md')));
    assert.ok(!fs.existsSync(path.join(root, 'rules', 'reference-resolution.md')));
  } finally {
    rm(root);
  }
});

test('verifyDetailLinks passes on a correctly seeded tree', () => {
  const root = makeBrain();
  try {
    applyInit(root, planInit(root));
    const links = verifyDetailLinks(root);
    assert.equal(links.length, 2);
    assert.ok(links.every((l) => l.ok));
  } finally {
    rm(root);
  }
});

test('verifyDetailLinks CATCHES a flattened _details/ -- the silent corruption', () => {
  const root = makeBrain();
  try {
    // Reproduce what Copy-Item -Recurse seeds/rules/* rules/ actually produced.
    fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
    fs.copyFileSync(path.join(root, 'seeds/rules/_index.md'), path.join(root, 'rules/_index.md'));
    fs.copyFileSync(
      path.join(root, 'seeds/rules/_details/entry-lifecycle.md'),
      path.join(root, 'rules/entry-lifecycle.md')
    );
    fs.copyFileSync(
      path.join(root, 'seeds/rules/_details/reference-resolution.md'),
      path.join(root, 'rules/reference-resolution.md')
    );

    const broken = verifyDetailLinks(root).filter((l) => !l.ok);
    assert.equal(broken.length, 2, 'both Detail links must be reported broken');
    assert.deepEqual(
      broken.map((b) => b.link).sort(),
      ['_details/entry-lifecycle.md', '_details/reference-resolution.md']
    );
  } finally {
    rm(root);
  }
});

test('an already-installed category is left alone, never re-seeded over', () => {
  const root = makeBrain();
  try {
    // Simulate a brain that has learned a real entry.
    fs.mkdirSync(path.join(root, 'rules', '_details'), { recursive: true });
    fs.writeFileSync(path.join(root, 'rules', '_index.md'), '# Rules\n\n## learned-thing\n');
    fs.writeFileSync(path.join(root, 'rules', '_details', 'learned-thing.md'), 'user knowledge\n');

    const plan = planInit(root);
    const rules = plan.categories.find((c) => c.name === 'rules');
    assert.equal(rules.status, 'present');
    assert.equal(rules.files.length, 0);

    applyInit(root, plan);
    assert.equal(fs.readFileSync(path.join(root, 'rules', '_index.md'), 'utf8'), '# Rules\n\n## learned-thing\n');
    assert.equal(fs.readFileSync(path.join(root, 'rules', '_details', 'learned-thing.md'), 'utf8'), 'user knowledge\n');
  } finally {
    rm(root);
  }
});

test('running twice is a no-op the second time', () => {
  const root = makeBrain();
  try {
    const first = applyInit(root, planInit(root));
    assert.ok(first.created.length > 0);

    const secondPlan = planInit(root);
    assert.ok(secondPlan.categories.every((c) => c.status === 'present'));
    const second = applyInit(root, secondPlan);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.mkdirs, []);
  } finally {
    rm(root);
  }
});

test('preferences and topics get an empty _details/ even though their seed ships none', () => {
  const root = makeBrain();
  try {
    applyInit(root, planInit(root));
    for (const cat of ['preferences', 'topics']) {
      const d = path.join(root, cat, '_details');
      assert.ok(fs.existsSync(d), `${cat}/_details/ should exist`);
      assert.deepEqual(fs.readdirSync(d), [], `${cat}/_details/ should be empty`);
    }
  } finally {
    rm(root);
  }
});

test('a missing seeds/ is reported, not silently treated as nothing to do', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-init-noseed-'));
  try {
    const plan = planInit(root);
    assert.equal(plan.seedsPresent, false);
    assert.equal(plan.categories.length, CATEGORIES.length);
    assert.ok(plan.categories.every((c) => c.status === 'noseed'));
    assert.equal(plan.problems.length, CATEGORIES.length);
  } finally {
    rm(root);
  }
});

test('an unexpected pre-existing file under an absent _index.md is preserved and reported', () => {
  const root = makeBrain();
  try {
    // No rules/_index.md, but a stray _details file is already there.
    fs.mkdirSync(path.join(root, 'rules', '_details'), { recursive: true });
    fs.writeFileSync(path.join(root, 'rules', '_details', 'entry-lifecycle.md'), 'DO NOT CLOBBER\n');

    const plan = planInit(root);
    applyInit(root, plan);

    assert.equal(
      fs.readFileSync(path.join(root, 'rules', '_details', 'entry-lifecycle.md'), 'utf8'),
      'DO NOT CLOBBER\n'
    );
    assert.ok(plan.problems.some((p) => p.includes('already exists, left untouched')));
    // The rest of the seed still lands.
    assert.ok(fs.existsSync(path.join(root, 'rules', '_details', 'reference-resolution.md')));
  } finally {
    rm(root);
  }
});
