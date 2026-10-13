'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { HunterStore } = require('../src/lead-hunter-store'), { LeadsStore } = require('../src/leads-store'), { importSelected } = require('../src/lead-hunter-import');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-import-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new HunterStore(dir), leadsStore = new LeadsStore(dir), job = store.enqueue({ goal: 'Find businesses', filters: { region: 'Selangor' } }), attemptId = crypto.randomUUID();
  store.transition(job.id, job.revision, 'running', '', { attemptId });
  const candidate = { id: 'candidate-one', company: 'Example workshop', industry: 'Workshops', region: 'Selangor', city: 'Shah Alam', address: '1 Workshop Road', website: { state: 'not_observed', url: '' }, contact: { email: 'hello@workshop.example', phone: '', form: '' }, sources: [{ url: 'https://directory.example/workshop', label: 'Public directory', observedAt: '2026-10-13T01:00:00Z' }], identityKeys: ['business:exampleworkshop:selangor:shahalam'], duplicate: { kind: 'none', recordIds: [] }, discoveredAt: '2026-10-13T01:00:00Z' };
  store.commitBatch(job.id, attemptId, { candidates: [candidate], seenKeys: candidate.identityKeys });
  return { store, leadsStore, candidateIds: [candidate.id], clients: [] };
}
test('selected import creates new pending-validation Leads with durable bounded evidence', t => {
  const f = fixture(t), result = importSelected(f), lead = f.leadsStore.list()[0];
  assert.deepEqual(result.createdLeadIds, [lead.id]); assert.equal(lead.stage, 'new'); assert.match(lead.nextStep, /Validation pending/); assert.equal(lead.discovery.candidateId, f.candidateIds[0]); assert.equal(lead.discovery.website.state, 'not_observed'); assert.equal(lead.discovery.location.city, 'Shah Alam'); assert.equal(f.store.snapshot().candidates[0].importedLeadId, lead.id);
  assert.equal(f.leadsStore.findByDiscoveryCandidateId(f.candidateIds[0]).id, lead.id);
});
test('repeated and same-turn imports create only one lead and preserve its newer activity', async t => {
  const f = fixture(t); const [a, b] = await Promise.all([Promise.resolve().then(() => importSelected(f)), Promise.resolve().then(() => importSelected(f))]);
  assert.equal(a.createdLeadIds.length, 1); assert.equal(b.createdLeadIds.length, 0); assert.equal(b.existingLeadIds[0], a.createdLeadIds[0]);
  const lead = f.leadsStore.list()[0], updated = f.leadsStore.change(lead.id, lead.revision, 'note', 'New reply'); importSelected(f); assert.deepEqual(f.leadsStore.list()[0], updated);
});
test('crash after lead creation heals from origin before duplicate rechecking', t => {
  const f = fixture(t), mark = f.store.markImported.bind(f.store); f.store.markImported = () => { throw new Error('Simulated interruption'); };
  assert.throws(() => importSelected(f), /Simulated interruption/); assert.equal(f.leadsStore.list().length, 1); assert.equal(f.store.snapshot().candidates[0].importedLeadId, undefined);
  const lead = f.leadsStore.list()[0]; f.leadsStore.change(lead.id, lead.revision, 'archive', true); f.store.markImported = mark;
  const result = importSelected(f); assert.equal(result.createdLeadIds.length, 0); assert.deepEqual(result.existingLeadIds, [lead.id]); assert.equal(f.store.snapshot().candidates[0].importedLeadId, lead.id);
});
test('ambiguous duplicates require explicit review and confident clients are never overwritten', t => {
  const f = fixture(t), existing = f.leadsStore.create({ title: 'Existing prospect', company: 'Example workshop', email: 'hello@workshop.example' }), bytes = fs.readFileSync(f.leadsStore.file);
  let result = importSelected(f); assert.equal(result.createdLeadIds.length, 0); assert.match(result.rejected[0].reason, /acknowledge/); assert.deepEqual(fs.readFileSync(f.leadsStore.file), bytes);
  result = importSelected({ ...f, acknowledgePossibleDuplicates: true }); assert.equal(result.createdLeadIds.length, 1); assert.deepEqual(f.leadsStore.list().find(l => l.id === existing.id), existing);
  const other = fixture(t), client = { id: 'client-one', name: 'Example workshop', region: 'Selangor', city: 'Shah Alam', address: '1 Workshop Road' }; result = importSelected({ ...other, clients: [client], acknowledgePossibleDuplicates: true }); assert.equal(result.createdLeadIds.length, 0); assert.match(result.rejected[0].reason, /already matches/); assert.equal(other.leadsStore.list().length, 0); assert.equal(client.name, 'Example workshop');
});
test('missing, empty and forged selections cannot create arbitrary Leads', t => {
  const f = fixture(t); assert.deepEqual(importSelected({ ...f, candidateIds: [] }), { createdLeadIds: [], existingLeadIds: [], rejected: [] });
  assert.equal(importSelected({ ...f, candidateIds: ['missing'] }).rejected.length, 1);
  assert.throws(() => importSelected({ ...f, candidateIds: [null] }), { code: 'HUNTER_INVALID' }); assert.throws(() => importSelected({ ...f, candidateIds: Array(501).fill('one') }), { code: 'HUNTER_INVALID' }); assert.equal(f.leadsStore.list().length, 0);
});
