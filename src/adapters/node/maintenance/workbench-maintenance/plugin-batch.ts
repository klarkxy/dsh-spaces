import { runBatch } from "../../../../shared/batch";
import { formatWorkbenchFailure } from "../../../../shared/workbench";
import { applyXpEmbedCompatibility, XP_PACKAGE_NAME, XP_SUPPORTED_VERSION } from "../../diagnostics/xp-compatibility";
import { WorkbenchJobAbortError, WorkbenchJobError, type WorkbenchJobContext } from "../workbench-jobs";
import { FULL_SPACES_PACKAGE } from "./constants";
import { MaintenanceCore } from "./core";
import { PluginBatchItemError } from "./errors";
import { verifyPluginReadback } from "./plugin-readback";
import type { PluginMutationExpected, ResolvedCommand } from "./types";

/**
 * Plugin batch operations: stop, mutate, verify, restart. Every batch keeps
 * the mutation journal so a failed run leaves evidence behind.
 */
export class MaintenancePluginBatch extends MaintenanceCore {
  protected async runPluginInstall(
    command: Extract<ResolvedCommand, { kind: "plugin.install" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ) {
    await this.mutatePlugins(
      command.spaceIds,
      ctx,
      planId,
      command.spaceIds.map((spaceId) => ({
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
        const batch = await runBatch(command.spaceIds, async (spaceId) => {
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

  protected async runPluginRemove(
    command: Extract<ResolvedCommand, { kind: "plugin.remove" }>,
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
        ctx.phase("remove");
        ctx.message(`Removing ${command.packageName}.`);
        await this.pluginRemoveImpl(this.ports.home, command.spaceId, command.packageName);
      },
    );
  }

  protected async runPluginToggle(
    command: Extract<ResolvedCommand, { kind: "plugin.toggle" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ) {
    await this.mutatePlugins(
      [command.spaceId],
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
}
