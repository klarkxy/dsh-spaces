import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { GlobalLlmHost, LlmApplyCommand } from "../../../core/application/global-llm-host";
import { LLM_ERROR, LlmConfigError } from "../../../shared/llm-connections";
import type { LlmInstanceRecord } from "../../../core/ports/llm-runtime";
import { isLlmWriteMethod, type LlmApiResult } from "../../../shared/llm-api";
import type { WorkbenchJob, WorkbenchSpace } from "../../../shared/workbench";
import { llmCatalogPath } from "../llm/llm-paths";
import type { WorkbenchJobContext, WorkbenchJobStore } from "../maintenance/workbench-jobs";
import { WorkbenchPublicError } from "./errors";
import type { SupervisorLifecycle } from "./lifecycle";
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
  llmHost: () => GlobalLlmHost;
  jobs: () => WorkbenchJobStore | undefined;
  lifecycle: SupervisorLifecycle;
  managerId: () => string | null;
  hasComponent: (component: SpacesComponent) => boolean;
  installComponent: (profileId: string, component: SpacesComponent) => Promise<void>;
  componentAligned: (profileId: string, component: SpacesComponent) => boolean;
  devCheckout: () => string | undefined;
  runs: SpaceRunRegistry;
  observeChildWork: <T>(action: () => T) => T;
  requireManaged: (spaceId: string) => string;
  stopOwned: (spaceId: string) => Promise<void>;
  startSpace: (spaceId: string, ctx: WorkbenchJobContext) => Promise<WorkbenchJob["result"]>;
  homeProfileNames: () => string[];
  publicStatus: (id: string) => WorkbenchSpace["status"];
  currentServiceEpoch: () => string;
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

  async dispatchLlm(body: unknown): Promise<unknown> {
    const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined;
    const jobs = this.host.jobs();
    if (method === "applyPlan") {
      if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
      return this.host.llmHost().dispatch(body);
    }
    if (typeof method === "string" && isLlmWriteMethod(method)) {
      if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
      return jobs.runExclusive(async () => {
        this.assertLlmMutationAllowed();
        const result = await this.host.llmHost().dispatch(body);
        await this.maybeInstallLlmBridge(body);
        return result;
      });
    }
    const result = await this.host.llmHost().dispatch(body);
    await this.maybeInstallLlmBridge(body);
    return result;
  }

  async dispatchLlmCredential(body: unknown): Promise<unknown> {
    const jobs = this.host.jobs();
    if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
    return jobs.runExclusive(async () => {
      this.assertLlmMutationAllowed();
      return this.host.llmHost().dispatchCredential(body);
    });
  }

  private assertLlmMutationAllowed(): void {
    this.host.lifecycle.assertWritable();
    if (this.host.lifecycle.sealing) {
      throw new WorkbenchPublicError("workbench/unavailable", "The supervisor is releasing run rights.");
    }
    if (!this.host.jobs()) throw new WorkbenchPublicError("workbench/read-only");
  }

  async dispatchLlmAdmitted(body: unknown): Promise<LlmApiResult> {
    const jobs = this.host.jobs();
    if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
    return jobs.runAdmitted(async () => {
      const method = body && typeof body === "object" ? (body as { method?: unknown }).method : undefined;
      if (typeof method === "string" && isLlmWriteMethod(method)) {
        this.assertLlmMutationAllowed();
      }
      const result = await this.host.llmHost().dispatch(body);
      await this.maybeInstallLlmBridge(body);
      return result as LlmApiResult;
    });
  }

  llmCatalogObservation(): { revision: number; digest: string } {
    const path = llmCatalogPath(this.host.home);
    let digest = createHash("sha256").update("").digest("hex");
    let revision = 0;
    try {
      const bytes = readFileSync(path);
      digest = createHash("sha256").update(bytes).digest("hex");
      const parsed = JSON.parse(bytes.toString("utf8")) as { revision?: unknown };
      if (typeof parsed.revision === "number" && Number.isInteger(parsed.revision) && parsed.revision >= 0) {
        revision = parsed.revision;
      }
    } catch {
      /* missing catalog is an empty observation */
    }
    return { revision, digest };
  }

  private async maybeInstallLlmBridge(body: unknown): Promise<void> {
    const request = body as { method?: string; spaceId?: string; shared?: { mode?: string } };
    if (
      typeof request.spaceId === "string" &&
      (request.method === "mapImported" ||
        (request.method === "updateSpacePolicy" && request.shared?.mode && request.shared.mode !== "none"))
    ) {
      await this.ensureLlmBridge(request.spaceId);
    }
  }

  assertLlmWritable(): void {
    if (!this.host.lifecycle.handle) {
      throw new LlmConfigError(LLM_ERROR.WRITE_OWNER_REQUIRED, "Home write owner is required for this change");
    }
    this.host.lifecycle.assertWritable();
  }

  async submitLlmApply(command: LlmApplyCommand, requestId: string): Promise<WorkbenchJob> {
    this.assertLlmMutationAllowed();
    const jobs = this.host.jobs();
    if (!jobs) throw new WorkbenchPublicError("workbench/read-only");
    return jobs.submit(command, requestId, (ctx) =>
      this.host.observeChildWork(() => this.runLlmApply(command, ctx)),
    );
  }

  async runLlmApply(command: LlmApplyCommand, ctx: WorkbenchJobContext): Promise<void> {
    this.assertLlmMutationAllowed();
    for (const id of command.spaceIds) {
      const failure = this.currentActivity(id)?.cleanupFailure;
      if (failure) throw failure;
    }
    ctx.phase("apply");
    await this.host.llmHost().executeApply(command, async (spaceId) => {
      const id = this.host.requireManaged(spaceId);
      const release = await this.reserveIdle(id);
      try {
        this.assertLlmMutationAllowed();
        ctx.message(`restart ${spaceId}`);
        await this.host.stopOwned(id);
      } catch (error) {
        await release(error);
        throw error;
      }
      await release();
      await this.host.startSpace(id, ctx);
    });
  }

  listLlmInstances(): LlmInstanceRecord[] {
    return this.host.homeProfileNames().map((id) => {
      const leftover = this.host.runs.unmanaged.has(id);
      let status = leftover ? "unknown" : this.host.publicStatus(id);
      const session = this.currentActivity(id);
      const activity = session?.cleanupFailure ? "unknown" : session?.status ?? "unknown";
      if (status === "running" && activity === "unknown") status = "unknown";
      return {
        spaceId: id,
        status,
        generation: this.host.runs.generations.get(id) ?? 0,
        catalogRevision: this.host.runs.llmApplied.get(id) ?? null,
        policyRevision: null,
        busy: activity === "busy",
        serviceEpoch: this.host.currentServiceEpoch(),
      };
    });
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
