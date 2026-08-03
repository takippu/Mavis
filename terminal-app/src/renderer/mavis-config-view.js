'use strict';

// MT.mavisConfig — Mavis's own config: Identity (per-category card editor), Preferences
// (read + an Add-preference composer), Rules (read-only, external edit). Edits are surgical
// section/frontmatter writes via the guarded mavis-config-writer; every save goes through a
// propose-then-confirm Review diff ("Save to brain"), honoring the approval-before-mutations
// contract. The brain .md files never change shape — only one section/key/bullet at a time.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const icon = (n, s) => (MT.icons ? MT.icons.svg(n, s) : '');
  const PENCIL = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  function parseFm(md) {
    const out = {}; const lines = String(md || '').split(/\r?\n/);
    if (lines[0] !== '---') return out;
    for (let i = 1; i < lines.length; i++) { if (lines[i] === '---') break; const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/); if (m) out[m[1]] = m[2].trim(); }
    return out;
  }
  const stripFm = (md) => String(md || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const norm = (s) => String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const sectionBody = (md, heading) => {
    const lines = stripFm(md).split(/\r?\n/); const out = []; let on = false;
    for (const l of lines) { const h = l.match(/^##\s+(.+?)\s*$/); if (h) { on = h[1].trim() === heading; continue; } if (on) out.push(l); }
    return out.join('\n').replace(/^\n+|\n+$/g, '');
  };
  const bulletsOf = (body) => String(body || '').split('\n').map((l) => { const m = l.match(/^\s*[-*]\s+(.*)$/); return m ? m[1].trim() : null; }).filter(Boolean);

  function openBtn(key, label) {
    const b = el('button', 'mt-mavis-open'); b.type = 'button';
    b.title = 'Open ' + (label || 'this file') + ' in your editor';
    b.innerHTML = icon('external', 13) + '<span>Open file</span>';
    b.addEventListener('click', () => { try { window.mavis.openMavisFile(key); } catch { /* noop */ } });
    return b;
  }

  // ---------- identity form spec ----------
  // Preset TEXTS are written verbatim INTO the user's own identity files, so they must not carry a
  // hardcoded name or a gendered pronoun — `{name}` is substituted from identity/profile.md at
  // render time (see resolvePresets) and the wording stays pronoun-neutral. That also makes the
  // presets MATCH what SETUP.md generates for a new brain, so a freshly set-up file shows
  // "matches <preset>" instead of reading as hand-tuned.
  const TONE = [
    { label: 'Casual peer', text: "Talk like a senior engineer who's also a friend. No stiffness, no performance. Say what you mean, keep it real, and match {name}'s energy. Humor is fine when it lands naturally — don't force it. You're a peer, not an assistant." },
    { label: 'Balanced', text: 'Professional but warm. Clear and direct, with enough context to be useful. Approachable without being overly casual.' },
    { label: 'Formal', text: 'Precise and professional. Lead with substance, minimal informality. Structured and thorough.' },
  ];
  const DISAGREE = [
    { label: 'Say once + reason + ask', text: "Say so once, give the reason in 1-2 sentences, then ask if {name} wants to proceed. Don't lecture. Don't repeat. Their call." },
    { label: 'Defer immediately', text: "Note the concern briefly, then defer to {name}'s call without pushing." },
    { label: 'Push back twice then defer', text: 'Raise the concern, and if {name} disagrees, make the case once more with evidence — then defer to their call.' },
  ];
  const UNCERTAIN = [
    { label: 'Guess then flag', text: 'Make the best guess, then flag the assumption explicitly so {name} can correct it if it’s off.' },
    { label: 'Ask first', text: 'When uncertain, ask a focused clarifying question before proceeding.' },
    { label: 'Flag only', text: 'State what’s uncertain and why, and wait for direction rather than guessing.' },
  ];
  // {name} → the name from identity/profile.md; "the user" when the brain has no name yet (a fresh
  // clone before setup), which keeps the sentence grammatical instead of leaving a raw token behind
  // in a file Mavis reads every session.
  const resolvePresets = (presets, name) =>
    presets.map((p) => ({ label: p.label, text: p.text.replace(/\{name\}/g, name || 'the user') }));

  const RESPONSE_SHAPE = [
    '**Balanced by default.** A few sentences; lead with the answer.',
    '**Lead with the answer.** State the result first; reasoning after, if asked.',
    '**No filler openers.** Skip "Great question", "Sure thing", "I’d be happy to help". Just answer.',
    '**No reflexive apologies.** Apologize only when actually wrong, and once.',
    '**No trailing summaries.** Stop when done; don’t say "In summary...".',
  ];

  // `## How to address <name>` is the one identity heading SETUP.md generates with the user's name
  // baked into it, so it reads differently in every brain. The writer matches section headings
  // EXACTLY and has no upsert fallback (mavis-config-writer.replaceSectionBody → 'section "..." not
  // found'), so a hardcoded heading here can only ever resolve on the brain it was written for.
  // Read the real heading off communication.md instead; the profile name is only the fallback for a
  // file that has no such section yet.
  function addressHeading(cfg) {
    const md = stripFm((cfg && cfg.communication) || '');
    for (const line of md.split(/\r?\n/)) {
      const h = line.match(/^##\s+(How to address\b.*?)\s*$/i);
      if (h) return h[1].trim();
    }
    const name = parseFm(cfg && cfg.profile).name || '';
    return 'How to address' + (name ? ' ' + name : '');
  }

  function spec(cfg) {
    const name = parseFm(cfg && cfg.profile).name || '';
    const address = addressHeading(cfg);
    return [
      { group: 'Profile', file: 'profile', cards: [
        { field: 'Name', control: 'fm-text', fmKey: 'name' },
        { field: 'Pronouns', control: 'fm-select', fmKey: 'pronouns', options: ['he/him', 'she/her', 'they/them'] },
      ] },
      { group: 'Personality', file: 'personality', open: 'personality', cards: [
        { field: 'Who you are', control: 'textarea', section: 'Who you are' },
        { field: 'Core traits', control: 'chips', section: 'Core traits', options: ['Direct.', 'Curious.', 'Pragmatic.', 'Quietly sharp.', 'Dry humor welcome.'] },
        { field: 'Tone', control: 'preset', section: 'Tone', presets: resolvePresets(TONE, name) },
        { field: 'How you handle disagreement', control: 'preset', presets: resolvePresets(DISAGREE, name), dual: [{ key: 'personality', section: 'How you handle disagreement' }, { key: 'communication', section: 'Disagreement' }] },
        { field: 'How you handle uncertainty', control: 'preset', section: 'How you handle uncertainty', presets: resolvePresets(UNCERTAIN, name) },
        { field: "What you're not", control: 'chips', section: "What you're not", options: ['Not a cheerleader.', 'Not a yes-man.', 'Not a roleplay character — Mavis is a collaborator, not a persona to perform.'] },
      ] },
      { group: 'Communication', file: 'communication', open: 'communication', cards: [
        { field: address, control: 'textarea', section: address },
        { field: 'Default response shape', control: 'checklist', section: 'Default response shape', options: RESPONSE_SHAPE },
        { field: 'When to be expansive', control: 'textarea', section: 'When to be expansive' },
        { field: 'Language', control: 'fm-select-section', section: 'Language', options: ['English'] },
        { field: 'Markdown discipline', control: 'textarea', section: 'Markdown discipline' },
      ] },
    ];
  }

  // ---------- compact line diff ----------
  function lineDiff(before, after) {
    const a = String(before).split('\n'), b = String(after).split('\n');
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const ctx = 2, rows = [];
    for (let i = Math.max(0, p - ctx); i < p; i++) rows.push(['ctx', a[i]]);
    for (let i = p; i < a.length - s; i++) rows.push(['del', a[i]]);
    for (let i = p; i < b.length - s; i++) rows.push(['add', b[i]]);
    const aEnd = a.length - s;
    for (let i = aEnd; i < Math.min(aEnd + ctx, a.length); i++) rows.push(['ctx', a[i]]);
    return rows;
  }

  // ---------- the propose-then-confirm Review panel ----------
  // changes: [{ key, section|fm, op }] — previews each, shows the diff, saves all on confirm.
  async function review(host, title, changes, onDone) {
    const panel = el('div', 'mt-review');
    panel.appendChild(el('div', 'mt-review-head', 'Review changes before saving to the brain'));
    panel.appendChild(el('div', 'mt-review-sub', 'This is the exact patch. Nothing is written until you click “Save to brain”.'));
    let anyChange = false;
    const previews = [];
    for (const c of changes) {
      let pv; try { pv = await window.mavis.previewMavisConfig(c.key, c.op); } catch { pv = { ok: false, error: 'preview failed' }; }
      if (!pv || !pv.ok) { const e = el('div', 'mt-review-err', 'Could not prepare ' + c.key + ': ' + ((pv && pv.error) || 'error')); panel.appendChild(e); continue; }
      previews.push({ key: c.key, op: c.op, pv });
      if (!pv.changed) continue;
      anyChange = true;
      panel.appendChild(el('div', 'mt-review-file', c.key + '.md' + (c.label ? '  ·  ' + c.label : '')));
      const diff = el('div', 'mt-diff');
      lineDiff(pv.before, pv.after).forEach(([t, s]) => { const d = el('div', 'mt-diff-' + t); d.textContent = (t === 'del' ? '- ' : t === 'add' ? '+ ' : '  ') + s; diff.appendChild(d); });
      panel.appendChild(diff);
    }
    const row = el('div', 'mt-do-form-actions');
    if (anyChange) {
      const save = el('button', 'mt-pill', 'Save to brain');
      const status = el('span', 'mt-do-form-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      save.addEventListener('click', async () => {
        save.disabled = true; save.textContent = 'Saving…';
        for (const pr of previews) {
          if (!pr.pv.changed) continue;
          let r; try { r = await window.mavis.saveMavisConfig(pr.key, pr.op); } catch { r = { ok: false, error: 'save failed' }; }
          if (!r || !r.ok) { save.disabled = false; save.textContent = 'Save to brain'; status.textContent = 'Aborted: ' + ((r && r.error) || 'guard failed'); return; }
        }
        onDone(true);
      });
      row.appendChild(save);
      const cancel = el('button', 'mt-link', 'Cancel'); cancel.addEventListener('click', () => onDone(false)); row.appendChild(cancel);
      row.appendChild(status);
    } else {
      panel.appendChild(el('div', 'mt-do-hint', 'No changes to save.'));
      const cancel = el('button', 'mt-link', 'Close'); cancel.addEventListener('click', () => onDone(false)); row.appendChild(cancel);
    }
    panel.appendChild(row);
    host.innerHTML = ''; host.appendChild(panel);
  }

  // ---------- card ----------
  function card(c, cfg, refresh) {
    const wrap = el('div', 'mt-id-card');
    const head = el('div', 'mt-id-card-head');
    head.appendChild(el('div', 'mt-id-card-title', c.field));
    const pencil = el('button', 'mt-pencil'); pencil.type = 'button'; pencil.innerHTML = PENCIL + '<span>Edit</span>';
    head.appendChild(pencil);
    wrap.appendChild(head);
    const body = el('div', 'mt-id-card-body');
    wrap.appendChild(body);

    const fm = parseFm(cfg.profile);
    const fileMd = (key) => (key === 'profile' ? cfg.profile : key === 'communication' ? cfg.communication : cfg.personality);
    const curSectionBody = c.section ? sectionBody(fileMd(c.file), c.section)
      : (c.dual ? sectionBody(fileMd(c.dual[0].key), c.dual[0].section) : '');
    const curFm = c.fmKey ? (fm[c.fmKey] || '') : '';

    // ----- read view -----
    function renderRead() {
      pencil.style.display = '';
      body.innerHTML = '';
      if (c.control === 'fm-text' || c.control === 'fm-select') { body.appendChild(el('div', 'mt-id-val', curFm || '—')); }
      else if (c.control === 'chips' || c.control === 'checklist') {
        const items = bulletsOf(curSectionBody);
        const chips = el('div', 'mt-chips-read');
        items.forEach((t) => { const ch = el('span', 'mt-chip on'); if (MT.md) MT.md.inline(t, ch); else ch.textContent = t; chips.appendChild(ch); });
        body.appendChild(items.length ? chips : el('div', 'mt-id-val', '—'));
      } else { const v = el('div', 'mt-id-val'); if (MT.md && curSectionBody) v.appendChild(MT.md.render(curSectionBody, 'mt-md-tight')); else v.textContent = curSectionBody || '—'; body.appendChild(v); }
      if (c.dual) { const s = el('div', 'mt-id-sync'); s.innerHTML = icon('refresh', 12) + '<span>kept in sync across personality.md + communication.md</span>'; body.appendChild(s); }
    }

    // ----- edit view; returns getChanges() -----
    function renderEdit() {
      pencil.style.display = 'none';
      body.innerHTML = '';
      let getBody; // () => the new section body string (for section controls)
      let getValue; // () => the new frontmatter value (for fm controls)

      if (c.control === 'fm-text') {
        const inp = el('input', 'mt-field-input'); inp.type = 'text'; inp.value = curFm; body.appendChild(inp); getValue = () => inp.value.trim();
      } else if (c.control === 'fm-select') {
        const sel = MT.dropdown.create({ options: [...c.options, 'Custom…'].map((o) => ({ value: o, label: o })), className: 'mt-field-input' });
        const cust = el('input', 'mt-field-input'); cust.type = 'text'; cust.placeholder = 'custom value'; cust.style.marginTop = '8px';
        const known = c.options.includes(curFm); sel.value = known ? curFm : 'Custom…'; cust.value = known ? '' : curFm; cust.style.display = known ? 'none' : '';
        sel.addEventListener('change', () => { cust.style.display = sel.value === 'Custom…' ? '' : 'none'; });
        body.appendChild(sel); body.appendChild(cust);
        getValue = () => (sel.value === 'Custom…' ? cust.value.trim() : sel.value);
      } else if (c.control === 'fm-select-section') {
        const sel = MT.dropdown.create({ options: [...c.options, 'Custom…'].map((o) => ({ value: o, label: o })), className: 'mt-field-input' });
        const known = c.options.includes(curSectionBody.trim()); sel.value = known ? curSectionBody.trim() : 'Custom…';
        const cust = el('input', 'mt-field-input'); cust.type = 'text'; cust.value = known ? '' : curSectionBody; cust.style.marginTop = '8px'; cust.style.display = known ? 'none' : '';
        sel.addEventListener('change', () => { cust.style.display = sel.value === 'Custom…' ? '' : 'none'; });
        body.appendChild(sel); body.appendChild(cust);
        getBody = () => (sel.value === 'Custom…' ? cust.value.trim() : sel.value);
      } else if (c.control === 'textarea') {
        const ta = el('textarea', 'mt-field-input'); ta.value = curSectionBody; ta.rows = Math.min(10, Math.max(3, curSectionBody.split('\n').length + 1)); body.appendChild(ta); getBody = () => ta.value;
      } else if (c.control === 'preset') {
        const row = el('div', 'mt-preset-row');
        const sel = MT.dropdown.create({ options: c.presets.map((p) => ({ value: p.label, label: p.label })).concat([{ value: '__custom', label: 'Custom…' }]), className: 'mt-field-input mt-preset-sel' });
        row.appendChild(sel);
        const flag = el('span', 'mt-preset-flag'); row.appendChild(flag);
        body.appendChild(row);
        const ta = el('textarea', 'mt-field-input'); ta.value = curSectionBody; ta.rows = Math.min(8, Math.max(3, curSectionBody.split('\n').length + 2)); body.appendChild(ta);
        const match = c.presets.find((p) => norm(p.text) === norm(curSectionBody));
        const syncFlag = () => {
          const m2 = c.presets.find((p) => norm(p.text) === norm(ta.value));
          if (m2) { sel.value = m2.label; flag.textContent = '✓ matches “' + m2.label + '”'; flag.className = 'mt-preset-flag matched'; }
          else { sel.value = '__custom'; flag.textContent = 'Custom (hand-tuned)'; flag.className = 'mt-preset-flag custom'; }
        };
        sel.value = match ? match.label : '__custom';
        sel.addEventListener('change', () => { if (sel.value !== '__custom') { const p = c.presets.find((x) => x.label === sel.value); if (p) ta.value = p.text; } syncFlag(); });
        ta.addEventListener('input', syncFlag);
        syncFlag();
        getBody = () => ta.value;
      } else if (c.control === 'chips' || c.control === 'checklist') {
        const cur = bulletsOf(curSectionBody);
        const items = cur.map((t) => ({ text: t, on: true }));
        (c.options || []).forEach((o) => { if (!items.some((it) => norm(it.text) === norm(o) || norm(it.text).startsWith(norm(o).slice(0, 18)))) items.push({ text: o, on: false }); });
        const list = el('div', c.control === 'chips' ? 'mt-chips-edit' : 'mt-checks');
        items.forEach((it) => {
          if (c.control === 'chips') {
            const ch = el('button', 'mt-chip' + (it.on ? ' on' : '')); ch.type = 'button'; ch.textContent = it.text.replace(/\*\*/g, '');
            ch.addEventListener('click', () => { it.on = !it.on; ch.classList.toggle('on', it.on); });
            list.appendChild(ch);
          } else {
            const rowEl = el('label', 'mt-check'); const sw = el('span', 'mt-sw' + (it.on ? ' on' : ''));
            const lbl = el('span', 'mt-check-lbl'); if (MT.md) MT.md.inline(it.text, lbl); else lbl.textContent = it.text;
            rowEl.appendChild(sw); rowEl.appendChild(lbl);
            rowEl.addEventListener('click', (e) => { e.preventDefault(); it.on = !it.on; sw.classList.toggle('on', it.on); });
            list.appendChild(rowEl);
          }
        });
        body.appendChild(list);
        if (c.control === 'chips') { const add = el('button', 'mt-chip mt-chip-add', '+ add'); add.type = 'button'; add.addEventListener('click', () => { const t = prompt('Add a trait'); if (t && t.trim()) { items.push({ text: t.trim(), on: true }); renderEditAddChip(list, items[items.length - 1]); } }); list.appendChild(add); }
        getBody = () => items.filter((it) => it.on).map((it) => '- ' + it.text).join('\n');
      }

      function renderEditAddChip(list, it) {
        const ch = el('button', 'mt-chip on'); ch.type = 'button'; ch.textContent = it.text.replace(/\*\*/g, '');
        ch.addEventListener('click', () => { it.on = !it.on; ch.classList.toggle('on', it.on); });
        list.insertBefore(ch, list.lastChild);
      }

      const actions = el('div', 'mt-do-form-actions');
      const reviewBtn = el('button', 'mt-pill', 'Review changes');
      const cancel = el('button', 'mt-link', 'Cancel');
      cancel.addEventListener('click', () => renderRead());
      reviewBtn.addEventListener('click', () => {
        let changes;
        if (c.fmKey) changes = [{ key: c.file, op: { type: 'frontmatter', key: c.fmKey, value: getValue() } }];
        else if (c.dual) { const b = getBody(); changes = c.dual.map((d) => ({ key: d.key, label: '## ' + d.section, op: { type: 'section', heading: d.section, body: b } })); }
        else changes = [{ key: c.file, label: '## ' + c.section, op: { type: 'section', heading: c.section, body: getBody() } }];
        const rp = el('div'); body.appendChild(rp);
        actions.style.display = 'none';
        review(rp, c.field, changes, (saved) => { if (saved) refresh(); else { rp.remove(); actions.style.display = ''; renderRead(); } });
      });
      actions.appendChild(reviewBtn); actions.appendChild(cancel);
      body.appendChild(actions);
    }

    pencil.addEventListener('click', () => renderEdit());
    renderRead();
    return wrap;
  }

  // ---------- read-only doc (rules) ----------
  function docSection(parent, content, key, collapse, label) {
    const sec = el('div', 'mt-mavis-sec');
    const head = el('div', 'mt-mavis-sec-head'); head.appendChild(el('div')); head.appendChild(openBtn(key, label));
    sec.appendChild(head);
    const body = stripFm(content);
    if (body.trim() && MT.md) sec.appendChild(MT.md.render(body, 'mt-mavis-doc', collapse ? { collapse: true } : undefined));
    else if (body.trim()) { const pre = el('pre', 'mt-mavis-doc'); pre.textContent = body; sec.appendChild(pre); }
    else sec.appendChild(el('div', 'mt-empty', 'This file is empty.'));
    parent.appendChild(sec);
  }

  const TITLES = { identity: 'Identity', rules: 'Rules' };
  // rules has no static subtitle — cfg.rulesFile (from brain-stats.contractFiles, AGENTS.md when
  // present else the legacy CLAUDE.md) names whichever file is actually canonical, so the
  // subtitle, the content on screen, and the "Open file" target below can never disagree.
  const SUBS = {
    identity: 'Who Mavis is, and how it talks — edit any category below; nothing saves until you review the diff.',
  };
  const rulesSub = (file) => 'The operating contract Mavis follows every session (' + file + '). Read-only here — open the file to edit.';

  MT.mavisConfig = {
    async render(host, section) {
      host.innerHTML = '';
      host.appendChild(el('div', 'mt-page-title', TITLES[section] || 'Mavis'));

      let cfg; try { cfg = await window.mavis.getMavisConfig(); } catch { cfg = null; }
      cfg = cfg || {};
      const rulesFile = cfg.rulesFile || 'CLAUDE.md';
      const sub = section === 'rules' ? rulesSub(rulesFile) : SUBS[section];
      if (sub) host.appendChild(el('div', 'mt-sub', sub));
      const refresh = () => MT.mavisConfig.render(host, section);

      const wrap = el('div', 'mt-mavis-wrap');
      if (section === 'identity') {
        spec(cfg).forEach((grp) => {
          const g = el('div', 'mt-id-group');
          const lab = el('div', 'mt-label mt-id-group-lab'); lab.textContent = grp.group + ' · ' + grp.file + '.md';
          g.appendChild(lab);
          grp.cards.forEach((c) => g.appendChild(card(Object.assign({ file: grp.file }, c), cfg, refresh)));
          wrap.appendChild(g);
        });
      } else {
        docSection(wrap, cfg.rules, 'rules', true, rulesFile);
      }
      host.appendChild(wrap);
    },
  };
})();
