#!/usr/bin/env node
/** Independent acceptance against packed resources and a disposable Home. No model calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_BIN, resolveNpmCli, resolvePnpmCjs, writePnpmShim, isolatedEnv, runDsh, run, refuseRealHome, stopOwned, rpc, assertRpcOk } from './verify-spaces-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const withThemes = process.argv.includes('--themes');
const output = join(root, '.sandbox', withThemes ? 'workbench-product-themes' : 'workbench-product');
const node = process.execPath;
const bin = process.env.DSH_TEST_BIN || DEFAULT_BIN;
const playwrightPath = process.env.DSH_TEST_PLAYWRIGHT || 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const proved = [];
const report = { status: 'running', proved, realDsh: true, packed: true, modelCalls: false };
const redact = value => String(value).replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]').replace(/\/bootstrap\/[^\s"'<>]+/g, '/bootstrap/[redacted]').replace(/(dsh-auth-[^=\s]+)=([^;\s"']+)/g, '$1=[redacted]');
const pass = text => { proved.push(text); console.log(`PASS ${text}`); };
const save = () => writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  mkdirSync(output, { recursive: true });
  const home = mkdtempSync(join(output, 'home-'));
  refuseRealHome(home);
  report.home = home;
  report.startedAt = new Date().toISOString();
  const tooling = Object.fromEntries(['shim', 'pnpmHome', 'store', 'cache'].map(key => [key, join(output, key)]));
  Object.values(tooling).forEach(path => mkdirSync(path, { recursive: true }));
  writePnpmShim(tooling.shim, node, resolvePnpmCjs());
  const env = isolatedEnv(home, node, tooling);
  for (const key of Object.keys(env)) {
    if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH).*(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key)) delete env[key];
  }
  const packDir = join(output, 'packed');
  mkdirSync(packDir, { recursive: true });
  const npm = resolveNpmCli(node);
  const pack = name => {
    const result = run(node, [npm, 'pack', join(root, 'packages', name), '--json', '--ignore-scripts', '--pack-destination', packDir], {
      cwd: root, env, timeoutMs: 60000, label: `pack ${name}`,
    });
    const rows = JSON.parse(result);
    const file = join(packDir, rows[0].filename);
    assert.ok(existsSync(file));
    return file;
  };
  const plugin = pack('plugin');
  const bridge = pack('view-bridge');
  report.artifacts = { plugin: { path: plugin, sha256: hash(plugin) }, bridge: { path: bridge, sha256: hash(bridge) } };
  runDsh(node, bin, home, tooling, ['--profile', 'web', '--dump-config'], 180000, 'seed base web', join(output, 'seed.log'));
  const originalDefault = readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8');
  pass('fresh official web profile seeded without copying user data');
  const supervisor = spawn(node, [join(root, 'packages/supervisor/lib/index.js'),
    '--home', home, '--bin', bin, '--node', node, '--port', '0',
    '--plugin-artifact', plugin, '--view-bridge-artifact', bridge,
    '--snapshot-worker', join(root, 'packages/supervisor/lib/snapshot-worker.mjs'),
    '--control-tool-root', join(output, 'tools'), '--snapshot-root', join(output, 'snapshots')],
  { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchOutput = '', stderr = '';
  supervisor.stdout.on('data', chunk => { launchOutput = (launchOutput + chunk.toString()).slice(-32768); });
  supervisor.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-32768); });
  let browser;
  let page;
  let api;
  try {
    await until(() => {
      if (supervisor.exitCode !== null) throw new Error(`supervisor exited ${supervisor.exitCode}: ${redact(stderr)}`);
      return /bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.test(launchOutput);
    }, 'packaged supervisor initialization', 240000);
    const bootstrapUrl = launchOutput.match(/bootstrap=(http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)[1];
    const origin = new URL(bootstrapUrl).origin;
    report.origin = origin;
    if (process.argv.includes('--http-only')) {
      const response = await fetch(bootstrapUrl, { redirect: 'manual' });
      await response.body?.cancel();
      assert.equal(response.status, 303);
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      assert.ok(cookie);
      api = async (method, payload = {}) => {
        const result = await fetch(`${origin}/api/workbench/${method}`, {
          method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
        });
        const body = await result.json();
        if (!body.ok) throw new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
        return body.value;
      };
      const execute = async command => {
        const submitted = await api('submit', { command, requestId: randomUUID() });
        let latest;
        await until(async () => {
          latest = await api('job', { id: submitted.id });
          return !['queued', 'running'].includes(latest.status);
        }, command.kind, 240000);
        assert.equal(latest.status, 'succeeded', `${command.kind}: ${JSON.stringify(latest.error)}`);
      };
      const state = await api('state');
      assert.equal(state.role, 'manager', JSON.stringify(state.reasons));
      assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, 'running', JSON.stringify(state.reasons));
      pass('real dedicated DSH manager started from packed resources');
      assert.equal(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'), originalDefault);
      for (const name of ['coding', 'notes']) {
        await execute({ kind: 'space.create', input: { name } });
        const manifest = JSON.parse(readFileSync(join(home, 'profiles', name, 'package.json'), 'utf8'));
        assert.equal(Boolean(manifest.dependencies?.['@dsh-spaces/plugin']), false);
        assert.ok(manifest.dependencies?.['@dsh-spaces/view-bridge']);
        await execute({ kind: 'space.start', spaceId: name });
        const view = await api('view', { spaceId: name });
        const entry = await fetch(`${view.entryOrigin}${view.entryPath}`, { headers: { cookie, origin }, redirect: 'manual' });
        assert.equal(entry.status, 200);
        assert.ok((await entry.text()).includes(`location.replace(${JSON.stringify(`${view.origin}/`)})`));
        const childCookie = entry.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        const document = await fetch(`${view.origin}/`, { headers: { cookie: childCookie }, signal: AbortSignal.timeout(15000) });
        assert.equal(document.status, 200);
        assert.match(await document.text(), /(?:dsh|deepseek)/i);
        pass(`${name}: ordinary real DSH started and authorized embed route reached clean document URL`);
      }
      const plan = await api('preview', { request: { kind: 'space.stop', spaceId: state.managerId } });
      await execute({ kind: 'plan.execute', planId: plan.id });
      const rescue = await fetch(`${origin}/`, { headers: { cookie } });
      assert.equal(rescue.status, 200);
      assert.match(await rescue.text(), /救援入口|管理环境不可用/);
      assert.equal((await api('state')).spaces.find(space => space.id === state.managerId)?.status, 'stopped');
      pass('real manager stopped while independent entry and state API remain available');
      report.status = 'pass';
      report.scope = 'HTTP and real process foundation only; browser/theme/maintenance acceptance not included';
      return;
    }
    const { chromium } = await import(pathToFileURL(playwrightPath).href);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', error => console.log(`BROWSER ${redact(error.message)}`));
    await page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await until(() => page.url() === `${origin}/`, 'clean stable entry URL');
    api = async (method, payload = {}) => {
      const response = await context.request.post(`${origin}/api/workbench/${method}`, { headers: { origin }, data: payload, timeout: 30000 });
      const body = await response.json();
      if (!body.ok) throw new Error(`${method}: ${body.error?.code} ${body.error?.message}`);
      return body.value;
    };
    const job = async command => {
      const submitted = await api('submit', { command, requestId: randomUUID() });
      let latest = submitted;
      await until(async () => {
        latest = await api('job', { id: submitted.id });
        return !['queued', 'running'].includes(latest.status);
      }, command.kind, 240000);
      assert.equal(latest.status, 'succeeded', `${command.kind}: ${JSON.stringify(latest.error)}`);
      return latest;
    };
    let state = await api('state');
    assert.equal(state.writable, true);
    assert.equal(state.role, 'manager');
    assert.ok(state.managerId);
    assert.equal(state.spaces.find(space => space.id === state.managerId)?.status, 'running');
    const managerView = await api('view', { spaceId: state.managerId });
    await until(() => page.frames().some(frame => frame.url().startsWith(managerView.origin + '/')), 'real manager iframe');
    const managerFrame = page.frames().find(frame => frame.url().startsWith(managerView.origin + '/'));
    await managerFrame.locator('.dsh-wb-rail').waitFor({ state: 'visible', timeout: 60000 });
    pass('packaged supervisor launched a real dedicated DSH manager with the workbench rail');
    assert.equal(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'), originalDefault);
    pass('default web manifest preserved');

    const scenarios = withThemes ? [
      ['zhuqing', '竹青', 'dsh-theme-plugin', '0.3.3'],
      ['eternalnight', 'EternalNight', '@eternalnight/dsh-theme', '0.5.1'],
      ['xp', 'XP', 'dsh-client-ui-theme-xp', '0.1.1'],
    ] : [['coding', '编程'], ['notes', '笔记']];
    const visited = new Map();
    for (const [name, displayName, packageName, version] of scenarios) {
      await job({ kind: 'space.create', input: { name, displayName } });
      if (packageName) {
        const catalog = await api('plugins', { query: packageName });
        const entry = catalog.find(row => row.packageName === packageName);
        assert.ok(entry, `catalog includes ${packageName}`);
        const plan = await api('preview', { request: { kind: 'plugin.install', spaceIds: [name], catalogId: entry.id, version } });
        await job({ kind: 'plan.execute', planId: plan.id });
        const installed = JSON.parse(readFileSync(join(home, 'profiles', name, 'node_modules', packageName, 'package.json'), 'utf8'));
        assert.equal(installed.name, packageName);
        assert.equal(installed.version, version);
        pass(`${name}: exact theme ${packageName}@${version} installed through workbench and read back`);
      }
      const manifest = JSON.parse(readFileSync(join(home, 'profiles', name, 'package.json'), 'utf8'));
      assert.equal(Boolean(manifest.dependencies?.['@dsh-spaces/plugin']), false);
      assert.ok(manifest.dependencies?.['@dsh-spaces/view-bridge']);
      await until(async () => (await managerFrame.getByRole('button', { name: displayName, exact: true }).count()) > 0, `rail ${displayName}`);
      await managerFrame.getByRole('button', { name: displayName, exact: true }).first().click();
      await until(async () => {
        state = await api('state');
        return state.spaces.find(space => space.id === name)?.status === 'running';
      }, `click starts ${name}`);
      const view = await api('view', { spaceId: name });
      await until(() => page.frames().some(frame => frame.url().startsWith(view.origin + '/')), `embedded ${name}`);
      await managerFrame.locator(`.dsh-wb-rail button[aria-current="true"]`).filter({ hasText: displayName }).waitFor({ timeout: 60000 });
      const child = page.frames().find(frame => frame.url().startsWith(view.origin + '/'));
      visited.set(name, child);
      if (withThemes) {
        const workspacePath = join(output, `empty-workspace-${name}`);
        mkdirSync(workspacePath, { recursive: true });
        const cookies = (await context.cookies(view.origin)).map(row => `${row.name}=${row.value}`).join('; ');
        const created = assertRpcOk(await rpc(Number(new URL(view.origin).port), cookies, 'workspace/create', { request: { path: workspacePath } }), 'create empty workspace');
        const workspaceId = created?.workspace?.workspaceId ?? created?.workspaceId;
        assert.ok(workspaceId);
        assertRpcOk(await rpc(Number(new URL(view.origin).port), cookies, 'session/create', { request: { workspaceId } }), 'create empty session');
        await child.goto(`${view.origin}/${name === 'zhuqing' ? '#theme=zhuqing-light' : ''}`);
        if (name === 'xp') await child.locator('[data-xp-desktop], #dsh-xp-taskbar').first().waitFor({ timeout: 30000 });
        else {
          for (const label of [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i]) {
            const button = child.getByRole('button', { name: label }).first();
            await button.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
            if (await button.isVisible()) await button.click();
          }
          const workspacePicker = child.getByText('选择工作区', { exact: true }).first();
          if (await workspacePicker.isVisible()) {
            await workspacePicker.click();
            await child.getByText(`empty-workspace-${name}`, { exact: true }).last().click();
          }
          const editor = child.locator('[contenteditable="true"]').first();
          await editor.waitFor({ timeout: 30000 });
          await editor.fill(`unsent draft ${name}`);
          if (name === 'zhuqing') {
            await until(() => child.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').replace(/\s+/g, '') === 'rgb(239,248,241)'), 'real Zhuqing theme tokens');
          } else await child.locator('.dt-bg img, .dt-bg video').first().waitFor({ timeout: 30000 });
        }
        await page.screenshot({ path: join(output, `${name}-workbench.png`) });
      }
      pass(`${name}: ordinary profile has only lightweight bridge, rail click starts and embeds real DSH`);
    }
    if (withThemes) {
      for (const [name, displayName] of scenarios.slice(0, 2)) {
        await managerFrame.getByRole('button', { name: displayName, exact: true }).first().click();
        await managerFrame.locator('.dsh-wb-rail button[aria-current="true"]').filter({ hasText: displayName }).waitFor({ timeout: 15000 });
        assert.ok((await visited.get(name).locator('[contenteditable="true"]').first().innerText()).includes(`unsent draft ${name}`));
      }
      pass('XP cannot take over the outer rail; switching back retains unsent drafts in both other theme spaces');
    }
    await page.screenshot({ path: join(output, 'workbench-two-spaces.png') });
    const beforeStop = await api('state');
    const plan = await api('preview', { request: { kind: 'space.stop', spaceId: beforeStop.managerId } });
    await job({ kind: 'plan.execute', planId: plan.id });
    assert.equal((await api('state')).spaces.find(space => space.id === beforeStop.managerId)?.status, 'stopped');
    await page.getByText(/检查并恢复|救援入口|需要恢复|管理环境不可用/).first().waitFor({ timeout: 15000 });
    await page.screenshot({ path: join(output, 'manager-stopped-rescue.png') });
    pass('stopping the real manager keeps the already-open stable rescue page and API available');
    report.status = 'pass';
    report.scope = 'A product foundation only; full theme, maintenance, desktop and video acceptance still required';
  } catch (error) {
    report.status = 'fail';
    report.error = redact(error instanceof Error ? error.stack : error);
    if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (api) {
      try {
        const plan = await api('preview', { request: { kind: 'controller.shutdown' } });
        await api('submit', { command: { kind: 'plan.execute', planId: plan.id }, requestId: randomUUID() });
        await until(() => supervisor.exitCode !== null, 'supervisor clean shutdown', 15000);
      } catch { /* Owned test process tree cleanup below, never other Home processes. */ }
    }
    await browser?.close().catch(() => {});
    if (supervisor.exitCode === null) await stopOwned(supervisor);
    writeFileSync(join(output, 'supervisor.log'), redact(`${launchOutput}\n${stderr}`));
    report.finishedAt = new Date().toISOString();
    save();
  }
}

main().catch(error => {
  report.status = 'fail';
  report.error ||= redact(error.message);
  mkdirSync(output, { recursive: true });
  save();
  console.error(`FAIL ${redact(error.message)}`);
  process.exitCode = 1;
});
