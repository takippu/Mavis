'use strict';

// MT.files — the Files view: a lazy file tree (left, ~260px) rooted at the active
// session's project dir, and a CodeMirror 5 viewer/editor (right). Reads/writes are
// scoped to `root` by the main-process fs-browser (path-confined); the renderer only
// ever touches file/path data via textContent/createElement and CodeMirror's setValue.
// Router-view contract: render(host, ctx) paints into the given host (a detached frag —
// never gate the paint on document.contains); the router appends it once resolved.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const icon = (name, size) => (MT.icons ? MT.icons.svg(name, size) : '');

  // static, data-free SVG glyphs (never fed file/path data → safe as innerHTML literals)
  const FILE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  const CARET_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>';
  const UP_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';

  // ---- paths (rel paths are always '/'-joined; root ('.') is the tree top) ----
  function baseName(p) { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(i + 1) : s; }
  function joinRel(parentRel, name) { return (!parentRel || parentRel === '.') ? name : parentRel + '/' + name; }
  function extOf(name) { const b = baseName(name); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; }
  function fmtSize(n) { const mb = (Number(n) || 0) / (1024 * 1024); return (mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round((Number(n) || 0) / 1024)) + ' KB'); }

  // ---- CodeMirror mode by extension (v1 curated set — see the spec mode map) ----
  const MODE = {
    js: { name: 'javascript' }, jsx: { name: 'javascript' }, mjs: { name: 'javascript' }, cjs: { name: 'javascript' },
    ts: { name: 'javascript', typescript: true }, tsx: { name: 'javascript', typescript: true },
    json: { name: 'javascript', json: true },
    css: 'css', scss: 'text/x-scss', less: 'text/x-less',
    html: 'htmlmixed', htm: 'htmlmixed', vue: 'htmlmixed', svelte: 'htmlmixed',
    xml: 'xml', svg: 'xml', xhtml: 'xml',
    md: 'markdown', markdown: 'markdown',
    py: 'python',
    php: 'php',
    c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', cc: 'text/x-c++src', cxx: 'text/x-c++src', hpp: 'text/x-c++src', java: 'text/x-java',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    ps1: 'powershell', psm1: 'powershell',
    yaml: 'yaml', yml: 'yaml',
    sql: 'sql',
    dart: 'dart',
  };
  function modeFor(name) { return MODE[extOf(name)] || null; }

  MT.files = {
    render(host, ctx) {
      // per-render token — a newer Files render supersedes this one (guards the async
      // root resolve, tree loads, and the re-root poll from acting after teardown).
      const token = (MT.files._seq = (MT.files._seq || 0) + 1);
      host.innerHTML = '';

      // view state (closure-scoped to this render)
      let root = null, rootName = '';
      let cm = null;                 // live CodeMirror instance, or null (placeholder / no file)
      let openRel = null, openName = '';
      let openRowEl = null;          // the selected tree row (for the selection + dirty marker)
      let dirty = false, lastSaved = '';

      // ---- shell: header + body (tree | editor) ----
      const wrap = el('div', 'mt-files');
      const head = el('div', 'mt-files-head');
      const rootChip = el('div', 'mt-files-root');
      const rootIco = el('span', 'mt-files-root-ico'); rootIco.innerHTML = icon('folder', 16);
      const rootLabel = el('span', 'mt-files-root-name', '…');
      rootChip.appendChild(rootIco); rootChip.appendChild(rootLabel);
      head.appendChild(rootChip);
      wrap.appendChild(head);

      const body = el('div', 'mt-files-body');
      const treeEl = el('div', 'mt-files-tree');
      const editorEl = el('div', 'mt-files-editor');
      body.appendChild(treeEl); body.appendChild(editorEl);
      wrap.appendChild(body);
      host.appendChild(wrap);

      // editor: header (filename + dirty + save) over the CodeMirror host / placeholder
      const edHead = el('div', 'mt-files-ed-head');
      const edName = el('span', 'mt-files-ed-name', 'No file open');
      const edStar = el('span', 'mt-files-ed-star', '*'); edStar.hidden = true;
      const saveBtn = el('button', 'mt-files-save', 'Save'); saveBtn.type = 'button'; saveBtn.hidden = true;
      saveBtn.title = 'Save (Ctrl S)';
      saveBtn.addEventListener('click', () => { doSave(); });
      edHead.appendChild(edName); edHead.appendChild(edStar);
      const edSpacer = el('span', 'mt-files-ed-spacer'); edHead.appendChild(edSpacer);
      edHead.appendChild(saveBtn);
      const edBody = el('div', 'mt-files-ed-body');
      editorEl.appendChild(edHead); editorEl.appendChild(edBody);
      showPlaceholder('Select a file to view.');

      // Ctrl/Cmd+S saves regardless of whether focus is in the tree or the editor
      // (CM5's default keymap doesn't bind Ctrl-S, so the event bubbles here cleanly).
      host.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); doSave(); }
      });

      // ---- dirty flag → filename star + tree-row marker + save button ----
      function setDirty(d) {
        dirty = !!d;
        edStar.hidden = !dirty;
        saveBtn.hidden = !dirty;
        if (openRowEl) openRowEl.classList.toggle('dirty', dirty);
      }

      // ---- editor mount / teardown ----
      function teardownCM() { cm = null; edBody.innerHTML = ''; }
      function showPlaceholder(msg) { teardownCM(); const p = el('div', 'mt-files-ed-empty', msg); edBody.appendChild(p); }
      function mountEditor(text, name) {
        edBody.innerHTML = '';
        const cmHost = el('div', 'mt-files-cm');
        edBody.appendChild(cmHost);
        if (typeof window.CodeMirror !== 'function') { showPlaceholder('Editor unavailable.'); return; }
        cm = window.CodeMirror(cmHost, {
          value: String(text == null ? '' : text),   // CM sets content via its API, never innerHTML
          mode: modeFor(name),
          lineNumbers: true,
          lineWrapping: false,
          theme: 'mavis',
          tabSize: 2,
        });
        lastSaved = cm.getValue();
        setDirty(false);
        cm.on('change', () => setDirty(cm.getValue() !== lastSaved));
        // let the flex layout settle, then refresh so CM measures its real height
        requestAnimationFrame(() => { if (cm) cm.refresh(); });
      }

      async function doSave() {
        if (!cm || !openRel || !dirty) return;
        const text = cm.getValue();
        try {
          const res = await window.mavis.filesWrite(root, openRel, text);
          if (!res || !res.ok) throw new Error('write-failed');
          lastSaved = text;
          setDirty(!!cm && text !== cm.getValue()); // may have kept typing during the await
          if (MT.toast) MT.toast.show({ title: 'Saved', body: openName, timeout: 2200 });
        } catch (err) {
          if (MT.toast) MT.toast.show({ title: 'Save failed', body: 'Could not write ' + openName, timeout: 5000 });
        }
      }

      // ---- open a file (guarding unsaved edits on switch) ----
      async function openFile(rel, rowEl, name) {
        if (rel === openRel) return;
        if (dirty) {
          const choice = await promptUnsaved(openName);
          if (choice === 'cancel') return;
          if (choice === 'save') { await doSave(); if (dirty) return; } // save failed → keep the current buffer
          // 'discard' → fall through and drop the edits
        }
        if (token !== MT.files._seq) return; // superseded while awaiting the prompt/save
        let res;
        try { res = await window.mavis.filesRead(root, rel); }
        catch (err) { selectRow(rowEl); openRel = rel; openName = name; edName.textContent = name; setDirty(false); showPlaceholder('Could not read this file.'); return; }
        if (token !== MT.files._seq) return;
        selectRow(rowEl);
        openRel = rel; openName = name;
        edName.textContent = name;
        setDirty(false);
        // main returns an { error } sentinel on failure (safeResolve throw / ENOENT / EACCES /
        // non-regular file), NOT a throw — the try/catch above never fires for it. Handle it here
        // so a failed read shows the placeholder instead of mounting an empty editable buffer.
        if (res && res.error) { showPlaceholder('Could not read this file.'); return; }
        if (res && res.binary) showPlaceholder('Binary file — not shown.');
        else if (res && res.tooLarge) showPlaceholder('File too large to edit' + (res.size ? ' (' + fmtSize(res.size) + ')' : '') + '.');
        else mountEditor(res ? res.text : '', name);
      }

      function selectRow(rowEl) {
        if (openRowEl) { openRowEl.classList.remove('selected', 'dirty'); }
        openRowEl = rowEl || null;
        if (openRowEl) openRowEl.classList.add('selected');
      }

      // ---- tree ----
      // Render one level into `container`. Entries arrive dirs-first then files (main sorts);
      // each dir lazily loads + caches its own children on first expand.
      function renderLevel(container, parentRel, depth, list) {
        container.innerHTML = '';
        const entries = (list && Array.isArray(list.entries)) ? list.entries : [];
        if (!entries.length) { container.appendChild(indentedEmpty(depth, 'empty')); }
        entries.forEach((entry) => {
          if (!entry || !entry.name) return;
          const rel = joinRel(parentRel, entry.name);
          if (entry.type === 'dir') container.appendChild(dirNode(rel, entry.name, depth));
          else container.appendChild(fileNode(rel, entry.name, depth));
        });
        if (list && list.truncated) container.appendChild(indentedEmpty(depth, '…more'));
      }

      function indentedEmpty(depth, text) {
        const n = el('div', 'mt-ftree-note', text);
        n.style.paddingLeft = padFor(depth) + 'px';
        return n;
      }
      function padFor(depth) { return 8 + depth * 14; }

      function dirNode(rel, name, depth) {
        const holder = el('div', 'mt-ftree-dir');
        const row = el('div', 'mt-ftree-row mt-ftree-dirrow');
        row.style.paddingLeft = padFor(depth) + 'px';
        row.setAttribute('role', 'button'); row.tabIndex = 0;
        const caret = el('span', 'mt-ftree-caret'); caret.innerHTML = CARET_SVG;
        const ic = el('span', 'mt-ftree-ico'); ic.innerHTML = icon('folder', 15);
        row.appendChild(caret); row.appendChild(ic); row.appendChild(el('span', 'mt-ftree-name', name));
        const kids = el('div', 'mt-ftree-children'); kids.hidden = true;
        let loaded = false, open = false, loading = false;
        const toggle = async () => {
          open = !open;
          holder.classList.toggle('open', open);
          kids.hidden = !open;
          if (open && !loaded && !loading) {
            loading = true;
            kids.appendChild(indentedEmpty(depth + 1, 'Loading…'));
            let res = null;
            try { res = await window.mavis.filesList(root, rel); } catch (err) { res = null; }
            loading = false;
            if (token !== MT.files._seq) return;
            loaded = true;
            if (res && res.error) res = null; // { error } sentinel from main → the error-note branch
            if (res) renderLevel(kids, rel, depth + 1, res);
            else { kids.innerHTML = ''; kids.appendChild(indentedEmpty(depth + 1, 'Could not read folder')); }
          }
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        holder.appendChild(row); holder.appendChild(kids);
        return holder;
      }

      function fileNode(rel, name, depth) {
        const row = el('div', 'mt-ftree-row mt-ftree-filerow');
        row.style.paddingLeft = padFor(depth) + 'px';
        row.setAttribute('role', 'button'); row.tabIndex = 0;
        row.appendChild(el('span', 'mt-ftree-caret')); // spacer, aligns with dir carets
        const ic = el('span', 'mt-ftree-ico'); ic.innerHTML = FILE_SVG;
        row.appendChild(ic); row.appendChild(el('span', 'mt-ftree-name', name));
        const open = () => openFile(rel, row, name);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        return row;
      }

      // ---- the `..` row — climb to the parent folder ----
      // NOT a listDir('../'): fs-browser confines every op to `root`, so ascending RE-ROOTS the
      // whole view and MAIN re-approves the new root (files:parent), ceiling'd at PROJECTS_ROOT.
      // filesParent doubles as the probe: an { error } answer means we're at the ceiling, so the
      // row simply isn't drawn rather than being drawn and doing nothing.
      let parentAbs = null;
      async function probeParent(forRoot) {
        try { const r = await window.mavis.filesParent(forRoot); return (r && !r.error && r.root) ? r.root : null; }
        catch { return null; }
      }
      function upNode() {
        const row = el('div', 'mt-ftree-row mt-ftree-uprow');
        row.style.paddingLeft = padFor(0) + 'px';
        row.setAttribute('role', 'button'); row.tabIndex = 0;
        row.title = parentAbs || '';
        row.appendChild(el('span', 'mt-ftree-caret'));       // spacer, aligns with dir carets
        const ic = el('span', 'mt-ftree-ico'); ic.innerHTML = UP_SVG;
        row.appendChild(ic);
        row.appendChild(el('span', 'mt-ftree-name', '..'));
        const go = async () => {
          if (!parentAbs) return;
          if (dirty) {                                        // same guard as switching files
            const choice = await promptUnsaved(openName);
            if (choice === 'cancel') return;
            if (choice === 'save') { await doSave(); if (dirty) return; }
          }
          if (token !== MT.files._seq) return;
          await loadRoot(parentAbs);
        };
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        return row;
      }

      // ---- (re)root the whole view at an absolute dir ----
      async function loadRoot(abs) {
        root = abs;
        rootName = baseName(abs) || abs;
        rootLabel.textContent = rootName;
        rootChip.title = abs;
        // a re-root belongs to the new project — reset the editor + selection
        openRel = null; openName = ''; edName.textContent = 'No file open';
        selectRow(null); setDirty(false); showPlaceholder('Select a file to view.');
        treeEl.innerHTML = '';
        const rootKids = el('div', 'mt-ftree-children');
        treeEl.appendChild(rootKids);
        rootKids.appendChild(indentedEmpty(0, 'Loading…'));
        let res = null;
        try { res = await window.mavis.filesList(root, '.'); } catch (err) { res = null; }
        if (token !== MT.files._seq) return;
        if (res && res.error) res = null; // { error } sentinel from main → the error-note branch
        if (res) renderLevel(rootKids, '.', 0, res);
        else { rootKids.innerHTML = ''; rootKids.appendChild(indentedEmpty(0, 'Could not read this folder.')); }
        // `..` on top, but only when main says an ascent is actually ALLOWED (probed per root, so
        // the row disappears at the ceiling instead of sitting there doing nothing). renderLevel
        // clears the container, so this has to come after it.
        const up = await probeParent(abs);
        // Two guards, both needed: the render token (a newer Files render superseded us), and the
        // root identity (a newer loadRoot for a DIFFERENT dir landed while we awaited — its probe
        // must win, and this stale one must not overwrite parentAbs or paint into its tree).
        if (token !== MT.files._seq || root !== abs) return;
        parentAbs = up;
        if (parentAbs) rootKids.insertBefore(upNode(), rootKids.firstChild);
      }

      function showNoRoot() {
        rootLabel.textContent = 'No project';
        treeEl.innerHTML = '';
        treeEl.appendChild(el('div', 'mt-empty', 'Open a session to browse its files.'));
      }

      // ---- resolve the initial root (active session cwd → brain-root fallback) ----
      (async () => {
        let abs = (MT.session && MT.session.activeCwd && MT.session.activeCwd()) || null;
        if (!abs) { try { abs = await window.mavis.filesRoot(); } catch (err) { abs = null; } }
        if (token !== MT.files._seq) return;
        if (abs) await loadRoot(abs);
        else showNoRoot();
      })();

      // ---- re-root when the active session/tab changes while the view is visible ----
      // No session-change event is exposed to the view, so poll activeCwd() lightly and
      // re-root on a real change. Tear down once this render is superseded or its host is
      // detached (navigated away). A re-root while there are unsaved edits is deferred to
      // a later tick so it never silently discards the buffer.
      let everConnected = false;
      // Follow the ACTIVE SESSION, and only when it actually moves. This used to re-root whenever
      // `cwd !== root`, which was fine when root could only ever BE a session cwd — but now that
      // `..` can re-root above it, that condition is permanently true after a climb and would yank
      // you straight back to the project folder within 1.5s. Tracking the last-seen cwd means an
      // ascent is left alone, while a real tab switch still re-roots.
      let lastCwd = (MT.session && MT.session.activeCwd && MT.session.activeCwd()) || null;
      const poll = setInterval(() => {
        if (token !== MT.files._seq) { clearInterval(poll); return; }
        if (host.isConnected) everConnected = true;
        else if (everConnected) { clearInterval(poll); return; }
        else return;
        if (dirty || !root) return;
        const cwd = (MT.session && MT.session.activeCwd && MT.session.activeCwd()) || null;
        if (cwd && cwd !== lastCwd) { lastCwd = cwd; loadRoot(cwd); }
      }, 1500);

      return Promise.resolve();
    },
  };

  // ---- unsaved-changes guard: save / discard / cancel ----
  // MT.confirm is boolean-only, so this three-way prompt is built here from the same
  // themed .mt-confirm-* primitives. Resolves 'save' | 'discard' | 'cancel'.
  function promptUnsaved(name) {
    return new Promise((resolve) => {
      const overlay = el('div', 'mt-confirm-overlay');
      const card = el('div', 'mt-confirm');
      card.setAttribute('role', 'alertdialog'); card.setAttribute('aria-modal', 'true');
      card.appendChild(el('div', 'mt-confirm-title', 'Unsaved changes'));
      card.appendChild(el('div', 'mt-confirm-msg', 'Save changes to ' + (name || 'this file') + ' before switching?'));
      const row = el('div', 'mt-confirm-actions');
      const cancel = el('button', 'mt-confirm-btn', 'Cancel'); cancel.type = 'button';
      const discard = el('button', 'mt-confirm-btn danger', 'Discard'); discard.type = 'button';
      const save = el('button', 'mt-confirm-btn primary', 'Save'); save.type = 'button';
      const finish = (v) => { document.removeEventListener('keydown', onKey, true); if (overlay.parentNode) overlay.parentNode.removeChild(overlay); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancel'); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish('save'); }
      };
      cancel.addEventListener('click', () => finish('cancel'));
      discard.addEventListener('click', () => finish('discard'));
      save.addEventListener('click', () => finish('save'));
      row.append(cancel, discard, save);
      card.appendChild(row);
      overlay.appendChild(card);
      overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish('cancel'); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => { overlay.classList.add('in'); save.focus(); });
    });
  }
})();
