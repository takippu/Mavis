import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { setImmediate } from 'node:timers';
import { BrainClient } from '../lib/brain-sync/client.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function client(fetchImpl){return new BrainClient({config:{endpoint:'https://example.com',brainRoot:os.tmpdir(),vault:'v'.repeat(43)},secrets:{credential:'c'.repeat(43)},directory:os.tmpdir(),fetchImpl});}
test('rate-limit retry honors the server reset delay',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
 let calls=0;
 const instance=client(async()=>++calls===1?Response.json({error:'THROTTLED'},{status:429,headers:{'Retry-After':'10'}}):Response.json({ok:true}));
 const pending=instance.request('/head');pending.catch(()=>{});await flush();
 t.mock.timers.tick(2000);await flush();assert.equal(calls,1,'must not retry before the reset');
 t.mock.timers.tick(8000);await flush();assert.deepEqual(await pending,{ok:true});assert.equal(calls,2);
});
test('parallel downloads are paced below the minute request limit',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
 const starts=[];const instance=client(async()=>{starts.push(Date.now());return Response.json({ok:true});});
 const pending=Promise.all(Array.from({length:4},()=>instance.request('/head')));await flush();
 assert.equal(starts.length,1);
 for(let n=0;n<3;n++){t.mock.timers.tick(200);await flush();}
 await pending;assert.deepEqual(starts,[0,200,400,600]);
});
test('throttling without a reset header waits past the current minute',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:59000});
 let calls=0;const instance=client(async()=>++calls===1?Response.json({error:'THROTTLED'},{status:429}):Response.json({ok:true}));
 const pending=instance.request('/head');pending.catch(()=>{});await flush();
 t.mock.timers.tick(1000);await flush();assert.equal(calls,1);
 t.mock.timers.tick(1000);await flush();assert.deepEqual(await pending,{ok:true});assert.equal(calls,2);
});
test('startup deadline prevents a retry that cannot finish in time',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:0});
 let calls=0;const instance=client(async()=>{calls++;return Response.json({error:'THROTTLED'},{status:429,headers:{'Retry-After':'10'}});});
 instance.deadline=1000;await assert.rejects(instance.request('/head'),error=>error.exitCode===8);assert.equal(calls,1);
});
