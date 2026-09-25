/** Two actual DSH Hosts, no browser: private run handoffs into the real Home gateway/store.
 * The parent is an isolated test owner, NOT the production Supervisor integration. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { createServer } from 'node:http';
import { createServer as portServer } from 'node:net';
import { HomeDashboard } from '../src/core/domain/dashboard/home-backend.ts';
import { HomeDashboardFileStore } from '../src/adapters/node/dashboard/file-store.ts';
import { HomeDashboardGateway } from '../src/adapters/node/dashboard/gateway.ts';
import { writeDashboardBootstrap } from '../src/adapters/node/dashboard/bootstrap.ts';
import { DashboardFault } from '../src/core/domain/dashboard/errors.ts';
import { applyIsolationPatch } from '../src/core/domain/isolation.ts';
const sdk = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!sdk) throw new Error('Explicit installed SDK fixture required');
const bin = resolve(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
mkdirSync('.sandbox', { recursive: true });
const root = mkdtempSync(resolve('.sandbox/dashboard-home-native-'));
const home = join(root, 'home'), artifacts = join(root, 'packages'); mkdirSync(home); mkdirSync(artifacts);
const evidence = resolve('.sandbox/dashboard-home-native-evidence'); mkdirSync(evidence, { recursive: true });
const env = { ...process.env, DSH_HOME: home, CI: '1', npm_config_registry: 'https://registry.npmjs.org', npm_config_fetch_retries: '0', PATH: resolve(sdk, 'node_modules/.bin') + delimiter + process.env.PATH };
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE;
const sources = ['home-a', 'home-b'].map(spaceId => ({ spaceId, title: spaceId, sourceState: 'stopped', publishing: 'disabled' }));
const bindings = new Map(), children = [], grants = [], proved = [];
let ownerActive = true, origin = '', gateway;
const assertOwner = () => { if (!ownerActive) throw new DashboardFault('dashboard/unavailable'); };
const hub = new HomeDashboard({ backendEpoch: randomUUID(), store: new HomeDashboardFileStore(join(home, '.spaces-dashboard', 'v1'), assertOwner), now: Date.now, newId: randomUUID, sources: () => sources, assertOwner,
  assertRun: binding => { const expected = bindings.get(binding.spaceId); if (!expected || expected.runId !== binding.runId || expected.generation !== binding.generation) throw new DashboardFault('dashboard/stale-run'); } });
const session = randomUUID();
gateway = new HomeDashboardGateway(hub, { origin: () => origin, authorize: req => req.headers.cookie === `fixture=${session}` ? { subjectId: 'fixture-owner', layoutWrite: true, publicationsManage: true } : null });
const server = createServer((req, res) => { void gateway.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
const redact = text => String(text).replace(/([?&]token=)[^&\s\x1b"']+/g, '$1[redacted]').replace(/[a-f0-9]{64}/g, '[redacted-digest]');
function pass(message) { proved.push(message); console.log('PASS', message); }
function run(args, label, executable = process.execPath) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${label}: ${redact(result.stderr || result.stdout || result.error).slice(-5000)}`);
  return result.stdout;
}
function pack(directory) { const output = run(['pack', directory, '--ignore-scripts', '--json', '--pack-destination', artifacts], 'pack', 'npm'); return join(artifacts, JSON.parse(output)[0].filename); }
function fingerprint(path) {
  if (!existsSync(path)) return 'absent'; const hash = createHash('sha256');
  function walk(directory) { for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    assert.equal(entry.isSymbolicLink(), false); const p = join(directory, entry.name); hash.update(p.slice(path.length)); if (entry.isDirectory()) walk(p); else hash.update(readFileSync(p));
  } } walk(path); return hash.digest('hex');
}
async function query(body, path = '/api/dashboard/v1/query') {
  const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, Cookie: `fixture=${session}`, 'Content-Type': 'application/json', 'X-DSH-Dashboard': '1' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); return response.json();
}
async function start(spaceId, bootstrap) {
  const reserve = portServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const child = spawn(process.execPath, [bin, '--profile', spaceId, '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env: { ...env, DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE: bootstrap.path }, cwd: root, stdio: ['ignore','pipe','pipe'] });
  children.push(child);
  await new Promise((yes, no) => {
    let text = ''; const done = error => { clearTimeout(timer); child.stdout.off('data', consume); child.stderr.off('data', consume); child.off('exit', exit); child.off('error', fail); error ? no(error) : yes(); };
    const consume = chunk => { text = (text + chunk).slice(-16000); if (/HOME_TEST_READY/.test(text)) done(); };
    const exit = code => done(new Error(`Host ${spaceId} exited ${code}: ${redact(text)}`)); const fail = error => done(error);
    const timer = setTimeout(() => done(new Error(`Host ${spaceId} readiness: ${redact(text)}`)), 90000);
    child.stdout.on('data', consume); child.stderr.on('data', consume); child.once('exit', exit); child.once('error', fail);
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((yes, no) => { const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('Normal child shutdown deadline')); }, 15000); child.once('exit', () => { clearTimeout(timer); yes(); }); child.kill('SIGTERM'); });
}
try {
  await new Promise(r => server.listen(0,'127.0.0.1',r)); origin = `http://127.0.0.1:${server.address().port}`;
  const dashboard = pack(resolve('packages/dashboard'));
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dashboard-home-native-source', version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  writeFileSync(join(source, 'cordis.patch.yml'), '- insert:\n    - id: home-test-source\n      name: dashboard-home-native-source\n');
  writeFileSync(join(source, 'index.js'), `export const name='dashboard-home-native-source'; export const inject=['dashboardProvider'];
export async function apply(ctx) { const handle=ctx.dashboardProvider.register({types:[{typeId:'count',version:1,kind:'metric',title:'Count'}],snapshot:()=>[{instanceId:'item',typeId:'count',typeVersion:1,title:'Native background result',content:{kind:'metric',value:7,unit:'items'},sourceTarget:null,updatedAt:new Date().toISOString(),staleAfterSeconds:null}]}); const result=await handle.publish(); if(result.home.state!=='published')throw Error('Home publication not accepted: '+result.home.state); console.log('HOME_TEST_READY'); }
export default {name,inject,apply};\n`);
  const sourceTar = pack(source), protectedPaths = ['profiles/web','sessions','storages'];
  const before = protectedPaths.map(p => fingerprint(join(home,p)));
  for (const s of sources) {
    run([bin,'--profile',s.spaceId,'--from-default-profile','web','--dump-config'],'create named profile');
    const patch = join(home,'profiles',s.spaceId,'cordis.patch.yml'); writeFileSync(patch,applyIsolationPatch(readFileSync(patch,'utf8'),s.spaceId,patch));
    run([bin,'plugin','--profile',s.spaceId,'add',dashboard],'install dashboard');
    run([bin,'plugin','--profile',s.spaceId,'add',sourceTar],'install test source');
    const policy = await hub.applyPublication({kind:'dashboard.publication.set',spaceId:s.spaceId,providerId:'dashboard-home-native-source',expectedGrantRevision:'absent',selection:{kind:'all'}},assertOwner);
    s.policy = policy;
  }
  for (const s of sources) {
    const binding = {spaceId:s.spaceId,generation:1,runId:randomUUID()}; bindings.set(s.spaceId,binding); s.sourceState='running';
    const issued=await gateway.publishers.issue(binding); const file=writeDashboardBootstrap(join(root,'private'),issued.bootstrap,assertOwner); grants.push({...issued,file});
    await start(s.spaceId,file);
  }
  const catalog = (await query({kind:'catalog'})).data; assert.equal(catalog.entries.length,2);
  const refs = catalog.entries.map(e=>e.ref); const values=(await query({kind:'instances',refs})).data.items;
  assert.deepEqual(values.map(i=>i.state==='present'&&i.instance.content.value),[7,7]);
  pass('Two installed native DSH Hosts publish to one Home via private bearer handoffs, without any browser');
  const overview=(await query({kind:'overview'}));
  const receipt=await query({requestId:randomUUID(),issuedAt:new Date().toISOString(),backendEpoch:overview.backendEpoch,command:{kind:'board.create',boardId:'home',title:'Combined',placements:refs.map((ref,i)=>({id:'p'+i,ref,x:i*6,y:0,w:6,h:2}))}},'/api/dashboard/v1/commands');
  assert.equal(receipt.result.board.placements.length,2); pass('One Home layout references both native spaces; no source task was copied');
  grants[0].dispose(); bindings.delete('home-a'); sources[0].sourceState='stopped'; await stop(children[0]);
  const stopped=(await query({kind:'instances',refs})).data.items;
  const a=stopped.find(i=>i.ref.spaceId==='home-a'),b=stopped.find(i=>i.ref.spaceId==='home-b');
  assert.equal(a.state,'present'); assert.equal(a.freshness,'stale'); assert.equal(b.state,'present'); assert.equal(b.freshness,'current');
  pass('Stopping one owned run retains its authorized last result and leaves the second Host live');
  await hub.applyPublication({kind:'dashboard.publication.set',spaceId:'home-a',providerId:'dashboard-home-native-source',expectedGrantRevision:sources[0].policy.revision,selection:null},assertOwner);
  assert.equal((await query({kind:'catalog'})).data.entries.length,1); assert.equal((await query({kind:'board',boardId:'home'})).data.board.placements.length,1);
  pass('Revocation removes source visibility from catalog and existing board without stopping the other Host');
  for(let i=0;i<children.length;i++){grants[i].dispose();bindings.delete(sources[i].spaceId);await stop(children[i]);grants[i].file.dispose();}
  assert.deepEqual(protectedPaths.map(p=>fingerprint(join(home,p))),before);
  pass('Root web/session/storage fingerprints unchanged; no model calls, browser or production Home used');
  writeFileSync(join(evidence,'result.json'),JSON.stringify({status:'passed',node:process.version,proved,owner:'isolated test fixture, not production Supervisor',source:'synthetic plugin running in two native DSH Hosts'},null,2));
} catch(error) {
  process.exitCode=1; console.error(redact(error.stack??error)); writeFileSync(join(evidence,'result.json'),JSON.stringify({status:'failed',proved,error:redact(error.message??error)},null,2));
} finally {
  gateway.close(); bindings.clear(); for(const child of children)try{await stop(child);}catch(error){console.error(redact(error));process.exitCode=1;}
  await hub.close(); ownerActive=false;server.closeAllConnections();await new Promise(r=>server.close(r));
}
