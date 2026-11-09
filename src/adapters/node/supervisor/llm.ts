import { randomUUID } from "node:crypto";
import { LLM_ERROR, LlmConfigError } from "../../../shared/llm-connections";
import type { SpacesComponent } from "../payload/dev-checkout";
import { profileHasLlmBridge } from "./profile-probe";
import type { SpaceRunRegistry } from "./space-runs";
import {
  LLM_ACTIVITY_CHANNEL,
  LLM_ACTIVITY_TIMEOUT_MS,
  parseActivityReport,
  type LlmActivityIdentity,
  type LlmActivityReport,
  type LlmActivityStatus,
  type LlmActivityTransport,
} from "../../../shared/llm-activity";

type ActivitySession = {
  identity: LlmActivityIdentity;
  transport: LlmActivityTransport;
  revision: number;
  status: LlmActivityStatus;
  cleanupFailure?: LlmConfigError;
  pending: Map<string, { resolve(report: LlmActivityReport): void; reject(error: Error): void }>;
  dispose(): void;
};

export interface SupervisorLlmHost {
  home: string;
  managerId: () => string | null;
  publicStatus: (id: string) => "running" | "stopped" | "crashed" | "unknown" | string;
  currentServiceEpoch: () => string;
  hasComponent: (component: SpacesComponent) => boolean;
  installComponent: (profileId: string, component: SpacesComponent) => Promise<void>;
  componentAligned: (profileId: string, component: SpacesComponent) => boolean;
  devCheckout: () => string | undefined;
  runs: SpaceRunRegistry;
}

export class SupervisorLlm {
  private readonly activity = new Map<string, ActivitySession>();

  constructor(private readonly host: SupervisorLlmHost) {}

  attachChild(spaceId: string, transport: LlmActivityTransport, generation: number, serviceEpoch: string): () => void {
    this.activity.get(spaceId)?.dispose();
    if (!transport.connected || !transport.send) return () => {};
    const identity = { spaceId, generation, serviceEpoch };
    const session: ActivitySession = {
      identity, transport, revision: -1, status: "unknown", pending: new Map(),
      dispose: () => {
        if (this.activity.get(spaceId) !== session) return;
        this.activity.delete(spaceId);
        transport.off("message", receive);
        for (const event of ["disconnect", "exit", "error"]) transport.off(event, session.dispose);
        for (const pending of [...session.pending.values()]) pending.reject(this.unknownActivity(spaceId));
        session.pending.clear();
      },
    };
    const receive = (raw: unknown) => {
      if (this.activity.get(spaceId) !== session) return;
      const report = parseActivityReport(raw, identity);
      if (!report || report.revision <= session.revision) return;
      session.revision = report.revision;
      session.status = report.status;
      if (report.kind === "reply" && report.requestId) session.pending.get(report.requestId)?.resolve(report);
    };
    this.activity.set(spaceId, session);
    transport.on("message", receive);
    for (const event of ["disconnect", "exit", "error"]) transport.on(event, session.dispose);
    // The bridge can already be loaded when a library caller attaches a child.
    void this.requestActivity(session, "observe", randomUUID()).catch(() => {});
    return session.dispose;
  }

  private unknownActivity(spaceId: string): LlmConfigError {
    return new LlmConfigError(LLM_ERROR.APPLY_FAILED, "space LLM activity is unknown; it was not stopped", { spaceId });
  }

  private currentActivity(spaceId: string): ActivitySession | undefined {
    const session = this.activity.get(spaceId);
    return session && session.transport.connected &&
      session.identity.generation === this.host.runs.generation(spaceId) &&
      session.identity.serviceEpoch === this.host.currentServiceEpoch() ? session : undefined;
  }

  async observeTaskActivity(spaceId: string): Promise<LlmActivityStatus> {
    if (["stopped", "crashed"].includes(this.host.publicStatus(spaceId))) return "idle";
    const session = this.currentActivity(spaceId);
    if (!session || session.cleanupFailure) return "unknown";
    try {
      const report = await this.requestActivity(session, "observe", randomUUID());
      return this.currentActivity(spaceId) === session ? report.status : "unknown";
    } catch { return "unknown"; } // No telemetry is never evidence of idleness.
  }

  async whileIdle<T>(spaceId: string, action: () => Promise<T>): Promise<T> {
    if (["stopped", "crashed"].includes(this.host.publicStatus(spaceId))) return action();
    const release = await this.reserveIdle(spaceId);
    try { return await action(); }
    finally { await release(); }
  }

  private requestActivity(
    session: ActivitySession, operation: "observe" | "reserve" | "release", reservationId: string,
  ): Promise<LlmActivityReport> {
    const requestId = randomUUID();
    const observedRevision = session.revision;
    return new Promise((resolve, reject) => {
      const settle = (error?: Error, report?: LlmActivityReport) => {
        if (!session.pending.delete(requestId)) return;
        clearTimeout(timer);
        if (error) {
          if (operation !== "observe" || session.revision === observedRevision) session.status = "unknown";
          reject(error);
        }
        else resolve(report!);
      };
      const timer = setTimeout(() => settle(this.unknownActivity(session.identity.spaceId)), LLM_ACTIVITY_TIMEOUT_MS);
      session.pending.set(requestId, {
        resolve: (report) => settle(undefined, report),
        reject: (error) => settle(error),
      });
      try {
        if (!session.transport.connected || !session.transport.send) throw this.unknownActivity(session.identity.spaceId);
        session.transport.send({
          type: LLM_ACTIVITY_CHANNEL, ...session.identity, kind: "request", requestId, operation, reservationId,
        }, (error) => { if (error) settle(error); });
      } catch (error) {
        settle(error instanceof Error ? error : this.unknownActivity(session.identity.spaceId));
      }
    });
  }

  private async reserveIdle(spaceId: string): Promise<(failure?: unknown) => Promise<void>> {
    const session = this.currentActivity(spaceId);
    if (!session) throw this.unknownActivity(spaceId);
    if (session.cleanupFailure) throw session.cleanupFailure;
    const reservationId = randomUUID();
    const release = async (originalFailure?: unknown) => {
      if (!session.transport.connected) return;
      try {
        const report = await this.requestActivity(session, "release", reservationId);
        if (!report.released) throw new Error("The exact idle reservation was not released.");
      } catch (cleanupError) {
        const original = originalFailure instanceof Error ? originalFailure.message : "";
        const failure = new LlmConfigError(LLM_ERROR.APPLY_FAILED,
          `${original ? `${original}; ` : ""}LLM apply reservation release could not be confirmed; activity remains unknown.`,
          { spaceId, releaseFailure: cleanupError instanceof Error ? cleanupError.message : "Unknown release failure" });
        failure.cause = originalFailure === undefined ? cleanupError : new AggregateError([originalFailure, cleanupError]);
        session.cleanupFailure = failure;
        session.status = "unknown";
        throw failure;
      }
    };
    try {
      const report = await this.requestActivity(session, "reserve", reservationId);
      if (this.currentActivity(spaceId) !== session || report.status === "unknown" ||
        session.status === "unknown") throw this.unknownActivity(spaceId);
      if (report.status === "busy" || session.status === "busy" || !report.reserved) {
        throw new LlmConfigError(LLM_ERROR.SPACE_BUSY, "space is busy; it was not force-stopped", { spaceId });
      }
      return release;
    } catch (error) {
      // A timed-out request can still have acquired admission. Release only our
      // nonce over the same ordered IPC descriptor; never retry the apply.
      await release(error);
      throw error;
    }
  }

  async ensureLlmBridge(profileId: string): Promise<void> {
    if (!this.host.hasComponent("llm-bridge")) return;
    if (profileId === "web" || profileId === this.host.managerId()) return;
    if (this.host.devCheckout() !== undefined
      ? this.host.componentAligned(profileId, "llm-bridge")
      : profileHasLlmBridge(this.host.home, profileId)) return;
    await this.host.installComponent(profileId, "llm-bridge");
  }
}
