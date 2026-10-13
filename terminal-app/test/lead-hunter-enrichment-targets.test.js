'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {latestValidationMap,enrichmentEligibility,observationDigest,canonicalDigest}=require('../src/lead-hunter-enrichment-targets');
const candidate={id:'one',jobId:'discover-one',company:'One business',region:'Selangor',city:'Shah Alam',sources:[]};
const job=(id)=>({id,kind:'validate',targetSnapshots:[{candidateId:'one',candidate:{...candidate}}],targetCandidateIds:['one'],validationResultIds:['result-'+id]});
const result=(id,overall)=>({id:'result-'+id,taskId:id,candidateId:'one',overall,checkedAt:'2026-10-13T01:00:00.000Z'});
test('newest submitted validation blocks older Passed when unfinished or not Passed',()=>{
 const state={candidates:[candidate],jobs:[job('first')],validationResults:[result('first','passed')]};assert.equal(enrichmentEligibility(state,'one').eligible,true);
 state.jobs.push(job('new'));assert.equal(latestValidationMap(state).get('one').job.id,'new');assert.equal(enrichmentEligibility(state,'one').eligible,false);
 for(const overall of ['needs_review','failed']){state.validationResults.push(result('new',overall));assert.equal(enrichmentEligibility(state,'one').eligible,false);state.validationResults.pop()}
 state.validationResults.push(result('new','passed'));assert.equal(enrichmentEligibility(state,'one').validation.id,'result-new');
});
test('import metadata alone does not invalidate validated business observations',()=>{
 const state={candidates:[{...candidate,importedLeadId:'lead-one'}],jobs:[job('first')],validationResults:[result('first','passed')]};assert.equal(enrichmentEligibility(state,'one').eligible,true);
 assert.equal(observationDigest(candidate),observationDigest(state.candidates[0]));assert.notEqual(canonicalDigest(candidate),canonicalDigest(state.candidates[0]));
 state.candidates[0].city='Klang';assert.equal(enrichmentEligibility(state,'one').eligible,false);assert.equal(enrichmentEligibility(state,'missing').eligible,false);
});
test('result references must belong to the latest task and exact candidate',()=>{
 const state={candidates:[candidate],jobs:[job('first')],validationResults:[{...result('first','passed'),id:'unlinked'}]};assert.equal(enrichmentEligibility(state,'one').eligible,false);
 state.validationResults=[{...result('first','passed'),candidateId:'other'}];assert.equal(enrichmentEligibility(state,'one').eligible,false);
});
test('eligible candidate pages scale to 2000 without rendering or returning unbounded data',()=>{
 const {enrichmentCandidatePage,enrichmentPage}=require('../src/lead-hunter-pages');
 const candidates=Array.from({length:2000},(_,i)=>({...candidate,id:'c-'+String(i).padStart(4,'0'),company:'Business '+i}));
 const task={id:'validated',kind:'validate',targetSnapshots:candidates.map(c=>({candidateId:c.id,candidate:{...c}})),validationResultIds:candidates.map(c=>'r-'+c.id)};
 const state={candidates,jobs:[task],validationResults:candidates.map(c=>({id:'r-'+c.id,taskId:task.id,candidateId:c.id,overall:'passed',checkedAt:'2026-10-13T01:00:00Z'})),enrichmentResults:[]};
 const page=enrichmentCandidatePage(state,{});assert.equal(page.total,2000);assert.equal(page.items.length,25);assert.equal(page.items[0].validationTaskId,'validated');
 state.jobs.push({...job('pending'),targetSnapshots:[{candidateId:'c-0000',candidate:candidates[0]}]});assert.equal(enrichmentCandidatePage(state,{}).total,1999);
 for(const input of [null,[],{limit:101},{search:'x'.repeat(121)},{offset:-1},{outcome:'passed'}]){assert.throws(()=>enrichmentCandidatePage(state,input));assert.throws(()=>enrichmentPage(state,input))}
});
test('historical enrichment results use submitted identity and flag superseding validation',()=>{
 const {enrichmentPage}=require('../src/lead-hunter-pages');
 const state={candidates:[candidate],jobs:[job('first'),{id:'enrich-one',kind:'enrich',targetSnapshots:[{candidateId:'one',candidate:{...candidate}}]}],validationResults:[result('first','passed')],enrichmentResults:[{id:'e-one',taskId:'enrich-one',candidateId:'one',validationResultId:'result-first',enrichedAt:'2026-10-13T01:00:00Z'}]};
 assert.equal(enrichmentPage(state,{}).items[0].validationSuperseded,false);
 state.jobs.push(job('new'));const page=enrichmentPage(state,{search:'one business',jobId:'enrich-one'});assert.equal(page.total,1);assert.equal(page.items[0].validationSuperseded,true);assert.equal(page.items[0].company,'One business');
});
