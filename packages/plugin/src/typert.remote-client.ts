import type { PortalSnapshot, SpaceHostAudience } from "../../../src/shared/space-host";
import type { DesktopSpaceAction } from "./types";
import type { RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import type { SpaceDetail, SpacesOverview } from "../../../src/shared/spaces-control";
import type {
  WorkbenchApiArgs,
  WorkbenchApiMethod,
  WorkbenchApiResult,
} from "../../../src/shared/workbench";
import type {
  ClientFailureReport,
  DesktopLaunchState,
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
  WorkbenchServiceRestartPreview,
} from "./types";
import { TYPERT } from "./typert.host";
import "./host/remote-errors";

/**
 * The workbench namespace surface, derived from the canonical API definition.
 */
type WorkbenchRemoteNamespace = {
  [K in WorkbenchApiMethod]: (...args: WorkbenchApiArgs<K>) => Promise<RemoteResult<WorkbenchApiResult<K>>>;
};

/**
 * The flat workbench endpoint map, derived from the canonical API definition.
 */
type WorkbenchRemoteMapEntries = {
  [K in WorkbenchApiMethod as `workbench/${K}`]: (
    ...args: WorkbenchApiArgs<K>
  ) => Promise<RemoteResult<WorkbenchApiResult<K>>>;
};

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespace$workbenchGuide {
    spaceActivity: (spaceId: string, serviceEpoch: string) => Promise<RemoteResult<{ activity: "idle" | "busy" | "unknown"; generation: number }>>;
    presentationSnapshot: () => Promise<RemoteResult<PortalSnapshot>>;
    spaceAction: (request: DesktopSpaceAction) => Promise<RemoteResult<PortalSnapshot>>;
    role: () => Promise<RemoteResult<WorkbenchGuideRole>>;
    bootstrap: () => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    returnTarget: () => Promise<RemoteResult<WorkbenchReturnTarget>>;
    portalTarget: (audience: SpaceHostAudience) => Promise<RemoteResult<WorkbenchReturnTarget>>;
    initialize: () => Promise<RemoteResult<WorkbenchInitializeResult>>;
    previewServiceRestart: () => Promise<RemoteResult<WorkbenchServiceRestartPreview>>;
    previewServiceStop: () => Promise<RemoteResult<WorkbenchServiceRestartPreview>>;
    stopService: (confirmationId: string) => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    restartService: (confirmationId: string) => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    beginDesktopLaunch: () => Promise<RemoteResult<DesktopLaunchState>>;
    desktopLaunchState: () => Promise<RemoteResult<DesktopLaunchState>>;
    reportClientFailure: (report: ClientFailureReport) => Promise<RemoteResult<{ recorded: boolean }>>;
  }
  interface TypertRemoteNamespace$spaces {
    overview: () => Promise<RemoteResult<SpacesOverview>>;
    detail: (id: string) => Promise<RemoteResult<SpaceDetail>>;
  }
  interface TypertRemoteNamespace$workbench extends WorkbenchRemoteNamespace {}
  interface TypertRemoteMap extends WorkbenchRemoteMapEntries {
    "workbenchGuide/spaceActivity": (spaceId: string, serviceEpoch: string) => Promise<RemoteResult<{ activity: "idle" | "busy" | "unknown"; generation: number }>>;
    "workbenchGuide/presentationSnapshot": () => Promise<RemoteResult<PortalSnapshot>>;
    "workbenchGuide/spaceAction": (request: DesktopSpaceAction) => Promise<RemoteResult<PortalSnapshot>>;
    "workbenchGuide/role": () => Promise<RemoteResult<WorkbenchGuideRole>>;
    "workbenchGuide/bootstrap": () => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    "workbenchGuide/returnTarget": () => Promise<RemoteResult<WorkbenchReturnTarget>>;
    "workbenchGuide/portalTarget": (audience: SpaceHostAudience) => Promise<RemoteResult<WorkbenchReturnTarget>>;
    "workbenchGuide/initialize": () => Promise<RemoteResult<WorkbenchInitializeResult>>;
    "workbenchGuide/previewServiceRestart": () => Promise<RemoteResult<WorkbenchServiceRestartPreview>>;
    "workbenchGuide/previewServiceStop": () => Promise<RemoteResult<WorkbenchServiceRestartPreview>>;
    "workbenchGuide/stopService": (confirmationId: string) => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    "workbenchGuide/restartService": (confirmationId: string) => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    "workbenchGuide/beginDesktopLaunch": () => Promise<RemoteResult<DesktopLaunchState>>;
    "workbenchGuide/desktopLaunchState": () => Promise<RemoteResult<DesktopLaunchState>>;
    "workbenchGuide/reportClientFailure": (report: ClientFailureReport) => Promise<RemoteResult<{ recorded: boolean }>>;
    "spaces/overview": () => Promise<RemoteResult<SpacesOverview>>;
    "spaces/detail": (id: string) => Promise<RemoteResult<SpaceDetail>>;
  }
  interface TypertRemoteNamespaceMap {
    workbenchGuide: TypertRemoteNamespace$workbenchGuide;
    spaces: TypertRemoteNamespace$spaces;
    workbench: TypertRemoteNamespace$workbench;
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: "dsh-spaces",
  descriptors: TYPERT.invocations.map((row) => ({
    id: row.id,
    service: row.service,
    namespace: row.namespace,
    method: row.method,
    invocation: row.invocation,
    parameters: row.parameters,
    result: row.result,
    sourceLocation: row.sourceLocation,
  })),
};

export default TYPERT_REMOTE;
