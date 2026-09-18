declare module "@deepseek-ai/dsh-typert-protocol/types" {
  interface RemoteErrorDetailsMap {
    "spaces/read-only": {};
    "spaces/host-denied": {};
    "spaces/invalid-input": {};
    "spaces/not-found": {};
    "spaces/already-exists": {};
    "spaces/locked": {};
    "spaces/unavailable": {};
    "workbench/invalid-input": {};
    "workbench/not-found": {};
    "workbench/conflict": {};
    "workbench/locked": {};
    "workbench/unavailable": {};
    "workbench/unsupported": {};
    "workbench/recovery-required": {};
    "workbench/read-only": {};
    "workbench/forbidden": {};
    "workbench/not-cancellable": {};
    LLM_REVISION_CONFLICT: {};
    LLM_WRITE_OWNER_REQUIRED: {};
    LLM_CONFIG_INVALID: {};
    LLM_UNSUPPORTED_RUNTIME: {};
    LLM_UNSUPPORTED_PROTOCOL: {};
    LLM_ADAPTER_MISSING: {};
    LLM_MODEL_NOT_FOUND: {};
    LLM_CONNECTION_IN_USE: {};
    LLM_SHARED_CONNECTION_READ_ONLY: {};
    LLM_MANAGED_ROUTE_CONFLICT: {};
    LLM_CREDENTIAL_MISSING: {};
    LLM_CREDENTIAL_WRITE_FAILED: {};
    LLM_DISCOVERY_FAILED: {};
    LLM_SPACE_BUSY: {};
    LLM_APPLY_FAILED: {};
    LLM_RESULT_UNKNOWN: {};
  }
}

export const SPACES_REMOTE_CODES = [
  "spaces/read-only",
  "spaces/host-denied",
  "spaces/invalid-input",
  "spaces/not-found",
  "spaces/already-exists",
  "spaces/locked",
  "spaces/unavailable",
] as const;

export const WORKBENCH_REMOTE_CODES = [
  "workbench/invalid-input",
  "workbench/not-found",
  "workbench/conflict",
  "workbench/locked",
  "workbench/unavailable",
  "workbench/unsupported",
  "workbench/recovery-required",
  "workbench/read-only",
  "workbench/forbidden",
  "workbench/not-cancellable",
] as const;

export const LLM_REMOTE_CODES = [
  "LLM_REVISION_CONFLICT",
  "LLM_WRITE_OWNER_REQUIRED",
  "LLM_CONFIG_INVALID",
  "LLM_UNSUPPORTED_RUNTIME",
  "LLM_UNSUPPORTED_PROTOCOL",
  "LLM_ADAPTER_MISSING",
  "LLM_MODEL_NOT_FOUND",
  "LLM_CONNECTION_IN_USE",
  "LLM_SHARED_CONNECTION_READ_ONLY",
  "LLM_MANAGED_ROUTE_CONFLICT",
  "LLM_CREDENTIAL_MISSING",
  "LLM_CREDENTIAL_WRITE_FAILED",
  "LLM_DISCOVERY_FAILED",
  "LLM_SPACE_BUSY",
  "LLM_APPLY_FAILED",
  "LLM_RESULT_UNKNOWN",
] as const;

export type SpacesRemoteCode = (typeof SPACES_REMOTE_CODES)[number];
export type WorkbenchRemoteCode = (typeof WORKBENCH_REMOTE_CODES)[number];
export type LlmRemoteCode = (typeof LLM_REMOTE_CODES)[number];

export const WORKBENCH_PUBLIC_ERROR: Record<WorkbenchRemoteCode, string> = {
  "workbench/invalid-input": "The request is not a valid workbench operation.",
  "workbench/not-found": "That item was not found.",
  "workbench/conflict": "A job with this request already exists for a different command.",
  "workbench/locked": "Another workbench operation is already running.",
  "workbench/unavailable": "The workbench service could not complete this request.",
  "workbench/unsupported": "That command is not supported.",
  "workbench/recovery-required": "Workbench identity is damaged.",
  "workbench/read-only": "The workbench is read-only until control is acquired.",
  "workbench/forbidden": "This profile cannot perform that workbench action.",
  "workbench/not-cancellable": "This job cannot be cancelled in its current phase.",
};

export const LLM_PUBLIC_ERROR: Record<LlmRemoteCode, string> = {
  LLM_REVISION_CONFLICT: "The shared catalog revision changed. The write was not applied.",
  LLM_WRITE_OWNER_REQUIRED: "Home write owner is required for this change.",
  LLM_CONFIG_INVALID: "The shared LLM request is not valid.",
  LLM_UNSUPPORTED_RUNTIME: "This shared LLM schema is not supported.",
  LLM_UNSUPPORTED_PROTOCOL: "That protocol is not enabled for shared connections.",
  LLM_ADAPTER_MISSING: "The official adapter is not available in this space.",
  LLM_MODEL_NOT_FOUND: "That shared connection or model was not found.",
  LLM_CONNECTION_IN_USE: "The connection is still referenced and was not deleted.",
  LLM_SHARED_CONNECTION_READ_ONLY: "Shared connection fields cannot be edited from this space.",
  LLM_MANAGED_ROUTE_CONFLICT: "A reserved shared route id is already occupied.",
  LLM_CREDENTIAL_MISSING: "The shared credential record is not readable.",
  LLM_CREDENTIAL_WRITE_FAILED: "The shared credential record could not be written.",
  LLM_DISCOVERY_FAILED: "The explicit model discovery or test request failed.",
  LLM_SPACE_BUSY: "That space is busy. It was not force-stopped.",
  LLM_APPLY_FAILED: "The apply plan stopped at the first failure.",
  LLM_RESULT_UNKNOWN: "The write result is unknown. The request was not replayed.",
};
