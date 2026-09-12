import { RestoreSession as CoreRestoreSession } from "../core/application/restore-session";
import type { RestoreSessionOptions as CoreRestoreSessionOptions } from "../core/application/restore-session";
import type {
  RestoreBackupOptions,
  RestoreSessionRuntimes,
  RestoreSessionSnapshots,
} from "../core/ports/restore";
import { describeRuntime } from "./runtime-descriptor";
import type { SnapshotRestoreOptions } from "./snapshot-store";

export type { RestoreBackupOptions, RestoreSessionRuntimes, RestoreSessionSnapshots };

export interface RestoreSessionOptions {
  snapshots: RestoreSessionSnapshots;
  runtimes: RestoreSessionRuntimes;
  applyRestoredSettings: () => void;
}

/**
 * IPC restore path: recover/restore/finishRestore stay fail-closed together.
 * MaintenanceGate still releases on return; this session owns the block.
 * Node runtime-descriptor probing stays in this adapter.
 */
export class RestoreSession {
  private readonly inner: CoreRestoreSession;

  constructor(opts: RestoreSessionOptions) {
    this.inner = new CoreRestoreSession({
      ...opts,
      describeRuntime: { describe: describeRuntime },
    } satisfies CoreRestoreSessionOptions);
  }

  get recoveryError(): string {
    return this.inner.recoveryError;
  }

  set recoveryError(value: string) {
    this.inner.recoveryError = value;
  }

  assertAvailable(quitInProgress: boolean): void {
    this.inner.assertAvailable(quitInProgress);
  }

  finishRestore(): Promise<void> {
    return this.inner.finishRestore();
  }

  restoreSnapshot(id: string, options?: SnapshotRestoreOptions): Promise<void> {
    return this.inner.restoreSnapshot(id, options);
  }

  recoverOnStartup(): Promise<void> {
    return this.inner.recoverOnStartup();
  }
}
