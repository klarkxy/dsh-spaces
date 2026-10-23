import { randomUUID } from "node:crypto";
import { XP_EMBED_COMPATIBILITY_NOTE, XP_PACKAGE_NAME, XP_SUPPORTED_VERSION } from "../../diagnostics/xp-compatibility";
import type { WorkbenchPlanRequest } from "../../../../shared/workbench";
import { MaintenanceRuntime } from "./runtime";
import { FULL_SPACES_PACKAGE, WORKBENCH_PLAN_TTL_MS } from "./constants";
import { WorkbenchMaintenanceError } from "./errors";
import type { ResolvedCommand, StoredPlan } from "./types";
import { assertGuardedPackage, requireExactVersion, requirePackageName } from "./validation";
import { unique } from "./util";

/**
 * Preview and plan construction. Every plan records the exact command and a
 * fingerprint of the observed state so execution can refuse a stale plan.
 */
export class MaintenancePlans extends MaintenanceRuntime {
  protected async buildPlan(request: WorkbenchPlanRequest): Promise<StoredPlan> {
    const createdAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + WORKBENCH_PLAN_TTL_MS).toISOString();
    const id = randomUUID();
    switch (request.kind) {
      case "plugin.install":
        return this.planPluginInstall(id, createdAt, expiresAt, request);
      case "plugin.remove":
        return this.planPluginRemove(id, createdAt, expiresAt, request);
      case "plugin.toggle":
        return this.planPluginToggle(id, createdAt, expiresAt, request);
      case "plugin.cleanup-manager":
        return this.planCleanupManager(id, createdAt, expiresAt, request);
      case "snapshot.create":
        return this.planSnapshotCreate(id, createdAt, expiresAt);
      case "snapshot.delete":
        return this.planSnapshotDelete(id, createdAt, expiresAt, request.snapshotId);
      case "space.runtime.set":
        return this.planSpaceRuntimeSet(id, createdAt, expiresAt, request);
      case "runtime.remove":
        return this.planRuntimeRemove(id, createdAt, expiresAt, request.version);
      default:
        throw new WorkbenchMaintenanceError("workbench/runtime-handoff");
    }
  }

  private async planPluginInstall(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.install" }>,
  ): Promise<StoredPlan> {
    const spaceIds = unique(request.spaceIds.map((spaceId) => this.targetSpace(spaceId, false)));
    if (spaceIds.length === 0) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    const version = requireExactVersion(request.version);
    const entry = await this.resolveNpmCatalog(request.catalogId, version, true);
    const packageName = requirePackageName(entry);
    assertGuardedPackage(packageName);
    const runningSpaceIds = this.runningOf(spaceIds);
    const command: ResolvedCommand = {
      kind: "plugin.install",
      spaceIds,
      catalogId: entry.id,
      packageName,
      version,
    };
    const changes = [
      `Install ${packageName}@${version} into ${spaceIds.join(", ")}.`,
      runningSpaceIds.length
        ? `Stop and restart running workspaces: ${runningSpaceIds.join(", ")}.`
        : "No running workspace needs to stop.",
      "The plugin change is not a hot reload; restart is required.",
      ...(packageName === XP_PACKAGE_NAME && version === XP_SUPPORTED_VERSION ? [XP_EMBED_COMPATIBILITY_NOTE] : []),
    ];
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.install",
      title: `Install ${packageName}@${version}`,
      scope: "space",
      affectedSpaceIds: spaceIds,
      runningSpaceIds,
      changes,
      destructive: false,
      expiresAt,
    });
  }

  private async planPluginRemove(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.remove" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    const packageName = requirePackageName({ packageName: request.packageName, installSpec: request.packageName });
    assertGuardedPackage(packageName);
    if (!this.spaceHasPlugin(spaceId, packageName)) {
      throw new WorkbenchMaintenanceError("workbench/not-found");
    }
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = { kind: "plugin.remove", spaceId, packageName };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.remove",
      title: `Remove ${packageName} from ${spaceId}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        `Remove ${packageName} from ${spaceId}.`,
        runningSpaceIds.length ? `Stop and restart ${spaceId}.` : "Workspace is stopped.",
        "The plugin change is not a hot reload; restart is required.",
      ],
      destructive: true,
      expiresAt,
    });
  }

  private async planPluginToggle(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.toggle" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    const packageName = this.resolveTogglePackage(spaceId, request.pluginId, request.enabled);
    assertGuardedPackage(packageName);
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = {
      kind: "plugin.toggle",
      spaceId,
      pluginId: request.pluginId,
      packageName,
      enabled: request.enabled,
    };
    const action = request.enabled ? "Install" : "Remove";
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.toggle",
      title: `${action} ${packageName} on ${spaceId}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        `${action} ${packageName} on ${spaceId} using the existing install/remove semantics.`,
        runningSpaceIds.length ? `Stop and restart ${spaceId}.` : "Workspace is stopped.",
        "This is not a hot toggle; the workspace must restart to apply the change.",
      ],
      destructive: !request.enabled,
      expiresAt,
    });
  }

  private async planCleanupManager(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.cleanup-manager" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    if (!this.spaceHasPlugin(spaceId, FULL_SPACES_PACKAGE)) {
      throw new WorkbenchMaintenanceError("workbench/not-found");
    }
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = {
      kind: "plugin.cleanup-manager",
      spaceId,
      packageName: FULL_SPACES_PACKAGE,
    };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.cleanup-manager",
      title: `Remove the management plugin from ${spaceId}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        `Remove ${FULL_SPACES_PACKAGE} from ordinary workspace ${spaceId}.`,
        "User data is not copied or migrated.",
        runningSpaceIds.length ? `Stop and restart ${spaceId}.` : "Workspace is stopped.",
      ],
      destructive: true,
      expiresAt,
    });
  }
}
