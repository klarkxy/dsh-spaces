import { WorkbenchJobAbortError, type WorkbenchJobContext, type WorkbenchJobResult } from "../workbench-jobs";
import { MaintenancePlans } from "./plans";
import { uncertainMaintenance, WorkbenchMaintenanceError } from "./errors";
import type { StoredPlan } from "./types";
import { requestFromCommand } from "./validation";

/**
 * Guarded execution phases. A stored plan is re-validated against the live
 * state before it runs; a failed phase settles the plan and reports the failure.
 */
export class MaintenanceExecution extends MaintenancePlans {
  protected async executeLocked(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJobResult | void> {
    const wasAdmitted = this.admittedPlans.delete(planId);
    const stored = this.readPlan(planId);
    if (stored.status !== "previewed") throw new WorkbenchMaintenanceError("workbench/conflict");
    this.assertPlanIdentity(stored);
    if (!wasAdmitted) this.assertFresh(stored);
    const rebuilt = await this.buildPlan(requestFromCommand(stored.command));
    if (rebuilt.fingerprint !== stored.fingerprint) {
      throw new WorkbenchMaintenanceError("workbench/stale");
    }
    ctx.phase("prepare");
    ctx.message(stored.public.title);
    ctx.cancellable(true);
    this.throwIfAborted(ctx);
    this.markPlan(stored, "running");
    let irreversible = false;
    try {
      const withIrreversible = async <T>(work: () => Promise<T>): Promise<T> => {
        irreversible = true;
        ctx.cancellable(false);
        return work();
      };
      switch (stored.command.kind) {
        case "plugin.install": {
          const command = stored.command;
          return await this.finishPlan(stored, () => this.runPluginInstall(command, ctx, stored.id, () => {
            irreversible = true;
          }));
        }
        case "plugin.install.spec": {
          const command = stored.command;
          return await this.finishPlan(stored, () => this.runPluginInstallSpec(command, ctx, stored.id, () => {
            irreversible = true;
          }));
        }
        case "plugin.remove": {
          const command = stored.command;
          return await this.finishPlan(stored, () => this.runPluginRemove(command, ctx, stored.id, () => {
            irreversible = true;
          }));
        }
        case "plugin.toggle": {
          const command = stored.command;
          return await this.finishPlan(stored, () => this.runPluginToggle(command, ctx, stored.id, () => {
            irreversible = true;
          }));
        }
        case "plugin.cleanup-manager":
          await this.runCleanupManager(stored.command, ctx, stored.id, () => {
            irreversible = true;
          });
          this.markPlan(stored, "succeeded");
          return;
        case "snapshot.create":
          return await this.finishPlan(stored, () => withIrreversible(() => this.runSnapshotCreate(ctx)));
        case "snapshot.delete": {
          const snapshotId = stored.command.snapshotId;
          await withIrreversible(() => this.runSnapshotDelete(snapshotId, ctx));
          this.markPlan(stored, "succeeded");
          return;
        }
        case "space.runtime.set": {
          const command = stored.command;
          return await this.finishPlan(stored, () =>
            withIrreversible(() => this.runSpaceRuntimeSet(command, ctx)),
          );
        }
        case "runtime.remove": {
          const version = stored.command.version;
          return await this.finishPlan(stored, () => withIrreversible(() => this.runRuntimeRemove(version, ctx)));
        }
      }
    } catch (error) {
      if (uncertainMaintenance(error)) {
        this.ports.setMaintenance(true);
      } else if (error instanceof WorkbenchJobAbortError && !irreversible) {
        this.markPlan(stored, "cancelled");
      } else {
        this.markPlan(stored, "failed");
      }
      throw this.fail(error, "execute");
    }
  }

  private async finishPlan<T>(stored: StoredPlan, work: () => Promise<T>): Promise<T> {
    const result = await work();
    this.markPlan(stored, "succeeded");
    return result;
  }
}
