'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { HunterStore, candidateDigest, validationChecksRequired, CHECK_KEYS } = require('../src/lead-hunter-store');
const timestamp = '2026-10-13T01:00:00.000Z';
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-validate-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new HunterStore(dir, { now: () => timestamp }); }
function seed(store, count = 1) {
  const job = store.enqueue({ goal: 'Discover businesses', filters: { region: 'Selangor', limit: Math.max(count, 1) } }), attempt = crypto.randomUUID();
  let current = store.transition(job.id, job.revision, 'running', '', { attemptId: attempt });
  const candidates = Array.from({ length: count }, (_, index) => ({ id: 'candidate-' + index, company: 'Business ' + index, industry: 'Workshops', region: 'Selangor', city: 'Shah Alam', address: 'Street ' + index, website: { state: 'found', url: 'https://business.example/' + index }, contact: { email: '', phone: '', form: '' }, sources: [{ url: 'https://business.example/' + index, label: 'Business', observedAt: timestamp }], identityKeys: ['business:' + index], duplicate: { kind: 'none', recordIds: [] }, discoveredAt: timestamp }));
  for (let i = 0; i < count; i += 10) current = store.commitBatch(job.id, attempt, { candidates: candidates.slice(i, i + 10), seenKeys: [] });
  store.transition(job.id, current.revision, 'completed'); return store.snapshot().candidates;
}
function request(ids, criteria = {}) { return { goal: 'Validate selected businesses', provider: 'codex', model: 'gpt-6.1-sol', candidateIds: ids, criteria }; }
function result(job, target, overrides = {}) {
  const required = validationChecksRequired(job.criteria);
  const checks = CHECK_KEYS.map(key => ({ key, required: required[key], status: key === 'duplicate' ? 'passed' : required[key] || key === 'contact' && job.criteria.contact === 'any' ? 'unknown' : 'not_requested', explanation: 'Evidence remains inconclusive.', sourceUrls: [], observedAt: timestamp }));
  return { id: crypto.randomUUID(), taskId: job.id, candidateId: target.candidateId, inputDigest: target.inputDigest, model: job.model, checkedAt: timestamp, overall: 'needs_review', checks, sources: [], duplicate: { kind: 'none', recordIds: [] }, ...overrides };
}
test('committed legacy v1 format migrates only in memory and preserves original backup on next write', t => {
  const store = fixture(t), legacy = {
    version: 1, paused: false,
    jobs: [{ goal: 'Discover businesses', provider: 'codex', filters: { industry: '', region: 'Selangor', city: '', website: 'any', contact: 'any', sources: 'public_web', limit: 50, skipExisting: true }, id: '11111111-1111-4111-8111-111111111111', revision: '22222222-2222-4222-8222-222222222222', status: 'completed', reason: 'Saved', attemptId: null, checkpointId: '33333333-3333-4333-8333-333333333333', seenKeys: ['business:legacy'], candidateIds: ['legacy-candidate'], completedBatches: 1, noNewBatches: 0, retries: 0, deadlineAt: 1000, nextRetryAt: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp }],
    candidates: [{ id: 'legacy-candidate', jobId: '11111111-1111-4111-8111-111111111111', company: 'Legacy Business', industry: 'Workshops', region: 'Selangor', city: 'Shah Alam', address: '', website: { state: 'found', url: 'https://business.example/legacy' }, contact: { email: '', phone: '', form: '' }, sources: [{ url: 'https://business.example/legacy', label: 'Business', observedAt: timestamp }], identityKeys: ['business:legacy'], duplicate: { kind: 'none', recordIds: [] }, discoveredAt: timestamp, importedLeadId: 'legacy-lead' }]
  }, candidates = structuredClone(legacy.candidates);
  fs.writeFileSync(store.file, JSON.stringify(legacy)); const bytes = fs.readFileSync(store.file), ids = legacy.jobs.map(j => j.id);
  const read = store.snapshot(); assert.equal(read.version, 3); assert.equal(read.jobs[0].kind, 'discover'); assert.equal(read.jobs[0].model, 'gpt-5.5'); assert.deepEqual(read.jobs.map(j => j.id), ids); assert.deepEqual(read.candidates, candidates); assert.deepEqual(fs.readFileSync(store.file), bytes);
  store.enqueueValidation(request([candidates[0].id])); assert.deepEqual(fs.readFileSync(store.file + '.bak'), bytes); assert.equal(JSON.parse(fs.readFileSync(store.file)).version, 3);
});
test('validation resolves backend candidates and snapshots original facts and model immutably', t => {
  const store = fixture(t), candidates = seed(store), input = request([candidates[0].id], { contact: 'email' }), job = store.enqueueValidation(input);
  input.candidateIds[0] = 'changed'; input.criteria.contact = 'phone'; job.targetSnapshots[0].candidate.company = 'changed'; job.model = 'gpt-5.5'; store.markImported(candidates[0].id, 'lead-self');
  const saved = store.snapshot().jobs.at(-1); assert.equal(saved.model, 'gpt-6.1-sol'); assert.equal(saved.criteria.contact, 'email'); assert.equal(saved.targetSnapshots[0].candidate.company, 'Business 0'); assert.equal(saved.targetSnapshots[0].candidate.importedLeadId, undefined); assert.equal(saved.targetSnapshots[0].inputDigest, candidateDigest(candidates[0]));
  assert.throws(() => store.transition(saved.id, saved.revision, 'paused', '', { model: 'gpt-5.5' }));
});
test('missing, repeated, oversized or renderer-supplied targets leave durable bytes unchanged', t => {
  const store = fixture(t), candidates = seed(store), bytes = fs.readFileSync(store.file);
  for (const input of [request([]), request(['missing']), request([candidates[0].id, candidates[0].id]), request(Array.from({ length: 101 }, (_, i) => 'id-' + i)), { ...request([candidates[0].id]), targetSnapshots: [] }, request([candidates[0].id], { checkDuplicates: 'yes' })]) assert.throws(() => store.enqueueValidation(input));
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});
test('historical results persist once per task/target and exact retry does not consume a batch', t => {
  const store = fixture(t), [candidate] = seed(store), job = store.enqueueValidation(request([candidate.id])), attemptId = crypto.randomUUID(); store.transition(job.id, job.revision, 'running', '', { attemptId });
  const value = result(job, job.targetSnapshots[0]); const first = store.commitValidationBatch(job.id, attemptId, { results: [value], summary: 'Unknown identity' }); const bytes = fs.readFileSync(store.file);
  const retry = store.commitValidationBatch(job.id, attemptId, { results: [value] }); assert.equal(retry.completedBatches, 1); assert.equal(retry.revision, first.revision); assert.deepEqual(fs.readFileSync(store.file), bytes); assert.equal(store.snapshot().validationResults[0].overall, 'needs_review'); assert.deepEqual(store.snapshot().candidates, [candidate]);
  assert.throws(() => store.commitValidationBatch(job.id, attemptId, { results: [{ ...value, id: crypto.randomUUID() }] }), { code: 'HUNTER_CONFLICT' });
  store.transition(job.id, first.revision, 'completed'); const second = store.enqueueValidation(request([candidate.id])); assert.notEqual(second.id, job.id); assert.equal(store.snapshot().validationResults.length, 1);
});
test('foreign targets, duplicate outputs, digest/model mismatch and unsupported claims cannot commit', t => {
  const store = fixture(t), candidates = seed(store, 2), job = store.enqueueValidation(request([candidates[0].id])), attempt = crypto.randomUUID(); store.transition(job.id, job.revision, 'running', '', { attemptId: attempt }); const value = result(job, job.targetSnapshots[0]), bytes = fs.readFileSync(store.file);
  const unsupported = structuredClone(value); unsupported.checks[0].status = 'passed'; unsupported.overall = 'passed';
  for (const results of [[{ ...value, candidateId: candidates[1].id }], [{ ...value, inputDigest: 'bad' }], [{ ...value, model: 'gpt-5.5' }], [value, value], [unsupported], [{ ...value, sources: [{ url: 'http://127.0.0.1/', label: 'Private', observedAt: timestamp }] }]]) assert.throws(() => store.commitValidationBatch(job.id, attempt, { results }));
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});
test('cancel and pause fence late validation results', t => {
  const store = fixture(t), [candidate] = seed(store); for (const state of ['cancelled', 'paused']) { const job = store.enqueueValidation(request([candidate.id])), attemptId = crypto.randomUUID(), running = store.transition(job.id, job.revision, 'running', '', { attemptId }); store.transition(job.id, running.revision, state); assert.throws(() => store.commitValidationBatch(job.id, attemptId, { results: [result(job, job.targetSnapshots[0])] }), { code: 'HUNTER_STALE' }); } assert.equal(store.snapshot().validationResults.length, 0);
});
test('changed persisted snapshots or historical relations are corruption and never overwritten', t => {
  const store = fixture(t), [candidate] = seed(store), job = store.enqueueValidation(request([candidate.id])), original = fs.readFileSync(store.file), backup = fs.readFileSync(store.file + '.bak');
  for (const mutate of [data => { data.jobs.at(-1).targetSnapshots[0].candidate.company = 'Forged'; }, data => { data.jobs.at(-1).targetSnapshots[0].inputDigest = '0'.repeat(64); }, data => { data.jobs.at(-1).validationResultIds = [crypto.randomUUID()]; }, data => { data.jobs.at(-1).targetSnapshots[0].discoveryJobId = job.id; }]) { const data = JSON.parse(original); mutate(data); fs.writeFileSync(store.file, JSON.stringify(data)); const bytes = fs.readFileSync(store.file); assert.throws(() => store.snapshot(), { code: 'HUNTER_CORRUPT' }); assert.throws(() => store.setPaused(true), { code: 'HUNTER_CORRUPT' }); assert.deepEqual(fs.readFileSync(store.file), bytes); assert.deepEqual(fs.readFileSync(store.file + '.bak'), backup); }
});
test('result capacity is reserved before execution and subsequent writes respect it', t => {
  const store = fixture(t), [candidate] = seed(store), bytes = fs.readFileSync(store.file); store.maxBytes = bytes.length + 5000;
  assert.throws(() => store.enqueueValidation(request([candidate.id])), { code: 'HUNTER_FULL' }); assert.deepEqual(fs.readFileSync(store.file), bytes);
});

test('legacy corruption is validated before migration and does not create backups or rewrite data', t => {
  const store = fixture(t); seed(store); const original = store.snapshot(); original.version = 1; delete original.validationResults; for (const job of original.jobs) delete job.kind;
  for (const mutate of [data => { data.jobs[0].completedBatches = 11; }, data => { data.jobs[0].candidateIds.push('missing'); }, data => { data.candidates[0].sources[0].url = 'http://127.0.0.1/'; }, data => { data.jobs[0].kind = 'validate'; }]) { const data = structuredClone(original); mutate(data); fs.writeFileSync(store.file, JSON.stringify(data)); const bytes = fs.readFileSync(store.file), backup = fs.readFileSync(store.file + '.bak'); assert.throws(() => store.snapshot(), { code: 'HUNTER_CORRUPT' }); assert.throws(() => store.enqueueValidation(request(['candidate-0'])), { code: 'HUNTER_CORRUPT' }); assert.deepEqual(fs.readFileSync(store.file), bytes); assert.deepEqual(fs.readFileSync(store.file + '.bak'), backup); }
});

test('exact result retry remains idempotent when the final batch consumed the budget', t => {
  const store = fixture(t), candidates = seed(store, 10), job = store.enqueueValidation(request(candidates.map(c => c.id))), attemptId = crypto.randomUUID(); store.transition(job.id, job.revision, 'running', '', { attemptId });
  const values = job.targetSnapshots.map(target => result(job, target)); let current; for (const value of values) current = store.commitValidationBatch(job.id, attemptId, { results: [value] });
  const bytes = fs.readFileSync(store.file), retry = store.commitValidationBatch(job.id, attemptId, { results: [values.at(-1)] }); assert.equal(retry.completedBatches, 10); assert.equal(retry.revision, current.revision); assert.deepEqual(fs.readFileSync(store.file), bytes);
});

test('large candidate fixture preserves all 2,000 IDs and rejects mismatched job ownership', t => {
  const store = fixture(t); seed(store, 100); const base = store.snapshot(), template = base.jobs[0], data = { version: 2, paused: false, jobs: [], candidates: [], validationResults: [] };
  for (let batch = 0; batch < 20; batch++) { const jobId = crypto.randomUUID(), candidates = base.candidates.map((c, index) => ({ ...structuredClone(c), id: 'large-' + batch + '-' + index, jobId })); data.jobs.push({ ...structuredClone(template), id: jobId, revision: crypto.randomUUID(), candidateIds: candidates.map(c => c.id) }); data.candidates.push(...candidates); }
  fs.writeFileSync(store.file, JSON.stringify(data)); const bytes = fs.readFileSync(store.file), read = store.snapshot(); assert.equal(read.candidates.length, 2000); assert.equal(new Set(read.candidates.map(c => c.id)).size, 2000); assert.deepEqual(fs.readFileSync(store.file), bytes);
  data.jobs[0].candidateIds[0] = data.jobs[1].candidateIds[0]; fs.writeFileSync(store.file, JSON.stringify(data)); assert.throws(() => store.snapshot(), { code: 'HUNTER_CORRUPT' });
});

test('v2 Discover and Validate missing saved models are corruption rather than silently defaulted', t => {
  const store = fixture(t), [candidate] = seed(store); store.enqueueValidation(request([candidate.id])); const original = fs.readFileSync(store.file), backup = fs.readFileSync(store.file + '.bak');
  for (const kind of ['discover', 'validate']) for (const value of [undefined, null, 'unsupported-model']) { const data = JSON.parse(original), job = data.jobs.find(j => j.kind === kind); if (value === undefined) delete job.model; else job.model = value; fs.writeFileSync(store.file, JSON.stringify(data)); const bytes = fs.readFileSync(store.file); assert.throws(() => store.snapshot(), { code: 'HUNTER_CORRUPT' }); assert.throws(() => store.setPaused(true), { code: 'HUNTER_CORRUPT' }); assert.deepEqual(fs.readFileSync(store.file), bytes); assert.deepEqual(fs.readFileSync(store.file + '.bak'), backup); }
});
