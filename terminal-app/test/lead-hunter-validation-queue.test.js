'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { HunterStore, validationChecksRequired, CHECK_KEYS } = require('../src/lead-hunter-store');
const { HunterQueue } = require('../src/lead-hunter-queue');
const timestamp = '2026-10-13T01:00:00.000Z';
const discover = { goal: 'Discover', filters: { region: 'Selangor' } };
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function seed(store, count = 1) {
  const job = store.enqueue({ ...discover, filters: { ...discover.filters, limit: count } }), attemptId = crypto.randomUUID();
  let current = store.transition(job.id, job.revision, 'running', '', { attemptId });
  const candidates = Array.from({ length: count }, (_, i) => ({ id: 'candidate-' + i, company: 'Business ' + i, industry: 'Workshops', region: 'Selangor', city: 'Shah Alam', address: 'Street ' + i, website: { state: 'found', url: 'https://business.example/' + i }, contact: { email: '', phone: '', form: '' }, sources: [{ url: 'https://business.example/' + i, label: 'Business', observedAt: timestamp }], identityKeys: ['business:' + i], duplicate: { kind: 'none', recordIds: [] }, discoveredAt: timestamp }));
  for (let i = 0; i < count; i += 10) current = store.commitBatch(job.id, attemptId, { candidates: candidates.slice(i, i + 10), seenKeys: [] });
  store.transition(job.id, current.revision, 'completed'); return store.snapshot().candidates;
}
function request(candidates, criteria = {}) { return { goal: 'Validate', model: 'gpt-6.1-sol', candidateIds: candidates.map(c => c.id), criteria }; }
function output(call) {
  const required = validationChecksRequired(call.job.criteria);
  return { validationResults: call.targets.map(target => ({ id: crypto.randomUUID(), taskId: call.job.id, candidateId: target.candidateId, inputDigest: target.inputDigest, model: call.job.model, checkedAt: timestamp, overall: 'needs_review', checks: CHECK_KEYS.map(key => ({ key, required: required[key], status: key === 'duplicate' ? 'passed' : required[key] || key === 'contact' && call.job.criteria.contact === 'any' ? 'unknown' : 'not_requested', explanation: 'Evidence was inconclusive.', sourceUrls: [], observedAt: timestamp })), sources: [], duplicate: { kind: 'none', recordIds: [] } })), summary: 'Unknown remains Unknown' };
}
function fixture(t, { count = 1, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-validate-queue-')), store = new HunterStore(dir), candidates = seed(store, count), calls = []; let active = 0, peak = 0;
  const runner = { run(args) { active++; peak = Math.max(active, peak); return new Promise((resolve, reject) => calls.push({ ...args, resolve: result => { active--; resolve(result); }, reject: error => { active--; reject(error); } })); } };
  const queue = new HunterQueue({ store, runner, ...options }); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return { store, candidates, queue, calls, peak: () => peak };
}
test('mixed Discover/Validate uses one shared FIFO, retains Unknown and original candidates', async t => {
  const f = fixture(t), first = f.queue.submit(discover), second = f.queue.submitValidation(request(f.candidates)), third = f.queue.submit(discover); await f.queue.recover(); await tick();
  assert.equal(f.calls[0].job.id, first.id); assert.equal(f.calls[0].targets, undefined); f.calls[0].resolve({ candidates: [], exhausted: true }); await tick();
  assert.equal(f.calls[1].job.id, second.id); assert.equal(f.calls[1].targets[0].candidateId, f.candidates[0].id); f.calls[1].resolve(output(f.calls[1])); await tick();
  assert.equal(f.calls[2].job.id, third.id); f.calls[2].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.peak(), 1); assert.equal(f.store.snapshot().validationResults.length, 1); assert.equal(f.store.snapshot().validationResults[0].overall, 'needs_review'); assert.deepEqual(f.store.snapshot().candidates, f.candidates); await f.queue.shutdown();
});
test('100 targets checkpoint in bounded batches, independent of Discover no-new exhaustion', async t => {
  const f = fixture(t, { count: 100 }); f.queue.submitValidation(request(f.candidates)); await f.queue.recover(); await tick();
  for (let index = 0; index < 10; index++) { const call = f.calls[index]; assert.equal(call.targets.length, 10); assert.equal(call.targets[0].candidateId, 'candidate-' + index * 10); call.resolve(output(call)); await tick(); }
  const state = f.store.snapshot(), job = state.jobs.at(-1); assert.equal(job.status, 'completed'); assert.equal(job.completedBatches, 10); assert.equal(job.noNewBatches, 0); assert.equal(state.validationResults.length, 100); assert.equal(f.calls.length, 10); assert.equal(f.peak(), 1); await f.queue.shutdown();
});
test('budget completion retains checked outcomes and marks remaining targets unfinished', async t => {
  const f = fixture(t, { count: 11, policy: { maxBatches: 1 } }); f.queue.submitValidation(request(f.candidates)); await f.queue.recover(); await tick(); f.calls[0].resolve(output(f.calls[0])); await tick();
  const state = f.store.snapshot(), job = state.jobs.at(-1); assert.equal(job.status, 'completed'); assert.equal(job.validationResultIds.length, 10); assert.equal(state.validationResults.length, 10); assert.match(job.reason, /remaining targets are unfinished/); await f.queue.shutdown();
});
test('cancel waits for teardown, fences late validation success, then runs next stage', async t => {
  const f = fixture(t), validation = f.queue.submitValidation(request(f.candidates)), next = f.queue.submit(discover); await f.queue.recover(); await tick(); const cancel = f.queue.cancel(validation.id); await tick(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(output(f.calls[0])); await cancel; await tick(); assert.equal(f.store.snapshot().validationResults.length, 0); assert.equal(f.calls[1].job.id, next.id); f.calls[1].resolve({ candidates: [], exhausted: true }); await tick(); assert.equal(f.peak(), 1); await f.queue.shutdown();
});
test('current duplicate refresh excludes own Lead imported after immutable submission', async t => {
  const existing = { leads: [], clients: [] }, f = fixture(t, { getExisting: () => existing }); f.queue.submitValidation(request(f.candidates)); await f.queue.recover(); await tick();
  f.store.markImported(f.candidates[0].id, 'self-lead'); existing.leads.push({ ...f.candidates[0], id: 'self-lead' }); f.calls[0].resolve(output(f.calls[0])); await tick();
  let value = f.store.snapshot().validationResults[0]; assert.deepEqual(value.duplicate, { kind: 'none', recordIds: [] }); assert.equal(value.checks.find(c => c.key === 'duplicate').status, 'passed');
  f.queue.submitValidation(request(f.candidates)); await tick(); existing.clients.push({ ...f.candidates[0], id: 'other-client' }); f.calls[1].resolve(output(f.calls[1])); await tick();
  value = f.store.snapshot().validationResults.at(-1); assert.deepEqual(value.duplicate, { kind: 'confident', recordIds: ['other-client'] }); assert.equal(value.overall, 'failed'); assert.equal(f.store.snapshot().jobs.filter(j => j.kind === 'validate')[0].targetSnapshots[0].candidate.importedLeadId, undefined); await f.queue.shutdown();
});
test('missing/foreign/duplicate runner targets are execution failure, never business Failed', async t => {
  for (const malformed of ['missing', 'foreign', 'duplicate']) { const f = fixture(t, { count: 2 }); f.queue.submitValidation(request(f.candidates)); await f.queue.recover(); await tick(); const result = output(f.calls[0]); if (malformed === 'missing') result.validationResults.pop(); if (malformed === 'foreign') result.validationResults[0].candidateId = 'foreign'; if (malformed === 'duplicate') result.validationResults[1] = result.validationResults[0]; f.calls[0].resolve(result); await tick(); assert.equal(f.store.snapshot().jobs.at(-1).status, 'failed'); assert.equal(f.store.snapshot().jobs.at(-1).errorCode, 'OUTPUT'); assert.equal(f.store.snapshot().validationResults.length, 0); await f.queue.shutdown(); }
});
test('restart fences Validate attempts without changing target snapshots or model', async t => {
  const f = fixture(t), job = f.store.enqueueValidation(request(f.candidates)); f.store.transition(job.id, job.revision, 'running', '', { attemptId: crypto.randomUUID() }); await f.queue.recover(); await tick(); assert.equal(f.calls.length, 0); assert.equal(f.store.snapshot().paused, true);
  await f.queue.resume(); await tick(); assert.equal(f.calls[0].job.model, 'gpt-6.1-sol'); assert.deepEqual(f.calls[0].targets, job.targetSnapshots); f.calls[0].resolve(output(f.calls[0])); await tick(); assert.equal(f.store.snapshot().jobs.at(-1).status, 'completed'); await f.queue.shutdown();
});
