import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codeRoot, readJSON } from './roots.mjs';
import { writeJSON, atomicWrite } from './state.mjs';
import { hash, canonical } from './crypto.mjs';

const workerRoot=path.join(codeRoot,'packages/brain-sync-worker');
export function cloudPlan(account,name) {
  if(!/^[a-f0-9]{32}$/.test(account||'')||!/^[a-z][a-z0-9-]{2,45}$/.test(name||''))throw new Error('Provide a Cloudflare account ID and dedicated lowercase resource prefix');
  return {version:1,account,resources:{worker:name,bucket:`${name}-private`,database:`${name}-metadata`},privateR2:true,privateSeed:false,migrationHash:hash(fs.readFileSync(path.join(workerRoot,'migrations/0001_vault.sql'))),sourceHash:hash(fs.readFileSync(path.join(workerRoot,'src/index.mjs'))),prices:['https://developers.cloudflare.com/r2/pricing/','https://developers.cloudflare.com/d1/platform/pricing/','https://developers.cloudflare.com/workers/platform/pricing/'],operations:['Verify selected account/login and product/billing access','Reject colliding unrelated names','Create dedicated private R2 and D1','Apply migration','Set separate private AUTH_PEPPER and BOOTSTRAP_TOKEN','Deploy Worker','Verify liveness and unauthenticated refusal'],humanSteps:['Cloudflare browser login','R2 product/billing activation if needed','Confirm resource plan','Store bootstrap secret in private password manager','Bootstrap first owner and remove server bootstrap secret']};
}
function wrangler(args,account,{input,interactive=false,allowMissingWorker=false}={}) {
  const cli=path.join(workerRoot,'node_modules/wrangler/bin/wrangler.js');
  if(!fs.existsSync(cli))throw new Error('Run npm ci in packages/brain-sync-worker before cloud setup');
  const result=spawnSync(process.execPath,[cli,...args],{cwd:workerRoot,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:account,WRANGLER_SEND_METRICS:'false'},input,stdio:interactive?'inherit':undefined,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024,timeout:60000});
  if(!result.error && result.status!==0 && allowMissingWorker && /10007/.test(result.stderr||''))return null;
  if(result.error||result.status!==0)throw new Error(`Wrangler ${args.slice(0,2).join(' ')} failed; inspect provider login/access and local deployment receipt before retrying`);
  return result.stdout || '';
}
export async function applyCloudPlan(plan,directory,{bootstrapToken,pepper,runner=wrangler,fetchImpl=fetch}={}) {
  const validated=cloudPlan(plan.account,plan.resources?.worker);
  if(canonical(validated)!==canonical(plan))throw new Error('Cloud plan or source changed; regenerate exact preview before applying');
  const receiptPath=path.join(directory,'cloud-receipt.json'), configPath=path.join(directory,'wrangler.private.json');
  let receipt=readJSON(receiptPath,{plan,status:'starting'});
  if(canonical(receipt.plan)!==canonical(plan))throw new Error('Another resource plan owns this deployment receipt');
  const run=(args,options)=>runner(args,plan.account,options);
  const auth=JSON.parse(run(['whoami','--json']));
  if(!auth.loggedIn || !auth.accounts?.some(account=>account.id===plan.account))throw new Error('Reviewed account is not available in this authenticated login');
  if(!receipt.workerChecked) {
    const existing=run(['deployments','list','--name',plan.resources.worker,'--json'],{allowMissingWorker:true});
    if(existing!==null)throw new Error('Worker name exists already; refuse to overwrite an unrelated deployment');
    receipt.workerChecked=true;writeJSON(receiptPath,receipt);
  }
  if(!receipt.bucket && !receipt.database) {
    // Provider listing is deliberately required before creation; names are never adopted.
    const buckets=run(['r2','bucket','list']),databases=JSON.parse(run(['d1','list','--json']));
    if(buckets.includes(plan.resources.bucket)||databases.some(row=>row.name===plan.resources.database))throw new Error('Resource name collision; choose another dedicated prefix or review explicit adoption separately');
    writeJSON(receiptPath,receipt);
  }
  if(!receipt.bucket) {run(['r2','bucket','create',plan.resources.bucket]);receipt={...receipt,bucket:plan.resources.bucket};writeJSON(receiptPath,receipt);}
  run(['r2','bucket','dev-url','disable',plan.resources.bucket,'--force']);
  if(!run(['r2','bucket','dev-url','get',plan.resources.bucket]).includes('Public access via the r2.dev URL is disabled.'))throw new Error('Private bucket status could not be verified');
  receipt.privateR2=true;writeJSON(receiptPath,receipt);
  if(!receipt.database) {
    const created=run(['d1','create',plan.resources.database,'--update-config=false']);
    const match=created.match(/(?:database_id["']?\s*[:=]\s*["'])([a-f0-9-]{36})/i);
    if(!match)throw new Error('D1 create response lacked a verifiable ID; preserve resources and inspect before resuming');
    receipt={...receipt,database:{name:plan.resources.database,id:match[1]}};writeJSON(receiptPath,receipt);
  }
  // Remote D1's trigger parser rejects CRLF SQL. Stage the reviewed migration
  // with LF endings, regardless of the caller's editor or Windows checkout.
  const migrationsDir=path.resolve(directory,'migrations');
  atomicWrite(path.join(migrationsDir,'0001_vault.sql'),fs.readFileSync(path.join(workerRoot,'migrations/0001_vault.sql'),'utf8').replace(/\r\n/g,'\n'));
  const config={name:plan.resources.worker,account_id:plan.account,main:path.join(workerRoot,'src/index.mjs').replace(/\\/g,'/'),compatibility_date:'2026-10-05',compatibility_flags:['nodejs_compat'],observability:{enabled:true,head_sampling_rate:0.1},d1_databases:[{binding:'DB',database_name:plan.resources.database,database_id:receipt.database.id,migrations_dir:migrationsDir.replace(/\\/g,'/')}],r2_buckets:[{binding:'BLOBS',bucket_name:plan.resources.bucket}]};
  writeJSON(configPath,config);
  if(!receipt.migrated) {
    // Use D1's import parser: the remote query splitter also truncates some
    // valid CASE/END trigger bodies. Include the migration receipt atomically.
    const ledgerSQL="CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);";
    const applied=JSON.parse(run(['d1','execute',plan.resources.database,'--remote','--config',configPath,'--command',`${ledgerSQL} SELECT name FROM d1_migrations WHERE name='0001_vault.sql';`,'--json']));
    if(!applied.some(result=>result.results?.some(row=>row.name==='0001_vault.sql'))) {
      const importFile=path.join(directory,'schema-import.sql');
      atomicWrite(importFile,`${ledgerSQL}\n${fs.readFileSync(path.join(migrationsDir,'0001_vault.sql'),'utf8')}\nINSERT INTO d1_migrations(name) VALUES('0001_vault.sql');\n`);
      run(['d1','execute',plan.resources.database,'--remote','--config',configPath,'--file',importFile]);
    }
    receipt.migrated=true;writeJSON(receiptPath,receipt);
  }
  if(!receipt.secrets) {
    if(!bootstrapToken || !pepper)throw new Error('Private bootstrap token and auth pepper must be provided via terminal prompts');
    run(['secret','put','AUTH_PEPPER','--config',configPath],{input:pepper});
    run(['secret','put','BOOTSTRAP_TOKEN','--config',configPath],{input:bootstrapToken});receipt.secrets=true;writeJSON(receiptPath,receipt);
  }
  const deployed=run(['deploy','--config',configPath,'--autoconfig=false']);
  const endpoint=deployed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/ig)?.[0];
  if(!endpoint)throw new Error('Deployment response lacked an endpoint; inspect receipt/provider before claiming live');
  receipt={...receipt,status:'deployed-needs-verification',endpoint};writeJSON(receiptPath,receipt);
  let healthy=false;
  for(let attempt=0;attempt<5;attempt++) {
    try {const health=await fetchImpl(`${endpoint}/health`,{redirect:'error',signal:AbortSignal.timeout(10000)});healthy=health.ok&&(await health.json()).protocol===1;} catch {healthy=false;}
    if(healthy)break;
    if(attempt<4)await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!healthy)throw new Error('Deployed health/protocol check failed');
  const refusal=await fetchImpl(`${endpoint}/v1/vaults/${'a'.repeat(43)}/head`,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'X-Mavis-Protocol':'1'}});
  if(refusal.status!==401)throw new Error('Deployed unauthenticated-access refusal failed');
  receipt.status='verified-no-private-seed';receipt.verifiedAt=new Date().toISOString();writeJSON(receiptPath,receipt);
  return {receiptPath,endpoint,privateSeed:false,next:'Bootstrap owner privately then remove BOOTSTRAP_TOKEN. No memory uploaded.'};
}
