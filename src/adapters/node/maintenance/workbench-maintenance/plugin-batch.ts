import { join } from "node:path";
import { runBatch } from "../../../../shared/batch";
import { formatWorkbenchFailure, type WorkbenchJobResult, type WorkbenchJobStep } from "../../../../shared/workbench";
import { applyXpEmbedCompatibility, XP_PACKAGE_NAME, XP_SUPPORTED_VERSION } from "../../diagnostics/xp-compatibility";
import { installSpecFor, pendingBuildKeys, writeBuildPolicy } from "../../products/plugin-exact-source";
import { WorkbenchJobAbortError, WorkbenchJobError, type WorkbenchJobContext } from "../workbench-jobs";
import type { MaintenanceLivePluginInput } from "../workbench-maintenance-ports";
import { FULL_SPACES_PACKAGE } from "./constants";
import { MaintenanceCore } from "./core";
import { PluginBatchItemError, WorkbenchMaintenanceError } from "./errors";
import { verifyPluginReadback } from "./plugin-readback";
import type { PluginMutationExpected, ResolvedCommand } from "./types";

/**
 * Plugin batch operations: running workspaces apply live through their own
 * `pluginManager` without stopping; stopped/crashed workspaces mutate offline
 * with the mutation journal and read-back verification. `cleanup-manager`
 * remains stop-mutate-restart because the manager package is guarded.
 */
export class MaintenancePluginBatch extends MaintenanceCore {
  protected async runPluginInstall(
    command: Extract<ResolvedCommand, { kind: "plugin.install" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ): Promise<WorkbenchJobResult | void> {
    const { runningIds, offlineIds } = this.partitionPluginTargets(command.spaceIds);
    this.assertLiveCapable(runningIds);
    if (offlineIds.length > 0) {
      await this.mutateOfflinePlugins(
        offlineIds,
        ctx,
        planId,
        offlineIds.map((spaceId) => ({
          spaceId,
          action: "install",
          packageName: command.packageName,
          version: command.version,
        })),
        async () => {
          ctx.phase("download");
          ctx.message(`Downloading ${command.packageName}@${command.version}.`);
          const spec = await this.ensureExactNpmLibrary(command.catalogId, command.packageName, command.version);
          this.throwIfAborted(ctx);
          markIrreversible();
          ctx.cancellable(false);
          ctx.phase("install");
          ctx.message(`Installing ${command.packageName}@${command.version}.`);
          const batch = await runBatch(offlineIds, async (spaceId) => {
            await this.pluginAddImpl(this.ports.home, spaceId, spec);
            if (command.packageName === XP_PACKAGE_NAME && command.version === XP_SUPPORTED_VERSION) {
              applyXpEmbedCompatibility(this.ports.home, spaceId);
            }
          });
          if (batch.failed) {
            throw new PluginBatchItemError(
              batch.failed.error,
              batch.failed.item,
              command.packageName,
              "install",
            );
          }
        },
      );
    }
    if (runningIds.length === 0) return;
    return this.executeLivePlugins(
      command.spaceIds,
      runningIds,
      ctx,
      markIrreversible,
      command.packageName,
      "install",
      (spaceId) => ({
        kind: "install",
        spaceId,
        packageName: command.packageName,
        version: command.version,
      }),
    );
  }

  /**
   * Exact-source install: write the caller's allowBuilds verbatim (with the
   * deny-by-default stance), install the verbatim spec, then verify the
   * read-back against the pinned source. No catalog resolution or download
   * step happens for this kind.
   */
  protected async runPluginInstallSpec(
    command: Extract<ResolvedCommand, { kind: "plugin.install.spec" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ): Promise<WorkbenchJobResult | void> {
    const plugin = command.plugin;
    const { runningIds, offlineIds } = this.partitionPluginTargets([command.spaceId]);
    this.assertLiveCapable(runningIds);
    if (offlineIds.length > 0) {
      await this.mutateOfflinePlugins(
        offlineIds,
        ctx,
        planId,
        [{
          spaceId: command.spaceId,
          action: "install",
          packageName: plugin.packageName,
          ...(plugin.kind === "npm" ? { version: plugin.version } : {}),
          plugin,
        }],
        async () => {
          markIrreversible();
          ctx.cancellable(false);
          ctx.phase("install");
          ctx.message(`Installing ${plugin.packageName}.`);
          writeBuildPolicy(join(this.ports.home, "profiles", command.spaceId), plugin.approvedBuilds);
          try {
            await this.pluginAddImpl(this.ports.home, command.spaceId, installSpecFor(plugin));
          } catch (error) {
            const pending = pendingBuildKeys(error instanceof Error ? error.message : String(error));
            if (pending.length) {
              throw new Error(
                `${error instanceof Error ? error.message : String(error)} Pending builds awaiting approval: ${pending.join(", ")}`,
              );
            }
            throw error;
          }
          if (plugin.kind === "npm" && plugin.packageName === XP_PACKAGE_NAME && plugin.version === XP_SUPPORTED_VERSION) {
            applyXpEmbedCompatibility(this.ports.home, command.spaceId);
          }
        },
      );
      return;
    }
    return this.executeLivePlugins(
      [command.spaceId],
      runningIds,
      ctx,
      markIrreversible,
      plugin.packageName,
      "install",
      (spaceId) => ({
        kind: "install.spec",
        spaceId,
        plugin,
      }),
    );
  }

  protected async runPluginRemove(
    command: Extract<ResolvedCommand, { kind: "plugin.remove" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ): Promise<WorkbenchJobResult | void> {
    const { runningIds, offlineIds } = this.partitionPluginTargets([command.spaceId]);
    this.assertLiveCapable(runningIds);
    if (offlineIds.length > 0) {
      await this.mutateOfflinePlugins(
        offlineIds,
        ctx,
        planId,
        [{ spaceId: command.spaceId, action: "remove", packageName: command.packageName }],
        async () => {
          markIrreversible();
          ctx.cancellable(false);
          ctx.phase("remove");
          ctx.message(`Removing ${command.packageName}.`);
          await this.pluginRemoveImpl(this.ports.home, command.spaceId, command.packageName);
        },
      );
      return;
    }
    return this.executeLivePlugins(
      [command.spaceId],
      runningIds,
      ctx,
      markIrreversible,
      command.packageName,
      "remove",
      (spaceId) => ({
        kind: "remove",
        spaceId,
        packageName: command.packageName,
      }),
    );
  }

  protected async runPluginToggle(
    command: Extract<ResolvedCommand, { kind: "plugin.toggle" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ): Promise<WorkbenchJobResult | void> {
    const { runningIds, offlineIds } = this.partitionPluginTargets([command.spaceId]);
    this.assertLiveCapable(runningIds);
    if (offlineIds.length > 0) {
      await this.mutateOfflinePlugins(
        offlineIds,
        ctx,
        planId,
        [
          {
            spaceId: command.spaceId,
            action: command.enabled ? "install" : "remove",
            packageName: command.packageName,
          },
        ],
        async () => {
          markIrreversible();
          ctx.cancellable(false);
          ctx.phase("toggle");
          ctx.message(`${command.enabled ? "Installing" : "Removing"} ${command.packageName}.`);
          await this.setSpacePluginImpl(
            this.ports.home,
            command.spaceId,
            command.pluginId,
            command.enabled,
            (name) => this.ports.statusOf(name) === "running",
          );
        },
      );
      return;
    }
    const installSpec = command.enabled
      ? this.resolveToggleLiveSpec(command.pluginId, command.packageName)
      : undefined;
    return this.executeLivePlugins(
      [command.spaceId],
      runningIds,
      ctx,
      markIrreversible,
      command.packageName,
      command.enabled ? "install" : "remove",
      (spaceId) => ({
        kind: "toggle",
        spaceId,
        pluginId: command.pluginId,
        packageName: command.packageName,
        enabled: command.enabled,
        ...(installSpec ? { installSpec } : {}),
      }),
    );
  }

  protected async runCleanupManager(
    command: Extract<ResolvedCommand, { kind: "plugin.cleanup-manager" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ) {
    await this.mutatePlugins(
      [command.spaceId],
      ctx,
      planId,
      [{ spaceId: command.spaceId, action: "remove", packageName: command.packageName }],
      async () => {
        markIrreversible();
        ctx.cancellable(false);
        ctx.phase("cleanup");
        ctx.message(`Removing ${FULL_SPACES_PACKAGE}.`);
        await this.pluginRemoveImpl(this.ports.home, command.spaceId, command.packageName);
      },
    );
  }

  private async mutatePlugins(
    spaceIds: string[],
    ctx: WorkbenchJobContext,
    planId: string,
    expected: PluginMutationExpected[],
    mutate: () => Promise<void>,
  ) {
    const running = this.runningOf(spaceIds);
    ctx.phase("stop");
    ctx.cancellable(true);
    for (const spaceId of running) {
      this.throwIfAborted(ctx);
      await this.ports.stopSpace(spaceId);
    }
    if (ctx.signal.aborted) {
      await this.startRequired(running);
      throw new WorkbenchJobAbortError();
    }
    this.writePluginMutation(planId, spaceIds, expected);
    try {
      await mutate();
      ctx.phase("verify");
      for (const row of expected) verifyPluginReadback(this.ports.home, row);
      this.clearPluginMutation();
    } catch (error) {
      if (error instanceof WorkbenchJobAbortError && this.pluginTargetsUnchanged(spaceIds)) {
        this.clearPluginMutation();
        await this.startRequired(running);
        throw error;
      }
      this.failPluginMutation();
      const failedItem = error instanceof PluginBatchItemError ? error : undefined;
      const row = failedItem
        ? expected.find((item) => item.spaceId === failedItem.spaceId) ?? {
            spaceId: failedItem.spaceId,
            action: "install" as const,
            packageName: failedItem.packageName,
          }
        : expected[0];
      const reason = error instanceof Error ? error.message : String(error);
      const stage = failedItem?.stage
        ?? (row?.action === "remove" ? "remove" : row?.action === "install" ? "install" : "plugin");
      const packageName = failedItem?.packageName ?? row?.packageName;
      const spaceId = failedItem?.spaceId ?? row?.spaceId;
      const message = formatWorkbenchFailure({
        spaceId,
        stage,
        packageName,
        pluginAttribution: packageName ? "known" : "unknown",
        reason,
      });
      ctx.message(message);
      throw new WorkbenchJobError("workbench/failed", message, {
        spaceId,
        stage,
        packageName,
        pluginAttribution: packageName ? "known" : "unknown",
      });
    }
    await this.startRequired(running);
  }

  private partitionPluginTargets(spaceIds: string[]): { runningIds: string[]; offlineIds: string[] } {
    this.assertPluginTargetsReady(spaceIds);
    const runningIds: string[] = [];
    const offlineIds: string[] = [];
    for (const id of spaceIds) {
      const status = this.ports.statusOf(id);
      if (status === "running") runningIds.push(id);
      else offlineIds.push(id);
    }
    return { runningIds, offlineIds };
  }

  private assertLiveCapable(runningIds: string[]): void {
    if (runningIds.length > 0 && !this.ports.pluginLive) {
      throw new WorkbenchJobError(
        "workbench/unavailable",
        "The running workspace plugin manager surface is unavailable; running workspaces were not stopped.",
      );
    }
  }

  private async executeLivePlugins(
    allSpaceIds: string[],
    runningIds: string[],
    ctx: WorkbenchJobContext,
    markIrreversible: () => void,
    packageName: string,
    stage: "install" | "remove",
    buildInput: (spaceId: string) => MaintenanceLivePluginInput,
  ): Promise<WorkbenchJobResult> {
    this.throwIfAborted(ctx);
    markIrreversible();
    ctx.cancellable(false);
    const restartRequiredSpaceIds: string[] = [];
    const steps: WorkbenchJobStep[] = allSpaceIds.map(spaceId => ({
      step: stage,
      status: runningIds.includes(spaceId) ? "not-run" : "done",
      packageName,
      detail: spaceId,
    }));
    const publish = () => ctx.result({
      ...(allSpaceIds.length === 1 ? { spaceId: allSpaceIds[0] } : {}),
      steps: steps.map(step => ({ ...step })),
      ...(restartRequiredSpaceIds.length ? { restartRequiredSpaceIds: [...restartRequiredSpaceIds] } : {}),
    });
    publish();
    for (const spaceId of runningIds) {
      const step = steps[allSpaceIds.indexOf(spaceId)]!;
      try {
        if (this.ports.statusOf(spaceId) !== "running") {
          throw new WorkbenchMaintenanceError(
            "workbench/conflict",
            `The workspace ${spaceId} changed state before the live plugin operation ran.`,
          );
        }
        const res = await this.ports.pluginLive!(buildInput(spaceId), ctx);
        step.status = "done";
        step.detail = `${spaceId}; application=${res.application}`;
        if (res.application === "restart-required") {
          restartRequiredSpaceIds.push(spaceId);
        }
        publish();
      } catch (error) {
        step.status = "failed";
        publish();
        if (error instanceof WorkbenchJobAbortError || error instanceof WorkbenchJobError || error instanceof WorkbenchMaintenanceError) {
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        const message = formatWorkbenchFailure({
          spaceId,
          stage,
          packageName,
          pluginAttribution: "known",
          reason,
        });
        ctx.message(message);
        throw new WorkbenchJobError("workbench/failed", message, {
          spaceId,
          stage,
          packageName,
          pluginAttribution: "known",
        });
      }
    }
    const pluginApplication = restartRequiredSpaceIds.length > 0 ? "restart-required" : "applied";
    return {
      ...(allSpaceIds.length === 1 ? { spaceId: allSpaceIds[0] } : {}),
      pluginApplication,
      ...(restartRequiredSpaceIds.length > 0 ? { restartRequiredSpaceIds } : {}),
      ...(steps.length > 0 ? { steps } : {}),
    };
  }

  private async mutateOfflinePlugins(
    offlineIds: string[],
    ctx: WorkbenchJobContext,
    planId: string,
    expected: PluginMutationExpected[],
    mutate: () => Promise<void>,
  ): Promise<void> {
    this.throwIfAborted(ctx);
    this.writePluginMutation(planId, offlineIds, expected);
    try {
      await mutate();
      ctx.phase("verify");
      for (const row of expected) verifyPluginReadback(this.ports.home, row);
      this.clearPluginMutation();
    } catch (error) {
      if (error instanceof WorkbenchJobAbortError && this.pluginTargetsUnchanged(offlineIds)) {
        this.clearPluginMutation();
        throw error;
      }
      this.failPluginMutation();
      const failedItem = error instanceof PluginBatchItemError ? error : undefined;
      const row = failedItem
        ? expected.find((item) => item.spaceId === failedItem.spaceId) ?? {
            spaceId: failedItem.spaceId,
            action: "install" as const,
            packageName: failedItem.packageName,
          }
        : expected[0];
      const reason = error instanceof Error ? error.message : String(error);
      const stage = failedItem?.stage
        ?? (row?.action === "remove" ? "remove" : row?.action === "install" ? "install" : "plugin");
      const packageName = failedItem?.packageName ?? row?.packageName;
      const spaceId = failedItem?.spaceId ?? row?.spaceId;
      const message = formatWorkbenchFailure({
        spaceId,
        stage,
        packageName,
        pluginAttribution: packageName ? "known" : "unknown",
        reason,
      });
      ctx.message(message);
      throw new WorkbenchJobError("workbench/failed", message, {
        spaceId,
        stage,
        packageName,
        pluginAttribution: "known",
      });
    }
  }
}
