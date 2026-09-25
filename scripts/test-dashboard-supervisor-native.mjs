/** Actual WorkbenchSupervisor + two actual DSH Hosts. No mock owner, authentication or plan callback. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbenchSupervisor } from '../src/adapters/node/workbench-supervisor.ts';
import { applyIsolationPatch } from '../src/core/domain/isolation.ts';
import { HomeController } from '../src/adapters/node/home-controller.ts';

const sdk = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!sdk) throw new Error('An explicitly installed official SDK is required');
const bin = resolve(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
mkdirSync('.sandbox', { recursive: true });
const root = mkdtempSync(resolve('.sandbox/dashboard-supervisor-native-'));
const home = join(root, 'home'), artifacts = join(root, 'packages'), evidence = resolve('.sandbox/dashboard-supervisor-evidence');
mkdirSync(home); mkdirSync(artifacts); mkdirSync(evidence, { recursive: true });
process.env.PATH = resolve(sdk, 'node_modules/.bin') + delimiter + process.env.PATH;
const env = { ...process.env, DSH_HOME: home, CI: '1', npm_config_fetch_retries: '0' };
delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE;
const redacted = value => String(value).replace(/([?&]token=)[^&\s\x1b"']+/g, '$1[redacted]').replace(/[a-f0-9]{64}/g, '[redacted-identifier]');
const proved = [];
function pass(value) { proved.push(value); console.log('PASS', value); }
function run(executable, args, label) {
  const r = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${label}: ${redacted(r.stderr || r.stdout || r.error).slice(-6000)}`);
  return r.stdout;
}
const cli = (args, label) => run(process.execPath, [bin, ...args], label);
const pack = path => join(artifacts, JSON.parse(run('npm', ['pack', resolve(path), '--ignore-scripts', '--json', '--pack-destination', artifacts], 'pack'))[0].filename);
function fingerprint(path) {
  if (!existsSync(path)) return 'absent';
  const hash = createHash('sha256');
  const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    assert.equal(e.isSymbolicLink(), false); const p = join(dir,e.name); hash.update(p.slice(path.length)); e.isDirectory() ? walk(p) : hash.update(readFileSync(p));
  } }; walk(path); return hash.digest('hex');
}
let supervisor;
try {
  const dashboard = pack('packages/dashboard'), manager = pack('packages/plugin'), bridge = pack('packages/view-bridge');
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dashboard-supervisor-native-source', version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  writeFileSync(join(source, 'cordis.patch.yml'), '- insert:\n    - id: dashboard-supervisor-native-source\n      name: dashboard-supervisor-native-source\n');
  writeFileSync(join(source, 'index.js'), `export const name='dashboard-supervisor-native-source'; export const inject=['dashboardProvider'];
export async function apply(ctx) { const handle=ctx.dashboardProvider.register({types:[{typeId:'count',version:1,kind:'metric',title:'Count'}],snapshot:()=>[{instanceId:'item',typeId:'count',typeVersion:1,title:'Native managed result',content:{kind:'metric',value:9,unit:'items'},sourceTarget:null,updatedAt:new Date().toISOString(),staleAfterSeconds:null}]}); const result=await handle.publish(); if(result.home.state!=='published')throw Error('Expected an authorized Home publication'); }
export default {name,inject,apply};\n`);
  const sourcePackage = pack(source), ids = ['managed-a', 'managed-b'];
  for (const id of ids) {
    cli(['--profile', id, '--from-default-profile', 'web', '--dump-config'], 'prepare named profile');
    const patch = join(home, 'profiles', id, 'cordis.patch.yml'); writeFileSync(patch, applyIsolationPatch(readFileSync(patch, 'utf8'), id, patch));
    cli(['plugin', '--profile', id, 'add', dashboard], 'install standalone dashboard');
    cli(['plugin', '--profile', id, 'add', sourcePackage], 'install test source');
  }
  const protectedPaths = ['profiles/web', 'sessions', 'storages']; const before = protectedPaths.map(p => fingerprint(join(home, p)));
  supervisor = await createWorkbenchSupervisor({
    home, bin, port: 0, portStart: 42000, portEnd: 42999, pluginArtifact: manager, viewBridgeArtifact: bridge,
    controlToolRoot: join(root, 'tools'), nodeExe: process.execPath,
  });
  const login = await fetch(supervisor.bootstrapUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 303); const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; '); await login.body?.cancel();
  const post = async (path, body, authorized = true, headers = {}) => {
    const response = await fetch(supervisor.origin + path, { method: 'POST', headers: { Origin: supervisor.origin, 'Content-Type': 'application/json', 'X-DSH-Dashboard': '1', ...(authorized ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, data: await response.json() };
  };
  const api = async (method, body = {}) => {
    const r = await post('/api/workbench/' + method, body); assert.equal(r.status, 200); assert.equal(r.data.ok, true, JSON.stringify(r.data)); return r.data.value;
  };
  const context = async () => { const s = await api('state'); return { serviceEpoch: s.serviceEpoch, expectedRevision: s.revision }; };
  const submit = async command => {
    const job = await api('submit', { command, requestId: randomUUID(), context: await context() });
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const observed = await api('job', { id: job.id });
      if (observed.status === 'failed') throw new Error(`Native job failed: ${redacted(JSON.stringify(observed))}`);
      if (observed.status === 'succeeded') return observed;
      await delay(100); // read-only observation of this exact job, never replay
    }
    throw new Error('Native management job deadline');
  };
  const plan = async request => {
    const preview = await api('preview', { request, context: await context() });
    return submit({ kind: 'plan.execute', planId: preview.id });
  };
  const query = async request => { const r = await post('/api/dashboard/v1/query', request); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.data; };
  const state = await api('state'); assert.equal(state.role, 'manager'); assert.equal(state.writable, true, JSON.stringify(state));
  assert.equal((await post('/api/dashboard/v1/query', { kind: 'overview' }, false)).status, 401);
  assert.equal((await post('/api/dashboard/v1/query', { kind: 'overview' }, true, { Origin: 'http://untrusted.invalid' })).status, 403);
  pass('Actual Supervisor owns the Home and authenticates dashboard routes on its existing port');
  for (const id of ids) {
    await plan({ kind: 'dashboard.publication.set', spaceId: id, providerId: 'dashboard-supervisor-native-source', expectedGrantRevision: 'absent', selection: { kind: 'all' } });
    assert.equal((await api('state')).spaces.find(s => s.id === id).status, 'stopped');
  }
  pass('Actual preview/plan.execute grants publication without installing or starting sources');
  for (const id of ids) await submit({ kind: 'space.start', spaceId: id });
  const end = Date.now() + 15000;
  let catalog;
  do { catalog = await query({ kind: 'catalog' }); if (catalog.entries.length === 2) break; await delay(100); } while (Date.now() < end);
  assert.equal(catalog.entries.length, 2);
  const refs = catalog.entries.map(e => e.ref), overview = await post('/api/dashboard/v1/query', { kind: 'overview' });
  const saved = await post('/api/dashboard/v1/commands', { requestId: randomUUID(), issuedAt: new Date().toISOString(), backendEpoch: overview.data.backendEpoch,
    command: { kind: 'board.create', boardId: 'home', title: 'Managed Home', placements: refs.map((ref, i) => ({ id: `p${i}`, ref, x: i*6, y: 0, w: 6, h: 2 })) } });
  assert.equal(saved.status, 200); assert.equal(saved.data.result.board.placements.length, 2);
  pass('Two native DSH Hosts started by the real Supervisor publish into one persisted Home board');
  const privateDir = join(home, '.spaces-dashboard', 'private');
  const issued = [];
  for (const name of readdirSync(privateDir)) {
    const path = join(privateDir, name), bootstrap = JSON.parse(readFileSync(path, 'utf8'));
    const grant = await fetch(supervisor.origin + '/internal/dashboard/v1/grant', { headers: { Authorization: `Bearer ${bootstrap.bearer}` }, signal: AbortSignal.timeout(10000) });
    assert.equal(grant.status, 200); issued.push({ path, bootstrap, spaceId: (await grant.json()).spaceId });
  }
  const a = issued.find(v => v.spaceId === ids[0]); assert.ok(a);
  await plan({ kind: 'space.stop', spaceId: ids[0] });
  assert.equal(existsSync(a.path), false);
  const old = await fetch(supervisor.origin + '/internal/dashboard/v1/grant', { headers: { Authorization: `Bearer ${a.bootstrap.bearer}` } }); assert.equal(old.status, 401); await old.body?.cancel();
  const results = (await query({ kind: 'instances', refs })).items;
  assert.equal(results.find(i => i.ref.spaceId === ids[0]).freshness, 'stale'); assert.equal(results.find(i => i.ref.spaceId === ids[1]).freshness, 'current');
  pass('Normal stop invalidates the exact private run immediately while the other native Host stays live');
  const policy = (await query({ kind: 'publications', spaceId: ids[0] })).policies[0];
  await plan({ kind: 'dashboard.publication.set', spaceId: ids[0], providerId: policy.providerId, expectedGrantRevision: policy.revision, selection: null });
  assert.equal((await query({ kind: 'catalog' })).entries.length, 1); assert.equal((await query({ kind: 'board', boardId: 'home' })).board.placements.length, 1);
  await plan({ kind: 'space.delete', spaceId: ids[0], removeData: false });
  assert.equal(existsSync(join(home, 'profiles', ids[0])), false);
  pass('Actual authorization and deletion plans remove source visibility without a management bypass');
  await supervisor.close(); supervisor = null;
  assert.equal(new HomeController(home).inspect().held, false); assert.equal(readdirSync(privateDir).length, 0);
  assert.deepEqual(protectedPaths.map(p => fingerprint(join(home,p))), before);
  pass('Normal Supervisor shutdown revokes all handoffs, releases run ownership and preserves root data');
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', node: process.version, proved, supervisor: 'production WorkbenchSupervisorRuntime', sources: 'two installed native DSH Hosts, synthetic business plugin', modelCalls: false }, null, 2));
} catch (error) {
  process.exitCode = 1; console.error(redacted(error.stack ?? error));
  if (supervisor) console.error('PUBLIC SUPERVISOR STATE', redacted(JSON.stringify(await supervisor.runtime.state())));
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'failed', proved, error: redacted(error.message ?? error) }, null, 2));
} finally {
  if (supervisor) try { await supervisor.close(); } catch (error) { console.error(redacted(error)); process.exitCode = 1; }
}
