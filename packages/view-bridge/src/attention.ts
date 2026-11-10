import type { Context } from "@deepseek-ai/cordis";
import {
  SPACE_ATTENTION_CHANNEL,
  SPACE_ATTENTION_POLL_MS,
  attentionIdentityFromEnv,
  type SpaceAttention,
  type SpaceAttentionIdentity,
  type SpaceAttentionReport,
  type SpaceAttentionTransport,
} from "../../../src/shared/space-attention";

/** Pending forwarded Remote events as exposed by `ctx.typertGateway`. */
type TypertGatewayLike = { getPendingRemoteEvents(): readonly { event: string; agentId: unknown }[] };
/** Session store face used for the userQuestions projection. */
type SessionsLike = { list(): readonly unknown[] };
type SessionProjectionsLike = { snapshot(session: unknown, keys?: readonly string[]): { values?: Record<string, unknown> } };
export type SpaceAttentionSources = {
  typertGateway?: TypertGatewayLike;
  sessions?: SessionsLike;
  sessionProjections?: SessionProjectionsLike;
};

/**
 * Push-only attention state on the inherited IPC descriptor.
 *
 * Attention is `required` only while a tool approval or an ask_user_question
 * card is pending in any Session of this space — never for errors or idle
 * turns. A missing service or a thrown read reports `unknown`; it is never
 * guessed as `none`.
 */
export class SpaceAttentionProbe {
  private revision = 0;
  private closed = false;
  private reportingFailed = false;
  private last: SpaceAttention | undefined;
  private readonly identity: SpaceAttentionIdentity;
  private readonly transport: SpaceAttentionTransport;
  private readonly sources: () => SpaceAttentionSources;
  private readonly log?: (message: string, cause?: unknown) => void;

  constructor(
    identity: SpaceAttentionIdentity,
    transport: SpaceAttentionTransport,
    sources: () => SpaceAttentionSources,
    log?: (message: string, cause?: unknown) => void,
  ) {
    this.identity = identity;
    this.transport = transport;
    this.sources = sources;
    this.log = log;
    transport.on("disconnect", this.close);
  }

  /** One detection sample. Throws are a degraded read, never a crash. */
  compute(): SpaceAttention {
    try {
      const { typertGateway, sessions, sessionProjections } = this.sources();
      if (!typertGateway || typeof typertGateway.getPendingRemoteEvents !== "function" ||
        !sessions || typeof sessions.list !== "function" ||
        !sessionProjections || typeof sessionProjections.snapshot !== "function") {
        this.degraded("space attention is unknown; a required host service is missing");
        return "unknown";
      }
      for (const pending of typertGateway.getPendingRemoteEvents()) {
        if (pending?.event === "approval/request" || pending?.event === "user-questions/request") return "required";
      }
      for (const session of sessions.list()) {
        const snapshot = sessionProjections.snapshot(session, ["userQuestions"]);
        const questions = snapshot?.values?.userQuestions;
        if (questions && typeof questions === "object" &&
          Array.isArray((questions as { active?: unknown }).active) &&
          (questions as { active: unknown[] }).active.length > 0) return "required";
      }
      return "none";
    } catch (error) {
      this.degraded("space attention read failed", error);
      return "unknown";
    }
  }

  private degraded = once((message: string, cause?: unknown) => this.log?.(message, cause));

  /** Recompute and report only on change. */
  poll = (): void => {
    const attention = this.compute();
    if (attention === this.last) return;
    this.last = attention;
    this.report(attention);
  };

  private report(attention: SpaceAttention): void {
    if (this.closed || this.reportingFailed) return;
    if (!this.transport.connected || !this.transport.send) return;
    const message: SpaceAttentionReport = {
      type: SPACE_ATTENTION_CHANNEL,
      ...this.identity,
      kind: "state",
      revision: ++this.revision,
      attention,
    };
    try {
      this.transport.send(message, (error) => { if (error) this.reportingFailed = true; });
    } catch {
      this.reportingFailed = true;
    }
  }

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.transport.off("disconnect", this.close);
  };
}

/** A logged degradation is reported once, not on every poll cycle. */
function once(fn: (message: string, cause?: unknown) => void): (message: string, cause?: unknown) => void {
  const seen = new Set<string>();
  return (message, cause) => {
    if (seen.has(message)) return;
    seen.add(message);
    try { fn(message, cause); } catch { /* logging must not break detection */ }
  };
}

/**
 * Wire the producer into a child space Cordis context. Called from the view
 * bridge when the supervisor injected its identity and an IPC descriptor
 * exists. Every service is read lazily, so the bridge loading before the
 * session stack is ready reports `unknown` instead of failing the plugin.
 */
export function installSpaceAttention(ctx: Context, env: NodeJS.ProcessEnv = process.env, transport: SpaceAttentionTransport = process): SpaceAttentionProbe | undefined {
  const identity = attentionIdentityFromEnv(env);
  if (!identity || !transport.connected || !transport.send) return undefined;
  const get = (ctx as { get?(name: string, strict?: boolean): unknown }).get;
  const sources = (): SpaceAttentionSources => ({
    typertGateway: (typeof get === "function" ? get.call(ctx, "typertGateway", false) : undefined) as TypertGatewayLike | undefined,
    sessions: (typeof get === "function" ? get.call(ctx, "sessions", false) : undefined) as SessionsLike | undefined,
    sessionProjections: (typeof get === "function" ? get.call(ctx, "sessionProjections", false) : undefined) as SessionProjectionsLike | undefined,
  });
  const logger = (ctx as { logger?: (name: string) => { warn(...args: unknown[]): void } }).logger;
  const warn = typeof logger === "function" ? logger.call(ctx, "dsh-spaces-view-bridge") : undefined;
  const attention = new SpaceAttentionProbe(identity, transport, sources,
    typeof warn?.warn === "function" ? (message, cause) => warn.warn(message, cause) : undefined);
  const on = (ctx as { on?(event: string, listener: (...args: any[]) => any, options?: unknown): unknown }).on;
  if (typeof on === "function") {
    // Session events flip timed question cards. Pending forwarded approvals are
    // registered asynchronously inside the waterfall chain and emit no event of
    // their own, so the interval below is what observes them.
    on.call(ctx, "session/event", attention.poll, { global: true });
    on.call(ctx, "session/created", attention.poll, { global: true });
    on.call(ctx, "session/disposed", attention.poll, { global: true });
  }
  const timer = setInterval(attention.poll, SPACE_ATTENTION_POLL_MS);
  (timer as { unref?: () => void }).unref?.();
  attention.poll();
  ctx.effect(() => () => {
    clearInterval(timer);
    attention.close();
  });
  return attention;
}
