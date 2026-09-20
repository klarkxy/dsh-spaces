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

const DSH_TOPICS = new Set(["dsh-plugin", "dsh", "deepseek-harness", "deepseekharness"]);
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "dsh-spaces",
};

function topicsOf(value: unknown): string[] {
  return strings(value).map((item) => item.toLowerCase());
}

function isDshRelated(topics: string[]): boolean {
  return topics.some((topic) => DSH_TOPICS.has(topic));
}

function gitSpec(fullName: string): string {
  return `github:${fullName}`;
}

export function parseGitHubRepo(value: unknown): PluginCatalogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.archived === true || row.disabled === true) return undefined;
  const fullName = text(row.full_name);
  const url = text(row.html_url);
  if (!fullName || !OWNER_REPO_RE.test(fullName) || !url?.startsWith("https://github.com/")) return undefined;
  const topics = topicsOf(row.topics);
  if (!isDshRelated(topics)) return undefined;
  const owner =
    text((row.owner as { login?: unknown } | undefined)?.login) || fullName.split("/")[0] || "";
  const spec = gitSpec(fullName);
  const description = text(row.description) ?? "";
  const category = text(row.category);
  return {
    id: fullName.toLowerCase(),
    repo: fullName,
    owner,
    url,
    tier: "verified-git",
    packageName: fullName.split("/")[1],
    installMethod: "git",
    installSpec: spec,
    runsBuildScript: true,
    description,
    summary: description,
    summaryEn: description,
    category,
    tags: topics,
    stars: num(row.stargazers_count ?? row.stars),
    license: text((row.license as { spdx_id?: unknown } | undefined)?.spdx_id) || text(row.license),
    hasClient: false,
  };
}

export function parseTopicDump(value: unknown): { meta: PluginCatalogMeta; entries: PluginCatalogEntry[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unsupported plugin catalog");
  }
  const unique = new Map<string, PluginCatalogEntry>();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const row =
      item && typeof item === "object"
        ? { full_name: key, ...(item as Record<string, unknown>) }
        : undefined;
    const entry = parseGitHubRepo(row);
    if (entry && !unique.has(entry.id)) unique.set(entry.id, entry);
  }
  const entries = [...unique.values()];
  return {
    meta: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      count: entries.length,
      contentHash: "github-topic",
    },
    entries,
  };
}

export function parseAnyCatalog(value: unknown): { meta: PluginCatalogMeta; entries: PluginCatalogEntry[] } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (row.meta && Array.isArray(row.entries)) return parseCatalog(value);
  }
  return parseTopicDump(value);
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
    return parseAnyCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Plugin catalog cache could not be read. Original bytes were left unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Local catalog only. Missing cache is seed; a damaged cache file is a real error. */
export function readLocalPluginCatalog(
  dshHome: string,
  options: { url?: string } = {},
): PluginCatalogSnapshot {
  assertNotRealHome(dshHome);
  const url = resolveCatalogUrl(options.url);
  const cached = readCachedCatalog(dshHome);
  if (cached) return { ...cached, source: "cache", url };
  return { ...seedCatalog(), source: "seed", url };
}

function rememberEntries(dshHome: string, extras: PluginCatalogEntry[]): void {
  if (extras.length === 0) return;
  const current = readCachedCatalog(dshHome) ?? seedCatalog();
  const unique = new Map(current.entries.map((entry) => [entry.id, entry]));
  for (const entry of extras) unique.set(entry.id, entry);
  const entries = [...unique.values()];
  writeCache(dshHome, {
    meta: { ...current.meta, count: entries.length },
    entries,
  });
}

function githubJson(fetchImpl: CatalogFetcher, url: string): Promise<unknown> {
  return fetchImpl(url, { headers: GITHUB_HEADERS }).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

export async function searchPluginCatalog(
  dshHome: string,
  query: string,
  options: { fetchImpl?: CatalogFetcher } = {},
): Promise<PluginCatalogEntry[]> {
  assertNotRealHome(dshHome);
  const q = query.trim();
  if (!q || q.length > 80) return [];
  const fetchImpl =
    options.fetchImpl ??
    (async (target, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        return await fetch(target, { headers: init?.headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    });
  const extras: PluginCatalogEntry[] = [];
  if (OWNER_REPO_RE.test(q)) {
    const [owner, repo] = q.split("/");
    try {
      const entry = parseGitHubRepo(
        await githubJson(fetchImpl, `https://api.github.com/repos/${owner}/${repo}`),
      );
      if (entry) extras.push(entry);
    } catch {
      // keep local catalog matches
    }
  }
  rememberEntries(dshHome, extras);
  return extras;
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
      const parsed = parseAnyCatalog(await response.json());
      writeCache(dshHome, parsed, response.headers.get("etag"));
      return { ...parsed, source: "remote", url };
    } catch (error) {
      if (options.refresh) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  if (cached) return { ...cached, source: "cache", url };
  return { ...seedCatalog(), source: "seed", url };
}
