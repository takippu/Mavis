import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes } from 'node:crypto';
import { id } from '../../../scripts/lib/brain-sync/crypto.mjs';
import { BrainClient } from '../../../scripts/lib/brain-sync/client.mjs';

const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('local Workers/D1/R2 encrypted two-device roundtrip, stale push, conflict, history and revoke',async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:path.join(packageRoot,'src/index.mjs'),compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BLOBS'],bindings:{AUTH_PEPPER:'synthetic-fixture-pepper',BOOTSTRAP_TOKEN:'synthetic-fixture-bootstrap'}}));
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 // D1 exec splits on newlines; pass complete SQL statements including trigger bodies.
 const sql=fs.readFileSync(path.join(packageRoot,'migrations/0001_vault.sql'),'utf8');
 const statements=sql.split(/(?=^CREATE (?:TABLE|TRIGGER)|^PRAGMA)/m).map(value=>value.trim()).filter(Boolean);
 for(const statement of statements)await db.prepare(statement).run();
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mavis-cloud-fixture-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const vault=id(),device=id(),credential=id(),keys={'1':randomBytes(32).toString('base64url')};
 const fetchImpl=(url,options)=>mf.dispatchFetch(url,options);
 const boot=await fetchImpl('https://fixture.test/v1/bootstrap',{method:'POST',headers:{Authorization:'Bearer synthetic-fixture-bootstrap','Content-Type':'application/json'},body:JSON.stringify({vault,device,credential})});assert.equal(boot.status,201,await boot.text());
 const secondBoot=await fetchImpl('https://fixture.test/v1/bootstrap',{method:'POST',headers:{Authorization:'Bearer synthetic-fixture-bootstrap','Content-Type':'application/json'},body:JSON.stringify({vault,device:id(),credential:id()})});assert.notEqual(secondBoot.status,201);
 function client(label,token=credential) {const brainRoot=path.join(temp,label,'brain'),directory=path.join(temp,label,'machine');fs.mkdirSync(path.join(brainRoot,'identity'),{recursive:true});return new BrainClient({config:{endpoint:'https://fixture.test',vault,brainRoot},secrets:{keys,credential:token},directory,fetchImpl,validateCandidate:false});}
 const first=client('first');fs.writeFileSync(path.join(first.root,'identity/profile.md'),'private identity fixture\n[diagram](diagram.pdf)');fs.writeFileSync(path.join(first.root,'identity/diagram.pdf'),'%PDF-1.7\nprivate attachment fixture');
 const pushed=await first.push();assert.equal(pushed.generation,1);assert.equal((await first.push()).noop,true);
 const second=client('second');const pulled=await second.pull();assert.equal(pulled.applied,2);assert.equal(fs.readFileSync(path.join(second.root,'identity/profile.md'),'utf8'),'private identity fixture\n[diagram](diagram.pdf)');assert.equal(fs.readFileSync(path.join(second.root,'identity/diagram.pdf'),'utf8'),'%PDF-1.7\nprivate attachment fixture');
 fs.writeFileSync(path.join(first.root,'identity/profile.md'),'private first edit');await first.push();
 fs.writeFileSync(path.join(second.root,'identity/profile.md'),'private second edit');await assert.rejects(second.push(),/NEEDS_PULL/);await assert.rejects(second.pull(),/CONFLICT/);assert.equal(fs.readFileSync(path.join(second.root,'identity/profile.md'),'utf8'),'private second edit');
 const rows=await db.prepare('SELECT * FROM revisions').all();assert.equal(rows.results.length,2);assert.ok(!JSON.stringify(rows).includes('profile.md'));assert.ok(!JSON.stringify(rows).includes('private first edit'));
 const history=await first.request('/revisions');assert.equal(history.length,2);
 const original=await first.readRevision(pushed.head);const restored=await first.push({operation:'restore',restoreFiles:original.files});assert.equal(restored.generation,3);await first.pull();assert.ok(fs.readFileSync(path.join(first.root,'identity/profile.md'),'utf8').includes('private identity fixture'));
 fs.writeFileSync(path.join(first.root,'identity/profile.md'),'private first edit');await first.push();
 const capability=id();await first.request('/pairings','POST',{id:id(),capability,role:'reader'});
 const readerToken=id(),readerId=id();const enroll=await fetchImpl('https://fixture.test/v1/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capability,device:readerId,credential:readerToken})});assert.equal(enroll.status,201);
 const replay=await fetchImpl('https://fixture.test/v1/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capability,device:id(),credential:id()})});assert.equal(replay.status,401);
 const reader=client('reader',readerToken);await reader.pull();fs.writeFileSync(path.join(reader.root,'identity/profile.md'),'reader forbidden');await assert.rejects(reader.push(),/FORBIDDEN/);
 const conflictPreview=await second.pull({dryRun:true});assert.deepEqual(conflictPreview.conflicts,['identity/profile.md']);
 await second.pull({resolutions:{'identity/profile.md':'local'}});assert.equal((await second.status()).pending.length,1);await second.push();await first.pull();assert.equal(fs.readFileSync(path.join(first.root,'identity/profile.md'),'utf8'),'private second edit');
 // Race real D1-triggered commits with different complete encrypted snapshots.
 const third=client('third');await third.pull();
 fs.writeFileSync(path.join(first.root,'identity/profile.md'),'race first');fs.writeFileSync(path.join(third.root,'identity/profile.md'),'race third');
 const race=await Promise.allSettled([first.push(),third.push()]);assert.equal(race.filter(result=>result.status==='fulfilled').length,1);assert.equal(race.filter(result=>result.status==='rejected').length,1);
 const winner=race[0].status==='fulfilled'?first:third;
 const loser=winner===first?third:first;const raceConflict=await loser.pull({dryRun:true});assert.deepEqual(raceConflict.conflicts,['identity/profile.md']);await loser.pull({resolutions:{'identity/profile.md':'remote'}});
 // A server-accepted commit whose response disappears must recover without another revision.
 const lostResponse=client('lost-response');await lostResponse.pull();fs.writeFileSync(path.join(lostResponse.root,'identity/profile.md'),'receipt retry fixture');
 let lose=true;lostResponse.fetchImpl=async(url,options)=>{const response=await fetchImpl(url,options);if(url.endsWith('/commits')&&lose){lose=false;throw new Error('synthetic lost response');}return response;};
 await assert.rejects(lostResponse.push(),/unavailable/);const recovered=await lostResponse.push();assert.equal(recovered.recovered,true);
 await first.pull();
 const oldKeys={'1':keys['1']};keys['2']=randomBytes(32).toString('base64url');
 const rotated=await first.push({operation:'rotate'});assert.equal(first.state().epoch,2);
 const staleKeyClient=client('old-keys');staleKeyClient.secrets={keys:oldKeys,credential};await assert.rejects(staleKeyClient.pull(),/Missing epoch key/);
 await staleKeyClient.request('/head');staleKeyClient.secrets={keys,credential};await staleKeyClient.pull();
 assert.equal(fs.readFileSync(path.join(staleKeyClient.root,'identity/profile.md'),'utf8'),'receipt retry fixture');
 // Quota checks are inside SQLite reservation triggers, not a racy client preflight.
 await db.prepare('UPDATE vaults SET budget=reserved WHERE id=?').bind(vault).run();
 await assert.rejects(first.request('/uploads','POST',{id:id(),epoch:2,kind:'document',hash:'a'.repeat(64),bytes:1}),/QUOTA_EXCEEDED/);
 await db.prepare('UPDATE vaults SET budget=536870912 WHERE id=?').bind(vault).run();
 // Committed references cannot be pruned even when a forged plan names them.
 const protectedId=Object.values(first.state().files)[0].object.id;
 await db.prepare('UPDATE objects SET created=unixepoch()-700000 WHERE id=?').bind(protectedId).run();
 const maintenance=await first.request('/maintenance','POST',{objects:[protectedId]});assert.deepEqual(maintenance.deleted,[]);
 await assert.rejects(db.prepare('DELETE FROM objects WHERE id=?').bind(protectedId).run(),/REFERENCED_OBJECT/);
 const references=await db.prepare('SELECT * FROM objects').all();const bucket=await mf.getR2Bucket('BLOBS');
 for(const object of references.results){const stored=await bucket.get(`${vault}/${object.id}`);if(stored){const ciphertext=await stored.text();assert.ok(!ciphertext.includes('profile.md'));assert.ok(!ciphertext.includes('receipt retry fixture'));}}
 await first.request(`/devices/${readerId}/revoke`,'POST',{});await assert.rejects(reader.head(),/UNAUTHORIZED/);
 const rollback=client('rollback');rollback.checkpoint(first.state());rollback.fetchImpl=async()=>Response.json({head:null,generation:0,epoch:1});await assert.rejects(rollback.head(),/rollback/);
 const tamperedId=Object.values(first.state().files)[0].object.id;await bucket.put(`${vault}/${tamperedId}`,'tampered ciphertext');
 const corrupt=client('corrupt');await assert.rejects(corrupt.pull(),/integrity failure/);assert.equal(fs.existsSync(path.join(corrupt.root,'identity/profile.md')),false);
});
