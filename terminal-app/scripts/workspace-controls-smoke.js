'use strict';
// App-owned click integration with an isolated profile and disposable folder.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-controls-'));
const data = path.join(root, 'state'), folder = path.join(root, 'project'); fs.mkdirSync(data); fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, 'test.js'), 'const test = true;\n');
process.env.MAVIS_TEST_USER_DATA = data; process.env.MAVIS_BRAIN_ROOT = require('./fixture-brain')(path.join(root, 'brain'));
let pickerCalls = 0; dialog.showOpenDialog = async () => { pickerCalls++; return { canceled: false, filePaths: [folder] }; };
const errors = []; app.on('web-contents-created', (_e, wc) => wc.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); }));
require('./fixture-agent-guard')(ipcMain);
require(process.env.MAVIS_SMOKE_MAIN || '../src/main');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function test() {
  let win;
  for (let i=0;i<100;i++) { win=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Mavis-Terminal'); if(win && !win.webContents.isLoading() && await win.webContents.executeJavaScript(`!!MT.workspace && !!document.querySelector('.mt-proj[role=button]')`)) break; await delay(100); }
  assert.ok(win);
  const js = source => win.webContents.executeJavaScript(source);
  const poll = async source => { for (let i=0;i<100;i++) { if(await js(source))return; await delay(50); } throw Error('Timed out: '+source); };
  const launcher = await js(`(() => {
    const visible=[...document.querySelectorAll('.ws-sidebar nav button')].filter(b=>!b.hidden).map(b=>b.textContent.trim());
    const terminal=document.querySelector('[aria-label="Toggle terminal"]');
    return { visible, terminalDisabled:terminal.disabled, projectCursor:getComputedStyle(document.querySelector('.mt-proj[role=button]')).cursor };
  })()`);
  for(const label of ['Files','Search','Changes','Map','Ask Mavis']) assert.ok(!launcher.visible.includes(label), label+' should be absent from launcher');
  assert.equal(launcher.terminalDisabled,true); assert.equal(launcher.projectCursor,'pointer');
  await js(`document.querySelector('.mt-proj[role=button]').click()`);
  await poll(`MT.workspace.projects.size===1`); assert.equal(pickerCalls,1);
  await js(`MT.workspace.run('shell')`);
  await poll(`[...MT.workspace.projects.values()][0]?.terminals.find(t=>t.kind==='shell')?.ptyId`);
  await js(`document.querySelector('[aria-label="Toggle terminal"]').click()`);
  assert.equal(await js(`[...MT.workspace.projects.values()][0].terminalVisible`),false);
  await js(`MT.workspace.run('daily')`); await js(`document.querySelector('[aria-label="Toggle terminal"]').click()`);
  await poll(`[...MT.workspace.projects.values()][0].terminalVisible && ![...MT.workspace.projects.values()][0].host.hidden`);
  const active=await js(`([...document.querySelectorAll('.ws-sidebar nav button')].filter(b=>!b.hidden).map(b=>b.textContent.trim()))`);
  for(const label of ['Files','Search','Changes'])assert.ok(active.includes(label));
  await js(`Promise.all([MT.newProject.open(),MT.newProject.open()])`);
  assert.equal(await js(`document.querySelectorAll('.mt-np-overlay').length`),1);
  const cancelStyle=await js(`(() => { const b=[...document.querySelectorAll('.mt-np-foot button')].find(b=>b.textContent==='Cancel');return {cursor:getComputedStyle(b).cursor,drag:getComputedStyle(b).getPropertyValue('-webkit-app-region')};})()`);
  assert.equal(cancelStyle.cursor,'pointer'); assert.equal(cancelStyle.drag,'no-drag');
  await js(`[...document.querySelectorAll('.mt-np-foot button')].find(b=>b.textContent==='Cancel').click()`);
  assert.equal(await js(`document.querySelectorAll('.mt-np-overlay').length`),0); assert.equal(await js(`document.getElementById('app').inert`),false);
  await js(`MT.newProject.open()`); await js(`document.querySelector('.mt-np-x').click()`);
  assert.equal(await js(`document.querySelectorAll('.mt-np-overlay').length`),0);
  await js(`MT.newProject.open()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await poll(`!document.querySelector('.mt-np-overlay')`);
  await js(`(() => { const t=[...MT.workspace.projects.values()][0].terminals.find(t=>t.kind==='shell');mavis.sendInput(t.ptyId,'exit\\r');})()`);
  await poll(`![...MT.workspace.projects.values()][0].terminals.find(t=>t.kind==='shell').ptyId`);
  await js(`MT.workspace.run('closeProject')`);
  const hiddenAgain=await js(`([...document.querySelectorAll('.ws-sidebar nav button')].filter(b=>!b.hidden).map(b=>b.textContent.trim()))`);
  for(const label of ['Files','Search','Changes'])assert.ok(!hiddenAgain.includes(label));
  await js(`document.querySelector('.mt-proj[role=button]').click()`); await poll(`MT.workspace.projects.size===1`); assert.equal(pickerCalls,1,'Folder choice should be remembered');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,launcherScope:true,projectCardOpen:true,rememberedFolder:true,terminalClick:true,cancel:true,closeButton:true,escape:true,duplicateDialogGuard:true,handCursor:true,errors}));
  app.quit();
}
app.whenReady().then(test).catch(e=>{console.error(e);app.exit(1);});
