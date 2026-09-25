import type { DashboardError } from '../../../shared/dashboard.js';
import { DashboardFault, publicError } from './errors.js';
import { timers, type TimerPort } from './provider.js';

export type ReadSessionState = 'opening' | 'active' | 'failed' | 'closed';
export interface ReadSessionOptions<T> {
  /** Must decode and validate the response before resolving. Must honor AbortSignal. */
  read(signal: AbortSignal): Promise<T>;
  onValue(value: T): void;
  onFailure(error: DashboardError): void;
  clearSensitive(): void;
  timer?: TimerPort;
}

/** One page-read lifetime. Failure is terminal; a new page creates a new session. */
export class DashboardReadSession<T> {
  private current: ReadSessionState = 'opening';
  private started = false;
  private controller: AbortController | null = null;
  private pollTimer: unknown;
  private timeout: unknown;
  private expiry: unknown;
  private readonly timer: TimerPort;
  constructor(private readonly options: ReadSessionOptions<T>) { this.timer = options.timer ?? timers; }
  get state(): ReadSessionState { return this.current; }
  start(): void {
    if (this.current === 'failed' || this.current === 'closed') throw new DashboardFault('dashboard/unavailable');
    if (this.started) return;
    this.started = true;
    this.read();
  }
  private clearTimers(): void {
    for (const timer of [this.pollTimer, this.timeout, this.expiry]) if (timer !== undefined) this.timer.clear(timer);
    this.pollTimer = this.timeout = this.expiry = undefined;
  }
  private fail(error: unknown): void {
    if (this.current === 'failed' || this.current === 'closed') return;
    this.current = 'failed';
    this.clearTimers(); this.controller?.abort(); this.controller = null;
    const exposed = publicError(error);
    if (exposed.code === 'dashboard/unauthenticated' || exposed.code === 'dashboard/forbidden') this.options.clearSensitive();
    else this.expiry = this.timer.set(() => { this.expiry = undefined; this.options.clearSensitive(); }, 60_000);
    this.options.onFailure(exposed);
  }
  private read(): void {
    if (this.current === 'failed' || this.current === 'closed') return;
    const controller = new AbortController();
    this.controller = controller;
    this.timeout = this.timer.set(() => this.fail(new DashboardFault('dashboard/unavailable')), 5000);
    void Promise.resolve().then(() => {
      if (this.controller !== controller || controller.signal.aborted) throw new DashboardFault('dashboard/unavailable');
      return this.options.read(controller.signal);
    }).then(value => {
      if (this.controller !== controller || controller.signal.aborted || this.current === 'failed' || this.current === 'closed') return;
      if (this.timeout !== undefined) this.timer.clear(this.timeout);
      this.timeout = undefined; this.controller = null;
      this.current = 'active'; this.options.onValue(value);
      if (this.current !== 'active') return;
      this.pollTimer = this.timer.set(() => { this.pollTimer = undefined; this.read(); }, 2000);
    }).catch(error => this.fail(error));
  }
  close(): void {
    if (this.current === 'closed') return;
    this.current = 'closed'; this.clearTimers(); this.controller?.abort(); this.controller = null;
    this.options.clearSensitive();
  }
}
