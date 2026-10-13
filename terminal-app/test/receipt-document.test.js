'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const invoice = require('../src/invoice-document'), receipt = require('../src/receipt-document'), quote = require('../src/quotation-document');
const record = () => ({ id:'saved', number:'INV-2026-001', status:'issued', values:{ ...invoice.defaults(), customerName:'Client <script>', project:'Website', dueDate:'2026-12-01', items:[{description:'Development',quantity:1,unitSen:10000}] }, payments:[{id:'p',date:'2026-10-09',amountSen:10000,method:'Bank transfer',reference:'ref <script>',voidedAt:null}] });
test('paid receipt uses the shared green template with stable invoice reference and payment total', () => {
  const r=record(),html=receipt.render(r);assert.match(html,/>RECEIPT</);assert.match(html,/#14734e/);assert.match(html,/RCT-2026-001/);assert.match(html,/INV-2026-001/);assert.match(html,/TOTAL PAID/);assert.match(html,/RM100.00/);assert.match(html,/9 October 2026/);assert.match(html,/ref &lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/PAYMENT INSTRUCTIONS|TOTAL DUE/);assert.match(receipt.footer(r),/Receipt RCT-2026-001/);
  assert.match(invoice.render(r),/#006c99/);assert.match(quote.render({values:quote.defaults()}),/#ff6b35/);
});
test('receipts require active payments covering an issued invoice, including after payment corrections', () => {
  const r=record();for(const changed of [{...r,status:'draft'},{...r,status:'void'},{...r,payments:[]},{...r,payments:[{...r.payments[0],amountSen:5000}]},{...r,payments:[{...r.payments[0],voidedAt:'now'}]},{...r,values:{...r.values,items:[{description:'Extra scope',quantity:1,unitSen:20000}]}}])assert.throws(()=>receipt.render(changed),/fully paid/);
});
