'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { InvoicesStore } = require('../src/invoices-store'), doc = require('../src/invoice-document'), quotation = require('../src/quotation-document');
const { overview } = require('../src/freelance-money');
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-invoices-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new InvoicesStore(dir); };
const values = () => ({ ...doc.defaults(), issueDate: '2026-01-01', dueDate: '2026-01-31', customerName: 'Example Client', project: 'Website', items: [{ description: 'Development', quantity: 1, unitSen: 429900 }] });
const payment = amountSen => ({ amountSen, date: '2026-01-02', method: 'Bank transfer', reference: 'Fixture reference', notes: '', requestId: crypto.randomUUID() });
test('draft invoices persist numbering and require complete details before finalising', t => {
  const store = fixture(t), d = store.save(null, null, doc.defaults()); assert.equal(d.number.slice(-3), '001'); assert.throws(() => store.issue(d.id, d.revision), /due date/); assert.throws(() => store.payment(d.id, d.revision, payment(1)), /Finalise/);
  const changed = store.save(d.id, d.revision, values()); assert.equal(changed.number, d.number); const issued = store.issue(changed.id, changed.revision); assert.equal(issued.status, 'issued');
  assert.equal(store.save(issued.id, issued.revision, values()).revision, issued.revision); assert.throws(() => store.issue(issued.id, issued.revision), /Only a draft/);
  assert.ok(fs.existsSync(store.file + '.bak')); const reopened = new InvoicesStore(path.dirname(store.file)); assert.equal(reopened.get(issued.id, issued.revision).values.items[0].unitSen, 429900);
});
test('quotation percentages round exact sen and snapshots remain independent of the source', () => {
  const q = { id: 'quote', revision: 'revision', number: 'QTN-2026-001', values: { ...quotation.defaults(), ...values(), validUntil: '', dueDate: undefined } }; delete q.values.dueDate;
  assert.equal(doc.total(doc.fromQuote(q, 5000, 'Initial deposit')), 214950); assert.equal(doc.total(doc.fromQuote(q, 2500, 'Milestone')), 107475);
  const v = doc.fromQuote(q); q.values.items[0].unitSen = 100; assert.equal(v.items[0].unitSen, 429900); assert.equal(v.dueDate, '');
  q.values.items[0].unitSen = 101; assert.equal(doc.total(doc.fromQuote(q, 5000, 'Half')), 51);
  for (const p of [-1, 0, 10001, 1.5]) assert.throws(() => doc.fromQuote(q, p, 'Invalid')); assert.throws(() => doc.fromQuote(q, 5000, ''), /Name/);
});
test('payments are partial, duplicate-safe, revision guarded and cannot overpay', t => {
  const store = fixture(t), d = store.save(null, null, values()), i = store.issue(d.id, d.revision), p = payment(214950);
  const a = store.payment(i.id, i.revision, p); assert.equal(doc.paid(a), 214950); assert.equal(doc.balance(a), 214950); assert.equal(doc.status(a, '2026-01-10'), 'partial'); assert.equal(doc.status(a, '2026-02-01'), 'overdue');
  const duplicate = store.payment(i.id, i.revision, p); assert.equal(duplicate.payments.length, 1); assert.equal(duplicate.revision, a.revision);
  assert.throws(() => store.payment(a.id, a.revision, { ...p, amountSen: 1 }), /different details/); assert.throws(() => store.payment(i.id, i.revision, payment(1)), { code: 'INVOICES_CONFLICT' });
  assert.throws(() => store.payment(a.id, a.revision, payment(214951)), /exceeds/); assert.equal(store.get(a.id, a.revision).payments.length, 1);
  const b = store.payment(a.id, a.revision, payment(214950)); assert.equal(doc.balance(b), 0); assert.equal(doc.status(b, '2026-02-01'), 'paid');
  assert.throws(() => store.payment(b.id, b.revision, payment(1)), /exceeds/); assert.throws(() => store.void(b.id, b.revision), /active payment/);
});
test('payment corrections retain entries and restore balance; void invoices leave money totals', t => {
  const store = fixture(t), d = store.save(null, null, values()), i = store.issue(d.id, d.revision), p = payment(50000), a = store.payment(i.id, i.revision, p);
  assert.throws(() => store.reverse(a.id, a.revision, a.payments[0].id, ''), /reason/); const b = store.reverse(a.id, a.revision, a.payments[0].id, 'Duplicate imported entry');
  assert.equal(b.payments.length, 1); assert.ok(b.payments[0].voidedAt); assert.equal(doc.paid(b), 0); assert.equal(doc.balance(b), 429900);
  assert.equal(store.payment(b.id, b.revision, p).payments.length, 1); assert.equal(doc.paid(store.get(b.id, b.revision)), 0);
  assert.throws(() => store.reverse(b.id, b.revision, b.payments[0].id, 'Again'), /no longer active/);
  const c = store.void(b.id, b.revision); assert.equal(c.status, 'void'); assert.throws(() => store.payment(c.id, c.revision, payment(1)), /Finalise/);
  const totals = overview({ invoices: [c], quotations: [], expenses: [] }, '2026-02-01'); assert.equal(totals.invoicedSen, 0); assert.equal(totals.paidSen, 0); assert.equal(totals.outstandingSen, 0);
});
test('invalid financial values and corrupt invoice ledgers fail closed', t => {
  const store = fixture(t), d = store.save(null, null, values()), i = store.issue(d.id, d.revision);
  for (const bad of [-1, 0, 1.2, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => store.payment(i.id, i.revision, payment(bad)));
  assert.throws(() => store.payment(i.id, i.revision, { ...payment(1), date: '9999-12-31' }), /future/);
  assert.throws(() => store.payment(i.id, i.revision, { ...payment(1), date: '2026-02-30' }), /valid payment date/);
  const corrupt = JSON.parse(fs.readFileSync(store.file)); corrupt.invoices[0].payments.push({ ...payment(500000), id: 'bad', recordedAt: 'now', voidedAt: null }); fs.writeFileSync(store.file, JSON.stringify(corrupt)); const before = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.save(null, null, values()), { code: 'INVOICES_CORRUPT' }); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
});
test('money totals distinguish quoted, invoiced, receipts, outstanding and recorded expenses', t => {
  const store = fixture(t), d = store.save(null, null, values()), i = store.issue(d.id, d.revision), a = store.payment(i.id, i.revision, payment(10000)), draft = store.save(null, null, values());
  const q = { archived: false, values: { ...quotation.defaults(), items: values().items } }, empty = { archived: false, values: quotation.defaults() };
  const totals = overview({ invoices: [a, draft], quotations: [q, empty, { ...q, archived: true }], expenses: [{ archived: false, values: { amountSen: 2000 } }, { archived: true, values: { amountSen: 99999 } }] }, '2026-02-01');
  assert.equal(totals.invoicedSen, 429900); assert.equal(totals.paidSen, 10000); assert.equal(totals.outstandingSen, 419900); assert.equal(totals.overdueSen, 419900); assert.equal(totals.expensesSen, 2000); assert.equal(totals.cashAfterExpensesSen, 8000); assert.equal(totals.quotedSen, 429900); assert.equal(totals.unpricedQuotes, 1);
});
test('invoice PDFs use invoice semantics and the current recorded balance while quotation content stays literal', t => {
  const store = fixture(t), d = store.save(null, null, values()), i = store.issue(d.id, d.revision), a = store.payment(i.id, i.revision, payment(214950));
  a.values.customerName = 'Quotation <example>'; const html = doc.render(a); assert.ok(html.includes('>INVOICE<')); assert.ok(html.includes('BILL TO')); assert.ok(html.includes('Payment Due')); assert.ok(html.includes('TOTAL DUE')); assert.ok(html.includes('RM2,149.50')); assert.ok(html.includes('Quotation &lt;example&gt;')); assert.ok(doc.footer(a).includes('| Invoice INV-')); assert.equal(quotation.render({ values: quotation.defaults() }).includes('>QUOTATION<'), true);
});

test('issued invoice revisions retain payments, audit values and numbering, and protect paid balances', t => {
  const store = fixture(t), d = store.save(null, null, values()), issued = store.issue(d.id, d.revision);
  const paid = store.payment(issued.id, issued.revision, payment(214950));
  const next = { ...values(), customerName: 'Revised Client', items: [{ description: 'Revised scope', quantity: 1, unitSen: 500000 }] };
  const revised = store.save(paid.id, paid.revision, next);
  assert.equal(revised.number, issued.number); assert.equal(revised.status, 'issued'); assert.deepEqual(revised.payments, paid.payments);
  assert.equal(doc.balance(revised), 285050); assert.equal(doc.status(revised, '2026-01-10'), 'partial');
  assert.deepEqual(revised.activity[0].previousValues, paid.values); assert.equal(revised.activity[0].previousRevision, paid.revision);
  assert.throws(() => store.save(paid.id, paid.revision, next), { code: 'INVOICES_CONFLICT' });
  const disk = fs.readFileSync(store.file, 'utf8');
  for (const invalid of [{ ...next, customerName: '' }, { ...next, dueDate: '' }, { ...next, items: [{ description: 'Below receipts', quantity: 1, unitSen: 214949 }] }, { ...next, items: [{ description: 'Unknown price', quantity: 1, unitSen: null }] }]) {
    assert.throws(() => store.save(revised.id, revised.revision, invalid)); assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
  }
  const matched = store.save(revised.id, revised.revision, { ...next, items: [{ description: 'Adjusted agreed total', quantity: 1, unitSen: 214950 }] });
  assert.equal(doc.status(matched, '2026-01-10'), 'paid');
  const increased = store.save(matched.id, matched.revision, next); assert.equal(doc.status(increased, '2026-01-10'), 'partial');
  const totals = overview({ invoices: [increased], quotations: [], expenses: [] }, '2026-01-10');
  assert.equal(totals.invoicedSen, 500000); assert.equal(totals.paidSen, 214950); assert.equal(totals.outstandingSen, 285050);
  const reopened = new InvoicesStore(path.dirname(store.file)).get(increased.id, increased.revision); assert.equal(reopened.activity.filter(a => a.kind === 'revised').length, 3);
});
test('voided invoice details remain immutable', t => {
  const store = fixture(t), draft = store.save(null, null, values()), issued = store.issue(draft.id, draft.revision), voided = store.void(issued.id, issued.revision);
  const disk = fs.readFileSync(store.file, 'utf8'); assert.throws(() => store.save(voided.id, voided.revision, values()), /Voided/); assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
});
