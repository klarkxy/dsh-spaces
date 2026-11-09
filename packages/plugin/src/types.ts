/** Public plugin Remote DTOs. Browser-safe: no paths, tokens, cookies or commands. */
import type { SpaceDetail, SpacesOverview } from "../../../src/shared/spaces-control";
import type { WorkbenchStartupFailure } from "../../../src/shared/workbench-startup";
import type { WorkbenchApi, WorkbenchRole } from "../../../src/shared/workbench";

export type { SpaceDetail, SpacesOverview, WorkbenchApi, WorkbenchRole };
export type { WorkbenchStartupFailure, WorkbenchStartupPhase, WorkbenchStartupStatus } from "../../../src/shared/workbench-startup";

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

export type DesktopLaunchPhase =
  | "idle"
  | "discovering"
  | "preparing"
  | "launching"
  | "starting"
  | "connecting"
  | "ready"
  | "failed"
  | "stopped";

/** Host-owned Desktop launch snapshot. No home, path, credential, endpoint, or one-time entry. */
export interface DesktopLaunchState {
  operationId: string | null;
  phase: DesktopLaunchPhase;
  serviceEpoch: string | null;
  managerId: string | null;
  reasons: string[];
  failure: WorkbenchStartupFailure | null;
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
  spaceActivity?(spaceId: string, serviceEpoch: string): Promise<{ activity: "idle" | "busy" | "unknown"; generation: number }>;
  previewServiceStop?(): Promise<WorkbenchServiceRestartPreview>;
  stopService?(confirmationId: string): Promise<WorkbenchBootstrapResult>;
  /** Explicit Desktop rail action, scoped to one managed child and the observed service. */
  spaceAction?(request: DesktopSpaceAction): Promise<import("../../../src/shared/space-host").PortalSnapshot>;
  /** Desktop-only, explicit preview and confirmation; never called by discovery. */
  previewServiceRestart?(): Promise<WorkbenchServiceRestartPreview>;
  restartService?(confirmationId: string): Promise<WorkbenchBootstrapResult>;
  presentationSnapshot?(): Promise<import("../../../src/shared/space-host").PortalSnapshot>;
  /** Explicit audience-bound presentation entry; no management operations. */
  portalTarget(audience: import("../../../src/shared/space-host").SpaceHostAudience): Promise<WorkbenchReturnTarget>;
  role(): Promise<WorkbenchGuideRole>;
  bootstrap(): Promise<WorkbenchBootstrapResult>;
  returnTarget(): Promise<WorkbenchReturnTarget>;
  initialize(): Promise<WorkbenchInitializeResult>;
  /** Confirmed Desktop only. Joins the process launch and returns before it finishes. */
  beginDesktopLaunch?(): Promise<DesktopLaunchState>;
  /** Read-only. Idle before the first launch; never discovers, registers, or starts. */
  desktopLaunchState?(): Promise<DesktopLaunchState>;
}

export interface DesktopSpaceAction {
  spaceId: string;
  action: "open" | "start" | "stop" | "restart";
  serviceEpoch: string;
  expectedGeneration?: number;
  interruptAccepted?: boolean;
}

export function validDesktopSpaceAction(value: unknown): value is DesktopSpaceAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["action", "serviceEpoch", "spaceId", "expectedGeneration", "interruptAccepted"].includes(key)) &&
    (row.expectedGeneration === undefined || Number.isSafeInteger(row.expectedGeneration) && (row.expectedGeneration as number) >= 0) &&
    (row.interruptAccepted === undefined || typeof row.interruptAccepted === "boolean" && Number.isSafeInteger(row.expectedGeneration)) &&
    typeof row.spaceId === "string" && /^[a-z0-9][a-z0-9-]{0,38}$/.test(row.spaceId) &&
    typeof row.serviceEpoch === "string" && /^[a-f0-9]{64}$/.test(row.serviceEpoch) &&
    ["open", "start", "stop", "restart"].includes(row.action as string);
}

export interface WorkbenchServiceRestartPreview {
  confirmationId: string;
  expiresAt: string;
  action: "start" | "restart" | "stop";
  spaces: { id: string; displayName: string; running: boolean }[];
}
