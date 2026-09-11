import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { t } from "../shared/i18n";
import {
  PROTECTED_PLUGIN_PACKAGES,
  type InstalledPlugin,
  type PluginDownloadRequest,
  type PluginInstallResult,
  type PluginLibraryEntry,
} from "../shared/types";
import { enqueuePlugin, runDsh } from "./dsh-cli";
import { assertNotRealHome } from "./home-guard";
import { npmPackumentUrl } from "./package-source";
import { isGitSpec, isInstallableEntry, isSafeSpec, pluginAliases } from "../shared/plugin";
import { lookupCatalogEntry } from "./plugin-catalog";
import {
  archiveAbsPath,
  archiveRelPath,
  isHubPluginArchive,
  lookupLibraryEntry,
  removeLibraryEntry,
  spacesUsingPlugin,
  syncLibraryFromProfiles,
  upsertLibraryEntry,
} from "./plugin-library";
import { currentPackageSource, npmCliJs, nodeExecutable, runProcess, toolchainEnv } from "./toolchain";

const PROTECTED = new Set<string>(PROTECTED_PLUGIN_PACKAGES);
const PLUGIN_TIMEOUT_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export type PluginFetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

export type GitPacker = (spec: string, destFile: string) => Promise<void>;

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
    list.push({
      name: bundle,
      version: deps[bundle],
      protected: isProtectedPlugin(bundle),
    });
  }
  for (const [dep, version] of Object.entries(deps)) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    list.push({ name: dep, version, protected: isProtectedPlugin(dep) });
  }
  return list;
}

function pluginError(spec: string, code: number, stdout: string, stderr: string): Error {
  const detail = (stderr || stdout).slice(0, 800);
  const allowBuilds = /allowBuilds|prepare|ignored/i.test(detail)
    ? t("errors.pluginAllowBuilds")
    : "";
  return new Error(
    `${t("errors.pluginAddFailed", { spec, code, detail })}${allowBuilds ? `\n${allowBuilds}` : ""}`,
  );
}

function addableSpec(dshHome: string, spec: string): string {
  if (isHubPluginArchive(dshHome, spec)) return spec;
  if (isSafeSpec(spec)) return spec;
  throw new Error(t("errors.pluginSpecInvalid", { spec }));
}

export async function pluginAdd(dshHome: string, name: string, spec: string): Promise<void> {
  assertProfile(dshHome, name);
  const target = addableSpec(dshHome, spec);
  await enqueuePlugin(t("queue.pluginAddSpec", { name, spec: target }), async () => {
    const { stdout, stderr, code } = await runDsh(
      dshHome,
      ["plugin", "--profile", name, "add", target],
      { timeoutMs: PLUGIN_TIMEOUT_MS },
    );
    if (code !== 0) throw pluginError(target, code, stdout, stderr);
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
  await enqueuePlugin(t("queue.pluginRemove", { name, spec: packageName }), async () => {
    const { stdout, stderr, code } = await runDsh(
      dshHome,
      ["plugin", "--profile", name, "remove", packageName],
      { timeoutMs: PLUGIN_TIMEOUT_MS },
    );
    if (code !== 0) {
      throw new Error(
        t("errors.pluginRemoveFailed", {
          spec: packageName,
          code,
          detail: (stderr || stdout).slice(0, 800),
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

export async function installPluginToProfiles(
  dshHome: string,
  profiles: string[],
  spec: string,
  runningOf: (name: string) => boolean,
): Promise<PluginInstallResult> {
  if (profiles.length === 0) {
    throw new Error(t("errors.pluginNeedTarget"));
  }
  const unique = [...new Set(profiles)];
  for (const name of unique) {
    await pluginAdd(dshHome, name, spec);
  }
  return { running: unique.filter(runningOf) };
}

export function listPluginLibrary(
  dshHome: string,
  profileNames: string[],
): PluginLibraryEntry[] {
  return syncLibraryFromProfiles(dshHome, listAllProfilePlugins(dshHome, profileNames));
}

function defaultFetcher(): PluginFetcher {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      return await fetch(url, { headers: init?.headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
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

function npmPackageName(spec: string): string {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 0) return spec;
    const scope = spec.slice(0, slash);
    const rest = spec.slice(slash + 1).split("@")[0];
    return rest ? `${scope}/${rest}` : spec;
  }
  return spec.split("@")[0] || spec;
}

async function downloadNpmTarball(
  spec: string,
  destFile: string,
  fetchImpl: PluginFetcher,
): Promise<{ packageName: string }> {
  const name = npmPackageName(spec);
  const url = npmPackumentUrl(currentPackageSource(), name);
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(t("errors.pluginDownloadFailed", { spec, detail: `HTTP ${response.status}` }));
  }
  const packument = (await response.json()) as {
    name?: unknown;
    "dist-tags"?: { latest?: string };
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const latest = packument["dist-tags"]?.latest;
  const tarball = latest ? packument.versions?.[latest]?.dist?.tarball : undefined;
  const packageName = typeof packument.name === "string" && packument.name ? packument.name : name;
  if (!tarball) {
    throw new Error(t("errors.pluginDownloadFailed", { spec, detail: "missing tarball" }));
  }
  const packed = await fetchImpl(rewriteTarballUrl(tarball));
  if (!packed.ok) {
    throw new Error(t("errors.pluginDownloadFailed", { spec, detail: `HTTP ${packed.status}` }));
  }
  const bytes = Buffer.from(await packed.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error(t("errors.pluginDownloadFailed", { spec, detail: "empty tarball" }));
  }
  await writeAtomicBin(destFile, bytes);
  return { packageName };
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

function resolveDownloadMeta(
  dshHome: string,
  request: PluginDownloadRequest,
): { id: string; spec: string; packageName: string; title: string; catalogId?: string; source: PluginLibraryEntry["source"] } {
  if (request.catalogId) {
    const entry = lookupCatalogEntry(dshHome, request.catalogId);
    if (!entry) throw new Error(t("errors.pluginCatalogMissing", { id: request.catalogId }));
    if (!isInstallableEntry(entry) || !entry.installSpec) {
      throw new Error(t("errors.pluginNotInstallable", { id: request.catalogId }));
    }
    const spec = entry.installSpec;
    const packageName = entry.packageName || spec.replace(/^github:[^/]+\//, "");
    return {
      id: entry.id,
      spec,
      packageName,
      title: entry.packageName || entry.repo,
      catalogId: entry.id,
      source: "catalog",
    };
  }
  const spec = request.spec?.trim() ?? "";
  if (!isSafeSpec(spec)) throw new Error(t("errors.pluginSpecInvalid", { spec }));
  return {
    id: spec.toLowerCase(),
    spec,
    packageName: spec.replace(/^github:[^/]+\//, ""),
    title: spec.replace(/^github:[^/]+\//, ""),
    source: "manual",
  };
}

export async function downloadPlugin(
  dshHome: string,
  request: PluginDownloadRequest,
  options: { fetchImpl?: PluginFetcher; packGit?: GitPacker } = {},
): Promise<PluginLibraryEntry> {
  assertNotRealHome(dshHome);
  const meta = resolveDownloadMeta(dshHome, request);
  const existing = lookupLibraryEntry(dshHome, meta.id);
  const dest = archiveAbsPath(dshHome, meta.id);
  if (existing?.tarball && existsSync(resolve(dshHome, existing.tarball))) {
    return existing;
  }
  await enqueuePlugin(t("queue.pluginDownload", { spec: meta.spec }), async () => {
    if (isGitSpec(meta.spec)) {
      const pack = options.packGit ?? defaultGitPacker;
      await pack(meta.spec, dest);
    } else {
      const fetched = await downloadNpmTarball(meta.spec, dest, options.fetchImpl ?? defaultFetcher());
      if (fetched.packageName) meta.packageName = fetched.packageName;
    }
    if (!existsSync(dest)) {
      throw new Error(t("errors.pluginDownloadFailed", { spec: meta.spec, detail: "no file" }));
    }
  });
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
  upsertLibraryEntry(dshHome, entry);
  return entry;
}

export async function removeDownloadedPlugin(
  dshHome: string,
  id: string,
  profileNames: string[],
): Promise<PluginLibraryEntry[]> {
  assertNotRealHome(dshHome);
  const entry = lookupLibraryEntry(dshHome, id);
  if (!entry) throw new Error(t("errors.pluginLibraryMissing", { id }));
  const used = spacesUsingPlugin(listAllProfilePlugins(dshHome, profileNames), entry);
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
