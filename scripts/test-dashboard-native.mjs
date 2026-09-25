/** Real official CLI + packed plugin + authenticated native Web, in a disposable named profile. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { applyIsolationPatch } from '../src/core/domain/isolation.ts';

const root = resolve('.');
const sdk = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!sdk) throw new Error('Explicit SDK fixture required');
const bin = resolve(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const profile = 'dashboard-native';
mkdirSync('.sandbox', { recursive: true });
const fixture = mkdtempSync(resolve('.sandbox/dashboard-native-'));
const home = join(fixture, 'home');
const artifacts = join(fixture, 'packages');
const evidence = resolve('.sandbox/dashboard-native-evidence');
mkdirSync(home); mkdirSync(artifacts); mkdirSync(evidence, { recursive: true });
const env = { ...process.env, DSH_HOME: home, CI: '1', npm_config_registry: 'https://registry.npmjs.org', npm_config_fetch_retries: '0',
  PATH: resolve(sdk, 'node_modules/.bin') + delimiter + process.env.PATH };
delete env.ELECTRON_RUN_AS_NODE;
const redact = value => String(value).replace(/([?&]token=)[^&\s\x1b"']+/g, '$1[redacted]').replace(/dsh-auth-[^=\s]+=[^;\s"']+/g, '[redacted-cookie]');
const proved = [];
function pass(message) { proved.push(message); console.log('PASS', message); }
function run(executable, args, label) {
  console.log('STEP', label);
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${redact(result.stderr || result.stdout || result.error?.message).slice(-6000)}`);
  return result.stdout;
}
const cli = (args, label) => run(process.execPath, [bin, ...args], label);
function pack(directory) {
  const output = run('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', artifacts], 'Pack ' + directory);
  const entries = JSON.parse(output); assert.equal(entries.length, 1);
  return join(artifacts, entries[0].filename);
}
function fingerprint(path) {
  if (!existsSync(path)) return 'absent';
  const hash = createHash('sha256');
  function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.equal(entry.isSymbolicLink(), false); const file = join(dir, entry.name); hash.update(file.slice(path.length));
    if (entry.isDirectory()) walk(file); else hash.update(readFileSync(file));
  } }
  walk(path); return hash.digest('hex');
}
let current, browser, page;
async function stop() {
  const child = current; current = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Normal native Host shutdown timed out')); }, 15000);
    child.once('exit', () => { clearTimeout(timer); resolveStop(); }); child.kill('SIGTERM');
  });
}
async function start() {
  const reserve = createServer(); await new Promise(resolvePort => reserve.listen(0, '127.0.0.1', resolvePort));
  const port = reserve.address().port; await new Promise(resolvePort => reserve.close(resolvePort));
  const child = spawn(process.execPath, [bin, '--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env, cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
  current = child;
  const url = await new Promise((resolveUrl, reject) => {
    let tail = '', ended = false;
    const finish = (error, url) => {
      if (ended) return; ended = true; clearTimeout(timer);
      child.stdout.off('data', consume); child.stderr.off('data', consume); child.off('exit', exit); child.off('error', fail);
      if (error) reject(error); else resolveUrl(url);
    };
    const consume = chunk => {
      tail = (tail + chunk.toString()).slice(-24000);
      const match = tail.match(/dsh web:\s*(https?:\/\/[^\s\x1b]+)/);
      if (!match) return;
      const found = new URL(match[1]);
      if (found.origin !== `http://127.0.0.1:${port}` || found.pathname !== '/') finish(new Error('Unexpected native endpoint'));
      else finish(null, found);
    };
    const exit = code => finish(new Error(`Native Host exited ${code}: ${redact(tail).slice(-5000)}`));
    const fail = error => finish(error);
    const timer = setTimeout(() => finish(new Error(`Native Host did not become ready: ${redact(tail).slice(-5000)}`)), 90000);
    child.stdout.on('data', consume); child.stderr.on('data', consume); child.once('exit', exit); child.once('error', fail);
  });
  // Authenticate using the actual native token-to-HttpOnly-cookie exchange.
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('dsh-auth-'));
  await login.body?.cancel(); assert.equal(login.status, 303); assert.ok(cookie);
  const origin = url.origin;
  async function query(input, authorized = true, extra = {}) {
    return fetch(origin + '/api/dashboard/v1/query', { method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json', 'X-DSH-Dashboard': '1', ...(authorized ? { Cookie: cookie } : {}), ...extra,
    }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
  }
  return { origin, cookie, query };
}
try {
  const packagePath = pack(resolve('packages/dashboard'));
  cli(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'Create isolated named profile');
  const patch = join(home, 'profiles', profile, 'cordis.patch.yml');
  writeFileSync(patch, applyIsolationPatch(readFileSync(patch, 'utf8'), profile, patch));
  const protectedPaths = ['profiles/web', 'sessions', 'storages'];
  const before = protectedPaths.map(path => fingerprint(join(home, path)));
  cli(['plugin', '--profile', profile, 'add', packagePath], 'Install packed dashboard through official CLI');
  const dump = cli(['--profile', profile, '--dump-config'], 'Inspect native bundle composition');
  assert.match(dump, /dsh-dashboard/); assert.match(dump, /@dsh-spaces\/dashboard/);
  pass('Official CLI installs the dashboard bundle without manual activation rows');

  // Synthetic business data lives in an actual Host plugin, never a UI mock.
  const source = join(fixture, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dashboard-native-test-source', version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  writeFileSync(join(source, 'cordis.patch.yml'), "- insert:\n    - id: dashboard-native-test-source\n      name: dashboard-native-test-source\n");
  writeFileSync(join(source, 'index.js'), `export const name='dashboard-native-test-source'; export const inject=['dashboardProvider'];
export async function apply(ctx) {
 const handle=ctx.dashboardProvider.register({types:[{typeId:'progress',version:1,kind:'progress',title:'Native progress'}],snapshot:()=>[{instanceId:'work',typeId:'progress',typeVersion:1,title:'Native test progress',content:{kind:'progress',value:3,max:10,unit:'items',status:'running'},sourceTarget:null,updatedAt:new Date().toISOString(),staleAfterSeconds:null}]});
 await handle.publish();
}
export default {name,inject,apply};\n`);
  cli(['plugin', '--profile', profile, 'add', pack(source)], 'Install test-only native source');
  let host = await start();
  assert.equal((await host.query({ kind: 'overview' }, false)).status, 401);
  assert.equal((await host.query({ kind: 'overview' }, true, { Origin: 'http://untrusted.invalid' })).status, 403);
  assert.equal((await host.query({ kind: 'overview' }, true, { 'X-DSH-Dashboard': '0' })).status, 403);
  const catalogResponse = await host.query({ kind: 'catalog' }); assert.equal(catalogResponse.status, 200);
  const catalog = (await catalogResponse.json()).data; assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].ref.providerId, 'dashboard-native-test-source');
  pass('Real native browser authentication and actual caller-bound Host publication');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const equals = host.cookie.indexOf('=');
  await context.addCookies([{ name: host.cookie.slice(0, equals), value: host.cookie.slice(equals + 1), url: host.origin, httpOnly: true, sameSite: 'Lax' }]);
  page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(redact(error.message)));
  await page.goto(host.origin);
  // This is a fresh native profile. Wait for each real first-use control;
  // an immediate isVisible() before hydration would incorrectly skip the modal.
  for (const label of [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i]) {
    const button = page.getByRole('button', { name: label }).first();
    await button.waitFor({ state: 'visible', timeout: 20000 });
    await button.click();
  }
  await page.getByRole('button', { name: '工作首页', exact: true }).click();
  await page.getByRole('button', { name: '固定 Native test progress', exact: true }).click();
  await page.locator('.dsh-dashboard .dd-card progress').waitFor();
  assert.equal(await page.locator('.dsh-dashboard .dd-card progress').getAttribute('value'), '3');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(evidence, 'native.png'), fullPage: true });
  await browser.close(); browser = null; page = null;
  const board = (await (await host.query({ kind: 'board', boardId: 'home' })).json()).data.board;
  assert.equal(board.placements.length, 1);
  pass('Packed client loads through native DSH shared React and pins a real Host component');
  await stop(); host = await start();
  const reopened = (await (await host.query({ kind: 'board', boardId: 'home' })).json()).data.board;
  assert.equal(reopened.revision, board.revision); assert.equal(reopened.placements.length, 1);
  await stop();
  pass('Normal Host restart retains layout without reissuing the mutation');
  cli(['plugin', '--profile', profile, 'remove', 'dashboard-native-test-source'], 'Remove test-only source');
  cli(['plugin', '--profile', profile, 'remove', '@dsh-spaces/dashboard'], 'Remove dashboard entry');
  const afterRemove = cli(['--profile', profile, '--dump-config'], 'Inspect uninstall'); assert.doesNotMatch(afterRemove, /@dsh-spaces\/dashboard/);
  assert.deepEqual(protectedPaths.map(path => fingerprint(join(home, path))), before);
  pass('Uninstall removes native activation and protected root web/session/storage trees are unchanged');
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', node: process.version, proved, businessData: 'synthetic Host plugin', modelsCalled: false }, null, 2));
} catch (error) {
  console.error(redact(error?.stack ?? error)); process.exitCode = 1;
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'failed', node: process.version, proved, error: redact(error?.message ?? error) }, null, 2));
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true, timeout: 5000 });
      const text = redact((await page.locator('body').innerText({ timeout: 5000 })).slice(0, 12000));
      writeFileSync(join(evidence, 'failure-page.txt'), text);
      console.error('NATIVE FIXTURE PAGE', text);
    } catch (captureError) { console.error('Evidence capture failed:', redact(captureError?.message ?? captureError)); }
  }
} finally {
  if (browser) await browser.close();
  try { await stop(); } catch (error) { console.error(redact(error)); process.exitCode = 1; }
  // Keep this invocation's isolated fixture as test evidence; no user data is cleaned.
}
