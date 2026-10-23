import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SpaceMessageRouter } from '../../src/adapters/node/message-bus/router.ts';

const browserChild = fileURLToPath(new URL('../fixtures/browser-space-child.ts', import.meta.url));
const callerChild = fileURLToPath(new URL('../fixtures/space-message-child.ts', import.meta.url));

function query(child: ChildProcess, payload: Record<string, unknown>): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Browser bus query timed out')); }, 4000);
    const receive = (value: any): void => {
      if (value?.test !== 'result' || value.id !== id) return;
      clearTimeout(timer); child.off('message', receive); resolve(value);
    };
    child.on('message', receive);
    child.send({ test: 'request', id, target: 'browser', timeoutMs: 2000, ...payload });
  });
}

async function launch(file: string, env: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  const child = fork(file, [], { execArgv: ['--import', 'tsx'],
    env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', data => { stderr += String(data); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Browser child did not start: ${stderr}`)), 5000);
    const receive = (value: any): void => {
      if (value?.test === 'ready') { clearTimeout(timer); child.off('message', receive); resolve(); }
    };
    child.on('message', receive);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser child exited ${code}: ${stderr}`)); });
  });
  return child;
}

test('real Browser Host denies by default then exposes only authorized operations to one Space', async () => {
  const router = new SpaceMessageRouter();
  const children: ChildProcess[] = [];
  try {
    const caller = await launch(callerChild); children.push(caller); router.attach('coding', caller);
    const outsider = await launch(callerChild); children.push(outsider); router.attach('outsider', outsider);
    const denied = await launch(browserChild); children.push(denied); router.attach('browser', denied);
    assert.deepEqual((await query(caller, { test: 'capabilities' })).value, []);
    assert.equal((await query(caller, { operation: 'browser.openURL', params: { url: 'https://example.com' } })).error, 'unauthorized');
    const allowed = await launch(browserChild, { BROWSER_ALLOWED: 'coding',
      DSH_SPACES_SUPERVISOR_ORIGIN: 'http://127.0.0.1:6821' }); children.push(allowed); router.attach('browser', allowed);
    const capabilities = await query(caller, { test: 'capabilities' });
    assert.deepEqual(capabilities.value.map((item: { operation: string }) => item.operation), ['browser.listTabs', 'browser.openURL']);
    assert.deepEqual((await query(outsider, { test: 'capabilities' })).value, []);
    assert.equal((await query(outsider, { operation: 'browser.listTabs', params: null })).error, 'unauthorized');
    const opened = await query(caller, { operation: 'browser.openURL', params: { url: 'https://example.com' } });
    assert.equal(opened.ok, true); assert.equal(opened.value.url, 'https://example.com/');
    const listed = await query(caller, { operation: 'browser.listTabs', params: null });
    assert.deepEqual(listed.value.map((tab: { url: string | null }) => tab.url), [null, 'https://example.com/']);
    assert.equal((await query(caller, { operation: 'browser.openURL', params: { url: 'file:///etc/passwd' } })).error, 'operation-failed');
    for (const origin of ['http://127.0.0.1:6821', 'http://localhost:6821', 'http://127.0.0.1:4100']) {
      assert.equal((await query(caller, { operation: 'browser.openURL', params: { url: origin } })).error, 'operation-failed');
    }
    assert.equal((await query(caller, { operation: 'browser.openURL', params: { url: 'http://127.0.0.1:6822' } })).ok, true);
  } finally {
    router.close();
    await Promise.all(children.map(async child => { if (child.exitCode === null && child.signalCode === null) { const finished = once(child, 'exit'); child.kill(); await finished; } }));
  }
});
