import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkbenchSupervisor, type WorkbenchSupervisorHandle } from '../src/adapters/node/workbench-supervisor.ts';
import { expectedAuthCookieName } from '../src/adapters/node/workbench-http.ts';
import { HomeOperationLock } from '../src/adapters/node/home-operation-lock.ts';
import type { PatchWriter } from '../src/adapters/node/patch-writer.ts';
import type { WorkbenchPlanRequest } from '../src/shared/workbench.ts';

function profile(home: string, id: string, dashboard = false, manager = false) {
  const root = join(home, 'profiles', id); mkdirSync(root, { recursive: true });
  const packages = ['@deepseek-ai/dsh-web-app', ...(manager ? ['@dsh-spaces/plugin'] : []), ...(dashboard ? ['@dsh-spaces/dashboard'] : [])];
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(packages.map(p => [p, '0.1.7-alpha.1'])), dsh: { profile: { bundles: packages } } }));
  writeFileSync(join(root, 'cordis.patch.yml'), '- id: storage-json\n  config:\n    root: isolated\n');
}
async function setup() {
  mkdirSync('.sandbox', { recursive: true }); const home = mkdtempSync(resolve('.sandbox/dashboard-supervisor-'));
  const cli = join(home, 'cli'); mkdirSync(join(cli, 'lib'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-alpha.1' }));
  writeFileSync(join(cli, 'lib', 'bin.js'), '');
  profile(home, 'a', true); profile(home, 'b', true); profile(home, 'plain');
  const children = new Map<string, ChildProcess>(), paths = new Map<string, string | undefined>();
  let failSpawn = false, cleanupWasBeforeKill = true, clock = Date.now();
  const handle = await createWorkbenchSupervisor({
    home, bin: join(cli, 'lib', 'bin.js'), port: 0, portStart: 36000, portEnd: 38999,
    now: () => new Date(clock),
    patchWriter: { verify: async () => {}, ensureWorkbenchPatch: () => {}, patchPath: (id: string) => join(home, 'profiles', id, 'cordis.patch.yml') } as unknown as PatchWriter,
    dumpConfig: async id => `- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${id}/storages')\n- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${id}/sessions')\n`,
    runCli: async args => { const id = args[args.indexOf('--profile') + 1]; if (args.includes('--from-default-profile')) profile(home, id, false, true); return { code: 0, stdout: '', stderr: '' }; },
    processRuntime: {
      prepareHome: async () => {}, pollMs: 20, readyTimeoutMs: 10000, gracefulWaitMs: 3000,
      spawn: (args, options) => {
        const id = args[args.indexOf('--profile') + 1], port = args[args.indexOf('--port') + 1];
        paths.set(id, options.env?.DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE);
        if (failSpawn && id === 'a') throw new Error('intentional launch failure');
        const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/dashboard-supervisor-child.ts')], {
          ...options, env: { ...process.env, ...options.env, DASHBOARD_TEST_PORT: port, DASHBOARD_TEST_COOKIE: expectedAuthCookieName(`127.0.0.1:${port}`) },
        }); children.set(id, child); return child;
      },
      kill: async pid => {
        const id = [...children].find(([, child]) => child.pid === pid)?.[0];
        if (id && paths.get(id)) cleanupWasBeforeKill &&= !existsSync(paths.get(id)!);
        process.kill(pid, 'SIGTERM');
      },
    },
  });
  const login = await fetch(handle.bootstrapUrl, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(x => x.split(';')[0]).join('; '); await login.body?.cancel(); assert.equal(login.status, 303);
  const context = async () => { const state = await handle.runtime.state(); return { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision }; };
  async function post(path: string, input: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(handle.origin + path, { method: 'POST', headers: { Origin: handle.origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-DSH-Dashboard': '1', ...headers }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  }
  async function management(method: string, payload: unknown) { return post('/api/workbench/' + method, payload); }
  async function finish(id: string) {
    for (let n = 0; n < 250; n++) { const job = await handle.runtime.job(id); if (job.status === 'succeeded' || job.status === 'failed') return job; await sleep(20); }
    throw new Error('Job did not finish');
  }
  async function command(value: any) {
    const submitted = await management('submit', { command: value, requestId: randomUUID(), context: await context() });
    assert.equal(submitted.body.ok, true, JSON.stringify(submitted.body)); return finish(submitted.body.value.id);
  }
  async function preview(request: WorkbenchPlanRequest) {
    const result = await management('preview', { request, context: await context() }); assert.equal(result.body.ok, true, JSON.stringify(result.body)); return result.body.value;
  }
  async function plan(request: WorkbenchPlanRequest) { const p = await preview(request); return command({ kind: 'plan.execute', planId: p.id }); }
  const query = async (value: any) => { const result = await post('/api/dashboard/v1/query', value); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data; };
  const grant = async (id = 'a', revision = 'absent', selection: any = { kind: 'all' }, providerId = 'test-provider') => plan({ kind: 'dashboard.publication.set', spaceId: id, providerId, expectedGrantRevision: revision, selection });
  return { handle, home, children, paths, post, management, context, command, preview, plan, query, grant,
    fail: () => { failSpawn = true; }, advance: (ms: number) => { clock += ms; }, get cleanupWasBeforeKill() { return cleanupWasBeforeKill; }, async close() {
      await handle.close();
      for (const c of children.values()) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
      rmSync(home, { recursive: true, force: true });
    },
  };
}
async function rejectedRequest(f: Awaited<ReturnType<typeof setup>>, request: unknown) {
  const r = await f.management('preview', { request, context: await f.context() }); assert.equal(r.body.ok, false); return r.body.error;
}

test('real Supervisor mounts Home endpoints and uses its own operator cookie only', async () => {
  const f = await setup(); try {
    const overview = await f.query({ kind: 'overview' }); assert.equal(overview.mode, 'home'); assert.equal(overview.capabilities.publicationsManage, true);
    assert.equal(existsSync(join(f.home, '.spaces-dashboard')), false, 'a read must not create persistent files');
    assert.equal((await f.post('/api/dashboard/v1/query', { kind: 'overview' }, { Cookie: '' })).status, 401);
    const endpoint = JSON.parse(readFileSync(join(f.home, '.dsh-spaces-control', 'endpoint.json'), 'utf8'));
    assert.equal((await f.post('/api/dashboard/v1/query', { kind: 'overview' }, { Cookie: '', Authorization: `Bearer ${endpoint.bearer}` })).status, 401);
    assert.equal((await f.post('/api/dashboard/v1/query', { kind: 'overview' }, { Origin: 'http://127.0.0.1:12345' })).status, 403);
  } finally { await f.close(); }
});
test('publication uses preview and persisted plan.execute; it never starts or installs a space', async () => {
  const f = await setup(); try {
    const before = f.children.size; const p = await f.preview({ kind: 'dashboard.publication.set', spaceId: 'a', providerId: 'test-provider', expectedGrantRevision: 'absent', selection: { kind: 'all' } });
    assert.equal(existsSync(join(f.home, '.spaces-dashboard', 'v1', 'policies.json')), false);
    assert.match(p.changes.join(' '), /No plugin installation/);
    const job = await f.command({ kind: 'plan.execute', planId: p.id }); assert.equal(job.status, 'succeeded', JSON.stringify(job));
    assert.equal(f.children.size, before); assert.equal((await f.query({ kind: 'publications', spaceId: 'a' })).policies[0].pendingStart, true);
    assert.equal((await f.command({ kind: 'plan.execute', planId: p.id })).status, 'failed');
    assert.equal((await f.post('/api/dashboard/v1/commands', { ...p, kind: 'dashboard.publication.set' })).status, 400);
  } finally { await f.close(); }
});
test('protected profiles, unknown fields, old grant and foreign epoch cannot authorize publication', async () => {
  const f = await setup(); try {
    const input = { kind: 'dashboard.publication.set', spaceId: 'a', providerId: 'test-provider', expectedGrantRevision: 'absent', selection: { kind: 'all' } };
    await rejectedRequest(f, { ...input, spaceId: 'web' });
    await rejectedRequest(f, { ...input, spaceId: (await f.handle.runtime.state()).managerId });
    await rejectedRequest(f, { ...input, bearer: 'not-a-permission' });
    await rejectedRequest(f, { ...input, expectedGrantRevision: 'old' });
    const result = await f.management('preview', { request: input, context: { ...(await f.context()), serviceEpoch: '0'.repeat(64) } });
    assert.equal(result.body.ok, false); assert.equal(existsSync(join(f.home, '.spaces-dashboard')), false);
  } finally { await f.close(); }
});
test('two plans based on one grant revision cannot both commit', async () => {
  const f = await setup(); try {
    const input = { kind: 'dashboard.publication.set' as const, spaceId: 'a', providerId: 'test-provider', expectedGrantRevision: 'absent', selection: { kind: 'all' as const } };
    const a = await f.preview(input), b = await f.preview(input);
    assert.equal((await f.command({ kind: 'plan.execute', planId: a.id })).status, 'succeeded');
    assert.equal((await f.command({ kind: 'plan.execute', planId: b.id })).status, 'failed');
  } finally { await f.close(); }
});
test('owned launches get separate private files and manager/plain spaces get no bootstrap', async () => {
  const f = await setup(); try {
    assert.equal((await f.grant()).status, 'succeeded'); assert.equal((await f.grant('b')).status, 'succeeded');
    for (const id of ['a', 'b', 'plain']) assert.equal((await f.command({ kind: 'space.start', spaceId: id })).status, 'succeeded');
    const a = f.paths.get('a')!, b = f.paths.get('b')!; assert.ok(a && b && a !== b); assert.ok(existsSync(a));
    assert.equal(f.paths.get('plain'), undefined); assert.equal(f.paths.get((await f.handle.runtime.state()).managerId!), undefined);
    assert.equal((await f.query({ kind: 'catalog' })).entries.length, 2);
  } finally { await f.close(); }
});
test('stop invalidates run before SIGTERM, retains approved result and does not affect another space', async () => {
  const f = await setup(); try {
    for (const id of ['a', 'b']) { await f.grant(id); assert.equal((await f.command({ kind: 'space.start', spaceId: id })).status, 'succeeded'); }
    const bootstrap = JSON.parse(readFileSync(f.paths.get('a')!, 'utf8')); const bPid = f.children.get('b')!.pid;
    assert.equal((await f.plan({ kind: 'space.stop', spaceId: 'a' })).status, 'succeeded');
    assert.equal(f.cleanupWasBeforeKill, true); assert.equal(existsSync(f.paths.get('a')!), false);
    const stale = await fetch(f.handle.origin + '/internal/dashboard/v1/grant', { headers: { Authorization: `Bearer ${bootstrap.bearer}` } }); assert.equal(stale.status, 401); await stale.body?.cancel();
    assert.equal(f.children.get('b')!.pid, bPid);
    const items = (await f.query({ kind: 'instances', refs: ['a','b'].map(spaceId => ({ spaceId, providerId: 'test-provider', instanceId: 'item' })) })).items;
    assert.equal(items[0].freshness, 'stale'); assert.equal(items[1].freshness, 'current');
  } finally { await f.close(); }
});
test('spontaneous owned process exit invalidates the private capability without waiting for heartbeat', async () => {
  const f = await setup(); try {
    await f.grant(); await f.command({ kind: 'space.start', spaceId: 'a' }); const path = f.paths.get('a')!; const child = f.children.get('a')!;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited;
    assert.equal(existsSync(path), false); assert.equal((await f.query({ kind: 'instances', refs: [{ spaceId: 'a', providerId: 'test-provider', instanceId: 'item' }] })).items[0].freshness, 'stale');
  } finally { await f.close(); }
});
test('failed spawn invalidates only that new handoff and does not replay the launch', async () => {
  const f = await setup(); try {
    await f.grant(); f.fail(); const job = await f.command({ kind: 'space.start', spaceId: 'a' }); assert.equal(job.status, 'failed');
    assert.ok(f.paths.get('a')); assert.equal(existsSync(f.paths.get('a')!), false); assert.deepEqual(readdirSync(join(f.home, '.spaces-dashboard', 'private')), []);
    assert.equal(f.children.has('a'), false); await f.query({ kind: 'overview' }); assert.equal(f.children.has('a'), false);
  } finally { await f.close(); }
});
test('revocation plan hides live source without restarting or stopping its process', async () => {
  const f = await setup(); try {
    await f.grant(); await f.command({ kind: 'space.start', spaceId: 'a' }); const pid = f.children.get('a')!.pid;
    const revision = (await f.query({ kind: 'publications', spaceId: 'a' })).policies[0].revision;
    assert.equal((await f.grant('a', revision, null)).status, 'succeeded');
    assert.equal((await f.query({ kind: 'catalog' })).entries.length, 0); assert.equal(f.children.get('a')!.pid, pid); assert.equal(f.children.get('a')!.exitCode, null);
  } finally { await f.close(); }
});
test('space deletion revokes all source grants before deleting profile data', async () => {
  const f = await setup(); try {
    await f.grant(); await f.grant('a', 'absent', { kind: 'all' }, 'second-provider'); await f.command({ kind: 'space.start', spaceId: 'a' });
    const result = await f.plan({ kind: 'space.delete', spaceId: 'a', removeData: false }); assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(existsSync(join(f.home, 'profiles', 'a')), false); const policies = JSON.parse(readFileSync(join(f.home, '.spaces-dashboard', 'v1', 'policies.json'), 'utf8'));
    assert.equal(policies.policies.length, 2); assert.ok(policies.policies.every((p: any) => p.selection === null));
    assert.equal((await f.query({ kind: 'catalog' })).entries.length, 0);
  } finally { await f.close(); }
});
test('expired or generation-stale plans fail instead of being replayed', async () => {
  const f = await setup(); try {
    const input = { kind: 'dashboard.publication.set' as const, spaceId: 'plain', providerId: 'test-provider', expectedGrantRevision: 'absent', selection: { kind: 'all' as const } };
    const stale = await f.preview(input); await f.command({ kind: 'space.start', spaceId: 'plain' });
    assert.equal((await f.command({ kind: 'plan.execute', planId: stale.id })).status, 'failed');
    const expired = await f.preview(input); f.advance(360000); assert.equal((await f.command({ kind: 'plan.execute', planId: expired.id })).status, 'failed');
  } finally { await f.close(); }
});
test('foreign Home mutation lock and maintenance evidence refuse authorization writes', async () => {
  const f = await setup(); try {
    const input = { kind: 'dashboard.publication.set', spaceId: 'a', providerId: 'test-provider', expectedGrantRevision: 'absent', selection: { kind: 'all' } };
    const lock = new HomeOperationLock(f.home); await lock.run('test-owner', async () => { await rejectedRequest(f, input); });
    const evidence = join(f.home, '.dsh-spaces-mutation.json'); writeFileSync(evidence, '{}'); await rejectedRequest(f, input); rmSync(evidence);
    assert.equal(existsSync(join(f.home, '.spaces-dashboard', 'v1', 'policies.json')), false);
  } finally { await f.close(); }
});


test('parent bootstrap paths cannot leak into manager or unapproved space launches', async () => {
  const key = 'DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE';
  const previous = process.env[key];
  process.env[key] = resolve('.sandbox/unowned-parent-bootstrap-must-not-be-read.json');
  let f: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    f = await setup();
    const state = await f.handle.runtime.state();
    assert.equal(state.writable, true, JSON.stringify(state));
    assert.equal(f.paths.get(state.managerId!), undefined);
    assert.equal((await f.command({ kind: 'space.start', spaceId: 'plain' })).status, 'succeeded');
    assert.equal(f.paths.get('plain'), undefined);
    assert.equal(existsSync(join(f.home, '.spaces-dashboard', 'private')), false);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    await f?.close();
  }
});
