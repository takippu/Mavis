'use strict';

// MT.journal — the brain shell: one Steep card with underline tabs
// [Character, Topics, Log]. Character is a compact one-screen hub (Mavis · MCP
// server slots · Inventory bags for Identity/Preferences/Rules · Skills) that
// drills down into sub-views (Preferences/Rules reuse the generic list browser;
// Identity gets a facet list+detail; MCP/Skill get a read-only detail). Topics
// reuses the generic list browser; Log embeds the daily-log view.
// Read-only, XSS-safe (createElement/textContent + MT.md only), token-themed.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const md = (text, host) => { if (MT.md) host.appendChild(MT.md.render(text, 'mt-md-tight')); else host.appendChild(el('div', null, text)); };

  const TAB_DEFS = [['character', 'Character'], ['topics', 'Topics'], ['log', 'Log']];
  const labelFor = (key) => { const t = TAB_DEFS.find((d) => d[0] === key); return t ? t[1] : key; };

  function isActive(e) { return String((e.frontmatter || {}).status || '').toLowerCase() !== 'superseded'; }
  function scopesOf(e) { const s = (e.frontmatter || {}).scope; return Array.isArray(s) ? s.filter(Boolean).map(String) : []; }
  function titleOf(e) { return String((e.frontmatter || {}).title || e.slug || 'Untitled'); }

  // generic body sections: prefer the backend's generic h2 capture, which listCategoryEntries
  // emits at the TOP level as `e.sections` ([{label,content}]) — tolerate a nested `body.sections`
  // too — then fall back to the legacy three-section {rule,why,how} shape so a pre-generalized
  // parseEntryFile keeps working. Empty-content sections are dropped. (Topics carry Did/Refs/
  // Pre-empt only here, so reading the wrong key blanks the whole topic body.)
  function sectionsOf(e) {
    const b = e.body || {};
    const generic = Array.isArray(e.sections) ? e.sections
      : Array.isArray(b.sections) ? b.sections
        : null;
    if (generic) {
      return generic
        .map((s) => ({ label: String((s && s.label) || ''), content: String((s && s.content) || '').trim() }))
        .filter((s) => s.content);
    }
    return [
      { label: 'Rule', content: String(b.rule || '').trim() },
      { label: 'Why', content: String(b.why || '').trim() },
      { label: 'How to apply', content: String(b.how || '').trim() },
    ].filter((s) => s.content);
  }

  // one-line summary: first sentence of the FIRST section, md-stripped (the detail panel still
  // renders full bodies through MT.md). Strip emphasis chars so the list preview reads cleanly.
  function summaryOf(e) {
    const secs = sectionsOf(e);
    let raw = String(secs.length ? secs[0].content : '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    raw = raw
      .replace(/\[\[([^\]]+)\]\]/g, '$1')        // [[slug]] → slug
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [text](url) → text (topic Did sentences often lead with a link)
      .replace(/[*`]/g, '')
      .trim();
    const m = raw.match(/^(.*?[.!?])(\s|$)/);
    return m ? m[1] : raw;
  }

  // a frontmatter link (string markdown-link / bare path-or-slug, or {label,url}) → a row
  function renderLink(link) {
    const div = el('div', 'mt-topic-ref');
    let text = '', url = '';
    if (link && typeof link === 'object') {
      url = String(link.url || link.href || '');
      text = String(link.label || link.title || link.text || url);
    } else {
      const s = String(link || '');
      const m = s.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m && MT.md) { MT.md.inline(s, div); return div; }
      text = s; url = s;
    }
    const route = url && MT.md && MT.md.linkRoute && MT.md.linkRoute(url);
    if (route) {
      const a = el('a', 'mt-md-link', text || url); a.setAttribute('role', 'link'); a.tabIndex = 0; a.title = url;
      a.addEventListener('click', (e) => { e.preventDefault(); route(); });
      a.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); route(); } });
      div.appendChild(a);
    } else div.textContent = text || url;
    return div;
  }

  // bumped on every render() — a brain-changed re-render (or a fast re-nav) starts a fresh render
  // while a prior render's async paint may still be mid-await; the paints check they're still the
  // current generation before touching their (possibly detached) host.
  let renderGen = 0;

  MT.journal = {
    async render(host) {
      const myGen = ++renderGen;
      host.innerHTML = '';
      host.appendChild(el('div', 'mt-page-title', 'Journal'));

      // preferences power the only live tab — load eagerly so the router's settle
      // promise reflects real content (the whole view re-renders on brain-changed).
      let entries = [];
      try { entries = await window.mavis.categoryEntries('preferences'); } catch { entries = []; }
      if (!Array.isArray(entries)) entries = [];

      // per-category nouns for copy, and a lazy entry cache (preferences seeded from the
      // eager load above so the Preferences bag + tab paint without a refetch).
      const NOUNS = {
        preferences: { one: 'preference', many: 'preferences', article: 'a' },
        topics: { one: 'topic', many: 'topics', article: 'a' },
        rules: { one: 'rule', many: 'rules', article: 'a' },
      };
      const entryCache = { preferences: entries };

      const card = el('div', 'mt-card mt-jrnl-card');
      const strip = el('div', 'mt-jtabs'); strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Journal sections');
      const body = el('div', 'mt-jbody'); body.setAttribute('role', 'tabpanel');
      card.appendChild(strip); card.appendChild(body);
      host.appendChild(card);

      let activeTab = 'character';
      const tabBtns = {};

      function selectTab(key) {
        activeTab = key;
        for (const k in tabBtns) { const on = k === key; tabBtns[k].classList.toggle('on', on); tabBtns[k].setAttribute('aria-selected', on ? 'true' : 'false'); tabBtns[k].tabIndex = on ? 0 : -1; }
        body.setAttribute('aria-label', labelFor(key));
        body.innerHTML = '';
        if (key === 'character') buildCharacter(body);
        else if (key === 'topics') buildBrowser(body, 'topics');
        else if (key === 'log') buildLog(body);
        else buildPlaceholder(body, labelFor(key));
      }

      TAB_DEFS.forEach(([key, label], idx) => {
        const b = el('button', 'mt-jtab' + (key === activeTab ? ' on' : '')); b.type = 'button'; b.textContent = label;
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', key === activeTab ? 'true' : 'false'); b.tabIndex = key === activeTab ? 0 : -1;
        b.addEventListener('click', () => selectTab(key));
        b.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); const n = TAB_DEFS[(idx + 1) % TAB_DEFS.length][0]; selectTab(n); tabBtns[n].focus(); }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); const n = TAB_DEFS[(idx - 1 + TAB_DEFS.length) % TAB_DEFS.length][0]; selectTab(n); tabBtns[n].focus(); }
        });
        tabBtns[key] = b; strip.appendChild(b);
      });

      function buildPlaceholder(hostEl, label) {
        hostEl.innerHTML = '';
        const ph = el('div', 'mt-jrnl-ph');
        const ico = el('span', 'mt-jrnl-ph-ico'); if (MT.icons) ico.innerHTML = MT.icons.svg('journal', 28); ph.appendChild(ico);
        ph.appendChild(el('div', 'mt-jrnl-ph-title', label));
        ph.appendChild(el('div', null, 'Arrives as the brain refactor rolls out.'));
        hostEl.appendChild(ph);
      }

      // ---- generic list browser (Preferences, Rules, Topics) ----
      // Renders any list category: 3-way Remembered/All/Forgotten toggle + search + a
      // list/detail split. Scope chips appear only when entries actually carry scopes
      // (topics have none → the scope row is hidden). Detail iterates generic `sections`.
      async function buildBrowser(hostEl, category) {
        const noun = NOUNS[category] || { one: 'entry', many: 'entries', article: 'an' };
        let rows = entryCache[category];
        if (!rows) {
          hostEl.innerHTML = '';
          hostEl.appendChild(el('div', 'mt-empty', 'Loading…'));
          try { rows = await window.mavis.categoryEntries(category); } catch { rows = []; }
          if (!Array.isArray(rows)) rows = [];
          entryCache[category] = rows;
          if (myGen !== renderGen || activeTab !== category) return;   // superseded render or switched away mid-await → don't paint stale
        }
        hostEl.innerHTML = '';
        if (!rows.length) { hostEl.appendChild(el('div', 'mt-empty', 'No ' + noun.many + ' recorded yet.')); return; }

        let scopeSel = '__all__';
        let memMode = 'remembered'; // 'remembered' (active) | 'all' | 'forgotten' (superseded)
        let query = '';
        let selectedSlug = null;
        // Phase 2.4 editing — preferences + rules only (the writer builds Rule/Why/How bodies).
        const EDITABLE = !!(MT.entryEditor && MT.entryEditor.EDITABLE.indexOf(category) >= 0);
        const reload = () => { entryCache[category] = null; buildBrowser(hostEl, category); };

        // distinct scopes across ACTIVE entries = the "scope lines" (empty for topics)
        const activeScopes = [];
        const seen = new Set();
        rows.filter(isActive).forEach((e) => scopesOf(e).forEach((s) => { if (!seen.has(s)) { seen.add(s); activeScopes.push(s); } }));
        activeScopes.sort((a, b) => a.localeCompare(b));

        const pool = () => memMode === 'all' ? rows
          : memMode === 'forgotten' ? rows.filter((e) => !isActive(e))
          : rows.filter(isActive);

        function matchesQuery(e) {
          if (!query) return true;
          const q = query.toLowerCase();
          const fm = e.frontmatter || {};
          const secText = sectionsOf(e).map((s) => s.content).join(' ');
          return [fm.title, secText, scopesOf(e).join(' '), summaryOf(e)]
            .some((v) => String(v || '').toLowerCase().includes(q));
        }
        function visible() {
          return pool().filter((e) => {
            if (scopeSel !== '__all__' && !scopesOf(e).includes(scopeSel)) return false;
            return matchesQuery(e);
          });
        }

        // toolbar: scope chips + count, "Show forgotten" switch, search
        const toolbar = el('div', 'mt-jrnl-toolbar');
        const filters = el('div', 'mt-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Filter by scope');
        // memory-mode segmented control [Remembered | All | Forgotten] (default Remembered)
        const MEM_MODES = [['remembered', 'Remembered'], ['all', 'All'], ['forgotten', 'Forgotten']];
        const seg = el('div', 'mt-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Filter memories by status');
        const segBtns = {};
        MEM_MODES.forEach(([key, label]) => {
          const b = el('button', 'mt-seg-btn' + (memMode === key ? ' active' : ''), label); b.type = 'button';
          b.setAttribute('aria-pressed', memMode === key ? 'true' : 'false');
          b.addEventListener('click', () => {
            if (memMode === key) return;
            memMode = key;
            for (const k in segBtns) { const on = k === key; segBtns[k].classList.toggle('active', on); segBtns[k].setAttribute('aria-pressed', on ? 'true' : 'false'); }
            buildFilters(); relist();
          });
          segBtns[key] = b; seg.appendChild(b);
        });
        const search = el('div', 'mt-search');
        const sico = el('span'); if (MT.icons) sico.innerHTML = MT.icons.svg('search', 16); search.appendChild(sico);
        const input = el('input'); input.type = 'search'; input.placeholder = 'Search ' + noun.many + '…'; input.setAttribute('aria-label', 'Search ' + noun.many);
        search.appendChild(input);
        input.addEventListener('input', () => { query = input.value; relist(); });
        if (activeScopes.length) toolbar.appendChild(filters);   // no scopes (topics) → no scope row
        toolbar.appendChild(seg); toolbar.appendChild(search);
        if (EDITABLE) {
          const addBtn = el('button', 'mt-pill mt-jrnl-add'); addBtn.type = 'button';
          addBtn.innerHTML = (MT.icons ? MT.icons.svg('plus', 15) : '') + '<span>Add</span>';
          addBtn.addEventListener('click', () => MT.entryEditor.open({ mode: 'add', category, onSaved: reload }));
          toolbar.appendChild(addBtn);
        }
        hostEl.appendChild(toolbar);

        const split = el('div', 'mt-jrnl-split');
        const list = el('div', 'mt-jrnl-list');
        const detail = el('div', 'mt-jrnl-detail');
        split.appendChild(list); split.appendChild(detail);
        hostEl.appendChild(split);

        function buildFilters() {
          filters.innerHTML = '';
          if (!activeScopes.length) return;   // no scopes (e.g. topics) → no scope row; scopeSel stays '__all__'
          const p = pool();
          const mk = (key, label, count) => {
            const b = el('button', 'mt-filter' + (scopeSel === key ? ' active' : '')); b.type = 'button';
            b.appendChild(document.createTextNode(label));
            if (count != null) b.appendChild(el('span', 'mt-filter-count', String(count)));
            b.setAttribute('aria-pressed', scopeSel === key ? 'true' : 'false');
            b.addEventListener('click', () => { scopeSel = key; buildFilters(); relist(); });
            filters.appendChild(b);
          };
          mk('__all__', 'All', p.length);
          activeScopes.forEach((s) => mk(s, s, p.filter((e) => scopesOf(e).includes(s)).length));
        }

        function showDetail(e) {
          detail.innerHTML = '';
          if (!e) { detail.appendChild(el('div', 'mt-empty', 'Select ' + noun.article + ' ' + noun.one + ' to read it.')); return; }
          const fm = e.frontmatter || {};
          detail.appendChild(el('div', 'mt-jrnl-detail-title', titleOf(e)));

          const meta = el('div', 'mt-detail-meta');
          const scs = scopesOf(e);
          if (scs.length) meta.appendChild(el('span', null, 'Scope: ' + scs.join(', ')));
          const act = isActive(e);
          const stat = el('span', 'mt-jrnl-meta-status');
          stat.appendChild(el('span', 'mt-status-dot' + (act ? ' s-active' : '')));
          stat.appendChild(el('span', null, act ? 'active' : 'superseded'));
          meta.appendChild(stat);
          if (fm.since) meta.appendChild(el('span', null, 'Since ' + fm.since));
          if (fm.updated && fm.updated !== fm.since) meta.appendChild(el('span', null, 'Updated ' + fm.updated));
          detail.appendChild(meta);

          const section = (lab, txt) => { const t = String(txt || '').trim(); if (!t) return; detail.appendChild(el('div', 'mt-sect-lab', lab)); md(t, detail); };
          sectionsOf(e).forEach((s) => section(s.label, s.content));

          const links = Array.isArray(fm.links) ? fm.links.filter(Boolean) : [];
          if (links.length) {
            detail.appendChild(el('div', 'mt-sect-lab', 'Links'));
            const refs = el('div', 'mt-topic-refs mt-jrnl-detail-links');
            links.forEach((l) => refs.appendChild(renderLink(l)));
            detail.appendChild(refs);
          }

          if (EDITABLE) {
            const actions = el('div', 'mt-jrnl-detail-actions');
            const editB = el('button', 'mt-pill mt-pill-ghost'); editB.type = 'button';
            editB.innerHTML = (MT.icons ? MT.icons.svg('pencil', 14) : '') + '<span>Edit</span>';
            editB.addEventListener('click', () => MT.entryEditor.open({ mode: 'edit', category, entry: e, onSaved: reload }));
            actions.appendChild(editB);
            if (isActive(e)) {
              const supB = el('button', 'mt-pill mt-pill-ghost', 'Supersede'); supB.type = 'button';
              const activeSlugs = rows.filter(isActive).map((x) => x.slug);
              supB.addEventListener('click', () => MT.entryEditor.open({ mode: 'supersede', category, entry: e, activeSlugs, onSaved: reload }));
              actions.appendChild(supB);
            }
            detail.appendChild(actions);
          }
        }

        function renderRow(e) {
          const row = el('div', 'mt-jrnl-entry' + (isActive(e) ? '' : ' superseded') + (e.slug === selectedSlug ? ' sel' : ''));
          row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0');
          const act = isActive(e);
          row.setAttribute('aria-label', titleOf(e) + ' — ' + (act ? 'active' : 'superseded'));
          const top = el('div', 'mt-jrnl-entry-top');
          top.appendChild(el('div', 'mt-jrnl-entry-title', titleOf(e)));
          top.appendChild(el('span', 'mt-status-dot' + (act ? ' s-active' : '')));
          row.appendChild(top);
          const sum = summaryOf(e);
          if (sum) row.appendChild(el('div', 'mt-jrnl-entry-sum', sum));
          const scs = scopesOf(e);
          if (scs.length) { const chips = el('div', 'mt-dl-projs'); scs.slice(0, 6).forEach((s) => chips.appendChild(el('span', 'mt-dl-proj', s))); row.appendChild(chips); }
          const open = () => { selectedSlug = e.slug; for (const c of list.children) c.classList && c.classList.remove('sel'); row.classList.add('sel'); showDetail(e); };
          row.addEventListener('click', open);
          row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
          return row;
        }

        function relist() {
          list.innerHTML = '';
          const vis = visible();
          if (!vis.length) { list.appendChild(el('div', 'mt-empty', 'No ' + noun.many + ' match.')); showDetail(null); return; }
          if (!vis.some((e) => e.slug === selectedSlug)) selectedSlug = vis[0].slug;
          vis.forEach((e) => list.appendChild(renderRow(e)));
          showDetail(vis.find((e) => e.slug === selectedSlug) || vis[0]);
        }

        buildFilters();
        relist();
      }

      // ---- CHARACTER tab → compact one-screen hub + drill-down sub-router ----
      // The hub (sub === null) fits one screen: Mavis card (left) · MCP server slots +
      // compact Inventory bags (right) · Skills row (below), with NO detail panel.
      // Clicking a bag / MCP slot / skill sets `sub` and repaints into a sub-view that
      // opens with a "Character › <label>" breadcrumb. All read-only; a not-yet-wired
      // backend degrades to empty grids, never throws.
      async function buildCharacter(hostEl) {
        hostEl.innerHTML = '';
        hostEl.appendChild(el('div', 'mt-empty', 'Loading…'));

        // mcpServers()/skills() are the canonical bridge names; tolerate list* aliases and
        // an unbuilt data layer (missing fn → caught → []). identityFacets() + the rules
        // category load in parallel; preferences reuse the eager entryCache from render().
        const callFirst = async (names) => {
          for (const n of names) {
            const fn = window.mavis && window.mavis[n];
            if (typeof fn === 'function') { try { const r = await fn(); return Array.isArray(r) ? r : []; } catch { return []; } }
          }
          return [];
        };
        const [facetsRaw, servers, skills, ruleRows] = await Promise.all([
          (async () => { try { return await window.mavis.identityFacets(); } catch { return {}; } })(),
          callFirst(['mcpServers', 'listMcpServers']),
          callFirst(['skills', 'listSkills']),
          (async () => {
            if (Array.isArray(entryCache.rules)) return entryCache.rules;
            let r; try { r = await window.mavis.categoryEntries('rules'); } catch { r = []; }
            if (!Array.isArray(r)) r = [];
            entryCache.rules = r; return r;
          })(),
        ]);
        if (myGen !== renderGen || activeTab !== 'character') return;   // superseded render or switched away mid-await → don't paint stale

        const data = facetsRaw && typeof facetsRaw === 'object' ? facetsRaw : {};
        const prefRows = Array.isArray(entryCache.preferences) ? entryCache.preferences : [];
        const profile = data.profile || {};
        const userName = String(profile.name || data.name || '').trim();          // the USER (whom Mavis serves)
        const pronouns = String(profile.pronouns || data.pronouns || '').trim();

        // identity facets → the Identity bag + the Identity sub-view (reuse the old normalization)
        const normFacet = (f, i, col) => {
          if (f && typeof f === 'object') {
            return { key: 'facet:' + col + ':' + String(f.key || f.slug || f.id || i), col,
              label: String(f.label || f.title || f.name || ('Facet ' + (i + 1))),
              text: String(f.text || f.body || f.detail || f.rule || '') };
          }
          return { key: 'facet:' + col + ':' + i, col, label: String(f || ('Facet ' + (i + 1))), text: '' };
        };
        const personality = (Array.isArray(data.personality) ? data.personality : []).map((f, i) => normFacet(f, i, 'personality'));
        const communication = (Array.isArray(data.communication) ? data.communication : []).map((f, i) => normFacet(f, i, 'communication'));
        const coreFacets = (Array.isArray(data.coreOaths) ? data.coreOaths : []).map((f, i) => normFacet(f, i, 'core'));
        const facets = personality.concat(communication, coreFacets);
        const colLabel = (col) => col === 'personality' ? 'Personality' : col === 'communication' ? 'Communication' : 'Principles';

        const prefActive = prefRows.filter(isActive);
        const ruleActive = (Array.isArray(ruleRows) ? ruleRows : []).filter(isActive);

        // local drill-down state: null = hub, else { type, server?, skill? }
        let sub = null;

        // breadcrumb: "Character" (→ hub) › <current label>
        function crumbRow(label) {
          const row = el('div', 'mt-hub-crumb');
          const back = el('button', 'mt-hub-crumb-link'); back.type = 'button'; back.textContent = 'Character';
          back.setAttribute('aria-label', 'Back to Character');
          back.addEventListener('click', () => { sub = null; paint(); });
          row.appendChild(back);
          row.appendChild(el('span', 'mt-hub-crumb-sep', '›'));
          row.appendChild(el('span', 'mt-hub-crumb-cur', label));
          return row;
        }

        // Identity sub-view: a list/detail split; click a facet → its text via MT.md; auto-select first
        function renderIdentity(innerHost) {
          if (!facets.length) { innerHost.appendChild(el('div', 'mt-empty', 'No identity facets recorded yet.')); return; }
          const split = el('div', 'mt-jrnl-split');
          const list = el('div', 'mt-jrnl-list');
          const detail = el('div', 'mt-jrnl-detail');
          split.appendChild(list); split.appendChild(detail);
          innerHost.appendChild(split);
          const btns = [];
          function showFacet(f, btn) {
            btns.forEach((b) => b.classList.remove('sel'));
            if (btn) btn.classList.add('sel');
            detail.innerHTML = '';
            detail.appendChild(el('div', 'mt-jrnl-detail-title', f.label));
            const meta = el('div', 'mt-detail-meta');
            meta.appendChild(el('span', null, colLabel(f.col)));
            detail.appendChild(meta);
            if (f.text.trim()) md(f.text, detail);
            else detail.appendChild(el('div', 'mt-empty', 'No description recorded.'));
          }
          let first = null;
          [['Personality', personality], ['Communication', communication], ['Principles', coreFacets]].forEach(([lab, arr]) => {
            if (!arr.length) return;
            list.appendChild(el('div', 'mt-sect-lab', lab));
            arr.forEach((f) => {
              const r = el('button', 'mt-hub-facet'); r.type = 'button'; r.textContent = f.label;
              r.addEventListener('click', () => showFacet(f, r));
              btns.push(r);
              if (!first) first = { f, r };
              list.appendChild(r);
            });
          });
          if (first) showFacet(first.f, first.r);
        }

        // MCP sub-view: read-only detail with name + scope + a one-line note (no tokens/args read)
        function renderMcp(innerHost, s) {
          const detail = el('div', 'mt-jrnl-detail');
          detail.appendChild(el('div', 'mt-jrnl-detail-title', String(s.name || 'Server')));
          const meta = el('div', 'mt-detail-meta');
          const scope = s.scope || s.source;                     // data layer returns `source` ('user' | 'project')
          const scopeText = scope === 'user' ? 'user scope' : scope === 'project' ? 'project scope' : (scope ? String(scope) : '');
          if (scopeText) meta.appendChild(el('span', null, scopeText));
          meta.appendChild(el('span', null, 'read-only'));
          detail.appendChild(meta);
          detail.appendChild(el('div', 'mt-empty', 'Connected MCP server. Mavis reads its tools at runtime; no tokens or arguments are stored here.'));
          innerHost.appendChild(detail);
        }

        // Skill sub-view: read-only detail with name + description via MT.md
        function renderSkill(innerHost, sk) {
          const detail = el('div', 'mt-jrnl-detail');
          detail.appendChild(el('div', 'mt-jrnl-detail-title', String(sk.name || sk.slug || 'Skill')));
          const meta = el('div', 'mt-detail-meta');
          meta.appendChild(el('span', null, 'Skill'));
          detail.appendChild(meta);
          const desc = String(sk.description || '').trim();
          if (desc) md(desc, detail);
          else detail.appendChild(el('div', 'mt-empty', 'No description recorded.'));
          innerHost.appendChild(detail);
        }

        // ---- the hub (sub === null): one screen, no detail panel ----
        function renderHub() {
          const wrap = el('div', 'mt-hub');

          // LEFT — Mavis card (matches the short right column via align-items: stretch)
          const me = el('div', 'mt-hub-me');
          const portrait = el('img', 'mt-char-portrait'); portrait.src = './assets/mavis-logo.png'; portrait.alt = ''; portrait.setAttribute('aria-hidden', 'true');
          me.appendChild(portrait);
          me.appendChild(el('div', 'mt-char-name', 'Mavis'));
          const subBits = [];
          if (userName) subBits.push('serves ' + userName);
          if (pronouns) subBits.push(pronouns);
          me.appendChild(el('div', 'mt-char-class', subBits.length ? subBits.join(' · ') : 'your collaborator'));
          wrap.appendChild(me);

          // RIGHT — panes (MCP slots + Inventory bags), then Skills below
          const right = el('div', 'mt-hub-right');
          const panes = el('div', 'mt-hub-panes');

          // MCP servers slot grid (compact tiles; drill into a read-only detail)
          const mcpCol = el('div', 'mt-hub-mcp');
          mcpCol.appendChild(el('div', 'mt-sect-lab', 'MCP Servers'));
          const grid = el('div', 'mt-hub-mcp-grid');
          const makeSlot = (s) => {
            const b = el('button', 'mt-hub-slot'); b.type = 'button';
            b.setAttribute('aria-label', 'MCP server ' + s.name);
            const ico = el('span', 'mt-hub-slot-ico'); if (MT.icons) ico.innerHTML = MT.icons.svg('server', 18); b.appendChild(ico);
            b.appendChild(el('span', 'mt-hub-slot-name', String(s.name || 'server')));
            b.addEventListener('click', () => { sub = { type: 'mcp', server: s }; paint(); });
            return b;
          };
          if (!servers.length) {
            grid.appendChild(el('div', 'mt-hub-empty-note', 'None connected'));
          } else {
            servers.forEach((s) => grid.appendChild(makeSlot(s)));
            const minSlots = Math.max(4, Math.ceil(servers.length / 2) * 2);
            for (let i = servers.length; i < minSlots; i++) {
              const eSlot = el('div', 'mt-hub-slot empty'); eSlot.setAttribute('aria-hidden', 'true'); grid.appendChild(eSlot);
            }
          }
          mcpCol.appendChild(grid);
          panes.appendChild(mcpCol);

          // Inventory bags — compact clickable buttons (whole bag is the button)
          const bagsCol = el('div', 'mt-hub-inv');
          bagsCol.appendChild(el('div', 'mt-sect-lab', 'Inventory'));
          const bags = el('div', 'mt-hub-bags');
          const makeBag = (label, iconName, count, onOpen) => {
            const b = el('button', 'mt-hub-bag'); b.type = 'button'; b.setAttribute('aria-label', 'Open ' + label);
            const bi = el('span', 'mt-hub-bag-ico'); if (MT.icons) bi.innerHTML = MT.icons.svg(iconName, 18); b.appendChild(bi);
            b.appendChild(el('span', 'mt-hub-bag-lab', label));
            b.appendChild(el('span', 'mt-hub-bag-ct', String(count)));
            b.appendChild(el('span', 'mt-hub-bag-chev', '›'));
            b.addEventListener('click', onOpen);
            return b;
          };
          bags.appendChild(makeBag('Identity', 'user', facets.length, () => { sub = { type: 'identity' }; paint(); }));
          bags.appendChild(makeBag('Preferences', 'list', prefActive.length, () => { sub = { type: 'preferences' }; paint(); }));
          bags.appendChild(makeBag('Rules', 'checkSquare', ruleActive.length, () => { sub = { type: 'rules' }; paint(); }));
          bagsCol.appendChild(bags);
          panes.appendChild(bagsCol);
          right.appendChild(panes);

          // Skills row (compact tiles; drill into a read-only detail)
          const skillsBox = el('div', 'mt-hub-skills');
          skillsBox.appendChild(el('div', 'mt-sect-lab', 'Skills'));
          const skRow = el('div', 'mt-hub-skill-row');
          if (!skills.length) {
            skRow.appendChild(el('div', 'mt-hub-skill empty', 'No skills'));
          } else {
            skills.forEach((sk) => {
              const b = el('button', 'mt-hub-skill'); b.type = 'button';
              b.setAttribute('aria-label', 'Skill ' + String(sk.name || sk.slug || ''));
              const ico = el('span', 'mt-hub-skill-ico'); if (MT.icons) ico.innerHTML = MT.icons.svg('sparkles', 16); b.appendChild(ico);
              b.appendChild(el('span', 'mt-hub-skill-name', String(sk.name || sk.slug || 'Skill')));
              b.addEventListener('click', () => { sub = { type: 'skill', skill: sk }; paint(); });
              skRow.appendChild(b);
            });
          }
          skillsBox.appendChild(skRow);
          right.appendChild(skillsBox);
          wrap.appendChild(right);
          hostEl.appendChild(wrap);
        }

        // paint the hub or the active sub-view
        function paint() {
          hostEl.innerHTML = '';
          if (!sub) { renderHub(); return; }
          let label = '';
          if (sub.type === 'preferences') label = 'Preferences';
          else if (sub.type === 'rules') label = 'Rules';
          else if (sub.type === 'identity') label = 'Identity';
          else if (sub.type === 'mcp') label = String(sub.server.name || 'Server');
          else if (sub.type === 'skill') label = String(sub.skill.name || sub.skill.slug || 'Skill');
          hostEl.appendChild(crumbRow(label));
          const innerHost = el('div', 'mt-hub-sub');
          hostEl.appendChild(innerHost);
          if (sub.type === 'preferences') buildBrowser(innerHost, 'preferences');
          else if (sub.type === 'rules') buildBrowser(innerHost, 'rules');
          else if (sub.type === 'identity') renderIdentity(innerHost);
          else if (sub.type === 'mcp') renderMcp(innerHost, sub.server);
          else if (sub.type === 'skill') renderSkill(innerHost, sub.skill);
        }

        paint();
      }

      // ---- LOG tab (embed the existing daily-log browser; drop its own page title) ----
      function buildLog(hostEl) {
        hostEl.innerHTML = '';
        if (!MT.dailyLog || typeof MT.dailyLog.render !== 'function') { buildPlaceholder(hostEl, 'Log'); return; }
        const p = MT.dailyLog.render(hostEl);            // clears host + appends its page title synchronously
        const dup = hostEl.querySelector('.mt-page-title'); // suppress the duplicate "Daily log" title
        if (dup) dup.remove();
        return p;
      }

      selectTab(activeTab);
    },
  };
})();
