/** Public plugin Remote DTOs. Browser-safe: no paths, tokens, cookies or commands. */
import type { SpaceDetail, SpacesOverview } from "../../../src/shared/spaces-control";
import type { WorkbenchApi, WorkbenchRole } from "../../../src/shared/workbench";

export type { SpaceDetail, SpacesOverview, WorkbenchApi, WorkbenchRole };
export type { LlmApiRequest, LlmApiResult, LlmCredentialRequest } from "../../../src/shared/llm-api";
export type { WorkbenchPackageRelease } from "../../../src/shared/workbench";

export interface WorkbenchHostHint {
  role: WorkbenchRole;
  /** Local identity/role is blocked. Distinct from WorkbenchState.availability. */
  unavailable: boolean;
}

export interface WorkbenchGuideRole {
  role: WorkbenchRole;
  profileId: string | null;
  managerId: string | null;
  unavailable: boolean;
  reasons: string[];
}

export interface WorkbenchBootstrapResult {
  ok: boolean;
  connected: boolean;
  unavailable: boolean;
  origin: string | null;
  reasons: string[];
}

export interface WorkbenchReturnTarget {
  available: boolean;
  origin: string | null;
  path: string | null;
  unavailable: boolean;
  reasons: string[];
}

/** Explicit Home initialization. No path, CLI, tarball, or worker arguments. */
export interface WorkbenchInitializeResult {
  ok: boolean;
  connected: boolean;
  unavailable: boolean;
  origin: string | null;
  path: string | null;
  managerId: string | null;
  reasons: string[];
}

export interface WorkbenchGuideApi {
  role(): Promise<WorkbenchGuideRole>;
  bootstrap(): Promise<WorkbenchBootstrapResult>;
  returnTarget(): Promise<WorkbenchReturnTarget>;
  initialize(): Promise<WorkbenchInitializeResult>;
}
