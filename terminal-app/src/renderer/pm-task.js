'use strict';

// MT.pmTask — right-anchored slide-in sheet showing one project-board task in-app:
// description, subtasks (checklist + done state), comments, source request.
// Read-only. Header paints instantly from the board card; the body skeletons
// until GET /api/mcp/v1/tasks/<id> resolves. Esc / backdrop / × close it.
(function () {
  const MT = (window.MT = window.MT || {});
  const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
  const icon = (name, size) => (MT.icons ? MT.icons.svg(name, size) : '');

  // resolve a PM project name → a local brain project folder (for "Start work").
  // listProjects is cached in main, so this is cheap; cache it here per session too.
  let _brainProjects = null;
  // collapse runs of non-alnum to a single '-' (so "my-app" ≠ "myapp"), not strip-all
  const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  async function resolveProjectDir(projectName) {
    if (!projectName) return null;
    if (!_brainProjects) { try { _brainProjects = await window.mavis.listProjects(); } catch { _brainProjects = []; } }
    const target = normName(projectName);
    if (!target) return null;
    const hit = (Array.isArray(_brainProjects) ? _brainProjects : []).find((p) => p && p.dir && (normName(p.name) === target || normName(p.slug) === target));
    return hit ? { dir: hit.dir, label: hit.name } : null;
  }
  // drop the cached project list when the brain changes (new/renamed project)
  if (window.mavis && window.mavis.onBrainChanged) window.mavis.onBrainChanged(() => { _brainProjects = null; });

  let overlay = null;     // the live sheet node (identity = staleness guard)
  let prevFocus = null;
  let keyHandler = null;

  const STATUS_LABEL = { todo: 'To Do', doing: 'Doing', done: 'Done' };

  function relDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
    try { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return String(s); }
  }

  // The board stores task/CR descriptions (and some comments) as TipTap/ProseMirror
  // doc JSON. Render it to readable DOM — textContent/createElement throughout, never
  // innerHTML, so user content can't inject markup. Plain-text fallback if not a doc.
  // image embeds: the doc src is "/api/images/<key>" (web route, session-gated).
  // We can't <img> it directly, so fetch via main (Bearer) → data URL, async.
  function imageKeyFromSrc(src) {
    const m = String(src == null ? '' : src).match(/\/api\/images\/(.+)$/);
    return m ? m[1] : '';
  }
  function imageNode(attrs) {
    const key = imageKeyFromSrc(attrs && attrs.src);
    if (!key) return el('span', 'mt-prose-img', '[image]');
    const fig = el('div', 'mt-prose-figure');
    const ph = el('div', 'mt-prose-img', 'Loading image…');
    fig.appendChild(ph);
    const done = (res) => {
      if (res && res.ok && res.dataUrl) {
        const img = document.createElement('img');
        img.className = 'mt-prose-img-real';
        img.alt = attrs && attrs.alt ? String(attrs.alt) : 'image';
        img.src = res.dataUrl; // data: URL from our own Bearer-authed, image/*-checked fetch
        // click / Enter → open the zoomable lightbox (reuses the loaded data URL)
        img.title = 'Click to enlarge';
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.setAttribute('aria-label', (img.alt && img.alt !== 'image' ? img.alt + ' — ' : '') + 'view larger');
        const openViewer = () => { if (MT.imageViewer && MT.imageViewer.open) MT.imageViewer.open(res.dataUrl, img.alt); };
        img.addEventListener('click', openViewer);
        img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(); } });
        fig.innerHTML = '';
        fig.appendChild(img);
      } else {
        ph.textContent = '[image unavailable]';
      }
    };
    let p;
    try { p = window.mavis.pmImage ? window.mavis.pmImage(key) : Promise.resolve({ ok: false }); }
    catch { p = Promise.resolve({ ok: false }); }
    Promise.resolve(p).then(done).catch(() => done({ ok: false }));
    return fig;
  }

  function applyMarks(text, marks) {
    let node = document.createTextNode(text);
    (Array.isArray(marks) ? marks : []).forEach((m) => {
      const ty = m && m.type;
      let w;
      if (ty === 'bold' || ty === 'strong') w = document.createElement('strong');
      else if (ty === 'italic' || ty === 'em') w = document.createElement('em');
      else if (ty === 'code') w = document.createElement('code');
      else if (ty === 'link') { w = document.createElement('span'); w.className = 'mt-prose-link'; }
      else if (ty === 'strike') { w = document.createElement('s'); }
      else return;
      w.appendChild(node);
      node = w;
    });
    return node;
  }
  function inlineInto(parent, nodes) {
    (Array.isArray(nodes) ? nodes : []).forEach((n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'text') parent.appendChild(applyMarks(String(n.text == null ? '' : n.text), n.marks));
      else if (n.type === 'hardBreak') parent.appendChild(document.createElement('br'));
      else if (n.type === 'image') parent.appendChild(imageNode(n.attrs));
      else if (Array.isArray(n.content)) inlineInto(parent, n.content);
    });
  }
  function blockInto(parent, node) {
    if (!node || typeof node !== 'object') return;
    const t = node.type;
    if (t === 'paragraph') { const p = el('p', 'mt-prose-p'); inlineInto(p, node.content); parent.appendChild(p); }
    else if (t === 'heading') { const h = el('div', 'mt-prose-h'); inlineInto(h, node.content); parent.appendChild(h); }
    else if (t === 'bulletList' || t === 'orderedList') {
      const list = document.createElement(t === 'orderedList' ? 'ol' : 'ul');
      list.className = 'mt-prose-list';
      (Array.isArray(node.content) ? node.content : []).forEach((li) => {
        const item = document.createElement('li');
        (Array.isArray(li.content) ? li.content : []).forEach((c) => blockInto(item, c));
        list.appendChild(item);
      });
      parent.appendChild(list);
    }
    else if (t === 'blockquote') { const bq = el('blockquote', 'mt-prose-quote'); (Array.isArray(node.content) ? node.content : []).forEach((c) => blockInto(bq, c)); parent.appendChild(bq); }
    else if (t === 'codeBlock') { const pre = el('pre', 'mt-prose-code'); inlineInto(pre, node.content); parent.appendChild(pre); }
    else if (t === 'image') parent.appendChild(imageNode(node.attrs));
    else if (Array.isArray(node.content)) node.content.forEach((c) => blockInto(parent, c));
    else if (node.text) parent.appendChild(document.createTextNode(String(node.text)));
  }
  function renderRich(str) {
    const s = String(str == null ? '' : str);
    let doc = null;
    if (s.charAt(0) === '{') { try { doc = JSON.parse(s); } catch { doc = null; } }
    if (doc && doc.type === 'doc' && Array.isArray(doc.content)) {
      const wrap = el('div', 'mt-prose');
      doc.content.forEach((n) => blockInto(wrap, n));
      return wrap; // a valid doc renders (blank if empty) — never dump raw JSON
    }
    return el('div', 'mt-sheet-prose', s); // plain text (or a non-doc string)
  }

  function statusChip(status) {
    const c = el('span', 'mt-status-chip');
    const dot = el('span', 'mt-status-dot s-' + (STATUS_LABEL[status] ? status : 'other'));
    c.appendChild(dot);
    c.appendChild(el('span', null, STATUS_LABEL[status] || status || 'unknown'));
    return c;
  }

  function sectionLabel(text, trailing) {
    const h = el('div', 'mt-sheet-sec-head');
    h.appendChild(el('span', 'mt-label', text));
    if (trailing != null) h.appendChild(el('span', 'mt-sheet-sec-count', String(trailing)));
    return h;
  }

  function factsRow(task) {
    const facts = [];
    if (task.assignee) facts.push(['Assignee', task.assignee]);
    if (task.category) facts.push(['Category', task.subcategory ? task.category + ' · ' + task.subcategory : task.category]);
    if (task.priority) facts.push(['Priority', task.priority]);
    if (task.branch) facts.push(['Branch', task.branch]);
    if (task.dueDate) facts.push(['Due', relDate(task.dueDate)]);
    if (!facts.length) return null;
    const wrap = el('div', 'mt-sheet-facts');
    facts.forEach(([k, v]) => {
      const f = el('div', 'mt-fact');
      f.appendChild(el('span', 'mt-fact-k', k));
      f.appendChild(el('span', 'mt-fact-v', v));
      wrap.appendChild(f);
    });
    return wrap;
  }

  function subtasksSection(list) {
    const sec = el('div', 'mt-sheet-section');
    const done = list.filter((c) => c.isCompleted).length;
    sec.appendChild(sectionLabel('Subtasks', list.length ? done + '/' + list.length : ''));
    if (!list.length) { sec.appendChild(el('div', 'mt-empty', 'No subtasks.')); return sec; }
    const ul = el('div', 'mt-checklist');
    list.forEach((c) => {
      const row = el('div', 'mt-check' + (c.isCompleted ? ' done' : ''));
      const ico = el('span', 'mt-check-ico');
      ico.innerHTML = icon(c.isCompleted ? 'checkSquare' : 'square', 17);
      row.appendChild(ico);
      row.appendChild(el('span', 'mt-check-text', c.content));
      ul.appendChild(row);
    });
    sec.appendChild(ul);
    return sec;
  }

  function commentsSection(list) {
    if (!list.length) return null;
    const sec = el('div', 'mt-sheet-section');
    sec.appendChild(sectionLabel('Comments', list.length));
    list.forEach((cm) => {
      const c = el('div', 'mt-comment');
      const head = el('div', 'mt-comment-head');
      head.appendChild(el('span', 'mt-comment-author', cm.author));
      if (cm.createdAt) head.appendChild(el('span', 'mt-comment-when', relDate(cm.createdAt)));
      c.appendChild(head);
      c.appendChild(renderRich(cm.content));
      sec.appendChild(c);
    });
    return sec;
  }

  function sourceSection(cr) {
    if (!cr) return null;
    const sec = el('div', 'mt-sheet-section');
    sec.appendChild(sectionLabel('Source request'));
    const head = el('div', 'mt-source-head');
    if (cr.code) head.appendChild(el('span', 'mt-type-pill', cr.code));
    if (cr.status) head.appendChild(statusChip(cr.status));
    sec.appendChild(head);
    if (cr.title) sec.appendChild(el('div', 'mt-source-title', cr.title));
    if (cr.description) sec.appendChild(renderRich(cr.description));
    return sec;
  }

  function skeletonBody() {
    const wrap = el('div');
    const sk = (w, h, mt) => (MT.skeleton ? MT.skeleton.bar(w, h, mt) : el('div'));
    wrap.appendChild(el('div', 'mt-label', 'Description'));
    ['100%', '94%', '72%'].forEach((w, i) => wrap.appendChild(sk(w, '12px', i ? '8px' : '10px')));
    const l = el('div', 'mt-label', 'Subtasks'); l.style.marginTop = '24px'; wrap.appendChild(l);
    ['82%', '66%', '76%'].forEach((w) => wrap.appendChild(sk(w, '15px', '11px')));
    return wrap;
  }

  function errorBody(res, onRetry) {
    const wrap = el('div');
    const reason = res && res.reason;
    const msg = reason === 'not-found' ? 'This task no longer exists on the board.'
      : reason === 'unauthorized' ? 'Token rejected — update it in Settings.'
      : 'Couldn’t reach the PM API.';
    wrap.appendChild(el('div', 'mt-empty', msg));
    if (reason !== 'not-found' && reason !== 'unauthorized') {
      const retry = el('button', 'mt-pill', 'Retry');
      retry.style.marginTop = '8px';
      retry.addEventListener('click', onRetry);
      wrap.appendChild(retry);
    }
    return wrap;
  }

  function renderSections(body, task) {
    body.innerHTML = '';
    const facts = factsRow(task);
    if (facts) body.appendChild(facts);

    const desc = el('div', 'mt-sheet-section');
    desc.appendChild(sectionLabel('Description'));
    if (task.description) desc.appendChild(renderRich(task.description));
    else desc.appendChild(el('div', 'mt-empty', 'No description.'));
    body.appendChild(desc);

    body.appendChild(subtasksSection(task.checklist));
    const comments = commentsSection(task.comments);
    if (comments) body.appendChild(comments);
    const source = sourceSection(task.sourceCr);
    if (source) body.appendChild(source);
  }

  function fillBody(item, body, node) {
    body.innerHTML = '';
    body.appendChild(skeletonBody());
    const done = (res) => {
      if (overlay !== node) return; // closed or replaced while awaiting
      if (!res || !res.ok) { body.innerHTML = ''; body.appendChild(errorBody(res, () => fillBody(item, body, node))); return; }
      renderSections(body, res.task);
    };
    let p;
    try { p = window.mavis.pmTask(item.id); } catch { p = Promise.reject(); }
    Promise.resolve(p).then(done).catch(() => done({ ok: false, reason: 'network' }));
  }

  function focusables(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('button, a[href], input, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  function close() {
    if (!overlay) return;
    if (MT.imageViewer && MT.imageViewer.close) MT.imageViewer.close(); // close any open lightbox too
    const node = overlay;
    const handler = keyHandler;
    const pf = prevFocus;
    overlay = null; keyHandler = null; prevFocus = null;
    if (handler) document.removeEventListener('keydown', handler, true);
    node.classList.remove('in');
    // remove AFTER the .22s slide-out completes (240 > 220ms); a fixed timeout
    // also covers prefers-reduced-motion, where transitionend would never fire.
    setTimeout(() => { if (node && node.parentNode) node.remove(); }, 240);
    if (pf && typeof pf.focus === 'function') pf.focus();
  }

  function open(item) {
    if (!item || !item.id) return;
    if (overlay) close();

    prevFocus = document.activeElement;
    const node = el('div', 'mt-sheet-overlay');
    const sheet = el('div', 'mt-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Task details' + (item.code ? ' — ' + item.code : ''));

    // header (instant, from the board card)
    const head = el('div', 'mt-sheet-head');
    const topRow = el('div', 'mt-sheet-toprow');
    const chips = el('div', 'mt-sheet-chips');
    if (item.code) chips.appendChild(el('span', 'mt-type-pill', item.code));
    chips.appendChild(statusChip(item.status));
    topRow.appendChild(chips);

    // No "Open in browser" link: the task detail carries no task URL and the board has
    // no /tasks/<id> page (tasks open as modals on the board) — there is no valid
    // deep-link, and the whole point of this sheet is to read the detail in-app.
    const actions = el('div', 'mt-sheet-actions');
    const closeBtn = el('button', 'mt-icon-btn');
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close task details');
    closeBtn.innerHTML = icon('close', 16);
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    // "Start work" — open a Mavis session in the task's project folder (if it maps to one)
    resolveProjectDir(item.project).then((proj) => {
      if (!proj || overlay !== node) return;
      const sw = el('button', 'mt-sheet-startwork');
      sw.type = 'button';
      sw.title = 'Start a Mavis session in ' + proj.label;
      sw.innerHTML = icon('play', 14) + '<span>Start work</span>';
      // MT.openProject (app.js), not MT.session.open directly — it's the same "open a project tab"
      // call with nothing PM-specific about it, and going through it is what applies the per-session
      // harness picker's current pick (a direct MT.session.open call bypasses that entirely and
      // always falls back to the global default, silently ignoring whatever the user picked).
      sw.addEventListener('click', () => { if (MT.openProject) MT.openProject({ cwd: proj.dir, label: item.code || item.title }); close(); });
      actions.insertBefore(sw, closeBtn);
    }).catch(() => { /* noop */ });
    topRow.appendChild(actions);
    head.appendChild(topRow);

    head.appendChild(el('div', 'mt-sheet-title', item.title));
    const metaBits = [item.project, item.phase].filter(Boolean);
    if (metaBits.length) head.appendChild(el('div', 'mt-sheet-meta', metaBits.join(' · ')));
    sheet.appendChild(head);

    const body = el('div', 'mt-sheet-body');
    sheet.appendChild(body);
    node.appendChild(sheet);

    node.addEventListener('click', (e) => { if (e.target === node) close(); });
    // Capture-phase Esc closes the sheet — but if the image lightbox is open on top,
    // defer to it (it handles its own Esc first). Both listen on document-capture and
    // the sheet's was registered first, so an explicit isOpen() check is the robust
    // way to order them (see memory: window-keydown-listener-ordering).
    keyHandler = (e) => {
      if (e.key === 'Escape') {
        if (MT.imageViewer && MT.imageViewer.isOpen && MT.imageViewer.isOpen()) return;
        e.stopPropagation(); e.preventDefault(); close();
      }
      else if (e.key === 'Tab') {
        const f = focusables(sheet);
        if (!f.length) { e.preventDefault(); return; } // keep focus inside the dialog
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyHandler, true);

    document.body.appendChild(node);
    overlay = node;
    requestAnimationFrame(() => { if (overlay === node) node.classList.add('in'); });
    closeBtn.focus();
    fillBody(item, body, node);
  }

  MT.pmTask = { open, close, isOpen: () => !!overlay };
})();
