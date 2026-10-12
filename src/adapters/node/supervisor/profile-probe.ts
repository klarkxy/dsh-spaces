import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isExactRuntimeVersion } from "../../../shared/runtime";

const SPACES_PLUGIN = "@dsh-spaces/plugin";

export function publicPluginVersion(spec: unknown): string | null {
  if (typeof spec !== "string") return null;
  if (/[\\/]|file:|git\+|github:|:\/\/|token|password|login/i.test(spec)) return null;
  return isExactRuntimeVersion(spec) ? spec : null;
}

export function profileHasLlmBridge(home: string, profileId: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(home, "profiles", profileId, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      dsh?: { profile?: { bundles?: unknown } };
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...(Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []),
    ];
    return names.some((name) => typeof name === "string" && /llm-bridge/i.test(name));
  } catch {
    return false;
  }
}

export function profileHasViewBridge(home: string, profileId: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(home, "profiles", profileId, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      dsh?: { profile?: { bundles?: unknown } };
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...(Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []),
    ];
    return names.some((name) => typeof name === "string" && /view-bridge/i.test(name));
  } catch {
    return false;
  }
}

export function inspectManagerInstall(home: string, profileId: string): "missing" | "manager" | "ordinary" | "damaged" {
  const dir = join(home, "profiles", profileId);
  if (!existsSync(dir)) return "missing";
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return "damaged";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      dsh?: { profile?: { bundles?: unknown } };
    };
    const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const deps = pkg.dependencies ?? {};
    if (bundles.includes(SPACES_PLUGIN) || Object.prototype.hasOwnProperty.call(deps, SPACES_PLUGIN)) {
      return "manager";
    }
    return "ordinary";
  } catch {
    return "damaged";
  }
}
