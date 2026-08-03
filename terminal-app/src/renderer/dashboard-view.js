'use strict';

// MT.dashboard — the Steep landing dashboard (section 1 of the locked mockup).
// Light/editorial: serif greeting, 4 KPI tiles, a two-column "jump back in" /
// "specs in progress" row, then a recent-activity list. Rust is the only accent;
// exactly one Ink pill CTA (the first "Open"). All user text is set via textContent
// so odd project names / paths / headlines can never break the markup.
(function () {
  const MT = (window.MT = window.MT || {});

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function greetingWord() {
    const h = new Date().getHours();
    if (h < 5) return 'Good night';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function dateLine() {
    try {
      return new Date().toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long',
      });
    } catch {
      return '';
    }
  }

  // YYYY-MM-DD (or ISO) → "today" / "yesterday" / "Mon DD" / raw. Best-effort only.
  function relAccessed(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    try {
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    } catch {
      return String(s);
    }
  }

  // ---- KPI tiles ----
  function tile(num, label, warm) {
    const card = el('div', 'mt-card mt-tile' + (warm ? ' mt-card-warm' : ''));
    const n = el('div', 'mt-tile-num', String(num));
    if (warm) n.style.color = 'var(--color-rust)';
    card.appendChild(n);
    card.appendChild(el('div', 'mt-tile-label', label));
    return card;
  }

  function buildTiles(data) {
    const c = (data && data.counts) || {};
    const openSessions =
      (MT.session && typeof MT.session.count === 'function') ? MT.session.count() : 0;
    const tiles = el('div', 'mt-tiles');
    tiles.appendChild(tile(c.activeProjects || 0, 'active projects', false));
    tiles.appendChild(tile(openSessions || 0, 'open sessions', false));
    tiles.appendChild(tile(c.specsInProgress || 0, 'specs in progress', true));
    tiles.appendChild(tile(c.updates || 0, 'updates today', false));
    return tiles;
  }

  // ---- "Jump back in" card ----
  function buildRecent(recent) {
    const card = el('div', 'mt-card');
    card.style.padding = '18px';
    const head = el('div', 'mt-label', 'Jump back in');
    head.style.marginBottom = '12px';
    card.appendChild(head);

    if (!recent || !recent.length) {
      card.appendChild(el('div', 'mt-empty', 'No recent projects yet'));
      return card;
    }

    recent.forEach((r) => {
      const row = el('div', 'mt-row' + (r.dir ? ' mt-row-click' : ''));
      if (!r.dir) row.style.padding = '10px 0';

      if (r.dir) {
        const fire = () => {
          if (window.MT && typeof window.MT.openProject === 'function') {
            window.MT.openProject({ cwd: r.dir, label: r.name });
          }
        };
        row.title = 'Open ' + (r.name || 'project');
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.setAttribute('aria-label', 'Open ' + (r.name || 'project'));
        row.addEventListener('click', fire);
        row.addEventListener('keydown', (e) => { if (e.target !== row) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } });
      }

      const left = el('div');
      left.style.minWidth = '0';
      left.appendChild(el('div', 'mt-row-name', r.name || 'Untitled'));
      if (r.dir) left.appendChild(el('div', 'mt-row-sub', r.dir));
      row.appendChild(left);

      const right = el('div');
      right.style.cssText = 'display:flex;align-items:center;gap:8px;flex:none;margin-left:12px';
      const stamp = el('span', null, relAccessed(r.lastAccessed));
      stamp.style.color = 'var(--color-graphite)';
      stamp.style.fontSize = '13px';
      right.appendChild(stamp);
      if (r.slug && window.MT.icons) {
        const info = el('button', 'mt-info-btn');
        info.type = 'button';
        info.title = 'Details';
        info.setAttribute('aria-label', 'Details for ' + (r.name || 'project'));
        info.innerHTML = window.MT.icons.svg('info', 16);
        info.addEventListener('click', (e) => { e.stopPropagation(); window.MT.router.show('detail', r.slug); });
        right.appendChild(info);
      }
      row.appendChild(right);

      card.appendChild(row);
    });
    return card;
  }

  // ---- "Specs in progress" card ----
  function buildSpecs(specs) {
    const card = el('div', 'mt-card');
    card.style.padding = '18px';
    const head = el('div', 'mt-label', 'Specs in progress');
    head.style.marginBottom = '12px';
    card.appendChild(head);

    if (!specs || !specs.length) {
      card.appendChild(el('div', 'mt-empty', 'No specs in progress'));
      return card;
    }

    specs.forEach((s, i) => {
      const top = el('div');
      top.style.display = 'flex';
      top.style.justifyContent = 'space-between';
      top.style.alignItems = 'baseline';
      top.style.fontSize = '14px';
      if (i > 0) top.style.marginTop = '13px';

      const name = el('span', null, s.change || s.project || 'spec');
      name.style.fontWeight = '450';
      name.style.overflow = 'hidden';
      name.style.textOverflow = 'ellipsis';
      name.style.whiteSpace = 'nowrap';
      top.appendChild(name);

      const hasTotal = typeof s.total === 'number' && s.total > 0;
      const ratio = hasTotal ? `${s.completed || 0}/${s.total}` : '';
      const val = el('span', null, ratio);
      val.style.color = 'var(--color-graphite)';
      val.style.flex = 'none';
      val.style.marginLeft = '12px';
      top.appendChild(val);
      card.appendChild(top);

      const bar = el('div', 'mt-bar');
      bar.style.marginTop = '7px';
      const fill = el('span');
      const pct = hasTotal
        ? Math.max(0, Math.min(100, Math.round(((s.completed || 0) / s.total) * 100)))
        : 0;
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
    });
    return card;
  }

  // ---- charts ----
  // Hero: the pulse waveform (90-day activity). Then a 3-up row: radial year,
  // momentum rings, project constellation. Every datum is hover-inspectable.
  function buildPulse(data) {
    const card = el('div', 'mt-card mt-pulse-card');
    const head = el('div', 'mt-chart-head');
    head.appendChild(el('div', 'mt-label', 'Activity'));
    card.appendChild(head);
    if (MT.charts && MT.charts.pulse) {
      const p = MT.charts.pulse(data.activityByDay || [], { streak: (data.streak && data.streak.current) || 0 });
      head.appendChild(el('div', 'mt-chart-sub', (p.total || 0) + ' section' + (p.total === 1 ? '' : 's') + ' · last 90 days · hover to inspect'));
      card.appendChild(p.node);
    }
    return card;
  }

  function chartCard(title) {
    const card = el('div', 'mt-card mt-chart-card');
    const head = el('div', 'mt-chart-head');
    head.appendChild(el('div', 'mt-label', title));
    card.appendChild(head);
    return card;
  }

  function buildChartRow(data) {
    const row = el('div', 'mt-cols mt-cols-3 mt-cols-charts');
    if (!MT.charts) return row;

    const cYear = chartCard('Radial year');
    cYear.appendChild(MT.charts.radialYear(data.activityByDay || []).node);
    row.appendChild(cYear);

    const cRings = chartCard('Momentum');
    cRings.appendChild(MT.charts.rings({
      streak: data.streak || { current: 0, best: 0 },
      week: data.week || { current: 0, peak: 0 },
      active: (data.counts && data.counts.activeProjects) || 0,
      total: (data.counts && data.counts.totalProjects) || 0,
    }).node);
    row.appendChild(cRings);

    const cConst = chartCard('Constellation');
    cConst.appendChild(MT.charts.constellation(data.projectActivity || []).node);
    row.appendChild(cConst);

    return row;
  }

  // ---- "Recent activity" list ----
  function buildActivity(activity) {
    const wrap = el('div');
    wrap.style.marginTop = '26px';
    const head = el('div', 'mt-label', 'Recent activity');
    head.style.marginBottom = '12px';
    wrap.appendChild(head);

    const card = el('div', 'mt-card');
    card.style.padding = '18px';

    if (!activity || !activity.length) {
      card.appendChild(el('div', 'mt-empty', 'Nothing logged today'));
      wrap.appendChild(card);
      return wrap;
    }

    activity.forEach((a) => {
      const row = el('div', 'mt-row');
      row.style.padding = '10px 0';

      const left = el('div');
      left.style.minWidth = '0';
      const headline = el('div', 'mt-row-name', a.headline || a.project || '');
      headline.style.overflow = 'hidden';
      headline.style.textOverflow = 'ellipsis';
      headline.style.whiteSpace = 'nowrap';
      left.appendChild(headline);
      row.appendChild(left);

      const proj = el('span', null, a.project || '');
      proj.style.color = 'var(--color-graphite)';
      proj.style.fontSize = '13px';
      proj.style.flex = 'none';
      proj.style.marginLeft = '12px';
      row.appendChild(proj);

      card.appendChild(row);
    });
    wrap.appendChild(card);
    return wrap;
  }

  MT.dashboard = {
    async render(host) {
      host.innerHTML = '';

      // Two independent brain reads, in parallel, each failing soft on its own: the dashboard
      // payload and the identity facets that carry the user's name. Neither may take the other
      // down — a brain with no identity/ yet still renders a full dashboard, and vice versa.
      const [payload, facets] = await Promise.all([
        (async () => { try { return await window.mavis.getDashboardData(); } catch { return null; } })(),
        (async () => { try { return await window.mavis.identityFacets(); } catch { return null; } })(),
      ]);
      const data = payload || { counts: {}, recent: [], specs: [], activity: [], activityByDay: [], streak: { current: 0, best: 0 }, week: { current: 0, peak: 0 }, projectActivity: [] };

      // greeting (serif) + sub line.
      // The name is whatever the user put in their own identity/profile.md (brain-stats
      // getIdentityFacets → profile.name) — never a hardcoded handle, because this is the very
      // first thing anyone sees and greeting them by someone else's name is the worst possible
      // opener. A fresh clone has no profile yet, so fall back to the greeting ALONE (no comma,
      // no placeholder name): "Good morning" is neutral, "Good morning, there" is not.
      const who = (facets && facets.profile && facets.profile.name) || '';
      const greeting = el('div', 'mt-greeting', who ? greetingWord() + ', ' + who : greetingWord());
      host.appendChild(greeting);

      const touched = (data.recent && data.recent.length) || 0;
      const parts = [];
      const d = dateLine();
      if (d) parts.push(d);
      parts.push(
        touched === 1
          ? 'you have touched 1 project today'
          : `you have touched ${touched} projects today`
      );
      const sub = el('div', 'mt-sub', parts.join(' · '));
      host.appendChild(sub);

      // KPI tiles
      host.appendChild(buildTiles(data));

      // charts: pulse hero + radial-year / momentum / constellation row
      host.appendChild(buildPulse(data));
      host.appendChild(buildChartRow(data));

      // two-column row
      const cols = el('div', 'mt-cols');
      cols.appendChild(buildRecent(data.recent));
      cols.appendChild(buildSpecs(data.specs));
      host.appendChild(cols);

      // recent activity
      host.appendChild(buildActivity(data.activity));
    },
  };
})();
