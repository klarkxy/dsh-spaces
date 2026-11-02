/** Public startup observation. No commands, local paths, secrets, or internal errors. */

export type WorkbenchStartupPhase = "preparing" | "starting" | "ready" | "failed";

export interface WorkbenchStartupFailure {
  stage: string;
  primaryReason: string;
  cleanupReason?: string;
  instanceRetained: boolean;
}

export interface WorkbenchStartupStatus {
  serviceEpoch: string;
  managerId: string | null;
  phase: WorkbenchStartupPhase;
  reasons: string[];
  failure: WorkbenchStartupFailure | null;
}
