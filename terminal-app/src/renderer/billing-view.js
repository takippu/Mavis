'use strict';
window.MT.createBillingView = (kind, doc) => {
  const MT = window.MT, isInvoice = kind === 'invoices', singular = isInvoice ? 'invoice' : 'quotation', plural = isInvoice ? 'Invoices' : 'Quotations', draftKey = 'mavis-' + singular + '-draft';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const btn = (text, action, primary = false) => { const b = el('button', 'ws-button' + (primary ? ' ws-primary' : ''), text); b.type = 'button'; b.onclick = action; return b; };
  const request = async (action, values) => { const r = await window.mavis.workspace(isInvoice && action === 'backup' ? 'freelance-backup' : kind + '-' + action, values); if (r?.error) throw Object.assign(Error(r.error), { code: r.code }); return r; };
  let host, content, records = [], clients = [], draft = null, notice = '', busy = false, preview = false, query = '', archived = false, sequence = 0;
  let invoiceFilter = 'all', reverseId = null, draftBackedUp = true, paymentsBackedUp = true;
  const paymentKey = 'mavis-invoice-payment-drafts'; let paymentDrafts = {};
  if (isInvoice) try { paymentDrafts = JSON.parse(localStorage.getItem(paymentKey)) || {}; } catch {}
  try {
    const recovered = JSON.parse(localStorage.getItem(draftKey));
    if (recovered?.dirty && Array.isArray(recovered.values?.items) && Array.isArray(recovered.rates)) { draft = recovered; preview = true; }
  } catch {}
  function remember() { try { if (draft?.dirty) localStorage.setItem(draftKey, JSON.stringify(draft)); else localStorage.removeItem(draftKey); draftBackedUp = true; } catch { draftBackedUp = false; notice = 'Draft backup is unavailable. Save before leaving this screen.'; } }
  async function discardOK() { return !draft?.dirty || await MT.confirm({ title: 'Discard ' + singular + ' changes?', message: 'Your unsaved ' + singular + ' changes will be discarded.', okLabel: 'Discard changes' }); }
  function edit(record) { draft = { id: record?.id || null, revision: record?.revision, number: record?.number, status: record?.status || 'draft', payments: record?.payments || [], activity: record?.activity || [], quotationId: record?.quotationId, quotationNumber: record?.quotationNumber, quotationRevision: record?.quotationRevision, values: structuredClone(record.values), rates: record.values.items.map(i => i.unitSen == null ? '' : (i.unitSen / 100).toFixed(2)), dirty: false }; preview = true; notice = ''; remember(); paint(); }
  async function cancelDraft() {
    if (busy) return;
    const saved = !!draft.id, issued = isInvoice && draft.status === 'issued';
    if ((saved || draft.dirty) && !await MT.confirm({ title: issued ? 'Discard invoice changes?' : 'Cancel this ' + singular + ' draft?', message: issued ? 'Your saved invoice and payment history will stay as they are.' : saved ? 'The saved draft will be ' + (isInvoice ? 'voided' : 'archived') + '. Its number and history are retained.' : 'This unsaved draft will be removed from this Mac.', okLabel: issued ? 'Discard changes' : 'Cancel draft' })) return;
    await attempt(async () => {
      if (issued) { const record = (await request('list')).invoices.find(r => r.id === draft.id); if (!record) throw Error('This invoice is no longer available.'); accept(record); notice = 'Unsaved changes discarded.'; return; }
      if (saved) await request(isInvoice ? 'void' : 'archive', { id: draft.id, revision: draft.revision, archived: true });
      draft = null; remember(); preview = false; records = (await request('list'))[kind]; notice = 'Draft cancelled.';
    });
  }
  async function start(arg) { if (busy || !await discardOK()) return; await attempt(async () => { const result = await request('start', arg || {}); edit(result); }); }
  async function attempt(action) {
    if (busy) return; busy = true; notice = ''; paint();
    try { await action(); } catch (e) { notice = e.message; if (e.code === (isInvoice ? 'INVOICES_CONFLICT' : 'QUOTATIONS_CONFLICT')) { try { records = (await request('list'))[kind]; } catch {} } }
    finally { busy = false; if (host?.isConnected) paint(); }
  }
  function values() {
    const v = structuredClone(draft.values);
    v.items.forEach((i, n) => { const rate = draft.rates[n].trim(); if (rate !== '' && !/^\d+(\.\d{1,2})?$/.test(rate)) throw Error('Enter item rates with up to two decimal places.'); i.unitSen = rate === '' ? null : Math.round(Number(rate) * 100); });
    return doc.validate(v);
  }
  function accept(record) { const showing = preview; edit(record); preview = showing; }
  async function saveRecord() {
    const q = await request('save', { id: draft.id, revision: draft.revision, values: values(), quotationId: draft.quotationId, quotationRevision: draft.quotationRevision });
    accept(q); records = (await request('list'))[kind]; return q;
  }
  async function save(exportPDF) {
    if (isInvoice && exportPDF) return attempt(async () => { doc.ready(values()); const q = draft.dirty ? await saveRecord() : draft; const r = await request('export', { id: q.id, revision: q.revision }); notice = r.ok ? 'PDF exported to ' + r.file : 'PDF export cancelled.'; });
    const form = host.querySelector('.ws-quote-form'); if (form && !form.reportValidity()) return;
    await attempt(async () => {
      const v = values(); if (exportPDF) doc.ready(v);
      const q = await saveRecord(); notice = isInvoice && draft.status === 'issued' ? 'Invoice changes saved.' : plural.slice(0, -1) + ' draft saved.';
      if (exportPDF) { const result = await request('export', { id: q.id, revision: q.revision }); notice = result.ok ? 'PDF exported to ' + result.file : plural.slice(0, -1) + ' saved. PDF export cancelled.'; }
    });
  }
  async function finalise() {
    try { doc.ready(values()); } catch (e) { notice = e.message; paint(); return; }
    if (!await MT.confirm({ title: 'Finalise this invoice?', message: 'Finalise this invoice for ' + doc.money(doc.total(values())) + ' and start recording payments. You can save billing changes afterwards. Nothing is sent to the client.', okLabel: 'Finalise invoice', danger: false })) return;
    await attempt(async () => { const q = await saveRecord(); accept(await request('issue', { id: q.id, revision: q.revision })); preview = false; notice = 'Invoice finalised.'; });
  }
  async function convert(view) {
    await attempt(async () => { window.QuotationDocument.ready(values()); const q = draft.dirty ? await saveRecord() : draft; MT.router.show(view, { quotationId: q.id, quotationRevision: q.revision }); });
  }
  async function load(target, arg) {
    host = target; const token = ++sequence; host.replaceChildren(el('p', 'ws-leads-loading', 'Loading ' + kind + '…'));
    try {
      const result = await request('list'); if (token !== sequence || !target.isConnected) return; records = result[kind]; clients = result.clients || [];
      if (arg?.id) { const r = records.find(r => r.id === arg.id); if (!r) throw Error('This record is no longer available.'); if (await discardOK()) edit(r); else paint(); } else if (arg?.leadId || arg?.clientId || arg?.quotationId) { await start(arg); } else paint();
    } catch (e) { if (token === sequence && target.isConnected) target.replaceChildren(el('h1', '', plural), el('p', 'ws-leads-error', e.message), btn('Retry', () => load(target, arg))); }
  }
  function paint() {
    if (!host?.isConnected) return;
    const oldBody = host.querySelector('.ws-billing-body'), key = (draft?.id || 'new') + ':' + preview, scroll = oldBody?.dataset.scrollKey === key ? oldBody.scrollTop : 0;
    host.replaceChildren(); host.className = 'ws-quotations' + (isInvoice ? ' ws-invoices' : '');
    const header = el('header', 'ws-leads-header'), title = el('div'); title.append(el('h1', '', plural), el('p', 'ws-leads-sub', isInvoice ? 'Invoice your work and track payments received.' : 'Draft a TRLABS quotation and export an A4 PDF.'));
    const actions = el('div', 'ws-leads-actions');
    if (draft) {
      actions.append(btn('All ' + kind, async () => { if (await discardOK()) { draft = null; remember(); preview = false; notice = ''; paint(); } }), btn(preview ? isInvoice && draft.status !== 'draft' ? 'Payment details' : 'Document settings' : isInvoice && draft.status !== 'draft' ? 'View document' : 'Edit document', () => { try { if (isInvoice && draft.status === 'issued' && draft.dirty && preview) { notice = 'Save invoice changes before opening payment details.'; paint(); return; } values(); preview = !preview; notice = ''; } catch (e) { notice = e.message; } paint(); }));
      if (!isInvoice || draft.status !== 'void') actions.append(btn(isInvoice && draft.status === 'issued' ? 'Save changes' : 'Save draft', () => save(false)));
      if (!isInvoice || draft.status !== 'void') actions.append(btn(isInvoice && draft.status === 'issued' ? 'Discard changes' : 'Cancel draft', cancelDraft));
      if (isInvoice && doc.status(draft) === 'paid') actions.append(btn('View receipt', () => MT.router.show('receipts', { id: draft.id })));
      if (isInvoice && draft.status === 'draft') actions.append(btn('Finalise invoice', finalise, true));
      else if (!isInvoice || draft.status === 'issued') actions.append(btn('Export PDF', () => save(true), true));
      if (!isInvoice && draft.id) actions.append(btn('Create invoice', () => convert('invoices')), btn('Create project tasks', () => convert('jobs')));
      if (isInvoice && draft.id) actions.append(btn('Refresh invoice', () => attempt(async () => { const r = (await request('list')).invoices.find(i => i.id === draft.id); if (r && await discardOK()) accept(r); })));
    }
    else actions.append(btn('Export backup', () => attempt(async () => { const r = await request('backup'); if (r.ok) notice = isInvoice ? 'Freelance backup exported.' : 'Quotation backup exported.'; })), btn('New ' + singular, () => start(), true));
    header.append(title, actions); host.append(header);
    if (notice) { const n = el('p', 'ws-leads-notice', notice); n.setAttribute('role', 'status'); host.append(n); }
    if (draft) {
      const caption = el('div', 'ws-quote-caption'); caption.append(el('strong', '', draft.number || 'New draft'), el('span', 'ws-leads-sub', draft.dirty ? 'Unsaved changes kept on this Mac' : 'Saved locally'));
      if (draft.values.leadId) caption.append(btn('View linked lead', () => MT.router.show('leads', { leadId: draft.values.leadId })));
      if (draft.values.clientId) caption.append(btn('View client', () => MT.router.show('clients', { id: draft.values.clientId })));
      if (isInvoice && draft.quotationId) caption.append(btn('From ' + draft.quotationNumber, () => MT.router.show('quotations', { id: draft.quotationId })));
      if (isInvoice) { const badge = el('span', 'ws-billing-status', doc.labels[doc.status(draft)]); badge.dataset.status = doc.status(draft); caption.append(badge); }
      host.append(caption);
    }
    const body = el('div', 'ws-billing-body'); body.tabIndex = 0; body.setAttribute('aria-label', draft ? singular + (preview ? ' document' : ' details') : kind + ' list'); body.dataset.scrollKey = key;
    content = body; host.append(body);
    if (!draft) listing();
    else if (preview) documentEditor();
    else if (isInvoice && draft.status !== 'draft') invoiceDetails();
    else editor();
    body.scrollTop = scroll;
    for (const control of host.querySelectorAll('button,input,select,textarea')) control.disabled = busy || control.dataset.minimumItem === 'true';
  }
  function listing() {
    const controls = el('div', 'ws-leads-controls'), search = el('input', 'ws-input'), scope = el('select', 'ws-input'); search.type = 'search'; search.placeholder = 'Search ' + kind; search.setAttribute('aria-label', 'Search ' + kind); search.value = query;
    for (const [value, label] of (isInvoice ? [['all', 'All invoices'], ...Object.entries(doc.labels)] : [['active', 'All ' + kind], ['archived', 'Archived']])) { const o = el('option', '', label); o.value = value; scope.append(o); } scope.value = isInvoice ? invoiceFilter : archived ? 'archived' : 'active'; scope.setAttribute('aria-label', 'Filter ' + kind);
    controls.append(search, scope); content.append(controls); const list = el('div', 'ws-quote-list'); content.append(list);
    const render = () => {
      list.replaceChildren(); const filtered = records.filter(q => (isInvoice ? invoiceFilter === 'all' || doc.status(q) === invoiceFilter : q.archived === archived) && [q.number, q.values.project, q.values.customerName].join(' ').toLowerCase().includes(query.toLowerCase()));
      if (!filtered.length) { const empty = el('div', 'ws-leads-empty'); empty.append(el('h2', '', records.length ? 'No matching ' + kind : 'Your first ' + singular), el('p', 'ws-leads-sub', isInvoice ? 'Create an invoice here or from a saved quotation.' : 'Create one here or open a lead and choose Create quotation.')); list.append(empty); return; }
      for (const q of filtered) {
        const row = el('article', 'ws-quote-row'), details = el('div'); details.append(btn(q.number + ' · ' + (q.values.project || 'Untitled project'), () => { edit(q); }), el('p', 'ws-leads-sub', (q.values.customerName || 'Client not set') + ' · ' + q.values.issueDate));
        const actions = el('div', 'ws-leads-actions');
        if (isInvoice) { const badge = el('span', 'ws-billing-status', doc.labels[doc.status(q)]); badge.dataset.status = doc.status(q); actions.append(badge, el('strong', 'ws-lead-value', doc.money(doc.balance(q)) + ' due')); }
        else actions.append(el('strong', 'ws-lead-value', doc.money(doc.total(q.values))), btn(q.archived ? 'Restore' : 'Archive', () => attempt(async () => { await request('archive', { id: q.id, revision: q.revision, archived: !q.archived }); records = (await request('list'))[kind]; })));
        row.append(details, actions); list.append(row);
      }
    };
    search.oninput = () => { query = search.value; render(); }; scope.onchange = () => { if (isInvoice) invoiceFilter = scope.value; else archived = scope.value === 'archived'; render(); }; render();
  }
  function changed() { draft.dirty = true; notice = ''; host.querySelector('.ws-leads-notice')?.remove(); remember(); const state = host.querySelector('.ws-quote-caption .ws-leads-sub'); if (state) state.textContent = 'Unsaved changes kept on this Mac'; }
  function field(name, label, type = 'text', full = false, parent) {
    const wrap = el('label', 'ws-lead-field' + (full ? ' full' : '')), input = el(type === 'textarea' ? 'textarea' : 'input', 'ws-input'); input.name = name; input.id = 'quote-' + name; wrap.htmlFor = input.id; wrap.append(el('span', '', label));
    if (type === 'textarea') { input.rows = ['terms', 'paymentInstructions'].includes(name) ? 5 : 3; } else input.type = type;
    input.value = draft.values[name]; input.maxLength = { project: 500, customerName: 240, customerAddress: 2000, terms: 20000, paymentInstructions: 3000, issuerName: 160, registration: 100 }[name] || 100;
    if (['issuerName', 'issueDate'].includes(name)) input.required = true;
    if (['validUntil', 'dueDate'].includes(name)) input.min = draft.values.issueDate;
    input.oninput = () => { draft.values[name] = input.value; if (name === 'issueDate') host.querySelector(isInvoice ? '[name="dueDate"]' : '[name="validUntil"]').min = input.value; changed(); }; wrap.append(input); parent.append(wrap);
  }
  function editor() {
    const form = el('form', 'ws-quote-form'), grid = el('div', 'ws-lead-fields'); form.onsubmit = e => { e.preventDefault(); save(false); };
    const clientLabel = el('label', 'ws-lead-field full'), client = el('select', 'ws-input'); clientLabel.append(el('span', '', 'Saved client (optional)')); client.setAttribute('aria-label', 'Saved client');
    const none = el('option', '', 'Enter client details manually'); none.value = ''; client.append(none);
    for (const c of clients.filter(c => !c.archived || c.id === draft.values.clientId)) { const o = el('option', '', c.values.name); o.value = c.id; client.append(o); } client.value = draft.values.clientId || '';
    client.onchange = () => { draft.values.clientId = client.value || null; const c = clients.find(c => c.id === client.value)?.values; if (c) { draft.values.customerName = c.company || c.name; draft.values.customerAddress = [c.address, c.contact, c.email, c.phone].filter(Boolean).join('\n'); } changed(); paint(); }; clientLabel.append(client); grid.append(clientLabel);
    for (const args of [['project', 'Project reference', 'text', true], ['customerName', 'Client / company name'], ['issueDate', 'Issue date', 'date'], ['customerAddress', 'Client address / contact details', 'textarea'], [isInvoice ? 'dueDate' : 'validUntil', isInvoice ? 'Payment due date' : 'Valid until (optional)', 'date']]) field(args[0], args[1], args[2], args[3], grid);
    form.append(grid);
    conversionControls(form);
    form.append(el('h2', '', 'Items'), el('p', 'ws-leads-sub', 'Rates are in MYR. Leave a rate blank while pricing is still undecided.'));
    const items = el('div', 'ws-quote-items');
    draft.values.items.forEach((item, index) => {
      const row = el('div', 'ws-quote-item'); row.dataset.item = String(index);
      for (const [name, label, value, type] of [['description', 'Description ' + (index + 1), item.description, 'textarea'], ['quantity', 'Quantity ' + (index + 1), item.quantity, 'number'], ['rate', 'Unit rate (RM) ' + (index + 1), draft.rates[index], 'text']]) {
        const wrap = el('label', 'ws-lead-field'), input = el(type === 'textarea' ? 'textarea' : 'input', 'ws-input'); input.name = 'item-' + index + '-' + name; input.id = 'quote-' + input.name; wrap.htmlFor = input.id; wrap.append(el('span', '', label)); input.value = value;
        if (type === 'textarea') { input.rows = 3; input.maxLength = 5000; } else input.type = type;
        if (name === 'quantity') { input.min = '1'; input.max = '10000'; input.step = '1'; input.required = true; }
        if (name === 'rate') { input.inputMode = 'decimal'; input.placeholder = 'Not priced'; input.pattern = '\\d+(\\.\\d{1,2})?'; }
        input.oninput = () => { if (name === 'rate') draft.rates[index] = input.value; else item[name] = name === 'quantity' ? Number(input.value) : input.value; changed(); updateTotal(); }; wrap.append(input); row.append(wrap);
      }
      const remove = btn('Remove item ' + (index + 1), () => { draft.values.items.splice(index, 1); draft.rates.splice(index, 1); changed(); paint(); }); remove.disabled = draft.values.items.length === 1; remove.dataset.minimumItem = String(draft.values.items.length === 1); row.append(remove); items.append(row);
    });
    form.append(items, btn('Add item', () => { if (draft.values.items.length >= 100) { notice = 'A quotation supports up to 100 items.'; paint(); return; } draft.values.items.push({ description: '', quantity: 1, unitSen: null }); draft.rates.push(''); changed(); paint(); host.querySelector('.ws-quote-item:last-child textarea')?.focus(); }));
    const summary = el('p', 'ws-quote-total'); summary.setAttribute('aria-live', 'polite'); form.append(summary);
    function updateTotal() { try { summary.textContent = 'Total · ' + doc.money(doc.total(values())); } catch { summary.textContent = 'Check item quantities and rates'; } } updateTotal();
    const notes = el('div', 'ws-lead-fields'); field('terms', 'Terms and scope notes (optional)', 'textarea', true, notes); field('paymentInstructions', 'Payment instructions (optional)', 'textarea', true, notes);
    const company = el('details', 'ws-quote-company'); company.append(el('summary', '', 'Company details · TRLABS invoice template')); const companyFields = el('div', 'ws-lead-fields'); field('issuerName', 'Company name', 'text', false, companyFields); field('registration', 'Business registration number', 'text', false, companyFields); company.append(companyFields);
    form.append(notes, company); content.append(form);
  }
  function conversionControls(parent) {
    if (isInvoice && draft.quotationId) {
      const source = el('div', 'ws-billing-conversion'), percent = el('input', 'ws-input'), label = el('input', 'ws-input'); percent.type = 'number'; percent.min = '.01'; percent.max = '100'; percent.step = '.01'; percent.value = '100'; percent.setAttribute('aria-label', 'Percentage of quotation'); label.placeholder = 'Deposit or milestone name'; label.maxLength = 160; label.setAttribute('aria-label', 'Billing label');
      source.append(el('p', 'ws-leads-sub', 'Bill the full quotation or replace items with a named deposit/milestone percentage.'), percent, label, btn('Apply quotation amount', () => { const basisPoints = Math.round(Number(percent.value) * 100), billingLabel = label.value; attempt(async () => { const r = await request('start', { quotationId: draft.quotationId, quotationRevision: draft.quotationRevision, basisPoints, billingLabel }); draft.values.items = r.values.items; draft.rates = r.values.items.map(i => (i.unitSen / 100).toFixed(2)); changed(); }); })); parent.append(source);
    }
  }
  function documentEditor() {
    const locked = isInvoice && draft.status === 'void';
    if (!locked) {
      if (!isInvoice || draft.status === 'draft') conversionControls(content);
      const toolbar = el('div', 'ws-document-toolbar'); toolbar.append(el('p', 'ws-leads-sub', 'Click text on the page to edit. Amounts recalculate as you type.'));
      toolbar.append(btn('Add item', () => { if (draft.values.items.length >= 100) { notice = 'This document supports up to 100 items.'; paint(); return; } draft.values.items.push({ description: '', quantity: 1, unitSen: null }); draft.rates.push(''); changed(); paint(); }));
      const client = el('select', 'ws-input'); client.setAttribute('aria-label', 'Use saved client'); const blank = el('option', '', 'Use saved client…'); blank.value = ''; client.append(blank); for (const c of clients.filter(c => !c.archived)) { const option = el('option', '', c.values.name); option.value = c.id; client.append(option); }
      client.value = draft.values.clientId || ''; client.onchange = () => { const c = clients.find(c => c.id === client.value)?.values; draft.values.clientId = client.value || null; if (c) { draft.values.customerName = c.company || c.name; draft.values.customerAddress = [c.address,c.contact,c.email,c.phone].filter(Boolean).join('\n'); } changed(); paint(); }; toolbar.append(client); content.append(toolbar);
    }
    const paper = el('div', 'ws-document-paper');
    paper.append(MT.createDocumentEditor({ doc, record: draft, rates: draft.rates, invoice: isInvoice, locked: locked || busy, onChange: changed, onError: message => { notice = message; const status = host.querySelector('.ws-document-error'); if (status) status.textContent = message; }, onRemove: index => { draft.values.items.splice(index,1); draft.rates.splice(index,1); changed(); paint(); } })); content.append(paper);
    const status = el('p', 'ws-document-error ws-leads-error'); status.setAttribute('role','status'); content.append(status, el('p','ws-leads-sub','PDF export uses this template and adds page breaks and page numbers.'));
  }
  function rememberPayments() { try { if (Object.keys(paymentDrafts).length) localStorage.setItem(paymentKey, JSON.stringify(paymentDrafts)); else localStorage.removeItem(paymentKey); paymentsBackedUp = true; } catch { paymentsBackedUp = false; notice = 'Payment draft backup is unavailable. Keep this screen open until you record it.'; } }
  async function recordPayment(p, amountSen) {
    const id = draft.id, revision = draft.revision;
    await attempt(async () => {
      const r = await request('payment', { id, revision, values: { amountSen, date: p.date, method: p.method, reference: p.reference, notes: p.notes, requestId: p.requestId } });
      delete paymentDrafts[id]; rememberPayments(); accept(r); records = (await request('list')).invoices; notice = 'Payment recorded.';
      if (doc.status(r) === 'paid') await MT.router.show('receipts', { id: r.id });
    });
  }
  function invoiceDetails() {
    const section = el('section', 'ws-invoice-details'); section.append(el('h2', '', draft.values.project), el('p', '', draft.values.customerName));
    const summary = el('dl', 'ws-lead-summary'); for (const [key, value] of [['Invoice total', doc.money(doc.total(draft.values))], ['Payments received', doc.money(doc.paid(draft))], ['Remaining balance', doc.money(doc.balance(draft))], ['Payment due', draft.values.dueDate]]) summary.append(el('dt', '', key), el('dd', '', value)); section.append(summary);
    if (draft.status === 'issued') {
      const voidButton = btn('Void invoice', async () => { if (await MT.confirm({ title: 'Void ' + draft.number + '?', message: 'This removes it from outstanding totals and blocks further payment entries. Its history is retained.', okLabel: 'Void invoice' })) attempt(async () => { accept(await request('void', { id: draft.id, revision: draft.revision })); }); }); section.append(voidButton);
      if (doc.balance(draft) > 0) {
        section.append(el('h2', '', 'Record payment received'), el('p', 'ws-leads-sub', 'Record a payment already received. This updates tracking on this Mac.'));
        const p = paymentDrafts[draft.id] || { amount: '', date: doc.today(), method: '', reference: '', notes: '', requestId: crypto.randomUUID() }, form = el('form', 'ws-payment-form'), grid = el('div', 'ws-lead-fields');
        for (const [key, label, type] of [['amount', 'Amount received (RM)', 'text'], ['date', 'Payment date', 'date'], ['method', 'Method (optional)', 'text'], ['reference', 'Reference (optional)', 'text'], ['notes', 'Notes (optional)', 'text']]) {
          const wrap = el('label', 'ws-lead-field'), input = el('input', 'ws-input'); wrap.append(el('span', '', label)); input.type = type; input.name = 'payment-' + key; input.value = p[key]; input.required = ['amount', 'date'].includes(key); input.maxLength = { method: 80, reference: 240, notes: 2000 }[key] || 100;
          if (key === 'amount') { input.inputMode = 'decimal'; input.pattern = '\\d+(\\.\\d{1,2})?'; } if (key === 'date') input.max = doc.today();
          input.oninput = () => { p[key] = input.value; paymentDrafts[draft.id] = p; rememberPayments(); }; wrap.append(input); grid.append(wrap);
        }
        const submit = el('button', 'ws-button ws-primary', 'Record payment'); submit.type = 'submit';
        const actions = el('div', 'ws-leads-actions'); actions.append(submit, btn('Mark fully paid', async () => {
          const amount = doc.balance(draft);
          if (!await MT.confirm({ title: 'Mark this invoice fully paid?', message: 'Record ' + doc.money(amount) + ' already received on ' + p.date + ', clear the remaining balance and open the receipt.', okLabel: 'Mark fully paid', danger: false })) return;
          await recordPayment(p, amount);
        }));
        actions.append(btn('Discard payment draft', async () => { if (!await MT.confirm({ title: 'Discard payment draft?', message: 'Only the unrecorded payment form will be cleared. Recorded payments are retained.', okLabel: 'Discard draft' })) return; delete paymentDrafts[draft.id]; rememberPayments(); paint(); }));
        form.append(grid, actions); section.append(form);
        form.onsubmit = e => { e.preventDefault(); if (form.reportValidity()) recordPayment(p, Math.round(Number(p.amount) * 100)); };
      }
    }
    section.append(el('h2', '', 'Payment history')); const history = el('div', 'ws-payment-history');
    if (!draft.payments.length) history.append(el('p', 'ws-leads-sub', 'No payments recorded.'));
    for (const p of draft.payments) {
      const entry = el('article', 'ws-payment-entry'); entry.append(el('strong', '', doc.money(p.amountSen) + ' · ' + p.date), el('p', 'ws-leads-sub', [p.method, p.reference, p.notes].filter(Boolean).join(' · ')));
      if (p.voidedAt) entry.append(el('p', '', 'Entry reversed · ' + p.voidReason));
      else {
        entry.append(btn('Correct payment record', () => { reverseId = reverseId === p.id ? null : p.id; paint(); }));
        if (reverseId === p.id) { const form = el('form'), reason = el('input', 'ws-input'), submit = el('button', 'ws-button', 'Reverse entry'); reason.required = true; reason.maxLength = 2000; reason.placeholder = 'Reason for correcting this entry'; reason.setAttribute('aria-label', 'Correction reason'); submit.type = 'submit'; form.append(reason, submit); entry.append(form);
          form.onsubmit = async e => { e.preventDefault(); const text = reason.value; if (!form.reportValidity() || !await MT.confirm({ title: 'Reverse this payment entry?', message: 'This corrects the recorded balance and keeps the original entry. It does not refund a payment.', okLabel: 'Reverse entry' })) return; attempt(async () => { accept(await request('reverse', { id: draft.id, revision: draft.revision, paymentId: p.id, reason: text })); reverseId = null; notice = 'Payment entry reversed.'; }); };
        }
      }
      history.append(entry);
    }
    section.append(history); if (draft.activity.length) { section.append(el('h2', '', 'Invoice activity')); const activity = el('ol', 'ws-lead-activity'); for (const a of draft.activity) { const li = el('li'); li.append(el('time', 'ws-leads-sub', new Date(a.at).toLocaleString('en-MY')), el('p', '', a.text)); activity.append(li); } section.append(activity); } content.append(section);
  }
  const hasDraft = () => !!draft?.dirty || isInvoice && Object.keys(paymentDrafts).length > 0;
  return { render: load, hasDraft, beforeClose: async () => !((draft?.dirty && !draftBackedUp) || (isInvoice && Object.keys(paymentDrafts).length && !paymentsBackedUp)) || await MT.confirm({ title: 'Draft backup unavailable', message: 'These unsaved edits could not be backed up. Save or discard them before closing to avoid losing your work.', okLabel: 'Close without backup', cancelLabel: 'Keep working' }) };
};
