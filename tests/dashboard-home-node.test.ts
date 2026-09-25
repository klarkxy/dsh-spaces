import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, chmodSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HomeDashboard, type HomeDashboardStore } from '../src/core/domain/dashboard/home-backend.ts';
import { HomeDashboardFileStore } from '../src/adapters/node/dashboard/file-store.ts';
import { HomeDashboardInternalHttp, INTERNAL_PREFIX } from '../src/adapters/node/dashboard/internal-http.ts';
import { writeDashboardBootstrap } from '../src/adapters/node/dashboard/bootstrap.ts';
import { DashboardHomePublisher, readPublisherBootstrap } from '../packages/dashboard/src/host/home-publisher.ts';
import { DashboardFault } from '../src/core/domain/dashboard/errors.ts';
import type { SourceSummary } from '../src/shared/dashboard.ts';

function directory() { mkdirSync('.sandbox', { recursive: true }); return mkdtempSync(resolve('.sandbox/dashboard-home-node-')); }
function fixture() {
  const path = directory(); const sources: SourceSummary[] = ['a', 'b'].map(spaceId => ({ spaceId, title: spaceId, sourceState: 'running', publishing: 'disabled' }));
  const store = new HomeDashboardFileStore(join(path, 'home', '.spaces-dashboard', 'v1'), () => {});
  const hub = new HomeDashboard({ backendEpoch: randomUUID(), store, sources: () => sources, now: Date.now, newId: randomUUID, assertOwner: () => {}, assertRun: b => { if (!sources.some(s => s.spaceId === b.spaceId && s.sourceState === 'running')) throw new DashboardFault('dashboard/stale-run'); } });
  const client = hub.client(() => ({ subjectId: 'operator', layoutWrite: true, publicationsManage: true }));
  let origin = '', calls = 0;
  const internal = new HomeDashboardInternalHttp(hub, () => origin);
  const server = createServer((req, res) => { calls++; void internal.handle(req, res).then(handled => { if (!handled) { res.writeHead(401); res.end(); } }); });
  return { path, store, hub, client, sources, internal, get origin() { return origin; }, get calls() { return calls; }, async start() {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, async grant(spaceId = 'a', providerId = 'provider') {
    const policy = await hub.applyPublication({ kind: 'dashboard.publication.set', spaceId, providerId, expectedGrantRevision: 'absent', selection: { kind: 'all' } }, () => {});
    const issued = await internal.issue({ spaceId, generation: 1, runId: randomUUID() });
    const file = writeDashboardBootstrap(join(path, 'private'), issued.bootstrap, () => {});
    return { ...issued, file, policy };
  }, async close() { internal.close(); await hub.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(path, { recursive: true, force: true }); } };
}
async function wire(origin: string, path: string, bearer: string, body?: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((yes, no) => {
    const request = httpRequest(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra } }, response => {
      let text = ''; response.on('data', x => { text += x; }); response.on('end', () => { let body: unknown; try { body = JSON.parse(text); } catch { body = text; } yes({ status: response.statusCode!, body }); }); response.on('error', no);
    }); request.on('error', no); request.end(body);
  });
}
const data = { types: [{ typeId: 'metric', version: 1, title: 'Metric', kind: 'metric' as const }], instances: [{ instanceId: 'item', typeId: 'metric', typeVersion: 1, title: 'Secret title', content: { kind: 'metric' as const, value: 3, unit: '' }, sourceTarget: null, updatedAt: '2026-09-25T00:00:00Z', staleAfterSeconds: null }] };
const childMessage = (child: ChildProcess, predicate: (message: any) => boolean) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error('Child response deadline')); }, 10000);
  const listener = (message: any) => { if (predicate(message)) { cleanup(); resolve(message); } };
  const exit = () => { cleanup(); reject(new Error('Child exited before reply')); };
  const cleanup = () => { clearTimeout(timer); child.off('message', listener); child.off('exit', exit); };
  child.on('message', listener); child.once('exit', exit);
});
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('Child normal stop deadline')); }, 5000);
    child.once('exit', () => { clearTimeout(timer); yes(); }); child.send({ kind: 'close' });
  });
}

test('private store read does not create a Home directory or empty files', async () => {
  const path = directory(); try {
    const store = new HomeDashboardFileStore(join(path, 'new'), () => {});
    assert.equal(await store.readPolicies(), null); assert.equal(await store.readLayout(), null); assert.deepEqual(readdirSync(path), []); await store.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});
test('real file reopen retains approved projection and marks old run stale', async () => {
  const f = fixture(); await f.start(); try {
    const grant = await f.grant(); const publisher = await DashboardHomePublisher.open(grant.file.path);
    assert.equal((await publisher.forProvider('provider').publish(data)).state, 'published'); publisher.close(); grant.dispose(); await f.hub.close();
    const store = new HomeDashboardFileStore(f.store.root, () => {});
    const next = new HomeDashboard({ backendEpoch: 'new', store, now: Date.now, newId: randomUUID, sources: () => f.sources, assertOwner: () => {}, assertRun: () => {} });
    const result = await next.client(() => ({ subjectId: 'operator', layoutWrite: true, publicationsManage: true })).query({ kind: 'instances', refs: [{ spaceId: 'a', providerId: 'provider', instanceId: 'item' }] });
    if (result.data.kind !== 'instances' || result.data.items[0].state !== 'present') assert.fail();
    assert.equal(result.data.items[0].instance.content.kind, 'metric'); assert.equal(result.data.items[0].freshness, 'stale'); await next.close();
  } finally { await f.close(); }
});
test('malformed policy file is kept byte-for-byte, not repaired on read', async () => {
  const path = directory(); try {
    const root = join(path, 'store'); mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, 'policies.json'), '{broken', { mode: 0o600 });
    const store = new HomeDashboardFileStore(root, () => {}); await assert.rejects(store.readPolicies()); assert.equal(readFileSync(join(root, 'policies.json'), 'utf8'), '{broken'); await store.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});
test('symlink root, ancestor and leaf are rejected without touching target', async () => {
  const path = directory(); try {
    const target = join(path, 'target'); mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, 'sentinel'), 'keep');
    symlinkSync(target, join(path, 'link')); assert.throws(() => new HomeDashboardFileStore(join(path, 'link', 'child'), () => {}));
    const root = join(path, 'store'); mkdirSync(root, { mode: 0o700 }); symlinkSync(join(target, 'sentinel'), join(root, 'policies.json'));
    const store = new HomeDashboardFileStore(root, () => {}); await assert.rejects(store.readPolicies()); await assert.rejects(store.writePolicies({ schemaVersion: 1, policies: [] }));
    assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'keep'); await store.close();
  } finally { rmSync(path, { recursive: true, force: true }); }
});
test('bootstrap uses owner-only permissions and refuses broadened access or symlinks', async () => {
  const f = fixture(); await f.start(); try {
    const issued = await f.grant(); assert.equal(statSync(issued.file.path).mode & 0o777, 0o600); assert.equal(readPublisherBootstrap(issued.file.path).runId, issued.bootstrap.runId);
    const link = join(f.path, 'private', 'link'); symlinkSync(issued.file.path, link); assert.throws(() => readPublisherBootstrap(link));
    chmodSync(issued.file.path, 0o644); assert.throws(() => readPublisherBootstrap(issued.file.path)); chmodSync(issued.file.path, 0o600);
    issued.file.dispose(); issued.file.dispose();
  } finally { await f.close(); }
});
test('internal publisher endpoints reject browser origins, cookies, wrong bearers and hostile Host', async () => {
  const f = fixture(); await f.start(); try {
    const { bootstrap } = await f.grant();
    for (const headers of ([{ Origin: f.origin }, { Cookie: 'stolen=1' }, { Host: 'evil.invalid' }, { 'Sec-Fetch-Site': 'same-origin' }] as Array<Record<string, string>>)) {
      assert.equal((await wire(f.origin, INTERNAL_PREFIX + 'grant', bootstrap.bearer, undefined, headers)).status, 403);
    }
    assert.equal((await wire(f.origin, INTERNAL_PREFIX + 'grant', '0'.repeat(64))).status, 401);
    assert.equal((await wire(f.origin, '/api/dashboard/v1/query', bootstrap.bearer, '{}')).status, 401);
    assert.equal((await wire(f.origin, INTERNAL_PREFIX + 'grant', bootstrap.bearer)).status, 200);
  } finally { await f.close(); }
});
test('invalid wire JSON and forged space IDs never create a projection', async () => {
  const f = fixture(); await f.start(); try {
    const { bootstrap, policy } = await f.grant();
    assert.equal((await wire(f.origin, INTERNAL_PREFIX + 'publish', bootstrap.bearer, '{"a":1,"a":2}')).status, 400);
    const request = { protocolVersion: 1, runId: bootstrap.runId, providerId: 'provider', grantRevision: policy.revision, sequence: 1, ...data, spaceId: 'b' };
    assert.equal((await wire(f.origin, INTERNAL_PREFIX + 'publish', bootstrap.bearer, JSON.stringify(request))).status, 400);
    const response = await f.client.query({ kind: 'catalog' }); if (response.data.kind !== 'catalog') assert.fail(); assert.equal(response.data.entries.length, 0);
  } finally { await f.close(); }
});
test('real Node publishing is paced before transport timeout and never retries revoked runs', async () => {
  const f = fixture(); await f.start(); try {
    const grant = await f.grant(); const publisher = await DashboardHomePublisher.open(grant.file.path), provider = publisher.forProvider('provider');
    try {
      assert.equal((await provider.publish(data)).state, 'published');
      const start = Date.now(); assert.equal((await provider.publish(data)).state, 'published'); assert.ok(Date.now() - start >= 850);
      grant.dispose(); assert.equal((await provider.publish(data)).state, 'failed'); const count = f.calls;
      assert.equal((await provider.publish(data)).state, 'failed'); await new Promise(r => setTimeout(r, 1100)); assert.equal(f.calls, count);
    } finally { publisher.close(); }
  } finally { await f.close(); }
});
test('two independent background processes update the same Home with no iframe or frontend', async () => {
  const f = fixture(); await f.start(); const children: ChildProcess[] = []; try {
    const grants = await Promise.all([f.grant('a'), f.grant('b')]);
    for (const g of grants) {
      const child = fork(resolve('tests/fixtures/dashboard-home-child.ts'), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE: g.file.path }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
    }
    await Promise.all(children.map(c => childMessage(c, m => m.kind === 'ready')));
    const replies = children.map((child, i) => { const promise = childMessage(child, m => m.id === 'first'); child.send({ kind: 'publish', value: i + 4, id: 'first' }); return promise; });
    assert.deepEqual((await Promise.all(replies)).map(r => r.result.state), ['published', 'published']);
    const result = await f.client.query({ kind: 'instances', refs: ['a', 'b'].map(spaceId => ({ spaceId, providerId: 'provider', instanceId: 'item' })) });
    if (result.data.kind !== 'instances') assert.fail(); assert.deepEqual(result.data.items.map(i => i.state === 'present' && i.instance.content.kind === 'metric' ? i.instance.content.value : null), [4, 5]);
    await stopChild(children[0]); grants[0].dispose(); f.sources[0].sourceState = 'stopped';
    const again = childMessage(children[1], m => m.id === 'second'); children[1].send({ kind: 'publish', value: 9, id: 'second' }); assert.equal((await again).result.state, 'published');
    const offline = await f.client.query({ kind: 'instances', refs: [{ spaceId: 'a', providerId: 'provider', instanceId: 'item' }] });
    if (offline.data.kind !== 'instances' || offline.data.items[0].state !== 'present') assert.fail(); assert.equal(offline.data.items[0].freshness, 'stale');
    await f.hub.applyPublication({ kind: 'dashboard.publication.set', spaceId: 'a', providerId: 'provider', expectedGrantRevision: grants[0].policy.revision, selection: null }, () => {});
    const catalog = await f.client.query({ kind: 'catalog' }); if (catalog.data.kind !== 'catalog') assert.fail(); assert.equal(catalog.data.entries.length, 1);
  } finally { for (const child of children) await stopChild(child); await f.close(); }
});
