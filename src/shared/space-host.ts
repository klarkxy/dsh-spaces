/** Presentation contracts only. Neither an application name nor these DTOs grant management rights. */
export const PORTAL_SOURCE = "dsh-spaces-portal";
export const PORTAL_PARENT_SOURCE = "dsh-spaces-portal-parent";
export const CONTAINED_MANAGEMENT_PARAM = "dsh-spaces-contained";
export const PORTAL_CHANNEL_RE = /^[a-f0-9]{32}$/;
export const PORTAL_SPACE_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
export interface SpaceHostAudience { parentOrigin: string; channel: string }
export interface PortalSpace { id: string; displayName: string; status: string; generation: number }
export interface PortalSnapshot { serviceEpoch: string; managerId: string | null; spaces: PortalSpace[] }

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
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "managerId,serviceEpoch,spaces" ||
      typeof row.serviceEpoch !== "string" || !/^[a-f0-9]{64}$/.test(row.serviceEpoch) ||
      !(row.managerId === null || typeof row.managerId === "string" && PORTAL_SPACE_RE.test(row.managerId)) ||
      !Array.isArray(row.spaces) || row.spaces.length > 1000) return null;
  const ids = new Set<string>();
  const spaces: PortalSpace[] = [];
  for (const item of row.spaces) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const space = item as Record<string, unknown>;
    if (Object.keys(space).sort().join(",") !== "displayName,generation,id,status" ||
        typeof space.id !== "string" || !PORTAL_SPACE_RE.test(space.id) || ids.has(space.id) ||
        typeof space.displayName !== "string" || space.displayName.length > 200 ||
        typeof space.status !== "string" || !["running", "starting", "stopping", "stopped", "crashed", "unknown"].includes(space.status) ||
        !Number.isSafeInteger(space.generation) || (space.generation as number) < 0) return null;
    ids.add(space.id);
    spaces.push({ id: space.id, displayName: space.displayName, status: space.status, generation: space.generation as number });
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
