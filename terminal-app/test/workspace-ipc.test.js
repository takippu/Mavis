'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const { install } = require('../src/workspace-ipc');
test('workspace bridge binds authorization to main, not renderer-persisted paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-ipc-')), folder = path.join(root, 'project'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'file.txt'), 'safe'); const handlers = new Map(), sender = { mainFrame: {} }, event = { sender, senderFrame: sender.mainFrame };
  const service = install({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showOpenDialog: async () => ({ filePaths: [folder] }) }, shell: {}, getWindow: () => ({ webContents: sender }), dir: root, getProjects: () => [], getSessions: () => ({ close() {} }), send() {} });
  t.after(() => { service.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }); const call = (name, p, e = event) => handlers.get('workspace:' + name)(e, p);
  const project = await call('open', {}); assert.ok(project.id); assert.equal((await call('read', { id: project.id, rel: 'file.txt' })).text, 'safe');
  assert.match((await call('read', { id: project.id, rel: 'file.txt' }, { sender: {} })).error, /sender/);
  const forged = await call('persist', { version: 3, workspaces: [{ ...project, root: root, terminals: [] }] }); assert.equal(forged.ok, true); assert.equal((await call('load')).workspaces[0].root, fs.realpathSync(folder));
  assert.ok((await call('persist', { version: 3, workspaces: [{ id: 'forged', root, terminals: [] }] })).error);
  assert.ok((await call('persist', { version: 3, workspaces: [{ ...project, terminals: [{ cwd: root }] }] })).error);
  await call('close', { id: project.id }); assert.ok((await call('read', { id: project.id, rel: 'file.txt' })).error);
});

test('registered projects without a local folder use the picker and remember it locally', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-project-picker-'));
  const folder = path.join(root, 'folder'); fs.mkdirSync(folder);
  const handlers = new Map(), sender = { mainFrame: {} }, event = { sender, senderFrame: sender.mainFrame };
  let picks = 0, cancel = true;
  const installService = () => install({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showOpenDialog: async () => { picks++; return { canceled: cancel, filePaths: cancel ? [] : [folder] }; } },
    shell: {}, getWindow: () => ({ webContents: sender }), dir: root,
    getProjects: () => [{ slug: 'folderless', name: 'Folderless' }, { slug: 'stale', dir: path.join(root, 'missing') }],
    getSessions: () => ({ close() {} }), send() {},
  });
  let service = installService(); t.after(() => { service.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = p => handlers.get('workspace:open')(event, p);
  assert.equal((await open({ slug: 'folderless' })).cancelled, true);
  assert.equal(service.registry.size, 0);
  cancel = false;
  const w = await open({ slug: 'folderless' });
  assert.equal(w.slug, 'folderless'); assert.equal(w.root, fs.realpathSync(folder));
  service.close(w.id); service.closeAll(); service = installService();
  const again = await open({ slug: 'folderless' }); assert.equal(again.root, w.root); assert.equal(picks, 2);
  assert.equal(service.projectFolder('folderless'), w.root);
  assert.ok((await open({ slug: 'unknown' })).error);
  const stale = await open({ slug: 'stale' }); assert.equal(stale.root, w.root); assert.equal(picks, 3);
});

test('location actions reveal and copy trusted file, folder and registered project paths', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-location-')), folder = path.join(root, 'Project with spaces');
  fs.mkdirSync(folder); fs.mkdirSync(path.join(folder,'nested')); fs.writeFileSync(path.join(folder,'nested','file.txt'),'safe');
  fs.symlinkSync(root,path.join(folder,'escape'));
  const handlers = new Map(), sender = {mainFrame:{}}, event = {sender,senderFrame:sender.mainFrame}, reveals=[],copies=[];
  const service = install({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showOpenDialog:async()=>({filePaths:[folder]})},shell:{showItemInFolder:p=>reveals.push(p)},clipboard:{writeText:p=>copies.push(p)},getWindow:()=>({webContents:sender}),dir:root,getProjects:()=>[{slug:'linked',dir:folder},{slug:'folderless'}],getSessions:()=>({close(){}}),send(){}});
  t.after(()=>{service.closeAll();fs.rmSync(root,{recursive:true,force:true});});
  const call=(p,e=event)=>handlers.get('workspace:location')(e,p);
  const w=await handlers.get('workspace:open')(event,{}), full=path.join(w.root,'nested','file.txt');
  assert.equal((await call({id:w.id,rel:'nested/file.txt',action:'copyFull'})).path,full);assert.equal(copies.at(-1),full);
  await call({id:w.id,rel:'nested/file.txt',action:'copyRelative'});assert.equal(copies.at(-1),path.join('nested','file.txt'));
  await call({id:w.id,rel:'nested',action:'reveal'});assert.equal(reveals.at(-1),path.join(w.root,'nested'));
  await call({slug:'linked',action:'copyFull'});assert.equal(copies.at(-1),w.root);
  await call({slug:'linked',action:'reveal'});assert.equal(reveals.at(-1),w.root);
  assert.equal((await call({slug:'folderless',action:'resolve'})).available,false);
  const before=copies.length;
  for(const p of [{id:w.id,rel:'../outside',action:'copyFull'},{id:w.id,rel:root,action:'copyFull'},{id:w.id,rel:'escape/file',action:'copyFull'},{slug:'unknown',action:'copyFull'},{slug:'folderless',action:'copyFull'},{id:'forged',action:'copyFull'},{id:w.id,action:'arbitrary'}])assert.ok((await call(p)).error);
  assert.match((await call({id:w.id,action:'copyFull'},{sender:{}})).error,/sender/);assert.equal(copies.length,before);
  service.close(w.id);assert.ok((await call({id:w.id,action:'reveal'})).error);
});
