import {
  composeSpaceGlow,
  isHostActivityRecord,
  type SpaceAttention,
  type SpaceGlow,
  type SpaceWorking,
} from "../../../../src/shared/space-attention";

/**
 * Current-space activity light: contract, composition and poller.
 *
 * The host reports two raw facts about the native space this client runs in
 * (`workbenchGuide/hostActivity`), composed via shared `composeSpaceGlow`:
 *
 *   attention "required"                  -> "attention" (yellow, always wins)
 *   attention "none"    + working "busy"  -> "working"   (green)
 *   everything else, including unknown     -> null        (no light)
 */
export type HostAttention = SpaceAttention;
export type HostWorking = SpaceWorking;
export interface HostActivityReport { attention: HostAttention; working: HostWorking }
/** The one presentation value: no light, green, or yellow. */
export type HostGlow = SpaceGlow;

/** Same cadence as the native directory refresh. */
export const HOST_ACTIVITY_POLL_MS = 1500;
/** Bounded read deadline so a hung transport cannot keep an old light alive. */
export const HOST_ACTIVITY_READ_TIMEOUT_MS = 5000;

/** Strict parser: a closed shape with closed values, or `null`. */
export function parseHostActivity(value: unknown): HostActivityReport | null {
  return isHostActivityRecord(value) ? { attention: value.attention, working: value.working } : null;
}

/** Compose the single light. Yellow first; green only for a known-quiet attention. */
export function composeHostGlow(report: HostActivityReport | null): HostGlow {
  return report ? composeSpaceGlow(report.attention, report.working) : null;
}

export interface HostActivityTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
const browserTimers: HostActivityTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Sequential poller. One read in flight at most; the next read is scheduled
 * only after the previous one settled.
 */
export class HostActivityPoller {
  private timer: unknown;
  private deadline: unknown;
  private inflight: AbortController | undefined;
  private running = false;
  private epoch = 0;
  private glow: HostGlow = null;
  constructor(
    private read: (signal: AbortSignal) => Promise<unknown>,
    private apply: (glow: HostGlow) => void,
    private timers: HostActivityTimers = browserTimers,
    private intervalMs = HOST_ACTIVITY_POLL_MS,
    private readTimeoutMs = HOST_ACTIVITY_READ_TIMEOUT_MS,
  ) {}
  get active(): boolean { return this.running; }
  start = (): void => {
    if (this.running) return;
    this.running = true;
    const epoch = ++this.epoch;
    void this.tick(epoch);
  };
  stop = (): void => {
    if (!this.running) return;
    this.running = false;
    this.epoch++;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.deadline !== undefined) this.timers.clearTimeout(this.deadline);
    this.deadline = undefined;
    this.inflight?.abort();
    this.inflight = undefined;
    this.set(null);
  };
  private set(glow: HostGlow): void {
    if (glow === this.glow) return;
    this.glow = glow;
    this.apply(glow);
  }
  private async tick(epoch: number): Promise<void> {
    const controller = new AbortController();
    this.inflight = controller;
    let glow: HostGlow = null;
    let deadline: unknown;
    try {
      const report = await new Promise<unknown>((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("The host activity read was aborted.")), { once: true });
        deadline = this.deadline = this.timers.setTimeout(() => {
          reject(new Error("The host activity read did not finish before its deadline."));
          controller.abort();
        }, this.readTimeoutMs);
        try { this.read(controller.signal).then(resolve, reject); } catch (cause) { reject(cause); }
      });
      glow = composeHostGlow(parseHostActivity(report));
    } catch { glow = null; }
    finally {
      if (deadline !== undefined) this.timers.clearTimeout(deadline);
      if (this.deadline === deadline) this.deadline = undefined;
      if (this.inflight === controller) this.inflight = undefined;
    }
    if (!this.running || epoch !== this.epoch) return;
    this.set(glow);
    this.timer = this.timers.setTimeout(() => { void this.tick(epoch); }, this.intervalMs);
  }
}
