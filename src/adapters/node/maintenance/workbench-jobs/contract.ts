import type {


  WorkbenchFailureContext,
  WorkbenchJob,

} from "../../../../shared/workbench";
import type { LlmErrorCode } from "../../../../shared/llm-connections";
import { sanitizeJobText } from "./util";

export const WORKBENCH_CONTROL_DIR_NAME = ".dsh-spaces-control";
export const WORKBENCH_JOBS_DIR_NAME = "jobs";

export const WORKBENCH_JOB_ERROR = {
  "workbench/invalid-input": "The request is not a valid workbench job.",
  "workbench/conflict": "A job with this request id already exists for a different command.",
  "workbench/not-found": "That job was not found.",
  "workbench/not-cancellable": "This job cannot be cancelled in its current phase.",
  "workbench/persist-failed": "The job could not be saved. The operation was not accepted.",
  "workbench/failed": "The job failed.",
  "workbench/unreadable": "The job record could not be read. Original bytes were left unchanged.",
  "workbench/unsupported": "That command is not supported.",
  "workbench/unavailable": "The workbench cannot accept this request.",
} as const;

export const INTERRUPTED_JOB_MESSAGE =
  "The previous run was interrupted. The result is unconfirmed; some changes may already have happened. The command was not replayed.";

export type WorkbenchJobErrorCode = keyof typeof WORKBENCH_JOB_ERROR;


export type WorkbenchJobResult = NonNullable<WorkbenchJob["result"]>;
export type WorkbenchJobsInject = (op: string, detail?: string) => void;
export type WorkbenchJobSettleStatus = "succeeded" | "failed" | "cancelled";

export interface WorkbenchJobSettle {
  status: WorkbenchJobSettleStatus;
  result?: WorkbenchJobResult;
  message?: string;
}

export class WorkbenchJobError extends Error {
  readonly name = "WorkbenchJobError";
  constructor(
    readonly code: WorkbenchJobErrorCode,
    message: string = WORKBENCH_JOB_ERROR[code],
    readonly context?: WorkbenchFailureContext,
  ) {
    super(visibleJobMessage(code, message));
  }
}

export function visibleJobMessage(code: WorkbenchJobErrorCode | LlmErrorCode, message: string): string {
  const fallback = isJobErrorCode(code) ? WORKBENCH_JOB_ERROR[code] : "The job failed.";
  const cleaned = sanitizeJobText(message).trim().slice(0, 500);
  return cleaned || fallback;
}

export class WorkbenchJobAbortError extends Error {
  readonly name = "AbortError";
  constructor(message = "The job was aborted.") {
    super(message);
  }
}

export interface WorkbenchJobContext {
  readonly signal: AbortSignal;
  phase(phase: string): void;
  message(message: string): void;
  cancellable(value: boolean): void;
  result(value: WorkbenchJobResult): void;
}

export type WorkbenchJobHandler = (context: WorkbenchJobContext) => Promise<WorkbenchJobResult | void>;

export interface WorkbenchJobsOptions {
  home: string;
  /** Test seam for write failures. Not a general filesystem mock. */
  inject?: WorkbenchJobsInject;
  now?: () => Date;
}


export function isJobErrorCode(value: string): value is WorkbenchJobErrorCode {
  return Object.prototype.hasOwnProperty.call(WORKBENCH_JOB_ERROR, value);
}

