import fs from 'node:fs';
import path from 'node:path';
import { id, hash, encrypt, decrypt, sign, verify, canonical } from './crypto.mjs';
import { snapshot, mergePlan, validatePath, safeFile } from './scope.mjs';
import { readJSON } from './roots.mjs';
import { writeJSON, atomicWrite, applyJournal, recoverJournal, withLock } from './state.mjs';
import { lint } from '../brain-lint-core.mjs';

const failure = (message, exitCode = 2) => Object.assign(new Error(message), { exitCode });
export function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw failure('Endpoint must be an HTTPS origin (loopback HTTP permitted for local tests)');
  return url.origin;
}
export class BrainClient {
  constructor({ config, secrets, directory, fetchImpl = fetch, validateCandidate = true, deadline = null }) {
    this.config = config; this.secrets = secrets; this.directory = directory; this.fetchImpl = fetchImpl; this.validateCandidate = validateCandidate;
    this.endpoint = validateEndpoint(config.endpoint); this.root = config.brainRoot;
    if(!/^[A-Za-z0-9_-]{43}$/.test(config.vault||'') || !this.root || !fs.existsSync(this.root) || !fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink())throw failure('Invalid vault or data root; recover/configure before sync');
    this.deadline = deadline;
  }
  key(epoch = 1) { const key = this.secrets.keys?.[String(epoch)]; if (!key) throw failure('Missing epoch key; import protected recovery material',5);if(typeof key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(key))throw failure('Invalid epoch key',7);return Buffer.from(key,'base64url'); }
  state() { return readJSON(path.join(this.directory,'state.json'), { head:null,generation:0,epoch:1,files:{},tombstones:[] }); }
  checkpoint(value) { writeJSON(path.join(this.directory,'state.json'), value); }
  async request(route, method = 'GET', value, binary = false, attempt = 0) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(this.secrets.credential||''))throw failure('Device credentials missing; privately enroll before remote sync',5);
    let response;
    const timeout=this.deadline?Math.min(30000,this.deadline-Date.now()):30000;
    if(timeout<=0)throw failure('Startup sync deadline reached; using local memory',4);
    try { response = await this.fetchImpl(`${this.endpoint}/v1/vaults/${this.config.vault}${route}`, { method, redirect:'error', signal:AbortSignal.timeout(timeout), headers:{ Authorization:`Bearer ${this.secrets.credential}`, 'X-Mavis-Protocol':'1', ...(value ? {'Content-Type':binary?'application/octet-stream':'application/json'}:{}) }, body:value ? binary?value:JSON.stringify(value):undefined }); }
    catch { throw failure('Sync endpoint unavailable or timed out; local changes retained',4); }
    if(attempt<2 && [429,500,502,503,504].includes(response.status) && (method==='GET'||method==='PUT'||['/uploads','/commits'].includes(route))) {
      const retryAfter=Number(response.headers.get('Retry-After'));
      const delay=Number.isFinite(retryAfter)&&retryAfter>0?Math.min(2000,retryAfter*1000):250*2**attempt;
      if(!this.deadline||Date.now()+delay<this.deadline) {
        await response.body?.cancel();await new Promise(resolve=>setTimeout(resolve,delay));
        return this.request(route,method,value,binary,attempt+1);
      }
    }
    if (!response.ok) {
      let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>512*1024)throw failure('Remote error exceeds limit',7);chunks.push(Buffer.from(chunk));}
      let error;try{error=JSON.parse(Buffer.concat(chunks).toString());}catch{error={error:'REMOTE_ERROR'};}
      throw failure(error.error || 'REMOTE_ERROR', response.status===409?3:response.status===401||response.status===403?5:response.status===426?6:response.status===413||response.status===429?8:7);
    }
    if (binary && method==='GET') {
      const chunks=[]; let size=0;
      for await (const chunk of response.body) {size+=chunk.length; if(size>48*1024*1024) throw failure('Remote object too large',7); chunks.push(Buffer.from(chunk));}
      return Buffer.concat(chunks);
    }
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>512*1024)throw failure('Remote metadata exceeds limit',7);chunks.push(Buffer.from(chunk));}
    try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw failure('Remote returned malformed metadata',7);}
  }
  async head() {
    const head=await this.request('/head'), state=this.state();
    if (!Number.isSafeInteger(head.generation) || head.generation<state.generation || (head.generation===state.generation && head.head!==state.head)) throw failure('Remote rollback or inconsistent head detected',7);
    const trusted=readJSON(path.join(this.directory,'trusted.json'));
    if(trusted && (head.generation<trusted.generation || (head.generation===trusted.generation && head.head!==trusted.head)))throw failure('Remote is older than privately supplied trusted receipt',7);
    return head;
  }
  async status(remote = false) {
    const local=snapshot(this.root), state=this.state();
    const pending=[...new Set([...Object.keys(local.files),...Object.keys(state.files)])].filter(name=>local.files[name]?.hash!==state.files[name]?.hash);
    return { configured:true, mode:'explicit', scope:'markdown-and-referenced-attachments', head:state.head,generation:state.generation,pending, warnings:local.warnings, interrupted:fs.existsSync(path.join(this.directory,'apply.json')), ...(remote?{remote:await this.head()}:{}) };
  }
  async upload(object) {
    const {data,...reference}=object;
    const receipt=await this.request('/uploads','POST',reference);
    if (!receipt.ready) {
      const uploaded=await this.request(`/objects/${object.id}`,'PUT',data,true);
      if(uploaded.hash!==object.hash || uploaded.bytes!==object.bytes) throw failure('Upload receipt mismatch',7);
    }
    return reference;
  }
  validateLocal(root) {
    if (!this.validateCandidate) return;
    const report=lint(root,{codeRoot:this.config.codeRoot||root});
    if(report.counts.fail) throw failure(`Brain lint has ${report.counts.fail} failures; resolve before sync`);
  }
  async push({ dryRun = false, operation = 'save', restoreFiles = null } = {}) {
    if(!fs.existsSync(path.join(this.root,'identity/profile.md')))throw failure('Identity missing; recover an existing brain or explicitly set up a new one before push');
    return withLock(this.directory,async()=>{
      if (fs.existsSync(path.join(this.directory,'apply.json')) || fs.existsSync(path.join(this.directory,'save.json'))) throw failure('Unfinished apply/save must be recovered before push',7);
      const state=this.state(), local=restoreFiles?{files:restoreFiles,warnings:[]}:snapshot(this.root);
      if(local.warnings.length) throw failure('Potential embedded credentials detected; review flagged documents before upload');
      this.validateLocal(this.root);
      const names=new Set([...Object.keys(state.files),...Object.keys(local.files)]);
      const changed=[...names].filter(name=>state.files[name]?.hash!==local.files[name]?.hash);
      if(dryRun) return {dryRun:true,changes:changed.map(name=>({path:name,bytes:local.files[name]?.bytes||0,deleted:!local.files[name]})),bytes:changed.reduce((n,name)=>n+(local.files[name]?.bytes||0),0)};
      const head=await this.head();
      const previousPending=readJSON(path.join(this.directory,'pending.json'));
      if(previousPending) {
        let confirmed;
        try {confirmed=await this.readRevision(previousPending.envelope.id,false);}catch(error){if(error.message!=='NOT_FOUND')throw error;}
        if(confirmed) {
          if(canonical(confirmed)!==canonical(previousPending.manifest))throw failure('Pending receipt mismatch',7);
          if(previousPending.envelope.operation!=='restore')this.checkpoint({head:confirmed.id,generation:confirmed.generation,epoch:confirmed.epoch,files:confirmed.files,tombstones:confirmed.tombstones});
          fs.unlinkSync(path.join(this.directory,'pending.json'));
          return {recovered:true,head:confirmed.id,generation:confirmed.generation,needsPull:head.head!==confirmed.id};
        }
      }
      if(head.head!==state.head) {
        if(previousPending) {
          const archived=path.join(this.directory,'abandoned',`${previousPending.envelope.id}.json`);writeJSON(archived,previousPending);fs.unlinkSync(path.join(this.directory,'pending.json'));
        }
        throw failure('NEEDS_PULL: remote has changed; pull before pushing',3);
      }
      if(!changed.length && operation==='save') return {noop:true,head:state.head};
      const pendingFile=path.join(this.directory,'pending.json');
      let pending=readJSON(pendingFile);
      const fingerprint=hash(canonical(Object.fromEntries(Object.entries(local.files).map(([name,file])=>[name,file.hash]))));
      if(pending && (pending.parent!==state.head || pending.fingerprint!==fingerprint)) throw failure('Interrupted push has a different snapshot; doctor must resolve pending upload',7);
      if(!pending) {
        const objects=[], files={};
        const targetEpoch=operation==='rotate'?head.epoch+1:head.epoch;
        for(const [name,file] of Object.entries(local.files)) {
          if(operation!=='rotate' && state.files[name]?.hash===file.hash) files[name]=state.files[name];
          else {
            const object=encrypt(file.data,this.key(targetEpoch),this.config.vault,targetEpoch,file.kind);
            const {data,...reference}=object; objects.push({...reference,data:data.toString('base64')});
            files[name]={hash:file.hash,bytes:file.bytes,kind:file.kind,object:reference};
          }
        }
        const revision=id(), request=id(), generation=head.generation+1;
        const tombstones=[...new Set([...state.tombstones,...Object.keys(state.files).filter(name=>!files[name])])].filter(name=>!files[name]);
        const manifest={version:1,vault:this.config.vault,id:revision,parent:state.head,generation,epoch:targetEpoch,files,tombstones};
        const manifestObject=encrypt(Buffer.from(canonical(manifest)),this.key(targetEpoch),this.config.vault,targetEpoch,'manifest');
        const {data,...reference}=manifestObject; objects.push({...reference,data:data.toString('base64')});
        const envelope={version:1,vault:this.config.vault,id:revision,request,parent:state.head,generation,epoch:targetEpoch,manifest:reference.id,objects:[...Object.values(files).map(file=>file.object),reference].sort((a,b)=>a.id.localeCompare(b.id)),operation};
        if(Buffer.byteLength(canonical(envelope))>512*1024) throw failure('Commit metadata exceeds limit; reduce document count');
        pending={parent:state.head,fingerprint,objects,manifest,envelope,mac:sign(envelope,this.key(targetEpoch),this.config.vault,targetEpoch)};
        writeJSON(pendingFile,pending);
      }
      for(const object of pending.objects) await this.upload({...object,data:Buffer.from(object.data,'base64')});
      let receipt;
      try {receipt=await this.request('/commits','POST',{...pending.envelope,mac:pending.mac});}
      catch(error) {
        if(error.message==='STALE_HEAD') {writeJSON(path.join(this.directory,'abandoned',`${pending.envelope.id}.json`),pending);fs.unlinkSync(pendingFile);}
        throw error;
      }
      if(receipt.id!==pending.envelope.id || receipt.generation!==pending.envelope.generation) throw failure('Commit receipt mismatch',7);
      const confirmed=await this.readRevision(receipt.id,false);
      if(operation!=='restore')this.checkpoint({head:confirmed.id,generation:confirmed.generation,epoch:confirmed.epoch,files:confirmed.files,tombstones:confirmed.tombstones});
      fs.unlinkSync(pendingFile);
      return {head:receipt.id,generation:receipt.generation,changed:changed.length,uploadedObjects:pending.objects.length};
    });
  }
  async readRevision(revision, includeBodies = true) {
    try {
    const response=await this.request(`/revisions/${revision}`), {mac,...envelope}=response;
    if(envelope.version!==1 || envelope.vault!==this.config.vault || envelope.id!==revision || !Array.isArray(envelope.objects) || envelope.objects.length>10001) throw failure('Invalid revision',7);
    verify(envelope,mac,this.key(envelope.epoch),this.config.vault,envelope.epoch);
    const ref=envelope.objects.find(object=>object.id===envelope.manifest && object.kind==='manifest');
    if(!ref) throw failure('Missing manifest reference',7);
    const bytes=await this.request(`/objects/${ref.id}`,'GET',undefined,true);
    const manifestBytes=decrypt(bytes,this.key(ref.epoch),{...ref,vault:this.config.vault});if(manifestBytes.length>8*1024*1024)throw failure('Manifest exceeds limit',7);
    const manifest=JSON.parse(manifestBytes.toString());
    for(const field of ['version','vault','id','parent','generation','epoch']) if(manifest[field]!==envelope[field]) throw failure('Manifest revision mismatch',7);
    if(!manifest.files || Array.isArray(manifest.files) || !Array.isArray(manifest.tombstones) || Object.keys(manifest.files).length>10000) throw failure('Invalid manifest',7);
    const folded=new Set(), refs=new Map(envelope.objects.map(object=>[object.id,object]));
    if(refs.size!==envelope.objects.length) throw failure('Duplicate object references',7);
    const referenced=new Set([ref.id]);
    for(const [name,file] of Object.entries(manifest.files)) {
      validatePath(name); const lower=name.toLowerCase(); if(folded.has(lower)) throw failure('Case collision in manifest',7); folded.add(lower);
      if(!file.object || canonical(refs.get(file.object.id))!==canonical(file.object) || file.object.epoch!==envelope.epoch || !/^[a-f0-9]{64}$/.test(file.hash||'') || !Number.isInteger(file.bytes) || file.bytes<0 || file.bytes>(file.kind==='attachment'?24:8)*1024*1024 || file.kind!==file.object.kind || !['document','attachment'].includes(file.kind) || (file.kind==='document')!==/\.md$/i.test(name)) throw failure('Invalid document reference',7);
      referenced.add(file.object.id);
      if(includeBodies) {
        const ciphertext=await this.request(`/objects/${file.object.id}`,'GET',undefined,true);
        file.data=decrypt(ciphertext,this.key(envelope.epoch),{...file.object,vault:this.config.vault});
        if(hash(file.data)!==file.hash || file.data.length!==file.bytes) throw failure('Plaintext integrity failure',7);
        if(file.kind==='document') {const text=new TextDecoder('utf-8',{fatal:true}).decode(file.data);if(text.includes('\0')) throw failure('Binary Markdown',7);}
      }
    }
    if(referenced.size!==refs.size) throw failure('Manifest object-list mismatch',7);
    for(const name of manifest.tombstones) {validatePath(name);if(manifest.files[name]) throw failure('Invalid tombstone',7);}
    return manifest;
    } catch(error) {if(!error.exitCode)error.exitCode=7;throw error;}
  }
  async pull({dryRun=false,resolutions={}}={}) {
    return withLock(this.directory,async()=>{
      if(fs.existsSync(path.join(this.directory,'apply.json')) || fs.existsSync(path.join(this.directory,'save.json')) || fs.existsSync(path.join(this.directory,'pending.json'))) throw failure('Unfinished save/apply/push blocks pull; run doctor',7);
      const head=await this.head(), state=this.state();
      if(head.head===state.head) return {noop:true,head:state.head};
      if(!head.head) return {noop:true,head:null};
      const local=snapshot(this.root), remote=await this.readRevision(head.head,false);
      const documents=Object.entries(remote.files);let nextDocument=0;
      await Promise.all(Array.from({length:Math.min(4,documents.length)},async()=>{
        while(nextDocument<documents.length) {
          const [name,file]=documents[nextDocument++],existing=local.files[name],base=state.files[name];
          if(existing?.hash===file.hash && base?.object.id===file.object.id) {file.data=existing.data;continue;}
          const ciphertext=await this.request(`/objects/${file.object.id}`,'GET',undefined,true);
          file.data=decrypt(ciphertext,this.key(remote.epoch),{...file.object,vault:this.config.vault});
          if(hash(file.data)!==file.hash||file.data.length!==file.bytes)throw failure('Plaintext integrity failure',7);
        }
      })).catch(error=>{if(!error.exitCode)error.exitCode=7;throw error;});
      // A newly referenced remote attachment may already exist as a preserved local asset.
      // Include that physical preimage in the merge rather than treating it as absent.
      for(const [name,file] of Object.entries(remote.files))if(!local.files[name]) {
        const target=safeFile(this.root,name);
        if(fs.existsSync(target)) {
          const data=fs.readFileSync(target);local.files[name]={hash:hash(data),originalHash:hash(data),bytes:data.length,kind:file.kind,data};
        }
      }
      const plan=mergePlan(state.files,local.files,remote.files);
      if(remote.generation!==head.generation || remote.epoch!==head.epoch) throw failure('Head receipt mismatch',7);
      const unresolved=plan.conflicts.filter(name=>!['local','remote'].includes(resolutions[name]));
      for(const name of plan.conflicts) if(resolutions[name]==='remote')plan.changes.push({path:name,before:local.files[name]?.hash||null,after:remote.files[name]?.hash||null});
      if(unresolved.length) {
        if(dryRun)return {dryRun:true,head:remote.id,changes:plan.changes,conflicts:unresolved};
        if(!dryRun) {
          const conflictDir=path.join(this.directory,'conflicts',remote.id);
          writeJSON(path.join(conflictDir,'plan.json'),{head:remote.id,paths:plan.conflicts});
          for(const [index,name] of plan.conflicts.entries()) {
            writeJSON(path.join(conflictDir,`${index}.json`),{path:name,base:state.files[name]||null,local:local.files[name]?.hash||null,remote:remote.files[name]?.hash||null});
            if(local.files[name]) atomicWrite(path.join(conflictDir,`${index}.local`),local.files[name].data);
            if(remote.files[name]) atomicWrite(path.join(conflictDir,`${index}.remote`),remote.files[name].data);
            if(state.files[name]) {
              const original=state.files[name].object;
              const ciphertext=await this.request(`/objects/${original.id}`,'GET',undefined,true);
              const bytes=decrypt(ciphertext,this.key(original.epoch),{...original,vault:this.config.vault});
              if(hash(bytes)!==state.files[name].hash)throw failure('Conflict base integrity failure',7);
              atomicWrite(path.join(conflictDir,`${index}.base`),bytes);
            }
          }
        }
        throw Object.assign(failure(`CONFLICT: ${plan.conflicts.length} divergent paths; active brain unchanged`,3),{details:{paths:unresolved,head:remote.id}});
      }
      if(dryRun) return {dryRun:true,...plan,head:remote.id};
      const candidate=path.join(this.directory,'candidates',id());fs.mkdirSync(candidate,{recursive:true,mode:0o700});
      for(const [name,file] of Object.entries(local.files)) atomicWrite(safeFile(candidate,name),file.data);
      for(const change of plan.changes) {
        const target=safeFile(candidate,change.path);
        if(change.after===null) fs.unlinkSync(target); else atomicWrite(target,remote.files[change.path].data);
      }
      // Code contracts are local validation inputs, never part of the encrypted manifest.
      if(this.config.codeRoot) for(const name of ['AGENTS.md','CLAUDE.md','SETUP.md']) {
        const source=path.join(this.config.codeRoot,name); if(fs.existsSync(source)) fs.copyFileSync(source,path.join(candidate,name));
      }
      this.validateLocal(candidate);
      const candidateScan=snapshot(candidate);
      for(const [name,file] of Object.entries(remote.files)) if(file.kind==='attachment' && !candidateScan.files[name] && !local.files[name]) throw failure('Remote attachment lacks an in-scope Markdown reference',7);
      // Preserve machine-local frontmatter on existing project index files.
      for(const change of plan.changes) {
        change.originalHash=local.files[change.path]?.originalHash || null;
        if(remote.files[change.path] && /^projects\/[^/]+\/index\.md$/.test(change.path) && local.files[change.path]) {
          const source=fs.readFileSync(safeFile(this.root,change.path),'utf8');
          const fields=source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].split(/\r?\n/).filter(line=>/^(?:path|last_accessed):/.test(line))||[];
          if(fields.length) remote.files[change.path].data=Buffer.from(remote.files[change.path].data.toString().replace(/^---\r?\n/,`---\n${fields.join('\n')}\n`));
        }
      }
      const files=Object.fromEntries(Object.entries(remote.files).map(([name,{data,...file}])=>[name,file]));
      const next={head:remote.id,generation:remote.generation,epoch:remote.epoch,files,tombstones:remote.tombstones};
      if(this.deadline && Date.now()>=this.deadline)throw failure('Startup sync deadline reached before apply; local memory retained',4);
      const finish=applyJournal(this.root,this.directory,plan.changes,remote.files,{before:state,next});
      this.checkpoint(next); finish();
      return {head:remote.id,generation:remote.generation,applied:plan.changes.length};
    });
  }
  async sync(options) { const pulled=await this.pull(options); const pushed=await this.push(options); return {pulled,pushed}; }
  doctor() {
    const lock=readJSON(path.join(this.directory,'lock'));
    let live=false;
    if(lock) {try {process.kill(lock.pid,0);live=true;}catch(e){if(e.code!=='ESRCH')live=true;}}
    return {lock:lock?{pid:lock.pid,live}:null,interruptedApply:fs.existsSync(path.join(this.directory,'apply.json')),pendingPush:fs.existsSync(path.join(this.directory,'pending.json')),incompleteSave:fs.existsSync(path.join(this.directory,'save.json'))};
  }
  recover() {const report=this.doctor();if(report.lock?.live)throw failure('A live sync process holds the lock',7);if(report.lock)fs.unlinkSync(path.join(this.directory,'lock'));return recoverJournal(this.root,this.directory);}
}
