import type { Board, BoardMutation, BoardMutationReceipt, InstanceRef, Limits, Placement } from '../../../shared/dashboard.js';
import { DashboardFault, invalid, limit } from './errors.js';
import { DASHBOARD_LIMITS, RECEIPT_RETENTION_MS, REQUEST_WINDOW_MS } from './limits.js';
import {
  byteLength, canonicalJson, copyJson, identifier, object, parseBoardMutation,
  parseStrictJson, refKey, timestampMillis,
} from './validation.js';

export interface ReceiptRecord {
  subjectId: string;
  committedAt: string;
  request: BoardMutation;
  receipt: BoardMutationReceipt;
}
export interface LayoutDocument {
  schemaVersion: 1;
  boards: Board[];
  tombstones: Array<{ id: string; revision: string }>;
  receipts: ReceiptRecord[];
}
export interface LayoutContext {
  backendEpoch: string;
  subjectId: string;
  now: number;
  newRevision: string;
  /** Must consult current committed authorization inside the caller's single-writer critical section. */
  canRead(ref: InstanceRef): boolean;
}
export interface PreparedLayout {
  document: LayoutDocument;
  receipt: BoardMutationReceipt;
  changed: boolean;
}

/** New state is created explicitly. Never use this as a corrupt-file or read-error default. */
export function emptyLayout(): LayoutDocument { return { schemaVersion: 1, boards: [], tombstones: [], receipts: [] }; }

function board(input: unknown, limits: Readonly<Limits>): Board {
  const value = object(input, ['id', 'title', 'revision', 'placements'], [], 'board');
  identifier(value.id, 'board.id'); identifier(value.revision, 'board.revision');
  const checked = parseBoardMutation({ requestId: 'validation', backendEpoch: 'validation', issuedAt: '2026-01-01T00:00:00Z', command: {
    kind: 'board.create', boardId: value.id, title: value.title, placements: value.placements,
  } }, limits);
  if (checked.command.kind !== 'board.create') return invalid('board');
  return { id: checked.command.boardId, title: checked.command.title, revision: value.revision as string, placements: checked.command.placements };
}
function uniqueIds(ids: string[], field: string): void { if (new Set(ids).size !== ids.length) invalid(field); }

/** Strict disk decoder. The storage adapter must bound bytes before calling this. */
export function parseLayoutDocument(input: unknown, limits: Readonly<Limits> = DASHBOARD_LIMITS): LayoutDocument {
  const data = typeof input === 'string' || input instanceof Uint8Array ? parseStrictJson(input, limits.maxLayoutBytes) : input;
  const text = canonicalJson(data); limit(byteLength(text), limits.maxLayoutBytes, 'layout');
  const row = object(JSON.parse(text) as unknown, ['schemaVersion', 'boards', 'tombstones', 'receipts'], [], 'layout');
  if (row.schemaVersion !== 1) throw new DashboardFault('dashboard/unsupported-version');
  if (!Array.isArray(row.boards) || !Array.isArray(row.tombstones) || !Array.isArray(row.receipts)) return invalid('layout');
  limit(row.boards.length, limits.maxBoards, 'boards');
  limit(row.boards.length + row.tombstones.length, limits.maxBoardIds, 'boardIds');
  limit(row.receipts.length, limits.maxReceipts, 'receipts');
  const boards = (row.boards as unknown[]).map(value => board(value, limits));
  const tombstones = (row.tombstones as unknown[]).map(inputTombstone => {
    const value = object(inputTombstone, ['id', 'revision'], [], 'tombstone');
    return { id: identifier(value.id, 'tombstone.id'), revision: identifier(value.revision, 'tombstone.revision') };
  });
  uniqueIds([...boards, ...tombstones].map(value => value.id), 'boardIds');
  const receipts = (row.receipts as unknown[]).map(inputReceipt => {
    const value = object(inputReceipt, ['subjectId', 'committedAt', 'request', 'receipt'], [], 'receiptRecord');
    identifier(value.subjectId, 'subjectId'); timestampMillis(value.committedAt, 'committedAt');
    const request = parseBoardMutation(value.request, limits);
    const receipt = object(value.receipt, ['protocolVersion', 'backendEpoch', 'requestId', 'result'], [], 'receipt');
    if (receipt.protocolVersion !== 1 || receipt.backendEpoch !== request.backendEpoch || receipt.requestId !== request.requestId) invalid('receipt');
    if (!receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result)) return invalid('receipt.result');
    const result = receipt.result as Record<string, unknown>;
    if (result.kind === 'board.saved') {
      object(result, ['kind', 'board'], [], 'receipt.result');
      const saved = board(result.board, limits);
      if (request.command.kind === 'board.delete' || saved.id !== request.command.boardId || saved.title !== request.command.title || canonicalJson(saved.placements) !== canonicalJson(request.command.placements)) invalid('receipt.result');
      result.board = saved;
    } else if (result.kind === 'board.deleted') {
      object(result, ['kind', 'boardId', 'revision'], [], 'receipt.result');
      identifier(result.revision, 'receipt.revision');
      if (request.command.kind !== 'board.delete' || result.boardId !== request.command.boardId) invalid('receipt.result');
    } else invalid('receipt.result');
    return { subjectId: value.subjectId as string, committedAt: value.committedAt as string, request, receipt: receipt as unknown as BoardMutationReceipt };
  });
  uniqueIds(receipts.map(value => value.request.requestId), 'receipts');
  return { schemaVersion: 1, boards, tombstones, receipts };
}

function visibleReceipt(receipt: BoardMutationReceipt, canRead: (ref: InstanceRef) => boolean): BoardMutationReceipt {
  const result = copyJson(receipt);
  if (result.result.kind === 'board.saved') result.result.board.placements = result.result.board.placements.filter(placement => canRead(copyJson(placement.ref)));
  return result;
}
export function readReceipt(
  document: LayoutDocument,
  requestId: string,
  context: Pick<LayoutContext, 'subjectId' | 'now' | 'canRead'>,
): BoardMutationReceipt | null {
  identifier(requestId, 'requestId');
  const found = document.receipts.find(value => value.request.requestId === requestId && value.subjectId === context.subjectId);
  if (!found || context.now - timestampMillis(found.committedAt) >= RECEIPT_RETENTION_MS) return null;
  return visibleReceipt(found.receipt, context.canRead);
}
function requireNewReferences(placements: Placement[], previous: Board | undefined, canRead: (ref: InstanceRef) => boolean): void {
  for (const placement of placements) {
    const old = previous?.placements.find(value => value.id === placement.id);
    if (old && refKey(old.ref) === refKey(placement.ref)) continue;
    if (!canRead(copyJson(placement.ref))) throw new DashboardFault('dashboard/not-found');
  }
}

/** Atomic-document reducer. Caller must persist document BEFORE exposing receipt. No IO, retries or side effects. */
export function prepareLayout(
  inputDocument: LayoutDocument,
  inputRequest: unknown,
  context: LayoutContext,
  limits: Readonly<Limits> = DASHBOARD_LIMITS,
): PreparedLayout {
  identifier(context.backendEpoch, 'backendEpoch'); identifier(context.subjectId, 'subjectId'); identifier(context.newRevision, 'newRevision');
  if (!Number.isFinite(context.now) || !Number.isFinite(new Date(context.now).getTime())) invalid('now');
  const request = parseBoardMutation(inputRequest, limits);
  if (request.backendEpoch !== context.backendEpoch) throw new DashboardFault('dashboard/stale-epoch');
  const document = parseLayoutDocument(inputDocument, limits);
  const known = document.receipts.find(value => value.request.requestId === request.requestId);
  if (known && context.now - timestampMillis(known.committedAt) < RECEIPT_RETENTION_MS) {
    if (known.subjectId !== context.subjectId || canonicalJson(known.request) !== canonicalJson(request)) throw new DashboardFault('dashboard/request-conflict');
    return { document, receipt: visibleReceipt(known.receipt, context.canRead), changed: false };
  }
  if (Math.abs(context.now - timestampMillis(request.issuedAt)) > REQUEST_WINDOW_MS) throw new DashboardFault('dashboard/request-expired');
  // Pruning is part of this NEW successful write candidate, never a read-side mutation.
  document.receipts = document.receipts.filter(value => context.now - timestampMillis(value.committedAt) < RECEIPT_RETENTION_MS);
  if (document.receipts.length >= limits.maxReceipts) throw new DashboardFault('dashboard/unavailable');
  const command = request.command;
  const previous = document.boards.find(value => value.id === command.boardId);
  let result: BoardMutationReceipt['result'];
  if (command.kind === 'board.create') {
    if (previous || document.tombstones.some(value => value.id === command.boardId)) throw new DashboardFault('dashboard/revision-conflict');
    limit(document.boards.length + 1, limits.maxBoards, 'boards');
    limit(document.boards.length + document.tombstones.length + 1, limits.maxBoardIds, 'boardIds');
    requireNewReferences(command.placements, undefined, context.canRead);
    const saved: Board = { id: command.boardId, title: command.title, revision: context.newRevision, placements: copyJson(command.placements) };
    document.boards.push(saved); result = { kind: 'board.saved', board: copyJson(saved) };
  } else {
    if (!previous || previous.revision !== command.expectedRevision) throw new DashboardFault('dashboard/revision-conflict');
    if (context.newRevision === previous.revision) invalid('newRevision');
    if (command.kind === 'board.replace') {
      requireNewReferences(command.placements, previous, context.canRead);
      previous.title = command.title; previous.placements = copyJson(command.placements); previous.revision = context.newRevision;
      result = { kind: 'board.saved', board: copyJson(previous) };
    } else {
      document.boards = document.boards.filter(value => value.id !== command.boardId);
      document.tombstones.push({ id: command.boardId, revision: context.newRevision });
      result = { kind: 'board.deleted', boardId: command.boardId, revision: context.newRevision };
    }
  }
  const receipt: BoardMutationReceipt = { protocolVersion: 1, backendEpoch: context.backendEpoch, requestId: request.requestId, result };
  document.receipts.push({ subjectId: context.subjectId, committedAt: new Date(context.now).toISOString(), request, receipt: copyJson(receipt) });
  limit(byteLength(canonicalJson(document)), limits.maxLayoutBytes, 'layout');
  return { document, receipt: visibleReceipt(receipt, context.canRead), changed: true };
}
