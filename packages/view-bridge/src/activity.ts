import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { LLM_ERROR, LlmConfigError } from "../../../src/shared/llm-connections";
import {
  LLM_ACTIVITY_CHANNEL,
  activityIdentityFromEnv,
  parseActivityRequest,
  type LlmActivityIdentity,
  type LlmActivityReport,
  type LlmActivityStatus,
  type LlmActivityTransport,
} from "../../../src/shared/llm-activity";

type ActivityAgent = Pick<Agent, "status"> & Partial<Pick<Agent, "whenIdle" | "runMaintenance">>;
type AgentActivity = {
  agent: ActivityAgent;
  observable: boolean;
  idle: boolean;
  maintenance: number;
  original: Agent["runMaintenance"];
  wrapper: Agent["runMaintenance"];
  restore(): void;
};
type IdleClaim = { release(): void; settled: Promise<unknown> };

/**
 * Process-local admission on the inherited parent IPC descriptor. No session
 * contents or credentials cross it; an idle reservation closes the check/stop
 * race by refusing new stream consumption until its owner releases it.
 */
export class LlmActivity {
  private streams = 0;
  private revision = 0;
  private reservation: string | undefined;
  private closed = false;
  private reportingFailed = false;
  private lastState: LlmActivityStatus | undefined;
  private readonly tracked = new Map<ActivityAgent, AgentActivity>();
  private claims: IdleClaim[] = [];

  constructor(
    private readonly identity: LlmActivityIdentity,
    private readonly transport: LlmActivityTransport,
    private readonly agents: () => readonly ActivityAgent[] | undefined,
  ) {
    transport.on("message", this.receive);
    transport.on("disconnect", this.close);
    this.publish();
  }

  status(): LlmActivityStatus {
    if (this.closed || this.reportingFailed) return "unknown";
    if (this.streams > 0) return "busy";
    try {
      const agents = this.agents();
      if (!Array.isArray(agents)) return "unknown";
      for (const [agent, activity] of this.tracked) {
        if (!agents.includes(agent)) { activity.restore(); this.tracked.delete(agent); }
      }
      if (agents.some((agent) => agent?.status === "running")) return "busy";
      const activity = agents.map(agent => this.trackAgent(agent));
      if (activity.some(record => record?.maintenance)) return "busy";
      return agents.every(agent => agent?.status === "idle") &&
        activity.every(record => record?.observable && record.idle &&
          record.agent.runMaintenance === record.wrapper) ? "idle" : "unknown";
    } catch {
      return "unknown";
    }
  }

  private observeIdle(record: AgentActivity): void {
    record.idle = false;
    try {
      const idle = record.agent.whenIdle!();
      if (!idle || typeof idle.then !== "function") { record.observable = false; return; }
      void idle.then(() => {
        if (this.tracked.get(record.agent) !== record) return;
        record.idle = true;
        this.publish();
      }, () => {
        record.observable = false;
        this.publish();
      });
    } catch {
      record.observable = false;
    }
  }

  private trackAgent(agent: ActivityAgent): AgentActivity | undefined {
    const tracked = this.tracked.get(agent);
    if (tracked) return tracked;
    if (!agent || typeof agent.runMaintenance !== "function" || typeof agent.whenIdle !== "function") return undefined;
    const original = agent.runMaintenance;
    const descriptor = Object.getOwnPropertyDescriptor(agent, "runMaintenance");
    const activity = this;
    const record: AgentActivity = {
      agent, original, observable: true, idle: false, maintenance: 0,
      wrapper<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (activity.reservation) {
          throw new LlmConfigError(LLM_ERROR.SPACE_BUSY, "LLM configuration apply has reserved this idle space.");
        }
        record.maintenance++;
        activity.publish();
        const finish = () => { record.maintenance--; activity.publish(); };
        try {
          return original.call(agent, task).then(value => { finish(); return value as T; }, error => {
            finish(); throw error;
          });
        } catch (error) {
          finish();
          throw error;
        }
      },
      restore() {
        if (agent.runMaintenance !== record.wrapper) return;
        if (descriptor) Object.defineProperty(agent, "runMaintenance", descriptor);
        else delete agent.runMaintenance;
      },
    };
    try {
      Object.defineProperty(agent, "runMaintenance", { value: record.wrapper, configurable: true, writable: true });
    } catch {
      return undefined;
    }
    this.tracked.set(agent, record);
    // Observation never admits a waiting apply. Until this settles, activity is
    // unknown; this also covers maintenance already active when the bridge loads.
    this.observeIdle(record);
    return record;
  }

  private claimIdle(reservationId: string): boolean {
    this.reservation = reservationId;
    try {
      for (const record of this.tracked.values()) {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const result = record.original.call(record.agent, (signal) => {
          const abort = () => release();
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          return gate.finally(() => signal.removeEventListener("abort", abort));
        });
        // The native maintenance claim rejects active work synchronously. Its
        // own abort signal releases this empty claim during cooperative stop,
        // so holding admission cannot deadlock the official agent disposer.
        this.claims.push({ release, settled: result });
        void result.catch(() => { record.observable = false; this.publish(); });
      }
      return true;
    } catch {
      for (const record of this.tracked.values()) this.observeIdle(record);
      return false;
    }
  }

  private async releaseClaims(reservationId: string): Promise<boolean> {
    if (this.reservation !== reservationId) return this.reservation === undefined;
    const claims = this.claims;
    for (const claim of claims) claim.release();
    const outcomes = await Promise.allSettled(claims.map(claim => claim.settled));
    if (outcomes.some(outcome => outcome.status === "rejected")) return false;
    if (this.reservation === reservationId) { this.claims = []; this.reservation = undefined; }
    return this.reservation === undefined;
  }

  stream(next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const activity = this;
    return (async function* () {
      if (activity.reservation) {
        throw new LlmConfigError(LLM_ERROR.SPACE_BUSY, "LLM configuration apply has reserved this idle space.");
      }
      activity.streams++;
      activity.publish();
      try {
        yield* next();
      } finally {
        activity.streams--;
        activity.publish();
      }
    })();
  }

  publish = (): void => {
    this.report({ kind: "state" });
  };

  private report(detail: Pick<LlmActivityReport, "kind" | "requestId" | "reserved" | "released">): void {
    if (detail.kind === "state" && this.reportingFailed) return;
    if (!this.transport.connected || !this.transport.send) return;
    const status = this.status();
    if (detail.kind === "state" && status === this.lastState) return;
    this.lastState = status;
    const message: LlmActivityReport = {
      type: LLM_ACTIVITY_CHANNEL,
      ...this.identity,
      ...detail,
      revision: ++this.revision,
      status,
    };
    try {
      this.transport.send(message, (error) => { if (error) this.reportingFailed = true; });
    } catch {
      this.reportingFailed = true;
    }
  }

  private receive = (raw: unknown): void => {
    if (this.closed) return;
    const message = parseActivityRequest(raw, this.identity);
    if (!message) return;
    let reserved = false, released = false;
    if (message.operation === "reserve") {
      if ((!this.reservation || this.reservation === message.reservationId) && this.status() === "idle") {
        reserved = this.reservation === message.reservationId || this.claimIdle(message.reservationId);
      }
    } else if (message.operation === "release") {
      void this.releaseClaims(message.reservationId).then(released => {
        this.report({ kind: "reply", requestId: message.requestId, reserved: false, released });
      });
      return;
    }
    this.report({ kind: "reply", requestId: message.requestId, reserved, released });
  };

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.publish();
    this.transport.off("message", this.receive);
    this.transport.off("disconnect", this.close);
    for (const record of this.tracked.values()) record.restore();
    this.tracked.clear();
  };
}

export function installLlmActivity(
  ctx: Context, env: NodeJS.ProcessEnv = process.env, transport: LlmActivityTransport = process,
): void {
  const identity = activityIdentityFromEnv(env);
  if (!identity || !transport.connected || !transport.send) return;
  let readAgents: () => readonly ActivityAgent[] | undefined = () => undefined;
  const activity = new LlmActivity(identity, transport, () => readAgents());
  ctx.inject(["agents"], (agentsCtx) => {
    const reader = () => agentsCtx.agents.list();
    readAgents = reader;
    activity.publish();
    agentsCtx.effect(() => () => {
      if (readAgents === reader) {
        readAgents = () => undefined;
        activity.publish();
      }
    });
  });
  ctx.on("llm/stream", (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
    activity.stream(next), { global: true, prepend: true });
  ctx.on("agent/status", activity.publish, { global: true });
  ctx.on("agent/created", () => { activity.publish(); return undefined; }, { global: true });
  ctx.on("agent/disposed", activity.publish, { global: true });
  ctx.effect(() => activity.close);
}
