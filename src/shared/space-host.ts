/** Presentation contracts only. Neither an application name nor these DTOs grant management rights. */
export const PORTAL_SOURCE = "dsh-spaces-portal";
export const PORTAL_PARENT_SOURCE = "dsh-spaces-portal-parent";
export const CONTAINED_MANAGEMENT_PARAM = "dsh-spaces-contained";
export const PORTAL_CHANNEL_RE = /^[a-f0-9]{32}$/;
export const PORTAL_SPACE_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
export type NativeSpaceTarget = "@settings" | string;
/**
 * The closed fragment the desktop shell writes into the portal page after it
 * has opened the settings page. The portal page forwards it to the manager
 * guest, which opens its own create dialog on top of that page. It carries
 * presentation only: no right, no credential and no management request
 * travels with it.
 *
 * An older portal page does not know this fragment. It ignores it and the
 * user stays on the settings page without a dialog: no failure, no timeout.
 */
export function nativeCreateIntentHash(requestId: number): string {
  return "#intent/create/" + String(requestId);
}
/** Strictly parsed create intent. Only a bounded positive integer is accepted. */
export function parseNativeCreateIntent(hash: string): number | null {
  const match = /^#intent\/create\/([1-9][0-9]{0,9})$/.exec(hash);
  if (!match) return null;
  const requestId = Number(match[1]);
  return Number.isSafeInteger(requestId) ? requestId : null;
}
export function isNativeSpaceTarget(value: unknown): value is NativeSpaceTarget {
  return value === "@settings" || typeof value === "string" && PORTAL_SPACE_RE.test(value);
}
export interface NativeSpaceNavigation { kind: "select" | "selected" | "rejected"; requestId: number; target: NativeSpaceTarget; targetGeneration?: number }
/** A fragment carries presentation only. The document still needs its operator session. */
export function parseNativeSpaceHash(hash: string): NativeSpaceNavigation | null {
  const match = /^#(select|selected|rejected)\/([1-9][0-9]{0,9})\/(@settings|[a-z0-9][a-z0-9-]{0,38})(?:\/(0|[1-9][0-9]{0,15}))?$/.exec(hash);
  if (!match) return null;
  const targetGeneration = match[4] === undefined ? undefined : Number(match[4]);
  if (targetGeneration !== undefined && (match[1] !== "select" || match[3] === "@settings" || !Number.isSafeInteger(targetGeneration))) return null;
  return { kind: match[1] as NativeSpaceNavigation["kind"], requestId: Number(match[2]), target: match[3],
    ...(targetGeneration === undefined ? {} : { targetGeneration }) };
}
export interface SpaceHostAudience { parentOrigin: string; channel: string }
export interface PortalSpace { id: string; displayName: string; status: string; generation: number; icon?: string }
export interface PortalSnapshot { serviceEpoch: string; managerId: string | null; spaces: PortalSpace[] }

export const PORTAL_FAILURE_REASONS = [
  "state-request", "state-invalid", "service-changed", "manager-generation-changed",
  "manager-stopped", "manager-view-request", "manager-view-invalid", "manager-view-failed",
  "manager-disconnected", "view-ready-timeout", "portal-entry-timeout",
] as const;
export const PORTAL_FAILURE_CODES = [
  "workbench/unauthorized", "workbench/forbidden", "workbench/unavailable",
  "workbench/invalid-input", "workbench/not-found", "workbench/failed",
  "workbench/unsupported", "workbench/busy", "workbench/conflict", "workbench/incompatible",
  "workbench/locked", "workbench/maintenance", "workbench/protected", "workbench/read-only",
  "workbench/recovery-required", "workbench/unmanaged",
  "portal/request-deadline", "portal/transport-failed", "portal/response-invalid",
] as const;
/** Closed presentation diagnostics. Never forward an exception, URL or server message. */
export interface PortalFailure {
  reason: typeof PORTAL_FAILURE_REASONS[number];
  code?: typeof PORTAL_FAILURE_CODES[number];
  status?: number;
}
export function parsePortalFailure(value: unknown): PortalFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Object.hasOwn(row, "reason") || Object.keys(row).some(key => !["reason", "code", "status"].includes(key)) ||
      !PORTAL_FAILURE_REASONS.includes(row.reason as PortalFailure["reason"]) ||
      (Object.hasOwn(row, "code") && !PORTAL_FAILURE_CODES.includes(row.code as NonNullable<PortalFailure["code"]>)) ||
      (Object.hasOwn(row, "status") && (!Number.isInteger(row.status) || (row.status as number) < 100 || (row.status as number) > 599))) return null;
  return { reason: row.reason as PortalFailure["reason"],
    ...(Object.hasOwn(row, "code") ? { code: row.code as PortalFailure["code"] } : {}),
    ...(Object.hasOwn(row, "status") ? { status: row.status as number } : {}) };
}

const portalFailureCauses: Record<PortalFailure["reason"], string> = {
  "state-request": "The portal could not read the space service state.",
  "state-invalid": "The space service returned invalid portal state data.",
  "service-changed": "The space service epoch changed during this portal lifetime.",
  "manager-generation-changed": "The manager generation changed during this portal lifetime.",
  "manager-stopped": "The manager is no longer running.",
  "manager-view-request": "The portal could not request the manager view.",
  "manager-view-invalid": "The manager view identity or entry data was invalid.",
  "manager-view-failed": "The manager view reported that its UI did not become ready.",
  "manager-disconnected": "The manager view connection disconnected.",
  "view-ready-timeout": "The manager view did not complete readiness before the deadline.",
  "portal-entry-timeout": "The portal did not report space service state before the entry deadline.",
};
/** Fixed presentation text shared by the portable and native controllers. */
export function portalFailureDetail(failure: PortalFailure): string {
  return portalFailureCauses[failure.reason] +
    (failure.status === undefined ? "" : ` HTTP ${failure.status}.`) +
    (failure.code === undefined ? "" : ` Code: ${failure.code}.`);
}

export const NATIVE_PORTAL_FAILURE_HASH_LIMIT = 512;
export function nativePortalFailureHash(value: unknown): string | null {
  const failure = parsePortalFailure(value);
  if (!failure) return null;
  const hash = "#failed/" + encodeURIComponent(JSON.stringify(failure));
  return hash.length <= NATIVE_PORTAL_FAILURE_HASH_LIMIT ? hash : null;
}
/** Only canonical encoded DTOs are accepted, including closed fields and bounded bytes. */
export function parseNativePortalFailureHash(hash: string): PortalFailure | null {
  if (hash.length > NATIVE_PORTAL_FAILURE_HASH_LIMIT || !hash.startsWith("#failed/")) return null;
  try {
    const failure = parsePortalFailure(JSON.parse(decodeURIComponent(hash.slice(8))));
    return failure && nativePortalFailureHash(failure) === hash ? failure : null;
  } catch { return null; }
}

/** The bundled iframe transport requires same-site loopback cookies. Native/remote transports need an adapter. */
export function parseSpaceHostAudience(value: unknown): SpaceHostAudience | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "channel,parentOrigin" ||
      typeof row.channel !== "string" || !PORTAL_CHANNEL_RE.test(row.channel) ||
      typeof row.parentOrigin !== "string" || row.parentOrigin.length > 128) return null;
  try {
    const url = new URL(row.parentOrigin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.origin !== row.parentOrigin ||
        url.username || url.password || url.search || url.hash) return null;
    return { parentOrigin: url.origin, channel: row.channel };
  } catch { return null; }
}

export function parsePortalSnapshot(value: unknown): PortalSnapshot | null {
  // Self-contained: the portal embeds this validator in its browser script.
  const spacePattern = /^[a-z0-9][a-z0-9-]{0,38}$/;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "managerId,serviceEpoch,spaces" ||
      typeof row.serviceEpoch !== "string" || !/^[a-f0-9]{64}$/.test(row.serviceEpoch) ||
      !(row.managerId === null || typeof row.managerId === "string" && spacePattern.test(row.managerId)) ||
      !Array.isArray(row.spaces) || row.spaces.length > 1000) return null;
  const ids = new Set<string>();
  const spaces: PortalSpace[] = [];
  for (const item of row.spaces) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const space = item as Record<string, unknown>;
    if (!["displayName,generation,id,status", "displayName,generation,icon,id,status"].includes(Object.keys(space).sort().join(",")) ||
        (space.icon !== undefined && (typeof space.icon !== "string" || space.icon.length > 240_000 ||
          !/^(?:|whale|hash|code|chat|lab|book|data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2})$/.test(space.icon))) ||
        typeof space.id !== "string" || !spacePattern.test(space.id) || ids.has(space.id) ||
        typeof space.displayName !== "string" || space.displayName.length > 200 ||
        typeof space.status !== "string" || !["running", "starting", "stopping", "stopped", "crashed", "unknown"].includes(space.status) ||
        !Number.isSafeInteger(space.generation) || (space.generation as number) < 0) return null;
    ids.add(space.id);
    spaces.push({ id: space.id, displayName: space.displayName, status: space.status, generation: space.generation as number,
      ...(space.icon === undefined ? {} : { icon: space.icon as string }) });
  }
  return { serviceEpoch: row.serviceEpoch, managerId: row.managerId as string | null, spaces };
}

/** Validate source, origin and one presentation lifetime before inspecting a message payload. */
export function portalMessage(event: { source: unknown; origin: string; data: unknown },
  frameWindow: unknown, origin: string, channel: string): Record<string, unknown> | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== origin || !PORTAL_CHANNEL_RE.test(channel)) return null;
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const row = event.data as Record<string, unknown>;
  if (row.source !== PORTAL_SOURCE || row.channel !== channel || typeof row.type !== "string") return null;
  return row;
}

/** Existing view handshake identity, supplied by the owning Host to a contained surface. */
export interface SpaceSurfaceView {
  parentOrigin: string;
  serviceEpoch: string;
  spaceId: string;
  generation: number;
  channel: string;
}
