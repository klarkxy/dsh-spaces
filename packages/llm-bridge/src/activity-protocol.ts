export const LLM_ACTIVITY_CHANNEL = "dsh-spaces:llm-activity";
export const LLM_ACTIVITY_TIMEOUT_MS = 5_000;

export type LlmActivityStatus = "idle" | "busy" | "unknown";
export type LlmActivityIdentity = {
  spaceId: string;
  generation: number;
  serviceEpoch: string;
};
export type LlmActivityRequest = LlmActivityIdentity & {
  type: typeof LLM_ACTIVITY_CHANNEL;
  kind: "request";
  requestId: string;
  operation: "observe" | "reserve" | "release";
  reservationId: string;
};
export type LlmActivityReport = LlmActivityIdentity & {
  type: typeof LLM_ACTIVITY_CHANNEL;
  kind: "state" | "reply";
  revision: number;
  status: LlmActivityStatus;
  requestId?: string;
  reserved?: boolean;
  released?: boolean;
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

export function activityIdentityMatches(value: unknown, identity: LlmActivityIdentity): boolean {
  const row = record(value);
  return row?.type === LLM_ACTIVITY_CHANNEL && row.spaceId === identity.spaceId &&
    row.generation === identity.generation && row.serviceEpoch === identity.serviceEpoch;
}

export function parseActivityRequest(value: unknown, identity: LlmActivityIdentity): LlmActivityRequest | undefined {
  const row = record(value);
  if (!row || !activityIdentityMatches(row, identity) || row.kind !== "request" ||
    !identifier(row.requestId) || !identifier(row.reservationId) ||
    (row.operation !== "observe" && row.operation !== "reserve" && row.operation !== "release")) return undefined;
  return row as LlmActivityRequest;
}

export function parseActivityReport(value: unknown, identity: LlmActivityIdentity): LlmActivityReport | undefined {
  const row = record(value);
  if (!row || !activityIdentityMatches(row, identity) || !integer(row.revision) ||
    (row.status !== "idle" && row.status !== "busy" && row.status !== "unknown")) return undefined;
  if (row.kind === "state") return row as LlmActivityReport;
  if (row.kind === "reply" && identifier(row.requestId) && typeof row.reserved === "boolean" &&
    typeof row.released === "boolean") {
    return row as LlmActivityReport;
  }
  return undefined;
}

export function activityIdentityFromEnv(env: NodeJS.ProcessEnv): LlmActivityIdentity | undefined {
  const spaceId = env.DSH_SPACES_VIEW_ID;
  const generation = env.DSH_SPACES_VIEW_GENERATION;
  const serviceEpoch = env.DSH_SPACES_VIEW_SERVICE_EPOCH;
  if (spaceId === undefined && generation === undefined && serviceEpoch === undefined) return undefined;
  if (!identifier(spaceId) || !generation || !/^\d+$/.test(generation) ||
    !integer(Number(generation)) || !serviceEpoch || !/^[a-f0-9]{64}$/.test(serviceEpoch)) {
    throw new Error("The LLM activity launch identity is invalid.");
  }
  return { spaceId, generation: Number(generation), serviceEpoch };
}

export interface LlmActivityTransport {
  readonly connected: boolean;
  send?(message: unknown, callback: (error: Error | null) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
