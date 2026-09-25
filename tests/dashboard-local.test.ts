import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDashboard, parseLocalDashboardDocument, type LocalDashboardAccess, type LocalDashboardDocument, type LocalDashboardStore } from '../src/core/domain/dashboard/local-backend.ts';
import { DashboardFault } from '../src/core/domain/dashboard/errors.ts';
import type { BoardMutation, DashboardQueryResponse, WidgetInstance } from '../src/shared/dashboard.ts';

const initialTime = Date.parse('2026-09-25T00:00:00Z');
const copy = <T>(value: T): T => structuredClone(value);
function instance(id = 'work'): WidgetInstance {
  return { instanceId: id, typeId: 'progress', typeVersion: 1, title: `Task ${id}`, content: { kind: 'progress', value: 1, max: 10, unit: 'items', status: 'running' }, sourceTarget: { kind: 'space' }, updatedAt: new Date(initialTime).toISOString(), staleAfterSeconds: 30 };
}
function store(initial: unknown | null = null) {
  let value = copy(initial), reads = 0, writes = 0, closes = 0;
  let beforeWrite: (() => Promise<void>) | undefined;
  const port: LocalDashboardStore = {
    read: async () => { reads++; return copy(value); },
    write: async document => { writes++; await beforeWrite?.(); value = copy(document); },
    close: async () => { closes++; },
  };
  return { port, get value() { return copy(value); }, get reads() { return reads; }, get writes() { return writes; }, get closes() { return closes; }, set beforeWrite(callback: (() => Promise<void>) | undefined) { beforeWrite = callback; } };
}
function setup(storage = store(), epoch = 'epoch-1') {
  let n = 0, now = initialTime;
  let access: LocalDashboardAccess | null = { subjectId: 'reader', layoutWrite: true };
  const service = new LocalDashboard({ spaceId: 'coding', title: 'Coding', backendEpoch: epoch, now: () => now, newId: () => `id-${++n}`, store: storage.port });
  const client = service.client(() => access);
  const ref = (id = 'work') => ({ spaceId: 'coding', providerId: 'tasks', instanceId: id });
  const create = (requestId = 'create'): BoardMutation => ({ requestId, issuedAt: new Date(now).toISOString(), backendEpoch: epoch, command: { kind: 'board.create', boardId: 'home', title: 'Home', placements: [{ id: 'p', ref: ref(), x: 0, y: 0, w: 6, h: 2 }] } });
  let data = [instance()];
  const provider = () => service.bindProvider('tasks').register({ types: [{ typeId: 'progress', version: 1, kind: 'progress', title: 'Progress' }], snapshot: () => copy(data) });
  return { service, client, storage, provider, ref, create, setAccess: (value: LocalDashboardAccess | null) => { access = value; }, setTime: (value: number) => { now = value; }, setInstances: (value: WidgetInstance[]) => { data = value; } };
}
async function code(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, error => error instanceof DashboardFault && error.code === `dashboard/${expected}`);
}
function data<K extends DashboardQueryResponse['data']['kind']>(value: DashboardQueryResponse, kind: K): Extract<DashboardQueryResponse['data'], { kind: K }> {
  assert.equal(value.data.kind, kind); return value.data as Extract<DashboardQueryResponse['data'], { kind: K }>;
}

test('empty overview and board lookup never create persistent records', async () => {
  const f = setup(); const overview = data(await f.client.query({ kind: 'overview' }), 'overview');
  assert.equal(overview.mode, 'local'); assert.equal(overview.defaultBoardId, 'home');
  assert.equal(data(await f.client.query({ kind: 'board', boardId: 'home' }), 'board').board, null);
  assert.equal(f.storage.reads, 1); assert.equal(f.storage.writes, 0);
  await f.service.close(); await f.service.close(); assert.equal(f.storage.closes, 1);
});
test('unauthenticated readers fail before touching storage; read-only clients cannot write', async () => {
  const f = setup(); f.setAccess(null); await code(f.client.query({ kind: 'overview' }), 'unauthenticated'); assert.equal(f.storage.reads, 0);
  f.setAccess({ subjectId: 'reader', layoutWrite: false });
  assert.equal(data(await f.client.query({ kind: 'overview' }), 'overview').capabilities.layoutWrite, false);
  await code(f.client.mutate(f.create()), 'forbidden'); assert.equal(f.storage.writes, 0); await f.service.close();
});
test('provider publication, pinning, receipt and reopen use the same persistent document', async () => {
  const f = setup(); const p = f.provider(); const result = await p.publish(); assert.equal(result.home.state, 'not-configured');
  const receipt = await f.client.mutate(f.create()); assert.equal(receipt.result.kind, 'board.saved');
  const saved = f.storage.value as LocalDashboardDocument; assert.equal(saved.providers.length, 1); assert.equal(saved.layout.receipts.length, 1); assert.equal(saved.layout.boards.length, 1);
  await f.service.close();
  const next = setup(f.storage, 'epoch-2');
  const board = data(await next.client.query({ kind: 'board', boardId: 'home' }), 'board').board; assert.equal(board?.placements.length, 1);
  const cached = data(await next.client.query({ kind: 'instances', refs: [next.ref()] }), 'instances').items[0];
  assert.equal(cached.state, 'present'); if (cached.state === 'present') { assert.equal(cached.freshness, 'stale'); assert.equal(cached.sourceState, 'unknown'); }
  assert.equal(data(await next.client.query({ kind: 'receipt', requestId: 'create' }), 'receipt').receipt?.backendEpoch, 'epoch-1');
  await next.service.close();
});
test('only full commit completion can release a publication confirmation', async () => {
  const f = setup(); let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.storage.beforeWrite = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
  let confirmed = false; const publication = f.provider().publish().then(value => { confirmed = true; return value; });
  await entered; assert.equal(confirmed, false); assert.equal(f.storage.value, null);
  release(); await publication; assert.equal(confirmed, true); await f.service.close();
});
test('write failure is terminal, keeps evidence and never serves the old cache as success', async () => {
  const f = setup(); const p = f.provider(); await p.publish(); const previous = f.storage.value;
  f.storage.beforeWrite = async () => { throw new Error('private path/token'); };
  await code(f.client.mutate(f.create()), 'storage-failed'); assert.deepEqual(f.storage.value, previous);
  await code(f.client.query({ kind: 'overview' }), 'storage-failed'); await code(f.client.mutate(f.create('again')), 'storage-failed');
  assert.equal(f.storage.writes, 2); await f.service.close();
});
test('malformed or unknown storage cannot become an empty dashboard', async () => {
  for (const value of [{}, { schemaVersion: 2, layout: {}, providers: [] }, '{"duplicate":1,"duplicate":2}', { schemaVersion: 1, layout: {}, providers: [] }]) {
    const f = setup(store(value)); await code(f.client.query({ kind: 'overview' }), 'storage-failed'); await code(f.client.query({ kind: 'overview' }), 'storage-failed');
    assert.equal(f.storage.reads, 1); assert.equal(f.storage.writes, 0); assert.deepEqual(f.storage.value, value); await f.service.close();
  }
});
test('two clients replacing one revision have exactly one winner', async () => {
  const f = setup(); await f.provider().publish(); const created = await f.client.mutate(f.create()); assert.equal(created.result.kind, 'board.saved'); if (created.result.kind !== 'board.saved') return;
  const other = f.service.client(() => ({ subjectId: 'second-window', layoutWrite: true }));
  const base = f.create(); const command = { kind: 'board.replace' as const, boardId: 'home', expectedRevision: created.result.board.revision, title: 'Updated', placements: [] };
  const results = await Promise.allSettled([f.client.mutate({ ...base, requestId: 'a', command }), other.mutate({ ...base, requestId: 'b', command })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const failure = results.find(value => value.status === 'rejected') as PromiseRejectedResult; assert.equal(failure.reason.code, 'dashboard/revision-conflict'); await f.service.close();
});
test('duplicate commands do not commit twice and progress updates do not change layout revisions', async () => {
  const f = setup(); const p = f.provider(); await p.publish(); const first = await f.client.mutate(f.create()); const writes = f.storage.writes;
  assert.deepEqual(await f.client.mutate(f.create()), first); assert.equal(f.storage.writes, writes);
  const updated = instance(); updated.content = { kind: 'progress', value: 2, max: 10, unit: 'items', status: 'running' }; f.setInstances([updated]); await p.publish();
  const board = data(await f.client.query({ kind: 'board', boardId: 'home' }), 'board').board;
  if (first.result.kind === 'board.saved') assert.equal(board?.revision, first.result.board.revision); await f.service.close();
});
test('foreign spaces cannot be queried through local mode or introduced in new placements', async () => {
  const f = setup(); await f.provider().publish(); const foreign = { ...f.ref(), spaceId: 'other' };
  assert.equal(data(await f.client.query({ kind: 'instances', refs: [foreign] }), 'instances').items[0].state, 'unavailable');
  const request = f.create(); if (request.command.kind === 'board.create') request.command.placements[0].ref = foreign;
  await code(f.client.mutate(request), 'not-found'); await code(f.client.query({ kind: 'publications', spaceId: 'coding' }), 'unsupported-operation'); await f.service.close();
});
test('catalog empty filter is empty and cursor is bound to subject, filter, size and metadata', async () => {
  const f = setup(); f.setInstances([instance('a'), instance('b'), instance('c')]); const p = f.provider(); await p.publish();
  assert.equal(data(await f.client.query({ kind: 'catalog', spaceIds: [] }), 'catalog').entries.length, 0);
  const first = data(await f.client.query({ kind: 'catalog', limit: 1 }), 'catalog'); assert.ok(first.nextCursor);
  const cursor = first.nextCursor!;
  await code(f.client.query({ kind: 'catalog', cursor, limit: 2 }), 'cursor-invalid');
  await code(f.client.query({ kind: 'catalog', cursor, limit: 1, spaceIds: ['coding'] }), 'cursor-invalid');
  const other = f.service.client(() => ({ subjectId: 'other', layoutWrite: true })); await code(other.query({ kind: 'catalog', cursor, limit: 1 }), 'cursor-invalid');
  const changed = [instance('a'), instance('b'), instance('c')]; changed[0].content = { kind: 'progress', value: 2, max: 10, unit: 'items', status: 'running' }; f.setInstances(changed); await p.publish();
  const second = data(await f.client.query({ kind: 'catalog', cursor, limit: 1 }), 'catalog'); assert.equal(second.entries[0].ref.instanceId, 'b'); assert.equal(second.catalogRevision, first.catalogRevision);
  changed[0].title = 'Renamed'; f.setInstances(changed); await p.publish(); await code(f.client.query({ kind: 'catalog', cursor, limit: 1 }), 'cursor-invalid'); await f.service.close();
});
test('cursor expiry is explicit; invalid cursors never silently start from page one', async () => {
  const f = setup(); f.setInstances([instance('a'), instance('b')]); await f.provider().publish();
  const cursor = data(await f.client.query({ kind: 'catalog', limit: 1 }), 'catalog').nextCursor!;
  f.setTime(initialTime + 300000); await code(f.client.query({ kind: 'catalog', cursor, limit: 1 }), 'cursor-invalid');
  await code(f.client.query({ kind: 'catalog', cursor: 'invented' }), 'cursor-invalid'); await f.service.close();
});
test('source navigation never starts processes and requires a real live target', async () => {
  const f = setup(); const p = f.provider(); await p.publish();
  assert.equal(data(await f.client.query({ kind: 'navigation', ref: f.ref() }), 'navigation').available, true);
  const value = instance(); value.sourceTarget = { kind: 'artifact', id: 'not-verified' }; f.setInstances([value]); await p.publish();
  const result = data(await f.client.query({ kind: 'navigation', ref: f.ref() }), 'navigation'); assert.equal(result.available, false); assert.equal(result.target, null); await f.service.close();
});
test('normal removal leaves a placeholder and hides removed refs in old receipts', async () => {
  const f = setup(); const p = f.provider(); await p.publish(); await f.client.mutate(f.create()); await p.dispose();
  assert.equal(data(await f.client.query({ kind: 'board', boardId: 'home' }), 'board').board?.placements.length, 1);
  assert.equal(data(await f.client.query({ kind: 'instances', refs: [f.ref()] }), 'instances').items[0].state, 'unavailable');
  const receipt = data(await f.client.query({ kind: 'receipt', requestId: 'create' }), 'receipt').receipt!;
  if (receipt.result.kind === 'board.saved') assert.equal(receipt.result.board.placements.length, 0); await f.service.close();
});
test('deleting the default board does not reuse its tombstoned ID or create one on read', async () => {
  const f = setup(); await f.provider().publish(); const saved = await f.client.mutate(f.create()); if (saved.result.kind !== 'board.saved') assert.fail();
  await f.client.mutate({ ...f.create('delete'), command: { kind: 'board.delete', boardId: 'home', expectedRevision: saved.result.board.revision } });
  const writes = f.storage.writes; assert.equal(data(await f.client.query({ kind: 'overview' }), 'overview').defaultBoardId, 'home-2'); assert.equal(f.storage.writes, writes); await f.service.close();
});
test('current authorization is checked again after asynchronous navigation', async () => {
  const s = store(); let allow = true; let finish!: () => void; let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; }); let id = 0;
  const service = new LocalDashboard({ spaceId: 'coding', title: 'Coding', backendEpoch: 'epoch-1', newId: () => `id-${++id}`, now: () => initialTime, store: s.port, targetExists: async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); return true; } });
  const client = service.client(() => allow ? { subjectId: 'reader', layoutWrite: true } : null);
  await service.bindProvider('tasks').register({ types: [{ typeId: 'progress', kind: 'progress', title: 'Progress', version: 1 }], snapshot: () => [instance()] }).publish();
  const pending = client.query({ kind: 'navigation', ref: { spaceId: 'coding', providerId: 'tasks', instanceId: 'work' } }); await entered; allow = false; finish(); await code(pending, 'unauthenticated'); await service.close();
});
test('snapshot and response objects cannot mutate backend state by alias', async () => {
  const f = setup(); await f.provider().publish(); const response = data(await f.client.query({ kind: 'instances', refs: [f.ref()] }), 'instances');
  const first = response.items[0]; if (first.state !== 'present') assert.fail(); first.instance.title = 'forged';
  const second = data(await f.client.query({ kind: 'instances', refs: [f.ref()] }), 'instances').items[0]; if (second.state !== 'present') assert.fail(); assert.equal(second.instance.title, 'Task work'); await f.service.close();
});
test('closed service rejects work and duplicate provider identities are refused', async () => {
  const f = setup(); f.provider(); assert.throws(() => f.provider(), /dashboard\/request-conflict/); await f.service.close();
  await code(f.client.query({ kind: 'overview' }), 'unavailable'); await code(f.client.mutate(f.create()), 'unavailable'); assert.throws(() => f.service.bindProvider('new'), /dashboard\/unavailable/);
});
test('local document decoder rejects duplicate providers without dropping any records', async () => {
  const f = setup(); await f.provider().publish(); const record = f.storage.value as LocalDashboardDocument; record.providers.push(copy(record.providers[0]));
  assert.throws(() => parseLocalDashboardDocument(record), /dashboard\/invalid-input/); await f.service.close();
});
