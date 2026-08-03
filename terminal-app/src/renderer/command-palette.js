'use strict';

// MT.palette — Ctrl K jump (fuzzy project open) + Ctrl Shift F search (brain-wide).
// open('jump') (default) | open('search'). Steep dialog with focus return + Tab trap.
(function () {
  const MT = (window.MT = window.MT || {});
  let overlay = null;
  let projects = [];

  // navigable views surfaced in Ctrl+K alongside projects (palette-only since their
  // sidebar buttons were consolidated away). Routes via MT.router.show(view).
  const VIEWS = [
    { view: 'mavis-identity', name: 'Identity', hint: 'Mavis — edit identity' },
    { view: 'mavis-rules', name: 'Rules', hint: 'Mavis — edit rules' },
  ];

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function markHit(snippet, q) {
    const s = esc(snippet);
    if (!q) return s;
    const eq = esc(q);
    const i = s.toLowerCase().indexOf(eq.toLowerCase());
    if (i < 0) return s;
    return s.slice(0, i) + '<mark>' + s.slice(i, i + eq.length) + '</mark>' + s.slice(i + eq.length);
  }

  MT.palette = {
    init() { /* nothing to pre-warm */ },
    async open(mode) {
      if (overlay) return;
      mode = mode === 'search' ? 'search' : 'jump';
      const prevFocus = document.activeElement;
      if (mode === 'jump') {
        try { projects = await window.mavis.listProjects(); } catch { projects = []; }
        if (!Array.isArray(projects)) projects = [];
      }

      overlay = document.createElement('div');
      overlay.className = 'mt-palette-overlay';
      const aria = mode === 'search' ? 'Search the brain' : 'Jump to a project';
      const ph = mode === 'search' ? 'Search the brain…' : 'Jump to a project…';
      overlay.innerHTML =
        '<div class="mt-palette" role="dialog" aria-modal="true" aria-label="' + aria + '">' +
        '<input class="mt-palette-input" placeholder="' + ph + '" aria-label="' + aria + '" />' +
        '<div class="mt-palette-list"></div></div>';
      const input = overlay.querySelector('.mt-palette-input');
      const listEl = overlay.querySelector('.mt-palette-list');

      let idx = 0;
      let results = [];
      let searchTimer = null;

      const close = () => {
        clearTimeout(searchTimer);
        if (overlay) { overlay.remove(); overlay = null; }
        if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      };
      const pick = (i) => {
        const r = results[i];
        if (!r) return;
        if (mode === 'jump') { close(); if (r.view) MT.router.show(r.view); else MT.openProject({ cwd: r.dir, label: r.name }); }
        else if (r.slug) { close(); MT.router.show('detail', r.slug); }
      };
      // one delegated listener instead of re-binding every row on each redraw
      listEl.addEventListener('click', (e) => {
        const row = e.target.closest && e.target.closest('.mt-palette-row');
        if (row && row.dataset.i != null) pick(Number(row.dataset.i));
      });
      const refreshActive = () => {
        const rows = listEl.querySelectorAll('.mt-palette-row');
        rows.forEach((r, i) => r.classList.toggle('active', i === idx));
        const a = rows[idx];
        if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
      };

      const drawJump = () => {
        const q = input.value.toLowerCase();
        const vmatches = VIEWS.filter((v) => v.name.toLowerCase().includes(q) || v.hint.toLowerCase().includes(q));
        const pmatches = projects.filter((p) => p && p.dir && String(p.name || '').toLowerCase().includes(q));
        results = vmatches.concat(pmatches);
        if (idx >= results.length) idx = 0;
        listEl.innerHTML =
          results.map((r, i) =>
            `<div class="mt-palette-row${i === idx ? ' active' : ''}" data-i="${i}">` +
            `<span>${esc(r.name)}</span><span class="path">${esc(r.view ? r.hint : (r.dir || ''))}</span></div>`
          ).join('') || '<div class="mt-empty">No match</div>';
      };

      const drawSearch = async () => {
        const q = input.value.trim();
        if (q.length < 2) { results = []; listEl.innerHTML = '<div class="mt-empty">Type at least 2 characters…</div>'; return; }
        let res = [];
        try { res = await window.mavis.searchBrain(q); } catch { res = []; }
        if (!overlay) return; // closed while awaiting
        results = Array.isArray(res) ? res : [];
        if (idx >= results.length) idx = 0;
        if (!results.length) { listEl.innerHTML = '<div class="mt-empty">No matches</div>'; return; }
        let html = '';
        let lastGroup = null;
        results.forEach((r, i) => {
          const group = r.project || r.file;
          if (group !== lastGroup) { html += `<div class="mt-search-group">${esc(group)}</div>`; lastGroup = group; }
          html +=
            `<div class="mt-palette-row${i === idx ? ' active' : ''}" data-i="${i}">` +
            `<span class="mt-search-snip">${markHit(r.snippet, q)}</span>` +
            `<span class="path">${esc(r.file)}:${r.line}</span></div>`;
        });
        listEl.innerHTML = html;
      };

      const draw = () => {
        if (mode === 'jump') drawJump();
        else { clearTimeout(searchTimer); searchTimer = setTimeout(drawSearch, 200); }
      };

      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      input.addEventListener('input', () => { idx = 0; draw(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, Math.max(0, results.length - 1)); refreshActive(); }
        else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); refreshActive(); }
        else if (e.key === 'Enter') pick(idx);
        else if (e.key === 'Tab') e.preventDefault();
      });

      document.body.appendChild(overlay);
      draw();
      input.focus();
    },
  };
})();
