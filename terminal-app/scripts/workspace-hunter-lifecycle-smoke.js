'use strict';
// Isolated real Mac main/window lifecycle. Deferred runner never contacts a provider.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {app,BrowserWindow,ipcMain}=require('electron');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hunter-lifecycle-')),data=path.join(root,'data');fs.mkdirSync(data);
process.env.MAVIS_TEST_USER_DATA=data;process.env.MAVIS_BRAIN_ROOT=require('./fixture-brain')(path.join(root,'brain'));require('./fixture-agent-guard')(ipcMain);
const moduleService=require('../src/lead-hunter-service'),create=moduleService.createHunterService;let service,active=0,attempts=0,aborted=false;
const runner={run({signal}){active++;attempts++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;setTimeout(()=>{active--;reject(Object.assign(new Error('Fixture interrupted'),{code:'PROCESS'}));},100);},{once:true}));}};
moduleService.createHunterService=options=>(service=create({...options,runner}));
require('../src/main');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function windowReady(){for(let i=0;i<150;i++){const w=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Mavis-Terminal');if(w&&!w.webContents.isLoading()&&await w.webContents.executeJavaScript('!!MT.workspace?.ready'))return w;await delay(40);}throw Error('Window did not become ready');}
let successful=false;
app.on('will-quit',()=>{
 try{assert.equal(active,0,'Quit must await runner teardown');assert.equal(aborted,true);const saved=JSON.parse(fs.readFileSync(path.join(data,'lead-hunter.json')));assert.equal(saved.paused,true);assert.equal(saved.jobs[0].status,'paused');assert.equal(attempts,1);console.log(JSON.stringify({ok:true,macWindowCloseKeepsQueue:true,windowRecreationKeepsOneService:true,quitAwaitsTeardown:true,recoverableCheckpoint:true}));successful=true;fs.rmSync(root,{recursive:true,force:true});}catch(e){console.error(e);process.exitCode=1;}
});
app.whenReady().then(async()=>{
 if(process.platform!=='darwin')throw Error('This fixture verifies the Mac close/quit contract');
 let win=await windowReady();await service.ready;
 const job=await win.webContents.executeJavaScript(`mavis.workspace('hunter-submit',{goal:'Fixture lifecycle search',provider:'codex',filters:{industry:'',region:'Selangor',city:'',website:'any',contact:'any',sources:'public_web',limit:1,skipExisting:true}})`);assert.ok(job.id);
 for(let i=0;i<100&&active===0;i++)await delay(20);assert.equal(active,1);
 win.close();for(let i=0;i<150&&!win.isDestroyed();i++)await delay(40);assert.equal(win.isDestroyed(),true);
 assert.equal(active,1);assert.equal(aborted,false);assert.equal(service.snapshot().jobs[0].status,'running');
 const original=service;app.emit('activate');win=await windowReady();assert.equal(service,original);assert.equal(attempts,1);
 await win.webContents.executeJavaScript(`MT.workspace.run('lead-hunter')`);assert.equal(service.snapshot().jobs[0].status,'running');
 app.quit();await delay(50);assert.equal(active,1,'Teardown has a deliberate delay');
}).catch(async e=>{console.error(e.stack||e);await service?.shutdown().catch(()=>{});app.exit(1);});
setTimeout(()=>{if(!successful){console.error('Lifecycle fixture timed out');app.exit(1);}},20000).unref();
