import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{43}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tokenHash = (token, env) => createHmac('sha256', env.AUTH_PEPPER).update(token).digest('hex');
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const identifier = value => { if (!ID.test(value || '')) fail(400, 'INVALID_ID'); return value; };
async function bounded(request, limit) {
  if (Number(request.headers.get('content-length') || 0) > limit) fail(413, 'TOO_LARGE');
  const chunks = []; let size = 0;
  if (!request.body) fail(400, 'MISSING_BODY');
  for await (const chunk of request.body) { size += chunk.length; if (size > limit) fail(413, 'TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
async function body(request, fields) {
  let result; try { result = JSON.parse((await bounded(request, 512 * 1024)).toString()); } catch (e) { if (e.status) throw e; fail(400, 'INVALID_JSON'); }
  if (!result || Array.isArray(result) || typeof result !== 'object' || Object.keys(result).some(key => !fields.includes(key))) fail(400, 'INVALID_FIELDS');
  return result;
}
function equal(a, b) { const x=Buffer.from(a || ''), y=Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x,y); }
async function authenticate(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (!ID.test(token || '')) fail(401, 'UNAUTHORIZED');
  const device = await env.DB.prepare('SELECT * FROM devices WHERE credential=? AND revoked=0').bind(tokenHash(token,env)).first();
  if (!device) fail(401, 'UNAUTHORIZED');
  return device;
}
export default {
 async fetch(request, env) {
  try {
   const url = new URL(request.url), route = url.pathname, method = request.method;
   if (method === 'GET' && route === '/health') return json({ protocol: 1, status: 'ok' });
   if (!env.AUTH_PEPPER) fail(503,'NOT_CONFIGURED');
   if (method === 'POST' && route === '/v1/bootstrap') {
    if (!env.BOOTSTRAP_TOKEN || !equal(request.headers.get('Authorization'), `Bearer ${env.BOOTSTRAP_TOKEN}`)) fail(401,'UNAUTHORIZED');
    const input = await body(request,['vault','device','credential']);
    identifier(input.vault); identifier(input.device); identifier(input.credential);
    await env.DB.batch([
     env.DB.prepare('INSERT INTO vaults(id) VALUES(?)').bind(input.vault),
     env.DB.prepare('INSERT INTO devices(id,vault,credential,role) VALUES(?,?,?,\'owner\')').bind(input.device,input.vault,tokenHash(input.credential,env))
    ]);
    return json({ vault:input.vault, device:input.device },201);
   }
   if (method === 'POST' && route === '/v1/enroll') {
    const input = await body(request,['capability','device','credential']);
    identifier(input.capability); identifier(input.device); identifier(input.credential);
    const pairing = await env.DB.prepare('SELECT * FROM pairings WHERE capability=? AND consumed=0 AND expires>=unixepoch()').bind(tokenHash(input.capability,env)).first();
    if (!pairing) fail(401,'PAIRING_EXPIRED');
    await env.DB.batch([
     env.DB.prepare('UPDATE pairings SET consumed=1 WHERE id=?').bind(pairing.id),
     env.DB.prepare('INSERT INTO devices(id,vault,credential,role) VALUES(?,?,?,?)').bind(input.device,pairing.vault,tokenHash(input.credential,env),pairing.role)
    ]);
    return json({ vault:pairing.vault, device:input.device },201);
   }
   if (request.headers.get('X-Mavis-Protocol') !== '1') fail(426,'INCOMPATIBLE_PROTOCOL');
   const device = await authenticate(request,env);
   const rate=await env.DB.prepare('INSERT INTO request_windows(device,minute,requests) VALUES(?,unixepoch()/60,1) ON CONFLICT(device) DO UPDATE SET minute=unixepoch()/60,requests=CASE WHEN minute=unixepoch()/60 THEN requests+1 ELSE 1 END RETURNING requests').bind(device.id).first();
   if(rate.requests>600)fail(429,'THROTTLED');
   const match = route.match(/^\/v1\/vaults\/([A-Za-z0-9_-]{43})(\/.*)$/);
   if (!match || match[1] !== device.vault) fail(404,'NOT_FOUND');
   const [,vault, action] = match;
   const writer = () => { if (!['owner','writer'].includes(device.role)) fail(403,'FORBIDDEN'); };
   const owner = () => { if (device.role !== 'owner') fail(403,'FORBIDDEN'); };
   if (method === 'GET' && action === '/head') return json(await env.DB.prepare('SELECT head,generation,epoch FROM vaults WHERE id=?').bind(vault).first());
   if (method === 'GET' && action === '/revisions') {
    const before=Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before<1) fail(400,'INVALID_CURSOR');
    const result=await env.DB.prepare('SELECT id,parent,generation,epoch,created,operation FROM revisions WHERE vault=? AND generation<? ORDER BY generation DESC LIMIT 100').bind(vault,before).all(); return json(result.results);
   }
   if (method === 'GET' && action.startsWith('/revisions/')) {
    const revision=await env.DB.prepare('SELECT envelope,mac FROM revisions WHERE vault=? AND id=?').bind(vault,identifier(action.slice(11))).first();
    if (!revision) fail(404,'NOT_FOUND'); return json({ ...JSON.parse(revision.envelope),mac:revision.mac });
   }
   if (method === 'POST' && action === '/uploads') {
    writer(); const input=await body(request,['id','epoch','kind','hash','bytes']); identifier(input.id);
    if (!['document','attachment','manifest'].includes(input.kind) || !/^[a-f0-9]{64}$/.test(input.hash || '') || !Number.isInteger(input.bytes) || input.bytes<1 || input.bytes>48*1024*1024 || !Number.isInteger(input.epoch)) fail(400,'INVALID_OBJECT');
    if(input.bytes>(input.kind==='attachment'?32:12)*1024*1024+4096)fail(413,'TOO_LARGE');
    const epoch=await env.DB.prepare('SELECT epoch FROM vaults WHERE id=?').bind(vault).first();
    if(input.epoch!==epoch.epoch && !(device.role==='owner' && input.epoch===epoch.epoch+1))fail(403,'WRONG_EPOCH');
    const existing=await env.DB.prepare('SELECT * FROM objects WHERE id=?').bind(input.id).first();
    if (existing) { if (existing.vault!==vault || existing.hash!==input.hash || existing.bytes!==input.bytes || existing.epoch!==input.epoch || existing.kind!==input.kind) fail(409,'OBJECT_ID_REUSED'); return json({ ready:!!existing.ready }); }
    await env.DB.prepare('INSERT INTO objects(id,vault,epoch,kind,hash,bytes,created) VALUES(?,?,?,?,?,?,unixepoch())').bind(input.id,vault,input.epoch,input.kind,input.hash,input.bytes).run(); return json({ready:false},201);
   }
   if (action.startsWith('/objects/')) {
    const object=await env.DB.prepare('SELECT * FROM objects WHERE vault=? AND id=?').bind(vault,identifier(action.slice(9))).first();
    if (!object) fail(404,'NOT_FOUND'); const key=`${vault}/${object.id}`;
    if(object.ready<0)fail(409,'OBJECT_BEING_PRUNED');
    if (method==='GET') {
     if (!object.ready) fail(404,'NOT_FOUND'); const stored=await env.BLOBS.get(key); if (!stored) fail(404,'NOT_FOUND');
     return new Response(stored.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if (method==='PUT') {
     writer(); const bytes=await bounded(request,object.bytes);
     if (bytes.length!==object.bytes || digest(bytes)!==object.hash) fail(400,'INTEGRITY_FAILURE');
     const existing=await env.BLOBS.head(key);
     if (existing && (existing.size!==object.bytes || existing.customMetadata?.hash!==object.hash)) fail(409,'OBJECT_ID_REUSED');
     if (!existing) await env.BLOBS.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{hash:object.hash}});
     const receipt=await env.BLOBS.head(key);
     if (!receipt || receipt.size!==object.bytes || receipt.customMetadata?.hash!==object.hash) fail(409,'OBJECT_ID_REUSED');
     const ready=await env.DB.prepare('UPDATE objects SET ready=1 WHERE id=? AND vault=? AND ready>=0').bind(object.id,vault).run(); if(!ready.meta.changes)fail(409,'OBJECT_BEING_PRUNED');return json({hash:object.hash,bytes:object.bytes});
    }
   }
   if (method==='POST' && action==='/commits') {
    writer(); const input=await body(request,['version','vault','id','request','parent','generation','epoch','manifest','objects','operation','mac']);
    identifier(input.id); identifier(input.request); identifier(input.manifest); if (input.parent!==null) identifier(input.parent);
    if (input.version!==1 || input.vault!==vault || !Number.isInteger(input.generation) || input.generation<1 || !Number.isInteger(input.epoch) || !['save','restore','rotate'].includes(input.operation) || !/^[a-f0-9]{64}$/.test(input.mac || '') || !Array.isArray(input.objects) || input.objects.length>10001) fail(400,'INVALID_COMMIT');
    const ids=new Set(); for (const ref of input.objects) { identifier(ref.id); if(ids.has(ref.id) || Object.keys(ref).some(k=>!['id','hash','bytes','kind','epoch'].includes(k)) || !/^[a-f0-9]{64}$/.test(ref.hash||'') || !Number.isInteger(ref.bytes) || !['document','attachment','manifest'].includes(ref.kind) || ref.epoch!==input.epoch) fail(400,'INVALID_REFERENCE'); ids.add(ref.id); }
    if (!ids.has(input.manifest)) fail(400,'INCOMPLETE_MANIFEST');
    const {mac,...envelope}=input; const encoded=JSON.stringify(envelope);
    const existing=await env.DB.prepare('SELECT envelope,mac FROM revisions WHERE request=?').bind(input.request).first();
    if(existing) { if(existing.envelope!==encoded || existing.mac!==mac) fail(409,'REQUEST_ID_REUSED'); return json({id:input.id,generation:input.generation}); }
    await env.DB.prepare('INSERT INTO revisions(id,vault,request,parent,generation,epoch,manifest,device,operation,envelope,mac,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,unixepoch())').bind(input.id,vault,input.request,input.parent,input.generation,input.epoch,input.manifest,device.id,input.operation,encoded,mac).run();
    return json({id:input.id,generation:input.generation},201);
   }
   if(method==='GET' && action==='/devices') { owner(); return json((await env.DB.prepare('SELECT id,role,revoked FROM devices WHERE vault=?').bind(vault).all()).results); }
   if(method==='POST' && action==='/pairings') { owner(); const input=await body(request,['id','capability','role']); identifier(input.id); identifier(input.capability); if(!['writer','reader'].includes(input.role)) fail(400,'INVALID_ROLE'); await env.DB.prepare('INSERT INTO pairings(id,vault,capability,role,expires) VALUES(?,?,?,?,unixepoch()+600)').bind(input.id,vault,tokenHash(input.capability,env),input.role).run(); return json({id:input.id,expiresIn:600},201); }
   if(method==='POST' && /^\/devices\/[A-Za-z0-9_-]{43}\/revoke$/.test(action)) { owner(); const target=action.split('/')[2]; await env.DB.prepare('UPDATE devices SET revoked=1 WHERE id=? AND vault=?').bind(target,vault).run(); return json({id:target,revoked:true}); }
   if(method==='GET' && action==='/maintenance') {
    owner(); const result=await env.DB.prepare("SELECT id,bytes FROM objects WHERE vault=? AND created<unixepoch()-604800 AND NOT EXISTS(SELECT 1 FROM revisions,json_each(json_extract(revisions.envelope,'$.objects')) refs WHERE revisions.vault=objects.vault AND json_extract(refs.value,'$.id')=objects.id) LIMIT 100").bind(vault).all();
    return json({kind:'staged-orphans',graceDays:7,objects:result.results,committedHistoryPruned:false});
   }
   if(method==='POST' && action==='/maintenance') {
    owner(); const input=await body(request,['objects']);if(!Array.isArray(input.objects)||input.objects.length>100)fail(400,'INVALID_PLAN');
    const deleted=[];
    for(const objectId of input.objects) {
     identifier(objectId);
     const guarded=await env.DB.prepare("UPDATE objects SET ready=-1 WHERE vault=? AND id=? AND created<unixepoch()-604800 AND NOT EXISTS(SELECT 1 FROM revisions,json_each(json_extract(revisions.envelope,'$.objects')) refs WHERE revisions.vault=objects.vault AND json_extract(refs.value,'$.id')=objects.id)").bind(vault,objectId).run();
     if(!guarded.meta.changes)continue;
     await env.BLOBS.delete(`${vault}/${objectId}`);await env.DB.prepare('DELETE FROM objects WHERE vault=? AND id=? AND ready=-1').bind(vault,objectId).run();deleted.push(objectId);
    }
    return json({deleted,committedHistoryPruned:false});
   }
   fail(404,'NOT_FOUND');
  } catch(error) {
   const known=String(error.message).match(/STALE_HEAD|INCOMPLETE_OBJECTS|INCOMPLETE_MANIFEST|REQUEST_ID_REUSED|QUOTA_EXCEEDED|WRONG_EPOCH|DEVICE_LIMIT|PAIRING_EXPIRED|OWNER_RECOVERY_REQUIRED|ALREADY_BOOTSTRAPPED|FORBIDDEN/);
   return json({error:error.code || known?.[0] || 'INTERNAL_ERROR'},error.status || (known?.[0]==='QUOTA_EXCEEDED'?413:known?409:500));
  }
 }
};
