import type { MaintenanceStatus } from "../../shared/upgrade";
import type { OperationLock } from "../ports/operation-lock";

/**
 * Process-wide maintenance mutex. `run` records the holder synchronously
 * before any await so a second caller in the same turn is rejected.
 * Admitted `runMutation` calls keep a count; a maintenance run waits for
 * that count to reach zero, and later mutations are rejected while held.
 *
 * An optional OperationLock serializes the admitted work across hosts.
 * With no lock, overlapping mutations (including different spaces) stay
 * allowed after local admission.
 */
export class MaintenanceGate {
  private holder: string | undefined;
  private inFlight = 0;
  private readonly drainWaiters: Array<() => void> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private readonly listeners = new Set<(status: MaintenanceStatus) => void>();

  constructor(private readonly lock?: OperationLock) {}

  get busy(): boolean {
    return this.holder !== undefined;
  }

  get current(): string | undefined {
    return this.holder;
  }

  get mutations(): number {
    return this.inFlight;
  }

  snapshot(): MaintenanceStatus {
    return { busy: this.busy, current: this.holder, mutations: this.inFlight };
  }

  onChange(listener: (status: MaintenanceStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run<T>(label: string, action: () => Promise<T>): Promise<T> {
    const name = label.trim();
    if (!name) throw new Error("Maintenance label is required");
    if (this.holder !== undefined) {
      throw new Error(`Cannot start ${name}: maintenance already running (${this.holder})`);
    }
    this.holder = name;
    this.emit();
    const body = async () => {
      await this.waitForMutations();
      return await action();
    };
    return this.throughLock(name, body, () => {
      this.holder = undefined;
      this.emit();
      this.wake();
    });
  }

  runMutation<T>(action: () => Promise<T>): Promise<T> {
    if (this.holder !== undefined) {
      throw new Error(`Cannot mutate while maintenance is running (${this.holder})`);
    }
    this.inFlight += 1;
    this.emit();
    const body = async () => action();
    return this.throughLock("mutation", body, () => {
      this.inFlight -= 1;
      this.emit();
      this.wake();
    });
  }

  idle(): Promise<void> {
    if (this.holder === undefined && this.inFlight === 0) return Promise.resolve();
    return new Promise((resolveIdle) => {
      this.idleWaiters.push(resolveIdle);
    });
  }

  private throughLock<T>(label: string, body: () => Promise<T>, release: () => void): Promise<T> {
    try {
      const runBody = this.lock ? this.lock.run(label, body) : body();
      return Promise.resolve(runBody).finally(release);
    } catch (err) {
      release();
      throw err;
    }
  }

  private waitForMutations(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolveDrain) => {
      this.drainWaiters.push(resolveDrain);
    });
  }

  private wake(): void {
    if (this.inFlight === 0) {
      const drain = this.drainWaiters.splice(0);
      for (const waiter of drain) waiter();
    }
    if (this.holder === undefined && this.inFlight === 0) {
      const idle = this.idleWaiters.splice(0);
      for (const waiter of idle) waiter();
    }
  }

  private emit(): void {
    const status = this.snapshot();
    for (const listener of this.listeners) listener(status);
  }
}
