/** Fictional IDs and data. Compile-time examples, not live requests. */
import type {
  BoardMutation, DashboardQuery, DashboardQueryResponse,
  ProviderRegistration, PublicationPlanInput, PublishRequest,
} from './contracts';

export const writing = {
  protocolVersion: 1,
  runId: 'run-writing-01',
  providerId: '@example/writing',
  sequence: 1,
  grantRevision: 'grant-writing-01',
  types: [{ typeId: 'chapter-progress', version: 1, kind: 'progress', title: '章节进度' }],
  instances: [{
    instanceId: 'book-01', typeId: 'chapter-progress', typeVersion: 1,
    title: '本周写作',
    content: { kind: 'progress', value: 3, max: 5, unit: '章', status: 'running' },
    sourceTarget: { kind: 'session', id: 'session-writing-01' },
    updatedAt: '2026-09-25T12:00:00Z', staleAfterSeconds: 300,
  }],
} satisfies PublishRequest;

export const tasks = {
  protocolVersion: 1,
  runId: 'run-coding-01', providerId: '@example/tasks', sequence: 1,
  grantRevision: 'grant-coding-01',
  types: [{ typeId: 'review-list', version: 1, kind: 'list', title: '待处理事项' }],
  instances: [{
    instanceId: 'review-01', typeId: 'review-list', typeVersion: 1, title: '代码审阅',
    content: { kind: 'list', items: [{ id: 'item-01', label: '检查接口合同', state: 'todo' }] },
    sourceTarget: { kind: 'space' }, updatedAt: '2026-09-25T12:00:00Z', staleAfterSeconds: 300,
  }],
} satisfies PublishRequest;

export const boardCreate = {
  requestId: 'request-board-01', issuedAt: '2026-09-25T12:01:00Z', backendEpoch: 'epoch-home-01',
  command: {
    kind: 'board.create', boardId: 'board-home-01', title: '我的工作首页',
    placements: [
      { id: 'placement-01', ref: { spaceId: 'space-writing', providerId: '@example/writing', instanceId: 'book-01' }, x: 0, y: 0, w: 6, h: 3 },
      { id: 'placement-02', ref: { spaceId: 'space-coding', providerId: '@example/tasks', instanceId: 'review-01' }, x: 6, y: 0, w: 6, h: 3 },
    ],
  },
} satisfies BoardMutation;

export const query = {
  kind: 'instances', refs: boardCreate.command.placements.map(p => p.ref),
} satisfies DashboardQuery;

export const policyPreview = {
  kind: 'dashboard.publication.set', spaceId: 'space-writing', providerId: '@example/writing',
  expectedGrantRevision: 'grant-disabled-01',
  selection: { kind: 'selected', instanceIds: ['book-01'] },
} satisfies PublicationPlanInput;

export const response = {
  protocolVersion: 1, backendEpoch: 'epoch-home-01',
  data: { kind: 'instances', items: [{
    state: 'present', ref: boardCreate.command.placements[0].ref,
    instance: writing.instances[0], runId: writing.runId, sequence: 1,
    receivedAt: '2026-09-25T12:00:01Z', freshness: 'current', sourceState: 'running',
  }, {
    state: 'present', ref: boardCreate.command.placements[1].ref,
    instance: tasks.instances[0], runId: tasks.runId, sequence: 1,
    receivedAt: '2026-09-25T12:00:02Z', freshness: 'current', sourceState: 'running',
  }] },
} satisfies DashboardQueryResponse;

/** Host adapter supplies the optional registry; this is not a DSH API call. */
export function writingRegistration(readProgress: () => number): ProviderRegistration {
  return {
    types: writing.types,
    snapshot: () => [{
      ...writing.instances[0],
      content: { kind: 'progress', value: readProgress(), max: 5, unit: '章', status: 'running' },
      updatedAt: new Date().toISOString(),
    }],
  };
}

// A third-party executor is deliberately not part of the v1 mutation contract.
// @ts-expect-error v1 contains only board mutations
export const forbiddenCommand: BoardMutation['command'] = { kind: 'action.execute', command: 'publish' };
