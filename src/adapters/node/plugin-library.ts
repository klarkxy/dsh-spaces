import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstalledPlugin, PluginLibraryEntry } from "../../shared/types";
import { isBareNpmPackageName, pluginAliases } from "../../shared/plugin";
import { isExactRuntimeVersion } from "../../shared/runtime";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";

export const PLUGIN_LIBRARY_FILE = "plugin-library.json";
export const PLUGIN_ARCHIVE_DIR = "plugins";

export function pluginLibraryPath(dshHome: string): string {
  return join(dshHome, "hub", PLUGIN_LIBRARY_FILE);
}

export function pluginArchiveDir(dshHome: string): string {
  return join(dshHome, "hub", PLUGIN_ARCHIVE_DIR);
}

export function libraryFileId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "__").replace(/^_+|_+$/g, "").slice(0, 80) || "plugin";
}

export function archiveRelPath(id: string): string {
  return join("hub", PLUGIN_ARCHIVE_DIR, `${libraryFileId(id)}.tgz`).replaceAll("\\", "/");
}

export function archiveAbsPath(dshHome: string, id: string): string {
  return join(dshHome, archiveRelPath(id));
}

export function isHubPluginArchive(dshHome: string, spec: string): boolean {
  const lower = spec.toLowerCase();
  if (!lower.endsWith(".tgz") && !lower.endsWith(".tar.gz")) return false;
  const root = resolve(pluginArchiveDir(dshHome));
  const file = resolve(spec);
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(file);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseEntry(value: unknown): PluginLibraryEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = text(row.id)?.toLowerCase();
  const spec = text(row.spec);
  const packageName = text(row.packageName);
  if (!id || !spec || !packageName) return undefined;
  const source =
    row.source === "catalog" || row.source === "manual" || row.source === "installed"
      ? row.source
      : "manual";
  return {
    id,
    spec,
    packageName,
    title: text(row.title) || packageName,
    catalogId: text(row.catalogId)?.toLowerCase(),
    tarball: text(row.tarball)?.replaceAll("\\", "/"),
    source,
    downloadedAt: text(row.downloadedAt) || new Date(0).toISOString(),
  };
}

export function readPluginLibrary(dshHome: string): PluginLibraryEntry[] {
  assertNotRealHome(dshHome);
  const path = pluginLibraryPath(dshHome);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { plugins?: unknown };
    const raw = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    const unique = new Map<string, PluginLibraryEntry>();
    for (const item of raw) {
      const entry = parseEntry(item);
      if (entry && !unique.has(entry.id)) unique.set(entry.id, entry);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export function writePluginLibrary(dshHome: string, plugins: PluginLibraryEntry[]): PluginLibraryEntry[] {
  assertNotRealHome(dshHome);
  const unique = new Map<string, PluginLibraryEntry>();
  for (const entry of plugins) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry);
  }
  const list = [...unique.values()];
  atomicWrite(pluginLibraryPath(dshHome), `${JSON.stringify({ plugins: list }, null, 2)}\n`);
  return list;
}

export function upsertLibraryEntry(dshHome: string, entry: PluginLibraryEntry): PluginLibraryEntry[] {
  const current = readPluginLibrary(dshHome).filter((item) => item.id !== entry.id);
  current.push(entry);
  current.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return writePluginLibrary(dshHome, current);
}

export function lookupLibraryEntry(dshHome: string, id: string): PluginLibraryEntry | undefined {
  const key = id.trim().toLowerCase();
  return readPluginLibrary(dshHome).find(
    (entry) => entry.id === key || entry.packageName === id.trim() || entry.spec === id.trim(),
  );
}

export function spacesUsingPlugin(
  dshHome: string,
  installed: Record<string, InstalledPlugin[]>,
  entry: PluginLibraryEntry,
): string[] {
  const aliases = pluginAliases(entry);
  const pinned = exactPinnedVersion(entry);
  const tarballAbs = entry.tarball ? resolve(dshHome, entry.tarball) : undefined;
  return Object.entries(installed)
    .filter(([space, list]) =>
      list.some((item) => pluginUsesLibraryEntry(dshHome, space, item, aliases, pinned, tarballAbs)),
    )
    .map(([name]) => name);
}

function exactPinnedVersion(entry: PluginLibraryEntry): string | undefined {
  if (!isBareNpmPackageName(entry.packageName)) return undefined;
  const prefix = `${entry.packageName}@`;
  const spec = entry.spec.trim();
  if (!spec.startsWith(prefix)) return undefined;
  const version = spec.slice(prefix.length);
  return isExactRuntimeVersion(version) ? version : undefined;
}

function pluginUsesLibraryEntry(
  dshHome: string,
  space: string,
  item: InstalledPlugin,
  aliases: string[],
  pinned: string | undefined,
  tarballAbs: string | undefined,
): boolean {
  if (!aliases.includes(item.name)) return false;
  if (item.requestedSpec && isFileSpec(item.requestedSpec)) {
    const referenced = resolveRequestedArchive(dshHome, space, item.requestedSpec);
    if (!referenced) return true;
    if (tarballAbs && sameArchiveIdentity(referenced, tarballAbs) !== false) return true;
  }
  if (!pinned) return true;
  const actual = item.resolvedVersion ?? item.version;
  if (typeof actual !== "string" || !isExactRuntimeVersion(actual)) return true;
  return actual === pinned;
}

function isFileSpec(spec: string): boolean {
  return /^file:/i.test(spec.trim().replace(/^["']+|["']+$/g, ""));
}

function requestedFilePath(spec: string): string | undefined {
  const trimmed = spec.trim().replace(/^["']+|["']+$/g, "");
  if (!isFileSpec(trimmed)) return undefined;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  const rest = trimmed.slice(5);
  return rest.trim() ? rest : undefined;
}

function resolveRequestedArchive(dshHome: string, space: string, spec: string): string | undefined {
  const path = requestedFilePath(spec);
  if (!path || path.includes("\0")) return undefined;
  const homeRoot = resolve(dshHome);
  const base = resolve(dshHome, "profiles", space);
  const baseRel = relative(homeRoot, base);
  if (!baseRel || baseRel.startsWith("..") || isAbsolute(baseRel)) return undefined;
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function sameResolvedPath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameArchiveIdentity(left: string, right: string): boolean | undefined {
  if (sameResolvedPath(left, right)) return true;
  let canonicalLeft: string;
  let canonicalRight: string;
  try {
    canonicalLeft = realpathSync(left);
  } catch {
    return undefined;
  }
  try {
    canonicalRight = realpathSync(right);
  } catch {
    return undefined;
  }
  return sameResolvedPath(canonicalLeft, canonicalRight) ? true : false;
}

export function removeLibraryEntry(dshHome: string, id: string): PluginLibraryEntry[] {
  const entry = lookupLibraryEntry(dshHome, id);
  const next = readPluginLibrary(dshHome).filter((item) => item.id !== entry?.id);
  if (entry?.tarball) {
    const file = resolve(dshHome, entry.tarball);
    if (isHubPluginArchive(dshHome, file)) rmSync(file, { force: true });
  }
  return writePluginLibrary(dshHome, next);
}

export function syncLibraryFromProfiles(
  dshHome: string,
  installed: Record<string, InstalledPlugin[]>,
): PluginLibraryEntry[] {
  const library = readPluginLibrary(dshHome);
  const known = new Set(library.flatMap((entry) => pluginAliases(entry)));
  let changed = false;
  const now = new Date().toISOString();
  for (const list of Object.values(installed)) {
    for (const item of list) {
      if (item.protected || known.has(item.name)) continue;
      known.add(item.name);
      library.push({
        id: item.name.toLowerCase(),
        spec: item.name,
        packageName: item.name,
        title: item.name,
        source: "installed",
        downloadedAt: now,
      });
      changed = true;
    }
  }
  if (!changed) return library;
  library.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return writePluginLibrary(dshHome, library);
}
