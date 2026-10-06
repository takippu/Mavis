'use strict';
// App-owned colour integration with disposable profile and project data.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mavis-colors-'));
const data = path.join(root, 'state'), brain = path.join(root, 'brain');
for (const dir of [data, brain, path.join(brain,'projects'), path.join(brain,'identity')]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(brain,'AGENTS.md'),'# Disposable test brain\n');
fs.writeFileSync(path.join(brain,'projects','_index.md'),'');
fs.writeFileSync(path.join(brain,'identity','profile.md'),'# Test\n');
const catalog = ['Alpha','Beta','Neutral'].map((name,i) => {
  const dir = path.join(root,name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir,'hello.js'),'const hello = true;\n');
  return {slug:name.toLowerCase(),name,dir,color:['#2f6f9e','#b2542f',null][i],group:'active'};
});
fs.writeFileSync(path.join(data,'workspace-state.json'),JSON.stringify({version:3,activeId:'alpha',workspaces:catalog.map(p=>({id:p.slug,slug:p.slug,root:p.dir,name:p.name,terminals:[],terminalVisible:false}))}));
process.env.MAVIS_TEST_USER_DATA=data; process.env.MAVIS_BRAIN_ROOT=brain;
const errors=[]; app.on('web-contents-created',(_e,wc)=>wc.on('console-message',(_e,level,message)=>{if(level>=3) errors.push(message);}));
require(process.env.MAVIS_SMOKE_MAIN || '../src/main');
ipcMain.removeHandler('list-projects'); ipcMain.handle('list-projects',()=>catalog);
ipcMain.removeHandler('project:set-color'); ipcMain.handle('project:set-color',(_e,{slug,color})=>{catalog.find(p=>p.slug===slug).color=color || null;return {ok:true};});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  let win; for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!MT.workspace?.ready'))break;await delay(100);}
  assert.ok(win); const js=s=>win.webContents.executeJavaScript(s);
  const poll=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await delay(50);}throw Error('Timed out: '+s);};
  const colors=()=>js(`[...document.querySelectorAll('.ws-project-tab')].map(t=>({color:t.style.getPropertyValue('--project-color'),active:t.classList.contains('active'),dot:!!t.querySelector('.ws-project-color')}))`);
  assert.deepEqual(await colors(),[{color:'#2f6f9e',active:true,dot:true},{color:'#b2542f',active:false,dot:true},{color:'',active:false,dot:false}]);
  await js(`MT.workspace.activate('beta')`); assert.equal((await colors())[1].active,true);assert.equal((await colors())[0].active,false);
  await js(`MT.workspace.run('projects')`);
  await poll(`!!document.querySelector('[aria-label="Set colour for Alpha"]')`);
  await js(`document.querySelector('[aria-label="Set colour for Alpha"]').click();document.querySelector('[aria-label="Use #4f8a3c"]').click()`);
  await poll(`document.querySelector('.ws-project-tab').style.getPropertyValue('--project-color')==='#4f8a3c'`);
  assert.equal(catalog[0].color,'#4f8a3c');
  await js(`document.querySelector('[aria-label="Set colour for Alpha"]').click();document.querySelector('[aria-label="Clear colour"]').click()`);
  await poll(`!document.querySelector('.ws-project-tab').classList.contains('colored')`);
  catalog[0].color='#7c3a6a'; win.webContents.send('brain-changed',{});
  await poll(`document.querySelector('.ws-project-tab').style.getPropertyValue('--project-color')==='#7c3a6a'`);
  await js(`MT.workspace.activate('alpha')`);
  const evidence=path.resolve(__dirname,'../design-proposals/build-verification');
  fs.mkdirSync(evidence,{recursive:true});
  for(const [theme,width,height,name] of [['dark',1280,800,'project-tabs-dark'],['light',1280,800,'project-tabs-light'],['dark',900,650,'project-tabs-compact']]){
    win.setSize(width,height);await js(`MT.theme.apply(${JSON.stringify(theme)})`);await delay(150);
    fs.writeFileSync(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(errors,[]);const result={ok:true,restoredColors:true,activeState:true,livePicker:true,clearColor:true,externalRefresh:true,neutralFolder:true,errors};
  fs.writeFileSync(path.join(evidence,'project-colors-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
