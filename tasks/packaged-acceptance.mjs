import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bin, home } from './real-config-check.mjs';
import { ProfileRegistry } from '../src/main/profile-registry.ts';
import { writeSettings } from '../src/main/hub-settings.ts';
import { DEFAULT_HUB_SETTINGS } from '../src/shared/types.ts';
import { findNodeDir, toolchainRoot } from '../src/main/toolchain.ts';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = mkdtempSync(join(tmpdir(), 'spaces-packaged-check-'));
const tools = join(root, 'tools'); mkdirSync(tools);
symlinkSync(findNodeDir(), join(tools, 'node'), 'junction');
symlinkSync(join(toolchainRoot(), 'pnpm'), join(tools, 'pnpm'), 'junction');
new ProfileRegistry(home).markOnboarded();
writeSettings(home, { ...DEFAULT_HUB_SETTINGS, locale: 'en', portStart: 3240, portEnd: 3269 });
const env = { ...process.env, DSH_SPACES_HOME: home, DSH_SPACES_USER_DATA: join(root, 'app'),
  DSH_SPACES_TOOLCHAIN: tools, DSH_SPACES_CLI: resolve(dirname(bin), '../../../..'), DSH_SPACES_DISABLE_UPDATES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: resolve(process.env.DSH_TEST_PACKAGED_EXE || 'release/win-unpacked/DSH Spaces.exe'), args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], env, timeout: 120000 });
const page = await app.firstWindow();
await page.bringToFront();
try {
  await page.waitForFunction(async () => (await window.dshSpaces.getCliStatus()).state === 'ready', null, { timeout: 60000 });
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await page.evaluate(() => window.dshSpaces.getDshHome()), home);
  const state = await page.evaluate(() => window.dshSpaces.getMaintenance());
  assert.equal(state.error, undefined, 'packaged snapshot worker recovery must complete');
  await page.getByRole('button', { name: 'coding', exact: true }).click();
  await page.waitForFunction(async () => (await window.dshSpaces.listProfiles()).find(p => p.name === 'coding')?.status === 'running', null, { timeout: 60000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Versions and recovery', exact: true }).click();
  await page.getByRole('heading', { name: 'DSH runtime' }).waitFor();
  await page.screenshot({ path: resolve('tasks/artifacts/packaged-app.png') });
  await page.getByRole('button', { name: 'General', exact: true }).click();
  const closed = app.waitForEvent('close', { timeout: 20000 });
  await page.getByRole('button', { name: 'Quit', exact: true }).click({ noWaitAfter: true }).catch(error => {
    if (!String(error).includes('closed')) throw error;
  });
  await closed;
  console.log('PASS packaged Windows app: real preload/UI, unpacked snapshot worker, DSH startup and explicit Settings quit');
  console.log(`PACKAGED_TEST_ROOT=${root}`);
} catch (error) {
  console.log('Packaged UI:', await page.locator('body').innerText().catch(() => 'unavailable'));
  console.log('Packaged CLI:', await page.evaluate(() => window.dshSpaces.getCliStatus()).catch(() => 'unavailable'));
  console.log('Packaged maintenance:', await page.evaluate(() => window.dshSpaces.getMaintenance()).catch(() => 'unavailable'));
  await page.screenshot({ path: resolve('tasks/artifacts/packaged-failure.png') }).catch(() => {});
  throw error;
} finally { await app.close().catch(() => {}); }
