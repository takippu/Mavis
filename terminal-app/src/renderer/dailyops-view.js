'use strict';

// MT.dailyops — left: saved standups (standups/<date>.md, newest first) with Copy.
// Right (floating): "Today's DailyOps" — a Generate flow that drives Claude headlessly
// to draft today's standup from the daily-memories, surfacing Claude's questions as cards.
// States: saved | idle | generating | asking | review | error. On save it writes
// standups/<date>.md (app composes/saves; the model never writes the brain).
//
// The whole generate flow — state, sessionId, in-progress answers, the draft, AND the
// awaited claude turn — lives at MODULE level, not inside render()'s closure. Leaving the
// DailyOps view destroys its DOM (the router rebuilds #view-host on every nav); keeping the
// flow in `flow` means coming back REHYDRATES an in-flight generation/answers/review instead
// of resetting to idle. render() is now a pure view of `flow`; the controllers mutate `flow`
// and paint(); a turn that resolves while you're on another screen just updates `flow`.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const headerLine = (text) => String(text || '').split(/\r?\n/)[0] || '';
  // staged loader phases (perceived progress — the real claude call is one opaque turn)
  const GEN_STEPS = ['Loading Claude', 'Collecting daily memories', 'Reading yesterday’s work', 'Drafting the standup'];
  const DRAFT_STEPS = ['Sending your answers', 'Drafting the standup', 'Formatting the block'];
  const qKey = (q, idx) => q.id || ('q' + idx); // robust to a malformed ASK with missing/duplicate ids

  // ---- persistent flow state (survives view nav / re-render) ----
  // Held in a shared async controller (MT.async.controller): `flow` IS its module-level
  // state object, ctrl.run() seq-guards the claude turn (a Regenerate / End supersedes an
  // in-flight one), and ctrl.isBusy() drives app.js's brain-changed skip-list.
  const ACTIVE = ['generating', 'asking', 'review', 'error'];
  const ctrl = MT.async.controller(
    {
      state: 'idle',     // idle | generating | asking | review | error | saved
      date: null,        // the ctx.date this flow belongs to (stale across a day rollover)
      steps: null,       // staged-loader labels for the current 'generating'
      genStep: 0,        // staged-loader progress — lives in flow so a nav-away/return RESUMES the
                         //   loader instead of restarting it from step 1 (the router rebuilds the DOM)
      sessionId: null,   // claude --resume id (asking → continue)
      questions: null,   // asking
      note: null,        // asking
      answers: {},       // asking — partial answers, keyed by question key (persists edits)
      draft: '',         // review — draft text (persists edits)
      manual: false,     // review — manual vs claude draft
      composed: null,    // review — { concise, detailed } composed drafts (the Detailed-toggle source)
      detailed: false,   // review — false = concise (one headline line per project, the default)
      error: null,       // error
    },
    { busyWhen: (s) => ACTIVE.includes(s.state) }
  );
  const flow = ctrl.state;
  function resetFlow(state) {
    flow.state = state; flow.steps = null; flow.genStep = 0; flow.sessionId = null; flow.questions = null;
    flow.note = null; flow.answers = {}; flow.draft = ''; flow.manual = false; flow.composed = null; flow.detailed = false; flow.error = null;
  }

  // ---- live render targets (refreshed on every render) ----
  let bodyEl = null, ctxDate = '', todayEntry = null, viewHost = null;
  let genTimer = null;

  function copyBtn(getText) {
    const b = el('button', 'mt-link', 'Copy');
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(getText() || ''); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1400); }
      catch { b.textContent = 'Copy failed'; }
    });
    return b;
  }

  function standupCard(entry) {
    const card = el('div', 'mt-card mt-do-entry');
    const head = el('div', 'mt-do-head');
    head.appendChild(el('span', 'mt-do-date', headerLine(entry.text) || entry.date));
    head.appendChild(copyBtn(() => entry.text));
    card.appendChild(head);
    card.appendChild(el('pre', 'mt-do-block', entry.text || ''));
    return card;
  }

  // ----- question cards (bound to flow.answers so edits survive a nav away) -----
  function questionCard(q, idx) {
    const key = qKey(q, idx);
    const labelText = q.label || q.id || 'Question';
    const wrap = el('div', 'mt-do-q');
    wrap.dataset.qid = key;
    wrap.dataset.kind = q.kind || 'text';
    wrap.appendChild(el('div', 'mt-do-q-label', labelText));
    const opts = Array.isArray(q.options) ? q.options : [];
    if (q.kind === 'multiselect' || q.kind === 'select') {
      const saved = flow.answers[key];
      // seed the default (multiselect → all options) so an untouched question still answers
      if (saved === undefined) flow.answers[key] = q.kind === 'multiselect' ? opts.map(String) : '';
      const group = el('div', 'mt-do-q-opts');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', labelText);
      opts.forEach((o, oi) => {
        const row = el('label', 'mt-do-opt');
        const inp = document.createElement('input');
        inp.type = q.kind === 'multiselect' ? 'checkbox' : 'radio';
        inp.name = 'q_' + key; // per-card name so two id-less questions don't merge
        inp.value = String(o);
        inp.id = 'q_' + key + '_' + oi; // option index → no collision on duplicate options
        if (q.kind === 'multiselect') inp.checked = Array.isArray(saved) ? saved.includes(String(o)) : true;
        else inp.checked = saved === String(o);
        inp.addEventListener('change', () => {
          if (q.kind === 'multiselect') flow.answers[key] = Array.from(group.querySelectorAll('input:checked')).map((i) => i.value);
          else flow.answers[key] = inp.value;
        });
        row.appendChild(inp);
        row.appendChild(el('span', null, String(o)));
        group.appendChild(row);
      });
      wrap.appendChild(group);
    } else {
      if (flow.answers[key] === undefined) flow.answers[key] = '';
      const ta = el('textarea', 'mt-field-input mt-do-q-text');
      ta.rows = 2;
      ta.placeholder = q.placeholder || 'Type your answer (blank = none)';
      ta.setAttribute('aria-label', labelText);
      ta.value = String(flow.answers[key]);
      ta.addEventListener('input', () => { flow.answers[key] = ta.value; });
      wrap.appendChild(ta);
    }
    return wrap;
  }

  // ----- controllers (module-level → survive the in-flight turn across a nav) -----
  function handleResult(r) {
    if (!r || r.kind === 'error') { flow.state = 'error'; flow.error = (r && r.error) || 'no response'; return paint(); }
    if (r.kind === 'ask') { flow.state = 'asking'; flow.sessionId = r.sessionId; flow.questions = r.questions; flow.note = r.note; flow.answers = {}; return paint(); }
    if (r.kind === 'done') { flow.state = 'review'; flow.composed = { concise: r.text || '', detailed: r.textDetailed || r.text || '' }; flow.detailed = false; flow.draft = flow.composed.concise; flow.manual = false; return paint(); }
    if (r.kind === 'message') { flow.state = 'error'; flow.error = 'Claude didn’t return a usable block:\n' + (r.text || '').slice(0, 400); return paint(); }
    flow.state = 'error'; flow.error = 'unexpected response'; return paint();
  }

  async function startGenerate() {
    resetFlow('generating'); flow.date = ctxDate; flow.steps = GEN_STEPS;
    paint();
    const r = await ctrl.run(() => window.mavis.dailyopsGenStart(ctxDate));
    if (r.superseded) return; // a newer Generate / Regenerate took over → drop this turn
    handleResult(r.ok ? r.result : null);
  }

  async function submitAnswers() {
    const sessionId = flow.sessionId; const answers = flow.answers; const date = ctxDate;
    flow.state = 'generating'; flow.steps = DRAFT_STEPS; flow.genStep = 0;
    paint();
    const r = await ctrl.run(() => window.mavis.dailyopsGenContinue({ date, sessionId, answers }));
    if (r.superseded) return;
    handleResult(r.ok ? r.result : null);
  }

  // ----- painter — renders flow into the right-panel body (bodyEl) -----
  function paint() {
    if (genTimer) { clearInterval(genTimer); genTimer = null; }
    // Always render into the CURRENT module bodyEl — at initial render it's still inside
    // the router's detached frag (attached right after), and an async turn that resolves
    // after a nav-away harmlessly paints a now-detached node (GC'd); the return re-renders
    // fresh from `flow`. No document.contains guard — that would blank the initial paint.
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    switch (flow.state) {
      case 'saved': return paintSaved();
      case 'generating': return paintGenerating();
      case 'asking': return paintAsking();
      case 'review': return paintReview();
      case 'error': return paintError();
      default: return paintIdle();
    }
  }

  function paintSaved() {
    const text = (todayEntry && todayEntry.text) || flow.draft || '';
    bodyEl.appendChild(el('div', 'mt-do-hint', 'Today’s standup is saved.'));
    bodyEl.appendChild(el('pre', 'mt-do-block', text));
    const row = el('div', 'mt-do-form-actions');
    row.appendChild(copyBtn(() => text));
    const regen = el('button', 'mt-link', 'Regenerate');
    regen.addEventListener('click', () => startGenerate());
    row.appendChild(regen);
    bodyEl.appendChild(row);
  }

  function paintIdle() {
    bodyEl.appendChild(el('div', 'mt-do-hint', 'Generate today’s standup — Claude reads your daily-memories and asks a couple of questions.'));
    const row = el('div', 'mt-do-form-actions');
    const gen = el('button', 'mt-pill', 'Generate');
    gen.addEventListener('click', () => startGenerate());
    row.appendChild(gen);
    const manual = el('button', 'mt-link', 'Write manually');
    manual.addEventListener('click', () => { resetFlow('review'); flow.manual = true; flow.date = ctxDate; paint(); });
    row.appendChild(manual);
    bodyEl.appendChild(row);
  }

  function paintGenerating() {
    const steps = flow.steps || GEN_STEPS;
    if (typeof flow.genStep !== 'number' || flow.genStep < 0) flow.genStep = 0;
    const wrap = el('div', 'mt-do-steps');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    bodyEl.appendChild(wrap);
    const addStep = (idx, done) => {
      const s = el('div', 'mt-do-step ' + (done ? 'done' : 'current'));
      const ico = el('span', 'mt-do-step-ico');
      if (done) ico.textContent = '✓';
      else { const sp = el('span', 'mt-do-spinner'); sp.setAttribute('aria-hidden', 'true'); ico.appendChild(sp); }
      s.appendChild(ico);
      s.appendChild(el('span', 'mt-do-step-label', steps[idx]));
      wrap.appendChild(s);
      requestAnimationFrame(() => s.classList.add('in'));
    };
    // Resume the loader where it left off: prior steps as ✓, the current one spinning. Coming back
    // from another view re-renders from flow.genStep instead of snapping to step 1.
    const cap = Math.min(flow.genStep, steps.length - 1);
    for (let k = 0; k < cap; k++) addStep(k, true);
    addStep(cap, false);
    const advance = () => {
      // node detached (nav-away) → freeze; paint() restarts the interval from flow.genStep on return.
      if (!wrap.isConnected) { clearInterval(genTimer); genTimer = null; return; }
      if (flow.genStep >= steps.length - 1) { clearInterval(genTimer); genTimer = null; return; } // last step spins until the result lands
      const cur = wrap.querySelector('.mt-do-step.current');
      if (cur) { cur.classList.remove('current'); cur.classList.add('done'); const ic = cur.querySelector('.mt-do-step-ico'); if (ic) ic.textContent = '✓'; }
      flow.genStep++;
      addStep(flow.genStep, false);
    };
    genTimer = setInterval(advance, 1500);
  }

  function paintAsking() {
    if (flow.note) bodyEl.appendChild(el('div', 'mt-do-note', flow.note));
    const form = el('div', 'mt-do-qs');
    (flow.questions || []).forEach((q, i) => form.appendChild(questionCard(q, i)));
    bodyEl.appendChild(form);
    const row = el('div', 'mt-do-form-actions');
    const cont = el('button', 'mt-pill', 'Continue');
    const status = el('span', 'mt-do-form-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    cont.addEventListener('click', () => { cont.disabled = true; cont.textContent = 'Thinking…'; submitAnswers(); });
    const cancel = el('button', 'mt-link', 'Cancel');
    cancel.addEventListener('click', () => { resetFlow(todayEntry ? 'saved' : 'idle'); flow.date = ctxDate; paint(); });
    row.appendChild(cont); row.appendChild(cancel); row.appendChild(status);
    bodyEl.appendChild(row);
  }

  function paintReview() {
    bodyEl.appendChild(el('div', 'mt-do-hint', flow.manual ? 'Write today’s standup, then Save.' : 'Review Claude’s draft, edit if needed, then Save.'));
    // Detailed toggle — concise (one headline line per project) by default; flip on for sub-bullets.
    // Recomposes from the two versions the agent returned; no re-run. (Not shown for a manual draft.)
    if (flow.composed && !flow.manual) {
      const tog = el('div', 'mt-do-detail-toggle');
      const sw = el('button', 'mt-switch' + (flow.detailed ? ' on' : '')); sw.type = 'button';
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', flow.detailed ? 'true' : 'false');
      const track = el('span', 'mt-switch-track'); track.appendChild(el('span', 'mt-switch-thumb')); sw.appendChild(track);
      sw.appendChild(el('span', 'mt-switch-label', 'Detailed (sub-bullets)'));
      sw.addEventListener('click', () => { flow.detailed = !flow.detailed; flow.draft = flow.composed[flow.detailed ? 'detailed' : 'concise']; paint(); });
      tog.appendChild(sw);
      bodyEl.appendChild(tog);
    }
    const ta = el('textarea', 'mt-field-input mt-do-review');
    ta.setAttribute('aria-label', flow.manual ? 'Write today’s standup' : 'Today’s standup draft');
    ta.value = flow.draft || '';
    ta.rows = 16;
    if (flow.manual) ta.placeholder = 'DD/MM/YYYY - Day - Name\n\nPrevious Work Day - …\n      - Project : …\n\nIssues Faced\n    - None\n\nToday\n      - Project : …';
    ta.addEventListener('input', () => { flow.draft = ta.value; });
    bodyEl.appendChild(ta);
    const row = el('div', 'mt-do-form-actions');
    const save = el('button', 'mt-pill', 'Save');
    save.title = 'Save to standups/' + (ctxDate || '') + '.md';
    const status = el('span', 'mt-do-form-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    save.addEventListener('click', async () => {
      const text = flow.draft;
      if (!text.trim()) { status.textContent = 'Nothing to save.'; return; }
      save.disabled = true; save.textContent = 'Saving…';
      let r;
      try { r = await window.mavis.dailyopsSave({ date: ctxDate, text }); } catch { r = null; }
      if (!r || !r.ok) { save.disabled = false; save.textContent = 'Save'; status.textContent = (r && r.reason) || 'Could not save.'; return; }
      try { await navigator.clipboard.writeText(r.text || ''); } catch { /* optional */ }
      resetFlow('saved'); flow.date = ctxDate;
      MT.dailyops.render(viewHost); // refresh history + panel
    });
    row.appendChild(save);
    row.appendChild(copyBtn(() => flow.draft));
    if (!flow.manual) { const regen = el('button', 'mt-link', 'Regenerate'); regen.addEventListener('click', () => startGenerate()); row.appendChild(regen); }
    row.appendChild(status);
    bodyEl.appendChild(row);
  }

  function paintError() {
    bodyEl.appendChild(el('div', 'mt-do-error', flow.error || 'Generation failed.'));
    const row = el('div', 'mt-do-form-actions');
    const retry = el('button', 'mt-pill', 'Retry');
    retry.addEventListener('click', () => startGenerate());
    row.appendChild(retry);
    const manual = el('button', 'mt-link', 'Write manually');
    manual.addEventListener('click', () => { resetFlow('review'); flow.manual = true; flow.date = ctxDate; paint(); });
    row.appendChild(manual);
    bodyEl.appendChild(row);
  }

  MT.dailyops = {
    async render(host) {
      host.innerHTML = '';
      viewHost = host;
      host.appendChild(el('div', 'mt-page-title', 'DailyOps'));
      host.appendChild(el('div', 'mt-sub', 'Your saved standups (standups/) — past entries on the left, today’s generator on the right.'));

      let entries = [];
      let ctx = null;
      try { entries = await window.mavis.dailyopsList(); } catch { entries = []; }
      try { ctx = await window.mavis.dailyopsContext(); } catch { ctx = null; }
      if (!Array.isArray(entries)) entries = [];
      ctx = ctx || { date: '', exists: false };
      ctxDate = ctx.date || '';
      todayEntry = entries.find((e) => e.date === ctxDate) || null;

      const layout = el('div', 'mt-dailyops-layout');

      // ----- history (left) -----
      const hist = el('div', 'mt-dailyops-history');
      hist.appendChild(el('div', 'mt-label', 'Past daily ops'));
      const list = el('div', 'mt-do-list');
      if (!entries.length) list.appendChild(el('div', 'mt-empty', 'No standups in standups/ yet.'));
      else entries.forEach((e) => list.appendChild(standupCard(e)));
      hist.appendChild(list);

      // ----- floating panel (right) -----
      const panel = el('div', 'mt-card mt-do-form');
      panel.appendChild(el('div', 'mt-row-name', 'Today’s DailyOps'));
      panel.appendChild(el('div', 'mt-do-date2', ctxDate || ''));
      const body = el('div', 'mt-do-panel-body');
      panel.appendChild(body);
      bodyEl = body;

      layout.appendChild(hist);
      layout.appendChild(panel);
      host.appendChild(layout);

      // Rehydrate an in-flight flow for TODAY; otherwise show saved/idle. A day
      // rollover (flow.date !== ctxDate) discards a stale flow.
      const rehydrate = ACTIVE.includes(flow.state) && flow.date === ctxDate;
      if (!rehydrate) { resetFlow(todayEntry ? 'saved' : 'idle'); flow.date = ctxDate; }
      paint();
    },
  };

  // while a generation / answering / review is in flight, app.js skips the brain-changed
  // re-render so the user's in-progress flow isn't needlessly rebuilt mid-step.
  MT.dailyops.isBusy = () => ctrl.isBusy();
})();
