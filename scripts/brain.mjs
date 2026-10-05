#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveRoots, readJSON, codeRoot } from './lib/brain-sync/roots.mjs';
import { id, sealRecovery, openRecovery, canonical } from './lib/brain-sync/crypto.mjs';
import { snapshot, safeFile } from './lib/brain-sync/scope.mjs';
import { storeSecrets, loadSecrets, writeJSON, atomicWrite, withLock } from './lib/brain-sync/state.mjs';
import { BrainClient, validateEndpoint } from './lib/brain-sync/client.mjs';
import { prompt } from './lib/brain-sync/prompt.mjs';
import { planInit, applyInit } from './lib/init-brain-core.mjs';
import { planMigration, applyMigration } from './lib/brain-sync/migrate.mjs';
import { cloudPlan, applyCloudPlan } from './lib/brain-sync/cloud.mjs';

const args=process.argv.slice(2);
const value=flag=>{const index=args.indexOf(flag);if(index<0)return null;if(!args[index+1]||args[index+1].startsWith('--'))throw new Error(`${flag} requires a value`);return args[index+1];};
const output=value_=>process.stdout.write(`${args.includes('--json')?JSON.stringify(value_):JSON.stringify(value_,null,2)}\n`);
const help=`Mavis Brain Sync (protocol 1)
  node scripts/brain.mjs init --brain-root <directory> [--endpoint <https-origin>]
  node scripts/brain.mjs bootstrap
  node scripts/brain.mjs status [--remote] [--json]
  node scripts/brain.mjs push|pull|sync [--dry-run]
  node scripts/brain.mjs history [--before <generation>]
  node scripts/brain.mjs restore --revision <id> [--dry-run]
  node scripts/brain.mjs conflicts --resolve <relative-path> --choose local|remote [--dry-run]
  node scripts/brain.mjs invite --output <private-file> [--role writer|reader]
  node scripts/brain.mjs connect --input <private-invitation> --brain-root <directory>
  node scripts/brain.mjs enroll --input <private-invitation>
  node scripts/brain.mjs export --output <private-file>
  node scripts/brain.mjs import --input <private-export> --brain-root <empty-directory>
  node scripts/brain.mjs devices [--revoke <device-id>]
  node scripts/brain.mjs key rotate [--dry-run]
  node scripts/brain.mjs key export --output <private-file>
  node scripts/brain.mjs key import --input <private-file>
  node scripts/brain.mjs maintenance [--apply-plan <JSON-file>]
  node scripts/brain.mjs doctor [--recover]
  node scripts/brain.mjs save begin|finish
  node scripts/brain.mjs cloud setup --account <id> --name <resource-prefix>
  node scripts/brain.mjs migrate --destination <empty-directory> [--output <plan-file>]
  node scripts/brain.mjs migrate --apply-plan <plan-file> [--cutover]
  node scripts/brain.mjs paths --project <slug> --path <local-project-directory>
Credentials and unlocking secrets are entered privately in a terminal, never as flags.
Writes occur only when the named operation is explicitly requested. Uploads are explicit.
Use MAVIS_SYNC_HOME to isolate machine configuration; MAVIS_DATA_ROOT selects data.
`;
async function privateSecrets(roots) {
  const metadata=readJSON(path.join(roots.machineRoot,'secrets.json'));
  const passphrase=metadata?.adapter==='encrypted-file'?await prompt('Unlock local encrypted keys',{secret:true}):undefined;
  return loadSecrets(roots.machineRoot,passphrase);
}
async function saveCredentials(directory,secrets) {
  const passphrase=process.platform==='linux'?await prompt('Local key-file passphrase (at least 12 characters)',{secret:true}):undefined;
  storeSecrets(directory,secrets,passphrase);
}
async function publicRequest(endpoint,route,input,credential) {
  const response=await fetch(`${validateEndpoint(endpoint)}${route}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',...(credential?{Authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(input)});
  const result=await response.json(); if(!response.ok)throw new Error(result.error||'Enrollment failed');return result;
}
function emptyDestination(root) {
  if(fs.existsSync(root)&&fs.readdirSync(root).length)throw new Error('Import/connect requires an empty data directory; existing brain is preserved');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
}
try {
 const supported=new Set(['--brain-root','--endpoint','--json','--remote','--dry-run','--before','--revision','--resolve','--choose','--resolutions','--output','--role','--input','--revoke','--recover','--apply-plan','--cutover','--destination','--project','--path','--account','--name','--help']);
 for(const argument of args)if(argument.startsWith('--')&&!supported.has(argument))throw new Error('Unsupported command option; use help');
 const command=args[0];
 if(!command||command==='help'||args.includes('--help')) {process.stdout.write(help);}
 else {
  const roots=resolveRoots({brainRoot:value('--brain-root')});
  const configFile=path.join(roots.machineRoot,'config.json');
  if(command==='cloud') {
   if(args[1]!=='setup')throw new Error('Use cloud setup');
   if(value('--apply-plan')) {
    const bootstrapToken=await prompt('Private bootstrap token (store in your password manager)',{secret:true});
    const pepper=await prompt('Separate private server authentication pepper',{secret:true});
    if(bootstrapToken.length<32||pepper.length<32)throw new Error('Use independent high-entropy values of at least 32 characters');
    output(await applyCloudPlan(readJSON(value('--apply-plan')),roots.machineRoot,{bootstrapToken,pepper}));
   } else {
    const plan=cloudPlan(value('--account'),value('--name'));
    if(value('--output')){if(fs.existsSync(value('--output')))throw new Error('Cloud plan output exists');writeJSON(value('--output'),plan);}
    output({dryRun:true,plan,applyGuide:path.join(codeRoot,'docs/brain-sync/cloudflare.md')});
   }
  } else if(command==='paths') {
   const slug=value('--project'),localPath=value('--path');
   if(!/^[a-z0-9][a-z0-9._-]*$/.test(slug||'')||!localPath||!path.isAbsolute(localPath))throw new Error('Provide a safe --project slug and absolute local --path');
   if(!fs.existsSync(path.join(roots.brainRoot,'projects',slug,'index.md')))throw new Error('Project is not registered in this brain');
   const file=path.join(roots.machineRoot,'projects.json'),overrides=readJSON(file,{});overrides[slug]={path:path.resolve(localPath),last_accessed:new Date().toLocaleDateString('en-CA')};writeJSON(file,overrides);output({project:slug,path:overrides[slug].path,machineLocal:true});
  } else if(command==='migrate') {
   if(value('--apply-plan'))output(applyMigration(readJSON(path.resolve(value('--apply-plan'))),roots.machineRoot,{cutover:args.includes('--cutover')}));
   else {
    const destination=value('--destination');if(!destination)throw new Error('Provide --destination or --apply-plan');
    const plan=planMigration(roots.brainRoot,destination,codeRoot);if(value('--output')){if(fs.existsSync(value('--output')))throw new Error('Plan output exists');writeJSON(path.resolve(value('--output')),plan);}output(plan);
   }
  } else if(command==='init') {
   if(fs.existsSync(configFile))throw new Error('An installation is registered already; preserve it and use isolated MAVIS_SYNC_HOME for another vault');
   const root=value('--brain-root')?path.resolve(value('--brain-root')):path.join(os.homedir(),'MavisBrain');
   fs.mkdirSync(root,{recursive:true,mode:0o700});
   fs.mkdirSync(path.join(root,'projects'),{recursive:true});
   const endpoint=value('--endpoint'); if(endpoint)validateEndpoint(endpoint);
   const config={version:1,codeRoot,brainRoot:root,endpoint:endpoint?validateEndpoint(endpoint):null,vault:id(),device:id(),mode:'explicit',scope:'markdown-and-referenced-attachments',startupPull:true,awaitingSetup:!fs.existsSync(path.join(root,'identity/profile.md'))};
   const secrets={keys:{'1':randomBytes(32).toString('base64url')},credential:id()};
   await saveCredentials(roots.machineRoot,secrets);
   const plan=planInit(root,codeRoot);applyInit(root,plan);
   writeJSON(configFile,config);
   output({initialized:true,brainRoot:root,endpoint:config.endpoint,setupRequired:!fs.existsSync(path.join(root,'identity/profile.md')),next:'Run the Mavis setup wizard for missing identity, export recovery privately, then bootstrap after deployment. No upload occurred.'});
  } else if(command==='connect'||command==='import') {
   if(fs.existsSync(configFile))throw new Error('Machine registration already exists; use another MAVIS_SYNC_HOME for isolated import');
   const input=value('--input'),destination=value('--brain-root');if(!input||!destination)throw new Error('Provide --input and --brain-root');
   const passphrase=await prompt('Private invitation/export unlocking secret',{secret:true});
   const protectedValue=JSON.parse(fs.readFileSync(input,'utf8')); const payload=openRecovery(protectedValue,passphrase);
   const root=path.resolve(destination);emptyDestination(root);
   if(payload.version!==1)throw new Error('Incompatible private bundle');
   const config={...payload.config,codeRoot,brainRoot:root,device:id(),restored:true,awaitingSetup:false};validateEndpoint(config.endpoint);
   let secrets;
   if(command==='connect') {
    if(payload.kind!=='invitation')throw new Error('Expected invitation');
    const credential=id();await publicRequest(config.endpoint,'/v1/enroll',{capability:payload.capability,device:config.device,credential});
    secrets={keys:payload.keys,credential};
   } else {
    if(payload.kind!=='export'||!payload.files)throw new Error('Expected encrypted export');
    for(const [name,file] of Object.entries(payload.files))atomicWrite(safeFile(root,name),Buffer.from(file,'base64'));
    snapshot(root);secrets={keys:payload.keys,credential:id()};
   }
   await saveCredentials(roots.machineRoot,secrets);writeJSON(configFile,config);
   writeJSON(path.join(roots.machineRoot,'trusted.json'),payload.receipt||{generation:0,head:null});
   output({connected:command==='connect',imported:command==='import',brainRoot:root,next:command==='connect'?'Pull the brain before activation.':'Files restored offline; enroll fresh device credentials before remote sync.'});
  } else if(command==='save') {
   const marker=path.join(roots.machineRoot,'save.json');
   if(args[1]==='begin'){await withLock(roots.machineRoot,async()=>{if(fs.existsSync(marker)||fs.existsSync(path.join(roots.machineRoot,'apply.json')))throw new Error('Save/apply already in progress');writeJSON(marker,{pid:process.pid,started:new Date().toISOString()});});output({saving:true});}
   else if(args[1]==='finish'){await withLock(roots.machineRoot,async()=>{if(!fs.existsSync(marker))throw new Error('No active save marker');const {lint}=await import('./lib/brain-lint-core.mjs');const report=lint(roots.brainRoot,{codeRoot});if(report.counts.fail)throw new Error('Lint failures block completed-save marker');fs.unlinkSync(marker);});output({saved:true,uploaded:false,next:'Push/sync explicitly when desired'});}
   else throw new Error('Use save begin or save finish');
  } else {
   if(!roots.config.endpoint && command==='status') {output({configured:false,mode:'explicit',brainRoot:roots.brainRoot,next:'Initialize and review your Cloudflare resource plan'});}
   else {
   if(!roots.config.endpoint)throw new Error('No endpoint configured; initialize with --endpoint after reviewing your cloud plan');
   const secrets=(command==='doctor'||(command==='status'&&!args.includes('--remote')))?{}:await privateSecrets(roots), client=new BrainClient({config:{...roots.config,brainRoot:roots.brainRoot,codeRoot},secrets,directory:roots.machineRoot});
   if(command==='bootstrap') {const token=await prompt('One-time bootstrap token',{secret:true});output(await publicRequest(client.endpoint,'/v1/bootstrap',{vault:roots.config.vault,device:roots.config.device,credential:secrets.credential},token));}
   else if(command==='enroll') {
    const source=value('--input');if(!source)throw new Error('Provide private invitation file');const passphrase=await prompt('Invitation unlocking secret',{secret:true});const payload=openRecovery(readJSON(source),passphrase);
    if(payload.version!==1||payload.kind!=='invitation'||payload.config.vault!==roots.config.vault||payload.config.endpoint!==roots.config.endpoint)throw new Error('Invitation belongs to a different vault');
    const credential=id(),device=id();await publicRequest(client.endpoint,'/v1/enroll',{capability:payload.capability,device,credential});
    await saveCredentials(roots.machineRoot,{keys:payload.keys,credential});writeJSON(configFile,{...roots.config,device});writeJSON(path.join(roots.machineRoot,'trusted.json'),payload.receipt);output({enrolled:true,brainPreserved:true});
   }
   else if(command==='status')output(await client.status(args.includes('--remote')));
   else if(['push','pull','sync'].includes(command))output(await client[command]({dryRun:args.includes('--dry-run')}));
   else if(command==='history')output(await client.request(`/revisions${value('--before')?`?before=${encodeURIComponent(value('--before'))}`:''}`));
   else if(command==='conflicts') {
    const name=value('--resolve'),choice=value('--choose');
    if(!value('--resolutions')&&(!name||!['local','remote'].includes(choice)))throw new Error('Provide --resolve <path> and --choose local|remote or --resolutions <JSON-file>; use pull --dry-run to inspect conflicts');
    output(await client.pull({dryRun:args.includes('--dry-run'),resolutions:value('--resolutions')?readJSON(value('--resolutions')):{[name]:choice}}));
   }
   else if(command==='restore') {
    const revision=value('--revision');if(!revision)throw new Error('Provide --revision');const manifest=await client.readRevision(revision);
    const status=await client.status();if(status.pending.length)throw new Error('Restore requires a clean working brain; sync pending edits first');
    const restored=await client.push({dryRun:args.includes('--dry-run'),operation:'restore',restoreFiles:manifest.files});
    output(args.includes('--dry-run')?restored:{restored,applied:await client.pull()});
   } else if(command==='doctor')output(args.includes('--recover')?client.recover():client.doctor());
   else if(command==='devices')output(value('--revoke')?await client.request(`/devices/${value('--revoke')}/revoke`,'POST',{}):await client.request('/devices'));
   else if(command==='maintenance') {
    const plan=value('--apply-plan')?readJSON(value('--apply-plan')):null;
    output(plan?await client.request('/maintenance','POST',{objects:plan.objects.map(object=>typeof object==='string'?object:object.id)}):await client.request('/maintenance'));
   }
   else if(command==='key') {
    if(args[1]==='rotate') {
     const head=await client.head();
     if(args.includes('--dry-run'))output({dryRun:true,fromEpoch:head.epoch,toEpoch:head.epoch+1,reencryptAll:true,remainingDevicesNeedPrivateKeyImport:true});
     else {
      const epoch=String(head.epoch+1);if(!secrets.keys[epoch])secrets.keys[epoch]=randomBytes(32).toString('base64url');
      await saveCredentials(roots.machineRoot,secrets);output(await client.push({operation:'rotate'}));
     }
    } else if(args[1]==='export') {
     const destination=value('--output');if(!destination||fs.existsSync(destination))throw new Error('Provide a new private output file');
     const passphrase=await prompt('Private key-bundle unlocking secret',{secret:true});
     atomicWrite(path.resolve(destination),canonical(sealRecovery({version:1,kind:'keys',vault:roots.config.vault,endpoint:roots.config.endpoint,keys:secrets.keys,receipt:{head:client.state().head,generation:client.state().generation}},passphrase)));
     output({written:path.resolve(destination),encrypted:true,credentialsIncluded:false});
    } else if(args[1]==='import') {
     const source=value('--input');if(!source)throw new Error('Provide private --input file');
     const passphrase=await prompt('Private key-bundle unlocking secret',{secret:true});
     const payload=openRecovery(readJSON(source),passphrase);
     if(payload.version!==1||payload.kind!=='keys'||payload.vault!==roots.config.vault||payload.endpoint!==roots.config.endpoint)throw new Error('Key bundle belongs to a different vault or endpoint');
     for(const [epoch,key] of Object.entries(payload.keys)){if(secrets.keys[epoch]&&secrets.keys[epoch]!==key)throw new Error('Conflicting epoch key');if(Buffer.from(key,'base64url').length!==32)throw new Error('Invalid epoch key');secrets.keys[epoch]=key;}
     await saveCredentials(roots.machineRoot,secrets);writeJSON(path.join(roots.machineRoot,'trusted.json'),payload.receipt);output({imported:true,epochCount:Object.keys(secrets.keys).length});
    } else throw new Error('Use key rotate|export|import');
   }
   else if(command==='invite'||command==='export') {
    const destination=value('--output');if(!destination)throw new Error('Provide private --output path');if(fs.existsSync(destination))throw new Error('Refusing to overwrite private export');
    const passphrase=await prompt('Private bundle unlocking secret (at least 12 characters)',{secret:true});
    let payload={version:1,config:roots.config,keys:secrets.keys,receipt:client.state()};
    if(command==='invite') {
     const capability=id();await client.request('/pairings','POST',{id:id(),capability,role:value('--role')||'writer'});
     payload={...payload,kind:'invitation',capability};
    } else {const local=snapshot(roots.brainRoot);payload={...payload,kind:'export',files:Object.fromEntries(Object.entries(local.files).map(([name,file])=>[name,file.data.toString('base64')]))};}
    atomicWrite(path.resolve(destination),canonical(sealRecovery(payload,passphrase)));output({written:path.resolve(destination),encrypted:true,credentialsIncluded:false});
   } else throw new Error(`Unknown command: ${command}`);
   }
  }
 }
} catch(error) {process.stderr.write(`${args.includes('--json')?JSON.stringify({error:error.message,exitCode:error.exitCode||2,...(error.details?{details:error.details}:{})}):`brain: ${error.message}`}\n`);process.exitCode=error.exitCode||2;}
