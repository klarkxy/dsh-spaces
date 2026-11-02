import type { WorkbenchStartupFailure, WorkbenchStartupPhase, WorkbenchStartupStatus } from "../../../shared/workbench-startup";
import { publicReason, publishStartupStatus, StartFailureError, startupFailureFrom } from "../runtime/start-failure";

export interface SupervisorStartupView {
  serviceEpoch: string;
  managerId: string | null;
}

export interface SupervisorStartupFailOptions {
  /** Live process after a non-StartFailureError. A StartFailureError keeps its own flag. */
  instanceRetained?: boolean;
  reasons?: readonly string[];
}

/**
 * Initial supervisor startup. Preparing until the first real manager start.
 * Failed stays failed. A snapshot is a published copy and does not change the record.
 */
export class SupervisorStartup {
  private phase: WorkbenchStartupPhase = "preparing";
  private reasons: string[] = [];
  private failure: WorkbenchStartupFailure | null = null;

  starting(): void {
    if (this.phase !== "preparing") return;
    this.phase = "starting";
  }

  ready(): void {
    if (this.phase !== "starting") return;
    this.phase = "ready";
    this.failure = null;
    this.reasons = [];
  }

  fail(cause: unknown, stage: string, options: SupervisorStartupFailOptions = {}): void {
    if (this.phase === "failed" || this.phase === "ready") return;
    const failure = startupFailureFrom(cause, stage);
    if (!(cause instanceof StartFailureError) && options.instanceRetained === true) {
      failure.instanceRetained = true;
    }
    const reasons: string[] = [];
    const push = (value: string) => {
      const line = publicReason(value, "");
      if (line && !reasons.includes(line)) reasons.push(line);
    };
    push(failure.primaryReason);
    if (failure.cleanupReason) push(`Cleanup: ${failure.cleanupReason}`);
    for (const reason of options.reasons ?? []) push(reason);
    this.phase = "failed";
    this.failure = {
      stage: failure.stage,
      primaryReason: failure.primaryReason,
      ...(failure.cleanupReason ? { cleanupReason: failure.cleanupReason } : {}),
      instanceRetained: failure.instanceRetained === true,
    };
    this.reasons = reasons;
  }

  /** Append a later public fault without changing the latched cause or calling it cleanup. */
  note(reason: unknown): void {
    if (this.phase !== "failed") return;
    const line = publicReason(reason, "");
    if (!line || this.reasons.includes(line)) return;
    this.reasons.push(line);
  }

  snapshot(view: SupervisorStartupView): WorkbenchStartupStatus {
    const failure = this.failure
      ? {
          stage: this.failure.stage,
          primaryReason: this.failure.primaryReason,
          ...(this.failure.cleanupReason !== undefined ? { cleanupReason: this.failure.cleanupReason } : {}),
          instanceRetained: this.failure.instanceRetained,
        }
      : null;
    return publishStartupStatus({
      serviceEpoch: view.serviceEpoch,
      managerId: view.managerId,
      phase: this.phase,
      reasons: this.reasons.slice(),
      failure,
    });
  }
}
