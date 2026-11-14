import type { ProfileRegistry } from '../profile/profile-registry';
import type { SnapshotExecutor } from '../snapshots/snapshot-executor';
import type { RuntimeStore } from '../runtime/runtime-store';
import type { DiagnosticsService } from '../diagnostics/diagnostics';
import type { HomeOperationLock } from '../home/home-operation-lock';
import type { ExactPluginSource } from '../../../shared/plugin-source';
import type { ProfileStatus } from '../../../shared/types';
import type { SnapshotRuntime } from '../../../shared/snapshots';
import type { WorkbenchJobStep } from '../../../shared/workbench';
import type { WorkbenchProductObservation } from '../../../shared/workbench-product';
import type { WorkbenchJobContext } from './workbench-jobs';

export type MaintenanceLivePluginInput =
  | { kind: 'install'; spaceId: string; packageName: string; version: string }
  | { kind: 'install.spec'; spaceId: string; plugin: ExactPluginSource }
  | { kind: 'remove'; spaceId: string; packageName: string }
  | {
      kind: 'toggle';
      spaceId: string;
      pluginId: string;
      packageName: string;
      enabled: boolean;
      installSpec?: string;
    };

export interface MaintenanceLivePluginResult {
  application: 'applied' | 'restart-required';
  steps: WorkbenchJobStep[];
}

/** Node-only composition boundary; all paths and process authority stay here. */
export interface WorkbenchMaintenancePorts {
  home: string;
  registry: ProfileRegistry;
  lock: HomeOperationLock;
  snapshots: SnapshotExecutor;
  runtimes: RuntimeStore;
  diagnostics: DiagnosticsService;
  managerId(): string | null;
  hasUnfinishedPlan?(planId: string): boolean;
  unfinishedPlanIds?(): string[];
  assertWritable(): void;
  validateSpace(spaceId: string, allowManager?: boolean): void;
  statusOf(spaceId: string): ProfileStatus;
  generationOf?(spaceId: string): number;
  ownedSpaceIds(): string[];
  pluginLive?(
    input: MaintenanceLivePluginInput,
    ctx: WorkbenchJobContext,
  ): Promise<MaintenanceLivePluginResult>;
  /** These callbacks may only stop instances whose ownership is known. No auto force-kill. */
  stopSpace(spaceId: string): Promise<void>;
  stopAll(): Promise<void>;
  startSpace(spaceId: string): Promise<void>;
  currentRuntime(): SnapshotRuntime;
  /** The host CLI that manages the Home; ordinary spaces may pin a different runtime. */
  hostRuntime(): { bin: string; version: string } | null;
  /** Refresh selected CLI resolver and re-establish the manager after maintenance. */
  reinitializeManager(): Promise<void>;
  setMaintenance(active: boolean): void;
  isCompatibleRuntime(version: string): boolean;
  observation(): WorkbenchProductObservation;
}
