import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentDiagnosticLogger } from "../diagnostics/operation-log";

export interface BoundProfileEntry {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
  group?: unknown;
  config?: unknown;
}

export interface BoundProfileLayer {
  packageName: string;
  packageDir: string;
  patchPaths: string[];
  patches: unknown[];
}

export interface BoundLoadedProfile {
  name: string;
  dir: string;
  layers: BoundProfileLayer[];
  patchPath: string;
  patches: unknown[];
  skippedBundles: Array<{ packageName: string; reason: string }>;
}

/** The @deepseek-ai/dsh-app-boot surface consumers need, stable across the supported host runtimes. */
export interface BoundAppBoot {
  resolveBundleDir: (binName: string, packageName: string, installAnchor: string, profileDir: string) => string;
  resolveProfileDir: (name: string, home?: string) => string;
  loadOverlayPatches: (binName: string, path: string) => unknown[];
  loadOptionalPatches: (binName: string, path: string) => unknown[] | undefined;
  loadProfileDirectory: (
    binName: string,
    dir: string,
    installAnchor: string,
    options?: { userLayer?: boolean },
  ) => BoundLoadedProfile;
  composeEntries: (layers: unknown[][], warn?: (line: string) => void) => BoundProfileEntry[];
  renderConfigDump: (
    binName: string,
    absoluteConfigPath: string,
    layers: Array<{ label: string; patches: unknown[] }>,
    warn?: (line: string) => void,
  ) => string;
  getDshRuntimeVersion: () => string;
  evaluatePluginCompatibility: (
    manifest: unknown,
    exemptions: Record<string, string[]>,
    runtimeVersion: string,
  ) => { requirements: Record<string, string> } | { peers: Record<string, string> } | undefined;
}

/**
 * Resolve the bound Host's @deepseek-ai/dsh-app-boot module and the owning
 * @deepseek-ai/dsh install anchor (its package.json) from the bound CLI bin.
 */
export async function loadBoundAppBoot(bin: string): Promise<{ appBoot: BoundAppBoot; installAnchor: string }> {
  const appBootPath = createRequire(bin).resolve("@deepseek-ai/dsh-app-boot");
  const appBoot = (await import(pathToFileURL(appBootPath).href)) as BoundAppBoot;
  let dir = dirname(bin);
  for (;;) {
    const path = join(dir, "package.json");
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === "@deepseek-ai/dsh") {
      return { appBoot, installAnchor: path };
    }
    if (dirname(dir) === dir) throw new Error("The bound CLI installation manifest is missing.");
    dir = dirname(dir);
  }
}

const PROFILE_ROOT_FILENAME = "cordis.yml";
const HOME_PATCH_FILENAME = "cordis.patch.yml";
const DUMP_BIN_NAME = "dsh";

/**
 * Compose a main profile's configuration dump in process. This mirrors the
 * official `dsh --profile <name> --dump-config` layer order — bundle layers,
 * the profile patch layer, then the Home patch layer — minus everything the
 * CLI does besides reading: no profile initialization, no cordis.yml root
 * rewrite, no shipped-profile normalization, no stderr output. The CLI arg
 * parser also refuses the Electron-owned "desktop" profile outright, which is
 * why the bound app-boot composes the dump here instead.
 */
export async function composeMainProfileDump(input: { home: string; profile: string; bin: string }): Promise<string> {
  const { appBoot, installAnchor } = await loadBoundAppBoot(input.bin);
  const dir = appBoot.resolveProfileDir(input.profile, input.home);
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(`The main space profile ${JSON.stringify(input.profile)} is not installed.`);
  }
  const loaded = appBoot.loadProfileDirectory(DUMP_BIN_NAME, dir, installAnchor);
  const layers = loaded.layers.map((layer) => ({ label: layer.packageName, patches: layer.patches }));
  if (existsSync(loaded.patchPath)) layers.push({ label: loaded.patchPath, patches: loaded.patches });
  const homePatchFile = join(input.home, HOME_PATCH_FILENAME);
  const homePatches = appBoot.loadOptionalPatches(DUMP_BIN_NAME, homePatchFile);
  if (homePatches !== undefined) layers.push({ label: homePatchFile, patches: homePatches });
  const root = join(dir, PROFILE_ROOT_FILENAME);
  if (!existsSync(root)) {
    throw new Error(`The main space profile ${JSON.stringify(input.profile)} has no ${PROFILE_ROOT_FILENAME}.`);
  }
  const warnings = loaded.skippedBundles.map(
    (skipped) => `skipping profile bundle ${JSON.stringify(skipped.packageName)}: ${skipped.reason}`,
  );
  const dump = appBoot.renderConfigDump(DUMP_BIN_NAME, root, layers, (line) => warnings.push(line));
  if (warnings.length) {
    currentDiagnosticLogger()?.debug("models.main-dump-warnings", "The main space profile dump reported skipped input.", {
      profile: input.profile,
      warnings: warnings.join("; "),
    });
  }
  return dump;
}
