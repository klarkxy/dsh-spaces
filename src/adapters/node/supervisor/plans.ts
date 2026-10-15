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
import type { SupervisorDashboard } from "../dashboard/supervisor";
import type { HomeOperationLock } from "../home-operation-lock";
import type { SpaceMessageRouter } from "../message-bus/router";
import type { ProfileRegistry } from "../profile-registry";
import { WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, type WorkbenchJobContext, type WorkbenchJobStore } from "../workbench-jobs";
import type { SupervisorDashboardHost } from "./dashboard-host";
import { WorkbenchPublicError } from "./errors";
import type { SupervisorInstanceRecords } from "./instance-records";
import type { SupervisorLifecycle } from "./lifecycle";
import type { SpaceRunRegistry } from "./space-runs";
import type { StoredPlan, WorkbenchMaintenance, WorkbenchSupervisorOptions } from "./types";

const PLAN_TTL_MS = 5 * 60_000;

export interface SupervisorPlansHost {
  home: string;
  lifecycle: SupervisorLifecycle;
  runs: SpaceRunRegistry;
  instances: () => SupervisorInstanceRecords;
  lock: HomeOperationLock;
  registry: ProfileRegistry;
  now: () => Date;
  messageBus: SpaceMessageRouter;
  options: WorkbenchSupervisorOptions;
  dashboard: () => SupervisorDashboard | null;
  dashboardHost: () => SupervisorDashboardHost;
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
  currentServiceEpoch: () => string;
  stateRevision: () => string;
  productObservation: () => { serviceEpoch: string; expectedRevision: string };
  assertLiveContext: (context: WorkbenchMutationContext) => void;
}

export class SupervisorPlans {
  readonly plans = new Map<string, StoredPlan>();
  private stoppedShutdownJobId: string | null = null;

  constructor(private readonly host: SupervisorPlansHost) {}

  previewLocal(request: WorkbenchPlanRequest): WorkbenchPlan {
    const id = "spaceId" in request ? this.host.requireSpace(request.spaceId) : "";
    if (request.kind === "space.stop" || request.kind === "space.restart" || request.kind === "space.delete") {
      this.host.requireManaged(id);
      this.host.protectSpecial(id, { allowManager: request.kind !== "space.delete" });
      if (request.kind === "space.delete") this.host.protectSpecial(id, { allowManager: false });
    }
    const running = id && this.host.statusOf(id) === "running" ? [id] : [];
    const observed = this.host.productObservation();
    const plan: WorkbenchPlan = {
      id: randomUUID(),
      kind: request.kind,
      title: request.kind,
      scope: request.kind === "service.shutdown" ? "controller" : "space",
      affectedSpaceIds: id ? [id] : this.host.ownedSpaceIds(),
      runningSpaceIds: request.kind === "service.shutdown"
        ? this.host.ownedSpaceIds().filter((name) => this.host.statusOf(name) === "running")
        : running,
      changes: request.kind === "dashboard.publication.set" ? [
        `Publish provider ${request.providerId} from ${request.spaceId} to this Home only.`,
        request.selection === null ? "Revoke publication and hide the cached projection immediately." :
          request.selection.kind === "all" ? "Allow all instances of this provider on the next normal start." :
            `Allow ${request.selection.instanceIds.length} selected instance(s) on the next normal start.`,
        "No plugin installation, process restart or business task is performed by this plan.",
      ] : request.kind === "space.delete" ? [
        "Remove this space's profile and installed plugins.",
        request.removeData ? "Delete this space's isolated sessions and storage." : "Keep this space's isolated sessions and storage on disk.",
      ] : [request.kind],
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

  private async executeLocal(stored: StoredPlan, ctx: WorkbenchJobContext): Promise<void> {
    const request = stored.request;
    switch (request.kind) {
      case "dashboard.publication.set": {
        ctx.phase("dashboard-publication");
        ctx.cancellable(false);
        await this.host.lock.run("dashboard.publication.set", async () => {
          const dashboard = this.host.dashboardHost().requireDashboard();
          const assertPlan = () => {
            this.host.dashboardHost().requireDashboard();
            this.host.assertLiveContext({ serviceEpoch: stored.plan.serviceEpoch, expectedRevision: stored.plan.stateRevision });
            if (this.fingerprint(request) !== stored.fingerprint) throw new WorkbenchPublicError("workbench/conflict");
            this.host.protectSpecial(this.host.requireManaged(request.spaceId), { allowManager: false });
            if (this.host.runs.unmanaged.has(request.spaceId)) throw new WorkbenchPublicError("workbench/unmanaged");
          };
          await dashboard.apply(request, assertPlan);
        });
        return;
      }
      case "space.stop": {
        ctx.phase("stop");
        const id = this.host.requireManaged(request.spaceId);
        await this.host.stopOwned(id);
        return;
      }
      case "space.restart": {
        ctx.phase("restart");
        const id = this.host.requireManaged(request.spaceId);
        await this.host.stopOwned(id);
        await this.host.startSpace(id, ctx);
        return;
      }
      case "space.delete": {
        ctx.phase("delete");
        const id = this.host.requireManaged(request.spaceId);
        this.host.protectSpecial(id, { allowManager: false });
        await this.host.lock.run("space.delete", async () => {
          await this.host.dashboard()?.revokeSpace(id, () => {
            this.host.dashboardHost().requireDashboard();
            this.host.assertLiveContext({ serviceEpoch: stored.plan.serviceEpoch, expectedRevision: stored.plan.stateRevision });
          });
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
    await this.host.dashboard()?.close();
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
