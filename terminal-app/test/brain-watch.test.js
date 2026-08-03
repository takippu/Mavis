'use strict';

// Regression coverage for the Mavis-config cache-invalidation path: the config view
// reads identity/*.md + CLAUDE.md through a memoized getMavisConfig, so the watcher
// MUST fire (→ invalidate() → brain-changed) when those files change. This was a HIGH
// miss — identity/ and CLAUDE.md were unwatched, so Edit-and-save served stale content.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startBrainWatch } = require('../src/brain-watch');

function tmpBrain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-watch-'));
  fs.mkdirSync(path.join(dir, 'identity'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'daily-memories'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'topics', '_details'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'identity', 'preferences.md'), '# prefs\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# contract\n');
  fs.writeFileSync(path.join(dir, 'topics', '_index.md'), '# Topics\n');
  fs.writeFileSync(path.join(dir, 'topics', '_details', 'payment-gateway.md'), '# payment-gateway\n');
  return dir;
}

// Poll the captured events for one matching pred, up to ms; resolves the event or null.
function waitFor(events, pred, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('brain-watch fires an identity-scoped change for identity/* edits (Mavis config input)', async () => {
  const dir = tmpBrain();
  const events = [];
  const w = startBrainWatch(dir, (p) => events.push(p), 30);
  try {
    await settle(90); // let the watchers attach
    fs.writeFileSync(path.join(dir, 'identity', 'preferences.md'), '# prefs edited\n');
    const hit = await waitFor(events, (e) => e && e.scope === 'identity', 3000);
    assert.ok(hit, 'expected an identity-scoped change event after editing identity/preferences.md');
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('brain-watch fires a rules-scoped change for CLAUDE.md edits (rules contract)', async () => {
  const dir = tmpBrain();
  const events = [];
  const w = startBrainWatch(dir, (p) => events.push(p), 30);
  try {
    await settle(90);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# contract edited\n');
    const hit = await waitFor(events, (e) => e && e.scope === 'rules', 3000);
    assert.ok(hit, 'expected a rules-scoped change event after editing CLAUDE.md');
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('brain-watch fires a topic-scoped change for topics/_details/*.md edits (two-tier topics)', async () => {
  const dir = tmpBrain();
  const events = [];
  const w = startBrainWatch(dir, (p) => events.push(p), 30);
  try {
    await settle(90);
    fs.writeFileSync(path.join(dir, 'topics', '_details', 'payment-gateway.md'), '# payment-gateway\n\n## Did\nedited\n');
    const hit = await waitFor(events, (e) => e && e.scope === 'topic', 3000);
    assert.ok(hit, 'expected a topic-scoped change event after editing topics/_details/payment-gateway.md');
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
