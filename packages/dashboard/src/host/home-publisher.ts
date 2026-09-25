import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { PublishRequest, PublisherGrant } from '../../../../src/shared/dashboard.js';
import { HomePublisher, PublicationChannel } from '../../../../src/core/domain/dashboard/provider.js';
import { DashboardFault, publicError } from '../../../../src/core/domain/dashboard/errors.js';
import { canonicalJson, identifier, object, parsePublishAck, parseSelection, parseStrictJson, timestampMillis } from '../../../../src/core/domain/dashboard/validation.js';

export const DASHBOARD_BOOTSTRAP_ENV = 'DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE';
export interface PublisherBootstrap { protocolVersion: 1; origin: string; runId: string; bearer: string }
export function readPublisherBootstrap(path: string): PublisherBootstrap {
  if (process.platform === 'win32') throw new DashboardFault('dashboard/unsupported-operation');
  if (!isAbsolute(path)) throw new DashboardFault('dashboard/invalid-input');
  let parent = dirname(resolve(path));
  for (;;) {
    const s = lstatSync(parent); if (!s.isDirectory() || s.isSymbolicLink()) throw new DashboardFault('dashboard/forbidden');
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  const directory = lstatSync(dirname(path));
  if (directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) throw new DashboardFault('dashboard/forbidden');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new DashboardFault('dashboard/forbidden');
    const bytes = Buffer.alloc(8193); let total = 0;
    for (;;) { const n = readSync(fd, bytes, total, bytes.length - total, null); if (!n) break; total += n; if (total > 8192) throw new DashboardFault('dashboard/limit-exceeded'); }
    const row = object(parseStrictJson(bytes.subarray(0, total), 8192), ['protocolVersion', 'origin', 'runId', 'bearer']);
    const origin = new URL(String(row.origin));
    if (row.protocolVersion !== 1 || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== row.origin || origin.username || origin.password || !/^\d+$/.test(origin.port)) throw new DashboardFault('dashboard/forbidden');
    identifier(row.runId); if (typeof row.bearer !== 'string' || !/^[a-f0-9]{64}$/.test(row.bearer)) throw new DashboardFault('dashboard/invalid-input');
    return row as unknown as PublisherBootstrap;
  } finally { closeSync(fd); }
}
interface Pending { provider: string | null; work(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }
const providerErrors = new Set(['invalid-input', 'stale-grant', 'stale-sequence', 'sequence-conflict', 'limit-exceeded', 'forbidden'].map(code => 'dashboard/' + code));
const errors = new Set([...providerErrors, 'dashboard/stale-run', 'dashboard/unauthenticated', 'dashboard/unsupported-version', 'dashboard/unsupported-operation', 'dashboard/rate-limited', 'dashboard/storage-failed', 'dashboard/unavailable']);

/** One run, fair first-send scheduling. Failed requests are never put back in the queue. */
export class DashboardHomePublisher {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = false;
  private failure: DashboardFault | null = null;
  private lastRequest = -Infinity;
  private readonly lastProvider = new Map<string, number>();
  private readonly providers = new Map<string, HomePublisher>();
  private readonly sequences = new Map<string, number>();
  private readonly failedProviders = new Set<string>();
  private controller: AbortController | null = null;
  private readonly channel: PublicationChannel;
  private constructor(private readonly bootstrap: PublisherBootstrap, private readonly grants: PublisherGrant['grants'], private readonly fetchImpl: typeof fetch) {
    this.channel = new PublicationChannel(async (request, signal) => {
      if (signal.aborted) throw new DashboardFault('dashboard/unavailable');
      const ack = parsePublishAck(await this.call('publish', request, signal));
      if (ack.providerId !== request.providerId || ack.runId !== request.runId || ack.sequence !== request.sequence) throw new DashboardFault('dashboard/invalid-input');
      this.sequences.set(request.providerId, ack.sequence); return ack;
    });
  }
  static async open(path: string, fetchImpl: typeof fetch = fetch): Promise<DashboardHomePublisher> {
    const bootstrap = readPublisherBootstrap(path);
    const temporary = new DashboardHomePublisher(bootstrap, [], fetchImpl);
    try {
      const raw = await temporary.call('grant');
      const grant = object(raw, ['protocolVersion', 'runId', 'spaceId', 'grants']);
      if (grant.protocolVersion !== 1 || grant.runId !== bootstrap.runId || !Array.isArray(grant.grants) || grant.grants.length > 32) throw new DashboardFault('dashboard/invalid-input');
      identifier(grant.spaceId);
      const seen = new Set<string>();
      for (const item of grant.grants) {
        const g = object(item, ['providerId', 'revision', 'selection']);
        const providerId = identifier(g.providerId), revision = identifier(g.revision), selection = parseSelection(g.selection);
        if (!selection || seen.has(providerId)) throw new DashboardFault('dashboard/invalid-input');
        seen.add(providerId); temporary.grants.push({ providerId, revision, selection });
      }
      temporary.lastRequest = Date.now(); temporary.armHeartbeat(); return temporary;
    } catch (error) { temporary.close(); throw error; }
  }
  forProvider(providerId: string): HomePublisher {
    identifier(providerId);
    const known = this.providers.get(providerId); if (known) return known;
    if (this.providers.size >= 32) throw new DashboardFault('dashboard/limit-exceeded');
    const grant = this.grants.find(g => g.providerId === providerId);
    const schedule = (work: () => Promise<unknown>) => this.enqueue(providerId, work);
    class ScheduledPublisher extends HomePublisher {
      override async publish(input: Parameters<HomePublisher['publish']>[0]): Promise<Awaited<ReturnType<HomePublisher['publish']>>> {
        try {
          // Scheduling precedes PublicationChannel's 5-second transport timeout.
          // A cold provider must not time out merely because other providers had turns.
          return await schedule(async () => {
            const result = await super.publish(input);
            if (result.state === 'failed') throw new DashboardFault(result.error.code);
            return result;
          }) as Awaited<ReturnType<HomePublisher['publish']>>;
        } catch (error) { return { state: 'failed', error: publicError(error) }; }
      }
    }
    const publisher = new ScheduledPublisher({ runId: this.bootstrap.runId, providerId, grantRevision: grant?.revision ?? 'absent', selection: grant?.selection ?? null }, this.channel);
    this.providers.set(providerId, publisher); return publisher;
  }
  private enqueue(provider: string | null, work: () => Promise<unknown>): Promise<unknown> {
    if (this.stopped || this.failure) return Promise.reject(this.failure ?? new DashboardFault('dashboard/unavailable'));
    if (provider !== null && this.failedProviders.has(provider)) return Promise.reject(new DashboardFault('dashboard/unavailable'));
    if (this.queue.length >= 33) return Promise.reject(new DashboardFault('dashboard/rate-limited'));
    return new Promise((resolve, reject) => { this.queue.push({ provider, work, resolve, reject }); this.drain(); });
  }
  private drain(): void {
    if (this.busy || this.timer || this.stopped || this.failure || !this.queue.length) return;
    const now = Date.now();
    const readyAt = (p: Pending) => Math.max(this.lastRequest + 250, p.provider === null ? 0 : (this.lastProvider.get(p.provider) ?? -Infinity) + 1000);
    let index = this.queue.findIndex(p => readyAt(p) <= now);
    if (index < 0) {
      const delay = Math.max(1, Math.min(...this.queue.map(readyAt)) - now);
      this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, delay); return;
    }
    const pending = this.queue.splice(index, 1)[0]; this.busy = true; this.lastRequest = now;
    if (pending.provider !== null) this.lastProvider.set(pending.provider, now);
    void pending.work().then(value => {
      // Space requests from acknowledgement time, not only send-start time:
      // variable loopback latency must not trip the receiver's one-second window.
      this.lastRequest = Date.now();
      if (pending.provider !== null) this.lastProvider.set(pending.provider, this.lastRequest);
      pending.resolve(value);
    }, error => {
      const fault = error instanceof DashboardFault ? error : new DashboardFault('dashboard/unavailable');
      if (pending.provider !== null && providerErrors.has(fault.code)) {
        this.failedProviders.add(pending.provider);
        const removed = this.queue.filter(p => p.provider === pending.provider); this.queue = this.queue.filter(p => p.provider !== pending.provider);
        for (const item of removed) item.reject(fault);
      } else this.fail(fault);
      pending.reject(fault);
    }).finally(() => { this.busy = false; this.drain(); });
  }
  private async call(path: 'grant' | 'publish' | 'heartbeat', body?: unknown, outer?: AbortSignal): Promise<unknown> {
    if (this.stopped || this.failure || outer?.aborted) throw this.failure ?? new DashboardFault('dashboard/unavailable');
    const controller = new AbortController(); this.controller = controller;
    const abort = () => controller.abort(); outer?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 5000);
    try {
      const response = await this.fetchImpl(`${this.bootstrap.origin}/internal/dashboard/v1/${path}`, {
        method: path === 'grant' ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.bootstrap.bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: canonicalJson(body) }),
      });
      const reader = response.body?.getReader(); if (!reader) throw new DashboardFault('dashboard/invalid-input');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 65536) { await reader.cancel(); throw new DashboardFault('dashboard/limit-exceeded'); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks); const result = parseStrictJson(bytes, 65536);
      if (!response.ok) {
        const row = object(result, ['protocolVersion', 'error']), error = object(row.error, ['code', 'message'], ['details', 'requestId']);
        if (row.protocolVersion !== 1 || typeof error.code !== 'string' || !errors.has(error.code)) throw new DashboardFault('dashboard/invalid-input');
        throw new DashboardFault(error.code as ConstructorParameters<typeof DashboardFault>[0]);
      }
      if (this.stopped || controller.signal.aborted) throw new DashboardFault('dashboard/unavailable');
      return result;
    } catch (error) { throw error instanceof DashboardFault ? error : new DashboardFault('dashboard/unavailable'); }
    finally { clearTimeout(timeout); outer?.removeEventListener('abort', abort); if (this.controller === controller) this.controller = null; }
  }
  private armHeartbeat(): void {
    if (this.stopped || this.failure) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      void this.enqueue(null, async () => {
        const providers = [...this.providers].filter(([id]) => this.grants.some(g => g.providerId === id)).map(([providerId, p]) => ({ providerId, lastSequence: this.sequences.get(providerId) ?? 0, state: p.healthy ? 'ready' : 'failed' }));
        const value = object(await this.call('heartbeat', { protocolVersion: 1, runId: this.bootstrap.runId, providers }), ['protocolVersion', 'receivedAt']);
        if (value.protocolVersion !== 1) throw new DashboardFault('dashboard/unsupported-version'); timestampMillis(value.receivedAt); return value;
      }).then(() => this.armHeartbeat(), error => this.fail(error instanceof DashboardFault ? error : new DashboardFault('dashboard/unavailable')));
    }, 15000);
  }
  private fail(error: DashboardFault): void { this.failure ??= error; this.close(); }
  close(): void {
    this.stopped = true; this.channel.close(); this.controller?.abort();
    if (this.timer) clearTimeout(this.timer); if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.timer = this.heartbeatTimer = undefined;
    for (const item of this.queue.splice(0)) item.reject(this.failure ?? new DashboardFault('dashboard/unavailable'));
  }
}
