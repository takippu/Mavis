'use strict';

// MT.topics — the topic_index retrieval graph as a browsable panel: a searchable left rail
// of topics (slug + one-line "Did"); the main pane renders the selected topic as a header +
// Triggers chips (collapsed) + Did lead + clickable Refs + a Pre-empt callout + one
// collapsible card per dated addendum — instead of one wall of markdown.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const md = (text, host) => { if (MT.md) host.appendChild(MT.md.render(text, 'mt-md-tight')); else host.appendChild(el('div', null, text)); };

  function firstLine(s) { return String(s || '').split(/\r?\n/)[0] || ''; }

  // a ref line ("`projects/x/notes.md` (desc)") → a clickable path + plain rest where routable
  function renderRef(refStr) {
    const div = el('div', 'mt-topic-ref');
    const m = String(refStr).match(/^`([^`]+)`(.*)$/);
    const route = m && MT.md && MT.md.linkRoute && MT.md.linkRoute(m[1]);
    if (route) {
      const a = el('a', 'mt-md-link mt-mono', m[1]); a.setAttribute('role', 'link'); a.tabIndex = 0; a.title = m[1];
      a.addEventListener('click', (e) => { e.preventDefault(); route(); });
      a.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); route(); } });
      div.appendChild(a);
      if (m[2] && MT.md) MT.md.inline(m[2], div);
    } else if (MT.md) MT.md.inline(refStr, div);
    else div.textContent = refStr;
    return div;
  }

  function triggerChips(triggers) {
    const all = String(triggers || '').split(',').map((s) => s.trim()).filter(Boolean);
    const wrap = el('div', 'mt-topic-triggers');
    if (!all.length) return wrap;
    const SHOW = 4;
    all.forEach((tr, i) => { const c = el('span', 'mt-chip', tr); if (i >= SHOW) c.classList.add('mt-hidden'); wrap.appendChild(c); });
    if (all.length > SHOW) {
      const more = el('button', 'mt-chip mt-chip-more', '+' + (all.length - SHOW) + ' more');
      more.type = 'button';
      more.addEventListener('click', () => { wrap.querySelectorAll('.mt-hidden').forEach((c) => c.classList.remove('mt-hidden')); more.remove(); });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function addendumFold(a, open) {
    const fold = el('div', 'mt-fold' + (open ? ' open' : ''));
    const head = el('button', 'mt-fold-head'); head.type = 'button';
    head.appendChild(el('span', 'mt-fold-date', a.date || ''));
    head.appendChild(el('span', 'mt-fold-title', a.title || 'Note'));
    head.appendChild(el('span', 'mt-fold-caret', '▸'));
    const body = el('div', 'mt-fold-body');
    md(a.body || '', body);
    head.setAttribute('aria-expanded', String(!!open)); head.addEventListener('click', () => { head.setAttribute('aria-expanded', String(fold.classList.toggle('open'))); });
    fold.appendChild(head); fold.appendChild(body);
    return fold;
  }

  const remembered = new Map();
  MT.topics = {
    async render(host, initialSlug, opts = {}) {
      host.innerHTML = '';
      const header = el('div', 'mt-row');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:8px';
      header.appendChild(el('div', 'mt-page-title', 'Topics'));
      const search = el('div', 'mt-search');
      const sico = el('span'); if (MT.icons) sico.innerHTML = MT.icons.svg('search', 16); search.appendChild(sico);
      const input = el('input'); input.type = 'search'; input.placeholder = 'Search topics…'; input.setAttribute('aria-label', 'Search topics');
      search.appendChild(input);
      header.appendChild(search);
      host.appendChild(header);

      const scope = opts.project || 'all'; const state = remembered.get(scope) || {}; input.value = state.query || ''; initialSlug ||= state.slug;
      let topics = [];
      try { topics = await window.mavis.listTopics(); } catch { host.appendChild(el('p', '', 'Could not load topics.')); const retry = el('button', 'mt-btn', 'Retry'); retry.onclick = () => MT.topics.render(host, initialSlug, opts); host.appendChild(retry); return; }
      topics = Array.isArray(topics) ? topics.filter(topic => MT.workspaceData.topicMatches(topic, opts.project)) : [];
      if (!Array.isArray(topics) || !topics.length) { host.appendChild(el('div', 'mt-empty', 'No topics indexed.')); return; }
      host.appendChild(el('div', 'mt-sub', topics.length + ' topics in the retrieval index'));

      const layout = el('div', 'mt-dl-layout');
      const rail = el('div', 'mt-dl-rail');
      const main = el('div', 'mt-dl-main');
      layout.appendChild(rail); layout.appendChild(main);
      host.appendChild(layout);

      let selected = (initialSlug && topics.some((t) => t.slug === initialSlug)) ? initialSlug : topics[0].slug;

      function showTopic(t) {
        main.innerHTML = '';
        const head = el('div', 'mt-topic-head');
        head.appendChild(el('div', 'mt-topic-title', t.slug));
        const meta = [];
        if (t.addendums && t.addendums.length) meta.push(t.addendums.length + ' addend' + (t.addendums.length === 1 ? 'um' : 'a'));
        if (meta.length) head.appendChild(el('span', 'mt-topic-meta', meta.join(' · ')));
        main.appendChild(head);

        const triggers = el('details', 'ws-topic-triggers'); triggers.append(el('summary', '', 'Recall keywords'), triggerChips(t.triggers)); main.appendChild(triggers);

        if (t.did) { main.appendChild(el('div', 'mt-sect-lab', 'What we learned')); const d = el('div', 'mt-topic-did-lead'); md(t.did, d); main.appendChild(d); }

        if (t.refs && t.refs.length) {
          main.appendChild(el('div', 'mt-sect-lab', 'References'));
          const refs = el('div', 'mt-topic-refs');
          t.refs.forEach((r) => refs.appendChild(renderRef(r)));
          main.appendChild(refs);
        }

        if (t.preempt) { main.appendChild(el('div', 'mt-sect-lab', 'Scope notes')); const c = el('div', 'mt-topic-callout'); md(t.preempt, c); main.appendChild(c); }

        if (t.addendums && t.addendums.length) {
          main.appendChild(el('div', 'mt-sect-lab', 'Updates'));
          t.addendums.forEach((a, i) => main.appendChild(addendumFold(a, i === t.addendums.length - 1)));
        }
        main.scrollTop = 0;
      }

      function paint(q) {
        rail.innerHTML = '';
        const ql = String(q || '').trim().toLowerCase();
        const filtered = topics.filter((t) => !ql || t.slug.toLowerCase().includes(ql) || String(t.triggers || '').toLowerCase().includes(ql) || String(t.did || '').toLowerCase().includes(ql));
        if (!filtered.length) { rail.appendChild(el('div', 'mt-empty', 'No matching topic')); return; }
        filtered.forEach((t) => {
          const item = el('div', 'mt-dl-date mt-topic-item' + (t.slug === selected ? ' active' : ''));
          item.setAttribute('role', 'button'); item.setAttribute('tabindex', '0');
          item.appendChild(el('div', 'mt-topic-slug', t.slug));
          if (t.did) item.appendChild(el('div', 'mt-topic-did', firstLine(t.did)));
          const open = () => { selected = t.slug; state.slug = selected; remembered.set(scope, state); showTopic(t); for (const c of rail.children) c.classList && c.classList.remove('active'); item.classList.add('active'); };
          item.addEventListener('click', open);
          item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
          rail.appendChild(item);
        });
      }

      input.addEventListener('input', () => { state.query = input.value; remembered.set(scope, state); paint(input.value); });
      paint(input.value);
      showTopic(topics.find((t) => t.slug === selected) || topics[0]);
    },
  };
})();
