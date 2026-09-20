import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseLocalePreferenceValue,
  parsePackageSourceValue,
  parseThemePreferenceValue,
  type DesktopShellPreferencePatch,
} from "../shared/desktop-shell";
import type { LocalePreference, PackageSource, ThemePreference } from "../shared/types";
import { DEFAULT_HUB_SETTINGS } from "../shared/types";
import { atomicWrite } from "../adapters/node/atomic";
import { readSettings } from "../adapters/node/hub-settings";
import { validateSnapshotRoot } from "../../packages/plugin/src/host/supervisor-pack";

export const PACKAGED_PAYLOAD_DIRNAME = "spaces-payload";
export const DEV_PAYLOAD_SEGMENTS = ["packages", "plugin", "lib"] as const;
export const SHELL_PREFS_FILE = "desktop-shell.json";
export const SHELL_PRELOAD_FILE = "index.cjs";
export const DESKTOP_SNAPSHOTS_DIRNAME = "snapshots";
const SNAPSHOT_ROOT_REASON = "snapshotRoot must be a real directory outside snapshot-replaced Home entries.";

export interface DesktopShellPrefs {
  locale: LocalePreference;
  theme: ThemePreference;
  packageSource: PackageSource;
}

export interface PayloadRootResolution {
  packaged: boolean;
  resourcesPath: string;
  moduleDir: string;
}

export function resolveSpacesPayloadRoot(input: PayloadRootResolution): string {
  if (input.packaged) return resolve(input.resourcesPath, PACKAGED_PAYLOAD_DIRNAME, "lib");
  return resolve(input.moduleDir, "..", "..", ...DEV_PAYLOAD_SEGMENTS);
}

export function shellPreloadPath(moduleDir: string): string {
  return join(moduleDir, "..", "preload", SHELL_PRELOAD_FILE);
}

export interface InflightHolder<T> {
  current: Promise<T> | null;
}

/** Coalesce overlapping calls. Sequential calls after settle, including after failure, run again. */
export function coalesceInflight<T>(holder: InflightHolder<T>, start: () => Promise<T>): Promise<T> {
  if (holder.current) return holder.current;
  const run = start();
  holder.current = run;
  void run.finally(() => {
    if (holder.current === run) holder.current = null;
  }).catch(() => undefined);
  return run;
}

export function openWorkbenchSession<T>(ready: boolean, open: () => T): T {
  if (!ready) {
    throw new Error("The workbench session cannot be created before the app is ready.");
  }
  return open();
}

export function trustedShellUrl(input: { devRendererUrl: string | undefined; moduleDir: string }): string {
  const dev = input.devRendererUrl?.trim();
  if (dev) return dev;
  return pathToFileURL(join(input.moduleDir, "..", "renderer", "index.html")).href;
}

export function verifiedToolFile(raw: string | undefined | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const candidate = resolve(raw.trim());
  if (!isAbsolute(candidate)) return null;
  try {
    const link = lstatSync(candidate);
    if (link.isDirectory() || link.isSocket() || link.isFIFO()) return null;
    const st = statSync(candidate);
    if (!st.isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

export function testRuntimeOverride(): { nodeExe: string; cliBin: string } | null {
  const cliBin = verifiedToolFile(firstEnv("DSH_TEST_CLI_BIN", "DSH_TEST_BIN"));
  const nodeExe = verifiedToolFile(firstEnv("DSH_TEST_NODE", "DSH_TEST_NODE_EXE"));
  if (!cliBin || !nodeExe) return null;
  return { nodeExe, cliBin };
}

export function realDirectory(raw: string): string | null {
  try {
    const path = resolve(raw);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return path;
  } catch {
    return null;
  }
}

/** Recorded roots are validated in place. Missing default `snapshots` may be created only when asked. */
export function ensureDesktopSnapshotRoot(
  home: string,
  snapshotRoot: string,
  options: { createIfMissing?: boolean } = {},
): string {
  if (typeof snapshotRoot !== "string" || !snapshotRoot.trim() || !isAbsolute(snapshotRoot)) {
    throw new Error(SNAPSHOT_ROOT_REASON);
  }
  const resolved = resolve(snapshotRoot);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(SNAPSHOT_ROOT_REASON);
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(SNAPSHOT_ROOT_REASON);
    const existing = validateSnapshotRoot(home, resolved);
    if (!existing) throw new Error(SNAPSHOT_ROOT_REASON);
    return existing;
  }
  if (options.createIfMissing !== true) throw new Error(SNAPSHOT_ROOT_REASON);
  if (basename(resolved) !== DESKTOP_SNAPSHOTS_DIRNAME) throw new Error(SNAPSHOT_ROOT_REASON);
  if (!validateSnapshotRoot(home, dirname(resolved))) throw new Error(SNAPSHOT_ROOT_REASON);
  try {
    mkdirSync(resolved);
  } catch {
    throw new Error(SNAPSHOT_ROOT_REASON);
  }
  const created = validateSnapshotRoot(home, resolved);
  if (!created) throw new Error(SNAPSHOT_ROOT_REASON);
  return created;
}

export function loadShellPrefs(userData: string, home: string): DesktopShellPrefs {
  const path = join(userData, SHELL_PREFS_FILE);
  const fallback = defaultsFromHome(home);
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopShellPrefs>;
    return {
      locale: parseLocalePreferenceValue(parsed.locale) ?? fallback.locale,
      theme: parseThemePreferenceValue(parsed.theme) ?? fallback.theme,
      packageSource: parsePackageSourceValue(parsed.packageSource) ?? fallback.packageSource,
    };
  } catch {
    return fallback;
  }
}

export function writeShellPrefs(userData: string, prefs: DesktopShellPrefs): DesktopShellPrefs {
  mkdirSync(userData, { recursive: true });
  const next: DesktopShellPrefs = {
    locale: prefs.locale,
    theme: prefs.theme,
    packageSource: prefs.packageSource,
  };
  atomicWrite(join(userData, SHELL_PREFS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function applyPreferencePatch(
  current: DesktopShellPrefs,
  patch: DesktopShellPreferencePatch,
): DesktopShellPrefs {
  return {
    locale: patch.locale ?? current.locale,
    theme: patch.theme ?? current.theme,
    packageSource: patch.packageSource ?? current.packageSource,
  };
}

export function moduleDirFromMeta(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}

function defaultsFromHome(home: string): DesktopShellPrefs {
  try {
    const settings = readSettings(home);
    return {
      locale: settings.locale,
      theme: settings.theme,
      packageSource: settings.packageSource,
    };
  } catch {
    return {
      locale: DEFAULT_HUB_SETTINGS.locale,
      theme: DEFAULT_HUB_SETTINGS.theme,
      packageSource: DEFAULT_HUB_SETTINGS.packageSource,
    };
  }
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
