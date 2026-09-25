/** Actual workbench UI + Supervisor + two installed DSH Hosts. Synthetic business data only. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbenchSupervisor } from '../src/adapters/node/workbench-supervisor.ts';
import { applyIsolationPatch } from '../src/core/domain/isolation.ts';
import { chromium } from 'playwright';
import { HomeController } from '../src/adapters/node/home-controller.ts';

const sdk = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!sdk) throw new Error('An explicitly installed official SDK is required');
const bin = resolve(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
mkdirSync('.sandbox', { recursive: true });
const root = mkdtempSync(resolve('.sandbox/dashboard-workbench-native-'));
const home = join(root, 'home'), artifacts = join(root, 'packages'), evidence = resolve('.sandbox/dashboard-workbench-evidence');
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
let supervisor, browser, page;
try {
  const dashboard = pack('packages/dashboard'), manager = pack('packages/plugin'), bridge = pack('packages/view-bridge');
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dashboard-workbench-native-source', version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  writeFileSync(join(source, 'cordis.patch.yml'), '- insert:\n    - id: dashboard-workbench-native-source\n      name: dashboard-workbench-native-source\n');
  writeFileSync(join(source, 'index.js'), `export const name='dashboard-workbench-native-source'; export const inject=['dashboardProvider'];
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
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_TEST_CHROMIUM ? { executablePath: process.env.DSH_TEST_CHROMIUM } : {}) });
  const contextBrowser = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await contextBrowser.addCookies(cookie.split('; ').map(pair => {
    const split = pair.indexOf('='); return { name: pair.slice(0, split), value: pair.slice(split + 1), url: supervisor.origin, httpOnly: true, sameSite: 'Strict' };
  }));
  page = await contextBrowser.newPage(); page.setDefaultTimeout(20000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(redacted(error.message)));
  await page.goto(supervisor.origin);
  const app = page.frameLocator('#manager-frame');
  await app.getByRole('heading', { name: '工作首页', exact: true }).waitFor();
  assert.equal(await app.locator('[data-home-view]').count(), 0, 'Default Home is the dashboard, not a hidden auto-created chat');
  assert.equal((await query({ kind: 'board', boardId: 'home' })).board, null, 'Opening the homepage does not create layout');
  pass('Actual manager-origin workbench opens the Home dashboard using authenticated Supervisor CORS, without creating chat or layout');
  async function waitPolicy(id, matches) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const policies = (await query({ kind: 'publications', spaceId: id })).policies;
      if (matches(policies)) return policies;
      await delay(100); // observe exact policy state, no mutation retries
    }
    throw new Error('Policy completion deadline');
  }
  const providerId = 'dashboard-workbench-native-source';
  await app.getByRole('button', { name: '发布授权', exact: true }).click();
  for (const id of ids) {
    await app.getByLabel('来源空间', { exact: true }).selectOption(id);
    await app.getByLabel('发布插件标识', { exact: true }).fill(providerId);
    await app.getByRole('radio', { name: '全部实例，包括未来新增实例', exact: true }).check();
    await app.getByRole('button', { name: '预览授权变更', exact: true }).click();
    await app.locator('[data-plan-id]').waitFor();
    assert.equal((await query({ kind: 'publications', spaceId: id })).policies.length, 0, 'Preview is not permission');
    if (id === ids[0]) {
      await app.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal((await query({ kind: 'publications', spaceId: id })).policies.length, 0, 'Cancelling preview changes nothing');
      await app.getByRole('button', { name: '预览授权变更', exact: true }).click();
    }
    await app.locator('[data-plan-id]').click();
    await waitPolicy(id, rows => rows.some(p => p.providerId === providerId && p.selection?.kind === 'all'));
    assert.equal((await api('state')).spaces.find(s => s.id === id).status, 'stopped', 'Granting does not start space');
  }
  pass('Publishing form previews and cancels without side effects, then confirms via real plan.execute while sources stay stopped');
  // These are existing management commands, not a browser fixture or replaced process runtime.
  for (const id of ids) await submit({ kind: 'space.start', spaceId: id });
  await app.getByRole('button', { name: '看板', exact: true }).click();
  for (const id of ids) {
    const entry = app.locator('.dd-catalog-entry').filter({ hasText: id });
    await entry.getByRole('button', { name: '固定 Native managed result', exact: true }).click();
    await app.locator('.dd-card').filter({ hasText: id }).locator('.dd-metric').waitFor();
  }
  assert.equal(await app.locator('.dd-card').count(), 2);
  const board = (await query({ kind: 'board', boardId: 'home' })).board;
  assert.equal(board.placements.length, 2);
  await page.screenshot({ path: join(evidence, 'home-desktop.png'), fullPage: true });
  pass('Default Home pins and renders real publications from two native Hosts into the same persisted board');
  // Switching views does not recreate the native chat frame. Draft preservation is
  // also checked by the existing workbench DOM fixture with an editable textarea.
  await app.getByRole('button', { name: '聊天', exact: true }).click();
  const chat = app.locator('[data-home-view]'); await chat.waitFor({ state: 'visible' });
  await chat.evaluate(element => { window.__dashboardChatNode = element; });
  await app.getByRole('button', { name: '看板', exact: true }).click();
  assert.equal(await chat.evaluate(element => element === window.__dashboardChatNode), true);
  await app.getByRole('button', { name: '聊天', exact: true }).click();
  assert.equal(await chat.evaluate(element => element === window.__dashboardChatNode), true);
  await app.getByRole('button', { name: '看板', exact: true }).click();
  pass('Chat is an explicit lazy view and its iframe survives dashboard navigation');
  await page.setViewportSize({ width: 450, height: 844 });
  await page.screenshot({ path: join(evidence, 'home-narrow.png'), fullPage: true });
  assert.equal(await app.locator('.dsh-workbench').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await app.getByRole('button', { name: '发布授权', exact: true }).click();
  await app.getByLabel('来源空间', { exact: true }).selectOption(ids[0]);
  await app.getByRole('button', { name: '编辑', exact: true }).click();
  await app.getByRole('radio', { name: '停用发布 / 撤销授权', exact: true }).check();
  await app.getByRole('button', { name: '预览授权变更', exact: true }).click();
  await app.locator('[data-plan-id]').click();
  await waitPolicy(ids[0], rows => rows.some(p => p.selection === null));
  assert.equal((await api('state')).spaces.find(s => s.id === ids[0]).status, 'running', 'Revoke does not stop a source');
  await app.getByRole('button', { name: '看板', exact: true }).click();
  await app.locator('.dd-card').filter({ hasText: ids[0] }).waitFor({ state: 'detached' });
  assert.equal(await app.locator('.dd-card').count(), 1);
  assert.equal((await query({ kind: 'board', boardId: 'home' })).board.placements.length, 1);
  pass('UI revocation hides the already pinned source via real management plans without stopping either Host');
  assert.deepEqual(pageErrors, []);
  await browser.close(); browser = null; page = null;
  await supervisor.close(); supervisor = null;
  assert.equal(new HomeController(home).inspect().held, false); assert.equal(readdirSync(join(home, '.spaces-dashboard', 'private')).length, 0);
  assert.deepEqual(protectedPaths.map(p => fingerprint(join(home,p))), before);
  pass('Normal Supervisor shutdown revokes all handoffs, releases run ownership and preserves root data');
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', node: process.version, proved, supervisor: 'production WorkbenchSupervisorRuntime', sources: 'two installed native DSH Hosts, synthetic business plugin', modelCalls: false }, null, 2));
} catch (error) {
  process.exitCode = 1; console.error(redacted(error.stack ?? error));
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true });
    for (const frame of page.frames()) {
      try { console.error('VISIBLE TEST PAGE', redacted((await frame.locator('body').innerText({ timeout: 3000 })).slice(0, 15000))); } catch { /* document was already gone */ }
    }
  }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'failed', proved, error: redacted(error.message ?? error) }, null, 2));
} finally {
  if (browser) await browser.close();
  if (supervisor) try { await supervisor.close(); } catch (error) { console.error(redacted(error)); process.exitCode = 1; }
}
