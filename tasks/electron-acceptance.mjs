import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { bin, home } from './real-config-check.mjs';
import { ProfileRegistry } from '../src/main/profile-registry.ts';
import { writeSettings } from '../src/main/hub-settings.ts';
import { DEFAULT_HUB_SETTINGS } from '../src/shared/types.ts';
import { findNodeDir, toolchainRoot, setToolchainRoot, ensurePnpm } from '../src/main/toolchain.ts';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const electronExe = require('electron');
const root = mkdtempSync(join(tmpdir(), 'spaces-electron-check-'));
const userData = join(root, 'app');
const toolsDir = join(root, 'tools');
const nodeDir = findNodeDir();
const priorTools = toolchainRoot();
assert.ok(nodeDir);
mkdirSync(userData); mkdirSync(toolsDir);
symlinkSync(nodeDir, join(toolsDir, 'node'), 'junction');
symlinkSync(join(priorTools, 'pnpm'), join(toolsDir, 'pnpm'), 'junction');
setToolchainRoot(toolsDir);
await ensurePnpm();
new ProfileRegistry(home).markOnboarded();
writeSettings(home, { ...DEFAULT_HUB_SETTINGS, locale: 'en', portStart: 3210, portEnd: 3239 });
const bootstrap = join(root, 'bootstrap.cjs');
writeFileSync(bootstrap, `const electron = require('electron');\nelectron.app.setPath('userData', ${JSON.stringify(userData)});\nconst buildMenu=electron.Menu.buildFromTemplate.bind(electron.Menu);\nglobal.__acceptanceMenus=[];\nelectron.Menu.buildFromTemplate=(items)=>{global.__acceptanceMenus.push(items);return buildMenu(items)};\nimport(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});\n`);
const env = { ...process.env, DSH_SPACES_HOME: home, DSH_SPACES_TOOLCHAIN: toolsDir, DSH_SPACES_CLI: resolve(dirname(bin), '../../../..') };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`ELECTRON_TEST_ROOT=${root}`);
// Desktop automation may run behind another window; keep animation frames active.
const app = await electron.launch({ executablePath: electronExe, args: [bootstrap, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], env, timeout: 120000 });
const page = await app.firstWindow();
await page.bringToFront();
const errors = [];
app.process().stderr?.on('data', chunk => console.log('Electron:', chunk.toString().slice(0, 1200)));
page.on('pageerror', error => errors.push(String(error)));
page.setDefaultTimeout(20000);
const artifacts = resolve('tasks/artifacts'); mkdirSync(artifacts, { recursive: true });
let exited = false;
const ports = [];
async function waitRunning(name) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const row = (await page.evaluate(() => window.dshSpaces.listProfiles())).find(p => p.name === name);
    if (row?.status === 'running' && Number.isInteger(row.port)) return row;
    if (row?.status === 'crashed') throw new Error(row.lastError || `${name} crashed`);
    await delay(150);
  }
  throw new Error(`${name} did not become ready within 60 seconds`);
}
async function rpc(port, method, payload = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, connection: 'close' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.ok(body.result?.ok, JSON.stringify(body));
  return body.result.value;
}
try {
  await page.waitForFunction(async () => (await window.dshSpaces.getCliStatus()).state === 'ready');
  console.log('Electron profiles:', JSON.stringify(await page.evaluate(() => window.dshSpaces.listProfiles())));
  await page.getByRole('button', { name: 'coding', exact: true }).click();
  await waitRunning('coding');
  for (const name of ['web', 'writing']) await page.evaluate(name => window.dshSpaces.startProfile(name), name);
  const profiles = await page.evaluate(() => window.dshSpaces.listProfiles());
  assert.equal(profiles.filter(p => p.status === 'running').length, 3);
  assert.equal(new Set(profiles.map(p => p.port)).size, 3);
  const sessions = {};
  for (const profile of profiles) {
    ports.push(profile.port);
    const workspace = join(root, `workspace-${profile.name}`); mkdirSync(workspace);
    const session = await rpc(profile.port, 'session.create', { cwd: workspace });
    assert.ok(session.sessionId); sessions[profile.name] = session.sessionId;
  }
  for (const profile of profiles) {
    const value = await rpc(profile.port, 'session.list');
    const ids = (value.items || []).map(row => row.sessionId);
    assert.ok(ids.includes(sessions[profile.name]));
    for (const [name, id] of Object.entries(sessions)) if (name !== profile.name) assert.ok(!ids.includes(id));
  }
  console.log('PASS Electron: three real DSH processes, distinct ports and isolated sessions');
  const beforeView = await page.evaluate(() => window.dshSpaces.getSelectedProfile());
  const beforeIds = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.id));
  await page.evaluate(() => window.dshSpaces.windowClose());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'close must hide to a working tray');
  const secondary = spawn(electronExe, [bootstrap], { env, windowsHide: true, stdio: 'pipe' });
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { secondary.kill(); reject(new Error('second instance did not exit')); }, 15000);
    secondary.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error(`second instance exit ${code}`)); });
    secondary.once('error', reject);
  });
  await page.waitForFunction(() => document.visibilityState === 'visible');
  assert.equal(await page.evaluate(() => window.dshSpaces.getSelectedProfile()), beforeView);
  assert.deepEqual(await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(w => w.id)), beforeIds);
  console.log('PASS Electron: close to tray, single instance restores unchanged embedded views');
  await page.evaluate(() => window.dshSpaces.showProfileMenu('coding'));
  await app.evaluate(() => {
    const items = global.__acceptanceMenus.at(-1);
    const diagnostic = items.find(item => /Diagnostics|诊断/.test(item.label || ''));
    if (!diagnostic) throw new Error('diagnostics missing from actual native menu');
    diagnostic.click();
  });
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Diagnostics — coding' }).waitFor();
  await page.getByRole('button', { name: 'Copy redacted logs' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'diagnostics.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Versions and recovery', exact: true }).click();
  await page.getByRole('heading', { name: 'DSH runtime' }).waitFor();
  await page.getByRole('button', { name: 'Stop spaces and create snapshot' }).click();
  const responsiveAt = Date.now();
  await page.evaluate(() => window.dshSpaces.getMaintenance());
  assert.ok(Date.now() - responsiveAt < 2000, 'snapshot copying must leave the main process responsive');
  await page.waitForFunction(() => document.body.innerText.includes('Snapshot created. Spaces remain stopped.') || Boolean(document.querySelector('[role="alert"]')), null, { timeout: 300000 });
  assert.equal(await page.locator('[role="alert"]').count(), 0, await page.locator('body').innerText());
  console.log('PASS Electron: full offline snapshot created with real pnpm runtime');
  let state = await page.evaluate(() => window.dshSpaces.getMaintenance());
  assert.equal(state.snapshots.length, 1);
  assert.ok((await page.evaluate(() => window.dshSpaces.listProfiles())).every(p => p.status === 'stopped'));
  writeFileSync(join(home, 'hub', 'after-snapshot.txt'), 'later data');
  writeFileSync(join(home, '.credentials.yaml'), '{}\n# acceptance preserved\n');
  await page.getByRole('button', { name: 'Preview and restore', exact: true }).first().click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  const restoreResponsiveAt = Date.now();
  await page.evaluate(() => window.dshSpaces.getMaintenance());
  assert.ok(Date.now() - restoreResponsiveAt < 2000, 'restoring must leave the main process responsive');
  await page.waitForFunction(() => document.body.innerText.includes('Operation complete.') || Boolean(document.querySelector('[role="alert"]')), null, { timeout: 300000 });
  assert.equal(await page.locator('[role="alert"]').count(), 0, await page.locator('body').innerText());
  assert.equal(existsSync(join(home, 'hub', 'after-snapshot.txt')), false);
  assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), '{}\n# acceptance preserved\n');
  state = await page.evaluate(() => window.dshSpaces.getMaintenance());
  assert.equal(state.snapshots.length, 2);
  assert.ok(state.inventory.current.bin.includes('snapshots'));
  assert.equal(state.error, undefined);
  await page.screenshot({ path: join(artifacts, 'versions-recovery.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'coding', exact: true }).click();
  const restarted = await waitRunning('coding');
  const restoredList = await rpc(restarted.port, 'session.list');
  assert.ok(restoredList.items.some(row => row.sessionId === sessions.coding));
  console.log('PASS Electron: restore confirmation, before-restore backup, credentials preserved, offline snapshot runtime starts with original chats');
  assert.deepEqual(errors, []);
  const closed = app.waitForEvent('close', { timeout: 20000 });
  await app.evaluate(({ app }) => app.quit());
  await closed; exited = true;
  for (const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
  console.log('PASS Electron: explicit quit closes owned DSH ports');
} catch (error) {
  console.log('Electron renderer errors:', errors);
  console.log('Electron UI:', await page.locator('body').innerText().catch(() => 'unavailable'));
  await page.screenshot({ path: join(artifacts, 'electron-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (!exited) { await app.close().catch(() => {}); }
}
