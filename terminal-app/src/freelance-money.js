'use strict';
const invoice = require('./invoice-document'), quotation = require('./quotation-document');
function sum(values) { let total = 0; for (const n of values) { total += n; if (!Number.isSafeInteger(total)) throw Error('Totals exceed the supported money range.'); } return total; }
function overview({ invoices, quotations, expenses }, date = quotation.today()) {
  const issued = invoices.filter(i => i.status === 'issued'), activeQuotes = quotations.filter(q => !q.archived), activeExpenses = expenses.filter(e => !e.archived);
  const invoicedSen = sum(issued.map(i => invoice.total(i.values))), paidSen = sum(issued.map(invoice.paid)), outstandingSen = sum(issued.map(invoice.balance));
  const expensesSen = sum(activeExpenses.map(e => e.values.amountSen));
  return { invoicedSen, paidSen, outstandingSen, expensesSen, cashAfterExpensesSen: paidSen - expensesSen, quotedSen: sum(activeQuotes.map(q => quotation.total(q.values) ?? 0)), unpricedQuotes: activeQuotes.filter(q => quotation.total(q.values) === null).length, overdueSen: sum(issued.filter(i => invoice.status(i, date) === 'overdue').map(invoice.balance)), invoiceCount: issued.length };
}
module.exports = { overview };
