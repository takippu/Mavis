'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./quotation-document'), require('./invoice-document'));
  else root.ReceiptDocument = factory(root.QuotationDocument, root.InvoiceDocument);
})(typeof window === 'object' ? window : globalThis, function (quotation, invoice) {
  const number = record => record.number.replace(/^INV-/, 'RCT-');
  function checkRecord(record) {
    invoice.ready(record.values);
    if (record.status !== 'issued' || invoice.balance(record) !== 0 || invoice.paid(record) <= 0) throw Error('A receipt is available only for a fully paid invoice with recorded payments.');
  }
  function render(record) {
    checkRecord(record);
    const payments = record.payments.filter(p => !p.voidedAt).sort((a, b) => a.date.localeCompare(b.date));
    const paymentDate = payments.at(-1).date;
    const { dueDate, ...values } = record.values;
    return quotation.render({ ...record, number: number(record), values: { ...values, validUntil: '', issueDate: paymentDate } }, { kind: 'receipt', invoiceNumber: record.number, paymentDate, payments });
  }
  function footer(record) { return quotation.footer({ ...record, number: number(record) }, 'receipt'); }
  return { number, checkRecord, render, footer, ready: invoice.ready };
});
