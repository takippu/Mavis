'use strict';
(() => {
  const MT = window.MT, money = window.QuotationDocument.money;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const btn = (text, action, primary = false) => { const b = el('button', 'ws-button' + (primary ? ' ws-primary' : ''), text); b.type = 'button'; b.onclick = action; return b; };
  const request = async (action, p) => { const r = await window.mavis.workspace('freelance-' + action, p); if (r?.error) throw Object.assign(Error(r.error), { code: r.code }); return r; };
  const stages = [['planned', 'Planned'], ['active', 'Active'], ['on-hold', 'On hold'], ['completed', 'Completed']];
  const state = {};
  for (const kind of ['clients', 'jobs', 'expenses']) { state[kind] = { draft: null, selected: null, expanded: false, query: '', scope: kind === 'jobs' ? 'all' : 'active', taskDraft: null }; try { state[kind].draft = JSON.parse(localStorage.getItem('mavis-' + kind + '-draft')); } catch {} }
  try { state.jobs.taskDraft = JSON.parse(localStorage.getItem('mavis-jobs-task-draft')); } catch {}
  let host, kind, data, busy = false, notice = '', sequence = 0;
  function closeDetails() {
    const id = state[kind].selected; state[kind].selected = null; state[kind].expanded = false; paint();
    (host.querySelector('[data-record-id="' + id + '"] button') || host.querySelector('input[type="search"]'))?.focus();
  }
  function detailShell(panel, title, editing = false) {
    const toolbar = el('div', 'ws-lead-detail-toolbar'), head = el('div', 'ws-lead-detail-head'), h = el('h2', '', title), controls = el('div', 'ws-leads-actions'); h.tabIndex = -1;
    const expand = btn(state[kind].expanded ? 'Show list' : 'Expand details', () => { state[kind].expanded = !state[kind].expanded; host.querySelector('.ws-freelance-layout').classList.toggle('detail-expanded', state[kind].expanded); expand.textContent = state[kind].expanded ? 'Show list' : 'Expand details'; expand.setAttribute('aria-pressed', String(state[kind].expanded)); });
    expand.classList.add('ws-freelance-expand'); expand.setAttribute('aria-pressed', String(state[kind].expanded)); controls.append(expand); if (!editing) controls.append(btn('Close', closeDetails));
    head.append(h, controls); toolbar.append(head); panel.append(toolbar);
    const body = el('div', 'ws-lead-detail-body'); body.tabIndex = 0; body.setAttribute('aria-label', singular(kind) + (editing ? ' editor' : ' information')); panel.append(body); return { toolbar, body };
  }
  const singular = k => ({ clients: 'client', jobs: 'project', expenses: 'expense' })[k];
  function remember(k) { try { const draft = state[k].draft; if (k === 'jobs') { if (state.jobs.taskDraft) localStorage.setItem('mavis-jobs-task-draft', JSON.stringify(state.jobs.taskDraft)); else localStorage.removeItem('mavis-jobs-task-draft'); } if (draft) localStorage.setItem('mavis-' + k + '-draft', JSON.stringify(draft)); else localStorage.removeItem('mavis-' + k + '-draft'); } catch { notice = 'Draft backup is unavailable. Save before leaving this screen.'; } }
  async function discardOK() { return !(state[kind].draft || state[kind].taskDraft) || await MT.confirm({ title: 'Discard unsaved changes?', message: 'Your unsaved ' + (state[kind].taskDraft ? 'task' : singular(kind)) + ' changes will be discarded.', okLabel: 'Discard changes' }); }
  async function attempt(action) { if (busy) return; busy = true; notice = ''; paint(); try { await action(); } catch (e) { notice = e.message; if (e.code === 'FREELANCE_CONFLICT') try { data = await request('list'); } catch {} } finally { busy = false; if (host?.isConnected) paint(); } }
  const blank = k => k === 'clients' ? { name: '', company: '', contact: '', email: '', phone: '', address: '', notes: '' } : k === 'jobs' ? { title: '', clientId: null, scope: '', notes: '', stage: 'planned', budgetSen: null, dueDate: '', workspaceId: '', quotationId: '', milestones: [] } : { description: '', clientId: null, jobId: null, amountSen: 0, category: '', date: window.QuotationDocument.today(), notes: '' };
  async function start(record, initial) {
    if (busy || !await discardOK()) return;
    const values = structuredClone(record?.values || initial || blank(kind)); state[kind].draft = { id: record?.id || null, revision: record?.revision, values, moneyText: kind === 'jobs' ? values.budgetSen == null ? '' : (values.budgetSen / 100).toFixed(2) : kind === 'expenses' ? values.amountSen ? (values.amountSen / 100).toFixed(2) : '' : '' };
    state[kind].taskDraft = null; state[kind].selected = record?.id || null; remember(kind); notice = ''; paint(); host.querySelector('form input')?.focus();
  }
  async function load(target, view, arg) {
    notice = ''; host = target; kind = view === 'money' ? 'expenses' : view; const token = ++sequence; host.dataset.view = view; host.replaceChildren(el('p', '', 'Loading freelance records…'));
    try {
      const result = await request('list'); if (token !== sequence || !target.isConnected) return; data = result;
      if (arg?.quotationId && kind === 'jobs') {
        const q = data.quotations.find(q => q.id === arg.quotationId); if (!q || q.revision !== arg.quotationRevision) throw Error('The quotation changed. Reopen it before creating a project.'); window.QuotationDocument.ready(q.values);
        await start(null, { ...blank('jobs'), title: q.values.project, clientId: q.values.clientId || null, scope: q.values.items.map(i => i.description).join('\n\n'), budgetSen: window.QuotationDocument.total(q.values), quotationId: q.id });
      } else if (arg?.newClientId && kind === 'jobs') await start(null, { ...blank('jobs'), clientId: arg.newClientId });
      else { if (arg?.id && !state[kind].draft && !state[kind].taskDraft) state[kind].selected = arg.id; paint(); }
    } catch (e) { if (token === sequence && target.isConnected) target.replaceChildren(el('h1', '', 'Freelance'), el('p', 'ws-leads-error', e.message), btn('Retry', () => load(target, view, arg))); }
  }
  function paint() {
    if (!host?.isConnected || !data) return; const view = host.dataset.view, s = state[kind], title = view === 'money' ? 'Money overview' : kind === 'clients' ? 'Clients' : 'Tasks';
    const previousBody = host.querySelector('.ws-lead-detail-body'), scroll = previousBody?.scrollTop || 0;
    const previousList = host.querySelector('.ws-freelance-list'); if (previousList?.offsetHeight) s.listScroll = previousList.scrollTop;
    host.replaceChildren(); host.className = 'ws-freelance-records';
    host.onkeydown = event => { if (event.key === 'Escape' && s.selected && !s.draft && !s.taskDraft && !busy && !event.target.closest('input,textarea,select')) { event.preventDefault(); closeDetails(); } };
    const header = el('header', 'ws-leads-header'), text = el('div'); text.append(el('h1', '', title), el('p', 'ws-leads-sub', { clients: 'Contacts and billing details for your freelance work.', jobs: 'What to do next, grouped by client and project.', expenses: 'All-time totals from finalised invoices, recorded payments and active expenses.' }[kind]));
    const actions = el('div', 'ws-leads-actions'); actions.append(btn('Export backup', () => attempt(async () => { const r = await request('backup'); if (r.ok) notice = 'Freelance backup exported.'; })), btn(kind === 'jobs' ? 'New task' : 'New ' + singular(kind), () => kind === 'jobs' ? startTask() : start(), true)); if (kind === 'jobs') actions.prepend(btn('New project', () => start())); header.append(text, actions); host.append(header);
    if (notice) { const n = el('p', 'ws-leads-notice', notice); n.setAttribute('role', 'status'); host.append(n); }
    const controls = el('div', 'ws-leads-controls'), search = el('input', 'ws-input'), filter = el('select', 'ws-input'); search.type = 'search'; search.value = s.query; search.placeholder = kind === 'jobs' ? 'Search tasks, projects or clients' : 'Search ' + kind; search.setAttribute('aria-label', kind === 'jobs' ? 'Search tasks' : 'Search ' + kind);
    const scopes = kind === 'jobs' ? [['all', 'All open'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['completed', 'Completed'], ['archived', 'Archived']] : [['active', kind === 'expenses' ? 'Active expenses' : 'All clients'], ['archived', 'Archived']];
    for (const [value, label] of scopes) { const o = el('option', '', label); o.value = value; filter.append(o); } filter.value = s.scope; filter.setAttribute('aria-label', 'Filter ' + kind); controls.append(search); if (kind === 'jobs') { const tabs = el('nav', 'ws-task-filters'); tabs.setAttribute('aria-label', 'Filter tasks'); for (const [value, label] of scopes) { const tab = btn(label, () => { s.scope = value; s.listScroll = 0; const list = host.querySelector('.ws-freelance-list'); if (list) list.scrollTop = 0; paint(); }); tab.dataset.taskFilter = value; tab.setAttribute('aria-pressed', String(s.scope === value)); tabs.append(tab); } controls.append(tabs); } else controls.append(filter); host.append(controls);
    const layout = el('div', 'ws-freelance-layout'), listPane = el('section', 'ws-freelance-list'), list = el('div', 'ws-freelance-items');
    listPane.setAttribute('aria-label', view === 'money' ? 'Money totals and expenses' : title);
    if (view === 'money') listPane.append(overview(), el('h2', '', 'Expenses'));
    listPane.append(list); layout.append(listPane); host.append(layout);
    function renderList() {
      list.replaceChildren(); if (kind === 'jobs') { renderTasks(list); return; } const records = data[kind].filter(r => (s.scope === 'archived' ? r.archived : !r.archived) && (kind !== 'jobs' || !stages.some(x => x[0] === s.scope) || r.values.stage === s.scope) && Object.values(r.values).filter(v => typeof v === 'string').join(' ').toLowerCase().includes(s.query.toLowerCase()));
      if (!records.length) { const empty = el('div', 'ws-leads-empty'); empty.append(el('h2', '', data[kind].length ? 'No matching records' : kind === 'clients' ? 'Keep your client details together' : 'Record your first expense'), el('p', 'ws-leads-sub', kind === 'expenses' ? 'Expenses reduce the cash after expenses figure above.' : 'Add a record to start tracking it here.')); list.append(empty); }
      for (const r of records) {
        const row = el('article', 'ws-freelance-row'), open = btn(r.values.name || r.values.title || r.values.description, async () => { if (await discardOK()) { s.draft = null; remember(kind); s.selected = r.id; notice = ''; const body = host.querySelector('.ws-lead-detail-body'); if (body) body.scrollTop = 0; paint(); host.querySelector('.ws-lead-detail-head h2')?.focus(); } }); row.dataset.recordId = r.id;
        const details = el('div'); details.append(open, el('p', 'ws-leads-sub', kind === 'clients' ? [r.values.company, r.values.email, r.values.phone].filter(Boolean).join(' · ') : r.values.date + (r.values.category ? ' · ' + r.values.category : '')));
        row.append(details); if (kind !== 'clients') row.append(el('strong', 'ws-lead-value', money(r.values.amountSen))); list.append(row);
      }
    }
    listPane.onscroll = () => { if (listPane.offsetHeight) s.listScroll = listPane.scrollTop; };
    search.oninput = () => { s.query = search.value; s.listScroll = 0; renderList(); listPane.scrollTop = 0; }; filter.onchange = () => { s.scope = filter.value; s.listScroll = 0; renderList(); listPane.scrollTop = 0; }; renderList();
    const record = data[kind].find(r => r.id === s.selected);
    if (s.draft || s.taskDraft || record) { layout.classList.add('with-detail'); layout.classList.toggle('detail-expanded', s.expanded); const panel = el('section', 'ws-freelance-detail'); panel.setAttribute('aria-label', singular(kind) + ' details'); layout.append(panel); if (s.taskDraft) taskEditor(panel); else if (s.draft) editor(panel); else details(panel, record); panel.querySelector('.ws-lead-detail-body').scrollTop = scroll; }
    listPane.scrollTop = s.listScroll || 0;
    for (const input of host.querySelectorAll('button,input,textarea,select')) input.disabled = busy || input.dataset.archived === 'true';
  }
  function dueText(task) {
    if (task.done) return 'Completed'; if (!task.dueDate) return 'No due date';
    const today = window.QuotationDocument.today();
    if (task.dueDate === today) return 'Due today';
    const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(task.dueDate + 'T12:00:00'));
    return (task.dueDate < today ? 'Overdue · ' : 'Due ') + date;
  }
  function taskRow(record, task) {
    const row = el('div', 'ws-task-row'); row.dataset.taskId = task.id; row.dataset.projectId = record.id;
    const label = el('label', 'ws-task-label'), check = el('input'); check.type = 'checkbox'; check.checked = task.done; check.disabled = record.archived; check.dataset.archived = String(record.archived);
    const text = el('span', 'ws-task-title', task.title); label.append(check, text);
    const due = el('span', 'ws-task-due', dueText(task)); if (!task.done && task.dueDate && task.dueDate < window.QuotationDocument.today()) due.classList.add('overdue');
    row.classList.toggle('completed', task.done); row.append(label, due);
    check.onchange = async () => { const done = check.checked; const values = structuredClone(record.values); values.milestones.find(m => m.id === task.id).done = done;
      await attempt(async () => { await request('save', { kind: 'jobs', id: record.id, revision: record.revision, values }); data = await request('list'); notice = done ? 'Task completed.' : 'Task reopened.'; });
      (host.querySelector('[data-task-id="' + task.id + '"] input') || host.querySelector('.ws-task-filters [aria-pressed=true]'))?.focus();
    }; return row;
  }
  async function openProject(record) {
    if (busy || !await discardOK()) return; state.jobs.draft = null; state.jobs.taskDraft = null; state.jobs.selected = record.id; remember('jobs'); notice = '';
    const body = host.querySelector('.ws-lead-detail-body'); if (body) body.scrollTop = 0; paint(); host.querySelector('.ws-lead-detail-head h2')?.focus();
  }
  function renderTasks(list) {
    const s = state.jobs, groups = window.FreelanceTasks.groups(data.jobs, data.clients, s.scope, s.query, window.QuotationDocument.today());
    if (!groups.length) { const empty = el('div', 'ws-leads-empty'); empty.append(el('h2', '', s.query ? 'No matching tasks' : { today: 'Nothing due today', upcoming: 'No upcoming tasks', completed: 'No completed tasks yet', archived: 'No archived projects', all: 'Your task list is clear' }[s.scope]), el('p', 'ws-leads-sub', s.scope === 'today' ? 'Today includes overdue tasks. Check Upcoming for future tasks and tasks without a due date.' : s.scope === 'upcoming' ? 'Future tasks and tasks without a due date appear here.' : 'Add a task and choose its project to get started.')); list.append(empty); return; }
    for (const group of groups) {
      const section = el('section', 'ws-task-client'); section.append(el('h2', '', group.clientName));
      for (const { record, tasks } of group.projects) {
        const project = el('section', 'ws-task-project'); project.dataset.recordId = record.id;
        const head = el('div', 'ws-task-project-head'), title = el('div'); title.append(el('h3', '', record.values.title));
        const count = record.values.milestones.filter(m => !m.done).length; title.append(el('p', 'ws-leads-sub', record.archived ? 'Archived project' : count + ' open · ' + record.values.milestones.filter(m => m.done).length + ' completed'));
        const actions = el('div', 'ws-leads-actions'); actions.append(btn('Project details', () => openProject(record))); if (!record.archived) actions.append(btn('Add task', () => startTask(record)));
        head.append(title, actions); project.append(head); for (const task of tasks) project.append(taskRow(record, task));
        if (!record.values.milestones.length) project.append(el('p', 'ws-leads-sub', 'No tasks yet. Add the first step for this project.')); section.append(project);
      } list.append(section);
    }
  }
  async function startTask(record) {
    if (busy || !await discardOK()) return;
    const project = record || data.jobs.find(j => !j.archived); state.jobs.draft = null; state.jobs.selected = project?.id || null;
    state.jobs.taskDraft = { title: '', dueDate: '', projectId: project?.id || '', revision: project?.revision, projectTitle: '', clientId: null, taskId: crypto.randomUUID() }; remember('jobs'); notice = ''; paint(); host.querySelector('[name="task-title"]')?.focus();
  }
  function taskEditor(panel) {
    const d = state.jobs.taskDraft, shell = detailShell(panel, 'New task', true), form = el('form', 'ws-freelance-form'), grid = el('div', 'ws-lead-fields'); form.id = 'freelance-task-form'; shell.body.setAttribute('aria-label', 'New task editor');
    const field = (key, label, type = 'text', options) => {
      const wrap = el('label', 'ws-lead-field'), input = el(type === 'select' ? 'select' : 'input', 'ws-input'); input.name = 'task-' + key;
      if (options) for (const [value, title] of options) { const option = el('option', '', title); option.value = value; input.append(option); } else { input.type = type; input.maxLength = 240; }
      input.required = ['title', 'projectTitle'].includes(key); input.value = d[key] || ''; wrap.append(el('span', '', label), input); grid.append(wrap);
      input.oninput = () => { d[key] = input.value; if (key === 'projectId') { const project = data.jobs.find(j => j.id === input.value); d.revision = project?.revision; state.jobs.selected = project?.id || null; } remember('jobs'); };
      if (key === 'projectId') input.onchange = () => { input.oninput(); paint(); host.querySelector('[name="task-projectId"]')?.focus(); }; return input;
    };
    field('title', 'Task'); field('dueDate', 'Due date (optional)', 'date');
    field('projectId', 'Project', 'select', [['', 'New project…'], ...data.jobs.filter(j => !j.archived).map(j => [j.id, j.values.title + ' · ' + (data.clients.find(c => c.id === j.values.clientId)?.values.name || 'No linked client')])]);
    if (!d.projectId) { field('projectTitle', 'Project name'); field('clientId', 'Client (optional)', 'select', [['', 'No linked client'], ...data.clients.filter(c => !c.archived).map(c => [c.id, c.values.name])]); }
    shell.toolbar.append(el('p', 'ws-leads-sub', 'Add a clear next step. Project scope and billing details stay with the project.'));
    const actions = el('div', 'ws-leads-actions'), save = el('button', 'ws-button ws-primary', 'Save task'); save.type = 'submit'; save.setAttribute('form', form.id); actions.append(save, btn('Discard changes', async () => { if (await discardOK()) { state.jobs.taskDraft = null; remember('jobs'); paint(); } })); shell.toolbar.append(actions); form.append(grid); shell.body.append(form);
    form.onsubmit = e => { e.preventDefault(); if (!form.reportValidity()) return; attempt(async () => {
      const project = data.jobs.find(j => j.id === d.projectId); if (d.projectId && (!project || project.archived)) throw Error('This project is unavailable. Choose another project.');
      const values = project ? structuredClone(project.values) : { ...blank('jobs'), title: d.projectTitle, clientId: d.clientId || null };
      if (values.milestones.length >= 100) throw Error('This project already has 100 tasks. Choose another project.');
      values.milestones.push({ id: d.taskId, title: d.title, dueDate: d.dueDate, done: false });
      const r = await request('save', { kind: 'jobs', id: project?.id, revision: d.revision, values }); state.jobs.taskDraft = null; state.jobs.selected = null; state.jobs.scope = 'all'; remember('jobs'); data = await request('list'); notice = 'Task saved.';
    }); };
  }
  function projectDetails(panel, record) {
    const v = record.values; const context = el('p', 'ws-leads-sub', data.clients.find(c => c.id === v.clientId)?.values.name || 'No linked client'); panel.append(context, el('h3', '', 'Tasks'));
    for (const task of v.milestones) panel.append(taskRow(record, task)); if (!v.milestones.length) panel.append(el('p', 'ws-leads-sub', 'No tasks yet. Add the first step for this project.'));
    if (!record.archived) panel.append(btn('Add task', () => startTask(record)));
    const disclosure = el('details', 'ws-task-project-details'), summary = el('summary', '', 'Project details'); disclosure.append(summary);
    const info = el('dl', 'ws-lead-summary'); info.append(el('dt', '', 'Stage'), el('dd', '', stages.find(([key]) => key === v.stage)?.[1] || v.stage)); if (v.dueDate) info.append(el('dt', '', 'Project deadline'), el('dd', '', v.dueDate)); if (v.budgetSen !== null) info.append(el('dt', '', 'Agreed budget'), el('dd', '', money(v.budgetSen))); disclosure.append(info);
    const links = el('div', 'ws-leads-actions'); if (v.clientId) links.append(btn('View client', () => MT.router.show('clients', { id: v.clientId })));
    if (v.workspaceId) links.append(btn('Open coding workspace', () => attempt(async () => { if (MT.workspace.projects.has(v.workspaceId)) await MT.workspace.activate(v.workspaceId); else await MT.workspace.openProject({ restore: v.workspaceId }); await MT.workspace.run('files'); })));
    if (v.quotationId) links.append(btn('View source quotation', () => MT.router.show('quotations', { id: v.quotationId }))); disclosure.append(links);
    for (const [key, label] of [['scope', 'Agreed scope'], ['notes', 'Notes']]) if (v[key]) { const section = el('section', 'ws-freelance-prose'); section.append(el('h3', '', label), el('p', 'ws-lead-brief', v[key])); disclosure.append(section); } panel.append(disclosure);
  }
  function overview() {
    const section = el('section', 'ws-money-summary'), rows = el('dl'); section.setAttribute('aria-label', 'All-time money totals');
    const helpers = { overdueSen: 'Included in outstanding', cashAfterExpensesSen: 'Payments received minus recorded expenses', quotedSen: 'Not received income' + (data.money.unpricedQuotes ? ' · ' + data.money.unpricedQuotes + ' still unpriced' : '') };
    for (const [label, field] of [['Invoiced', 'invoicedSen'], ['Payments received', 'paidSen'], ['Outstanding', 'outstandingSen'], ['Overdue balance', 'overdueSen'], ['Recorded expenses', 'expensesSen'], ['Cash after expenses', 'cashAfterExpensesSen'], ['Quotation drafts total', 'quotedSen']]) {
      const row = el('div', 'ws-money-row'), term = el('dt'), value = el('dd', '', money(data.money[field])); row.dataset.total = field;
      term.append(el('span', '', label)); if (helpers[field]) term.append(el('small', '', helpers[field])); row.append(term, value); rows.append(row);
    }
    section.append(rows, el('p', 'ws-leads-sub', 'Draft and void invoices are excluded from invoice totals. Archived expenses are excluded.')); return section;
  }
  function addField(parent, key, label, type = 'text', options) {
    const d = state[kind].draft, wrap = el('label', 'ws-lead-field'), input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', 'ws-input'); input.name = key; input.id = 'freelance-' + key; wrap.htmlFor = input.id; wrap.append(el('span', '', label));
    if (type === 'select') for (const [value, text] of options) { const o = el('option', '', text); o.value = value; input.append(o); } else if (type === 'textarea') input.rows = 5; else input.type = type;
    input.value = key === 'moneyText' ? d.moneyText : d.values[key] ?? ''; if (['name', 'title', 'description', 'date'].includes(key)) input.required = true;
    input.maxLength = { name: 240, company: 240, contact: 160, email: 240, phone: 80, address: 2000, notes: kind === 'expenses' ? 3000 : 10000, title: 240, scope: 20000, description: 500, category: 100 }[key] || 100;
    if (key === 'moneyText') { input.inputMode = 'decimal'; input.pattern = '\\d+(\\.\\d{1,2})?'; if (kind === 'expenses') input.required = true; }
    input.oninput = () => { if (key === 'moneyText') d.moneyText = input.value; else d.values[key] = ['clientId', 'jobId'].includes(key) ? input.value || null : input.value; remember(kind); }; wrap.append(input); parent.append(wrap);
  }
  function editor(panel) {
    const d = state[kind].draft, shell = detailShell(panel, (d.id ? 'Edit ' : 'New ') + singular(kind), true);
    shell.toolbar.append(el('p', 'ws-leads-sub', 'Draft kept on this Mac until you save or discard it.')); panel = shell.body;
    const form = el('form', 'ws-freelance-form'), grid = el('div', 'ws-lead-fields');
    form.id = 'freelance-' + kind + '-form';
    if (kind === 'clients') for (const args of [['name', 'Client name'], ['company', 'Company'], ['contact', 'Contact person'], ['email', 'Email', 'email'], ['phone', 'Phone / WhatsApp', 'tel'], ['address', 'Billing address', 'textarea'], ['notes', 'Notes', 'textarea']]) addField(grid, ...args);
    else {
      addField(grid, kind === 'jobs' ? 'title' : 'description', kind === 'jobs' ? 'Project name' : 'Expense description');
      addField(grid, 'clientId', 'Client (optional)', 'select', [['', 'No linked client'], ...data.clients.filter(c => !c.archived || c.id === d.values.clientId).map(c => [c.id, c.values.name])]);
      if (kind === 'jobs') {
        addField(grid, 'stage', 'Stage', 'select', stages); addField(grid, 'dueDate', 'Deadline (optional)', 'date'); addField(grid, 'moneyText', 'Agreed budget (RM, optional)'); addField(grid, 'workspaceId', 'Coding workspace (optional)', 'select', [['', 'No linked workspace'], ...data.workspaces.map(w => [w.id, w.name])]); addField(grid, 'scope', 'Agreed scope', 'textarea');
      } else { addField(grid, 'moneyText', 'Amount (RM)'); addField(grid, 'date', 'Expense date', 'date'); addField(grid, 'category', 'Category (optional)'); addField(grid, 'jobId', 'Project (optional)', 'select', [['', 'No linked project'], ...data.jobs.filter(j => !j.archived || j.id === d.values.jobId).map(j => [j.id, j.values.title])]); }
      addField(grid, 'notes', 'Notes', 'textarea');
    }
    form.append(grid);
    if (kind === 'jobs') {
      form.append(el('h3', '', 'Tasks')); const list = el('div', 'ws-job-milestones');
      d.values.milestones.forEach((m, index) => { const row = el('div', 'ws-job-milestone');
        for (const [key, label, type] of [['title', 'Task ' + (index + 1), 'text'], ['dueDate', 'Task due date ' + (index + 1), 'date']]) { const wrap = el('label', 'ws-lead-field'), input = el('input', 'ws-input'); input.type = type; input.name = 'milestone-' + index + '-' + key; input.value = m[key]; input.required = key === 'title'; input.maxLength = 240; wrap.append(el('span', '', label), input); input.oninput = () => { m[key] = input.value; remember(kind); }; row.append(wrap); }
        row.append(btn('Remove task ' + (index + 1), () => { d.values.milestones.splice(index, 1); remember(kind); paint(); })); list.append(row); });
      form.append(list, btn('Add task', () => { if (d.values.milestones.length >= 100) return; d.values.milestones.push({ id: crypto.randomUUID(), title: '', dueDate: '', done: false }); remember(kind); paint(); }));
    }
    const actions = el('div', 'ws-leads-actions'), save = el('button', 'ws-button ws-primary', 'Save ' + singular(kind)); save.type = 'submit'; save.setAttribute('form', form.id); actions.append(save, btn('Discard changes', async () => { if (await discardOK()) { state[kind].draft = null; remember(kind); paint(); } })); shell.toolbar.append(actions); panel.append(form);
    form.onsubmit = e => { e.preventDefault(); if (!form.reportValidity()) return; const currentKind = kind; attempt(async () => {
      const values = structuredClone(d.values); if (currentKind === 'jobs') values.budgetSen = d.moneyText.trim() ? Math.round(Number(d.moneyText) * 100) : null; if (currentKind === 'expenses') values.amountSen = Math.round(Number(d.moneyText) * 100);
      const r = await request('save', { kind: currentKind, id: d.id, revision: d.revision, values }); state[currentKind].draft = null; state[currentKind].selected = r.id; remember(currentKind); data = await request('list'); notice = 'Record saved.';
    }); };
  }
  function details(panel, record) {
    const v = record.values, shell = detailShell(panel, v.name || v.title || v.description); panel = shell.body;
    const actions = el('div', 'ws-leads-actions'); actions.append(btn('Edit ' + singular(kind), () => start(record)), btn(record.archived ? 'Restore' : 'Archive', () => { const k = kind; attempt(async () => { await request('archive', { kind: k, id: record.id, revision: record.revision, archived: !record.archived }); data = await request('list'); state[k].selected = null; notice = record.archived ? 'Record restored.' : 'Record archived.'; }); })); shell.toolbar.append(actions);
    if (kind === 'jobs') { projectDetails(panel, record); return; }
    const info = el('dl', 'ws-lead-summary'); for (const [key, value] of Object.entries(v)) if (typeof value === 'string' && value && !['name', 'title', 'description', 'clientId', 'jobId', 'workspaceId', 'quotationId', 'scope', 'notes', 'address'].includes(key)) info.append(el('dt', '', { dueDate: 'Deadline', stage: 'Stage' }[key] || key[0].toUpperCase() + key.slice(1)), el('dd', '', value)); panel.append(info);
    if (v.clientId) panel.append(btn('View client', () => MT.router.show('clients', { id: v.clientId })));
    if (kind === 'clients') {
      if (v.address) { const address = el('section', 'ws-freelance-prose'); address.append(el('h3', '', 'Billing address'), el('p', 'ws-lead-brief', v.address)); panel.append(address); }
      const create = el('div', 'ws-leads-actions'); create.append(btn('New quotation', () => MT.router.show('quotations', { clientId: record.id })), btn('New invoice', () => MT.router.show('invoices', { clientId: record.id })), btn('New project', () => MT.router.show('jobs', { newClientId: record.id })), btn('New lead', () => MT.router.show('leads', { clientId: record.id }))); panel.append(create);
      for (const [label, items, route] of [['Leads', data.leads.filter(l => l.clientId === record.id), 'leads'], ['Quotations', data.quotations.filter(q => q.values.clientId === record.id), 'quotations'], ['Invoices', data.invoices.filter(i => i.values.clientId === record.id), 'invoices'], ['Projects and tasks', data.jobs.filter(j => j.values.clientId === record.id), 'jobs']]) { panel.append(el('h3', '', label)); if (!items.length) panel.append(el('p', 'ws-leads-sub', 'None linked yet.')); for (const item of items) panel.append(btn(item.number || item.title || item.values.title, () => MT.router.show(route, route === 'leads' ? { leadId: item.id } : { id: item.id }))); }
    }
    if (kind === 'expenses') panel.append(el('p', '', 'Expense · ' + money(v.amountSen)));
    for (const [key, label] of [['notes', 'Notes']]) if (v[key]) { const section = el('section', 'ws-freelance-prose'); section.append(el('h3', '', label), el('p', 'ws-lead-brief', v[key])); panel.append(section); }
  }
  MT.freelance = { render: load, hasDraft: () => Object.values(state).some(s => s.draft || s.taskDraft), beforeClose: async () => !Object.values(state).some(s => s.draft || s.taskDraft) || await MT.confirm({ title: 'Keep freelance drafts for next time?', message: 'Your client, project, task and expense drafts are backed up on this Mac.', okLabel: 'Close and keep drafts', cancelLabel: 'Keep working', danger: false }) };
})();
