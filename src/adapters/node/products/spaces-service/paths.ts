import { lstatSync, realpathSync } from "../../../../shared/node/filesystem";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isExpectedIsolationRoot } from "../../profile/patch-writer";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import { DISPLAY_NAME_MAX, SpacesPublicError } from "./public-errors";

const DSH_HOME_PATH_RE = /^dshHomePath\(\s*(['"])([^'"]+)\1\s*\)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function profileDirFromBaseUrl(baseUrl: string | undefined): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  try {
    const asUrl = baseUrl.includes("://") ? fileURLToPath(baseUrl) : resolve(baseUrl);
    const resolved = resolve(asUrl);
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return null;
  }
}

export function sameContainedPath(expected: string, actual: string, home: string): boolean {
  try {
    const left = existsSync(expected) ? realpathSync(expected) : resolve(expected);
    const right = existsSync(actual) ? realpathSync(actual) : resolve(actual);
    if (!inside(home, left) || !inside(home, right)) return false;
    return samePath(left, right);
  } catch {
    return false;
  }
}

export function assertLexicalInside(root: string, target: string): void {
  if (!inside(root, resolve(target))) throw new SpacesPublicError("spaces/invalid-input");
}

export function inside(root: string, target: string): boolean {
  const r = comparablePath(root);
  const t = comparablePath(target);
  if (samePath(r, t)) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string): boolean { return comparablePath(a) === comparablePath(b); }

export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function canonicalExisting(root: string, target: string): string | null {
  try {
    const resolved = resolve(target);
    if (!inside(root, resolved) && !samePath(root, resolved)) return null;
    if (!lexists(resolved)) return null;
    const real = realpathSync(resolved);
    if (!inside(root, real) && !samePath(root, real)) return null;
    return real;
  } catch {
    return null;
  }
}

export function projectedInside(root: string, target: string): boolean {
  try {
    const resolved = resolve(target);
    if (!inside(root, resolved)) return false;
    let current = resolved;
    while (!lexists(current)) {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    const realAncestor = realpathSync(current);
    if (!inside(root, realAncestor) && !samePath(root, realAncestor)) return false;
    const suffix = resolved.slice(resolve(current).length);
    const projected = join(realAncestor, suffix.replace(/^[\\/]/, ""));
    return inside(root, projected) || samePath(root, projected);
  } catch {
    return false;
  }
}

export function formatLiveRoot(root: unknown): string | null {
  if (typeof root === "string") {
    if (root.startsWith("!!js ")) return root;
    if (DSH_HOME_PATH_RE.test(root.trim())) return `!!js ${root.trim()}`;
    return JSON.stringify(root);
  }
  if (root && typeof root === "object" && "__jsExpr" in root && typeof (root as { __jsExpr: unknown }).__jsExpr === "string") {
    return `!!js ${(root as { __jsExpr: string }).__jsExpr}`;
  }
  return null;
}

export function isDefaultIsolationRoot(actual: string, kind: "sessions" | "storages", home: string | null): boolean {
  if (actual.startsWith("!!js ")) {
    const match = actual.slice(5).trim().match(DSH_HOME_PATH_RE);
    return match?.[2] === kind;
  }
  if (!home) return false;
  try {
    const path = actual.startsWith('"') ? (JSON.parse(actual) as string) : actual;
    return samePath(path, join(home, kind));
  } catch {
    return false;
  }
}

export function matchesIsolation(
  actual: string,
  name: string,
  kind: "sessions" | "storages",
  home: string | null,
): boolean {
  if (isExpectedIsolationRoot(actual, name, kind)) return true;
  if (!home) return false;
  try {
    const path = actual.startsWith('"') ? (JSON.parse(actual) as string) : actual;
    return samePath(path, join(home, "hub", name, kind));
  } catch {
    return false;
  }
}

export function publicPluginName(name: string): string | null {
  if (!/^(@[a-z0-9-~._]+\/)?[a-z0-9-~._]+$/i.test(name)) return null;
  if (name.includes("..") || name.includes("\\") || name.includes(":")) return null;
  return name;
}

export function publicPluginVersion(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  if (/[\\/]|file:|git\+|github:|:\/\/|token|password|login/i.test(spec)) return null;
  return isExactRuntimeVersion(spec) ? spec : null;
}

export function safeDisplayName(value: string, fallback: string): string {
  const text = value.trim();
  if (!text || text.length > DISPLAY_NAME_MAX || /[\u0000-\u001f\\/]/.test(text)) return fallback;
  return text;
}

function isIsoTimestamp(value: string): boolean {
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function readSnapshotManifest(
  raw: string,
  id: string,
  home: string,
  spaceId: string,
): { id: string; createdAt: string; runtimeVersion: string | null } | null {
  try {
    const parsed = JSON.parse(raw) as {
      id?: unknown;
      createdAt?: unknown;
      runtimeVersion?: unknown;
      home?: unknown;
      profiles?: unknown;
    };
    if (typeof parsed.home !== "string" || !samePath(parsed.home, home)) return null;
    if (!Array.isArray(parsed.profiles) || !parsed.profiles.includes(spaceId)) return null;
    if (typeof parsed.createdAt !== "string" || !isIsoTimestamp(parsed.createdAt)) return null;
    const runtimeVersion =
      typeof parsed.runtimeVersion === "string" && isExactRuntimeVersion(parsed.runtimeVersion)
        ? parsed.runtimeVersion
        : null;
    return { id, createdAt: parsed.createdAt, runtimeVersion };
  } catch {
    return null;
  }
}
