import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesPhrase, parseCategoryIndex, parseSkillTable, recallExact } from '../lib/recall-core.mjs';

const INDEX = '# Index\n## payment-gateway\n**Triggers:** stripe, payment gateway, "payment, pay"\n**Summary:** Built PayEx.\n**Detail:** [_details/payment-gateway.md](_details/payment-gateway.md)\n\n## auth\n**Triggers:** auth, oauth\n**Summary:** Authentication.\n**Detail:** [_details/auth.md](_details/auth.md)\n';

test('index parser keeps active entries, summaries, and quoted commas', () => {
  const entries = parseCategoryIndex(INDEX, 'topics');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].triggers, ['stripe', 'payment gateway', 'payment, pay']);
  assert.equal(entries[0].relativePath, 'topics/_details/payment-gateway.md');
});

test('phrase match is case insensitive and respects word boundaries', () => {
  assert.equal(matchesPhrase('We need STRIPE checkout', 'stripe'), true);
  assert.equal(matchesPhrase('stripes on a shirt', 'stripe'), false);
  assert.equal(matchesPhrase('payment gateway', 'payment gateway'), true);
});

test('skill parser returns candidates without reading the skill body', () => {
  const rows = parseSkillTable('| `skills/daily-standup/SKILL.md` | "daily", "daily ops", or "standup". |\n');
  assert.deepEqual(rows.map((row) => row.slug), ['daily-standup']);
  assert.deepEqual(rows[0].triggers, ['daily', 'daily ops', 'standup']);
});

test('exact recall returns canonical detail and related path, but only a skill candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-recall-'));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  try {
    write('topics/_index.md', INDEX);
    write('preferences/_index.md', '# Preferences\n');
    write('topics/_details/payment-gateway.md', '---\nlinks: [auth]\n---\n# PayEx context\n');
    write('topics/_details/auth.md', '---\nlinks: []\n---\n# Auth context\n');
    write('AGENTS.md', '| `skills/daily-standup/SKILL.md` | "daily", "standup". |\n');
    write('projects/_index.md', '- [shop](shop/index.md) — app, active — Shop.\n');
    const payment = recallExact({ root, query: 'Could we use Stripe as a payment gateway?', limit: 2 });
    assert.equal(payment.results[0].slug, 'payment-gateway');
    assert.ok(payment.results[0].detail.includes('PayEx context'));
    assert.equal(payment.results[0].related[0].path, 'topics/_details/auth.md');
    const weak = recallExact({ root, query: 'Could we use Stripe?', limit: 2 });
    assert.equal(weak.results[0].slug, 'payment-gateway');
    assert.equal(weak.results[0].detailDeferred, true);
    assert.ok(weak.fallback.includes('weak trigger'));
    const skill = recallExact({ root, query: 'daily standup' });
    assert.equal(skill.results[0].kind, 'skill');
    assert.equal(skill.results[0].detail, null);
    assert.equal(skill.results[0].requiresSkillRead, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
