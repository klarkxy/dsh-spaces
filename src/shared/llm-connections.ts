/** Public LLM error codes shared by supervisor, bridge activity, and job records. */

/**
 * Retired shared-connection codes remain declared so stored job records and
 * share scans that predate the 2026-11-05 retirement still parse. Only the
 * codes marked "produced" below are emitted by current code; the rest are
 * read-side tolerance for persisted evidence. Do not remove entries: job
 * record parsing accepts any of them (workbench-jobs/record.ts).
 */
export const LLM_ERROR = {
  REVISION_CONFLICT: "LLM_REVISION_CONFLICT",
  WRITE_OWNER_REQUIRED: "LLM_WRITE_OWNER_REQUIRED",
  CONFIG_INVALID: "LLM_CONFIG_INVALID", // produced: share-secret-scan
  UNSUPPORTED_RUNTIME: "LLM_UNSUPPORTED_RUNTIME",
  UNSUPPORTED_PROTOCOL: "LLM_UNSUPPORTED_PROTOCOL",
  ADAPTER_MISSING: "LLM_ADAPTER_MISSING",
  MODEL_NOT_FOUND: "LLM_MODEL_NOT_FOUND",
  CONNECTION_IN_USE: "LLM_CONNECTION_IN_USE",
  SHARED_CONNECTION_READ_ONLY: "LLM_SHARED_CONNECTION_READ_ONLY",
  MANAGED_ROUTE_CONFLICT: "LLM_MANAGED_ROUTE_CONFLICT",
  CREDENTIAL_MISSING: "LLM_CREDENTIAL_MISSING",
  CREDENTIAL_WRITE_FAILED: "LLM_CREDENTIAL_WRITE_FAILED",
  DISCOVERY_FAILED: "LLM_DISCOVERY_FAILED",
  SPACE_BUSY: "LLM_SPACE_BUSY", // produced: supervisor/llm.ts, view-bridge activity
  APPLY_FAILED: "LLM_APPLY_FAILED", // produced: supervisor/llm.ts
  RESULT_UNKNOWN: "LLM_RESULT_UNKNOWN",
} as const;

export type LlmErrorCode = (typeof LLM_ERROR)[keyof typeof LLM_ERROR];

export class LlmConfigError extends Error {
  readonly name = "LlmConfigError";
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly details: Record<string, string | number | undefined> = {},
  ) {
    super(message);
  }
}
