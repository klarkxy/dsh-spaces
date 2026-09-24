import type {
  BoundProviderRegistry, LocalPublishResult, ProviderHandle, ProviderRegistration,
  PublicationSelection, PublishRequest, WidgetInstance, WidgetType,
} from '../../../shared/dashboard.js';
import { DashboardFault, publicError } from './errors.js';
import { copyJson, identifier, parsePublishAck, parsePublishRequest, parseSelection, parseSnapshot } from './validation.js';

type Snapshot = { types: WidgetType[]; instances: WidgetInstance[] };
type HomeResult = LocalPublishResult['home'];
export interface TimerPort {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
export const timers: TimerPort = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Own one already-authorized run. The Host supplies the transport; this module discovers no credentials. */
export class PublicationChannel {
  private failure: HomeResult & { state: 'failed' } | null = null;
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  constructor(
    private readonly send: (request: PublishRequest, signal: AbortSignal) => Promise<unknown>,
    private readonly timer: TimerPort = timers,
  ) {}
  get error(): HomeResult & { state: 'failed' } | null {
    return this.failure ? copyJson(this.failure) : this.closed ? { state: 'failed', error: publicError(new DashboardFault('dashboard/unavailable')) } : null;
  }
  async request(request: PublishRequest): Promise<unknown> {
    if (this.failure || this.closed) throw new DashboardFault('dashboard/unavailable');
    const controller = new AbortController();
    this.controllers.add(controller);
    let timeout: unknown;
    let removeAbort: (() => void) | undefined;
    try {
      const timeoutOrAbort = new Promise<never>((_resolve, reject) => {
        const aborted = () => reject(new DashboardFault('dashboard/unavailable'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        removeAbort = () => controller.signal.removeEventListener('abort', aborted);
        timeout = this.timer.set(() => controller.abort(), 5000);
      });
      const result = await Promise.race([Promise.resolve().then(() => {
        if (this.failure || this.closed || controller.signal.aborted) throw new DashboardFault('dashboard/unavailable');
        return this.send(copyJson(request), controller.signal);
      }), timeoutOrAbort]);
      if (this.failure || this.closed || controller.signal.aborted) throw new DashboardFault('dashboard/unavailable');
      return result;
    } catch (error) {
      const code = publicError(error).code;
      const providerOnly = ['dashboard/invalid-input', 'dashboard/stale-grant', 'dashboard/stale-sequence', 'dashboard/sequence-conflict', 'dashboard/limit-exceeded', 'dashboard/forbidden'];
      if (!providerOnly.includes(code)) {
        this.failure ??= { state: 'failed', error: publicError(error) };
        for (const active of this.controllers) active.abort();
      }
      throw error;
    } finally {
      if (timeout !== undefined) this.timer.clear(timeout);
      removeAbort?.(); this.controllers.delete(controller);
    }
  }
  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}

/** Bound provider session. No caller-supplied spaceId and no automatic grant refresh. */
export class HomePublisher {
  private sequence = 0;
  private failed: HomeResult & { state: 'failed' } | null = null;
  private busy = false;
  private readonly selection: PublicationSelection | null;
  constructor(
    private readonly binding: { runId: string; providerId: string; grantRevision: string; selection: PublicationSelection | null },
    private readonly channel: PublicationChannel,
  ) {
    identifier(binding.runId, 'runId'); identifier(binding.providerId, 'providerId'); identifier(binding.grantRevision, 'grantRevision');
    this.binding = copyJson(binding);
    this.selection = parseSelection(binding.selection);
  }
  get healthy(): boolean { return this.failed === null && this.channel.error === null; }
  async publish(input: Snapshot): Promise<HomeResult> {
    if (this.failed) return copyJson(this.failed);
    if (this.channel.error) return this.channel.error;
    if (this.selection === null) return { state: 'not-authorized' };
    if (this.busy) throw new DashboardFault('dashboard/unavailable');
    this.busy = true;
    try {
      const snapshot = parseSnapshot(input);
      const selection = this.selection;
      const instances = snapshot.instances.filter(instance => selection.kind === 'all' || selection.instanceIds.includes(instance.instanceId));
      const used = new Set(instances.map(instance => instance.typeId));
      const types = snapshot.types.filter(type => used.has(type.typeId));
      const request = parsePublishRequest({
        protocolVersion: 1, runId: this.binding.runId, providerId: this.binding.providerId,
        sequence: this.sequence + 1, grantRevision: this.binding.grantRevision, types, instances,
      });
      const ack = parsePublishAck(await this.channel.request(request));
      if (ack.runId !== request.runId || ack.providerId !== request.providerId || ack.sequence !== request.sequence) throw new DashboardFault('dashboard/invalid-input');
      this.sequence = request.sequence;
      return { state: 'published', sequence: this.sequence };
    } catch (error) {
      this.failed = { state: 'failed', error: publicError(error) };
      return copyJson(this.failed);
    } finally { this.busy = false; }
  }
}

export interface ProviderLocalPort {
  /** Must return only after the validated local snapshot is committed. */
  commit(snapshot: Snapshot): Promise<string>;
  /** Unregisters this display provider, never deletes source business data. */
  remove(): Promise<void>;
}
type Pending = { promise: Promise<LocalPublishResult>; resolve(value: LocalPublishResult): void; reject(reason: unknown): void };
function pending(): Pending {
  let resolve!: Pending['resolve'], reject!: Pending['reject'];
  const promise = new Promise<LocalPublishResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Trusted Host factory. Supply one bound instance per real plugin context, not a global caller-selectable registry. */
export function createBoundProviderRegistry(local: ProviderLocalPort, home: HomePublisher | null = null): BoundProviderRegistry {
  let registered = false;
  return {
    register(registration: ProviderRegistration): ProviderHandle {
      if (registered) throw new DashboardFault('dashboard/request-conflict');
      if (typeof registration.snapshot !== 'function') throw new DashboardFault('dashboard/invalid-input');
      const types = parseSnapshot({ types: registration.types, instances: [] }).types;
      registered = true;
      let active: Pending | null = null;
      let queued: Pending | null = null;
      let closed = false;
      let localFailure: DashboardFault | null = null;
      let disposing: Promise<void> | null = null;
      const start = (slot: Pending): void => {
        active = slot;
        void (async () => {
          try {
            // Defer the callback so a reentrant caller sees the active slot.
            const instances = await Promise.resolve().then(() => registration.snapshot());
            const snapshot = parseSnapshot({ types, instances });
            const localRevision = identifier(await local.commit(copyJson(snapshot)), 'localRevision');
            const homeResult: HomeResult = home ? await home.publish(snapshot) : { state: 'not-configured' };
            slot.resolve({ localRevision, home: homeResult });
          } catch (error) {
            localFailure = error instanceof DashboardFault ? error : new DashboardFault('dashboard/unavailable');
            slot.reject(localFailure);
          } finally {
            active = null;
            const next = queued; queued = null;
            if (next) {
              if (closed || localFailure) next.reject(localFailure ?? new DashboardFault('dashboard/unavailable'));
              else start(next);
            }
          }
        })();
      };
      return {
        publish(): Promise<LocalPublishResult> {
          if (closed || localFailure) return Promise.reject(localFailure ?? new DashboardFault('dashboard/unavailable'));
          if (active) {
            queued ??= pending();
            return queued.promise;
          }
          const slot = pending(); start(slot); return slot.promise;
        },
        dispose(): Promise<void> {
          if (disposing) return disposing;
          closed = true;
          if (queued) { queued.reject(new DashboardFault('dashboard/unavailable')); queued = null; }
          const current = active?.promise;
          disposing = (async () => {
            let failure: unknown = null;
            try { if (current) await current; } catch (error) { failure = error; }
            try {
              if (!localFailure && home?.healthy) {
                const result = await home.publish({ types: [], instances: [] });
                if (result.state === 'failed') failure ??= new DashboardFault(result.error.code);
              }
            } catch (error) { failure ??= error; }
            try { await local.remove(); } catch (error) { failure ??= error; }
            // The binding itself is not reused in this lifetime; unloading needs a new Host context.
            if (failure) throw failure instanceof DashboardFault ? failure : new DashboardFault('dashboard/unavailable');
          })();
          return disposing;
        },
      };
    },
  };
}
