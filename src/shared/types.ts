export type ProfileStatus = "stopped" | "starting" | "stopping" | "running" | "crashed";

export interface SpaceMeta {
  base?: 'web' | 'browser';
  baseVersion?: string;
  displayName: string;
  icon?: string;
  order: number;
  /** Start this space once when a user opens Desktop and its service becomes ready. */
  startWithDesktop?: boolean;
  /** Exact DSH runtime version this space is pinned to. */
  dshVersion?: string;
  /** ISO timestamp written by Spaces when the space was created. Registers the space. */
  createdAt?: string;
}

export interface ProfileRecord {
  name: string;
  path: string;
  hasWebApp: boolean;
  meta: SpaceMeta;
  status: ProfileStatus;
  port?: number;
  lastError?: string;
}

export interface SpacesFile {
  version: 1;
  order: string[];
  meta: Record<string, SpaceMeta>;
}

/** npm/Node download origin. China uses npmmirror; official uses npmjs + nodejs.org. */
export type PackageSource = "china" | "official";

/** UI language. `system` follows the OS locale (zh* → Chinese, otherwise English). */
export type LocalePreference = "system" | "en" | "zh";

/** Chrome + DSH appearance. `system` follows OS `prefers-color-scheme`. */
export type ThemePreference = "system" | "light" | "dark";

export interface HubSettings {
  portStart: number;
  portEnd: number;
  packageSource: PackageSource;
  locale: LocalePreference;
  theme: ThemePreference;
  /** Empty means the built-in jsDelivr catalog URL. */
  catalogUrl: string;
}

export type PluginTier = "verified-npm" | "verified-git" | "likely-plugin" | "related";

export type PluginInstallMethod = "npm" | "git" | "manual";

export type PluginCatalogSource = "remote" | "cache" | "seed";

export interface PluginCatalogMeta {
  schemaVersion: number;
  generatedAt: string;
  count: number;
  contentHash: string;
}

export interface PluginCatalogEntry {
  id: string;
  repo: string;
  owner: string;
  url: string;
  tier: PluginTier;
  packageName?: string;
  installMethod: PluginInstallMethod;
  installSpec?: string;
  runsBuildScript: boolean;
  description: string;
  summary?: string;
  summaryEn?: string;
  category?: string;
  tags: string[];
  stars: number;
  license?: string;
  hasClient: boolean;
}

export interface PluginCatalogSnapshot {
  meta: PluginCatalogMeta;
  entries: PluginCatalogEntry[];
  source: PluginCatalogSource;
  url: string;
}

export interface InstalledPlugin {
  name: string;
  /** Requested dependency spec from package.json. Not proof of the installed bits. */
  requestedSpec?: string;
  /** Actual version from node_modules, or null when unknown. */
  resolvedVersion?: string | null;
  /** Display version: resolved, else omitted/unknown. */
  version?: string | null;
  protected: boolean;
}

export type PluginLibrarySource = "catalog" | "manual" | "installed";

export interface PluginLibraryEntry {
  id: string;
  spec: string;
  packageName: string;
  title: string;
  catalogId?: string;
  /** Path relative to DSH_HOME, e.g. `hub/plugins/foo.tgz`. */
  tarball?: string;
  source: PluginLibrarySource;
  downloadedAt: string;
}

export interface PluginManageRow {
  id: string;
  packageName: string;
  title: string;
  version?: string | null;
  protected: boolean;
  enabled: boolean;
  inLibrary: boolean;
}

export interface PluginDownloadRequest {
  catalogId?: string;
  spec?: string;
  /** Exact npm version to pin. Omit to resolve and pin current latest. Ignored for git specs. */
  version?: string;
}

export interface PluginInstallResult {
  running: string[];
}

export const RESERVED_PROFILE_NAMES = ["web", "desktop", "hub", "headless", "node_modules"] as const;

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/** A space id is the full profile directory name under profiles/, e.g. `space-demo`. */
export const SPACE_ID_RE = /^space-[a-z0-9][a-z0-9-]{0,32}$/;

/** The user-entered part of a space id (before the `space-` prefix). */
export const SPACE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,32}$/;

export function spaceIdFromName(name: string): string {
  return `space-${name}`;
}

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  portStart: 3100,
  portEnd: 3199,
  packageSource: inferPackageSource(),
  locale: "system",
  theme: "system",
  catalogUrl: "",
};

export const DEFAULT_PLUGIN_CATALOG_URL =
  "https://klarkxy.github.io/dsh-plugins/plugins.json";

export const PLUGIN_CATALOG_SCHEMA_VERSION = 1;

export const INSTALLABLE_PLUGIN_TIERS: readonly PluginTier[] = ["verified-npm", "verified-git"];

export const PROTECTED_PLUGIN_PACKAGES = [
  "@dsh-spaces/browser",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
] as const;

export function inferPackageSource(locale?: string): PackageSource {
  const value = locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh([-_]|$)/i.test(value) ? "china" : "official";
}

