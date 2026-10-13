'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { LeadsStore, validDate } = require('../src/leads-store');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-leads-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new LeadsStore(dir); }
test('leads survive new store instances with exact MYR value, scope and activity', t => {
  const store = fixture(t); assert.deepEqual(store.list(), []);
  const lead = store.create({ title: ' Insurance portal ', stage: 'discussing', brief: 'Rates supplied by client\nAPI access unknown', followUp: '2026-10-09', valueSen: 599900 });
  assert.equal(lead.title, 'Insurance portal'); assert.equal(lead.valueSen, 599900); assert.equal(lead.company, '');
  const changed = store.change(lead.id, lead.revision, 'update', { stage: 'quoted', nextStep: 'Await response' });
  const noted = store.change(changed.id, changed.revision, 'note', 'Client asked about hosting');
  const restored = new LeadsStore(path.dirname(store.file)).list()[0]; assert.deepEqual(restored, noted);
  assert.equal(restored.activity.length, 3); assert.match(restored.activity[1].text, /discussing to quoted/);
  assert.equal(JSON.parse(fs.readFileSync(store.file + '.bak', 'utf8')).leads[0].revision, changed.revision);
});
test('stale edits and duplicate submission cannot overwrite a newer lead or note', t => {
  const store = fixture(t), lead = store.create({ title: 'Prospect' });
  const updated = store.change(lead.id, lead.revision, 'note', 'First reply');
  assert.throws(() => store.change(lead.id, lead.revision, 'update', { title: 'Stale title' }), { code: 'LEADS_CONFLICT' });
  assert.throws(() => store.change(lead.id, lead.revision, 'note', 'Duplicate'), { code: 'LEADS_CONFLICT' });
  assert.deepEqual(store.list()[0], updated);
});
test('archive is reversible and does not erase the original brief or activity', t => {
  const store = fixture(t), lead = store.create({ title: 'Prospect', brief: 'Client scope' });
  const archived = store.change(lead.id, lead.revision, 'archive', true); assert.equal(store.list()[0].archived, true);
  const restored = store.change(lead.id, archived.revision, 'archive', false); assert.equal(restored.archived, false); assert.equal(restored.brief, 'Client scope'); assert.equal(restored.activity.length, 3);
});
test('invalid input cannot partially mutate persisted leads', t => {
  const store = fixture(t), lead = store.create({ title: 'Original' }), bytes = fs.readFileSync(store.file);
  for (const values of [{ title: '' }, { stage: 'paid' }, { valueSen: 4.5 }, { valueSen: -1 }, { followUp: '2026-02-30' }, { followUp: '2026-99-99' }, { id: 'forged' }, { revision: 'forged' }, { title: 'x'.repeat(161) }, JSON.parse('{"__proto__":"bad"}')]) {
    assert.throws(() => store.change(lead.id, lead.revision, 'update', values)); assert.deepEqual(fs.readFileSync(store.file), bytes);
  }
  assert.throws(() => store.create({ title: ' ' })); assert.throws(() => store.change(lead.id, lead.revision, 'note', ' ')); assert.throws(() => store.change(lead.id, lead.revision, 'archive', 'yes'));
  assert.equal(validDate('2028-02-29'), true); assert.equal(validDate('2027-02-29'), false);
});
test('corrupt storage fails closed and keeps both primary and backup unchanged', t => {
  const store = fixture(t), lead = store.create({ title: 'Original' }); store.change(lead.id, lead.revision, 'note', 'Backup exists');
  fs.writeFileSync(store.file, '{broken'); const backup = fs.readFileSync(store.file + '.bak');
  assert.throws(() => store.list(), { code: 'LEADS_CORRUPT' }); assert.throws(() => store.create({ title: 'Do not overwrite' }), { code: 'LEADS_CORRUPT' });
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken'); assert.deepEqual(fs.readFileSync(store.file + '.bak'), backup);
});
test('optional discovery origins retain legacy records and cannot be overwritten by editing', t => {
  const store = fixture(t), legacy = store.create({ title: 'Legacy prospect' });
  const discovery = { version: 1, candidateId: 'hunter-one', jobId: 'job-one', provider: 'codex', discoveredAt: '2026-10-13T01:00:00Z', sources: [{ url: 'https://directory.example/workshop', label: 'Directory', observedAt: '2026-10-13T01:00:00Z' }], website: { state: 'unknown', url: '' }, location: { region: 'Selangor', city: '', address: '' } };
  const lead = store.create({ title: 'Discovered workshop', discovery }); discovery.location.region = 'Changed';
  assert.equal(store.findByDiscoveryCandidateId('hunter-one').discovery.location.region, 'Selangor'); assert.equal(store.list().find(l => l.id === legacy.id).discovery, undefined);
  assert.throws(() => store.change(lead.id, lead.revision, 'update', { discovery }), /cannot be overwritten/);
  const bytes = fs.readFileSync(store.file);
  for (const invalid of [{ ...lead.discovery, version: 2 }, { ...lead.discovery, candidateId: '' }, { ...lead.discovery, sources: [] }, { ...lead.discovery, sources: [{ url: 'http://127.0.0.1', label: '', observedAt: '2026-10-13T01:00:00Z' }] }, { ...lead.discovery, website: { state: 'found', url: '' } }]) assert.throws(() => store.create({ title: 'Invalid evidence', discovery: invalid }));
  assert.deepEqual(fs.readFileSync(store.file), bytes);
});
test('import provenance retains the public final URL of a redirected source',t=>{
 const store=fixture(t),date='2026-10-13T01:00:00.000Z';
 const discovery={version:1,candidateId:'hunter-redirect',jobId:'job-redirect',provider:'codex',discoveredAt:date,sources:[{url:'https://example.org/contact',finalUrl:'https://www.example.org/contact',label:'Example',observedAt:date}],website:{state:'found',url:'https://www.example.org/contact'},location:{region:'Selangor',city:'Shah Alam',address:''}};
 const lead=store.create({title:'Redirected public source',discovery});assert.equal(new LeadsStore(path.dirname(store.file)).list()[0].discovery.sources[0].finalUrl,discovery.sources[0].finalUrl);
 assert.throws(()=>store.create({title:'Private redirect',discovery:{...discovery,sources:[{...discovery.sources[0],finalUrl:'http://127.0.0.1/'}]}}));assert.equal(store.list().length,1);assert.ok(lead.id);
});
