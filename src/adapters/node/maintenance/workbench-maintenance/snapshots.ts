import type { WorkbenchJobContext, WorkbenchJobResult } from "../workbench-jobs";
import { MaintenancePluginBatch } from "./plugin-batch";
import type { ResolvedCommand, StoredPlan } from "./types";

/**
 * Snapshot create/delete flows. Snapshot creation owns the maintenance flag
 * and the manager reinitialisation that follows a whole-home snapshot.
 */
export class MaintenanceSnapshots extends MaintenancePluginBatch {
  protected planSnapshotCreate(id: string, createdAt: string, expiresAt: string): StoredPlan {
    const affectedSpaceIds = this.owned();
    const runningSpaceIds = this.runningOf(affectedSpaceIds);
    const command: ResolvedCommand = { kind: "snapshot.create" };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "snapshot.create",
      title: "Create a whole-home snapshot",
      scope: "home",
      affectedSpaceIds,
      runningSpaceIds,
      changes: [
        "Snapshot the entire Home using the existing snapshot format.",
        "Stop every owned workspace, including the manager.",
        "Other workspaces are not started again after the snapshot.",
        `Current runtime ${this.currentVersionLabel()}.`,
      ],
      destructive: false,
      expiresAt,
    });
  }

  protected planSnapshotDelete(id: string, createdAt: string, expiresAt: string, snapshotId: string): StoredPlan {
    const meta = this.requireSnapshot(snapshotId);
    const command: ResolvedCommand = { kind: "snapshot.delete", snapshotId: meta.id };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "snapshot.delete",
      title: `Delete snapshot ${meta.id}`,
      scope: "home",
      affectedSpaceIds: [...meta.profiles],
      runningSpaceIds: [],
      changes: [`Delete snapshot ${meta.id} taken at ${meta.createdAt}.`],
      destructive: true,
      expiresAt,
    });
  }

  protected async runSnapshotCreate(ctx: WorkbenchJobContext): Promise<WorkbenchJobResult> {
    const runtime = this.ports.currentRuntime();
    return this.withMaintenance(ctx, async () => {
      ctx.phase("stop");
      ctx.cancellable(true);
      ctx.message("Stopping owned workspaces.");
      this.throwIfAborted(ctx);
      await this.ports.stopAll();
      this.throwIfAborted(ctx);
      ctx.cancellable(false);
      ctx.phase("snapshot");
      ctx.message("Creating a whole-home snapshot.");
      const meta = await this.ports.snapshots.create(runtime, "workbench");
      ctx.result({ snapshotId: meta.id });
      return { snapshotId: meta.id };
    });
  }

  protected async runSnapshotDelete(snapshotId: string, ctx: WorkbenchJobContext) {
    ctx.phase("delete");
    ctx.cancellable(false);
    ctx.message("Deleting the snapshot.");
    await this.ports.snapshots.delete(snapshotId);
  }

  private async withMaintenance<T>(ctx: WorkbenchJobContext, action: () => Promise<T>): Promise<T> {
    this.ports.setMaintenance(true);
    try {
      const result = await action();
      ctx.phase("reinitialize");
      ctx.message("Reinitializing the manager.");
      await this.ports.reinitializeManager();
      this.ports.setMaintenance(false);
      return result;
    } catch (error) {
      this.ports.setMaintenance(true);
      throw error;
    }
  }
}
