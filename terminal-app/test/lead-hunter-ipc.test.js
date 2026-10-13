'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { install } = require('../src/workspace-ipc');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-ipc-')), handlers = new Map(), sender = {mainFrame:{}}, calls = [], opened=[];
  const snapshot={version:1,paused:false,jobs:[{id:'job-one'}],candidates:[{id:'candidate-one',jobId:'job-one',sources:[{url:'https://example.org/business'}]}]};
  const hunter={store:{file:path.join(dir,'lead-hunter.json')},snapshot:()=>snapshot,submit:p=>{calls.push(['submit',p]);return{id:'job-two'};},pause:()=>calls.push(['pause']),resume:()=>calls.push(['resume']),cancel:id=>calls.push(['cancel',id]),importSelected:p=>{calls.push(['import',p]);return{createdLeadIds:['lead-one'],existingLeadIds:[],rejected:[]};}};
  let output; const backup=path.join(dir,'backup.json');
  const service=install({ipcMain:{handle:(n,f)=>handlers.set(n,f)},dialog:{showSaveDialog:async()=>({filePath:output||backup,canceled:false})},shell:{openExternal:async url=>opened.push(url)},getWindow:()=>({webContents:sender}),dir,getProjects:()=>[],getSessions:()=>({}),send(){},hunterService:hunter});
  t.after(()=>{service.closeAll();fs.rmSync(dir,{recursive:true,force:true});});
  return{hunter,snapshot,calls,opened,backup,setOutput:p=>output=p,call:(name,p={},e={sender,senderFrame:sender.mainFrame})=>handlers.get('workspace:'+name)?.(e,p),sender};
}
test('hunter IPC rejects foreign frames before any service action',async t=>{
 const f=fixture(t); for(const n of ['hunter-status','hunter-submit','hunter-pause','hunter-resume','hunter-cancel','hunter-results','hunter-import','hunter-open-source']) for(const event of [{sender:{}},{sender:f.sender,senderFrame:{}}]) assert.match((await f.call(n,{},event))?.error||'',/sender/); assert.equal(f.calls.length,0);
});
test('hunter IPC forwards structured tasks and rejects malformed controls',async t=>{
 const f=fixture(t);assert.deepEqual(await f.call('hunter-status'),f.snapshot);
 assert.deepEqual(await f.call('hunter-results',{jobId:'job-one'}),{candidates:f.snapshot.candidates});
 assert.deepEqual(await f.call('hunter-submit',{goal:'Workshops',filters:{region:'Selangor'},provider:'codex'}),{id:'job-two'});
 for(const p of [null,[],{id:5},{id:''},{id:'x'.repeat(129)}]) assert.ok((await f.call('hunter-cancel',p))?.error);
 assert.ok((await f.call('hunter-import',{candidateIds:'all'}))?.error);
 assert.ok((await f.call('hunter-import',{candidateIds:['candidate-one'],acknowledgePossibleDuplicates:'yes'}))?.error);
 assert.equal(f.calls.filter(x=>x[0]==='cancel').length,0);
 await f.call('hunter-import',{candidateIds:['candidate-one'],acknowledgePossibleDuplicates:true});assert.equal(f.calls.at(-1)[1].acknowledgePossibleDuplicates,true);
});
test('hunter source opening allows only public evidence URLs already in results',async t=>{
 const f=fixture(t); assert.deepEqual(await f.call('hunter-open-source',{url:'https://example.org/business'}),{ok:true});assert.equal(f.opened.length,1);
 for(const url of ['file:///etc/passwd','https://example.org/forged','http://127.0.0.1/','https://user:secret@example.org/business','javascript:alert(1)']) assert.ok((await f.call('hunter-open-source',{url}))?.error);
 assert.equal(f.opened.length,1);
});
test('Freelance backup includes hunter data and cannot overwrite the hunter store',async t=>{
 const f=fixture(t);assert.deepEqual(await f.call('freelance-backup'),{ok:true});assert.deepEqual(JSON.parse(fs.readFileSync(f.backup)).hunter,f.snapshot);
 f.setOutput(f.hunter.store.file);assert.match((await f.call('freelance-backup')).error,/different file/);
});
test('manual Leads creation cannot forge an imported candidate provenance',async t=>{
 const f=fixture(t);const result=await f.call('leads-create',{values:{title:'Forged',discovery:{version:1,candidateId:'fake',jobId:'fake',provider:'codex',discoveredAt:new Date().toISOString(),sources:[{url:'https://example.org/business',label:'Example',observedAt:new Date().toISOString()}],website:{state:'unknown',url:''},location:{region:'Selangor',city:'',address:''},industry:''}}});
 assert.match(result.error||'',/Discover/);assert.deepEqual((await f.call('leads-list')).leads,[]);
});
