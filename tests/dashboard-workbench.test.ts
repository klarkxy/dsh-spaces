import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardEndpoint, connectWorkbenchDashboard, readPublicationPolicies, publicationInput } from '../packages/plugin/src/workbench/dashboard-client.ts';
import type { WorkbenchView } from '../src/shared/workbench.ts';

const epoch = 'ab'.repeat(32);
const expected = { epoch, generation: 2, managerId: 'spaces-hub', pageOrigin: 'http://127.0.0.1:6001' };
const view: WorkbenchView = { serviceEpoch: epoch, spaceId: 'spaces-hub', generation: 2,
  origin: expected.pageOrigin, entryOrigin: 'http://127.0.0.1:6000', entryPath: '/view/spaces-hub/2', channel: 'current' };

test('dashboard endpoint is resolved through the current manager view, without any secret', () => {
  assert.equal(dashboardEndpoint(view, expected), view.entryOrigin);
  assert.ok(!JSON.stringify(view).includes('token'));
});
test('foreign origins, mismatched managers, generations, epochs and credential URLs are refused', () => {
  for (const change of [{ spaceId: 'ordinary' }, { generation: 3 }, { serviceEpoch: 'cd'.repeat(32) },
    { origin: 'http://127.0.0.1:7000' }, { entryOrigin: 'https://outside.example' },
    { entryOrigin: 'http://x:y@127.0.0.1:6000' }, { entryPath: '//outside.example/' }]) {
    assert.throws(() => dashboardEndpoint({ ...view, ...change }, expected));
  }
});
test('owned manager transport includes browser credentials but not Host or publisher bearer', async () => {
  let calls = 0;
  const backend = await connectWorkbenchDashboard({ view: async id => { assert.equal(id, expected.managerId); return view; } }, expected, async (url, options) => {
    calls++; assert.equal(String(url), 'http://127.0.0.1:6000/api/dashboard/v1/query');
    assert.equal(options?.credentials, 'include'); assert.equal(options?.mode, 'cors'); assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), null);
    return Response.json({ protocolVersion: 1, backendEpoch: epoch, data: { kind: 'publications', policies: [] } });
  });
  await backend.query({ kind: 'publications', spaceId: 'coding' }); assert.equal(calls, 1);
});
test('failed view discovery cannot fall back to current Host or localhost guessing', async () => {
  let calls = 0;
  await assert.rejects(connectWorkbenchDashboard({ view: async () => { throw new Error('failed'); } }, expected, async () => { calls++; return new Response(); }));
  assert.equal(calls, 0);
});
test('publication policy response is bound to the current owner and source', () => {
  const response = { protocolVersion: 1, backendEpoch: epoch, data: { kind: 'publications', policies: [{ spaceId: 'coding', providerId: 'p', revision: 'r1', selection: null, pendingStart: false }] } };
  assert.equal(readPublicationPolicies(response, epoch, 'coding')[0].selection, null);
  assert.throws(() => readPublicationPolicies(response, 'cd'.repeat(32), 'coding'));
  assert.throws(() => readPublicationPolicies(response, epoch, 'other'));
  assert.throws(() => readPublicationPolicies({ ...response, token: 'unwanted' }, epoch, 'coding'));
  response.data.policies.push(response.data.policies[0]);
  assert.throws(() => readPublicationPolicies(response, epoch, 'coding'));
});
test('permission form maps none, selected and all to exact existing plan requests', () => {
  assert.deepEqual(publicationInput('coding', 'tasks', 'r2', 'disabled', ''), {
    kind: 'dashboard.publication.set', spaceId: 'coding', providerId: 'tasks', expectedGrantRevision: 'r2', selection: null,
  });
  assert.deepEqual(publicationInput('coding', 'tasks', 'absent', 'selected', 'one\ntwo').selection, { kind: 'selected', instanceIds: ['one', 'two'] });
  assert.deepEqual(publicationInput('coding', 'tasks', 'absent', 'all', 'one').selection, { kind: 'all' });
});
test('empty, duplicate and excessive selected IDs cannot turn into all-instance access', () => {
  for (const input of ['', 'one\none', 'one\n', Array.from({ length: 101 }, (_, i) => String(i)).join('\n')]) {
    assert.throws(() => publicationInput('coding', 'tasks', 'absent', 'selected', input));
  }
  assert.throws(() => publicationInput('coding', '', 'absent', 'all', ''));
});
