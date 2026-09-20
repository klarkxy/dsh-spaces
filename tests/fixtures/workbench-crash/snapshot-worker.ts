/**
 * Test-only snapshot worker. Installs the original SnapshotStore.inject seam on
 * restore, then loads the production snapshot-worker dispatcher (runtimeInstall,
 * async errors, child-process journals). Do not pack this as a product worker.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotStore } from "../../../src/main/snapshot-store.ts";

type SnapshotInject = (op: string, detail?: string) => void;

const hook = String(process.env.DSH_FAULT_SNAPSHOT_HOOK ?? "").trim();
const action = String(process.env.DSH_FAULT_SNAPSHOT_ACTION ?? "").trim();
const markerDir = String(process.env.DSH_FAULT_MARKER_DIR ?? "").trim();

if (hook) {
  const originalRestore = SnapshotStore.prototype.restore;
  SnapshotStore.prototype.restore = function restoreWithFaultInject(
    this: SnapshotStore,
    id: string,
    runtime?: Parameters<typeof originalRestore>[1],
    options?: Parameters<typeof originalRestore>[2],
  ) {
    const store = this as SnapshotStore & { inject?: SnapshotInject };
    const previous = store.inject;
    store.inject = (op, detail) => {
      previous?.(op, detail);
      if (op === hook) onSnapshotHook(op, detail);
    };
    try {
      return originalRestore.call(this, id, runtime, options);
    } finally {
      store.inject = previous;
    }
  };
}

await import("../../../src/main/snapshot-worker.ts");

function onSnapshotHook(op: string, detail?: string): void {
  writeMarker({
    kind: "snapshot",
    op,
    detail: detail ?? null,
    pid: process.pid,
    action,
    at: new Date().toISOString(),
  });
  if (action === "kill") process.kill(process.pid, "SIGKILL");
  throw new Error(`fault inject ${op}`);
}

function writeMarker(payload: Record<string, unknown>): void {
  if (!markerDir) throw new Error("DSH_FAULT_MARKER_DIR is required when a snapshot hook fires");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, "fault-marker.json"), `${JSON.stringify(payload, null, 2)}\n`);
  appendFileSync(join(markerDir, "fault-marker.jsonl"), `${JSON.stringify(payload)}\n`);
}
