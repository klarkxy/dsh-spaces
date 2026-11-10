/**
 * Space attention telemetry on the inherited child IPC descriptor.
 *
 * The child view bridge pushes identity-bound attention reports to the
 * Supervisor. The channel is push-only: no requests, no credentials and no
 * session content — only a presentation state per live child generation.
 */
export const SPACE_ATTENTION_CHANNEL = "dsh-spaces:space-attention";
export const SPACE_ATTENTION_POLL_MS = 1_000;

export type SpaceAttention = "required" | "none" | "unknown";
export type SpaceAttentionIdentity = {
  spaceId: string;
  generation: number;
  serviceEpoch: string;
};
export type SpaceAttentionReport = SpaceAttentionIdentity & {
  type: typeof SPACE_ATTENTION_CHANNEL;
  kind: "state";
  revision: number;
  attention: SpaceAttention;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function attentionIdentityMatches(value: unknown, identity: SpaceAttentionIdentity): boolean {
  const row = record(value);
  return row?.type === SPACE_ATTENTION_CHANNEL && row.spaceId === identity.spaceId &&
    row.generation === identity.generation && row.serviceEpoch === identity.serviceEpoch;
}

/** Strict report parser: identity match, closed kind and closed attention value. */
export function parseSpaceAttentionReport(value: unknown, identity: SpaceAttentionIdentity): SpaceAttentionReport | undefined {
  const row = record(value);
  if (!row || !attentionIdentityMatches(row, identity) || row.kind !== "state" || !integer(row.revision) ||
    (row.attention !== "required" && row.attention !== "none" && row.attention !== "unknown")) return undefined;
  return row as SpaceAttentionReport;
}

/** Identity comes from the supervisor-injected view env; invalid values are fatal, like the LLM channel. */
export function attentionIdentityFromEnv(env: Record<string, string | undefined>): SpaceAttentionIdentity | undefined {
  const spaceId = env.DSH_SPACES_VIEW_ID;
  const generation = env.DSH_SPACES_VIEW_GENERATION;
  const serviceEpoch = env.DSH_SPACES_VIEW_SERVICE_EPOCH;
  if (spaceId === undefined && generation === undefined && serviceEpoch === undefined) return undefined;
  if (!identifier(spaceId) || !generation || !/^\d+$/.test(generation) ||
    !integer(Number(generation)) || !serviceEpoch || !/^[a-f0-9]{64}$/.test(serviceEpoch)) {
    throw new Error("The space attention launch identity is invalid.");
  }
  return { spaceId, generation: Number(generation), serviceEpoch };
}

export interface SpaceAttentionTransport {
  readonly connected: boolean;
  send?(message: unknown, callback: (error: Error | null) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
