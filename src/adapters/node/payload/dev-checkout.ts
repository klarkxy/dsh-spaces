import { lstatSync, realpathSync } from "../../../shared/node/filesystem";
/** Dev-checkout linking: components installed as link: specs straight into a source checkout. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { samePath } from "../home/home-guard";
import { SPACES_COMPONENT_PACKAGES } from "../../../shared/plugin-spec";

export type SpacesComponent = "plugin" | "view-bridge" | "browser";

export const DEV_COMPONENT_DIRS: Record<SpacesComponent, string> = {
  plugin: "packages/plugin",
  "view-bridge": "packages/view-bridge",
  browser: "packages/browser",
};

/**
 * Checkout root iff `payloadRootLib` is `<root>/packages/plugin/lib` of a
 * source checkout (private root manifest named dsh-spaces), else
 * undefined. A packed or staged install never qualifies: staged copies live
 * under a tools `components/` tree and standard installs live under
 * node_modules, whose root manifest is neither private nor the plugin package.
 */
export function detectDevCheckout(payloadRootLib: string): string | undefined {
  if (typeof payloadRootLib !== "string" || !payloadRootLib.trim()) return undefined;
  let real: string;
  try {
    real = realpathSync(resolve(payloadRootLib));
  } catch {
    return undefined;
  }
  if (real.split(/[\\/]+/).includes("node_modules")) return undefined;
  const root = resolve(real, "..", "..", "..");
  try {
    if (!samePath(realpathSync(join(root, "packages", "plugin", "lib")), real)) return undefined;
  } catch {
    return undefined;
  }
  let manifest: { name?: unknown; private?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      private?: unknown;
    };
  } catch {
    return undefined;
  }
  if (manifest.name !== "dsh-spaces" || manifest.private !== true) return undefined;
  return root;
}

/** The checkout directory linked into a profile for one component. */
export function devComponentDir(checkout: string, component: SpacesComponent): string {
  return join(checkout, ...DEV_COMPONENT_DIRS[component].split("/"));
}

/**
 * True iff the profile's component package dependency is recorded as a
 * `link:` spec, its node_modules entry is a symlink/junction, and that link
 * resolves to this checkout's component directory.
 */
export function devComponentLinked(
  home: string,
  profileId: string,
  checkout: string,
  component: SpacesComponent,
): boolean {
  const profileDir = join(home, "profiles", profileId);
  let spec: unknown;
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    spec = manifest.dependencies?.[SPACES_COMPONENT_PACKAGES[component]];
  } catch {
    return false;
  }
  if (typeof spec !== "string" || !spec.startsWith("link:")) return false;
  const link = join(profileDir, "node_modules", ...SPACES_COMPONENT_PACKAGES[component].split("/"));
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;
  try {
    return samePath(realpathSync(link), realpathSync(devComponentDir(checkout, component)));
  } catch {
    return false;
  }
}

/**
 * Why a checkout component directory cannot be linked into a profile, or
 * undefined when it is installable: a real directory whose manifest names the component,
 * declares a `main` entry, and whose declared bundle patch file exists.
 * Returning a reason instead of guessing keeps a missing or damaged source
 * from degrading into "no component" (silently skipped steps) or into an
 * opaque plugin-add failure.
 */
export function devComponentProblem(checkout: string, component: SpacesComponent): string | undefined {
  const expected = SPACES_COMPONENT_PACKAGES[component];
  const dir = devComponentDir(checkout, component);
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return `the linked ${expected} source directory is missing`;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return `the linked ${expected} source is not a real directory`;
  const manifestPath = join(dir, "package.json");
  let manifest: { name?: unknown; main?: unknown; dsh?: { bundle?: { patch?: unknown } } };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    return `the linked ${expected} manifest could not be read`;
  }
  if (manifest.name !== expected) return `the linked ${expected} manifest declares ${String(manifest.name)}`;
  const main = manifest.main;
  if (typeof main !== "string" || !main.trim() || !existsSync(join(dir, ...main.split("/")))) {
    return `the linked ${expected} main build entry is missing`;
  }
  const patch = manifest.dsh?.bundle?.patch;
  const patches = typeof patch === "string" ? [patch] : Array.isArray(patch) ? patch : [];
  if (!patches.length || patches.some((file) => typeof file !== "string" || !file.trim() || !existsSync(join(dir, ...file.split("/"))))) {
    return `the linked ${expected} bundle patch is missing`;
  }
  return undefined;
}
