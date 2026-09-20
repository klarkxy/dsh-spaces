/** Node-only protocol helpers. Do not import this from browser shared contracts. */
import { createHash } from "node:crypto";
import type { WorkbenchHomeSettings } from "../../shared/workbench-product";
import type { WorkbenchMutationContext, WorkbenchSpace } from "../../shared/workbench";

export const WORKBENCH_PROTOCOL_VERSION = 2 as const;

export const WORKBENCH_PROTOCOL_CONFLICT = "workbench/conflict" as const;
export const WORKBENCH_PROTOCOL_INVALID = "workbench/invalid-input" as const;

const DIGEST_RE = /^[a-f0-9]{64}$/;
const HOME_DIGEST_PREFIX = "dsh-spaces-home-v1:";
const EPOCH_DIGEST_PREFIX = "dsh-spaces-epoch-v1:";
const REVISION_DIGEST_PREFIX = "dsh-spaces-revision-v1:";

export class WorkbenchProtocolConflictError extends Error {
  readonly name = "WorkbenchProtocolConflictError";
  readonly code = WORKBENCH_PROTOCOL_CONFLICT;
  constructor(message = "The service epoch or state revision does not match.") {
    super(message);
  }
}

export class WorkbenchProtocolInputError extends Error {
  readonly name = "WorkbenchProtocolInputError";
  readonly code = WORKBENCH_PROTOCOL_INVALID;
  constructor(message = "The mutation context is not valid.") {
    super(message);
  }
}

export type WorkbenchRevisionSpace = Pick<
  WorkbenchSpace,
  | "id"
  | "displayName"
  | "icon"
  | "isolation"
  | "generation"
  | "status"
  | "managed"
  | "needsIsolation"
  | "isHost"
  | "hasWebApp"
>;

export type WorkbenchRevisionInput = {
  spaces: readonly WorkbenchRevisionSpace[];
  settings: WorkbenchHomeSettings;
};

export function digestHomeIdentity(canonicalHome: string): string {
  if (typeof canonicalHome !== "string" || canonicalHome.length === 0) {
    throw new WorkbenchProtocolInputError("A canonical Home path is required to digest identity.");
  }
  return sha256(`${HOME_DIGEST_PREFIX}${canonicalHome}`);
}

/** Public service epoch from the lock nonce. The nonce itself is never returned. */
export function deriveServiceEpoch(ownerNonce: string): string {
  if (typeof ownerNonce !== "string" || ownerNonce.length === 0) {
    throw new WorkbenchProtocolInputError("An owner nonce is required to derive the service epoch.");
  }
  return sha256(`${EPOCH_DIGEST_PREFIX}${ownerNonce}`);
}

/**
 * Deterministic management-state digest. Covers space metadata, generation/status
 * and Home settings, including the caller-provided space list order.
 * Jobs, clocks and logs are not accepted as inputs.
 */
export function computeWorkbenchRevision(input: WorkbenchRevisionInput): string {
  if (!input || !Array.isArray(input.spaces) || !input.settings) {
    throw new WorkbenchProtocolInputError("Revision input requires spaces and settings.");
  }
  const spaces = input.spaces.map((space) => ({
    displayName: space.displayName,
    generation: space.generation,
    hasWebApp: space.hasWebApp,
    icon: space.icon,
    id: space.id,
    isHost: space.isHost,
    isolation: space.isolation,
    managed: space.managed,
    needsIsolation: space.needsIsolation,
    status: space.status,
  }));
  const payload = {
    settings: {
      catalogUrl: input.settings.catalogUrl,
      packageSource: input.settings.packageSource,
      portEnd: input.settings.portEnd,
      portStart: input.settings.portStart,
    },
    spaces,
  };
  return sha256(`${REVISION_DIGEST_PREFIX}${JSON.stringify(payload)}`);
}

export function parseMutationContext(value: unknown): WorkbenchMutationContext {
  if (!isPlainObject(value)) {
    throw new WorkbenchProtocolInputError();
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("serviceEpoch" in value) || !("expectedRevision" in value)) {
    throw new WorkbenchProtocolInputError();
  }
  const serviceEpoch = value.serviceEpoch;
  const expectedRevision = value.expectedRevision;
  if (typeof serviceEpoch !== "string" || !DIGEST_RE.test(serviceEpoch)) {
    throw new WorkbenchProtocolInputError();
  }
  if (typeof expectedRevision !== "string" || !DIGEST_RE.test(expectedRevision)) {
    throw new WorkbenchProtocolInputError();
  }
  return { serviceEpoch, expectedRevision };
}

export function assertMutationContext(
  context: WorkbenchMutationContext,
  current: { serviceEpoch: string; revision: string },
): void {
  const parsed = parseMutationContext(context);
  if (parsed.serviceEpoch !== current.serviceEpoch || parsed.expectedRevision !== current.revision) {
    throw new WorkbenchProtocolConflictError();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
