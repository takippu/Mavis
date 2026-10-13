'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const { FreelanceStore } = require('../src/freelance-store');
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-freelance-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new FreelanceStore(dir); };
const job = clientId => ({ title: 'Client site', clientId, stage: 'active', budgetSen: 500000, dueDate: '2026-12-01', scope: 'Landing page', notes: '', workspaceId: '', quotationId: '', milestones: [{ id: 'm1', title: 'Design approval', dueDate: '', done: false }] });
test('clients, jobs, milestones and expenses persist with stable links and recoverable backups', t => {
  const store = fixture(t), c = store.save('clients', null, null, { name: 'Example client', company: 'Example company', email: 'example@example.com' }), j = store.save('jobs', null, null, job(c.id));
  const completed = store.save('jobs', j.id, j.revision, { ...j.values, milestones: [{ ...j.values.milestones[0], done: true }] });
  const e = store.save('expenses', null, null, { description: 'Domain', clientId: c.id, jobId: j.id, amountSen: 8000, category: 'Hosting', date: '2026-10-08', notes: '' });
  const reopened = new FreelanceStore(path.dirname(store.file)); assert.equal(reopened.get('jobs', j.id).values.milestones[0].done, true); assert.equal(reopened.get('expenses', e.id).values.jobId, j.id); assert.ok(fs.existsSync(store.file + '.bak'));
  assert.throws(() => store.save('jobs', j.id, j.revision, job(c.id)), { code: 'FREELANCE_CONFLICT' }); assert.equal(store.get('jobs', j.id).revision, completed.revision);
  const archived = store.archive('clients', c.id, c.revision, true); assert.equal(store.get('jobs', j.id).values.clientId, c.id); assert.equal(store.archive('clients', c.id, archived.revision, false).archived, false);
});
test('invalid links, duplicate milestones, money and corrupted records are rejected without replacing data', t => {
  const store = fixture(t); assert.throws(() => store.save('jobs', null, null, job('missing')), /client/); const c = store.save('clients', null, null, { name: 'Client' });
  const invalid = job(c.id); invalid.milestones.push(invalid.milestones[0]); assert.throws(() => store.save('jobs', null, null, invalid), /task/);
  assert.throws(() => store.save('expenses', null, null, { description: 'Invalid', amountSen: -1, date: '2026-10-08' })); assert.throws(() => store.save('jobs', null, null, { ...job(c.id), dueDate: '2026-02-30' }));
  const before = fs.readFileSync(store.file, 'utf8'); assert.throws(() => store.archive('clients', c.id, 'stale', true), { code: 'FREELANCE_CONFLICT' }); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  fs.writeFileSync(store.file, '{broken'); assert.throws(() => store.save('clients', null, null, { name: 'New' }), { code: 'FREELANCE_CORRUPT' }); assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});
