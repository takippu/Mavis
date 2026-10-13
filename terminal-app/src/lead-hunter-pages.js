'use strict';
// Query responses stay bounded even when the local office holds thousands of observations.
function invalid(message) { throw Object.assign(new Error(message), {code:'HUNTER_INVALID'}); }
function options(value = {}, results = false) {
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['search','offset','limit','jobId',...(results?['outcome']:[])].includes(k))) invalid('Invalid lead hunter page query.');
 const {search='',offset=0,limit=25,jobId,outcome='any'}=value;
 if(typeof search!=='string'||search.length>120||!Number.isInteger(offset)||offset<0||offset>50000||!Number.isInteger(limit)||limit<1||limit>100) invalid('Choose a valid search and page size from 1 to 100.');
 if(jobId!==undefined&&(typeof jobId!=='string'||!jobId.trim()||jobId.length>128)) invalid('Invalid task filter.');
 if(results&&!['any','passed','needs_review','failed'].includes(outcome)) invalid('Invalid validation outcome filter.');
 return {search:search.trim(),offset,limit,jobId,outcome};
}
const fold=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('en-MY');
const matches=(row,search)=>!search||fold([row.company,row.region,row.city,row.industry,row.address].join(' ')).includes(fold(search));
const newest=(a,b,time)=>String(b[time]||'').localeCompare(String(a[time]||''))||String(a.id).localeCompare(String(b.id));
function page(items,q) { return {items:items.slice(q.offset,q.offset+q.limit),total:items.length,offset:q.offset,limit:q.limit}; }
function candidatePage(snapshot,input) {
 const q=options(input);
 const rows=(snapshot.candidates||[]).filter(c=>(!q.jobId||c.jobId===q.jobId)&&matches(c,q.search)).sort((a,b)=>newest(a,b,'discoveredAt'));
 return page(rows,q);
}
function validationPage(snapshot,input) {
 const q=options(input,true), targets=new Map();
 for(const job of snapshot.jobs||[]) if(job.kind==='validate') for(const target of job.targetSnapshots||[]) targets.set(job.id+'\0'+target.candidateId,target.candidate);
 const rows=(snapshot.validationResults||[]).filter(r=>(!q.jobId||r.taskId===q.jobId)&&(q.outcome==='any'||r.overall===q.outcome)).map(r=>{
  const candidate=targets.get(r.taskId+'\0'+r.candidateId)||{};
  return {...r,company:candidate.company||'Business unavailable',region:candidate.region||'',city:candidate.city||'',industry:candidate.industry||'',address:candidate.address||''};
 }).filter(r=>matches(r,q.search)).sort((a,b)=>newest(a,b,'checkedAt'));
 return page(rows,q);
}
function enrichmentCandidatePage(snapshot,input){
 const q=options(input),{latestValidationMap,enrichmentEligibility}=require('./lead-hunter-enrichment-targets');
 const lookup={latest:latestValidationMap(snapshot),candidates:new Map((snapshot.candidates||[]).map(c=>[c.id,c]))};
 const rows=[];
 for(const c of snapshot.candidates||[]){
  if(q.jobId&&c.jobId!==q.jobId||!matches(c,q.search))continue;
  const eligible=enrichmentEligibility(snapshot,c.id,lookup);if(!eligible.eligible)continue;
  rows.push({...c,validationResultId:eligible.validation.id,validationTaskId:eligible.validationTaskId,validatedAt:eligible.validation.checkedAt});
 }
 rows.sort((a,b)=>newest(a,b,'validatedAt'));return page(rows,q);
}
function enrichmentPage(snapshot,input){
 const q=options(input),{latestValidationMap,enrichmentEligibility}=require('./lead-hunter-enrichment-targets'),targets=new Map();
 for(const job of snapshot.jobs||[])if(job.kind==='enrich')for(const target of job.targetSnapshots||[])targets.set(job.id+'\0'+target.candidateId,target);
 const lookup={latest:latestValidationMap(snapshot),candidates:new Map((snapshot.candidates||[]).map(c=>[c.id,c]))};
 const rows=(snapshot.enrichmentResults||[]).filter(r=>!q.jobId||r.taskId===q.jobId).map(r=>{
  const target=targets.get(r.taskId+'\0'+r.candidateId),candidate=target?.candidate||{};
  const eligible=enrichmentEligibility(snapshot,r.candidateId,lookup);
  return {...r,company:candidate.company||'Business unavailable',region:candidate.region||'',city:candidate.city||'',industry:candidate.industry||'',address:candidate.address||'',validationSuperseded:!eligible.eligible||eligible.validation.id!==r.validationResultId};
 }).filter(r=>matches(r,q.search)).sort((a,b)=>newest(a,b,'enrichedAt'));
 return page(rows,q);
}
module.exports={candidatePage,validationPage,enrichmentCandidatePage,enrichmentPage};
