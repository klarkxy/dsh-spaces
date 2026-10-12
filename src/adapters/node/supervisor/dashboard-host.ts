import type { IncomingMessage, ServerResponse } from "node:http";
import { SupervisorDashboard } from "../dashboard/supervisor";
import { handleDashboardUnavailable } from "../dashboard/gateway";
import { cookieValue } from "../workbench-http";
import type { HomeControlHandle, HomeController } from "../home-controller";
import type { HomeOperationLock } from "../home-operation-lock";
import type { WorkbenchSpace } from "../../../shared/workbench";
import { WorkbenchPublicError } from "./errors";

export interface SupervisorDashboardHostDeps {
  home: string;
  controller: HomeController;
  lock: HomeOperationLock;
  now: () => Date;
  origin: () => string;
  dashboard: () => SupervisorDashboard | null;
  setDashboard: (dashboard: SupervisorDashboard | null) => void;
  handle: () => HomeControlHandle | undefined;
  closed: () => boolean;
  sealing: () => boolean;
  blocked: () => boolean;
  maintenanceFlag: () => boolean;
  maintenanceBlocked: () => boolean;
  transferredOwner: () => boolean;
  hasMaintenanceEvidence: () => boolean;
  requireServiceEpoch: () => string;
  managerOrigin: () => string | null;
  listSpaces: () => WorkbenchSpace[];
  unmanaged: Set<string>;
  generations: Map<string, number>;
  cookieName: () => string;
  sessionEquals: (value: string) => boolean;
  reasons: () => string[];
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
        return !this.host.closed() && value && this.host.sessionEquals(value)
          ? { subjectId: "supervisor-local-operator", layoutWrite: false, publicationsManage: false } : null;
      },
    });
  }

  private assertOwner(): void {
    const current = this.host.controller.inspect();
    const expected = this.host.handle()?.owner;
    if (!expected || this.host.closed() || this.host.transferredOwner() || !current.held || !("owner" in current) ||
      current.handoff || current.liveness !== "alive" || current.owner.nonce !== expected.nonce ||
      current.owner.pid !== expected.pid || current.owner.startedAt !== expected.startedAt) {
      throw new WorkbenchPublicError("workbench/read-only", "The current Home owner is required.");
    }
  }

  private managementAllowed(): boolean {
    return Boolean(this.host.handle()) && !this.host.closed() && !this.host.sealing() && !this.host.blocked() &&
      !this.host.maintenanceFlag() && !this.host.maintenanceBlocked() && !this.host.hasMaintenanceEvidence();
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
        if (!space || this.host.unmanaged.has(id) || this.host.generations.get(id) !== generation) {
          throw new WorkbenchPublicError("workbench/conflict", "The source generation is no longer owned.");
        }
      },
    }));
  }

  retireDashboardRun(id: string, generation?: number): Error | undefined {
    try { this.host.dashboard()?.retire(id, generation); }
    catch {
      const message = "Dashboard publishing was revoked but private handoff cleanup failed.";
      if (!this.host.reasons().includes(message)) this.host.reasons().push(message);
      return new WorkbenchPublicError("workbench/failed", message);
    }
  }
}
