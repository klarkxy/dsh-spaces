/** Private owned-child IPC protocol. No browser or management API. */
export const BUS_CHANNEL = 'dsh-spaces:bus:1';
export const BUS_MAX_BYTES = 64 * 1024;
export const BUS_MAX_PENDING = 128;
export const BUS_MAX_TIMEOUT = 60_000;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type BusErrorCode = 'invalid-input' | 'target-unavailable' | 'operation-not-found' | 'unauthorized' | 'timeout' | 'disconnected' | 'overloaded' | 'operation-failed';
const codes = new Set<BusErrorCode>(['invalid-input', 'target-unavailable', 'operation-not-found', 'unauthorized', 'timeout', 'disconnected', 'overloaded', 'operation-failed']);
export class SpaceMessageError extends Error {
  constructor(readonly code: BusErrorCode) { super(`space-message/${code}`); this.name = 'SpaceMessageError'; }
}
export function busIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
/** Reject lossy JSON (undefined, NaN, sparse arrays, prototypes, cycles), then detach. */
export function busJson(value: unknown): JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 16384 || depth > 32) throw new SpaceMessageError('invalid-input');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || !v || seen.has(v)) throw new SpaceMessageError('invalid-input');
    const prototype = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new SpaceMessageError('invalid-input');
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Object.getOwnPropertySymbols(v).length) throw new SpaceMessageError('invalid-input');
    if (Array.isArray(v) && (v.length > 16384 || Object.keys(v).length !== v.length ||
      Object.keys(v).some((key, index) => key !== String(index)))) throw new SpaceMessageError('invalid-input');
    for (const [key, d] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!d.enumerable || !('value' in d)) throw new SpaceMessageError('invalid-input');
      visit(d.value, depth + 1);
    }
    seen.delete(v);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > BUS_MAX_BYTES) throw new SpaceMessageError('invalid-input');
  return JSON.parse(json);
}
export type BusRequest = { channel: typeof BUS_CHANNEL; kind: 'request'; requestId: string; target: string; operation: string; params: JsonValue; timeoutMs: number };
export type BusInvoke = { channel: typeof BUS_CHANNEL; kind: 'invoke'; requestId: string; source: string; operation: string; params: JsonValue; timeoutMs: number };
export type BusResponse = { channel: typeof BUS_CHANNEL; kind: 'response'; requestId: string; ok: true; value: JsonValue } | { channel: typeof BUS_CHANNEL; kind: 'response'; requestId: string; ok: false; error: BusErrorCode };
export type BusMessage = BusRequest | BusInvoke | BusResponse;
export function parseBusMessage(raw: unknown): BusMessage | null {
  if (!raw || typeof raw !== 'object' || (raw as { channel?: unknown }).channel !== BUS_CHANNEL) return null;
  const v = busJson(raw) as Record<string, JsonValue>;
  if (!busIdentifier(v.requestId)) throw new SpaceMessageError('invalid-input');
  let keys: string[];
  if (v.kind === 'request' || v.kind === 'invoke') {
    keys = ['channel', 'kind', 'requestId', v.kind === 'request' ? 'target' : 'source', 'operation', 'params', 'timeoutMs'];
    if (!busIdentifier(v.operation) || !busIdentifier(v[v.kind === 'request' ? 'target' : 'source']) || !Number.isInteger(v.timeoutMs) || Number(v.timeoutMs) < 1 || Number(v.timeoutMs) > BUS_MAX_TIMEOUT) throw new SpaceMessageError('invalid-input');
  } else if (v.kind === 'response') {
    keys = ['channel', 'kind', 'requestId', 'ok', v.ok === true ? 'value' : 'error'];
    if (v.ok !== true && (v.ok !== false || !codes.has(v.error as BusErrorCode))) throw new SpaceMessageError('invalid-input');
  } else throw new SpaceMessageError('invalid-input');
  if (keys.length !== Object.keys(v).length || keys.some(k => !Object.hasOwn(v, k))) throw new SpaceMessageError('invalid-input');
  return v as unknown as BusMessage;
}
export function busFailure(requestId: string, error: BusErrorCode): BusResponse {
  return { channel: BUS_CHANNEL, kind: 'response', requestId, ok: false, error };
}
