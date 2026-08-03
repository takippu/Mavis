'use strict';

// MT.brainHealth — the Brain Health card (Dashboard) + the FAIL-count badge (sidebar nav) +
// the gated Fix modal. Renders what `scripts/lint-brain.mjs` says via the brain:health bridge;
// it never reads or writes brain files itself. Repair goes through main, which validates the
// request, plans it with --dry-run, and only writes a plan the user has explicitly approved.
//
// THREE STRUCTURAL RULES THIS FILE EXISTS TO RESPECT:
//
// 1. The BADGE lives in the SHELL, not in the view. The router rebuilds #view-host on every
//    nav, so a badge owned by a view module would vanish the moment you left the Dashboard --
//    which is the only time a badge is worth anything. mountBadge() is called once from
//    buildSidebar(); only mountCard() re-runs per Dashboard render.
//
// 2. The report is cached at MODULE level (the module outlives every view). Navigating back to
//    the Dashboard repaints instantly from the last push instead of flashing a pending state.
//
// 3. The push channel is subscribed EXACTLY ONCE. ipcRenderer.on ACCUMULATES listeners, so
//    subscribing inside mountCard would leak one listener per Dashboard visit and re-render the
//    card N times per lint. ensureSubscribed() is idempotent.
(function () {
  const MT = (window.MT = window.MT || {});

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  MT.brainHealth = (() => {
    let report = null;        // last lint report, or null before the first one lands
    let cardBody = null;      // body of the currently mounted card (dies with the view on nav)
    let cardCount = null;     // the "2 fail - 10 warn" line in the card head
    let badgeEl = null;       // shell-owned; mounted once, lives for the app's lifetime
    let subscribed = false;
    let inFlight = false, pending = false;

    // v1 repairs are `rotate <project>` and `shard-notes <project>` only. Everything else the
    // linter suggests (trim, re-shard an index, repoint a ref) is judgment work done by hand,
    // so those rows get no button rather than a button that lies about what it can do.
    // The trailing space is load-bearing: a bare "rotate" with no project is not actionable.
    function isFixable(f) {
      return !!parseFix(f);
    }

    // suggestedAction -> {command, project}, or null. Main re-validates both from scratch: this
    // parse decides whether to OFFER a button, it is not a security check.
    function parseFix(f) {
      if (!f || f.severity !== 'fail') return null;
      const m = String(f.suggestedAction || '').match(/^(rotate|shard-notes) ([a-z0-9][a-z0-9._-]*)$/);
      return m ? { command: m[1], project: m[2] } : null;
    }

    // FAILs first, then WARNs; original (checker) order preserved inside each tier, since that
    // already groups size / link / ref-rule flags together.
    function ordered(flags) {
      const f = (flags || []).filter(Boolean);
      return [...f.filter((x) => x.severity === 'fail'), ...f.filter((x) => x.severity !== 'fail')];
    }

    function failCount(r) {
      return (r && r.counts && Number(r.counts.fail)) || 0;
    }

    // ---- badge (shell) ----
    function mountBadge(navEl) {
      if (!navEl) return;
      badgeEl = el('span', 'mt-nav-badge mt-nav-badge-bh');
      badgeEl.hidden = true;
      navEl.appendChild(badgeEl);
      paintBadge();
    }

    function paintBadge() {
      if (!badgeEl) return;
      const n = failCount(report);
      // Hidden at zero: a "0" badge is noise. WARNs deliberately do not raise it either -- a
      // pill that is always lit is a pill you stop seeing, which kills the whole repair loop.
      badgeEl.hidden = n <= 0;
      badgeEl.textContent = n > 99 ? '99+' : String(n);
      badgeEl.setAttribute('aria-label', n + ' brain health failure' + (n === 1 ? '' : 's'));
    }

    // ---- card (view) ----
    function mountCard(host) {
      if (!host) return;
      const wrap = el('div', 'mt-bh-wrap');

      const head = el('div', 'mt-bh-head');
      head.appendChild(el('div', 'mt-label', 'Brain health'));
      cardCount = el('div', 'mt-bh-count');
      head.appendChild(cardCount);
      wrap.appendChild(head);

      const card = el('div', 'mt-card mt-bh-card');
      cardBody = el('div', 'mt-bh-body');
      card.appendChild(cardBody);
      wrap.appendChild(card);
      host.appendChild(wrap);

      paintCard();
      // Repaint from the cache first (instant), then reconcile with main. Both are cheap: get()
      // returns main's cached report, it does not spawn a lint.
      ensureSubscribed();
      refresh();
    }

    function paintCard() {
      if (!cardBody) return;
      cardBody.innerHTML = '';

      if (!report) {
        if (cardCount) cardCount.textContent = '';
        cardBody.appendChild(el('div', 'mt-empty', 'Checking the brain…'));
        return;
      }

      const flags = ordered(report.flags);
      const fails = failCount(report);
      const warns = (report.counts && Number(report.counts.warn)) || 0;
      if (cardCount) {
        cardCount.textContent = flags.length
          ? fails + ' fail · ' + warns + ' warn'
          : '';
      }

      if (!flags.length) {
        const ok = el('div', 'mt-bh-ok');
        const ico = el('span', 'mt-bh-ok-ico');
        // static, data-free icon literal -- every value below is set via textContent
        ico.innerHTML = MT.icons ? MT.icons.svg('check', 16) : '';
        ok.appendChild(ico);
        ok.appendChild(el('div', 'mt-bh-ok-text', 'No flags — brain within budgets, links connected'));
        cardBody.appendChild(ok);
        return;
      }

      const list = el('div', 'mt-bh-list');
      flags.forEach((f) => list.appendChild(buildRow(f)));
      cardBody.appendChild(list);
    }

    function buildRow(f) {
      const fail = f.severity === 'fail';
      const row = el('div', 'mt-bh-row');

      row.appendChild(el('span', 'mt-bh-chip ' + (fail ? 'fail' : 'warn'), fail ? 'FAIL' : 'WARN'));

      const main = el('div', 'mt-bh-main');
      main.appendChild(el('div', 'mt-bh-file', f.file || ''));
      main.appendChild(el('div', 'mt-bh-detail', f.detail || ''));
      row.appendChild(main);

      if (f.suggestedAction) {
        const hint = el('span', 'mt-bh-hint', f.suggestedAction);
        hint.title = f.suggestedAction;
        row.appendChild(hint);
      }

      const fix = parseFix(f);
      if (fix) {
        const btn = el('button', 'mt-bh-fix', 'Preview fix');
        btn.type = 'button';
        btn.title = 'Show exactly what `' + fix.command + ' ' + fix.project + '` would change';
        // "Preview", never "Fix": this button only ever opens a diff. Applying is a second,
        // separate click inside the modal, against a plan the user has already read.
        btn.addEventListener('click', () => openFixModal(fix));
        row.appendChild(btn);
      }

      return row;
    }

    // ---- fix modal (preview -> approve -> apply) ----

    const KB = (n) => (Number(n) || 0) < 1024
      ? (Number(n) || 0) + ' B'
      : ((Number(n) || 0) / 1024).toFixed(1) + ' KB';

    // One human sentence per command. summary shapes come from brain-repair-core's planners:
    // rotate -> {kept, keptUndated, moved, hotBytesBefore, hotBytesAfter, archives}
    // shard-notes -> {entries, indexBytesBefore, indexBytesAfter}
    function summaryLine(plan) {
      const s = (plan && plan.summary) || {};
      if (plan.command === 'rotate') {
        const arch = (s.archives || []).join(', ') || 'the archive';
        return s.kept + ' checkpoints kept hot, ' + s.moved + ' moved to ' + arch +
          ' — ' + KB(s.hotBytesBefore) + ' to ' + KB(s.hotBytesAfter);
      }
      return s.entries + ' sections split into notes/_details/ — index ' +
        KB(s.indexBytesBefore) + ' to ' + KB(s.indexBytesAfter);
    }

    // Trailing \r so a CRLF brain file does not render a visible carriage return in every row.
    const lines = (t) => String(t == null ? '' : t).split('\n').map((l) => l.replace(/\r$/, ''));

    const CTX = 3;      // context lines kept around the changed region
    const MAX_ROWS = 400; // hard cap: a plan can move tens of thousands of lines

    /**
     * Diff two versions of a file into side-by-side rows.
     *
     * WHY THIS IS NOT "show the first 60 lines of each side": for a rotation the head of the file
     * is IDENTICAL before and after (the newest checkpoints stay put — the blocks that move are the
     * OLD ones at the tail). A head preview therefore renders two identical panes and shows the
     * user nothing, right before they approve a destructive write to gitignored data. Verified on a
     * real 56KB fixture: first differing line was 68, and the real brain's files rotate at ~32KB in.
     *
     * Common-prefix/suffix trimming is enough for both repairs (each rewrites one contiguous region:
     * rotate drops a run of old blocks, shard-notes replaces section bodies with index entries), so
     * it stays O(n) with no LCS — and it centres the view on the bytes that actually change.
     */
    function diffRows(before, after) {
      const a = lines(before);
      const b = lines(after);
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      let s = 0;
      while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

      const rows = [];
      const ctxStart = Math.max(0, p - CTX);
      if (ctxStart > 0) rows.push({ kind: 'gap' });
      for (let i = ctxStart; i < p; i++) rows.push({ kind: 'ctx', ln: i + 1, rn: i + 1, l: a[i], r: b[i] });

      const dels = a.slice(p, a.length - s);
      const adds = b.slice(p, b.length - s);
      const n = Math.min(Math.max(dels.length, adds.length), MAX_ROWS);
      for (let i = 0; i < n; i++) {
        rows.push({
          kind: 'chg',
          ln: i < dels.length ? p + i + 1 : null,
          rn: i < adds.length ? p + i + 1 : null,
          l: i < dels.length ? dels[i] : null,
          r: i < adds.length ? adds[i] : null,
        });
      }
      const hidden = Math.max(dels.length, adds.length) - n;

      const tailFrom = a.length - s;
      for (let i = tailFrom; i < Math.min(tailFrom + CTX, a.length); i++) {
        rows.push({ kind: 'ctx', ln: i + 1, rn: b.length - s + (i - tailFrom) + 1, l: a[i], r: b[i] });
      }
      if (s > CTX) rows.push({ kind: 'gap' });
      return { rows, hidden, unchanged: dels.length === 0 && adds.length === 0 };
    }

    // Reuses the Changes view's grid/line classes (changes.css is loaded globally), so the diff
    // looks identical to git's and is already retuned for the four dark themes.
    function buildPanes(write) {
      const wrap = el('div', 'mt-bh-panes');
      const { rows, hidden, unchanged } = diffRows(write.before, write.after);

      const scroll = el('div', 'mt-chg-scroll mt-bh-scroll');
      const grid = el('div', 'mt-chg-grid');
      grid.appendChild(el('div', 'mt-chg-col-h', write.before == null ? 'Does not exist yet' : 'Current'));
      grid.appendChild(el('div', 'mt-chg-col-h', 'After repair'));

      if (unchanged) {
        const none = el('div', 'mt-chg-empty', 'No change to this file.');
        none.style.gridColumn = '1 / -1';
        grid.appendChild(none);
      }

      rows.forEach((row) => {
        if (row.kind === 'gap') {
          for (let i = 0; i < 2; i++) {
            const g = el('div', 'mt-chg-ln gap' + (i ? ' side-new' : ''));
            g.appendChild(el('span', 'mt-chg-n', ''));
            g.appendChild(el('span', 'mt-chg-c', '⋯'));
            grid.appendChild(g);
          }
          return;
        }
        const chg = row.kind === 'chg';
        grid.appendChild(cell(row.l, row.ln, 'side-old' + (chg && row.l !== null ? ' del' : '')));
        grid.appendChild(cell(row.r, row.rn, 'side-new' + (chg && row.r !== null ? ' add' : '')));
      });

      scroll.appendChild(grid);
      wrap.appendChild(scroll);
      if (hidden > 0) {
        wrap.appendChild(el('div', 'mt-chg-trunc', hidden + ' more changed lines not shown — the repair still applies to the whole file.'));
      }
      return wrap;
    }

    function cell(text, num, cls) {
      // text === null means "this side has no line here" -> a gap filler, not an empty line.
      const n = el('div', 'mt-chg-ln ' + cls + (text === null ? ' gap' : ''));
      n.appendChild(el('span', 'mt-chg-n', num == null ? '' : String(num)));
      n.appendChild(el('span', 'mt-chg-c', text === null ? '' : text));
      return n;
    }

    function openFixModal(fix) {
      const overlay = el('div', 'mt-np-overlay');
      const card = el('div', 'mt-np-card mt-bh-modal');
      overlay.appendChild(card);

      let closed = false;
      let busy = false; // an apply is in flight: the write is NOT interruptible from here
      function close() {
        if (closed || busy) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
      }
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
      document.body.appendChild(overlay);
      setTimeout(() => document.addEventListener('keydown', onKey, true), 0);

      const head = el('div', 'mt-np-head');
      head.appendChild(el('div', 'mt-np-title', fix.command === 'rotate' ? 'Rotate progress.md' : 'Shard notes.md'));
      const x = el('button', 'mt-np-x');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.innerHTML = MT.icons ? MT.icons.svg('close', 16) : '';
      x.addEventListener('click', close);
      head.appendChild(x);
      card.appendChild(head);

      const body = el('div', 'mt-np-body mt-bh-modal-body');
      card.appendChild(body);
      const foot = el('div', 'mt-np-foot');
      card.appendChild(foot);

      body.appendChild(el('div', 'mt-empty', 'Planning the repair…'));

      const cancel = el('button', 'mt-link', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', close);
      foot.appendChild(cancel);

      const applyBtn = el('button', 'mt-pill', 'Apply repair');
      applyBtn.type = 'button';
      applyBtn.disabled = true; // nothing to approve until a plan is on screen
      foot.appendChild(applyBtn);

      const bridge = window.mavis && window.mavis.brainHealth;
      if (!bridge || !bridge.previewFix) {
        body.innerHTML = '';
        body.appendChild(el('div', 'mt-bh-err', 'Repair is unavailable in this build.'));
        return;
      }

      Promise.resolve(bridge.previewFix(fix.command, fix.project))
        .then((plan) => {
          if (closed) return;
          body.innerHTML = '';
          // Main returns { error } sentinels rather than throwing (the git:* posture).
          if (!plan || plan.error || !Array.isArray(plan.writes)) {
            body.appendChild(el('div', 'mt-bh-err', (plan && plan.error) || 'Could not plan this repair.'));
            return;
          }
          renderPlan(plan);
        })
        .catch((e) => {
          // NEVER an empty catch: a swallowed throw here would leave "Planning..." on screen
          // forever with no clue why (the router's silent-catch bug, one level down).
          if (closed) return;
          body.innerHTML = '';
          body.appendChild(el('div', 'mt-bh-err', 'Could not plan this repair: ' + (e && e.message ? e.message : String(e))));
        });

      function renderPlan(plan) {
        body.appendChild(el('div', 'mt-bh-sum', summaryLine(plan)));

        const list = el('div', 'mt-bh-files');
        let paneHost = null;
        let selected = 0;

        plan.writes.forEach((w, i) => {
          const r = el('button', 'mt-bh-fileitem');
          r.type = 'button';
          const name = el('span', 'mt-bh-fname', w.path);
          const delta = w.before == null
            ? 'new · ' + KB((w.after || '').length)
            : KB(w.before.length) + ' to ' + KB((w.after || '').length);
          r.appendChild(name);
          r.appendChild(el('span', 'mt-bh-fdelta', delta));
          r.addEventListener('click', () => { selected = i; paint(); });
          list.appendChild(r);
        });
        body.appendChild(list);

        paneHost = el('div');
        body.appendChild(paneHost);

        function paint() {
          [...list.children].forEach((c, i) => c.classList.toggle('selected', i === selected));
          paneHost.innerHTML = '';
          paneHost.appendChild(buildPanes(plan.writes[selected]));
        }
        paint();

        const note = el('div', 'mt-bh-note',
          'Applying copies every original to _backup/repair-<timestamp>/ first, then writes atomically.');
        body.appendChild(note);

        applyBtn.disabled = false;
        applyBtn.addEventListener('click', () => {
          if (busy) return;
          busy = true;
          applyBtn.disabled = true;
          cancel.disabled = true;
          applyBtn.textContent = 'Applying…';
          Promise.resolve(bridge.applyFix(fix.command, fix.project))
            .then((res) => {
              busy = false;
              if (!res || res.error || !res.applied) {
                cancel.disabled = false;
                applyBtn.textContent = 'Apply repair';
                // A refusal is usually drift: the file changed since the preview, so the diff on
                // screen no longer describes what would happen. Re-previewing is the way back.
                body.insertBefore(
                  el('div', 'mt-bh-err', (res && res.error) || 'The repair did not apply.'),
                  body.firstChild
                );
                return;
              }
              done(res);
            })
            .catch((e) => {
              busy = false;
              cancel.disabled = false;
              applyBtn.textContent = 'Apply repair';
              body.insertBefore(el('div', 'mt-bh-err', 'The repair did not apply: ' + (e && e.message ? e.message : String(e))), body.firstChild);
            });
        });
      }

      // Applied: replace the diff with the receipt. The backup path is the single most important
      // thing to show -- brain data is gitignored, so this directory is the only way back.
      function done(res) {
        body.innerHTML = '';
        const ok = el('div', 'mt-bh-ok');
        const ico = el('span', 'mt-bh-ok-ico');
        ico.innerHTML = MT.icons ? MT.icons.svg('check', 16) : ''; // static literal, no data
        ok.appendChild(ico);
        ok.appendChild(el('div', 'mt-bh-ok-text', 'Repair applied.'));
        body.appendChild(ok);
        body.appendChild(el('div', 'mt-bh-sum', summaryLine({ command: fix.command, summary: res.summary })));
        body.appendChild(el('div', 'mt-bh-note', 'Originals backed up to:'));
        body.appendChild(el('div', 'mt-bh-backup', res.backupDir || '(not reported)'));

        foot.innerHTML = '';
        const doneBtn = el('button', 'mt-pill', 'Done');
        doneBtn.type = 'button';
        doneBtn.addEventListener('click', close); // busy is already false: the write has landed
        foot.appendChild(doneBtn);
        // Main re-lints after a successful apply and pushes the new report; this just closes the
        // gap if that push is slow.
        refresh();
      }
    }

    // ---- data ----
    function apply(r) {
      if (!r) return;
      report = r;
      paintCard();
      paintBadge();
    }

    function ensureSubscribed() {
      if (subscribed) return;
      if (!window.mavis || !window.mavis.brainHealth || !window.mavis.brainHealth.onChange) return;
      subscribed = true;
      window.mavis.brainHealth.onChange((r) => apply(r));
    }

    function refresh() {
      // COALESCE, never drop: `if (inFlight) return` would discard the newest request and leave a
      // stale report on screen (the 2026-07-17 git-badge lag bug). Note that another pass is
      // wanted and re-run once this one lands.
      if (inFlight) { pending = true; return Promise.resolve(); }
      if (!window.mavis || !window.mavis.brainHealth || !window.mavis.brainHealth.get) return Promise.resolve();
      inFlight = true;
      return Promise.resolve(window.mavis.brainHealth.get())
        .then((r) => { if (r) apply(r); })
        .catch(() => { /* main returns null until the first lint lands; a failure just leaves the cache */ })
        .then(() => {
          inFlight = false;
          if (pending) { pending = false; return refresh(); }
        });
    }

    // Called once from boot. main runs its first lint at startup, so `get()` may legitimately
    // return null for a second or two -- the push settles it. The bounded retry closes the race
    // where that push lands BEFORE this renderer subscribed: without it a missed push would leave
    // the card on "Checking the brain..." until the next brain write.
    async function start() {
      ensureSubscribed();
      for (let i = 0; i < 8 && !report; i++) {
        await refresh();
        if (report) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return { mountCard, mountBadge, refresh, start, last: () => report };
  })();
})();
