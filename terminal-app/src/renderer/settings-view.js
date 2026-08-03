'use strict';

// MT.settings — the Settings view (session-ux owns it). Section-extensible:
// other modules call MT.settings.registerSection(label, render) to add a card
// below the core form (integrations registers PM token + Map controls there).
(function () {
  const MT = (window.MT = window.MT || {});
  const sections = [];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function appliesTag(applies) {
    if (applies === 'live') return null; // live settings apply immediately — no badge (only flag the ones that need a restart)
    return el('span', 'mt-field-tag', 'needs restart');
  }

  MT.settings = {
    registerSection(label, render) {
      if (typeof render === 'function') sections.push({ label, render });
    },

    async render(host) {
      host.innerHTML = '';
      host.appendChild(el('div', 'mt-page-title', 'Settings'));

      let data;
      try { data = await window.mavis.getSettings(); } catch { data = null; }
      const schema = (data && data.schema) || {};
      const values = (data && data.values) || {};

      // Never offer a harness that is not installed — a dead dropdown entry that spawns nothing is
      // worse than no choice at all. Fetched ONCE, up front (render() is already async and this is
      // one more await before any row paints — same pattern as the getSettings() call above), rather
      // than per-row: the row loop below is a plain synchronous for-in, and awaiting inside it would
      // risk reordering/dropping rows for no benefit since only one key needs this data.
      let harnessInstalled = [];
      try { harnessInstalled = await window.mavis.harnessAvailable(); } catch { harnessInstalled = []; }
      if (!Array.isArray(harnessInstalled)) harnessInstalled = [];

      const card = el('div', 'mt-card');
      card.style.padding = '20px';
      card.style.marginTop = '16px';

      const form = el('div', 'mt-settings-form');
      const inputs = {};
      for (const key in schema) {
        const s = schema[key];
        // Single-harness machine (the common case today): skip the row entirely rather than show a
        // dropdown with exactly one dead-obvious choice.
        if (key === 'harness' && harnessInstalled.length < 2) continue;
        const field = el('div', 'mt-field');
        const label = el('label', 'mt-field-label', s.label || key);
        label.htmlFor = 'set-' + key;
        if (s.applies) { const tag = appliesTag(s.applies); if (tag) label.appendChild(tag); }
        field.appendChild(label);

        let input;
        if (s.type === 'weekdays') {
          // 7 toggle chips (Mon→Sun); stores a CSV of JS getDay() indices (0=Sun … 6=Sat).
          const DAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];
          const selected = new Set(String(values[key] != null ? values[key] : (s.default || ''))
            .split(',').map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6));
          const group = el('div', 'mt-weekdays');
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', s.label || key);
          DAYS.forEach(([lbl, idx]) => {
            const b = el('button', 'mt-weekday' + (selected.has(idx) ? ' on' : ''), lbl);
            b.type = 'button';
            b.setAttribute('aria-pressed', selected.has(idx) ? 'true' : 'false');
            b.addEventListener('click', () => {
              if (selected.has(idx)) selected.delete(idx); else selected.add(idx);
              b.classList.toggle('on');
              b.setAttribute('aria-pressed', selected.has(idx) ? 'true' : 'false');
            });
            group.appendChild(b);
          });
          // expose `.value` (CSV) for the generic save loop; a no-op setter so the initializer below can't reset it
          Object.defineProperty(group, 'value', {
            get() { return Array.from(selected).sort((a, b) => a - b).join(','); },
            set() { /* state is driven by the chips */ },
          });
          input = group;
        } else if (Array.isArray(s.enum)) {
          // harness: only offer ids actually installed (already guaranteed >= 2 here, or the row
          // was skipped above); every other enum field is unaffected.
          const enumValues = key === 'harness' ? s.enum.filter((opt) => harnessInstalled.includes(opt)) : s.enum;
          const ddOpts = enumValues.map((opt) => ({ value: opt, label: (s.enumLabels && s.enumLabels[opt]) || opt }));
          input = MT.dropdown.create({ options: ddOpts, value: values[key], className: 'mt-field-input', ariaLabel: s.label || key });
          // live preview: app theme applies on change; Save persists it (only-save-on-Save)
          if (key === 'appTheme') input.addEventListener('change', () => { if (MT.theme && MT.theme.apply) MT.theme.apply(input.value, { animate: true }); });
          // preview the completion sound when you pick one
          if (key === 'notifySound') input.addEventListener('change', () => { if (MT.notify) { MT.notify.configure({ sound: input.value }); MT.notify.test(); } });
        } else {
          input = el('input', 'mt-field-input');
          input.type = s.type === 'number' ? 'number' : 'text';
          if (s.clamp) { input.min = s.clamp[0]; input.max = s.clamp[1]; }
          // a field whose blank state MEANS something (autorunCommand) has to say so in the box
          if (s.placeholder) input.placeholder = s.placeholder;
          if (key === 'notifyVolume') input.addEventListener('change', () => { if (MT.notify) { MT.notify.configure({ volume: input.value }); MT.notify.test(); } });
        }
        input.id = 'set-' + key;
        input.value = values[key] != null ? values[key] : '';
        field.appendChild(input);
        inputs[key] = input;
        form.appendChild(field);
      }
      card.appendChild(form);

      const actions = el('div');
      actions.style.cssText = 'display:flex;gap:12px;align-items:center;margin-top:16px';
      const save = el('button', 'mt-pill', 'Save');
      const status = el('span');
      status.style.cssText = 'color:var(--color-graphite);font-size:13px';
      save.addEventListener('click', async () => {
        const patch = {};
        for (const k in inputs) patch[k] = inputs[k].value;
        try {
          const r = await window.mavis.setSettings(patch);
          if (r && r.ok) {
            status.textContent = 'Saved';
            if (MT.theme && MT.theme.apply && patch.appTheme) MT.theme.apply(patch.appTheme, { animate: true });
            if (MT.session && MT.session.applyTerminalSettings) MT.session.applyTerminalSettings({ fontSize: Number(patch.terminalFontSize) });
            if (MT.notify && MT.notify.configure) MT.notify.configure({ mode: patch.notifyOnComplete, sound: patch.notifySound, volume: patch.notifyVolume });
          } else {
            status.textContent = 'Save failed';
          }
        } catch {
          status.textContent = 'Save failed';
        }
      });
      actions.appendChild(save);
      actions.appendChild(status);
      card.appendChild(actions);
      host.appendChild(card);

      // registered sections (e.g. integrations: PM token, Map controls)
      for (const sec of sections) {
        const wrap = el('div');
        wrap.style.marginTop = '18px';
        const lbl = el('div', 'mt-label', sec.label);
        lbl.style.margin = '0 0 10px';
        wrap.appendChild(lbl);
        const c = el('div', 'mt-card');
        c.style.padding = '20px';
        try { sec.render(c); } catch { /* a section error must not break Settings */ }
        wrap.appendChild(c);
        host.appendChild(wrap);
      }
    },
  };
})();
