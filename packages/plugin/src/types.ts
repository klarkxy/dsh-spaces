/** Public plugin Remote DTOs. Browser-safe: no paths, tokens, cookies or commands. */
import type { SpaceDetail, SpacesOverview } from "../../../src/shared/spaces-control";
import type { WorkbenchApi, WorkbenchRole } from "../../../src/shared/workbench";

export type { SpaceDetail, SpacesOverview, WorkbenchApi, WorkbenchRole };

export interface WorkbenchHostHint {
  role: WorkbenchRole;
  recoveryRequired: boolean;
}

export interface WorkbenchGuideRole {
  role: WorkbenchRole;
  profileId: string | null;
  managerId: string | null;
  recoveryRequired: boolean;
  reasons: string[];
}

export interface WorkbenchBootstrapResult {
  ok: boolean;
  connected: boolean;
  recoveryRequired: boolean;
  origin: string | null;
  reasons: string[];
}

export interface WorkbenchReturnTarget {
  available: boolean;
  origin: string | null;
  path: string | null;
  recoveryRequired: boolean;
  reasons: string[];
}

export interface WorkbenchGuideApi {
  role(): Promise<WorkbenchGuideRole>;
  bootstrap(): Promise<WorkbenchBootstrapResult>;
  returnTarget(): Promise<WorkbenchReturnTarget>;
}
