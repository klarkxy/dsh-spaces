export const WORKBENCH_ERROR = {
  "workbench/invalid-input": "The request is not a valid workbench operation.",
  "workbench/unauthorized": "Authentication is required.",
  "workbench/forbidden": "This origin cannot call that workbench method.",
  "workbench/not-found": "That item was not found.",
  "workbench/read-only": "The workbench is read-only until control is acquired.",
  "workbench/unavailable": "The workbench cannot accept this request.",
  "workbench/unsupported": "That command is not supported.",
  "workbench/conflict": "The service epoch or state revision does not match.",
  "workbench/busy": "Another controller already holds run rights for this home.",
  "workbench/unmanaged": "This instance is not managed here. It can be viewed only.",
  "workbench/protected": "The web profile and manager space cannot be changed this way.",
  "workbench/incompatible": "The bound DSH CLI could not be validated as an exact installed version.",
  "workbench/failed": "The workbench request failed.",
  "workbench/maintenance": "That maintenance action is not available yet.",
} as const;

export type WorkbenchErrorCode = keyof typeof WORKBENCH_ERROR;

export class WorkbenchPublicError extends Error {
  readonly name = "WorkbenchPublicError";
  constructor(
    readonly code: WorkbenchErrorCode,
    message: string = WORKBENCH_ERROR[code],
  ) {
    super(message);
  }
}
