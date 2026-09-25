import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDashboard, type LocalDashboardDocument } from '../src/core/domain/dashboard/local-backend.ts';
import type { WidgetInstance } from '../src/shared/dashboard.ts';

const widget: WidgetInstance = { instanceId: 'metric', typeId: 'count', typeVersion: 1, title: 'Count', content: { kind: 'metric', value: 1, unit: '' }, sourceTarget: { kind: 'space' }, updatedAt: '2026-09-25T00:00:00Z', staleAfterSeconds: null };
function context() {
  let value: LocalDashboardDocument | null = null;
  let ids = 0;
  const options = {
    spaceId: 'local', title: 'Local', now: () => Date.parse('2026-09-25T00:00:00Z'), newId: () => `id-${++ids}`,
    store: { read: async () => value, write: async (input: LocalDashboardDocument) => { value = structuredClone(input); }, close: async () => {} },
  };
  const register = (service: LocalDashboard) => service.bindProvider('metrics').register({ types: [{ typeId: 'count', version: 1, title: 'Count', kind: 'metric' }], snapshot: () => [structuredClone(widget)] });
  return { options, register };
}
test('a maximum-length valid backend epoch still yields a valid local publication receipt', async () => {
  const f = context(); const service = new LocalDashboard({ ...f.options, backendEpoch: 'e'.repeat(128) });
  const receipt = await f.register(service).publish(); assert.ok(receipt.localRevision.length <= 128); assert.equal(receipt.home.state, 'not-configured');
  await service.close();
});
test('registering a provider in a new run does not relabel an old snapshot as live', async () => {
  const f = context(); const first = new LocalDashboard({ ...f.options, backendEpoch: 'old' }); await f.register(first).publish(); await first.close();
  const second = new LocalDashboard({ ...f.options, backendEpoch: 'new' }); const provider = f.register(second);
  const client = second.client(() => ({ subjectId: 'user', layoutWrite: true }));
  const catalog = await client.query({ kind: 'catalog' }); assert.equal(catalog.data.kind, 'catalog'); if (catalog.data.kind === 'catalog') assert.equal(catalog.data.entries[0].sourceState, 'unknown');
  const ref = { spaceId: 'local', providerId: 'metrics', instanceId: 'metric' };
  const before = await client.query({ kind: 'instances', refs: [ref] }); if (before.data.kind !== 'instances' || before.data.items[0].state !== 'present') assert.fail();
  assert.equal(before.data.items[0].freshness, 'stale');
  await provider.publish(); const after = await client.query({ kind: 'catalog' }); if (after.data.kind !== 'catalog') assert.fail(); assert.equal(after.data.entries[0].sourceState, 'running');
  await second.close();
});
