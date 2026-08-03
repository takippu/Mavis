'use strict';

// App shell: title bar (frameless chrome), sidebar nav, view router. Orchestrates
// the MT modules (icons, session, dashboard, projects, palette, settings). Loaded last.
(function () {
  const MT = (window.MT = window.MT || {});
  const $ = (sel) => document.querySelector(sel);
  const icon = (name, size) => (MT.icons ? MT.icons.svg(name, size) : '');
  let viewHost, sessionsHost, current = 'dashboard', currentSlug = null;
  let renderSeq = 0;
  let sidebarCollapsed = false, sidebarToggleBtn = null;
  const navItems = {};
  // Per-session harness picker (titlebar). `harnessPicker` is the dropdown element itself — built
  // eagerly in buildTitlebar() but left hidden until initHarnessPicker() (called from the boot IIFE
  // below, after settings + harnessAvailable() land) confirms there is an actual choice to make.
  // `selectedHarness` is the id the NEXT new session should use; null means "no override — let
  // main default to cfg.HARNESS" (see create-session in main.js), which is also the correct
  // behaviour on a single-harness machine where the picker never reveals itself.
  let harnessPicker = null, selectedHarness = null;
  const HARNESS_LABELS = { claude: 'Claude Code', codex: 'Codex' };
  // The Project Board is an OPTIONAL integration (Settings → "Project board tab"), off by default.
  // Off means genuinely absent, not merely hidden: no nav item is built, no Settings card is
  // registered, and the router refuses the view — see mountPmFeature() below.
  let pmEnabled = false;

  // ---- router ----
  MT.router = {
    show(view, arg) {
      // Never route to a feature the user has not enabled. Restored state, a stale keyboard
      // shortcut or a future call site can all ask for 'pm'; with the integration off there is
      // nothing to render, so fall back to the dashboard rather than paint an empty tab.
      if (view === 'pm' && !pmEnabled) view = 'dashboard';
      const my = ++renderSeq;
      const prevView = current;
      current = view;
      if (view === 'detail' || view === 'journal' || view === 'topics') currentSlug = arg;
      // leaving a view closes any open PM task sheet (a same-view re-render keeps it)
      if (view !== prevView && MT.pmTask && MT.pmTask.close) MT.pmTask.close();
      const isSession = view === 'session';
      sessionsHost.classList.toggle('hidden', !isSession);
      viewHost.classList.toggle('hidden', isSession);
      for (const k in navItems) { const on = k === view; navItems[k].classList.toggle('active', on); if (on) navItems[k].setAttribute('aria-current', 'page'); else navItems[k].removeAttribute('aria-current'); }

      if (isSession) { MT.session.showActive(); return Promise.resolve(); }

      const frag = document.createElement('div');
      let p;
      if (view === 'projects') p = MT.projects.render(frag, MT.openProject);
      else if (view === 'settings') p = MT.settings.render(frag);
      else if (view === 'detail') p = MT.detail.render(frag, currentSlug, MT.openProject);
      else if (view === 'pm') p = MT.pm.render(frag);
      else if (view === 'map') p = MT.map.render(frag);
      else if (view === 'dailyops') p = MT.dailyops.render(frag);
      else if (view === 'journal') p = MT.dailyLog.render(frag, currentSlug);
      else if (view === 'topics') p = MT.topics.render(frag, currentSlug);
      else if (view === 'files') p = MT.files.render(frag, { openProject: MT.openProject });
      else if (view === 'changes') p = MT.changes.render(frag, { openProject: MT.openProject });
      else if (view === 'character') p = MT.journal.render(frag);
      else if (view === 'mavis-identity') p = MT.mavisConfig.render(frag, 'identity');
      else if (view === 'mavis-rules') p = MT.mavisConfig.render(frag, 'rules');
      else if (view === 'ask') p = MT.brainChat.render(frag);
      // Dashboard + the Brain Health card. The card is appended HERE, at the router's call site,
      // rather than from inside dashboard-view.js: that module renders brain STATS (counts,
      // charts) and knows nothing about the linter, and this keeps the health feature to one
      // view module + the shell. Chained so the card lands after the dashboard's own sections,
      // and so a dashboard render failure still surfaces through the router's catch below.
      else p = Promise.resolve(MT.dashboard.render(frag)).then(() => { if (MT.brainHealth) MT.brainHealth.mountCard(frag); });

      // delayed skeleton — only paints if the load is slow enough to perceive
      // (≈network), so fast local views never flash a placeholder.
      let settled = false;
      let skeletonShown = false;
      let skelTimer = null;
      const skel = MT.skeleton && MT.skeleton.forView(view);
      if (skel) {
        skelTimer = setTimeout(() => {
          if (settled || my !== renderSeq) return;
          viewHost.innerHTML = '';
          const s = document.createElement('div');
          skel(s);
          viewHost.appendChild(s);
          skeletonShown = true;
        }, 140);
      }

      return Promise.resolve(p)
        .then(() => { settled = true; if (skelTimer) clearTimeout(skelTimer); if (my === renderSeq) { if (view !== prevView) frag.classList.add('mt-view-in'); viewHost.innerHTML = ''; viewHost.appendChild(frag); } })
        .catch((err) => { settled = true; if (skelTimer) clearTimeout(skelTimer); console.error('[mt-router] view render failed:', view, err); /* clear a stuck skeleton; otherwise leave prior content */ if (my === renderSeq && skeletonShown) viewHost.innerHTML = ''; });
    },
    current() { return current; },
  };

  // ---- app theme ----
  MT.theme = {
    apply(id, opts = {}) {
      const root = document.documentElement;
      if (id && id !== 'light') root.setAttribute('data-theme', id);
      else root.removeAttribute('data-theme');
      // brief color cross-fade so the swap is smooth, not a hard cut
      if (opts.animate) { root.classList.add('theming'); setTimeout(() => root.classList.remove('theming'), 320); }
      // the terminal pane palette + the SVG charts read CSS vars at apply/render time.
      // Non-chart views re-theme live via the CSS-var cascade, so only the dashboard
      // (SVG charts can't update live) needs a repaint — and re-rendering Settings here
      // would snap its theme dropdown back to the saved value mid-preview.
      if (MT.session && MT.session.applyThemePalette) MT.session.applyThemePalette();
      if (current === 'dashboard') MT.router.show(current, currentSlug);
    },
  };

  // Every project launch (palette, dashboard bubbles, Files/Changes/Detail "open") funnels through
  // here, so this is the one place that needs to know the per-session harness override. A caller
  // that already set opts.harness wins; otherwise fall back to the titlebar picker's current pick
  // (null on a single-harness machine, where main.js's own cfg.HARNESS default takes over).
  MT.openProject = (opts) => {
    const o = Object.assign({}, opts || {});
    if (o.harness == null && selectedHarness) o.harness = selectedHarness;
    return MT.session.open(o);
  };
  // open a project by display name / slug (constellation bubbles) — resolves its dir first
  MT.openProjectByName = async (name) => {
    try {
      const list = await window.mavis.listProjects();
      const lk = String(name || '').toLowerCase();
      const p = (list || []).find((x) => String(x.name || '').toLowerCase() === lk || String(x.slug || '').toLowerCase() === lk);
      if (p && p.dir) MT.openProject({ cwd: p.dir, label: p.name });
    } catch { /* no-op if the project can't be resolved */ }
  };

  // ---- title bar ----
  function buildTitlebar() {
    const tb = $('#titlebar');
    const left = document.createElement('div');
    left.className = 'mt-tb-left';
    const brand = document.createElement('div');
    brand.className = 'mt-brand';
    brand.innerHTML = '<img class="mt-brand-logo" src="./assets/mavis-logo.png" alt="" aria-hidden="true" /><span class="mt-brand-name">Mavis</span>';
    const tabs = document.createElement('div');
    tabs.className = 'mt-tabs';
    tabs.id = 'tabs';
    tabs.setAttribute('role', 'tablist');
    left.appendChild(brand);
    left.appendChild(tabs);

    const right = document.createElement('div');
    right.className = 'mt-tb-right';
    const kbar = document.createElement('button');
    kbar.className = 'mt-kbar';
    kbar.type = 'button';
    kbar.setAttribute('aria-label', 'Open command palette (Ctrl K)');
    kbar.innerHTML = '<span>' + icon('search', 16) + '</span><span>Jump to a project…</span><span class="hint" aria-hidden="true">Ctrl K</span>';
    kbar.addEventListener('click', () => MT.palette.open());

    // Per-session harness picker — which agent CLI the NEXT new session spawns. Built here (empty)
    // so it exists at boot before settings/availability are known; initHarnessPicker() (called from
    // the boot IIFE once window.mavis.harnessAvailable() answers) fills it in and reveals it ONLY
    // when there's an actual choice — a single-harness machine never sees this at all. Reuses the
    // same chip look as the split-menu's project picker (mt-field-input), which already lives
    // correctly in this titlebar's token scheme (see .mt-kbar, styled the same way).
    harnessPicker = MT.dropdown.create({
      options: [],
      className: 'mt-field-input',
      ariaLabel: 'Default agent for the next new session',
      onChange: (v) => { selectedHarness = v; },
    });
    harnessPicker.style.width = '132px';
    // .mt-dd sets its own `display: block`, which an author rule always beats the UA [hidden]
    // rule for (same specificity, origin wins) — so plain `.hidden = true` would NOT actually
    // hide this element. Inline display:none always wins regardless, so use that instead.
    harnessPicker.style.display = 'none';

    const wc = document.createElement('div');
    wc.className = 'mt-wc';
    const mk = (cls, iconName, fn, ariaLabel) => {
      const b = document.createElement('button');
      b.className = 'mt-wc-btn' + (cls ? ' ' + cls : '');
      b.type = 'button';
      b.innerHTML = icon(iconName, 15);
      b.title = ariaLabel;
      b.setAttribute('aria-label', ariaLabel);
      b.addEventListener('click', fn);
      return b;
    };
    const maxBtn = mk('', 'maximize', () => window.mavis.winMaximize(), 'Maximize');
    wc.appendChild(mk('', 'minimize', () => window.mavis.winMinimize(), 'Minimize'));
    wc.appendChild(maxBtn);
    wc.appendChild(mk('close', 'close', () => {
      // confirm before quitting — the × sits next to minimize/maximize and is easy to misclick;
      // closing ends every open terminal session + any in-progress Ask-Mavis chat.
      if (MT.confirm) {
        MT.confirm({
          title: 'Close Mavis-Terminal?',
          message: 'This quits the app. Open terminal sessions and any in-progress Ask-Mavis chat will end.',
          okLabel: 'Close',
          cancelLabel: 'Cancel',
          danger: true,
        }).then((ok) => { if (ok) window.mavis.winClose(); });
      } else {
        window.mavis.winClose();
      }
    }, 'Close'));

    // Ask Mavis — compact accent action, pinned in the titlebar's right cluster (left of the
    // command palette). A first-class router VIEW; its conversation + headless-claude session
    // persist across nav (see brain-chat.js). Registered in navItems so the router toggles .active.
    const ask = document.createElement('button');
    ask.className = 'mt-tb-ask';
    ask.type = 'button';
    ask.title = 'Ask Mavis';
    ask.setAttribute('aria-label', 'Ask Mavis');
    ask.innerHTML =
      '<span class="mt-ask-ico" aria-hidden="true">' + icon('sparkles', 16) + '</span>' +
      '<span class="mt-ask-label">Ask Mavis</span>';
    ask.addEventListener('click', () => MT.router.show('ask'));
    navItems.ask = ask;

    right.appendChild(ask);
    right.appendChild(harnessPicker);
    right.appendChild(kbar);
    right.appendChild(wc);
    tb.appendChild(left);
    tb.appendChild(right);

    window.mavis.onWinState(({ maximized }) => {
      maxBtn.innerHTML = icon(maximized ? 'restore' : 'maximize', 15);
      const lbl = maximized ? 'Restore' : 'Maximize';
      maxBtn.title = lbl;
      maxBtn.setAttribute('aria-label', lbl);
    });
    return tabs;
  }

  // ---- sidebar ----
  // Hoisted out of buildSidebar() because one nav item (the optional Project Board) is mounted
  // LATER, from the async boot block, once settings are known. `before` inserts it at the right
  // place in the Tools group instead of appending it after Settings and the version footer.
  function mkNav(key, text, iconName, before) {
    const sb = $('#sidebar');
    const n = document.createElement('button');
    n.className = 'mt-nav';
    n.type = 'button';
    n.innerHTML = '<span class="mt-nav-ico" aria-hidden="true">' + icon(iconName || key, 18) + '</span><span class="mt-nav-label">' + text + '</span>';
    n.title = text; // native tooltip — the only label affordance once collapsed to the icon rail
    n.addEventListener('click', () => MT.router.show(key));
    if (before && before.parentNode === sb) sb.insertBefore(n, before);
    else sb.appendChild(n);
    navItems[key] = n;
    return n;
  }

  // Mount the optional Project Board: nav item + its Settings card. Called once, from the async
  // boot block, ONLY when the pmEnabled setting is on — so a user who never turns it on sees no
  // trace of it in the UI. The boot splash is still up at that point, so nothing flashes in.
  function mountPmFeature() {
    if (pmEnabled) return;
    pmEnabled = true;
    mkNav('pm', 'PM', 'pm', navItems.map); // before Map, keeping the Tools group's original order
    if (MT.settings && MT.settings.registerSection && MT.pmSettings) {
      MT.settings.registerSection('Project board', (h) => MT.pmSettings.render(h));
    }
  }

  function buildSidebar() {
    const sb = $('#sidebar');
    // top header row: the first section heading ("Workspace") + the collapse toggle on ONE line, so
    // the toggle aligns with the heading instead of floating in its own row. Chevrons-left when
    // expanded («), -right when collapsed (»); the glyph swaps via MT.shell.setCollapsed → updateSidebarToggle.
    const head = document.createElement('div');
    head.className = 'mt-nav-head';
    const headLabel = document.createElement('div');
    headLabel.className = 'mt-nav-label';
    headLabel.textContent = 'Workspace';
    sidebarToggleBtn = document.createElement('button');
    sidebarToggleBtn.className = 'mt-sidebar-toggle';
    sidebarToggleBtn.type = 'button';
    sidebarToggleBtn.addEventListener('click', () => MT.shell.toggleSidebar());
    head.appendChild(headLabel);
    head.appendChild(sidebarToggleBtn);
    sb.appendChild(head);
    updateSidebarToggle();
    const mkLabel = (text) => { const l = document.createElement('div'); l.className = 'mt-nav-label'; l.textContent = text; sb.appendChild(l); };
    // (Ask Mavis moved to the titlebar's right cluster — see buildTitlebar.)
    // Workspace group — its "Workspace" heading is rendered in the header row above.
    mkNav('dashboard', 'Dashboard');
    // count of brain-health FAILs, pushed by main after every re-lint. Same shell-level reasoning
    // as the Changes badge below: the point of it is to be visible from the OTHER views.
    if (MT.brainHealth) MT.brainHealth.mountBadge(navItems.dashboard);
    mkNav('projects', 'Projects');
    mkNav('files', 'Files', 'folder');
    mkNav('changes', 'Changes', 'git-branch');
    MT.gitBadge.mount(navItems.changes);   // count of changed files, kept fresh by the shell's poll
    mkLabel('Memory');
    mkNav('journal', 'Daily log');
    mkNav('topics', 'Topics');
    mkNav('character', 'Character', 'user');
    mkLabel('Tools');
    // (the optional Project Board nav item is inserted here by mountPmFeature(), if enabled)
    mkNav('map', 'Map');
    mkNav('dailyops', 'Daily Ops');
    const spacer = document.createElement('div');
    spacer.className = 'mt-nav-spacer';
    sb.appendChild(spacer);
    mkNav('settings', 'Settings');
    // version footer — subtle, pinned at the very bottom; tooltip carries the runtime versions
    const ver = document.createElement('div');
    ver.className = 'mt-nav-version';
    ver.innerHTML = '<span class="mt-ver-name">Mavis Terminal</span><span class="mt-ver-num">v…</span>';
    sb.appendChild(ver);
    if (window.mavis.appVersion) {
      window.mavis.appVersion().then((v) => {
        if (!v) return;
        const num = ver.querySelector('.mt-ver-num');
        if (num) num.textContent = 'v' + v.app;
        ver.title = 'Mavis Terminal v' + v.app + '\nElectron ' + v.electron + ' · Node ' + v.node + ' · Chromium ' + v.chrome;
      }).catch(() => {});
    }
  }

  // ---- per-session harness picker ----
  // Called once at boot, after settings load, with the configured default agent id. Populates +
  // reveals the titlebar picker ONLY when more than one harness is actually installed — the
  // "no dead affordance" rule. Never throws: a failed harnessAvailable() call just leaves the
  // picker hidden and selectedHarness null, which falls through to main.js's own cfg.HARNESS
  // default (see create-session in main.js) — so the app still works correctly either way.
  async function initHarnessPicker(defaultId) {
    // The tab badge needs the true default + labels to compare against regardless of whether the
    // PICKER itself ends up visible — only the picker's mount is gated on there being an actual
    // choice, so set this unconditionally first.
    if (MT.session && MT.session.setHarnessContext) MT.session.setHarnessContext({ defaultId, labels: HARNESS_LABELS });
    if (!harnessPicker) return;
    let ids = [];
    try { ids = await window.mavis.harnessAvailable(); } catch { ids = []; }
    if (!Array.isArray(ids) || ids.length < 2) return;
    const opts = ids.map((id) => ({ value: id, label: HARNESS_LABELS[id] || id }));
    harnessPicker.setOptions(opts);
    selectedHarness = ids.includes(defaultId) ? defaultId : ids[0];
    harnessPicker.value = selectedHarness;
    harnessPicker.style.display = '';
  }

  // ---- collapsible sidebar (icon rail) ----
  // Swap the toggle chevron + its tooltip to match the current state («collapse / »expand).
  function updateSidebarToggle() {
    if (!sidebarToggleBtn) return;
    sidebarToggleBtn.innerHTML = icon(sidebarCollapsed ? 'chevrons-right' : 'chevrons-left', 18);
    const lbl = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
    sidebarToggleBtn.title = lbl;
    sidebarToggleBtn.setAttribute('aria-label', lbl);
  }
  // Persist the collapse flag into the session-state blob WITHOUT clobbering the tabs: read the
  // current state, set the one field, write it back. (session-state.write also preserves this flag
  // when session-view persists its tabs, so the two writers never fight — belt and suspenders.)
  async function persistCollapsed(collapsed) {
    try {
      const st = (await window.mavis.getSessionState()) || {};
      st.sidebarCollapsed = collapsed;
      await window.mavis.setSessionState(st);
    } catch { /* live UI state; a failed persist just means it won't survive a restart */ }
  }
  MT.shell = {
    isCollapsed() { return sidebarCollapsed; },
    setCollapsed(collapsed, opts = {}) {
      collapsed = !!collapsed;
      const changed = collapsed !== sidebarCollapsed;
      sidebarCollapsed = collapsed;
      const appEl = $('#app');
      if (appEl) appEl.classList.toggle('mt-sidebar-collapsed', collapsed);
      updateSidebarToggle();
      if (changed && !opts.silent) persistCollapsed(collapsed);
      // the terminal area's width just changed — refit the active session after layout settles.
      // fitTab (via refitActive) gates on a real dimension change, so this never fires a no-op pty
      // resize (the SIGWINCH gotcha); the panes' ResizeObserver also refits across the transition.
      requestAnimationFrame(() => { try { if (MT.session && MT.session.refitActive) MT.session.refitActive(); } catch { /* noop */ } });
    },
    toggleSidebar() { MT.shell.setCollapsed(!sidebarCollapsed); },
  };

  // ---- Changes badge — count of changed files in the active session's repo ----
  // Lives in the SHELL, not in changes-view.js: the whole point of the badge is to be visible
  // while you are on ANOTHER view, and a view's state dies on navigation (the router rebuilds
  // #view-host every time).
  //
  // Defined ABOVE the boot block on purpose: buildSidebar() calls MT.gitBadge.mount(), so this
  // assignment must have executed by then — a plain `MT.x = ...` is not hoisted, and having it
  // below the call site is a TypeError that kills the first paint.
  //
  // Cost discipline: `git status` spawns a process, and process spawn on Windows is not free.
  // So the poll is SLOW and focus-gated, `gitResolve` (~4 git calls) is cached per cwd while only
  // `gitStatus` (1 call) runs per tick, and the Changes view pushes its own count via set() after
  // every reload so being ON the view never double-spawns.
  MT.gitBadge = (() => {
    const POLL_MS = 5000;
    let badgeEl = null;
    // Measured on this box: resolveRepo ~133ms (it is ~4 git calls), status ~35ms. So the resolve
    // is cached PER CWD in a Map — a single-slot cache made every A -> B -> A tab switch re-resolve
    // and turned a 35ms switch into a 170ms one. With the Map, a switch costs one status: instant.
    const rootByCwd = new Map();                     // cwd -> repo root, or null for "not a repo"
    let inFlight = false, pending = false, seq = 0;

    function mount(navEl) {
      if (!navEl) return;
      badgeEl = document.createElement('span');
      badgeEl.className = 'mt-nav-badge';
      badgeEl.hidden = true;
      navEl.appendChild(badgeEl);
    }

    function set(n) {
      if (!badgeEl) return;
      const c = Number(n) || 0;
      badgeEl.hidden = c <= 0;                       // a zero badge is noise, not information
      badgeEl.textContent = c > 99 ? '99+' : String(c);
      badgeEl.setAttribute('aria-label', c + ' changed file' + (c === 1 ? '' : 's'));
    }

    async function refresh() {
      // COALESCE, never drop. An early `if (inFlight) return` loses the newest request outright:
      // switch tabs while a status is in flight and the badge keeps the OLD project's count until
      // the next 5s tick — which is exactly the "very slow to update" this replaced. Instead, note
      // that state moved and re-run once the current pass lands.
      if (inFlight) { pending = true; return; }
      const cwd = (MT.session && MT.session.activeCwd && MT.session.activeCwd()) || null;
      if (!cwd) { set(0); return; }
      inFlight = true;
      const my = ++seq;
      try {
        if (!rootByCwd.has(cwd)) {
          const info = await window.mavis.gitResolve(cwd);
          if (my !== seq) return;
          rootByCwd.set(cwd, (info && !info.error && info.root) ? info.root : null);
        }
        const root = rootByCwd.get(cwd);
        if (!root) { set(0); return; }               // not a repo -> no badge, not a zero
        const st = await window.mavis.gitStatus(root);
        if (my !== seq) return;
        if (!st || st.error) { set(0); return; }     // main returns an { error } sentinel, not a throw
        // A file can sit in BOTH lists (porcelain 'MM' = staged AND unstaged edits). Count UNIQUE
        // paths so the badge matches "files with changes", not row count.
        const uniq = new Set();
        (st.staged || []).forEach((e) => { if (e && e.rel) uniq.add(e.rel); });
        (st.unstaged || []).forEach((e) => { if (e && e.rel) uniq.add(e.rel); });
        set(uniq.size);
      } catch { set(0); }
      finally {
        inFlight = false;
        if (pending) { pending = false; refresh(); } // state changed mid-flight -> settle on the latest
      }
    }

    // The poll is only a SAFETY NET for edits made outside the app (Mavis writing files in the
    // terminal, an editor elsewhere). The responsive path is event-driven: session-view calls
    // refresh() on tab activation, and changes-view pushes its own count via set().
    // Focus-gated: a backgrounded app spawning git every 5s forever is pure waste.
    function start() {
      refresh();
      setInterval(() => { if (document.hasFocus()) refresh(); }, POLL_MS);
      window.addEventListener('focus', () => refresh());
    }

    return { mount, set, refresh, start };
  })();

  // ---- boot ----
  viewHost = $('#view-host');
  sessionsHost = $('#sessions-host');
  const tabs = buildTitlebar();
  buildSidebar();
  MT.session.init(tabs, sessionsHost);
  if (MT.palette && MT.palette.init) MT.palette.init();
  // a clicked attention-notification activates that session
  if (window.mavis.onActivateSession) {
    window.mavis.onActivateSession((p) => { if (p && p.id && MT.session) { if (MT.session.activateByPty) MT.session.activateByPty(p.id); else if (MT.session.activate) MT.session.activate(p.id); MT.router.show('session'); } });
  }
  // main intercepted Ctrl+R/Ctrl+Shift+R/F5 (Chromium's default reload accelerators) — confirm
  // via the themed dialog before actually reloading, since a reload resets the whole UI.
  if (window.mavis.onReloadConfirmRequest && MT.confirm) {
    window.mavis.onReloadConfirmRequest(({ hardReload } = {}) => {
      MT.confirm({
        title: 'Reload Mavis-Terminal?',
        message: 'This resets the UI (open tabs, in-progress Ask-Mavis chat). Terminal sessions may not survive.',
        okLabel: 'Reload',
        cancelLabel: 'Cancel',
        danger: false,
      }).then((ok) => window.mavis.reloadConfirmResponse({ ok, hardReload }));
    });
  }
  if (MT.settings && MT.settings.registerSection) {
    // The Project Board's token card is NOT registered here — it only exists when the integration
    // is enabled, and that is not known until the async boot block has read settings. See
    // mountPmFeature(). Settings is only ever rendered on user navigation, which happens long
    // after that, so registering late is safe.
    if (MT.mapSettings) MT.settings.registerSection('Map', (h) => MT.mapSettings.render(h));
  }
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); MT.palette.open('search'); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); MT.palette.open(); }
  });
  if (window.mavis.onBrainChanged) {
    window.mavis.onBrainChanged(() => {
      if (current === 'session') return;
      // PM shows remote project-board data, not the brain — re-rendering it on a brain
      // write is pointless and would race an in-flight board fetch. Map is a static
      // build (a re-render rebuilds the <webview> + reloads the 6 MB graph for no new
      // data); Settings shows config, not brain data. Skip all three.
      // Ask Mavis shows a conversation, not brain-data — a brain write shouldn't rebuild it (and would
      // disrupt an in-flight turn); its state persists in the module regardless.
      // Files shows a lazy tree + an editor buffer (possibly with unsaved edits) — a brain write is
      // irrelevant to it and a re-render would blow the tree/editor away, so skip it too.
      // Changes shows git state, not brain data — and a re-render would blow away an
      // in-progress commit message, so it skips for the same reason Files does.
      if (current === 'pm' || current === 'map' || current === 'settings' || current === 'ask' || current === 'files' || current === 'changes') return;
      // don't blow away an in-flight DailyOps generation / answers / review
      if (current === 'dailyops' && MT.dailyops && MT.dailyops.isBusy && MT.dailyops.isBusy()) return;
      MT.router.show(current, currentSlug);
    });
  }


  // boot loader: fade out the first-paint splash once the first view's data has
  // rendered. Idempotent + transition/timeout cleanup so it can never trap the UI.
  function hideBootLoader() {
    const node = document.getElementById('mt-loader');
    if (!node || node.classList.contains('mt-loader-hide')) return;
    node.classList.add('mt-loader-hide');
    const done = () => { if (node.parentNode) node.parentNode.removeChild(node); };
    node.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 700); // fallback if transitionend never fires (reduced-motion)
  }

  (async () => {
    // Restore the persisted collapse state while the boot splash still covers the UI (no expand→collapse
    // flash). `silent` so restoring doesn't re-persist. Runs before restore() spawns terminals.
    try {
      const ss = await window.mavis.getSessionState();
      if (ss && ss.sidebarCollapsed) MT.shell.setCollapsed(true, { silent: true });
    } catch { /* default = expanded */ }
    try {
      const s = await window.mavis.getSettings();
      if (s && s.values) {
        // Optional Project Board integration. Accepts the 'on' string the settings dropdown
        // stores AND a plain boolean, so it keeps working whichever shape the main process
        // hands back; anything else (including the key being absent entirely) means off.
        if (s.values.pmEnabled === true || s.values.pmEnabled === 'on') mountPmFeature();
        // set the theme attribute BEFORE restore() spawns terminals (they read --term-* on create)
        if (s.values.appTheme && s.values.appTheme !== 'light') document.documentElement.setAttribute('data-theme', s.values.appTheme);
        MT.session.applyTerminalSettings({ fontSize: s.values.terminalFontSize });
        if (MT.notify) MT.notify.configure({ mode: s.values.notifyOnComplete, sound: s.values.notifySound, volume: s.values.notifyVolume });
        // Awaited BEFORE restore() below: restored tabs render their harness badge immediately
        // from session-state, and that comparison needs the global default + labels in place first.
        try { await initHarnessPicker(s.values.harness); } catch { /* single-harness fallback: no picker */ }
      }
    } catch { /* defaults are fine */ }
    let restored = 0;
    try { restored = await MT.session.restore(); } catch { restored = 0; }
    try { if (!restored) await MT.router.show('dashboard'); }
    finally { hideBootLoader(); }
    // after restore(), so the first refresh sees the restored session's cwd rather than none
    MT.gitBadge.start();
    // main's boot lint may still be in flight (it spawns node): start() polls get() briefly and
    // gives up once the report lands or the push arrives. No poll after that — it's push-driven.
    if (MT.brainHealth) MT.brainHealth.start();
  })();
  // failsafe: never let the splash trap the UI if a read hangs
  setTimeout(hideBootLoader, 5000);
})();
