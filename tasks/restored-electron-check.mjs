import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const [home, root, sessionId] = process.argv.slice(2);
assert.ok(home && root && sessionId, 'Usage: restored-electron-check.mjs <temporary-home> <test-root> <original-session-id>');
for (const path of [home, root]) {
  const rel = relative(tmpdir(), path);
  assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('spaces-'));
}
const require = createRequire(import.meta.url);
const { _electron: electron } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const env = { ...process.env, DSH_SPACES_HOME: home, DSH_SPACES_TOOLCHAIN: join(root, 'tools'), DSH_SPACES_DISABLE_UPDATES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'),
  args: [join(root, 'bootstrap.cjs'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], env, timeout: 120000 });
let port;
try {
  const page = await app.firstWindow(); await page.bringToFront();
  const state = await page.evaluate(() => window.dshSpaces.getMaintenance());
  assert.ok(state.inventory.current.bin.includes('snapshots'));
  assert.equal(state.inventory.current.origin, 'snapshot');
  assert.equal(state.error, undefined); assert.equal(state.snapshots.length, 2);
  await page.getByRole('button', { name: 'coding', exact: true }).click();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const row = (await page.evaluate(() => window.dshSpaces.listProfiles())).find(p => p.name === 'coding');
    if (row.status === 'crashed') throw new Error(row.lastError);
    if (row.status === 'running' && Number.isInteger(row.port)) { port = row.port; break; }
    await delay(150);
  }
  assert.ok(port, 'restored space becomes ready');
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/api/session.list`, { method: 'POST', headers: { origin, 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'restored-acceptance', method: 'session.list', payload: {} }), signal: AbortSignal.timeout(10000) });
  const body = await response.json(); assert.ok(body.result.ok);
  assert.ok(body.result.value.items.some(row => row.sessionId === sessionId));
  console.log('PASS Electron relaunch: restored snapshot selected, two backups retained, UI starts original session offline');
  const closed = app.waitForEvent('close', { timeout: 20000 });
  await app.evaluate(({ app }) => app.quit()); await closed;
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1000) }));
  console.log('PASS explicit quit closes restored runtime port');
} finally { await app.close().catch(() => {}); }
