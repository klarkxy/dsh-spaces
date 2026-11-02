import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import {
  WORKBENCH_API,
  type WorkbenchApi,
  type WorkbenchApiArgs,
  type WorkbenchApiMethod,
  type WorkbenchApiResult,
} from "../../../../src/shared/workbench";
import {
  KNOWN_WORKBENCH_ERROR_CODES,
  publicWorkbenchErrorMessage,
} from "../../../../src/shared/workbench-errors";
import type {
  DesktopLaunchState,
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

/** The named wire payload of one management API call. */
function workbenchPayload<K extends WorkbenchApiMethod>(method: K, args: WorkbenchApiArgs<K>): Record<string, unknown> {
  const spec: { args: readonly { name: string }[] } = WORKBENCH_API[method];
  const values = args as unknown as readonly unknown[];
  const payload: Record<string, unknown> = {};
  spec.args.forEach((arg, index) => {
    payload[arg.name] = values[index];
  });
  return payload;
}

/** One management API call over the shared RPC carrier. */
function callWorkbench<K extends WorkbenchApiMethod>(
  connection: WorkbenchConnection,
  method: K,
  args: WorkbenchApiArgs<K>,
): Promise<WorkbenchApiResult<K>> {
  return callRemote<WorkbenchApiResult<K>>(connection, `workbench/${method}`, workbenchPayload(method, args));
}

export function createWorkbenchRemote(connection: WorkbenchConnection): WorkbenchApi {
  return {
    state: () => callWorkbench(connection, "state", []),
    startupStatus: () => callWorkbench(connection, "startupStatus", []),
    detail: (spaceId) => callWorkbench(connection, "detail", [spaceId]),
    submit: (command, requestId, context) => callWorkbench(connection, "submit", [command, requestId, context]),
    job: (id) => callWorkbench(connection, "job", [id]),
    cancel: (id) => callWorkbench(connection, "cancel", [id]),
    view: (spaceId) => callWorkbench(connection, "view", [spaceId]),
    preview: (request, context) => callWorkbench(connection, "preview", [request, context]),
    product: (request) => callWorkbench(connection, "product", [request]),
    plugins: (query) => callWorkbench(connection, "plugins", [query]),
    snapshots: () => callWorkbench(connection, "snapshots", []),
    snapshot: (id) => callWorkbench(connection, "snapshot", [id]),
    runtimes: () => callWorkbench(connection, "runtimes", []),
    backups: (spaceId) => callWorkbench(connection, "backups", [spaceId]),
    llm: (request) => callWorkbench(connection, "llm", [request]),
    llmCredential: (request) => callWorkbench(connection, "llmCredential", [request]),
  };
}

export function createWorkbenchGuideRemote(connection: WorkbenchConnection): WorkbenchGuideApi {
  return {
    presentationSnapshot: () => callRemote<import("../../../../src/shared/space-host").PortalSnapshot>(connection, "workbenchGuide/presentationSnapshot", {}),
    spaceActivity: (spaceId, serviceEpoch) => callRemote<{ activity: "idle" | "busy" | "unknown"; generation: number }>(connection, "workbenchGuide/spaceActivity", { spaceId, serviceEpoch }),
    spaceAction: request => callRemote<import("../../../../src/shared/space-host").PortalSnapshot>(connection, "workbenchGuide/spaceAction", { request }),
    role: () => callRemote<WorkbenchGuideRole>(connection, "workbenchGuide/role", {}),
    bootstrap: () => callRemote<WorkbenchBootstrapResult>(connection, "workbenchGuide/bootstrap", {}),
    returnTarget: () => callRemote<WorkbenchReturnTarget>(connection, "workbenchGuide/returnTarget", {}),
    portalTarget: audience => callRemote<WorkbenchReturnTarget>(connection, "workbenchGuide/portalTarget", { audience }),
    initialize: () => callRemote<WorkbenchInitializeResult>(connection, "workbenchGuide/initialize", {}),
    previewServiceRestart: () => callRemote<import("../types").WorkbenchServiceRestartPreview>(connection, "workbenchGuide/previewServiceRestart", {}),
    previewServiceStop: () => callRemote<import("../types").WorkbenchServiceRestartPreview>(connection, "workbenchGuide/previewServiceStop", {}),
    stopService: confirmationId => callRemote<WorkbenchBootstrapResult>(connection, "workbenchGuide/stopService", { confirmationId }),
    restartService: confirmationId => callRemote<WorkbenchBootstrapResult>(connection, "workbenchGuide/restartService", { confirmationId }),
    beginDesktopLaunch: () => callRemote<DesktopLaunchState>(connection, "workbenchGuide/beginDesktopLaunch", {}),
    desktopLaunchState: () => callRemote<DesktopLaunchState>(connection, "workbenchGuide/desktopLaunchState", {}),
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
