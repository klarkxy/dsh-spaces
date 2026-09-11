import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { SnapshotStore, type SnapshotStoreOptions } from "./snapshot-store";
import type { PendingRestore, RestoreResult, SnapshotMeta, SnapshotRuntime } from "../shared/snapshots";
import type { SnapshotRestoreOptions } from "./snapshot-store";

/** Large copies run off Electron's event loop; the maintenance gate owns admission. */
export class SnapshotExecutor {
  private readonly store: SnapshotStore;
  constructor(private readonly options: SnapshotStoreOptions & { workerFile: string }) {
    this.store = new SnapshotStore(options);
  }
  list(): SnapshotMeta[] { return this.store.list(); }
  preview(id: string): SnapshotMeta { return this.store.preview(id); }
  runtimeBin(id: string): string { return this.store.runtimeBin(id); }
  runtimeRoot(id: string): string { return this.store.runtimeRoot(id); }
  pendingRestore(): PendingRestore | undefined { return this.store.pendingRestore(); }
  completeRestore(): void { this.store.completeRestore(); }
  create(runtime: SnapshotRuntime, reason?: string): Promise<SnapshotMeta> { return this.run("create", { runtime, reason }); }
  restore(id: string, runtime?: SnapshotRuntime, options?: SnapshotRestoreOptions): Promise<RestoreResult> {
    return this.run("restore", { id, runtime, options });
  }
  recover(): Promise<PendingRestore | undefined> { return this.run("recover", {}); }
  async delete(id: string): Promise<void> {
    if (this.options.inUse?.(id)) throw new Error("The active snapshot cannot be deleted.");
    await this.run("delete", { id });
  }
  private run<T>(operation: string, args: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(pathToFileURL(this.options.workerFile), {
        workerData: { home: this.options.home, root: this.options.root, operation, ...args },
        execArgv: [],
      });
      let reply: { ok: boolean; result?: T; error?: string } | undefined;
      worker.once("message", value => { reply = value; });
      worker.once("error", reject);
      worker.once("exit", code => {
        if (code !== 0 || !reply) reject(new Error(`Snapshot worker exited without completing (${code}).`));
        else if (!reply.ok) reject(new Error(reply.error || "Snapshot operation failed."));
        else resolve(reply.result as T);
      });
    });
  }
}
