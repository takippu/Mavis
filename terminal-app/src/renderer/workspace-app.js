'use strict';
// Persistent project workspace. DOM visibility never owns a model or a PTY lifecycle.
(() => {
  const MT = window.MT, api = window.mavis, monaco = window.mavisEditor;
  // Monaco cancels pending language work when an editor group is disposed.
  window.addEventListener('unhandledrejection', event => { if (event.reason?.name === 'Canceled' || event.reason?.message === 'Canceled') event.preventDefault(); });
  const projects = new Map(), terminalRoutes = new Map();
  let activeId = null, globalView = null, globalArg, sidebarCollapsed = false, inspectorVisible = false, focusedGroup = 0, persistTimer, closePending = false;
  let memoryScope = 'project'; const memoryViews = ['daily', 'topics', 'character', 'ops', 'mavis-identity', 'mavis-rules'];
  let projectCatalog = [], colorSequence = 0, defaultAgent = 'claude';
  let preferences = { editorFontSize: 14, terminalFontSize: 14, wordWrap: 'off', showHidden: true }, available = [], dragId, booting = true, pmEnabled = false;
  const app = document.getElementById('app'); app.replaceChildren(); document.getElementById('mt-loader')?.remove();
  document.body.classList.toggle('mac', api.platform === 'darwin');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (text, action, icon) => { const b = el('button', 'ws-button'); b.type = 'button'; if (icon) b.innerHTML = MT.icons.svg(icon, 16); if (text) b.append(el('span', '', text)); b.setAttribute('aria-label', text || ({ toggleHidden: 'Show or hide hidden files', newFile: 'New file', sidebar: 'Toggle sidebar', terminal: 'Toggle terminal', inspector: 'Toggle project details' })[action] || action); b.title = b.getAttribute('aria-label'); b.addEventListener('click', () => safe(() => run(action))); return b; };
  const ws = () => projects.get(activeId);
  const call = async (action, payload = {}) => { const r = await api.workspace(action, payload); if (r?.error) throw Object.assign(new Error(r.error), { code: r.code }); return r; };
  function safe(fn) { return Promise.resolve().then(fn).catch(error => { status.textContent = error.message; return message('Could not complete action', error.message); }); }
  const toolbar = el('header', 'ws-toolbar'), title = el('div', 'ws-title', 'maviscode'), subtitle = el('small', '', 'Your project workspace'); title.append(subtitle);
  const brand = el('img', 'ws-brand'); brand.src = './assets/mavis-logo.png'; brand.alt = ''; toolbar.append(button('', 'sidebar', 'sidebar'), brand, title, button('Save', 'save', 'save'), button('', 'terminal', 'terminal'), button('', 'inspector', 'info'));
  if (api.platform !== 'darwin') { const min = button('−', 'minimize'); const max = button('□', 'maximize'); const close = button('×', 'windowClose'); toolbar.append(min, max, close); }
  const projectStrip = el('nav', 'ws-projects'); projectStrip.setAttribute('aria-label', 'Project tabs');
  const shell = el('div', 'ws-shell'), sidebar = el('aside', 'ws-sidebar'), nav = el('nav', 'ws-nav'), treeHost = el('div', 'ws-tree'), main = el('main', 'ws-main'), inspector = el('aside', 'ws-inspector');
  sidebar.setAttribute('aria-label', 'Mavis navigation'); nav.setAttribute('aria-label', 'Sections'); const projectNav = el('nav', 'ws-project-nav'), memoryNav = el('nav', 'ws-memory-nav'); sidebar.append(nav, projectNav, memoryNav, treeHost);
  const footer = el('footer', 'ws-footer'), branch = el('span', '', 'Mavis'), changes = el('span'), language = el('span'), status = el('span', 'ws-status', 'Ready'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); footer.append(branch, changes, language, status);
  const globalHost = el('section', 'ws-page'); globalHost.hidden = true; main.append(globalHost);
  const inspectorDivider = divider('vertical', size => { inspector.style.width = Math.max(180, Math.min(440, size)) + 'px'; }, () => inspector.offsetWidth, true, 'Resize project details');
  shell.append(sidebar, divider('vertical', size => { sidebar.style.width = Math.max(150, Math.min(360, size)) + 'px'; }, () => sidebar.offsetWidth), main, inspectorDivider, inspector);
  app.append(toolbar, projectStrip, shell, footer);
  const navButtons = new Map();
  for (const [host, items] of [[nav, [['Projects','projects','projects'],['Memory','memory','book'],['Settings','settings','settings']]], [projectNav, [['Files','files','files'],['Search','search','search'],['Changes','changes','git-branch']]], [memoryNav, [['Daily Log','daily','calendar'],['Topics','topics','book'],['Character','character','user'],['Daily Ops','ops','check']]]]) {
    for (const [text,action,icon] of items) { const b = button(text,action,icon); navButtons.set(action,b); host.append(b); }
  }
  memoryNav.hidden = true;
  function divider(direction, apply, size, reverse = false, label = 'Resize sidebar') {
    const d = el('div', 'ws-divider' + (direction === 'horizontal' ? ' horizontal' : '')); d.tabIndex = 0; d.setAttribute('role', 'separator'); d.setAttribute('aria-label', direction === 'horizontal' && label === 'Resize sidebar' ? 'Resize terminal panel' : label); d.setAttribute('aria-valuemin', '80'); d.setAttribute('aria-valuemax', '1000'); d.setAttribute('aria-valuenow', String(size() || 244)); d.setAttribute('aria-orientation', direction);
    d.addEventListener('pointerdown', e => { const start = direction === 'horizontal' ? e.clientY : e.clientX, old = size(); d.setPointerCapture(e.pointerId); d.setAttribute('aria-valuenow', String(size())); const move = ev => apply(old + (direction === 'horizontal' ? (reverse ? ev.clientY - start : start - ev.clientY) : (reverse ? start - ev.clientX : ev.clientX - start))); const end = () => { d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', end); persist(); }; d.addEventListener('pointermove', move); d.addEventListener('pointerup', end); });
    d.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); apply(size() + (['ArrowRight', 'ArrowUp'].includes(e.key) ? 20 : -20)); d.setAttribute('aria-valuenow', String(size())); persist(); } }); return d;
  }
  function dialog({ title, text, input, choices = ['Cancel', 'OK'], body }) {
    return new Promise(resolve => {
      const previous = document.activeElement, overlay = el('div', 'ws-dialog-overlay'), box = el('section', 'ws-dialog'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title); box.append(el('h2', '', title)); if (text) box.append(el('p', '', text));
      let field; if (input !== undefined) { field = el('input', 'ws-input'); field.value = input; field.setAttribute('aria-label', title); box.append(field); }
      if (body) box.append(body);
      const row = el('div', 'ws-dialog-actions');
      const finish = choice => { overlay.remove(); document.removeEventListener('keydown', key, true); previous?.focus?.(); resolve({ choice, value: field?.value }); };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(choices[0]); } else if (e.key === 'Tab') { const nodes = [...box.querySelectorAll('button,input,select,[tabindex="0"]')]; const i = nodes.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); nodes.at(-1)?.focus(); } else if (!e.shiftKey && i === nodes.length - 1) { e.preventDefault(); nodes[0]?.focus(); } } };
      choices.forEach((c, i) => { const b = el('button', 'ws-button' + (i === choices.length - 1 ? ' ws-primary' : ''), c); b.type = 'button'; b.onclick = () => finish(c); row.append(b); }); box.append(row); overlay.append(box); app.append(overlay); document.addEventListener('keydown', key, true); (field || row.firstChild).focus();
    });
  }
  function actionMenu(anchor, items) { const rect = anchor.getBoundingClientRect(); MT.contextMenu.show(rect.left, rect.bottom + 4, items.map(item => { if (Array.isArray(item)) item = { label: item[0], onClick: item[1] }; return item.separator ? item : { ...item, onClick: () => safe(item.onClick) }; })); }
  const revealLabel = api.platform === 'darwin' ? 'Reveal in Finder' : api.platform === 'win32' ? 'Reveal in File Explorer' : 'Reveal in File Manager';
  async function location(target, action) {
    const result = await call('location', { ...target, action });
    if (action.startsWith('copy')) status.textContent = 'Copied ' + (action === 'copyRelative' ? 'relative' : 'full') + ' path';
    return result;
  }
  async function projectActions(anchor, project, workspace) {
    const w = workspace || [...projects.values()].find(w => project.slug && w.slug === project.slug);
    const target = w && !w.missing ? { id: w.id } : { slug: project.slug };
    const available = await location(target, 'resolve').then(r => r.available).catch(() => false);
    if (!anchor.isConnected) return;
    actionMenu(anchor, [
      { label: w ? 'Switch to Project' : 'Open Project', icon: 'folder', onClick: () => w ? activate(w.id) : MT.openProject(project) },
      ...(project.slug ? [{ label: 'Project Details', icon: 'info', onClick: () => showGlobal('detail', project.slug) }] : []),
      { separator: true },
      { label: revealLabel, icon: 'external', enabled: available, onClick: () => location(target, 'reveal') },
      { label: 'Copy Full Path', icon: 'copy', enabled: available, onClick: () => location(target, 'copyFull') },
      ...(w && !w.missing ? [{ separator: true }, { label: 'Close Project', icon: 'close', onClick: () => closeProject(w) }] : []),
    ]);
  }
  const message = (title, text) => dialog({ title, text, choices: ['OK'] });
  function renderTabs() {
    updateProjectControls();
    projectStrip.replaceChildren();
    for (const w of projects.values()) {
      const tab = el('div', 'ws-project-tab' + (w.id === activeId && !globalView ? ' active' : '')); tab.draggable = true;
      const color = MT.workspaceData.projectColor(w, projectCatalog, api.platform);
      if (color) { tab.classList.add('colored'); tab.style.setProperty('--project-color', color); }
      const activity = w.terminals.some(t => t.signal === 'await') ? ' · Needs input' : w.terminals.some(t => t.signal === 'busy') ? ' · Working' : '';
      const b = el('button', 'ws-button', w.name + (Array.from(w.docs.values()).some(d => d.dirty) ? ' •' : '') + activity); b.type = 'button'; b.setAttribute('aria-pressed', String(w.id === activeId && !globalView)); b.onclick = () => { w.rememberedGlobal = null; safe(() => activate(w.id)); };
      if (color) { const dot = el('span', 'ws-project-color'); dot.setAttribute('aria-hidden', 'true'); b.prepend(dot); }
      b.title = w.name + (color ? ' · Project colour: ' + color : '');
      b.onkeydown = e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const ids = [...projects.keys()]; safe(() => activate(ids[(ids.indexOf(w.id) + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length])); } };
      const more = el('button', 'ws-button ws-close'); more.innerHTML = MT.icons.svg('more', 14); more.type = 'button'; more.title = 'Project actions'; more.setAttribute('aria-label', 'Actions for project ' + w.name); more.onclick = () => safe(() => projectActions(more, w, w));
      tab.oncontextmenu = event => { event.preventDefault(); safe(() => projectActions(more, w, w)); };
      const c = el('button', 'ws-button ws-close'); c.innerHTML = MT.icons.svg('close', 14); c.type = 'button'; c.setAttribute('aria-label', 'Close project ' + w.name); c.onclick = () => safe(() => closeProject(w)); tab.append(b, more, c);
      tab.ondragstart = () => { dragId = w.id; }; tab.ondragover = e => e.preventDefault(); tab.ondrop = e => { e.preventDefault(); if (!dragId || dragId === w.id) return; const order = [...projects.values()]; const moved = projects.get(dragId); const next = order.filter(x => x.id !== dragId); next.splice(next.findIndex(x => x.id === w.id), 0, moved); projects.clear(); next.forEach(x => projects.set(x.id, x)); renderTabs(); persist(); };
      projectStrip.append(tab);
    }
    const opener = button('', 'projects', 'plus');
    opener.title = 'Open Project'; opener.setAttribute('aria-label', 'Open Project');
    projectStrip.append(opener);
  }
  async function refreshProjectColors() {
    const sequence = ++colorSequence;
    try { const list = await api.listProjects(); if (sequence !== colorSequence || !Array.isArray(list)) return; projectCatalog = list; renderTabs(); }
    catch { /* Keep the last known colours during a temporary read failure. */ }
  }
  window.addEventListener('mavis-project-color', event => {
    const { slug, color } = event.detail || {}; const project = projectCatalog.find(p => p.slug === slug);
    if (project) { ++colorSequence; project.color = color; renderTabs(); }
    else refreshProjectColors();
  });
  function updateProjectControls() {
    const ready = !!ws() && !ws().missing;
    for (const name of ['files', 'search', 'changes']) navButtons.get(name).hidden = !ready;
    projectNav.hidden = !ready || !!globalView; memoryNav.hidden = !memoryViews.includes(globalView);
    const d = ws()?.docs.get((ws()?.groups[focusedGroup] || ws()?.groups[0])?.file);
    const save = toolbar.querySelector('[aria-label=Save]'); save.disabled = !!globalView || !d || d.kind !== 'text' || !d.dirty || !!d.saving; save.title = save.disabled ? 'No unsaved editable file' : 'Save file (⌘S)';
    toolbar.querySelector('[aria-label="Toggle project details"]').setAttribute('aria-pressed', String(inspectorVisible && !globalView));
    const details = toolbar.querySelector('[aria-label="Toggle project details"]'); details.disabled = !ready || !!globalView;
    const terminal = toolbar.querySelector('[aria-label="Toggle terminal"]');
    terminal.setAttribute('aria-pressed', String(ready && ws().terminalVisible && !globalView)); terminal.disabled = !ready; terminal.title = ready ? 'Show terminal or start a shell' : 'Open a project to use terminals';
  }
  updateProjectControls();
  function snapshot() {
    for (const w of projects.values()) for (const g of w.groups) if (g.file) g.states[g.file] = g.editor.saveViewState();
    return { version: 3, activeId, sidebarCollapsed, sidebarWidth: sidebar.offsetWidth, inspectorVisible, inspectorWidth: inspector.offsetWidth, preferences, uiVersion: 2, memoryScope,
      workspaces: [...projects.values()].map(w => ({
        id: w.id, root: w.root, name: w.name, slug: w.slug, view: w.view, file: w.file, focusedGroup: w.focusedGroup || 0, rememberedGlobal: w.rememberedGlobal,
        documents: [...w.docs.values()].map(d => ({ rel: d.rel })), groups: w.groups.map(g => ({ file: g.file, viewStates: g.states, width: g.host.offsetWidth })),
        terminals: w.terminals.map(t => ({ id: t.id, kind: t.kind, label: t.label, cwd: t.cwd, share: t.share })), activeTerminal: w.activeTerminal,
        terminalVisible: w.terminalVisible, terminalHeight: w.terminalHeight, terminalPosition: w.terminalPosition, terminalSplit: w.terminalSplit, splitDirection: w.splitDirection,
        expanded: [...w.expanded], legacyLayouts: w.legacyLayouts,
      })) };
  }
  function persist() { if (booting) return; clearTimeout(persistTimer); persistTimer = setTimeout(() => safe(() => call('persist', snapshot())), 250); }
  async function flush() { clearTimeout(persistTimer); await Promise.all([...projects.values()].flatMap(w => [...w.docs.values()].filter(d => d.dirty).map(d => recovery(w, d)))); await call('persist', snapshot()); }
  function recovery(w, d) { clearTimeout(d.recoveryTimer); return call('recovery', { id: w.id, rel: d.rel, snapshot: d.dirty ? { text: d.model.getValue(), revision: d.revision, bom: d.bom, eol: d.eol, modelVersion: d.model.getVersionId() } : null }); }
  async function openProject(input = {}) {
    const res = await call('open', input); if (res.cancelled) return;
    if (!booting && !MT.workspaceData.projectColor(res, projectCatalog, api.platform)) await refreshProjectColors();
    if (projects.has(res.id)) { const w = projects.get(res.id); await activate(res.id); if (!booting && !input.restore) await openProjectTerminal(w); return; }
    const w = createWorkspace(res, input.saved || {}); projects.set(w.id, w); await activate(w.id); persist();
    w.rememberedGlobal = ['daily', 'topics', 'character', 'ops'].includes(input.saved?.rememberedGlobal) ? input.saved.rememberedGlobal : null;
    for (const doc of input.saved?.documents || []) await openFile(w, doc.rel, false).catch(e => { status.textContent = e.message; });
    if (input.saved?.groups?.length) { for (let i = 0; i < Math.min(2, input.saved.groups.length); i++) { if (i && !w.groups[i]) createGroup(w); Object.assign(w.groups[i].states, input.saved.groups[i].viewStates || {}); const file = input.saved.groups[i].file; if (w.docs.has(file)) showDocument(w, file, i); } }
    w.focusedGroup = input.saved?.focusedGroup || 0;
    if (w.groups.length === 2 && input.saved?.groups[0]?.width >= 180) w.groups[0].host.style.flex = '0 0 ' + Math.max(180, Math.min(input.saved.groups[0].width, w.editorArea.clientWidth - 180)) + 'px';
    w.file = input.saved?.file || w.file; if (w.file && w.docs.has(w.file)) showDocument(w, w.file);
    showWorkspaceView(w); renderTabs();
    if (!booting && !input.restore) await openProjectTerminal(w);
  }
  async function openProjectTerminal(w) {
    if (w.agentOpening) return w.agentOpening;
    w.agentOpening = (async () => {
      const agents = w.terminals.filter(t => t.kind !== 'shell');
      const live = agents.find(t => t.kind === defaultAgent && t.ptyId) || agents.find(t => t.ptyId);
      if (live) { w.activeTerminal = live.id; w.terminalVisible = true; renderTerminals(w); updateProjectControls(); fit(w); live.term?.focus(); persist(); return; }
      const previous = agents.find(t => t.kind === defaultAgent);
      await newTerminal(w, defaultAgent, previous);
    })();
    try { await w.agentOpening; } finally { w.agentOpening = null; }
  }
  function createWorkspace(meta, saved) {
    const w = { ...meta, docs: new Map(), groups: [], terminals: [], expanded: new Set(saved.expanded || ['.']), view: saved.view || 'files', file: null, activeTerminal: saved.activeTerminal, terminalVisible: saved.terminalVisible !== false, terminalHeight: saved.terminalHeight || 200, terminalPosition: saved.terminalPosition || 'bottom', terminalSplit: saved.terminalSplit || false, splitDirection: saved.splitDirection || 'row', legacyLayouts: saved.legacyLayouts, sequence: 0 };
    w.host = el('section', 'ws-project-host'); w.host.setAttribute('aria-label', w.name + ' workspace'); w.body = el('div', 'ws-project-body'); w.editorArea = el('div', 'ws-edit-area'); w.page = el('section', 'ws-page'); w.page.hidden = true;
    w.body.append(w.editorArea, w.page); w.host.append(w.body); main.append(w.host);
    createGroup(w);
    w.termHost = el('section', 'ws-terminals'); w.termHost.setAttribute('aria-label', w.name + ' terminals'); w.termBar = el('div', 'ws-terminal-bar'); w.termPanes = el('div', 'ws-terminal-panes'); w.termHost.append(w.termBar, w.termPanes);
    w.termDivider = divider('horizontal', size => { w.terminalHeight = Math.max(80, Math.min(500, size)); w.termHost.style.height = w.terminalHeight + 'px'; fit(w); }, () => w.termHost.offsetHeight);
    w.body.append(w.termDivider, w.termHost);
    for (const savedTerm of saved.terminals || []) w.terminals.push({ ...savedTerm, id: savedTerm.id || crypto.randomUUID(), status: 'restored', restored: true });
    renderTerminals(w); renderFileTabs(w); displayDocument(w, w.groups[0], null); return w;
  }
  function createGroup(w) {
    const g = { file: w.file, states: {}, host: el('div', 'ws-group'), tabs: el('div', 'ws-files'), crumb: el('div', 'ws-crumb'), editorHost: el('div', 'ws-editor') };
    g.editorHost.id = 'editor-' + crypto.randomUUID(); g.editorHost.setAttribute('role', 'tabpanel');
    g.previewHost = el('section', 'ws-image-preview'); g.previewHost.id = 'preview-' + crypto.randomUUID(); g.previewHost.setAttribute('role', 'tabpanel'); g.previewHost.hidden = true; g.previewHost.tabIndex = 0;
    g.tabs.setAttribute('aria-label', 'Open files'); g.tabs.setAttribute('role', 'tablist'); g.empty = el('section', 'ws-editor-empty'); g.empty.append(el('h2', '', w.name), el('p', '', 'Choose a file in the sidebar to start editing.'), button('Open File…', 'quickOpen', 'file'), button('New File', 'newFile', 'plus')); g.host.append(g.tabs, g.crumb, g.empty, g.editorHost, g.previewHost);
    g.host.addEventListener('focusin', () => { focusedGroup = w.groups.indexOf(g); w.focusedGroup = focusedGroup; w.file = g.file; api.setTerminalFocused(false); });
    if (w.groups.length) { g.divider = divider('vertical', size => { const first = w.groups[0]; first.host.style.flex = '0 0 ' + Math.max(180, Math.min(w.editorArea.clientWidth - 180, size)) + 'px'; fit(w); }, () => w.groups[0].host.offsetWidth, false, 'Resize editor groups'); w.editorArea.append(g.divider); }
    w.editorArea.append(g.host); w.groups.push(g);
    g.editor = monaco.editor.create(g.editorHost, { model: null, automaticLayout: true, fontSize: preferences.editorFontSize, fontFamily: 'SFMono-Regular, Menlo, monospace', lineHeight: 24, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 8 }, wordWrap: preferences.wordWrap, tabSize: 2, renderLineHighlight: 'none', overviewRulerBorder: false });
    g.editor.onDidFocusEditorText(() => { focusedGroup = w.groups.indexOf(g); w.focusedGroup = focusedGroup; api.setTerminalFocused(false); });
    g.editor.onDidChangeCursorPosition(e => { if (w.id === activeId) language.textContent = `${g.editor.getModel()?.getLanguageId() || ''} · ${e.position.lineNumber}:${e.position.column}`; });
    return g;
  }
  async function activate(id) {
    if (projects.get(id)?.missing) return locateMissing(projects.get(id));
    activeId = id; globalView = null; globalHost.hidden = true; for (const w of projects.values()) if (w.host) w.host.hidden = w.id !== id;
    const w = ws(); focusedGroup = w?.focusedGroup || 0; subtitle.textContent = w?.name || 'Your project workspace'; renderTabs(); if (w) { await renderTree(w); showWorkspaceView(w); renderInspector(w); updateStatus(w); fit(w); if (w.rememberedGlobal) await showGlobal(w.rememberedGlobal); } persist();
  }
  function updateNav(view) { for (const [name, b] of navButtons) b.setAttribute('aria-pressed', String(name === view || (name === 'character' && ['mavis-identity','mavis-rules'].includes(view)) || (name === 'memory' && memoryViews.includes(view)))); updateProjectControls(); }
  function updateStatus(w) { branch.textContent = w.branch || w.name; changes.textContent = [...w.docs.values()].filter(d => d.dirty).length + ' unsaved'; status.textContent = w.root; }
  function renderInspector(w) {
    inspectorDivider.hidden = !inspectorVisible;
    inspector.hidden = !inspectorVisible; inspector.replaceChildren(el('h3', '', 'Mavis'), el('div', 'ws-label', 'Project context'), el('p', '', w.slug ? 'Memory linked to ' + w.slug : 'This folder has no linked Mavis project.'), button('Notes and progress', 'overview', 'book'), button('Daily Log', 'daily', 'calendar'), button('Topics', 'topics', 'book'), el('div', 'ws-label', 'Current file'), el('p', '', w.file || 'No file selected'), el('div', 'ws-label', 'Project folder'), el('p', '', w.root));
  }
  async function renderTree(w) {
    if (w.id !== activeId || globalView) return;
    const seq = w.treeSeq = (w.treeSeq || 0) + 1; treeHost.replaceChildren(); treeHost.hidden = w.view !== 'files'; if (treeHost.hidden) return;
    const heading = el('div', 'ws-root-name', w.name); const menu = button('', 'explorerMenu', 'more'); menu.setAttribute('aria-label', 'Project folder actions'); menu.title = 'Project folder actions'; heading.append(menu, button('', 'newFile', 'plus')); treeHost.append(heading);
    const content = el('div'); treeHost.append(content);
    async function directory(rel, depth, host) {
      let list; try { list = await call('list', { id: w.id, rel }); } catch (e) { host.append(el('p', '', e.message)); return; }
      if (seq !== w.treeSeq || w.id !== activeId) return;
      for (const entry of list.entries) {
        if (!preferences.showHidden && entry.name.startsWith('.')) continue;
        const name = rel === '.' ? entry.name : rel + '/' + entry.name; const row = el('div', 'ws-tree-row'); row.style.paddingLeft = depth * 12 + 'px';
        const b = el('button', 'ws-button'); b.type = 'button'; b.innerHTML = MT.icons.svg(entry.type === 'dir' ? (w.expanded.has(name) ? 'chevron-down' : 'chevron-right') : 'file', 14); b.append(el('span', 'ws-tree-name', entry.name)); b.setAttribute('aria-label', name); b.setAttribute('aria-pressed', String(w.file === name));
        if (entry.type === 'dir') b.setAttribute('aria-expanded', String(w.expanded.has(name))); b.title = name; b.onclick = () => safe(async () => { if (entry.type === 'dir') { w.expanded.has(name) ? w.expanded.delete(name) : w.expanded.add(name); await renderTree(w); persist(); } else await openFile(w, name); });
        const more = el('button', 'ws-button ws-more'); more.innerHTML = MT.icons.svg('more', 14); more.type = 'button'; more.title = 'File and folder actions'; more.setAttribute('aria-label', 'Actions for ' + name); more.onclick = () => fileActions(more, w, name, entry.type); row.oncontextmenu = event => { event.preventDefault(); fileActions(more, w, name, entry.type); }; row.append(b, more); host.append(row);
        if (entry.type === 'dir' && w.expanded.has(name)) await directory(name, depth + 1, host);
      }
      if (list.truncated) host.append(el('p', '', 'More than 2,000 entries. Use Search to find files.'));
    }
    await directory('.', 0, content);
  }
  function languageFor(rel) { const ext = rel.split('.').at(-1).toLowerCase(); return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', css: 'css', scss: 'scss', html: 'html', vue: 'html', md: 'markdown', py: 'python', php: 'php', sh: 'shell', yaml: 'yaml', yml: 'yaml', sql: 'sql', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', swift: 'swift' })[ext] || 'plaintext'; }
  async function openFile(w, rel, select = true, line) {
    w.loading ||= new Map();
    if (w.loading.has(rel)) { await w.loading.get(rel); if (w.docs.has(rel)) return openFile(w, rel, select, line); return; }
    if (!w.docs.has(rel)) {
      let finishLoad; w.loading.set(rel, new Promise(resolve => { finishLoad = resolve; }));
      try {
      const recovered = await call('recovery', { id: w.id, rel });
      const read = await call('read', { id: w.id, rel }).catch(e => { if (recovered && e.code === 'ENOENT') return { text: '', revision: null, missing: true, bom: recovered.bom, eol: recovered.eol }; throw e; }); if (read.unsupported && !read.preview) return message(rel, read.unsupported);
      let text = read.preview?.text || read.text || '', dirty = false;
      if (!read.preview && recovered && recovered.text !== read.text) { const answer = await dialog({ title: 'Recover unsaved edits?', text: w.name + ' / ' + rel + '\nAn unsaved local copy is available.', choices: ['Cancel', 'Discard recovery', 'Recover'] }); if (answer.choice === 'Cancel') return; if (answer.choice === 'Recover') { text = recovered.text; dirty = true; } else await call('recovery', { id: w.id, rel, snapshot: null }); }
      if (!projects.has(w.id)) return;
      const model = monaco.editor.createModel(text, read.preview ? 'plaintext' : languageFor(rel), monaco.Uri.parse('mavis:///' + w.id + '/' + rel.split('/').map(encodeURIComponent).join('/')));
      model.setEOL(read.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      const d = { rel, model, kind: read.preview?.kind || 'text', preview: read.preview, size: read.size, previewReason: read.unsupported, revision: recovered && dirty ? recovered.revision : read.revision, baseText: read.text, bom: read.bom, eol: read.eol, dirty, conflict: recovered && dirty && recovered.revision !== read.revision ? read : null };
      d.subscription = model.onDidChangeContent(() => { if (d.reloading || d.kind !== 'text') return; d.dirty = model.getValue() !== d.baseText; clearTimeout(d.recoveryTimer); d.recoveryTimer = setTimeout(() => safe(() => recovery(w, d)), 700); renderFileTabs(w); renderTabs(); updateStatus(w); persist(); }); w.docs.set(rel, d);
      } finally { w.loading.delete(rel); finishLoad(); }
    }
    if (select) { w.view = 'files'; w.file = rel; showDocument(w, rel); if (w.id === activeId) { globalView = null; globalHost.hidden = true; w.host.hidden = false; showWorkspaceView(w); renderTree(w); renderInspector(w); } }
    else if (!w.file) w.file = rel;
    if (line) { const g = w.groups[focusedGroup] || w.groups[0]; g.editor.setPosition({ lineNumber: line, column: 1 }); g.editor.revealLineInCenter(line); }
    renderFileTabs(w); persist();
  }
  function showDocument(w, rel, groupIndex = focusedGroup) {
    const g = w.groups[groupIndex] || w.groups[0], d = w.docs.get(rel); if (!d) return;
    if (g.file) g.states[g.file] = g.editor.saveViewState(); g.file = rel; w.file = rel;
    displayDocument(w, g, d);
    if (g.states[rel] && d.kind !== 'image') g.editor.restoreViewState(g.states[rel]);
    (d.kind === 'image' ? g.previewHost : g.editor).focus(); renderFileTabs(w); renderConflict(w, d); updateProjectControls(); if (w.id === activeId && !globalView) safe(() => renderTree(w)); persist();
  }
  function fileSize(size) { return size < 1024 ? size + ' B' : size < 1024 * 1024 ? (size / 1024).toFixed(1) + ' KiB' : (size / 1024 / 1024).toFixed(1) + ' MiB'; }
  function displayDocument(w, g, d) {
    g.previewHost.replaceChildren(); g.previewHost.hidden = d?.kind !== 'image'; g.editorHost.hidden = d?.kind === 'image';
    g.empty.hidden = !!d; g.editorHost.hidden = !d || d.kind === 'image'; g.editor.setModel(d && d.kind !== 'image' ? d.model : null); g.editor.updateOptions({ readOnly: !!d && d.kind !== 'text' });
    if (!d) return;
    g.crumb.textContent = w.name + ' / ' + d.rel + ' · ' + (d.kind === 'text' ? d.eol + ' · UTF-8' : 'Read-only · ' + fileSize(d.size));
    if (d.kind === 'binary') { g.crumb.textContent += ' · ' + (d.previewReason || 'Byte preview') + (d.preview.truncated ? ' Showing first 64 KiB.' : ''); return; }
    if (d.kind !== 'image') return;
    g.previewHost.setAttribute('aria-label', 'Image preview: ' + d.rel);
    const bar = el('div', 'ws-preview-bar'), info = el('span', 'ws-preview-info', 'Loading image…'), canvas = el('div', 'ws-image-canvas'), img = el('img', 'ws-preview-image');
    img.alt = d.rel; img.draggable = false;
    const fit = el('button', 'ws-button', 'Fit'), actual = el('button', 'ws-button', '100%'); fit.type = actual.type = 'button';
    const zoom = natural => { canvas.classList.toggle('actual-size', natural); fit.setAttribute('aria-pressed', String(!natural)); actual.setAttribute('aria-pressed', String(natural)); };
    fit.onclick = () => zoom(false); actual.onclick = () => zoom(true); zoom(false);
    img.onload = () => { info.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' px · ' + fileSize(d.size) + ' · Read-only'; };
    img.onerror = () => { info.textContent = 'This image could not be decoded · ' + fileSize(d.size); img.hidden = true; canvas.append(el('p', 'ws-preview-error', 'The image is damaged or its format is unsupported.')); };
    img.src = d.preview.dataUrl; bar.append(info, fit, actual); canvas.append(img); g.previewHost.append(bar, canvas);
  }
  function renderFileTabs(w) {
    for (const g of w.groups) {
      g.tabs.replaceChildren();
      for (const d of w.docs.values()) {
        const item = el('div', 'ws-file' + (g.file === d.rel ? ' active' : '')), b = el('button', 'ws-button', d.rel.split('/').at(-1) + (d.dirty ? ' •' : '')); b.type = 'button'; b.title = d.rel; b.id = 'tab-' + crypto.randomUUID(); b.setAttribute('aria-controls', d.kind === 'image' ? g.previewHost.id : g.editorHost.id); if (g.file === d.rel) { g.editorHost.setAttribute('aria-labelledby', b.id); g.previewHost.setAttribute('aria-labelledby', b.id); } b.tabIndex = g.file === d.rel ? 0 : -1; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(g.file === d.rel)); b.setAttribute('aria-pressed', String(g.file === d.rel)); b.onclick = () => showDocument(w, d.rel, w.groups.indexOf(g));
        b.onkeydown = e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const names = [...w.docs.keys()]; showDocument(w, names[(names.indexOf(d.rel) + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length], w.groups.indexOf(g)); } };
        const close = el('button', 'ws-button'); close.innerHTML = MT.icons.svg('close', 14); close.type = 'button'; close.setAttribute('aria-label', 'Close ' + d.rel); close.onclick = () => safe(() => closeDocument(w, d)); item.append(b, close); item.draggable = true;
        item.ondragstart = e => e.dataTransfer.setData('text/x-mavis-file', d.rel); item.ondragover = e => e.preventDefault(); item.ondrop = e => { e.preventDefault(); const name = e.dataTransfer.getData('text/x-mavis-file'); if (!w.docs.has(name)) return; const ordered = [...w.docs.keys()].filter(x => x !== name); ordered.splice(ordered.indexOf(d.rel), 0, name); const docs = ordered.map(x => [x, w.docs.get(x)]); w.docs = new Map(docs); renderFileTabs(w); persist(); }; g.tabs.append(item);
      }
      g.tabs.hidden = !w.docs.size; g.crumb.hidden = !w.docs.size;
      if (!w.docs.size) { g.crumb.textContent = 'Open a file from the sidebar or press ' + (api.platform === 'darwin' ? '⌘P' : 'Ctrl+P'); }
    }
  }
  function renderConflict(w, d) {
    w.notice?.remove(); if (!d.conflict) return;
    const n = el('div', 'ws-notice'); n.append(el('span', '', 'This file changed on disk. Your edits are preserved.'));
    for (const [text, fn] of [['Compare', () => compare(w, d.conflict.text || '', d.model.getValue(), d.rel + ' · disk → unsaved editor')], ['Keep editing', () => { n.remove(); w.groups[w.focusedGroup || 0]?.editor.focus(); }], ['Reload', async () => { if ((await dialog({ title: 'Reload from disk?', text: 'Discard local edits to ' + d.rel + '?', choices: ['Cancel', 'Reload'] })).choice === 'Reload') { d.reloading = true; d.model.setValue(d.conflict.text || ''); d.reloading = false; d.revision = d.conflict.revision; d.baseText = d.model.getValue(); d.kind = d.conflict.preview?.kind || 'text'; d.preview = d.conflict.preview; d.size = d.conflict.size; d.previewReason = d.conflict.unsupported; if (d.preview) d.model.setValue(d.preview.text || ''); d.dirty = false; d.conflict = null; for (const g of w.groups) if (g.file === d.rel) displayDocument(w, g, d); await recovery(w, d); renderConflict(w, d); renderFileTabs(w); } }], ['Overwrite…', async () => { if ((await dialog({ title: 'Overwrite disk version?', text: 'Replace the displayed disk revision with your local edits to ' + d.rel + '?', choices: ['Cancel', 'Overwrite'] })).choice === 'Overwrite') await saveDocument(w, d, d.conflict.revision); }]]) { const b = el('button', 'ws-button', text); b.onclick = () => safe(fn); n.append(b); }
    w.body.prepend(n); w.notice = n;
  }
  async function saveDocument(w, d, override) {
    if (!d) return true; if (d.kind !== 'text') { status.textContent = 'Read-only preview · ' + d.rel; return true; } const version = d.model.getVersionId(), text = d.model.getValue(); d.saving = true; updateProjectControls();
    let res; try { res = await call('save', { id: w.id, rel: d.rel, text, revision: override === undefined ? d.revision : override, bom: d.bom, modelVersion: version }); } finally { d.saving = false; updateProjectControls(); }
    if (!res.ok) { d.conflict = res.disk || await call('read', { id: w.id, rel: d.rel }).catch(() => ({ missing: true, revision: null })); renderConflict(w, d); status.textContent = res.message; return false; }
    d.revision = res.revision; d.baseText = text; d.conflict = null; d.dirty = d.model.getVersionId() !== version; await recovery(w, d); renderConflict(w, d); renderFileTabs(w); renderTabs(); updateStatus(w); status.textContent = 'Saved ' + d.rel; return true;
  }
  async function resolveDirty(w, docs) {
    const dirty = docs.filter(d => d.dirty); if (!dirty.length) return true;
    const answer = await dialog({ title: 'Unsaved changes', text: w.name + '\n' + dirty.map(d => d.rel).join('\n'), choices: ['Cancel', 'Discard', 'Save all'] });
    if (answer.choice === 'Cancel') return false;
    if (answer.choice === 'Save all') { for (const d of dirty) if (!await saveDocument(w, d) || d.dirty) return false; }
    else for (const d of dirty) { clearTimeout(d.recoveryTimer); await call('recovery', { id: w.id, rel: d.rel, snapshot: null }); d.dirty = false; }
    return true;
  }
  async function closeDocument(w, d) {
    if (!await resolveDirty(w, [d])) return; clearTimeout(d.recoveryTimer); d.subscription.dispose(); w.docs.delete(d.rel);
    for (const g of w.groups) if (g.file === d.rel) { g.file = w.docs.keys().next().value || null; displayDocument(w, g, w.docs.get(g.file)); }
    d.model.dispose(); w.file = w.groups[0].file; renderFileTabs(w); renderTabs(); persist();
  }
  async function closeProject(w) {
    if (w.terminals.some(t => t.ptyId) && (await dialog({ title: 'Close project?', text: 'Running terminals in ' + w.name + ' will stop.', choices: ['Cancel', 'Close project'] })).choice !== 'Close project') return;
    if (!await resolveDirty(w, [...w.docs.values()])) return;
    await call('close', { id: w.id }); for (const t of w.terminals) { terminalRoutes.delete(t.ptyId); t.term?.dispose(); }
    for (const g of w.groups) g.editor.dispose(); w.diff?.dispose(); w.diffModels?.forEach(m => m.dispose());
    for (const d of w.docs.values()) { clearTimeout(d.recoveryTimer); d.subscription.dispose(); d.model.dispose(); } w.host.remove(); projects.delete(w.id);
    activeId = projects.keys().next().value || null; if (activeId) await activate(activeId); else await showGlobal('projects'); renderTabs(); await flush();
  }
  function fit(w) {
    requestAnimationFrame(() => { for (const g of w.groups) g.editor.layout(); w.diff?.layout(); for (const t of w.terminals) if (t.term && t.host?.offsetWidth && t.host?.offsetHeight) { try { t.fit.fit(); if (t.ptyId) api.resize(t.ptyId, t.term.cols, t.term.rows); } catch {} } });
  }
  function termTheme() { const s = getComputedStyle(document.documentElement); return { background: s.getPropertyValue('--ws-bg').trim(), foreground: s.getPropertyValue('--ws-text').trim() }; }
  function actualTheme() { const dark = getComputedStyle(document.documentElement).colorScheme === 'dark' || (getComputedStyle(document.documentElement).colorScheme === 'light dark' && matchMedia('(prefers-color-scheme: dark)').matches); return dark ? { background: '#202124', foreground: '#ededf0', cursor: '#74b1ff', selectionBackground: '#32435b' } : { background: '#ffffff', foreground: '#24262b', cursor: '#1768c5', selectionBackground: '#dce9fa' }; }
  async function newTerminal(w, kind = 'shell', restored) {
    if (!w) return run('open');
    const t = restored || { id: crypto.randomUUID(), kind, label: kind === 'shell' ? 'Shell' : kind === 'claude' ? 'Claude' : 'Codex', cwd: w.root, status: 'starting' };
    if (!restored) w.terminals.push(t);
    t.term ||= new Terminal({ fontSize: preferences.terminalFontSize, fontFamily: 'SFMono-Regular, Menlo, monospace', lineHeight: 1.35, theme: actualTheme(), scrollback: 3000, allowProposedApi: false, linkHandler: MT.terminalInteractions.createOscLinkHandler(url => api.openExternal(url)) });
    if (!t.fit) { t.fit = new FitAddon.FitAddon(); t.term.loadAddon(t.fit); }
    if (!t.host) {
      t.host = el('div', 'ws-terminal'); t.caption = el('div', 'ws-terminal-label', t.cwd); t.xterm = el('div', 'ws-xterm'); t.host.append(t.caption, t.xterm); w.termPanes.append(t.host); t.term.open(t.xterm);
      t.term.onData(data => { if (t.ptyId) api.sendInput(t.ptyId, data); else if (data === '\r') safe(() => newTerminal(w, t.kind, t)); });
      wireTerminal(w, t);
      t.xterm.addEventListener('focusin', () => { w.activeTerminal = t.id; api.setTerminalFocused(true); });
      t.xterm.addEventListener('focusout', () => setTimeout(() => api.setTerminalFocused(!!document.activeElement?.classList.contains('xterm-helper-textarea')), 0));
    }
    w.activeTerminal = t.id; w.terminalVisible = true; t.status = 'starting'; renderTerminals(w);
    t.autorunSent = false;
    const res = await call('terminal', { id: w.id, kind: t.kind, label: t.label, cwd: t.cwd, cols: t.term.cols, rows: t.term.rows }).catch(e => ({ ok: false, reason: e.message }));
    if (!projects.has(w.id)) { if (res.id) await call('terminalClose', { id: w.id, terminalId: res.id }).catch(() => {}); return; }
    if (!res.ok) { t.status = 'exited'; t.term.write('\r\n' + (res.reason || 'Could not start terminal.') + '\r\nPress Enter to retry.\r\n'); }
    else { t.ptyId = res.id; t.status = 'running'; t.restored = false; t.autorun = res.autorun; terminalRoutes.set(res.id, { w, t }); }
    renderTerminals(w); fit(w); t.term.focus(); persist();
  }
  function wireTerminal(w, t) {
    const send = data => { if (t.ptyId) api.sendInput(t.ptyId, data); };
    const copy = () => navigator.clipboard.writeText(t.term.getSelection()).catch(e => { status.textContent = e.message; });
    const pasteText = async () => { const text = await navigator.clipboard.readText(); if (text) t.term.paste(text); };
    const paste = () => safe(async () => {
      if (await api.clipboardHasImage()) { const image = await api.clipboardPasteImage(); if (image?.path) { t.term.paste(image.path + ' '); status.textContent = 'Attached image: ' + image.path; } }
      else await pasteText();
    });
    t.term.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true;
      if (MT.terminalInteractions.handlePlainSpace(e, send)) return false;
      if (t.kind === 'codex' && MT.terminalInteractions.handleCodexAltArrow(e, send)) return false;
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && t.kind !== 'shell') { e.preventDefault(); send('\x1b\r'); return false; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'c' && t.term.hasSelection()) { e.preventDefault(); copy(); return false; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return false; }
      return true;
    });
    t.xterm.addEventListener('contextmenu', e => {
      e.preventDefault(); MT.contextMenu.show(e.clientX, e.clientY, [
        { label: 'Copy', enabled: t.term.hasSelection(), onClick: copy },
        { label: 'Paste', onClick: paste },
        { label: 'Select all', onClick: () => t.term.selectAll() },
        { label: 'Clear', onClick: () => t.term.clear() },
        { separator: true },
        { label: 'Suggested commands', enabled: !!t.ptyId && t.kind !== 'shell', onClick: () => MT.suggestedCommands.open({ ptyId: t.ptyId, label: w.name + ' / ' + t.label }) },
      ]);
    });
  }
  function renderTerminals(w) {
    w.termHost.hidden = !w.terminalVisible; w.termDivider.hidden = !w.terminalVisible || w.terminalPosition === 'right'; w.termHost.style.height = w.terminalPosition === 'right' ? '' : w.terminalHeight + 'px'; w.host.classList.toggle('side', w.terminalPosition === 'right');
    const tabs = el('div', 'ws-terminal-tabs'), actions = el('div', 'ws-terminal-actions');
    w.termBar.replaceChildren(tabs, actions);
    w.termPanes.querySelectorAll('.ws-terminal-divider').forEach(d => d.remove());
    for (const t of w.terminals) {
      const b = el('button', 'ws-button', t.label + (t.status === 'restored' ? ' · Start' : t.status === 'exited' ? ' · Exited' : '')); b.type = 'button'; b.title = t.kind + ' terminal · ' + (t.cwd || w.root); b.setAttribute('aria-pressed', String(w.activeTerminal === t.id));
      b.onclick = () => safe(async () => { w.activeTerminal = t.id; if (!t.term) await newTerminal(w, t.kind, t); else { renderTerminals(w); fit(w); t.term.focus(); } }); tabs.append(b);
      if (t.host) t.host.hidden = !w.terminalSplit && t.id !== w.activeTerminal;
    }
    const control = (label, icon, fn) => { const b = el('button', 'ws-button'); b.type = 'button'; b.innerHTML = MT.icons.svg(icon, 16); b.title = label; b.setAttribute('aria-label', label); b.onclick = () => safe(() => fn(b)); return b; };
    const add = control('New terminal', 'plus', b => actionMenu(b, ['shell', ...available].map(kind => ({ label: kind === 'shell' ? 'Shell' : kind === 'claude' ? 'Claude' : 'Codex', icon: 'terminal', onClick: () => newTerminal(w, kind) }))));
    const split = control(w.terminalSplit ? 'Unsplit terminals' : 'Split terminal', 'split', async () => { if (!w.terminalSplit && w.terminals.length < 2) await newTerminal(w, 'shell'); w.terminalSplit = !w.terminalSplit; renderTerminals(w); fit(w); persist(); });
    const more = control('Terminal actions', 'more', b => {
      const selected = w.terminals.find(t => t.id === w.activeTerminal);
      const arrange = direction => { w.splitDirection = direction; w.terminalSplit = true; renderTerminals(w); fit(w); persist(); };
      actionMenu(b, [
        { label: 'Arrange side by side', enabled: w.terminals.length >= 2, onClick: () => arrange('row') },
        { label: 'Stack terminals', enabled: w.terminals.length >= 2, onClick: () => arrange('col') },
        { label: w.terminalPosition === 'right' ? 'Move panel to bottom' : 'Move panel to right', onClick: () => { w.terminalPosition = w.terminalPosition === 'right' ? 'bottom' : 'right'; renderTerminals(w); fit(w); persist(); } },
        { label: 'Rename terminal…', enabled: !!selected, onClick: async () => { const r = await dialog({ title: 'Terminal name', input: selected.label, choices: ['Cancel', 'Rename'] }); if (r.choice === 'Rename' && r.value.trim()) { selected.label = r.value.trim(); renderTerminals(w); persist(); } } },
        { label: 'Close terminal…', enabled: !!selected, danger: true, onClick: () => closeTerminal(w, selected) },
      ]);
    });
    const hide = control('Hide terminal panel', 'close', () => { w.terminalVisible = false; renderTerminals(w); fit(w); persist(); });
    actions.append(add, split, more, hide); w.termPanes.classList.toggle('vertical', w.splitDirection === 'col'); updateProjectControls();
    w.termPanes.querySelector('.ws-empty')?.remove();
    const panes = w.terminals.filter(t => t.host && !t.host.hidden);
    for (let i = 1; i < panes.length; i++) {
      const first = panes[i - 1], horizontal = w.splitDirection === 'col';
      if (first.share && w.terminalSplit) first.host.style.flex = '0 0 ' + (first.share * 100) + '%';
      const resize = divider(horizontal ? 'horizontal' : 'vertical', size => {
        const total = horizontal ? w.termPanes.clientHeight : w.termPanes.clientWidth;
        first.share = Math.max(.15, Math.min(.75, size / total)); first.host.style.flex = '0 0 ' + (first.share * 100) + '%'; fit(w);
      }, () => horizontal ? first.host.offsetHeight : first.host.offsetWidth, horizontal);
      resize.classList.add('ws-terminal-divider'); w.termPanes.insertBefore(resize, panes[i].host);
    }
    if (!w.terminalSplit) for (const t of panes) t.host.style.flex = '';

    if (!w.terminals.length) { const empty = el('div', 'ws-empty', 'Open a shell or agent terminal for this project.'); empty.append(button('New Terminal', 'shell', 'terminal')); w.termPanes.append(empty); }
  }
  async function closeTerminal(w, t) {
    if (!t) return; if (t.ptyId && (await dialog({ title: 'Close terminal?', text: t.label + '\nThe running process will stop.', choices: ['Cancel', 'Close terminal'] })).choice !== 'Close terminal') return;
    clearTimeout(t.autorunTimer); if (t.ptyId) { await call('terminalClose', { id: w.id, terminalId: t.ptyId }); terminalRoutes.delete(t.ptyId); } t.term?.dispose(); t.host?.remove(); w.terminals = w.terminals.filter(x => x !== t); w.activeTerminal = w.terminals[0]?.id; renderTerminals(w); fit(w); persist();
  }
  api.onPtyData(({ id, data }) => { const route = terminalRoutes.get(id); if (route) { const t = route.t; t.term.write(data, () => {
    if (t.autorun && !t.autorunSent) {
      let tail = ''; for (let i = Math.max(0, t.term.buffer.active.length - 20); i < t.term.buffer.active.length; i++) tail += t.term.buffer.active.getLine(i)?.translateToString() + '\n';
      const ready = t.kind === 'codex' ? /context left|for shortcuts|›/.test(tail) : tail.split('\n').some(MT.tuiDetect.isReadyLine);
      if (ready && !/Do you want|trust this folder|Would you like to proceed/i.test(tail)) { t.autorunSent = true; api.sendInput(id, t.autorun.command); t.autorunTimer = setTimeout(() => { if (t.ptyId === id) api.sendInput(id, '\r'); }, t.autorun.enterDelayMs || 300); }
    }
  }); t.activity = Date.now(); } });
  api.onPtyExit(({ id, code }) => { const route = terminalRoutes.get(id); if (!route) return; const { w, t } = route; t.ptyId = null; t.status = 'exited'; t.term.write(`\r\n[Exited with code ${code ?? 0}] Press Enter to restart.\r\n`); terminalRoutes.delete(id); renderTerminals(w); });
  api.onSessionState(({ id, state: signal }) => { const route = terminalRoutes.get(id); if (!route) return; const previous = route.t.signal; route.t.signal = signal; renderTabs(); if (['done', 'await'].includes(signal) && signal !== previous) MT.notify?.complete({ id, label: route.w.name + ' / ' + route.t.label, kind: signal, watching: document.hasFocus() && !globalView && route.w.id === activeId && route.w.terminalVisible }); });
  function showWorkspaceView(w) {
    updateNav(w.view); w.editorArea.hidden = !['files', 'diff'].includes(w.view); w.page.hidden = ['files', 'diff'].includes(w.view); w.diffView && (w.diffView.hidden = w.view !== 'diff'); if (w.view === 'diff') w.editorArea.hidden = true;
    treeHost.hidden = w.view !== 'files'; renderTerminals(w);
    if (!['files', 'diff'].includes(w.view)) safe(() => renderProjectPage(w));
  }
  async function renderProjectPage(w) {
    const seq = ++w.sequence, host = w.page; host.replaceChildren(); host.append(el('div', 'ws-scope', w.name + ' · ' + w.root));
    if (w.view === 'overview') {
      if (w.slug) await MT.detail.render(host, w.slug, MT.openProject); else { host.append(el('h2', '', w.name), el('p', '', 'Open Files to edit code or create a terminal below. This folder is not registered in Mavis memory.'), button('Files', 'files', 'files')); }
      return;
    }
    if (w.view === 'search') {
      host.append(el('h2', '', 'Search project')); const form = el('form', 'ws-search'), input = el('input', 'ws-input'), resultHost = el('div'); input.value = w.searchQuery || ''; input.placeholder = 'Find text in files'; input.setAttribute('aria-label', 'Search project text'); const submit = el('button', 'ws-button ws-primary', 'Search'); submit.type = 'submit'; form.append(input, submit); host.append(form, resultHost); let querySeq = 0;
      const paintResults = results => { resultHost.replaceChildren(); let previous; for (const hit of results.results || []) { const path = hit.rel || hit.path; if (path !== previous) { resultHost.append(el('h3', 'ws-search-file', path)); previous = path; } const b = el('button', 'ws-button ws-search-hit'); b.append(el('small', '', String(hit.line || '')), el('span', '', hit.text || '')); b.onclick = () => safe(() => openFile(w, path, true, hit.line)); resultHost.append(b); } resultHost.append(el('p', '', results.truncated ? 'Result limit reached. Refine your search.' : (results.results || []).length + ' results')); };
      if (w.searchResults) paintResults(w.searchResults);
      input.oninput = () => { w.searchQuery = input.value; };
      form.onsubmit = e => { e.preventDefault(); const token = ++querySeq; w.searchQuery = input.value; safe(async () => { resultHost.replaceChildren(el('p', '', 'Searching…')); const results = await call('search', { id: w.id, query: input.value, mode: 'content' }); if (token !== querySeq || seq !== w.sequence) return; w.searchResults = results; paintResults(results); }); }; input.focus(); return;
    }
    if (w.view === 'changes') {
      host.append(el('h2', '', 'Changes')); const res = await call('git', { id: w.id, action: 'status' }).catch(e => ({ error: e.message })); if (seq !== w.sequence) return;
      if (res.error || !res.staged) { host.append(el('p', '', res.reason || 'No Git repository found.')); return; }
      host.append(el('div', 'ws-scope', 'Repository: ' + res.repositoryRoot + ' · diffs compare saved files on disk'));
      const controls = el('div', 'ws-search'); for (const action of ['commit', 'push', 'branches']) { const b = el('button', 'ws-button', action === 'branches' ? 'Switch branch' : action[0].toUpperCase() + action.slice(1)); b.onclick = () => safe(() => gitAction(w, action)); controls.append(b); } host.append(controls);
      for (const staged of [false, true]) { host.append(el('div', 'ws-label', staged ? 'Staged' : 'Working tree')); for (const entry of res[staged ? 'staged' : 'unstaged']) { const row = el('div', 'ws-row'); const b = el('button', 'ws-button', entry.status + '  ' + entry.rel); b.onclick = () => safe(async () => { const versions = await call('git', { id: w.id, action: 'versions', rel: entry.rel, staged }); if (versions.unsupported) return message('Cannot preview', 'Binary or oversized file.'); compare(w, versions.original || '', versions.modified || '', entry.rel + (staged ? ' · staged' : ' · working tree')); }); const stage = el('button', 'ws-button', staged ? 'Unstage' : 'Stage'); stage.onclick = () => safe(() => gitAction(w, staged ? 'unstage' : 'stage', [entry.rel])); row.append(b, stage); if (!staged) { const discard = el('button', 'ws-button', 'Discard'); discard.onclick = () => safe(() => gitAction(w, 'discard', [entry.rel])); row.append(discard); } host.append(row); } }
      if (!res.staged.length && !res.unstaged.length) host.append(el('p', '', 'Working tree clean.')); return;
    }
  }
  async function gitAction(w, action, rels) {
    if (['discard', 'checkout', 'stage', 'commit'].includes(action) && [...w.docs.values()].some(d => d.dirty)) { await message('Save edits first', 'Save or close unsaved editor files before changing the repository. Git acts on files saved on disk.'); return; }
    let payload = { id: w.id, action, rels };
    if (action === 'branches') {
      const r = await call('git', payload); const picker = el('select', 'ws-input'); picker.setAttribute('aria-label', 'Branch'); for (const name of r.list || []) { const option = el('option', '', name); option.value = name; picker.append(option); } picker.value = r.current; const answer = await dialog({ title: 'Switch branch', text: 'Current: ' + r.current, choices: ['Cancel', 'Switch'], body: picker }); if (answer.choice !== 'Switch') return; payload = { id: w.id, action: 'checkout', name: picker.value };
    } else if (action === 'commit') { const answer = await dialog({ title: 'Commit staged changes', input: '', choices: ['Cancel', 'Commit'] }); if (answer.choice !== 'Commit') return; payload.message = answer.value; }
    else if (['discard', 'push'].includes(action)) { if ((await dialog({ title: action === 'push' ? 'Push changes?' : 'Discard changes?', text: w.name + '\n' + (rels?.join('\n') || 'Push the current branch to its remote.'), choices: ['Cancel', action === 'push' ? 'Push' : 'Discard'] })).choice === 'Cancel') return; }
    if (['discard', 'checkout', 'stage', 'commit'].includes(payload.action) && [...w.docs.values()].some(d => d.dirty)) { await message('Save edits first', 'Save or close unsaved editor files before changing the repository.'); return; }
    await call('git', payload); if (w.view === 'changes') await renderProjectPage(w); await reconcile(w); status.textContent = 'Git action completed for ' + w.name;
  }
  function compare(w, original, modified, label) {
    const previousView = w.view === 'diff' ? 'changes' : w.view;
    w.diff?.dispose(); w.diffModels?.forEach(m => m.dispose()); w.diffView?.remove();
    w.diffView = el('div', 'ws-diff-view'); const bar = el('div', 'ws-diff-bar', label), back = el('button', 'ws-button', 'Back'); back.onclick = () => { w.view = previousView; w.diffView.hidden = true; showWorkspaceView(w); }; bar.append(back); const host = el('div', 'ws-diff'); w.diffView.append(bar, host); w.body.insertBefore(w.diffView, w.termDivider);
    w.diff = monaco.editor.createDiffEditor(host, { automaticLayout: true, readOnly: true, fontSize: preferences.editorFontSize, renderSideBySide: true, minimap: { enabled: false } }); w.diffModels = [monaco.editor.createModel(original), monaco.editor.createModel(modified)]; w.diff.setModel({ original: w.diffModels[0], modified: w.diffModels[1] }); w.view = 'diff'; showWorkspaceView(w); fit(w);
  }
  async function showGlobal(view, arg) {
    globalArg = arg;
    if (['map', 'ask'].includes(view)) return showGlobal('projects');
    if (ws() && ['daily','topics','character','ops'].includes(view)) { ws().rememberedGlobal = view; persist(); }
    inspectorDivider.hidden = true;
    globalView = view; updateNav(view); for (const w of projects.values()) if (w.host) w.host.hidden = true; globalHost.hidden = false; treeHost.hidden = true; inspector.hidden = true; globalHost.replaceChildren(); renderTabs();
    const scope = el('div', 'ws-scope-bar');
    const project = memoryScope === 'project' && ws() ? (ws().slug || '__unlinked__') : null;
    if (['daily','topics'].includes(view)) {
      const label = el('label', '', 'Memory for'); const select = el('select', 'ws-input'); select.id = 'memory-scope'; label.htmlFor = select.id;
      if (ws()) { const option = el('option', '', ws().name); option.value = 'project'; select.append(option); }
      const all = el('option', '', 'All Projects'); all.value = 'all'; select.append(all); select.value = ws() ? memoryScope : 'all';
      select.onchange = () => { memoryScope = select.value; persist(); safe(() => showGlobal(view)); }; scope.append(label, select);
    } else scope.append(el('span', '', ['character','mavis-identity','mavis-rules'].includes(view) ? 'Shared Mavis profile and working rules' : view === 'ops' ? 'Daily planning · All Projects' : 'maviscode'));
    if (ws()) { const back = el('button', 'ws-button', 'Back to ' + ws().name); back.onclick = () => { ws().rememberedGlobal = null; safe(() => activate(activeId)); }; scope.append(back); }
    if (view !== 'projects') globalHost.append(scope); if (project === '__unlinked__' && ['daily','topics'].includes(view)) globalHost.append(el('p', 'ws-notice', 'This folder has no linked project memory. Choose All Projects to browse shared memory.'));
    const holder = el('div'); globalHost.append(holder);
    if (view === 'projects') {
      const projectList = el('div'); holder.append(projectList); await MT.projects.render(projectList, MT.openProject, { onOpenFolder: () => safe(() => openProject()) });
    } else if (view === 'daily') await MT.dailyLog.render(holder, arg, { project });
    else if (view === 'topics') await MT.topics.render(holder, arg, { project });
    else if (view === 'character') { await MT.journal.render(holder, { characterOnly: true }); }
    else if (view === 'ops') await MT.dailyops.render(holder);
    else if (view === 'settings') { await MT.settings.render(holder); MT.brainHealth?.mountCard(holder); }
    else if (view === 'dashboard') { await MT.dashboard.render(holder); MT.brainHealth?.mountCard(holder); }
    else if (view === 'mavis-identity' || view === 'mavis-rules') await MT.mavisConfig.render(holder, view === 'mavis-identity' ? 'identity' : 'rules');
    else if (view === 'pm' && pmEnabled) await MT.pm.render(holder);
    else if (view === 'detail') await MT.detail.render(holder, arg, MT.openProject);
  }
  async function locateMissing(w) {
    const answer = await dialog({ title: 'Project folder unavailable', text: w.root, choices: ['Cancel', 'Close record', 'Retry', 'Locate folder'] });
    if (answer.choice === 'Close record') { projects.delete(w.id); renderTabs(); persist(); return showGlobal('projects'); }
    if (answer.choice === 'Retry') { projects.delete(w.id); try { await openProject({ restore: w.id, saved: w }); } catch (e) { projects.set(w.id, w); renderTabs(); throw e; } }
    if (answer.choice === 'Locate folder') { const previous = new Set(projects.keys()); await openProject(); if ([...projects.keys()].some(id => !previous.has(id))) { projects.delete(w.id); renderTabs(); persist(); } }
  }
  function fileActions(anchor, w, rel, type) {
    const target = { id: w.id, rel };
    actionMenu(anchor, [
      { label: type === 'dir' ? 'Expand Folder' : 'Open File', icon: type === 'dir' ? 'folder' : 'file', onClick: async () => { if (type === 'dir') { w.expanded.add(rel); await renderTree(w); persist(); } else await openFile(w, rel); } },
      { label: revealLabel, icon: 'external', onClick: () => location(target, 'reveal') },
      { label: 'Copy Full Path', icon: 'copy', onClick: () => location(target, 'copyFull') },
      { label: 'Copy Relative Path', icon: 'copy', onClick: () => location(target, 'copyRelative') },
      { separator: true },
      { label: 'Rename…', onClick: () => mutateFile(w, rel, 'rename') },
      { label: 'Move to Trash…', danger: true, onClick: () => mutateFile(w, rel, 'trash') },
    ]);
  }
  async function mutateFile(w, rel, operation) {
    const affected = [...w.docs.values()].filter(d => d.rel === rel || d.rel.startsWith(rel + '/'));
    let to;
    if (operation === 'rename') { const result = await dialog({ title: 'New relative path', input: rel, choices: ['Cancel', 'Rename'] }); if (result.choice !== 'Rename') return; to = result.value; if (!to?.trim()) return; }
    else if ((await dialog({ title: 'Move to Trash?', text: rel + '\nYou can restore it from the Trash.', choices: ['Cancel', 'Move to Trash'] })).choice !== 'Move to Trash') return;
    const dirty = affected.filter(d => d.dirty);
    if (dirty.length) {
      if ((await dialog({ title: 'Save before changing files?', text: dirty.map(d => d.rel).join('\n'), choices: ['Cancel', 'Save all'] })).choice !== 'Save all') return;
      for (const d of dirty) if (!await saveDocument(w, d) || d.dirty) return;
    }
    await call('mutate', { id: w.id, operation: to ? 'rename' : 'trash', rel, to });
    for (const d of affected) { const next = to && to + d.rel.slice(rel.length); d.dirty = false; await closeDocument(w, d); if (next) await openFile(w, next); } await renderTree(w);
  }
  async function reconcile(w) {
    for (const d of w.docs.values()) {
      const read = await call('read', { id: w.id, rel: d.rel }).catch(e => ({ error: e.message, missing: true, revision: null }));
      if (!projects.has(w.id) || w.docs.get(d.rel) !== d || d.model.isDisposed()) continue;
      if (read.revision === d.revision) continue;
      if (!d.dirty && !read.missing && (read.preview || d.kind !== 'text')) {
        d.kind = read.preview?.kind || 'text'; d.preview = read.preview; d.size = read.size; d.previewReason = read.unsupported;
        d.reloading = true; d.model.setValue(read.preview?.text || read.text || ''); monaco.editor.setModelLanguage(d.model, read.preview ? 'plaintext' : languageFor(d.rel)); d.reloading = false;
        d.baseText = read.text; d.revision = read.revision; d.bom = read.bom; d.eol = read.eol; d.conflict = null;
        for (const g of w.groups) if (g.file === d.rel) displayDocument(w, g, d);
        continue;
      }
      if (d.kind !== 'text' && read.missing) { for (const g of w.groups) if (g.file === d.rel) g.crumb.textContent = d.rel + ' · File is unavailable · Read-only'; continue; }
      if (read.missing || read.unsupported || d.dirty) { d.conflict = read; if (w.file === d.rel) renderConflict(w, d); }
      else { d.reloading = true; const states = w.groups.map(g => g.editor.saveViewState()); d.model.setValue(read.text); d.reloading = false; d.baseText = read.text; d.revision = read.revision; w.groups.forEach((g, i) => g.editor.restoreViewState(states[i])); }
    }
  }
  async function quickOpen(commands = false) {
    const body = el('div', 'ws-palette-list'), search = el('input', 'ws-input'); search.placeholder = commands ? 'Search commands' : 'Find a file by name'; search.setAttribute('aria-label', search.placeholder); body.append(search); const results = el('div', 'ws-palette-list'); body.append(results); let seq = 0;
    const choices = Object.keys(commandLabels); const w = ws();
    const render = async () => { const token = ++seq; results.replaceChildren(); if (commands) { for (const id of choices.filter(id => commandLabels[id].toLowerCase().includes(search.value.toLowerCase()))) { const b = el('button', 'ws-button', commandLabels[id]); b.onclick = () => { body.closest('.ws-dialog-overlay').querySelector('.ws-dialog-actions button').click(); safe(() => run(id)); }; results.append(b); } } else { if (!w || !search.value.trim()) return; const r = await call('search', { id: w.id, query: search.value, mode: 'files' }); if (token !== seq) return; for (const hit of r.results || []) { const b = el('button', 'ws-button', hit.rel || hit.path); b.onclick = () => { body.closest('.ws-dialog-overlay').querySelector('.ws-dialog-actions button').click(); safe(() => openFile(w, hit.rel || hit.path)); }; results.append(b); } } };
    search.oninput = () => safe(render); render(); const waiting = dialog({ title: commands ? 'Command Palette' : 'Quick Open', body, choices: ['Close'] }); search.focus(); await waiting;
  }
  const commandLabels = { open: 'Open Folder', projects: 'Projects', save: 'Save File', saveAll: 'Save All Files', saveAs: 'Save As', quickOpen: 'Quick Open File', search: 'Search Project', shell: 'New Shell Terminal', claude: 'New Claude Terminal', codex: 'New Codex Terminal', splitEditor: 'Split Editor', closeSplit: 'Close Editor Split', closeProject: 'Close Project', nextProject: 'Next Project', terminal: 'Toggle Terminal', inspector: 'Toggle Mavis Pane', sidebar: 'Toggle Sidebar', wordWrap: 'Toggle Word Wrap', daily: 'Daily Log', topics: 'Topics', settings: 'Settings', dashboard: 'Brain Overview', newFile: 'New File', newFolder: 'New Folder' };
  async function run(action) {
    const w = ws(), g = w?.groups[focusedGroup] || w?.groups[0], d = w?.docs.get(g?.file);
    if (['files', 'search', 'changes', 'overview'].includes(action)) { if (!w || w.missing) return showGlobal('projects'); globalView = null; globalHost.hidden = true; w.host.hidden = false; w.view = action; w.rememberedGlobal = null; showWorkspaceView(w); renderTabs(); if (action === 'files') await renderTree(w); renderInspector(w); persist(); return; }
    if (action === 'memory') return showGlobal('daily');
    if (action === 'explorerMenu' && w) return actionMenu(treeHost.querySelector('[aria-label="Project folder actions"]') || toolbar, [ ['Project Overview', () => run('overview')], [revealLabel, () => location({ id: w.id }, 'reveal')], ['Copy Full Path', () => location({ id: w.id }, 'copyFull')], { separator: true }, ['New Folder…', () => run('newFolder')], [(preferences.showHidden ? 'Hide' : 'Show') + ' Hidden Files', () => run('toggleHidden')] ]);
    if (['projects', 'daily', 'topics', 'character', 'settings', 'ops', 'dashboard', 'mavis-identity', 'mavis-rules', 'pm'].includes(action)) return showGlobal(action);
    if (action === 'open') return openProject(); if (action === 'save') return saveDocument(w, d);
    if (action === 'saveAll') {
      const failures = [];
      for (const project of projects.values()) for (const doc of project.docs.values()) if (doc.dirty) {
        try { if (!await saveDocument(project, doc)) failures.push(project.name + ' / ' + doc.rel + ': disk conflict'); }
        catch (e) { failures.push(project.name + ' / ' + doc.rel + ': ' + e.message); }
      }
      if (failures.length) await message('Some files were not saved', failures.join('\n')); else status.textContent = 'All files saved';
      return;
    }
    if (action === 'saveAs' && d) {
      if (d.kind !== 'text') { status.textContent = 'Read-only preview · ' + d.rel; return; }
      const version = d.model.getVersionId(), text = d.model.getValue();
      const res = await call('saveAs', { id: w.id, rel: d.rel, text, bom: d.bom });
      if (res.ok) {
        if (d.model.getVersionId() !== version) { await recovery(w, d); status.textContent = 'Saved copy as ' + res.rel + '; newer edits remain in ' + d.rel; return; }
        d.dirty = false; await recovery(w, d); await closeDocument(w, d); await openFile(w, res.rel);
      }
      return;
    }
    if (action === 'quickOpen' || action === 'palette') return quickOpen(action === 'palette');
    if (['shell', 'claude', 'codex'].includes(action)) return newTerminal(w, action);
    if (action === 'find' && d?.kind !== 'image') return g?.editor.getAction('actions.find').run();
    if (action === 'closeResource') return document.activeElement?.classList.contains('xterm-helper-textarea') ? closeTerminal(w, w.terminals.find(t => t.id === w.activeTerminal)) : d && closeDocument(w, d);
    if (action === 'closeProject' && w) return closeProject(w);
    if (action === 'nextProject') { const ids = [...projects.keys()]; return activate(ids[(ids.indexOf(activeId) + 1) % ids.length]); }
    if (action === 'splitEditor' && w && w.groups.length < 2) { const group = createGroup(w); if (w.file) showDocument(w, w.file, 1); fit(w); persist(); return; }
    if (action === 'closeSplit' && w?.groups.length === 2) { const group = w.groups.pop(); group.editor.dispose(); group.host.remove(); group.divider?.remove(); w.groups[0].host.style.flex = ''; focusedGroup = 0; persist(); return; }
    if (action === 'wordWrap') { preferences.wordWrap = preferences.wordWrap === 'off' ? 'on' : 'off'; for (const project of projects.values()) for (const group of project.groups) group.editor.updateOptions({ wordWrap: preferences.wordWrap }); persist(); }
    if (action === 'toggleHidden') { preferences.showHidden = !preferences.showHidden; if (w) await renderTree(w); persist(); }
    if (action === 'sidebar') { sidebarCollapsed = !sidebarCollapsed; sidebar.classList.toggle('collapsed', sidebarCollapsed); sidebar.style.width = ''; if (w) fit(w); persist(); }
    if (action === 'inspector') { if (globalView || !w) return; inspectorVisible = !inspectorVisible; inspector.hidden = !inspectorVisible; inspectorDivider.hidden = !inspectorVisible; if (w) fit(w); updateProjectControls(); persist(); }
    if (action === 'terminal') {
      if (!w || w.missing) return showGlobal('projects');
      const wasGlobal = !!globalView; if (wasGlobal) await run('files');
      if (!w.terminals.length) return newTerminal(w, 'shell');
      w.terminalVisible = wasGlobal || !w.terminalVisible; renderTerminals(w); updateProjectControls(); fit(w); persist();
    }
    if (['newFile', 'newFolder'].includes(action) && w) { const answer = await dialog({ title: action === 'newFile' ? 'New file' : 'New folder', input: '', choices: ['Cancel', 'Create'] }); if (answer.choice !== 'Create') return; await call('mutate', { id: w.id, operation: action === 'newFile' ? 'file' : 'folder', rel: answer.value }); await renderTree(w); if (action === 'newFile') await openFile(w, answer.value); }
    if (action === 'minimize') api.winMinimize(); if (action === 'maximize') api.winMaximize(); if (action === 'windowClose') api.winClose();
  }
  MT.openProject = p => safe(async () => { const listed = await api.listProjects(); const match = listed.find(x => (p.slug && x.slug === p.slug) || (p.cwd && x.dir === p.cwd) || (p.label && x.name === p.label)); if (!match) throw new Error('Project is not registered. Use Open Folder.'); ++colorSequence; projectCatalog = listed; return openProject({ slug: match.slug }); });
  MT.projectActions = (anchor, project) => safe(() => projectActions(anchor, project));
  MT.router = { show: (view, arg) => safe(() => ['session', 'files'].includes(view) ? run('files') : showGlobal(({ journal: 'daily', dailyops: 'ops' })[view] || view, arg)), current: () => globalView || ws()?.view };
  MT.session = { activeCwd: () => ws()?.root, count: () => projects.size, applyTerminalSettings: opts => { preferences.terminalFontSize = opts.fontSize || 14; for (const w of projects.values()) for (const t of w.terminals) if (t.term) t.term.options.fontSize = preferences.terminalFontSize; }, refitActive: () => ws() && fit(ws()), open: MT.openProject };
  MT.theme = { apply(name) { document.documentElement.style.colorScheme = name === 'system' ? 'light dark' : /dark|ink/i.test(name) ? 'dark' : 'light'; monaco.editor.setTheme(actualTheme().background === '#202124' ? 'vs-dark' : 'vs'); for (const w of projects.values()) for (const t of w.terminals) if (t.term) t.term.options.theme = actualTheme(); } };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (document.documentElement.style.colorScheme === 'light dark') MT.theme.apply('system'); });
  api.onCommand(id => safe(() => run(id)));
  api.onBrainChanged(() => {
    refreshProjectColors();
    const view = globalView, arg = globalArg;
    if (view === 'settings' || view === 'character' || document.querySelector('.mt-np-overlay')) return;
    if (view && ['projects', 'daily', 'topics', 'dashboard', 'detail'].includes(view)) safe(() => globalView === view && showGlobal(view, arg));
    else if (view === 'ops' && !MT.dailyops?.isBusy?.()) safe(() => globalView === view && showGlobal(view, arg));
    const w = ws(); if (!view && w?.view === 'overview') safe(() => renderProjectPage(w));
  });
  api.onWorkspaceChanged(({ workspaceId }) => { const w = projects.get(workspaceId); if (w) safe(async () => { await reconcile(w); if (activeId === w.id && w.view === 'files') await renderTree(w); }); });
  window.addEventListener('focus', () => { for (const w of projects.values()) if (!w.missing) safe(() => reconcile(w)); });
  window.addEventListener('resize', () => ws() && fit(ws()));
  api.onCloseRequest(async () => {
    if (closePending) return; closePending = true;
    try {
      const running = [...projects.values()].flatMap(w => w.terminals.filter(t => t.ptyId).map(t => w.name + ' / ' + t.label));
      if (running.length && (await dialog({ title: 'Stop running terminals?', text: running.join('\n'), choices: ['Cancel', 'Close'] })).choice !== 'Close') return;
      const dirty = [...projects.values()].flatMap(w => [...w.docs.values()].filter(d => d.dirty).map(d => ({ w, d })));
      if (dirty.length) {
        const answer = await dialog({ title: 'Unsaved changes', text: dirty.map(({ w, d }) => w.name + ' / ' + d.rel).join('\n'), choices: ['Cancel', 'Discard all', 'Save all'] });
        if (answer.choice === 'Cancel') return;
        if (answer.choice === 'Save all') { for (const { w, d } of dirty) if (!await saveDocument(w, d) || d.dirty) return; }
        else for (const { w, d } of dirty) { clearTimeout(d.recoveryTimer); await call('recovery', { id: w.id, rel: d.rel, snapshot: null }); d.dirty = false; }
      }
      await flush(); api.closeApproved();
    } finally { closePending = false; }
  });
  api.onReloadConfirmRequest(async p => { await flush(); const answer = await dialog({ title: 'Reload workspace?', text: 'Unsaved edits are backed up. Running terminals may lose their displayed history.', choices: ['Cancel', 'Reload'] }); api.reloadConfirmResponse({ ...p, ok: answer.choice === 'Reload' }); });
  async function boot() {
    const settings = await api.getSettings(); preferences.terminalFontSize = settings.values.terminalFontSize || 14; available = await api.harnessAvailable(); defaultAgent = available.includes(settings.values.harness) ? settings.values.harness : available.includes('claude') ? 'claude' : available[0] || settings.values.harness || 'claude';
    await refreshProjectColors();
    MT.notify?.configure({ mode: settings.values.notifyOnComplete, sound: settings.values.notifySound, volume: settings.values.notifyVolume });
    const saved = await call('load'); Object.assign(preferences, saved.preferences || {}); sidebarCollapsed = saved.sidebarCollapsed === true; inspectorVisible = saved.uiVersion === 2 && saved.inspectorVisible === true; memoryScope = saved.memoryScope === 'all' ? 'all' : 'project'; sidebar.classList.toggle('collapsed', sidebarCollapsed); if (!sidebarCollapsed && saved.sidebarWidth) sidebar.style.width = Math.max(150, saved.sidebarWidth) + 'px'; if (saved.inspectorWidth >= 180) inspector.style.width = saved.inspectorWidth + 'px'; MT.theme.apply(settings.values.appTheme || 'system');
    for (const record of saved.workspaces || []) { try { await openProject({ restore: record.id, saved: record }); } catch { const missing = { ...record, missing: true, docs: new Map(), groups: [], terminals: record.terminals || [], expanded: new Set() }; projects.set(record.id, missing); } }
    if (saved.activeId && projects.has(saved.activeId) && !projects.get(saved.activeId).missing) await activate(saved.activeId); else if (![...projects.values()].some(w => !w.missing)) await showGlobal('projects');
    pmEnabled = settings.values.pmEnabled === true || settings.values.pmEnabled === 'on';
    if (pmEnabled) { const b = button('Project Board', 'pm', 'projects'); nav.append(b); }
    MT.settings.registerSection('Editor', host => {
      const label = el('label', 'ws-row', 'Editor font size'); const input = el('input', 'ws-input'); input.type = 'number'; input.min = 10; input.max = 24; input.value = preferences.editorFontSize; input.setAttribute('aria-label', 'Editor font size');
      input.onchange = () => { preferences.editorFontSize = Math.max(10, Math.min(24, Number(input.value) || 14)); input.value = preferences.editorFontSize; for (const w of projects.values()) { for (const g of w.groups) g.editor.updateOptions({ fontSize: preferences.editorFontSize }); w.diff?.updateOptions({ fontSize: preferences.editorFontSize }); } persist(); };
      label.append(input); host.append(label, button('Toggle hidden files', 'toggleHidden', 'file'), button('Toggle word wrap', 'wordWrap', 'file'));
    });
    if (pmEnabled) MT.settings.registerSection('Project Board', host => MT.pmSettings.render(host));
    MT.brainHealth?.mountBadge(navButtons.get('settings')); MT.brainHealth?.start();
    booting = false; renderTabs(); status.textContent = 'Workspace ready'; persist();
  }
  // Public state is useful for app-owned diagnostics and integration checks; no filesystem handles.
  MT.workspace = { run, openProject, projects, snapshot, flush, activate, get activeId() { return activeId; }, get ready() { return !booting; } };
  safe(boot);
})();
