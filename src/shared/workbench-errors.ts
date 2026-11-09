/** Public workbench/spaces/LLM remote codes. No Node APIs; host and browser share this list. */

import { reportedOrFallback } from "./public-reason";

/** Read-only discovery found no live supervisor for this Home (none running, or the recorded one is gone). */
export const WORKBENCH_ENTRY_UNAVAILABLE = "The workbench entry is not available yet.";

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
  "workbench/failed",
  "workbench/maintenance",
  "workbench/busy",
  "workbench/unmanaged",
  "workbench/protected",
  "workbench/incompatible",
  "workbench/unauthorized",
] as const;

export const LLM_REMOTE_CODES = [
  "LLM_CONFIG_INVALID",
  "LLM_SPACE_BUSY",
  "LLM_APPLY_FAILED",
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
  "workbench/failed": "The workbench request failed.",
  "workbench/maintenance": "That maintenance action is not available yet.",
  "workbench/busy": "Another controller already holds run rights for this home.",
  "workbench/unmanaged": "This instance is not managed here. It can be viewed only.",
  "workbench/protected": "The web profile and manager space cannot be changed this way.",
  "workbench/incompatible": "The bound DSH CLI could not be validated as an exact installed version.",
  "workbench/unauthorized": "Authentication is required.",
};

export const SPACES_PUBLIC_ERROR: Record<SpacesRemoteCode, string> = {
  "spaces/read-only": "Spaces are read-only until the host identity and runtime are confirmed.",
  "spaces/host-denied": "The current host space cannot be modified this way.",
  "spaces/invalid-input": "The request is not a valid space operation.",
  "spaces/not-found": "That space was not found.",
  "spaces/already-exists": "A space with that name already exists.",
  "spaces/locked": "Another space operation is already running.",
  "spaces/unavailable": "A previous space operation did not finish.",
};

export const LLM_PUBLIC_ERROR: Record<LlmRemoteCode, string> = {
  LLM_CONFIG_INVALID: "The LLM request is not valid.",
  LLM_SPACE_BUSY: "That space is busy. It was not force-stopped.",
  LLM_APPLY_FAILED: "The apply plan stopped at the first failure.",
};

/** Every code the workbench client may display. Unknown codes stay redacted. */
export const KNOWN_WORKBENCH_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...WORKBENCH_REMOTE_CODES,
  ...SPACES_REMOTE_CODES,
  ...LLM_REMOTE_CODES,
]);

const PUBLIC_REMOTE_ERROR: Readonly<Record<string, string>> = {
  ...WORKBENCH_PUBLIC_ERROR,
  ...SPACES_PUBLIC_ERROR,
  ...LLM_PUBLIC_ERROR,
};

/** Known code keeps a redacted reason, or the fixed sentence. Unknown codes return null. */
export function publicWorkbenchErrorMessage(code: string, reported: unknown): string | null {
  if (!KNOWN_WORKBENCH_ERROR_CODES.has(code) || !Object.hasOwn(PUBLIC_REMOTE_ERROR, code)) return null;
  return reportedOrFallback(reported, PUBLIC_REMOTE_ERROR[code]!);
}
