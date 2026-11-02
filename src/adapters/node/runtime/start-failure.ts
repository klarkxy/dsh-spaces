import { sanitizeLogText } from "../diagnostics/diagnostics";
import { redactPublicReason } from "../../../shared/public-reason";
import type { WorkbenchStartupFailure, WorkbenchStartupStatus } from "../../../shared/workbench-startup";

const PUBLIC_REASON_LIMIT = 220;

/** Sanitized public text. Placeholders from the existing redactors are kept. */
export function publicReason(value: unknown, fallback = "The start failed."): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const sanitized = redactPublicReason(sanitizeLogText(raw), PUBLIC_REASON_LIMIT).trim();
  return sanitized || fallback;
}

/**
 * A start that failed, plus a second cleanup fault.
 * The original exception stays on `cause` and is not a wire field.
 */
export class StartFailureError extends Error {
  readonly stage: string;
  readonly primaryReason: string;
  readonly cleanupReason: string;
  readonly instanceRetained: boolean;

  constructor(input: { stage: string; cause: unknown; cleanup: unknown; instanceRetained: boolean }) {
    const primaryReason = publicReason(input.cause);
    // A thrown `undefined` has no message. Keep that text so it is not mistaken for a missing cleanup.
    const cleanupReason = input.cleanup === undefined ? "undefined" : publicReason(input.cleanup, "Cleanup failed.");
    super(`${primaryReason} Cleanup: ${cleanupReason}`, { cause: input.cause });
    this.name = "StartFailureError";
    this.stage = input.stage;
    this.primaryReason = primaryReason;
    this.cleanupReason = cleanupReason;
    this.instanceRetained = input.instanceRetained;
  }
}

export function startupFailureFrom(error: unknown, stage: string): WorkbenchStartupFailure {
  if (error instanceof StartFailureError) {
    return {
      stage: error.stage || stage,
      primaryReason: error.primaryReason,
      cleanupReason: error.cleanupReason,
      instanceRetained: error.instanceRetained,
    };
  }
  return {
    stage,
    primaryReason: publicReason(error),
    instanceRetained: false,
  };
}

export function publishStartupFailure(failure: WorkbenchStartupFailure): WorkbenchStartupFailure {
  const primaryReason = publicReason(failure.primaryReason);
  const cleanupReason = failure.cleanupReason ? publicReason(failure.cleanupReason, "Cleanup failed.") : undefined;
  const stage = publicReason(failure.stage, "prepare").slice(0, 64);
  return {
    stage,
    primaryReason,
    ...(cleanupReason ? { cleanupReason } : {}),
    instanceRetained: failure.instanceRetained === true,
  };
}

function publicManagerId(id: string | null): string | null {
  if (!id) return null;
  if (id === "web" || /^[a-z0-9][a-z0-9-]{0,38}$/.test(id)) return id;
  return null;
}

/** Re-sanitize every public field so a later slice cannot drop the second reason. */
export function publishStartupStatus(status: WorkbenchStartupStatus): WorkbenchStartupStatus {
  const reasons: string[] = [];
  for (const reason of status.reasons) {
    const line = publicReason(reason, "");
    if (line && !reasons.includes(line)) reasons.push(line);
  }
  let failure = status.failure ? publishStartupFailure(status.failure) : null;
  if (status.phase === "failed" && !failure) {
    failure = publishStartupFailure({
      stage: "prepare",
      primaryReason: reasons[0] || "The start failed.",
      instanceRetained: false,
    });
  }
  if (status.phase !== "failed") failure = null;
  if (failure?.cleanupReason && !reasons.includes(`Cleanup: ${failure.cleanupReason}`)) {
    reasons.push(`Cleanup: ${failure.cleanupReason}`);
  }
  const serviceEpoch = /^(?:[a-f0-9]{64})?$/.test(status.serviceEpoch) ? status.serviceEpoch : "";
  return {
    serviceEpoch,
    managerId: publicManagerId(status.managerId),
    phase: status.phase,
    reasons: reasons.slice(0, 32),
    failure,
  };
}
