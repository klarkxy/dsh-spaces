import { parentPort, workerData } from "node:worker_threads";
import { SnapshotStore, type SnapshotRestoreOptions } from "./snapshot-store";
import type { SnapshotRuntime } from "../shared/snapshots";

const input = workerData as {
  home: string;
  root: string;
  operation: "create" | "restore" | "recover" | "delete";
  runtime?: SnapshotRuntime;
  id?: string;
  reason?: string;
  options?: SnapshotRestoreOptions;
};
try {
  const store = new SnapshotStore({ home: input.home, root: input.root });
  const result = input.operation === "create" ? store.create(input.runtime!, input.reason)
    : input.operation === "restore" ? store.restore(input.id!, input.runtime, input.options)
    : input.operation === "recover" ? store.recover() : store.delete(input.id!);
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
} finally { parentPort!.close(); }
