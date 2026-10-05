import fs from 'node:fs';
import path from 'node:path';
import { DIRECTORIES } from './scope.mjs';
import { hash, canonical } from './crypto.mjs';
import { writeJSON, atomicWrite } from './state.mjs';
import { lint } from '../brain-lint-core.mjs';

export function planMigration(source, destination, codeRoot) {
  source=path.resolve(source);destination=path.resolve(destination);
  if(fs.lstatSync(source).isSymbolicLink() || (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()))throw new Error('Linked migration roots are unsupported');
  if(source===destination || destination.startsWith(source+path.sep) || source.startsWith(destination+path.sep))throw new Error('Migration requires separate non-nested source and destination');
  if(!fs.existsSync(path.join(source,'identity/profile.md')))throw new Error('Source identity missing; migration cannot run setup/reset');
  if(fs.existsSync(destination)&&fs.readdirSync(destination).length)throw new Error('Migration destination must be empty');
  const files=[];
  function walk(relative) {
    const file=path.join(source,relative),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw new Error(`Migration blocks linked source entry: ${relative}`);
    if(stat.isDirectory())for(const name of fs.readdirSync(file))walk(`${relative}/${name}`);
    else if(stat.isFile())files.push({path:relative,bytes:stat.size,hash:hash(fs.readFileSync(file))});
    else throw new Error('Unsupported source entry');
  }
  for(const directory of DIRECTORIES)if(fs.existsSync(path.join(source,directory)))walk(directory);
  for(const legacy of ['topic_index.md','topic_details','.setup-complete','_backup'])if(fs.existsSync(path.join(source,legacy)))walk(legacy);
  const projections=['AGENTS.md','CLAUDE.md','SETUP.md','scripts','skills','docs','seeds','mavis'].filter(name=>fs.existsSync(path.join(codeRoot,name)));
  return {version:1,source,destination,codeRoot,files,projections,bytes:files.reduce((sum,file)=>sum+file.bytes,0),preservesSource:true};
}
export function applyMigration(plan, directory, {cutover=false}={}) {
  const current=planMigration(plan.source,plan.destination,plan.codeRoot);
  if(canonical(current)!==canonical(plan))throw new Error('Migration source changed after preview; generate a new plan');
  fs.mkdirSync(plan.destination,{recursive:true,mode:0o700});
  const receiptFile=path.join(directory,'migration.json');writeJSON(receiptFile,{...plan,status:'copying'});
  for(const file of plan.files) {
    const data=fs.readFileSync(path.join(plan.source,file.path));if(hash(data)!==file.hash)throw new Error('Source changed during migration');
    atomicWrite(path.join(plan.destination,file.path),data);
    if(hash(fs.readFileSync(path.join(plan.destination,file.path)))!==file.hash)throw new Error('Migration copy verification failed');
  }
  // Local code projections preserve existing relative links. They never enter sync scope.
  fs.symlinkSync(plan.codeRoot,path.join(plan.destination,'.mavis-code'),process.platform==='win32'?'junction':'dir');
  for(const name of plan.projections) {
    const source=path.join(plan.codeRoot,name),target=path.join(plan.destination,name);
    if(fs.statSync(source).isDirectory())fs.symlinkSync(source,target,process.platform==='win32'?'junction':'dir');
    else {fs.copyFileSync(source,target);fs.chmodSync(target,0o444);}
  }
  const report=lint(plan.destination,{codeRoot:plan.codeRoot});
  if(report.counts.fail){writeJSON(receiptFile,{...plan,status:'blocked',report});throw new Error('Migrated links/lint have failures; original and copy preserved without root cutover');}
  if(cutover) {
    const configFile=path.join(directory,'config.json');
    const previous=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8')):{};
    writeJSON(path.join(directory,'migration-before.json'),previous);
    writeJSON(configFile,{...previous,brainRoot:plan.destination,codeRoot:plan.codeRoot});
  }
  writeJSON(receiptFile,{...plan,status:cutover?'selected':'verified',report});
  return {copied:plan.files.length,bytes:plan.bytes,sourcePreserved:true,selected:cutover,brainRoot:plan.destination,lint:report.counts};
}
