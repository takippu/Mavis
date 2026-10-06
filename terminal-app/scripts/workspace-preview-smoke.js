'use strict';
// Exercise our renderer with disposable files and an isolated application profile.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { app, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-preview-'));
const data = path.join(root, 'state'), folder = path.join(root, 'project'); fs.mkdirSync(data); fs.mkdirSync(folder);
const png = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/mavis-logo.png'));
fs.writeFileSync(path.join(folder, 'image.png'), png); fs.writeFileSync(path.join(folder, 'other.bin'), Buffer.from([0,1,2,255,65])); fs.writeFileSync(path.join(folder, 'code.js'), 'const code = true;\n');
const workspace = { id: 'preview', root: folder, name: 'Preview', documents: ['image.png','other.bin','code.js'].map(rel => ({ rel })), file: 'image.png', groups: [{file:'image.png'}], terminals: [] };
fs.writeFileSync(path.join(data, 'workspace-state.json'), JSON.stringify({ version:3, activeId:'preview', workspaces:[workspace] }));
process.env.MAVIS_TEST_USER_DATA = data; process.env.MAVIS_BRAIN_ROOT = require('./fixture-brain')(path.join(root, 'brain'));
const errors = []; app.on('web-contents-created', (_e,wc) => wc.on('console-message', (_e,level,message) => {if(level>=3) errors.push(message);}));
require(process.env.MAVIS_SMOKE_MAIN || '../src/main');
const delay = ms => new Promise(r => setTimeout(r,ms));
async function test() {
  let win; for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Mavis-Terminal');if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript(`!!MT.workspace?.ready && !!MT.workspace.projects.get('preview')?.docs.get('code.js')`))break;await delay(100);}
  assert.ok(win); win.webContents.setBackgroundThrottling(false); const js = s => win.webContents.executeJavaScript(s);
  const poll = async s => {for(let i=0;i<100;i++){if(await js(s))return;await delay(50);}throw Error('Timed out: '+s);};
  const tab = name => js(`([...MT.workspace.projects.get('preview').groups[0].tabs.querySelectorAll('[role=tab]')].find(b=>b.title===${JSON.stringify(name)}).click())`);
  await poll(`document.querySelector('.ws-preview-image')?.naturalWidth>0`);
  const initial = await js(`(() => {const w=MT.workspace.projects.get('preview'),g=w.groups[0];return {image:w.docs.get('image.png').kind,hidden:g.editorHost.hidden,bytes:w.docs.get('other.bin').kind,dirty:[...w.docs.values()].some(d=>d.dirty),cursor:getComputedStyle(g.previewHost.querySelector('button')).cursor};})()`);
  assert.deepEqual(initial,{image:'image',hidden:true,bytes:'binary',dirty:false,cursor:'pointer'});
  await js(`MT.workspace.run('save')`); await js(`MT.workspace.run('saveAs')`);
  assert.deepEqual(fs.readFileSync(path.join(folder,'image.png')),png);
  await js(`document.querySelector('.ws-preview-bar button:last-child').click()`); assert.equal(await js(`document.querySelector('.ws-image-canvas').classList.contains('actual-size')`),true);
  await js(`MT.workspace.run('splitEditor')`); await poll(`document.querySelectorAll('.ws-preview-image').length===2`);
  await tab('other.bin'); assert.equal(await js(`MT.workspace.projects.get('preview').groups[0].editor.getOption(mavisEditor.editor.EditorOption.readOnly)`),true);
  assert.equal(await js(`MT.workspace.projects.get('preview').groups[1].previewHost.hidden`),false);
  await js(`MT.workspace.run('save')`); await js(`MT.workspace.run('saveAs')`);
  assert.deepEqual(fs.readFileSync(path.join(folder,'other.bin')),Buffer.from([0,1,2,255,65]));
  await tab('code.js'); assert.equal(await js(`MT.workspace.projects.get('preview').groups[0].editor.getOption(mavisEditor.editor.EditorOption.readOnly)`),false);
  assert.equal(await js(`MT.workspace.projects.get('preview').groups[0].editorHost.hidden`),false);
  fs.writeFileSync(path.join(folder,'other.bin'),Buffer.from([0,99,255]));
  await poll(`MT.workspace.projects.get('preview').docs.get('other.bin').model.getValue().includes('00 63 ff')`);
  const changed = Buffer.concat([png,Buffer.from('changed')]); fs.writeFileSync(path.join(folder,'image.png'),changed);
  await poll(`MT.workspace.projects.get('preview').docs.get('image.png').size===${changed.length}`);
  assert.equal(await js(`MT.workspace.projects.get('preview').docs.get('image.png').conflict`),null);
  await js(`MT.workspace.run('closeSplit')`); await tab('image.png'); await poll(`document.querySelector('.ws-preview-image')?.naturalWidth>0`);
  assert.equal(await js(`MT.workspace.projects.get('preview').groups.length`),1);
  await delay(500);
  fs.writeFileSync('/tmp/mavis-image-preview.png',(await win.webContents.capturePage()).toPNG());
  await js(`MT.workspace.run('closeResource')`); assert.equal(await js(`!!MT.workspace.projects.get('preview').docs.get('image.png')`),false);
  assert.equal(await js(`!!document.querySelector('.ws-preview-image')`),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,imageDecode:true,zoom:true,split:true,binaryReadOnly:true,textEditable:true,saveProtection:true,externalRefresh:true,close:true,errors}));
  app.quit();
}
app.whenReady().then(test).catch(e=>{console.error(e);app.exit(1);});
