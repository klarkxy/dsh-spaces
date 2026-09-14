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
    "workbench/recovery-required": {};
    "workbench/read-only": {};
    "workbench/forbidden": {};
    "workbench/not-cancellable": {};
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
  "workbench/recovery-required",
  "workbench/read-only",
  "workbench/forbidden",
  "workbench/not-cancellable",
] as const;

export type SpacesRemoteCode = (typeof SPACES_REMOTE_CODES)[number];
export type WorkbenchRemoteCode = (typeof WORKBENCH_REMOTE_CODES)[number];

export const WORKBENCH_PUBLIC_ERROR: Record<WorkbenchRemoteCode, string> = {
  "workbench/invalid-input": "The request is not a valid workbench operation.",
  "workbench/not-found": "That item was not found.",
  "workbench/conflict": "A job with this request already exists for a different command.",
  "workbench/locked": "Another workbench operation is already running.",
  "workbench/unavailable": "The workbench service could not complete this request.",
  "workbench/recovery-required": "Workbench identity is damaged. Recovery is required.",
  "workbench/read-only": "The workbench is read-only until control is acquired.",
  "workbench/forbidden": "This profile cannot perform that workbench action.",
  "workbench/not-cancellable": "This job cannot be cancelled in its current phase.",
};
