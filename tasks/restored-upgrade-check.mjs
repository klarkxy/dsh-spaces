import assert from 'node:assert/strict';
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {ProcessManager} from '../src/main/process-manager.ts';
import {PatchWriter} from '../src/main/patch-writer.ts';
import {SnapshotStore,clearRuntimeFallback} from '../src/main/snapshot-store.ts';
import {describeRuntime} from '../src/main/runtime-descriptor.ts';
import {dshSessionCookie,dshSessionList} from '../src/main/dsh-endpoint.ts';
import {setSelectedDshResolver} from '../src/main/dsh-cli.ts';

// Resume only an acceptance-owned restored Home; do not repeat the large copy
// merely to verify first startup after the already completed data restoration.
const home=resolve(process.env.DSH_TEST_UPGRADE_HOME);
const root=resolve(process.env.DSH_TEST_UPGRADE_ROOT);
assert.equal(dirname(home),tmpdir()); assert.match(home.split(/[\\/]/).at(-1),/^spaces-real-config-/);
assert.equal(dirname(root),tmpdir()); assert.match(root.split(/[\\/]/).at(-1),/^spaces-real-upgrade-/);
const install=JSON.parse(readFileSync(process.env.DSH_TEST_INSTALL_RESULT,'utf8'));
const current=JSON.parse(readFileSync(join(install.root,'current.json'),'utf8'));
assert.equal(current.origin,'snapshot'); assert.equal(current.version,'0.1.1-rc.2');
const store=new SnapshotStore({home,root:join(root,'snapshots')});
assert.equal(store.pendingRestore(),undefined);
assert.ok(!existsSync(join(home,'hub','after-upgrade-acceptance.txt')));
assert.ok(store.list().some(s=>s.reason==='before-restore' && s.runtimeVersion===install.installed.version));
const snapshot=store.list().find(s=>current.bin.startsWith(store.runtimeRoot(s.id)));
assert.ok(snapshot);
const names=['web','coding','writing'];
const ids=names.map(name=>{
  const dir=join(root,'snapshots',snapshot.id,'data',...(name==='web'?[]:['hub',name]),'sessions');
  const sessions=readdirSync(dir,{recursive:true}).map(String).filter(path=>/^session-[0-9a-f-]+$/i.test(path.split(/[\\/]/).at(-1)));
  assert.equal(sessions.length,1);
  return sessions[0].split(/[\\/]/).at(-1);
});
setSelectedDshResolver(()=>current.bin);
const manager=new ProcessManager(home,new PatchWriter(home),3410,3439);
const ports=new Set();
try {
  for(let attempt=0;attempt<3;attempt++) {
    clearRuntimeFallback(join(home,'profiles'),describeRuntime(current).root);
    const rows=await Promise.all(names.map(name=>manager.start(name)));
    for(const [i,row] of rows.entries()) {
      ports.add(row.port);
      const cookie=await dshSessionCookie(manager.urlOf(names[i]),fetch,AbortSignal.timeout(10000));
      const list=await dshSessionList(row.port,fetch,AbortSignal.timeout(10000),cookie);
      assert.ok(list.items.some(s=>s.sessionId===ids[i]));
      ids.forEach((id,other)=>{if(other!==i) assert.ok(!list.items.some(s=>s.sessionId===id));});
    }
    await manager.stopAll();
    console.log(`PASS restored runtime cold concurrent startup ${attempt+1}: original isolated sessions retained`);
  }
} finally {await manager.stopAll();}
for(const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(1000)}));
writeFileSync(join(root,'restored-start-result.json'),JSON.stringify({home,root,currentVersion:current.version,candidate:install.installed.version,snapshotId:snapshot.id,attempts:3,passed:true},null,2));
console.log('PASS prior version restored, before-restore backup retained, all owned ports closed');
