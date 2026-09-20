import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProfileRegistry } from '../src/adapters/node/profile-registry.ts';
import { writeSettings } from '../src/adapters/node/hub-settings.ts';
import { DEFAULT_HUB_SETTINGS } from '../src/shared/types.ts';
import { findNodeDir, toolchainRoot, setToolchainRoot, ensurePnpm } from '../src/adapters/node/toolchain.ts';
import { SnapshotStore } from '../src/adapters/node/snapshot-store.ts';
import { describeRuntime, readRuntimeRef } from '../src/adapters/node/runtime-descriptor.ts';
import { ProcessManager } from '../src/adapters/node/process-manager.ts';
import { PatchWriter } from '../src/adapters/node/patch-writer.ts';
import { setSelectedDshResolver } from '../src/adapters/node/dsh-cli.ts';

const require = createRequire(import.meta.url);
const { _electron: electron } = require(process.env.DSH_TEST_PLAYWRIGHT_MODULE || 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const resumed = process.env.DSH_TEST_RECOVERY_FIXTURE ? JSON.parse(readFileSync(process.env.DSH_TEST_RECOVERY_FIXTURE,'utf8')) : undefined;
const {bin,home}=resumed || await import('./real-config-check.mjs');
const root = resumed?.root || mkdtempSync(join(tmpdir(), 'spaces-recovery-acceptance-'));
assert.equal(dirname(root),tmpdir());
assert.match(root.split(/[\\/]/).at(-1),/^spaces-recovery-acceptance-/);
const userData = join(root, 'app');
const toolsDir = join(root, 'tools');
mkdirSync(userData,{recursive:true}); mkdirSync(toolsDir,{recursive:true});
const testNodeLink=join(toolsDir,'node');
if(existsSync(testNodeLink)) {
  assert.ok(lstatSync(testNodeLink).isSymbolicLink());
  unlinkSync(testNodeLink);
}
symlinkSync(dirname(process.execPath),testNodeLink,'junction');
if(!existsSync(join(toolsDir,'pnpm'))) symlinkSync(join(toolchainRoot(), 'pnpm'), join(toolsDir, 'pnpm'), 'junction');
setToolchainRoot(toolsDir); await ensurePnpm();
new ProfileRegistry(home).markOnboarded();
const oldSettings = { ...DEFAULT_HUB_SETTINGS, locale: 'en', theme: 'dark', packageSource: 'official', portStart: 3610, portEnd: 3639 };
writeSettings(home, oldSettings);
setSelectedDshResolver(() => bin);
const manager = new ProcessManager(home, new PatchWriter(home), 3610, 3639);
const workspace = join(root, 'workspace'); mkdirSync(workspace,{recursive:true});
async function rpc(port, method, payload = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/${method}`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin, connection: 'close' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.ok(body.result?.ok, JSON.stringify(body));
  return body.result.value;
}
async function waitUntil(check, timeoutMs=60000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) { if(await check()) return; await delay(150); }
  throw new Error(`Acceptance condition did not complete within ${timeoutMs}ms`);
}
let sessionId=resumed?.sessionId;
if(!resumed) try {
  const {port} = await manager.start('coding');
  sessionId = (await rpc(port, 'session.create', {cwd:workspace})).sessionId;
  assert.ok(sessionId);
} finally { await manager.stopAll(); }
const store = new SnapshotStore({home, root:join(userData,'snapshots')});
console.log(`RECOVERY_TEST_ROOT=${root}\nRECOVERY_TEST_HOME=${home}`);
console.log('Creating a complete snapshot with the real offline DSH runtime...');
const snapshot = resumed ? store.preview(resumed.snapshotId) : store.create(describeRuntime(readRuntimeRef(bin)), 'recovery-acceptance');
console.log(`SNAPSHOT=${snapshot.id} (${(snapshot.size/1048576).toFixed(1)} MiB)`);
const fixtureFile=join(root,'fixture.json');
writeFileSync(fixtureFile,JSON.stringify({root,home,bin,snapshotId:snapshot.id,sessionId},null,2));
console.log('RECOVERY_FIXTURE='+fixtureFile);
if(process.env.DSH_TEST_PREPARE_ONLY==='1') process.exit(0);
writeSettings(home, {...oldSettings, theme:'light', packageSource:'china', portStart:3640, portEnd:3669});
const marker=join(home,'hub','after-snapshot.txt'); writeFileSync(marker,'preserve this later state');
writeFileSync(join(home,'.anonymous-user-id'),'test-identity-must-survive');
mkdirSync(join(userData,'runtimes'),{recursive:true});
// Only the pointer is damaged; no real installed runtime files are modified.
// A reused fixture now runs from the snapshot; retain that actual runtime root
// when damaging its pointer so generated fallback links still describe reality.
const activeBin=resumed ? store.runtimeBin(snapshot.id) : bin;
writeFileSync(join(userData,'runtimes','current.json'),JSON.stringify({version:snapshot.runtimeVersion,bin:join(dirname(activeBin),'missing-acceptance-bin.js'),origin:resumed?'snapshot':'managed'}));
const bootstrap=join(root,'bootstrap.cjs');
writeFileSync(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`);
const env={...process.env,DSH_SPACES_HOME:home,DSH_SPACES_USER_DATA:userData,DSH_SPACES_TOOLCHAIN:toolsDir,DSH_SPACES_CLI:resolve(dirname(bin),'../../../..'),DSH_SPACES_DISABLE_UPDATES:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:process.env.DSH_TEST_PACKAGED_EXE || require('electron'),
  args:[...(process.env.DSH_TEST_PACKAGED_EXE ? [] : [bootstrap]),'--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling'],env,timeout:60000});
const page=await app.firstWindow(); page.setDefaultTimeout(20000);
const artifacts=resolve('.sandbox/recovery-acceptance'); mkdirSync(artifacts,{recursive:true});
try {
  await page.waitForFunction(()=>document.body.innerText.includes('selected runtime is missing'));
  assert.ok((await page.evaluate(()=>window.dshSpaces.listProfiles())).every(p=>p.status==='stopped'));
  await assert.rejects(page.evaluate(id=>window.dshSpaces.restoreSnapshot(id),snapshot.id));
  assert.ok(existsSync(marker),'unconfirmed incomplete-runtime restore must not change live data');
  console.log('PASS damaged runtime blocks startup and requires explicit consent before data-only backup');
  const recovery=page.getByRole('button',{name:/version.*recovery|open.*recovery|版本.*恢复/i});
  await recovery.first().click();
  await page.getByRole('heading',{name:'DSH runtime',exact:true}).waitFor();
  await page.getByRole('button',{name:'Preview and restore',exact:true}).first().click();
  const confirm=page.getByRole('button',{name:'Confirm',exact:true});
  assert.equal(await confirm.isEnabled(),false);
  const text=await page.locator('body').innerText();
  assert.match(text,/data.only|data backup|runtime.*(missing|unavailable|cannot)|cannot.*runtime/i);
  await page.getByRole('checkbox').nth(0).check();
  assert.equal(await confirm.isEnabled(),false,'data-only backup consent must be separate and explicit');
  await page.getByRole('checkbox').nth(1).check();
  await page.screenshot({path:join(artifacts,'damaged-runtime-confirmation.png')});
  await confirm.click();
  await waitUntil(()=>page.evaluate(async()=>{
    const m=await window.dshSpaces.getMaintenance();
    return !m.operation && m.inventory.current?.origin==='snapshot';
  }),180000);
  await page.getByText('Operation complete.',{exact:true}).waitFor();
  const state=await page.evaluate(()=>window.dshSpaces.getMaintenance());
  assert.equal(state.error,undefined);
  assert.equal(existsSync(marker),false);
  assert.equal(readFileSync(join(home,'.anonymous-user-id'),'utf8'),'test-identity-must-survive');
  const rescue=state.snapshots.find(s=>s.runtimeMissing);
  assert.ok(rescue,'current data must be preserved in a clearly marked data-only backup');
  assert.equal(readFileSync(join(userData,'snapshots',rescue.id,'data','hub','after-snapshot.txt'),'utf8'),'preserve this later state');
  await assert.rejects(page.evaluate(id=>window.dshSpaces.restoreSnapshot(id),rescue.id));
  console.log('PASS complete snapshot restored from a broken runtime; later data retained separately; incomplete target rejected');
  await page.getByRole('button',{name:'General',exact:true}).click();
  assert.equal(await page.getByLabel('Port start',{exact:true}).inputValue(),'3610');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  const saved=await page.evaluate(()=>window.dshSpaces.getSettings());
  for(const key of ['portStart','portEnd','packageSource','locale','theme']) assert.equal(saved[key],oldSettings[key],key);
  assert.ok((await page.evaluate(()=>window.dshSpaces.listProfiles())).every(p=>p.status==='stopped'));
  console.log('PASS restored form Save preserves restored settings and leaves spaces stopped');
  await page.getByRole('button',{name:'coding',exact:true}).click();
  await waitUntil(()=>page.evaluate(async()=>(await window.dshSpaces.listProfiles()).find(p=>p.name==='coding')?.status==='running'));
  const coding=(await page.evaluate(()=>window.dshSpaces.listProfiles())).find(p=>p.name==='coding');
  assert.ok((await rpc(coding.port,'session.list')).items.some(s=>s.sessionId===sessionId));
  await waitUntil(()=>app.evaluate(async({webContents},port)=>{
    const view=webContents.getAllWebContents().find(w=>w.getURL().startsWith(`http://127.0.0.1:${port}`));
    return view && !view.isLoading() && await view.executeJavaScript('document.body.innerText.length > 100');
  },coding.port));
  const screenshot=await app.evaluate(async({BrowserWindow},port)=>{
    const view=BrowserWindow.getAllWindows()[0].contentView.children.find(v=>v.webContents?.getURL().startsWith(`http://127.0.0.1:${port}/`));
    if(!view?.getVisible() || view.getBounds().width<100) throw new Error('Restored DSH view is not visible');
    return (await view.webContents.capturePage()).toPNG().toString('base64');
  },coding.port);
  writeFileSync(join(artifacts,'restored-space.png'),Buffer.from(screenshot,'base64'));
  const closed=app.waitForEvent('close',{timeout:20000});
  await page.evaluate(()=>window.dshSpaces.quitApp()).catch(()=>{}); await closed;
  await assert.rejects(fetch(`http://127.0.0.1:${coding.port}`,{signal:AbortSignal.timeout(1000)}));
  console.log('PASS explicit start uses restored offline runtime and original session; exit closes owned port');
} catch(error) {
  console.log('UI:',await page.locator('body').innerText().catch(()=>'<closed>'));
  await page.screenshot({path:join(artifacts,'failure.png')}).catch(()=>{});
  throw error;
} finally {await app.close().catch(()=>{});}
