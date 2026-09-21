import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNotRealHome, isInsideRealHome } from "./home-guard";
import { isBareNpmPackageName } from "../../shared/plugin";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../shared/types";

export type BlueprintRuntimeOptions = { home: string; bin: string };

export type BlueprintRuntimeVersions = {
  dsh: string | null;
  base: string | null;
  webApp: string | null;
};

export type BlueprintRuntimeLayer = {
  name: string;
  version: string;
  packageDir: string;
  patchPath: string;
  patches: unknown[];
};

export type BlueprintRuntimeInspect = {
  versions: BlueprintRuntimeVersions;
  baseLayers: BlueprintRuntimeLayer[];
  baseEntries: unknown[];
  homePatches: unknown[];
  fingerprint: string;
};

export type BlueprintRuntimeComposeInput = {
  spaceId: string;
  bundles: string[];
  patch: unknown[];
};

export type BlueprintRuntimeCompose = {
  versions: BlueprintRuntimeVersions;
  layers: BlueprintRuntimeLayer[];
  entries: unknown[];
  warnings: string[];
  fingerprint: string;
};

export type BlueprintRuntimeModuleInput = {
  spaceId: string;
  specifier: string;
};

export type BlueprintRuntimeModule = {
  packageName: string;
  packageVersion: string | null;
  resolvedPath: string | null;
  builtin: boolean;
};

export type BlueprintRuntimeErrorCode =
  | "invalid-home"
  | "invalid-bin"
  | "invalid-space"
  | "runtime-unsupported"
  | "bundle-unresolved"
  | "bundle-patch-missing"
  | "bundle-patch-invalid"
  | "bundle-patch-escape"
  | "home-patch-invalid"
  | "module-invalid"
  | "module-unresolved"
  | "builtin-unsupported"
  | "observation-changed"
  | "utf8-invalid"
  | "manifest-invalid";

const ERROR_MESSAGE: Record<BlueprintRuntimeErrorCode, string> = {
  "invalid-home": "Blueprint runtime Home is invalid.",
  "invalid-bin": "Blueprint runtime bin is invalid.",
  "invalid-space": "Blueprint runtime space is invalid.",
  "runtime-unsupported": "Blueprint runtime is missing required official capabilities.",
  "bundle-unresolved": "Blueprint runtime bundle could not be resolved.",
  "bundle-patch-missing": "Blueprint runtime bundle patch is missing.",
  "bundle-patch-invalid": "Blueprint runtime bundle patch is invalid.",
  "bundle-patch-escape": "Blueprint runtime bundle patch is outside its package.",
  "home-patch-invalid": "Blueprint runtime Home patch is unreadable.",
  "module-invalid": "Blueprint runtime module specifier is invalid.",
  "module-unresolved": "Blueprint runtime module could not be resolved.",
  "builtin-unsupported": "Blueprint runtime does not provide that cordis builtin.",
  "observation-changed": "Blueprint runtime files changed during inspection.",
  "utf8-invalid": "Blueprint runtime evidence is not valid UTF-8.",
  "manifest-invalid": "Blueprint runtime package manifest is invalid.",
};

const HOST_BASE = "@deepseek-ai/dsh-base";
const HOST_WEB_APP = "@deepseek-ai/dsh-web-app";
const BIN_NAME = "dsh";
const RESERVED_SPACES = new Set<string>(RESERVED_PROFILE_NAMES);
const CORDIS_BUILTINS: Record<string, string> = {
  group: "@deepseek-ai/cordis-plugin-group",
  include: "@deepseek-ai/cordis-plugin-include",
};

type ResolveExports = (
  pkg: { name: string; exports?: unknown },
  entry?: string,
  options?: { conditions?: string[]; require?: boolean; browser?: boolean; unsafe?: boolean },
) => string[] | undefined;

type AppBootModule = {
  resolveBundleDir: (binName: string, packageName: string, installAnchor: string, profileDir: string) => string;
  loadProfileDirectory: unknown;
  loadOptionalPatches: (binName: string, file: string) => unknown[] | undefined;
  loadOverlayPatches: (binName: string, file: string) => unknown[];
  composeEntries: (layers: unknown[][], warn?: (message: string) => void) => unknown[];
  mountRootInclude: unknown;
  PROFILE_TEMPLATES: { web?: { bundles?: unknown } };
  PROFILE_PATCH_FILENAME: string;
  PROFILES_DIR: string;
};

type BoundRuntime = {
  home: string;
  bin: string;
  installAnchor: string;
  appBootPath: string;
  appBootManifestPath: string;
  appBoot: AppBootModule;
  resolveExports: ResolveExports;
  requireFromBoot: NodeRequire;
};

type ObservedFile = { status: "absent" | "present"; hash: string };

class Observation {
  private readonly files = new Map<string, ObservedFile>();
  private readonly logical = new Map<string, string>();

  observe(logical: string, path: string, optional: boolean, missing: BlueprintRuntimeErrorCode): Buffer | undefined {
    const resolved = resolve(path);
    assertNotRealHomePath(resolved, missing);
    let bytes: Buffer | undefined;
    try {
      bytes = readFileSync(resolved);
    } catch (error) {
      if (isEnoent(error)) {
        if (!optional) throw runtimeError(missing);
        this.record(logical, resolved, { status: "absent", hash: "" });
        return undefined;
      }
      throw runtimeError(missing);
    }
    this.record(logical, resolved, { status: "present", hash: sha256Hex(bytes) });
    return bytes;
  }

  fingerprint(): string {
    const lines = [...this.logical.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([logical, path]) => {
        const row = this.files.get(path);
        if (!row) return `${logical}:ABSENT`;
        return row.status === "absent" ? `${logical}:ABSENT` : `${logical}:PRESENT:${row.hash}`;
      });
    return sha256Hex(Buffer.from(lines.join("\n"), "utf8"));
  }

  assertStable(): void {
    for (const [path, previous] of this.files) {
      const current = snapshotPath(path);
      if (current.status !== previous.status || current.hash !== previous.hash) {
        throw runtimeError("observation-changed");
      }
    }
  }

  private record(logical: string, path: string, row: ObservedFile): void {
    const existingLogical = this.logical.get(logical);
    if (existingLogical && existingLogical !== path) throw runtimeError("observation-changed");
    const existing = this.files.get(path);
    if (existing && (existing.status !== row.status || existing.hash !== row.hash)) {
      throw runtimeError("observation-changed");
    }
    this.logical.set(logical, path);
    this.files.set(path, row);
  }
}

export class BlueprintRuntimeError extends Error {
  readonly code: BlueprintRuntimeErrorCode;

  constructor(code: BlueprintRuntimeErrorCode, message: string) {
    super(message);
    this.name = "BlueprintRuntimeError";
    this.code = code;
  }
}

/**
 * Read-only evidence of the bound DSH runtime and Home overlay.
 * Does not initialize profiles, boot the Loader, or import user plugins.
 * cordis:group / cordis:include are capability evidence only; the caller still
 * decides whether a config that names them is safe to apply.
 */
export async function inspectBlueprintRuntime(
  options: BlueprintRuntimeOptions,
): Promise<BlueprintRuntimeInspect> {
  const bound = await bindRuntime(options);
  const observation = new Observation();
  observeRuntimeFiles(observation, bound);
  const profileDir = bound.home;
  const versions = readHostVersions(bound, observation, profileDir);
  const bundles = webTemplateBundles(bound.appBoot);
  const baseLayers: BlueprintRuntimeLayer[] = [];
  for (const [index, packageName] of bundles.entries()) {
    baseLayers.push(readBundleLayer(bound, observation, profileDir, packageName, index));
  }
  const homePatches = readHomePatches(bound, observation);
  const entries = bound.appBoot.composeEntries(
    baseLayers.map((layer) => layer.patches),
    () => {},
  );
  observation.assertStable();
  return {
    versions: mergeLayerVersions(versions, baseLayers),
    baseLayers,
    baseEntries: entries,
    homePatches,
    fingerprint: observation.fingerprint(),
  };
}

/**
 * Compose requested bundle patches, the supplied profile patch, and the actual
 * Home overlay with official composeEntries. Does not write the target profile.
 */
export async function composeBlueprintRuntime(
  options: BlueprintRuntimeOptions,
  input: BlueprintRuntimeComposeInput,
): Promise<BlueprintRuntimeCompose> {
  const bound = await bindRuntime(options);
  const spaceId = requireSpaceId(input?.spaceId);
  const bundles = requireBundleNames(input?.bundles);
  const supplied = requirePatchList(input?.patch);
  const observation = new Observation();
  observeRuntimeFiles(observation, bound);
  const profileDir = requireProfileDir(bound, spaceId, observation);
  const versions = readHostVersions(bound, observation, profileDir);
  const layers: BlueprintRuntimeLayer[] = [];
  for (const [index, packageName] of bundles.entries()) {
    layers.push(readBundleLayer(bound, observation, profileDir, packageName, index));
  }
  const homePatches = readHomePatches(bound, observation);
  const warnings: string[] = [];
  let entries: unknown[];
  try {
    entries = bound.appBoot.composeEntries(
      [...layers.map((layer) => layer.patches), structuredClone(supplied), homePatches],
      (message) => {
        warnings.push(message);
      },
    );
  } catch {
    throw runtimeError("bundle-patch-invalid");
  }
  observation.assertStable();
  return {
    versions: mergeLayerVersions(versions, layers),
    layers,
    entries,
    warnings,
    fingerprint: observation.fingerprint(),
  };
}

/**
 * Resolve a package specifier or supported cordis builtin against the bound
 * runtime and target profile without importing or executing the module.
 */
export async function resolveBlueprintModule(
  options: BlueprintRuntimeOptions,
  input: BlueprintRuntimeModuleInput,
): Promise<BlueprintRuntimeModule> {
  const bound = await bindRuntime(options);
  const spaceId = requireSpaceId(input?.spaceId);
  const specifier = requireSpecifier(input?.specifier);
  const observation = new Observation();
  observeRuntimeFiles(observation, bound);
  const profileDir = requireProfileDir(bound, spaceId, observation);
  const builtin = resolveCordisBuiltin(bound, observation, profileDir, specifier);
  if (builtin) {
    observation.assertStable();
    return builtin;
  }
  const parsed = parsePackageSpecifier(specifier);
  const packageDir = resolvePackageDir(bound, parsed.packageName, profileDir, "module-unresolved");
  const manifestPath = join(packageDir, "package.json");
  const manifestBytes = observation.observe(
    `package/${parsed.packageName}/manifest`,
    manifestPath,
    false,
    "manifest-invalid",
  );
  const manifest = parseManifest(manifestBytes);
  const version = typeof manifest.version === "string" ? manifest.version : null;
  const resolvedPath = resolveExportPath(
    bound,
    packageDir,
    parsed.packageName,
    manifest,
    parsed.subpath,
    observation,
  );
  observation.assertStable();
  return {
    packageName: typeof manifest.name === "string" ? manifest.name : parsed.packageName,
    packageVersion: version,
    resolvedPath,
    builtin: false,
  };
}

async function bindRuntime(options: BlueprintRuntimeOptions): Promise<BoundRuntime> {
  if (!options || typeof options.home !== "string") throw runtimeError("invalid-home");
  if (typeof options.bin !== "string") throw runtimeError("invalid-bin");
  const home = requireSandboxHome(options.home);
  const bin = requireBinFile(options.bin);
  const installAnchor = requireInstallAnchor(bin);
  let appBootPath: string;
  try {
    appBootPath = createRequire(bin).resolve("@deepseek-ai/dsh-app-boot");
  } catch {
    throw runtimeError("runtime-unsupported");
  }
  assertNotRealHomePath(appBootPath, "runtime-unsupported");
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(appBootPath).href);
  } catch {
    throw runtimeError("runtime-unsupported");
  }
  const appBoot = requireAppBoot(imported);
  const appBootManifestPath = join(dirname(appBootPath), "..", "package.json");
  const requireFromBoot = createRequire(appBootPath);
  let resolveExports: ResolveExports;
  try {
    const resolved = requireFromBoot.resolve("resolve.exports");
    const namespace = await import(pathToFileURL(resolved).href) as {
      resolve?: ResolveExports;
      default?: { resolve?: ResolveExports };
    };
    const fn = namespace.resolve ?? namespace.default?.resolve;
    if (typeof fn !== "function") throw new Error("missing");
    resolveExports = fn;
  } catch {
    throw runtimeError("runtime-unsupported");
  }
  return {
    home,
    bin,
    installAnchor,
    appBootPath,
    appBootManifestPath: existsAsFile(appBootManifestPath) ? resolve(appBootManifestPath) : join(dirname(appBootPath), "package.json"),
    appBoot,
    resolveExports,
    requireFromBoot,
  };
}

function requireAppBoot(value: unknown): AppBootModule {
  if (!isPlainObject(value)) throw runtimeError("runtime-unsupported");
  const templates = value.PROFILE_TEMPLATES;
  if (
    typeof value.resolveBundleDir !== "function"
    || typeof value.loadProfileDirectory !== "function"
    || typeof value.loadOptionalPatches !== "function"
    || typeof value.loadOverlayPatches !== "function"
    || typeof value.composeEntries !== "function"
    || typeof value.mountRootInclude !== "function"
    || typeof value.PROFILE_PATCH_FILENAME !== "string"
    || typeof value.PROFILES_DIR !== "string"
    || !isPlainObject(templates)
  ) {
    throw runtimeError("runtime-unsupported");
  }
  if (!isSafeBasename(value.PROFILE_PATCH_FILENAME) || !isSafeBasename(value.PROFILES_DIR)) {
    throw runtimeError("runtime-unsupported");
  }
  return value as AppBootModule;
}

function webTemplateBundles(appBoot: AppBootModule): string[] {
  const bundles = appBoot.PROFILE_TEMPLATES.web?.bundles;
  if (!Array.isArray(bundles) || bundles.some((item) => typeof item !== "string" || !isBareNpmPackageName(item))) {
    throw runtimeError("runtime-unsupported");
  }
  return bundles;
}

function observeRuntimeFiles(observation: Observation, bound: BoundRuntime): void {
  observation.observe("bin", bound.bin, false, "invalid-bin");
  observation.observe("app-boot", bound.appBootPath, false, "runtime-unsupported");
  observation.observe("app-boot-manifest", bound.appBootManifestPath, true, "runtime-unsupported");
  observation.observe("install-manifest", bound.installAnchor, false, "invalid-bin");
}

function readHostVersions(
  bound: BoundRuntime,
  observation: Observation,
  profileDir: string,
): BlueprintRuntimeVersions {
  const installBytes = observation.observe("install-manifest", bound.installAnchor, false, "invalid-bin");
  const install = parseManifest(installBytes);
  const dsh = typeof install.version === "string" ? install.version : null;
  return {
    dsh,
    base: readResolvedVersion(bound, observation, profileDir, HOST_BASE, "host-base"),
    webApp: readResolvedVersion(bound, observation, profileDir, HOST_WEB_APP, "host-web"),
  };
}

function readResolvedVersion(
  bound: BoundRuntime,
  observation: Observation,
  profileDir: string,
  packageName: string,
  logical: string,
): string | null {
  let packageDir: string;
  try {
    packageDir = bound.appBoot.resolveBundleDir(BIN_NAME, packageName, bound.installAnchor, profileDir);
  } catch {
    return null;
  }
  assertNotRealHomePath(packageDir, "bundle-unresolved");
  const manifestPath = join(packageDir, "package.json");
  if (!containedIn(packageDir, manifestPath)) return null;
  const bytes = observation.observe(`host/${logical}/manifest`, manifestPath, true, "manifest-invalid");
  if (!bytes) return null;
  const manifest = parseManifest(bytes);
  return typeof manifest.version === "string" ? manifest.version : null;
}

function mergeLayerVersions(
  versions: BlueprintRuntimeVersions,
  layers: BlueprintRuntimeLayer[],
): BlueprintRuntimeVersions {
  const byName = new Map(layers.map((layer) => [layer.name, layer.version]));
  return {
    dsh: versions.dsh,
    base: byName.get(HOST_BASE) ?? versions.base,
    webApp: byName.get(HOST_WEB_APP) ?? versions.webApp,
  };
}

function readBundleLayer(
  bound: BoundRuntime,
  observation: Observation,
  profileDir: string,
  packageName: string,
  index: number,
): BlueprintRuntimeLayer {
  const packageDir = resolvePackageDir(bound, packageName, profileDir, "bundle-unresolved");
  const manifestPath = join(packageDir, "package.json");
  const manifestBytes = observation.observe(
    `layer/${index}/${packageName}/manifest`,
    manifestPath,
    false,
    "manifest-invalid",
  );
  const manifest = parseManifest(manifestBytes);
  const name = typeof manifest.name === "string" ? manifest.name : "";
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (!name || !version) throw runtimeError("manifest-invalid");
  const declared = readDeclaredPatch(manifest);
  const patchPath = declaredPatchPath(packageDir, declared);
  assertRegularContainedFile(
    packageDir,
    patchPath,
    "bundle-patch-escape",
    "bundle-patch-invalid",
    "bundle-patch-missing",
  );
  const patchBytes = observation.observe(
    `layer/${index}/${packageName}/patch`,
    patchPath,
    false,
    "bundle-patch-missing",
  );
  if (!patchBytes) throw runtimeError("bundle-patch-missing");
  decodeUtf8(patchBytes, "utf8-invalid");
  let patches: unknown[];
  try {
    patches = bound.appBoot.loadOverlayPatches(BIN_NAME, patchPath);
  } catch {
    throw runtimeError("bundle-patch-invalid");
  }
  if (!Array.isArray(patches)) throw runtimeError("bundle-patch-invalid");
  return { name, version, packageDir, patchPath, patches };
}

function readHomePatches(bound: BoundRuntime, observation: Observation): unknown[] {
  const patchPath = join(bound.home, bound.appBoot.PROFILE_PATCH_FILENAME);
  if (!containedIn(bound.home, patchPath)) throw runtimeError("home-patch-invalid");
  const bytes = observation.observe("home-patch", patchPath, true, "home-patch-invalid");
  if (!bytes) return [];
  decodeUtf8(bytes, "utf8-invalid");
  let parsed: unknown[] | undefined;
  try {
    parsed = bound.appBoot.loadOptionalPatches(BIN_NAME, patchPath);
  } catch {
    throw runtimeError("home-patch-invalid");
  }
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw runtimeError("home-patch-invalid");
  return parsed;
}

function resolveCordisBuiltin(
  bound: BoundRuntime,
  observation: Observation,
  profileDir: string,
  specifier: string,
): BlueprintRuntimeModule | undefined {
  if (!specifier.startsWith("cordis:")) return undefined;
  const name = specifier.slice("cordis:".length);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw runtimeError("module-invalid");
  if (typeof bound.appBoot.mountRootInclude !== "function") throw runtimeError("builtin-unsupported");
  const provider = CORDIS_BUILTINS[name];
  if (!provider) throw runtimeError("builtin-unsupported");
  let version: string | null = null;
  try {
    const packageDir = resolvePackageDir(bound, provider, profileDir, "module-unresolved");
    const manifestPath = join(packageDir, "package.json");
    const bytes = observation.observe(`builtin/${name}/manifest`, manifestPath, true, "manifest-invalid");
    if (bytes) {
      const manifest = parseManifest(bytes);
      version = typeof manifest.version === "string" ? manifest.version : null;
    }
  } catch (error) {
    if (error instanceof BlueprintRuntimeError && error.code !== "module-unresolved" && error.code !== "bundle-unresolved") {
      throw error;
    }
    version = null;
  }
  return {
    packageName: provider,
    packageVersion: version,
    resolvedPath: null,
    builtin: true,
  };
}

function resolveExportPath(
  bound: BoundRuntime,
  packageDir: string,
  packageName: string,
  manifest: Record<string, unknown>,
  subpath: string,
  observation: Observation,
): string {
  const declared = manifest.exports;
  if (declared !== undefined) {
    const resolved = resolveWithExports(bound.resolveExports, packageName, declared, subpath);
    if (!resolved) throw runtimeError("module-unresolved");
    const file = containedExportFile(packageDir, resolved);
    observation.observe(`package/${packageName}/export`, file, false, "module-unresolved");
    return file;
  }
  const main = typeof manifest.main === "string" && manifest.main.length > 0 ? manifest.main : undefined;
  const request = subpath === "." ? join(packageDir, main ?? "index") : join(packageDir, subpath.slice(2));
  let resolved: string;
  try {
    resolved = createRequire(join(packageDir, "package.json")).resolve(request);
  } catch {
    throw runtimeError("module-unresolved");
  }
  const file = containedExportFile(packageDir, resolved, true);
  observation.observe(`package/${packageName}/export`, file, false, "module-unresolved");
  return file;
}

function resolveWithExports(
  resolveExports: ResolveExports,
  packageName: string,
  declared: unknown,
  subpath: string,
): string | undefined {
  const attempts: Array<{ conditions?: string[]; require?: boolean }> = [
    { conditions: ["import", "node", "default"] },
    { require: true, conditions: ["require", "node", "default"] },
  ];
  for (const options of attempts) {
    let candidates: string[] | undefined;
    try {
      candidates = resolveExports({ name: packageName, exports: declared }, subpath, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("No known conditions for ")) continue;
      if (message.startsWith("Missing \"")) return undefined;
      throw runtimeError("module-unresolved");
    }
    const first = (candidates ?? []).find((item) => typeof item === "string" && item.startsWith("./"));
    if (first) return first;
  }
  return undefined;
}

function containedExportFile(packageDir: string, candidate: string, alreadyAbsolute = false): string {
  const target = alreadyAbsolute ? resolve(candidate) : resolve(packageDir, candidate);
  if (!alreadyAbsolute && (isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate))) {
    throw runtimeError("module-unresolved");
  }
  if (!containedIn(packageDir, target)) throw runtimeError("module-unresolved");
  assertRegularContainedFile(packageDir, target, "module-unresolved", "module-unresolved", "module-unresolved");
  return realpathSync(target);
}

function resolvePackageDir(
  bound: BoundRuntime,
  packageName: string,
  profileDir: string,
  code: BlueprintRuntimeErrorCode,
): string {
  let packageDir: string;
  try {
    packageDir = bound.appBoot.resolveBundleDir(BIN_NAME, packageName, bound.installAnchor, profileDir);
  } catch {
    throw runtimeError(code);
  }
  assertNotRealHomePath(packageDir, code);
  let st;
  try {
    st = lstatSync(packageDir);
  } catch {
    throw runtimeError(code);
  }
  if (!st.isDirectory() && !st.isSymbolicLink()) throw runtimeError(code);
  let real: string;
  try {
    real = realpathSync(packageDir);
  } catch {
    throw runtimeError(code);
  }
  assertNotRealHomePath(real, code);
  const manifestPath = join(packageDir, "package.json");
  if (!containedIn(packageDir, manifestPath) && !containedIn(real, join(real, "package.json"))) {
    throw runtimeError("manifest-invalid");
  }
  return packageDir;
}

function readDeclaredPatch(manifest: Record<string, unknown>): string {
  const dsh = manifest.dsh;
  if (!isPlainObject(dsh)) throw runtimeError("bundle-patch-missing");
  const bundle = dsh.bundle;
  if (!isPlainObject(bundle) || typeof bundle.patch !== "string") throw runtimeError("bundle-patch-missing");
  return bundle.patch;
}

function declaredPatchPath(packageDir: string, declared: string): string {
  if (!declared || declared.includes("\0")) throw runtimeError("bundle-patch-invalid");
  const normalized = declared.replaceAll("\\", "/");
  if (
    isAbsolute(declared)
    || isAbsolute(normalized)
    || /^[A-Za-z]:/.test(declared)
    || normalized.startsWith("/")
  ) {
    throw runtimeError("bundle-patch-escape");
  }
  const parts = normalized.split("/");
  const segments = parts[0] === "." ? parts.slice(1) : parts;
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw runtimeError("bundle-patch-escape");
  }
  const joined = resolve(packageDir, declared);
  if (!containedIn(packageDir, joined)) throw runtimeError("bundle-patch-escape");
  return joined;
}

function assertRegularContainedFile(
  packageDir: string,
  filePath: string,
  escape: BlueprintRuntimeErrorCode,
  invalid: BlueprintRuntimeErrorCode,
  missing: BlueprintRuntimeErrorCode,
): void {
  if (!containedIn(packageDir, filePath)) throw runtimeError(escape);
  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    throw runtimeError(missing);
  }
  let realFile: string;
  let realPackage: string;
  try {
    realFile = realpathSync(filePath);
    realPackage = realpathSync(packageDir);
  } catch {
    throw runtimeError(escape);
  }
  assertNotRealHomePath(realFile, escape);
  if (!containedIn(realPackage, realFile)) throw runtimeError(escape);
  let realSt;
  try {
    realSt = statSync(realFile);
  } catch {
    throw runtimeError(invalid);
  }
  if (!realSt.isFile() || realSt.isDirectory()) throw runtimeError(invalid);
  if (!st.isFile() && !st.isSymbolicLink()) throw runtimeError(invalid);
}

function requireSandboxHome(home: string): string {
  if (!home || home.includes("\0")) throw runtimeError("invalid-home");
  const resolved = resolve(home);
  try {
    assertNotRealHome(resolved);
  } catch {
    throw runtimeError("invalid-home");
  }
  if (isInsideRealHome(resolved)) throw runtimeError("invalid-home");
  let st;
  try {
    st = lstatSync(resolved);
  } catch {
    throw runtimeError("invalid-home");
  }
  if (!st.isDirectory() && !st.isSymbolicLink()) throw runtimeError("invalid-home");
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw runtimeError("invalid-home");
  }
  if (isInsideRealHome(real)) throw runtimeError("invalid-home");
  return resolved;
}

function requireBinFile(bin: string): string {
  if (!bin || bin.includes("\0")) throw runtimeError("invalid-bin");
  const resolved = resolve(bin);
  if (isInsideRealHome(resolved)) throw runtimeError("invalid-bin");
  let st;
  try {
    st = lstatSync(resolved);
  } catch {
    throw runtimeError("invalid-bin");
  }
  if (!st.isFile() && !st.isSymbolicLink()) throw runtimeError("invalid-bin");
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw runtimeError("invalid-bin");
  }
  if (isInsideRealHome(real) || !statSync(real).isFile()) throw runtimeError("invalid-bin");
  return real;
}

function requireInstallAnchor(bin: string): string {
  const anchor = resolve(dirname(bin), "..", "package.json");
  if (!existsAsFile(anchor)) throw runtimeError("invalid-bin");
  let real: string;
  try {
    real = realpathSync(anchor);
  } catch {
    throw runtimeError("invalid-bin");
  }
  if (isInsideRealHome(real)) throw runtimeError("invalid-bin");
  return real;
}

function requireSpaceId(spaceId: unknown): string {
  if (typeof spaceId !== "string" || !PROFILE_NAME_RE.test(spaceId) || RESERVED_SPACES.has(spaceId)) {
    throw runtimeError("invalid-space");
  }
  return spaceId;
}

function requireProfileDir(bound: BoundRuntime, spaceId: string, observation: Observation): string {
  const dir = join(bound.home, bound.appBoot.PROFILES_DIR, spaceId);
  if (!containedIn(bound.home, dir)) throw runtimeError("invalid-space");
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw runtimeError("invalid-space");
  }
  if (!st.isDirectory() && !st.isSymbolicLink()) throw runtimeError("invalid-space");
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw runtimeError("invalid-space");
  }
  if (!containedIn(realpathSync(bound.home), real) || isInsideRealHome(real)) {
    throw runtimeError("invalid-space");
  }
  const manifestPath = join(dir, "package.json");
  observation.observe(`profile/${spaceId}/manifest`, manifestPath, false, "invalid-space");
  return dir;
}

function requireBundleNames(bundles: unknown): string[] {
  if (!Array.isArray(bundles)) throw runtimeError("bundle-unresolved");
  const names: string[] = [];
  for (const item of bundles) {
    if (typeof item !== "string" || !isBareNpmPackageName(item)) throw runtimeError("bundle-unresolved");
    names.push(item);
  }
  return names;
}

function requirePatchList(patch: unknown): unknown[] {
  if (!Array.isArray(patch)) throw runtimeError("bundle-patch-invalid");
  return patch;
}

function requireSpecifier(specifier: unknown): string {
  if (typeof specifier !== "string" || !specifier || specifier.includes("\0") || /[\s;|&$`<>()]/.test(specifier)) {
    throw runtimeError("module-invalid");
  }
  if (
    specifier.startsWith(".")
    || specifier.startsWith("/")
    || specifier.includes("\\")
    || /^[A-Za-z]:[\\/]/.test(specifier)
    || /^[a-z][a-z0-9+.-]*:/.test(specifier.toLowerCase()) && !specifier.startsWith("cordis:")
  ) {
    throw runtimeError("module-invalid");
  }
  return specifier;
}

function parsePackageSpecifier(specifier: string): { packageName: string; subpath: string } {
  if (specifier.startsWith("cordis:")) throw runtimeError("builtin-unsupported");
  if (specifier.startsWith("#") || specifier.includes(":")) throw runtimeError("module-invalid");
  const packageName = packageNameOf(specifier);
  if (!packageName || !isBareNpmPackageName(packageName)) throw runtimeError("module-invalid");
  if (specifier === packageName) return { packageName, subpath: "." };
  if (!specifier.startsWith(`${packageName}/`)) throw runtimeError("module-invalid");
  const rest = specifier.slice(packageName.length + 1);
  const segments = rest.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw runtimeError("module-invalid");
  }
  return { packageName, subpath: `./${rest}` };
}

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return specifier.split("/")[0];
}

function parseManifest(bytes: Buffer | undefined): Record<string, unknown> {
  if (!bytes) throw runtimeError("manifest-invalid");
  const text = decodeUtf8(bytes, "utf8-invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw runtimeError("manifest-invalid");
  }
  if (!isPlainObject(parsed)) throw runtimeError("manifest-invalid");
  return parsed;
}

function decodeUtf8(bytes: Buffer, code: BlueprintRuntimeErrorCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw runtimeError(code);
  }
}

function snapshotPath(path: string): ObservedFile {
  try {
    const bytes = readFileSync(path);
    return { status: "present", hash: sha256Hex(bytes) };
  } catch (error) {
    if (isEnoent(error)) return { status: "absent", hash: "" };
    throw runtimeError("observation-changed");
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function containedIn(root: string, target: string): boolean {
  const rootPath = canon(root);
  const targetPath = canon(target);
  const rel = relative(rootPath, targetPath);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes("..");
}

function canon(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSafeBasename(value: string): boolean {
  return Boolean(value) && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function assertNotRealHomePath(path: string, code: BlueprintRuntimeErrorCode): void {
  if (isInsideRealHome(path)) throw runtimeError(code);
}

function runtimeError(code: BlueprintRuntimeErrorCode): BlueprintRuntimeError {
  return new BlueprintRuntimeError(code, ERROR_MESSAGE[code]);
}
