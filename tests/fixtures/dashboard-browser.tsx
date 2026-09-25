/** Browser-only test fixture. Synthetic data, in-memory store, no DSH Home or network backend. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardApp } from '../../packages/dashboard/src/view';
import { LocalDashboard, type LocalDashboardDocument } from '../../src/core/domain/dashboard/local-backend';
import type { WidgetInstance } from '../../src/shared/dashboard';
let documentValue: LocalDashboardDocument | null = null;
let reads = 0, writes = 0, next = 0, allowed = true, chapters = 3;
const service = new LocalDashboard({ spaceId: 'writing', title: '写作空间', backendEpoch: 'browser-fixture', now: Date.now, newId: () => `id-${++next}`,
  store: { read: async () => documentValue, write: async value => { writes++; documentValue = structuredClone(value); }, close: async () => {} } });
const client = service.client(() => allowed ? { subjectId: 'fixture-user', layoutWrite: true } : null);
const provider = service.bindProvider('writing-tools').register({
  types: [{ typeId: 'chapters', version: 1, kind: 'progress', title: '写作进度' }, { typeId: 'checklist', version: 1, kind: 'list', title: '交付清单' }, { typeId: 'notes', version: 1, kind: 'markdown', title: '今日笔记' }],
  snapshot: (): WidgetInstance[] => [
    { instanceId: 'story', typeId: 'chapters', typeVersion: 1, title: '写作进度', content: { kind: 'progress', value: chapters, max: 10, unit: '章', status: 'running' }, sourceTarget: { kind: 'space' }, updatedAt: new Date().toISOString(), staleAfterSeconds: 30 },
    { instanceId: 'release', typeId: 'checklist', typeVersion: 1, title: '交付清单', content: { kind: 'list', items: [{ id: 'first', label: '检查章节衔接', state: 'doing' }, { id: 'second', label: '整理人物设定', state: 'todo' }] }, sourceTarget: null, updatedAt: new Date().toISOString(), staleAfterSeconds: null },
    { instanceId: 'notes', typeId: 'notes', typeVersion: 1, title: '今日笔记', content: { kind: 'markdown', text: '# 下一章\n主角收到一封没有署名的信。\n[静态文字，不会请求网络](https://example.test/track)' }, sourceTarget: null, updatedAt: new Date().toISOString(), staleAfterSeconds: null },
  ],
});
const backend = { query: (request: Parameters<typeof client.query>[0]) => { reads++; return client.query(request); }, mutate: client.mutate };
Object.assign(window, { dashboardTest: {
  state: () => ({ reads, writes, boards: structuredClone(documentValue?.layout.boards ?? []), providerInstances: documentValue?.providers[0]?.instances.length ?? 0 }),
  update: async () => { chapters = 7; await provider.publish(); },
  revoke: () => { allowed = false; },
} });
void provider.publish().then(() => createRoot(document.getElementById('root')!).render(<DashboardApp backend={backend} />));
