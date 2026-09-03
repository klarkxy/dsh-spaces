import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../shared/i18n";
import {
  PROTECTED_PLUGIN_PACKAGES,
  type InstalledPlugin,
  type PluginInstallResult,
} from "../shared/types";
import { enqueuePlugin, runDsh } from "./dsh-cli";
import { assertNotRealHome } from "./home-guard";
import { isInstallableEntry, isSafeSpec } from "../shared/plugin";
import { lookupCatalogEntry } from "./plugin-catalog";

const PROTECTED = new Set<string>(PROTECTED_PLUGIN_PACKAGES);
const PLUGIN_TIMEOUT_MS = 180_000;

function profileDir(dshHome: string, name: string): string {
  return join(dshHome, "profiles", name);
}

function readManifest(dshHome: string, name: string): {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
} {
  const pkgPath = join(profileDir(dshHome, name), "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(t("errors.unknownProfile", { name }));
  }
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      dsh?: { profile?: { bundles?: string[] } };
    };
  } catch {
    throw new Error(t("errors.unknownProfile", { name }));
  }
}

function assertProfile(dshHome: string, name: string): void {
  assertNotRealHome(dshHome);
  if (!existsSync(profileDir(dshHome, name))) {
    throw new Error(t("errors.unknownProfile", { name }));
  }
}

export function isProtectedPlugin(packageName: string): boolean {
  return PROTECTED.has(packageName);
}

export function listAllProfilePlugins(
  dshHome: string,
  names: string[],
): Record<string, InstalledPlugin[]> {
  const result: Record<string, InstalledPlugin[]> = {};
  for (const name of names) {
    try {
      result[name] = listProfilePlugins(dshHome, name);
    } catch {
      result[name] = [];
    }
  }
  return result;
}

export function listProfilePlugins(dshHome: string, name: string): InstalledPlugin[] {
  assertProfile(dshHome, name);
  const manifest = readManifest(dshHome, name);
  const deps = manifest.dependencies ?? {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const seen = new Set<string>();
  const list: InstalledPlugin[] = [];
  for (const bundle of bundles) {
    if (seen.has(bundle)) continue;
    seen.add(bundle);
    list.push({
      name: bundle,
      version: deps[bundle],
      protected: isProtectedPlugin(bundle),
    });
  }
  for (const [dep, version] of Object.entries(deps)) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    list.push({ name: dep, version, protected: isProtectedPlugin(dep) });
  }
  return list;
}

function pluginError(spec: string, code: number, stdout: string, stderr: string): Error {
  const detail = (stderr || stdout).slice(0, 800);
  const allowBuilds = /allowBuilds|prepare|ignored/i.test(detail)
    ? t("errors.pluginAllowBuilds")
    : "";
  return new Error(
    `${t("errors.pluginAddFailed", { spec, code, detail })}${allowBuilds ? `\n${allowBuilds}` : ""}`,
  );
}

export async function pluginAdd(dshHome: string, name: string, spec: string): Promise<void> {
  assertProfile(dshHome, name);
  if (!isSafeSpec(spec)) {
    throw new Error(t("errors.pluginSpecInvalid", { spec }));
  }
  await enqueuePlugin(t("queue.pluginAddSpec", { name, spec }), async () => {
    const { stdout, stderr, code } = await runDsh(
      dshHome,
      ["plugin", "--profile", name, "add", spec],
      { timeoutMs: PLUGIN_TIMEOUT_MS },
    );
    if (code !== 0) throw pluginError(spec, code, stdout, stderr);
  });
}

export async function pluginRemove(dshHome: string, name: string, packageName: string): Promise<void> {
  assertProfile(dshHome, name);
  if (!isSafeSpec(packageName)) {
    throw new Error(t("errors.pluginSpecInvalid", { spec: packageName }));
  }
  if (isProtectedPlugin(packageName)) {
    throw new Error(t("errors.pluginProtected", { name: packageName }));
  }
  await enqueuePlugin(t("queue.pluginRemove", { name, spec: packageName }), async () => {
    const { stdout, stderr, code } = await runDsh(
      dshHome,
      ["plugin", "--profile", name, "remove", packageName],
      { timeoutMs: PLUGIN_TIMEOUT_MS },
    );
    if (code !== 0) {
      throw new Error(
        t("errors.pluginRemoveFailed", {
          spec: packageName,
          code,
          detail: (stderr || stdout).slice(0, 800),
        }),
      );
    }
  });
}

export async function resolveInstallSpec(
  dshHome: string,
  request: { catalogId?: string; spec?: string },
): Promise<string> {
  if (request.catalogId) {
    const entry = lookupCatalogEntry(dshHome, request.catalogId);
    if (!entry) throw new Error(t("errors.pluginCatalogMissing", { id: request.catalogId }));
    if (!isInstallableEntry(entry) || !entry.installSpec) {
      throw new Error(t("errors.pluginNotInstallable", { id: request.catalogId }));
    }
    return entry.installSpec;
  }
  const spec = request.spec?.trim() ?? "";
  if (!isSafeSpec(spec)) {
    throw new Error(t("errors.pluginSpecInvalid", { spec }));
  }
  return spec;
}

export async function installPluginToProfiles(
  dshHome: string,
  profiles: string[],
  spec: string,
  runningOf: (name: string) => boolean,
): Promise<PluginInstallResult> {
  if (profiles.length === 0) {
    throw new Error(t("errors.pluginNeedTarget"));
  }
  const unique = [...new Set(profiles)];
  for (const name of unique) {
    await pluginAdd(dshHome, name, spec);
  }
  return { running: unique.filter(runningOf) };
}
