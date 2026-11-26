/**
 * Current-space activity light: contract, composition and poller.
 *
 * The host reports two raw facts about the native space this client runs in
 * (`workbenchGuide/hostActivity`). This module is the only place that turns
 * them into one presentation value:
 *
 *   attention "required"                  -> "attention" (yellow, always wins)
 *   attention "none"    + working "busy"  -> "working"   (green)
 *   everything else, including unknown     -> null        (no light)
 *
 * Green needs attention to be a known "none": while a pending approval cannot
 * be ruled out, no green is shown. Nothing is guessed and nothing is kept: a
 * failed read, a malformed report or a stopped poller all clear the light.
 * The poller is a plain status refresh. It never reconnects, retries early or
 * recovers; it asks again at the normal cadence and reports what it got.
 */
export type HostAttention = "required" | "none" | "unknown";
export type HostWorking = "busy" | "idle" | "unknown";
export interface HostActivityReport { attention: HostAttention; working: HostWorking }
/** The one presentation value: no light, green, or yellow. */
export type HostGlow = "working" | "attention" | null;

/** Same cadence as the native directory refresh. */
export const HOST_ACTIVITY_POLL_MS = 1500;
/**
 * Deadline of one read. No client-side RPC deadline exists to reuse (the 30s
 * constants in the repository are host-side call limits); a read that has not
 * answered in five seconds is already stale for a light that refreshes every
 * 1.5s, so it is aborted and the light is withdrawn.
 */
export const HOST_ACTIVITY_READ_TIMEOUT_MS = 5000;

/** Strict parser: a closed shape with closed values, or `null`. */
export function parseHostActivity(value: unknown): HostActivityReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 2 || !keys.includes("attention") || !keys.includes("working")) return null;
  if (row.attention !== "required" && row.attention !== "none" && row.attention !== "unknown") return null;
  if (row.working !== "busy" && row.working !== "idle" && row.working !== "unknown") return null;
  return { attention: row.attention, working: row.working };
}

/** Compose the single light. Yellow first; green only for a known-quiet attention. */
export function composeHostGlow(report: HostActivityReport | null): HostGlow {
  if (!report) return null;
  if (report.attention === "required") return "attention";
  if (report.attention === "none" && report.working === "busy") return "working";
  return null;
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
 * only after the previous one settled. Every read is bounded and abortable:
 *
 *  - it gets its own `AbortSignal` and a `readTimeoutMs` deadline, and it is
 *    raced against both, so a transport that never settles or ignores the
 *    signal cannot keep an old light alive;
 *  - a deadline, an abort, a rejection or a malformed report all read as no
 *    light, and the next read still waits the ordinary cadence (a timeout is
 *    never an early retry);
 *  - `stop()` aborts the read in flight, cancels the cadence and clears the
 *    light through `apply(null)` at once. Whatever an older read does later,
 *    including settling after a new `start()`, is dropped by its epoch.
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
