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
  const validationDefaults = () => ({ goal: '', model: '', industry: '', region: '', city: '', website: 'any', contact: 'any', checkDuplicates: true });
  let validationDraft = validationDefaults();
  try { const saved = JSON.parse(localStorage.getItem('mavis-hunter-validation-draft')); if (saved && typeof saved === 'object') { for (const key of ['goal', 'model', 'industry', 'region', 'city']) if (typeof saved[key] === 'string') validationDraft[key] = saved[key]; for (const key of ['website', 'contact']) if (choices[key].some(([value]) => value === saved[key])) validationDraft[key] = saved[key]; if (typeof saved.checkDuplicates === 'boolean') validationDraft.checkDuplicates = saved.checkDuplicates; } } catch {}
  const enrichmentGroups = { offerings: 'Services and products', contacts: 'Public contacts', branding: 'Observed branding', website: 'Website observations', brief: 'Mockup brief' };
  let enrichmentDraft = { goal: '', model: '', groups: Object.fromEntries(Object.keys(enrichmentGroups).map(key => [key, true])) };
  try { const saved = JSON.parse(localStorage.getItem('mavis-hunter-enrichment-draft')); if (saved && typeof saved === 'object') { for (const key of ['goal', 'model']) if (typeof saved[key] === 'string') enrichmentDraft[key] = saved[key]; for (const key of Object.keys(enrichmentGroups)) if (typeof saved.groups?.[key] === 'boolean') enrichmentDraft.groups[key] = saved.groups[key]; } } catch {}
  const enrichmentSelection = new Set();
  let enrichPickerOffset = 0, enrichPickerSearch = '', enrichPickerJobId = '', enrichPickerPage = { items: [], total: 0 }, enrichPickerLoading = false, enrichPickerError = '', enrichPickerRequest = 0, enrichPickerTimer = null;
  let enrichResultsOffset = 0, enrichResultsSearch = '', enrichResultsJobId = '', enrichResultPage = { items: [], total: 0 }, enrichResultsLoading = false, enrichResultsError = '', enrichResultsRequest = 0, enrichResultsTimer = null;
  function rememberEnrichmentDraft() { try { localStorage.setItem('mavis-hunter-enrichment-draft', JSON.stringify(enrichmentDraft)); } catch { setNotice('Enrich draft backup is unavailable. Keep this screen open until you submit.', true); } }
  const validationSelection = new Set(), discoveryOffsets = new Map();
  let stage = 'discover', pickerOffset = 0, pickerSearch = '', pickerJobId = '', pickerPage = { items: [], total: 0 }, pickerLoading = false, pickerError = '', pickerRequest = 0, pickerTimer = null;
  let resultsOffset = 0, resultsJobId = '', resultPage = { items: [], total: 0 }, resultsLoading = false, resultsError = '', resultsRequest = 0, queueOffset = 0;
  const isValidation = job => job?.kind === 'validate';
  const isEnrichment = job => job?.kind === 'enrich';
  const isDiscovery = job => !job?.kind || job.kind === 'discover';
  const stageFor = job => isEnrichment(job) ? 'enrich' : isValidation(job) ? 'validate' : 'discover';
  const stageLabel = job => isEnrichment(job) ? 'Enrich' : isValidation(job) ? 'Validate' : 'Discover';
  const validationResultsFor = job => (snapshot.validationResults || []).filter(result => result.taskId === job.id);
  const taskCount = job => isEnrichment(job) ? (snapshot.enrichmentResults || []).filter(result => result.taskId === job.id).length + ' of ' + (job.targetCandidateIds?.length || 0) + ' enriched' : isValidation(job) ? validationResultsFor(job).length + ' of ' + (job.targetCandidateIds?.length || 0) + ' checked' : candidatesFor(job).length + ' candidates saved';
  function rememberValidationDraft() { try { localStorage.setItem('mavis-hunter-validation-draft', JSON.stringify(validationDraft)); } catch { setNotice('Validate draft backup is unavailable. Keep this screen open until you submit.', true); } }
  let host = null, office = null, unsubscribe = null, sequence = 0, eventVersion = 0;
  let snapshot = { version: 1, paused: false, jobs: [], candidates: [] }, ui = null, busy = false, submitting = false, loaded = false, animationPaused = false;
  let modelCatalogKey = '';
  let notice = '', noticeError = false, activeTab = 'goal', returnFocus = null, menuGeneration = 0;
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
    for (const n of [ui.notice, ui.goalNotice, ui.queueNotice, ui.resultsNotice]) { n.textContent = notice; n.hidden = !notice; n.dataset.error = String(noticeError); n.setAttribute('role', noticeError ? 'alert' : 'status'); }
  }
  function applySnapshot(value) {
    const next = value?.snapshot || value;
    if (!next || !Array.isArray(next.jobs) || !Array.isArray(next.candidates)) return;
    const candidateKey = value => JSON.stringify(value.candidates.map(candidate => [candidate.id, candidate.importedLeadId, candidate.duplicate?.kind]));
    const candidatesChanged = candidateKey(snapshot) !== candidateKey(next), eligibilityKey = value => JSON.stringify([value.candidates, (value.jobs || []).filter(isValidation).map(job => [job.id, job.targetCandidateIds]), value.validationResults || []]), eligibilityChanged = eligibilityKey(snapshot) !== eligibilityKey(next), enrichResultsChanged = JSON.stringify(snapshot.enrichmentResults || []) !== JSON.stringify(next.enrichmentResults || []), resultsChanged = JSON.stringify(snapshot.validationResults || []) !== JSON.stringify(next.validationResults || []);
    const hadError = !!snapshot.error; snapshot = next; loaded = true;
    if (next.error) setNotice('Discover stopped: ' + (next.error.message || 'Saved state could not be updated.') + ' Saved results remain available. Resolve the storage problem, then retry.', true);
    else if (hadError && notice.startsWith('Discover stopped:')) setNotice('');
    sync();
    if (ui.dialog.open && stage === 'validate') { if (activeTab === 'goal' && candidatesChanged) loadPicker(); if (activeTab === 'results' && resultsChanged) loadValidationResults(); }
    if (ui.dialog.open && stage === 'enrich') { if (activeTab === 'goal' && eligibilityChanged) loadEnrichmentPicker(); if (activeTab === 'results' && (enrichResultsChanged || eligibilityChanged)) loadEnrichmentResults(); }
  }
  async function refresh() { const eventAtStart = eventVersion, owner = sequence, value = await request('status'); if (owner === sequence && eventAtStart === eventVersion) applySnapshot(value); }
  async function attempt(fn, pendingText, menuContext = null) {
    if (busy || !host?.isConnected) return;
    const owner = sequence, focused = document.activeElement, actionMenuGeneration = menuGeneration;
    const inDialog = !!ui?.dialog.open && ui.dialog.contains(focused);
    const actionFocus = focused?.matches('button') ? { node: focused, key: focused.dataset.focus, id: focused.id, jobId: focused.closest('[data-job-id]')?.dataset.jobId, inDialog } : null;
    const safeFocus = inDialog ? ui[activeTab + 'Tab'] : focused === ui?.pauseTask ? ui.viewTask : null;
    busy = true; submitting = pendingText === 'Submitting task…'; setNotice(pendingText || ''); syncBusy();
    // Native disabled buttons lose focus. Keep focus on a stable semantic control while the action runs.
    if (actionFocus && focused.disabled && safeFocus && !safeFocus.hidden) safeFocus.focus({ preventScroll: true });
    try { await fn(); }
    catch (e) { if (owner === sequence && (menuContext === null || (ui?.dialog.open && menuContext === menuGeneration))) setNotice(e.message || 'Discover could not complete that action. Try again.', true); }
    finally { if (owner === sequence) {
      const restoreFocus = actionFocus && (document.activeElement === safeFocus || document.activeElement === document.body);
      busy = false; submitting = false;
      if (host?.isConnected) {
        sync(); syncBusy();
        // Restore only if the user has not moved elsewhere during the request, and the original menu is still open.
        if (restoreFocus && (!actionFocus.inDialog || (ui.dialog.open && menuGeneration === actionMenuGeneration))) {
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
    ui.submit.textContent = submitting && stage === 'discover' ? 'Submitting…' : 'Submit task';
    if (ui.validationSubmit) { ui.validationSubmit.disabled = busy || !loaded || !!snapshot.error || !validationModelAvailable() || !validationSelection.size; ui.validationSubmit.textContent = submitting && stage === 'validate' ? 'Submitting…' : 'Submit validation task'; }
    for (const node of ui.picker?.querySelectorAll('input[type=checkbox]') || []) node.disabled = busy || (!node.checked && validationSelection.size >= 100);
    if (ui.selectPage) ui.selectPage.disabled = busy || pickerLoading || !pickerPage.items.length || (validationSelection.size >= 100 && !pickerPage.items.every(candidate => validationSelection.has(candidate.id)));
    if (ui.clearSelection) ui.clearSelection.disabled = busy || !validationSelection.size;
    if (ui.enrichmentSubmit) { ui.enrichmentSubmit.disabled = busy || !loaded || !!snapshot.error || !enrichmentModelAvailable() || !enrichmentSelection.size || !Object.values(enrichmentDraft.groups).some(Boolean); ui.enrichmentSubmit.textContent = submitting && stage === 'enrich' ? 'Submitting…' : 'Submit enrichment task'; }
    for (const node of ui.enrichPicker?.querySelectorAll('input[type=checkbox]') || []) node.disabled = busy || (!node.checked && enrichmentSelection.size >= 100);
    if (ui.enrichSelectPage) ui.enrichSelectPage.disabled = busy || enrichPickerLoading || !enrichPickerPage.items.length || (enrichmentSelection.size >= 100 && !enrichPickerPage.items.every(candidate => enrichmentSelection.has(candidate.id)));
    if (ui.enrichClearSelection) ui.enrichClearSelection.disabled = busy || !enrichmentSelection.size;
  }
  function switchTab(name, focus = false) {
    if (name === 'results' && stage === 'discover') name = 'queue';
    activeTab = name;
    for (const id of ['goal', 'queue', 'results']) { const on = id === name; ui[id + 'Pane'].hidden = !on; ui[id + 'Tab'].setAttribute('aria-selected', String(on)); ui[id + 'Tab'].tabIndex = on ? 0 : -1; }
    if (name === 'queue') renderQueue();
    if (name === 'goal' && stage === 'validate') loadPicker();
    if (name === 'goal' && stage === 'enrich') loadEnrichmentPicker();
    if (name === 'results') { if (stage === 'enrich') loadEnrichmentResults(); else loadValidationResults(); }
    if (focus) ui[name + 'Tab'].focus();
  }
  function openMenu(name = 'goal', agent = stage) {
    if (!ui || !host?.isConnected) return;
    ++menuGeneration;
    if (!ui.dialog.open) returnFocus = document.activeElement;
    stage = agent; ui.dialog.dataset.stage = stage;
    const validating = stage === 'validate', enriching = stage === 'enrich', nameLabel = enriching ? 'Enrich' : validating ? 'Validate' : 'Discover';
    ui.menuTitle.textContent = nameLabel;
    ui.menuSubtitle.textContent = enriching ? 'Add details to businesses that passed Validate.' : validating ? 'Check selected Discover candidates.' : 'Give this agent a goal. It handles one task at a time.';
    ui.closeButton.setAttribute('aria-label', 'Close ' + nameLabel + ' menu'); ui.tabs.setAttribute('aria-label', nameLabel + ' menu');
    ui.discoveryForm.hidden = stage !== 'discover'; ui.discoveryIntro.hidden = stage !== 'discover'; ui.validationForm.hidden = !validating; ui.enrichmentForm.hidden = !enriching; ui.resultsTab.hidden = stage === 'discover';
    ui.validationResultsBody.hidden = !validating; ui.enrichmentResultsBody.hidden = !enriching;
    ui.goalTab.textContent = stage === 'discover' ? 'Goals & filters' : 'Goal';
    office?.setMenuOpen(stage === 'discover'); office?.setValidateMenuOpen(validating); office?.setEnrichMenuOpen(enriching);
    switchTab(name);
    if (!ui.dialog.open) ui.dialog.showModal();
    ui[activeTab + 'Tab'].focus();
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
    syncModel(); syncValidationModel(); syncEnrichmentModel(); syncPickerSelection(); syncEnrichmentSelection(); syncValidationResultContext(); syncEnrichmentResultContext();
    const pending = snapshot.jobs.filter(j => ['queued', 'running', 'waiting', 'paused'].includes(j.status)).length, job = currentJob();
    ui.queueCount.textContent = ui.menuCount.textContent = String(pending);
    ui.title.textContent = !loaded ? 'Loading office…' : job ? job.goal : 'Discover, Validate and Enrich are ready';
    const queueCount = snapshot.jobs.filter(j => j.status === 'queued').length;
    ui.status.textContent = !loaded ? 'Loading saved tasks and results.' : snapshot.error ? 'Stopped · ' + (snapshot.error.message || 'Discover needs recovery.') + ' · ' + snapshot.candidates.length + ' candidates saved' : !job ? (snapshot.paused ? 'Tasks paused. Submit a goal or resume the queue.' : 'No tasks yet. Set a goal to get started.') : [stageLabel(job), snapshot.paused && ['queued', 'running'].includes(job.status) ? 'Tasks paused' : stateLabel(job), countBatches(job) + ' batches saved', taskCount(job), queueCount + ' queued', snapshot.activity?.jobId === job.id ? (snapshot.activity.type === 'source' ? 'Reading source: ' + snapshot.activity.label : isEnrichment(job) ? 'Enriching business details' : isValidation(job) ? 'Checking business evidence' : 'Searching public sources') : reasonText(job)].filter(Boolean).join(' · ');
    ui.dock.dataset.kind = job ? stageFor(job) : '';
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
  function pageControls(offset, total, change, key) {
    const nav = el('nav', 'lh-pagination'); nav.setAttribute('aria-label', 'Pages');
    const prev = button('Previous', () => change(Math.max(0, offset - 25))), next = button('Next', () => change(offset + 25));
    prev.disabled = offset === 0; next.disabled = offset + 25 >= total;
    prev.dataset.focus = key + ':previous'; next.dataset.focus = key + ':next';
    const label = el('span', '', total ? (offset + 1) + '–' + Math.min(offset + 25, total) + ' of ' + total : '0 results');
    nav.append(prev, label, next); return nav;
  }
  const validationModelAvailable = () => snapshot.models?.some(model => model.id === validationDraft.model && model.available === true);
  function syncValidationModel() {
    if (!ui?.validationModel) return;
    const models = snapshot.models || [];
    if (loaded && !validationDraft.model) { validationDraft.model = snapshot.defaultModel || 'gpt-5.5'; rememberValidationDraft(); }
    const key = JSON.stringify([models, validationDraft.model]);
    if (ui.validationModel.dataset.catalog !== key) {
      ui.validationModel.replaceChildren();
      for (const model of models) { const option = el('option', '', (model.label || model.id) + (model.available ? '' : ' (unavailable)')); option.value = model.id; option.disabled = model.available !== true; ui.validationModel.append(option); }
      if (!models.some(model => model.id === validationDraft.model)) { const option = el('option', '', validationDraft.model ? validationDraft.model + ' (unavailable)' : 'Loading models…'); option.value = validationDraft.model; option.disabled = true; ui.validationModel.append(option); }
      ui.validationModel.dataset.catalog = key;
    }
    ui.validationModel.value = validationDraft.model;
    const selectedModel = models.find(model => model.id === validationDraft.model);
    const reason = !loaded ? 'Checking available models…' : validationModelAvailable() ? 'Saved with this task. Changes apply to new Validate tasks.' : (selectedModel?.reason || 'The saved model is unavailable.') + ' Choose an available model to submit.';
    ui.validationModelHelp.textContent = reason;
    ui.validationModel.setCustomValidity(loaded && !validationModelAvailable() ? reason : '');
  }
  function validationField(parent, name, text, type = 'text', hint = '') {
    const label = el('label', 'lh-field'); label.append(el('span', '', text));
    const input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input'); input.name = name; input.id = 'lh-validation-' + name; label.htmlFor = input.id;
    if (type === 'select' && name !== 'model') for (const [value, copy] of choices[name]) { const option = el('option', '', copy); option.value = value; input.append(option); }
    if (type === 'text') input.type = 'text';
    if (name === 'goal') { input.required = true; input.rows = 3; input.maxLength = 240; input.placeholder = 'Describe what you want to check.'; }
    else if (name === 'industry') { input.maxLength = 120; input.placeholder = 'Any industry'; }
    else if (['region', 'city'].includes(name)) { input.maxLength = 80; input.placeholder = name === 'region' ? 'Any state / region' : 'Any city / area'; }
    input.value = validationDraft[name];
    input.oninput = () => { input.setCustomValidity(''); validationDraft[name] = input.value; rememberValidationDraft(); if (name === 'model') { syncValidationModel(); syncBusy(); } };
    label.append(input);
    if (hint) { const help = el('small', '', hint); help.id = input.id + '-help'; input.setAttribute('aria-describedby', help.id); label.append(help); if (name === 'model') ui.validationModelHelp = help; }
    if (name === 'model') ui.validationModel = input;
    parent.append(label); return input;
  }
  function validationForm() {
    const form = el('form', 'lh-goal-form'); form.id = 'lh-validation-form';
    form.append(el('p', 'lh-intro', 'Choose Discover candidates, then set the checks. Validation saves evidence without changing Leads or Clients.'));
    const picker = el('fieldset', 'lh-candidate-picker'); picker.append(el('legend', '', 'Discover candidates'));
    const searchLabel = el('label', 'lh-field'); searchLabel.append(el('span', '', 'Search candidates'));
    const search = el('input'); search.type = 'search'; search.id = 'lh-validation-search'; search.maxLength = 120; search.placeholder = 'Business name, industry or location'; search.value = pickerSearch;
    search.oninput = () => { pickerSearch = search.value; pickerOffset = 0; clearTimeout(pickerTimer); pickerTimer = setTimeout(loadPicker, 200); }; searchLabel.append(search); picker.append(searchLabel);
    const filterLabel = el('label', 'lh-field'); filterLabel.append(el('span', '', 'Discovery task')); const filter = el('select'); filter.id = 'lh-validation-job-filter'; filter.onchange = () => { pickerJobId = filter.value; pickerOffset = 0; loadPicker(); }; filterLabel.append(filter); picker.append(filterLabel);
    const selectedCount = el('p', 'lh-selection-count'); selectedCount.id = 'lh-validation-selection-count'; selectedCount.setAttribute('role', 'status');
    const actions = el('div', 'lh-picker-actions');
    const selectPage = button('Select this page', () => {
      const allSelected = pickerPage.items.every(candidate => validationSelection.has(candidate.id));
      if (allSelected) for (const candidate of pickerPage.items) validationSelection.delete(candidate.id);
      else for (const candidate of pickerPage.items) { if (validationSelection.size >= 100) break; validationSelection.add(candidate.id); }
      renderPicker(); syncPickerSelection(); syncBusy();
    }); selectPage.id = 'lh-validation-select-page';
    const clear = button('Clear selection', () => { validationSelection.clear(); renderPicker(); syncPickerSelection(); syncBusy(); }); clear.id = 'lh-validation-clear'; actions.append(selectPage, clear);
    const pickerStatus = el('p', 'lh-picker-status'); pickerStatus.setAttribute('role', 'status'); picker.append(pickerStatus); ui.pickerStatus = pickerStatus;
    const list = el('div'); list.id = 'lh-validation-picker'; const pagination = el('div'); pagination.id = 'lh-validation-picker-pagination';
    picker.append(selectedCount, el('p', 'lh-intro', 'Up to 100 per task. Selections stay across pages and searches. Imported businesses and duplicates can be checked.'), actions, list, pagination); form.append(picker);
    Object.assign(ui, { picker: list, pickerJobFilter: filter, pickerPagination: pagination, selectedCount, selectPage, clearSelection: clear });
    validationField(form, 'goal', 'Goal', 'textarea'); validationField(form, 'model', 'Model', 'select', 'Checking available models…');
    validationField(form, 'industry', 'Industry'); const row = el('div', 'lh-row'); validationField(row, 'region', 'State / region'); validationField(row, 'city', 'City / area'); form.append(row);
    validationField(form, 'website', 'Website requirement', 'select', 'No website found stays inconclusive about actual absence. Has a website checks reachability and business ownership.');
    validationField(form, 'contact', 'Public contact', 'select', 'Any public contact inspects available evidence without requiring one. Emails are checked for public association, never deliverability.');
    const check = el('label', 'lh-check'), input = el('input'); input.type = 'checkbox'; input.name = 'checkDuplicates'; input.checked = validationDraft.checkDuplicates; input.onchange = () => { validationDraft.checkDuplicates = input.checked; rememberValidationDraft(); }; check.append(input, el('span', '', 'Check existing Leads and Clients for duplicates')); form.append(check);
    const line = el('div', 'lh-submitline'), submit = button('Submit validation task', null, true); submit.type = 'submit'; submit.id = 'lh-submit-validation'; ui.validationSubmit = submit;
    line.append(submit, el('p', '', 'Queued with Discover, one task at a time. Unknown evidence needs review; nothing is automatically imported.')); form.append(line);
    form.onsubmit = event => {
      event.preventDefault(); if (busy) return; syncValidationModel();
      form.elements.goal.setCustomValidity(validationDraft.goal.trim() ? '' : 'Enter a goal for Validate.');
      if (!validationSelection.size || validationSelection.size > 100) { setNotice('Choose 1–100 Discover candidates before submitting.', true); search.focus(); return; }
      if (!form.reportValidity()) return;
      const owner = sequence, candidateIds = [...validationSelection];
      const payload = { goal: validationDraft.goal.trim(), provider: 'codex', model: validationDraft.model, candidateIds, criteria: { industry: validationDraft.industry.trim(), region: validationDraft.region.trim(), city: validationDraft.city.trim(), website: validationDraft.website, contact: validationDraft.contact, checkDuplicates: validationDraft.checkDuplicates } };
      attempt(async () => { await request('submit-validation', payload); await refresh(); if (owner === sequence) { for (const id of candidateIds) validationSelection.delete(id); closeMenu(); setNotice('Validate task submitted. Open the shared queue to follow its progress.'); } }, 'Submitting task…');
    };
    return form;
  }
  function syncPickerSelection() {
    if (!ui?.selectedCount) return;
    ui.selectedCount.textContent = validationSelection.size + ' / 100 selected' + (validationSelection.size >= 100 ? ' · Task limit reached' : '');
    ui.selectPage.textContent = pickerPage.items.length && pickerPage.items.every(candidate => validationSelection.has(candidate.id)) ? 'Unselect this page' : 'Select this page';
  }
  async function loadPicker() {
    if (!ui || !host?.isConnected) return;
    const token = ++pickerRequest, owner = sequence; pickerLoading = true; pickerError = ''; renderPicker();
    const options = [['', 'All Discover tasks'], ...snapshot.jobs.filter(isDiscovery).map(job => [job.id, job.goal])];
    const catalog = JSON.stringify(options);
    if (ui.pickerJobFilter.dataset.catalog !== catalog) { ui.pickerJobFilter.replaceChildren(); for (const [value, copy] of options) { const option = el('option', '', copy); option.value = value; ui.pickerJobFilter.append(option); } ui.pickerJobFilter.dataset.catalog = catalog; }
    ui.pickerJobFilter.value = pickerJobId;
    try { const page = await request('candidates', { search: pickerSearch.trim(), offset: pickerOffset, limit: 25, ...(pickerJobId ? { jobId: pickerJobId } : {}) });
      if (owner !== sequence || token !== pickerRequest) return;
      if (!Array.isArray(page?.items)) throw new Error('Candidates could not be loaded. Try again.');
      pickerPage = page; pickerOffset = page.offset;
      if (pickerOffset >= page.total && pickerOffset > 0) { pickerOffset = Math.max(0, Math.floor((page.total - 1) / 25) * 25); return loadPicker(); }
    } catch (error) { if (owner === sequence && token === pickerRequest) pickerError = error.message || 'Candidates could not be loaded. Try again.'; }
    finally { if (owner === sequence && token === pickerRequest) { pickerLoading = false; renderPicker(); syncBusy(); } }
  }
  function renderPicker() {
    if (!ui?.picker) return;
    const focus = ui.picker.contains(document.activeElement) || ui.pickerPagination.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    ui.pickerStatus.textContent = pickerLoading ? 'Loading candidates…' : '';
    if (pickerLoading) { ui.picker.setAttribute('aria-busy', 'true'); syncBusy(); return; }
    ui.picker.replaceChildren(); ui.pickerPagination.replaceChildren();
    ui.picker.setAttribute('aria-busy', 'false');
    if (pickerError) { const error = el('p', 'lh-notice', pickerError); error.dataset.error = 'true'; error.setAttribute('role', 'alert'); ui.picker.append(error, button('Retry candidates', loadPicker)); }
    else if (!pickerPage.total) ui.picker.append(el('p', 'lh-empty', pickerSearch || pickerJobId ? 'No candidates match these filters. Your selections are retained.' : 'No Discover candidates yet. Run Discover first, then choose businesses here.'));
    else for (const candidate of pickerPage.items.slice(0, 25)) {
      const row = el('label', 'lh-picker-candidate'); row.dataset.validationCandidateId = candidate.id;
      const check = el('input'); check.type = 'checkbox'; check.checked = validationSelection.has(candidate.id); check.dataset.focus = candidate.id + ':validate-select'; check.disabled = busy || (!check.checked && validationSelection.size >= 100);
      check.onchange = () => { if (check.checked && validationSelection.size < 100) validationSelection.add(candidate.id); else { validationSelection.delete(candidate.id); check.checked = false; } syncPickerSelection(); syncBusy(); };
      const copy = el('span'); copy.append(el('strong', '', candidate.company), el('small', '', [candidate.industry, candidate.address || candidate.city || candidate.region].filter(Boolean).join(' · ') || 'Location not observed'));
      copy.append(el('small', '', 'From: ' + (snapshot.jobs.find(job => job.id === candidate.jobId)?.goal || candidate.jobId) + (candidate.importedLeadId ? ' · Added to Leads' : candidate.duplicate?.kind === 'confident' ? ' · Existing business' : ''))); row.append(check, copy); ui.picker.append(row);
    }
    if (!pickerError) ui.pickerPagination.append(pageControls(pickerOffset, pickerPage.total, next => { pickerOffset = next; loadPicker(); }, 'validation-picker-page'));
    syncPickerSelection();
    if (focus) { const target = [...ui.validationForm.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focus && !node.disabled); (target || ui.goalTab).focus({ preventScroll: true }); }
  }
  function buildValidationResults(pane) {
    pane.append(el('p', 'lh-intro', 'Passed meets the requested checks. Needs review includes Unknown evidence. Failed means a supported contradiction or duplicate. Unchecked targets are unfinished.'));
    const label = el('label', 'lh-field'); label.append(el('span', '', 'Validation task')); const filter = el('select'); filter.id = 'lh-validation-results-filter';
    filter.onchange = () => { resultsJobId = filter.value; resultsOffset = 0; loadValidationResults(); }; label.append(filter); pane.append(label);
    const resultStatus = el('p', 'lh-picker-status'); resultStatus.setAttribute('role', 'status'); pane.append(resultStatus); ui.validationResultStatus = resultStatus;
    const context = el('div', 'lh-result-context'), list = el('div'); list.id = 'lh-validation-result-list'; const pager = el('div'); pager.id = 'lh-validation-results-pagination'; pane.append(context, list, pager); Object.assign(ui, { validationResultsFilter: filter, validationResultList: list, validationResultContext: context, validationResultsPagination: pager });
  }
  async function loadValidationResults() {
    if (!ui || !host?.isConnected) return;
    const token = ++resultsRequest, owner = sequence; resultsLoading = true; resultsError = ''; renderValidationResults();
    const options = [['', 'All Validate tasks'], ...snapshot.jobs.filter(isValidation).map(job => [job.id, job.goal])], key = JSON.stringify(options);
    if (ui.validationResultsFilter.dataset.catalog !== key) { ui.validationResultsFilter.replaceChildren(); for (const [value, copy] of options) { const option = el('option', '', copy); option.value = value; ui.validationResultsFilter.append(option); } ui.validationResultsFilter.dataset.catalog = key; }
    ui.validationResultsFilter.value = resultsJobId;
    try { const page = await request('validation-results', { offset: resultsOffset, limit: 25, ...(resultsJobId ? { jobId: resultsJobId } : {}) }); if (owner !== sequence || token !== resultsRequest) return; if (!Array.isArray(page?.items)) throw new Error('Validation results could not be loaded. Try again.'); resultPage = page; resultsOffset = page.offset;
      if (resultsOffset >= page.total && resultsOffset > 0) { resultsOffset = Math.max(0, Math.floor((page.total - 1) / 25) * 25); return loadValidationResults(); }
    } catch (error) { if (owner === sequence && token === resultsRequest) resultsError = error.message || 'Validation results could not be loaded. Try again.'; }
    finally { if (owner === sequence && token === resultsRequest) { resultsLoading = false; renderValidationResults(); } }
  }
  function syncValidationResultContext() {
    if (!ui?.validationResultContext) return;
    const context = ui.validationResultContext, job = snapshot.jobs.find(task => task.id === resultsJobId);
    if (!job) {
      if (context.childElementCount) context.replaceChildren();
      context.dataset.jobId = ''; return;
    }
    // Task state changes update this text without rebuilding evidence rows or their focused controls.
    if (context.dataset.jobId !== job.id) {
      context.replaceChildren(el('h3', '', job.goal), el('p', 'lh-intro'), filtersDetail(job));
      context.dataset.jobId = job.id;
    }
    const label = snapshot.paused && ['running', 'queued'].includes(job.status) ? 'Paused' : stateLabel(job);
    const summary = context.querySelector('.lh-intro');
    const text = label + ' · ' + taskCount(job) + ' · ' + (job.model || 'gpt-5.5');
    if (summary.textContent !== text) summary.textContent = text;
  }
  function renderValidationResults() {
    if (!ui?.validationResultList) return;
    const list = ui.validationResultList, focusKey = list.contains(document.activeElement) || ui.validationResultsPagination.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    for (const detail of list.querySelectorAll('details[data-detail]')) { if (detail.open) expandedDetails.add(detail.dataset.detail); else expandedDetails.delete(detail.dataset.detail); }
    ui.validationResultStatus.textContent = resultsLoading ? 'Loading validation results…' : '';
    list.setAttribute('aria-busy', String(resultsLoading));
    if (resultsLoading) return;
    list.replaceChildren(); ui.validationResultsPagination.replaceChildren();
    const job = snapshot.jobs.find(task => task.id === resultsJobId);
    syncValidationResultContext();
    list.setAttribute('aria-busy', String(resultsLoading));
    if (resultsError) { const error = el('p', 'lh-notice', resultsError); error.dataset.error = 'true'; error.setAttribute('role', 'alert'); list.append(error, button('Retry results', loadValidationResults)); return; }
    if (!resultPage.total) { list.append(el('p', 'lh-empty', job ? 'No completed checks for this task yet. Targets remain unfinished until evidence is saved.' : 'No validation results yet. Choose candidates and submit a Validate goal.')); return; }
    for (const result of resultPage.items.slice(0, 25)) {
      const task = snapshot.jobs.find(item => item.id === result.taskId), target = task?.targetSnapshots?.find(item => item.candidateId === result.candidateId), candidate = target?.candidate || snapshot.candidates.find(item => item.id === result.candidateId);
      const item = el('article', 'lh-validation-finding'); item.dataset.validationResultId = result.id;
      const head = el('div', 'lh-finding-head'), badge = el('span', 'lh-badge', ({ passed: 'Passed', needs_review: 'Needs review', failed: 'Failed' }[result.overall] || 'Needs review')); badge.dataset.outcome = result.overall;
      head.append(el('h3', '', result.company || candidate?.company || 'Business ' + result.candidateId), badge); item.append(head, el('p', '', (task?.goal || result.taskId) + ' · ' + result.model + ' · Checked ' + dateLabel(result.checkedAt)));
      const details = el('details'); details.dataset.detail = result.id + ':checks'; details.open = expandedDetails.has(details.dataset.detail); const summary = el('summary', '', 'Checks and source evidence'); summary.dataset.focus = result.id + ':checks'; details.append(summary);
      const checks = el('ul', 'lh-validation-checks');
      for (const check of result.checks || []) { const li = el('li'); li.append(el('strong', '', ({ identity: 'Business identity', industry: 'Industry', location: 'Location', website: 'Website', contact: 'Public contact', duplicate: 'Existing Leads / Clients' }[check.key] || check.key.replace(/_/g, ' '))), document.createTextNode(' · ' + ({ passed: 'Passed', failed: 'Failed', unknown: 'Unknown', not_requested: 'Not requested' }[check.status] || 'Unknown') + (check.required ? '' : ' · Informational')), el('p', '', check.explanation || 'No explanation recorded.')); if (check.observedAt) li.append(el('p', '', 'Observed ' + dateLabel(check.observedAt))); const sourceUrls = new Set(check.sourceUrls || []); for (const [index, source] of (result.sources || []).entries()) if (sourceUrls.has(source.url) || sourceUrls.has(source.finalUrl)) { const evidence = button(source.label || source.url, () => openSource(source.url)); evidence.className = 'lh-source-button'; evidence.dataset.focus = result.id + ':check:' + check.key + ':source:' + index; li.append(evidence); } checks.append(li); }
      details.append(checks);
      const current = snapshot.candidates.find(item => item.id === result.candidateId);
      const observationKey = value => JSON.stringify(value && [value.company, value.industry, value.region, value.city, value.address, value.website, value.contact]);
      if (target?.candidate && current && observationKey(target.candidate) !== observationKey(current)) details.append(el('p', '', 'Current Discover observations differ from the submitted snapshot. These checks retain the recorded input.'));
      if (result.duplicate?.recordIds?.length) details.append(el('p', '', 'Existing record IDs: ' + result.duplicate.recordIds.join(', ')));
      const sources = el('ul', 'lh-source-list');
      for (const [index, source] of (result.sources || []).entries()) { const li = el('li'), b = button(source.label || source.url, () => openSource(source.url)); b.className = 'lh-source-button'; b.dataset.focus = result.id + ':source:' + index; b.title = source.url; const time = el('time', '', 'Observed ' + dateLabel(source.observedAt)); if (source.observedAt) time.dateTime = source.observedAt; li.append(b, time); sources.append(li); }
      details.append(sources.childElementCount ? sources : el('p', '', 'No public source was acquired. Unknown checks need review.'));
      details.append(el('p', '', 'Saved against the submitted candidate snapshot. Public email association is not a deliverability test. Leads and Clients were not changed.')); item.append(details); list.append(item);
    }
    ui.validationResultsPagination.append(pageControls(resultsOffset, resultPage.total, next => { resultsOffset = next; loadValidationResults(); ui.resultsPane.scrollTop = 0; }, 'validation-results-page'));
    if (focusKey) { const target = [...ui.resultsPane.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focusKey && !node.disabled); (target || ui.resultsTab).focus({ preventScroll: true }); }
  }
  const enrichmentModelAvailable = () => snapshot.models?.some(model => model.id === enrichmentDraft.model && model.available === true);
  function syncEnrichmentModel() {
    if (!ui?.enrichmentModel) return;
    const models = snapshot.models || [];
    if (loaded && !enrichmentDraft.model) { enrichmentDraft.model = snapshot.defaultModel || 'gpt-5.5'; rememberEnrichmentDraft(); }
    const key = JSON.stringify([models, enrichmentDraft.model]);
    if (ui.enrichmentModel.dataset.catalog !== key) {
      ui.enrichmentModel.replaceChildren();
      for (const model of models) { const option = el('option', '', (model.label || model.id) + (model.available ? '' : ' (unavailable)')); option.value = model.id; option.disabled = model.available !== true; ui.enrichmentModel.append(option); }
      if (!models.some(model => model.id === enrichmentDraft.model)) { const option = el('option', '', enrichmentDraft.model ? enrichmentDraft.model + ' (unavailable)' : 'Loading models…'); option.value = enrichmentDraft.model; option.disabled = true; ui.enrichmentModel.append(option); }
      ui.enrichmentModel.dataset.catalog = key;
    }
    ui.enrichmentModel.value = enrichmentDraft.model;
    const model = models.find(item => item.id === enrichmentDraft.model);
    const reason = !loaded ? 'Checking available models…' : enrichmentModelAvailable() ? 'Saved with this task. Changes apply to new Enrich tasks.' : (model?.reason || 'The saved model is unavailable.') + ' Choose an available model to submit.';
    ui.enrichmentModelHelp.textContent = reason; ui.enrichmentModel.setCustomValidity(loaded && !enrichmentModelAvailable() ? reason : '');
  }
  function enrichmentField(form, name, labelText, type) {
    const label = el('label', 'lh-field'); label.append(el('span', '', labelText));
    const input = el(type); input.name = name; input.id = 'lh-enrichment-' + name; input.value = enrichmentDraft[name];
    if (name === 'goal') { input.required = true; input.maxLength = 240; input.rows = 3; input.placeholder = 'Describe the details or mockup brief you want.'; }
    input.oninput = () => { input.setCustomValidity(''); enrichmentDraft[name] = input.value; rememberEnrichmentDraft(); if (name === 'model') { syncEnrichmentModel(); syncBusy(); } };
    label.append(input);
    if (name === 'model') { const help = el('small', '', 'Checking available models…'); help.id = input.id + '-help'; help.setAttribute('role', 'status'); input.setAttribute('aria-describedby', help.id); label.append(help); ui.enrichmentModel = input; ui.enrichmentModelHelp = help; }
    form.append(label); return input;
  }
  function enrichmentForm() {
    const form = el('form', 'lh-goal-form'); form.id = 'lh-enrichment-form';
    form.append(el('p', 'lh-intro', 'Choose businesses that passed their latest Validate task. Collect source-backed details and a draft mockup brief without changing Leads or Clients.'));
    const picker = el('fieldset', 'lh-candidate-picker'); picker.append(el('legend', '', 'Passed Validate'));
    const searchLabel = el('label', 'lh-field'); searchLabel.append(el('span', '', 'Search eligible businesses'));
    const search = el('input'); search.type = 'search'; search.id = 'lh-enrichment-search'; search.maxLength = 120; search.placeholder = 'Business name, industry or location'; search.value = enrichPickerSearch;
    search.oninput = () => { enrichPickerSearch = search.value; enrichPickerOffset = 0; clearTimeout(enrichPickerTimer); enrichPickerTimer = setTimeout(loadEnrichmentPicker, 200); }; searchLabel.append(search); picker.append(searchLabel);
    const filterLabel = el('label', 'lh-field'); filterLabel.append(el('span', '', 'Discovery task')); const filter = el('select'); filter.id = 'lh-enrichment-job-filter'; filter.onchange = () => { enrichPickerJobId = filter.value; enrichPickerOffset = 0; loadEnrichmentPicker(); }; filterLabel.append(filter); picker.append(filterLabel);
    const selectedCount = el('p', 'lh-selection-count'); selectedCount.id = 'lh-enrichment-selection-count'; selectedCount.setAttribute('role', 'status');
    const actions = el('div', 'lh-picker-actions');
    const selectPage = button('Select this page', () => { const all = enrichPickerPage.items.every(candidate => enrichmentSelection.has(candidate.id)); if (all) for (const candidate of enrichPickerPage.items) enrichmentSelection.delete(candidate.id); else for (const candidate of enrichPickerPage.items) { if (enrichmentSelection.size >= 100) break; enrichmentSelection.add(candidate.id); } renderEnrichmentPicker(); syncEnrichmentSelection(); syncBusy(); }); selectPage.id = 'lh-enrichment-select-page';
    const clear = button('Clear selection', () => { enrichmentSelection.clear(); renderEnrichmentPicker(); syncEnrichmentSelection(); syncBusy(); }); clear.id = 'lh-enrichment-clear'; actions.append(selectPage, clear);
    const pickerStatus = el('p', 'lh-picker-status'); pickerStatus.setAttribute('role', 'status');
    const list = el('div'); list.id = 'lh-enrichment-picker'; const pagination = el('div'); pagination.id = 'lh-enrichment-picker-pagination';
    picker.append(pickerStatus, selectedCount, el('p', 'lh-intro', 'Up to 100 per task. Selections stay across pages and searches. A newer unfinished or non-passing Validate task requires a fresh Passed result.'), actions, list, pagination); form.append(picker);
    Object.assign(ui, { enrichPicker: list, enrichPickerJobFilter: filter, enrichPickerPagination: pagination, enrichSelectedCount: selectedCount, enrichSelectPage: selectPage, enrichClearSelection: clear, enrichPickerStatus: pickerStatus });
    enrichmentField(form, 'goal', 'Goal', 'textarea'); enrichmentField(form, 'model', 'Model', 'select');
    const groups = el('fieldset', 'lh-enrichment-groups'); groups.append(el('legend', '', 'What to collect'));
    const copy = { offerings: 'Offerings described in public business sources.', contacts: 'Published contacts with exact business evidence. Never guessed or deliverability-tested.', branding: 'Observed business name and tagline. No invented colours or copied assets.', website: 'Specific page observations. Unchecked details remain Unknown.', brief: 'Suggested pages and content needs, separate from business facts. This does not build a mockup.' };
    for (const [key, text] of Object.entries(enrichmentGroups)) { const label = el('label', 'lh-check'), input = el('input'), span = el('span'); input.type = 'checkbox'; input.name = key; input.id = 'lh-enrichment-group-' + key; input.checked = enrichmentDraft.groups[key]; input.onchange = () => { enrichmentDraft.groups[key] = input.checked; rememberEnrichmentDraft(); syncBusy(); }; span.append(el('strong', '', text), el('small', '', copy[key])); label.append(input, span); groups.append(label); } form.append(groups);
    form.append(el('p', 'lh-intro', 'Unknown values stay blank. Public observations do not prove contact deliverability or absence of a website feature. No outreach, imports or asset copies.'));
    const line = el('div', 'lh-submitline'), submit = button('Submit enrichment task', null, true); submit.type = 'submit'; submit.id = 'lh-submit-enrichment'; ui.enrichmentSubmit = submit;
    line.append(submit, el('p', '', 'Queued with Discover and Validate, one task at a time. Review observations and draft suggestions separately.')); form.append(line);
    form.onsubmit = event => { event.preventDefault(); if (busy) return; syncEnrichmentModel(); form.elements.goal.setCustomValidity(enrichmentDraft.goal.trim() ? '' : 'Enter a goal for Enrich.');
      if (!enrichmentSelection.size || enrichmentSelection.size > 100) { setNotice('Choose 1–100 businesses that passed their latest Validate task.', true); search.focus(); return; }
      if (!Object.values(enrichmentDraft.groups).some(Boolean)) { setNotice('Choose at least one field group for Enrich.', true); groups.querySelector('input').focus(); return; }
      if (!form.reportValidity()) return;
      const owner = sequence, submitMenuGeneration = menuGeneration, candidateIds = [...enrichmentSelection], payload = { goal: enrichmentDraft.goal.trim(), provider: 'codex', model: enrichmentDraft.model, candidateIds, groups: { ...enrichmentDraft.groups } };
      attempt(async () => { await request('submit-enrichment', payload); await refresh(); if (owner === sequence) { for (const id of candidateIds) enrichmentSelection.delete(id); if (ui.dialog.open && stage === 'enrich' && menuGeneration === submitMenuGeneration) { closeMenu(); setNotice('Enrich task submitted. Open the shared queue to follow its progress.'); } } }, 'Submitting task…', submitMenuGeneration);
    }; return form;
  }
  function syncEnrichmentSelection() { if (!ui?.enrichSelectedCount) return; ui.enrichSelectedCount.textContent = enrichmentSelection.size + ' / 100 selected' + (enrichmentSelection.size >= 100 ? ' · Task limit reached' : ''); ui.enrichSelectPage.textContent = enrichPickerPage.items.length && enrichPickerPage.items.every(candidate => enrichmentSelection.has(candidate.id)) ? 'Unselect this page' : 'Select this page'; }
  async function loadEnrichmentPicker() {
    if (!ui || !host?.isConnected) return;
    const token = ++enrichPickerRequest, owner = sequence; enrichPickerLoading = true; enrichPickerError = ''; renderEnrichmentPicker();
    const options = [['', 'All Discover tasks'], ...snapshot.jobs.filter(isDiscovery).map(job => [job.id, job.goal])], key = JSON.stringify(options);
    if (ui.enrichPickerJobFilter.dataset.catalog !== key) { ui.enrichPickerJobFilter.replaceChildren(); for (const [value, copy] of options) { const option = el('option', '', copy); option.value = value; ui.enrichPickerJobFilter.append(option); } ui.enrichPickerJobFilter.dataset.catalog = key; } ui.enrichPickerJobFilter.value = enrichPickerJobId;
    try { const page = await request('enrich-candidates', { search: enrichPickerSearch.trim(), offset: enrichPickerOffset, limit: 25, ...(enrichPickerJobId ? { jobId: enrichPickerJobId } : {}) }); if (owner !== sequence || token !== enrichPickerRequest) return; if (!Array.isArray(page?.items)) throw new Error('Eligible businesses could not be loaded. Try again.'); enrichPickerPage = page; enrichPickerOffset = page.offset; if (enrichPickerOffset >= page.total && enrichPickerOffset > 0) { enrichPickerOffset = Math.max(0, Math.floor((page.total - 1) / 25) * 25); return loadEnrichmentPicker(); } }
    catch (error) { if (owner === sequence && token === enrichPickerRequest) enrichPickerError = error.message || 'Eligible businesses could not be loaded. Try again.'; }
    finally { if (owner === sequence && token === enrichPickerRequest) { enrichPickerLoading = false; renderEnrichmentPicker(); syncBusy(); } }
  }
  function renderEnrichmentPicker() {
    if (!ui?.enrichPicker) return;
    const focus = ui.enrichPicker.contains(document.activeElement) || ui.enrichPickerPagination.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    ui.enrichPickerStatus.textContent = enrichPickerLoading ? 'Loading eligible businesses…' : ''; ui.enrichPicker.setAttribute('aria-busy', String(enrichPickerLoading)); if (enrichPickerLoading) { syncBusy(); return; }
    ui.enrichPicker.replaceChildren(); ui.enrichPickerPagination.replaceChildren();
    if (enrichPickerError) { const error = el('p', 'lh-notice', enrichPickerError); error.dataset.error = 'true'; error.setAttribute('role', 'alert'); ui.enrichPicker.append(error, button('Retry eligible businesses', loadEnrichmentPicker)); }
    else if (!enrichPickerPage.total) ui.enrichPicker.append(el('p', 'lh-empty', enrichPickerSearch || enrichPickerJobId ? 'No eligible businesses match these filters. Your selections are retained.' : 'Run Validate first. Enrich requires a Passed result from the latest submitted Validate task for each business.'));
    else for (const candidate of enrichPickerPage.items.slice(0, 25)) { const row = el('label', 'lh-picker-candidate'); row.dataset.enrichmentCandidateId = candidate.id; const check = el('input'); check.type = 'checkbox'; check.checked = enrichmentSelection.has(candidate.id); check.dataset.focus = candidate.id + ':enrich-select'; check.disabled = busy || (!check.checked && enrichmentSelection.size >= 100);
      check.onchange = () => { if (check.checked && enrichmentSelection.size < 100) enrichmentSelection.add(candidate.id); else { enrichmentSelection.delete(candidate.id); check.checked = false; } syncEnrichmentSelection(); syncBusy(); };
      const copy = el('span'); copy.append(el('strong', '', candidate.company), el('small', '', [candidate.industry, candidate.address || candidate.city || candidate.region].filter(Boolean).join(' · ') || 'Location not observed'), el('small', '', 'Passed Validate · ' + dateLabel(candidate.validatedAt) + (candidate.importedLeadId ? ' · Added to Leads' : ''))); row.append(check, copy); ui.enrichPicker.append(row); }
    if (!enrichPickerError) ui.enrichPickerPagination.append(pageControls(enrichPickerOffset, enrichPickerPage.total, next => { enrichPickerOffset = next; loadEnrichmentPicker(); }, 'enrichment-picker-page')); syncEnrichmentSelection();
    if (focus) { const target = [...ui.enrichmentForm.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focus && !node.disabled); (target || ui.goalTab).focus({ preventScroll: true }); }
  }
  function buildEnrichmentResults(pane) {
    pane.append(el('p', 'lh-intro', 'Observed details carry public-source evidence. Unknown values stay blank. Draft mockup suggestions are proposals, separate from business facts.'));
    const searchLabel = el('label', 'lh-field'); searchLabel.append(el('span', '', 'Search enrichment results')); const search = el('input'); search.type = 'search'; search.id = 'lh-enrichment-results-search'; search.maxLength = 120; search.placeholder = 'Business name, industry or location'; search.value = enrichResultsSearch; search.oninput = () => { enrichResultsSearch = search.value; enrichResultsOffset = 0; clearTimeout(enrichResultsTimer); enrichResultsTimer = setTimeout(loadEnrichmentResults, 200); }; searchLabel.append(search); pane.append(searchLabel);
    const label = el('label', 'lh-field'); label.append(el('span', '', 'Enrichment task')); const filter = el('select'); filter.id = 'lh-enrichment-results-filter'; filter.onchange = () => { enrichResultsJobId = filter.value; enrichResultsOffset = 0; loadEnrichmentResults(); }; label.append(filter); pane.append(label);
    const resultStatus = el('p', 'lh-picker-status'); resultStatus.setAttribute('role', 'status'); const context = el('div', 'lh-result-context'), list = el('div'), pager = el('div'); list.id = 'lh-enrichment-result-list'; pager.id = 'lh-enrichment-results-pagination'; pane.append(resultStatus, context, list, pager); Object.assign(ui, { enrichmentResultsFilter: filter, enrichmentResultList: list, enrichmentResultContext: context, enrichmentResultsPagination: pager, enrichmentResultStatus: resultStatus });
  }
  async function loadEnrichmentResults() {
    if (!ui || !host?.isConnected) return;
    const token = ++enrichResultsRequest, owner = sequence; enrichResultsLoading = true; enrichResultsError = ''; renderEnrichmentResults();
    const options = [['', 'All Enrich tasks'], ...snapshot.jobs.filter(isEnrichment).map(job => [job.id, job.goal])], key = JSON.stringify(options);
    if (ui.enrichmentResultsFilter.dataset.catalog !== key) { ui.enrichmentResultsFilter.replaceChildren(); for (const [value, copy] of options) { const option = el('option', '', copy); option.value = value; ui.enrichmentResultsFilter.append(option); } ui.enrichmentResultsFilter.dataset.catalog = key; } ui.enrichmentResultsFilter.value = enrichResultsJobId;
    try { const page = await request('enrichment-results', { search: enrichResultsSearch.trim(), offset: enrichResultsOffset, limit: 25, ...(enrichResultsJobId ? { jobId: enrichResultsJobId } : {}) }); if (owner !== sequence || token !== enrichResultsRequest) return; if (!Array.isArray(page?.items)) throw new Error('Enrichment results could not be loaded. Try again.'); enrichResultPage = page; enrichResultsOffset = page.offset; if (enrichResultsOffset >= page.total && enrichResultsOffset > 0) { enrichResultsOffset = Math.max(0, Math.floor((page.total - 1) / 25) * 25); return loadEnrichmentResults(); } }
    catch (error) { if (owner === sequence && token === enrichResultsRequest) enrichResultsError = error.message || 'Enrichment results could not be loaded. Try again.'; }
    finally { if (owner === sequence && token === enrichResultsRequest) { enrichResultsLoading = false; renderEnrichmentResults(); } }
  }
  function syncEnrichmentResultContext() {
    if (!ui?.enrichmentResultContext) return;
    const context = ui.enrichmentResultContext, job = snapshot.jobs.find(task => task.id === enrichResultsJobId);
    if (!job) { if (context.childElementCount) context.replaceChildren(); context.dataset.jobId = ''; return; }
    if (context.dataset.jobId !== job.id) { context.replaceChildren(el('h3', '', job.goal), el('p', 'lh-intro'), filtersDetail(job)); context.dataset.jobId = job.id; }
    const label = snapshot.paused && ['running', 'queued'].includes(job.status) ? 'Paused' : stateLabel(job), summary = context.querySelector('.lh-intro'), text = label + ' · ' + taskCount(job) + ' · ' + job.model; if (summary.textContent !== text) summary.textContent = text;
  }
  function appendEnrichmentSources(parent, result, urls, key) {
    const supported = new Set(urls || []);
    for (const [index, source] of (result.sources || []).entries()) if (supported.has(source.url) || supported.has(source.finalUrl)) { const control = button(source.label || source.url, () => openSource(source.url)); control.className = 'lh-source-button'; control.dataset.focus = result.id + ':' + key + ':source:' + index; control.title = source.url; parent.append(control); }
  }
  function renderEnrichmentResults() {
    if (!ui?.enrichmentResultList) return;
    const list = ui.enrichmentResultList, focusKey = list.contains(document.activeElement) || ui.enrichmentResultsPagination.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    for (const detail of list.querySelectorAll('details[data-detail]')) { if (detail.open) expandedDetails.add(detail.dataset.detail); else expandedDetails.delete(detail.dataset.detail); }
    ui.enrichmentResultStatus.textContent = enrichResultsLoading ? 'Loading enrichment results…' : ''; list.setAttribute('aria-busy', String(enrichResultsLoading)); if (enrichResultsLoading) return;
    list.replaceChildren(); ui.enrichmentResultsPagination.replaceChildren(); syncEnrichmentResultContext();
    if (enrichResultsError) { const error = el('p', 'lh-notice', enrichResultsError); error.dataset.error = 'true'; error.setAttribute('role', 'alert'); list.append(error, button('Retry enrichment results', loadEnrichmentResults)); return; }
    if (!enrichResultPage.total) { list.append(el('p', 'lh-empty', enrichResultsSearch ? 'No saved enrichment results match this search.' : enrichResultsJobId ? 'No completed profiles for this task yet. Targets stay unfinished until evidence is saved.' : 'No enrichment results yet. Choose eligible businesses and submit an Enrich goal.')); return; }
    const labels = { description: 'Description', services: 'Services', products: 'Products', email: 'Public email', phone: 'Public phone', contact_form: 'Contact form', brand_name: 'Business name', tagline: 'Published tagline', website_url: 'Website', website_observations: 'Website observations' };
    for (const result of enrichResultPage.items.slice(0, 25)) {
      const task = snapshot.jobs.find(item => item.id === result.taskId), item = el('article', 'lh-validation-finding'); item.dataset.enrichmentResultId = result.id;
      const head = el('div', 'lh-finding-head'), badge = el('span', 'lh-badge', ({ ready: 'Ready', partial: 'Partial', needs_review: 'Needs review' }[result.status] || 'Needs review')); badge.dataset.outcome = result.status;
      head.append(el('h3', '', result.company || 'Business ' + result.candidateId), badge); item.append(head, el('p', '', (task?.goal || result.taskId) + ' · ' + result.model + ' · Enriched ' + dateLabel(result.enrichedAt)));
      if (result.validationSuperseded) item.append(el('p', 'lh-enrichment-history', 'A newer Validate task supersedes this profile’s input validation. This historical result retains the original submitted evidence.'));
      const facts = el('details'); facts.dataset.detail = result.id + ':fields'; facts.open = expandedDetails.has(facts.dataset.detail); const summary = el('summary', '', 'Business details and source evidence'); summary.dataset.focus = facts.dataset.detail; facts.append(summary);
      const identity = el('div', 'lh-enrichment-identity'); identity.append(el('strong', '', 'Business identity · ' + (result.identity?.state === 'observed' ? 'Observed' : 'Unknown')), el('p', '', result.identity?.explanation || 'No identity explanation was recorded.')); appendEnrichmentSources(identity, result, result.identity?.sourceUrls, 'identity'); facts.append(identity);
      const fields = el('dl', 'lh-enrichment-fields');
      for (const field of result.fields || []) { const state = field.state === 'observed' ? 'Observed' : field.state === 'not_requested' ? 'Not requested' : 'Unknown'; const term = el('dt', '', (labels[field.key] || field.key.replace(/_/g, ' ')) + ' · ' + state), value = el('dd');
        const observations = field.state === 'observed' ? field.values || [] : [];
        if (!observations.length) { const blank = el('span', 'lh-enrichment-unknown', '—'); blank.setAttribute('aria-label', state + '; no observed value'); value.append(blank); }
        for (const [index, observation] of observations.entries()) { const row = el('div', 'lh-enrichment-value'); row.append(el('p', '', observation.value)); appendEnrichmentSources(row, result, observation.sourceUrls, 'field:' + field.key + ':' + index); value.append(row); }
        if (field.explanation) value.append(el('small', '', field.explanation)); fields.append(term, value);
      } facts.append(fields);
      const sources = el('ul', 'lh-source-list'); for (const [index, source] of (result.sources || []).entries()) { const li = el('li'), control = button(source.label || source.url, () => openSource(source.url)); control.className = 'lh-source-button'; control.dataset.focus = result.id + ':source:' + index; control.title = source.url; const time = el('time', '', 'Observed ' + dateLabel(source.observedAt)); if (source.observedAt) time.dateTime = source.observedAt; li.append(control, time); sources.append(li); } facts.append(sources.childElementCount ? sources : el('p', '', 'No public source was acquired. Unknown values are left blank.'));
      facts.append(el('p', '', 'Public-source observations, not contact deliverability tests. Candidates, validation evidence, Leads and Clients were not changed.')); item.append(facts);
      if (result.brief?.state === 'draft') { const brief = el('details', 'lh-enrichment-brief'); brief.dataset.detail = result.id + ':brief'; brief.open = expandedDetails.has(brief.dataset.detail); const summary = el('summary', '', 'Draft mockup brief · suggestions'); summary.dataset.focus = brief.dataset.detail; brief.append(summary, el('p', '', 'Proposed structure and content needs. These suggestions are not observed business facts.'), el('p', '', result.brief.summary || 'No draft summary recorded.')); const suggestions = el('ul'); for (const suggestion of result.brief.suggestions || []) suggestions.append(el('li', '', suggestion)); brief.append(suggestions); item.append(brief); } else item.append(el('p', '', 'Mockup brief not requested.'));
      list.append(item);
    }
    ui.enrichmentResultsPagination.append(pageControls(enrichResultsOffset, enrichResultPage.total, next => { enrichResultsOffset = next; loadEnrichmentResults(); ui.resultsPane.scrollTop = 0; }, 'enrichment-results-page'));
    if (focusKey) { const target = [...ui.enrichmentResultsBody.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focusKey && !node.disabled); (target || ui.resultsTab).focus({ preventScroll: true }); }
  }

  function mutationControl(text, action, focusKey) { const b = button(text, () => attempt(action)); b.dataset.focus = focusKey; b.dataset.mutation = 'true'; return b; }
  function filtersDetail(job) {
    const details = el('details'), key = job.id + ':filters'; details.dataset.detail = key; details.open = expandedDetails.has(key);
    const summary = el('summary', '', 'Goal filters'); summary.dataset.focus = key; details.append(summary);
    const dl = el('dl'), f = isValidation(job) ? job.criteria || {} : job.filters || {};
    if (isEnrichment(job)) { for (const [label, value] of [['Agent', 'Enrich'], ['Model', job.model], ['Collect', Object.entries(job.groups || {}).filter(([, enabled]) => enabled).map(([key]) => enrichmentGroups[key] || key).join(', ')], ['Targets', job.targetCandidateIds?.length || 0]]) dl.append(el('dt', '', label), el('dd', '', value)); details.append(dl); const targets = el('ul', 'lh-enrichment-targets'); for (const target of job.targetSnapshots || []) targets.append(el('li', '', (target.candidate?.company || target.candidateId) + ' · Passed Validate ' + dateLabel(target.validatedAt))); details.append(targets); return details; }
    if (isValidation(job)) { for (const [label, value] of [['Agent', 'Validate'], ['Model', job.model || 'gpt-5.5'], ['Industry', f.industry || 'Any industry'], ['Region', f.region || 'Any region'], ['City', f.city || 'Any city'], ['Website', labelFor('website', f.website)], ['Contact', labelFor('contact', f.contact)], ['Duplicates', f.checkDuplicates ? 'Check Leads and Clients' : 'Not requested'], ['Targets', job.targetCandidateIds?.length || 0]]) dl.append(el('dt', '', label), el('dd', '', value)); details.append(dl); return details; }
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
    if (!detail.open) { detail.ontoggle = () => { if (detail.open) { expandedDetails.add(key); renderQueue(); } }; return detail; }
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
    const offset = Math.min(discoveryOffsets.get(job.id) || 0, Math.max(0, Math.floor((candidates.length - 1) / 25) * 25));
    const renderPage = () => { list.replaceChildren(); const start = discoveryOffsets.get(job.id) || 0; for (const candidate of candidates.slice(start, start + 25)) list.append(renderCandidate(candidate, job, updateActions)); };
    discoveryOffsets.set(job.id, offset); renderPage();
    const pager = pageControls(offset, candidates.length, next => { discoveryOffsets.set(job.id, next); renderQueue(); }, job.id + ':discover-page');
    detail.append(pager);
    updateActions(); detail.append(list, actions); return detail;
  }
  function renderQueue() {
    if (!ui) return;
    const list = ui.taskList, focusKey = list.contains(document.activeElement) || ui.queuePagination.contains(document.activeElement) ? document.activeElement.dataset.focus : null, scroll = ui.queuePane.scrollTop;
    for (const d of list.querySelectorAll('details[data-detail]')) { if (d.open) expandedDetails.add(d.dataset.detail); else expandedDetails.delete(d.dataset.detail); }
    list.replaceChildren(); ui.queuePagination.replaceChildren();
    if (!loaded) { list.append(el('p', 'lh-intro', 'Loading saved tasks…')); return; }
    if (!snapshot.jobs.length) { const empty = el('div', 'lh-empty'); empty.append(el('h3', '', 'No tasks yet'), el('p', '', 'Click Discover and submit your first goal.')); list.append(empty); return; }
    queueOffset = Math.min(queueOffset, Math.max(0, Math.floor((snapshot.jobs.length - 1) / 25) * 25));
    ui.queuePagination.replaceChildren(pageControls(queueOffset, snapshot.jobs.length, next => { queueOffset = next; renderQueue(); ui.queuePane.scrollTop = 0; }, 'queue-page'));
    for (const [relativeIndex, job] of snapshot.jobs.slice(queueOffset, queueOffset + 25).entries()) {
      const index = queueOffset + relativeIndex;
      const item = el('article', 'lh-task'); item.dataset.jobId = job.id;
      const top = el('div', 'lh-tasktop'), status = el('span', 'lh-badge', stateLabel(job)); status.dataset.state = job.status; top.append(el('span', '', stageLabel(job) + ' · Task ' + (index + 1)), status);
      const filters = isValidation(job) ? job.criteria || {} : job.filters || {};
      item.append(top, el('h3', '', job.goal), el('p', '', isEnrichment(job) ? Object.entries(job.groups || {}).filter(([, enabled]) => enabled).map(([key]) => enrichmentGroups[key] || key).join(' · ') : [filters.industry || 'Any industry', filters.city || filters.region || (isValidation(job) ? 'Any location' : 'Region not recorded'), labelFor('website', filters.website)].join(' · ')));
      item.append(el('p', '', countBatches(job) + ' batches saved · ' + taskCount(job)));
      if (snapshot.error && job.status === 'running') item.append(el('p', '', 'Stopped: ' + (snapshot.error.message || 'Discover needs recovery.') + ' Resume after resolving the storage problem.'));
      else if (reasonText(job)) item.append(el('p', '', reasonText(job)));
      else if (job.status === 'queued') item.append(el('p', '', snapshot.paused ? 'Waiting until tasks are resumed.' : 'Waiting for earlier tasks to finish.'));
      else if (job.status === 'running') item.append(el('p', '', isEnrichment(job) ? 'Collecting source-backed details. Completed profiles are saved after each batch.' : isValidation(job) ? 'Checking business evidence. Completed checks are saved after each batch.' : 'Searching public sources. Results appear after each completed batch.'));
      else if (job.status === 'completed') item.append(el('p', '', isEnrichment(job) ? 'Enrichment ended. Review observations and draft suggestions; unfinished targets remain unchecked.' : isValidation(job) ? 'Validation ended. Review outcomes and evidence; unchecked targets remain unfinished.' : 'Search finished. Review source evidence before adding to Leads.'));
      item.append(filtersDetail(job));
      if (isEnrichment(job)) { const view = button('View enrichment results', () => { enrichResultsJobId = job.id; enrichResultsOffset = 0; openMenu('results', 'enrich'); }); view.dataset.focus = job.id + ':results'; item.append(view); }
      else if (isValidation(job)) { const view = button('View validation results', () => { resultsJobId = job.id; resultsOffset = 0; openMenu('results', 'validate'); }); view.dataset.focus = job.id + ':results'; item.append(view); }
      else item.append(resultsDetail(job));
      if (['queued', 'running', 'waiting', 'paused'].includes(job.status)) {
        const actions = el('div', 'lh-task-actions');
        if (job.status === 'paused' || (job.status === 'waiting' && ['AUTH', 'QUOTA'].includes(job.errorCode))) actions.append(mutationControl('Resume tasks', async () => { await request('resume'); await refresh(); setNotice('Tasks resumed.'); }, job.id + ':resume'));
        actions.append(mutationControl('Cancel task', async () => { await request('cancel', { id: job.id }); await refresh(); setNotice('Task cancelled. Saved results remain available.'); }, job.id + ':cancel')); item.append(actions);
      }
      list.append(item);
    }
    ui.queuePane.scrollTop = scroll;
    if (focusKey) { const focus = [...ui.queuePane.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focusKey && !n.disabled); (focus || ui.queueTab).focus({ preventScroll: true }); }
  }
  function dispose() {
    ++sequence; ++pickerRequest; ++resultsRequest; ++enrichPickerRequest; ++enrichResultsRequest; clearTimeout(pickerTimer); clearTimeout(enrichPickerTimer); clearTimeout(enrichResultsTimer);
    if (typeof unsubscribe === 'function') unsubscribe(); unsubscribe = null;
    office?.destroy(); office = null;
    if (ui?.dialog.open) ui.dialog.close();
    ui = null; host = null; busy = false; submitting = false;
  }
  async function render(target) {
    dispose(); host = target; const token = sequence; eventVersion = 0; loaded = false; busy = false; activeTab = 'goal'; stage = 'discover';
    target.replaceChildren(); target.className = 'ws-lead-hunter'; modelCatalogKey = '';
    const heading = el('header', 'lh-heading'), titles = el('div'); titles.append(el('h1', '', 'Lead hunter'), el('p', '', 'Your office for finding new opportunities.'));
    const controls = el('div', 'lh-controls');
    const animation = iconButton(animationPaused ? 'play' : 'pause', animationPaused ? 'Resume office animation' : 'Pause office animation', () => { animationPaused = !animationPaused; office?.setMotionPaused(animationPaused); const label = animationPaused ? 'Resume office animation' : 'Pause office animation'; animation.replaceChildren(icon(animationPaused ? 'play' : 'pause')); animation.setAttribute('aria-pressed', String(animationPaused)); animation.setAttribute('aria-label', label); animation.title = label; }); animation.setAttribute('aria-pressed', String(animationPaused)); animation.id = 'lh-animation-toggle';
    const queue = button('Queue', () => openMenu('queue', stage)), queueCount = el('span', 'lh-count', '0'); queue.prepend(icon('queue')); queue.append(queueCount); queue.id = 'lh-open-queue'; controls.append(animation, queue); heading.append(titles, controls); target.append(heading);
    const officeSection = el('section', 'lh-office'); officeSection.setAttribute('aria-label', 'Pixel discovery office'); const scene = el('div', 'lh-scene'), hint = el('p', 'lh-hint'); hint.append(el('strong', '', 'Click Discover, Validate or Enrich'), document.createTextNode(' to give an agent a goal.')); officeSection.append(scene, hint); target.append(officeSection);
    const dock = el('div', 'lh-taskdock'); dock.setAttribute('aria-label', 'Office task status'); const dot = el('i', 'lh-status-dot'); dot.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'lh-taskcopy'), title = el('strong'), status = el('p'); copy.setAttribute('role', 'status'); copy.setAttribute('aria-live', 'polite'); copy.setAttribute('aria-atomic', 'true'); copy.append(title, status);
    const pauseAction = () => attempt(async () => { const resume = canResumeTasks(); await request(resume ? 'resume' : 'pause'); await refresh(); setNotice(resume ? 'Tasks resumed.' : 'Tasks paused. Saved results are kept.'); });
    const pauseTask = iconButton('pause', 'Pause tasks', pauseAction); pauseTask.id = 'lh-pause-task'; const viewTask = button('View task', () => { const job = currentJob(); if (job) queueOffset = Math.floor(snapshot.jobs.findIndex(task => task.id === job.id) / 25) * 25; openMenu('queue', stageFor(job)); }); dock.append(dot, copy, pauseTask, viewTask); target.append(dock);
    const noticeNode = el('p', 'lh-notice'); noticeNode.hidden = true; target.append(noticeNode);
    const footer = el('footer', 'lh-footer'), credit = button('Pixel Office by 2dPig · CC0', () => window.mavis.openExternal('https://2dpig.itch.io/pixel-office')); credit.className = 'lh-credit'; footer.append(credit, el('span', '', 'Discover · Validate · Enrich with source evidence')); target.append(footer);
    const dialog = el('dialog', 'lh-drawer'); dialog.id = 'lh-agent-menu'; dialog.setAttribute('aria-labelledby', 'lh-menu-title');
    const head = el('div', 'lh-drawerhead'), text = el('div'), menuTitle = el('h2', '', 'Discover'); menuTitle.id = 'lh-menu-title'; const menuSubtitle = el('p', '', 'Give this agent a goal. It handles one task at a time.'), closeButton = iconButton('close', 'Close Discover menu', closeMenu); text.append(menuTitle, menuSubtitle); head.append(text, closeButton); dialog.append(head);
    const tabs = el('div', 'lh-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Discover menu');
    const goalTab = button('Goals & filters', () => switchTab('goal')), queueTab = button('Task queue', () => switchTab('queue')), resultsTab = button('Results', () => switchTab('results')), menuCount = el('span', 'lh-count', '0'); queueTab.append(menuCount);
    for (const [name, b] of [['goal', goalTab], ['queue', queueTab], ['results', resultsTab]]) { b.id = 'lh-' + name + '-tab'; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'lh-' + name + '-pane'); tabs.append(b); }
    tabs.onkeydown = e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const names = stage !== 'discover' ? ['goal', 'queue', 'results'] : ['goal', 'queue']; const index = names.indexOf(activeTab); switchTab(e.key === 'Home' ? names[0] : e.key === 'End' ? names.at(-1) : names[(index + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length], true); } }; dialog.append(tabs);
    const goalPane = el('div', 'lh-pane'), queuePane = el('div', 'lh-pane'), resultsPane = el('div', 'lh-pane');
    for (const [name, pane] of [['goal', goalPane], ['queue', queuePane], ['results', resultsPane]]) { pane.id = 'lh-' + name + '-pane'; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', 'lh-' + name + '-tab'); }
    const goalNotice = el('p', 'lh-notice'), queueNotice = el('p', 'lh-notice'), resultsNotice = el('p', 'lh-notice'); goalNotice.hidden = queueNotice.hidden = resultsNotice.hidden = true;
    const discoveryIntro = el('p', 'lh-intro', 'Describe who you want to find, then narrow the search below.'); goalPane.append(goalNotice, discoveryIntro);
    const queueBar = el('div', 'lh-queuebar'), queueNote = el('p'), pauseAll = button('Pause tasks', pauseAction); pauseAll.id = 'lh-pause-all'; queueBar.append(queueNote, pauseAll);
    const taskList = el('div'), queuePagination = el('div'); taskList.id = 'lh-task-list'; queuePane.append(queueNotice, queueBar, queuePagination, taskList); dialog.append(goalPane, queuePane, resultsPane); target.append(dialog);
    ui = { dialog, menuTitle, menuSubtitle, closeButton, tabs, discoveryIntro, goalPane, queuePane, resultsPane, resultsNotice, goalTab, queueTab, resultsTab, queueCount, menuCount, title, status, dock, pauseTask, viewTask, pauseAll, queueNote, taskList, queuePagination, notice: noticeNode, goalNotice, queueNotice };
    ui.discoveryForm = goalForm(); ui.validationForm = validationForm(); ui.enrichmentForm = enrichmentForm(); goalPane.append(ui.discoveryForm, ui.validationForm, ui.enrichmentForm); ui.validationForm.hidden = ui.enrichmentForm.hidden = true; resultsTab.hidden = true;
    ui.validationResultsBody = el('div'); ui.enrichmentResultsBody = el('div'); resultsPane.append(resultsNotice, ui.validationResultsBody, ui.enrichmentResultsBody); buildValidationResults(ui.validationResultsBody); buildEnrichmentResults(ui.enrichmentResultsBody); ui.enrichmentResultsBody.hidden = true;
    dialog.addEventListener('close', () => { ++menuGeneration; office?.setMenuOpen(false); office?.setValidateMenuOpen(false); office?.setEnrichMenuOpen(false); if (host?.isConnected) (returnFocus?.isConnected ? returnFocus : office?.agent)?.focus({ preventScroll: true }); });
    dialog.onclick = e => { if (e.target === dialog && e.clientX < dialog.getBoundingClientRect().left) closeMenu(); };
    office = MT.leadHunterOffice.create(scene, { onDiscover: () => openMenu('goal', 'discover'), onValidate: () => openMenu('goal', 'validate'), onEnrich: () => openMenu('goal', 'enrich'), onError: message => setNotice(message, true) }); office.setMotionPaused(animationPaused);
    switchTab('goal'); setNotice(notice, noticeError); sync();
    unsubscribe = window.mavis.onHunterChanged?.(value => { if (token !== sequence || !host?.isConnected) return; eventVersion++; applySnapshot(value); });
    try { await refresh(); }
    catch (e) { if (token === sequence && target.isConnected) { setNotice('Discover could not load: ' + e.message + ' Use Retry to reconnect.', true); const retry = button('Retry', () => attempt(async () => { await refresh(); setNotice('Discover reconnected.'); })); retry.id = 'lh-retry'; target.insertBefore(retry, footer); } }
  }
  MT.leadHunter = { render, dispose, hasDraft: () => !!draft.goal.trim() || !!validationDraft.goal.trim() || !!enrichmentDraft.goal.trim(), beforeClose: async () => true };
})();
