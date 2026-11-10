/** Browser-safe workbench contracts. Jobs and durable records never carry file paths, cookies or child launch tokens. Transient blueprint product responses may include receiver-local input values. */
import type { CreateSpaceInput, SpaceDetail, SpaceSummary, SpacesMode } from './spaces-control';
import type { PluginSourceSpec } from './plugin-source';
import type {
  WorkbenchProductCommand,
  WorkbenchProductOutcome,
  WorkbenchProductRequest,
  WorkbenchProductResult,
} from './workbench-product';
import type { WorkbenchStartupStatus } from './workbench-startup';

export type { WorkbenchStartupStatus };

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

export interface WorkbenchSpace extends Omit<SpaceSummary, 'status'> {
  base?: 'web' | 'browser';
  baseVersion?: string;
  icon: string;
  status: 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed' | 'unknown';
  generation: number;
  managed: boolean;
  /** Presentation hint only: a pending approval or question in this space. Never a status, never authority. */
  attention?: import('./space-attention').SpaceAttention;
  /** Exact pinned DSH runtime version; null for the manager, which follows the host CLI. */
  dshVersion: string | null;
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

/** One step of a composed job such as creator.create. */
export interface WorkbenchJobStep {
  step: string;
  status: 'done' | 'failed' | 'not-run';
  packageName?: string;
  /** Public provenance for the step, e.g. an exact version or pinned git spec. */
  detail?: string;
}

export type WorkbenchJobResult = {
  spaceId?: string;
  snapshotId?: string;
  runtimeVersion?: string;
  dshVersion?: string;
  view?: WorkbenchView;
  product?: WorkbenchProductOutcome;
  steps?: WorkbenchJobStep[];
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
  subject?: { displayName: string; icon?: string };
}

export type WorkbenchCommand =
  | { kind: 'space.create'; input: CreateSpaceInput & { icon?: string; modelSource?: 'main'|'local'; browser?: boolean; base?: 'web'|'browser'; baseVersion?: string } }
  | { kind: 'space.update'; spaceId: string; displayName?: string; icon?: string }
  | { kind: 'space.reorder'; spaceIds: string[] }
  | { kind: 'space.start'; spaceId: string }
  | { kind: 'plan.execute'; planId: string }
  | {
      /**
       * Creator-channel composite command. Submitted only through
       * `/internal/creator/v1/createExecute`; the general `submit` dispatch
       * rejects it. `planId` identifies the frozen in-memory plan (prefixed
       * by its owning creator registration), not a lifecycle plan.
       */
      kind: 'creator.create';
      planId: string;
      name: string;
      displayName?: string;
      icon?: string;
    }
  | {
      /**
       * Control-channel lifecycle command. Submitted only through
       * `/internal/control/v1/execute`; the general `submit` dispatch rejects
       * it. `controlPlanId` identifies the frozen in-memory control plan
       * (prefixed by the owning main registration); the job's runner resolves
       * it back to the recorded start command or lifecycle plan.
       */
      kind: 'control.execute';
      controlPlanId: string;
      spaceId: string;
    }
  | WorkbenchProductCommand;

export type WorkbenchPlanRequest =
  | { kind: 'space.stop' | 'space.restart'; spaceId: string }
  | { kind: 'space.delete'; spaceId: string; removeData: boolean }
  | { kind: 'plugin.install'; spaceIds: string[]; catalogId: string; version: string }
  | {
      /**
       * Exact-source install variant: the closed npm/github source the
       * control channel freezes — never a catalog id, tag, range, raw spec
       * or path. The maintenance plan installs verbatim and verifies the
       * read-back against the pinned source.
       */
      kind: 'plugin.install.spec';
      spaceId: string;
      source: PluginSourceSpec;
    }
  | { kind: 'plugin.remove'; spaceId: string; packageName: string }
  | { kind: 'plugin.toggle'; spaceId: string; pluginId: string; enabled: boolean }
  | { kind: 'plugin.cleanup-manager'; spaceId: string }
  | {
      /**
       * Supervisor-local plans that write through the RUNNING child's own
       * `pluginManager` @Remote (path B): the child process applies the
       * change inside its declared reload lifecycle. They require a running
       * space and never stop it; the supervisor never writes the profile
       * while these run. The public preview input parser does not admit
       * these kinds; only the control channel's `plugin.live.*` ops create
       * them, and they are never read back off disk.
       */
      kind: 'plugin.live.install';
      spaceId: string;
      source: PluginSourceSpec;
    }
  | { kind: 'plugin.live.update'; spaceId: string; packageName: string; version: string }
  | { kind: 'plugin.live.entry'; spaceId: string; entryId: string; enabled: boolean }
  | { kind: 'plugin.live.remove'; spaceId: string; packageName: string }
  | { kind: 'snapshot.create' }
  | { kind: 'snapshot.delete'; snapshotId: string }
  | { kind: 'space.runtime.set'; spaceId: string; version: string }
  | {
      /**
       * Supervisor-local plan: copy the main space's model settings into a
       * stopped space once. The maintenance service hands it off.
       */
      kind: 'space.models.sync';
      spaceId: string;
    }
  | { kind: 'runtime.remove'; version: string }
  | { kind: 'service.shutdown' };

export interface WorkbenchPlan {
  /** Fresh task observation for a stop/restart; unknown requires an impact confirmation. */
  taskActivity?: 'idle' | 'busy' | 'unknown';
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
  host: boolean;
  pinnedBy: string[];
  removable: boolean;
  compatible: boolean;
}

export interface WorkbenchBackup { id: string; createdAt: string; reason: string }

/**
 * The one authoritative description of the management API surface.
 *
 * Every consumer is derived from this table: the `WorkbenchApi` contract, the
 * Host Remote registration, the Typert Client declarations, the wire schema
 * table and the Supervisor dispatch table. A method can therefore no longer be
 * added to one of them and forgotten in another.
 *
 * `args` lists the wire arguments in wire order. `name` is the wire argument
 * name; `value` is a type witness that is `undefined` at runtime and only pins
 * the argument's DTO type.
 */
export const WORKBENCH_API = {
  state: {
    args: [] as const,
    result: undefined as unknown as WorkbenchState,
  },
  /** Readonly startup observation. */
  startupStatus: {
    args: [] as const,
    result: undefined as unknown as WorkbenchStartupStatus,
  },
  detail: {
    args: [{ name: "spaceId", value: undefined as unknown as string }] as const,
    result: undefined as unknown as SpaceDetail,
  },
  submit: {
    args: [
      { name: "command", value: undefined as unknown as WorkbenchCommand },
      { name: "requestId", value: undefined as unknown as string },
      { name: "context", value: undefined as unknown as WorkbenchMutationContext },
    ] as const,
    result: undefined as unknown as WorkbenchJob,
  },
  job: {
    args: [{ name: "id", value: undefined as unknown as string }] as const,
    result: undefined as unknown as WorkbenchJob,
  },
  cancel: {
    args: [{ name: "id", value: undefined as unknown as string }] as const,
    result: undefined as unknown as WorkbenchJob,
  },
  view: {
    args: [{ name: "spaceId", value: undefined as unknown as string }] as const,
    result: undefined as unknown as WorkbenchView,
  },
  preview: {
    args: [
      { name: "request", value: undefined as unknown as WorkbenchPlanRequest },
      { name: "context", value: undefined as unknown as WorkbenchMutationContext },
    ] as const,
    result: undefined as unknown as WorkbenchPlan,
  },
  product: {
    args: [{ name: "request", value: undefined as unknown as WorkbenchProductRequest }] as const,
    result: undefined as unknown as WorkbenchProductResult,
  },
  plugins: {
    args: [{ name: "query", value: undefined as unknown as string }] as const,
    result: undefined as unknown as WorkbenchPlugin[],
  },
  snapshots: {
    args: [] as const,
    result: undefined as unknown as WorkbenchSnapshot[],
  },
  snapshot: {
    args: [{ name: "id", value: undefined as unknown as string }] as const,
    result: undefined as unknown as WorkbenchSnapshot,
  },
  runtimes: {
    args: [] as const,
    result: undefined as unknown as WorkbenchRuntime[],
  },
  backups: {
    args: [{ name: "spaceId", value: undefined as unknown as string }] as const,
    result: undefined as unknown as WorkbenchBackup[],
  },
} as const;

/** One management API method name. */
export type WorkbenchApiMethod = keyof typeof WORKBENCH_API;

/** The canonical management API method names, in wire order. */
export const WORKBENCH_API_METHODS: readonly WorkbenchApiMethod[] = Object.keys(
  WORKBENCH_API,
) as WorkbenchApiMethod[];

/** The DTO arguments of one management API method, in wire order. */
export type WorkbenchApiArgs<K extends WorkbenchApiMethod> = (typeof WORKBENCH_API)[K] extends {
  args: infer A extends readonly unknown[];
}
  ? { -readonly [I in keyof A]: A[I] extends { value: infer V } ? V : never }
  : never;

/** The DTO result of one management API method. */
export type WorkbenchApiResult<K extends WorkbenchApiMethod> = (typeof WORKBENCH_API)[K] extends {
  result: infer R;
}
  ? R
  : never;

/** The wire argument names of one management API method. */
export type WorkbenchApiArgNames<K extends WorkbenchApiMethod> = (typeof WORKBENCH_API)[K] extends {
  args: infer A extends readonly unknown[];
}
  ? (A[number] extends { name: infer N } ? (N extends string ? N : never) : never)
  : never;

/** The methods a Host may leave unimplemented. */
export type WorkbenchApiOptionalMethod = {
  [K in WorkbenchApiMethod]: (typeof WORKBENCH_API)[K] extends { optional: true } ? K : never;
}[WorkbenchApiMethod];

/** The methods every Host must implement. */
export type WorkbenchApiRequiredMethod = Exclude<WorkbenchApiMethod, WorkbenchApiOptionalMethod>;

/**
 * The management API contract, derived from {@link WORKBENCH_API}.
 *
 * The interface, the Host Remote registration and the Client declarations all
 * read the same table, so they cannot disagree about which methods exist or
 * what they carry.
 */
export type WorkbenchApi = {
  [K in WorkbenchApiRequiredMethod]: (...args: WorkbenchApiArgs<K>) => Promise<WorkbenchApiResult<K>>;
} & {
  [K in WorkbenchApiOptionalMethod]?: (...args: WorkbenchApiArgs<K>) => Promise<WorkbenchApiResult<K>>;
};
