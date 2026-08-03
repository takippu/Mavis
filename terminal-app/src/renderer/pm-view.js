'use strict';

// MT.pm — the optional Project Board view: a read-only per-project Kanban (To Do /
// Doing / Done) mirroring the remote board's own layout — pick a project, see ALL
// its tasks. An "Only mine" toggle filters to the token's user. Card → in-app detail
// sheet. Only mounted when the integration is switched on (see app.js mountPmFeature).
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

  const COLUMNS = [
    { key: 'todo', label: 'To Do' },
    { key: 'doing', label: 'Doing' },
    { key: 'done', label: 'Done' },
    { key: 'other', label: 'Other' },
  ];

  // persisted across view switches so you return to the same board.
  // taskSeq is the shared sequence guard (MT.async.seq) — module-level (not per-render)
  // so it strictly increases even when the whole view re-renders mid-load, keeping the
  // stale-guard sound across a project switch / "Only mine" toggle / re-render.
  let selectedProjectId = null;
  let mineOnly = false;
  const taskSeq = MT.async.seq();

  function infoCard(title, body) {
    const c = el('div', 'mt-card');
    c.style.cssText = 'padding:24px;margin-top:16px';
    c.appendChild(el('div', 'mt-row-name', title));
    c.appendChild(el('div', 'mt-row-sub', body));
    return c;
  }

  function taskCard(it) {
    const card = el('div', 'mt-card mt-kan-card');
    const top = el('div', 'mt-kan-card-top');
    top.appendChild(el('div', 'mt-kan-card-title', it.title));
    top.appendChild(el('span', 'mt-type-pill', it.code || 'task'));
    card.appendChild(top);
    const subBits = [it.subcategory || it.category, it.phase].filter(Boolean);
    if (subBits.length) card.appendChild(el('div', 'mt-row-sub', subBits.join(' · ')));
    if (it.assignee) card.appendChild(el('div', 'mt-kan-assignee', it.assignee));

    const open = () => { if (MT.pmTask && MT.pmTask.open) MT.pmTask.open(it); };
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', 'Open task ' + (it.code ? it.code + ' — ' : '') + it.title);
    card.title = 'Open task details';
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.target !== card) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return card;
  }

  function column(col, items) {
    const c = el('div', 'mt-kan-col');
    const head = el('div', 'mt-kan-head');
    head.appendChild(el('span', 'mt-kan-title', col.label));
    head.appendChild(el('span', 'mt-kan-count', String(items.length)));
    c.appendChild(head);
    const body = el('div', 'mt-kan-body');
    if (!items.length) body.appendChild(el('div', 'mt-kan-empty', 'Nothing here'));
    else items.forEach((it) => body.appendChild(taskCard(it)));
    c.appendChild(body);
    return c;
  }

  function boardSkeleton(container) {
    const board = el('div', 'mt-kanban');
    board.setAttribute('aria-hidden', 'true');
    const bar = (w, h, mt) => (MT.skeleton ? MT.skeleton.bar(w, h, mt) : el('div'));
    for (let c = 0; c < 3; c++) {
      const colEl = el('div', 'mt-kan-col');
      const head = el('div', 'mt-kan-head'); head.appendChild(bar('40%', '12px')); colEl.appendChild(head);
      const body = el('div', 'mt-kan-body');
      const n = c === 1 ? 4 : 5;
      for (let i = 0; i < n; i++) {
        const card = el('div', 'mt-card mt-skel-card'); card.style.padding = '13px 15px';
        card.appendChild(bar('80%', '13px')); card.appendChild(bar('55%', '10px', '9px'));
        body.appendChild(card);
      }
      colEl.appendChild(body);
      board.appendChild(colEl);
    }
    container.appendChild(board);
  }

  function renderBoard(container, items) {
    const byStatus = {};
    items.forEach((it) => { (byStatus[it.status] = byStatus[it.status] || []).push(it); });
    const board = el('div', 'mt-kanban');
    COLUMNS.forEach((col) => {
      const arr = byStatus[col.key] || [];
      if (col.key === 'other' && !arr.length) return;
      board.appendChild(column(col, arr));
    });
    container.appendChild(board);
  }

  MT.pm = {
    async render(host) {
      host.innerHTML = '';
      host.appendChild(el('div', 'mt-page-title', 'Project Manager'));

      let res;
      try { res = await window.mavis.pmProjects(); } catch { res = { ok: false, reason: 'network' }; }

      if (!res || !res.ok) {
        if (res && res.reason === 'no-token') {
          host.appendChild(infoCard('Connect your project board', 'Add your board API token in Settings to see the project boards.'));
          return;
        }
        const c = infoCard('Couldn’t load PM', res && res.reason === 'unauthorized' ? 'Token rejected — update it in Settings.' : 'Network error reaching the PM API.');
        const retry = el('button', 'mt-pill', 'Retry');
        retry.style.marginTop = '12px';
        retry.addEventListener('click', () => MT.pm.render(host));
        c.appendChild(retry);
        host.appendChild(c);
        return;
      }

      const me = res.me || {};
      const projects = (Array.isArray(res.projects) ? res.projects : [])
        .slice()
        .sort((a, b) => (b.taskCount || 0) - (a.taskCount || 0));
      if (!projects.length) { host.appendChild(el('div', 'mt-empty', 'No projects visible to your token.')); return; }

      if (me.name) host.appendChild(el('div', 'mt-sub', me.name + ' · ' + projects.length + ' project' + (projects.length === 1 ? '' : 's')));

      // resolve the selected project (persisted; else the busiest board)
      if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) selectedProjectId = projects[0].id;

      // toolbar: project picker (left) + "only mine" switch (right)
      const toolbar = el('div', 'mt-pm-toolbar');
      const pickers = el('div', 'mt-pm-pickers');
      const chips = {};
      projects.forEach((p) => {
        const b = el('button', 'mt-filter' + (p.id === selectedProjectId ? ' active' : ''));
        b.type = 'button';
        b.setAttribute('aria-pressed', p.id === selectedProjectId ? 'true' : 'false');
        b.appendChild(document.createTextNode(p.name));
        b.appendChild(el('span', 'mt-pm-count', ' ' + (p.taskCount || 0)));
        b.addEventListener('click', () => {
          if (selectedProjectId === p.id) return;
          selectedProjectId = p.id;
          for (const k in chips) { const on = k === p.id; chips[k].classList.toggle('active', on); chips[k].setAttribute('aria-pressed', on ? 'true' : 'false'); }
          load();
        });
        chips[p.id] = b;
        pickers.appendChild(b);
      });
      toolbar.appendChild(pickers);

      // "Only mine" only works when we resolved a user id to filter by; without
      // one the filter would silently no-op, so don't offer the toggle at all.
      if (me.userId) {
        const toggle = el('button', 'mt-switch' + (mineOnly ? ' on' : ''));
        toggle.type = 'button';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', mineOnly ? 'true' : 'false');
        // the visible "Only mine" text is the accessible name — no aria-label override
        toggle.innerHTML = '<span class="mt-switch-track"><span class="mt-switch-thumb"></span></span>';
        toggle.appendChild(el('span', 'mt-switch-label', 'Only mine'));
        toggle.addEventListener('click', () => {
          mineOnly = !mineOnly;
          toggle.classList.toggle('on', mineOnly);
          toggle.setAttribute('aria-checked', mineOnly ? 'true' : 'false');
          load();
        });
        toolbar.appendChild(toggle);
      } else {
        mineOnly = false; // can't filter by me without a user id
      }
      host.appendChild(toolbar);

      const container = el('div', 'mt-kanban-wrap');
      host.appendChild(container);

      async function load() {
        const my = taskSeq.begin();
        const pid = selectedProjectId; // commit to the values at invocation time,
        const mine = mineOnly;          // so an await-gap re-render can't shift them
        container.innerHTML = '';
        boardSkeleton(container);
        let r;
        try { r = await window.mavis.pmProjectTasks({ projectId: pid, assigneeId: mine && me.userId ? me.userId : undefined }); }
        catch { r = { ok: false, reason: 'network' }; }
        if (!taskSeq.isCurrent(my)) return; // a newer project/toggle change superseded this
        container.innerHTML = '';
        if (!r || !r.ok) {
          const c = infoCard('Couldn’t load tasks', r && r.reason === 'unauthorized' ? 'Token rejected — update it in Settings.' : 'Network error reaching the PM API.');
          const retry = el('button', 'mt-pill', 'Retry');
          retry.style.marginTop = '12px';
          retry.addEventListener('click', load);
          c.appendChild(retry);
          container.appendChild(c);
          return;
        }
        const items = r.items || [];
        // per-project task summaries carry no project name — stamp the selected
        // project's so the detail sheet (and "Start work") knows which project it is
        const proj = projects.find((p) => p.id === pid);
        if (proj && proj.name) items.forEach((it) => { if (it && !it.project) it.project = proj.name; });
        if (!items.length) { container.appendChild(el('div', 'mt-empty', mine ? 'No tasks assigned to you in this project.' : 'No tasks in this project yet.')); return; }
        renderBoard(container, items);
      }
      load();
    },
  };
})();
