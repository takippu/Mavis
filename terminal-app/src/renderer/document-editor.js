'use strict';
// Editable paper uses the export template; stored content stays plain text and typed amounts.
window.MT.createDocumentEditor = ({ doc, record, rates, invoice, locked, onChange, onError, onRemove }) => {
  const frame = document.createElement('iframe'); frame.className = 'ws-quote-preview ws-document-editor';
  frame.title = (invoice ? 'Invoice' : 'Quotation') + (locked ? ' preview' : ' editable document');
  // Parent attaches editing handlers; no document scripts or external resources are allowed.
  frame.setAttribute('sandbox', 'allow-same-origin');
  const original = record.values, v = structuredClone(original);
  v.items.forEach((item, i) => { item.quantity = Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10000 ? item.quantity : 1; item.unitSen = /^\d+(\.\d{1,2})?$/.test(rates[i]?.trim() || '') && Number(rates[i]) <= 9999999.99 ? Math.round(Number(rates[i]) * 100) : null; });
  if (!doc.dateOK(v.issueDate)) v.issueDate = doc.today();
  const deadline = invoice ? 'dueDate' : 'validUntil'; if (!doc.dateOK(v[deadline]) || v[deadline] < v.issueDate) v[deadline] = '';
  for (const [key,max] of Object.entries({issuerName:160,registration:100,project:500,customerName:240,customerAddress:2000,terms:20000,paymentInstructions:3000})) v[key] = v[key].slice(0,max); v.items.forEach(item => item.description = item.description.slice(0,5000));
  if (!v.issuerName.trim()) v.issuerName = 'TRLABS TECHNOLOGIES';
  frame.srcdoc = doc.render({ ...record, values: v });
  frame.addEventListener('load', () => {
    const page = frame.contentDocument; if (!page) return;
    const paperAccent = invoice ? '#006c99' : '#b44219';
    const style = page.createElement('style'); style.textContent = `
      [contenteditable]{outline:1px solid transparent;outline-offset:3px;min-height:1.5em;white-space:pre-wrap;cursor:text;border-radius:2px}
      [contenteditable]:hover,.paper-input:hover{outline-color:${invoice ? '#a6cedf' : '#e5a38c'};background:${invoice ? '#f5fafc' : '#fff5f0'}}
      [contenteditable]:focus,.paper-input:focus{outline:2px solid ${paperAccent};background:${invoice ? '#f5fafc' : '#fff5f0'}}
      [contenteditable]:empty:before{content:attr(data-placeholder);color:#707070;font-weight:normal}
      .paper-input{font:inherit;letter-spacing:inherit;color:inherit;background:transparent;border:0;padding:0;width:100%;outline:1px solid transparent;outline-offset:3px;border-radius:2px;min-width:0}
      .paper-input::placeholder{color:#707070;opacity:1}.rate .paper-input{text-align:center}.paper-remove{display:block;margin-top:3mm;border:0;background:transparent;color:${paperAccent};cursor:pointer;font:7pt Arial;white-space:nowrap;margin-left:-1mm;text-decoration:underline;text-underline-offset:3px}
      .paper-input:focus-visible,.paper-remove:focus-visible{outline:2px solid ${paperAccent};outline-offset:3px}::selection{background:${invoice ? '#cce4ef' : '#ffe2d6'};color:#303642}input,[contenteditable]{caret-color:${paperAccent}}
      @media screen{body{width:794px}.paper-hint{font:8pt Arial;color:#707070;margin-top:2mm}}`;
    page.head.append(style);
    const resize = () => { frame.style.height = Math.max(1123, page.documentElement.scrollHeight + 4) + 'px'; };
    if (locked) { resize(); return; }
    function text(node, key, placeholder, max, itemIndex) {
      if (!node) return; const item = itemIndex == null ? original : original.items[itemIndex];
      node.textContent = item[key]; node.contentEditable = 'plaintext-only'; node.setAttribute('role', 'textbox'); node.setAttribute('aria-label', placeholder); node.dataset.field = itemIndex == null ? key : 'item-' + itemIndex + '-' + key; node.dataset.placeholder = placeholder; node.spellcheck = true;
      node.addEventListener('input', () => { const value = node.innerText.replace(/\r/g, ''); item[key] = value; if (value.length > max) onError(placeholder + ' supports up to ' + max + ' characters.'); onChange(); totals(); resize(); });
      node.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && ['b','i','u'].includes(e.key.toLowerCase())) e.preventDefault(); });
    }
    function input(node, key, label, type = 'text', itemIndex) {
      const control = page.createElement('input'); control.className = 'paper-input'; control.type = type; control.name = itemIndex == null ? key : 'item-' + itemIndex + '-' + key; control.setAttribute('aria-label', label); control.placeholder = label;
      control.value = itemIndex == null ? original[key] : key === 'rate' ? rates[itemIndex] : original.items[itemIndex][key];
      if (type === 'date' && key !== 'issueDate') { control.min = original.issueDate; } else if (key === 'quantity') { control.min = 1; control.max = 10000; control.step = 1; } else { control.maxLength = 100; control.inputMode = 'decimal'; }
      control.addEventListener('input', () => { if (itemIndex == null) { original[key] = control.value; if (key === 'issueDate') page.querySelector('[name="' + deadline + '"]').min = control.value; } else if (key === 'rate') rates[itemIndex] = control.value; else original.items[itemIndex][key] = Number(control.value); onChange(); totals(); });
      node.replaceChildren(control); return control;
    }
    text(page.querySelector('header h2'), 'issuerName', 'Company name', 160);
    let registration = page.querySelector('.registration'); if (!registration) { registration = page.createElement('p'); registration.className = 'registration'; page.querySelector('header>div').append(registration); }
    const registrationLabel = page.createElement('span'), registrationValue = page.createElement('span'); registrationLabel.textContent = 'Business Registration No. '; registration.replaceChildren(registrationLabel, registrationValue); text(registrationValue, 'registration', 'Registration number', 100);
    text(page.querySelector('.client'), 'customerName', 'Client / company name', 240); text(page.querySelector('.address'), 'customerAddress', 'Client address and contact details', 2000);
    const project = page.querySelector('.project'), projectValue = page.createElement('span'); project.replaceChildren(page.createTextNode('Project reference: '), projectValue); text(projectValue, 'project', 'Project name', 500);
    const metadata = page.querySelector('.billing dl');
    const dateRow = (label, key) => { const dt = page.createElement('dt'), dd = page.createElement('dd'); dt.textContent = label; input(dd, key, label, 'date'); return [dt, dd]; };
    const number = metadata.querySelector('dd')?.textContent; metadata.replaceChildren(); const nLabel = page.createElement('dt'), nValue = page.createElement('dd'); nLabel.textContent = invoice ? 'Invoice No.' : 'Quotation No.'; nValue.textContent = number; metadata.append(nLabel, nValue, ...dateRow('Issue Date', 'issueDate'), ...dateRow(invoice ? 'Payment Due' : 'Valid Until', deadline));
    const currencyLabel = page.createElement('dt'), currency = page.createElement('dd'); currencyLabel.textContent = 'Currency'; currency.textContent = 'MYR'; metadata.append(currencyLabel, currency);
    page.querySelectorAll('tbody tr').forEach((row, i) => {
      text(row.querySelector('.description'), 'description', 'Item description ' + (i + 1), 5000, i);
      const rateCell = row.querySelector('.rate'), qty = page.createElement('div'), price = page.createElement('div'); rateCell.replaceChildren(qty, price); input(qty, 'quantity', 'Quantity ' + (i + 1), 'number', i); const label = page.createElement('div'); label.className = 'paper-hint'; label.textContent = 'Qty · unit rate RM'; rateCell.append(label); input(price, 'rate', 'Not priced', 'text', i);
      if (original.items.length > 1) { const remove = page.createElement('button'); remove.type = 'button'; remove.className = 'paper-remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove item ' + (i + 1)); remove.onclick = () => onRemove(i); row.firstElementChild.append(remove); }
    });
    for (const [key, title, max] of [['paymentInstructions','PAYMENT INSTRUCTIONS',3000],['terms','TERMS & SCOPE NOTES',20000]]) {
      let node = [...page.querySelectorAll('.notes')].find(n => n.querySelector('h3').textContent === title)?.querySelector('p');
      if (!node) { const section = page.createElement('section'), heading = page.createElement('h3'); section.className = 'notes'; heading.textContent = title; node = page.createElement('p'); section.append(heading, node); page.querySelector('main').insertBefore(section, page.querySelector('.thanks')); }
      text(node, key, key === 'terms' ? 'Add terms and scope notes (optional)' : 'Add payment instructions (optional)', max);
    }
    function totals() {
      let sum = 0, valid = true; original.items.forEach((item,i) => { const rate = rates[i]?.trim() || ''; const ok = /^\d+(\.\d{1,2})?$/.test(rate) && Number(rate) <= 9999999.99 && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 10000; valid = valid && ok; const amount = ok ? Math.round(Number(rate) * 100) * item.quantity : null; sum += amount || 0; page.querySelectorAll('tbody .amount')[i].textContent = doc.money(amount); });
      page.querySelector('.subtotal span:last-child').textContent = doc.money(valid ? sum : null); page.querySelector('.total span:last-child').textContent = doc.money(valid ? sum - (invoice ? doc.paid(record) : 0) : null);
      page.querySelector('.thanks').textContent = 'Thank you for ' + (invoice ? 'choosing' : 'considering') + ' ' + original.issuerName + '.';
    }
    totals(); resize(); page.body.dataset.editable = 'true';
  });
  return frame;
};
