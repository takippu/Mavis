'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {install}=require('../src/workspace-ipc'),{createHunterService}=require('../src/lead-hunter-service');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enrich-ipc-')),handlers=new Map(),sender={mainFrame:{}},calls=[],opened=[];
 const candidate={id:'one',jobId:'discover-one',company:'Fixture business',region:'Selangor',city:'Shah Alam',sources:[],discoveredAt:'2026-10-13T01:00:00Z'};
 const state={version:3,paused:false,jobs:[{id:'validation-one',kind:'validate',targetSnapshots:[{candidateId:'one',candidate:{...candidate}}],validationResultIds:['v-result']},{id:'enrich-one',kind:'enrich',targetSnapshots:[{candidateId:'one',candidate:{...candidate}}]}],candidates:[candidate],validationResults:[{id:'v-result',taskId:'validation-one',candidateId:'one',overall:'passed',checkedAt:'2026-10-13T01:00:00Z'}],enrichmentResults:[{id:'e-result',taskId:'enrich-one',candidateId:'one',validationResultId:'v-result',enrichedAt:'2026-10-13T02:00:00Z',sources:[{url:'https://public.example/enrich',finalUrl:'https://public.example/services',label:'Services',observedAt:'2026-10-13T02:00:00Z'}]}]};
 const queue={snapshot:()=>state,recover:async()=>state,submitEnrichment:p=>{calls.push(p);return{id:'new-enrich'}},shutdown:async()=>{}};
 const hunter=createHunterService({dir,store:{file:path.join(dir,'lead-hunter.json'),snapshot:()=>state},queue,runner:{},getModels:()=>[{id:'gpt-5.5',available:true},{id:'gpt-6.1-sol',available:false,reason:'Unavailable fixture model'}]});
 const backup=path.join(dir,'backup.json');const service=install({ipcMain:{handle:(n,f)=>handlers.set(n,f)},dialog:{showSaveDialog:async()=>({filePath:backup,canceled:false})},shell:{openExternal:async url=>opened.push(url)},getWindow:()=>({webContents:sender}),dir,getProjects:()=>[],getSessions:()=>({}),send(){},imageService:{},hunterService:hunter});
 t.after(async()=>{await hunter.shutdown();service.closeAll();fs.rmSync(dir,{recursive:true,force:true})});
 return {state,calls,opened,backup,sender,call:(n,p={},event={sender,senderFrame:sender.mainFrame})=>handlers.get('workspace:'+n)(event,p)};
}
test('Enrich IPC gates sender/model and forwards selected inputs without changing records',async t=>{
 const f=fixture(t),input={goal:'Research business',model:'gpt-5.5',candidateIds:['one'],groups:{offerings:true,contacts:true,branding:true,website:true,brief:true}},before=JSON.stringify([f.state.candidates,f.state.validationResults]);
 for(const name of ['hunter-submit-enrichment','hunter-enrich-candidates','hunter-enrichment-results'])for(const event of [{sender:{}},{sender:f.sender,senderFrame:{}}])assert.match((await f.call(name,input,event)).error,/sender/);
 const omitted={...input};delete omitted.model;
 for(const payload of [null,[],omitted,{...input,model:undefined},{...input,model:null},{...input,model:'gpt-6.1-sol'},{...input,model:'bad'}])assert.ok((await f.call('hunter-submit-enrichment',payload)).error);
 assert.deepEqual(await f.call('hunter-submit-enrichment',input),{id:'new-enrich'});assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{...input,provider:'codex'});assert.equal(JSON.stringify([f.state.candidates,f.state.validationResults]),before);
});
test('Enrich queries remain bounded and reflect current validation eligibility',async t=>{
 const f=fixture(t);assert.equal((await f.call('hunter-enrich-candidates',{})).total,1);assert.equal((await f.call('hunter-enrichment-results',{})).items[0].company,'Fixture business');
 for(const name of ['hunter-enrich-candidates','hunter-enrichment-results'])for(const payload of [null,[],{limit:101},{offset:-1},{search:22},{unknown:true}])assert.ok((await f.call(name,payload)).error);
 f.state.jobs.push({id:'new-validation',kind:'validate',targetSnapshots:[{candidateId:'one',candidate:f.state.candidates[0]}],validationResultIds:[]});assert.equal((await f.call('hunter-enrich-candidates',{})).total,0);assert.equal((await f.call('hunter-enrichment-results',{})).items[0].validationSuperseded,true);
});
test('Enrichment backup/source policy includes only persisted acquired public sources',async t=>{
 const f=fixture(t);for(const url of ['https://public.example/enrich','https://public.example/services'])assert.deepEqual(await f.call('hunter-open-source',{url}),{ok:true});
 for(const url of ['http://localhost/','file:///private/file','https://unobserved.example/mockup'])assert.ok((await f.call('hunter-open-source',{url})).error);
 await f.call('freelance-backup');assert.deepEqual(JSON.parse(fs.readFileSync(f.backup)).hunter.enrichmentResults,f.state.enrichmentResults);assert.equal(f.opened.length,2);
});
