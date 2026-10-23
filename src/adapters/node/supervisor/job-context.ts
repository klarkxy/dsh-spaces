import type { WorkbenchJobContext } from "../maintenance/workbench-jobs";

/**
 * A job context for work the supervisor runs on its own behalf, outside a
 * submitted job. It reports no phase, message, cancellation or result.
 */
export function silentJobContext(): WorkbenchJobContext {
  return {
    signal: new AbortController().signal,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}
