import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeDashboard, type HomeDashboardStore, type HomeReader, type HomeRunPublisher } from '../src/core/domain/dashboard/home-backend.ts';
import { DashboardFault } from '../src/core/domain/dashboard/errors.ts';
import type { PublicationSelection, SourceSummary } from '../src/shared/dashboard.ts';
const clone = <T>(v: T): T => structuredClone(v);
const baseTime = Date.parse('2026-09-25T00:00:00Z');
const ref = (spaceId = 'a', instanceId = 'item') => ({ spaceId, providerId: 'provider', instanceId });
function snapshot(value = 1, ids = ['item']) {
  return { types: [{ typeId: 'metric', version: 1, kind: 'metric', title: 'Metric' }], instances: ids.map(instanceId => ({ instanceId, typeId: 'metric', typeVersion: 1, title: `Secret ${instanceId}`, content: { kind: 'metric', value, unit: '' }, sourceTarget: { kind: 'space' }, updatedAt: new Date(baseTime).toISOString(), staleAfterSeconds: 30 })) };
}
function memory() {
  let policies: unknown | null = null, layout: unknown | null = null;
  const projections = new Map<string, unknown>(), counts = { policy: 0, layout: 0, projection: 0, read: 0, remove: 0 };
  let failRemove = false, failPolicy = false, failLayout = false, barrier: (() => Promise<void>) | null = null;
  const key = (space: string, provider: string) => JSON.stringify([space, provider]);
  const store: HomeDashboardStore = {
    readPolicies: async () => clone(policies), writePolicies: async value => { counts.policy++; if (failPolicy) throw new Error('private'); policies = clone(value); },
    readLayout: async () => clone(layout), writeLayout: async value => { counts.layout++; if (failLayout) throw new Error('private'); layout = clone(value); },
    readProjection: async (space, provider) => { counts.read++; return clone(projections.get(key(space, provider)) ?? null); },
    writeProjection: async value => { counts.projection++; await barrier?.(); projections.set(key(value.spaceId, value.request.providerId), clone(value)); },
    deleteProjection: async (space, provider) => { counts.remove++; if (failRemove) throw new Error('unlink failed'); projections.delete(key(space, provider)); },
    close: async () => {},
  };
  return { store, counts, projections, corrupt: (value: unknown) => { policies = value; },
    failRemove: () => { failRemove = true; }, failPolicy: () => { failPolicy = true; }, failLayout: () => { failLayout = true; },
    barrier: (fn: () => Promise<void>) => { barrier = fn; } };
}
function fixture(m = memory(), epoch = 'epoch') {
  let now = baseTime, next = 0, owner = true;
  let reader: HomeReader | null = { subjectId: 'operator', layoutWrite: true, publicationsManage: true };
  const sources: SourceSummary[] = ['a', 'b'].map(spaceId => ({ spaceId, title: spaceId, sourceState: 'running', publishing: 'disabled' }));
  const generations = new Map([['a', 1], ['b', 1]]);
  const hub = new HomeDashboard({ backendEpoch: epoch, store: m.store, now: () => now, newId: () => `${epoch}-${++next}`,
    sources: () => sources, assertOwner: () => { if (!owner) throw new DashboardFault('dashboard/forbidden'); },
    assertRun: b => { if (generations.get(b.spaceId) !== b.generation) throw new DashboardFault('dashboard/stale-run'); } });
  const auth = () => reader;
  const client = hub.client(auth);
  const query = async (value: any): Promise<any> => (await client.query(value)).data;
  const policies = new Map<string, string>();
  const set = async (spaceId: string, selection: PublicationSelection | null = { kind: 'all' }, providerId = 'provider') => {
    const k = spaceId + providerId;
    const result = await hub.applyPublication({ kind: 'dashboard.publication.set', spaceId, providerId, selection, expectedGrantRevision: policies.get(k) ?? 'absent' }, () => {});
    policies.set(k, result.revision); return result;
  };
  const begin = (spaceId = 'a', id = 'run-' + spaceId) => hub.beginRun({ spaceId, runId: id, generation: generations.get(spaceId)! });
  const request = (spaceId = 'a', sequence = 1, value = 1) => ({ protocolVersion: 1, runId: 'run-' + spaceId, providerId: 'provider', grantRevision: policies.get(spaceId + 'provider')!, sequence, ...snapshot(value) });
  const mutation = (requestId = 'pin', command?: any) => ({ requestId, backendEpoch: epoch, issuedAt: new Date(now).toISOString(), command: command ?? { kind: 'board.create', boardId: 'home', title: 'My board', placements: [{ id: 'p', ref: ref(), x: 0, y: 0, w: 6, h: 2 }] } });
  return { hub, client, query, auth, m, sources, generations, set, begin, request, mutation,
    advance: (ms = 1000) => { now += ms; }, deny: () => { reader = null; }, readOnly: () => { reader = { subjectId: 'reader', layoutWrite: false, publicationsManage: false }; }, loseOwner: () => { owner = false; } };
}
async function rejects(promise: Promise<unknown>, suffix: string) { await assert.rejects(promise, (e: any) => e.code === 'dashboard/' + suffix); }

test('Home empty reads never create policies, layout or source records', async () => {
  const f = fixture(); assert.equal((await f.query({ kind: 'overview' })).mode, 'home');
  assert.deepEqual((await f.query({ kind: 'catalog' })).entries, []); assert.equal((await f.query({ kind: 'board', boardId: 'home' })).board, null);
  assert.deepEqual(f.m.counts, { policy: 0, layout: 0, projection: 0, read: 0, remove: 0 }); await f.hub.close();
});
test('no grant means no publication, even with a legitimate run handle', async () => {
  const f = fixture(), run = await f.begin(); assert.deepEqual((await run.grant()).grants, []);
  await rejects(run.publish({ ...f.request(), grantRevision: 'invented' }), 'stale-grant'); assert.equal(f.m.counts.projection, 0); await f.hub.close();
});
test('publication management requires an admitted existing plan and current grant CAS', async () => {
  const f = fixture(); const input = { kind: 'dashboard.publication.set' as const, spaceId: 'a', providerId: 'provider', expectedGrantRevision: 'absent', selection: { kind: 'all' as const } };
  await rejects(f.hub.applyPublication(input, () => { throw new DashboardFault('dashboard/forbidden'); }), 'forbidden');
  assert.equal(f.m.counts.policy, 0); const policy = await f.set('a'); assert.equal(policy.pendingStart, true);
  await rejects(f.hub.applyPublication(input, () => {}), 'revision-conflict'); await f.hub.close();
});
test('expanding policy does not refresh an existing run or start a process', async () => {
  const f = fixture(); const old = await f.begin(); await f.set('a');
  assert.deepEqual((await old.grant()).grants, []); await rejects(old.publish(f.request()), 'stale-grant');
  old.close(); const next = await f.begin('a', 'new-run'); const grant = await next.grant(); assert.equal(grant.grants.length, 1);
  await next.publish({ ...f.request(), runId: 'new-run' }); assert.equal((await f.query({ kind: 'catalog' })).entries.length, 1); await f.hub.close();
});
test('two background spaces publish independently into one Home', async () => {
  const f = fixture(); await f.set('a'); await f.set('b'); const a = await f.begin('a'), b = await f.begin('b');
  await Promise.all([a.publish(f.request('a', 1, 3)), b.publish(f.request('b', 1, 7))]);
  const result = await f.query({ kind: 'instances', refs: [ref('b'), ref('a')] });
  assert.deepEqual(result.items.map((x: any) => x.instance.content.value), [7, 3]);
  assert.equal((await f.query({ kind: 'catalog', spaceIds: [] })).entries.length, 0); await f.hub.close();
});
test('stopped source keeps approved last result while another source continues', async () => {
  const f = fixture(); await f.set('a'); await f.set('b'); const a = await f.begin('a'), b = await f.begin('b');
  await a.publish(f.request()); await b.publish(f.request('b')); a.close(); f.sources[0].sourceState = 'stopped'; f.advance(); await b.publish(f.request('b', 2, 8));
  const items = (await f.query({ kind: 'instances', refs: [ref(), ref('b')] })).items;
  assert.equal(items[0].state, 'present'); assert.equal(items[0].freshness, 'stale'); assert.equal(items[0].sourceState, 'stopped'); assert.equal(items[1].instance.content.value, 8); await f.hub.close();
});
test('publish bodies cannot impersonate another space, provider or generation', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin();
  await rejects(run.publish({ ...f.request(), spaceId: 'b' }), 'invalid-input');
  await rejects(run.publish({ ...f.request(), providerId: 'other' }), 'stale-grant');
  await rejects(run.publish({ ...f.request(), runId: 'other' }), 'stale-run'); assert.equal(f.m.counts.projection, 0); await f.hub.close();
});
test('identical sequence returns original ack without refreshing timestamps or writing', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); const ack = await run.publish(f.request()); f.advance();
  assert.deepEqual(await run.publish(f.request()), ack); assert.equal(f.m.counts.projection, 1); await f.hub.close();
});
test('out-of-order or conflicting sequence cannot overwrite committed data', async () => {
  for (const [sequence, value, error] of [[1, 9, 'sequence-conflict'], [0, 1, 'invalid-input']] as const) {
    const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish(f.request()); f.advance();
    await rejects(run.publish(f.request('a', sequence, value)), error); assert.equal((await f.query({ kind: 'instances', refs: [ref()] })).items[0].instance.content.value, 1); await f.hub.close();
  }
});
test('old credential run cannot publish after normal stop and replacement', async () => {
  const f = fixture(); await f.set('a'); const old = await f.begin(); await old.publish(f.request()); old.close(); f.generations.set('a', 2);
  const next = await f.begin('a', 'new-run'); await next.publish({ ...f.request('a', 1, 9), runId: 'new-run' });
  await rejects(old.publish(f.request('a', 2)), 'stale-run'); assert.equal((await f.query({ kind: 'instances', refs: [ref()] })).items[0].instance.content.value, 9); await f.hub.close();
});
test('selection is enforced on whole snapshots and unselected type data never enters Home', async () => {
  const f = fixture(); await f.set('a', { kind: 'selected', instanceIds: ['item'] }); const run = await f.begin();
  await rejects(run.publish({ ...f.request(), ...snapshot(1, ['item', 'other']) }), 'forbidden'); assert.equal(f.m.counts.projection, 0); await f.hub.close();
});
test('heartbeat is not a content update and cannot invent a missing sequence', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish(f.request()); f.advance(30000);
  await rejects(run.heartbeat({ protocolVersion: 1, runId: 'run-a', providers: [{ providerId: 'provider', lastSequence: 2, state: 'ready' }] }), 'stale-sequence');
  await run.heartbeat({ protocolVersion: 1, runId: 'run-a', providers: [{ providerId: 'provider', lastSequence: 1, state: 'ready' }] });
  const item = (await f.query({ kind: 'instances', refs: [ref()] })).items[0]; assert.equal(item.freshness, 'stale'); assert.equal(f.m.counts.projection, 1); await f.hub.close();
});
test('channel inactivity is terminal without declaring the source process dead', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish(f.request()); f.advance(45000);
  await rejects(run.heartbeat({ protocolVersion: 1, runId: 'run-a', providers: [] }), 'unavailable');
  const item = (await f.query({ kind: 'instances', refs: [ref()] })).items[0]; assert.equal(item.sourceState, 'running'); assert.equal(item.freshness, 'stale'); await f.hub.close();
});
test('policy revocation hides content, old cursor, board refs, receipts and navigation', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish({ ...f.request(), ...snapshot(1, ['item', 'second']) });
  const cursor = (await f.query({ kind: 'catalog', limit: 1 })).nextCursor;
  await f.client.mutate(f.mutation()); const oldRequest = f.request('a', 2); await f.set('a', null);
  await rejects(run.publish(oldRequest), 'stale-grant');
  assert.equal((await f.query({ kind: 'instances', refs: [ref()] })).items[0].reason, 'not-found');
  assert.equal((await f.query({ kind: 'board', boardId: 'home' })).board.placements.length, 0);
  assert.equal((await f.query({ kind: 'receipt', requestId: 'pin' })).receipt.result.board.placements.length, 0);
  assert.equal((await f.query({ kind: 'navigation', ref: ref() })).available, false);
  await rejects(f.query({ kind: 'catalog', limit: 1, cursor }), 'cursor-invalid'); assert.equal(f.m.projections.size, 0); await f.hub.close();
});
test('physical cleanup failure does not roll back revoked permission', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish(f.request());
  f.m.failRemove(); await rejects(f.set('a', null), 'storage-failed'); assert.equal(f.m.projections.size, 1);
  const reads = f.m.counts.read;
  assert.equal((await f.query({ kind: 'catalog' })).entries.length, 0);
  assert.equal((await f.query({ kind: 'instances', refs: [ref()] })).items[0].reason, 'not-found'); assert.equal(f.m.counts.read, reads);
  await f.hub.close(); const next = fixture(f.m, 'new-epoch'); assert.equal((await next.query({ kind: 'catalog' })).entries.length, 0); await next.hub.close();
});
test('policy write failure stops admission instead of trusting an old in-memory grant', async () => {
  const f = fixture(); await f.set('a'); f.m.failPolicy(); await rejects(f.set('a', null), 'storage-failed');
  await rejects(f.query({ kind: 'overview' }), 'storage-failed'); await f.hub.close();
});
test('source removal is different from revocation and keeps lawful layout placeholders', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish(f.request()); await f.client.mutate(f.mutation()); f.advance();
  await run.publish({ ...f.request('a', 2), types: [], instances: [] });
  assert.equal((await f.query({ kind: 'board', boardId: 'home' })).board.placements.length, 1);
  assert.equal((await f.query({ kind: 'instances', refs: [ref()] })).items[0].reason, 'source-removed'); await f.hub.close();
});
test('Home layout CAS and progress sequences remain independent', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish(f.request()); const first = await f.client.mutate(f.mutation()); if (first.result.kind !== 'board.saved') assert.fail();
  f.advance(); await run.publish(f.request('a', 2));
  assert.equal((await f.query({ kind: 'board', boardId: 'home' })).board.revision, first.result.board.revision);
  const command = { kind: 'board.replace', boardId: 'home', title: 'Updated', placements: [], expectedRevision: first.result.board.revision };
  const results = await Promise.allSettled([f.client.mutate(f.mutation('one', command)), f.client.mutate(f.mutation('two', command))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.m.counts.layout, 2); await f.hub.close();
});
test('reader cannot manage publication or write layout; unauthenticated queries read nothing', async () => {
  const f = fixture(); f.deny(); await rejects(f.query({ kind: 'overview' }), 'unauthenticated'); assert.equal(f.m.counts.read, 0);
  f.readOnly(); await rejects(f.query({ kind: 'publications', spaceId: 'a' }), 'forbidden'); await rejects(f.client.mutate(f.mutation()), 'forbidden'); await f.hub.close();
});
test('content-only changes retain catalog cursors, while metadata changes invalidate them', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish({ ...f.request(), ...snapshot(1, ['item', 'second']) });
  const first = await f.query({ kind: 'catalog', limit: 1 }); f.advance();
  await run.publish({ ...f.request('a', 2), ...snapshot(9, ['item', 'second']) });
  assert.equal((await f.query({ kind: 'catalog', cursor: first.nextCursor, limit: 1 })).entries.length, 1); f.advance();
  const changed = snapshot(9, ['item', 'second']); changed.instances[0].title = 'Changed'; await run.publish({ ...f.request('a', 3), ...changed });
  await rejects(f.query({ kind: 'catalog', cursor: first.nextCursor, limit: 1 }), 'cursor-invalid'); await f.hub.close();
});
test('no success ack is emitted before durable publication completes', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { entered = r; }); f.m.barrier(() => { entered(); return new Promise(r => { release = r; }); });
  let ack = false; const publishing = run.publish(f.request()).then(() => { ack = true; }); await gate; assert.equal(ack, false);
  release(); await publishing; assert.equal(ack, true); await f.hub.close();
});
test('revoke waits for an admitted commit, and subsequent reads cannot pass the old grant', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { entered = r; }); f.m.barrier(() => { entered(); return new Promise(r => { release = r; }); });
  const publishing = run.publish(f.request()); await gate; const revoking = f.set('a', null); release(); await publishing; await revoking;
  assert.equal((await f.query({ kind: 'catalog' })).entries.length, 0); await f.hub.close();
});
test('response delivery stays inside the serialized policy critical section', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); await run.publish(f.request()); let delivered = false;
  const reading = f.hub.query({ kind: 'instances', refs: [ref()] }, f.auth, value => { assert.equal(value.data.kind, 'instances'); delivered = true; });
  const revoking = f.set('a', null); await reading; await revoking; assert.equal(delivered, true);
  await f.hub.query({ kind: 'instances', refs: [ref()] }, f.auth, value => { if (value.data.kind !== 'instances') assert.fail(); assert.equal(value.data.items[0].state, 'unavailable'); }); await f.hub.close();
});
test('corrupt policies are never repaired or substituted with an empty Home', async () => {
  const m = memory(); m.corrupt({ schemaVersion: 99, policies: [] }); const f = fixture(m);
  await rejects(f.query({ kind: 'overview' }), 'storage-failed'); assert.equal(m.counts.policy, 0); await f.hub.close();
});
test('rate limits reject a hot provider without changing other spaces', async () => {
  const f = fixture(); await f.set('a'); await f.set('b'); const a = await f.begin(), b = await f.begin('b');
  await a.publish(f.request()); await rejects(a.publish(f.request('a', 2)), 'rate-limited'); await b.publish(f.request('b'));
  assert.equal((await f.query({ kind: 'catalog' })).entries.length, 2); await f.hub.close();
});
test('losing Supervisor ownership denies writes and reads immediately', async () => {
  const f = fixture(); await f.set('a'); const run = await f.begin(); f.loseOwner();
  await rejects(run.publish(f.request()), 'forbidden'); await rejects(f.query({ kind: 'overview' }), 'forbidden'); assert.equal(f.m.counts.projection, 0); await f.hub.close();
});
