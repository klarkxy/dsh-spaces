/**
 * Browser-safe Creator (制作空间) channel contract. Scoped channel for the
 * trusted main-space identity: one space creation composition only, never
 * arbitrary management commands or arbitrary existing-space targets.
 * Jobs and durable records never carry file paths, tokens or credentials.
 */
import { isExactRuntimeVersion } from './runtime';
import { SPACE_NAME_RE } from './types';
import { PluginSourceError, parsePluginSource } from './plugin-source';
import type { ExactPluginSource as CreatorPlanPlugin } from './plugin-source';

// The closed exact plugin source moved to shared/plugin-source.ts so the
// Control channel and the maintenance `plugin.install.spec` plan parse the
// same shape. Re-exported here for source compatibility.
export {
  PluginSourceError,
  parsePluginSource,
  pluginSourceSpecOf,
  parseApprovedBuilds,
  parsePluginPackageName,
} from './plugin-source';
export type {
  PluginSourceNpm as CreatorNpmPlugin,
  PluginSourceGithub as CreatorGithubPlugin,
  PluginSourceSpec as CreatorPluginSpec,
  ExactPluginSource as CreatorPlanPlugin,
} from './plugin-source';

/** Wire prefix served by the Supervisor loopback entry. */
export const CREATOR_CHANNEL_PREFIX = '/internal/creator/v1/';

export const CREATOR_PROTOCOL_VERSION = 1 as const;

/** Internal operations. `issue`/`unregister` accept only the Host bearer; the
 *  business operations accept only the issued Creator scope token. */
export const CREATOR_OPS = [
  'issue',
  'unregister',
  'context',
  'createPreview',
  'createExecute',
  'job',
] as const;
export type CreatorOperation = (typeof CREATOR_OPS)[number];

export const CREATOR_ERROR = {
  'creator/invalid-input': 'The request is not a valid creator operation.',
  'creator/not-found': 'That item was not found.',
  'creator/conflict': 'A different main identity is already registered for this service epoch.',
  'creator/unregistered': 'The registration id does not match the active registration.',
  'creator/request-conflict': 'A job with this request id already exists for a different creator plan.',
  'creator/plan-expired': 'The preview expired. Request a new preview.',
  'creator/plan-consumed': 'The preview was already submitted.',
  'creator/read-only': 'The workbench is read-only until control is acquired.',
  'creator/unavailable': 'The workbench cannot accept this request.',
  'creator/unsupported': 'That command is not supported.',
  'creator/failed': 'The creator request failed.',
} as const;

export type CreatorErrorCode = keyof typeof CREATOR_ERROR;

export class CreatorPublicError extends Error {
  readonly name = 'CreatorPublicError';
  constructor(
    readonly code: CreatorErrorCode,
    message: string = CREATOR_ERROR[code],
  ) {
    super(message);
  }
}

export type CreatorModelSource = 'main' | 'local';

/** Normalized, validated creation input bound into a plan. */
export interface CreatorCreateSpec {
  /** User-facing name; the space id is `space-<name>`. */
  name: string;
  displayName?: string;
  icon?: string;
  /** Exact DSH base version; absent means the host CLI version. */
  baseVersion?: string;
  modelSource: CreatorModelSource;
  startAfterCreate: boolean;
  plugins: CreatorPlanPlugin[];
}

export type CreatorPlanStepKind =
  | 'prepare'
  | 'install-runtime'
  | 'create'
  | 'view-bridge'
  | 'models-sync'
  | 'plugin'
  | 'start'
  | 'result';

export interface CreatorPlanStep {
  step: CreatorPlanStepKind;
  packageName?: string;
}

/** Frozen creation preview. Single-use, TTL-bound, epoch/revision-bound. */
export interface CreatorPlan {
  id: string;
  kind: 'creator.create';
  serviceEpoch: string;
  stateRevision: string;
  expiresAt: string;
  fingerprint: string;
  input: CreatorCreateSpec;
  steps: CreatorPlanStep[];
}

export interface CreatorContext {
  protocolVersion: typeof CREATOR_PROTOCOL_VERSION;
  serviceEpoch: string;
  revision: string;
  writable: boolean;
  maintenance: boolean;
  /** A queued or running job occupies the single serialized job lane. */
  createBusy: boolean;
  dshVersion: string | null;
  modelSources: CreatorModelSource[];
}

export interface CreatorIssueInput {
  /** Caller-owned loopback identity endpoint; the supervisor challenges it. */
  origin: string;
  /** Bearer accepted by the caller's own /identity endpoint. */
  bearer: string;
  /** Canonical DSH Home the caller claims; must equal this Home. */
  home: string;
  /** Claimed main profile id (`web` or `desktop`). */
  profile: string;
}

/**
 * One main registration mints one scope per channel. `creator` is always
 * present; `control` is absent only when an older supervisor does not serve
 * the control channel at all. Scope strings are bearer credentials: they
 * never enter logs, job records, sessions or durable state.
 */
export interface CreatorIssueResult {
  registrationId: string;
  scopes: {
    creator?: string;
    control?: string;
  };
  serviceEpoch: string;
}

export interface CreatorUnregisterInput {
  registrationId: string;
}

const LOOPBACK_HTTP_RE = /^http:\/\/127\.0\.0\.1:\d+\/?$/;
const PROFILE_MAIN_RE = /^(web|desktop)$/;

function invalid(message: string = CREATOR_ERROR['creator/invalid-input']): never {
  throw new CreatorPublicError('creator/invalid-input', message);
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

/**
 * Validate one plugin source row, mapping the shared source validation to
 * this channel's closed error code.
 */
function parsePlugin(value: unknown): CreatorPlanPlugin {
  try {
    return parsePluginSource(value);
  } catch (error) {
    if (error instanceof PluginSourceError) invalid(error.message);
    throw error;
  }
}

/**
 * Validate and normalize a createPreview input. Unknown keys, unsafe specs,
 * ranges/tags, protected packages and duplicate package names are rejected.
 */
export function parseCreatorCreateSpec(value: unknown): CreatorCreateSpec {
  const body = expectObject(value);
  expectKeys(body, ['name'], ['displayName', 'icon', 'baseVersion', 'modelSource', 'startAfterCreate', 'plugins']);
  const name = expectString(body.name, 33);
  if (!SPACE_NAME_RE.test(name)) invalid();
  let displayName: string | undefined;
  if (body.displayName !== undefined) displayName = expectString(body.displayName, 120);
  let icon: string | undefined;
  if (body.icon !== undefined) icon = expectString(body.icon, 512);
  let baseVersion: string | undefined;
  if (body.baseVersion !== undefined) {
    const version = expectString(body.baseVersion, 64);
    if (!isExactRuntimeVersion(version)) invalid('The base version must be an exact installed version.');
    baseVersion = version;
  }
  let modelSource: CreatorModelSource = 'main';
  if (body.modelSource !== undefined) {
    if (body.modelSource !== 'main' && body.modelSource !== 'local') invalid();
    modelSource = body.modelSource;
  }
  let startAfterCreate = false;
  if (body.startAfterCreate !== undefined) {
    if (typeof body.startAfterCreate !== 'boolean') invalid();
    startAfterCreate = body.startAfterCreate;
  }
  const plugins: CreatorPlanPlugin[] = [];
  if (body.plugins !== undefined) {
    if (!Array.isArray(body.plugins) || body.plugins.length > 16) invalid();
    for (const row of body.plugins) {
      const plugin = parsePlugin(row);
      if (plugins.some((installed) => installed.packageName.toLowerCase() === plugin.packageName.toLowerCase())) {
        invalid(`Duplicate plugin package ${plugin.packageName}.`);
      }
      plugins.push(plugin);
    }
  }
  return {
    name,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(baseVersion !== undefined ? { baseVersion } : {}),
    modelSource,
    startAfterCreate,
    plugins,
  };
}

export function parseCreatorIssueInput(value: unknown): CreatorIssueInput {
  const body = expectObject(value);
  expectKeys(body, ['origin', 'bearer', 'home', 'profile']);
  const origin = expectString(body.origin, 64);
  if (!LOOPBACK_HTTP_RE.test(origin)) invalid('The identity endpoint must be a clean 127.0.0.1 origin.');
  const bearer = expectString(body.bearer, 256);
  if (!/^[a-f0-9]{64}$/.test(bearer)) invalid();
  const home = expectString(body.home, 1024);
  const profile = expectString(body.profile, 40);
  if (!PROFILE_MAIN_RE.test(profile)) invalid('The creator main identity must be the web or desktop profile.');
  return { origin: origin.replace(/\/$/, ''), bearer, home, profile };
}

export function parseCreatorUnregisterInput(value: unknown): CreatorUnregisterInput {
  const body = expectObject(value);
  expectKeys(body, ['registrationId']);
  const registrationId = expectString(body.registrationId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(registrationId)) invalid();
  return { registrationId };
}

export function parseCreatorExecuteInput(value: unknown): { planId: string; requestId: string } {
  const body = expectObject(value);
  expectKeys(body, ['planId', 'requestId']);
  const planId = expectString(body.planId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planId)) invalid();
  const requestId = expectString(body.requestId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)) invalid();
  return { planId, requestId };
}

export function parseCreatorJobInput(value: unknown): { jobId: string } {
  const body = expectObject(value);
  expectKeys(body, ['jobId']);
  const jobId = expectString(body.jobId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) invalid();
  return { jobId };
}
