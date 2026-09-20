import type { ProfileRegistry } from './profile-registry';
import type { SnapshotExecutor } from './snapshot-executor';
import type { RuntimeStore } from './runtime-store';
import type { CoordinatedUpgrade } from './coordinated-upgrade';
import type { DiagnosticsService } from './diagnostics';
import type { HomeOperationLock } from './home-operation-lock';
import type { ProfileStatus } from '../../shared/types';
import type { SnapshotRuntime } from '../../shared/snapshots';
import type { WorkbenchPackageUpgrade } from './workbench-package-upgrade';
import type { WorkbenchProductObservation } from '../../shared/workbench-product';

/** Node-only composition boundary; all paths and process authority stay here. */
export interface WorkbenchMaintenancePorts {
  home: string;
  registry: ProfileRegistry;
  lock: HomeOperationLock;
  snapshots: SnapshotExecutor;
  runtimes: RuntimeStore;
  upgrades: CoordinatedUpgrade;
  packageUpgrade?: WorkbenchPackageUpgrade;
  diagnostics: DiagnosticsService;
  managerId(): string | null;
  hasUnfinishedPlan?(planId: string): boolean;
  unfinishedPlanIds?(): string[];
  assertWritable(): void;
  validateSpace(spaceId: string, allowManager?: boolean): void;
  statusOf(spaceId: string): ProfileStatus;
  ownedSpaceIds(): string[];
  /** These callbacks may only stop instances whose ownership is known. No auto force-kill. */
  stopSpace(spaceId: string): Promise<void>;
  stopAll(): Promise<void>;
  startSpace(spaceId: string): Promise<void>;
  currentRuntime(): SnapshotRuntime;
  /** Refresh selected CLI resolver and re-establish the manager after maintenance. */
  reinitializeManager(): Promise<void>;
  setMaintenance(active: boolean): void;
  isCompatibleRuntime(version: string): boolean;
  observation(): WorkbenchProductObservation;
}
