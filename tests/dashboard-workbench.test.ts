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

// Validate both native FaceModel directions. The Supervisor's HTTP parser alone
// cannot prove that the manager Remote admits a newly added plan kind.
import { workbenchPlanRequestSchema, workbenchPlanSchema } from '../packages/plugin/src/host/workbench-schemas.ts';

test('native FaceModel admits publication plans in both request and response directions', () => {
  for (const selection of [null, { kind: 'all' }, { kind: 'selected', instanceIds: ['one', 'two'] }]) {
    const request = { kind: 'dashboard.publication.set', spaceId: 'coding', providerId: 'tasks', expectedGrantRevision: 'absent', selection };
    assert.deepEqual(workbenchPlanRequestSchema.parse(request), request);
  }
  const result = { id: 'plan-1', kind: 'dashboard.publication.set', title: 'Publishing permission',
    scope: 'space', affectedSpaceIds: ['coding'], runningSpaceIds: [], changes: ['Permit one source'],
    destructive: false, expiresAt: '2026-09-25T08:00:00Z', serviceEpoch: epoch, stateRevision: epoch };
  assert.deepEqual(workbenchPlanSchema.parse(result), result);
});
test('native plan schema stays closed and does not widen instance selection', () => {
  const valid = { kind: 'dashboard.publication.set', spaceId: 'coding', providerId: 'tasks', expectedGrantRevision: 'absent', selection: null };
  for (const patch of [{ token: 'forged' }, { providerId: '' }, { expectedGrantRevision: ' ' },
    { selection: { kind: 'selected', instanceIds: [] } }, { selection: { kind: 'selected', instanceIds: ['one', 'one'] } },
    { selection: { kind: 'all', instanceIds: ['one'] } }, { selection: { kind: 'other' } }]) {
    assert.equal(workbenchPlanRequestSchema.safeParse({ ...valid, ...patch }).success, false);
  }
});

import { mountStaticClientStyle } from '../packages/dashboard/src/client-style.ts';

test('native static stylesheet ownership and cleanup never replace another plugin sheet', () => {
  const nodes: any[] = [];
  const fake = { createElement: (name: string) => {
    assert.equal(name, 'style');
    const node = { dataset: {} as Record<string, string>, textContent: '', remove: () => {
      const at = nodes.indexOf(node); if (at >= 0) nodes.splice(at, 1);
    } }; return node;
  }, head: { appendChild: (node: unknown) => nodes.push(node) } } as unknown as Document;
  const foreign = { foreign: true }; nodes.push(foreign);
  const remove = mountStaticClientStyle(fake, '@dsh-spaces/plugin', 'workbench.css', '.dsh-workbench{display:flex}');
  const second = mountStaticClientStyle(fake, '@dsh-spaces/dashboard', 'dashboard.css', '.dsh-dashboard{display:block}');
  assert.equal(nodes.length, 3);
  assert.equal(nodes[1].dataset.plugin, '@dsh-spaces/plugin');
  assert.equal(nodes[1].dataset.pluginCss, '@dsh-spaces/plugin/workbench.css');
  assert.equal(nodes[1].textContent, '.dsh-workbench{display:flex}');
  remove(); remove(); assert.equal(nodes.length, 2); assert.strictEqual(nodes[0], foreign);
  second(); assert.deepEqual(nodes, [foreign]);
});
