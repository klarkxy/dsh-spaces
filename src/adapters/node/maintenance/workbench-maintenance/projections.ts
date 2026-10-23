import type { ConfigBackupMeta } from "../../../../shared/diagnostics";
import { pluginAliases } from "../../../../shared/plugin";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import type { SnapshotMeta } from "../../../../shared/snapshots";
import type { WorkbenchBackup, WorkbenchPlugin, WorkbenchSnapshot } from "../../../../shared/workbench";
import { listProfilePlugins } from "../../products/plugin-ops";

export function publicPlugin(row: WorkbenchPlugin): WorkbenchPlugin {
  return {
    id: row.id,
    title: row.title,
    packageName: row.packageName,
    description: row.description,
    version: row.version,
    installedIn: [...row.installedIn],
    protected: row.protected,
  };
}

export function publicSnapshot(meta: SnapshotMeta): WorkbenchSnapshot {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    reason: meta.reason,
    runtimeVersion: meta.runtimeVersion,
    spaceIds: [...meta.profiles],
    bytes: meta.size,
    restorable: meta.runtimeMissing !== true,
  };
}

export function publicBackup(meta: ConfigBackupMeta): WorkbenchBackup {
  return { id: meta.id, createdAt: meta.createdAt, reason: "configuration" };
}

export function snapshotFingerprint(meta: SnapshotMeta): unknown {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    runtimeVersion: meta.runtimeVersion,
    profiles: meta.profiles,
    size: meta.size,
    restorable: meta.runtimeMissing !== true,
  };
}

export function spacesUsing(
  installed: Record<string, ReturnType<typeof listProfilePlugins>>,
  packageName: string,
  spec?: string,
): string[] {
  const names = new Set(pluginAliases({ packageName, spec: spec || packageName }));
  return Object.entries(installed)
    .filter(([, list]) => list.some((item) => names.has(item.name)))
    .map(([name]) => name);
}

export function listProfilePluginsSafe(home: string, name: string): ReturnType<typeof listProfilePlugins> {
  try {
    return listProfilePlugins(home, name);
  } catch {
    return [];
  }
}

export function versionFromSpec(spec: string): string | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const version = spec.slice(at + 1);
  return isExactRuntimeVersion(version) ? version : null;
}
