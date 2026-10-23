import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import { isHubPluginArchive } from "../../products/plugin-library";
import { listProfilePlugins } from "../../products/plugin-ops";
import { WorkbenchMaintenanceError } from "./errors";
import type { PluginMutationExpected } from "./types";

export function verifyPluginReadback(home: string, expected: PluginMutationExpected): void {
  const plugins = listProfilePlugins(home, expected.spaceId);
  const hit = plugins.find((item) => item.name === expected.packageName);
  const manifestPath = join(home, "profiles", expected.spaceId, "package.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> })
    : { dependencies: {} };
  const lockPath = ["pnpm-lock.yaml", "pnpm-lock.yml"]
    .map((name) => join(home, "profiles", expected.spaceId, name))
    .find((path) => existsSync(path));
  const installedPath = join(home, "profiles", expected.spaceId, "node_modules", ...expected.packageName.split("/"), "package.json");
  if (expected.action === "install") {
    if (!hit) throw new WorkbenchMaintenanceError("workbench/failed");
    const declared = manifest.dependencies?.[expected.packageName];
    const fromOwnedArchive = typeof declared === "string" && declared.startsWith("file:") &&
      isHubPluginArchive(home, resolve(home, "profiles", expected.spaceId, declared.slice(5)));
    if (!declared || (expected.version && declared !== expected.version && !fromOwnedArchive)) {
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    if (!existsSync(installedPath) || !lockPath) throw new WorkbenchMaintenanceError("workbench/failed");
    const installed = JSON.parse(readFileSync(installedPath, "utf8")) as { name?: string; version?: string };
    if (installed.name !== expected.packageName || !installed.version || !isExactRuntimeVersion(installed.version) ||
      (expected.version && installed.version !== expected.version)) {
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    const lock = parseYaml(readFileSync(lockPath, "utf8"));
    const entry = lock?.importers?.["."]?.dependencies?.[expected.packageName];
    if (!entry || entry.specifier !== declared || typeof entry.version !== "string" || !entry.version) {
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    return;
  }
  if (hit || manifest.dependencies?.[expected.packageName]) throw new WorkbenchMaintenanceError("workbench/failed");
  if (lockPath && parseYaml(readFileSync(lockPath, "utf8"))?.importers?.["."]?.dependencies?.[expected.packageName]) {
    throw new WorkbenchMaintenanceError("workbench/failed");
  }
}
