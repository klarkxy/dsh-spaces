import type { SpaceAttention } from "../../../../src/shared/space-attention";

/**
 * The passive activity projection of the native space this host process IS.
 *
 * Host-local counterpart of the child-space attention probe: the same three
 * native Cordis services are read, but nothing crosses IPC — the sampler
 * computes on demand inside the trusted main host, so the client poll cadence
 * is the refresh cadence. The projection is boolean-grade only: no session
 * content, no request payloads, no credentials. A missing service or a thrown
 * read degrades to `unknown`; it is never guessed, and each dimension is
 * computed independently so one degraded read never masks the other.
 */
export interface HostActivityProjection {
  /** A pending tool approval or an answerable `ask_user_question` in this space. */
  attention: SpaceAttention;
  /** At least one live Agent of this space is inside a turn. */
  working: "busy" | "idle" | "unknown";
}

/** Pending forwarded Remote events as exposed by `ctx.typertGateway`. */
export interface HostActivityGateway {
  getPendingRemoteEvents(): readonly { event: string; agentId: unknown }[];
}
/** Live session listing face of `ctx.sessions`. */
export interface HostActivitySessions {
  list(): readonly unknown[];
}
/** Projection snapshot face of `ctx.sessionProjections`. */
export interface HostActivityProjections {
  snapshot(session: unknown, keys?: readonly string[]): { values?: Record<string, unknown> };
}
/** Live agent listing face of `ctx.agents`. */
export interface HostActivityAgents {
  list(): readonly { status?: unknown }[];
}
export interface HostActivitySources {
  typertGateway?: HostActivityGateway;
  sessions?: HostActivitySessions;
  sessionProjections?: HostActivityProjections;
  agents?: HostActivityAgents;
}

const UNKNOWN: HostActivityProjection = { attention: "unknown", working: "unknown" };

/** One question projection is well-formed only when it carries its active list. */
function userQuestionsActive(value: unknown): readonly unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const active = (value as { active?: unknown }).active;
  return Array.isArray(active) ? active : undefined;
}

/**
 * Attention half: order-independent evidence aggregation.
 *
 * Two independent evidence channels — the Gateway's pending forwarded
 * approvals/questions and the per-session `userQuestions` projection — are
 * scanned completely, each on its own terms. A broken sample (missing or
 * malformed projection, one session whose read throws, a channel that is
 * absent or failing) only marks the observation incomplete; it never ends
 * the scan early and never masks evidence another channel or a later
 * session already confirmed. The verdict is then:
 *
 *   any confirmed pending item or active card -> `required` (order-free)
 *   nothing confirmed, but coverage incomplete -> `unknown` (never a false quiet)
 *   everything valid and nothing pending       -> `none`
 *
 * The official registry serves an empty `values` map when the `userQuestions`
 * unit is not registered, so a missing key is a coverage gap, not quiet.
 */
export function computeHostAttention(sources: HostActivitySources): SpaceAttention {
  const { typertGateway, sessions, sessionProjections } = sources;
  let confirmed = false;
  let degraded = false;

  if (!typertGateway || typeof typertGateway.getPendingRemoteEvents !== "function") {
    degraded = true;
  } else {
    try {
      for (const pending of typertGateway.getPendingRemoteEvents()) {
        if (pending?.event === "approval/request" || pending?.event === "user-questions/request") confirmed = true;
      }
    } catch {
      degraded = true;
    }
  }

  if (!sessions || typeof sessions.list !== "function" ||
    !sessionProjections || typeof sessionProjections.snapshot !== "function") {
    degraded = true;
  } else {
    for (const session of sessions.list()) {
      let snapshot: { values?: Record<string, unknown> } | undefined;
      try {
        snapshot = sessionProjections.snapshot(session, ["userQuestions"]);
      } catch {
        degraded = true;
        continue;
      }
      const active = userQuestionsActive(snapshot?.values?.userQuestions);
      if (active === undefined) { degraded = true; continue; }
      if (active.length > 0) confirmed = true;
    }
  }

  if (confirmed) return "required";
  if (degraded) return "unknown";
  return "none";
}

/**
 * Working half: the native authority for "in a turn" is `agent.status === "running"`
 * (the same read the official session state controller and the `api-session/status`
 * event use). Anything unreadable or outside the closed status pair is unknown —
 * an unrecognized value is never read as idle.
 */
export function computeHostWorking(sources: HostActivitySources): HostActivityProjection["working"] {
  const { agents } = sources;
  if (!agents || typeof agents.list !== "function") return "unknown";
  let unknown = false;
  for (const agent of agents.list()) {
    if (agent?.status === "running") return "busy";
    if (agent?.status !== "idle") unknown = true;
  }
  return unknown ? "unknown" : "idle";
}

/**
 * One complete passive sample. Throws degrade only the dimension that threw;
 * this function itself never throws for source failures.
 */
export function computeHostActivity(sources: HostActivitySources): HostActivityProjection {
  let attention: SpaceAttention = "unknown";
  let working: HostActivityProjection["working"] = "unknown";
  try {
    attention = computeHostAttention(sources);
  } catch {
    attention = "unknown";
  }
  try {
    working = computeHostWorking(sources);
  } catch {
    working = "unknown";
  }
  return { attention, working };
}

/** Wire validation of the public projection: closed keys, closed values, no extras. */
export function parseHostActivity(value: unknown): HostActivityProjection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== 2 || !keys.includes("attention") || !keys.includes("working")) return undefined;
  if (row.attention !== "required" && row.attention !== "none" && row.attention !== "unknown") return undefined;
  if (row.working !== "busy" && row.working !== "idle" && row.working !== "unknown") return undefined;
  return row as unknown as HostActivityProjection;
}

type CordisServiceGetter = { get?(name: string, strict?: boolean): unknown };

/** Lazy service resolution: a missing service degrades to unknown, never a failed install. */
function hostActivitySourcesFrom(ctx: CordisServiceGetter): () => HostActivitySources {
  const get = ctx.get;
  return () => ({
    typertGateway: (typeof get === "function" ? get.call(ctx, "typertGateway", false) : undefined) as HostActivityGateway | undefined,
    sessions: (typeof get === "function" ? get.call(ctx, "sessions", false) : undefined) as HostActivitySessions | undefined,
    sessionProjections: (typeof get === "function" ? get.call(ctx, "sessionProjections", false) : undefined) as HostActivityProjections | undefined,
    agents: (typeof get === "function" ? get.call(ctx, "agents", false) : undefined) as HostActivityAgents | undefined,
  });
}

/**
 * Read the host's own passive projection inside its process. Presentation
 * read only: it never mutates agent state, never forwards session content,
 * and never guesses a missing service. Install nothing — the caller decides
 * the cadence.
 */
export function readHostActivity(ctx: CordisServiceGetter): HostActivityProjection {
  try {
    return computeHostActivity(hostActivitySourcesFrom(ctx)());
  } catch {
    return { ...UNKNOWN };
  }
}
