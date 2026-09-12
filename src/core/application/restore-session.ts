import type { RestoreSnapshotOptions, SnapshotRuntime } from "../../shared/snapshots";
import type {
  DescribeRuntimePort,
  RestoreBackupOptions,
  RestoreSessionRuntimes,
  RestoreSessionSnapshots,
} from "../ports/restore";

export interface RestoreSessionOptions {
  snapshots: RestoreSessionSnapshots;
  runtimes: RestoreSessionRuntimes;
  applyRestoredSettings: () => void;
  describeRuntime: DescribeRuntimePort;
}

/**
 * IPC restore path: recover/restore/finishRestore stay fail-closed together.
 * MaintenanceGate still releases on return; this session owns the block.
 */
export class RestoreSession {
  recoveryError = "";

  constructor(private readonly opts: RestoreSessionOptions) {}

  assertAvailable(quitInProgress: boolean): void {
    if (quitInProgress) {
      throw new Error("The application is exiting. Wait for shutdown to finish.");
    }
    if (this.recoveryError) throw new Error(this.recoveryError);
    const pending = this.opts.snapshots.pendingRestore();
    if (pending) {
      throw new Error(`Restore needs recovery: unfinished restore of ${pending.snapshotId}`);
    }
  }

  async finishRestore(): Promise<void> {
    const pending = this.opts.snapshots.pendingRestore();
    if (pending) {
      await this.opts.runtimes.selectExisting({
        bin: this.opts.snapshots.runtimeBin(pending.snapshotId),
        version: pending.runtimeVersion,
      });
      this.opts.snapshots.completeRestore();
      const leftover = this.opts.snapshots.pendingRestore();
      if (leftover) {
        throw new Error(`Restore cleanup left a pending restore of ${leftover.snapshotId}`);
      }
    }
    this.opts.applyRestoredSettings();
    this.recoveryError = "";
  }

  async restoreSnapshot(id: string, options?: RestoreSnapshotOptions): Promise<void> {
    let finishingRequestedRestore = false;
    try {
      await this.opts.snapshots.recover();
      const pending = this.opts.snapshots.pendingRestore();
      if (pending && pending.snapshotId !== id) {
        await this.finishRestore();
        throw new Error("The previous restore has been completed. Review the current state before restoring another snapshot.");
      }
      if (!pending) {
        await this.opts.snapshots.restore(id, this.currentRuntime(), this.backupOptions(options));
      }
      finishingRequestedRestore = true;
      await this.finishRestore();
    } catch (err) {
      try {
        await this.opts.snapshots.recover();
        const completedRequestedData = this.opts.snapshots.pendingRestore()?.snapshotId === id;
        // Settings/toolchain application may fail after pending was removed.
        // Reconcile that step too before admitting any more mutations.
        await this.finishRestore();
        if (completedRequestedData || finishingRequestedRestore) return;
      } catch (recovery) {
        this.block(`Restore needs recovery: ${String(recovery)}`);
        throw err;
      }
      throw err;
    }
  }

  async recoverOnStartup(): Promise<void> {
    try {
      await this.opts.snapshots.recover();
      await this.finishRestore();
      const pending = this.opts.snapshots.pendingRestore();
      if (pending) {
        throw new Error(`unfinished restore of ${pending.snapshotId}`);
      }
    } catch (err) {
      this.block(`Restore needs recovery before spaces can start: ${String(err)}`);
      throw err;
    }
  }

  private currentRuntime(): SnapshotRuntime | undefined {
    try {
      return this.opts.describeRuntime.describe(this.opts.runtimes.current());
    } catch {
      return undefined;
    }
  }

  private backupOptions(options?: RestoreSnapshotOptions): RestoreBackupOptions {
    const allowDataOnlyBackup = options?.allowDataOnlyBackup === true;
    let recordedRuntime: SnapshotRuntime | undefined;
    try {
      const ref = this.opts.runtimes.recordedRef();
      if (ref) recordedRuntime = this.opts.describeRuntime.describe(ref);
    } catch {
      recordedRuntime = undefined;
    }
    return { allowDataOnlyBackup, recordedRuntime };
  }

  private block(message: string): void {
    this.recoveryError = message;
  }
}
