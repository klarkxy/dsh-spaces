/**
 * Browser-safe Control (空间总控) channel contract. Scoped channel for the
 * trusted main-space identity, sharing the same registration record as the
 * Creator channel but gated by its own `control` scope. Read operations and
 * durable records never carry file paths, tokens, cookies or credentials.
 *
 * Wire shape: POST {origin}/internal/control/v1/<op> with a JSON body.
 * `issue`/`unregister` accept the Host bearer and return/retire the shared
 * registration (the response is the same CreatorIssueResult: one
 * registrationId with `scopes: { creator?, control? }`); every other op
 * accepts only the issued control scope as its Bearer token.
 */
import type { DiagnosticLogEntry, ConfigBackupMeta } from './diagnostics';
import type { WorkbenchJob, WorkbenchRuntime } from './workbench';
import type { PluginSourceSpec, ExactPluginSource } from './plugin-source';
import { PluginSourceError, parsePluginPackageName, parsePluginSource } from './plugin-source';
import { isExactRuntimeVersion } from './runtime';
import type { SpaceSharePreview, SpaceSharePlugin } from './space-share';
import { SPACE_NAME_RE } from './types';
import { MAX_WORKBENCH_SHARE_BASE64 } from './workbench-product';

export { parseCreatorIssueInput as parseControlIssueInput } from './creator';
export type { CreatorIssueInput as ControlIssueInput } from './creator';

/** Wire prefix served by the Supervisor loopback entry. */
export const CONTROL_CHANNEL_PREFIX = '/internal/control/v1/';

export const CONTROL_PROTOCOL_VERSION = 1 as const;

/**
 * Internal operations. `issue`/`unregister` accept only the Host bearer and
 * act on the registration shared with the Creator channel; the business
 * operations accept only the issued control scope token. `session` is
 * declared now so the surface is closed; the session-proxy phase it was
 * reserved for was withdrawn in favour of the `ui.*` automation ops, so it
 * keeps answering control/unsupported rather than not-found. The `ui.*` ops
 * drive the child-space page through the Supervisor's own automation
 * browser; every business `ui.*` op except `ui.open` takes a `uiSessionId`
 * minted by `ui.open` and bound to (registration, spaceId, generation,
 * serviceEpoch). Results never carry cookies, launch URLs, ports or
 * absolute origins.
 */
export const CONTROL_OPS = [
  'issue',
  'unregister',
  'context',
  'read',
  'plan',
  'execute',
  'session',
  'job',
  'import.preview',
  'ui.open',
  'ui.snapshot',
  'ui.act',
  'ui.eval',
  'ui.close',
] as const;
export type ControlOperation = (typeof CONTROL_OPS)[number];

/** Bounded read payloads. */
export const CONTROL_OVERVIEW_BYTES = 32 * 1024;
export const CONTROL_READ_BYTES = 64 * 1024;
export const CONTROL_LOG_TAIL_MAX = 200;
export const CONTROL_LOG_TAIL_DEFAULT = 100;
export const CONTROL_INSPECT_JOB_LIMIT = 16;
export const CONTROL_FAILED_JOB_LIMIT = 8;
export const CONTROL_LIVE_PLUGIN_LIMIT = 256;
export const CONTROL_TEMPLATE_LIMIT = 64;
export const CONTROL_TEMPLATE_PLUGIN_LIMIT = 32;
export const CONTROL_SECTION_SET = new Set(['plugins', 'plugins.live', 'model', 'runtime', 'diagnostics', 'jobs'] as const);
export type ControlInspectSection = 'plugins' | 'plugins.live' | 'model' | 'runtime' | 'diagnostics' | 'jobs';
export const CONTROL_INSPECT_DEFAULT_SECTIONS: readonly ControlInspectSection[] = ['plugins', 'model'];
export const CONTROL_READ_VIEWS = ['overview', 'inspect', 'logs', 'templates'] as const;
export type ControlReadView = (typeof CONTROL_READ_VIEWS)[number];
/**
 * `import.preview` stages one share archive (base64, capped like the
 * workbench share surface); the plan op itself stays inside the small body
 * limit. This op's request body may carry the share-bound envelope.
 */
export const CONTROL_IMPORT_PREVIEW_BODY_LIMIT = MAX_WORKBENCH_SHARE_BASE64 + 64 * 1024;

/**
 * Lifecycle + plugin/runtime/model-policy ops the plan/execute flow covers.
 * The `plugin.live.*` family writes through the running child space's own
 * `pluginManager` @Remote (path B in space-control-extensions.md); every
 * other op writes through the supervisor while the space is stopped or is
 * stopped inside the job. The two paths are never mixed on one profile.
 */
export const CONTROL_PLAN_OPS = [
  'start',
  'stop',
  'restart',
  'delete',
  'plugin.install',
  'plugin.remove',
  'plugin.toggle',
  'runtime.set',
  'models.sync',
  'plugin.live.install',
  'plugin.live.update',
  'plugin.live.entry',
  'plugin.live.remove',
  'space.from-template',
  'space.import',
] as const;
export type ControlPlanOp = (typeof CONTROL_PLAN_OPS)[number];
/** Ops that mutate a space but take no params beyond the target. */
const LIFECYCLE_OPS = new Set<ControlPlanOp>(['start', 'stop', 'restart', 'delete']);
/** Ops that take only the target space, like lifecycle ops, but freeze a supervisor plan. */
const TARGET_ONLY_OPS = new Set<ControlPlanOp>(['models.sync']);
/**
 * Ops that create a space rather than mutate an existing one. They take no
 * `spaceId` — the space id is derived from `params.name` — and the frozen
 * plan's `spaceId` is the derived (not yet existing) id.
 */
export const CONTROL_CREATION_PLAN_OPS = new Set<ControlPlanOp>(['space.from-template', 'space.import']);
/** Running-space ops handled by the child's own pluginManager @Remote. */
export const CONTROL_LIVE_PLAN_OPS = new Set<ControlPlanOp>([
  'plugin.live.install',
  'plugin.live.update',
  'plugin.live.entry',
  'plugin.live.remove',
]);
export const CONTROL_PLAN_TTL_MS = 5 * 60_000;
export const CONTROL_PLAN_LIMIT = 64;

export const CONTROL_ERROR = {
  'control/invalid-input': 'The request is not a valid control operation.',
  'control/not-found': 'That item was not found.',
  'control/conflict': 'A different main identity is already registered for this service epoch.',
  'control/unregistered': 'The registration id does not match the active registration.',
  'control/request-conflict': 'The observed state no longer matches the request.',
  'control/plan-expired': 'The control plan expired. Request a new plan.',
  'control/plan-consumed': 'The control plan was already submitted.',
  'control/protected': 'That space cannot be controlled through this channel.',
  'control/not-running': 'The space is not running.',
  'control/read-only': 'The workbench is read-only until control is acquired.',
  'control/unavailable': 'The workbench cannot accept this request.',
  'control/unsupported': 'That command is not supported.',
  'control/busy': 'The workbench already has a queued or running job.',
  'control/engine-unavailable': 'The UI automation engine is unavailable for this service epoch.',
  'control/failed': 'The control request failed.',
} as const;

export type ControlErrorCode = keyof typeof CONTROL_ERROR;

export class ControlPublicError extends Error {
  readonly name = 'ControlPublicError';
  constructor(
    readonly code: ControlErrorCode,
    message: string = CONTROL_ERROR[code],
  ) {
    super(message);
  }
}

/** `activity` is the last observed task state of one ordinary space. */
export type ControlSpaceActivity = 'idle' | 'busy' | 'unknown';

export interface ControlContext {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  serviceEpoch: string;
  revision: string;
  writable: boolean;
  maintenance: boolean;
  /** A queued or running job occupies the single serialized job lane. */
  busy: boolean;
  dshVersion: string | null;
  /** One entry per registered ordinary space (never web/desktop/manager). */
  spaces: Array<{ id: string; activity: ControlSpaceActivity }>;
}

/** The issue result is shared with Creator: one registration, two scopes. */
export interface ControlIssueResult {
  registrationId: string;
  scopes: {
    creator?: string;
    control?: string;
  };
  serviceEpoch: string;
}

export interface ControlReadInput {
  view: ControlReadView;
  /** Required for `inspect` and `logs`; rejected for `overview`. */
  spaceId?: string;
  /** `inspect` only; absent means plugins + model. */
  sections?: ControlInspectSection[];
  /** `logs` only; clamped to CONTROL_LOG_TAIL_MAX. */
  tail?: number;
}

export interface ControlOverviewSpace {
  id: string;
  displayName: string;
  status: 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed' | 'unknown';
  generation: number;
  dshVersion: string | null;
  activity: ControlSpaceActivity;
}

/** Public, already-sanitized job projection. */
export interface ControlJobSummary {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  message: string;
  updatedAt: string;
  affectedSpaceIds: string[];
  error?: { code: string; message: string };
}

export interface ControlOverviewResult {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  serviceEpoch: string;
  revision: string;
  writable: boolean;
  maintenance: boolean;
  busy: boolean;
  dshVersion: string | null;
  spaces: ControlOverviewSpace[];
  /** Spaces with a queued/running/failed creation job (portal projection). */
  creating: Array<{
    jobId: string;
    spaceId: string;
    displayName: string;
    status: 'queued' | 'running' | 'failed';
    phase: string;
    message: string;
    error?: string;
  }>;
  failedJobs: ControlJobSummary[];
  /** True when content was dropped to stay within CONTROL_OVERVIEW_BYTES. */
  truncated: boolean;
}

export type ControlSectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ControlErrorCode; message: string };

export interface ControlInspectModel {
  /** Child model catalog is not readable by the supervisor yet; null stays. */
  catalog: null;
  /** Why catalog is null: the child model catalog is only readable through a
   *  later UI-automation or in-space plugin surface. */
  catalogReason: string;
}

export interface ControlInspectRuntime {
  /** Exact pinned DSH runtime version of the space; null follows the host. */
  dshVersion: string | null;
  /** Installed runtime catalog; null when the maintenance read is unavailable. */
  runtimes: WorkbenchRuntime[] | null;
}

export interface ControlInspectDiagnostics {
  status: 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed' | 'unknown';
  lastError?: string;
  logError?: string;
  backups: ConfigBackupMeta[];
}

/**
 * The running child's own runtime view, read through its pluginManager and
 * pluginInventory @Remote surfaces (bounded, sanitized; never the raw rows).
 * `running` is the supervisor's status read at request time — a space that
 * stopped between then and the remote call fails inside that read instead of
 * fabricating a list.
 */
export interface ControlInspectLive {
  running: boolean;
  /** Loader entries in load order (pluginInventory/list or, when it is not
   *  mounted, the pluginManager projection of the same inventory). */
  plugins: Array<{
    entryId: string;
    moduleName: string;
    enabled: boolean;
    fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null;
    diagnostic?: string;
    patchId?: string;
    readOnlyReason?: string;
  }>;
  /** Bundles in the manifest's `dsh.profile.bundles` declaration order. */
  bundles: Array<{
    name: string;
    version?: string;
    enabled: boolean;
    installed: boolean;
    official?: boolean;
    updatable?: boolean;
    source?: string;
    error?: { code: string; diagnostic?: string };
  }>;
  /** True when a large remote row set was cut to the inspect bound. */
  truncated: boolean;
}

export interface ControlInspectResult {
  spaceId: string;
  plugins?: ControlSectionResult<Array<{ name: string; version: string | null }>>;
  pluginsLive?: ControlSectionResult<ControlInspectLive>;
  model?: ControlSectionResult<ControlInspectModel>;
  runtime?: ControlSectionResult<ControlInspectRuntime>;
  diagnostics?: ControlSectionResult<ControlInspectDiagnostics>;
  jobs?: ControlSectionResult<ControlJobSummary[]>;
}

export interface ControlLogsResult {
  spaceId: string;
  status: 'running' | 'starting' | 'stopping' | 'stopped' | 'crashed' | 'unknown';
  logError?: string;
  /** Sanitized tail; content only, never file paths. */
  entries: DiagnosticLogEntry[];
  /** True when entries were dropped for the tail or byte cap. */
  truncated: boolean;
}

export type ControlReadResult =
  | ({ view: 'overview' } & ControlOverviewResult)
  | ({ view: 'inspect' } & ControlInspectResult)
  | ({ view: 'logs' } & ControlLogsResult)
  | ({ view: 'templates' } & ControlTemplatesResult);

export type { WorkbenchJob as ControlJobResult };

/** One template row in the `templates` read view (bounded, sanitized). */
export interface ControlTemplateSummary {
  id: string;
  name: string;
  displayName: string;
  createdAt: string;
  /** Base selection + dshVersion recorded in the recipe; absent fields omitted. */
  source?: { dshVersion?: string | null; base?: string; baseVersion?: string };
  /** Bounded plugin manifest summary; truncated drops entries. */
  plugins: Array<{
    packageName: string;
    source: SpaceSharePlugin['source'];
    resolvedVersion: string | null;
    installSpec?: string;
  }>;
  hasConfig: boolean;
}

export interface ControlTemplatesResult {
  templates: ControlTemplateSummary[];
  /** True when rows or plugin entries were dropped for the bound. */
  truncated: boolean;
}

/**
 * `import.preview` input: a base64 share archive uploaded by the trusted
 * main host. The archive never takes a local path form — content only.
 */
export interface ControlImportPreviewInput {
  archiveBase64: string;
}

/**
 * `import.preview` result: the staged import id and the share's public
 * preview rows. `importId` is what a `space.import` plan consumes.
 */
export interface ControlImportPreviewResult {
  importId: string;
  expiresAt: string;
  preview: SpaceSharePreview;
}

/**
 * Frozen single-use control plan. `fingerprint` binds the normalized input,
 * the service epoch, the state revision and the target's observed status,
 * generation and task activity at plan time; execute refuses when any of
 * them moved. `displayName` is the space label frozen for approval text —
 * a rename changes the revision and invalidates the plan anyway.
 */
/** Normalized params as the frozen plan echoes them back. */
export type ControlPlanParamsResult =
  | { source: ExactPluginSource }
  | { packageName: string }
  | { packageName: string; enabled: boolean }
  | { packageName: string; version: string }
  | { entryId: string; enabled: boolean }
  | { version: string }
  | { templateId: string; name: string; displayName?: string }
  | { importId: string; name: string; displayName?: string };

/** Per-op params, discriminated by `op`. Lifecycle ops take none. */
export type ControlPlanParams =
  | { source: PluginSourceSpec }
  | { packageName: string }
  | { packageName: string; enabled: boolean }
  | { packageName: string; version: string }
  | { entryId: string; enabled: boolean }
  | { version: string }
  | { templateId: string; name: string; displayName?: string }
  | { importId: string; name: string; displayName?: string };

export type ControlPlanInput =
  | { op: 'start' | 'stop' | 'restart' | 'delete'; spaceId: string }
  | { op: 'plugin.install'; spaceId: string; params: { source: PluginSourceSpec } }
  | { op: 'plugin.remove'; spaceId: string; params: { packageName: string } }
  | { op: 'plugin.toggle'; spaceId: string; params: { packageName: string; enabled: boolean } }
  | { op: 'runtime.set'; spaceId: string; params: { version: string } }
  | { op: 'models.sync'; spaceId: string }
  | { op: 'plugin.live.install'; spaceId: string; params: { source: PluginSourceSpec } }
  | { op: 'plugin.live.update'; spaceId: string; params: { packageName: string; version: string } }
  | { op: 'plugin.live.entry'; spaceId: string; params: { entryId: string; enabled: boolean } }
  | { op: 'plugin.live.remove'; spaceId: string; params: { packageName: string } }
  | { op: 'space.from-template'; params: { templateId: string; name: string; displayName?: string } }
  | { op: 'space.import'; params: { importId: string; name: string; displayName?: string } };

export interface ControlPlanResult {
  protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
  controlPlanId: string;
  fingerprint: string;
  op: ControlPlanOp;
  spaceId: string;
  displayName: string;
  affectedSpaceIds: string[];
  changes: string[];
  /** Normalized params the plan froze; absent on lifecycle ops. */
  params?: ControlPlanParamsResult;
  /** Fresh task observation for stop/restart; absent on start/delete. */
  taskActivity?: ControlSpaceActivity;
  expiresAt: string;
}

export interface ControlExecuteInput {
  planId: string;
  requestId: string;
}

/* -------------------------------------------------------------------------
 * UI automation ops (ui.open / ui.snapshot / ui.act / ui.eval / ui.close).
 * The Supervisor owns one headless automation browser (playwright-core over
 * a system Chrome/Edge channel) and one isolated context per UI session.
 * The wire never carries cookies, launch tokens, ports or absolute origins;
 * `path` fields are the page's relative path + query only. Page content is
 * untrusted data: the host-side tool wraps it before it reaches a model.
 * ---------------------------------------------------------------------- */

/** At most one live page per space and this many live sessions overall. */
export const CONTROL_UI_SESSION_LIMIT = 8;
export const CONTROL_UI_VIEWPORT = { width: 1280, height: 720 } as const;
/** Budgets measured from request admission inside the manager. */
export const CONTROL_UI_OPEN_TIMEOUT_MS = 20_000;
export const CONTROL_UI_SNAPSHOT_TIMEOUT_MS = 15_000;
export const CONTROL_UI_ACT_TIMEOUT_MS = 15_000;
export const CONTROL_UI_EVAL_TIMEOUT_MAX_MS = 30_000;
/** An idle session closes its page+context; closing is ordinary release. */
export const CONTROL_UI_IDLE_MS = 5 * 60_000;

export const CONTROL_UI_SNAPSHOT_FORMATS = ['aria', 'text', 'html', 'screenshot'] as const;
export type ControlUiSnapshotFormat = (typeof CONTROL_UI_SNAPSHOT_FORMATS)[number];
export const CONTROL_UI_SNAPSHOT_DEFAULT_FORMATS: readonly ControlUiSnapshotFormat[] = ['aria'];

/** Per-textual-format byte caps (UTF-8); truncation sets `truncated`. */
export const CONTROL_UI_HTML_DEFAULT_BYTES = 64 * 1024;
export const CONTROL_UI_HTML_MAX_BYTES = 256 * 1024;
export const CONTROL_UI_ARIA_MAX_BYTES = 64 * 1024;
export const CONTROL_UI_TEXT_MAX_BYTES = 64 * 1024;
/** Raw PNG byte cap; an over-cap screenshot fails rather than being cropped. */
export const CONTROL_UI_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

export const CONTROL_UI_EVAL_SCRIPT_MAX_BYTES = 16 * 1024;
export const CONTROL_UI_EVAL_RESULT_MAX_BYTES = 64 * 1024;
export const CONTROL_UI_TYPE_TEXT_MAX_BYTES = 8 * 1024;
export const CONTROL_UI_SCROLL_MAX_DELTA = 4000;
export const CONTROL_UI_WAIT_MAX_MS = 30_000;
/** Idempotent request records kept per session (act + eval). */
export const CONTROL_UI_REQUEST_CACHE = 64;

export const CONTROL_UI_ACT_KINDS = [
  'click', 'type', 'press', 'scroll', 'select', 'hover', 'navigate', 'wait',
] as const;
export type ControlUiActKind = (typeof CONTROL_UI_ACT_KINDS)[number];

export type ControlUiAct =
  | { kind: 'click'; ref?: string; x?: number; y?: number; button?: 'left' | 'right'; clickCount?: 1 | 2 }
  | { kind: 'type'; ref: string; text: string }
  | { kind: 'press'; key: string; ref?: string }
  | { kind: 'scroll'; deltaY: number; ref?: string }
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'hover'; ref: string }
  | { kind: 'navigate'; path: string }
  | { kind: 'wait'; ms: number };

export interface ControlUiOpenInput {
  spaceId: string;
}

/** `viewport` is the fixed automation viewport; `url` is never returned. */
export interface ControlUiOpenResult {
  uiSessionId: string;
  spaceId: string;
  generation: number;
  viewport: { width: number; height: number };
  path: string;
}

export interface ControlUiSnapshotInput {
  uiSessionId: string;
  formats?: ControlUiSnapshotFormat[];
  /** aria-ref from the latest aria snapshot; scopes every requested format. */
  ref?: string;
  /** html format byte cap, clamped to CONTROL_UI_HTML_MAX_BYTES. */
  maxBytes?: number;
}

export interface ControlUiSnapshotResult {
  uiSessionId: string;
  spaceId: string;
  title: string;
  /** Page relative path + query, never the absolute origin. */
  path: string;
  aria?: string;
  text?: string;
  html?: string;
  /** Raw PNG bytes as base64; the host persists it via attachments. */
  screenshot?: string;
  screenshotBytes?: number;
  /** True when any returned textual body was cut at its byte cap. */
  truncated: boolean;
}

export interface ControlUiActInput {
  uiSessionId: string;
  requestId: string;
  act: ControlUiAct;
}

export interface ControlUiActResult {
  done: true;
  /** Page relative path + query after the action settled. */
  path: string;
}

export interface ControlUiEvalInput {
  uiSessionId: string;
  requestId: string;
  /** Function-body source run in the page; `element` is bound when ref set. */
  script: string;
  ref?: string;
  timeoutMs?: number;
}

export interface ControlUiEvalResult {
  /** JSON-serializable value; a truncated string when the serialized value
   *  exceeded CONTROL_UI_EVAL_RESULT_MAX_BYTES. Credential material is
   *  replaced by "[redacted]" before this is built. */
  value: unknown;
  truncated: boolean;
}

export interface ControlUiCloseInput {
  uiSessionId: string;
}

export interface ControlUiCloseResult {
  closed: true;
}

export type ControlUiOpInput =
  | { op: 'ui.open'; input: ControlUiOpenInput }
  | { op: 'ui.snapshot'; input: ControlUiSnapshotInput }
  | { op: 'ui.act'; input: ControlUiActInput }
  | { op: 'ui.eval'; input: ControlUiEvalInput }
  | { op: 'ui.close'; input: ControlUiCloseInput };

const SPACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

function invalid(message: string = CONTROL_ERROR['control/invalid-input']): never {
  throw new ControlPublicError('control/invalid-input', message);
}

function expectObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function expectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
  for (const key of required) {
    if (!(key in value)) invalid();
  }
}

function expectString(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  return value;
}

/** Validate and normalize a `read` request. Unknown keys are rejected. */
export function parseControlReadInput(value: unknown): ControlReadInput {
  const body = expectObject(value);
  expectKeys(body, ['view'], ['spaceId', 'sections', 'tail']);
  const view = expectString(body.view, 32) as ControlReadView;
  if (!CONTROL_READ_VIEWS.includes(view)) invalid();
  let spaceId: string | undefined;
  if (body.spaceId !== undefined) {
    spaceId = expectString(body.spaceId, 64);
    if (!SPACE_ID_RE.test(spaceId)) invalid();
  }
  if ((view === 'overview' || view === 'templates') && spaceId !== undefined) {
    invalid(`The ${view} view takes no spaceId.`);
  }
  if (view !== 'overview' && view !== 'templates' && spaceId === undefined) {
    invalid('This view requires a spaceId.');
  }
  let sections: ControlInspectSection[] | undefined;
  if (body.sections !== undefined) {
    if (view !== 'inspect') invalid('Only the inspect view accepts sections.');
    if (!Array.isArray(body.sections) || body.sections.length === 0 || body.sections.length > 8) invalid();
    const seen: ControlInspectSection[] = [];
    for (const item of body.sections) {
      const section = expectString(item, 32) as ControlInspectSection;
      if (!CONTROL_SECTION_SET.has(section)) invalid();
      if (!seen.includes(section)) seen.push(section);
    }
    sections = seen;
  }
  let tail: number | undefined;
  if (body.tail !== undefined) {
    if (view !== 'logs') invalid('Only the logs view accepts tail.');
    if (typeof body.tail !== 'number' || !Number.isSafeInteger(body.tail) || body.tail < 1) invalid();
    tail = Math.min(body.tail, CONTROL_LOG_TAIL_MAX);
  }
  return {
    view,
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(sections !== undefined ? { sections } : {}),
    ...(tail !== undefined ? { tail } : {}),
  };
}

const CONTROL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Map a source-validation failure onto this channel's closed error code. */
function sourceInvalid(error: unknown): never {
  if (error instanceof PluginSourceError) invalid(error.message);
  throw error;
}

function expectBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

/**
 * Validate and normalize a `plan` request. Unknown keys are rejected and
 * `params` is a closed shape discriminated by `op`: lifecycle ops take none.
 */
const CONTROL_DISPLAY_NAME_MAX = 80;

function expectDisplayName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, CONTROL_DISPLAY_NAME_MAX);
}

function expectNewSpaceName(value: unknown): string {
  const name = expectString(value, 33);
  if (!SPACE_NAME_RE.test(name)) invalid('That space name is not allowed.');
  return name;
}

export function parseControlPlanInput(value: unknown): ControlPlanInput {
  const body = expectObject(value);
  const op = expectString(body.op, 32) as ControlPlanOp;
  if (!(CONTROL_PLAN_OPS as readonly string[]).includes(op)) invalid();
  if (CONTROL_CREATION_PLAN_OPS.has(op)) {
    // Creation ops derive their space id from params.name; a spaceId on the
    // wire is meaningless and always rejected.
    expectKeys(body, ['op', 'params']);
    const params = expectObject(body.params);
    if (op === 'space.from-template') {
      expectKeys(params, ['templateId', 'name'], ['displayName']);
      const templateId = expectString(params.templateId, 128);
      if (!CONTROL_ID_RE.test(templateId)) invalid();
      const name = expectNewSpaceName(params.name);
      const displayName = expectDisplayName(params.displayName);
      return { op, params: { templateId, name, ...(displayName ? { displayName } : {}) } };
    }
    expectKeys(params, ['importId', 'name'], ['displayName']);
    const importId = expectString(params.importId, 128);
    if (!CONTROL_ID_RE.test(importId)) invalid();
    const name = expectNewSpaceName(params.name);
    const displayName = expectDisplayName(params.displayName);
    return { op: 'space.import', params: { importId, name, ...(displayName ? { displayName } : {}) } };
  }
  const spaceId = expectString(body.spaceId, 64);
  if (!SPACE_ID_RE.test(spaceId)) invalid();
  if (LIFECYCLE_OPS.has(op)) {
    expectKeys(body, ['op', 'spaceId']);
    return { op: op as 'start' | 'stop' | 'restart' | 'delete', spaceId };
  }
  if (TARGET_ONLY_OPS.has(op)) {
    expectKeys(body, ['op', 'spaceId']);
    return { op: 'models.sync', spaceId };
  }
  expectKeys(body, ['op', 'spaceId', 'params']);
  const params = expectObject(body.params);
  switch (op) {
    case 'plugin.install': {
      expectKeys(params, ['source']);
      try {
        parsePluginSource(params.source);
      } catch (error) {
        sourceInvalid(error);
      }
      return { op, spaceId, params: { source: params.source as PluginSourceSpec } };
    }
    case 'plugin.remove': {
      expectKeys(params, ['packageName']);
      let packageName: string;
      try {
        packageName = parsePluginPackageName(params.packageName);
      } catch (error) {
        sourceInvalid(error);
      }
      return { op, spaceId, params: { packageName: packageName! } };
    }
    case 'plugin.toggle': {
      expectKeys(params, ['packageName', 'enabled']);
      let packageName: string;
      try {
        packageName = parsePluginPackageName(params.packageName);
      } catch (error) {
        sourceInvalid(error);
      }
      const enabled = expectBoolean(params.enabled);
      return { op, spaceId, params: { packageName: packageName!, enabled } };
    }
    case 'runtime.set': {
      expectKeys(params, ['version']);
      const version = expectString(params.version, 64);
      if (!isExactRuntimeVersion(version)) invalid('The runtime version must be an exact version.');
      return { op, spaceId, params: { version } };
    }
    case 'plugin.live.install': {
      expectKeys(params, ['source']);
      let normalized;
      try {
        normalized = parsePluginSource(params.source);
      } catch (error) {
        sourceInvalid(error);
      }
      // The child applies approvedBuilds through installBundle's
      // options.approvedBuilds, whose official semantics only approve keys
      // that are already pending in pnpm-workspace.yaml — pre-seeding new
      // allowBuilds entries is a Supervisor write that path B must not do.
      // A source carrying build approvals therefore cannot run live.
      if (normalized!.approvedBuilds.length > 0) {
        throw new ControlPublicError(
          'control/unsupported',
          'plugin.live.install cannot pre-approve build scripts: the running space\'s installBundle only approves ' +
          'build keys already pending in pnpm-workspace.yaml. Plan plugin.install instead, or run the live install ' +
          'first and approve the reported pending keys afterwards.',
        );
      }
      return { op, spaceId, params: { source: params.source as PluginSourceSpec } };
    }
    case 'plugin.live.update': {
      expectKeys(params, ['packageName', 'version']);
      let packageName: string;
      try {
        packageName = parsePluginPackageName(params.packageName);
      } catch (error) {
        sourceInvalid(error);
      }
      const version = expectString(params.version, 64);
      if (!isExactRuntimeVersion(version)) invalid('The plugin version must be an exact published version.');
      return { op, spaceId, params: { packageName: packageName!, version } };
    }
    case 'plugin.live.entry': {
      expectKeys(params, ['entryId', 'enabled']);
      const entryId = expectString(params.entryId, 128);
      if (/\s/.test(entryId)) invalid();
      const enabled = expectBoolean(params.enabled);
      return { op, spaceId, params: { entryId, enabled } };
    }
    case 'plugin.live.remove': {
      expectKeys(params, ['packageName']);
      let packageName: string;
      try {
        packageName = parsePluginPackageName(params.packageName);
      } catch (error) {
        sourceInvalid(error);
      }
      return { op, spaceId, params: { packageName: packageName! } };
    }
    default:
      invalid();
  }
}

/** Validate and normalize an `execute` request. Unknown keys are rejected. */
export function parseControlExecuteInput(value: unknown): ControlExecuteInput {
  const body = expectObject(value);
  expectKeys(body, ['planId', 'requestId']);
  const planId = expectString(body.planId, 256);
  if (!CONTROL_ID_RE.test(planId)) invalid();
  const requestId = expectString(body.requestId, 128);
  if (!CONTROL_ID_RE.test(requestId)) invalid();
  return { planId, requestId };
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function parseControlJobInput(value: unknown): { jobId: string } {
  const body = expectObject(value);
  expectKeys(body, ['jobId']);
  const jobId = expectString(body.jobId, 128);
  if (!JOB_ID_RE.test(jobId)) invalid();
  return { jobId };
}

const UI_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UI_REF_RE = /^e[1-9][0-9]{0,5}$/;
const UI_PATH_RE = /^\/[^\\]*$/;
const UI_KEY_NAMES = new Set([
  'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
]);

function expectUiSessionId(value: unknown): string {
  const id = expectString(value, 128);
  if (!UI_SESSION_RE.test(id)) invalid();
  return id;
}

function expectUiRef(value: unknown): string {
  const ref = expectString(value, 16);
  if (!UI_REF_RE.test(ref)) invalid('A ref must be an aria-ref from the latest snapshot (e.g. "e12").');
  return ref;
}

function expectUiPath(value: unknown): string {
  const path = expectString(value, 2048);
  // Only a same-root relative path: no scheme-relative "//", no backslashes,
  // no fragments (they cannot reach the page) and no credentials.
  if (!UI_PATH_RE.test(path) || path.startsWith('//') || path.includes('#')) {
    invalid('Navigation is limited to a relative path inside the space.');
  }
  return path;
}

function expectNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid();
  return value;
}

/** Validate and normalize a `ui.open` request. */
export function parseControlUiOpenInput(value: unknown): ControlUiOpenInput {
  const body = expectObject(value);
  expectKeys(body, ['spaceId']);
  const spaceId = expectString(body.spaceId, 64);
  if (!SPACE_ID_RE.test(spaceId)) invalid();
  return { spaceId };
}

/** Validate and normalize a `ui.snapshot` request. */
export function parseControlUiSnapshotInput(value: unknown): ControlUiSnapshotInput {
  const body = expectObject(value);
  expectKeys(body, ['uiSessionId'], ['formats', 'ref', 'maxBytes']);
  const uiSessionId = expectUiSessionId(body.uiSessionId);
  let formats: ControlUiSnapshotFormat[] | undefined;
  if (body.formats !== undefined) {
    if (!Array.isArray(body.formats) || body.formats.length === 0 || body.formats.length > 4) invalid();
    const seen: ControlUiSnapshotFormat[] = [];
    for (const item of body.formats) {
      const format = expectString(item, 16) as ControlUiSnapshotFormat;
      if (!CONTROL_UI_SNAPSHOT_FORMATS.includes(format)) invalid();
      if (!seen.includes(format)) seen.push(format);
    }
    formats = seen;
  }
  const ref = body.ref !== undefined ? expectUiRef(body.ref) : undefined;
  let maxBytes: number | undefined;
  if (body.maxBytes !== undefined) {
    if (typeof body.maxBytes !== 'number' || !Number.isSafeInteger(body.maxBytes) || body.maxBytes < 1024) invalid();
    maxBytes = Math.min(body.maxBytes, CONTROL_UI_HTML_MAX_BYTES);
  }
  return {
    uiSessionId,
    ...(formats !== undefined ? { formats } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  };
}

/** One act step: a closed discriminated union by `kind`. */
export function parseControlUiAct(value: unknown): ControlUiAct {
  const body = expectObject(value);
  const kind = expectString(body.kind, 16) as ControlUiActKind;
  if (!(CONTROL_UI_ACT_KINDS as readonly string[]).includes(kind)) invalid();
  switch (kind) {
    case 'click': {
      expectKeys(body, ['kind'], ['ref', 'x', 'y', 'button', 'clickCount']);
      const ref = body.ref !== undefined ? expectUiRef(body.ref) : undefined;
      let x: number | undefined;
      let y: number | undefined;
      if (body.x !== undefined || body.y !== undefined) {
        x = expectNumber(body.x, 0, CONTROL_UI_VIEWPORT.width);
        y = expectNumber(body.y, 0, CONTROL_UI_VIEWPORT.height);
      }
      if (!ref && x === undefined) invalid('A click requires a ref or an x/y pair.');
      if (ref && x !== undefined) invalid('A click takes either a ref or coordinates, not both.');
      const button = body.button !== undefined ? expectString(body.button, 8) as 'left' | 'right' : undefined;
      if (button !== undefined && button !== 'left' && button !== 'right') invalid();
      const clickCount = body.clickCount !== undefined
        ? expectNumber(body.clickCount, 1, 2) as 1 | 2
        : undefined;
      return {
        kind,
        ...(ref !== undefined ? { ref } : {}),
        ...(x !== undefined ? { x, y: y! } : {}),
        ...(button !== undefined ? { button } : {}),
        ...(clickCount !== undefined ? { clickCount } : {}),
      };
    }
    case 'type': {
      expectKeys(body, ['kind', 'ref', 'text']);
      const ref = expectUiRef(body.ref);
      if (typeof body.text !== 'string' ||
          Buffer.byteLength(body.text, 'utf8') > CONTROL_UI_TYPE_TEXT_MAX_BYTES) invalid();
      return { kind, ref, text: body.text };
    }
    case 'press': {
      expectKeys(body, ['kind', 'key'], ['ref']);
      const key = expectString(body.key, 32);
      if (!UI_KEY_NAMES.has(key) && key.length !== 1) invalid('That key is not in the allowed key list.');
      const ref = body.ref !== undefined ? expectUiRef(body.ref) : undefined;
      return { kind, key, ...(ref !== undefined ? { ref } : {}) };
    }
    case 'scroll': {
      expectKeys(body, ['kind', 'deltaY'], ['ref']);
      const deltaY = expectNumber(body.deltaY, -CONTROL_UI_SCROLL_MAX_DELTA, CONTROL_UI_SCROLL_MAX_DELTA);
      if (!Number.isInteger(deltaY) || deltaY === 0) invalid();
      const ref = body.ref !== undefined ? expectUiRef(body.ref) : undefined;
      return { kind, deltaY, ...(ref !== undefined ? { ref } : {}) };
    }
    case 'select': {
      expectKeys(body, ['kind', 'ref', 'value']);
      const ref = expectUiRef(body.ref);
      const option = expectString(body.value, 1024);
      return { kind, ref, value: option };
    }
    case 'hover': {
      expectKeys(body, ['kind', 'ref']);
      return { kind, ref: expectUiRef(body.ref) };
    }
    case 'navigate': {
      expectKeys(body, ['kind', 'path']);
      return { kind, path: expectUiPath(body.path) };
    }
    case 'wait': {
      expectKeys(body, ['kind', 'ms']);
      const ms = expectNumber(body.ms, 0, CONTROL_UI_WAIT_MAX_MS);
      if (!Number.isInteger(ms)) invalid();
      return { kind, ms };
    }
    default:
      invalid();
  }
}

/** Validate and normalize a `ui.act` request. */
export function parseControlUiActInput(value: unknown): ControlUiActInput {
  const body = expectObject(value);
  expectKeys(body, ['uiSessionId', 'requestId', 'act']);
  const uiSessionId = expectUiSessionId(body.uiSessionId);
  const requestId = expectString(body.requestId, 128);
  if (!CONTROL_ID_RE.test(requestId)) invalid();
  return { uiSessionId, requestId, act: parseControlUiAct(body.act) };
}

/** Validate and normalize a `ui.eval` request. */
export function parseControlUiEvalInput(value: unknown): ControlUiEvalInput {
  const body = expectObject(value);
  expectKeys(body, ['uiSessionId', 'requestId', 'script'], ['ref', 'timeoutMs']);
  const uiSessionId = expectUiSessionId(body.uiSessionId);
  const requestId = expectString(body.requestId, 128);
  if (!CONTROL_ID_RE.test(requestId)) invalid();
  if (typeof body.script !== 'string' || !body.script.trim() ||
      Buffer.byteLength(body.script, 'utf8') > CONTROL_UI_EVAL_SCRIPT_MAX_BYTES) invalid();
  const ref = body.ref !== undefined ? expectUiRef(body.ref) : undefined;
  let timeoutMs: number | undefined;
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== 'number' || !Number.isSafeInteger(body.timeoutMs) ||
        body.timeoutMs < 1 || body.timeoutMs > CONTROL_UI_EVAL_TIMEOUT_MAX_MS) invalid();
    timeoutMs = body.timeoutMs;
  }
  return {
    uiSessionId,
    requestId,
    script: body.script,
    ...(ref !== undefined ? { ref } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** Validate and normalize a `ui.close` request. */
export function parseControlUiCloseInput(value: unknown): ControlUiCloseInput {
  const body = expectObject(value);
  expectKeys(body, ['uiSessionId']);
  return { uiSessionId: expectUiSessionId(body.uiSessionId) };
}

/**
 * Validate an `import.preview` request: a base64 share archive. The closed
 * shape carries content only — local paths are never accepted.
 */
export function parseControlImportPreviewInput(value: unknown): ControlImportPreviewInput {
  const body = expectObject(value);
  expectKeys(body, ['archiveBase64']);
  const archiveBase64 = expectString(body.archiveBase64, MAX_WORKBENCH_SHARE_BASE64 + 64);
  return { archiveBase64 };
}

export function parseControlUnregisterInput(value: unknown): { registrationId: string } {
  const body = expectObject(value);
  expectKeys(body, ['registrationId']);
  const registrationId = expectString(body.registrationId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(registrationId)) invalid();
  return { registrationId };
}
