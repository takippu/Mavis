'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./quotation-document'));
  else root.InvoiceDocument = factory(root.QuotationDocument);
})(typeof window === 'object' ? window : globalThis, function (quotation) {
  function toQuotation(input) { const { dueDate, ...v } = input; return { ...v, validUntil: dueDate }; }
  function fromQuotation(input) { const { validUntil, ...v } = input; return { ...v, dueDate: validUntil }; }
  function validate(input) { if (!input || typeof input !== 'object') throw Error('Invalid invoice details.'); return fromQuotation(quotation.validate(toQuotation(input))); }
  function defaults() { const v = quotation.defaults(); return fromQuotation({ ...v, validUntil: '' }); }
  function ready(input) { const v = validate(input); if (!v.dueDate) throw Error('Set the payment due date before finalising this invoice.'); quotation.ready(toQuotation(v)); return v; }
  function paid(record) { return (record.payments || []).filter(p => !p.voidedAt).reduce((sum, p) => sum + p.amountSen, 0); }
  function balance(record) { const amount = quotation.total(record.values); return amount === null ? null : amount - paid(record); }
  function status(record, date = quotation.today()) {
    if (record.status !== 'issued') return record.status;
    if (balance(record) === 0) return 'paid';
    if (record.values.dueDate < date) return 'overdue';
    return paid(record) ? 'partial' : 'unpaid';
  }
  const labels = { draft: 'Draft', void: 'Void', unpaid: 'Unpaid', partial: 'Partially paid', paid: 'Paid', overdue: 'Overdue' };
  function fromQuote(record, basisPoints = 10000, billingLabel = '') {
    const q = quotation.ready(record.values);
    if (!Number.isInteger(basisPoints) || basisPoints < 1 || basisPoints > 10000) throw Error('Enter a percentage above 0 and up to 100, with at most two decimal places.');
    let items = q.items.map(i => ({ ...i }));
    if (basisPoints !== 10000) {
      if (typeof billingLabel !== 'string' || !billingLabel.trim() || billingLabel.length > 160) throw Error('Name this deposit or milestone.');
      const total = quotation.total(q), unitSen = Number((BigInt(total) * BigInt(basisPoints) + 5000n) / 10000n);
      if (!unitSen) throw Error('This percentage rounds to zero. Enter a larger percentage.');
      items = [{ description: billingLabel.trim() + '\n' + (basisPoints / 100) + '% of ' + quotation.money(total) + ' for ' + q.project, quantity: 1, unitSen }];
    }
    return validate({ ...fromQuotation(q), items, issueDate: quotation.today(), dueDate: '' });
  }
  function render(record) {
    return quotation.render({ ...record, values: toQuotation(validate(record.values)), number: (record.status === 'draft' || !record.id ? 'DRAFT - ' : record.status === 'void' ? 'VOID - ' : '') + (record.number || 'not finalised') }, { kind: 'invoice', paidSen: paid(record) });
  }
  function footer(record) { return quotation.footer(record, 'invoice'); }
  return { defaults, validate, ready, render, footer, fromQuote, paid, balance, status, labels, total: quotation.total, money: quotation.money, today: quotation.today, dateOK: quotation.dateOK };
});
