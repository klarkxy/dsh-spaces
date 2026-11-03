import { CliInterruptedError } from "./cli";
import { HomeLockBusyError } from "../../home/home-operation-lock";
import type { CreateSpaceInput } from "../../../../shared/spaces-control";
import { PROFILE_NAME_RE, SPACE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../../../shared/types";

export const PUBLIC_ERROR = {
  "spaces/invalid-input": "The request is not a valid space operation.",
  "spaces/not-found": "That space was not found.",
  "spaces/host-denied": "The current host space cannot be modified this way.",
  "spaces/read-only": "Spaces are read-only until the host identity and runtime are confirmed.",
  "spaces/unavailable": "A previous space operation did not finish. Recovery is required.",
  "spaces/locked": "Another space operation is already running.",
  "spaces/already-exists": "A space with that name already exists.",
} as const;

export type SpacesErrorCode = keyof typeof PUBLIC_ERROR;

export const DIAGNOSTIC = {
  hostIdentityUnconfirmed: {
    code: "HOST_IDENTITY_UNCONFIRMED",
    message: "Host identity could not be confirmed from DSH home, loader root, and invocation profile.",
  },
  runtimeUnbound: {
    code: "RUNTIME_UNBOUND",
    message: "The bound DSH CLI could not be validated from the current process.",
  },
  runtimeIncompatible: {
    code: "RUNTIME_INCOMPATIBLE",
    message: "The bound DSH CLI is not an exact installed version.",
  },
  loaderMissing: {
    code: "LOADER_MISSING",
    message: "Required loader service is not available.",
  },
  liveConfigUnverified: {
    code: "LIVE_CONFIG_UNVERIFIED",
    message: "Current host configuration roots could not be verified.",
  },
  recoveryNeeded: {
    code: "RECOVERY_NEEDED",
    message: "A previous space mutation did not finish.",
  },
  lockHeld: {
    code: "LOCK_HELD",
    message: "A home operation lock is already held.",
  },
  lockResidue: {
    code: "LOCK_RESIDUE",
    message: "A home operation lock is incomplete or ambiguous and was not stolen.",
  },
  snapshotsUnavailable: {
    code: "SNAPSHOTS_UNAVAILABLE",
    message: "Snapshot metadata is unavailable because no snapshot root is configured.",
  },
  snapshotsUnreadable: {
    code: "SNAPSHOTS_UNREADABLE",
    message: "Configured snapshot root could not be read safely.",
  },
  registryCorrupt: {
    code: "REGISTRY_CORRUPT",
    message: "The spaces registry could not be read safely.",
  },
} as const;

export const DISPLAY_NAME_MAX = 80;

const UNCREATABLE = new Set<string>([...RESERVED_PROFILE_NAMES, "desktop", "acp", "sdk", "sdk-minimal"]);

export class SpacesPublicError extends Error {
  readonly name = "SpacesPublicError";
  constructor(
    readonly code: SpacesErrorCode,
    message: string = PUBLIC_ERROR[code],
  ) {
    super(message);
  }
}

export function parseCreateInput(input: CreateSpaceInput): { name: string; displayName: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SpacesPublicError("spaces/invalid-input");
  }
  const keys = Object.keys(input as object);
  for (const key of keys) {
    if (key !== "name" && key !== "displayName") {
      throw new SpacesPublicError("spaces/invalid-input", "The request contains unsupported fields.");
    }
  }
  if (typeof input.name !== "string") throw new SpacesPublicError("spaces/invalid-input");
  const name = input.name;
  if (!SPACE_NAME_RE.test(name) || name.trim() !== name || UNCREATABLE.has(name) ||
    (process.platform === "win32" && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name))) {
    throw new SpacesPublicError("spaces/invalid-input");
  }
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== "string") throw new SpacesPublicError("spaces/invalid-input");
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > DISPLAY_NAME_MAX || /[\u0000-\u001f\\/]/.test(displayName)) {
      throw new SpacesPublicError("spaces/invalid-input");
    }
    return { name, displayName };
  }
  return { name, displayName: name };
}

export function parseSpaceId(id: string): string {
  if (typeof id !== "string" || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    throw new SpacesPublicError("spaces/not-found");
  }
  if (id !== "web" && !PROFILE_NAME_RE.test(id)) throw new SpacesPublicError("spaces/not-found");
  return id;
}

export function toPublic(error: unknown, fallback: SpacesErrorCode): SpacesPublicError {
  if (error instanceof SpacesPublicError) return error;
  if (error instanceof HomeLockBusyError) return new SpacesPublicError("spaces/locked");
  if (error instanceof CliInterruptedError) return new SpacesPublicError("spaces/unavailable");
  return new SpacesPublicError(fallback);
}
