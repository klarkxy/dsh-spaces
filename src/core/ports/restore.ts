import type { RestoreSnapshotOptions, SnapshotRuntime } from "../../shared/snapshots";

export interface RestoreSessionSnapshots {
  recover(): void | Promise<unknown>;
  restore(
    id: string,
    runtime?: SnapshotRuntime,
    options?: RestoreBackupOptions,
  ): unknown | Promise<unknown>;
  pendingRestore(): { snapshotId: string; runtimeVersion: string } | undefined;
  completeRestore(): void | Promise<void>;
  runtimeBin(id: string): string;
}

export interface RestoreSessionRuntimes {
  current(): { bin: string; version: string } | undefined;
  recordedRef(): { bin: string; version: string } | undefined;
  selectExisting(ref: { bin: string; version: string }): Promise<unknown>;
}

export interface DescribeRuntimePort {
  describe(ref: { bin: string; version: string } | undefined): SnapshotRuntime;
}

export type RestoreBackupOptions = RestoreSnapshotOptions & {
  recordedRuntime?: SnapshotRuntime;
};
