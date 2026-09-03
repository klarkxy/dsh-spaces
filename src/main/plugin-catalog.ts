import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import seedJson from "./seed-plugin-catalog.json" with { type: "json" };
import {
  DEFAULT_PLUGIN_CATALOG_URL,
  PLUGIN_CATALOG_SCHEMA_VERSION,
  type PluginCatalogEntry,
  type PluginCatalogMeta,
  type PluginCatalogSnapshot,
  type PluginInstallMethod,
  type PluginTier,
} from "../shared/types";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";
import { parseCatalogUrl } from "./hub-settings";

export const CATALOG_CACHE_FILE = "plugin-catalog.json";
export const CATALOG_ETAG_FILE = "plugin-catalog.etag";

const TIERS = new Set<PluginTier>([
  "verified-npm",
  "verified-git",
  "likely-plugin",
  "related",
]);

const METHODS = new Set<PluginInstallMethod>(["npm", "git", "manual"]);

export type CatalogFetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export function isCompatibleCatalog(meta: PluginCatalogMeta): boolean {
  return Number.isFinite(meta.schemaVersion) && meta.schemaVersion <= PLUGIN_CATALOG_SCHEMA_VERSION;
}

export { isInstallableEntry, isSafeSpec } from "../shared/plugin";

export function resolveCatalogUrl(override?: string): string {
  return parseCatalogUrl(override) || DEFAULT_PLUGIN_CATALOG_URL;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function parseMeta(value: unknown): PluginCatalogMeta {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const schemaVersion = Number(row.schemaVersion);
  return {
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : Number.POSITIVE_INFINITY,
    generatedAt: text(row.generatedAt) ?? "",
    count: num(row.count),
    contentHash: text(row.contentHash) ?? "",
  };
}

function parseEntry(value: unknown): PluginCatalogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = text(row.id)?.toLowerCase();
  const repo = text(row.repo);
  const owner = text(row.owner);
  const url = text(row.url);
  const tier = text(row.tier);
  const installMethod = text(row.installMethod);
  if (!id || !repo || !owner || !url || !tier || !TIERS.has(tier as PluginTier)) return undefined;
  const method: PluginInstallMethod = METHODS.has(installMethod as PluginInstallMethod)
    ? (installMethod as PluginInstallMethod)
    : "manual";
  const installSpec = text(row.installSpec);
  return {
    id,
    repo,
    owner,
    url,
    tier: tier as PluginTier,
    packageName: text(row.packageName),
    installMethod: method,
    installSpec,
    runsBuildScript: row.runsBuildScript === true,
    description: text(row.description) ?? "",
    summary: text(row.summary),
    summaryEn: text(row.summaryEn),
    category: text(row.category),
    tags: strings(row.tags),
    stars: num(row.stars),
    license: text(row.license),
    hasClient: row.hasClient === true,
  };
}

export function parseCatalog(value: unknown): { meta: PluginCatalogMeta; entries: PluginCatalogEntry[] } {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const meta = parseMeta(row.meta);
  if (!isCompatibleCatalog(meta)) {
    throw new Error(`unsupported plugin catalog schema ${meta.schemaVersion}`);
  }
  const raw = Array.isArray(row.entries) ? row.entries : [];
  const unique = new Map<string, PluginCatalogEntry>();
  for (const item of raw) {
    const entry = parseEntry(item);
    if (entry && !unique.has(entry.id)) unique.set(entry.id, entry);
  }
  return {
    meta: { ...meta, count: unique.size },
    entries: [...unique.values()],
  };
}

export function seedCatalog(): { meta: PluginCatalogMeta; entries: PluginCatalogEntry[] } {
  return parseCatalog(seedJson);
}

export function lookupCatalogEntry(dshHome: string, id: string): PluginCatalogEntry | undefined {
  const key = id.trim().toLowerCase();
  const cached = readCachedCatalog(dshHome);
  const hit = cached?.entries.find((entry) => entry.id === key);
  if (hit) return hit;
  return seedCatalog().entries.find((entry) => entry.id === key);
}

export function catalogCachePath(dshHome: string): string {
  return join(dshHome, "hub", CATALOG_CACHE_FILE);
}

function etagPath(dshHome: string): string {
  return join(dshHome, "hub", CATALOG_ETAG_FILE);
}

function readCachedCatalog(dshHome: string): { meta: PluginCatalogMeta; entries: PluginCatalogEntry[] } | undefined {
  const path = catalogCachePath(dshHome);
  if (!existsSync(path)) return undefined;
  try {
    return parseCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function writeCache(
  dshHome: string,
  catalog: { meta: PluginCatalogMeta; entries: PluginCatalogEntry[] },
  etag?: string | null,
): void {
  atomicWrite(catalogCachePath(dshHome), `${JSON.stringify({ meta: catalog.meta, entries: catalog.entries })}\n`);
  if (etag) atomicWrite(etagPath(dshHome), `${etag}\n`);
}

export async function loadPluginCatalog(
  dshHome: string,
  options: { url?: string; refresh?: boolean; fetchImpl?: CatalogFetcher } = {},
): Promise<PluginCatalogSnapshot> {
  assertNotRealHome(dshHome);
  const url = resolveCatalogUrl(options.url);
  const cached = readCachedCatalog(dshHome);
  const etagFile = etagPath(dshHome);
  const etag = existsSync(etagFile) ? readFileSync(etagFile, "utf8").trim() : "";
  const fetchImpl =
    options.fetchImpl ??
    (async (target, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        return await fetch(target, { headers: init?.headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    });

  if (fetchImpl) {
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (etag && cached && !options.refresh) headers["If-None-Match"] = etag;
      const response = await fetchImpl(url, { headers });
      if (response.status === 304 && cached) {
        return { ...cached, source: "cache", url };
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseCatalog(await response.json());
      writeCache(dshHome, parsed, response.headers.get("etag"));
      return { ...parsed, source: "remote", url };
    } catch {
      // fall through to cache / seed
    }
  }

  if (cached) return { ...cached, source: "cache", url };
  return { ...seedCatalog(), source: "seed", url };
}
