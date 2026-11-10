import { parseSpaceBaseSelection, type SpaceBaseSelection } from '../../../shared/space-base';
import { ProfileRegistry } from '../profile/profile-registry';
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isGitSpec } from "../../../shared/plugin";
import { isExactRuntimeVersion } from "../../../shared/runtime";
import { FULL_SPACES_PACKAGE } from "../../../shared/plugin-spec";
import {
  SPACE_SHARE_FORMAT_VERSION,
  SPACE_SHARE_KIND,
  type SpaceExportOptions,
  type SpaceShareManifest,
  type SpaceSharePlugin,
  type SpaceSharePluginSource,
  type SpaceSharePreview,
} from "../../../shared/space-share";
import { MAX_WORKBENCH_SHARE_BYTES } from "../../../shared/workbench-product";
import { assertShareSecretFree } from "../../../shared/share-secret-scan";
import {
  isNpmRangeOrExact,
  isSafeNpmPackageName,
} from "../../../core/application/space-recipe";
import {
  PROTECTED_PLUGIN_PACKAGES,
  type InstalledPlugin,
  type PluginLibraryEntry,
} from "../../../shared/types";
import { listProfilePlugins, parseNpmNameAndVersion } from "./plugin-ops";
import { isHubPluginArchive, readPluginLibrary } from "./plugin-library";
import { packZip, unpackZip } from "./space-share-zip";
import { COMPONENT_PAYLOAD_PACKAGES } from "../payload/component-payload";
import { RETIRED_LLM_BRIDGE } from "../profile/profile-component-alignment";

const HOST_PACKAGES = new Set<string>([
  ...PROTECTED_PLUGIN_PACKAGES,
  FULL_SPACES_PACKAGE,
  // An older space keeps the retired bridge until its next start removes it.
  RETIRED_LLM_BRIDGE,
  ...Object.entries(COMPONENT_PAYLOAD_PACKAGES).filter(([component]) => component !== "browser").map(([, name]) => name),
]);
const SHARE_SOURCES = new Set<SpaceSharePluginSource>(["npm", "git", "manual", "unknown"]);

export { canonicalNpmInstallSpec, isNpmRangeOrExact, isSafeNpmPackageName, validateImportedPatch } from "../../../core/application/space-recipe";

export interface SpaceSharePorts {
  createSpace(input: { name: string; displayName: string; icon?: string } & SpaceBaseSelection): Promise<void>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  listSpaceIds(): string[];
  dshVersion?: string | null;
  base?: SpaceBaseSelection["base"];
  baseVersion?: string;
  now?: () => Date;
}

export interface PluginShareContext {
  library?: PluginLibraryEntry[];
  dshHome?: string;
  spaceId?: string;
}

export function classifyPluginSource(spec?: string): SpaceSharePluginSource {
  if (!spec) return "unknown";
  const trimmed = spec.trim();
  if (isGitSpec(trimmed)) return "git";
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

/** Only public npm/GitHub coordinates belong in a portable recipe. */
function portableRequestedSpec(spec: string | undefined, source: SpaceSharePluginSource): string | undefined {
  if (!spec) return undefined;
  const value = spec.trim();
  if (value.length > 214 || value.includes("..")) return undefined;
  if (classifyPluginSource(value) === "npm") return value;
  if (
    source === "git" &&
    /^github:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:#[A-Za-z0-9][A-Za-z0-9._/-]{0,127})?$/.test(value)
  ) return value;
  return undefined;
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
    requestedSpec: portableRequestedSpec(requestedSpec, source),
    resolvedVersion: resolved,
    source,
    installSpec: portableRequestedSpec(installSpec, source),
  };
}

export function buildSpaceShare(input: {
  displayName: string;
  icon?: string;
  plugins: InstalledPlugin[];
  patch?: string | null;
  dshVersion?: string | null;
  base?: SpaceBaseSelection["base"];
  baseVersion?: string;
  includeConfig?: boolean;
  now?: Date;
  library?: PluginLibraryEntry[];
  dshHome?: string;
  spaceId?: string;

}): { manifest: SpaceShareManifest; plugins: SpaceSharePlugin[]; patch?: string } {
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
      source: { ...parseSpaceBaseSelection(input), dshVersion: input.dshVersion ?? null },
      space: { displayName: input.displayName, icon: input.icon },
    },
    plugins,
    patch: input.includeConfig && input.patch ? input.patch : undefined,
  };
}

export function packSpaceShare(share: {
  manifest: SpaceShareManifest;
  plugins: SpaceSharePlugin[];
  patch?: string;

}): Buffer {
  const entries = [
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest, null, 2)}\n`) },
    { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins, null, 2)}\n`) },
  ];
  if (share.patch) {
    entries.push({ name: "profile.patch.yml", data: Buffer.from(share.patch) });
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
    source: { ...parseSpaceBaseSelection(row.source as SpaceBaseSelection), dshVersion: typeof dshVersion === "string" ? dshVersion : null },
    space: {
      displayName: space.displayName,
      icon: typeof space.icon === "string" ? space.icon : undefined,
    },
  };
}

export function assertSafeShareArchive(archive: Buffer, maxBytes = MAX_WORKBENCH_SHARE_BYTES): void {
  readSafeShareArchive(archive, maxBytes);
}

function readSafeShareArchive(archive: Buffer, maxBytes = MAX_WORKBENCH_SHARE_BYTES) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) {
    throw new Error("The space share archive is not a zip.");
  }
  if (archive.length > maxBytes) {
    throw new Error("The space share archive is too large.");
  }
  const unpacked = unpackZip(archive, maxBytes);
  let total = 0;
  for (const entry of unpacked) {
    const name = entry.name.replaceAll("\\", "/");
    if (
      !name ||
      name.includes("\0") ||
      name.startsWith("/") ||
      name.includes("..") ||
      name.includes("/") ||
      /^[A-Za-z]:/.test(name)
    ) {
      throw new Error("The space share archive contains an unsafe path.");
    }
    if (entry.data.length > maxBytes) {
      throw new Error("The space share archive contains an entry that is too large.");
    }
    total += entry.data.length;
    if (total > maxBytes) {
      throw new Error("The space share archive is too large.");
    }
  }
  return unpacked;
}

export function parseSpaceShare(archive: Buffer): {
  manifest: SpaceShareManifest;
  plugins: SpaceSharePlugin[];
  patch?: string;

} {
  const unpacked = readSafeShareArchive(archive);
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
  return { manifest, plugins, patch };
}

export function previewSpaceShare(archive: Buffer): SpaceSharePreview {
  const parsed = parseSpaceShare(archive);
  return {
    manifest: parsed.manifest,
    plugins: parsed.plugins,
    hasConfig: Boolean(parsed.patch),
    unknownSources: parsed.plugins.filter((row) => row.source === "unknown" || row.source === "manual" || row.source === "git").map((row) => row.packageName),
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
  const meta = new ProfileRegistry(dshHome).readSpaces().meta[spaceId];
  const share = buildSpaceShare({
    ...parseSpaceBaseSelection(meta ?? {}),
    displayName: options.displayName || spaceId,
    icon: options.icon,
    plugins,
    patch,
    dshVersion: options.dshVersion,
    includeConfig: options.includeConfig,
    library: readPluginLibrary(dshHome),
    dshHome,
    spaceId,
  });
  return packSpaceShare(share);
}



