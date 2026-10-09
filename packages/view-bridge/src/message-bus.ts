import { randomUUID } from 'node:crypto';
import { BUS_CHANNEL, BUS_MAX_PENDING, BUS_MAX_TIMEOUT, BUS_MAX_OPERATIONS, BUS_CAPABILITIES_OPERATION, capabilityDescription, parseSpaceCapabilities, SpaceMessageError, busFailure, busIdentifier, busJson, parseBusMessage,
  type BusMessage, type JsonValue, type SpaceCapabilityDeclaration, type SpaceCapability } from '../../../src/shared/space-message-bus.ts';

export interface SpaceMessageTransport {
  readonly connected: boolean;
  send?(message: unknown, callback: (error: Error | null) => void): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
export type SpaceOperation = (params: JsonValue, caller: Readonly<{ spaceId: string }>) => JsonValue | Promise<JsonValue>;
type Operation = { description: string; allowed: ReadonlySet<string>; handler: SpaceOperation };
/** Host-only API with permission-filtered static declarations. No eval, retry or reconnect. */
export class SpaceMessageBus {
  private closed = false;
  private executing = 0;
  private readonly operations = new Map<string, Operation>();
  private readonly pending = new Map<string, { resolve(value: JsonValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly active = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly transport: SpaceMessageTransport = process) {
    if (!transport.connected || !transport.send) throw new SpaceMessageError('disconnected');
    transport.on('message', this.receive);
    transport.on('disconnect', this.close);
  }
  get pendingCount(): number { return this.pending.size; }
  get activeCount(): number { return this.active.size; }
  /** Each operation is opt-in for exact source spaces, denied by default. */
  handle(operation: string, allowedSpaces: readonly string[], handler: SpaceOperation, declaration: SpaceCapabilityDeclaration = { description: '' }): () => void {
    if (this.closed) throw new SpaceMessageError('disconnected');
    if (!busIdentifier(operation) || !Array.isArray(allowedSpaces) || allowedSpaces.length > 128 || allowedSpaces.some(id => !busIdentifier(id)) || typeof handler !== 'function' || this.operations.has(operation)) throw new SpaceMessageError('invalid-input');
    if (operation === BUS_CAPABILITIES_OPERATION) throw new SpaceMessageError('invalid-input');
    if (this.operations.size >= BUS_MAX_OPERATIONS) throw new SpaceMessageError('overloaded');
    const entry = { allowed: new Set(allowedSpaces), handler, description: capabilityDescription(declaration) };
    this.operations.set(operation, entry);
    return () => { if (this.operations.get(operation) === entry) this.operations.delete(operation); };
  }
  /** Query this target only; it discloses operations authorized for this source session. */
  async capabilities(target: string, timeoutMs?: number): Promise<SpaceCapability[]> {
    return parseSpaceCapabilities(await this.request(target, BUS_CAPABILITIES_OPERATION, null, timeoutMs));
  }
  async request(target: string, operation: string, params: JsonValue, timeoutMs = 10_000): Promise<JsonValue> {
    if (this.closed || !this.transport.connected) throw new SpaceMessageError('disconnected');
    if (!busIdentifier(target) || !busIdentifier(operation) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BUS_MAX_TIMEOUT) throw new SpaceMessageError('invalid-input');
    const requestId = randomUUID();
    const message = parseBusMessage({ channel: BUS_CHANNEL, kind: 'request', requestId, target, operation, params, timeoutMs })!;
    if (this.pending.size >= BUS_MAX_PENDING) throw new SpaceMessageError('overloaded');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(requestId, 'timeout'), timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(message, () => this.reject(requestId, 'disconnected'));
    });
  }
  private reject(id: string, code: ConstructorParameters<typeof SpaceMessageError>[0]): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer); p.reject(new SpaceMessageError(code));
  }
  private send(message: BusMessage, failed?: () => void): void {
    if (this.closed || !this.transport.connected) { failed?.(); return; }
    try { this.transport.send!(message, error => { if (error) failed?.(); }); } catch { failed?.(); }
  }
  private receive = (raw: unknown): void => {
    if (this.closed) return;
    let message;
    try { message = parseBusMessage(raw); } catch { return; }
    if (!message) return;
    if (message.kind === 'response') {
      const p = this.pending.get(message.requestId);
      if (!p) return;
      this.pending.delete(message.requestId); clearTimeout(p.timer);
      if (message.ok) p.resolve(message.value); else p.reject(new SpaceMessageError(message.error));
      return;
    }
    if (message.kind !== 'invoke') return;
    const { requestId } = message;
    if (message.operation === BUS_CAPABILITIES_OPERATION) {
      if (message.params !== null) { this.send(busFailure(requestId, 'invalid-input')); return; }
      const value = [...this.operations.entries()].filter(([, op]) => op.allowed.has(message.source))
        .map(([operation, op]) => ({ operation, description: op.description }))
        .sort((a, b) => a.operation.localeCompare(b.operation));
      // Bounded static declarations fit in one ordinary response. No registry or broadcast.
      this.send({ channel: BUS_CHANNEL, kind: 'response', requestId, ok: true, value });
      return;
    }
    const operation = this.operations.get(message.operation);
    if (!operation) { this.send(busFailure(requestId, 'operation-not-found')); return; }
    if (!operation.allowed.has(message.source)) { this.send(busFailure(requestId, 'unauthorized')); return; }
    if (this.executing >= BUS_MAX_PENDING || this.active.has(requestId)) { this.send(busFailure(requestId, 'overloaded')); return; }
    // Expiry releases bookkeeping only. It cannot undo or guarantee cancellation of a handler.
    const timer = setTimeout(() => this.active.delete(requestId), message.timeoutMs);
    this.active.set(requestId, timer);
    this.executing++;
    void Promise.resolve().then(() => {
      if (this.closed || !this.active.has(requestId)) throw new SpaceMessageError('disconnected');
      return operation.handler(message.params, Object.freeze({ spaceId: message.source }));
    }).then(value => {
      if (!this.active.has(requestId) || this.closed) return;
      const response = parseBusMessage({ channel: BUS_CHANNEL, kind: 'response', requestId, ok: true, value: busJson(value) })!;
      this.send(response);
    }).catch(() => {
      if (this.active.has(requestId) && !this.closed) this.send(busFailure(requestId, 'operation-failed'));
    }).finally(() => { this.executing--; clearTimeout(timer); this.active.delete(requestId); });
  };
  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.transport.off('message', this.receive); this.transport.off('disconnect', this.close);
    for (const id of this.pending.keys()) this.reject(id, 'disconnected');
    for (const timer of this.active.values()) clearTimeout(timer);
    this.active.clear(); this.operations.clear();
  };
}
export { SpaceMessageError, type JsonValue, type SpaceCapability, type SpaceCapabilityDeclaration } from '../../../src/shared/space-message-bus.ts';
