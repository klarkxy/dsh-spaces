import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HomeDashboard, type HomePolicyBook } from '../src/core/domain/dashboard/home-backend.ts';
import type { LayoutDocument } from '../src/core/domain/dashboard/boards.ts';
import type { Projection } from '../src/core/domain/dashboard/projection.ts';
import { HomeDashboardFileStore } from '../src/adapters/node/dashboard/file-store.ts';
import { DashboardFault } from '../src/core/domain/dashboard/errors.ts';

// The hooks run after the actual disk operation reaches its first await. They
// represent synchronous retirement/session changes outside the Hub write queue.
class RacingStore extends HomeDashboardFileStore {
  policyRace?: () => void;
  layoutRace?: () => void;
  projectionRace?: () => void;
  deleteRace?: () => void;
  override writePolicies(value: HomePolicyBook, check?: () => void) { const work = super.writePolicies(value, check); this.policyRace?.(); return work; }
  override writeLayout(value: LayoutDocument, check?: () => void) { const work = super.writeLayout(value, check); this.layoutRace?.(); return work; }
  override writeProjection(value: Projection, check?: () => void) { const work = super.writeProjection(value, check); this.projectionRace?.(); return work; }
  override deleteProjection(space: string, provider: string, check?: () => void) { const work = super.deleteProjection(space, provider, check); this.deleteRace?.(); return work; }
}
function fixture() {
  mkdirSync('.sandbox', { recursive: true }); const root = mkdtempSync(resolve('.sandbox/dashboard-commit-'));
  const store = new RacingStore(join(root, 'store'), () => {});
  const hub = new HomeDashboard({ backendEpoch: 'epoch', store, newId: randomUUID, now: Date.now, assertOwner: () => {}, assertRun: () => {},
    sources: () => [{ spaceId: 'a', title: 'A', sourceState: 'running', publishing: 'disabled' }] });
  let writable = true;
  const auth = () => ({ subjectId: 'operator', layoutWrite: writable, publicationsManage: true });
  const set = (revision = 'absent', selection: null | { kind: 'all' } = { kind: 'all' }, guard = () => {}) => hub.applyPublication({
    kind: 'dashboard.publication.set', spaceId: 'a', providerId: 'provider', expectedGrantRevision: revision, selection,
  }, guard);
  const request = (revision: string, runId: string, value = 42) => ({ protocolVersion: 1, runId, providerId: 'provider', grantRevision: revision, sequence: 1,
    types: [{ typeId: 'metric', version: 1, title: 'Metric', kind: 'metric' }],
    instances: [{ instanceId: 'item', typeId: 'metric', typeVersion: 1, title: 'Value', content: { kind: 'metric', value, unit: '' }, sourceTarget: null, updatedAt: new Date().toISOString(), staleAfterSeconds: null }],
  });
  const mutation = () => ({ requestId: randomUUID(), backendEpoch: 'epoch', issuedAt: new Date().toISOString(),
    command: { kind: 'board.create' as const, boardId: 'board', title: 'Board', placements: [] } });
  return { hub, store, auth, set, request, mutation, readOnly: () => { writable = false; }, writable: () => { writable = true; },
    async close() { await hub.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('retirement during real async disk preparation prevents projection commit and does not poison the Home', async () => {
  const f = fixture(); try {
    const grant = await f.set(), run = await f.hub.beginRun({ spaceId: 'a', generation: 1, runId: 'first' });
    f.store.projectionRace = () => run.close();
    await assert.rejects(run.publish(f.request(grant.revision, 'first')), { code: 'dashboard/stale-run' });
    assert.equal(await f.store.readProjection('a', 'provider'), null);
    const catalog = await f.hub.query({ kind: 'catalog' }, f.auth); assert.equal(catalog.data.kind, 'catalog');
    if (catalog.data.kind === 'catalog') assert.deepEqual(catalog.data.entries, []);
    f.store.projectionRace = undefined;
    const fresh = await f.hub.beginRun({ spaceId: 'a', generation: 2, runId: 'second' });
    assert.equal((await fresh.publish(f.request(grant.revision, 'second', 43))).sequence, 1);
  } finally { await f.close(); }
});

test('same-subject loss of layout permission before rename leaves no layout or receipt', async () => {
  const f = fixture(); try {
    f.store.layoutRace = f.readOnly;
    await assert.rejects(f.hub.mutate(f.mutation(), f.auth), { code: 'dashboard/forbidden' });
    assert.equal(await f.store.readLayout(), null);
    await f.hub.query({ kind: 'overview' }, f.auth);
    f.writable(); f.store.layoutRace = undefined;
    assert.equal((await f.hub.mutate(f.mutation(), f.auth)).result.kind, 'board.saved');
  } finally { await f.close(); }
});

test('plan authority lost during policy preparation does not persist a new grant or break reads', async () => {
  const f = fixture(); try {
    let permitted = true; f.store.policyRace = () => { permitted = false; };
    await assert.rejects(f.set('absent', { kind: 'all' }, () => { if (!permitted) throw new DashboardFault('dashboard/forbidden'); }), { code: 'dashboard/forbidden' });
    assert.equal(await f.store.readPolicies(), null);
    await f.hub.query({ kind: 'overview' }, f.auth);
    f.store.policyRace = undefined;
    assert.equal((await f.set()).selection?.kind, 'all');
  } finally { await f.close(); }
});

test('authority lost before projection cleanup never restores the already committed revocation', async () => {
  const f = fixture(); try {
    const policy = await f.set(), run = await f.hub.beginRun({ spaceId: 'a', generation: 1, runId: 'first' });
    await run.publish(f.request(policy.revision, 'first'));
    let permitted = true; f.store.deleteRace = () => { permitted = false; };
    await assert.rejects(f.set(policy.revision, null, () => { if (!permitted) throw new DashboardFault('dashboard/forbidden'); }), { code: 'dashboard/forbidden' });
    assert.ok(await f.store.readProjection('a', 'provider'), 'refused cleanup retains the old disk evidence');
    const book = await f.store.readPolicies() as HomePolicyBook; assert.equal(book.policies[0].selection, null);
    const catalog = await f.hub.query({ kind: 'catalog' }, f.auth);
    if (catalog.data.kind !== 'catalog') assert.fail(); assert.deepEqual(catalog.data.entries, []);
  } finally { await f.close(); }
});
