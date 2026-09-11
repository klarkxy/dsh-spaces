export type ProfileKind = "root" | "workbench" | "hidden";

export type ProfileStatus = "stopped" | "starting" | "running" | "crashed";

export interface SpaceMeta {
  displayName: string;
  icon?: string;
  order: number;
}

export interface ProfileRecord {
  name: string;
  kind: ProfileKind;
  path: string;
  hasWebApp: boolean;
  needsConversion: boolean;
  meta: SpaceMeta;
  status: ProfileStatus;
  port?: number;
  lastError?: string;
}

export interface SpacesFile {
  version: 1;
  onboarded?: boolean;
  order: string[];
  meta: Record<string, SpaceMeta>;
}

export type QuitBehavior = "stop" | "keep";

/** npm/Node download origin. China uses npmmirror; official uses npmjs + nodejs.org. */
export type PackageSource = "china" | "official";

/** UI language. `system` follows the OS locale (zh* → Chinese, otherwise English). */
export type LocalePreference = "system" | "en" | "zh";

/** Chrome + DSH appearance. `system` follows OS `prefers-color-scheme`. */
export type ThemePreference = "system" | "light" | "dark";

export interface HubSettings {
  portStart: number;
  portEnd: number;
  /** Read for compatibility. Quit always stops owned spaces; keep is no longer applied. */
  quitBehavior: QuitBehavior;
  /** One-time notice after migrating away from quitBehavior=keep. */
  quitKeepHintDismissed?: boolean;
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
  version?: string;
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
  version?: string;
  protected: boolean;
  enabled: boolean;
  inLibrary: boolean;
}

export interface PluginInstallRequest {
  profiles: string[];
  catalogId?: string;
  spec?: string;
}

export interface PluginDownloadRequest {
  catalogId?: string;
  spec?: string;
}

export interface PluginSpaceToggleRequest {
  profile: string;
  id: string;
  enabled: boolean;
}

export interface PluginInstallResult {
  running: string[];
}

export interface OnboardingProfile {
  name: string;
  kind: ProfileKind;
  action: "adopt-root" | "convert-workbench" | "already-workbench" | "hide";
}

export interface OnboardingScan {
  onboarded: boolean;
  dshHome: string;
  profiles: OnboardingProfile[];
}

export type CreateStep = "validate" | "plugin" | "patch" | "verify" | "meta";

export interface CreateProgress {
  step: CreateStep;
  message: string;
}

export interface PluginQueueSnapshot {
  pending: number;
  current?: string;
}

export type CliEnsureState = "idle" | "checking" | "installing" | "ready" | "error";

export type CliEnsureStep = "node" | "pnpm" | "cli";

export interface CliEnsureStatus {
  state: CliEnsureState;
  message: string;
  step?: CliEnsureStep;
}

export interface RuntimeStatus {
  node: boolean;
  pnpm: boolean;
  cli: boolean;
  packageSource: PackageSource;
}

export const RESERVED_PROFILE_NAMES = ["web", "hub", "headless", "node_modules"] as const;

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  portStart: 3100,
  portEnd: 3199,
  quitBehavior: "stop",
  packageSource: inferPackageSource(),
  locale: "system",
  theme: "system",
  catalogUrl: "",
};

export const DEFAULT_PLUGIN_CATALOG_URL =
  "https://cdn.jsdelivr.net/gh/wgd753/awesome-dsh-plugin@main/data/repositories.json";

export const PLUGIN_CATALOG_SCHEMA_VERSION = 1;

export const INSTALLABLE_PLUGIN_TIERS: readonly PluginTier[] = ["verified-npm", "verified-git"];

export const PROTECTED_PLUGIN_PACKAGES = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
] as const;

export function inferPackageSource(locale?: string): PackageSource {
  const value = locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh([-_]|$)/i.test(value) ? "china" : "official";
}

