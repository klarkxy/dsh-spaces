import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { isAuthorizedProductHome } from "./home-guard";
import { ProcessTerminationError } from "./terminate-process";
import { SnapshotStore, type SnapshotStoreOptions } from "./snapshot-store";
import type {
  PendingRestore,
  RestoreJournal,
  RestoreRecoveryReceipt,
  RestoreResult,
  SnapshotMeta,
  SnapshotRuntime,
} from "../shared/snapshots";
import type { SnapshotRestoreOptions } from "./snapshot-store";

export type SnapshotWorkerOperation =
  | "runtimeInstall"
  | "create"
  | "restore"
  | "recover"
  | "delete"
  | "completeRestore"
  | "copyLinkedTree"
  | "removeTree"
  | "renameTree"
  | "retargetTree"
  | "clearRuntimeFallback";

export type SnapshotWorkerData = {
  home: string;
  root?: string;
  operation: SnapshotWorkerOperation;
  allowProductHome?: boolean;
} & Record<string, unknown>;

/** Large copies run off the HTTP event loop; the maintenance gate owns admission. */
export class SnapshotExecutor {
  private readonly store: SnapshotStore;
  constructor(private readonly options: SnapshotStoreOptions & { workerFile: string; workerExecArgv?: string[] }) {
    this.store = new SnapshotStore(options);
  }
  list(): SnapshotMeta[] { return this.store.list(); }
  preview(id: string): SnapshotMeta { return this.store.preview(id); }
  runtimeBin(id: string): string { return this.store.runtimeBin(id); }
  runtimeRoot(id: string): string { return this.store.runtimeRoot(id); }
  pendingRestore(): PendingRestore | undefined { return this.store.pendingRestore(); }
  restoreJournal(): RestoreJournal | undefined { return this.store.restoreJournal(); }
  recoveryReceipt(): RestoreRecoveryReceipt | undefined { return this.store.recoveryReceipt(); }
  completeRestore(): Promise<void> {
    return Promise.reject(new Error("Snapshot restore is not supported."));
  }
  create(runtime: SnapshotRuntime, reason?: string): Promise<SnapshotMeta> { return this.run("create", { runtime, reason }); }
  restore(_id: string, _runtime?: SnapshotRuntime, _options?: SnapshotRestoreOptions): Promise<RestoreResult> {
    return Promise.reject(new Error("Snapshot restore is not supported."));
  }
  recover(): Promise<PendingRestore | undefined> {
    return Promise.reject(new Error("Upgrade recovery is not supported."));
  }
  async delete(id: string): Promise<void> {
    if (this.options.inUse?.(id)) throw new Error("The active snapshot cannot be deleted.");
    await this.run("delete", { id });
  }
  private run<T>(operation: SnapshotWorkerOperation, args: object): Promise<T> {
    return runSnapshotWorker<T>(this.options.workerFile, {
      home: this.options.home,
      root: this.options.root,
      operation,
      allowProductHome: isAuthorizedProductHome(this.options.home),
      ...args,
    }, this.options.workerExecArgv ?? []);
  }
}

export function runSnapshotWorker<T>(
  workerFile: string,
  workerData: SnapshotWorkerData,
  execArgv: string[] = [],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(workerFile), {
      workerData,
      execArgv,
    });
    let reply: { ok: boolean; result?: T; error?: string; errorName?: string } | undefined;
    worker.once("message", value => { reply = value; });
    worker.once("error", error => reject(workerData.operation === "runtimeInstall"
      ? new ProcessTerminationError(`Runtime maintenance worker failed: ${error.message}`) : error));
    worker.once("exit", code => {
      if (code !== 0 || !reply) {
        const Failure = workerData.operation === "runtimeInstall" ? ProcessTerminationError : Error;
        reject(new Failure(`Maintenance worker exited without completing (${code}).`));
      }
      else if (!reply.ok) {
        const Failure = reply.errorName === "ProcessTerminationError" ? ProcessTerminationError : Error;
        reject(new Failure(reply.error || "Maintenance operation failed."));
      }
      else resolve(reply.result as T);
    });
  });
}
