'use strict';

// MT.pmSettings / MT.mapSettings — sections registered into session-ux's Settings
// view (via MT.settings.registerSection in app.js). Project-board token entry + Map
// rebuild. The board section is only registered when the optional Project Board
// integration is switched on (see mountPmFeature in app.js).
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

  MT.pmSettings = {
    async render(host) {
      let st;
      try { st = await window.mavis.pmTokenStatus(); } catch { st = { present: false }; }
      const field = el('div', 'mt-field');
      const lbl = el('label', 'mt-field-label', 'Project board API token');
      lbl.htmlFor = 'pm-token';
      field.appendChild(lbl);
      const input = el('input', 'mt-field-input');
      input.id = 'pm-token';
      input.type = 'password';
      input.placeholder = st && st.present ? '•••• ' + (st.maskedTail || '') + ' (saved)' : 'Paste your board API token';
      field.appendChild(input);
      host.appendChild(field);
      // Which board this token belongs to is a separate setting, and the pairing is not obvious
      // from a lone password box — say so here rather than let someone paste a token for one
      // deployment against another's URL and get a silent 401.
      const hint = el('div', 'mt-row-sub', 'Read scope is enough. The board this talks to is the "Project board API base URL" setting above — change it to your own deployment if you self-host.');
      hint.style.marginTop = '8px';
      host.appendChild(hint);

      const actions = el('div');
      actions.style.cssText = 'display:flex;gap:12px;align-items:center;margin-top:12px';
      const save = el('button', 'mt-pill', 'Save token');
      const clear = el('button', 'mt-link', 'Clear');
      const status = el('span');
      status.style.cssText = 'color:var(--color-graphite);font-size:13px';
      save.addEventListener('click', async () => {
        if (!input.value) return;
        const r = await window.mavis.pmSetToken(input.value);
        status.textContent = 'Saved (••' + ((r && r.maskedTail) || '') + ')';
        input.value = '';
      });
      clear.addEventListener('click', async () => { await window.mavis.pmClearToken(); status.textContent = 'Cleared'; });
      actions.appendChild(save);
      actions.appendChild(clear);
      actions.appendChild(status);
      host.appendChild(actions);
    },
  };

  MT.mapSettings = {
    async render(host) {
      let st;
      try { st = await window.mavis.mapStatus(); } catch { st = { ready: false }; }
      host.appendChild(el('div', null, st && st.ready ? 'Map is built.' : 'Map is not built yet.'));
      const b = el('button', 'mt-link', 'Rebuild map');
      b.style.marginTop = '8px';
      b.addEventListener('click', async () => {
        b.textContent = 'Rebuilding…';
        const r = await window.mavis.mapRebuild();
        b.textContent = r && r.ok ? 'Rebuilt' : 'Rebuild failed';
      });
      host.appendChild(b);
    },
  };
})();
