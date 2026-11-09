/**
 * Closed exact plugin source used by the Creator channel, the Control
 * channel's plugin.install op and the maintenance `plugin.install.spec`
 * plan. Exactly one of `npm` (package name + exact published version) or
 * `github` (owner/repo pinned to a full commit sha, optional subdirectory).
 * Protected packages and the Spaces manager package can never be installed
 * through these channels.
 *
 * Browser-safe: no file paths, tokens or credentials.
 */
import { isExactRuntimeVersion } from './runtime';
import { isFullSpacesManagerSpec, FULL_SPACES_PACKAGE } from './plugin-spec';
import { PROTECTED_PLUGIN_PACKAGES } from './types';

/** npm install spec: an exact published version, never a tag or range. */
export interface PluginSourceNpm {
  packageName: string;
  version: string;
  /** Exact pnpm `allowBuilds` keys whose build scripts the caller approved. */
  approvedBuilds?: string[];
}

/** GitHub install spec: owner/repo pinned to a full commit sha. */
export interface PluginSourceGithub {
  owner: string;
  repo: string;
  /** Exactly 40 lowercase hex characters. No branch, tag, or "latest". */
  commit: string;
  /** Optional package subdirectory inside the repository (safe relative path). */
  path?: string;
  /** Expected installed package.json name; the install is verified by read-back. */
  packageName: string;
  /** Exact pnpm `allowBuilds` keys whose build scripts the caller approved. */
  approvedBuilds?: string[];
}

/** Exactly one of `npm` or `github`; the wire shape callers send. */
export type PluginSourceSpec = { npm: PluginSourceNpm } | { github: PluginSourceGithub };

/** Normalized plugin row bound into a frozen plan. */
export type ExactPluginSource =
  | { kind: 'npm'; packageName: string; version: string; approvedBuilds: string[] }
  | {
      kind: 'github';
      owner: string;
      repo: string;
      commit: string;
      path?: string;
      packageName: string;
      approvedBuilds: string[];
    };

export class PluginSourceError extends Error {
  readonly name = 'PluginSourceError';
}

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GITHUB_COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_SUBDIR_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const PROTECTED = new Set<string>(PROTECTED_PLUGIN_PACKAGES);

function invalid(message = 'The plugin source is not a valid exact source.'): never {
  throw new PluginSourceError(message);
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
 * Exact `allowBuilds` keys the caller approves before install. pnpm matches
 * these against the package name (optionally name@version) — never a URL,
 * spec or wildcard — for both registry and git-hosted packages.
 */
const APPROVED_BUILD_KEY_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9][a-z0-9._~+-]*)?$/;
export function parseApprovedBuilds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) invalid();
  const out: string[] = [];
  for (const item of value) {
    const key = expectString(item, 256);
    if (!APPROVED_BUILD_KEY_RE.test(key)) invalid('Build approvals accept exact package names or name@version only.');
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * An npm package name that may be installed through a scoped channel:
 * protected bundles and the Spaces manager package are refused.
 */
export function parsePluginPackageName(value: unknown): string {
  const name = expectString(value, 214);
  if (!NPM_NAME_RE.test(name)) invalid();
  if (PROTECTED.has(name) || isFullSpacesManagerSpec(name) || name === FULL_SPACES_PACKAGE) {
    invalid('A protected plugin cannot be installed through this channel.');
  }
  return name;
}

function parseGithubPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = expectString(value, 200);
  if (raw !== raw.trim() || raw.startsWith('/') || raw.endsWith('/') || raw.includes('\\')) invalid();
  const segments = raw.split('/');
  if (!segments.length || segments.length > 8) invalid();
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !SAFE_SUBDIR_SEGMENT_RE.test(segment)) invalid();
  }
  return segments.join('/');
}

/**
 * Validate and normalize one closed exact source. Unknown keys, unsafe
 * specs, ranges/tags, short shas, unsafe subdirectories and protected
 * packages are rejected.
 */
export function parsePluginSource(value: unknown): ExactPluginSource {
  const body = expectObject(value);
  const hasNpm = Object.prototype.hasOwnProperty.call(body, 'npm');
  const hasGithub = Object.prototype.hasOwnProperty.call(body, 'github');
  if (hasNpm === hasGithub) invalid();
  if (hasNpm) {
    expectKeys(body, ['npm']);
    const npm = expectObject(body.npm);
    expectKeys(npm, ['packageName', 'version'], ['approvedBuilds']);
    const packageName = parsePluginPackageName(npm.packageName);
    const version = expectString(npm.version, 64);
    if (!isExactRuntimeVersion(version)) invalid('npm plugins require an exact published version.');
    return { kind: 'npm', packageName, version, approvedBuilds: parseApprovedBuilds(npm.approvedBuilds) };
  }
  expectKeys(body, ['github']);
  const github = expectObject(body.github);
  expectKeys(github, ['owner', 'repo', 'commit', 'packageName'], ['path', 'approvedBuilds']);
  const owner = expectString(github.owner, 39);
  if (!GITHUB_OWNER_RE.test(owner)) invalid();
  const repo = expectString(github.repo, 100);
  if (!GITHUB_REPO_RE.test(repo)) invalid();
  const commit = expectString(github.commit, 40);
  if (!GITHUB_COMMIT_RE.test(commit)) invalid('GitHub plugins require a full 40-character commit sha.');
  const path = parseGithubPath(github.path);
  const packageName = parsePluginPackageName(github.packageName);
  const approvedBuilds = parseApprovedBuilds(github.approvedBuilds);
  return { kind: 'github', owner, repo, commit, ...(path ? { path } : {}), packageName, approvedBuilds };
}

/** The source wire shape equivalent to a normalized row (lossless round-trip). */
export function pluginSourceSpecOf(plugin: ExactPluginSource): PluginSourceSpec {
  if (plugin.kind === 'npm') {
    return {
      npm: {
        packageName: plugin.packageName,
        version: plugin.version,
        ...(plugin.approvedBuilds.length ? { approvedBuilds: [...plugin.approvedBuilds] } : {}),
      },
    };
  }
  return {
    github: {
      owner: plugin.owner,
      repo: plugin.repo,
      commit: plugin.commit,
      ...(plugin.path !== undefined ? { path: plugin.path } : {}),
      packageName: plugin.packageName,
      ...(plugin.approvedBuilds.length ? { approvedBuilds: [...plugin.approvedBuilds] } : {}),
    },
  };
}
