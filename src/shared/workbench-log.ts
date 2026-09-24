/** Public workbench log line. Secrets and local paths are removed before this leaves the supervisor. */

export type WorkbenchLogLevel = "info" | "warn" | "error";

export interface WorkbenchLogEntry {
  at: string;
  level: WorkbenchLogLevel;
  area: string;
  event: string;
  message: string;
  code?: string;
}

export interface WorkbenchLogSnapshot {
  entries: WorkbenchLogEntry[];
  logError: string | null;
}
