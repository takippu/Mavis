'use strict';

// MT.entryEditor — add / edit / supersede a two-tier entry (preferences + rules) from the
// journal browser, behind a propose-then-confirm diff. The main process does the guarded,
// atomic write (mavis-config-writer); here we only collect the form, preview the diff, and
// commit on confirm. Rule/Why/How categories only — topics (Did/Refs/Pre-empt) are read-only
// because the writer builds a Rule/Why/How body. All DOM built via createElement (XSS-safe).
(function () {
  const MT = (window.MT = window.MT || {});
  const EDITABLE_CATS = ['preferences', 'rules', 'topics'];

  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const icon = (name, sz) => (MT.icons ? MT.icons.svg(name, sz || 16) : '');
  // deterministic-enough date for `since`/`updated`; the writer re-validates the shape.
  const today = () => new Date().toISOString().slice(0, 10);
  const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

  // naive line diff — good for the localized section-body + single-index-line edits these ops make.
  function lineDiff(before, after) {
    const b = String(before == null ? '' : before).split(/\r?\n/);
    const a = String(after == null ? '' : after).split(/\r?\n/);
    const bs = new Set(b), as = new Set(a);
    return { removed: b.filter((l) => !as.has(l)), added: a.filter((l) => !bs.has(l)) };
  }

  function modal(titleText) {
    const overlay = el('div', 'mt-np-overlay');
    const card = el('div', 'mt-np-card');
    overlay.appendChild(card);
    const head = el('div', 'mt-np-head');
    head.appendChild(el('div', 'mt-np-title', titleText));
    const x = el('button', 'mt-np-x'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.innerHTML = icon('close', 16);
    head.appendChild(x); card.appendChild(head);
    const body = el('div', 'mt-np-body'); card.appendChild(body);
    const foot = el('div', 'mt-np-foot'); card.appendChild(foot);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    x.addEventListener('click', close);
    document.body.appendChild(overlay);
    setTimeout(() => document.addEventListener('keydown', onKey, true), 0);
    return { overlay, card, body, foot, close };
  }

  function field(parent, label, control) {
    parent.appendChild(el('label', 'mt-field-label', label));
    parent.appendChild(control);
    return control;
  }
  function textInput(ph) { const i = el('input', 'mt-field-input'); i.type = 'text'; if (ph) i.placeholder = ph; return i; }
  function textArea(ph, rows) { const t = el('textarea', 'mt-field-input'); t.rows = rows || 3; if (ph) t.placeholder = ph; return t; }

  function renderDiff(host, pv) {
    host.innerHTML = '';
    // add/supersede return {files:[...]}; edit returns {before,after,changed}
    const files = pv.files || [{ key: 'details', before: pv.before, after: pv.after, changed: pv.changed }];
    const changed = files.filter((f) => f.changed);
    if (!changed.length) { host.appendChild(el('div', 'mt-empty', 'No change.')); return false; }
    changed.forEach((f) => {
      host.appendChild(el('div', 'mt-sect-lab', f.key === 'index' ? 'Index — _index.md' : 'Entry — _details/<slug>.md'));
      const pre = el('pre', 'mt-entry-diff');
      const { added, removed } = lineDiff(f.before, f.after);
      removed.forEach((l) => pre.appendChild(el('div', 'mt-diff-del', '- ' + l)));
      added.forEach((l) => pre.appendChild(el('div', 'mt-diff-add', '+ ' + l)));
      host.appendChild(pre);
    });
    return true;
  }

  async function preview(payload) {
    try { return await window.mavis.previewEntry(payload); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  async function commit(payload) {
    try { return await window.mavis.saveEntry(payload); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // opts: { mode:'add'|'edit'|'supersede', category, entry?, activeSlugs?, onSaved }
  function open(opts) {
    opts = opts || {};
    const { mode, category } = opts;
    if (!EDITABLE_CATS.includes(category)) return;
    const isTopic = category === 'topics';
    const noun = category === 'rules' ? 'rule' : isTopic ? 'topic' : 'preference';
    const entry = opts.entry || null;
    const fm = (entry && entry.frontmatter) || {};
    const titles = { add: 'Add a ' + noun, edit: 'Edit ' + noun, supersede: 'Supersede ' + noun };
    const m = modal(titles[mode] || 'Entry');

    const form = el('div', 'mt-pref-form');
    m.body.appendChild(form);
    let build; // () => payload | { error }

    if (mode === 'add') {
      const title = field(form, 'Title (one-line label)', textInput(isTopic ? 'e.g. Payment gateway' : 'e.g. Prefers dark mode'));
      const slug = field(form, 'Slug (id / filename)', textInput('auto from title'));
      title.addEventListener('input', () => { if (!slug.dataset.touched) slug.value = slugify(title.value); });
      slug.addEventListener('input', () => { slug.dataset.touched = '1'; });
      const triggers = field(form, 'Triggers (comma-separated)', textInput('keyword, synonym, adjacent term'));
      const summary = field(form, 'Summary (one line)', textInput('the gist, shown in the index'));
      const scope = field(form, 'Scope (comma-separated, optional)', textInput(isTopic ? 'usually empty for topics' : 'e.g. ui, workflow'));
      let b1, b2, b3;
      if (isTopic) {
        b1 = field(form, 'Did', textArea('what we built / learned', 3));
        b2 = field(form, 'Refs (durable pointers, one per line, optional)', textArea('- `projects/x/notes.md` (what)', 2));
        b3 = field(form, 'Pre-empt (honest scope, optional)', textArea('what this does / does NOT cover', 2));
      } else {
        b1 = field(form, 'Rule', textArea('what to do / not do', 3));
        b2 = field(form, 'Why (optional)', textArea('the reason / incident', 2));
        b3 = field(form, 'How to apply (optional)', textArea('when it fires + the action', 2));
      }
      build = () => {
        const s = slugify(slug.value || title.value);
        if (!s) return { error: 'Add a title or slug.' };
        if (!b1.value.trim()) return { error: (isTopic ? 'Did' : 'Rule') + ' is required.' };
        if (!summary.value.trim()) return { error: 'Summary is required.' };
        if (!triggers.value.trim()) return { error: 'Triggers are required.' };
        const entryObj = { slug: s, date: today(), title: title.value, triggers: triggers.value, summary: summary.value, scope: scope.value };
        if (isTopic) { entryObj.did = b1.value; entryObj.refs = b2.value.trim() || undefined; entryObj.preempt = b3.value.trim() || undefined; }
        else { entryObj.rule = b1.value; entryObj.why = b2.value.trim() || undefined; entryObj.how = b3.value.trim() || undefined; }
        return { op: 'add', category, entry: entryObj };
      };
    } else if (mode === 'edit') {
      let b1, b2, b3;
      if (isTopic) {
        const secOf = (label) => { const s = (entry.sections || []).find((x) => String(x.label).toLowerCase() === label); return s ? s.content : ''; };
        b1 = field(form, 'Did', textArea('', 3)); b1.value = secOf('did');
        b2 = field(form, 'Refs', textArea('', 2)); b2.value = secOf('refs');
        b3 = field(form, 'Pre-empt', textArea('', 2)); b3.value = secOf('pre-empt');
      } else {
        const bd = (entry && entry.body) || {};
        b1 = field(form, 'Rule', textArea('', 3)); b1.value = bd.rule || '';
        b2 = field(form, 'Why', textArea('', 2)); b2.value = bd.why || '';
        b3 = field(form, 'How to apply', textArea('', 2)); b3.value = bd.how || '';
      }
      build = () => {
        if (!b1.value.trim()) return { error: (isTopic ? 'Did' : 'Rule') + ' is required.' };
        const patch = { date: today() };
        if (isTopic) { patch.did = b1.value; if (b2.value.trim()) patch.refs = b2.value; if (b3.value.trim()) patch.preempt = b3.value; }
        else { patch.rule = b1.value; if (b2.value.trim()) patch.why = b2.value; if (b3.value.trim()) patch.how = b3.value; }
        return { op: 'edit', category, slug: entry.slug, patch };
      };
    } else { // supersede
      form.appendChild(el('div', 'mt-sub', 'Marks "' + (fm.title || entry.slug) + '" superseded and drops it from the index — the detail file is kept. Pick the entry that replaces it.'));
      const others = (opts.activeSlugs || []).filter((s) => s !== (entry && entry.slug));
      const bySlug = field(form, 'Superseded by', MT.dropdown
        ? MT.dropdown.create({ options: others.map((s) => ({ value: s, label: s })), className: 'mt-field-input' })
        : (() => { const sel = el('select', 'mt-field-input'); others.forEach((s) => { const o = el('option', null, s); o.value = s; sel.appendChild(o); }); return sel; })());
      build = () => {
        const sb = bySlug.value;
        if (!sb) return { error: 'Pick the superseding entry.' };
        return { op: 'supersede', category, slug: entry.slug, opts: { superseded_by: sb, date: today() } };
      };
    }

    const status = el('span', 'mt-do-form-status');
    const primary = el('button', 'mt-pill', 'Preview changes'); primary.type = 'button';
    m.foot.appendChild(status); m.foot.appendChild(primary);

    // Stage 1: preview → Stage 2: confirm-save.
    primary.addEventListener('click', async () => {
      const built = build();
      if (built.error) { status.textContent = built.error; return; }
      status.textContent = 'Composing…'; primary.disabled = true;
      const pv = await preview(built);
      primary.disabled = false;
      if (!pv || !pv.ok) { status.textContent = (pv && pv.error) || 'Preview failed.'; return; }
      status.textContent = '';
      form.style.display = 'none';
      const diffHost = el('div', 'mt-entry-diff-wrap');
      m.body.appendChild(diffHost);
      const hasChange = renderDiff(diffHost, pv);
      // swap the footer to Save / Back
      m.foot.innerHTML = '';
      const s2 = el('span', 'mt-do-form-status'); m.foot.appendChild(s2);
      const back = el('button', 'mt-pill mt-pill-ghost', 'Back'); back.type = 'button';
      back.addEventListener('click', () => { diffHost.remove(); form.style.display = ''; m.foot.innerHTML = ''; m.foot.appendChild(status); m.foot.appendChild(primary); status.textContent = ''; });
      const save = el('button', 'mt-pill', 'Save to brain'); save.type = 'button'; save.disabled = !hasChange;
      save.addEventListener('click', async () => {
        s2.textContent = 'Saving…'; save.disabled = true;
        const r = await commit(built);
        if (!r || !r.ok) { s2.textContent = (r && r.error) || 'Save failed.'; save.disabled = false; return; }
        m.close();
        if (typeof opts.onSaved === 'function') opts.onSaved(built);
      });
      m.foot.appendChild(back); m.foot.appendChild(save);
    });

    setTimeout(() => { const first = form.querySelector('input, textarea, button'); if (first) try { first.focus(); } catch { /* noop */ } }, 0);
  }

  MT.entryEditor = { open, EDITABLE: EDITABLE_CATS.slice() };
})();
