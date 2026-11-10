import { isGitSpec, isSafeSpec } from "../../../../shared/plugin";
import { isExactRuntimeVersion } from "../../../../shared/runtime";
import { PluginSourceError, parsePluginSource, pluginSourceSpecOf } from "../../../../shared/plugin-source";
import { PROFILE_NAME_RE } from "../../../../shared/types";
import type { WorkbenchPlanRequest } from "../../../../shared/workbench";
import { isProtectedPlugin } from "../../products/plugin-ops";
import { CATALOG_ID_RE, NPM_NAME_RE, PROTECTED_PACKAGES } from "./constants";
import { WorkbenchMaintenanceError } from "./errors";
import type { PlanStatus, ResolvedCommand } from "./types";
import { isPlainObject, unique } from "./util";

/**
 * Maintenance-side re-validation of a plan request. The public surface first
 * goes through supervisor/input.ts parsePlanRequest (different id/version
 * strictness); this parser rejects the same removed kinds and additionally
 * enforces maintenance catalog/package rules. Keep kind coverage aligned.
 */
export function parsePlanRequest(input: unknown): WorkbenchPlanRequest {
  if (!isPlainObject(input)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  const kind = input.kind;
  switch (kind) {
    case "space.stop":
    case "space.restart": {
      expectKeys(input, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceId(input.spaceId) };
    }
    case "space.delete": {
      expectKeys(input, ["kind", "spaceId", "removeData"]);
      if (typeof input.removeData !== "boolean") throw new WorkbenchMaintenanceError("workbench/invalid-input");
      return { kind, spaceId: parseSpaceId(input.spaceId), removeData: input.removeData };
    }
    case "plugin.install": {
      expectKeys(input, ["kind", "spaceIds", "catalogId", "version"]);
      return {
        kind,
        spaceIds: parseSpaceIds(input.spaceIds),
        catalogId: parseCatalogId(input.catalogId),
        version: requireExactVersion(input.version),
      };
    }
    case "plugin.install.spec": {
      expectKeys(input, ["kind", "spaceId", "source"]);
      try {
        return { kind, spaceId: parseSpaceId(input.spaceId), source: pluginSourceSpecOf(parsePluginSource(input.source)) };
      } catch (error) {
        if (error instanceof PluginSourceError) throw new WorkbenchMaintenanceError("workbench/invalid-input");
        throw error;
      }
    }
    case "plugin.remove": {
      expectKeys(input, ["kind", "spaceId", "packageName"]);
      return { kind, spaceId: parseSpaceId(input.spaceId), packageName: parsePackageName(input.packageName) };
    }
    case "plugin.toggle": {
      expectKeys(input, ["kind", "spaceId", "pluginId", "enabled"]);
      if (typeof input.enabled !== "boolean") throw new WorkbenchMaintenanceError("workbench/invalid-input");
      return {
        kind,
        spaceId: parseSpaceId(input.spaceId),
        pluginId: parseCatalogId(input.pluginId),
        enabled: input.enabled,
      };
    }
    case "plugin.cleanup-manager": {
      expectKeys(input, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceId(input.spaceId) };
    }
    case "snapshot.create": {
      expectKeys(input, ["kind"]);
      return { kind };
    }
    case "snapshot.restore":
    case "config.restore":
      throw new WorkbenchMaintenanceError("workbench/unsupported");
    case "snapshot.delete": {
      expectKeys(input, ["kind", "snapshotId"]);
      return { kind, snapshotId: parseSnapshotId(input.snapshotId) };
    }
    case "space.runtime.set": {
      expectKeys(input, ["kind", "spaceId", "version"]);
      return { kind, spaceId: parseSpaceId(input.spaceId), version: requireExactVersion(input.version) };
    }
    case "runtime.remove": {
      expectKeys(input, ["kind", "version"]);
      return { kind, version: requireExactVersion(input.version) };
    }
    case "runtime.upgrade":
    case "runtime.install":
      throw new WorkbenchMaintenanceError("workbench/unsupported");
    case "controller.release":
    case "controller.shutdown":
      throw new WorkbenchMaintenanceError("workbench/unsupported");
    case "service.shutdown": {
      expectKeys(input, ["kind"]);
      return { kind };
    }
    default:
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
}

export function requestFromCommand(command: ResolvedCommand): WorkbenchPlanRequest {
  switch (command.kind) {
    case "plugin.install":
      return { kind: command.kind, spaceIds: command.spaceIds, catalogId: command.catalogId, version: command.version };
    case "plugin.install.spec":
      return { kind: command.kind, spaceId: command.spaceId, source: pluginSourceSpecOf(command.plugin) };
    case "plugin.remove":
      return { kind: command.kind, spaceId: command.spaceId, packageName: command.packageName };
    case "plugin.toggle":
      return { kind: command.kind, spaceId: command.spaceId, pluginId: command.pluginId, enabled: command.enabled };
    case "plugin.cleanup-manager":
      return { kind: command.kind, spaceId: command.spaceId };
    case "snapshot.create":
      return { kind: command.kind };
    case "snapshot.delete":
      return { kind: command.kind, snapshotId: command.snapshotId };
    case "space.runtime.set":
      return { kind: command.kind, spaceId: command.spaceId, version: command.version };
    case "runtime.remove":
      return { kind: command.kind, version: command.version };
  }
}

export function affectedFromCommand(command: ResolvedCommand): string[] {
  switch (command.kind) {
    case "plugin.install":
      return command.spaceIds;
    case "plugin.install.spec":
      return [command.spaceId];
    case "plugin.remove":
    case "plugin.toggle":
    case "plugin.cleanup-manager":
    case "space.runtime.set":
      return [command.spaceId];
    default:
      return [];
  }
}

function parseSpaceId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_NAME_RE.test(value)) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  return value;
}

function parseSpaceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  return unique(value.map(parseSpaceId));
}

function parseCatalogId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 214 || !CATALOG_ID_RE.test(value.trim())) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  rejectRawSpec(value);
  return value.trim();
}

function parsePackageName(value: unknown): string {
  if (typeof value !== "string" || !isNpmPackageId(value) || !isSafeSpec(value)) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  rejectRawSpec(value);
  return value;
}

function parseSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 80 || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  return value;
}

export function requireExactVersion(value: unknown): string {
  if (typeof value !== "string" || !isExactRuntimeVersion(value)) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  return value;
}

export function requirePackageName(entry: { packageName?: string; installSpec?: string }): string {
  const name = entry.packageName || entry.installSpec;
  if (!name || !isNpmPackageId(name) || isGitSpec(name)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  return name;
}

export function assertGuardedPackage(packageName: string): void {
  if (isGuardedPackage(packageName) || isProtectedPlugin(packageName)) {
    throw new WorkbenchMaintenanceError("workbench/forbidden");
  }
}

export function isGuardedPackage(packageName: string): boolean {
  return PROTECTED_PACKAGES.has(packageName);
}

export function isNpmPackageId(value: string): boolean {
  return value.length > 0 && value.length <= 214 && NPM_NAME_RE.test(value) && !value.startsWith(".") && !value.includes("\\");
}

export function rejectRawSpec(value: string): void {
  const lower = value.toLowerCase();
  if (
    lower.includes("file:") ||
    lower.includes("git+") ||
    lower.includes("github:") ||
    lower.includes("http:") ||
    lower.includes("https:") ||
    lower.includes("\\\\") ||
    value.includes("..") ||
    value.includes(";") ||
    value.includes("|") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\")
  ) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return value === "previewed" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function expectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  for (const key of required) {
    if (!(key in value)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
}
