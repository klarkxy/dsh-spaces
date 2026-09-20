#!/usr/bin/env node
/** Continue acceptance in the prior, explicitly isolated theme Home; never production. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedEnv, refuseRealHome, stopOwned } from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.sandbox/workbench-product-themes');
const output = join(root, '.sandbox/workbench-interactions');
const prior = JSON.parse(readFileSync(join(source, 'results.json'), 'utf8'));
const home = resolve(prior.home);
assert.ok(home.startsWith(source + sep) && prior.status === 'pass');
refuseRealHome(home);
const binding = JSON.parse(readFileSync(join(home, '.dsh-spaces-control/toolchain.json'), 'utf8'));
const report = { status: 'running', home, realDsh: true, modelCalls: false, proved: [] };
const pass = text => { report.proved.push(text); console.log(`PASS ${text}`); };
const until = async (fn, label, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(200); }
  throw new Error(`Timed out: ${label}`);
};
mkdirSync(output, { recursive: true });
const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(source, key)]));
const env = isolatedEnv(home, process.execPath, tooling);
const child = spawn(process.execPath, [join(root, 'packages/supervisor/lib/index.js'),
  '--home', home, '--bin', binding.bin, '--node', binding.nodeExe, '--port', '0',
  '--plugin-artifact', prior.artifacts.plugin.path, '--view-bridge-artifact', prior.artifacts.bridge.path,
  '--control-tool-root', binding.toolchainRoot, '--snapshot-root', binding.snapshotRoot,
  '--snapshot-worker', join(root, 'packages/supervisor/lib/snapshot-worker.mjs')],
{ cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let launch = '', errors = '', browser, page, api;
child.stdout.on('data', x => { launch += x; });
child.stderr.on('data', x => { errors += x; });
try {
  await until(() => {
    if (child.exitCode !== null) throw new Error(`supervisor exited: ${errors}`);
    return /bootstrap=(\S+)/.test(launch);
  }, 'supervisor', 240000);
  const bootstrap = launch.match(/bootstrap=(\S+)/)[1];
  const origin = new URL(bootstrap).origin;
  const { chromium } = await import(pathToFileURL(process.env.DSH_TEST_PLAYWRIGHT || 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await page.goto(bootstrap);
  api = async (method, data = {}) => {
    const response = await context.request.post(`${origin}/api/workbench/${method}`, { headers: { origin }, data });
    const body = await response.json();
    assert.equal(body.ok, true, `${method}: ${JSON.stringify(body.error)}`);
    return body.value;
  };
  const job = async command => {
    let latest = await api('submit', { command, requestId: randomUUID() });
    await until(async () => { latest = await api('job', { id: latest.id }); return !['queued', 'running'].includes(latest.status); }, command.kind, 240000);
    assert.equal(latest.status, 'succeeded', JSON.stringify(latest.error));
    return latest;
  };
  const plan = async request => job({ kind: 'plan.execute', planId: (await api('preview', { request })).id });
  const state = await api('state');
  const managerView = await api('view', { spaceId: state.managerId });
  const manager = async () => {
    await until(() => page.frames().some(f => f.url().startsWith(managerView.origin + '/')), 'manager frame');
    const frame = page.frames().find(f => f.url().startsWith(managerView.origin + '/'));
    await frame.locator('.dsh-wb-rail').waitFor();
    return frame;
  };
  let hub = await manager();
  const select = async label => {
    await hub.getByRole('button', { name: label, exact: true }).first().click();
    await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: label }).waitFor({ timeout: 65000 });
  };
  await select('XP');
  const xpView = await api('view', { spaceId: 'xp' });
  const xp = page.frames().find(f => f.url().startsWith(xpView.origin + '/') && f.parentFrame() === hub);
  assert.ok(xp);
  for (const name of [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i]) {
    const button = xp.getByRole('button', { name }).first();
    await button.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await button.isVisible()) await button.click();
  }
  await xp.locator('[data-icon="browse"]').dblclick();
  await xp.locator('.xp-grid-item[data-kind="ws"]').filter({ hasText: 'empty-workspace-xp' }).dblclick();
  await xp.locator('.xp-grid-item[data-kind="new"]').dblclick();
  await until(() => xp.childFrames().length > 0, 'XP inner chat');
  const chat = xp.childFrames()[0];
  for (const name of [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i]) {
    const button = chat.getByRole('button', { name }).first();
    await button.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await button.isVisible()) await button.click();
  }
  const editor = chat.locator('[contenteditable="true"]').first();
  await editor.waitFor({ timeout: 30000 });
  assert.equal(await chat.locator('#dsh-xp-taskbar').count(), 0);
  await editor.fill('XP unsent acceptance draft');
  await page.screenshot({ path: join(output, 'xp-real-chat.png') });
  await select('竹青');
  await select('XP');
  assert.equal(await editor.innerText(), 'XP unsent acceptance draft');
  pass('XP opens its real inner chat without a recursive desktop; switching retains its draft');

  await select('EternalNight');
  await hub.getByRole('button', { name: '竹青', exact: true }).first().click();
  await hub.getByRole('button', { name: 'XP', exact: true }).first().click();
  await hub.getByRole('button', { name: 'EternalNight', exact: true }).first().click();
  await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: 'EternalNight' }).waitFor();
  await delay(1500);
  assert.equal(await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: 'EternalNight' }).count(), 1);
  pass('rapid real rail clicks retain the last selection');

  const id = `lifecycle-${Date.now()}`;
  const renamed = `已改名 ${id}`;
  await job({ kind: 'space.create', input: { name: id, displayName: '生命周期验收' } });
  assert.equal(await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: 'EternalNight' }).count(), 1);
  await job({ kind: 'space.update', spaceId: id, displayName: renamed, icon: 'code' });
  const order = (await api('state')).spaces.filter(s => s.id !== state.managerId).map(s => s.id);
  await job({ kind: 'space.reorder', spaceIds: [id, ...order.filter(x => x !== id)] });
  const updated = (await api('state')).spaces.find(s => s.id === id);
  assert.equal(updated.displayName, renamed);
  assert.equal(updated.icon, 'code');
  await select(renamed);
  const first = await api('view', { spaceId: id });
  await plan({ kind: 'space.restart', spaceId: id });
  const restarted = await api('view', { spaceId: id });
  assert.ok(restarted.generation > first.generation);
  await plan({ kind: 'space.stop', spaceId: id });
  assert.equal((await api('state')).spaces.find(s => s.id === id).status, 'stopped');
  await plan({ kind: 'space.delete', spaceId: id, removeData: true });
  assert.equal(existsSync(join(home, 'profiles', id)), false);
  assert.equal((await api('state')).spaces.some(s => s.id === id), false);
  pass('create preserves selection; rename, icon, reorder, restart, stop and deletion read back correctly');

  await select('竹青');
  await page.reload();
  hub = await manager();
  await hub.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: '竹青' }).waitFor({ timeout: 60000 });
  pass('refresh restores the last valid selected space');
  report.status = 'pass';
} catch (error) {
  report.status = 'fail'; report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (api) {
    try {
      const p = await api('preview', { request: { kind: 'controller.shutdown' } });
      await api('submit', { command: { kind: 'plan.execute', planId: p.id }, requestId: randomUUID() });
      await until(() => child.exitCode !== null, 'shutdown', 10000).catch(() => {});
    } catch {}
  }
  await browser?.close();
  await stopOwned(child).catch(() => {});
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(output, 'supervisor.log'), errors.replace(/\/bootstrap\/[^\s]+/g, '/bootstrap/[redacted]'));
  if (report.error) console.error(report.error);
}
