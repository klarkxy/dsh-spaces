import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createWorkbenchSupervisor } from '../src/adapters/node/workbench-supervisor.ts';
import { expectedAuthCookieName } from '../src/adapters/node/workbench-http.ts';
import type { PatchWriter } from '../src/adapters/node/patch-writer.ts';
function profile(home: string, id: string, manager = false) {
  const root = join(home, 'profiles', id); mkdirSync(root, { recursive: true });
  const packages = ['@deepseek-ai/dsh-web-app', manager ? '@dsh-spaces/plugin' : '@dsh-spaces/view-bridge'];
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(packages.map(p => [p, '0.2.0-rc.2'])), dsh: { profile: { bundles: packages } } }));
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: storage-json\n  config:\n    root: isolated\n');
}
function call(child: ChildProcess, data: Record<string, unknown>): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('fixture command timeout')); }, 5000);
    const receive = (m: any) => { if (m?.test === 'result' && m.id === id) { clearTimeout(timer); child.off('message', receive); resolve(m); } };
    child.on('message', receive); child.send({ ...data, id });
  });
}
test('real Supervisor launches two Cordis Space services, routes IPC, and disposes operation with its plugin', async () => {
  mkdirSync('.sandbox', { recursive: true }); const home = mkdtempSync(resolve('.sandbox/space-message-supervisor-'));
  const cli = join(home, 'cli'); mkdirSync(join(cli, 'lib'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }));
  writeFileSync(join(cli, 'lib', 'bin.js'), '');
  profile(home, 'alpha'); profile(home, 'beta');
  const children = new Map<string, ChildProcess>();
  const handle = await createWorkbenchSupervisor({
    home, bin: join(cli, 'lib', 'bin.js'), port: 0, portStart: 39000, portEnd: 41999,
    patchWriter: { verify: async () => {}, ensureWorkbenchPatch: () => {}, patchPath: (id: string) => join(home, 'profiles', id, 'cordis.patch.yml') } as unknown as PatchWriter,
    dumpConfig: async id => `- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${id}/storages')\n- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${id}/sessions')\n`,
    runCli: async args => { const id = args[args.indexOf('--profile') + 1]; if (args.includes('--from-default-profile')) profile(home, id, true); return { code: 0, stdout: '', stderr: '' }; },
    processRuntime: {
      prepareHome: async () => {}, pollMs: 20, readyTimeoutMs: 10000, gracefulWaitMs: 3000,
      spawn: (args, options) => {
        const id = args[args.indexOf('--profile') + 1], port = args[args.indexOf('--port') + 1];
        const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/space-message-supervisor-child.ts')], {
          ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, ...options.env, BUS_TEST_PORT: port, BUS_TEST_COOKIE: expectedAuthCookieName(`127.0.0.1:${port}`) },
        }); children.set(id, child); return child;
      }, kill: async pid => { process.kill(pid, 'SIGTERM'); },
    },
  });
  try {
    for (const id of ['alpha', 'beta']) {
      const state = await handle.runtime.state();
      const submitted = await handle.runtime.submit({ kind: 'space.start', spaceId: id }, randomUUID(), { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision });
      let job = submitted;
      while (job.status === 'running' || job.status === 'queued') { await sleep(20); job = await handle.runtime.job(job.id); }
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
    }
    const capabilities = await call(children.get('alpha')!, { test: 'capabilities', target: 'beta' });
    assert.deepEqual(capabilities.value, [{ operation: 'echo', description: 'Supervisor integration echo.' }]);
    assert.deepEqual((await call(children.get('beta')!, { test: 'capabilities', target: 'alpha' })).value, []);
    const result = await call(children.get('alpha')!, { test: 'request', target: 'beta', operation: 'echo', params: { value: 'actual-supervisor' } });
    assert.equal(result.ok, true); assert.deepEqual(result.value, { params: { value: 'actual-supervisor' }, caller: 'alpha' });
    const denied = await call(children.get('beta')!, { test: 'request', target: 'alpha', operation: 'echo', params: null });
    assert.equal(denied.error, 'unauthorized');
    await call(children.get('beta')!, { test: 'dispose-operation' });
    const disposed = await call(children.get('alpha')!, { test: 'request', target: 'beta', operation: 'echo', params: null });
    assert.equal(disposed.error, 'operation-not-found');
    assert.deepEqual((await call(children.get('alpha')!, { test: 'capabilities', target: 'beta' })).value, []);
  } finally {
    await handle.close();
    for (const child of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
