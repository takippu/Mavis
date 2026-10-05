import fs from 'node:fs';
import path from 'node:path';
import { BrainClient } from './client.mjs';
import { loadSecrets, recoverJournal } from './state.mjs';
import { readJSON } from './roots.mjs';
import { snapshot } from './scope.mjs';

export async function prepareBoot(roots) {
  const directory=roots.machineRoot;
  if(fs.existsSync(path.join(directory,'apply.json'))) {
    const lock=readJSON(path.join(directory,'lock'));
    if(lock) {try{process.kill(lock.pid,0);throw new Error('A live sync process is applying memory; retry boot');}catch(error){if(error.code!=='ESRCH')throw error;}fs.unlinkSync(path.join(directory,'lock'));}
    recoverJournal(roots.brainRoot,directory);
  }
  if(!roots.config.endpoint || !roots.config.startupPull)return {status:'local'};
  const deadline=Date.now()+5000;
  try {
    const state=readJSON(path.join(directory,'state.json'),{files:{}}),local=snapshot(roots.brainRoot);
    if([...new Set([...Object.keys(state.files),...Object.keys(local.files)])].some(name=>state.files[name]?.hash!==local.files[name]?.hash))return {status:'pending',message:'Local changes pending; explicit sync required'};
    if(readJSON(path.join(directory,'secrets.json'))?.adapter==='encrypted-file')return {status:'locked',message:'Unlock encrypted keys for explicit sync'};
    const secrets=loadSecrets(directory);
    const client=new BrainClient({config:{...roots.config,brainRoot:roots.brainRoot,codeRoot:roots.codeRoot},secrets,directory,deadline});
    const pulled=await client.pull();return {status:'ready',...pulled};
  } catch(error) {return {status:'local',message:error.message};}
}
