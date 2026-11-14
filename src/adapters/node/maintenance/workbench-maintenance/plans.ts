import { randomUUID } from "node:crypto";
import { XP_EMBED_COMPATIBILITY_NOTE, XP_PACKAGE_NAME, XP_SUPPORTED_VERSION } from "../../diagnostics/xp-compatibility";
import type { ExactPluginSource } from "../../../../shared/plugin-source";
import { parsePluginSource, PluginSourceError } from "../../../../shared/plugin-source";
import { pinDetailFor } from "../../products/plugin-exact-source";
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
      case "plugin.install.spec":
        return this.planPluginInstallSpec(id, createdAt, expiresAt, request);
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
    this.assertPluginTargetsReady(spaceIds);
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
        ? `Apply live inside running workspaces without stopping them: ${runningSpaceIds.join(", ")}.`
        : "No running workspace needs to stop.",
      runningSpaceIds.length
        ? "If a plugin requires a restart to take full effect, you decide when to restart."
        : "Stopped workspaces stay stopped after the plugin change.",
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

  /**
   * Exact-source install (D4): the control channel's closed npm/github pin.
   * `rejectRawSpec` stays untouched — this kind carries the normalized source
   * itself, so a raw spec or non-exact pin can never slip through the parse
   * boundary. The install writes the caller's allowBuilds verbatim before
   * adding and verifies the read-back against the pinned source afterwards.
   */
  private async planPluginInstallSpec(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.install.spec" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    this.assertPluginTargetsReady([spaceId]);
    let plugin: ExactPluginSource;
    try {
      plugin = parsePluginSource(request.source);
    } catch (error) {
      if (error instanceof PluginSourceError) throw new WorkbenchMaintenanceError("workbench/invalid-input");
      throw error;
    }
    assertGuardedPackage(plugin.packageName);
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = { kind: "plugin.install.spec", spaceId, plugin };
    const changes = [
      `Install ${pinDetailFor(plugin)} into ${spaceId} from the pinned source.`,
      ...(plugin.approvedBuilds.length
        ? [`Build scripts approved for: ${plugin.approvedBuilds.join(", ")}. Other build scripts stay denied.`]
        : ["No build scripts are approved; deny-by-default build policy is written before install."]),
      plugin.kind === "github"
        ? `The installed package is verified against ${plugin.owner}/${plugin.repo}${plugin.path ? `/${plugin.path}` : ""}#${plugin.commit} via the lockfile.`
        : `The installed package must resolve to ${plugin.packageName}@${plugin.version}.`,
      runningSpaceIds.length
        ? `Apply live inside running workspace ${spaceId} without stopping it.`
        : "The workspace is stopped and stays stopped.",
      runningSpaceIds.length
        ? "If the plugin requires a restart to take full effect, you decide when to restart."
        : "Stopped workspace stays stopped after the plugin change.",
      ...(plugin.kind === "npm" && plugin.packageName === XP_PACKAGE_NAME && plugin.version === XP_SUPPORTED_VERSION
        ? [XP_EMBED_COMPATIBILITY_NOTE]
        : []),
    ];
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.install.spec",
      title: `Install ${pinDetailFor(plugin)}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
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
    this.assertPluginTargetsReady([spaceId]);
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
        runningSpaceIds.length
          ? `Remove live inside running workspace ${spaceId} without stopping it.`
          : "Workspace is stopped.",
        runningSpaceIds.length
          ? "If a restart is required to unload active hooks, you decide when to restart."
          : "Stopped workspace stays stopped.",
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
    this.assertPluginTargetsReady([spaceId]);
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
        runningSpaceIds.length
          ? `${action} live inside running workspace ${spaceId} without stopping it.`
          : "Workspace is stopped.",
        runningSpaceIds.length
          ? "If a restart is required to finish applying the change, you decide when to restart."
          : "Stopped workspace stays stopped.",
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
