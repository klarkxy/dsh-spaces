import type {
  BoardMutation, DashboardQuery, InstanceRef, Limits, Placement, PublicationPlanInput,
  PublicationSelection, PublishAck, PublisherHeartbeat, PublishRequest, WidgetInstance, WidgetType,
} from '../../../shared/dashboard.js';
import { DashboardFault, invalid, limit } from './errors.js';
import { DASHBOARD_LIMITS, MAX_JSON_DEPTH } from './limits.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = Record<string, unknown>;
const encoder = new TextEncoder();
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

function unicode(text: string, field: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(field);
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid(field);
  }
}

export function byteLength(text: string): number { return encoder.encode(text).byteLength; }

/** Reject duplicate decoded keys before JSON.parse could silently overwrite them. */
export function parseStrictJson(input: string | Uint8Array, maxBytes = DASHBOARD_LIMITS.maxRequestBytes): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) invalid('maxBytes');
  let text: string;
  if (typeof input === 'string') {
    limit(input.length, maxBytes, 'body');
    unicode(input, 'body');
    limit(byteLength(input), maxBytes, 'body');
    text = input;
  } else if (input instanceof Uint8Array) {
    limit(input.byteLength, maxBytes, 'body');
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { return invalid('body'); }
  } else return invalid('body');
  let at = 0;
  const whitespace = () => { while (at < text.length && /[\x20\t\r\n]/.test(text[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') { at++; continue; }
      if (char === '"') {
        let result: string;
        try { result = JSON.parse(text.slice(start, at)) as string; }
        catch { return invalid('body'); }
        unicode(result, 'body');
        return result;
      }
    }
    return invalid('body');
  };
  const value = (depth: number): Json => {
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      if (depth >= MAX_JSON_DEPTH) invalid('body.depth');
      const array = char === '[';
      const closing = array ? ']' : '}';
      at++;
      const result: Json[] | Record<string, Json> = array ? [] : Object.create(null) as Record<string, Json>;
      const keys = new Set<string>();
      whitespace();
      if (text[at] === closing) { at++; return result; }
      while (at < text.length) {
        whitespace();
        if (array) (result as Json[]).push(value(depth + 1));
        else {
          if (text[at] !== '"') invalid('body');
          const key = string();
          if (keys.has(key)) invalid('body.duplicate-key');
          keys.add(key);
          whitespace();
          if (text[at++] !== ':') invalid('body');
          (result as Record<string, Json>)[key] = value(depth + 1);
        }
        whitespace();
        if (text[at] === closing) { at++; return result; }
        if (text[at++] !== ',') invalid('body');
      }
      return invalid('body');
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, at)) { at += token.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    if (!number) return invalid('body');
    at += number[0].length;
    const result = Number(number[0]);
    if (!Number.isFinite(result)) invalid('body');
    return Object.is(result, -0) ? 0 : result;
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) invalid('body');
  return result;
}

/** Only plain JSON data crosses the boundary. Never call getters or toJSON. */
function jsonData(input: unknown, seen: Set<object>, depth: number): Json {
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'string') { unicode(input, 'body'); return input; }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) invalid('body');
    return Object.is(input, -0) ? 0 : input;
  }
  if (!input || typeof input !== 'object' || seen.has(input) || depth >= MAX_JSON_DEPTH) return invalid('body');
  const prototype = Object.getPrototypeOf(input);
  if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) invalid('body');
  if (Object.getOwnPropertySymbols(input).length) invalid('body');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  seen.add(input);
  let result: Json;
  if (Array.isArray(input)) {
    if (Object.keys(descriptors).length !== input.length + 1) invalid('body');
    const values: Json[] = [];
    for (let i = 0; i < input.length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) invalid('body');
      values.push(jsonData(descriptor.value, seen, depth + 1));
    }
    result = values;
  } else {
    const values: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const key of Object.keys(descriptors).sort()) {
      unicode(key, 'body');
      const descriptor = descriptors[key];
      if (!own(descriptor, 'value') || !descriptor.enumerable) invalid('body');
      values[key] = jsonData(descriptor.value, seen, depth + 1);
    }
    result = values;
  }
  seen.delete(input);
  return result;
}

export function canonicalJson(input: unknown): string {
  return JSON.stringify(jsonData(input, new Set(), 0));
}
export function copyJson<T>(input: T): T { return JSON.parse(canonicalJson(input)) as T; }
function bounded(input: unknown, maximum: number): unknown {
  const text = canonicalJson(input);
  limit(byteLength(text), maximum, 'body');
  return JSON.parse(text) as unknown;
}
export function object(input: unknown, required: string[], optional: string[] = [], field = 'body'): Row {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid(field);
  const row = input as Row;
  for (const key of required) if (!own(row, key)) invalid(field);
  for (const key of Object.keys(row)) if (!required.includes(key) && !optional.includes(key)) invalid(field);
  return row;
}
function text(input: unknown, maximum: number, field: string, nonempty = true): string {
  if (typeof input !== 'string' || (nonempty && !input.trim().length)) return invalid(field);
  unicode(input, field);
  limit(Array.from(input).length, maximum, field);
  return input;
}
export function identifier(input: unknown, field = 'id'): string {
  const value = text(input, 128, field);
  if (/[\x00-\x1f\x7f-\x9f]/.test(value)) invalid(field);
  return value;
}
function integer(input: unknown, min: number, max: number, field: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) return invalid(field);
  return input;
}
function finite(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return invalid(field);
  return input;
}
function member<T extends string>(input: unknown, values: readonly T[], field: string): T {
  if (typeof input !== 'string' || !values.includes(input as T)) return invalid(field);
  return input as T;
}
function array(input: unknown, maximum: number, field: string, minimum = 0): unknown[] {
  if (!Array.isArray(input) || input.length < minimum) return invalid(field);
  limit(input.length, maximum, field);
  return input as unknown[];
}
function unique(values: unknown[], field: string): void {
  if (new Set(values.map(canonicalJson)).size !== values.length) invalid(field);
}
export function timestampMillis(input: unknown, field = 'timestamp'): number {
  if (typeof input !== 'string') return invalid(field);
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) return invalid(field);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) invalid(field);
  const result = Date.parse(input);
  if (!Number.isFinite(result)) invalid(field);
  return result;
}
function version(input: unknown): void {
  if (input !== 1) throw new DashboardFault('dashboard/unsupported-version');
}
function ref(input: unknown): InstanceRef {
  const row = object(input, ['spaceId', 'providerId', 'instanceId'], [], 'ref');
  identifier(row.spaceId, 'ref.spaceId'); identifier(row.providerId, 'ref.providerId'); identifier(row.instanceId, 'ref.instanceId');
  return row as unknown as InstanceRef;
}
export function refKey(value: InstanceRef): string { return JSON.stringify([value.spaceId, value.providerId, value.instanceId]); }

export function parseSelection(input: unknown): PublicationSelection | null {
  if (input === null) return null;
  const data = bounded(input, DASHBOARD_LIMITS.maxRequestBytes);
  const base = object(data, ['kind'], ['instanceIds'], 'selection');
  if (base.kind === 'all') object(base, ['kind'], [], 'selection');
  else if (base.kind === 'selected') {
    object(base, ['kind', 'instanceIds'], [], 'selection');
    const ids = array(base.instanceIds, 100, 'selection.instanceIds', 1);
    ids.forEach(id => identifier(id, 'selection.instanceIds')); unique(ids, 'selection.instanceIds');
  } else invalid('selection.kind');
  return base as unknown as PublicationSelection;
}

export function parseSnapshot(input: unknown, limits: Readonly<Limits> = DASHBOARD_LIMITS, referencedOnly = false): { types: WidgetType[]; instances: WidgetInstance[] } {
  const root = object(bounded(input, limits.maxPublishBytes), ['types', 'instances']);
  const types = array(root.types, limits.maxTypesPerProvider, 'types');
  const kinds = new Map<string, { version: number; kind: string }>();
  for (const inputType of types) {
    const type = object(inputType, ['typeId', 'version', 'kind', 'title'], [], 'types');
    const id = identifier(type.typeId, 'typeId');
    if (kinds.has(id)) invalid('types');
    const typeVersion = integer(type.version, 1, Number.MAX_SAFE_INTEGER, 'type.version');
    const kind = member(type.kind, ['progress', 'metric', 'list', 'markdown'], 'type.kind');
    text(type.title, 200, 'type.title'); kinds.set(id, { version: typeVersion, kind });
  }
  const instances = array(root.instances, limits.maxInstancesPerProvider, 'instances');
  const ids = new Set<string>();
  const referenced = new Set<string>();
  for (const inputInstance of instances) {
    const instance = object(inputInstance, ['instanceId', 'typeId', 'typeVersion', 'title', 'content', 'sourceTarget', 'updatedAt', 'staleAfterSeconds'], [], 'instance');
    const id = identifier(instance.instanceId, 'instanceId');
    if (ids.has(id)) invalid('instances');
    ids.add(id);
    const typeId = identifier(instance.typeId, 'instance.typeId');
    integer(instance.typeVersion, 1, Number.MAX_SAFE_INTEGER, 'instance.typeVersion');
    text(instance.title, 200, 'instance.title');
    const content = object(instance.content, ['kind'], ['value', 'max', 'unit', 'status', 'items', 'text'], 'content');
    limit(byteLength(canonicalJson(content)), limits.maxContentBytes, 'content');
    const type = kinds.get(typeId);
    if (!type || type.version !== instance.typeVersion || type.kind !== content.kind) invalid('instance.type');
    referenced.add(typeId);
    switch (content.kind) {
      case 'progress':
        object(content, ['kind', 'value', 'max', 'unit', 'status'], [], 'content');
        finite(content.value, 'content.value'); finite(content.max, 'content.max');
        if ((content.max as number) <= 0 || (content.value as number) < 0 || (content.value as number) > (content.max as number)) invalid('content.progress');
        text(content.unit, 32, 'content.unit', false);
        member(content.status, ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'], 'content.status'); break;
      case 'metric':
        object(content, ['kind', 'value', 'unit'], [], 'content');
        finite(content.value, 'content.value'); text(content.unit, 32, 'content.unit', false); break;
      case 'list': {
        object(content, ['kind', 'items'], [], 'content');
        const items = array(content.items, 100, 'content.items');
        const itemIds: string[] = [];
        for (const item of items) {
          const row = object(item, ['id', 'label', 'state'], [], 'content.items');
          itemIds.push(identifier(row.id, 'item.id')); text(row.label, 500, 'item.label');
          member(row.state, ['todo', 'doing', 'done', 'blocked'], 'item.state');
        }
        unique(itemIds, 'content.items'); break;
      }
      case 'markdown':
        object(content, ['kind', 'text'], [], 'content');
        text(content.text, limits.maxContentBytes, 'content.text', false);
        // This is not an HTML sanitizer. The renderer must still disable raw HTML and remote resources.
        if (/<(?:!--|!DOCTYPE\b|\?|\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*|\/?)>)/i.test(content.text as string)) invalid('content.text');
        break;
      default: invalid('content.kind');
    }
    if (instance.sourceTarget !== null) {
      const target = object(instance.sourceTarget, ['kind'], ['id'], 'sourceTarget');
      if (target.kind === 'space') object(target, ['kind'], [], 'sourceTarget');
      else {
        object(target, ['kind', 'id'], [], 'sourceTarget');
        member(target.kind, ['session', 'artifact'], 'sourceTarget.kind'); identifier(target.id, 'sourceTarget.id');
      }
    }
    timestampMillis(instance.updatedAt, 'updatedAt');
    if (instance.staleAfterSeconds !== null) integer(instance.staleAfterSeconds, 30, 86400, 'staleAfterSeconds');
  }
  if (referencedOnly && kinds.size !== referenced.size) invalid('types.unreferenced');
  return root as unknown as { types: WidgetType[]; instances: WidgetInstance[] };
}

export function parsePublishRequest(input: unknown, limits: Readonly<Limits> = DASHBOARD_LIMITS): PublishRequest {
  const row = object(bounded(input, Math.min(limits.maxPublishBytes, limits.maxRequestBytes)), ['protocolVersion', 'runId', 'providerId', 'sequence', 'grantRevision', 'types', 'instances']);
  version(row.protocolVersion); identifier(row.runId, 'runId'); identifier(row.providerId, 'providerId'); identifier(row.grantRevision, 'grantRevision');
  integer(row.sequence, 1, Number.MAX_SAFE_INTEGER, 'sequence');
  const snapshot = parseSnapshot({ types: row.types, instances: row.instances }, limits, true);
  return { ...row, ...snapshot } as unknown as PublishRequest;
}
export function parsePublishAck(input: unknown): PublishAck {
  const row = object(bounded(input, DASHBOARD_LIMITS.maxRequestBytes), ['protocolVersion', 'runId', 'providerId', 'sequence', 'receivedAt', 'accepted']);
  version(row.protocolVersion); identifier(row.runId, 'runId'); identifier(row.providerId, 'providerId');
  integer(row.sequence, 1, Number.MAX_SAFE_INTEGER, 'sequence'); timestampMillis(row.receivedAt, 'receivedAt');
  if (row.accepted !== true) invalid('accepted');
  return row as unknown as PublishAck;
}
export function parseHeartbeat(input: unknown, limits: Readonly<Limits> = DASHBOARD_LIMITS): PublisherHeartbeat {
  const row = object(bounded(input, limits.maxRequestBytes), ['protocolVersion', 'runId', 'providers']);
  version(row.protocolVersion); identifier(row.runId, 'runId');
  const ids: string[] = [];
  for (const item of array(row.providers, limits.maxProvidersPerSpace, 'providers')) {
    const provider = object(item, ['providerId', 'lastSequence', 'state'], [], 'providers');
    ids.push(identifier(provider.providerId, 'providerId'));
    integer(provider.lastSequence, 0, Number.MAX_SAFE_INTEGER, 'lastSequence');
    member(provider.state, ['ready', 'failed'], 'state');
  }
  unique(ids, 'providers'); return row as unknown as PublisherHeartbeat;
}
export function parsePublicationPlan(input: unknown): PublicationPlanInput {
  const row = object(bounded(input, DASHBOARD_LIMITS.maxRequestBytes), ['kind', 'spaceId', 'providerId', 'expectedGrantRevision', 'selection']);
  if (row.kind !== 'dashboard.publication.set') throw new DashboardFault('dashboard/unsupported-operation');
  identifier(row.spaceId, 'spaceId'); identifier(row.providerId, 'providerId'); identifier(row.expectedGrantRevision, 'expectedGrantRevision');
  row.selection = parseSelection(row.selection); return row as unknown as PublicationPlanInput;
}

export function parseQuery(input: unknown, limits: Readonly<Limits> = DASHBOARD_LIMITS): DashboardQuery {
  const data = bounded(input, limits.maxRequestBytes);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid('query');
  const row = data as Row;
  switch (row.kind) {
    case 'overview': object(row, ['kind']); break;
    case 'catalog': {
      object(row, ['kind'], ['spaceIds', 'cursor', 'limit']);
      if (own(row, 'spaceIds')) { const ids = array(row.spaceIds, 100, 'spaceIds'); ids.forEach(id => identifier(id, 'spaceIds')); unique(ids, 'spaceIds'); }
      if (own(row, 'cursor')) text(row.cursor, 4096, 'cursor');
      if (own(row, 'limit')) integer(row.limit, 1, limits.maxCatalogPageSize, 'limit');
      break;
    }
    case 'instances': {
      object(row, ['kind', 'refs']); const refs = array(row.refs, limits.maxQueryRefs, 'refs', 1).map(ref); unique(refs.map(refKey), 'refs'); break;
    }
    case 'board': object(row, ['kind', 'boardId']); identifier(row.boardId, 'boardId'); break;
    case 'receipt': object(row, ['kind', 'requestId']); identifier(row.requestId, 'requestId'); break;
    case 'navigation': object(row, ['kind', 'ref']); ref(row.ref); break;
    case 'publications': object(row, ['kind', 'spaceId']); identifier(row.spaceId, 'spaceId'); break;
    default: throw new DashboardFault('dashboard/unsupported-operation');
  }
  return row as unknown as DashboardQuery;
}

export function parsePlacements(input: unknown, limits: Readonly<Limits> = DASHBOARD_LIMITS): Placement[] {
  const values = array(input, limits.maxPlacementsPerBoard, 'placements');
  const ids: string[] = [];
  const parsed: Placement[] = [];
  for (const value of values) {
    const row = object(value, ['id', 'ref', 'x', 'y', 'w', 'h'], [], 'placement');
    ids.push(identifier(row.id, 'placement.id')); ref(row.ref);
    const x = integer(row.x, 0, 11, 'placement.x'), y = integer(row.y, 0, 9999, 'placement.y');
    const w = integer(row.w, 1, 12, 'placement.w'), h = integer(row.h, 1, 10000, 'placement.h');
    if (x + w > 12 || y + h > 10000) invalid('placement.bounds');
    for (const previous of parsed) {
      if (x < previous.x + previous.w && previous.x < x + w && y < previous.y + previous.h && previous.y < y + h) invalid('placements.overlap');
    }
    parsed.push(row as unknown as Placement);
  }
  unique(ids, 'placements'); return parsed;
}
export function parseBoardMutation(input: unknown, limits: Readonly<Limits> = DASHBOARD_LIMITS): BoardMutation {
  const row = object(bounded(input, limits.maxRequestBytes), ['requestId', 'issuedAt', 'backendEpoch', 'command']);
  identifier(row.requestId, 'requestId'); identifier(row.backendEpoch, 'backendEpoch'); timestampMillis(row.issuedAt, 'issuedAt');
  if (!row.command || typeof row.command !== 'object' || Array.isArray(row.command)) return invalid('command');
  const command = row.command as Row;
  switch (command.kind) {
    case 'board.create': object(command, ['kind', 'boardId', 'title', 'placements'], [], 'command'); break;
    case 'board.replace': object(command, ['kind', 'boardId', 'expectedRevision', 'title', 'placements'], [], 'command'); break;
    case 'board.delete': object(command, ['kind', 'boardId', 'expectedRevision'], [], 'command'); break;
    default: throw new DashboardFault('dashboard/unsupported-operation');
  }
  identifier(command.boardId, 'boardId');
  if (command.kind !== 'board.create') identifier(command.expectedRevision, 'expectedRevision');
  if (command.kind !== 'board.delete') { text(command.title, 200, 'board.title'); parsePlacements(command.placements, limits); }
  return row as unknown as BoardMutation;
}
