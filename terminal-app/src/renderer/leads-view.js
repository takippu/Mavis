'use strict';
(() => {
  const MT = window.MT;
  const stages = [['new', 'New'], ['discussing', 'In discussion'], ['quoted', 'Quoted'], ['won', 'Won'], ['lost', 'Lost']];
  const money = sen => sen === null ? 'Not priced yet' : new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(sen / 100);
  const today = () => { const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); };
  const dateLabel = date => new Date(date + 'T12:00:00').toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const request = async (action, payload) => { const r = await window.mavis.workspace('leads-' + action, payload); if (r?.error) throw Object.assign(new Error(r.error), { code: r.code }); return r; };
  const btn = (text, action, primary = false) => { const b = el('button', 'ws-button' + (primary ? ' ws-primary' : ''), text); b.type = 'button'; b.onclick = action; return b; };
  let selected = null, query = '', scope = 'active', view = 'board', records = [], host, sequence = 0, notice = '', draft = null, busy = false;
  let expanded = false;
  const noteDrafts = new Map();
  function closeDetails() {
    const id = selected; selected = null; expanded = false; paint();
    host.querySelector('[data-lead-id="' + id + '"]')?.focus();
  }
  function expandControl() {
    const control = btn(expanded ? 'Show pipeline' : 'Expand details', () => {
      expanded = !expanded;
      host.querySelector('.ws-leads-layout').classList.toggle('detail-expanded', expanded);
      control.textContent = expanded ? 'Show pipeline' : 'Expand details';
      control.setAttribute('aria-pressed', String(expanded));
    });
    control.classList.add('ws-lead-expand'); control.setAttribute('aria-pressed', String(expanded)); return control;
  }
  try { draft = JSON.parse(localStorage.getItem('mavis-lead-draft')); if (!draft || typeof draft.values?.title !== 'string') draft = null; } catch {}
  function rememberDraft() { try { if (draft) localStorage.setItem('mavis-lead-draft', JSON.stringify(draft)); else localStorage.removeItem('mavis-lead-draft'); } catch { notice = 'Draft backup is unavailable. Keep this screen open until you save.'; } }
  function visible() {
    return records.filter(l => (scope === 'archived' ? l.archived : !l.archived) && (scope !== 'due' || (!['won', 'lost'].includes(l.stage) && l.followUp && l.followUp <= today())) && [l.title, l.company, l.contact, l.email, l.phone, l.brief, l.nextStep].join(' ').toLowerCase().includes(query.toLowerCase()));
  }
  async function attempt(action) {
    if (busy) return;
    busy = true; notice = ''; paint();
    try { await action(); } catch (e) { notice = e.message; if (e.code === 'LEADS_CONFLICT') { try { records = (await request('list')).leads; } catch (reloadError) { notice += ' ' + reloadError.message; } } }
    finally { busy = false; if (host?.isConnected) paint(); }
  }
  async function choose(id) {
    if (draft && !await MT.confirm({ title: 'Discard this draft?', message: 'Your unsaved lead changes will be discarded.', okLabel: 'Discard draft' })) return;
    draft = null; rememberDraft(); selected = id; notice = '';
    const body = host.querySelector('.ws-lead-detail-body'); if (body) body.scrollTop = 0;
    paint(); host.querySelector('.ws-lead-detail h2')?.focus();
  }
  async function start(lead) {
    if (draft && !await MT.confirm({ title: 'Discard this draft?', message: 'Your unsaved lead changes will be discarded.', okLabel: 'Discard draft' })) return;
    selected = lead?.id || null;
    draft = { id: lead?.id || null, revision: lead?.revision, values: Object.fromEntries(['title', 'company', 'contact', 'email', 'phone', 'source', 'stage', 'followUp', 'valueSen', 'nextStep', 'brief', 'clientId'].map(k => [k, lead?.[k] ?? (['valueSen','clientId'].includes(k) ? null : k === 'stage' ? 'new' : '')])), valueText: lead?.valueSen == null ? '' : (lead.valueSen / 100).toFixed(2) };
    rememberDraft(); paint(); host.querySelector('[name="title"]')?.focus();
  }
  async function cancelDraft() {
    if (!await MT.confirm({ title: 'Discard this draft?', message: 'Your unsaved lead changes will be discarded.', okLabel: 'Discard draft' })) return;
    draft = null; rememberDraft(); paint();
  }
  async function load(target, arg) {
    host = target; const token = ++sequence; host.replaceChildren(el('p', 'ws-leads-loading', 'Loading leads…'));
    try { const result = await request('list'); if (token !== sequence || !target.isConnected) return; records = result.leads; if (arg?.leadId && !draft) selected = arg.leadId; if (draft) selected = draft.id; if (arg?.clientId && !draft) { const r = await window.mavis.workspace('freelance-list'); if(r.error) throw Error(r.error); const c = r.clients.find(c=>c.id===arg.clientId); if(!c) throw Error('Client is no longer available.'); await start(); Object.assign(draft.values,{clientId:c.id,company:c.values.company,contact:c.values.contact||c.values.name,email:c.values.email,phone:c.values.phone}); rememberDraft(); } paint(); }
    catch (e) { if (token === sequence && target.isConnected) { target.replaceChildren(el('h1', '', 'Leads'), el('p', 'ws-leads-error', e.message), btn('Retry', () => load(target))); } }
  }
  function paint() {
    if (!host?.isConnected) return;
    const scroll = host.querySelector('.ws-lead-detail-body')?.scrollTop || 0;
    host.replaceChildren(); host.className = 'ws-leads';
    host.onkeydown = event => {
      if (event.key === 'Escape' && selected && !draft && !busy && !event.target.closest('input,textarea,select')) { event.preventDefault(); closeDetails(); }
    };
    const header = el('header', 'ws-leads-header'), titles = el('div'); titles.append(el('h1', '', 'Leads'), el('p', 'ws-leads-sub', 'Track enquiries, quotes and your next follow-up.'));
    const actions = el('div', 'ws-leads-actions'); actions.append(btn('Export backup', () => attempt(async () => { const r = await request('export'); if (r.ok) notice = 'Backup exported.'; })), btn('New lead', () => !busy && start(), true)); header.append(titles, actions); host.append(header);
    const controls = el('div', 'ws-leads-controls'), search = el('input', 'ws-input'); search.type = 'search'; search.value = query; search.placeholder = 'Search leads'; search.setAttribute('aria-label', 'Search leads');
    const count = el('span', 'ws-leads-sub');
    const scopeSelect = el('select', 'ws-input'); scopeSelect.setAttribute('aria-label', 'Filter leads');
    for (const [value, label] of [['active', 'All leads'], ['due', 'Follow-ups due'], ['archived', 'Archived']]) { const o = el('option', '', label); o.value = value; scopeSelect.append(o); } scopeSelect.value = scope;
    const toggle = el('div', 'ws-leads-actions'); toggle.setAttribute('aria-label', 'Lead layout');
    for (const [value, label] of [['board', 'Board'], ['table', 'Table']]) { const b = btn(label, () => { view = value; paint(); }); b.setAttribute('aria-pressed', String(view === value)); toggle.append(b); }
    controls.append(search, scopeSelect, count, toggle); host.append(controls);
    if (notice) { const n = el('p', 'ws-leads-notice', notice); n.setAttribute('role', 'status'); host.append(n); }
    const layout = el('div', 'ws-leads-layout'), list = el('section', 'ws-leads-list'); list.setAttribute('aria-label', 'Lead pipeline'); layout.append(list); host.append(layout);
    const paintList = () => {
      const leads = visible(); count.textContent = leads.length + (leads.length === 1 ? ' lead' : ' leads'); list.replaceChildren();
      if (!leads.length) { const empty = el('div', 'ws-leads-empty'); empty.append(el('h2', '', records.length ? 'No matching leads' : 'Your next project starts here'), el('p', 'ws-leads-sub', records.length ? 'Try another search or filter.' : 'Save an enquiry, record what they need, and keep the next step in sight.')); if (!records.length) empty.append(btn('Add your first lead', () => start(), true)); list.append(empty); return; }
      if (view === 'table') { list.append(table(leads)); return; }
      const board = el('div', 'ws-leads-board'); board.tabIndex = 0; board.setAttribute('aria-label', 'Pipeline board. Scroll horizontally to see all stages.');
      for (const [stage, label] of stages) {
        const column = el('section', 'ws-leads-column'), items = leads.filter(l => l.stage === stage), heading = el('h2', '', label); heading.append(el('span', '', String(items.length))); column.dataset.stage = stage; column.append(heading);
        for (const lead of items) {
          const card = btn('', () => !busy && choose(lead.id)); card.className = 'ws-lead-card'; card.dataset.leadId = lead.id; card.dataset.stage = lead.stage; card.setAttribute('aria-label', 'Open ' + lead.title); card.setAttribute('aria-pressed', String(selected === lead.id));
          card.append(el('strong', '', lead.title)); if (lead.company || lead.contact) card.append(el('span', 'ws-leads-sub', lead.company || lead.contact));
          card.append(el('span', 'ws-lead-value', money(lead.valueSen))); if (lead.nextStep) card.append(el('span', 'ws-lead-next', lead.nextStep));
          if (lead.followUp) { const due = !['won', 'lost'].includes(lead.stage) && lead.followUp <= today(); card.append(el('span', 'ws-lead-followup' + (due ? ' due' : ''), (due ? 'Follow-up due · ' : 'Follow up · ') + dateLabel(lead.followUp))); }
          column.append(card);
        }
        if (!items.length) column.append(el('p', 'ws-leads-sub', 'No leads')); board.append(column);
      }
      list.append(board);
    };
    search.oninput = () => { query = search.value; paintList(); }; scopeSelect.onchange = () => { scope = scopeSelect.value; paintList(); }; paintList();
    const lead = records.find(l => l.id === selected);
    if (draft || lead) { layout.classList.add('with-detail'); layout.classList.toggle('detail-expanded', expanded); const panel = el('section', 'ws-lead-detail'); panel.setAttribute('aria-label', draft ? 'Lead editor' : 'Lead details'); layout.append(panel); if (draft) editor(panel); else details(panel, lead); panel.querySelector('.ws-lead-detail-body').scrollTop = scroll; }
    for (const control of host.querySelectorAll('button,input,select,textarea')) control.disabled = busy;
  }
  function table(leads) {
    const wrap = el('div', 'ws-leads-table-wrap'), table = el('table', 'ws-leads-table'), head = el('thead'), headings = el('tr');
    for (const label of ['Lead', 'Stage', 'Value', 'Follow-up', 'Next step']) { const th = el('th', '', label); th.scope = 'col'; headings.append(th); } head.append(headings); table.append(head);
    const body = el('tbody');
    for (const lead of leads) { const row = el('tr'); row.dataset.leadId = lead.id; const name = el('td'); name.append(btn(lead.title, () => choose(lead.id))); if (lead.company) name.append(el('small', 'ws-leads-sub', lead.company)); row.append(name, el('td', '', stages.find(s => s[0] === lead.stage)[1]), el('td', 'ws-lead-value', money(lead.valueSen)), el('td', '', lead.followUp ? dateLabel(lead.followUp) : 'Not scheduled'), el('td', '', lead.nextStep || 'Not set')); body.append(row); }
    table.append(body); wrap.append(table); return wrap;
  }
  function editor(panel) {
    const toolbar = el('div', 'ws-lead-detail-toolbar'), heading = el('div', 'ws-lead-detail-head');
    const h = el('h2', '', draft.id ? 'Edit lead' : 'New lead'); heading.append(h, expandControl());
    toolbar.append(heading, el('p', 'ws-leads-sub', 'Draft kept on this Mac until you save or discard it.')); panel.append(toolbar);
    const body = el('div', 'ws-lead-detail-body'); panel.append(body); panel = body;
    const form = el('form', 'ws-lead-form'), grid = el('div', 'ws-lead-fields');
    const definitions = [['title', 'Lead name', 'text'], ['company', 'Company', 'text'], ['contact', 'Contact person', 'text'], ['phone', 'Phone / WhatsApp', 'tel'], ['email', 'Email', 'email'], ['source', 'Lead source', 'text'], ['stage', 'Stage', 'select'], ['followUp', 'Follow-up date', 'date'], ['valueText', 'Estimated value (RM)', 'text'], ['nextStep', 'Next step', 'text'], ['brief', 'Project brief and scope', 'textarea']];
    for (const [name, label, type] of definitions) {
      const field = el('label', 'ws-lead-field' + (['title', 'nextStep', 'brief'].includes(name) ? ' full' : '')); field.append(el('span', '', label));
      const input = el(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input', 'ws-input'); input.name = name; input.id = 'lead-' + name; field.htmlFor = input.id;
      if (type === 'select') for (const [value, text] of stages) { const o = el('option', '', text); o.value = value; input.append(o); }
      else if (type !== 'textarea') input.type = type;
      if (name === 'valueText') { input.inputMode = 'decimal'; input.placeholder = 'Leave blank until priced'; input.pattern = '\\d+(\\.\\d{1,2})?'; }
      if (name === 'title') { input.required = true; input.maxLength = 160; }
      if (type === 'textarea') { input.rows = 8; input.maxLength = 50000; }
      input.value = name === 'valueText' ? draft.valueText : draft.values[name]; input.oninput = () => { if (name === 'valueText') draft.valueText = input.value; else draft.values[name] = input.value; rememberDraft(); }; field.append(input); grid.append(field);
    }
    const actions = el('div', 'ws-leads-actions'), save = el('button', 'ws-button ws-primary', 'Save lead'); save.type = 'submit'; actions.append(save, btn('Discard draft', cancelDraft)); form.append(grid, actions); panel.append(form);
    form.onsubmit = event => { event.preventDefault(); if (!form.reportValidity()) return; attempt(async () => {
      const values = { ...draft.values, valueSen: draft.valueText.trim() === '' ? null : Math.round(Number(draft.valueText) * 100) };
      const lead = draft.id ? await request('update', { id: draft.id, revision: draft.revision, values }) : await request('create', { values });
      draft = null; rememberDraft(); selected = lead.id; records = (await request('list')).leads; notice = 'Lead saved.';
    }); };
  }
  function details(panel, lead) {
    const heading = el('div', 'ws-lead-detail-head'), title = el('h2', '', lead.title); title.tabIndex = -1;
    const toolbar = el('div', 'ws-lead-detail-toolbar'), controls = el('div', 'ws-leads-actions');
    controls.append(expandControl(), btn('Close', closeDetails)); heading.append(title, controls); toolbar.append(heading); panel.append(toolbar);
    const actions = el('div', 'ws-leads-actions'); actions.append(btn('Create quotation', () => MT.router.show('quotations', { leadId: lead.id }), true), btn('Edit lead', () => start(lead)), btn(lead.archived ? 'Restore lead' : 'Archive lead', () => attempt(async () => { await request('archive', { id: lead.id, revision: lead.revision, archived: !lead.archived }); records = (await request('list')).leads; selected = null; notice = lead.archived ? 'Lead restored.' : 'Lead archived. You can restore it from Archived.'; }))); toolbar.append(actions); const body = el('div', 'ws-lead-detail-body'); body.tabIndex = 0; body.setAttribute('aria-label', 'Lead information and activity'); panel.append(body); panel = body; if (lead.clientId) panel.append(btn('View client',()=>MT.router.show('clients',{id:lead.clientId})));
    const stageLabel = el('label', 'ws-lead-field'); stageLabel.append(el('span', '', 'Stage')); const select = el('select', 'ws-input'); select.setAttribute('aria-label', 'Lead stage');
    for (const [value, text] of stages) { const o = el('option', '', text); o.value = value; select.append(o); } select.value = lead.stage;
    select.onchange = () => attempt(async () => { await request('update', { id: lead.id, revision: lead.revision, values: { stage: select.value } }); records = (await request('list')).leads; notice = 'Stage updated.'; }); stageLabel.append(select); panel.append(stageLabel);
    const summary = el('dl', 'ws-lead-summary');
    for (const [label, value] of [['Company', lead.company], ['Contact', lead.contact], ['Email', lead.email], ['Phone', lead.phone], ['Source', lead.source], ['Estimated value', money(lead.valueSen)], ['Follow-up', lead.followUp ? dateLabel(lead.followUp) : 'Not scheduled'], ['Next step', lead.nextStep || 'Not set']]) if (value) summary.append(el('dt', '', label), el('dd', '', value)); panel.append(summary);
    if (lead.brief) panel.append(el('h3', '', 'Project brief'), el('p', 'ws-lead-brief', lead.brief));
    panel.append(el('h3', '', 'Activity'));
    const noteForm = el('form', 'ws-lead-note'), note = el('textarea', 'ws-input'); note.placeholder = 'Log a call, client reply or decision'; note.setAttribute('aria-label', 'Activity note'); note.rows = 3; note.required = true; note.maxLength = 10000;
    note.value = noteDrafts.get(lead.id) || ''; note.oninput = () => noteDrafts.set(lead.id, note.value);
    const submit = el('button', 'ws-button', 'Add note'); submit.type = 'submit'; noteForm.append(note, submit); panel.append(noteForm);
    noteForm.onsubmit = e => { e.preventDefault(); const text = note.value; attempt(async () => { await request('note', { id: lead.id, revision: lead.revision, text }); noteDrafts.delete(lead.id); records = (await request('list')).leads; notice = 'Note saved.'; }); };
    const history = el('ol', 'ws-lead-activity');
    for (const activity of lead.activity) { const item = el('li'); const date = el('time', 'ws-leads-sub', new Date(activity.at).toLocaleString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })); date.dateTime = activity.at; item.append(date, el('p', '', activity.text)); history.append(item); } panel.append(history);
  }
  MT.leads = { render: load, hasDraft: () => !!draft, beforeClose: async () => !draft || await MT.confirm({ title: 'Keep lead draft for next time?', message: 'Your draft is backed up on this Mac and will reopen when you return to Leads.', okLabel: 'Close and keep draft', cancelLabel: 'Keep working', danger: false }) };
})();
