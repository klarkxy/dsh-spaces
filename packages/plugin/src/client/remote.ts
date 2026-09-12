import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {
  CreateSpaceInput,
  SpaceDetail,
  SpaceSummary,
  SpacesControlApi,
  SpacesOverview,
  VerifySpaceResult,
} from "../../../../src/shared/spaces-control";

/**
 * Transport adapter for the Spaces control Remote API.
 *
 * Wire contract (matches the Host-side Spaces namespace):
 *   channel  "/api"
 *   endpoint "spaces/overview" | "spaces/detail" | "spaces/create" | "spaces/verify"
 *   payload  { args: {} } | { args: { id } } | { args: { input } }
 *   result   ConnectionRpcResult<DTO> — { ok: true, value } or
 *            { ok: false, error: { code, message, details } }
 *
 * Evidence: @deepseek-ai/dsh-client-connection `ClientConnectionRpc.call` and
 * the shipped dsh-api-gateway invocation path
 * (`connection.rpc.call("/api", endpoint, { args }, signal)`).
 */

const CHANNEL = "/api";

const ENDPOINTS = {
  overview: "spaces/overview",
  detail: "spaces/detail",
  create: "spaces/create",
  verify: "spaces/verify",
} as const;

/**
 * Backend business error codes whose messages are written for end users and
 * are safe to display verbatim. Anything outside this list — transport
 * failures, internal errors, malformed payloads — collapses to a generic
 * message so raw internals, paths or credentials never reach the DOM.
 */
export const KNOWN_SPACES_ERROR_CODES: ReadonlySet<string> = new Set([
  "spaces/read-only",
  "spaces/host-denied",
  "spaces/invalid-input",
  "spaces/not-found",
  "spaces/already-exists",
  "spaces/locked",
  "spaces/unavailable",
]);

const GENERIC_ERROR_MESSAGE = "The Spaces service request failed. Try again later.";

/** Display-safe error: `message` is guaranteed user-presentable. */
export class SpacesRemoteError extends Error {
  readonly code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.name = "SpacesRemoteError";
    this.code = code;
  }
}

function sanitizeBackendError(error: unknown): SpacesRemoteError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const { code, message } = error as { code: string; message: string };
    if (KNOWN_SPACES_ERROR_CODES.has(code) && message.length > 0) {
      return new SpacesRemoteError(code, message);
    }
  }
  return new SpacesRemoteError(null, GENERIC_ERROR_MESSAGE);
}

function sanitizeThrown(): SpacesRemoteError {
  return new SpacesRemoteError(null, GENERIC_ERROR_MESSAGE);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpacesRemoteError(null, GENERIC_ERROR_MESSAGE);
  }
  return value as Record<string, unknown>;
}

/** Minimal structural face of ctx.connection used by this plugin. */
export type SpacesConnection = Pick<ConnectionHandle, "rpc">;

async function callSpaces<T>(
  connection: SpacesConnection,
  endpoint: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  let result;
  try {
    result = await connection.rpc.call(CHANNEL, endpoint, { args }, signal);
  } catch {
    throw sanitizeThrown();
  }
  if (!result.ok) throw sanitizeBackendError(result.error);
  return requireObject(result.value) as T;
}

/**
 * Bridge a live ctx.connection handle to the shared SpacesControlApi face.
 * Pure transport: no Node/Electron APIs, no SDK shims.
 */
export function createSpacesRemote(connection: SpacesConnection): SpacesControlApi {
  return {
    overview: () => callSpaces<SpacesOverview>(connection, ENDPOINTS.overview, {}),
    detail: (id: string) => callSpaces<SpaceDetail>(connection, ENDPOINTS.detail, { id }),
    create: (input: CreateSpaceInput) =>
      callSpaces<SpaceSummary>(connection, ENDPOINTS.create, { input }),
    verify: (id: string) => callSpaces<VerifySpaceResult>(connection, ENDPOINTS.verify, { id }),
  };
}

/** Normalize any rejection into a display-safe message. */
export function displayMessage(error: unknown): string {
  return error instanceof SpacesRemoteError ? error.message : GENERIC_ERROR_MESSAGE;
}
