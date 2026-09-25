import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalDashboard, type LocalDashboardDocument } from '../src/core/domain/dashboard/local-backend.ts';
import { DashboardView, WidgetContentView } from '../packages/dashboard/src/view.tsx';
import { moveCommand, pinCommand, readDashboardFrame, unpinCommand, type DashboardReadBackend } from '../packages/dashboard/src/model.ts';
import type { DashboardQueryResponse, WidgetContent, WidgetInstance } from '../src/shared/dashboard.ts';

async function fixture(count = 1) {
  let document: LocalDashboardDocument | null = null, id = 0, writes = 0;
  const now = '2026-09-25T00:00:00Z';
  const service = new LocalDashboard({ spaceId: 'local', title: 'Local', backendEpoch: 'epoch', newId: () => `id-${++id}`, now: () => Date.parse(now),
    store: { read: async () => document, write: async value => { writes++; document = structuredClone(value); }, close: async () => {} } });
  const client = service.client(() => ({ subjectId: 'user', layoutWrite: true }));
  const instances: WidgetInstance[] = Array.from({ length: count }, (_, i) => ({ instanceId: `task-${i}`, typeId: 'task', typeVersion: 1, title: `Task ${i}`, content: { kind: 'metric', value: i, unit: 'items' }, sourceTarget: { kind: 'space' }, updatedAt: now, staleAfterSeconds: null }));
  await service.bindProvider('tasks').register({ types: [{ typeId: 'task', version: 1, kind: 'metric', title: 'Tasks' }], snapshot: () => instances }).publish();
  return { service, client, now, get writes() { return writes; }, async pin() {
    const frame = await readDashboardFrame(client);
    await client.mutate({ backendEpoch: 'epoch', requestId: `pin-${++id}`, issuedAt: now, command: pinCommand(frame, frame.catalog[0].ref, `p-${id}`) });
  } };
}

test('all four renderers are inert and have no HTML, image or link injection', () => {
  const values: WidgetContent[] = [
    { kind: 'progress', value: 3, max: 10, unit: '<img src=x>', status: 'running' },
    { kind: 'metric', value: 5, unit: '<script>bad()</script>' },
    { kind: 'list', items: [{ id: 'a', label: '<iframe src=x></iframe>', state: 'blocked' }] },
    { kind: 'markdown', text: '# Heading\n[link](javascript:evil())\n![remote](https://example.test/track)\n<script>evil()</script>' },
  ];
  for (const content of values) {
    const html = renderToStaticMarkup(<WidgetContentView content={content} />);
    assert.ok(!/<(?:img|script|iframe|a)(?:\s|>)/i.test(html));
    assert.ok(!/\s(?:href|src|onerror)=/i.test(html));
  }
});
test('reading a frame does not create an empty board or write settings', async () => {
  const f = await fixture(); const before = f.writes;
  const frame = await readDashboardFrame(f.client); assert.equal(frame.board, null); assert.equal(frame.catalog.length, 1); assert.equal(f.writes, before);
  const html = renderToStaticMarkup(<DashboardView frame={frame} />); assert.match(html, /首页还没有固定组件/); await f.service.close();
});
test('frame uses the actual backend: pin, render title, unpin without deleting the provider', async () => {
  const f = await fixture(); await f.pin(); let frame = await readDashboardFrame(f.client);
  assert.equal(frame.items.length, 1); assert.equal(frame.board?.placements.length, 1);
  assert.match(renderToStaticMarkup(<DashboardView frame={frame} onUnpin={() => {}} />), /Task 0/);
  const command = unpinCommand(frame, frame.board!.placements[0].id);
  await f.client.mutate({ backendEpoch: 'epoch', requestId: 'remove', issuedAt: f.now, command });
  frame = await readDashboardFrame(f.client); assert.equal(frame.board?.placements.length, 0); assert.equal(frame.catalog.length, 1); await f.service.close();
});
test('layout controls preserve CAS and reject overlaps before sending commands', async () => {
  const f = await fixture(); await f.pin(); let frame = await readDashboardFrame(f.client);
  const first = frame.board!.placements[0]; const add = pinCommand(frame, first.ref, 'second');
  if (add.kind !== 'board.replace') assert.fail(); assert.equal(add.expectedRevision, frame.board!.revision); assert.equal(add.placements[1].x, 6);
  await f.client.mutate({ backendEpoch: 'epoch', requestId: 'add-again', issuedAt: f.now, command: add });
  frame = await readDashboardFrame(f.client);
  assert.throws(() => moveCommand(frame, 'second', { x: 0, y: 0, w: 6, h: 2 }), /dashboard\/invalid-input/);
  const moved = moveCommand(frame, 'second', { x: 0, y: 2, w: 6, h: 2 }); assert.equal(moved.kind, 'board.replace'); await f.service.close();
});
test('many placements use bounded batches and repeated instances are read once', async () => {
  const f = await fixture(60); const frame = await readDashboardFrame(f.client);
  await f.client.mutate({ backendEpoch: 'epoch', requestId: 'many', issuedAt: f.now, command: { kind: 'board.create', boardId: 'home', title: 'Many', placements: frame.catalog.map((entry, i) => ({ id: `p${i}`, ref: entry.ref, x: 0, y: i * 2, w: 6, h: 2 })) } });
  const sizes: number[] = [];
  const backend: DashboardReadBackend = { mutate: request => f.client.mutate(request), query: request => { if (request.kind === 'instances') sizes.push(request.refs.length); return f.client.query(request); } };
  const result = await readDashboardFrame(backend); assert.deepEqual(sizes, [50, 10]); assert.equal(result.items.length, 60); await f.service.close();
});
test('an epoch change during a frame fails instead of mixing two backends', async () => {
  const f = await fixture(); let calls = 0;
  const backend: DashboardReadBackend = { mutate: request => f.client.mutate(request), query: async request => {
    const value = await f.client.query(request); if (++calls > 1) value.backendEpoch = 'other'; return value;
  } };
  await assert.rejects(readDashboardFrame(backend), /dashboard\/stale-epoch/); assert.equal(calls, 2); await f.service.close();
});
test('aborting after the first response prevents subsequent requests', async () => {
  const f = await fixture(); const controller = new AbortController(); let calls = 0;
  const backend: DashboardReadBackend = { mutate: request => f.client.mutate(request), query: async request => { calls++; const response = await f.client.query(request); controller.abort(); return response; } };
  await assert.rejects(readDashboardFrame(backend, controller.signal), /dashboard\/unavailable/); assert.equal(calls, 1); await f.service.close();
});
test('malformed and swapped instance responses cannot be displayed under another reference', async () => {
  const f = await fixture(); await f.pin();
  const backend: DashboardReadBackend = { mutate: request => f.client.mutate(request), query: async request => {
    const value = await f.client.query(request);
    if (value.data.kind === 'instances') value.data.items[0].ref.instanceId = 'different';
    return value;
  } };
  await assert.rejects(readDashboardFrame(backend), /dashboard\/invalid-input/); await f.service.close();
});
test('old content is labelled stale and controls are disabled after read failure', async () => {
  const f = await fixture(); await f.pin(); const frame = await readDashboardFrame(f.client);
  const html = renderToStaticMarkup(<DashboardView frame={frame} error={{ code: 'dashboard/unavailable', message: 'hidden' }} onPin={() => {}} onUnpin={() => {}} />);
  assert.match(html, /看板读取已停止/); assert.match(html, /可能已过时/); assert.match(html, /disabled/); await f.service.close();
});
test('unknown result kinds fail rather than being treated as a valid empty result', async () => {
  const backend: DashboardReadBackend = { mutate: async () => { throw new Error('not used'); }, query: async () => ({ protocolVersion: 1, backendEpoch: 'epoch', data: { kind: 'invented' } } as unknown as DashboardQueryResponse) };
  await assert.rejects(readDashboardFrame(backend), /dashboard\/invalid-input/);
});
