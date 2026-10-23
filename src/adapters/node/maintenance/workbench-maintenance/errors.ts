import { ProcessTerminationError } from "../../runtime/terminate-process";
import { sanitizeJobText, WorkbenchJobError } from "../workbench-jobs";
import { WORKBENCH_MAINTENANCE_ERROR, type WorkbenchMaintenanceErrorCode } from "./constants";

export class WorkbenchMaintenanceError extends Error {
  readonly name = "WorkbenchMaintenanceError";
  constructor(
    readonly code: WorkbenchMaintenanceErrorCode,
    message: string = WORKBENCH_MAINTENANCE_ERROR[code],
  ) {
    const fallback = WORKBENCH_MAINTENANCE_ERROR[code] || "The maintenance operation failed.";
    const cleaned = sanitizeJobText(message).trim().slice(0, 500);
    super(cleaned || fallback);
  }
}

export class PluginBatchItemError extends Error {
  readonly name = "PluginBatchItemError";
  constructor(
    message: string,
    readonly spaceId: string,
    readonly packageName: string,
    readonly stage: string,
  ) {
    super(message);
  }
}

export function uncertainMaintenance(error: unknown): boolean {
  return error instanceof ProcessTerminationError || error instanceof WorkbenchJobError &&
    (error.code === "workbench/persist-failed" || error.code === "workbench/failed");
}
