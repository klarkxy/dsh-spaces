import { SNAPSHOT_ID_RE } from "../shared/snapshots";

export const PLUGIN_RESTORE_POINT_SCHEMA = 1 as const;

export const PLUGIN_RESTORE_EXCLUSIONS = {
  sessions: true,
  storages: true,
  otherSpaces: true,
  credentials: true,
  runtime: true,
  unmanagedPluginWrites: true,
} as const;

export type PluginRestoreBoundary = "independent-per-space" | "shared-deps-require-pause";

export type PluginRestoreAction = "install" | "uninstall";

export type PluginRestorePathKind = "file" | "dir" | "link";

export type PluginRestorePathRole = "lock" | "manifest" | "dependency" | "link" | "config" | "other";

export type PluginRestoreRoot = "home" | "store";

export type PluginRestoreExclusions = typeof PLUGIN_RESTORE_EXCLUSIONS;

export interface PluginRestorePath {
  root: PluginRestoreRoot;
  rel: string;
  kind: PluginRestorePathKind;
  role: PluginRestorePathRole;
  shared: boolean;
}

export interface PluginRestorePointRecord {
  schemaVersion: typeof PLUGIN_RESTORE_POINT_SCHEMA;
  id: string;
  createdAt: string;
  spaceId: string;
  packageName: string;
  requestedSpec: string;
  resolvedVersion: string;
  action: PluginRestoreAction;
  boundary: PluginRestoreBoundary;
  linkPreservingCopySufficient: boolean;
  paths: PluginRestorePath[];
  sharedReferencers: string[];
  contentDigest: string;
  excluded: PluginRestoreExclusions;
}

export interface PluginRestorePointInput {
  id: string;
  createdAt?: string;
  spaceId: string;
  packageName: string;
  requestedSpec: string;
  resolvedVersion: string;
  action: PluginRestoreAction;
  boundary: PluginRestoreBoundary;
  linkPreservingCopySufficient: boolean;
  paths: PluginRestorePath[];
  sharedReferencers?: string[];
  contentDigest: string;
}

const ROOTS = new Set<PluginRestoreRoot>(["home", "store"]);
const KINDS = new Set<PluginRestorePathKind>(["file", "dir", "link"]);
const ROLES = new Set<PluginRestorePathRole>(["lock", "manifest", "dependency", "link", "config", "other"]);
const BOUNDARIES = new Set<PluginRestoreBoundary>(["independent-per-space", "shared-deps-require-pause"]);
const ACTIONS = new Set<PluginRestoreAction>(["install", "uninstall"]);
const SPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const EXCLUDED_REL_RE =
  /(^|\/)(sessions|storages)(\/|$)|(^|\/)\.credentials\.yaml$|(^|\/)\.anonymous-user-id$/i;

export function toPosixRel(rel: string): string {
  return rel.replaceAll("\\", "/");
}

export function assertRestoreRel(rel: string): string {
  const normalized = toPosixRel(rel).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`restore path is invalid: ${rel}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`restore path is invalid: ${rel}`);
  }
  return normalized;
}

export function classifyRestorePath(
  rel: string,
  kind: PluginRestorePathKind,
  root: PluginRestoreRoot = "home",
): { role: PluginRestorePathRole; shared: boolean; excluded: boolean } {
  const posix = assertRestoreRel(rel);
  const excluded = root === "home" && EXCLUDED_REL_RE.test(posix);
  const base = posix.split("/").pop() ?? posix;
  let role: PluginRestorePathRole = "other";
  if (kind === "link" || posix === "profiles/node_modules" || posix.startsWith("profiles/node_modules/")) {
    role = "link";
  } else if (
    base === "pnpm-lock.yaml" ||
    base === "pnpm-lock.yml" ||
    base === "pnpm-workspace.yaml" ||
    base === ".modules.yaml" ||
    base === "package-lock.json"
  ) {
    role = "lock";
  } else if (base === "package.json") {
    role = "manifest";
  } else if (base === "cordis.patch.yml" || base === "cordis.yml") {
    role = "config";
  } else if (root === "store" || posix.includes("/node_modules/") || posix.endsWith("/node_modules") || posix.startsWith("node_modules/")) {
    role = "dependency";
  }
  const shared =
    root === "store" ||
    posix === "profiles/node_modules" ||
    posix.startsWith("profiles/node_modules/");
  return { role, shared, excluded };
}

export function buildPluginRestorePoint(input: PluginRestorePointInput): PluginRestorePointRecord {
  const paths = input.paths
    .map((path) => normalizePath(path))
    .filter((path) => !classifyRestorePath(path.rel, path.kind, path.root).excluded);
  if (paths.length === 0) {
    throw new Error("restore point has no install-environment paths");
  }
  const record: PluginRestorePointRecord = {
    schemaVersion: PLUGIN_RESTORE_POINT_SCHEMA,
    id: input.id,
    createdAt: input.createdAt ?? new Date().toISOString(),
    spaceId: input.spaceId,
    packageName: input.packageName,
    requestedSpec: input.requestedSpec,
    resolvedVersion: input.resolvedVersion,
    action: input.action,
    boundary: input.boundary,
    linkPreservingCopySufficient: input.linkPreservingCopySufficient,
    paths,
    sharedReferencers: [...new Set(input.sharedReferencers ?? [])].sort(),
    contentDigest: input.contentDigest,
    excluded: { ...PLUGIN_RESTORE_EXCLUSIONS },
  };
  return parsePluginRestorePoint(record);
}

export function serializePluginRestorePoint(record: PluginRestorePointRecord): string {
  const parsed = parsePluginRestorePoint(record);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function parsePluginRestorePoint(raw: string | unknown): PluginRestorePointRecord {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)) throw new Error("restore point is not an object");
  if (value.schemaVersion !== PLUGIN_RESTORE_POINT_SCHEMA) {
    throw new Error("restore point schema is not supported");
  }
  if (typeof value.id !== "string" || !SNAPSHOT_ID_RE.test(value.id)) {
    throw new Error("restore point id is invalid");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("restore point createdAt is invalid");
  }
  if (typeof value.spaceId !== "string" || !SPACE_ID_RE.test(value.spaceId)) {
    throw new Error("restore point spaceId is invalid");
  }
  if (typeof value.packageName !== "string" || !PACKAGE_NAME_RE.test(value.packageName)) {
    throw new Error("restore point packageName is invalid");
  }
  if (typeof value.requestedSpec !== "string" || value.requestedSpec.length === 0 || value.requestedSpec.length > 400) {
    throw new Error("restore point requestedSpec is invalid");
  }
  if (typeof value.resolvedVersion !== "string" || value.resolvedVersion.length === 0 || value.resolvedVersion.length > 64) {
    throw new Error("restore point resolvedVersion is invalid");
  }
  if (typeof value.action !== "string" || !ACTIONS.has(value.action as PluginRestoreAction)) {
    throw new Error("restore point action is invalid");
  }
  if (typeof value.boundary !== "string" || !BOUNDARIES.has(value.boundary as PluginRestoreBoundary)) {
    throw new Error("restore point boundary is invalid");
  }
  if (value.linkPreservingCopySufficient !== true && value.linkPreservingCopySufficient !== false) {
    throw new Error("restore point linkPreservingCopySufficient is invalid");
  }
  if (typeof value.contentDigest !== "string" || !DIGEST_RE.test(value.contentDigest)) {
    throw new Error("restore point contentDigest is invalid");
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0) {
    throw new Error("restore point paths are missing");
  }
  const paths = value.paths.map((path, index) => {
    if (!isRecord(path)) throw new Error(`restore point path ${index} is invalid`);
    return normalizePath(path);
  });
  if (paths.some((path) => classifyRestorePath(path.rel, path.kind, path.root).excluded)) {
    throw new Error("restore point must not include sessions, storages, credentials, or machine identity");
  }
  const referencers = Array.isArray(value.sharedReferencers) ? value.sharedReferencers : [];
  if (referencers.some((name) => typeof name !== "string" || !SPACE_ID_RE.test(name))) {
    throw new Error("restore point sharedReferencers are invalid");
  }
  const excluded = parseExclusions(value.excluded);
  return {
    schemaVersion: PLUGIN_RESTORE_POINT_SCHEMA,
    id: value.id,
    createdAt: value.createdAt,
    spaceId: value.spaceId,
    packageName: value.packageName,
    requestedSpec: value.requestedSpec,
    resolvedVersion: value.resolvedVersion,
    action: value.action as PluginRestoreAction,
    boundary: value.boundary as PluginRestoreBoundary,
    linkPreservingCopySufficient: value.linkPreservingCopySufficient,
    paths,
    sharedReferencers: [...new Set(referencers)].sort(),
    contentDigest: value.contentDigest,
    excluded,
  };
}

function normalizePath(path: Record<string, unknown> | PluginRestorePath): PluginRestorePath {
  if (!isRecord(path)) throw new Error("restore path is invalid");
  if (typeof path.root !== "string" || !ROOTS.has(path.root as PluginRestoreRoot)) {
    throw new Error("restore path root is invalid");
  }
  if (typeof path.rel !== "string") throw new Error("restore path rel is invalid");
  if (typeof path.kind !== "string" || !KINDS.has(path.kind as PluginRestorePathKind)) {
    throw new Error("restore path kind is invalid");
  }
  const rel = assertRestoreRel(path.rel);
  const classified = classifyRestorePath(rel, path.kind as PluginRestorePathKind, path.root as PluginRestoreRoot);
  const role =
    typeof path.role === "string" && ROLES.has(path.role as PluginRestorePathRole)
      ? (path.role as PluginRestorePathRole)
      : classified.role;
  if (!ROLES.has(role)) throw new Error("restore path role is invalid");
  const shared = path.shared === undefined ? classified.shared : path.shared === true;
  return {
    root: path.root as PluginRestoreRoot,
    rel,
    kind: path.kind as PluginRestorePathKind,
    role,
    shared,
  };
}

function parseExclusions(value: unknown): PluginRestoreExclusions {
  if (!isRecord(value)) throw new Error("restore point exclusions are invalid");
  for (const key of Object.keys(PLUGIN_RESTORE_EXCLUSIONS) as (keyof PluginRestoreExclusions)[]) {
    if (value[key] !== true) {
      throw new Error(`ordinary restore must exclude ${key}`);
    }
  }
  return { ...PLUGIN_RESTORE_EXCLUSIONS };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("restore point is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
