import { lstatSync } from "../../../shared/node/filesystem";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileStatus } from "../../../shared/types";
import type {
  WorkbenchJob,
  WorkbenchMutationContext,
  WorkbenchPlan,
  WorkbenchPlanRequest,
} from "../../../shared/workbench";
import { pinDetailFor } from "../products/plugin-exact-source";
import { parsePluginSource } from "../../../shared/plugin-source";
import type { HomeOperationLock } from "../home/home-operation-lock";
import type { SpaceMessageRouter } from "../message-bus/router";
import type { ProfileRegistry } from "../profile/profile-registry";
import { WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, type WorkbenchJobContext, type WorkbenchJobStore } from "../maintenance/workbench-jobs";
import { WorkbenchPublicError } from "./errors";
import type { SupervisorInstanceRecords } from "./instance-records";
import type { SupervisorLifecycle } from "./lifecycle";
import type { SpaceRunRegistry } from "./space-runs";
import type { StoredPlan, WorkbenchMaintenance, WorkbenchSupervisorOptions } from "./types";
import { describeModelSync, type ModelSyncSummary } from "../llm/main-model-sync";

const PLAN_TTL_MS = 5 * 60_000;

export interface SupervisorPlansHost {
  whileIdle?<T>(spaceId: string, action: () => Promise<T>): Promise<T>;
  home: string;
  lifecycle: SupervisorLifecycle;
  runs: SpaceRunRegistry;
  instances: () => SupervisorInstanceRecords;
  lock: HomeOperationLock;
  registry: ProfileRegistry;
  now: () => Date;
  messageBus: SpaceMessageRouter;
  options: WorkbenchSupervisorOptions;
  jobs: () => WorkbenchJobStore | undefined;
  maintenance: () => WorkbenchMaintenance | null;
  closeHttp: () => Promise<void>;
  dropWritable: () => void;
  requireSpace: (spaceId: string) => string;
  requireManaged: (spaceId: string) => string;
  protectSpecial: (id: string, options: { allowManager: boolean }) => void;
  statusOf: (id: string) => ProfileStatus;
  ownedSpaceIds: () => string[];
  stopOwned: (spaceId: string) => Promise<void>;
  stopOwnedAll: () => Promise<void>;
  startSpace: (spaceId: string, ctx: WorkbenchJobContext) => Promise<WorkbenchJob["result"]>;
  /** Verified main profile of this epoch; throws when the main space is not connected. */
  mainProfile: () => string;
  /** One copy of the main space's models into a stopped space. */
  syncMainModels: (spaceId: string) => Promise<ModelSyncSummary>;
  /**
   * Run one `plugin.live.*` request through the child's own pluginManager
   * inside the current serialized job; absent when the child remote
   * surface cannot be composed (the op fails closed).
   */
  pluginLive?: (
    request: Extract<WorkbenchPlanRequest, { kind: 'plugin.live.install' | 'plugin.live.update' | 'plugin.live.entry' | 'plugin.live.remove' }>,
    ctx: WorkbenchJobContext,
  ) => Promise<WorkbenchJob["result"] | void>;
  currentServiceEpoch: () => string;
  stateRevision: () => string;
  productObservation: () => { serviceEpoch: string; expectedRevision: string };
  assertLiveContext: (context: WorkbenchMutationContext) => void;
}

export class SupervisorPlans {
  readonly plans = new Map<string, StoredPlan>();
  private stoppedShutdownJobId: string | null = null;

  constructor(private readonly host: SupervisorPlansHost) {}

  previewLocal(request: WorkbenchPlanRequest, observedActivity?: "idle" | "busy" | "unknown"): WorkbenchPlan {
    const id = "spaceId" in request ? this.host.requireSpace(request.spaceId) : "";
    if (request.kind === "space.stop" || request.kind === "space.restart" || request.kind === "space.delete") {
      this.host.requireManaged(id);
      this.host.protectSpecial(id, { allowManager: request.kind !== "space.delete" });
      if (request.kind === "space.delete") this.host.protectSpecial(id, { allowManager: false });
    }
    let policyChanges: string[] | undefined;
    if (request.kind === "space.models.sync") {
      this.host.requireManaged(id);
      this.host.protectSpecial(id, { allowManager: false });
      const status = this.host.statusOf(id);
      if (status !== "stopped" && status !== "crashed") {
        throw new WorkbenchPublicError(
          "workbench/conflict",
          `The space ${id} must be stopped before models can be synced into it. Stop it first.`,
        );
      }
      const main = this.host.mainProfile();
      policyChanges = [
        `Copy the model settings of the main space (${main}) into ${id}: model routes, DeepSeek settings, the default model and the credentials they use.`,
        "Routes this space added itself stay. Sign-in based routes (OAuth) are not copied.",
        "This copies once. Later changes in the main space reach this space only when you sync again.",
      ];
    }
    if (request.kind === "plugin.live.install" || request.kind === "plugin.live.update" ||
        request.kind === "plugin.live.entry" || request.kind === "plugin.live.remove") {
      this.host.requireManaged(id);
      this.host.protectSpecial(id, { allowManager: false });
      const status = this.host.statusOf(id);
      if (status !== "running") {
        throw new WorkbenchPublicError(
          "workbench/conflict",
          `The space ${id} is ${status}; ${request.kind} requires a running space. ` +
          `Use the stopped-space plugin ops (plugin.install, plugin.remove, plugin.toggle) instead.`,
        );
      }
      policyChanges = livePlanChanges(request);
    }
    const running = id && this.host.statusOf(id) === "running" ? [id] : [];
    const taskActivity = request.kind === "space.stop" || request.kind === "space.restart"
      ? observedActivity ?? "unknown" : undefined;
    const observed = this.host.productObservation();
    const plan: WorkbenchPlan = {
      id: randomUUID(),
      kind: request.kind,
      ...(taskActivity ? { taskActivity } : {}),
      title: request.kind,
      scope: request.kind === "service.shutdown" ? "controller" : "space",
      affectedSpaceIds: id ? [id] : this.host.ownedSpaceIds(),
      runningSpaceIds: request.kind === "service.shutdown"
        ? this.host.ownedSpaceIds().filter((name) => this.host.statusOf(name) === "running")
        : running,
      changes: policyChanges ?? (request.kind === "space.delete" ? [
        "Remove this space's profile and installed plugins.",
        request.removeData ? "Delete this space's isolated sessions and storage." : "Keep this space's isolated sessions and storage on disk.",
      ] : [request.kind]),
      destructive: request.kind === "space.delete" || request.kind === "service.shutdown",
      expiresAt: new Date(this.host.now().getTime() + PLAN_TTL_MS).toISOString(),
      serviceEpoch: observed.serviceEpoch,
      stateRevision: observed.expectedRevision,
    };
    const stored: StoredPlan = { plan, request, fingerprint: this.fingerprint(request) };
    this.plans.set(plan.id, stored);
    this.host.instances().writeLifecyclePlan(stored);
    return plan;
  }

  async executePlan(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    const stored = this.plans.get(planId) ?? this.host.instances().readLifecyclePlan(planId);
    if (stored) {
      if (stored.consumed) throw new WorkbenchPublicError("workbench/not-found");
      if (Date.parse(stored.plan.expiresAt) <= this.host.now().getTime()) {
        this.host.instances().consumeLifecyclePlan(planId);
        throw new WorkbenchPublicError("workbench/invalid-input", "The preview expired. Request a new preview.");
      }
      if (!stored.plan.serviceEpoch || stored.plan.serviceEpoch !== this.host.currentServiceEpoch()) {
        throw new WorkbenchPublicError("workbench/conflict", "The preview belongs to another service epoch.");
      }
      if (!stored.plan.stateRevision || stored.plan.stateRevision !== this.host.stateRevision()) {
        throw new WorkbenchPublicError("workbench/conflict", "The target changed. Request a new preview.");
      }
      const fingerprint = this.fingerprint(stored.request);
      if (fingerprint !== stored.fingerprint) {
        throw new WorkbenchPublicError("workbench/conflict", "The target changed. Request a new preview.");
      }
      this.host.instances().consumeLifecyclePlan(planId);
      if (stored.request.kind === "service.shutdown") {
        if (!this.host.lifecycle.activeJobId) throw new WorkbenchPublicError("workbench/invalid-input", "Shutdown requires an active job.");
        this.host.lifecycle.relinquishKind = stored.request.kind;
        this.host.lifecycle.relinquishJobId = this.host.lifecycle.activeJobId;
        this.stoppedShutdownJobId = null;
      }
      return this.executeLocal(stored, ctx);
    }
    const maintenance = this.host.maintenance();
    if (!maintenance) throw new WorkbenchPublicError("workbench/maintenance");
    return maintenance.execute(planId, ctx);
  }

  private async executeLocal(stored: StoredPlan, ctx: WorkbenchJobContext): Promise<WorkbenchJob["result"] | void> {
    const request = stored.request;
    switch (request.kind) {
      case "space.stop": {
        ctx.phase("stop");
        const id = this.host.requireManaged(request.spaceId);
        if (stored.plan.taskActivity === "idle" && this.host.whileIdle) await this.host.whileIdle(id, () => this.host.stopOwned(id));
        else await this.host.stopOwned(id);
        return;
      }
      case "space.restart": {
        ctx.phase("restart");
        const id = this.host.requireManaged(request.spaceId);
        if (stored.plan.taskActivity === "idle" && this.host.whileIdle) await this.host.whileIdle(id, () => this.host.stopOwned(id));
        else await this.host.stopOwned(id);
        await this.host.startSpace(id, ctx);
        return;
      }
      case "space.delete": {
        ctx.phase("delete");
        const id = this.host.requireManaged(request.spaceId);
        this.host.protectSpecial(id, { allowManager: false });
        await this.host.lock.run("space.delete", async () => {
          await this.host.stopOwned(id);
          const profileDir = join(this.host.home, "profiles", id);
          const profileStat = lstatSync(profileDir);
          if (!profileStat.isDirectory() || profileStat.isSymbolicLink()) {
            throw new WorkbenchPublicError("workbench/protected");
          }
          if (request.removeData && existsSync(this.host.registry.hubDataDir(id))) {
            const dataStat = lstatSync(this.host.registry.hubDataDir(id));
            if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) {
              throw new WorkbenchPublicError("workbench/protected");
            }
          }
          this.host.registry.removeOfficialProfile(id);
          if (request.removeData) this.host.registry.removeHubData(id);
          this.host.registry.removeMeta(id);
        });
        return;
      }
      case "space.models.sync": {
        ctx.phase("models-sync");
        const id = this.host.requireManaged(request.spaceId);
        this.host.protectSpecial(id, { allowManager: false });
        const status = this.host.statusOf(id);
        if (status !== "stopped" && status !== "crashed") {
          throw new WorkbenchPublicError(
            "workbench/conflict",
            `The space ${id} started since the preview; models were not synced.`,
          );
        }
        // The serialized job tail plus the write lock serialize this write;
        // a failure after a committed file keeps the scene as evidence.
        const summary = await this.host.lock.run("space.models.sync", () => this.host.syncMainModels(id));
        ctx.message(describeModelSync(summary));
        return { spaceId: id, steps: [{ step: "models-sync", status: "done", detail: describeModelSync(summary) }] };
      }
      case "plugin.live.install":
      case "plugin.live.update":
      case "plugin.live.entry":
      case "plugin.live.remove": {
        ctx.phase("live-plugin");
        const id = this.host.requireManaged(request.spaceId);
        this.host.protectSpecial(id, { allowManager: false });
        // The execute-time fingerprint already binds status + generation;
        // the runner re-checks the same identity before every child call.
        if (this.host.statusOf(id) !== "running") {
          throw new WorkbenchPublicError(
            "workbench/conflict",
            `The space ${id} stopped since the plan was frozen; the live operation was not submitted.`,
          );
        }
        if (!this.host.pluginLive) {
          throw new WorkbenchPublicError("workbench/unavailable", "The child remote surface is unavailable.");
        }
        // Same job lane as every other profile writer: no supervisor-side
        // write can overlap the child's own pluginManager application.
        return await this.host.pluginLive(request, ctx);
      }
      case "service.shutdown": {
        ctx.phase("stopping-children");
        this.host.lifecycle.sealing = true;
        try {
          await this.host.stopOwnedAll();
        } catch (error) {
          this.host.lifecycle.sealing = false;
          this.host.lifecycle.endRelinquish();
          this.host.lifecycle.maintenanceBlocked = true;
          throw error;
        }
        this.stoppedShutdownJobId = this.host.lifecycle.relinquishJobId;
        ctx.phase("finalizing");
        return;
      }
      default:
        throw new WorkbenchPublicError("workbench/invalid-input");
    }
  }

  private fingerprint(request: WorkbenchPlanRequest): string {
    const spaces =
      "spaceId" in request
        ? [{ id: request.spaceId, status: this.host.statusOf(request.spaceId), generation: this.host.runs.generation(request.spaceId) }]
        : this.host.ownedSpaceIds().map((id) => ({ id, status: this.host.statusOf(id) }));
    return JSON.stringify({ request, spaces, owner: Boolean(this.host.lifecycle.handle) });
  }

  private async finishRelinquish(): Promise<void> {
    const kind = this.host.lifecycle.relinquishKind;
    if (!kind) return;
    this.host.lifecycle.endRelinquish();
    this.host.messageBus.close();
    this.host.dropWritable();
    if (kind === "service.shutdown") {
      this.host.lifecycle.sealing = true;
      this.host.lifecycle.closed = true;
      await this.host.closeHttp();
      await this.host.options.onNormalExit?.();
    }
  }

  async afterPlanJobSettled(jobId: string): Promise<void> {
    if (this.host.lifecycle.relinquishKind && this.host.lifecycle.relinquishJobId === jobId) {
      if (!this.jobPersistedSuccess(jobId)) {
        this.host.lifecycle.endRelinquish();
        this.host.lifecycle.maintenanceBlocked = true;
        this.host.lifecycle.blocked = true;
        const stopped = this.stoppedShutdownJobId === jobId;
        this.host.lifecycle.shutdownFailure = stopped ? "final-save" : "before-stop";
        this.host.lifecycle.reasons.push(stopped
          ? "Shutdown completion could not be saved. Owned processes stopped; run rights were kept."
          : "Shutdown failed before owned-process stopping began; run rights were kept.");
        return;
      }
      await this.finishRelinquish();
    }
  }

  private jobPersistedSuccess(jobId: string): boolean {
    const jobs = this.host.jobs();
    if (!jobs) return false;
    try {
      if (jobs.job(jobId).status !== "succeeded") return false;
    } catch {
      return false;
    }
    try {
      const raw = readFileSync(join(this.host.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, `${jobId}.json`), "utf8");
      const parsed = JSON.parse(raw) as { status?: string };
      return parsed.status === "succeeded";
    } catch {
      return false;
    }
  }
}

/** Approval-time change text for the running-space ops (path B). */
function livePlanChanges(request: WorkbenchPlanRequest): string[] {
  const appliedBy = "The change is applied inside the running space by the child's own plugin manager; no supervisor-side profile write happens.";
  switch (request.kind) {
    case "plugin.live.install": {
      let detail = "an exact source";
      try {
        detail = pinDetailFor(parsePluginSource(request.source));
      } catch {
        // The shared parser already validated this; the plan text keeps the
        // frozen request rather than reformatting it.
      }
      return [
        `Install plugin ${detail} into the running space ${request.spaceId} through its own plugin manager (installBundle).`,
        appliedBy,
      ];
    }
    case "plugin.live.update":
      return [
        `Update plugin ${request.packageName} to ${request.version} inside the running space ${request.spaceId} through its own plugin manager (updateBundle).`,
        appliedBy,
      ];
    case "plugin.live.entry":
      return [
        `${request.enabled ? "Enable" : "Disable"} loader entry ${request.entryId} inside the running space ${request.spaceId} through its own plugin manager (setPluginEnabled).`,
        appliedBy,
      ];
    case "plugin.live.remove":
      return [
        `Remove plugin ${request.packageName} from the running space ${request.spaceId} through its own plugin manager (removeBundle).`,
        appliedBy,
      ];
    default:
      return [request.kind];
  }
}
