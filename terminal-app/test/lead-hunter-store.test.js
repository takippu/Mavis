'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { HunterStore } = require('../src/lead-hunter-store');
const input = (extra = {}) => ({ goal: 'Find workshops', filters: { industry: 'Workshops', region: 'Selangor', city: 'Shah Alam', website: 'not_observed', ...extra } });
const candidate = id => ({ id, company: id, industry: 'Workshops', region: 'Selangor', city: 'Shah Alam', address: '', website: { state: 'not_observed', url: '' }, contact: { email: '', phone: '', form: '' }, sources: [{ url: 'https://business.example/' + id, label: 'Public directory', observedAt: '2026-10-13T01:00:00Z' }], identityKeys: ['business:' + id], duplicate: { kind: 'none', recordIds: [] }, discoveredAt: '2026-10-13T01:00:00Z' });
function fixture(t, options) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new HunterStore(dir, options); }
test('durable independent snapshots have immutable validated defaults and UUID guards', t => {
  const store = fixture(t), first = input(), job = store.enqueue(first); first.filters.region = 'Changed'; job.filters.region = 'Changed';
  store.enqueue(input({ region: 'Johor', limit: 1 })); const snapshot = new HunterStore(path.dirname(store.file)).snapshot();
  assert.equal(snapshot.jobs[0].filters.region, 'Selangor'); assert.equal(snapshot.jobs[0].filters.limit, 50); assert.equal(snapshot.jobs[1].filters.region, 'Johor'); assert.match(snapshot.jobs[0].revision, /^[0-9a-f-]{36}$/);
  const running = store.transition(snapshot.jobs[0].id, snapshot.jobs[0].revision, 'running', '', { attemptId: crypto.randomUUID() });
  assert.throws(() => store.transition(running.id, snapshot.jobs[0].revision, 'cancelled'), { code: 'HUNTER_CONFLICT' });
});
test('batch checkpoint and attempt fence survive reload, pause and cancel', t => {
  const store = fixture(t), job = store.enqueue(input()), attemptId = crypto.randomUUID();
  let running = store.transition(job.id, job.revision, 'running', '', { attemptId });
  running = store.commitBatch(job.id, attemptId, { candidates: [candidate('one')], seenKeys: ['business:one'], summary: 'Saved one' });
  assert.equal(running.completedBatches, 1); assert.ok(running.checkpointId); assert.equal(store.snapshot().candidates[0].jobId, job.id);
  assert.throws(() => store.commitBatch(job.id, crypto.randomUUID(), { candidates: [], seenKeys: [] }), { code: 'HUNTER_STALE' });
  store.transition(job.id, running.revision, 'paused', 'Paused');
  assert.throws(() => store.commitBatch(job.id, attemptId, { candidates: [candidate('late')], seenKeys: [] }), { code: 'HUNTER_STALE' });
  const reopened = new HunterStore(path.dirname(store.file)); assert.equal(reopened.snapshot().candidates.length, 1); reopened.markImported('one', 'lead-one'); assert.equal(store.snapshot().candidates[0].importedLeadId, 'lead-one');
});
test('invalid snapshots and storage bounds never overwrite durable data', t => {
  const store = fixture(t, { maxJobs: 1 }), job = store.enqueue(input()), bytes = fs.readFileSync(store.file);
  assert.throws(() => store.enqueue(input()), { code: 'HUNTER_FULL' });
  for (const filters of [{ region: '' }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { skipExisting: 'yes' }, { website: 'unknown' }, { region: 'x'.repeat(81) }]) assert.throws(() => store.enqueue(input(filters)));
  assert.deepEqual(fs.readFileSync(store.file), bytes);
  const limited = new HunterStore(path.dirname(store.file), { maxBytes: bytes.length + 40 });
  assert.throws(() => limited.transition(job.id, job.revision, 'paused', 'x'.repeat(900)), { code: 'HUNTER_FULL' }); assert.deepEqual(fs.readFileSync(store.file), bytes);
});
test('atomic backup retains previous state and corrupt reads preserve both copies', t => {
  const store = fixture(t); store.enqueue(input()); store.setPaused(true);
  assert.equal(JSON.parse(fs.readFileSync(store.file + '.bak')).paused, false);
  const backup = fs.readFileSync(store.file + '.bak'); fs.writeFileSync(store.file, '{broken');
  assert.throws(() => store.snapshot(), { code: 'HUNTER_CORRUPT' }); assert.throws(() => store.enqueue(input()), { code: 'HUNTER_CORRUPT' });
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken'); assert.deepEqual(fs.readFileSync(store.file + '.bak'), backup);
});
module.exports = { candidate, input };
test('each task keeps its selected model through reload and cannot change it during transitions', t => {
  const store = fixture(t), request = { ...input(), model: 'gpt-5.4' }, first = store.enqueue(request);
  request.model = 'gpt-5.5'; first.model = 'gpt-5.5'; store.enqueue(request);
  const saved = new HunterStore(path.dirname(store.file)).snapshot();
  assert.deepEqual(saved.jobs.map(j => j.model), ['gpt-5.4', 'gpt-5.5']);
  assert.throws(() => store.transition(saved.jobs[0].id, saved.jobs[0].revision, 'paused', '', { model: 'gpt-5.5' }));
  const bytes = fs.readFileSync(store.file);
  assert.throws(() => store.enqueue({ ...input(), model: '--sandbox' }), { code: 'HUNTER_INVALID' });
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});
test('legacy tasks keep the original GPT-5.5 model without rewriting data on read', t => {
  const store = fixture(t); store.enqueue(input()); const data = JSON.parse(fs.readFileSync(store.file)); data.version = 1; delete data.validationResults; delete data.jobs[0].kind; delete data.jobs[0].model;
  fs.writeFileSync(store.file, JSON.stringify(data)); const before = fs.readFileSync(store.file);
  assert.equal(store.snapshot().jobs[0].model, 'gpt-5.5'); assert.deepEqual(fs.readFileSync(store.file), before);
  data.jobs[0].model = 'bad-model'; fs.writeFileSync(store.file, JSON.stringify(data));
  assert.throws(() => store.snapshot(), { code: 'HUNTER_CORRUPT' });
});
