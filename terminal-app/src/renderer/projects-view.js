'use strict';

// MT.projects — the Steep launcher. Sections: Recent (top) · Active · Inactive,
// a type-filter chip row + live search, type icons on each card. The whole card
// is the click/keyboard target (no Open button).
(function () {
  const MT = (window.MT = window.MT || {});

  // curated swatches (6-col grid + a "none" cell = 4 rows); project colour tints the card + the
  // session tab's activity dot. Spread across hues — reds/oranges/golds/greens/teals/blues/purples/grays.
  const PRESETS = [
    '#b2542f', '#c0392b', '#97243b', '#d1603d', '#e07a3a', '#c08a2d',
    '#b59a3c', '#9a7b2f', '#6f8f2f', '#4f8a3c', '#2f6d4f', '#2c7a7b',
    '#2f8f86', '#2f6f9e', '#3a6ea5', '#4f5bd5', '#6246c4', '#7c3a6a',
    '#a84e7d', '#c2557a', '#8a5a3c', '#5b6472', '#3c4654',
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function isActive(p) {
    return String((p && (p.group || p.status)) || '').toLowerCase() === 'active';
  }

  // style a swatch button to reflect the current colour (filled) or "unset" (ring)
  function paintSwatch(sw, color) {
    if (color) { sw.classList.add('set'); sw.style.background = color; sw.title = 'Project colour: ' + color; }
    else { sw.classList.remove('set'); sw.style.background = ''; sw.title = 'Set a project colour'; }
  }

  let openPop = null;
  function closeSwatchPop() {
    if (openPop && openPop.parentNode) openPop.parentNode.removeChild(openPop);
    openPop = null;
    document.removeEventListener('pointerdown', onPopDown, true);
    document.removeEventListener('keydown', onPopKey, true);
  }
  function onPopDown(e) { if (openPop && !openPop.contains(e.target)) closeSwatchPop(); }
  function onPopKey(e) { if (e.key === 'Escape') closeSwatchPop(); }

  function openSwatchPop(p, sw) {
    closeSwatchPop();
    const pop = el('div', 'mt-swatch-pop');
    const pick = async (color) => {
      closeSwatchPop();
      let res = null;
      try { res = await window.mavis.setProjectColor(p.slug, color || ''); } catch { res = { ok: false }; }
      if (res && res.ok) { p.color = color || null; paintSwatch(sw, p.color); const card = sw.closest('.mt-proj'); if (card) tintCard(card, p.color); }
    };
    const none = el('button', 'mt-swatch-opt none');
    none.type = 'button'; none.title = 'No colour'; none.setAttribute('aria-label', 'Clear colour');
    if (MT.icons) none.innerHTML = MT.icons.svg('close', 12);
    none.addEventListener('click', () => pick(''));
    pop.appendChild(none);
    PRESETS.forEach((c) => {
      const o = el('button', 'mt-swatch-opt' + (String(p.color || '').toLowerCase() === c ? ' active' : ''));
      o.type = 'button'; o.style.background = c; o.title = c; o.setAttribute('aria-label', 'Use ' + c);
      o.addEventListener('click', () => pick(c));
      pop.appendChild(o);
    });
    document.body.appendChild(pop);
    const r = sw.getBoundingClientRect();
    const pw = pop.offsetWidth || 170;
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    pop.style.left = Math.round(Math.min(r.left, window.innerWidth - pw - 10)) + 'px';
    openPop = pop;
    setTimeout(() => { document.addEventListener('pointerdown', onPopDown, true); document.addEventListener('keydown', onPopKey, true); }, 0);
  }

  // tint the whole card with the project colour (he wanted the card coloured, not just the dot)
  function tintCard(card, color) {
    if (color) { card.classList.add('tinted'); card.style.setProperty('--cardc', color); }
    else { card.classList.remove('tinted'); card.style.removeProperty('--cardc'); }
  }

  function buildCard(p, onOpen) {
    const card = el('div', 'mt-card mt-proj');
    tintCard(card, p.color);

    const head = el('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.alignItems = 'center';
    head.style.gap = '10px';

    // left cluster: type icon + name + type pill (they describe the project, kept together)
    const left = el('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '9px';
    left.style.minWidth = '0';
    const ico = el('span', 'mt-proj-ico');
    if (MT.icons) ico.innerHTML = MT.icons.typeIcon(p.type);
    left.appendChild(ico);
    const nameEl = el('span', 'mt-proj-name', p.name || 'Untitled');
    nameEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0';
    left.appendChild(nameEl);
    if (p.type) { const pill = el('span', 'mt-type-pill', p.type); pill.style.flex = 'none'; left.appendChild(pill); }
    head.appendChild(left);

    // right cluster: controls (swatch + details) kept together with a tight gap so they don't drift apart
    const right = el('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '6px';
    right.style.flex = 'none';
    if (p.slug) {
      const sw = el('button', 'mt-swatch');
      sw.type = 'button';
      paintSwatch(sw, p.color);
      sw.setAttribute('aria-label', 'Set colour for ' + (p.name || 'project'));
      sw.addEventListener('click', (e) => { e.stopPropagation(); openSwatchPop(p, sw); });
      right.appendChild(sw);
    }
    if (p.slug) {
      const info = el('button', 'mt-info-btn');
      info.type = 'button';
      info.title = 'Details';
      info.setAttribute('aria-label', 'Details for ' + (p.name || 'project'));
      if (MT.icons) info.innerHTML = MT.icons.svg('info', 16);
      info.addEventListener('click', (e) => { e.stopPropagation(); MT.router.show('detail', p.slug); });
      right.appendChild(info);
    }
    head.appendChild(right);
    card.appendChild(head);

    if (p.dir) card.appendChild(el('div', 'mt-proj-path', p.dir));
    if (p.lastAccessed) {
      const m = el('div', null, 'opened ' + p.lastAccessed);
      m.style.color = 'var(--color-graphite)';
      m.style.fontSize = '12px';
      m.style.marginTop = '10px';
      card.appendChild(m);
    }

    if (p.dir) {
      const fire = () => onOpen({ cwd: p.dir, label: p.name, color: p.color || null });
      card.title = 'Open ' + (p.name || 'project');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', 'Open ' + (p.name || 'project'));
      card.addEventListener('click', fire);
      card.addEventListener('keydown', (e) => { if (e.target !== card) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } });
    } else {
      card.style.cursor = 'default';
    }
    return card;
  }

  function section(label, items, onOpen) {
    if (!items.length) return null;
    const frag = document.createDocumentFragment();
    const lbl = el('div', 'mt-label', label);
    lbl.style.margin = '18px 0 11px';
    frag.appendChild(lbl);
    const grid = el('div', 'mt-grid');
    items.forEach((p) => grid.appendChild(buildCard(p, onOpen)));
    frag.appendChild(grid);
    return frag;
  }

  MT.projects = {
    async render(host, onOpen) {
      host.innerHTML = '';
      let list = [];
      try { list = await window.mavis.listProjects(); } catch { /* empty */ }
      if (!Array.isArray(list)) list = [];

      // header: serif title + search
      const header = el('div');
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'flex-end';
      header.style.gap = '16px';
      header.style.marginBottom = '16px';
      header.appendChild(el('div', 'mt-page-title', 'Projects'));
      const search = el('div', 'mt-search');
      const sico = el('span');
      if (MT.icons) sico.innerHTML = MT.icons.svg('search', 16);
      search.appendChild(sico);
      const input = el('input');
      input.type = 'search';
      input.placeholder = 'Search…';
      input.setAttribute('aria-label', 'Search projects');
      search.appendChild(input);

      // right group: "New project" + search
      const right = el('div', 'mt-proj-headright');
      const newBtn = el('button', 'mt-pill mt-proj-new');
      newBtn.type = 'button';
      newBtn.innerHTML = (MT.icons ? MT.icons.svg('plus', 15) : '') + '<span>New project</span>';
      newBtn.addEventListener('click', () => { if (MT.newProject) MT.newProject.open(() => MT.projects.render(host, onOpen)); });
      right.append(newBtn, search);
      header.appendChild(right);
      host.appendChild(header);

      // type-filter chips
      const types = Array.from(new Set(list.map((p) => p.type).filter(Boolean))).sort();
      const filters = el('div', 'mt-filters');
      const chips = {};
      let typeFilter = 'all';
      const mkChip = (key, text) => {
        const b = el('button', 'mt-filter' + (key === 'all' ? ' active' : ''), text);
        b.type = 'button';
        b.addEventListener('click', () => {
          typeFilter = key;
          for (const k in chips) chips[k].classList.toggle('active', k === key);
          paint();
        });
        chips[key] = b;
        filters.appendChild(b);
      };
      mkChip('all', 'All');
      types.forEach((t) => mkChip(t, t));
      host.appendChild(filters);

      const body = el('div');
      host.appendChild(body);

      function paint() {
        body.innerHTML = '';
        const q = input.value.trim().toLowerCase();
        const filtered = list.filter((p) => {
          if (typeFilter !== 'all' && String(p.type || '').toLowerCase() !== typeFilter.toLowerCase()) return false;
          if (!q) return true;
          return String(p.name || '').toLowerCase().includes(q) || String(p.dir || '').toLowerCase().includes(q);
        });
        if (!filtered.length) {
          body.appendChild(el('div', 'mt-empty', list.length ? 'No matching projects' : 'No projects found'));
          return;
        }
        const recent = filtered
          .filter((p) => p.lastAccessed)
          .slice()
          .sort((a, b) => String(b.lastAccessed).localeCompare(String(a.lastAccessed)))
          .slice(0, 6);
        const recentNames = new Set(recent.map((p) => p.name));
        const active = filtered.filter((p) => isActive(p) && !recentNames.has(p.name));
        const inactive = filtered.filter((p) => !isActive(p) && !recentNames.has(p.name));

        const r = section('Recent', recent, onOpen); if (r) body.appendChild(r);
        const a = section('Active', active, onOpen); if (a) body.appendChild(a);
        const i = section('Inactive', inactive, onOpen); if (i) body.appendChild(i);
      }

      let paintTimer = null;
      input.addEventListener('input', () => { clearTimeout(paintTimer); paintTimer = setTimeout(paint, 120); });
      paint();
    },
  };
})();
