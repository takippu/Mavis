'use strict';
const crypto=require('node:crypto');
function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
const canonicalDigest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
function observationDigest(candidate){const copy={...candidate};delete copy.importedLeadId;return canonicalDigest(copy)}
function latestValidationMap(snapshot){
 const results=new Map((snapshot.validationResults||[]).map(r=>[r.taskId+'\0'+r.candidateId,r])),latest=new Map();
 // Durable array order is submission order; wall-clock changes cannot revive an older Passed task.
 for(const job of snapshot.jobs||[])if(job.kind==='validate'){
  const ownedResults=new Set(job.validationResultIds||[]);
  for(const target of job.targetSnapshots||[]){const result=results.get(job.id+'\0'+target.candidateId);latest.set(target.candidateId,{job,target,result:result&&ownedResults.has(result.id)?result:null})}
 }
 return latest;
}
function enrichmentEligibility(snapshot,candidateId,lookup){
 const candidate=lookup?.candidates?.get(candidateId)||(snapshot.candidates||[]).find(c=>c.id===candidateId);
 if(!candidate)return {eligible:false,reason:'This Discover candidate is unavailable.'};
 const latest=(lookup?.latest||latestValidationMap(snapshot)).get(candidateId);
 if(!latest)return {eligible:false,reason:'Run Validate before enriching this business.'};
 if(!latest.result)return {eligible:false,reason:'The latest validation has not checked this business yet.'};
 if(latest.result.overall!=='passed')return {eligible:false,reason:'The latest validation needs review or failed. Enrich requires Passed.'};
 if(!latest.target?.candidate||observationDigest(candidate)!==observationDigest(latest.target.candidate))return {eligible:false,reason:'Business observations changed since validation. Validate again before enriching.'};
 return {eligible:true,reason:'',candidate,validation:latest.result,validationTaskId:latest.job.id};
}
module.exports={latestValidationMap,enrichmentEligibility,canonicalDigest,observationDigest};
