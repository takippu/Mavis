'use strict';
const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {install}=require('../src/workspace-ipc'), {createHunterService}=require('../src/lead-hunter-service');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'validate-ipc-')),handlers=new Map(),sender={mainFrame:{}},calls=[],opened=[];
 const state={version:2,paused:false,jobs:[{id:'validate-task',kind:'validate',targetSnapshots:[{candidateId:'one',candidate:{company:'Original company',region:'Selangor',city:'Shah Alam'}}]}],candidates:[{id:'one',company:'First company',jobId:'discover-task',sources:[],discoveredAt:'2026-10-13T01:00:00Z'}],validationResults:[{id:'result-one',taskId:'validate-task',candidateId:'one',overall:'needs_review',checkedAt:'2026-10-13T01:00:00Z',sources:[{url:'https://public.example/business',finalUrl:'https://public.example/contact',label:'Contact',observedAt:'2026-10-13T01:00:00Z'}]}]};
 const queue={snapshot:()=>state,recover:async()=>state,submitValidation:p=>{calls.push(p);return{id:'new-validate'}},shutdown:async()=>{}};
 const store={file:path.join(dir,'lead-hunter.json'),snapshot:()=>state};
 const hunter=createHunterService({dir,store,queue,runner:{},getModels:()=>[{id:'gpt-5.5',available:true},{id:'gpt-6.1-sol',available:false,reason:'Fixture unavailable'}]});
 const backup=path.join(dir,'backup.json');
 const service=install({ipcMain:{handle:(n,f)=>handlers.set(n,f)},dialog:{showSaveDialog:async()=>({filePath:backup,canceled:false})},shell:{openExternal:async url=>opened.push(url)},getWindow:()=>({webContents:sender}),dir,getProjects:()=>[],getSessions:()=>({}),send(){},imageService:{},hunterService:hunter});
 t.after(async()=>{await hunter.shutdown();service.closeAll();fs.rmSync(dir,{recursive:true,force:true})});
 return {hunter,state,calls,opened,backup,call:(n,p={},event={sender,senderFrame:sender.mainFrame})=>handlers.get('workspace:'+n)(event,p),sender};
}
test('Validate IPC enforces sender policy and immutable supported model forwarding',async t=>{
 const f=fixture(t), input={goal:'Check businesses',model:'gpt-5.5',candidateIds:['one'],criteria:{region:'Selangor'}};
 for(const name of ['hunter-submit-validation','hunter-candidates','hunter-validation-results'])for(const event of [{sender:{}},{sender:f.sender,senderFrame:{}}])assert.match((await f.call(name,input,event)).error,/sender/);
 for(const payload of [null,[],{...input,model:'gpt-6.1-sol'},{...input,model:'nonexistent'}])assert.ok((await f.call('hunter-submit-validation',payload)).error);
 assert.deepEqual(await f.call('hunter-submit-validation',input),{id:'new-validate'});assert.equal(f.calls.length,1);assert.equal(f.calls[0].model,'gpt-5.5');
});
test('bounded query handlers reject malformed options and return historical result labels',async t=>{
 const f=fixture(t);assert.equal((await f.call('hunter-candidates',{})).items.length,1);
 assert.equal((await f.call('hunter-validation-results',{jobId:'validate-task',search:'original'})).items[0].company,'Original company');
 for(const name of ['hunter-candidates','hunter-validation-results'])for(const payload of [null,[],{limit:101},{limit:0},{offset:-1},{search:42},{unknown:true}])assert.ok((await f.call(name,payload)).error);
});
test('validation evidence source policy and backup preserve history without changing original candidates',async t=>{
 const f=fixture(t), before=JSON.stringify(f.state.candidates);
 assert.deepEqual(await f.call('hunter-open-source',{url:'https://public.example/business'}),{ok:true});
 assert.deepEqual(await f.call('hunter-open-source',{url:'https://public.example/contact'}),{ok:true});
 for(const url of ['http://127.0.0.1/','file:///private/file','https://unobserved.example/'])assert.ok((await f.call('hunter-open-source',{url})).error);
 await f.call('freelance-backup');const backup=JSON.parse(fs.readFileSync(f.backup));assert.deepEqual(backup.hunter.validationResults,f.state.validationResults);
 assert.equal(JSON.stringify(f.state.candidates),before);assert.equal(f.opened.length,2);
});
