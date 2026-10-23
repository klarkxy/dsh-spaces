import type { SnapshotRuntime } from "../../../shared/snapshots";
import type { ProfileStatus } from "../../../shared/types";
import type { WorkbenchDiagnostics, WorkbenchHomeSettings } from "../../../shared/workbench-product";
import type { WorkbenchJob, WorkbenchSpace } from "../../../shared/workbench";
import { DiagnosticsService, sanitizeLogText } from "../diagnostics/diagnostics";
import { hasUnfinishedMaintenance } from "../home/control-residue";
import type { HomeOperationLock } from "../home/home-operation-lock";
import type { WorkbenchLog } from "../maintenance/workbench-log";
import type { WorkbenchJobContext, WorkbenchJobStore } from "../maintenance/workbench-jobs";
import { WorkbenchMaintenance as WorkbenchMaintenanceService } from "../maintenance/workbench-maintenance";
import type { WorkbenchMaintenancePorts } from "../maintenance/workbench-maintenance-ports";
import type { ProfileRegistry } from "../profile/profile-registry";
import { isCompatibleDshCliVersion, type NodeSpacesService } from "../products/spaces-service";
import type { ProcessManager } from "../runtime/process-manager";
import { RuntimeStore } from "../runtime/runtime-store";
import { SnapshotExecutor } from "../snapshots/snapshot-executor";
import { defaultSnapshotWorkerFile } from "./payload";
import { silentJobContext } from "./job-context";
import type { SupervisorLifecycle } from "./lifecycle";
import type { BoundCli, WorkbenchMaintenance, WorkbenchSupervisorOptions } from "./types";

export interface SupervisorMaintenanceGateHost {
  home: string;
  registry: ProfileRegistry;
  lock: HomeOperationLock;
  lifecycle: SupervisorLifecycle;
  options: WorkbenchSupervisorOptions;
  cli: () => BoundCli | null;
  managerId: () => string | null;
  processes: () => ProcessManager | undefined;
  spaces: () => NodeSpacesService | undefined;
  jobs: () => WorkbenchJobStore | undefined;
  runtimeStore: () => RuntimeStore | undefined;
  setRuntimeStore: (store: RuntimeStore) => void;
  diagnostics: () => DiagnosticsService | undefined;
  setDiagnostics: (diagnostics: DiagnosticsService) => void;
  snapshotRoot: () => string;
  runtimeRoot: () => string;
  readHomeSettings: () => WorkbenchHomeSettings;
  workbenchLog: () => WorkbenchLog;
  listSpaces: () => WorkbenchSpace[];
  requireSpace: (spaceId: string) => string;
  validateSpace: (spaceId: string, allowManager?: boolean) => void;
  publicStatus: (id: string) => WorkbenchSpace["status"];
  statusOf: (name: string) => ProfileStatus;
  ownedSpaceIds: () => string[];
  stopOwned: (spaceId: string) => Promise<void>;
  stopOwnedAll: () => Promise<void>;
  startSpace: (spaceId: string, ctx: WorkbenchJobContext) => Promise<WorkbenchJob["result"]>;
  currentRuntime: () => SnapshotRuntime;
  reinitializeManager: () => Promise<void>;
  productObservation: () => { serviceEpoch: string; expectedRevision: string };
}

/**
 * Maintenance composition: the snapshot/runtime/diagnostics ports the
 * maintenance service runs on, and the evidence that gates new maintenance.
 */
export class SupervisorMaintenanceGate {
  constructor(private readonly host: SupervisorMaintenanceGateHost) {}

  createMaintenance(): WorkbenchMaintenance | null {
    if (!this.host.processes()) return null;
    const snapshotRoot = this.host.snapshotRoot();
    const worker = this.host.options.snapshotWorkerFile ?? defaultSnapshotWorkerFile();
    const snapshots = new SnapshotExecutor({
      home: this.host.home,
      root: snapshotRoot,
      workerFile: worker,
    });
    const runtimes = new RuntimeStore({
      installWorker: { file: worker, home: this.host.home },
      root: this.host.runtimeRoot(),
      snapshotRoot,
      source: () => this.host.readHomeSettings().packageSource,
      legacy: () => {
        const cli = this.host.cli();
        return cli ? { bin: cli.bin, version: cli.version } : undefined;
      },
    });
    this.host.setRuntimeStore(runtimes);
    const diagnostics = this.ensureDiagnostics();
    const ports = this.maintenancePorts(snapshots, runtimes, diagnostics);
    const create = this.host.options.createMaintenance ?? ((next) => new WorkbenchMaintenanceService(next, {
      packageSource: () => this.host.readHomeSettings().packageSource,
      log: (operation, error) => {
        const detail = sanitizeLogText(error instanceof Error ? error.message : String(error ?? ""));
        try {
          this.host.workbenchLog().append({
            level: "error",
            area: "maintenance",
            event: operation.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^-+/, "").slice(0, 80) || "maintenance",
            message: detail || "The maintenance operation failed.",
          });
        } catch {
          this.host.lifecycle.maintenanceBlocked = true;
          if (!this.host.lifecycle.reasons.includes("Maintenance diagnostics could not be saved. Further changes are blocked.")) {
            this.host.lifecycle.reasons.push("Maintenance diagnostics could not be saved. Further changes are blocked.");
          }
        }
      },
    }));
    return create(ports);
  }

  maintenancePorts(
    snapshots: SnapshotExecutor,
    runtimes: RuntimeStore,
    diagnostics: DiagnosticsService,
  ): WorkbenchMaintenancePorts {
    return {
      home: this.host.home,
      registry: this.host.registry,
      lock: this.host.lock,
      snapshots,
      runtimes,
      diagnostics,
      managerId: () => this.host.managerId(),
      assertWritable: () => this.host.lifecycle.assertWritable(),
      validateSpace: (spaceId, allowManager) => {
        this.host.validateSpace(spaceId, allowManager);
      },
      statusOf: (spaceId) => this.host.statusOf(spaceId),
      ownedSpaceIds: () => this.host.ownedSpaceIds(),
      stopSpace: (spaceId) => this.host.stopOwned(spaceId),
      stopAll: () => this.host.stopOwnedAll(),
      startSpace: async (spaceId) => { await this.host.startSpace(spaceId, silentJobContext()); },
      currentRuntime: () => this.host.currentRuntime(),
      hostRuntime: () => {
        const cli = this.host.cli();
        return cli ? { bin: cli.bin, version: cli.version } : null;
      },
      reinitializeManager: () => this.host.reinitializeManager(),
      setMaintenance: (active) => {
        if (active && !this.host.lifecycle.maintenanceFlag) {
          this.host.lifecycle.maintenanceInventory = {
            mode: this.host.spaces()?.capabilities().mode ?? "unknown-readonly",
            spaces: this.host.listSpaces(),
          };
        }
        this.host.lifecycle.maintenanceFlag = active;
        if (!active) this.host.lifecycle.maintenanceInventory = null;
      },
      hasUnfinishedPlan: planId => this.host.jobs()?.hasUnfinishedPlan(planId) ?? false,
      unfinishedPlanIds: () => this.host.jobs()?.unfinishedPlanIds() ?? [],
      isCompatibleRuntime: (version) => isCompatibleDshCliVersion(version),
      observation: () => this.host.productObservation(),
    };
  }

  ensureDiagnostics(): DiagnosticsService {
    const existing = this.host.diagnostics();
    if (existing) return existing;
    const created = new DiagnosticsService({
      home: this.host.home,
      profiles: () => this.host.registry.scan(),
      statusOf: (name) => this.host.statusOf(name),
    });
    this.host.setDiagnostics(created);
    return created;
  }

  productDiagnostics(spaceId: string): WorkbenchDiagnostics {
    const id = this.host.requireSpace(spaceId);
    const snap = this.ensureDiagnostics().get(id);
    return {
      spaceId: id,
      status: this.host.publicStatus(id),
      lastError: snap.lastError,
      logs: snap.logs.slice(0, 256),
      logError: snap.logError,
      backups: snap.backups,
    };
  }

  hasMaintenanceEvidence(): boolean {
    return hasUnfinishedMaintenance(this.host.home, this.host.snapshotRoot());
  }
}
