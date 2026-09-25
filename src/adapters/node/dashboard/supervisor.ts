import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { PublicationPlanInput, PublicationPolicy, SourceSummary } from '../../../shared/dashboard.js';
import type { WorkbenchSpace } from '../../../shared/workbench.js';
import { HomeDashboard, type OwnedDashboardRun } from '../../../core/domain/dashboard/home-backend.js';
import { DashboardFault } from '../../../core/domain/dashboard/errors.js';
import { cookieValue } from '../workbench-http.js';
import { HomeDashboardFileStore } from './file-store.js';
import { HomeDashboardGateway } from './gateway.js';
import { writeDashboardBootstrap } from './bootstrap.js';

export const DASHBOARD_LAUNCH_ENV = 'DSH_SPACES_DASHBOARD_BOOTSTRAP_FILE';
export interface SupervisorDashboardPorts {
  home: string;
  epoch: string;
  origin(): string;
  managerOrigin?(): string | null;
  now(): Date;
  spaces(): WorkbenchSpace[];
  /** Check the current on-disk HomeController identity, not just a cached handle. */
  assertOwner(): void;
  /** Only true while existing management writes are permitted. */
  canManage(): boolean;
  cookieName(): string;
  sessionEquals(value: string): boolean;
  assertSource(spaceId: string, generation: number): void;
}
type Launch = {
  binding: OwnedDashboardRun;
  invalidate?: () => void;
  file?: ReturnType<typeof writeDashboardBootstrap>;
};

/** Composition owned exclusively by the existing WorkbenchSupervisor. No listener or controller. */
export class SupervisorDashboard {
  private readonly hub: HomeDashboard;
  private readonly gateway: HomeDashboardGateway;
  private readonly launches = new Map<string, Launch>();
  private closed = false;
  constructor(private readonly ports: SupervisorDashboardPorts) {
    const store = new HomeDashboardFileStore(join(ports.home, '.spaces-dashboard', 'v1'), ports.assertOwner);
    this.hub = new HomeDashboard({
      backendEpoch: ports.epoch, store, now: () => ports.now().getTime(), newId: randomUUID,
      sources: () => this.sources(), assertOwner: ports.assertOwner,
      assertRun: binding => {
        const launch = this.launches.get(binding.spaceId);
        if (!launch || launch.binding.runId !== binding.runId || launch.binding.generation !== binding.generation) {
          throw new DashboardFault('dashboard/stale-run');
        }
        ports.assertSource(binding.spaceId, binding.generation);
      },
    });
    this.gateway = new HomeDashboardGateway(this.hub, {
      origin: ports.origin, managerOrigin: ports.managerOrigin,
      authorize: req => {
        // Publisher bearer and a child DSH cookie never become Home operator credentials.
        const value = cookieValue(req.headers.cookie, ports.cookieName());
        if (this.closed || !value || !ports.sessionEquals(value)) return null;
        return { subjectId: 'supervisor-local-operator', layoutWrite: ports.canManage(), publicationsManage: ports.canManage() };
      },
    });
  }
  private sources(): SourceSummary[] {
    return this.ports.spaces().filter(s => !s.isHost && s.managed).map(s => ({
      spaceId: s.id, title: s.displayName, publishing: 'disabled',
      sourceState: s.status === 'running' ? 'running' : s.status === 'stopped' ? 'stopped' : s.status === 'crashed' ? 'failed' : 'unknown',
    }));
  }
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> { return this.gateway.handle(req, res); }
  private async policies(spaceId: string): Promise<PublicationPolicy[]> {
    const response = await this.hub.query({ kind: 'publications', spaceId }, () => {
      this.ports.assertOwner();
      return { subjectId: 'supervisor-internal', layoutWrite: false, publicationsManage: true };
    });
    if (response.data.kind !== 'publications') throw new DashboardFault('dashboard/unavailable');
    return response.data.policies;
  }
  async validatePreview(input: PublicationPlanInput): Promise<void> {
    const current = (await this.policies(input.spaceId)).find(p => p.providerId === input.providerId);
    if ((current?.revision ?? 'absent') !== input.expectedGrantRevision) throw new DashboardFault('dashboard/revision-conflict');
  }
  apply(input: PublicationPlanInput, assertPlan: () => void): Promise<PublicationPolicy> {
    return this.hub.applyPublication(input, assertPlan);
  }
  /** Called inside the existing delete plan, before removing any profile or business data. */
  async revokeSpace(spaceId: string, assertPlan: () => void): Promise<void> {
    for (const policy of await this.policies(spaceId)) {
      if (policy.selection === null) continue;
      await this.hub.applyPublication({ kind: 'dashboard.publication.set', spaceId, providerId: policy.providerId,
        expectedGrantRevision: policy.revision, selection: null }, assertPlan);
    }
  }
  /** Only a normal user-requested start can reach this method. Never install or restart here. */
  async prepare(spaceId: string, generation: number, installed: boolean): Promise<void> {
    if (this.closed) throw new DashboardFault('dashboard/unavailable');
    this.ports.assertSource(spaceId, generation);
    if (this.launches.has(spaceId)) throw new DashboardFault('dashboard/request-conflict');
    if (!installed || !(await this.policies(spaceId)).some(p => p.selection !== null)) return;
    const launch: Launch = { binding: { spaceId, generation, runId: randomUUID() } };
    this.launches.set(spaceId, launch);
    try {
      const issued = await this.gateway.publishers.issue(launch.binding);
      launch.invalidate = issued.dispose;
      launch.file = writeDashboardBootstrap(join(this.ports.home, '.spaces-dashboard', 'private'), issued.bootstrap, this.ports.assertOwner);
    } catch (error) {
      this.launches.delete(spaceId); launch.invalidate?.();
      throw error;
    }
  }
  /** Return only the owning launch's file path, never its bearer or another space's environment. */
  environment(spaceId: string, generation: number): NodeJS.ProcessEnv {
    const launch = this.launches.get(spaceId);
    // toolchainEnv merges process.env later. An own undefined property must
    // shadow the parent handoff; deleting the property here would re-inherit it.
    if (!launch) return { [DASHBOARD_LAUNCH_ENV]: undefined };
    this.ports.assertSource(spaceId, generation);
    if (launch.binding.generation !== generation || !launch.file) throw new DashboardFault('dashboard/stale-run');
    return { [DASHBOARD_LAUNCH_ENV]: launch.file.path };
  }
  /** Invalidates synchronously before cleanup and before asking the process to stop. */
  retire(spaceId: string, generation?: number): void {
    const launch = this.launches.get(spaceId);
    if (!launch || (generation !== undefined && launch.binding.generation !== generation)) return;
    this.launches.delete(spaceId);
    launch.invalidate?.();
    launch.file?.dispose();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gateway.close(); // all bearer capabilities are dead even if file cleanup fails
    let failure: unknown;
    for (const spaceId of [...this.launches.keys()]) {
      try { this.retire(spaceId); } catch (error) { failure ??= error; }
    }
    try { await this.hub.close(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}
