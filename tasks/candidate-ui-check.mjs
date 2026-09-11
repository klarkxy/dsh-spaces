import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProfileRegistry } from '../src/main/profile-registry.ts';
import { writeSettings } from '../src/main/hub-settings.ts';
import { DEFAULT_HUB_SETTINGS } from '../src/shared/types.ts';

const require=createRequire(import.meta.url);
const { _electron:electron }=require(process.env.DSH_TEST_PLAYWRIGHT_MODULE || 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const candidate=JSON.parse(readFileSync(process.env.DSH_TEST_INSTALL_RESULT,'utf8'));
process.env.DSH_TEST_BIN=candidate.installed.bin;
const {home,bin}=await import('./real-config-check.mjs');
const root=mkdtempSync(join(tmpdir(),'spaces-candidate-ui-'));
const userData=join(root,'app'); mkdirSync(join(userData,'runtimes'),{recursive:true});
writeFileSync(join(userData,'runtimes','current.json'),JSON.stringify({bin,version:candidate.installed.version,origin:'managed'}));
new ProfileRegistry(home).markOnboarded();
writeSettings(home,{...DEFAULT_HUB_SETTINGS,locale:'en',theme:'dark',portStart:3710,portEnd:3739});
const env={...process.env,DSH_SPACES_HOME:home,DSH_SPACES_USER_DATA:userData,DSH_SPACES_DISABLE_UPDATES:'1'};
delete env.ELECTRON_RUN_AS_NODE;
assert.ok(process.env.DSH_TEST_PACKAGED_EXE,'Set DSH_TEST_PACKAGED_EXE to the final Windows executable');
const app=await electron.launch({executablePath:process.env.DSH_TEST_PACKAGED_EXE,args:['--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling'],env,timeout:120000});
const page=await app.firstWindow(); page.setDefaultTimeout(20000);
const ports=[];
async function waitUntil(check,timeout=90000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {if(await check()) return; await delay(150);}
  throw new Error('Candidate UI acceptance timed out');
}
try {
  assert.ok(await app.evaluate(({app})=>app.isPackaged));
  for(const name of ['web','coding','writing']) {
    await page.getByRole('button',{name:name==='web'?'Home':name,exact:true}).click();
    await waitUntil(()=>page.evaluate(async name=>(await window.dshSpaces.listProfiles()).find(p=>p.name===name)?.status==='running',name));
    const profile=(await page.evaluate(()=>window.dshSpaces.listProfiles())).find(p=>p.name===name);
    ports.push(profile.port);
    await waitUntil(()=>app.evaluate(async({webContents},port)=>{
      const view=webContents.getAllWebContents().find(w=>w.getURL().startsWith(`http://127.0.0.1:${port}/`));
      if(!view || view.isLoading()) return false;
      return view.executeJavaScript(`document.body.innerText.length > 100 && !document.body.innerText.includes('dsh web authentication required')`);
    },profile.port));
    const rpc=await app.evaluate(async({webContents},port)=>{
      const view=webContents.getAllWebContents().find(w=>w.getURL().startsWith(`http://127.0.0.1:${port}/`));
      return view.executeJavaScript(`fetch('/api/session/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'session/list',payload:{args:{_request:{}}}})}).then(async r=>({status:r.status,body:await r.json()}))`);
    },profile.port);
    assert.equal(rpc.status,200); assert.equal(rpc.body.result.ok,true);
    console.log(`PASS packaged ${name}: authenticated page renders and browser session.list succeeds`);
  }
  const screenshot=await app.evaluate(async({BrowserWindow},port)=>{
    const view=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.getURL().startsWith(`http://127.0.0.1:${port}/`));
    if(!view?.getVisible() || view.getBounds().width<100) throw new Error('DSH view is not visible');
    return (await view.webContents.capturePage()).toPNG().toString('base64');
  },ports.at(-1));
  writeFileSync(resolve('.sandbox/recovery-acceptance/candidate-ui.png'),Buffer.from(screenshot,'base64'));
  const closed=app.waitForEvent('close',{timeout:20000});
  await page.evaluate(()=>window.dshSpaces.quitApp()).catch(()=>{}); await closed;
} catch(error) {
  console.log('PROFILES',JSON.stringify(await page.evaluate(()=>window.dshSpaces.listProfiles()).catch(()=>[])));
  const views=await app.evaluate(async({webContents})=> {
    const local=webContents.getAllWebContents().filter(w=>w.getURL().startsWith('http://127.0.0.1:'));
    return Promise.all(local.map(async w=>({url:new URL(w.getURL()).origin,loading:w.isLoading(),text:await w.executeJavaScript('document.body.innerText').catch(()=>'<unavailable>')})));
  }).catch(()=>[]);
  console.log('VIEWS',JSON.stringify(views));
  throw error;
} finally { await app.close().catch(()=>{}); }
for(const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(1000)}));
console.log('PASS packaged candidate shutdown closes all owned API ports');
console.log('CANDIDATE_UI_ROOT='+root);
