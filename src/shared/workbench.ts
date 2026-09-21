/** Browser-safe workbench contracts. Jobs and durable records never carry file paths, cookies or child launch tokens. Transient blueprint product responses may include receiver-local input values. */
import type { LlmApiRequest, LlmApiResult, LlmCredentialRequest, LlmSpaceObservation } from './llm-api';
import type { CreateSpaceInput, SpaceDetail, SpaceSummary, SpacesMode } from './spaces-control';
import type {
  WorkbenchProductCommand,
  WorkbenchProductOutcome,
  WorkbenchProductRequest,
  WorkbenchProductResult,
} from './workbench-product';

export type WorkbenchRole = 'manager' | 'workspace' | 'uninitialized';
export type ControllerKind = 'web' | 'desktop';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type WorkbenchAvailability = 'ready' | 'limited' | 'unavailable';
export type WorkbenchProtocolVersion = 2;

/** Read/write CAS token. Missing or malformed context is rejected by callers. */
export interface WorkbenchMutationContext {
  serviceEpoch: string;
  expectedRevision: string;
}

/** Browser-safe failure fields. Do not put paths, tokens, or suggested fixes here. */
export interface WorkbenchFailureContext {
  spaceId?: string;
  stage?: string;
  packageName?: string;
  /** Known plugin vs could not attribute. */
  pluginAttribution?: 'known' | 'unknown';
  exitCode?: number | null;
  signal?: string | null;
}

export interface WorkbenchJobErrorInfo extends WorkbenchFailureContext {
  code: string;
  message: string;
}

export function formatWorkbenchFailure(input: {
  spaceId?: string;
  stage?: string;
  packageName?: string;
  pluginAttribution?: 'known' | 'unknown';
  reason: string;
  exitCode?: number | null;
  signal?: string | null;
}): string {
  const lines = [
    input.spaceId ? `空间 ${input.spaceId} 启动失败` : '操作失败',
    '',
    input.stage ? `阶段：${input.stage}` : '',
    input.pluginAttribution === 'unknown'
      ? '插件归属：未能归属到单个插件'
      : input.packageName
        ? `插件：${input.packageName}`
        : '',
    `原因：${input.reason}`,
    input.exitCode != null ? `退出码：${input.exitCode}` : '',
    input.signal ? `信号：${input.signal}` : '',
    '',
    '该次操作已失败。',
  ];
  return lines.filter((line, i, all) => line !== '' || (all[i - 1] !== '' && i !== 0)).join('\n').trim();
}

export interface WorkbenchPackageRelease {
  id: 'bundled-workbench';
  version: string;
  installedVersion: string | null;
  digest: string;
  updateAvailable: boolean;
}

export interface WorkbenchSpace extends Omit<SpaceSummary, 'status'> {
  icon: string;
  status: 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed' | 'unknown';
  generation: number;
  managed: boolean;
  needsIsolation: boolean;
}

export interface WorkbenchState {
  protocolVersion: WorkbenchProtocolVersion;
  serviceEpoch: string;
  revision: string;
  availability: WorkbenchAvailability;
  role: WorkbenchRole;
  managerId: string | null;
  /** Read-only controller status. Never includes the lock nonce. */
  owner: { kind: ControllerKind; since: string } | null;
  writable: boolean;
  mode: SpacesMode;
  dshVersion: string | null;
  maintenance: boolean;
  reasons: string[];
  spaces: WorkbenchSpace[];
  jobs: WorkbenchJob[];
}

export interface WorkbenchView {
  serviceEpoch: string;
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
  serviceEpoch: string;
  spaceId: string;
  generation: number;
  channel: string;
  state: 'ready' | 'failed' | 'disconnected';
  message?: string;
}

export type WorkbenchJobResult = {
  spaceId?: string;
  snapshotId?: string;
  runtimeVersion?: string;
  view?: WorkbenchView;
  product?: WorkbenchProductOutcome;
};

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
  result?: WorkbenchJobResult;
  error?: WorkbenchJobErrorInfo;
}

export type WorkbenchCommand =
  | { kind: 'space.create'; input: CreateSpaceInput & { icon?: string; useSharedLlm?: boolean } }
  | { kind: 'space.update'; spaceId: string; displayName?: string; icon?: string }
  | { kind: 'space.reorder'; spaceIds: string[] }
  | { kind: 'space.start'; spaceId: string }
  | { kind: 'space.verify'; spaceId: string }
  | { kind: 'plan.execute'; planId: string }
  | { kind: 'llm.apply'; spaceIds: string[]; catalogRevision: number; observations: LlmSpaceObservation[] }
  | WorkbenchProductCommand;

export type WorkbenchPlanRequest =
  | { kind: 'space.stop' | 'space.restart'; spaceId: string }
  | { kind: 'space.delete'; spaceId: string; removeData: boolean }
  | { kind: 'plugin.install'; spaceIds: string[]; catalogId: string; version: string }
  | { kind: 'plugin.remove'; spaceId: string; packageName: string }
  | { kind: 'plugin.toggle'; spaceId: string; pluginId: string; enabled: boolean }
  | { kind: 'plugin.cleanup-manager'; spaceId: string }
  | { kind: 'snapshot.create' }
  | { kind: 'snapshot.delete'; snapshotId: string }
  | { kind: 'runtime.install' | 'runtime.upgrade'; version: string }
  | { kind: 'workbench.upgrade'; catalogId: 'bundled-workbench'; version: string }
  | { kind: 'service.shutdown' };

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
  serviceEpoch: string;
  stateRevision: string;
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
  submit(command: WorkbenchCommand, requestId: string, context: WorkbenchMutationContext): Promise<WorkbenchJob>;
  job(id: string): Promise<WorkbenchJob>;
  cancel(id: string): Promise<WorkbenchJob>;
  view(spaceId: string): Promise<WorkbenchView>;
  preview(request: WorkbenchPlanRequest, context: WorkbenchMutationContext): Promise<WorkbenchPlan>;
  product(request: WorkbenchProductRequest): Promise<WorkbenchProductResult>;
  plugins(query: string): Promise<WorkbenchPlugin[]>;
  snapshots(): Promise<WorkbenchSnapshot[]>;
  snapshot(id: string): Promise<WorkbenchSnapshot>;
  runtimes(): Promise<WorkbenchRuntime[]>;
  /** Optional for older adapters; candidates are bound by the local supervisor. */
  workbenchPackage?(): Promise<WorkbenchPackageRelease | null>;
  backups(spaceId: string): Promise<WorkbenchBackup[]>;
  /** Redacted global LLM management. Secrets use the Host-only llmCredential HTTP method. */
  llm?(request: LlmApiRequest): Promise<LlmApiResult>;
  /**
   * Manager-Host-only secret writes. The payload lives for the request only:
   * it is not a StoredJob, not logged, and not returned to workspace profiles.
   */
  llmCredential?(request: LlmCredentialRequest): Promise<LlmApiResult>;
}
