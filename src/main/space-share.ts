import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isGitSpec } from "../shared/plugin";
import { isExactRuntimeVersion } from "../shared/runtime";
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
import { PROFILE_NAME_RE, PROTECTED_PLUGIN_PACKAGES, type InstalledPlugin } from "../shared/types";
import { listProfilePlugins } from "./plugin-ops";
import { packZip, unpackZip } from "./space-share-zip";
import { runBatch } from "../shared/batch";

const HOST_PACKAGES = new Set<string>([...PROTECTED_PLUGIN_PACKAGES, "@dsh-spaces/plugin"]);

export interface SpaceSharePorts {
  createSpace(input: { name: string; displayName: string; icon?: string }): Promise<void>;
  installPlugin(spaceId: string, spec: string): Promise<void>;
  listSpaceIds(): string[];
  dshVersion?: string | null;
  now?: () => Date;
}

export function classifyPluginSource(spec?: string): SpaceSharePluginSource {
  if (!spec) return "unknown";
  if (isGitSpec(spec)) return "git";
  if (spec.startsWith("file:") || spec.startsWith(".") || spec.includes("\\") || spec.includes("/")) return "manual";
  if (isExactRuntimeVersion(spec) || /@\d+\.\d+\.\d+/.test(spec)) return "npm";
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(spec) || spec.startsWith("@")) return "npm";
  return "unknown";
}

export function pluginToShare(plugin: InstalledPlugin): SpaceSharePlugin | null {
  if (HOST_PACKAGES.has(plugin.name)) return null;
  const requestedSpec = plugin.requestedSpec;
  const source = classifyPluginSource(requestedSpec ?? plugin.version ?? undefined);
  const installSpec =
    source === "npm" && plugin.resolvedVersion
      ? `${plugin.name}@${plugin.resolvedVersion}`
      : requestedSpec;
  return {
    packageName: plugin.name,
    requestedSpec,
    resolvedVersion: plugin.resolvedVersion ?? plugin.version ?? null,
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
}): { manifest: SpaceShareManifest; plugins: SpaceSharePlugin[]; patch?: string } {
  const plugins = input.plugins.map(pluginToShare).filter((row): row is SpaceSharePlugin => row !== null);
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
  return packZip(entries);
}

export function parseSpaceShare(archive: Buffer): {
  manifest: SpaceShareManifest;
  plugins: SpaceSharePlugin[];
  patch?: string;
} {
  const files = new Map(unpackZip(archive).map((entry) => [entry.name, entry.data]));
  const manifestRaw = files.get("manifest.json");
  const pluginsRaw = files.get("plugins.json");
  if (!manifestRaw || !pluginsRaw) throw new Error("The space share is missing manifest.json or plugins.json.");
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as SpaceShareManifest;
  if (manifest.kind !== SPACE_SHARE_KIND) throw new Error("That file is not a DSH space share.");
  if (manifest.formatVersion !== SPACE_SHARE_FORMAT_VERSION) {
    throw new Error(`Unsupported space share format ${String(manifest.formatVersion)}.`);
  }
  if (!manifest.space?.displayName) throw new Error("The space share is missing a display name.");
  const plugins = JSON.parse(pluginsRaw.toString("utf8")) as SpaceSharePlugin[];
  if (!Array.isArray(plugins)) throw new Error("The space share plugins list is invalid.");
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
  const share = buildSpaceShare({
    displayName: options.displayName || spaceId,
    icon: options.icon,
    plugins,
    patch,
    dshVersion: options.dshVersion,
    includeConfig: options.includeConfig,
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

  if (parsed.patch && options.writePatch) {
    try {
      options.writePatch(name, parsed.patch);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const pendingManual = parsed.plugins.filter((row) => row.source !== "npm" || !row.resolvedVersion);
  const npmPlugins = parsed.plugins.filter((row) => row.source === "npm" && row.resolvedVersion);
  let pluginStatus: SpaceImportResult["plugins"] = npmPlugins.length ? "completed" : pendingManual.length ? "pending-manual" : "completed";
  const batch = await runBatch(npmPlugins, async (plugin) => {
    const spec = plugin.installSpec || `${plugin.packageName}@${plugin.resolvedVersion}`;
    await ports.installPlugin(name, spec);
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
  };
}

export function writeSpaceArchiveFile(path: string, archive: Buffer): void {
  writeFileSync(path, archive);
}

export function readSpaceArchiveFile(path: string): Buffer {
  return readFileSync(path);
}
