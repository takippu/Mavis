'use strict';
(() => {
  const MT = window.MT;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
  const icon = name => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', { pause: 'M8 4v16M16 4v16', play: 'm7 3 14 9-14 9Z', close: 'm6 6 12 12M18 6 6 18', queue: 'm5 12 4 4L19 6' }[name]); s.append(p); return s;
  };
  const button = (text, fn, primary = false) => { const b = el('button', 'lh-button' + (primary ? ' lh-primary' : ''), text); b.type = 'button'; b.onclick = fn; return b; };
  const iconButton = (name, label, fn) => { const b = button('', fn); b.classList.add('lh-icon-button'); b.append(icon(name)); b.setAttribute('aria-label', label); b.title = label; return b; };
  const choices = {
    website: [['any', 'Any website status'], ['not_observed', 'No website found'], ['found', 'Has a website']],
    contact: [['any', 'Any public contact'], ['email', 'Email address'], ['phone', 'Phone number'], ['form', 'Contact form'], ['not_required', 'Not required']],
    sources: [['public_web', 'Public web + business directories'], ['business_sites', 'Business websites'], ['directories', 'Public business directories']]
  };
  const defaults = () => ({ goal: '', model: '', industry: '', region: '', city: '', website: 'any', contact: 'any', sources: 'public_web', limit: 50, skipExisting: true });
  let draft = defaults();
  try { const saved = JSON.parse(localStorage.getItem('mavis-hunter-draft')); if (saved && typeof saved.goal === 'string') { for (const key of ['goal', 'model', 'industry', 'region', 'city']) if (typeof saved[key] === 'string') draft[key] = saved[key]; for (const key of ['website', 'contact', 'sources']) if (choices[key].some(([value]) => value === saved[key])) draft[key] = saved[key]; if (Number.isInteger(saved.limit) && saved.limit >= 1 && saved.limit <= 500) draft.limit = saved.limit; if (typeof saved.skipExisting === 'boolean') draft.skipExisting = saved.skipExisting; } } catch {}
  let host = null, office = null, unsubscribe = null, sequence = 0, eventVersion = 0;
  let snapshot = { version: 1, paused: false, jobs: [], candidates: [] }, ui = null, busy = false, submitting = false, loaded = false, animationPaused = false;
  let modelCatalogKey = '';
  let notice = '', noticeError = false, activeTab = 'goal', returnFocus = null;
  const selected = new Map(), acknowledged = new Set(), expandedDetails = new Set();
  const request = async (action, payload) => { const r = await window.mavis.workspace('hunter-' + action, payload); const statusSnapshot = action === 'status' && Array.isArray(r?.jobs) && Array.isArray(r?.candidates) && typeof r.error !== 'string'; if (r?.error && !statusSnapshot) throw Object.assign(new Error(typeof r.error === 'string' ? r.error : r.error.message || 'Discover request failed.'), { code: r.code }); return r; };
  const currentJob = () => snapshot.jobs.find(j => j.status === 'running') || snapshot.jobs.find(j => ['waiting', 'paused', 'queued'].includes(j.status)) || snapshot.jobs.at(-1);
  const candidatesFor = job => snapshot.candidates.filter(c => c.jobId === job.id);
  const countBatches = job => Array.isArray(job.completedBatches) ? job.completedBatches.length : Number.isInteger(job.completedBatches) ? job.completedBatches : 0;
  const labelFor = (key, value) => choices[key].find(c => c[0] === value)?.[1] || String(value || 'Not specified');
  const reasonText = job => typeof job.reason === 'string' ? job.reason.replace(/_/g, ' ') : job.reason?.message || job.reason?.code?.replace(/_/g, ' ') || '';
  const canResumeTasks = () => !!snapshot.error || snapshot.paused || snapshot.jobs.some(j => j.status === 'paused' || (j.status === 'waiting' && ['AUTH', 'QUOTA'].includes(j.errorCode)));
  const stateLabel = job => snapshot.error && job.status === 'running' ? 'Stopped' : ({ queued: 'Queued', running: 'Running', waiting: 'Waiting', paused: 'Paused', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[job.status] || 'Unknown state');
  const dateLabel = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Time not recorded' : date.toLocaleString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  function rememberDraft() {
    try { localStorage.setItem('mavis-hunter-draft', JSON.stringify(draft)); }
    catch { setNotice('Goal draft backup is unavailable. Keep this screen open until you submit.', true); }
  }
  function setNotice(text, error = false) {
    notice = text; noticeError = error;
    if (!ui) return;
    for (const n of [ui.notice, ui.goalNotice, ui.queueNotice]) { n.textContent = notice; n.hidden = !notice; n.dataset.error = String(noticeError); n.setAttribute('role', noticeError ? 'alert' : 'status'); }
  }
  function applySnapshot(value) {
    const next = value?.snapshot || value;
    if (!next || !Array.isArray(next.jobs) || !Array.isArray(next.candidates)) return;
    const hadError = !!snapshot.error; snapshot = next; loaded = true;
    if (next.error) setNotice('Discover stopped: ' + (next.error.message || 'Saved state could not be updated.') + ' Saved results remain available. Resolve the storage problem, then retry.', true);
    else if (hadError && notice.startsWith('Discover stopped:')) setNotice('');
    sync();
  }
  async function refresh() { const eventAtStart = eventVersion, owner = sequence, value = await request('status'); if (owner === sequence && eventAtStart === eventVersion) applySnapshot(value); }
  async function attempt(fn, pendingText) {
    if (busy || !host?.isConnected) return;
    const owner = sequence, focused = document.activeElement;
    const inDialog = !!ui?.dialog.open && ui.dialog.contains(focused);
    const actionFocus = focused?.matches('button') ? { node: focused, key: focused.dataset.focus, id: focused.id, jobId: focused.closest('[data-job-id]')?.dataset.jobId, inDialog } : null;
    const safeFocus = inDialog ? ui[activeTab + 'Tab'] : focused === ui?.pauseTask ? ui.viewTask : null;
    busy = true; submitting = pendingText === 'Submitting task…'; setNotice(pendingText || ''); syncBusy();
    // Native disabled buttons lose focus. Keep focus on a stable semantic control while the action runs.
    if (actionFocus && focused.disabled && safeFocus && !safeFocus.hidden) safeFocus.focus({ preventScroll: true });
    try { await fn(); }
    catch (e) { if (owner === sequence) setNotice(e.message || 'Discover could not complete that action. Try again.', true); }
    finally { if (owner === sequence) {
      const restoreFocus = actionFocus && (document.activeElement === safeFocus || document.activeElement === document.body);
      busy = false; submitting = false;
      if (host?.isConnected) {
        sync(); syncBusy();
        // Restore only if the user has not moved elsewhere during the request, and the original menu is still open.
        if (restoreFocus && (!actionFocus.inDialog || ui.dialog.open)) {
          const controls = [...host.querySelectorAll('[data-focus]')];
          let target = actionFocus.key ? controls.find(n => n.dataset.focus === actionFocus.key) : actionFocus.id ? document.getElementById(actionFocus.id) : actionFocus.node;
          if (!target?.isConnected || target.disabled || target.hidden) {
            const key = actionFocus.jobId + (actionFocus.key?.endsWith(':import') ? ':results' : ':filters');
            target = controls.find(n => n.dataset.focus === key) || safeFocus;
          }
          target?.focus({ preventScroll: true });
        }
      }
    } }
  }
  function syncBusy() {
    if (!ui) return;
    ui.submit.disabled = busy || !loaded || !!snapshot.error || !modelAvailable();
    ui.pauseTask.disabled = busy || !loaded;
    ui.pauseAll.disabled = busy || !loaded;
    for (const b of ui.taskList.querySelectorAll('[data-mutation]')) b.disabled = busy || b.dataset.unavailable === 'true';
    ui.submit.textContent = submitting ? 'Submitting…' : 'Submit task';
  }
  function switchTab(name, focus = false) {
    activeTab = name;
    for (const id of ['goal', 'queue']) { const on = id === name; ui[id + 'Pane'].hidden = !on; ui[id + 'Tab'].setAttribute('aria-selected', String(on)); ui[id + 'Tab'].tabIndex = on ? 0 : -1; }
    if (name === 'queue') renderQueue();
    if (focus) ui[name + 'Tab'].focus();
  }
  function openMenu(name = 'goal') {
    if (!ui || !host?.isConnected) return;
    returnFocus = document.activeElement;
    switchTab(name); office?.setMenuOpen(true);
    if (!ui.dialog.open) ui.dialog.showModal();
    ui[name + 'Tab'].focus();
  }
  function closeMenu() { ui?.dialog.close(); }
  function labelledField(form, name, text, type = 'text', hint = '') {
    const field = el('label', 'lh-field'); field.append(el('span', '', text));
    const input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input'); input.name = name; input.id = 'lh-' + name; field.htmlFor = input.id;
    if (type === 'select' && name !== 'model') for (const [value, label] of choices[name]) { const option = el('option', '', label); option.value = value; input.append(option); }
    else if (!['textarea', 'select'].includes(type)) input.type = type;
    if (['goal', 'region'].includes(name)) input.required = true;
    if (type === 'textarea') { input.rows = 3; input.maxLength = 240; input.placeholder = 'Describe the businesses you want to find.'; }
    if (name === 'industry') { input.maxLength = 120; input.placeholder = 'Any industry'; input.setAttribute('list', 'lh-industries'); }
    if (['region', 'city'].includes(name)) { input.maxLength = 80; input.placeholder = name === 'region' ? 'Enter a state or region' : 'Any city'; }
    if (name === 'limit') { input.min = '1'; input.max = '500'; input.step = '1'; input.required = true; }
    input.value = String(draft[name]);
    input.oninput = () => { input.setCustomValidity(''); draft[name] = name === 'limit' ? Number(input.value) : input.value; rememberDraft(); if (name === 'model') { syncModel(); syncBusy(); } };
    field.append(input);
    if (name === 'model') ui.modelSelect = input;
    if (hint) { const help = el('small', '', hint); help.id = 'lh-' + name + '-help'; input.setAttribute('aria-describedby', help.id); field.append(help); if (name === 'model') { ui.modelHelp = help; help.setAttribute('role', 'status'); } }
    form.append(field); return input;
  }
  const modelAvailable = () => Array.isArray(snapshot.models) && snapshot.models.some(model => model.id === draft.model && model.available === true);
  function syncModel() {
    if (!ui?.modelSelect) return;
    const models = Array.isArray(snapshot.models) ? snapshot.models.filter(model => typeof model?.id === 'string' && model.id) : [];
    if (loaded && !draft.model) { draft.model = typeof snapshot.defaultModel === 'string' && snapshot.defaultModel ? snapshot.defaultModel : 'gpt-5.5'; rememberDraft(); }
    const key = JSON.stringify(models.map(model => [model.id, model.label, model.available, model.reason]));
    if (key !== modelCatalogKey || !ui.modelSelect.options.length) {
      const selectedValue = draft.model; ui.modelSelect.replaceChildren();
      for (const model of models) { const option = el('option', '', (model.label || model.id) + (model.available ? '' : ' (unavailable)')); option.value = model.id; option.disabled = model.available !== true; ui.modelSelect.append(option); }
      if (!models.some(model => model.id === selectedValue)) { const option = el('option', '', selectedValue ? selectedValue + ' (unavailable)' : 'Loading models…'); option.value = selectedValue; option.disabled = true; ui.modelSelect.append(option); }
      modelCatalogKey = key;
    }
    ui.modelSelect.value = draft.model;
    const model = models.find(model => model.id === draft.model), available = modelAvailable();
    const reason = !loaded ? 'Checking available models…' : available ? (models.filter(choice => choice.available === true).length === 1 && model.id === 'gpt-5.5' ? 'Currently, only GPT-5.5 can run Discover. More models need runner compatibility support. Saved with each task; changes affect new tasks.' : 'Saved with each task. Changing this model applies to new tasks.') : (model?.reason || (draft.model ? 'The saved model is not available for Discover.' : 'No model is available for Discover.')) + ' Choose an available model to submit.';
    if (ui.modelHelp.textContent !== reason) ui.modelHelp.textContent = reason;
    ui.modelSelect.setCustomValidity(loaded && !available ? reason : '');
  }
  function goalForm() {
    const form = el('form', 'lh-goal-form'); form.id = 'lh-goal-form';
    labelledField(form, 'goal', 'Goal', 'textarea');
    labelledField(form, 'model', 'Model', 'select', 'Checking available models…');
    labelledField(form, 'industry', 'Industry');
    const list = el('datalist'); list.id = 'lh-industries'; for (const value of ['Auto workshops', 'Clinics', 'Restaurants & cafes', 'Property agencies', 'Retail stores', 'Professional services']) { const option = el('option'); option.value = value; list.append(option); } form.append(list);
    const row = el('div', 'lh-row'); labelledField(row, 'region', 'State / region'); labelledField(row, 'city', 'City / area'); form.append(row);
    labelledField(form, 'website', 'Website presence', 'select', 'No website found means not observed in searched sources. Website findings remain unconfirmed until validation.');
    labelledField(form, 'contact', 'Public contact', 'select');
    const more = el('details', 'lh-options'); more.append(el('summary', '', 'More filters'));
    labelledField(more, 'sources', 'Discovery sources', 'select');
    labelledField(more, 'limit', 'Maximum businesses', 'number', 'Request 1–500. A task may finish with fewer results when sources or its search budget are exhausted.');
    const check = el('label', 'lh-check'), input = el('input'); input.type = 'checkbox'; input.name = 'skipExisting'; input.checked = draft.skipExisting; input.onchange = () => { draft.skipExisting = input.checked; rememberDraft(); }; check.append(input, el('span', '', 'Skip businesses already in Leads or Clients')); more.append(check); form.append(more);
    const line = el('div', 'lh-submitline'), submit = button('Submit task', null, true); submit.type = 'submit'; submit.id = 'lh-submit-task';
    line.append(submit, el('p', '', 'Runs with Codex, one task at a time. Review results before adding them to Leads.')); form.append(line); ui.submit = submit;
    form.onsubmit = e => {
      e.preventDefault(); if (busy) return; syncModel();
      for (const name of ['goal', 'region']) { const field = form.elements[name]; if (!field.value.trim()) field.setCustomValidity(name === 'goal' ? 'Enter a goal for Discover.' : 'Enter a state or region.'); }
      if (!form.reportValidity()) return;
      const owner = sequence;
      const payload = { goal: draft.goal.trim(), provider: 'codex', model: draft.model, filters: { industry: draft.industry.trim(), region: draft.region.trim(), city: draft.city.trim(), website: draft.website, contact: draft.contact, sources: draft.sources, limit: Number(draft.limit), skipExisting: draft.skipExisting } };
      attempt(async () => { await request('submit', payload); await refresh(); if (owner === sequence) { closeMenu(); setNotice('Task submitted. Open the queue to follow its progress.'); } }, 'Submitting task…');
    };
    return form;
  }
  function sync() {
    if (!ui || !host?.isConnected) return;
    syncModel();
    const pending = snapshot.jobs.filter(j => ['queued', 'running', 'waiting', 'paused'].includes(j.status)).length, job = currentJob();
    ui.queueCount.textContent = ui.menuCount.textContent = String(pending);
    ui.title.textContent = !loaded ? 'Loading Discover…' : job ? job.goal : 'Discover is ready';
    const queueCount = snapshot.jobs.filter(j => j.status === 'queued').length;
    ui.status.textContent = !loaded ? 'Loading saved tasks and results.' : snapshot.error ? 'Stopped · ' + (snapshot.error.message || 'Discover needs recovery.') + ' · ' + snapshot.candidates.length + ' candidates saved' : !job ? (snapshot.paused ? 'Tasks paused. Submit a goal or resume the queue.' : 'No tasks yet. Set a goal to get started.') : [snapshot.paused && ['queued', 'running'].includes(job.status) ? 'Tasks paused' : stateLabel(job), countBatches(job) + ' batches saved', candidatesFor(job).length + ' candidates saved', queueCount + ' queued', snapshot.activity?.jobId === job.id ? (snapshot.activity.type === 'source' ? 'Reading source: ' + snapshot.activity.label : 'Searching public sources') : reasonText(job)].filter(Boolean).join(' · ');
    ui.dock.dataset.state = snapshot.error ? 'stopped' : snapshot.paused ? 'paused' : job?.status || 'ready';
    ui.pauseTask.hidden = !snapshot.error && !snapshot.jobs.some(j => ['queued', 'running', 'waiting', 'paused'].includes(j.status));
    const canResume = canResumeTasks();
    const label = canResume ? 'Resume tasks' : 'Pause tasks';
    ui.pauseTask.replaceChildren(icon(canResume ? 'play' : 'pause')); ui.pauseTask.setAttribute('aria-label', label); ui.pauseTask.title = label;
    ui.pauseAll.textContent = label; ui.pauseAll.hidden = !snapshot.error && !snapshot.jobs.length;
    ui.viewTask.hidden = !snapshot.jobs.length;
    ui.queueNote.textContent = snapshot.error ? 'Discover is stopped. Resolve the storage problem, then Resume tasks. Saved results remain available.' : snapshot.paused ? 'Tasks are paused. Saved results remain available for review.' : 'One task at a time. Closing the window keeps tasks running while the app is open, this Mac is awake and network is available. Quit pauses unfinished work.';
    office?.update(snapshot);
    if (activeTab === 'queue') renderQueue(); syncBusy();
  }
  function mutationControl(text, action, focusKey) { const b = button(text, () => attempt(action)); b.dataset.focus = focusKey; b.dataset.mutation = 'true'; return b; }
  function filtersDetail(job) {
    const details = el('details'), key = job.id + ':filters'; details.dataset.detail = key; details.open = expandedDetails.has(key);
    const summary = el('summary', '', 'Goal filters'); summary.dataset.focus = key; details.append(summary);
    const dl = el('dl'), f = job.filters || {};
    for (const [label, value] of [['Model', job.model || 'gpt-5.5'], ['Industry', f.industry || 'Any industry'], ['Region', f.region || 'Not recorded'], ['City', f.city || 'Any city'], ['Website', labelFor('website', f.website)], ['Contact', labelFor('contact', f.contact)], ['Sources', labelFor('sources', f.sources)], ['Limit', f.limit], ['Skip existing', f.skipExisting ? 'Yes' : 'No']]) dl.append(el('dt', '', label), el('dd', '', value));
    details.append(dl); return details;
  }
  function openSource(url) { attempt(async () => { await request('open-source', { url }); }); }
  const websiteLabel = c => c.website?.state === 'found' ? 'Website found' : c.website?.state === 'not_observed' ? 'No website found in searched sources' : 'Website status unknown';
  function renderCandidate(candidate, job, updateActions) {
    const item = el('li', 'lh-candidate'); item.dataset.candidateId = candidate.id;
    const label = el('label', 'lh-candidate-title'), input = el('input'); input.type = 'checkbox'; input.dataset.focus = candidate.id + ':select'; input.setAttribute('aria-label', 'Select ' + candidate.company);
    const ids = selected.get(job.id); input.disabled = !!candidate.importedLeadId || candidate.duplicate?.kind === 'confident'; input.checked = !input.disabled && ids.has(candidate.id);
    if (input.disabled) ids.delete(candidate.id);
    input.onchange = () => { if (input.checked) ids.add(candidate.id); else ids.delete(candidate.id); acknowledged.delete(job.id); updateActions(); };
    label.append(input, el('strong', '', candidate.company)); item.append(label);
    const location = [candidate.city, candidate.region].filter(Boolean).join(', ');
    item.append(el('p', '', [location || 'Location not observed', websiteLabel(candidate)].join(' · ')));
    item.append(el('p', '', candidate.importedLeadId ? 'Added to Leads · Validation pending' : candidate.duplicate?.kind === 'confident' ? 'Already in Leads or Clients · Not available to add' : candidate.duplicate?.kind === 'possible' ? 'Possible duplicate · Review existing records before adding' : 'Validation pending'));
    const details = el('details'); details.dataset.detail = candidate.id + ':evidence'; details.open = expandedDetails.has(details.dataset.detail);
    const summary = el('summary', '', 'Source evidence'); summary.dataset.focus = candidate.id + ':evidence'; details.append(summary);
    const observations = el('dl', 'lh-observations');
    for (const [name, value] of [['Industry', candidate.industry || 'Not observed'], ['Address', candidate.address || 'Not observed'], ['Email', candidate.contact?.email || 'Not observed'], ['Phone', candidate.contact?.phone || 'Not observed'], ['Discovered', dateLabel(candidate.discoveredAt)]]) observations.append(el('dt', '', name), el('dd', '', value));
    if (candidate.website?.url) { const value = el('dd'); const b = button(candidate.website.url, () => openSource(candidate.website.url)); b.className = 'lh-source-button'; b.dataset.focus = candidate.id + ':website'; value.append(b); observations.append(el('dt', '', 'Website'), value); }
    if (candidate.contact?.form) { const value = el('dd'); const b = button('Open public contact form', () => openSource(candidate.contact.form)); b.className = 'lh-source-button'; b.dataset.focus = candidate.id + ':form'; value.append(b); observations.append(el('dt', '', 'Contact form'), value); }
    if (candidate.duplicate?.recordIds?.length) observations.append(el('dt', '', 'Existing IDs'), el('dd', '', candidate.duplicate.recordIds.join(', ')));
    details.append(observations);
    const sources = el('ul', 'lh-source-list');
    for (const [index, source] of (candidate.sources || []).entries()) {
      const li = el('li'), b = button(source.label || source.url, () => openSource(source.url)); b.className = 'lh-source-button'; b.dataset.focus = candidate.id + ':source:' + index; b.title = source.url;
      const time = el('time', '', 'Observed ' + dateLabel(source.observedAt)); if (source.observedAt) time.dateTime = source.observedAt; li.append(b, time); sources.append(li);
    }
    if (!sources.childElementCount) details.append(el('p', '', 'No source evidence was saved.'));
    else details.append(sources);
    details.append(el('p', '', 'Public-source observations. Business details and contacts have not been independently validated.'));
    item.append(details); return item;
  }
  function resultsDetail(job) {
    const candidates = candidatesFor(job), detail = el('details'), key = job.id + ':results'; detail.dataset.detail = key; detail.open = expandedDetails.has(key);
    const summary = el('summary', '', 'Review results (' + candidates.length + ')'); summary.dataset.focus = key; detail.append(summary);
    if (!candidates.length) { detail.append(el('p', '', ['running', 'queued', 'waiting', 'paused'].includes(job.status) ? 'No candidates have been saved yet. Completed search batches will appear here.' : 'No candidates were saved. ' + (reasonText(job) || 'The search ended without source-backed matches.'))); return detail; }
    if (!selected.has(job.id)) selected.set(job.id, new Set());
    const ids = selected.get(job.id), actions = el('div', 'lh-result-actions'), list = el('ul', 'lh-resultlist');
    const updateActions = () => {
      const chosen = candidates.filter(c => ids.has(c.id) && !c.importedLeadId && c.duplicate?.kind !== 'confident');
      const possible = chosen.filter(c => c.duplicate?.kind === 'possible').length;
      actions.replaceChildren(el('p', '', chosen.length + ' selected · Added leads start in New, with validation pending.'));
      if (possible) {
        const label = el('label', 'lh-check'), check = el('input'); check.type = 'checkbox'; check.checked = acknowledged.has(job.id); check.dataset.focus = job.id + ':acknowledge';
        check.onchange = () => { if (check.checked) acknowledged.add(job.id); else acknowledged.delete(job.id); const add = actions.querySelector('[data-mutation]'); add.disabled = busy || !check.checked; add.dataset.unavailable = String(!check.checked); };
        label.append(check, el('span', '', 'I reviewed the ' + possible + ' possible duplicate' + (possible === 1 ? '' : 's') + ' and want to add ' + (possible === 1 ? 'it' : 'them') + '.')); actions.append(label);
      }
      const add = mutationControl('Add selected to Leads', async () => {
        const selectedNow = candidates.filter(c => ids.has(c.id) && !c.importedLeadId && c.duplicate?.kind !== 'confident');
        if (!selectedNow.length) return;
        const result = await request('import', { candidateIds: selectedNow.map(c => c.id), acknowledgePossibleDuplicates: acknowledged.has(job.id) });
        await refresh();
        const rejected = result.rejected || []; for (const c of selectedNow) if (!rejected.some(r => (typeof r === 'string' ? r : r.candidateId || r.id) === c.id)) ids.delete(c.id);
        const created = result.createdLeadIds?.length || 0, existing = result.existingLeadIds?.length || 0;
        const errors = rejected.map(r => typeof r === 'string' ? r : r.reason?.message || r.reason || r.error || 'Candidate could not be added').join('; ');
        setNotice(created + ' added to Leads' + (existing ? ' · ' + existing + ' already saved' : '') + (rejected.length ? ' · ' + rejected.length + ' not added: ' + errors : '') + '. Validation remains pending.', rejected.length > 0);
      }, job.id + ':import');
      const unavailable = !chosen.length || (possible > 0 && !acknowledged.has(job.id)); add.dataset.unavailable = String(unavailable); add.disabled = busy || unavailable; actions.append(add);
    };
    for (const candidate of candidates) list.append(renderCandidate(candidate, job, updateActions));
    updateActions(); detail.append(list, actions); return detail;
  }
  function renderQueue() {
    if (!ui) return;
    const list = ui.taskList, focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focus : null, scroll = ui.queuePane.scrollTop;
    for (const d of list.querySelectorAll('details[data-detail]')) { if (d.open) expandedDetails.add(d.dataset.detail); else expandedDetails.delete(d.dataset.detail); }
    list.replaceChildren();
    if (!loaded) { list.append(el('p', 'lh-intro', 'Loading saved tasks…')); return; }
    if (!snapshot.jobs.length) { const empty = el('div', 'lh-empty'); empty.append(el('h3', '', 'No tasks yet'), el('p', '', 'Click Discover and submit your first goal.')); list.append(empty); return; }
    for (const [index, job] of snapshot.jobs.entries()) {
      const item = el('article', 'lh-task'); item.dataset.jobId = job.id;
      const top = el('div', 'lh-tasktop'), status = el('span', 'lh-badge', stateLabel(job)); status.dataset.state = job.status; top.append(el('span', '', 'Task ' + (index + 1)), status);
      item.append(top, el('h3', '', job.goal), el('p', '', [job.filters?.industry || 'Any industry', job.filters?.city || job.filters?.region || 'Region not recorded', labelFor('website', job.filters?.website)].join(' · ')));
      item.append(el('p', '', countBatches(job) + ' batches saved · ' + candidatesFor(job).length + ' candidates saved'));
      if (snapshot.error && job.status === 'running') item.append(el('p', '', 'Stopped: ' + (snapshot.error.message || 'Discover needs recovery.') + ' Resume after resolving the storage problem.'));
      else if (reasonText(job)) item.append(el('p', '', reasonText(job)));
      else if (job.status === 'queued') item.append(el('p', '', snapshot.paused ? 'Waiting until tasks are resumed.' : 'Waiting for earlier tasks to finish.'));
      else if (job.status === 'running') item.append(el('p', '', 'Searching public sources. Results appear after each completed batch.'));
      else if (job.status === 'completed') item.append(el('p', '', 'Search finished. Review source evidence before adding to Leads.'));
      item.append(filtersDetail(job), resultsDetail(job));
      if (['queued', 'running', 'waiting', 'paused'].includes(job.status)) {
        const actions = el('div', 'lh-task-actions');
        if (job.status === 'paused' || (job.status === 'waiting' && ['AUTH', 'QUOTA'].includes(job.errorCode))) actions.append(mutationControl('Resume tasks', async () => { await request('resume'); await refresh(); setNotice('Tasks resumed.'); }, job.id + ':resume'));
        actions.append(mutationControl('Cancel task', async () => { await request('cancel', { id: job.id }); await refresh(); setNotice('Task cancelled. Saved results remain available.'); }, job.id + ':cancel')); item.append(actions);
      }
      list.append(item);
    }
    ui.queuePane.scrollTop = scroll;
    if (focusKey) { const focus = [...list.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focusKey && !n.disabled); (focus || ui.queueTab).focus({ preventScroll: true }); }
  }
  function dispose() {
    ++sequence;
    if (typeof unsubscribe === 'function') unsubscribe(); unsubscribe = null;
    office?.destroy(); office = null;
    if (ui?.dialog.open) ui.dialog.close();
    ui = null; host = null; busy = false; submitting = false;
  }
  async function render(target) {
    dispose(); host = target; const token = sequence; eventVersion = 0; loaded = false; busy = false; activeTab = 'goal';
    target.replaceChildren(); target.className = 'ws-lead-hunter'; modelCatalogKey = '';
    const heading = el('header', 'lh-heading'), titles = el('div'); titles.append(el('h1', '', 'Lead hunter'), el('p', '', 'Your office for finding new opportunities.'));
    const controls = el('div', 'lh-controls');
    const animation = iconButton(animationPaused ? 'play' : 'pause', animationPaused ? 'Resume office animation' : 'Pause office animation', () => { animationPaused = !animationPaused; office?.setMotionPaused(animationPaused); const label = animationPaused ? 'Resume office animation' : 'Pause office animation'; animation.replaceChildren(icon(animationPaused ? 'play' : 'pause')); animation.setAttribute('aria-pressed', String(animationPaused)); animation.setAttribute('aria-label', label); animation.title = label; }); animation.setAttribute('aria-pressed', String(animationPaused)); animation.id = 'lh-animation-toggle';
    const queue = button('Queue', () => openMenu('queue')), queueCount = el('span', 'lh-count', '0'); queue.prepend(icon('queue')); queue.append(queueCount); queue.id = 'lh-open-queue'; controls.append(animation, queue); heading.append(titles, controls); target.append(heading);
    const officeSection = el('section', 'lh-office'); officeSection.setAttribute('aria-label', 'Pixel discovery office'); const scene = el('div', 'lh-scene'), hint = el('p', 'lh-hint'); hint.append(el('strong', '', 'Click Discover'), document.createTextNode(' to give the agent a goal.')); officeSection.append(scene, hint); target.append(officeSection);
    const dock = el('div', 'lh-taskdock'); dock.setAttribute('aria-label', 'Discover task status'); const dot = el('i', 'lh-status-dot'); dot.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'lh-taskcopy'), title = el('strong'), status = el('p'); copy.setAttribute('role', 'status'); copy.setAttribute('aria-live', 'polite'); copy.setAttribute('aria-atomic', 'true'); copy.append(title, status);
    const pauseAction = () => attempt(async () => { const resume = canResumeTasks(); await request(resume ? 'resume' : 'pause'); await refresh(); setNotice(resume ? 'Tasks resumed.' : 'Tasks paused. Saved results are kept.'); });
    const pauseTask = iconButton('pause', 'Pause tasks', pauseAction); pauseTask.id = 'lh-pause-task'; const viewTask = button('View task', () => openMenu('queue')); dock.append(dot, copy, pauseTask, viewTask); target.append(dock);
    const noticeNode = el('p', 'lh-notice'); noticeNode.hidden = true; target.append(noticeNode);
    const footer = el('footer', 'lh-footer'), credit = button('Pixel Office by 2dPig · CC0', () => window.mavis.openExternal('https://2dpig.itch.io/pixel-office')); credit.className = 'lh-credit'; footer.append(credit, el('span', '', 'Discovery observations · Validation pending')); target.append(footer);
    const dialog = el('dialog', 'lh-drawer'); dialog.id = 'lh-agent-menu'; dialog.setAttribute('aria-labelledby', 'lh-menu-title');
    const head = el('div', 'lh-drawerhead'), text = el('div'), menuTitle = el('h2', '', 'Discover'); menuTitle.id = 'lh-menu-title'; text.append(menuTitle, el('p', '', 'Give this agent a goal. It handles one task at a time.')); head.append(text, iconButton('close', 'Close Discover menu', closeMenu)); dialog.append(head);
    const tabs = el('div', 'lh-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Discover menu');
    const goalTab = button('Goals & filters', () => switchTab('goal')), queueTab = button('Task queue', () => switchTab('queue')), menuCount = el('span', 'lh-count', '0'); queueTab.append(menuCount);
    for (const [name, b] of [['goal', goalTab], ['queue', queueTab]]) { b.id = 'lh-' + name + '-tab'; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'lh-' + name + '-pane'); tabs.append(b); }
    tabs.onkeydown = e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); switchTab(e.key === 'Home' ? 'goal' : e.key === 'End' ? 'queue' : activeTab === 'goal' ? 'queue' : 'goal', true); } }; dialog.append(tabs);
    const goalPane = el('div', 'lh-pane'), queuePane = el('div', 'lh-pane');
    for (const [name, pane] of [['goal', goalPane], ['queue', queuePane]]) { pane.id = 'lh-' + name + '-pane'; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', 'lh-' + name + '-tab'); }
    const goalNotice = el('p', 'lh-notice'), queueNotice = el('p', 'lh-notice'); goalNotice.hidden = queueNotice.hidden = true;
    goalPane.append(goalNotice, el('p', 'lh-intro', 'Describe who you want to find, then narrow the search below.'));
    const queueBar = el('div', 'lh-queuebar'), queueNote = el('p'), pauseAll = button('Pause tasks', pauseAction); pauseAll.id = 'lh-pause-all'; queueBar.append(queueNote, pauseAll);
    const taskList = el('div'); taskList.id = 'lh-task-list'; queuePane.append(queueNotice, queueBar, taskList); dialog.append(goalPane, queuePane); target.append(dialog);
    ui = { dialog, goalPane, queuePane, goalTab, queueTab, queueCount, menuCount, title, status, dock, pauseTask, viewTask, pauseAll, queueNote, taskList, notice: noticeNode, goalNotice, queueNotice };
    goalPane.append(goalForm());
    dialog.addEventListener('close', () => { office?.setMenuOpen(false); if (host?.isConnected) (returnFocus?.isConnected ? returnFocus : office?.agent)?.focus({ preventScroll: true }); });
    dialog.onclick = e => { if (e.target === dialog && e.clientX < dialog.getBoundingClientRect().left) closeMenu(); };
    office = MT.leadHunterOffice.create(scene, { onDiscover: () => openMenu(), onError: message => setNotice(message, true) }); office.setMotionPaused(animationPaused);
    switchTab('goal'); setNotice(notice, noticeError); sync();
    unsubscribe = window.mavis.onHunterChanged?.(value => { if (token !== sequence || !host?.isConnected) return; eventVersion++; applySnapshot(value); });
    try { await refresh(); }
    catch (e) { if (token === sequence && target.isConnected) { setNotice('Discover could not load: ' + e.message + ' Use Retry to reconnect.', true); const retry = button('Retry', () => attempt(async () => { await refresh(); setNotice('Discover reconnected.'); })); retry.id = 'lh-retry'; target.insertBefore(retry, footer); } }
  }
  MT.leadHunter = { render, dispose, hasDraft: () => !!draft.goal.trim(), beforeClose: async () => true };
})();
