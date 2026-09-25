import type { Board, BoardCommand, CatalogEntry, DashboardBackend, DashboardQuery, DashboardQueryData, InstanceRef, InstanceView, Placement } from '../../../src/shared/dashboard.js';
import { DashboardFault, invalid, limit } from '../../../src/core/domain/dashboard/errors.js';
import { parseLayoutDocument } from '../../../src/core/domain/dashboard/boards.js';
import { byteLength, canonicalJson, copyJson, identifier, object, parseQuery, parseSnapshot, refKey, timestampMillis } from '../../../src/core/domain/dashboard/validation.js';

export interface DashboardFrame {
  backendEpoch: string;
  overview: Extract<DashboardQueryData, { kind: 'overview' }>;
  boardId: string;
  board: Board | null;
  items: InstanceView[];
  catalog: CatalogEntry[];
  moreCatalog: boolean;
}
/** HTTP adapters should honor the optional signal. In-process adapters cannot cancel a committed operation. */
export interface DashboardReadBackend extends DashboardBackend {
  query(request: DashboardQuery, signal?: AbortSignal): ReturnType<DashboardBackend['query']>;
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DashboardFault('dashboard/unavailable');
}
function choice(value: unknown, choices: string[], field: string): void {
  if (typeof value !== 'string' || !choices.includes(value)) invalid(field);
}
function boundedText(value: unknown, maximum: number, field: string): void {
  if (typeof value !== 'string' || Array.from(value).length > maximum) invalid(field);
}
function checkView(input: unknown, expected: InstanceRef): InstanceView {
  const value = object(input, ['state', 'ref'], ['instance', 'runId', 'sequence', 'receivedAt', 'freshness', 'sourceState', 'reason'], 'view');
  parseQuery({ kind: 'instances', refs: [value.ref] });
  if (canonicalJson(value.ref) !== canonicalJson(expected)) invalid('view.ref');
  if (value.state === 'unavailable') {
    object(value, ['state', 'ref', 'reason'], [], 'view');
    choice(value.reason, ['not-found', 'source-removed', 'unsupported'], 'view.reason');
  } else if (value.state === 'present') {
    object(value, ['state', 'ref', 'instance', 'runId', 'sequence', 'receivedAt', 'freshness', 'sourceState'], [], 'view');
    const instance = value.instance as Record<string, unknown> | null;
    if (!instance || typeof instance !== 'object' || !instance.content || typeof instance.content !== 'object') invalid('instance');
    const source = instance as Record<string, unknown>;
    parseSnapshot({ types: [{ typeId: source.typeId, version: source.typeVersion, kind: (source.content as Record<string, unknown>).kind, title: 'Display' }], instances: [instance] });
    if (source.instanceId !== expected.instanceId) invalid('instanceId');
    identifier(value.runId, 'runId'); timestampMillis(value.receivedAt, 'receivedAt');
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) invalid('sequence');
    choice(value.freshness, ['current', 'stale'], 'freshness');
    choice(value.sourceState, ['running', 'stopped', 'failed', 'unknown'], 'sourceState');
  } else invalid('view.state');
  return copyJson(value) as unknown as InstanceView;
}

/** One bounded read frame. No layout writes, process starts or business actions. */
export async function readDashboardFrame(backend: DashboardReadBackend, signal?: AbortSignal, selectedBoardId?: string): Promise<DashboardFrame> {
  let epoch: string | null = null;
  async function query<K extends DashboardQueryData['kind']>(request: DashboardQuery & { kind: K }): Promise<Extract<DashboardQueryData, { kind: K }>> {
    aborted(signal);
    const response = await backend.query(request, signal);
    aborted(signal);
    const encoded = canonicalJson(response); limit(byteLength(encoded), 8 * 1024 * 1024, 'response');
    const envelope = object(JSON.parse(encoded) as unknown, ['protocolVersion', 'backendEpoch', 'data']);
    if (envelope.protocolVersion !== 1) throw new DashboardFault('dashboard/unsupported-version');
    identifier(envelope.backendEpoch, 'backendEpoch');
    if (epoch !== null && epoch !== envelope.backendEpoch) throw new DashboardFault('dashboard/stale-epoch');
    epoch = envelope.backendEpoch as string;
    if (!envelope.data || typeof envelope.data !== 'object' || (envelope.data as { kind?: unknown }).kind !== request.kind) invalid('response.kind');
    return envelope.data as Extract<DashboardQueryData, { kind: K }>;
  }
  const overview = await query({ kind: 'overview' });
  object(overview, ['kind', 'mode', 'defaultBoardId', 'boards', 'sources', 'limits', 'capabilities']);
  choice(overview.mode, ['local', 'home'], 'mode'); identifier(overview.defaultBoardId, 'defaultBoardId');
  if (!Array.isArray(overview.boards) || overview.boards.length > 20 || !Array.isArray(overview.sources)) invalid('overview');
  for (const board of overview.boards) {
    object(board, ['id', 'title', 'revision']); identifier(board.id); identifier(board.revision); boundedText(board.title, 200, 'title');
  }
  object(overview.capabilities, ['layoutWrite', 'publicationsManage', 'executeActions']);
  if (typeof overview.capabilities.layoutWrite !== 'boolean' || typeof overview.capabilities.publicationsManage !== 'boolean' || overview.capabilities.executeActions !== false) invalid('capabilities');
  if (!Number.isSafeInteger(overview.limits?.maxQueryRefs) || overview.limits.maxQueryRefs < 1 || overview.limits.maxQueryRefs > 50) invalid('limits');
  const boardId = identifier(selectedBoardId ?? overview.defaultBoardId, 'boardId');
  const boardData = await query({ kind: 'board', boardId });
  object(boardData, ['kind', 'board']);
  const board = boardData.board === null ? null : parseLayoutDocument({ schemaVersion: 1, boards: [boardData.board], tombstones: [], receipts: [] }).boards[0];
  if (board !== null && board.id !== boardId) invalid('boardId');
  const catalogData = await query({ kind: 'catalog', limit: 100 });
  object(catalogData, ['kind', 'entries', 'catalogRevision', 'nextCursor']);
  identifier(catalogData.catalogRevision, 'catalogRevision');
  if (!Array.isArray(catalogData.entries) || catalogData.entries.length > 100) invalid('catalog');
  if (catalogData.nextCursor !== null && typeof catalogData.nextCursor !== 'string') invalid('cursor');
  for (const entry of catalogData.entries) {
    object(entry, ['ref', 'typeId', 'typeVersion', 'kind', 'title', 'sourceState']); parseQuery({ kind: 'instances', refs: [entry.ref] });
    identifier(entry.typeId); boundedText(entry.title, 200, 'title');
    if (!Number.isSafeInteger(entry.typeVersion) || entry.typeVersion < 1) invalid('typeVersion');
    choice(entry.kind, ['progress', 'metric', 'list', 'markdown'], 'kind');
    choice(entry.sourceState, ['running', 'stopped', 'failed', 'unknown'], 'sourceState');
  }
  const refs = [...new Map((board?.placements ?? []).map(placement => [refKey(placement.ref), placement.ref])).values()];
  const items: InstanceView[] = [];
  for (let offset = 0; offset < refs.length; offset += overview.limits.maxQueryRefs) {
    const batch = refs.slice(offset, offset + overview.limits.maxQueryRefs);
    const response = await query({ kind: 'instances', refs: batch });
    object(response, ['kind', 'items']);
    if (!Array.isArray(response.items) || response.items.length !== batch.length) invalid('items');
    items.push(...response.items.map((item, index) => checkView(item, batch[index])));
  }
  aborted(signal);
  return { backendEpoch: epoch!, overview, boardId, board, items, catalog: catalogData.entries, moreCatalog: catalogData.nextCursor !== null };
}

export function pinCommand(frame: DashboardFrame, ref: InstanceRef, placementId: string): BoardCommand {
  parseQuery({ kind: 'instances', refs: [ref] }); identifier(placementId);
  const placements = copyJson(frame.board?.placements ?? []);
  limit(placements.length + 1, Math.min(200, frame.overview.limits.maxPlacementsPerBoard), 'placements');
  let position: { x: number; y: number } | null = null;
  for (let y = 0; y <= 9998 && !position; y++) {
    for (const x of [0, 6]) {
      if (!placements.some(p => x < p.x + p.w && p.x < x + 6 && y < p.y + p.h && p.y < y + 2)) { position = { x, y }; break; }
    }
  }
  if (!position) throw new DashboardFault('dashboard/limit-exceeded');
  placements.push({ id: placementId, ref: copyJson(ref), ...position, w: 6, h: 2 });
  return frame.board ? { kind: 'board.replace', boardId: frame.board.id, expectedRevision: frame.board.revision, title: frame.board.title, placements } : { kind: 'board.create', boardId: frame.boardId, title: '工作首页', placements };
}
export function unpinCommand(frame: DashboardFrame, placementId: string): BoardCommand {
  if (!frame.board || !frame.board.placements.some(p => p.id === placementId)) throw new DashboardFault('dashboard/not-found');
  return { kind: 'board.replace', boardId: frame.board.id, expectedRevision: frame.board.revision, title: frame.board.title, placements: frame.board.placements.filter(p => p.id !== placementId) };
}
export function moveCommand(frame: DashboardFrame, placementId: string, position: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): BoardCommand {
  if (!frame.board || !frame.board.placements.some(p => p.id === placementId)) throw new DashboardFault('dashboard/not-found');
  const board = { ...frame.board, placements: frame.board.placements.map(p => p.id === placementId ? { ...p, ...position } : p) };
  parseLayoutDocument({ schemaVersion: 1, boards: [board], tombstones: [], receipts: [] });
  return { kind: 'board.replace', boardId: board.id, expectedRevision: board.revision, title: board.title, placements: board.placements };
}
