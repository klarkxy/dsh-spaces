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
  ClientFailureReport,
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

export type WorkbenchRemoteFailureKind = "rpc-transport" | "backend-error" | "invalid-response";
export type WorkbenchConnectionStateValue = "connected" | "disconnected" | "connecting";

export interface WorkbenchRemoteErrorMeta {
  endpoint?: string | null;
  failureKind?: WorkbenchRemoteFailureKind;
  connectionState?: WorkbenchConnectionStateValue | null;
  initialConnectionState?: WorkbenchConnectionStateValue | null;
}

export class WorkbenchRemoteError extends Error {
  readonly code: string | null;
  readonly endpoint: string | null;
  readonly failureKind: WorkbenchRemoteFailureKind;
  readonly connectionState: WorkbenchConnectionStateValue | null;
  readonly initialConnectionState: WorkbenchConnectionStateValue | null;

  constructor(code: string | null, message: string, meta: WorkbenchRemoteErrorMeta = {}) {
    super(message);
    this.name = "WorkbenchRemoteError";
    this.code = code;
    this.endpoint = meta.endpoint ?? null;
    this.failureKind = meta.failureKind ?? "backend-error";
    this.connectionState = meta.connectionState ?? null;
    this.initialConnectionState = meta.initialConnectionState ?? null;
  }
}

export type WorkbenchConnection = Pick<ConnectionHandle, "rpc"> & {
  state?: {
    getSnapshot?(): unknown;
    subscribe?(listener: () => void): () => void;
  };
};

function readConnectionState(connection: WorkbenchConnection): WorkbenchConnectionStateValue | null {
  try {
    const snapshot = connection.state?.getSnapshot?.();
    if (snapshot === "connected" || snapshot === "disconnected" || snapshot === "connecting") return snapshot;
  } catch {
    /* Optional diagnostic read never escapes. */
  }
  return null;
}

function sanitizeBackendError(error: unknown, meta: WorkbenchRemoteErrorMeta): WorkbenchRemoteError {
  if (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    const message = publicWorkbenchErrorMessage(code, (error as { message?: unknown }).message);
    if (message !== null) return new WorkbenchRemoteError(code, message, { ...meta, failureKind: "backend-error" });
  }
  return new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE, { ...meta, failureKind: "backend-error" });
}

function requireObject(value: unknown, meta: WorkbenchRemoteErrorMeta): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE, { ...meta, failureKind: "invalid-response" });
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
  const initialConnectionState = readConnectionState(connection);
  let result;
  try {
    result = await connection.rpc.call(CHANNEL, endpoint, { args }, signal);
  } catch {
    throw new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE, {
      endpoint,
      failureKind: "rpc-transport",
      connectionState: readConnectionState(connection) ?? initialConnectionState,
      initialConnectionState,
    });
  }
  const connectionState = readConnectionState(connection) ?? initialConnectionState;
  if (!result.ok) throw sanitizeBackendError(result.error, { endpoint, connectionState, initialConnectionState });
  if (Array.isArray(result.value)) return result.value as T;
  if (allowNull && result.value === null) return null as T;
  if (result.value === null || typeof result.value !== "object") {
    throw new WorkbenchRemoteError(null, GENERIC_ERROR_MESSAGE, {
      endpoint,
      failureKind: "invalid-response",
      connectionState,
      initialConnectionState,
    });
  }
  return requireObject(result.value, { endpoint, connectionState, initialConnectionState }) as T;
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
  };
}

export function createWorkbenchGuideRemote(connection: WorkbenchConnection): WorkbenchGuideApi {
  return {
    presentationSnapshot: () => callRemote<import("../../../../src/shared/space-host").PortalSnapshot>(connection, "workbenchGuide/presentationSnapshot", {}),
    hostActivity: signal => callRemote<{ attention: "required" | "none" | "unknown"; working: "busy" | "idle" | "unknown" }>(connection, "workbenchGuide/hostActivity", {}, signal),
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
    reportClientFailure: async (report: ClientFailureReport) => {
      try {
        return await callRemote<{ recorded: boolean }>(connection, "workbenchGuide/reportClientFailure", { report });
      } catch (error) {
        if (
          error instanceof WorkbenchRemoteError &&
          error.failureKind === "rpc-transport" &&
          readConnectionState(connection) !== "connected" &&
          typeof connection.state?.subscribe === "function"
        ) {
          let done = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let unsubscribe: (() => void) | undefined;
          const finish = () => {
            if (done) return;
            done = true;
            if (timer !== undefined) clearTimeout(timer);
            try { unsubscribe?.(); } catch { /* Ignore cleanup failure. */ }
          };
          const flush = () => {
            if (done || readConnectionState(connection) !== "connected") return;
            finish();
            void callRemote<{ recorded: boolean }>(connection, "workbenchGuide/reportClientFailure", { report }).catch(() => undefined);
          };
          timer = setTimeout(finish, 15_000);
          (timer as { unref?: () => void }).unref?.();
          unsubscribe = connection.state.subscribe(flush);
          if (done) {
            try { unsubscribe(); } catch { /* Ignore cleanup failure. */ }
          } else if (readConnectionState(connection) === "connected") {
            flush();
          }
        }
        return { recorded: false };
      }
    },
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
