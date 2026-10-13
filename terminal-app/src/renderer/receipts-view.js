'use strict';
(() => {
  const MT = window.MT, doc = window.ReceiptDocument;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const btn = (label, action, primary = false) => { const b = el('button', 'ws-button' + (primary ? ' ws-primary' : ''), label); b.type = 'button'; b.onclick = action; return b; };
  let host, records = [], selected = null, sequence = 0, notice = '', busy = false;
  async function load(target, arg) {
    host = target; const token = ++sequence; host.replaceChildren(el('p', 'ws-leads-loading', 'Loading receipts...'));
    try {
      const r = await window.mavis.workspace('invoices-list'); if (r.error) throw Error(r.error);
      if (token !== sequence || !target.isConnected) return;
      records = r.invoices.filter(i => { try { doc.checkRecord(i); return true; } catch { return false; } });
      selected = arg?.id || null; notice = selected && !records.some(i => i.id === selected) ? 'This invoice is no longer fully paid. Open its payment details to check the balance.' : ''; paint();
    } catch (e) { if (token === sequence && target.isConnected) target.replaceChildren(el('p', 'ws-leads-error', e.message), btn('Retry', () => load(target, arg))); }
  }
  function paint() {
    if (!host?.isConnected) return;
    host.replaceChildren(); host.className = 'ws-quotations ws-receipts';
    const record = records.find(i => i.id === selected), header = el('header', 'ws-leads-header'), title = el('div');
    title.append(el('h1', '', 'Receipts'), el('p', 'ws-leads-sub', 'Payment receipts from fully paid invoices.'));
    const actions = el('div', 'ws-leads-actions');
    if (record) actions.append(btn('All receipts', () => { selected = null; notice = ''; paint(); }), btn('View invoice', () => MT.router.show('invoices', { id: record.id })), btn('Export receipt PDF', async () => {
      if (busy) return; busy = true; notice = ''; paint();
      try { const r = await window.mavis.workspace('invoices-receipt', { id: record.id, revision: record.revision }); if (r.error) throw Error(r.error); notice = r.ok ? 'Receipt exported to ' + r.file : 'Receipt export cancelled.'; }
      catch (e) { notice = e.message; } finally { busy = false; paint(); }
    }, true));
    else actions.append(btn('View invoices', () => MT.router.show('invoices')));
    header.append(title, actions); host.append(header);
    if (notice) { const n = el('p', 'ws-leads-notice', notice); n.setAttribute('role', 'status'); host.append(n); }
    const body = el('div', 'ws-billing-body'); body.tabIndex = 0; body.setAttribute('aria-label', record ? 'Receipt document' : 'Receipts list'); host.append(body);
    if (record) {
      const caption = el('div', 'ws-quote-caption'); caption.append(el('strong', '', doc.number(record)), el('span', 'ws-billing-status', 'Paid in full')); caption.lastChild.dataset.status = 'paid'; host.insertBefore(caption, body);
      const paper = el('div', 'ws-document-paper'), frame = el('iframe', 'ws-quote-preview'); frame.title = 'Receipt ' + doc.number(record); frame.setAttribute('sandbox', 'allow-same-origin'); frame.srcdoc = doc.render(record);
      frame.onload = () => { frame.style.height = Math.max(1123, frame.contentDocument?.documentElement.scrollHeight + 4 || 0) + 'px'; }; paper.append(frame); body.append(paper);
    } else if (!records.length) body.append(el('h2', '', 'No receipts yet'), el('p', 'ws-leads-sub', 'Mark an invoice fully paid to open its receipt here.'));
    else { const list = el('div', 'ws-quote-list'); for (const i of records) { const row = el('article', 'ws-quote-row'), details = el('div'); details.append(btn(doc.number(i) + ' · ' + i.values.project, () => { selected = i.id; notice = ''; paint(); }), el('p', 'ws-leads-sub', i.values.customerName + ' · ' + i.number)); row.append(details, el('strong', 'ws-lead-value', window.InvoiceDocument.money(window.InvoiceDocument.paid(i)))); list.append(row); } body.append(list); }
    for (const b of host.querySelectorAll('button')) b.disabled = busy;
  }
  MT.receipts = { render: load };
})();
