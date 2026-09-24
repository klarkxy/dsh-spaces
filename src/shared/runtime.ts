import type { PackageSource } from "./types";

export const DSH_RUNTIME_PACKAGE = "@deepseek-ai/dsh";
/** Default for a new installation; existing selected runtimes keep their version. */
export const DSH_DEFAULT_VERSION = "0.1.7-alpha.1";
/** Official stable channel used when browsing the runtime catalog. */
export const DSH_DEFAULT_CHANNEL = "latest";

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

/** Exact version currently published as the official `latest` dist-tag. */
export function preferredTaggedVersion(catalog: RuntimeCatalog): string | undefined {
  const latest = catalog.distTags[DSH_DEFAULT_CHANNEL];
  return latest && isExactRuntimeVersion(latest) ? latest : undefined;
}
