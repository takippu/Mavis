'use strict';
// Real main/service/store/queue/UI, isolated user data and a controlled runner. No provider calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {app,BrowserWindow,ipcMain,shell}=require('electron');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mavis-validation-ui-')),data=path.join(root,'data');fs.mkdirSync(data);
process.env.MAVIS_TEST_USER_DATA=data;process.env.MAVIS_BRAIN_ROOT=require('./fixture-brain')(path.join(root,'brain'));require('./fixture-agent-guard')(ipcMain);
const {HunterStore}=require('../src/lead-hunter-store');
const seedStore=new HunterStore(data),stamp='2026-10-13T01:00:00.000Z';
for(let i=0;i<20;i++)seedStore.enqueue({goal:'Fixture Discover '+i,model:'gpt-5.5',filters:{region:'Selangor',limit:100}});
const seed=seedStore.snapshot();
for(const [batch,job]of seed.jobs.entries()){
 job.status='completed';job.completedBatches=10;job.checkpointId=crypto.randomUUID();
 for(let k=0;k<100;k++){
  const i=batch*100+k,id='fixture-'+String(i).padStart(4,'0');job.candidateIds.push(id);
  seed.candidates.push({id,jobId:job.id,company:'Fixture business '+String(i).padStart(4,'0'),industry:'Design studio',region:'Selangor',city:i%2?'Klang':'Shah Alam',address:'',website:{state:'not_observed',url:''},contact:{email:'',phone:'',form:''},sources:[{url:'https://example.org/business/'+id,label:'Fixture source',observedAt:stamp}],identityKeys:['business:'+id],duplicate:{kind:i%11===0?'confident':'none',recordIds:i%11===0?['existing-'+i]:[]},discoveredAt:stamp,...(i%7===0?{importedLeadId:'imported-'+i}:{})});
 }
}
fs.writeFileSync(seedStore.file,JSON.stringify(seed));assert.equal(seedStore.snapshot().candidates.length,2000);
const originalCandidates=JSON.stringify(seed.candidates),calls=[],errors=[],opened=[];
shell.openExternal=async url=>opened.push(url);
const fakeRunner={run(input){return new Promise((resolve,reject)=>{calls.push({...input,resolve,reject});input.signal.addEventListener('abort',()=>reject(Object.assign(Error('Fixture stopped'),{code:'PROCESS'})),{once:true})})}};
const serviceModule=require('../src/lead-hunter-service'),create=serviceModule.createHunterService;let service;
serviceModule.createHunterService=options=>(service=create({...options,runner:fakeRunner,getModels:()=>[{id:'gpt-5.5',label:'GPT-5.5',available:true},{id:'gpt-6.1-sol',label:'GPT-6.1 Sol',available:true},{id:'gpt-5.4',label:'GPT-5.4',available:false,reason:'Unavailable fixture model'}]}));
app.on('web-contents-created',(_e,wc)=>wc.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)}));require('../src/main');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 let win;for(let i=0;i<150;i++){win=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Mavis-Terminal');if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!MT.workspace?.ready'))break;await delay(50)}assert.ok(win);
 const js=code=>win.webContents.executeJavaScript(code),click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const poll=async code=>{for(let i=0;i<160;i++){if(await js('Boolean('+code+')'))return;await delay(40)}throw Error('Timed out: '+code+'\n'+await js(`document.querySelector('.ws-page:not([hidden])')?.innerText`))};
 const input=(name,value)=>js(`(()=>{let n=document.querySelector('#lh-validation-form [name='+${JSON.stringify(name)}+']');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const capture=async name=>{await delay(120);fs.writeFileSync(path.join(root,name+'.png'),(await win.webContents.capturePage()).toPNG())};
 win.setSize(1600,1000);await js(`MT.theme.apply('slate');MT.workspace.run('lead-hunter')`);await poll(`document.querySelector('#lh-validate-agent')&&!document.querySelector('#lh-submit-task').disabled`);
 assert.equal(await js(`document.querySelector('#lh-agent-menu').open`),false);assert.equal(await js(`document.querySelectorAll('.lh-scene button').length`),3);await capture('office');
 await click('#lh-validate-agent');await poll(`document.querySelectorAll('[data-validation-candidate-id]').length===25`);
 assert.match(await js(`document.querySelector('#lh-validation-picker-pagination').textContent`),/2000/);
 assert.equal(await js(`document.querySelector('[data-validation-candidate-id="fixture-0000"] input').disabled`),false,'Imported/confident duplicate remains selectable');
 await input('goal','Check selected fixture businesses');await input('model','gpt-6.1-sol');
 await click('#lh-validation-select-page');assert.match(await js(`document.querySelector('#lh-validation-selection-count').textContent`),/^25/);
 await click('[data-focus="validation-picker-page:next"]');await poll(`document.querySelector('[data-validation-candidate-id="fixture-0025"]')`);await click('#lh-validation-select-page');assert.match(await js(`document.querySelector('#lh-validation-selection-count').textContent`),/^50/);
 await js(`(()=>{let n=document.getElementById('lh-validation-search');n.value='Fixture business 1000';n.dispatchEvent(new Event('input',{bubbles:true}));})()`);await poll(`document.querySelectorAll('[data-validation-candidate-id]').length===1&&document.querySelector('[data-validation-candidate-id="fixture-1000"]')`);assert.match(await js(`document.querySelector('#lh-validation-selection-count').textContent`),/^50/);
 await click('[data-validation-candidate-id="fixture-1000"] input');assert.match(await js(`document.querySelector('#lh-validation-selection-count').textContent`),/^51/);await capture('goal-large-list');
 await js(`document.querySelector('#lh-validation-form').requestSubmit()`);await poll(`!document.querySelector('#lh-agent-menu').open`);for(let i=0;i<100&&!calls.length;i++)await delay(30);assert.equal(calls[0].job.kind,'validate');assert.equal(calls[0].job.model,'gpt-6.1-sol');assert.equal(calls[0].job.targetCandidateIds.length,51);assert.equal(calls[0].targets.length,10);
 await click('#lh-validate-agent');await poll(`document.querySelector('[data-validation-candidate-id="fixture-1000"]')`);await input('model','gpt-5.5');await input('goal','Second fixture task');await click('[data-validation-candidate-id="fixture-1000"] input');await js(`document.querySelector('#lh-validation-form').requestSubmit()`);await poll(`!document.querySelector('#lh-agent-menu').open`);
 const jobs=service.snapshot().jobs.filter(j=>j.kind==='validate');assert.deepEqual(jobs.map(j=>j.model),['gpt-6.1-sol','gpt-5.5']);assert.deepEqual(jobs.map(j=>j.status),['running','queued']);
 const {normalizeValidationBatch}=require('../src/lead-hunter-validation');
 calls[0].resolve({validationResults:normalizeValidationBatch({observations:[]},[],{job:calls[0].job,targets:calls[0].targets}),summary:'Fixture unknown evidence'});
 for(let i=0;i<100&&calls.length<2;i++)await delay(30);assert.equal(calls.length,2);assert.equal(service.snapshot().validationResults.length,10);assert.equal(calls[1].job.id,jobs[0].id);
 await click('#lh-validate-agent');await click('#lh-results-tab');await poll(`document.querySelectorAll('[data-validation-result-id]').length===10`);assert.match(await js(`document.querySelector('#lh-validation-result-list').textContent`),/Needs review/);
 await js(`(()=>{let n=document.getElementById('lh-validation-results-filter');n.value=${JSON.stringify(jobs[0].id)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);await poll(`document.querySelector('.lh-result-context').textContent.includes('Running')`);
 await js(`window.fixtureEvidenceNode=document.querySelector('[data-validation-result-id] details');fixtureEvidenceNode.open=true;fixtureEvidenceNode.querySelector('summary').focus()`);await capture('partial-results');
 await js(`mavis.workspace('hunter-cancel',{id:${JSON.stringify(jobs[0].id)}})`);for(let i=0;i<100&&calls.length<3;i++)await delay(30);assert.equal(calls.length,3);assert.equal(calls[2].job.id,jobs[1].id);assert.equal(service.snapshot().validationResults.length,10);
 await poll(`document.querySelector('.lh-result-context').textContent.includes('Cancelled')`);
 assert.equal(await js(`fixtureEvidenceNode===document.querySelector('[data-validation-result-id] details')&&fixtureEvidenceNode.open&&document.activeElement===fixtureEvidenceNode.querySelector('summary')`),true,'Status updates retain evidence and focus');
 await js(`(()=>{let n=document.getElementById('lh-validation-results-filter');n.value='';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const target=calls[2].targets[0],c=target.candidate,url='https://fixture-business.example/contact';
 const raw={candidateId:target.candidateId,company:c.company,industry:c.industry,region:c.region,city:c.city,address:'',website:{state:'found',url},contact:{email:'public@fixture-business.example',phone:'',form:''},sources:[{url,label:'Fixture contact'}]};
 const text=c.company+' '+c.industry+' '+c.region+' '+c.city+' public@fixture-business.example';
 calls[2].resolve({validationResults:normalizeValidationBatch({observations:[raw]},[{url,finalUrl:url,text,blocks:[text],pageTitle:c.company+' Contact',label:'Fixture contact',observedAt:stamp}],{job:calls[2].job,targets:calls[2].targets}),summary:'Fixture acquired evidence'});
 await poll(`document.querySelectorAll('[data-validation-result-id]').length===11`);assert.match(await js(`document.querySelector('#lh-validation-result-list').textContent`),/Passed/);
 const sourceSelector='[data-validation-result-id="'+service.snapshot().validationResults.at(-1).id+'"] .lh-source-button';await click(sourceSelector);for(let i=0;i<100&&!opened.length;i++)await delay(20);assert.equal(opened.at(-1),url);
 assert.equal(JSON.stringify(service.snapshot().candidates),originalCandidates,'Validation must not mutate original candidates');const leadsFile=path.join(data,'freelance-leads.json');assert.equal(fs.existsSync(leadsFile)?JSON.parse(fs.readFileSync(leadsFile,'utf8')).leads.length:0,0);
 await js(`document.querySelector('#lh-agent-menu').close()`);await click('#lh-validate-agent');await poll(`document.querySelectorAll('[data-validation-candidate-id]').length===1`);assert.equal(await js(`document.querySelector('#lh-validation-form [name=model]').value`),'gpt-5.5');
 win.setSize(390,844);await capture('goal-narrow');assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);await js(`document.querySelector('#lh-validation-form [name=website]').scrollIntoView({block:'center'})`);await capture('filters-narrow');
 await js(`document.querySelector('#lh-agent-menu').close()`);await click('#lh-discover-agent');assert.equal(await js(`document.querySelector('#lh-menu-title').textContent`),'Discover');assert.equal(await js(`document.querySelector('#lh-goal-form [name=model]').value`),'gpt-5.5');
 await js(`document.querySelector('#lh-agent-menu').close()`);await click('#lh-validate-agent');await js(`(()=>{let n=document.getElementById('lh-validation-search');n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));})()`);await poll(`document.querySelector('[data-validation-candidate-id="fixture-0000"]')`);
 for(let page=0;page<4;page++){await click('#lh-validation-select-page');if(page<3){await click('[data-focus="validation-picker-page:next"]');await poll(`document.querySelector('[data-validation-candidate-id="fixture-${String((page+1)*25).padStart(4,'0')}"]')`)}}
 assert.match(await js(`document.querySelector('#lh-validation-selection-count').textContent`),/^100/);await click('[data-focus="validation-picker-page:next"]');await poll(`document.querySelector('[data-validation-candidate-id="fixture-0100"]')`);assert.equal(await js(`[...document.querySelectorAll('#lh-validation-picker input')].every(n=>n.disabled)`),true);assert.equal(await js(`document.getElementById('lh-validation-select-page').disabled`),true);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,candidates:2000,boundedRows:25,crossPageSelection:true,selectionCap100:true,importedDuplicateSelectable:true,immutableModels:true,sharedFIFO:true,partialUnknownPreserved:true,cancelAdvances:true,resultStatusRefresh:true,realSourcePolicy:true,originalRecordsUnchanged:true,independentAgentDrafts:true,narrowNoOverflow:true,errors,artifacts:root}));await service.shutdown();app.exit(0);
}).catch(async e=>{console.error(e.stack||e);await service?.shutdown().catch(()=>{});app.exit(1)});
setTimeout(()=>{console.error('Validate fixture timed out');app.exit(1)},60000).unref();
