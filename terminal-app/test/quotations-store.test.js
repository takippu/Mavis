'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const { QuotationsStore } = require('../src/quotations-store'), document = require('../src/quotation-document');
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-quotes-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new QuotationsStore(dir); };
const values = () => ({ ...document.defaults(), issueDate: '2026-10-08', project: 'Corporate website', customerName: 'Example company', items: [{ description: 'Design and development', quantity: 2, unitSen: 12345 }, { description: 'Hosting', quantity: 1, unitSen: 25000 }] });
test('quotation numbering persists, stays stable on edits and advances across archive and reopen', t => {
  const store = fixture(t), a = store.save(null, null, values()); assert.equal(a.number, 'QTN-2026-001'); assert.equal(document.total(a.values), 49690);
  const reopened = new QuotationsStore(path.dirname(store.file)); const changed = reopened.save(a.id, a.revision, { ...a.values, issueDate: '2027-01-01', terms: 'Written acceptance required' }); assert.equal(changed.number, a.number);
  assert.notEqual(changed.revision, a.revision); reopened.archive(changed.id, changed.revision, true);
  assert.equal(reopened.save(null, null, values()).number, 'QTN-2026-002'); assert.equal(reopened.save(null, null, { ...values(), issueDate: '2027-01-01' }).number, 'QTN-2027-001');
  assert.ok(fs.existsSync(store.file + '.bak')); assert.equal(store.list().length, 3);
});
test('stale saves, exports and archives cannot replace newer quotation data', t => {
  const store = fixture(t), a = store.save(null, null, values()); const b = store.save(a.id, a.revision, { ...a.values, customerName: 'New name' });
  for (const action of [() => store.save(a.id, a.revision, a.values), () => store.get(a.id, a.revision), () => store.archive(a.id, a.revision, true)]) assert.throws(action, { code: 'QUOTATIONS_CONFLICT' });
  assert.equal(store.get(b.id, b.revision).values.customerName, 'New name'); assert.equal(store.get(b.id, b.revision).archived, false);
});
test('drafts permit unknown rates; PDF readiness rejects missing client or incomplete prices', t => {
  const store = fixture(t), draft = store.save(null, null, document.defaults()); assert.equal(document.total(draft.values), null);
  assert.throws(() => document.ready(draft.values), /client name/);
  const v = values(); v.items[0].unitSen = null; assert.equal(document.total(v), null); assert.throws(() => document.ready(v), /rate/);
  v.items[0].unitSen = 0; assert.equal(document.total(document.ready(v)), 25000);
});
test('invalid dates, quantities, money, oversized values and injected metadata are rejected without writes', t => {
  const store = fixture(t), v = values();
  for (const bad of [{ ...v, issueDate: '2026-02-30' }, { ...v, validUntil: '2026-01-01' }, { ...v, number: 'OVERRIDE' }, { ...v, terms: 'x'.repeat(20001) }, ...[-1, 1.5, Infinity, 10001].map(quantity => ({ ...v, items: [{ ...v.items[0], quantity }] })), ...[-1, 1.5, Infinity, 1000000000].map(unitSen => ({ ...v, items: [{ ...v.items[0], unitSen }] }))]) assert.throws(() => store.save(null, null, bad));
  assert.equal(fs.existsSync(store.file), false);
});
test('corrupt quotation storage fails closed and numbering cannot silently reset', t => {
  const store = fixture(t); store.save(null, null, values()); const data = JSON.parse(fs.readFileSync(store.file)); data.counters = {}; fs.writeFileSync(store.file, JSON.stringify(data)); const before = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.save(null, null, values()), { code: 'QUOTATIONS_CORRUPT' }); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  fs.writeFileSync(store.file, '{broken'); assert.throws(() => store.list(), { code: 'QUOTATIONS_CORRUPT' });
});
test('quotation document escapes content in all document and footer positions', () => {
  const v = values(); v.customerName = '<script>alert(1)</script>'; v.items[0].description = '<img src="https://example.com/secret"> & scope'; v.issuerName = 'A < B';
  const q = { values: v, number: '<unsafe>' }, html = document.render(q);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(html.includes('&lt;img src=&quot;https://example.com/secret&quot;&gt; &amp; scope'));
  assert.equal(html.includes('<script>'), false); assert.equal(html.includes('<img '), false); assert.ok(document.footer(q).includes('&lt;unsafe&gt;'));
});
