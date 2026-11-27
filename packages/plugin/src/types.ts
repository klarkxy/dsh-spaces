/** Public plugin Remote DTOs. Browser-safe: no paths, tokens, cookies or commands. */
import type { SpaceDetail, SpacesOverview } from "../../../src/shared/spaces-control";
import type { WorkbenchStartupFailure } from "../../../src/shared/workbench-startup";
import type { WorkbenchApi, WorkbenchRole } from "../../../src/shared/workbench";
import { parseNavDiag, type NavDiagRecord } from "../../../src/shared/nav-diag";
import { parsePortalFailure, type PortalFailure } from "../../../src/shared/space-host";

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
  /** Read-only raw activity of the native space this client runs in; the client composes the light. The signal bounds one read. */
  hostActivity?(signal?: AbortSignal): Promise<{ attention: "required" | "none" | "unknown"; working: "busy" | "idle" | "unknown" }>;
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
  /** Best-effort sanitized failure log forwarded from a client surface to host.jsonl. */
  reportClientFailure?(report: ClientFailureReport): Promise<{ recorded: boolean }>;
}

export const CLIENT_FAILURE_STAGES = [
  "role",
  "launch",
  "launch-poll",
  "directory-poll",
  "portal",
  "guest-bootstrap",
  "guest-load",
  "guest-crashed",
  "guest-navigated",
  "selection-timeout",
  "selection-rejected",
  "navigation",
  "browser-relay",
  "reload-surface",
  "host-shell",
] as const;

export type ClientFailureStage = typeof CLIENT_FAILURE_STAGES[number];

export interface ClientFailureReport {
  surface: "desktop-native" | "portable-host";
  stage: ClientFailureStage;
  detail: string | null;
  failedAt: string;
  rpcEndpoint?: string;
  rpcFailureKind?: "rpc-transport" | "backend-error" | "invalid-response";
  connectionState?: "connected" | "disconnected" | "connecting";
  portalFailure?: PortalFailure | null;
  navTrail?: NavDiagRecord[];
}

const CLIENT_FAILURE_REPORT_KEYS = new Set([
  "surface",
  "stage",
  "detail",
  "failedAt",
  "rpcEndpoint",
  "rpcFailureKind",
  "connectionState",
  "portalFailure",
  "navTrail",
]);

export function validClientFailureReport(value: unknown): value is ClientFailureReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !CLIENT_FAILURE_REPORT_KEYS.has(key))) return false;
  if (row.surface !== "desktop-native" && row.surface !== "portable-host") return false;
  if (typeof row.stage !== "string" || !CLIENT_FAILURE_STAGES.includes(row.stage as ClientFailureStage)) return false;
  if (!(row.detail === null || (typeof row.detail === "string" && row.detail.length <= 500))) return false;
  if (
    typeof row.failedAt !== "string" ||
    row.failedAt.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.failedAt)
  ) {
    return false;
  }
  if (
    row.rpcEndpoint !== undefined &&
    (typeof row.rpcEndpoint !== "string" || !/^(?:workbenchGuide|workbench|spaces)\/[A-Za-z]{1,40}$/.test(row.rpcEndpoint))
  ) {
    return false;
  }
  if (
    row.rpcFailureKind !== undefined &&
    row.rpcFailureKind !== "rpc-transport" &&
    row.rpcFailureKind !== "backend-error" &&
    row.rpcFailureKind !== "invalid-response"
  ) {
    return false;
  }
  if (
    row.connectionState !== undefined &&
    row.connectionState !== "connected" &&
    row.connectionState !== "disconnected" &&
    row.connectionState !== "connecting"
  ) {
    return false;
  }
  if (row.portalFailure !== undefined && row.portalFailure !== null && parsePortalFailure(row.portalFailure) === null) {
    return false;
  }
  if (row.navTrail !== undefined) {
    if (!Array.isArray(row.navTrail) || row.navTrail.length > 64) return false;
    for (const item of row.navTrail) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      if (parseNavDiag(JSON.stringify(item)) === null) return false;
    }
  }
  return true;
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
