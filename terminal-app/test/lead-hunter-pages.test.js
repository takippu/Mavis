'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { candidatePage, validationPage } = require('../src/lead-hunter-pages');
const snapshot = { jobs: [], candidates: Array.from({length:2000}, (_, i) => ({id:'c-'+i,jobId:i%2?'job-two':'job-one',company:'Business '+String(i).padStart(4,'0'),region:'Selangor',city:i%2?'Klang':'Shah Alam',industry:'Workshop',discoveredAt:'2026-10-13T00:00:00.000Z'})), validationResults:[] };
test('large candidate search returns bounded deterministic pages with full matching total', () => {
 const first=candidatePage(snapshot,{}), next=candidatePage(snapshot,{offset:25});
 assert.equal(first.total,2000);assert.equal(first.items.length,25);assert.equal(next.items.length,25);
 assert.equal(new Set([...first.items,...next.items].map(c=>c.id)).size,50);
 assert.deepEqual(candidatePage(snapshot,{}),first);
 const filtered=candidatePage(snapshot,{search:'shah alam',jobId:'job-one',limit:100});assert.equal(filtered.total,1000);assert.equal(filtered.items.length,100);
 assert.equal(candidatePage(snapshot,{search:'missing'}).total,0);
});
test('page validation rejects malformed inputs and never allows unbounded response sizes',()=>{
 for(const input of [null,[],{limit:0},{limit:101},{offset:-1},{offset:1.2},{offset:'0'},{search:7},{search:'x'.repeat(121)},{jobId:''},{anything:true}]) assert.throws(()=>candidatePage(snapshot,input));
 assert.equal(candidatePage(snapshot,{offset:50000}).items.length,0);
});
test('validation pages use historical target names and filter by task, outcome and search',()=>{
 const state={jobs:[{id:'v-one',kind:'validate',targetSnapshots:[{candidateId:'c-one',candidate:{company:'Historic Name',city:'Shah Alam',region:'Selangor'}}]}],candidates:[{id:'c-one',company:'Changed name'}],validationResults:[{id:'r-one',taskId:'v-one',candidateId:'c-one',overall:'needs_review',checkedAt:'2026-10-13T00:00:00.000Z'},{id:'r-two',taskId:'v-two',candidateId:'c-two',overall:'passed',checkedAt:'2026-10-13T00:00:00.000Z'}]};
 const page=validationPage(state,{jobId:'v-one',search:'historic',outcome:'needs_review'});assert.equal(page.total,1);assert.equal(page.items[0].company,'Historic Name');
 assert.equal(validationPage(state,{outcome:'failed'}).total,0);assert.throws(()=>validationPage(state,{outcome:'fiction'}));
});
