import type { WorkbenchState } from "../../../../src/shared/workbench";
import type { WorkbenchStartupFailure, WorkbenchStartupStatus } from "../../../../src/shared/workbench-startup";

/** One startup read, including its response body, never waits longer than this. */
export const STARTUP_READ_CAP_MS = 5_000;

export const STARTUP_EPOCH_MISMATCH = "The supervisor service epoch changed during startup observation.";
export const STARTUP_READY_INCONSISTENT = "Startup status reported ready, but the manager is not running.";
export const STARTUP_READ_FAILED = "The startup observation could not be read.";
export const STARTUP_READ_TIMEOUT = "The startup observation did not finish before its deadline.";

/**
 * Node-side reader for startup observation.
 * Wire arguments stay empty. A WorkbenchApi whose methods take no arguments
 * is assignable here; the optional signal is process-local and is not sent.
 */
export type StartupObservationReader = {
  state: (signal?: AbortSignal) => Promise<WorkbenchState>;
  startupStatus: (signal?: AbortSignal) => Promise<WorkbenchStartupStatus>;
};

export class StartupReadTimeoutError extends Error {
  readonly name = "StartupReadTimeoutError";
  constructor() {
    super(STARTUP_READ_TIMEOUT);
  }
}

export function startupReadBudget(remainingMs: number | undefined, capMs = STARTUP_READ_CAP_MS): number {
  const remaining = remainingMs === undefined ? capMs : remainingMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(capMs, remaining);
}

/**
 * Settle one observation even when the callee ignores AbortSignal.
 * The same signal is aborted at the deadline. The timer is cleared in finally,
 * and a late rejection is observed so it cannot surface as unhandled.
 */
export async function observeStartupRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  remainingMs: number | undefined,
): Promise<T> {
  const budget = startupReadBudget(remainingMs);
  if (budget <= 0) throw new StartupReadTimeoutError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const work = read(controller.signal);
  void work.then(() => undefined, () => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (settled) return;
          controller.abort();
          reject(new StartupReadTimeoutError());
        }, budget);
      }),
    ]);
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Known public text only. Raw transport errors and secrets stay out. */
export function publicObservationReason(error: unknown): string {
  if (error instanceof StartupReadTimeoutError) return STARTUP_READ_TIMEOUT;
  return remoteFailure(error)?.message ?? STARTUP_READ_FAILED;
}

/** Keep primary and cleanup as separate public strings. Do not slice them together. */
export function startupFailureReasons(status: WorkbenchStartupStatus): string[] {
  const reasons: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0 || reasons.includes(value)) return;
    reasons.push(value);
  };
  for (const reason of status.reasons) add(reason);
  add(status.failure?.primaryReason);
  add(status.failure?.cleanupReason);
  if (reasons.length === 0) reasons.push("The supervisor startup failed.");
  return reasons;
}

/** Already-read startup facts. Callers must not issue another request to fill this in. */
export interface StartupTerminalNotice {
  /** Copied from an already-read startup status. Null when that read had no structured failure. */
  failure: WorkbenchStartupFailure | null;
  reasons: string[];
  serviceEpoch: string | null;
  managerId: string | null;
  status: WorkbenchStartupStatus | null;
}

export type StartupWatchEvent =
  | { kind: "state"; state: WorkbenchState }
  | { kind: "status"; status: WorkbenchStartupStatus }
  | ({ kind: "terminal" } & StartupTerminalNotice);

export type StartupWatch = (event: StartupWatchEvent) => void;

function remoteFailure(error: unknown): { code: string; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const row = error as { isDSHRemoteError?: unknown; code?: unknown; message?: unknown };
  if (row.isDSHRemoteError !== true || typeof row.code !== "string") return null;
  const message = typeof row.message === "string" && row.message.trim() ? row.message : STARTUP_READ_FAILED;
  return { code: row.code, message };
}
