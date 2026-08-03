'use strict';

// MT.detail — read-only project brain context (no session). Reached via the
// info-icon on project cards / dashboard rows, or a search result.
(function () {
  const MT = (window.MT = window.MT || {});

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function card(label, body) {
    const c = el('div', 'mt-card');
    c.style.padding = '18px';
    const l = el('div', 'mt-label', label);
    l.style.marginBottom = '12px';
    c.appendChild(l);
    c.appendChild(body);
    return c;
  }

  function emptyBody(text) { return el('div', 'mt-empty', text); }

  function progressBody(items) {
    if (!items || !items.length) return emptyBody('No checkpoints yet');
    const wrap = el('div');
    items.forEach((p) => {
      const row = el('div', 'mt-checkpoint');
      row.appendChild(el('div', 'mt-checkpoint-when', p.when || ''));
      if (p.text) row.appendChild(el('div', 'mt-checkpoint-text', p.text));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function specsBody(items) {
    if (!items || !items.length) return emptyBody('No specs in progress');
    const wrap = el('div');
    items.forEach((s) => {
      const top = el('div');
      top.style.cssText = 'display:flex;justify-content:space-between;font-size:14px;margin-top:2px';
      top.appendChild(el('span', null, s.change || 'spec'));
      const hasTotal = typeof s.total === 'number' && s.total > 0;
      const t = el('span', null, hasTotal ? `${s.completed || 0}/${s.total}` : '');
      t.style.color = 'var(--color-graphite)';
      top.appendChild(t);
      wrap.appendChild(top);
      const bar = el('div', 'mt-bar');
      bar.style.margin = '6px 0 12px';
      const fill = el('span');
      fill.style.width = (hasTotal ? Math.round(((s.completed || 0) / s.total) * 100) : 0) + '%';
      bar.appendChild(fill);
      wrap.appendChild(bar);
    });
    return wrap;
  }

  function notesBody(items) {
    if (!items || !items.length) return emptyBody('No notes yet');
    const wrap = el('div');
    items.forEach((n) => {
      const row = el('div', 'mt-checkpoint');
      row.appendChild(el('div', 'mt-checkpoint-text', n.text || ''));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function mentionsBody(items) {
    if (!items || !items.length) return emptyBody('No recent mentions');
    const wrap = el('div');
    items.forEach((m) => {
      const row = el('div', 'mt-checkpoint');
      row.appendChild(el('div', 'mt-checkpoint-text', m.headline || ''));
      row.appendChild(el('div', 'mt-checkpoint-when', m.date || ''));
      wrap.appendChild(row);
    });
    return wrap;
  }

  MT.detail = {
    async render(host, slug, onOpen) {
      host.innerHTML = '';
      let d;
      try { d = await window.mavis.getProjectDetail(slug); } catch { d = null; }
      if (!d) { host.appendChild(emptyBody('Project not found')); return; }

      const back = el('button', 'mt-link', '‹ Projects');
      back.type = 'button';
      back.style.marginBottom = '10px';
      back.addEventListener('click', () => MT.router.show('projects'));
      host.appendChild(back);

      const head = el('div', 'mt-detail-head');
      const titleRow = el('div');
      titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
      const left = el('div');
      left.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0';
      const ico = el('span', 'mt-proj-ico');
      if (MT.icons) ico.innerHTML = MT.icons.typeIcon(d.type);
      left.appendChild(ico);
      left.appendChild(el('div', 'mt-page-title', d.name));
      titleRow.appendChild(left);
      if (d.dir) {
        const open = el('button', 'mt-pill', 'Open session');
        open.addEventListener('click', () => onOpen({ cwd: d.dir, label: d.name }));
        titleRow.appendChild(open);
      }
      head.appendChild(titleRow);

      const meta = el('div', 'mt-detail-meta');
      const m1 = [d.type, d.status].filter(Boolean).join(' · ');
      if (m1) meta.appendChild(el('span', null, m1));
      if (d.dir) meta.appendChild(el('span', 'mt-detail-path', d.dir));
      if (d.lastAccessed) meta.appendChild(el('span', null, 'opened ' + d.lastAccessed));
      head.appendChild(meta);
      host.appendChild(head);

      const grid = el('div', 'mt-detail-grid');
      grid.appendChild(card('Latest progress', progressBody(d.progress)));
      grid.appendChild(card('Active specs', specsBody(d.specs)));
      grid.appendChild(card('Notes & gotchas', notesBody(d.notes)));
      grid.appendChild(card('Recent mentions', mentionsBody(d.mentions)));
      host.appendChild(grid);
    },
  };
})();
