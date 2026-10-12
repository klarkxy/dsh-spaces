import type { IncomingMessage, ServerResponse } from "node:http";
import { SupervisorDashboard } from "../dashboard/supervisor";
import { handleDashboardUnavailable } from "../dashboard/gateway";
import { cookieValue } from "../workbench-http";
import type { HomeController } from "../home-controller";
import type { HomeOperationLock } from "../home-operation-lock";
import type { WorkbenchSpace } from "../../../shared/workbench";
import { WorkbenchPublicError } from "./errors";
import type { SupervisorLifecycle } from "./lifecycle";
import type { SpaceRunRegistry } from "./space-runs";

export interface SupervisorDashboardHostDeps {
  home: string;
  controller: HomeController;
  lock: HomeOperationLock;
  now: () => Date;
  origin: () => string;
  dashboard: () => SupervisorDashboard | null;
  setDashboard: (dashboard: SupervisorDashboard | null) => void;
  lifecycle: SupervisorLifecycle;
  hasMaintenanceEvidence: () => boolean;
  requireServiceEpoch: () => string;
  managerOrigin: () => string | null;
  listSpaces: () => WorkbenchSpace[];
  runs: SpaceRunRegistry;
  cookieName: () => string;
  sessionEquals: (value: string) => boolean;
}

export class SupervisorDashboardHost {
  constructor(private readonly host: SupervisorDashboardHostDeps) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const dashboard = this.host.dashboard();
    if (dashboard) return dashboard.handle(req, res);
    return handleDashboardUnavailable(req, res, {
      origin: () => this.host.origin(), managerOrigin: () => this.host.managerOrigin(),
      authorize: request => {
        const value = cookieValue(request.headers.cookie, this.host.cookieName());
        return !this.host.lifecycle.closed && value && this.host.sessionEquals(value)
          ? { subjectId: "supervisor-local-operator", layoutWrite: false, publicationsManage: false } : null;
      },
    });
  }

  private assertOwner(): void {
    const current = this.host.controller.inspect();
    const expected = this.host.lifecycle.handle?.owner;
    if (!expected || this.host.lifecycle.closed || !current.held || !("owner" in current) ||
      current.handoff || current.liveness !== "alive" || current.owner.nonce !== expected.nonce ||
      current.owner.pid !== expected.pid || current.owner.startedAt !== expected.startedAt) {
      throw new WorkbenchPublicError("workbench/read-only", "The current Home owner is required.");
    }
  }

  private managementAllowed(): boolean {
    return Boolean(this.host.lifecycle.handle) && !this.host.lifecycle.closed && !this.host.lifecycle.sealing && !this.host.lifecycle.blocked &&
      !this.host.lifecycle.maintenanceFlag && !this.host.lifecycle.maintenanceBlocked && !this.host.hasMaintenanceEvidence();
  }

  requireDashboard(): SupervisorDashboard {
    this.assertOwner();
    const dashboard = this.host.dashboard();
    if (!dashboard) throw new WorkbenchPublicError("workbench/unavailable", "Home dashboard is unavailable.");
    if (!this.managementAllowed()) throw new WorkbenchPublicError("workbench/maintenance");
    return dashboard;
  }

  initDashboard(): void {
    this.host.setDashboard(new SupervisorDashboard({
      home: this.host.home, epoch: this.host.requireServiceEpoch(), origin: () => this.host.origin(), now: this.host.now,
      managerOrigin: () => this.host.managerOrigin(),
      spaces: () => this.host.listSpaces(), assertOwner: () => this.assertOwner(),
      canManage: () => this.managementAllowed() && !this.host.lock.inspect().held, cookieName: () => this.host.cookieName(),
      sessionEquals: value => this.host.sessionEquals(value),
      assertSource: (id, generation) => {
        this.assertOwner();
        const space = this.host.listSpaces().find(s => s.id === id && !s.isHost && s.managed);
        if (!space || this.host.runs.unmanaged.has(id) || this.host.runs.generations.get(id) !== generation) {
          throw new WorkbenchPublicError("workbench/conflict", "The source generation is no longer owned.");
        }
      },
    }));
  }

  retireDashboardRun(id: string, generation?: number): Error | undefined {
    try { this.host.dashboard()?.retire(id, generation); }
    catch {
      const message = "Dashboard publishing was revoked but private handoff cleanup failed.";
      this.host.lifecycle.addReason(message);
      return new WorkbenchPublicError("workbench/failed", message);
    }
  }
}
