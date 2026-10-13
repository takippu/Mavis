'use strict';
// Shared by the local preview and native PDF exporter; no remote assets or scripts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuotationDocument = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const TEXT = { issuerName: 160, registration: 100, project: 500, customerName: 240, customerAddress: 2000, terms: 20000, paymentInstructions: 3000 };
  const money = sen => sen == null ? 'Not priced' : 'RM' + (sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function dateOK(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value + 'T00:00:00Z').getTime()) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value; }
  function today() { const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
  function defaults(lead) {
    return { issuerName: 'TRLABS TECHNOLOGIES', registration: '202603175570', project: lead?.title || '', customerName: lead?.company || lead?.contact || '', customerAddress: '', issueDate: today(), validUntil: '', leadId: lead?.id || null, clientId: lead?.clientId || null, terms: '', paymentInstructions: '', items: [{ description: lead?.title || '', quantity: 1, unitSen: null }] };
  }
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid quotation details.');
    const out = {};
    for (const key of Object.keys(input)) if (![...Object.keys(TEXT), 'issueDate', 'validUntil', 'leadId', 'clientId', 'items'].includes(key)) throw Error('Unknown quotation field: ' + key);
    for (const [key, limit] of Object.entries(TEXT)) {
      if (typeof input[key] !== 'string' || input[key].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input[key])) throw Error('Invalid ' + key + '.');
      out[key] = input[key].trim();
    }
    if (!out.issuerName) throw Error('Enter your company name.');
    if (!dateOK(input.issueDate) || (input.validUntil !== '' && !dateOK(input.validUntil))) throw Error('Choose valid quotation dates.');
    if (input.validUntil && input.validUntil < input.issueDate) throw Error('Valid until cannot be before the issue date.');
    out.issueDate = input.issueDate; out.validUntil = input.validUntil;
    if (input.leadId !== null && (typeof input.leadId !== 'string' || input.leadId.length > 100 || !input.leadId)) throw Error('Invalid linked lead.');
    out.leadId = input.leadId;
    const clientId = input.clientId ?? null;
    if (clientId !== null && (typeof clientId !== 'string' || !clientId || clientId.length > 100)) throw Error('Invalid linked client.'); out.clientId = clientId;
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw Error('Add between 1 and 100 quotation items.');
    out.items = input.items.map(item => {
      if (!item || typeof item.description !== 'string' || item.description.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item.description)) throw Error('Invalid item description.');
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) throw Error('Item quantity must be a whole number from 1 to 10,000.');
      if (item.unitSen !== null && (!Number.isSafeInteger(item.unitSen) || item.unitSen < 0 || item.unitSen > 999999999)) throw Error('Enter a valid item rate in MYR.');
      return { description: item.description.trim(), quantity: item.quantity, unitSen: item.unitSen };
    });
    const sum = out.items.reduce((a, item) => a + (item.unitSen ?? 0) * item.quantity, 0);
    if (!Number.isSafeInteger(sum) || sum > 999999999999) throw Error('Quotation total exceeds the supported limit.');
    return out;
  }
  function total(values) { return values.items.some(i => i.unitSen == null) ? null : values.items.reduce((a, i) => a + i.quantity * i.unitSen, 0); }
  function ready(values) {
    const v = validate(values);
    if (!v.project || !v.customerName || v.items.some(i => !i.description || i.unitSen === null)) throw Error('Enter a project, client name, and description and rate for every item before exporting.');
    return v;
  }
  const dateLabel = value => new Date(value + 'T12:00:00Z').toLocaleDateString('en-MY', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  function render(record, options = {}) {
    const v = validate(record.values), number = record.number || 'Draft - not issued', sum = total(v);
    const invoice = options.kind === 'invoice', receipt = options.kind === 'receipt', label = receipt ? 'Receipt' : invoice ? 'Invoice' : 'Quotation';
    const accent = receipt ? '#14734e' : invoice ? '#006c99' : '#ff6b35';
    const ink = receipt ? '#14734e' : invoice ? '#006c99' : '#b44219';
    const paid = invoice ? options.paidSen || 0 : 0;
    const totalDue = invoice && sum !== null ? sum - paid : sum;
    const row = (label, value) => '<dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd>';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(number)}</title><style>
      *{box-sizing:border-box}html{background:white}body{margin:0;color:#303642;font:10pt/1.55 Arial,Helvetica,sans-serif;letter-spacing:.35px}main{padding:0}header{border-top:5mm solid ${accent};padding-top:7mm;display:flex;justify-content:space-between;align-items:flex-start;gap:5mm;margin-bottom:10mm;break-inside:avoid}h1{font-size:23pt;letter-spacing:2px;line-height:1.1;margin:0;flex:none}h2{font-size:10pt;margin:0;font-weight:700;letter-spacing:1px}.registration{font-size:8pt;color:#707070;margin:1mm 0 0}.billing{display:grid;grid-template-columns:1.2fr 1fr;gap:8mm;margin-bottom:10mm;break-inside:avoid}.recipient{display:grid;grid-template-columns:18mm 1fr;gap:4mm}.label{font-size:8pt;color:${ink};font-weight:bold;padding-top:1mm}.client{font-weight:bold;white-space:pre-wrap;overflow-wrap:anywhere}.address{white-space:pre-wrap;color:#707070;font-size:9pt;margin-top:3mm;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:1fr 1.5fr;gap:3mm 5mm;margin:0;font-size:9pt}dt{color:#707070;font-size:8pt;font-weight:bold}dd{margin:0;text-align:right;overflow-wrap:anywhere}dd:first-of-type{font-weight:bold}.project{background:#f1f1f1;padding:3mm;font-size:9pt;font-weight:bold;margin:0 0 9mm;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:9pt}thead{display:table-header-group}th{background:#303642;color:white;text-align:left;font-size:8pt;padding:4mm 2.5mm;letter-spacing:.5px}th:first-child{width:10%}th:nth-child(2){width:54%}th:nth-child(3){width:16%}th:last-child{width:20%;text-align:right}td{border:1px solid #e8e8e8;padding:4mm 2.5mm;vertical-align:top;overflow-wrap:anywhere}td:first-child{font-weight:bold}.description{white-space:pre-wrap}.rate{text-align:center;font-size:8pt}.amount{text-align:right;font-weight:bold;font-variant-numeric:tabular-nums}.totals{width:42%;margin:7mm 0 7mm auto;break-inside:avoid}.subtotal,.total{display:flex;justify-content:space-between;gap:3mm;padding:3mm}.subtotal{font-size:9pt}.subtotal span:first-child{color:#707070;font-weight:bold;font-size:8pt}.total{background:${ink};color:white;padding:4mm;font-weight:bold;letter-spacing:.6px}.notes{margin:7mm 0;break-inside:auto;border:1px solid #eee}.notes h3{margin:0;background:#f1f1f1;padding:2.5mm;font-size:8pt;break-after:avoid}.notes p{white-space:pre-wrap;margin:0;padding:3mm;font-size:9pt;overflow-wrap:anywhere}.thanks{font-size:9pt;font-weight:bold;margin:8mm 0;break-inside:avoid}.preview-footer{color:#707070;text-align:center;font-size:8pt;margin-top:auto;padding-top:20mm;overflow-wrap:anywhere}@media screen{body{padding:18mm;min-height:297mm}main{min-height:261mm;display:flex;flex-direction:column}}@media print{.preview-footer{display:none}body{padding:0}tr{break-inside:avoid}}@page{size:A4;margin:18mm}
      </style></head><body><main><header><div><h2>${escape(v.issuerName)}</h2>${v.registration ? '<p class="registration">Business Registration No. ' + escape(v.registration) + '</p>' : ''}</div><h1>${receipt ? 'RECEIPT' : invoice ? 'INVOICE' : 'QUOTATION'}</h1></header><section class="billing"><div class="recipient"><div class="label">${receipt ? 'RECEIVED FROM' : invoice ? 'BILL TO' : 'QUOTE TO'}</div><div><div class="client">${escape(v.customerName || 'Client name required')}</div><div class="address">${escape(v.customerAddress)}</div></div></div><dl>${row(label + ' No.', number)}${row('Issue Date', dateLabel(v.issueDate))}${receipt ? row('Invoice No.', options.invoiceNumber) + row('Payment Date', dateLabel(options.paymentDate)) : v.validUntil ? row(invoice ? 'Payment Due' : 'Valid Until', dateLabel(v.validUntil)) : ''}${row('Currency', 'MYR')}</dl></section><p class="project">Project reference: ${escape(v.project || 'Project required')}</p><table><thead><tr><th>ITEM</th><th>DESCRIPTION</th><th>RATE</th><th>AMOUNT</th></tr></thead><tbody>${v.items.map((i, n) => '<tr><td>' + (n + 1) + '</td><td class="description">' + escape(i.description || 'Description required') + '</td><td class="rate">' + (i.quantity === 1 ? '' : i.quantity + ' x ') + escape(money(i.unitSen)) + '</td><td class="amount">' + escape(money(i.unitSen === null ? null : i.quantity * i.unitSen)) + '</td></tr>').join('')}</tbody></table><div class="totals"><div class="subtotal"><span>Subtotal</span><span>${escape(money(sum))}</span></div>${invoice && paid ? '<div class="subtotal"><span>Payments received</span><span>' + escape(money(paid)) + '</span></div>' : ''}<div class="total"><span>${receipt ? 'TOTAL PAID' : invoice ? 'TOTAL DUE' : 'TOTAL'}</span><span>${escape(money(totalDue))}</span></div></div>${receipt ? '<section class="notes"><h3>PAYMENTS RECEIVED</h3>' + options.payments.map(p => '<p>' + escape(dateLabel(p.date)) + ' - ' + escape(money(p.amountSen)) + (p.method ? ' - ' + escape(p.method) : '') + (p.reference ? ' - Reference: ' + escape(p.reference) : '') + '</p>').join('') + '</section>' : ''}${!receipt && v.paymentInstructions ? '<section class="notes"><h3>PAYMENT INSTRUCTIONS</h3><p>' + escape(v.paymentInstructions) + '</p></section>' : ''}${!receipt && v.terms ? '<section class="notes"><h3>TERMS &amp; SCOPE NOTES</h3><p>' + escape(v.terms) + '</p></section>' : ''}<p class="thanks">Thank you for ${receipt ? 'your payment to' : invoice ? 'choosing' : 'considering'} ${escape(v.issuerName)}.</p><footer class="preview-footer">${escape(v.issuerName)} | ${label} ${escape(number)}</footer></main></body></html>`;
  }
  function footer(record, kind = 'quotation') { return '<div style="width:100%;text-align:center;font:8pt Arial;color:#707070;padding:0 18mm">' + escape(record.values.issuerName) + ' | ' + (kind === 'receipt' ? 'Receipt' : kind === 'invoice' ? 'Invoice' : 'Quotation') + ' ' + escape(record.number) + ' | Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'; }
  return { defaults, validate, ready, render, footer, total, money, dateOK, today };
});
