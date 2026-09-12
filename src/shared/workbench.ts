/** Browser-safe workbench contracts. Never carry file paths, cookies or child launch tokens. */
import type { CreateSpaceInput, SpaceDetail, SpaceSummary, SpacesMode } from './spaces-control';

export type WorkbenchRole = 'manager' | 'workspace' | 'uninitialized';
export type ControllerKind = 'web' | 'desktop';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'recovery-required';

export interface WorkbenchSpace extends Omit<SpaceSummary, 'status'> {
  icon: string;
  status: 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed' | 'unknown';
  generation: number;
  managed: boolean;
  needsIsolation: boolean;
}

export interface WorkbenchState {
  role: WorkbenchRole;
  managerId: string | null;
  owner: { kind: ControllerKind; since: string } | null;
  writable: boolean;
  mode: SpacesMode;
  dshVersion: string | null;
  maintenance: boolean;
  recoveryRequired: boolean;
  reasons: string[];
  spaces: WorkbenchSpace[];
  jobs: WorkbenchJob[];
}

export interface WorkbenchView {
  spaceId: string;
  generation: number;
  /** Clean child origin for exact postMessage source checking. */
  origin: string;
  /** Clean supervisor origin serving entryPath, distinct from the child origin. */
  entryOrigin: string;
  /** Authenticated supervisor-relative route. No child launch token. */
  entryPath: string;
  /** Correlation only, never authorizes a management action. */
  channel: string;
}

export interface WorkbenchViewMessage {
  source: 'dsh-spaces-view';
  spaceId: string;
  generation: number;
  channel: string;
  state: 'ready' | 'failed' | 'disconnected';
  message?: string;
}

export interface WorkbenchJob {
  id: string;
  requestId: string;
  kind: string;
  status: JobStatus;
  phase: string;
  message: string;
  affectedSpaceIds: string[];
  createdAt: string;
  updatedAt: string;
  canCancel: boolean;
  result?: { spaceId?: string; snapshotId?: string; runtimeVersion?: string; view?: WorkbenchView };
  error?: { code: string; message: string };
}

export type WorkbenchCommand =
  | { kind: 'space.create'; input: CreateSpaceInput & { icon?: string } }
  | { kind: 'space.update'; spaceId: string; displayName?: string; icon?: string }
  | { kind: 'space.reorder'; spaceIds: string[] }
  | { kind: 'space.start'; spaceId: string }
  | { kind: 'space.verify'; spaceId: string }
  | { kind: 'plan.execute'; planId: string }
  | { kind: 'controller.acquire' }
  | { kind: 'recovery.resume' };

export type WorkbenchPlanRequest =
  | { kind: 'space.stop' | 'space.restart'; spaceId: string }
  | { kind: 'space.delete'; spaceId: string; removeData: boolean }
  | { kind: 'plugin.install'; spaceIds: string[]; catalogId: string; version: string }
  | { kind: 'plugin.remove'; spaceId: string; packageName: string }
  | { kind: 'plugin.toggle'; spaceId: string; pluginId: string; enabled: boolean }
  | { kind: 'plugin.cleanup-manager'; spaceId: string }
  | { kind: 'snapshot.create' }
  | { kind: 'snapshot.restore' | 'snapshot.delete'; snapshotId: string }
  | { kind: 'config.restore'; spaceId: string; backupId: string }
  | { kind: 'runtime.install' | 'runtime.upgrade'; version: string }
  | { kind: 'controller.release' | 'controller.shutdown' };

export interface WorkbenchPlan {
  id: string;
  kind: WorkbenchPlanRequest['kind'];
  title: string;
  scope: 'space' | 'home' | 'controller';
  affectedSpaceIds: string[];
  runningSpaceIds: string[];
  changes: string[];
  destructive: boolean;
  expiresAt: string;
}

export interface WorkbenchPlugin {
  id: string;
  title: string;
  packageName: string;
  description: string;
  version: string | null;
  installedIn: string[];
  protected: boolean;
}

export interface WorkbenchSnapshot {
  id: string;
  createdAt: string;
  reason?: string;
  runtimeVersion: string;
  spaceIds: string[];
  bytes: number;
  restorable: boolean;
}

export interface WorkbenchRuntime {
  version: string;
  installed: boolean;
  current: boolean;
  compatible: boolean;
}

export interface WorkbenchBackup { id: string; createdAt: string; reason: string }

export interface WorkbenchApi {
  state(): Promise<WorkbenchState>;
  detail(spaceId: string): Promise<SpaceDetail>;
  submit(command: WorkbenchCommand, requestId: string): Promise<WorkbenchJob>;
  job(id: string): Promise<WorkbenchJob>;
  cancel(id: string): Promise<WorkbenchJob>;
  view(spaceId: string): Promise<WorkbenchView>;
  preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan>;
  plugins(query: string): Promise<WorkbenchPlugin[]>;
  snapshots(): Promise<WorkbenchSnapshot[]>;
  snapshot(id: string): Promise<WorkbenchSnapshot>;
  runtimes(): Promise<WorkbenchRuntime[]>;
  backups(spaceId: string): Promise<WorkbenchBackup[]>;
}
