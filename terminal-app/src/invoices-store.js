'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { atomic } = require('./workspace-service'), doc = require('./invoice-document');
const LIMIT = 12 * 1024 * 1024;
function fail(message, code = 'INVOICES') { throw Object.assign(Error(message), { code }); }
function paymentValues(p) {
  if (!p || !Number.isSafeInteger(p.amountSen) || p.amountSen <= 0 || p.amountSen > 999999999999) fail('Enter a positive payment amount in MYR.');
  if (!doc.dateOK(p.date) || p.date > doc.today()) fail('Choose a valid payment date that is not in the future.');
  const out = { amountSen: p.amountSen, date: p.date };
  for (const [key, max] of [['method', 80], ['reference', 240], ['notes', 2000]]) { if (typeof p[key] !== 'string' || p[key].length > max) fail('Invalid payment ' + key + '.'); out[key] = p[key].trim(); }
  if (typeof p.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(p.requestId)) fail('Invalid payment request.'); out.requestId = p.requestId;
  return out;
}
class InvoicesStore {
  constructor(dir) { this.file = path.join(dir, 'freelance-invoices.json'); }
  read() {
    let raw; try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { version: 1, counters: {}, invoices: [] }; throw e; }
    try {
      if (Buffer.byteLength(raw) > LIMIT) throw Error();
      const data = JSON.parse(raw), ids = new Set(), numbers = new Set();
      if (data.version !== 1 || !Array.isArray(data.invoices) || !data.counters || typeof data.counters !== 'object' || Array.isArray(data.counters)) throw Error();
      for (const [year, n] of Object.entries(data.counters)) if (!/^\d{4}$/.test(year) || !Number.isSafeInteger(n) || n < 1) throw Error();
      for (const i of data.invoices) {
        doc.validate(i.values);
        if (!i.id || typeof i.id !== 'string' || ids.has(i.id) || !i.revision || typeof i.revision !== 'string' || !/^INV-\d{4}-\d{3,}$/.test(i.number) || numbers.has(i.number) || !['draft', 'issued', 'void'].includes(i.status) || !Array.isArray(i.payments) || !Array.isArray(i.activity) || !i.createdAt || !i.updatedAt) throw Error();
        const [, year, n] = i.number.split('-'); if (!(data.counters[year] >= Number(n))) throw Error();
        if (i.status === 'issued') doc.ready(i.values);
        const paymentIds = new Set(), requestIds = new Set();
        for (const p of i.payments) {
          paymentValues(p);
          if (!p.id || paymentIds.has(p.id) || requestIds.has(p.requestId) || !p.recordedAt || (p.voidedAt !== null && (typeof p.voidedAt !== 'string' || !p.voidedAt || typeof p.voidReason !== 'string' || !p.voidReason.trim()))) throw Error();
          paymentIds.add(p.id); requestIds.add(p.requestId);
        }
        if (i.status === 'draft' && i.payments.length || doc.paid(i) && i.status !== 'issued' || doc.balance(i) !== null && doc.balance(i) < 0) throw Error();
        ids.add(i.id); numbers.add(i.number);
      }
      return data;
    } catch { fail('Invoice storage could not be read. Your data was kept unchanged; recover the file or its .bak copy before saving.', 'INVOICES_CORRUPT'); }
  }
  list() { return this.read().invoices; }
  write(data) { if (Buffer.byteLength(JSON.stringify(data)) > LIMIT) fail('Invoice storage is full. Export a backup before adding records.'); atomic(this.file, data, true); }
  get(id, revision) { const i = this.list().find(i => i.id === id); this.check(i, revision); return i; }
  check(i, revision) { if (!i) fail('This invoice is no longer available.'); if (i.revision !== revision) fail('This invoice changed since you opened it. Reopen it before saving; your draft has been kept.', 'INVOICES_CONFLICT'); }
  stamp(i, text, kind) { const at = new Date().toISOString(); i.updatedAt = at; i.revision = crypto.randomUUID(); i.activity.unshift({ id: crypto.randomUUID(), at, kind, text }); }
  save(id, revision, input, source = null) {
    const values = doc.validate(input), data = this.read(); let i;
    if (id) {
      i = data.invoices.find(i => i.id === id); this.check(i, revision);
      if (i.status === 'void') fail('Voided invoices cannot be edited. Create a new invoice instead.');
      if (i.status === 'issued') {
        doc.ready(values); const received = doc.paid(i);
        if (doc.total(values) < received) fail('Invoice total cannot be lower than recorded payments of ' + doc.money(received) + '.');
        if (JSON.stringify(i.values) === JSON.stringify(values)) return i;
        const previousValues = structuredClone(i.values), previousRevision = i.revision;
        i.values = values; this.stamp(i, 'Invoice revised; total ' + doc.money(doc.total(previousValues)) + ' to ' + doc.money(doc.total(values)), 'revised');
        Object.assign(i.activity[0], { previousValues, previousRevision });
      } else { i.values = values; this.stamp(i, 'Invoice draft updated', 'updated'); }
    }
    else {
      const year = values.issueDate.slice(0, 4), n = (data.counters[year] || 0) + 1; if (!Number.isSafeInteger(n)) fail('Invoice numbering limit reached.');
      if (source && (!source.id || !source.number || !source.revision)) fail('Invalid source quotation.');
      data.counters[year] = n; const now = new Date().toISOString();
      i = { id: crypto.randomUUID(), revision: crypto.randomUUID(), number: 'INV-' + year + '-' + String(n).padStart(3, '0'), values, status: 'draft', payments: [], activity: [], quotationId: source?.id || null, quotationNumber: source?.number || '', quotationRevision: source?.revision || '', createdAt: now, updatedAt: now };
      this.stamp(i, 'Invoice draft created' + (source ? ' from ' + source.number : ''), 'created'); data.invoices.unshift(i);
    }
    this.write(data); return i;
  }
  issue(id, revision) {
    const data = this.read(), i = data.invoices.find(i => i.id === id); this.check(i, revision);
    if (i.status !== 'draft') fail('Only a draft can be finalised.'); doc.ready(i.values); i.status = 'issued'; this.stamp(i, 'Invoice finalised', 'issued'); this.write(data); return i;
  }
  payment(id, revision, input) {
    const p = paymentValues(input), data = this.read(), i = data.invoices.find(i => i.id === id);
    if (!i) fail('This invoice is no longer available.');
    const duplicate = i.payments.find(x => x.requestId === p.requestId);
    if (duplicate) { if (Object.keys(p).some(k => p[k] !== duplicate[k])) fail('This payment request already contains different details. Start a new payment entry.'); return i; }
    this.check(i, revision); if (i.status !== 'issued') fail('Finalise this invoice before recording a payment.');
    const balance = doc.balance(i); if (p.amountSen > balance) fail('Payment exceeds the remaining balance of ' + doc.money(balance) + '.');
    if (i.payments.length >= 1000) fail('This invoice has reached the payment-history limit.');
    i.payments.push({ ...p, id: crypto.randomUUID(), recordedAt: new Date().toISOString(), voidedAt: null, voidReason: '' }); this.stamp(i, 'Payment recorded: ' + doc.money(p.amountSen), 'payment'); this.write(data); return i;
  }
  reverse(id, revision, paymentId, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) fail('Enter a reason for correcting this payment record.');
    const data = this.read(), i = data.invoices.find(i => i.id === id); this.check(i, revision);
    if (i.status !== 'issued') fail('Only a finalised invoice has payment records.'); const p = i.payments.find(p => p.id === paymentId); if (!p || p.voidedAt) fail('This payment entry is no longer active.');
    p.voidedAt = new Date().toISOString(); p.voidReason = reason.trim(); this.stamp(i, 'Payment entry reversed: ' + doc.money(p.amountSen) + ' - ' + p.voidReason, 'reversed'); this.write(data); return i;
  }
  void(id, revision) {
    const data = this.read(), i = data.invoices.find(i => i.id === id); this.check(i, revision);
    if (i.status === 'void') fail('This invoice is already void.'); if (doc.paid(i)) fail('This invoice has active payment records. Correct those records before voiding it.');
    i.status = 'void'; this.stamp(i, 'Invoice voided', 'void'); this.write(data); return i;
  }
}
module.exports = { InvoicesStore, paymentValues };
