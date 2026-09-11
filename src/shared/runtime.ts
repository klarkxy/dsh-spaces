import type { PackageSource } from "./types";

export const DSH_RUNTIME_PACKAGE = "@deepseek-ai/dsh";
export const DSH_DEFAULT_VERSION = "0.1.5-rc.1";

/** Where the active CLI binary came from. Independent of npm dist-tags. */
export type RuntimeOrigin = "store" | "managed" | "system" | "snapshot";

export interface RuntimeRef {
  bin: string;
  version: string;
}

/**
 * Active CLI as verified from files next to the binary.
 * `current()` is sync and does not re-run `--version`; it reports a version
 * only when `package.json` beside the selected bin is readable and matches
 * the stored pointer. A missing or corrupt file is damage, not a valid current.
 * Live `--version` (exit 0) is the `selectExisting` / `install` probe.
 */
export interface RuntimeCurrent extends RuntimeRef {
  origin: RuntimeOrigin;
}

export interface InstalledRuntime {
  version: string;
  bin: string;
  dir: string;
}

export interface RuntimeInventory {
  installed: InstalledRuntime[];
  current?: RuntimeCurrent;
}

export interface RuntimeCatalogEntry {
  version: string;
  publishedAt?: string;
}

export interface RuntimeCatalog {
  versions: RuntimeCatalogEntry[];
  distTags: Record<string, string>;
}

export type { PackageSource };

/** Exact npm version. Rejects tags, ranges, paths, and shell fragments. */
export function isExactRuntimeVersion(version: string): boolean {
  if (typeof version !== "string" || version.length === 0 || version.length > 64) return false;
  if (/[\\/]/.test(version) || version.includes("..")) return false;
  if (/[\s;|&$`<>(){}[\]!#?'"*]/.test(version)) return false;
  if (version === "latest" || version === "next") return false;
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

const CHANNEL_TAGS = ["latest", "next"] as const;

/** Newest `latest` or `next` tag. Ignores stale `latest` when `next` is newer. */
export function preferredTaggedVersion(catalog: RuntimeCatalog): string | undefined {
  const tagged = new Set(
    CHANNEL_TAGS.map((tag) => catalog.distTags[tag]).filter(isExactRuntimeVersion),
  );
  if (tagged.size === 0) return undefined;
  for (const row of catalog.versions) {
    if (tagged.has(row.version)) return row.version;
  }
  const latest = catalog.distTags.latest;
  if (latest && tagged.has(latest)) return latest;
  return CHANNEL_TAGS.map((tag) => catalog.distTags[tag]).find((version) => tagged.has(version));
}
