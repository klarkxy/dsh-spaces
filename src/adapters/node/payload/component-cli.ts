import { lstatSync } from "../../../shared/node/filesystem";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { gte, satisfies, valid } from "semver";
import { isBareNpmPackageName } from "../../../shared/plugin";

const DSH_PEER = /^@deepseek-ai\/dsh(?:-|$)/;
// Official dsh-v0.2.1-alpha.4 introduced engines.dsh precedence over peers.
const DSH_ENGINE_REQUIREMENTS_VERSION = "0.2.1-alpha.4";

/** Evaluate a manifest for a target runtime, which need not be installed yet. */
export function unmetDshRequirements(manifest: unknown, version: string): Record<string, string> {
  if (!valid(version)) throw new Error(`Invalid DSH runtime version: ${version}.`);
  if (!isRecord(manifest)) throw new Error("Plugin manifest must be an object.");
  const ranges: Record<string, string> = {};
  let engine: string | undefined;
  if (gte(version, DSH_ENGINE_REQUIREMENTS_VERSION) && Object.hasOwn(manifest, "engines")) {
    if (!isRecord(manifest.engines)) throw new Error("Plugin manifest engines must be an object.");
    if (Object.hasOwn(manifest.engines, "dsh")) {
      if (typeof manifest.engines.dsh !== "string") throw new Error("Plugin manifest engines.dsh must be a string.");
      engine = manifest.engines.dsh;
    }
  }
  if (engine === undefined && Object.hasOwn(manifest, "peerDependencies")) {
    if (!isRecord(manifest.peerDependencies)) throw new Error("Plugin manifest has an invalid DSH peerDependencies declaration.");
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (typeof range !== "string") throw new Error(`Invalid plugin peer range for ${name}.`);
      if (DSH_PEER.test(name)) ranges[name] = range;
    }
  }
  const unmet: Record<string, string> = {};
  if (engine !== undefined) {
    if (!engine.trim() || !satisfies(version, engine, { includePrerelease: true })) unmet["engines.dsh"] = engine;
  } else {
    for (const [name, range] of Object.entries(ranges)) {
      if (unmetDshPeers(version, { [name]: range }).length) unmet[name] = range;
    }
  }
  if (Object.keys(unmet).length) {
    for (const field of ["name", "version"]) {
      if (!Object.hasOwn(manifest, field) || typeof manifest[field] !== "string" || !manifest[field].trim()) {
        throw new Error(`Plugin manifest ${field} must be a non-empty string when DSH requirements are unmet.`);
      }
    }
  }
  return unmet;
}

/** Keep each component's constraints separate; later packages cannot hide an earlier mismatch. */
export function unmetProfileDshRequirements(profileDir: string, version: string): string[] {
  const modules = join(profileDir, "node_modules", "@dsh-spaces");
  return ["plugin", "view-bridge", "llm-bridge", "browser"].flatMap(name => {
    const path = join(modules, name, "package.json");
    if (!existsSync(path)) return [];
    const manifest = readPluginManifest(path, `@dsh-spaces/${name}`);
    return Object.entries(unmetDshRequirements(manifest, version))
      .map(([dependency, range]) => `@dsh-spaces/${name} (${dependency}@${range})`);
  });
}

/** Peer ranges the current component build expects the host CLI release to satisfy. */
export function dshPeerRangesFromPackages(packageJsonPaths: readonly string[]): Record<string, string> {
  const ranges: Record<string, string> = {};
  for (const path of packageJsonPaths) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const peers = parsed && typeof parsed === "object"
      ? (parsed as { peerDependencies?: unknown }).peerDependencies
      : undefined;
    if (!peers || typeof peers !== "object") continue;
    for (const [name, range] of Object.entries(peers as Record<string, unknown>)) {
      if (!DSH_PEER.test(name)) continue;
      if (typeof range !== "string") throw new Error(`Invalid DSH peer range for ${name}.`);
      ranges[name] = range;
    }
  }
  return ranges;
}

/** Names and ranges the recorded CLI version does not satisfy. */
export function unmetDshPeers(version: string, ranges: Record<string, string>): string[] {
  const unmet: string[] = [];
  for (const [name, range] of Object.entries(ranges)) {
    let ok = false;
    try {
      const requirement = ["workspace:^", "workspace:~", "workspace:*"].includes(range) ? version : range;
      ok = requirement.trim() !== "" && satisfies(version, requirement, { includePrerelease: true });
    } catch {
      ok = false;
    }
    if (!ok) unmet.push(`${name}@${range}`);
  }
  return unmet;
}


/**
 * Installed third-party DSH requirements that do not accept this runtime.
 * A declared dependency counts when its bundle is disabled. An enabled bundle
 * counts without a dependency key. Official @deepseek-ai/* and Spaces
 * @dsh-spaces/* packages are outside this scan. A missing manifest imposes no
 * constraint. Manifest paths stay inside the profile node_modules tree.
 * Workspace tokens and prereleases use unmetDshPeers.
 */
export function unmetInstalledThirdPartyDshPeers(profileDir: string, version: string): string[] {
  const unmet: string[] = [];
  for (const name of installedThirdPartyNames(profileDir)) {
    const manifestPath = containedPackageManifest(profileDir, name);
    if (!existsSync(manifestPath)) continue;
    const manifest = readPluginManifest(manifestPath, name);
    for (const [dependency, range] of Object.entries(unmetDshRequirements(manifest, version))) {
      unmet.push(`${name} (${dependency}@${range})`);
    }
  }
  return unmet;
}

function installedThirdPartyNames(profileDir: string): string[] {
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw peerScanError();
  }
  if (!isRecord(parsed)) throw peerScanError();
  const dependencies = parsed.dependencies === undefined ? {} : parsed.dependencies;
  if (!isRecord(dependencies)) throw peerScanError();
  const names = new Set<string>();
  for (const name of [...Object.keys(dependencies), ...enabledBundleNames(parsed)]) {
    if (name.startsWith("@deepseek-ai/") || name.startsWith("@dsh-spaces/")) continue;
    if (!isBareNpmPackageName(name) || name.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`Installed plugin ${name} is not a package name, so its DSH peer declaration could not be checked.`);
    }
    names.add(name);
  }
  return [...names];
}

function enabledBundleNames(manifest: Record<string, unknown>): string[] {
  const dsh = manifest.dsh;
  if (dsh === undefined) return [];
  if (!isRecord(dsh)) throw peerScanError();
  const profile = dsh.profile;
  if (profile === undefined) return [];
  if (!isRecord(profile)) throw peerScanError();
  const bundles = profile.bundles;
  if (bundles === undefined) return [];
  if (!Array.isArray(bundles)) throw peerScanError();
  const names: string[] = [];
  for (const item of bundles) {
    if (typeof item !== "string") throw peerScanError();
    if (item.length > 0) names.push(item);
  }
  return names;
}

function containedPackageManifest(profileDir: string, packageName: string): string {
  const manifestPath = resolve(profileDir, "node_modules", ...packageName.split("/"), "package.json");
  const root = resolve(profileDir, "node_modules");
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const candidate = process.platform === "win32" ? manifestPath.toLowerCase() : manifestPath;
  const allowed = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  if (!candidate.startsWith(allowed)) {
    throw new Error(`Installed plugin ${packageName} is not a package name, so its DSH peer declaration could not be checked.`);
  }
  return manifestPath;
}

function readPluginManifest(manifestPath: string, packageName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Installed plugin ${packageName} manifest could not be read, so its DSH peer declaration was not checked.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Installed plugin ${packageName} manifest could not be read, so its DSH peer declaration was not checked.`);
  }
  return parsed;
}

function peerScanError(): Error {
  return new Error("The space profile manifest could not be read, so third-party plugin compatibility was not checked.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function cliLoadError(version: string, unmet: readonly string[]): string {
  return `Recorded CLI ${version} cannot load this component: ${unmet.join(", ")}.`;
}

/**
 * Regular component files shipped in one selected bridge. Extra installed
 * files are ignored. A top-level node_modules is never component content,
 * but lib/…/node_modules/… is: the supervisor's bundled UI engine lives
 * under lib/<component>/ui-engine/node_modules and must stay comparable.
 */
export function payloadBridgeFiles(payloadRoot: string, bridge: string): string[] {
  const root = join(payloadRoot, bridge);
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (rel === "node_modules") continue;
      const abs = join(dir, name);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (rel === "lib" || rel.startsWith("lib/")) walk(abs, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      if (rel === "package.json" || rel === "cordis.patch.yml" || rel.startsWith("lib/")) found.push(rel);
    }
  };
  walk(root, "");
  return found.sort();
}

/**
 * Component archives copied into hub/plugins. The 20 hex digits are the source
 * tarball sha256 prefix. `-r1` is the only alternate slot: pnpm `add` of a
 * `file:` spec that is already the dependency exits 0 and does not replace
 * drifted node_modules bytes. The installed dependency path therefore alternates
 * between `<digest>.tgz` and `<digest>-r1.tgz`. Compare installed content with
 * the selected component; do not require one exact archive path. Package name,
 * version, and source digest stay the same.
 */
const CANONICAL_ALIGNMENT_ARCHIVE_ID =
  /^dsh-spaces-(plugin|view-bridge|llm-bridge|browser)-[a-f0-9]{20}$/;

const ALIGNMENT_PACKAGE_NAMES = {
  plugin: "@dsh-spaces/plugin",
  "view-bridge": "@dsh-spaces/view-bridge",
  "llm-bridge": "@dsh-spaces/llm-bridge",
  browser: "@dsh-spaces/browser",
} as const;

export class AlignmentArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentArchiveError";
  }
}

/** One archive id for the single alignment add. Does not write or delete. */
export function alignmentArchiveId(profileDir: string, canonicalId: string, canonicalArchivePath: string): string {
  const match = CANONICAL_ALIGNMENT_ARCHIVE_ID.exec(canonicalId);
  if (!match) {
    throw new AlignmentArchiveError(`Unsupported alignment archive id ${canonicalId}.`);
  }
  const packageName = ALIGNMENT_PACKAGE_NAMES[match[1] as keyof typeof ALIGNMENT_PACKAGE_NAMES];
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) return canonicalId;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new AlignmentArchiveError("The space profile manifest could not be read, so the component was not installed.");
  }
  if (!isRecord(parsed)) {
    throw new AlignmentArchiveError("The space profile manifest could not be read, so the component was not installed.");
  }
  if (parsed.dependencies === undefined) return canonicalId;
  if (!isRecord(parsed.dependencies)) {
    throw new AlignmentArchiveError("The space profile manifest could not be read, so the component was not installed.");
  }
  if (!Object.prototype.hasOwnProperty.call(parsed.dependencies, packageName)) return canonicalId;
  const declared = parsed.dependencies[packageName];
  if (typeof declared !== "string") {
    throw new AlignmentArchiveError("The space profile manifest could not be read, so the component was not installed.");
  }
  const declaredPath = declaredFileCoordinate(declared, profileDir);
  // The declared coordinate already is the canonical archive, including a relative
  // file: spec from this profile. One alternate spec avoids the pnpm same-spec no-op.
  // A missing installed package manifest does not change that coordinate.
  // A dependency that already names the -r1 archive falls through and uses canonical.
  if (declaredPath && samePath(declaredPath, resolve(canonicalArchivePath))) return `${canonicalId}-r1`;
  return canonicalId;
}

function declaredFileCoordinate(spec: string, profileDir: string): string | undefined {
  const trimmed = spec.trim();
  const prefixed = trimmed.startsWith("file:");
  const body = prefixed ? trimmed.slice(5) : trimmed;
  if (!body || body.startsWith("//")) return undefined;
  if (isAbsolute(body)) return resolve(body);
  if (!prefixed) return undefined;
  return resolve(profileDir, body);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

