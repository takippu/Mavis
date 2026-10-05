import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, sign, verify, sealRecovery, openRecovery, id } from '../lib/brain-sync/crypto.mjs';
import { snapshot, validatePath, mergePlan } from '../lib/brain-sync/scope.mjs';
import { resolveRoots } from '../lib/brain-sync/roots.mjs';
import { atomicWrite, storeSecrets, loadSecrets, applyJournal, recoverJournal } from '../lib/brain-sync/state.mjs';
import { hash } from '../lib/brain-sync/crypto.mjs';
import { spawnSync } from 'node:child_process';
import { codeRoot } from '../lib/brain-sync/roots.mjs';
import { planMigration, applyMigration } from '../lib/brain-sync/migrate.mjs';
import { buildBootContext } from '../lib/boot-context-core.mjs';
import { recallExact } from '../lib/recall-core.mjs';
import { cloudPlan, applyCloudPlan } from '../lib/brain-sync/cloud.mjs';

function fixture(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'mavis-sync-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('encrypted objects bind vault/epoch/kind/id and reject tampering',()=>{
 const master=randomBytes(32),vault=id(),object=encrypt(Buffer.from('private project'),master,vault);
 assert.equal(decrypt(object.data,master,{...object,vault}).toString(),'private project');
 assert.ok(!object.data.toString().includes('private project'));
 assert.throws(()=>decrypt(object.data,master,{...object,vault:id()}));
 assert.throws(()=>decrypt(object.data,randomBytes(32),{...object,vault}));
 const corrupted=Buffer.from(object.data);corrupted[corrupted.length-5]^=1;assert.throws(()=>decrypt(corrupted,master,{...object,vault}));
 assert.notEqual(encrypt(Buffer.from('private project'),master,vault).id,object.id);
 const envelope={id:id(),generation:1};const mac=sign(envelope,master,vault,1);verify(envelope,mac,master,vault,1);assert.throws(()=>verify({...envelope,generation:2},mac,master,vault,1));
});
test('published synthetic interoperability vector decrypts and verifies unchanged',()=>{
 const vector=JSON.parse(fs.readFileSync(path.join(codeRoot,'docs/brain-sync/test-vector.json'),'utf8'));
 const master=Buffer.from(vector.master,'base64url');assert.equal(decrypt(Buffer.from(vector.object.data,'base64'),master,{...vector.object,vault:vector.vault}).toString(),vector.plaintext);verify(vector.commit,vector.mac,master,vector.vault,1);
});
test('recovery rejects wrong passwords and unbounded KDF settings',()=>{
 const envelope=sealRecovery({keys:{'1':'sample'},receipt:{generation:7}},'long-private-passphrase');
 assert.equal(openRecovery(envelope,'long-private-passphrase').receipt.generation,7);
 assert.throws(()=>openRecovery(envelope,'wrong-private-passphrase'));
 assert.throws(()=>openRecovery({...envelope,kdf:{name:'scrypt',N:2**30,r:8,p:1}},'long-private-passphrase'));
});
test('scope collects referenced PDFs only, strips local path and denies traversal',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'projects/example'),{recursive:true});
 fs.writeFileSync(path.join(root,'projects/example/index.md'),'---\npath: C:/private/local\nlast_accessed: 2026-01-01\nname: Example\n---\n[Attachment](diagram.pdf)');
 fs.writeFileSync(path.join(root,'projects/example/diagram.pdf'),'%PDF-1.7\nfixture');
 fs.writeFileSync(path.join(root,'projects/example/unreferenced.pdf'),'%PDF-1.7\nprivate');
 fs.mkdirSync(path.join(root,'projects/example/_backup'));fs.writeFileSync(path.join(root,'projects/example/_backup/private.md'),'never upload');
 const scan=snapshot(root);assert.deepEqual(Object.keys(scan.files).sort(),['projects/example/diagram.pdf','projects/example/index.md']);
 assert.ok(!scan.files['projects/example/index.md'].data.toString().includes('C:/private'));
 for(const name of ['projects/../.env','projects/x/CON.md','projects/x/../../identity/a.md','projects/x/a%20.md','projects/x/a.md.'])assert.throws(()=>validatePath(name));
 fs.writeFileSync(path.join(root,'projects/example/binary.md'),Buffer.from([255,254]));assert.throws(()=>snapshot(root));
});
test('three way merge preserves independent edits and rejects edit/delete and concurrent creation',()=>{
 const f=hash=>({hash});
 assert.deepEqual(mergePlan({a:f('old')},{a:f('local'),b:f('new')},{a:f('old'),c:f('remote')}).changes,[{path:'c',before:null,after:'remote'}]);
 assert.deepEqual(mergePlan({a:f('old')},{a:f('local')},{}).conflicts,['a']);
 assert.deepEqual(mergePlan({},{a:f('local')},{a:f('remote')}).conflicts,['a']);
 assert.equal(mergePlan({a:f('old')},{a:f('same')},{a:f('same')}).conflicts.length,0);
});
test('root precedence keeps code separate from registered data',t=>{
 const root=fixture(t),machine=path.join(root,'machine');fs.mkdirSync(machine);fs.writeFileSync(path.join(machine,'config.json'),JSON.stringify({brainRoot:path.join(root,'registered')}));
 const env={MAVIS_SYNC_HOME:machine,MAVIS_DATA_ROOT:path.join(root,'environment')};
 assert.equal(resolveRoots({env,sourceRoot:root}).brainRoot,env.MAVIS_DATA_ROOT);
 assert.equal(resolveRoots({env,sourceRoot:root,brainRoot:path.join(root,'explicit')}).brainRoot,path.join(root,'explicit'));
 delete env.MAVIS_DATA_ROOT;assert.equal(resolveRoots({env,sourceRoot:root}).brainRoot,path.join(root,'registered'));
});
test('apply journal restores originals after an interrupted checkpoint',t=>{
 const root=fixture(t),machine=path.join(root,'machine');fs.mkdirSync(path.join(root,'identity'));fs.writeFileSync(path.join(root,'identity/profile.md'),'before');
 applyJournal(root,machine,[{path:'identity/profile.md',originalHash:hash('before')}],{'identity/profile.md':{data:Buffer.from('after')}});
 assert.equal(fs.readFileSync(path.join(root,'identity/profile.md'),'utf8'),'after');
 assert.deepEqual(recoverJournal(root,machine),{recovered:true});assert.equal(fs.readFileSync(path.join(root,'identity/profile.md'),'utf8'),'before');
});
test('apply journal refuses to overwrite concurrent edits',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'identity'));fs.writeFileSync(path.join(root,'identity/profile.md'),'changed');
 assert.throws(()=>applyJournal(root,path.join(root,'machine'),[{path:'identity/profile.md',originalHash:hash('before')}],{'identity/profile.md':{data:Buffer.from('after')}}));
 assert.equal(fs.readFileSync(path.join(root,'identity/profile.md'),'utf8'),'changed');
});
test('Windows DPAPI stores no plaintext key and decrypts for current user',{skip:process.platform!=='win32'},t=>{
 const root=fixture(t),secret={keys:{'1':randomBytes(32).toString('base64url')},credential:id()};storeSecrets(root,secret);
 assert.deepEqual(loadSecrets(root),secret);const disk=fs.readFileSync(path.join(root,'secrets.json'),'utf8');assert.ok(!disk.includes(secret.credential));assert.ok(!disk.includes(secret.keys['1']));
});
test('separate-root initialization and both-harness installation use code assets and synthetic identity',{skip:process.platform!=='win32'},t=>{
 const temp=fixture(t),brainRoot=path.join(temp,'brain'),machine=path.join(temp,'machine');
 const env={...process.env,MAVIS_SYNC_HOME:machine,MAVIS_DATA_ROOT:brainRoot,MAVIS_INSTALL_ASSUME_HARNESSES:'claude,codex',CLAUDE_CONFIG_DIR:path.join(temp,'claude'),CODEX_HOME:path.join(temp,'codex'),MAVIS_AGENTS_HOME:path.join(temp,'agents')};
 const run=(script,args=[])=>spawnSync(process.execPath,[path.join(codeRoot,'scripts',script),...args],{env,cwd:temp,encoding:'utf8',windowsHide:true});
 const initialized=run('brain.mjs',['init','--brain-root',brainRoot,'--endpoint','https://synthetic-fixture.test','--json']);assert.equal(initialized.status,0,initialized.stderr);assert.ok(fs.existsSync(path.join(brainRoot,'rules/_details/daily-memory-format.md')));assert.ok(!fs.existsSync(path.join(brainRoot,'scripts')));
 fs.mkdirSync(path.join(brainRoot,'identity'));fs.writeFileSync(path.join(brainRoot,'identity/profile.md'),'---\nname: Synthetic Owner\n---\n');
 const boot=run('boot-context.mjs',['--json']);assert.equal(boot.status,0,boot.stderr);assert.ok(JSON.parse(boot.stdout).identity.profile.includes('Synthetic Owner'));
 const installed=run('install-harness.mjs',['--harness','both','--yes']);assert.equal(installed.status,0,installed.stderr);
 const activation=fs.readFileSync(path.join(temp,'agents/skills/mavis/SKILL.md'),'utf8');assert.ok(activation.includes(codeRoot.replace(/\\/g,'/')+'/AGENTS.md'));assert.ok(activation.includes(brainRoot.replace(/\\/g,'/')));assert.ok(!activation.includes('{{'));
});
test('local migration copies all reference assets, preserves original and verifies links before cutover',t=>{
 const temp=fixture(t),source=path.join(temp,'source'),destination=path.join(temp,'destination'),machine=path.join(temp,'machine');
 fs.mkdirSync(path.join(source,'identity'),{recursive:true});fs.mkdirSync(path.join(source,'projects'));
 fs.writeFileSync(path.join(source,'identity/profile.md'),'# Synthetic Owner\n');
 fs.writeFileSync(path.join(source,'projects/asset.pdf'),'%PDF-1.7\nlocal unreferenced asset');
 const plan=planMigration(source,destination,codeRoot);assert.equal(plan.files.length,2);
 const applied=applyMigration(plan,machine,{cutover:true});assert.equal(applied.selected,true);assert.ok(fs.existsSync(path.join(source,'identity/profile.md')));assert.equal(fs.readFileSync(path.join(destination,'projects/asset.pdf'),'utf8'),'%PDF-1.7\nlocal unreferenced asset');
 const boot=buildBootContext({root:destination,codeRoot,today:'2026-10-05'});assert.equal(boot.status,'ready');
 const recall=recallExact({root:destination,codeRoot,query:'push my brain'});assert.ok(recall.results.some(result=>result.kind==='skill'&&result.slug==='brain-sync'));
});
test('project selection uses a device-local path override without changing synced metadata',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'identity'));fs.writeFileSync(path.join(root,'identity/profile.md'),'# Synthetic Owner');fs.mkdirSync(path.join(root,'projects/example'),{recursive:true});fs.writeFileSync(path.join(root,'projects/_index.md'),'- [example](example/index.md) — app, active — Fixture.');fs.writeFileSync(path.join(root,'projects/example/index.md'),'---\nname: Example\npath: C:/old-machine/example\n---');
 const boot=buildBootContext({root,codeRoot,cwd:'/Users/example/projects/example',projectOverrides:{example:{path:'/Users/example/projects/example'}},today:'2026-10-05'});assert.equal(boot.project.slug,'example');assert.equal(boot.project.localPath,'/Users/example/projects/example');assert.ok(boot.project.index.includes('C:/old-machine'));
});
test('completed apply checkpoint recovers by finishing rather than rolling back files',t=>{
 const root=fixture(t),directory=path.join(root,'machine');fs.mkdirSync(path.join(root,'identity'));fs.writeFileSync(path.join(root,'identity/profile.md'),'before');
 applyJournal(root,directory,[{path:'identity/profile.md',originalHash:hash('before')}],{'identity/profile.md':{data:Buffer.from('after')}},{before:{head:'old'},next:{head:'new'}});
 atomicWrite(path.join(directory,'state.json'),JSON.stringify({head:'new'}));assert.deepEqual(recoverJournal(root,directory),{recovered:true,completed:true});assert.equal(fs.readFileSync(path.join(root,'identity/profile.md'),'utf8'),'after');
});
test('independent owner cloud plan is previewed, resumes dedicated resources and refuses collisions',async t=>{
 const temp=fixture(t),account='a'.repeat(32),plan=cloudPlan(account,'synthetic-owner-vault');const commands=[];
 const runner=(args,chosenAccount,options)=>{
  assert.equal(chosenAccount,account);commands.push(args);
  if(args[0]==='whoami')return JSON.stringify({loggedIn:true,accounts:[{id:account}]});
  if(args[0]==='deployments')return null;
  if(args[0]==='d1'&&args[1]==='list')return '[]';
  if(args[0]==='d1'&&args[1]==='create')return 'database_id = "12345678-1234-1234-1234-123456789012"';
  if(args[0]==='d1'&&args[1]==='execute'&&args.includes('--command'))return '[{"results":[]}]';
  if(args[0]==='r2'&&args[2]==='dev-url'&&args[3]==='get')return 'Public access via the r2.dev URL is disabled.';
 if(args[0]==='secret'){assert.ok(!args.includes(options.input));return '';}
  if(args[0]==='d1'&&args[1]==='execute'&&args.includes('--file')){
   const config=JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1],'utf8'));
   const sql=fs.readFileSync(args[args.indexOf('--file')+1],'utf8');
   assert.ok(!sql.includes('\r'));assert.ok(sql.includes('CREATE TRIGGER revision_guard'));
   assert.ok(sql.includes("INSERT INTO d1_migrations(name) VALUES('0001_vault.sql')"));
  }
  if(args[0]==='deploy')return 'https://synthetic-owner-vault.synthetic.workers.dev';
  return '';
 };
 const fetchImpl=async url=>url.endsWith('/health')?Response.json({protocol:1}):Response.json({error:'UNAUTHORIZED'},{status:401});
 const options={runner,fetchImpl,bootstrapToken:'private-bootstrap-fixture',pepper:'private-pepper-fixture'};
 const deployed=await applyCloudPlan(plan,temp,options);assert.equal(deployed.privateSeed,false);
 await applyCloudPlan(plan,temp,options);assert.equal(commands.filter(args=>args[0]==='d1'&&args[1]==='create').length,1);assert.equal(commands.filter(args=>args[0]==='r2'&&args[2]==='create').length,1);
 const receipt=fs.readFileSync(path.join(temp,'cloud-receipt.json'),'utf8');assert.ok(!receipt.includes(options.pepper));assert.ok(!receipt.includes(options.bootstrapToken));
 const other=path.join(temp,'other');
 await assert.rejects(applyCloudPlan(plan,other,{...options,runner:(args,chosenAccount,options)=>args[0]==='deployments'?'[]':runner(args,chosenAccount,options)}),/exists already/);
 await assert.rejects(applyCloudPlan({...plan,sourceHash:'wrong'},other,options),/changed/);
});
