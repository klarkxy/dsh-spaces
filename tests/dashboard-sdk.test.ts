import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dashboardDomainSpec, DASHBOARD_DOMAIN_NAME, openDashboardDomainStore } from '../packages/dashboard/src/host/domain-store.ts';
import { LocalDashboard, type LocalDashboardDocument } from '../src/core/domain/dashboard/local-backend.ts';
import type { WidgetInstance } from '../src/shared/dashboard.ts';

// A missing SDK is a failed gate, never a skipped or fake-successful test.
const sdkRoot = process.env.DSH_DASHBOARD_SDK_ROOT;
if (!sdkRoot) throw new Error('Set DSH_DASHBOARD_SDK_ROOT to the explicitly installed CLI fixture');
const sdkRequire = createRequire(join(resolve(sdkRoot), 'package.json'));
const sdk = async (name: string) => import(pathToFileURL(sdkRequire.resolve(name)).href);
const { Context } = await sdk('@deepseek-ai/cordis');
const { Storage } = await sdk('@deepseek-ai/dsh-storage');
const { JsonStorageBackend } = await sdk('@deepseek-ai/dsh-storage-json');
const { DomainFacility, defineDomain } = await sdk('@deepseek-ai/dsh-storage-domain');

async function fixture() {
  await mkdir('.sandbox', { recursive: true });
  const root = await mkdtemp(resolve('.sandbox/dashboard-storage-'));
  const directory = join(root, 'named-profile', 'storages');
  const backend = new JsonStorageBackend(directory);
  const ctx = new Context();
  await ctx.plugin(Storage);
  const unbind = ctx.storage.backend.register('dashboard-test-json', backend);
  const facility = new DomainFacility(ctx, { backend: 'dashboard-test-json' });
  return { root, directory, ctx, backend, facility, file: join(directory, `${DASHBOARD_DOMAIN_NAME}.json`), async close() {
    await facility.closeAll(); unbind(); await backend.close();
    // Only this invocation's private mkdtemp tree is removed.
    await rm(root, { recursive: true, force: true });
  } };
}
function makeService(store: Awaited<ReturnType<typeof openDashboardDomainStore>>, epoch = 'sdk-run-1') {
  let next = 0;
  return new LocalDashboard({ spaceId: 'named-profile', title: 'SDK fixture', backendEpoch: epoch,
    now: () => Date.parse('2026-09-25T00:00:00Z'), newId: () => `${epoch}-${++next}`, store });
}
function widget(): WidgetInstance {
  return { instanceId: 'chapters', typeId: 'writing', typeVersion: 1, title: 'Writing progress', content: { kind: 'progress', value: 3, max: 10, unit: 'chapters', status: 'running' }, sourceTarget: { kind: 'space' }, updatedAt: '2026-09-25T00:00:00Z', staleAfterSeconds: 30 };
}

test('official domain accepts the fixed single-file declaration and rejects nullable globals', () => {
  assert.equal(defineDomain(dashboardDomainSpec()).layout, 'single');
  assert.equal(dashboardDomainSpec().global.schema.safeParse(null).success, false);
});
test('real Cordis optional lookup leaves an unrelated business plugin usable', async () => {
  const ctx = new Context();
  let ran = false;
  await ctx.plugin({ name: 'dashboard-optional-fixture', apply(plugin: typeof ctx) {
    assert.equal(plugin.get('dashboardProvider', false), undefined);
    ran = true;
  } });
  assert.equal(ran, true);
});
test('official domain open plus readonly dashboard does not materialize files', async () => {
  const f = await fixture();
  try {
    const store = await openDashboardDomainStore(f.facility);
    const service = makeService(store);
    const response = await service.client(() => ({ subjectId: 'user', layoutWrite: true })).query({ kind: 'overview' });
    assert.equal(response.data.kind, 'overview');
    await assert.rejects(readFile(f.file), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.root), []);
    await service.close();
  } finally { await f.close(); }
});
test('real disk reopen retains projections, placements and request receipts together', async () => {
  const f = await fixture();
  try {
    const sentinel = join(f.root, 'unrelated.txt'); await writeFile(sentinel, 'untouched');
    const service = makeService(await openDashboardDomainStore(f.facility));
    const client = service.client(() => ({ subjectId: 'user', layoutWrite: true }));
    const provider = service.bindProvider('writer').register({ types: [{ typeId: 'writing', version: 1, kind: 'progress', title: 'Writing' }], snapshot: () => [widget()] });
    await provider.publish();
    const ref = { spaceId: 'named-profile', providerId: 'writer', instanceId: 'chapters' };
    const receipt = await client.mutate({ requestId: 'pin', backendEpoch: 'sdk-run-1', issuedAt: '2026-09-25T00:00:00Z', command: { kind: 'board.create', boardId: 'home', title: 'Home', placements: [{ id: 'p1', ref, x: 0, y: 0, w: 6, h: 2 }] } });
    assert.equal(receipt.result.kind, 'board.saved');
    const disk = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(disk.global.layout.receipts.length, 1); assert.equal(disk.global.providers.length, 1);
    await service.close();
    const reopened = makeService(await openDashboardDomainStore(f.facility), 'sdk-run-2');
    const second = reopened.client(() => ({ subjectId: 'user', layoutWrite: true }));
    const saved = await second.query({ kind: 'receipt', requestId: 'pin' });
    assert.equal(saved.data.kind, 'receipt'); if (saved.data.kind === 'receipt') assert.deepEqual(saved.data.receipt, receipt);
    const read = await second.query({ kind: 'instances', refs: [ref] });
    assert.equal(read.data.kind, 'instances'); if (read.data.kind === 'instances') { const item = read.data.items[0]; assert.equal(item.state, 'present'); if (item.state === 'present') assert.equal(item.freshness, 'stale'); }
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
    await reopened.close();
  } finally { await f.close(); }
});
test('official facility refuses a duplicate writer instead of opening a second copy', async () => {
  const f = await fixture();
  try {
    const first = await openDashboardDomainStore(f.facility);
    await assert.rejects(openDashboardDomainStore(f.facility), { code: 'already-open' });
    await first.close();
  } finally { await f.close(); }
});
test('malformed official storage file stays unchanged and is not treated as empty', async () => {
  const f = await fixture();
  try {
    await mkdir(f.directory, { recursive: true }); await writeFile(f.file, '{broken evidence');
    await assert.rejects(openDashboardDomainStore(f.facility));
    assert.equal(await readFile(f.file, 'utf8'), '{broken evidence');
    assert.deepEqual(await readdir(f.directory), [`${DASHBOARD_DOMAIN_NAME}.json`]);
  } finally { await f.close(); }
});
test('valid medium with invalid dashboard state fails schema validation, without repair', async () => {
  const f = await fixture();
  try {
    const raw = await f.backend.kv.open({ name: DASHBOARD_DOMAIN_NAME, version: 1, tables: [], hasGlobal: true, layout: 'single' });
    await raw.setGlobal({ schemaVersion: 1, layout: {}, providers: [] }); await raw.close();
    const original = await readFile(f.file, 'utf8');
    await assert.rejects(openDashboardDomainStore(f.facility), { code: 'invalid-record' });
    assert.equal(await readFile(f.file, 'utf8'), original);
  } finally { await f.close(); }
});
test('foreign unit version is rejected without migration or switching backend', async () => {
  const f = await fixture();
  try {
    const raw = await f.backend.kv.open({ name: DASHBOARD_DOMAIN_NAME, version: 99, tables: [], hasGlobal: true, layout: 'single' });
    await raw.setGlobal(dashboardDomainSpec().global.initial); await raw.close();
    const original = await readFile(f.file, 'utf8');
    await assert.rejects(openDashboardDomainStore(f.facility), { code: 'version-mismatch' });
    assert.equal(await readFile(f.file, 'utf8'), original);
  } finally { await f.close(); }
});
test('adapter validates writes before reaching the official durable store', async () => {
  const f = await fixture();
  try {
    const store = await openDashboardDomainStore(f.facility);
    await assert.rejects(store.write({ schemaVersion: 1, layout: {}, providers: [] } as unknown as LocalDashboardDocument));
    await assert.rejects(readFile(f.file), { code: 'ENOENT' });
    await store.close(); await assert.rejects(store.read(), /dashboard\/unavailable/);
  } finally { await f.close(); }
});
