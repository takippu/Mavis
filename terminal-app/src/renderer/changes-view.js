'use strict';

// MT.changes — the Changes view: a collapsible rail of changed files (left) and a
// side-by-side diff (right), for the repo behind the active session.
//
// The renderer NEVER names a repo: it sends the session cwd to git:resolve and main
// derives + remembers the root. Every later call passes that main-resolved root back.
//
// Router-view contract (same as files-view.js): render(host, ctx) paints into a DETACHED
// frag — never gate the paint on document.contains; the router appends it once resolved.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const icon = (name, size) => (MT.icons ? MT.icons.svg(name, size) : '');

  // module-level so a nav-away doesn't lose a typed commit message
  const state = { message: '', railCollapsed: false };

  MT.changes = {
    render(host, ctx) {
      const token = (MT.changes._seq = (MT.changes._seq || 0) + 1);
      const alive = () => token === MT.changes._seq;
      host.innerHTML = '';
      // The router wraps every view in a bare auto-height <div>, which breaks a child's
      // height:100% chain (the same trap that collapsed Ask Mavis — see brain-chat.js).
      // Give the wrapper a definite height (the view-host is position:absolute inset:0)
      // so .mt-chg fills, the rail scrolls internally, and the diff grid gets a real
      // scroll container instead of running the whole page long.
      host.style.height = '100%';

      let repo = null;          // { root, branch, detached, ahead, upstream }
      let sel = null;           // { rel, staged }
      let entries = { staged: [], unstaged: [] };
      // The TRUSTED SEED. git:resolve validates its argument as a session *cwd* against
      // the files:* allowlist — a repo root is usually an ANCESTOR of that cwd and is not
      // itself allowlisted, so re-resolving must always replay this cwd, never repo.root.
      let seedCwd = null;
      let commitBtn = null;     // declared HERE, not below commitBox() — a `let` used by an
                                // earlier-defined function is a TDZ trap waiting on a refactor.
      let pushing = false;      // `git push` is the longest await in the view; pushBtn.disabled
                                // alone can't single-flight it (refreshRepoChip clears it).

      const wrap = el('div', 'mt-chg');
      const head = el('div', 'mt-chg-head');
      const repoChip = el('div', 'mt-chg-repo');
      const repoIco = el('span', 'mt-chg-repo-ico'); repoIco.innerHTML = icon('folder', 15);
      const repoName = el('span', 'mt-chg-repo-name', '...');
      repoChip.append(repoIco, repoName);
      const branchChip = el('button', 'mt-chg-branch'); branchChip.type = 'button';
      const branchIco = el('span', 'mt-chg-branch-ico'); branchIco.innerHTML = icon('git-branch', 14);
      const branchName = el('span', 'mt-chg-branch-name', '...');
      branchChip.append(branchIco, branchName);
      const spacer = el('span', 'mt-chg-spacer');
      const refreshBtn = el('button', 'mt-chg-btn', 'Refresh'); refreshBtn.type = 'button';
      const pushBtn = el('button', 'mt-chg-btn', 'Push'); pushBtn.type = 'button';
      head.append(repoChip, branchChip, spacer, refreshBtn, pushBtn);
      wrap.appendChild(head);

      const body = el('div', 'mt-chg-body');
      const rail = el('div', 'mt-chg-rail');
      const diffEl = el('div', 'mt-chg-diff');
      body.append(rail, diffEl);
      wrap.appendChild(body);
      host.appendChild(wrap);

      if (state.railCollapsed) wrap.classList.add('mt-chg-rail-collapsed');

      // ---- rail ----
      function paintRail() {
        rail.innerHTML = '';
        const toggle = el('button', 'mt-chg-rail-toggle'); toggle.type = 'button';
        toggle.title = state.railCollapsed ? 'Expand file list' : 'Collapse file list';
        toggle.textContent = state.railCollapsed ? '»' : '«';
        toggle.addEventListener('click', () => {
          state.railCollapsed = !state.railCollapsed;
          wrap.classList.toggle('mt-chg-rail-collapsed', state.railCollapsed);
          paintRail();
        });
        rail.appendChild(toggle);

        const total = entries.staged.length + entries.unstaged.length;
        if (!total) { rail.appendChild(el('div', 'mt-chg-empty', 'No changes.')); return; }
        section('Staged', entries.staged, true);
        section('Changes', entries.unstaged, false);
        commitBox();
      }

      function section(label, list, staged) {
        if (!list.length) return;
        const h = el('div', 'mt-chg-sec');
        h.appendChild(el('span', 'mt-chg-sec-label', label + ' (' + list.length + ')'));
        const bulk = el('button', 'mt-chg-sec-act', staged ? 'Unstage all' : 'Stage all');
        bulk.type = 'button';
        // Section-scoped only — deliberately never a global `git add -A`, per the
        // stage-only-this-tasks-files preference.
        bulk.addEventListener('click', async () => {
          // Unmerged paths are excluded: `git add` on one marks the conflict resolved, and
          // a bulk lever must never do that as a side effect (spec non-goal: no conflict UI).
          const rels = list.filter((e) => !e.unmerged).map((e) => e.rel);
          if (!rels.length) return;
          const res = staged ? await window.mavis.gitUnstage(repo.root, rels) : await window.mavis.gitStage(repo.root, rels);
          if (res && res.error) return fail(res.error);
          await reload();
        });
        h.appendChild(bulk);
        rail.appendChild(h);
        list.forEach((e) => rail.appendChild(fileRow(e, staged)));
      }

      function fileRow(e, staged) {
        const row = el('div', 'mt-chg-f');
        if (sel && sel.rel === e.rel && sel.staged === staged) row.classList.add('selected');
        row.setAttribute('role', 'button'); row.tabIndex = 0;

        // The checkbox IS the staging control and reflects one fact: is this staged.
        // An unmerged path has no staging gesture at all — it is drawn INERT. `git add`
        // marks a conflict resolved and `git restore --staged` collapses it to HEAD and
        // removes git's own "you have unmerged files" commit guard; neither belongs behind
        // an accidental click when the spec's non-goal is "no conflict resolution UI".
        const ck = el('span', 'mt-chg-ck' + (e.unmerged ? ' inert' : (staged ? ' on' : '')));
        if (e.unmerged) {
          ck.title = 'Unmerged — resolve the conflict in the terminal';
        } else {
          ck.setAttribute('role', 'checkbox');
          ck.setAttribute('aria-checked', staged ? 'true' : 'false');
          ck.title = staged ? 'Unstage' : 'Stage';
          ck.addEventListener('click', async (ev) => {
            ev.stopPropagation();                  // selecting is a different gesture
            const res = staged ? await window.mavis.gitUnstage(repo.root, [e.rel]) : await window.mavis.gitStage(repo.root, [e.rel]);
            if (res && res.error) return fail(res.error);
            await reload();
          });
        }

        // 'U' is already spent on the untracked sentinel, so a conflict gets its own glyph
        // and its own class rather than borrowing a status letter that means something else.
        const st = e.unmerged
          ? el('span', 'mt-chg-st s-conflict', '!')
          : el('span', 'mt-chg-st s-' + e.status, e.status);
        if (e.unmerged) st.title = 'Unmerged';
        const nm = el('span', 'mt-chg-f-name', e.name);
        const dr = el('span', 'mt-chg-f-dir', e.dir);
        row.append(ck, st, nm, dr);
        row.title = e.rel;

        const open = () => { sel = { rel: e.rel, staged }; paintRail(); loadDiff(); };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
        return row;
      }

      function commitBox() {
        const box = el('div', 'mt-chg-commit');
        const ta = el('textarea', 'mt-chg-msg');
        ta.placeholder = 'Commit message';
        ta.rows = 3;
        ta.value = state.message;
        ta.addEventListener('input', () => { state.message = ta.value; syncCommitBtn(); });
        const btn = el('button', 'mt-chg-commit-btn'); btn.type = 'button';
        box.append(ta, btn);
        rail.appendChild(box);
        btn.addEventListener('click', doCommit);
        commitBtn = btn;
        syncCommitBtn();
      }

      function syncCommitBtn() {
        if (!commitBtn) return;
        const n = entries.staged.length;
        commitBtn.textContent = 'Commit ' + n;
        commitBtn.disabled = n === 0 || !state.message.trim();
      }

      function fail(msg) {
        if (MT.toast) MT.toast.show({ title: 'Git', body: String(msg), timeout: 6000 });
      }

      // ---- data ----
      // Mirror our just-fetched status into the sidebar's Changes badge. Unique paths, not row
      // count: a file with both staged and unstaged edits ('MM') sits in BOTH lists but is one
      // changed file. Must match MT.gitBadge.refresh's own counting or the number would flicker
      // between the two sources.
      function pushBadge() {
        if (!MT.gitBadge) return;
        const uniq = new Set();
        entries.staged.forEach((e) => { if (e && e.rel) uniq.add(e.rel); });
        entries.unstaged.forEach((e) => { if (e && e.rel) uniq.add(e.rel); });
        MT.gitBadge.set(uniq.size);
      }

      async function reload() {
        if (!repo || !repo.root) return;
        const res = await window.mavis.gitStatus(repo.root);
        if (!alive()) return;
        if (res && res.error) { entries = { staged: [], unstaged: [] }; pushBadge(); paintRail(); return fail(res.error); }
        entries = { staged: res.staged || [], unstaged: res.unstaged || [] };
        pushBadge();   // we already paid for this status — hand the count to the sidebar badge
                       // rather than let its poll spawn a second one while we're on this view
        // Keep the selection if the FILE still exists — on either side. Staging is exactly
        // the gesture that moves a row to the other section, so a one-sided check fails on
        // the very file the user just acted on: the selection would drop, the fallback below
        // would land on an unrelated file, and the diff header's Discard button would
        // silently re-arm for a file the user never selected.
        if (sel) {
          const here = (sel.staged ? entries.staged : entries.unstaged).some((e) => e.rel === sel.rel);
          if (!here) {
            const moved = (sel.staged ? entries.unstaged : entries.staged).some((e) => e.rel === sel.rel);
            sel = moved ? { rel: sel.rel, staged: !sel.staged } : null;
          }
        }
        if (!sel) { const first = entries.unstaged[0] || entries.staged[0]; if (first) sel = { rel: first.rel, staged: !entries.unstaged.length }; }
        paintRail();
        await loadDiff();
        await refreshRepoChip();
      }

      async function refreshRepoChip() {
        if (!repo) return;
        branchName.textContent = repo.branch || '(no commits)';
        branchChip.title = repo.detached ? 'Detached HEAD' : (repo.upstream || 'No upstream');
        // `pushing` must be ORed in: reload() calls this, and a stage/unstage/Refresh click
        // during the (network-bound, 5-30s) push would otherwise re-enable the button and
        // let a second concurrent `git push` fire against the same ref.
        pushBtn.disabled = pushing || !!repo.detached || !repo.branch;
        pushBtn.textContent = repo.upstream ? (repo.ahead ? 'Push ' + repo.ahead : 'Push') : 'Push -u';
      }

      // Re-resolve the repo from the trusted seed cwd (NOT repo.root — git:resolve
      // validates a session cwd, and the root is typically an un-allowlisted ancestor).
      // Returns true when `repo` was refreshed; an { error } sentinel leaves it intact
      // rather than clobbering repo.root and silently killing every later call.
      async function refreshRepo() {
        if (!seedCwd) return false;
        const info = await window.mavis.gitResolve(seedCwd);
        if (!alive()) return false;
        if (!info || info.error) return false;
        repo = info;
        return true;
      }

      async function loadRoot(cwd) {
        seedCwd = cwd;
        const info = await window.mavis.gitResolve(cwd);
        if (!alive()) return;
        if (!info || info.error) {
          repo = null;
          entries = { staged: [], unstaged: [] };
          pushBadge();   // clear the badge — a stale count from the previous repo would be a lie
          repoName.textContent = 'No repository';
          branchName.textContent = '-';
          rail.innerHTML = '';
          diffEl.innerHTML = '';
          diffEl.appendChild(el('div', 'mt-chg-empty', "This project isn't a git repository."));
          return;
        }
        repo = info;
        repoName.textContent = baseName(info.root);
        repoChip.title = info.root;
        sel = null;
        await reload();
      }

      function baseName(p) { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }

      refreshBtn.addEventListener('click', () => { if (repo) reload(); });

      // ---- diff ----
      const MODE = {
        js: { name: 'javascript' }, jsx: { name: 'javascript' }, mjs: { name: 'javascript' }, cjs: { name: 'javascript' },
        ts: { name: 'javascript', typescript: true }, tsx: { name: 'javascript', typescript: true },
        json: { name: 'javascript', json: true },
        css: 'css', scss: 'text/x-scss', less: 'text/x-less',
        html: 'htmlmixed', htm: 'htmlmixed', vue: 'htmlmixed', svelte: 'htmlmixed',
        xml: 'xml', svg: 'xml', md: 'markdown', markdown: 'markdown',
        py: 'python', php: 'php', java: 'text/x-java',
        c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src',
        sh: 'shell', bash: 'shell', ps1: 'powershell', psm1: 'powershell',
        yaml: 'yaml', yml: 'yaml', sql: 'sql', dart: 'dart',
      };
      function modeFor(name) {
        const b = String(name || ''); const i = b.lastIndexOf('.');
        return (i > 0 ? MODE[b.slice(i + 1).toLowerCase()] : null) || null;
      }

      // Highlight one line into `cell`. runMode hands us (text, styleClass) per token;
      // we append createTextNode / span — NEVER innerHTML with file content (same XSS
      // posture as md.js and pm-task.renderRich).
      function paintCode(cell, text, mode) {
        if (text == null) return;
        if (!mode || typeof window.CodeMirror !== 'function' || typeof window.CodeMirror.runMode !== 'function') {
          cell.appendChild(document.createTextNode(text));
          return;
        }
        try {
          window.CodeMirror.runMode(text, mode, (tok, style) => {
            if (style) {
              const s = document.createElement('span');
              // A CM style can be SPACE-SEPARATED ('variable-2 strong'); every class needs
              // the 'cm-' prefix or the trailing ones match nothing. Same as runmode.js:52.
              s.className = 'cm-' + String(style).replace(/ +/g, ' cm-');
              s.appendChild(document.createTextNode(tok));
              cell.appendChild(s);
            } else cell.appendChild(document.createTextNode(tok));
          });
        } catch (e) { cell.textContent = text; }
      }

      async function loadDiff() {
        diffEl.innerHTML = '';
        if (!repo || !sel) { diffEl.appendChild(el('div', 'mt-chg-empty', 'Select a file to see its diff.')); return; }
        const mySel = sel;
        const res = await window.mavis.gitDiff(repo.root, mySel.rel, mySel.staged);
        if (!alive() || sel !== mySel) return;              // superseded mid-await
        diffEl.innerHTML = '';

        const dh = el('div', 'mt-chg-diff-head');
        const name = mySel.rel.slice(mySel.rel.lastIndexOf('/') + 1);
        dh.appendChild(el('span', 'mt-chg-diff-name', name));
        dh.appendChild(el('span', 'mt-chg-diff-dir', mySel.rel));
        const dspacer = el('span', 'mt-chg-spacer'); dh.appendChild(dspacer);
        if (res && !res.error) {
          dh.appendChild(el('span', 'mt-chg-diff-stat add', '+' + (res.added || 0)));
          dh.appendChild(el('span', 'mt-chg-diff-stat del', '−' + (res.removed || 0)));
        }
        const discardBtn = el('button', 'mt-chg-btn danger', 'Discard'); discardBtn.type = 'button';
        discardBtn.addEventListener('click', () => doDiscard(mySel.rel, name));
        dh.appendChild(discardBtn);
        diffEl.appendChild(dh);

        // main returns an { error } sentinel, NOT a throw — handle it explicitly or a
        // failed diff renders as an empty (and misleading) "no changes" grid.
        if (!res || res.error) { diffEl.appendChild(el('div', 'mt-chg-empty', (res && res.error) || 'Could not read this diff.')); return; }
        if (res.binary) { diffEl.appendChild(el('div', 'mt-chg-empty', 'Binary file — not shown.')); return; }
        if (res.tooLarge) { diffEl.appendChild(el('div', 'mt-chg-empty', 'File too large to diff.')); return; }
        if (!res.hunks || !res.hunks.length) { diffEl.appendChild(el('div', 'mt-chg-empty', 'No textual changes.')); return; }

        const mode = modeFor(name);
        const scroll = el('div', 'mt-chg-scroll');
        // `cm-s-mavis` is load-bearing, not decoration: EVERY .cm-* colour rule in the app is
        // ancestor-scoped (files.css needs .cm-s-mavis, codemirror.css needs .cm-s-default).
        // Without it the runMode token spans match nothing, inherit --color-ash, and the whole
        // highlighting path renders flat monochrome. This class reuses files.css's palette,
        // including its nine-theme dark overrides.
        const grid = el('div', 'mt-chg-grid cm-s-mavis');
        // headers
        grid.appendChild(el('div', 'mt-chg-col-h', 'Old'));
        grid.appendChild(el('div', 'mt-chg-col-h', 'New'));
        res.hunks.forEach((h) => {
          const hh = el('div', 'mt-chg-hunk', h.header);
          hh.style.gridColumn = '1 / -1';
          grid.appendChild(hh);
          h.rows.forEach((r) => {
            grid.appendChild(cell(r, 'old', mode));
            grid.appendChild(cell(r, 'new', mode));
          });
        });
        scroll.appendChild(grid);
        diffEl.appendChild(scroll);

        if (res.truncated) {
          // No silent caps — say what was dropped.
          diffEl.appendChild(el('div', 'mt-chg-trunc', 'Diff truncated at ' + 4000 + ' rows. Open the file to see the rest.'));
        }
      }

      function cell(r, side, mode) {
        const isOld = side === 'old';
        const text = isOld ? r.oldText : r.newText;
        const num = isOld ? r.oldNum : r.newNum;
        // The column divider is an EXPLICIT class, never :nth-child(odd) — the grid also
        // holds 2 header cells and a full-width hunk bar per hunk, so child parity does
        // not track the old/new column and the border would land on the wrong cells.
        let cls = 'mt-chg-ln ' + (isOld ? 'side-old' : 'side-new');
        if (text === null) cls += ' gap';           // nothing on this side of the pair
        else if (r.type === 'ctx') cls += '';       // unchanged, no tint
        else if (isOld) cls += ' del';              // a non-null old cell in a change row is a removal
        else cls += ' add';                         // a non-null new cell in a change row is an addition
        const c = el('div', cls);
        c.appendChild(el('span', 'mt-chg-n', num == null ? '' : String(num)));
        const code = el('span', 'mt-chg-c');
        paintCode(code, text, mode);
        c.appendChild(code);
        return c;
      }

      // ---- actions ----
      // Commit is NOT confirmed: the button names the count, the message is on screen,
      // and it's reversible. Push and discard ARE (outward-facing / irreversible).
      async function doCommit() {
        if (!repo) return;
        const msg = state.message.trim();
        if (!msg || !entries.staged.length) return;
        const res = await window.mavis.gitCommit(repo.root, msg);
        if (!alive()) return;
        if (res && res.error) return fail(res.error);
        state.message = '';
        if (MT.toast) MT.toast.show({ title: 'Committed', body: (res.sha || '') + ' ' + msg.split('\n')[0], timeout: 3000 });
        await refreshRepo();          // refresh the ahead count
        if (!alive()) return;
        await reload();
      }

      async function doDiscard(rel, name) {
        if (!repo) return;
        const ok = await MT.confirm({
          title: 'Discard changes',
          message: 'Discard all changes to ' + name + '? This cannot be undone.',
          okLabel: 'Discard',
          danger: true,
        });
        if (!ok || !alive()) return;
        const res = await window.mavis.gitDiscard(repo.root, [rel]);
        if (!alive()) return;
        if (res && res.error) return fail(res.error);
        sel = null;
        await reload();
      }

      async function doPush() {
        if (pushing) return;                    // re-entry guard; the button state is not one
        if (!repo || !repo.branch || repo.detached) return;
        // The count is "local commits since the last fetch" — v1 has no fetch, so it is
        // NOT a claim about the remote's current state. Say so rather than assert.
        const n = repo.ahead || 0;
        const target = repo.upstream || ('origin/' + repo.branch);
        const msg = repo.upstream
          ? ('Push to ' + target + '? ' + n + ' local commit' + (n === 1 ? '' : 's') + ' since the last fetch.')
          : ('Push to origin/' + repo.branch + ' and set it as upstream?');
        const ok = await MT.confirm({ title: 'Push', message: msg, okLabel: 'Push', danger: false });
        if (!ok || !alive()) return;
        pushing = true;
        pushBtn.disabled = true;
        let res;
        try { res = await window.mavis.gitPush(repo.root); }
        finally { pushing = false; }
        if (!alive()) return;
        pushBtn.disabled = false;
        if (res && res.error) return fail(res.error);      // git's own text, e.g. non-fast-forward
        if (MT.toast) MT.toast.show({ title: 'Pushed', body: target, timeout: 3000 });
        await refreshRepo();
        if (!alive()) return;
        await refreshRepoChip();
      }

      async function doCheckout() {
        if (!repo) return;
        const b = await window.mavis.gitBranches(repo.root);
        if (!alive()) return;
        if (!b || b.error) return fail((b && b.error) || 'Could not list branches');
        const items = (b.list || []).filter((n) => n !== b.current);
        if (!items.length) return fail('No other branches');
        const pt = branchChip.getBoundingClientRect();
        MT.contextMenu.show(pt.left, pt.bottom + 4, items.map((n) => ({
          label: n,
          onClick: async () => {
            if (!repo || !alive()) return;
            const dirty = entries.staged.length + entries.unstaged.length;
            if (dirty) {
              const ok = await MT.confirm({
                title: 'Switch branch',
                message: 'Switch to ' + n + '? You have ' + dirty + ' uncommitted change' + (dirty === 1 ? '' : 's') + '.',
                okLabel: 'Switch',
                danger: false,
              });
              if (!ok || !alive()) return;
            }
            const res = await window.mavis.gitCheckout(repo.root, n);
            if (!alive()) return;
            // git refused (e.g. "local changes would be overwritten") -> show GIT'S text.
            // No auto-stash, no retry, no interpretation.
            if (res && res.error) return fail(res.error);
            await refreshRepo();
            if (!alive()) return;
            sel = null;
            await reload();
          },
        })));
      }

      pushBtn.addEventListener('click', doPush);
      branchChip.addEventListener('click', doCheckout);

      // ---- initial root: active session cwd, else nothing ----
      (async () => {
        const cwd = (MT.session && MT.session.activeCwd && MT.session.activeCwd()) || null;
        if (!alive()) return;
        if (!cwd) {
          repoName.textContent = 'No project';
          rail.appendChild(el('div', 'mt-chg-empty', 'Open a session to see its changes.'));
          return;
        }
        await loadRoot(cwd);
      })();

      // ---- re-root on session change (same poll as files-view; no event is exposed) ----
      let everConnected = false;
      let lastCwd = (MT.session && MT.session.activeCwd && MT.session.activeCwd()) || null;
      const poll = setInterval(() => {
        if (!alive()) { clearInterval(poll); return; }
        if (host.isConnected) everConnected = true;
        else if (everConnected) { clearInterval(poll); return; }
        else return;
        const cwd = (MT.session && MT.session.activeCwd && MT.session.activeCwd()) || null;
        if (cwd && cwd !== lastCwd) { lastCwd = cwd; loadRoot(cwd); }
      }, 1500);

      return Promise.resolve();
    },
  };
})();
