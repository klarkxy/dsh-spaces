import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { LlmApiRequest, LlmApiResult, LlmCredentialRequest } from "../../../../src/shared/llm-api";
import type { SpaceDetail } from "../../../../src/shared/spaces-control";
import type {
  WorkbenchApi,
  WorkbenchBackup,
  WorkbenchCommand,
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchSnapshot,
  WorkbenchState,
  WorkbenchView,
} from "../../../../src/shared/workbench";
import type { WorkbenchProductRequest, WorkbenchProductResult } from "../../../../src/shared/workbench-product";
import {
  KNOWN_WORKBENCH_ERROR_CODES,
  publicWorkbenchErrorMessage,
} from "../../../../src/shared/workbench-errors";
import type {
  WorkbenchBootstrapResult,
  WorkbenchGuideApi,
  WorkbenchGuideRole,
  WorkbenchHostHint,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
} from "../types";

const CHANNEL = "/api";
const GENERIC_ERROR_MESSAGE = "The workbench request failed.";
const HOST_HINT_GLOBAL = "__DSH_SPACES_HOST__";

export { KNOWN_WORKBENCH_ERROR_CODES };

export class WorkbenchRemoteError extends Error {
  readonly code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.name = "WorkbenchRemoteError";
    this.code = code;
  }
}

export type WorkbenchConnection = Pick<ConnectionHandle, "rpc">;

function sanitizeBackendError(error: unknown): WorkbenchRemoteError {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    const message = publicWorkbenchErrorMessage(code, (error as { message?: unknown }).message);
    if (message !== null) return new WorkbenchRemoteError(code, message);
  }
  return new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE);
  }
  return value as Record<string, unknown>;
}

async function callRemote<T>(
  connection: WorkbenchConnection,
  endpoint: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  allowNull = false,
): Promise<T> {
  let result;
  try {
    result = await connection.rpc.call(CHANNEL, endpoint, { args }, signal);
  } catch {
    throw new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE);
  }
  if (!result.ok) throw sanitizeBackendError(result.error);
  if (Array.isArray(result.value)) return result.value as T;
  if (allowNull && result.value === null) return null as T;
  if (result.value === null || typeof result.value !== "object") {
    throw new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE);
  }
  return requireObject(result.value) as T;
}

export function createWorkbenchRemote(connection: WorkbenchConnection): WorkbenchApi {
  return {
    state: () => callRemote<WorkbenchState>(connection, "workbench/state", {}),
    detail: (spaceId) => callRemote<SpaceDetail>(connection, "workbench/detail", { spaceId }),
    submit: (command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext) =>
      callRemote<WorkbenchJob>(connection, "workbench/submit", { command, requestId, context }),
    job: (id) => callRemote<WorkbenchJob>(connection, "workbench/job", { id }),
    cancel: (id) => callRemote<WorkbenchJob>(connection, "workbench/cancel", { id }),
    view: (spaceId) => callRemote<WorkbenchView>(connection, "workbench/view", { spaceId }),
    preview: (request: WorkbenchPlanRequest, context: WorkbenchMutationContext) =>
      callRemote<WorkbenchPlan>(connection, "workbench/preview", { request, context }),
    product: (request: WorkbenchProductRequest) =>
      callRemote<WorkbenchProductResult>(connection, "workbench/product", { request }),
    plugins: (query) => callRemote<WorkbenchPlugin[]>(connection, "workbench/plugins", { query }),
    snapshots: () => callRemote<WorkbenchSnapshot[]>(connection, "workbench/snapshots", {}),
    snapshot: (id) => callRemote<WorkbenchSnapshot>(connection, "workbench/snapshot", { id }),
    runtimes: () => callRemote<WorkbenchRuntime[]>(connection, "workbench/runtimes", {}),
    backups: (spaceId) => callRemote<WorkbenchBackup[]>(connection, "workbench/backups", { spaceId }),
    llm: (request: LlmApiRequest) => callRemote<LlmApiResult>(connection, "workbench/llm", { request }),
    llmCredential: (request: LlmCredentialRequest) =>
      callRemote<LlmApiResult>(connection, "workbench/llmCredential", { request }),
  };
}

export function createWorkbenchGuideRemote(connection: WorkbenchConnection): WorkbenchGuideApi {
  return {
    presentationSnapshot: () => callRemote<import("../../../../src/shared/space-host").PortalSnapshot>(connection, "workbenchGuide/presentationSnapshot", {}),
    role: () => callRemote<WorkbenchGuideRole>(connection, "workbenchGuide/role", {}),
    bootstrap: () => callRemote<WorkbenchBootstrapResult>(connection, "workbenchGuide/bootstrap", {}),
    returnTarget: () => callRemote<WorkbenchReturnTarget>(connection, "workbenchGuide/returnTarget", {}),
    portalTarget: audience => callRemote<WorkbenchReturnTarget>(connection, "workbenchGuide/portalTarget", { audience }),
    initialize: () => callRemote<WorkbenchInitializeResult>(connection, "workbenchGuide/initialize", {}),
    previewServiceRestart: () => callRemote<import("../types").WorkbenchServiceRestartPreview>(connection, "workbenchGuide/previewServiceRestart", {}),
    restartService: confirmationId => callRemote<WorkbenchBootstrapResult>(connection, "workbenchGuide/restartService", { confirmationId }),
  };
}

export function displayWorkbenchMessage(error: unknown): string {
  return error instanceof WorkbenchRemoteError ? error.message : GENERIC_ERROR_MESSAGE;
}

export function readHostHint(globalObject: Record<string, unknown> | undefined = globalThis as unknown as Record<string, unknown>): WorkbenchHostHint | null {
  const raw = globalObject?.[HOST_HINT_GLOBAL];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as { role?: unknown; unavailable?: unknown };
  if (row.role !== "manager" && row.role !== "workspace" && row.role !== "uninitialized") return null;
  if (typeof row.unavailable !== "boolean") return null;
  return { role: row.role, unavailable: row.unavailable };
}

export function isTrustedLoopbackHref(origin: string, path: string): string | null {
  try {
    if (!path.startsWith("/") || path.startsWith("//")) return null;
    const url = new URL(path, origin);
    if (url.origin !== origin) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname !== "127.0.0.1") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
