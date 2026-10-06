'use strict';
// Isolated application integration check. No user workspace/state is modified.
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-app-smoke-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
const performanceMode = !!process.env.MAVIS_WORKSPACE_PERF;
const names = performanceMode ? ['Alpha', 'Beta', 'Playground', 'SampleApp', 'Tools'] : ['Alpha', 'Beta'];
const fixtures = names.map(name => { const dir = path.join(root, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'workspace.ts'), 'export const project = ' + JSON.stringify(name) + ';\n'); fs.writeFileSync(path.join(dir, 'README.md'), '# ' + name + '\n'); if (performanceMode) for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, 'sample' + i + '.ts'), 'export const sample' + i + ' = ' + i + ';\n'); return dir; });
const loopFixture = path.join(root, 'Lifecycle'); fs.mkdirSync(loopFixture); fs.writeFileSync(path.join(loopFixture, 'loop.ts'), 'export const loop = true;\n');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [loopFixture] });
fs.writeFileSync(path.join(data, 'workspace-state.json'), JSON.stringify({ version: 3, activeId: 'smoke-a', workspaces: fixtures.map((root, i) => ({ id: i === 0 ? 'smoke-a' : i === 1 ? 'smoke-b' : 'smoke-' + i, root, name: path.basename(root), documents: fs.readdirSync(root).map(rel => ({ rel })), file: 'workspace.ts', terminals: [] })) }));
process.env.MAVIS_TEST_USER_DATA = data;
process.env.MAVIS_BRAIN_ROOT = require('./fixture-brain')(path.join(root, 'brain'));
const errors = [];
app.on('web-contents-created', (_e, wc) => { wc.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); }); wc.on('render-process-gone', (_e, detail) => errors.push(JSON.stringify(detail))); });
require('./fixture-agent-guard')(ipcMain);
require(process.env.MAVIS_SMOKE_MAIN || '../src/main');
async function test() {
  let win;
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Mavis-Terminal'); if (win && !win.webContents.isLoading()) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(win);
  for (let i = 0; i < 100; i++) { const ready = await win.webContents.executeJavaScript('!!window.MT?.workspace?.ready && window.MT.workspace.projects.size === ' + names.length); if (ready) break; await new Promise(r => setTimeout(r, 100)); }
  const result = await win.webContents.executeJavaScript(`(async () => {
    const app = MT.workspace; const a = app.projects.get('smoke-a'), b = app.projects.get('smoke-b');
    if (!a || !b) throw new Error('Projects did not restore');
    await app.activate(a.id);
    const doc = a.docs.get('workspace.ts'); if (!doc) throw new Error('Editor model missing');
    doc.model.setValue('export const edited = true;\\n');
    await app.activate(b.id);
    if (b.docs.get('workspace.ts').model.getValue().includes('edited')) throw new Error('Cross-project buffer leak');
    await app.activate(a.id);
    if (!doc.model.getValue().includes('edited') || !doc.dirty) throw new Error('Dirty buffer lost');
    await app.run('save');
    if (doc.dirty) throw new Error('Save failed');
    await app.run('splitEditor'); if (a.groups.length !== 2 || a.groups[0].editor.getModel() !== a.groups[1].editor.getModel()) throw new Error('Split model identity broken');
    await app.run('closeSplit');
    await app.run('shell');
    const term = a.terminals[0]; if (!term?.ptyId) throw new Error('Real shell did not start');
    mavis.sendInput(term.ptyId, 'printf MAVIS_SMOKE_OK\\r');
    await app.activate(b.id); await app.activate(a.id);
    if (!term.ptyId) throw new Error('Project switch terminated shell');
    await app.flush();
    return { projects: app.projects.size, documents: a.docs.size, groups: a.groups.length, terminal: term.ptyId, sidebar: document.querySelectorAll('.ws-sidebar nav button').length, editorWidth: a.groups[0].editorHost.offsetWidth };
  })()`);
  assert.equal(result.projects, names.length); assert.equal(result.sidebar, 10); assert.ok(result.editorWidth > 400);
  assert.match(fs.readFileSync(path.join(fixtures[0], 'workspace.ts'), 'utf8'), /edited/);
  await new Promise(r => setTimeout(r, 600));
  const output = await win.webContents.executeJavaScript(`(() => { const t = MT.workspace.projects.get('smoke-a').terminals[0].term; let text = ''; for(let i=0;i<t.buffer.active.length;i++)text += t.buffer.active.getLine(i)?.translateToString()+'\\n'; return text; })()`);
  assert.match(output, /MAVIS_SMOKE_OK/);
  const cancellation = await win.webContents.executeJavaScript(`(async () => {
    const app = MT.workspace, w = app.projects.get('smoke-a'), d = w.docs.get('workspace.ts');
    d.model.setValue('export const unsaved = true;\\n');
    const closing = app.run('closeResource');
    await new Promise(r => setTimeout(r, 50));
    const cancel = [...document.querySelectorAll('.ws-dialog-actions button')].find(b => b.textContent === 'Cancel');
    if (!cancel) throw new Error('Dirty close did not ask'); cancel.click(); await closing;
    if (w.docs.get(d.rel) !== d || !d.dirty) throw new Error('Cancel lost unsaved edits');
    return true;
  })()`);
  assert.equal(cancellation, true);
  fs.writeFileSync(path.join(fixtures[0], 'workspace.ts'), 'export const external = true;\n');
  const conflict = await win.webContents.executeJavaScript(`(async () => {
    const app = MT.workspace, w = app.projects.get('smoke-a'), d = w.docs.get('workspace.ts');
    await app.run('save');
    if (!d.dirty || !d.conflict || !d.model.getValue().includes('unsaved')) throw new Error('Conflict lost local edits');
    return true;
  })()`);
  assert.equal(conflict, true);
  assert.match(fs.readFileSync(path.join(fixtures[0], 'workspace.ts'), 'utf8'), /external/);
  await win.webContents.executeJavaScript(`(async () => {
    const reload = [...document.querySelectorAll('.ws-notice button')].find(b => b.textContent === 'Reload');
    if (!reload) throw new Error('Conflict reload missing'); reload.click();
    await new Promise(r => setTimeout(r, 50));
    [...document.querySelectorAll('.ws-dialog-actions button')].find(b => b.textContent === 'Reload').click();
    await new Promise(r => setTimeout(r, 100));
    const d = MT.workspace.projects.get('smoke-a').docs.get('workspace.ts');
    if (d.dirty || !d.model.getValue().includes('external')) throw new Error('Reload failed');
  })()`);
  let performanceResult;
  if (performanceMode) performanceResult = await win.webContents.executeJavaScript(`(async () => { const app = MT.workspace; for (const w of app.projects.values()) { await app.activate(w.id); while(w.terminals.length < 2) await app.run('shell'); } const ids = [...app.projects.keys()], times=[]; for (let i=0;i<50;i++) { const start=performance.now(); await app.activate(ids[i%ids.length]); times.push(performance.now()-start); } times.sort((a,b)=>a-b); return { projects:ids.length, documents:[...app.projects.values()].reduce((n,w)=>n+w.docs.size,0), terminals:[...app.projects.values()].reduce((n,w)=>n+w.terminals.length,0), switchMedianMs:times[25], switchP95Ms:times[47], switchMaxMs:times[49] }; })()`);
  if (performanceMode) { assert.equal(performanceResult.documents, 50); assert.equal(performanceResult.terminals, 10); assert.ok(performanceResult.switchP95Ms < 150, 'Project switching exceeded performance target'); }
  const lifecycle = await win.webContents.executeJavaScript(`(async () => {
    const app = MT.workspace, before = window.mavisEditor.editor.getModels().length;
    for (let i = 0; i < 20; i++) {
      await app.openProject({ saved: { documents: [{ rel: 'loop.ts' }] } });
      const w = app.projects.get(app.activeId);
      if (!w.docs.has('loop.ts')) throw new Error('Loop model did not load');
      await app.run('closeProject');
    }
    const after = window.mavisEditor.editor.getModels().length;
    if (after !== before) throw new Error('Models leaked across project close: ' + before + ' -> ' + after);
    return { cycles: 20, modelsBefore: before, modelsAfter: after, projects: app.projects.size };
  })()`);
  const parity = await win.webContents.executeJavaScript(`(async () => { const views = ['projects','daily','topics','character','ops','settings','overview','files','search','changes']; const evidence = []; for (const view of views) { await MT.workspace.run(view); evidence.push({ view, text: document.querySelector('.ws-main').innerText.length }); } await MT.workspace.run('files'); return evidence; })()`);
  assert.ok(parity.every(v => v.text > 10), 'Navigation view rendered empty');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.ws-dialog-overlay').length`), 0, 'Navigation left an unexpected error dialog');
  const evidence = path.resolve(__dirname, '../design-proposals/build-verification'); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'workspace-light.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`MT.theme.apply('dark')`);
  await new Promise(r => setTimeout(r, 200));
  fs.writeFileSync(path.join(evidence, 'workspace-dark.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(900, 600); await new Promise(r => setTimeout(r, 200));
  fs.writeFileSync(path.join(evidence, 'workspace-compact.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, [], 'Renderer errors: ' + errors.join('\n'));
  const report = { ok: true, ...result, output: 'Real shell output verified', dirtyCloseCancellation: cancellation, externalConflict: conflict, lifecycle, navigation: parity, performance: performanceResult, hardware: os.arch() + ' / ' + os.cpus()[0].model, errors, evidence };
  fs.writeFileSync(path.join(evidence, performanceMode ? 'performance.json' : 'smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (process.env.MAVIS_SMOKE_QUIT) return;
  // Let each PTY finish before Electron tears down its native runtime. A hard
  // app.exit with active node-pty callbacks can abort after a successful test.
  await win.webContents.executeJavaScript(`(() => { for (const w of MT.workspace.projects.values()) for (const t of w.terminals) if (t.ptyId) mavis.sendInput(t.ptyId, 'exit\\r'); })()`);
  let live = true;
  for (let i = 0; i < 100; i++) {
    live = await win.webContents.executeJavaScript(`([...MT.workspace.projects.values()].some(w => w.terminals.some(t => !!t.ptyId)))`);
    if (!live) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(live, false, 'Shell processes did not finish');
  await new Promise(r => setTimeout(r, 200));
}
app.whenReady().then(() => test()).then(async () => {
  if (!process.env.MAVIS_SMOKE_QUIT) return app.exit(0);
  const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Mavis-Terminal');
  app.quit();
  for (let i = 0; i < 100; i++) {
    const approved = await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.ws-dialog-actions button')].find(b => b.textContent === 'Close'); if(b) { b.click(); return true; } return false; })()`);
    if (approved) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Quit confirmation missing');
}).catch(e => { console.error(e); console.error('Renderer errors:', errors); app.exit(1); });
