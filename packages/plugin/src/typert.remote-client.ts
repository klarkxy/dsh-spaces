import type { SpaceHostAudience } from "../../../src/shared/space-host";
import type { RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
import type { SpaceDetail, SpacesOverview } from "../../../src/shared/spaces-control";
import type { LlmApiRequest, LlmApiResult, LlmCredentialRequest } from "../../../src/shared/llm-api";
import type {
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchPackageRelease,
  WorkbenchSnapshot,
  WorkbenchState,
  WorkbenchView,
} from "../../../src/shared/workbench";
import type { WorkbenchProductRequest, WorkbenchProductResult } from "../../../src/shared/workbench-product";
import type {
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
} from "./types";
import { TYPERT } from "./typert.host";
import "./host/remote-errors";

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespace$workbenchGuide {
    role: () => Promise<RemoteResult<WorkbenchGuideRole>>;
    bootstrap: () => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    returnTarget: () => Promise<RemoteResult<WorkbenchReturnTarget>>;
    portalTarget: (audience: SpaceHostAudience) => Promise<RemoteResult<WorkbenchReturnTarget>>;
    initialize: () => Promise<RemoteResult<WorkbenchInitializeResult>>;
  }
  interface TypertRemoteNamespace$spaces {
    overview: () => Promise<RemoteResult<SpacesOverview>>;
    detail: (id: string) => Promise<RemoteResult<SpaceDetail>>;
  }
  interface TypertRemoteNamespace$workbench {
    state: () => Promise<RemoteResult<WorkbenchState>>;
    detail: (spaceId: string) => Promise<RemoteResult<SpaceDetail>>;
    submit: (command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext) => Promise<RemoteResult<WorkbenchJob>>;
    job: (id: string) => Promise<RemoteResult<WorkbenchJob>>;
    cancel: (id: string) => Promise<RemoteResult<WorkbenchJob>>;
    view: (spaceId: string) => Promise<RemoteResult<WorkbenchView>>;
    preview: (request: WorkbenchPlanRequest, context: WorkbenchMutationContext) => Promise<RemoteResult<WorkbenchPlan>>;
    product: (request: WorkbenchProductRequest) => Promise<RemoteResult<WorkbenchProductResult>>;
    plugins: (query: string) => Promise<RemoteResult<WorkbenchPlugin[]>>;
    snapshots: () => Promise<RemoteResult<WorkbenchSnapshot[]>>;
    snapshot: (id: string) => Promise<RemoteResult<WorkbenchSnapshot>>;
    runtimes: () => Promise<RemoteResult<WorkbenchRuntime[]>>;
    workbenchPackage: () => Promise<RemoteResult<WorkbenchPackageRelease | null>>;
    backups: (spaceId: string) => Promise<RemoteResult<WorkbenchBackup[]>>;
    llm: (request: LlmApiRequest) => Promise<RemoteResult<LlmApiResult>>;
    llmCredential: (request: LlmCredentialRequest) => Promise<RemoteResult<LlmApiResult>>;
  }
  interface TypertRemoteMap {
    "workbenchGuide/role": () => Promise<RemoteResult<WorkbenchGuideRole>>;
    "workbenchGuide/bootstrap": () => Promise<RemoteResult<WorkbenchBootstrapResult>>;
    "workbenchGuide/returnTarget": () => Promise<RemoteResult<WorkbenchReturnTarget>>;
    "workbenchGuide/portalTarget": (audience: SpaceHostAudience) => Promise<RemoteResult<WorkbenchReturnTarget>>;
    "workbenchGuide/initialize": () => Promise<RemoteResult<WorkbenchInitializeResult>>;
    "spaces/overview": () => Promise<RemoteResult<SpacesOverview>>;
    "spaces/detail": (id: string) => Promise<RemoteResult<SpaceDetail>>;
    "workbench/state": () => Promise<RemoteResult<WorkbenchState>>;
    "workbench/detail": (spaceId: string) => Promise<RemoteResult<SpaceDetail>>;
    "workbench/submit": (command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext) => Promise<RemoteResult<WorkbenchJob>>;
    "workbench/job": (id: string) => Promise<RemoteResult<WorkbenchJob>>;
    "workbench/cancel": (id: string) => Promise<RemoteResult<WorkbenchJob>>;
    "workbench/view": (spaceId: string) => Promise<RemoteResult<WorkbenchView>>;
    "workbench/preview": (request: WorkbenchPlanRequest, context: WorkbenchMutationContext) => Promise<RemoteResult<WorkbenchPlan>>;
    "workbench/product": (request: WorkbenchProductRequest) => Promise<RemoteResult<WorkbenchProductResult>>;
    "workbench/plugins": (query: string) => Promise<RemoteResult<WorkbenchPlugin[]>>;
    "workbench/snapshots": () => Promise<RemoteResult<WorkbenchSnapshot[]>>;
    "workbench/snapshot": (id: string) => Promise<RemoteResult<WorkbenchSnapshot>>;
    "workbench/runtimes": () => Promise<RemoteResult<WorkbenchRuntime[]>>;
    "workbench/workbenchPackage": () => Promise<RemoteResult<WorkbenchPackageRelease | null>>;
    "workbench/backups": (spaceId: string) => Promise<RemoteResult<WorkbenchBackup[]>>;
    "workbench/llm": (request: LlmApiRequest) => Promise<RemoteResult<LlmApiResult>>;
    "workbench/llmCredential": (request: LlmCredentialRequest) => Promise<RemoteResult<LlmApiResult>>;
  }
  interface TypertRemoteNamespaceMap {
    workbenchGuide: TypertRemoteNamespace$workbenchGuide;
    spaces: TypertRemoteNamespace$spaces;
    workbench: TypertRemoteNamespace$workbench;
  }
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: "@dsh-spaces/plugin",
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
