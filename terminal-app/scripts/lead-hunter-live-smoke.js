'use strict';
// Explicit, bounded provider acceptance. Never runs under npm test or touches user records.
if(process.env.MAVIS_HUNTER_LIVE!=='1')throw Error('Set MAVIS_HUNTER_LIVE=1 to authorize this one-batch live acceptance check.');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {HunterStore}=require('../src/lead-hunter-store'),{HunterQueue}=require('../src/lead-hunter-queue'),{CodexRunner}=require('../src/lead-hunter-codex'),{LeadsStore}=require('../src/leads-store'),{importSelected}=require('../src/lead-hunter-import');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hunter-live-')),store=new HunterStore(root),leadsStore=new LeadsStore(root),real=new CodexRunner({dir:root});
let providerRuns=0,providerResult,rawOutput,progress=[];
const execute=real._execute.bind(real);
real._execute=async(...args)=>{const result=await execute(...args);try{rawOutput=JSON.parse(result.final);}catch{}return result;};
const runner={async run(input){providerRuns++;providerResult=await real.run({...input,onEvent:event=>{progress.push({type:event.type,label:event.label||'',at:new Date().toISOString()});input.onEvent(event);}});return providerResult;}};
const queue=new HunterQueue({store,runner,getExisting:()=>({leads:leadsStore.list(),clients:[]}),policy:{maxBatches:1,taskTimeoutMs:125000,batchTimeoutMs:120000}});
(async()=>{
 try{
  await queue.recover();const job=queue.submit({goal:'Find one Lavender branch in Shah Alam, Selangor. Search and cite https://lavender.my/locations/ ; use company Lavender and the industry/address from that same branch.',provider:'codex',filters:{industry:'Bakery',region:'Selangor',city:'Shah Alam',website:'found',contact:'any',sources:'public_web',limit:1,skipExisting:true}});
  const deadline=Date.now()+135000;let current;
  do{await new Promise(r=>setTimeout(r,100));current=queue.snapshot().jobs.find(j=>j.id===job.id);if(Date.now()>deadline)throw Error('Live acceptance deadline exceeded');}while(['queued','running','waiting'].includes(current.status));
  const artifact=process.env.MAVIS_HUNTER_LIVE_OUTPUT;
  const capture={checkedAt:new Date().toISOString(),providerRuns,job:current,rawOutput,result:providerResult,progress};if(artifact){fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(capture,null,2),{mode:0o600});}
  assert.equal(current.status,'completed',current.reason);assert.equal(providerRuns,1);const candidates=store.snapshot().candidates;assert.equal(candidates.length,1,current.reason);
  assert.ok(progress.some(p=>p.type==='search'));assert.ok(progress.some(p=>p.type==='source'));assert.equal(candidates[0].city,'Shah Alam');assert.equal(candidates[0].region,'Selangor');assert.ok(candidates[0].sources.length);
  const selected=importSelected({candidateIds:[candidates[0].id],store,leadsStore,clients:[]});assert.equal(selected.createdLeadIds.length,1);
  const repeat=importSelected({candidateIds:[candidates[0].id],store,leadsStore,clients:[]});assert.equal(repeat.createdLeadIds.length,0);assert.equal(leadsStore.list().length,1);
  const reopened=new LeadsStore(root).list()[0];assert.equal(reopened.stage,'new');assert.equal(reopened.discovery.candidateId,candidates[0].id);
  const evidence={checkedAt:new Date().toISOString(),ok:true,providerRuns,realSearch:true,sourceCorroboration:true,queueCommitted:true,ephemeralSelectedImport:true,idempotentImport:true,job:current,candidates,progress,usage:providerResult.usage,sourceObservations:providerResult.sourceObservations};
  if(artifact){fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,JSON.stringify(evidence,null,2),{mode:0o600});}
  console.log(JSON.stringify({ok:true,providerRuns,realSearch:true,sourceCorroboration:true,queueCommitted:true,ephemeralSelectedImport:true,idempotentImport:true,company:candidates[0].company,source:candidates[0].sources[0].url,artifact:artifact||null}));
 }finally{await queue.shutdown();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
