import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isExactRuntimeVersion } from "../../shared/runtime";

const BASE_PKG = "@deepseek-ai/dsh-base";
const WEB_PKG = "@deepseek-ai/dsh-web-app";

export const OFFICIAL_BASE_PACKAGE = BASE_PKG;
export const OFFICIAL_WEB_PACKAGE = WEB_PKG;

export function resolveOfficialVersions(bin: string): { base: string; web: string } {
  if (!existsSync(bin)) throw new Error(`Candidate CLI binary is missing: ${bin}`);
  let realBin: string;
  try {
    realBin = realpathSync(bin);
  } catch {
    throw new Error(`Candidate CLI binary is not resolvable: ${bin}`);
  }
  const req = createRequire(realBin);
  return {
    base: requireInstalledVersion(req, BASE_PKG),
    web: requireInstalledVersion(req, WEB_PKG),
  };
}

function requireInstalledVersion(req: NodeRequire, name: string): string {
  let pkgPath: string;
  try {
    pkgPath = req.resolve(`${name}/package.json`);
  } catch {
    throw new Error(`Candidate CLI does not resolve installed ${name}`);
  }
  const pkg = readPkg(pkgPath);
  if (!pkg || pkg.name !== name || typeof pkg.version !== "string" || !isExactRuntimeVersion(pkg.version)) {
    throw new Error(`Candidate CLI resolved ${name} without an exact installed version`);
  }
  return pkg.version;
}

function readPkg(path: string): { name?: unknown; version?: unknown; dependencies?: unknown; dsh?: unknown } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown;
      version?: unknown;
      dependencies?: unknown;
      dsh?: unknown;
    };
  } catch {
    return undefined;
  }
}

/** Which official base plugins a profile actually declares (deps or dsh.profile.bundles). */
export function usedOfficial(profileDir: string): { base: boolean; web: boolean } {
  const pkg = readPkg(join(profileDir, "package.json"));
  const deps = pkg?.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies as object) : [];
  const bundles = bundlesOf(pkg);
  const names = new Set([...deps, ...bundles]);
  return { base: names.has(BASE_PKG), web: names.has(WEB_PKG) };
}

function bundlesOf(pkg: { dsh?: unknown } | undefined): string[] {
  const dsh = pkg?.dsh;
  if (!dsh || typeof dsh !== "object") return [];
  const profile = (dsh as { profile?: { bundles?: unknown } }).profile;
  if (!profile || !Array.isArray(profile.bundles)) return [];
  return profile.bundles.filter((item): item is string => typeof item === "string");
}

/** Exact installed version of a package inside a profile's node_modules. */
export function packageVersionAt(profileDir: string, name: string): string | undefined {
  const pkg = readPkg(join(profileDir, "node_modules", ...name.split("/"), "package.json"));
  if (!pkg || pkg.name !== name || typeof pkg.version !== "string") return undefined;
  return isExactRuntimeVersion(pkg.version) ? pkg.version : undefined;
}
