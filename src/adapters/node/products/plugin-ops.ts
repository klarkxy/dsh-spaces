import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lt as semverLt, prerelease as semverPrerelease, valid as semverValid } from "semver";
import { t } from "../../../shared/i18n";
import { formatWorkbenchFailure } from "../../../shared/workbench";
import { DSH_RUNTIME_PACKAGE, isExactRuntimeVersion } from "../../../shared/runtime";
import {
  PROTECTED_PLUGIN_PACKAGES,
  type InstalledPlugin,
  type PluginDownloadRequest,
  type PluginInstallResult,
  type PluginLibraryEntry,
} from "../../../shared/types";
import { enqueuePlugin, findDshBin, runDsh } from "../runtime/dsh-cli";
import { sanitizeLogText } from "../diagnostics/diagnostics";
import { currentDiagnosticLogger } from "../diagnostics/operation-log";
import { assertNotRealHome } from "../home/home-guard";
import { npmPackumentUrl } from "./package-source";
import { isBareNpmPackageName, isGitSpec, isInstallableEntry, isSafeSpec, pluginAliases } from "../../../shared/plugin";
import { isExactGithubInstallSpec } from "../../../shared/plugin-source";
import { lookupCatalogEntry } from "./plugin-catalog";
import {
  archiveAbsPath,
  archiveRelPath,
  isHubPluginArchive,
  lookupLibraryEntry,
  removeLibraryEntry,
  spacesUsingPlugin,
  upsertLibraryEntry,
} from "./plugin-library";
import { currentPackageSource, npmCliJs, nodeExecutable, runProcess, toolchainEnv } from "../runtime/toolchain";

const PROTECTED = new Set<string>(PROTECTED_PLUGIN_PACKAGES);
const PLUGIN_TIMEOUT_MS = 180_000;
/** Headers plus body. Git pack reuses this bound; HTTP tests may inject a shorter value. */
export const DOWNLOAD_TIMEOUT_MS = 180_000;
/** npm packuments stay small; 32 MiB stops a never-ending JSON stream without blocking a real registry document. */
export const DOWNLOAD_METADATA_MAX_BYTES = 32 * 1024 * 1024;
/** Workbench plugin tarballs are tens of MiB; 256 MiB is a hard RAM cap, not an expected size. */
export const DOWNLOAD_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
/** How many exact versions one catalog entry reports. */
export const DEFAULT_PLUGIN_VERSION_LIMIT = 50;

export type PluginFetcher = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

export type GitPacker = (spec: string, destFile: string) => Promise<void>;

export type PluginDownloadOptions = {
  fetchImpl?: PluginFetcher;
  packGit?: GitPacker;
  signal?: AbortSignal;
  timeoutMs?: number;
  metadataMaxBytes?: number;
  archiveMaxBytes?: number;
};

function profileDir(dshHome: string, name: string): string {
  return join(dshHome, "profiles", name);
}

function readManifest(dshHome: string, name: string): {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
} {
  const pkgPath = join(profileDir(dshHome, name), "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(t("errors.unknownProfile", { name }));
  }
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[] } };
    };
  } catch {
    throw new Error(t("errors.unknownProfile", { name }));
  }
}

function assertProfile(dshHome: string, name: string): void {
  assertNotRealHome(dshHome);
  if (!existsSync(profileDir(dshHome, name))) {
    throw new Error(t("errors.unknownProfile", { name }));
  }
}

export function isProtectedPlugin(packageName: string): boolean {
  return PROTECTED.has(packageName);
}

export function listAllProfilePlugins(
  dshHome: string,
  names: string[],
): Record<string, InstalledPlugin[]> {
  const result: Record<string, InstalledPlugin[]> = {};
  for (const name of names) {
    try {
      result[name] = listProfilePlugins(dshHome, name);
    } catch {
      result[name] = [];
    }
  }
  return result;
}

function readResolvedVersion(dshHome: string, space: string, packageName: string): string | null {
  const pkg = join(profileDir(dshHome, space), "node_modules", ...packageName.split("/"), "package.json");
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown };
    const version = typeof parsed.version === "string" ? parsed.version : "";
    return isExactRuntimeVersion(version) ? version : null;
  } catch {
    return null;
  }
}

export function listProfilePlugins(dshHome: string, name: string): InstalledPlugin[] {
  assertProfile(dshHome, name);
  const manifest = readManifest(dshHome, name);
  const deps = manifest.dependencies ?? {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const seen = new Set<string>();
  const list: InstalledPlugin[] = [];
  for (const bundle of bundles) {
    if (seen.has(bundle)) continue;
    seen.add(bundle);
    const requestedSpec = deps[bundle];
    const resolvedVersion = readResolvedVersion(dshHome, name, bundle);
    list.push({
      name: bundle,
      requestedSpec,
      resolvedVersion,
      version: resolvedVersion,
      protected: isProtectedPlugin(bundle),
    });
  }
  return list;
}

function pluginError(spaceId: string, spec: string, code: number, stdout: string, stderr: string): Error {
  const detail = boundedProcessDetail(stdout, stderr);
  return new Error(
    formatWorkbenchFailure({
      spaceId,
      stage: "install",
      packageName: spec,
      pluginAttribution: "known",
      reason: t("errors.pluginAddFailed", { spec, code, detail }),
      exitCode: code,
    }),
  );
}

/** Official `dsh` stderr is often only "pnpm failed"; the useful pnpm text is on stdout. */
function boundedProcessDetail(stdout: string, stderr: string): string {
  const err = String(stderr ?? "");
  const errPart = err.length <= 800 ? err : `${err.slice(0, 300)}\n…\n${err.slice(-500)}`;
  const outTail = String(stdout ?? "").slice(-1600);
  const parts = [errPart, outTail].filter((part) => part.trim());
  let detail = parts.join("\n");
  if (parts.length === 2 && errPart.includes(outTail)) detail = errPart;
  if (detail.length > 2400) detail = `${detail.slice(0, 400)}\n…\n${detail.slice(-1800)}`;
  return sanitizeLogText(detail);
}

function addableSpec(dshHome: string, spec: string): string {
  if (isHubPluginArchive(dshHome, spec)) return spec;
  if (isSafeSpec(spec) || isExactGithubInstallSpec(spec)) return spec;
  throw new Error(t("errors.pluginSpecInvalid", { spec }));
}

/**
 * 0.1.7-alpha.1 forwards pnpm with execa and keeps each argument intact.
 * Older Windows builds use `shell: true`, which concatenates argv for cmd.exe
 * and splits a Home path at the first space.
 */
const ARGV_PRESERVING_CLI = "0.1.7-alpha.1";

function selectedCliVersion(profile?: string): string | undefined {
  const bin = findDshBin(profile);
  if (!bin) return undefined;
  for (const path of [join(dirname(bin), "package.json"), join(dirname(bin), "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
      if (parsed.name === DSH_RUNTIME_PACKAGE && typeof parsed.version === "string") return parsed.version;
    } catch {
      // The binary layout varies; the other candidate is the package root.
    }
  }
  return undefined;
}

function archiveAddArgument(dshHome: string, profile: string, target: string): string {
  if (process.platform !== "win32" || !isHubPluginArchive(dshHome, target)) return target;
  const version = selectedCliVersion(profile);
  if (!version || !semverValid(version) || !semverLt(version, ARGV_PRESERVING_CLI)) return target;
  const spec = relative(profileDir(dshHome, profile), target).replaceAll("\\", "/");
  return `"file:${spec}"`;
}

/**
 * On Windows, a `github:…&path:/…` spec only reaches `plugin add` intact when
 * the selected CLI preserves argv; older builds join arguments through
 * cmd.exe, where "&" splits the command. The selected version is the only
 * evidence — unknown means the bound runtime is current enough to check.
 */
function assertArgvSafeSpec(profile: string, target: string): void {
  if (process.platform !== "win32" || !isExactGithubInstallSpec(target)) return;
  const version = selectedCliVersion(profile);
  if (version && semverValid(version) && semverLt(version, ARGV_PRESERVING_CLI)) {
    throw new Error(t("errors.pluginSpecInvalid", { spec: target }));
  }
}

export async function pluginAdd(dshHome: string, name: string, spec: string, options: { force?: boolean } = {}): Promise<void> {
  assertProfile(dshHome, name);
  const target = addableSpec(dshHome, spec);
  assertArgvSafeSpec(name, target);
  const cliTarget = archiveAddArgument(dshHome, name, target);
  await enqueuePlugin(async () => {
    const log = currentDiagnosticLogger();
    const started = Date.now();
    log?.info("plugin.install.started", "Plugin installation started.", { space: name, package: publicPluginSpec(spec), force: options.force === true });
    const { stdout, stderr, code } = await runDsh(
      dshHome,
      ["plugin", "--profile", name, "add", cliTarget, ...(options.force ? ["--force"] : [])],
      { timeoutMs: PLUGIN_TIMEOUT_MS, profile: name },
    );
    log?.write({ level: code === 0 ? "info" : "error", event: "plugin.install.finished", message: "Plugin installer exited.", context: { space: name, package: publicPluginSpec(spec), exitCode: code, durationMs: Date.now() - started, stdout, stderr } });
    if (code !== 0) throw pluginError(name, target, code, stdout, stderr);
  });
}

/**
 * Dev-checkout install: `dsh plugin add` of a verified package directory so
 * the profile records a `link:` spec. Unlike pluginAdd this accepts a bare
 * directory, but only an absolute readable package outside Home whose
 * package.json name matches the expected component.
 */
export async function pluginLinkDirectory(
  dshHome: string,
  name: string,
  dir: string,
  expectedName: string,
): Promise<void> {
  assertProfile(dshHome, name);
  const invalid = (): Error => new Error(t("errors.pluginSpecInvalid", { spec: dir }));
  const inside = relative(resolve(dshHome), dir);
  const insideHome = inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  let valid = isAbsolute(dir) && !insideHome;
  if (valid) {
    try {
      valid = statSync(dir).isDirectory()
        && (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name === expectedName;
    } catch {
      valid = false;
    }
  }
  if (!valid) throw invalid();
  await enqueuePlugin(async () => {
    const log = currentDiagnosticLogger();
    const started = Date.now();
    log?.info("plugin.link.started", "Linked plugin installation started.", { space: name, package: expectedName });
    const { stdout, stderr, code } = await runDsh(
      dshHome,
      ["plugin", "--profile", name, "add", dir],
      { timeoutMs: PLUGIN_TIMEOUT_MS, profile: name },
    );
    log?.write({ level: code === 0 ? "info" : "error", event: "plugin.link.finished", message: "Linked plugin installer exited.", context: { space: name, package: expectedName, exitCode: code, durationMs: Date.now() - started, stdout, stderr } });
    if (code !== 0) throw pluginError(name, dir, code, stdout, stderr);
  });
}

export async function pluginRemove(dshHome: string, name: string, packageName: string): Promise<void> {
  assertProfile(dshHome, name);
  if (!isSafeSpec(packageName)) {
    throw new Error(t("errors.pluginSpecInvalid", { spec: packageName }));
  }
  if (isProtectedPlugin(packageName)) {
    throw new Error(t("errors.pluginProtected", { name: packageName }));
  }
  await enqueuePlugin(async () => {
    const log = currentDiagnosticLogger();
    const started = Date.now();
    log?.info("plugin.remove.started", "Plugin removal started.", { space: name, package: packageName });
    const { stdout, stderr, code } = await runDsh(
      dshHome,
      ["plugin", "--profile", name, "remove", packageName],
      { timeoutMs: PLUGIN_TIMEOUT_MS, profile: name },
    );
    log?.write({ level: code === 0 ? "info" : "error", event: "plugin.remove.finished", message: "Plugin remover exited.", context: { space: name, package: packageName, exitCode: code, durationMs: Date.now() - started, stdout, stderr } });
    if (code !== 0) {
      throw new Error(
        formatWorkbenchFailure({
          spaceId: name,
          stage: "remove",
          packageName,
          pluginAttribution: "known",
          reason: t("errors.pluginRemoveFailed", {
            spec: packageName,
            code,
            detail: (stderr || stdout).slice(0, 800),
          }),
          exitCode: code,
        }),
      );
    }
  });
}

export async function resolveInstallSpec(
  dshHome: string,
  request: { catalogId?: string; spec?: string },
): Promise<string> {
  if (request.catalogId) {
    const entry = lookupCatalogEntry(dshHome, request.catalogId);
    if (!entry) throw new Error(t("errors.pluginCatalogMissing", { id: request.catalogId }));
    if (!isInstallableEntry(entry) || !entry.installSpec) {
      throw new Error(t("errors.pluginNotInstallable", { id: request.catalogId }));
    }
    return entry.installSpec;
  }
  const spec = request.spec?.trim() ?? "";
  if (!isSafeSpec(spec)) {
    throw new Error(t("errors.pluginSpecInvalid", { spec }));
  }
  return spec;
}


function defaultFetcher(limits?: { metadataMaxBytes?: number; archiveMaxBytes?: number }): PluginFetcher {
  const metadataMaxBytes = limits?.metadataMaxBytes ?? DOWNLOAD_METADATA_MAX_BYTES;
  const archiveMaxBytes = limits?.archiveMaxBytes ?? DOWNLOAD_ARCHIVE_MAX_BYTES;
  return async (url, init) => {
    const response = await fetch(url, { headers: init?.headers, signal: init?.signal });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        const bytes = await readFetchBody(response, init?.signal, metadataMaxBytes);
        try {
          return JSON.parse(bytes.toString("utf8")) as unknown;
        } catch {
          throw new Error(t("errors.pluginDownloadFailed", { spec: url, detail: "invalid JSON" }));
        }
      },
      arrayBuffer: async () => {
        const bytes = await readFetchBody(response, init?.signal, archiveMaxBytes);
        return Uint8Array.from(bytes).buffer;
      },
    };
  };
}

function createDownloadControl(options: PluginDownloadOptions): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const parent = options.signal;
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    close() {
      controller.abort();
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function abortError(message = "The download was aborted."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError");
}

function throwIfDownloadAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function downloadFailed(spec: string, detail: string): Error {
  return new Error(t("errors.pluginDownloadFailed", { spec, detail }));
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readFetchBody(response: Response, signal: AbortSignal | undefined, maxBytes: number): Promise<Buffer> {
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw abortError();
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw downloadFailed("plugin", `response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) {
    const bytes = Buffer.from(await raceAbort(response.arrayBuffer(), signal ?? new AbortController().signal));
    if (bytes.length > maxBytes) throw downloadFailed("plugin", `response exceeded ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const abortReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw downloadFailed("plugin", `response exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
  } finally {
    signal?.removeEventListener("abort", abortReader);
  }
}

async function readFetcherJson(
  response: { json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> },
  signal: AbortSignal,
  maxBytes: number,
  spec: string,
): Promise<unknown> {
  throwIfDownloadAborted(signal);
  const value = await raceAbort(Promise.resolve().then(() => response.json()), signal);
  try {
    const encoded = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (encoded > maxBytes) throw downloadFailed(spec, `response exceeded ${maxBytes} bytes`);
  } catch (error) {
    if (error instanceof Error && /exceeded/.test(error.message)) throw error;
  }
  return value;
}

async function readFetcherArchive(
  response: { arrayBuffer(): Promise<ArrayBuffer> },
  signal: AbortSignal,
  maxBytes: number,
  spec: string,
): Promise<Buffer> {
  throwIfDownloadAborted(signal);
  const body: ArrayBuffer = await raceAbort<ArrayBuffer>(Promise.resolve().then(() => response.arrayBuffer()), signal);
  const bytes = Buffer.from(new Uint8Array(body));
  if (bytes.length > maxBytes) throw downloadFailed(spec, `response exceeded ${maxBytes} bytes`);
  if (bytes.length === 0) throw downloadFailed(spec, "empty tarball");
  return bytes;
}

function rewriteTarballUrl(url: string): string {
  if (currentPackageSource() !== "china") return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "registry.npmjs.org" || parsed.hostname.endsWith(".npmjs.org")) {
      parsed.protocol = "https:";
      parsed.hostname = "registry.npmmirror.com";
      return parsed.toString();
    }
  } catch {
    // keep original
  }
  return url;
}

async function writeAtomicBin(file: string, contents: Buffer): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

export function parseNpmNameAndVersion(spec: string): { name: string; version: string } | null {
  const trimmed = spec.trim();
  if (!trimmed || isGitSpec(trimmed)) return null;
  if (trimmed.startsWith("@")) {
    const at = trimmed.indexOf("@", 1);
    if (at < 0) return null;
    const name = trimmed.slice(0, at);
    const version = trimmed.slice(at + 1);
    if (!name.includes("/") || !isExactRuntimeVersion(version)) return null;
    return { name, version };
  }
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  const name = trimmed.slice(0, at);
  const version = trimmed.slice(at + 1);
  if (!name || name.includes("/") || !isExactRuntimeVersion(version)) return null;
  return { name, version };
}

async function downloadNpmTarball(
  spec: string,
  destFile: string,
  fetchImpl: PluginFetcher,
  control: { signal: AbortSignal; metadataMaxBytes: number; archiveMaxBytes: number },
): Promise<{ packageName: string; version: string }> {
  const parsed = parseNpmNameAndVersion(spec);
  if (!parsed) {
    throw new Error(t("errors.pluginNeedExactVersion"));
  }
  throwIfDownloadAborted(control.signal);
  const url = npmPackumentUrl(currentPackageSource(), parsed.name);
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: control.signal });
  if (!response.ok) {
    throw downloadFailed(spec, `HTTP ${response.status}`);
  }
  const packument = (await readFetcherJson(response, control.signal, control.metadataMaxBytes, spec)) as {
    name?: unknown;
    "dist-tags"?: { latest?: string };
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const tarball = packument.versions?.[parsed.version]?.dist?.tarball;
  const packageName = typeof packument.name === "string" && packument.name ? packument.name : parsed.name;
  if (!tarball) {
    throw downloadFailed(spec, "missing tarball");
  }
  throwIfDownloadAborted(control.signal);
  const packed = await fetchImpl(rewriteTarballUrl(tarball), { signal: control.signal });
  if (!packed.ok) {
    throw downloadFailed(spec, `HTTP ${packed.status}`);
  }
  const bytes = await readFetcherArchive(packed, control.signal, control.archiveMaxBytes, spec);
  throwIfDownloadAborted(control.signal);
  await writeAtomicBin(destFile, bytes);
  return { packageName, version: parsed.version };
}

async function defaultGitPacker(spec: string, destFile: string): Promise<void> {
  const node = nodeExecutable();
  const npm = npmCliJs();
  if (!node || !npm) throw new Error(t("errors.npmMissing"));
  const tmp = `${destFile}.pack`;
  mkdirSync(tmp, { recursive: true });
  try {
    const result = await runProcess(node, [npm, "pack", spec, "--pack-destination", tmp], {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      env: toolchainEnv(),
    });
    if (result.code !== 0) {
      throw new Error(
        t("errors.pluginPackFailed", {
          spec,
          code: result.code,
          detail: (result.stderr || result.stdout).slice(0, 800),
        }),
      );
    }
    const files = readdirSync(tmp).filter((name) => name.endsWith(".tgz"));
    if (files.length === 0) {
      throw new Error(t("errors.pluginPackFailed", { spec, code: result.code, detail: "no tarball" }));
    }
    mkdirSync(dirname(destFile), { recursive: true });
    renameSync(join(tmp, files[0]), destFile);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

type DownloadMeta = {
  id: string;
  spec: string;
  packageName: string;
  title: string;
  catalogId?: string;
  source: PluginLibraryEntry["source"];
};

function npmPin(packageName: string, version: string): Pick<DownloadMeta, "id" | "spec" | "packageName"> {
  const spec = `${packageName}@${version}`;
  return { id: spec.toLowerCase(), spec, packageName };
}

function resolveDownloadDraft(dshHome: string, request: PluginDownloadRequest): DownloadMeta {
  if (request.catalogId) {
    const entry = lookupCatalogEntry(dshHome, request.catalogId);
    if (!entry) throw new Error(t("errors.pluginCatalogMissing", { id: request.catalogId }));
    if (!isInstallableEntry(entry) || !entry.installSpec) {
      throw new Error(t("errors.pluginNotInstallable", { id: request.catalogId }));
    }
    const packageName = entry.packageName || entry.installSpec.replace(/^github:[^/]+\//, "");
    if (isGitSpec(entry.installSpec)) {
      return {
        id: entry.id,
        spec: entry.installSpec,
        packageName,
        title: entry.packageName || entry.repo,
        catalogId: entry.id,
        source: "catalog",
      };
    }
    const version = request.version?.trim() ?? "";
    if (version) {
      if (!isExactRuntimeVersion(version)) {
        throw new Error(t("errors.pluginNeedExactVersion"));
      }
      return {
        ...npmPin(packageName, version),
        title: entry.packageName || entry.repo,
        catalogId: entry.id,
        source: "catalog",
      };
    }
    const name = isBareNpmPackageName(packageName)
      ? packageName
      : isBareNpmPackageName(entry.installSpec)
        ? entry.installSpec
        : "";
    if (!name) throw new Error(t("errors.pluginNeedExactVersion"));
    return {
      id: name.toLowerCase(),
      spec: name,
      packageName: name,
      title: entry.packageName || entry.repo,
      catalogId: entry.id,
      source: "catalog",
    };
  }
  const spec = request.spec?.trim() ?? "";
  if (!isSafeSpec(spec)) throw new Error(t("errors.pluginSpecInvalid", { spec }));
  if (isGitSpec(spec)) {
    return {
      id: spec.toLowerCase(),
      spec,
      packageName: spec.replace(/^github:[^/]+\//, ""),
      title: spec.replace(/^github:[^/]+\//, ""),
      source: "manual",
    };
  }
  const parsed = parseNpmNameAndVersion(spec);
  if (parsed) {
    return { ...npmPin(parsed.name, parsed.version), title: parsed.name, source: "manual" };
  }
  if (!isBareNpmPackageName(spec)) {
    throw new Error(t("errors.pluginNeedExactVersion"));
  }
  return {
    id: spec.toLowerCase(),
    spec,
    packageName: spec,
    title: spec,
    source: "manual",
  };
}

async function resolveNpmLatest(
  name: string,
  fetchImpl: PluginFetcher,
  control: { signal: AbortSignal; metadataMaxBytes: number },
): Promise<{ packageName: string; version: string }> {
  throwIfDownloadAborted(control.signal);
  const url = npmPackumentUrl(currentPackageSource(), name);
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: control.signal });
  if (!response.ok) {
    throw downloadFailed(name, `HTTP ${response.status}`);
  }
  const packument = (await readFetcherJson(response, control.signal, control.metadataMaxBytes, name)) as {
    name?: unknown;
    "dist-tags"?: { latest?: unknown };
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const packageName = typeof packument.name === "string" && packument.name ? packument.name : name;
  const latest = typeof packument["dist-tags"]?.latest === "string" ? packument["dist-tags"].latest : "";
  const tarball = packument.versions?.[latest]?.dist?.tarball;
  if (!isExactRuntimeVersion(latest) || !tarball) {
    throw new Error(t("errors.pluginLatestMissing", { name: packageName }));
  }
  return { packageName, version: latest };
}

/** Exact npm versions of one package, newest first. */
export interface NpmPackageVersions {
  packageName: string;
  /** Exact semver versions, newest first. */
  versions: string[];
  /** The newest listed version, or null when the registry published none. */
  latest: string | null;
}

/**
 * Read the published versions of one npm package.
 *
 * One packument request, no retry and no cache. A failed request is the real
 * failure: the caller reports it instead of guessing a version.
 */
export async function listNpmPackageVersions(
  name: string,
  options: {
    fetchImpl?: PluginFetcher;
    signal?: AbortSignal;
    metadataMaxBytes?: number;
    limit?: number;
  } = {},
): Promise<NpmPackageVersions> {
  if (!isBareNpmPackageName(name)) throw new Error("Use an npm package name without a version or URL.");
  const fetchImpl = options.fetchImpl ?? defaultFetcher({ metadataMaxBytes: options.metadataMaxBytes });
  const control = new AbortController();
  const onParentAbort = () => control.abort();
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (options.signal?.aborted) control.abort();
  const metadataMaxBytes = options.metadataMaxBytes ?? DOWNLOAD_METADATA_MAX_BYTES;
  try {
    throwIfDownloadAborted(control.signal);
    const url = npmPackumentUrl(currentPackageSource(), name);
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: control.signal });
    if (!response.ok) {
      throw downloadFailed(name, `HTTP ${response.status}`);
    }
    const packument = (await readFetcherJson(response, control.signal, metadataMaxBytes, name)) as {
      name?: unknown;
      "dist-tags"?: { latest?: unknown };
      versions?: Record<string, unknown>;
    };
    if (!packument || packument.name !== name || !packument.versions ||
        typeof packument.versions !== "object" || Array.isArray(packument.versions)) {
      throw new Error("The npm registry returned metadata for an invalid or different package.");
    }
    const packageName = name;
    const published = Object.keys(packument.versions);
    const exact = published.filter((version) => isExactRuntimeVersion(version) && semverValid(version));
    // Newest first. Versions the registry published out of order keep their registry order.
    const sorted = exact
      .map((version, index) => ({ version, index }))
      .sort((a, b) => semverLt(a.version, b.version) ? 1 : semverLt(b.version, a.version) ? -1 : a.index - b.index)
      .map((row) => row.version);
    const versions = sorted.slice(0, Math.max(0, options.limit ?? DEFAULT_PLUGIN_VERSION_LIMIT));
    // The default and the upgrade target follow the registry's latest tag when it
    // names a listed version; otherwise the newest stable version. A prerelease is
    // only offered when the publisher tagged it latest.
    const tagged = typeof packument["dist-tags"]?.latest === "string" ? packument["dist-tags"].latest : "";
    const latest = sorted.includes(tagged) ? tagged : sorted.find((version) => !semverPrerelease(version)) ?? null;
    if (latest && versions.length && !versions.includes(latest)) versions[versions.length - 1] = latest;
    return { packageName, versions, latest };
  } finally {
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

async function pinDownloadMeta(
  draft: DownloadMeta,
  fetchImpl: PluginFetcher,
  control: { signal: AbortSignal; metadataMaxBytes: number },
): Promise<DownloadMeta> {
  if (isGitSpec(draft.spec) || parseNpmNameAndVersion(draft.spec)) return draft;
  const pinned = await resolveNpmLatest(draft.packageName, fetchImpl, control);
  const spec = `${pinned.packageName}@${pinned.version}`;
  return {
    ...draft,
    id: spec.toLowerCase(),
    spec,
    packageName: pinned.packageName,
  };
}

export async function downloadPlugin(
  dshHome: string,
  request: PluginDownloadRequest,
  options: PluginDownloadOptions = {},
): Promise<PluginLibraryEntry> {
  assertNotRealHome(dshHome);
  const fetchImpl = options.fetchImpl ?? defaultFetcher({
    metadataMaxBytes: options.metadataMaxBytes,
    archiveMaxBytes: options.archiveMaxBytes,
  });
  const draft = resolveDownloadDraft(dshHome, request);
  return enqueuePlugin(async () => {
    const control = createDownloadControl(options);
    const limits = {
      signal: control.signal,
      metadataMaxBytes: options.metadataMaxBytes ?? DOWNLOAD_METADATA_MAX_BYTES,
      archiveMaxBytes: options.archiveMaxBytes ?? DOWNLOAD_ARCHIVE_MAX_BYTES,
    };
    try {
      const log = currentDiagnosticLogger();
      log?.info("plugin.download.started", "Plugin download started.", { package: draft.packageName, source: draft.source });
      throwIfDownloadAborted(control.signal);
      const meta = await pinDownloadMeta(draft, fetchImpl, limits);
      const existing = lookupLibraryEntry(dshHome, meta.id);
      const dest = archiveAbsPath(dshHome, meta.id);
      if (existing?.tarball && existsSync(resolve(dshHome, existing.tarball))) {
        throwIfDownloadAborted(control.signal);
        return existing;
      }
      if (isGitSpec(meta.spec)) {
        throwIfDownloadAborted(control.signal);
        const pack = options.packGit ?? defaultGitPacker;
        await pack(meta.spec, dest);
        log?.info("plugin.download.packed", "Git plugin package was packed.", { package: meta.packageName, source: "github" });
      } else {
        const fetched = await downloadNpmTarball(meta.spec, dest, fetchImpl, limits);
        log?.info("plugin.download.fetched", "npm plugin archive was fetched.", { package: meta.packageName, source: "npm", bytes: existsSync(dest) ? statSync(dest).size : 0 });
        if (fetched.packageName) meta.packageName = fetched.packageName;
      }
      throwIfDownloadAborted(control.signal);
      if (!existsSync(dest)) {
        throw downloadFailed(meta.spec, "no file");
      }
      const entry: PluginLibraryEntry = {
        id: meta.id,
        spec: meta.spec,
        packageName: meta.packageName,
        title: meta.title,
        catalogId: meta.catalogId,
        tarball: archiveRelPath(meta.id),
        source: meta.source,
        downloadedAt: new Date().toISOString(),
      };
      throwIfDownloadAborted(control.signal);
      upsertLibraryEntry(dshHome, entry);
      log?.info("plugin.download.completed", "Plugin archive is available locally.", { package: entry.packageName, source: entry.source });
      return entry;
    } catch (error) {
      currentDiagnosticLogger()?.error("plugin.download.failed", "Plugin download failed.", error, { package: draft.packageName, source: draft.source });
      if (options.signal?.aborted) throw abortError();
      if (isAbortError(error)) throw downloadFailed(draft.spec, "timed out");
      throw error;
    } finally {
      control.close();
    }
  });
}

function publicPluginSpec(spec: string): string {
  if (isGitSpec(spec)) return spec.replace(/#.*$/, "#[pinned]");
  if (isBareNpmPackageName(spec) || parseNpmNameAndVersion(spec)) return spec;
  return "[local archive]";
}

export async function removeDownloadedPlugin(
  dshHome: string,
  id: string,
  profileNames: string[],
): Promise<PluginLibraryEntry[]> {
  assertNotRealHome(dshHome);
  const entry = lookupLibraryEntry(dshHome, id);
  if (!entry) throw new Error(t("errors.pluginLibraryMissing", { id }));
  const used = spacesUsingPlugin(dshHome, listAllProfilePlugins(dshHome, profileNames), entry);
  if (used.length > 0) {
    throw new Error(t("errors.pluginInUse", { name: entry.title || entry.packageName, spaces: used.join(", ") }));
  }
  return removeLibraryEntry(dshHome, entry.id);
}

function addSpecFor(dshHome: string, entry: PluginLibraryEntry): string {
  if (entry.tarball) {
    const abs = resolve(dshHome, entry.tarball);
    if (isHubPluginArchive(dshHome, abs)) return abs;
  }
  return entry.spec;
}

export async function setSpacePlugin(
  dshHome: string,
  profile: string,
  id: string,
  enabled: boolean,
  runningOf: (name: string) => boolean,
): Promise<PluginInstallResult> {
  assertProfile(dshHome, profile);
  let entry = lookupLibraryEntry(dshHome, id);
  if (!entry && !enabled) {
    entry = {
      id: id.toLowerCase(),
      spec: id,
      packageName: id,
      title: id,
      source: "installed",
      downloadedAt: new Date(0).toISOString(),
    };
  }
  if (!entry) throw new Error(t("errors.pluginLibraryMissing", { id }));
  if (pluginAliases(entry).some((name) => isProtectedPlugin(name))) {
    throw new Error(t("errors.pluginProtected", { name: entry.packageName }));
  }
  const installed = listProfilePlugins(dshHome, profile);
  const current = installed.find((item) => pluginAliases(entry).includes(item.name));
  if (enabled) {
    if (!current) {
      const before = new Set(installed.map((item) => item.name));
      await pluginAdd(dshHome, profile, addSpecFor(dshHome, entry));
      const added = listProfilePlugins(dshHome, profile).find(
        (item) => !before.has(item.name) && !item.protected,
      );
      if (added && added.name !== entry.packageName) {
        upsertLibraryEntry(dshHome, { ...entry, packageName: added.name });
      }
    }
  } else if (current) {
    await pluginRemove(dshHome, profile, current.name);
  }
  return { running: runningOf(profile) ? [profile] : [] };
}
