import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyIsolationPatch, patchTextLooksIsolated } from "../core/domain/isolation";
import { isGitSpec } from "../shared/plugin";
import { isExactRuntimeVersion } from "../shared/runtime";
import { FULL_SPACES_PACKAGE, isFullSpacesManagerSpec } from "../shared/desktop-controller";
import {
  SPACE_SHARE_FORMAT_VERSION,
  SPACE_SHARE_KIND,
  type SpaceExportOptions,
  type SpaceImportResult,
  type SpaceShareManifest,
  type SpaceSharePlugin,
  type SpaceSharePluginSource,
  type SpaceSharePreview,
} from "../shared/space-share";
import {
  LLM_SHARE_FILENAME,
  assertShareSecretFree,
  parseLlmShareManifest,
  type LlmShareManifest,
} from "../core/domain/llm-share";
import {
  PROFILE_NAME_RE,
  PROTECTED_PLUGIN_PACKAGES,
  type InstalledPlugin,
  type PluginLibraryEntry,
} from "../shared/types";
import { listProfilePlugins, parseNpmNameAndVersion } from "./plugin-ops";
import { isHubPluginArchive, readPluginLibrary } from "./plugin-library";
import { packZip, unpackZip } from "./space-share-zip";
import { runBatch } from "../shared/batch";

const HOST_PACKAGES = new Set<string>([...PROTECTED_PLUGIN_PACKAGES, FULL_SPACES_PACKAGE]);
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const NPM_RANGE_RE = /^[~^=]?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/;
const SHARE_SOURCES = new Set<SpaceSharePluginSource>(["npm", "git", "manual", "unknown"]);

export interface SpaceSharePorts {
  createSpace(input: { name: string; displayName: string; icon?: string }): Promise<void>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  listSpaceIds(): string[];
  dshVersion?: string | null;
  now?: () => Date;
  writeLlmShare?(spaceId: string, manifest: LlmShareManifest): Promise<void> | void;
}

export interface PluginShareContext {
  library?: PluginLibraryEntry[];
  dshHome?: string;
  spaceId?: string;
}

export function isSafeNpmPackageName(name: string): boolean {
  if (!name || name.length > 214) return false;
  if (name.startsWith(".") || name.startsWith("_")) return false;
  return NPM_NAME_RE.test(name);
}

export function isNpmRangeOrExact(spec: string): boolean {
  return NPM_RANGE_RE.test(spec.trim());
}

export function canonicalNpmInstallSpec(plugin: SpaceSharePlugin): string | null {
  if (!isSafeNpmPackageName(plugin.packageName)) return null;
  if (HOST_PACKAGES.has(plugin.packageName) || isFullSpacesManagerSpec(plugin.packageName)) return null;
  if (plugin.source !== "npm") return null;
  const version = plugin.resolvedVersion;
  if (!version || !isExactRuntimeVersion(version)) return null;
  const expected = `${plugin.packageName}@${version}`;
  if (plugin.installSpec && plugin.installSpec !== expected) return null;
  return expected;
}

export function classifyPluginSource(spec?: string): SpaceSharePluginSource {
  if (!spec) return "unknown";
  if (isGitSpec(spec)) return "git";
  const trimmed = spec.trim();
  if (isExactRuntimeVersion(trimmed) || isNpmRangeOrExact(trimmed) || isSafeNpmPackageName(trimmed)) {
    return "npm";
  }
  const versionAt = trimmed.startsWith("@") ? trimmed.indexOf("@", 1) : trimmed.lastIndexOf("@");
  if (
    versionAt > 0 &&
    isSafeNpmPackageName(trimmed.slice(0, versionAt)) &&
    isNpmRangeOrExact(trimmed.slice(versionAt + 1))
  ) {
    return "npm";
  }
  if (spec.startsWith("file:") || spec.startsWith(".") || spec.includes("\\") || spec.includes("/")) return "manual";
  return "unknown";
}

function looksLikeHubCacheSpec(spec: string): boolean {
  const lower = spec.replaceAll("\\", "/").toLowerCase();
  return /(?:^|\/)hub\/plugins\/[^/]+\.(?:tgz|tar\.gz)$/.test(lower);
}

function hubFileProvesNpm(
  spec: string,
  packageName: string,
  version: string,
  context: PluginShareContext,
): boolean {
  if (!looksLikeHubCacheSpec(spec)) return false;
  if (!context.library || !context.dshHome || !context.spaceId) return false;
  const raw = spec.trim().replace(/^file:/i, "").replace(/^"|"$/g, "");
  const abs = resolve(context.dshHome, "profiles", context.spaceId, raw);
  if (!isHubPluginArchive(context.dshHome, abs)) return false;
  return context.library.some((entry) => {
    if (entry.packageName !== packageName || !entry.tarball) return false;
    if (resolve(context.dshHome!, entry.tarball) !== abs) return false;
    const parsed = parseNpmNameAndVersion(entry.spec);
    return parsed?.name === packageName && parsed.version === version;
  });
}

export function pluginToShare(
  plugin: InstalledPlugin,
  context: PluginShareContext = {},
): SpaceSharePlugin | null {
  if (HOST_PACKAGES.has(plugin.name) || plugin.protected) return null;
  const requestedSpec = plugin.requestedSpec;
  const resolved =
    plugin.resolvedVersion && isExactRuntimeVersion(plugin.resolvedVersion)
      ? plugin.resolvedVersion
      : null;
  let source = classifyPluginSource(requestedSpec ?? plugin.version ?? undefined);
  let installSpec = requestedSpec;
  if (resolved && requestedSpec && isNpmRangeOrExact(requestedSpec)) {
    source = "npm";
    installSpec = `${plugin.name}@${resolved}`;
  } else if (
    resolved &&
    requestedSpec &&
    hubFileProvesNpm(requestedSpec, plugin.name, resolved, context)
  ) {
    source = "npm";
    installSpec = `${plugin.name}@${resolved}`;
  } else if (source === "npm" && resolved) {
    installSpec = `${plugin.name}@${resolved}`;
  }
  return {
    packageName: plugin.name,
    requestedSpec,
    resolvedVersion: resolved ?? plugin.resolvedVersion ?? null,
    source,
    installSpec,
  };
}

export function buildSpaceShare(input: {
  displayName: string;
  icon?: string;
  plugins: InstalledPlugin[];
  patch?: string | null;
  dshVersion?: string | null;
  includeConfig?: boolean;
  now?: Date;
  library?: PluginLibraryEntry[];
  dshHome?: string;
  spaceId?: string;
  llm?: LlmShareManifest;
}): { manifest: SpaceShareManifest; plugins: SpaceSharePlugin[]; patch?: string; llm?: LlmShareManifest } {
  const context: PluginShareContext = {
    library: input.library,
    dshHome: input.dshHome,
    spaceId: input.spaceId,
  };
  const plugins = input.plugins
    .map((plugin) => pluginToShare(plugin, context))
    .filter((row): row is SpaceSharePlugin => row !== null);
  return {
    manifest: {
      formatVersion: SPACE_SHARE_FORMAT_VERSION,
      kind: SPACE_SHARE_KIND,
      exportedAt: (input.now ?? new Date()).toISOString(),
      source: { dshVersion: input.dshVersion ?? null },
      space: { displayName: input.displayName, icon: input.icon },
    },
    plugins,
    patch: input.includeConfig && input.patch ? input.patch : undefined,
    llm: input.llm,
  };
}

export function packSpaceShare(share: {
  manifest: SpaceShareManifest;
  plugins: SpaceSharePlugin[];
  patch?: string;
  llm?: LlmShareManifest;
}): Buffer {
  const entries = [
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest, null, 2)}\n`) },
    { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins, null, 2)}\n`) },
  ];
  if (share.patch) {
    entries.push({ name: "profile.patch.yml", data: Buffer.from(share.patch) });
  }
  if (share.llm) {
    entries.push({
      name: LLM_SHARE_FILENAME,
      data: Buffer.from(`${JSON.stringify(share.llm, null, 2)}\n`),
    });
  }
  assertShareSecretFree(entries);
  return packZip(entries);
}

function assertSharePlugin(value: unknown, index: number): SpaceSharePlugin {
  if (!value || typeof value !== "object") {
    throw new Error(`The space share plugins list is invalid at index ${index}.`);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.packageName !== "string" || !row.packageName.trim()) {
    throw new Error(`The space share plugin at index ${index} is missing packageName.`);
  }
  if (
    row.resolvedVersion !== null &&
    row.resolvedVersion !== undefined &&
    typeof row.resolvedVersion !== "string"
  ) {
    throw new Error(`The space share plugin at index ${index} has an invalid resolvedVersion.`);
  }
  if (typeof row.source !== "string" || !SHARE_SOURCES.has(row.source as SpaceSharePluginSource)) {
    throw new Error(`The space share plugin at index ${index} has an invalid source.`);
  }
  if (row.installSpec !== undefined && typeof row.installSpec !== "string") {
    throw new Error(`The space share plugin at index ${index} has an invalid installSpec.`);
  }
  if (row.requestedSpec !== undefined && typeof row.requestedSpec !== "string") {
    throw new Error(`The space share plugin at index ${index} has an invalid requestedSpec.`);
  }
  return {
    packageName: row.packageName,
    requestedSpec: typeof row.requestedSpec === "string" ? row.requestedSpec : undefined,
    resolvedVersion: typeof row.resolvedVersion === "string" ? row.resolvedVersion : null,
    source: row.source as SpaceSharePluginSource,
    installSpec: typeof row.installSpec === "string" ? row.installSpec : undefined,
  };
}

function assertShareManifest(value: unknown): SpaceShareManifest {
  if (!value || typeof value !== "object") {
    throw new Error("The space share manifest is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (row.kind !== SPACE_SHARE_KIND) throw new Error("That file is not a DSH space share.");
  if (row.formatVersion !== SPACE_SHARE_FORMAT_VERSION) {
    throw new Error(`Unsupported space share format ${String(row.formatVersion)}.`);
  }
  if (!row.space || typeof row.space !== "object") {
    throw new Error("The space share is missing a display name.");
  }
  const space = row.space as Record<string, unknown>;
  if (typeof space.displayName !== "string" || !space.displayName.trim()) {
    throw new Error("The space share is missing a display name.");
  }
  if (space.icon !== undefined && typeof space.icon !== "string") {
    throw new Error("The space share has an invalid icon.");
  }
  if (typeof row.exportedAt !== "string") {
    throw new Error("The space share has an invalid export timestamp.");
  }
  if (!row.source || typeof row.source !== "object") {
    throw new Error("The space share has invalid source metadata.");
  }
  const dshVersion = (row.source as Record<string, unknown>).dshVersion;
  if (dshVersion !== undefined && dshVersion !== null && typeof dshVersion !== "string") {
    throw new Error("The space share has an invalid DSH version.");
  }
  return {
    formatVersion: SPACE_SHARE_FORMAT_VERSION,
    kind: SPACE_SHARE_KIND,
    exportedAt: row.exportedAt,
    source: { dshVersion: typeof dshVersion === "string" ? dshVersion : null },
    space: {
      displayName: space.displayName,
      icon: typeof space.icon === "string" ? space.icon : undefined,
    },
  };
}

export function parseSpaceShare(archive: Buffer): {
  manifest: SpaceShareManifest;
  plugins: SpaceSharePlugin[];
  patch?: string;
  llm?: LlmShareManifest;
} {
  const unpacked = unpackZip(archive);
  assertShareSecretFree(unpacked);
  const files = new Map(unpacked.map((entry) => [entry.name, entry.data]));
  const manifestRaw = files.get("manifest.json");
  const pluginsRaw = files.get("plugins.json");
  if (!manifestRaw || !pluginsRaw) throw new Error("The space share is missing manifest.json or plugins.json.");
  const manifest = assertShareManifest(JSON.parse(manifestRaw.toString("utf8")) as unknown);
  const pluginsJson = JSON.parse(pluginsRaw.toString("utf8")) as unknown;
  if (!Array.isArray(pluginsJson)) throw new Error("The space share plugins list is invalid.");
  const plugins = pluginsJson.map((row, index) => assertSharePlugin(row, index));
  const patch = files.get("profile.patch.yml")?.toString("utf8");
  const llmRaw = files.get(LLM_SHARE_FILENAME);
  const llm = llmRaw ? parseLlmShareManifest(JSON.parse(llmRaw.toString("utf8")) as unknown) : undefined;
  return { manifest, plugins, patch, llm };
}

export function validateImportedPatch(patch: string, spaceId: string): string {
  if (spaceId === "web") throw new Error("The web space cannot be imported onto.");
  const applied = applyIsolationPatch(patch, spaceId, "profile.patch.yml");
  if (!patchTextLooksIsolated(applied, spaceId)) {
    throw new Error("The imported config does not isolate this space.");
  }
  if (/dshHomePath\s*\(\s*['"][^'"]*\.\./i.test(applied)) {
    throw new Error("The imported config contains a path that is not allowed.");
  }
  if (/(?:hub|profiles)\/web\b/i.test(applied) && spaceId !== "web") {
    throw new Error("The imported config points at the web space.");
  }
  return applied;
}

export function previewSpaceShare(archive: Buffer): SpaceSharePreview {
  const parsed = parseSpaceShare(archive);
  return {
    manifest: parsed.manifest,
    plugins: parsed.plugins,
    hasConfig: Boolean(parsed.patch),
    unknownSources: parsed.plugins.filter((row) => row.source === "unknown" || row.source === "manual" || row.source === "git").map((row) => row.packageName),
    llmMappingRequired: Boolean(parsed.llm && parsed.llm.requirements.length > 0),
    llmRequirements: parsed.llm?.requirements ?? [],
  };
}

export function exportSpaceArchive(
  dshHome: string,
  spaceId: string,
  options: SpaceExportOptions & { displayName?: string; icon?: string; dshVersion?: string | null } = {},
): Buffer {
  if (spaceId === "web") throw new Error("The web space cannot be exported.");
  const plugins = listProfilePlugins(dshHome, spaceId);
  const patchPath = join(dshHome, "profiles", spaceId, "cordis.patch.yml");
  const patch = options.includeConfig && existsSync(patchPath) ? readFileSync(patchPath, "utf8") : null;
  const share = buildSpaceShare({
    displayName: options.displayName || spaceId,
    icon: options.icon,
    plugins,
    patch,
    dshVersion: options.dshVersion,
    includeConfig: options.includeConfig,
    library: readPluginLibrary(dshHome),
    dshHome,
    spaceId,
    llm: options.llm,
  });
  return packSpaceShare(share);
}

export function uniqueSpaceName(displayName: string, taken: string[]): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "space";
  const slug = PROFILE_NAME_RE.test(base) ? base : `space-${base.replace(/[^a-z0-9]/g, "").slice(0, 24) || "import"}`;
  const used = new Set(taken);
  if (!used.has(slug) && slug !== "web" && slug !== "hub") return slug;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${slug.slice(0, 36)}-${i}`.slice(0, 39);
    if (!used.has(candidate) && PROFILE_NAME_RE.test(candidate)) return candidate;
  }
  throw new Error("Could not allocate a space name.");
}

export async function importSpaceArchive(
  archive: Buffer,
  ports: SpaceSharePorts,
  options: { writePatch?: (spaceId: string, patch: string) => void } = {},
): Promise<SpaceImportResult> {
  const errors: string[] = [];
  let parsed: ReturnType<typeof parseSpaceShare>;
  try {
    parsed = parseSpaceShare(archive);
  } catch (error) {
    return {
      definition: "failed",
      plugins: "not-run",
      start: "not-run",
      errors: [error instanceof Error ? error.message : String(error)],
      pendingManual: [],
    };
  }

  const name = uniqueSpaceName(parsed.manifest.space.displayName, ports.listSpaceIds());
  let isolatedPatch: string | undefined;
  if (parsed.patch) {
    try {
      isolatedPatch = validateImportedPatch(parsed.patch, name);
    } catch (error) {
      return {
        definition: "failed",
        plugins: "not-run",
        start: "not-run",
        errors: [error instanceof Error ? error.message : String(error)],
        pendingManual: [],
      };
    }
  }

  try {
    await ports.createSpace({
      name,
      displayName: parsed.manifest.space.displayName,
      icon: parsed.manifest.space.icon,
    });
  } catch (error) {
    return {
      definition: "failed",
      plugins: "not-run",
      start: "not-run",
      errors: [error instanceof Error ? error.message : String(error)],
      pendingManual: [],
    };
  }

  if (isolatedPatch && options.writePatch) {
    try {
      options.writePatch(name, isolatedPatch);
    } catch (error) {
      return {
        definition: "imported",
        plugins: "not-run",
        start: "not-run",
        spaceId: name,
        errors: [error instanceof Error ? error.message : String(error)],
        pendingManual: [],
        llm: llmImportResult(parsed.llm),
      };
    }
  }

  if (parsed.llm && ports.writeLlmShare) {
    try {
      await ports.writeLlmShare(name, parsed.llm);
    } catch (error) {
      return {
        definition: "imported",
        plugins: "not-run",
        start: "not-run",
        spaceId: name,
        errors: [error instanceof Error ? error.message : String(error)],
        pendingManual: [],
        llm: llmImportResult(parsed.llm),
      };
    }
  }

  const auto: { plugin: SpaceSharePlugin; spec: string }[] = [];
  const pendingManual: SpaceSharePlugin[] = [];
  for (const plugin of parsed.plugins) {
    const spec = canonicalNpmInstallSpec(plugin);
    if (spec) auto.push({ plugin, spec });
    else pendingManual.push(plugin);
  }
  let pluginStatus: SpaceImportResult["plugins"] = auto.length
    ? "completed"
    : pendingManual.length
      ? "pending-manual"
      : "completed";
  const batch = await runBatch(auto, async (row) => {
    await ports.installPlugin(name, row.spec);
  });
  if (batch.failed) {
    errors.push(batch.failed.error);
    pluginStatus = "failed";
  } else if (pendingManual.length) pluginStatus = "pending-manual";

  return {
    definition: "imported",
    plugins: pluginStatus,
    start: "not-run",
    spaceId: name,
    errors,
    pendingManual,
    llm: llmImportResult(parsed.llm),
  };
}

function llmImportResult(manifest: LlmShareManifest | undefined): SpaceImportResult["llm"] {
  if (!manifest || manifest.requirements.length === 0) return undefined;
  return {
    mappingRequired: true,
    requirements: manifest.requirements,
    mapped: false,
  };
}

export function writeSpaceArchiveFile(path: string, archive: Buffer): void {
  writeFileSync(path, archive);
}

export function readSpaceArchiveFile(path: string): Buffer {
  return readFileSync(path);
}
