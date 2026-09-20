/**
 * Test-only snapshot worker. Installs SnapshotStore.inject on create, then loads
 * the production dispatcher. Restore is not patched. Do not pack as a product worker.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotStore } from "../../../src/adapters/node/snapshot-store.ts";

type SnapshotInject = (op: string, detail?: string) => void;

const hook = String(process.env.DSH_FAULT_SNAPSHOT_HOOK ?? "").trim();
const action = String(process.env.DSH_FAULT_SNAPSHOT_ACTION ?? "").trim();
const markerDir = String(process.env.DSH_FAULT_MARKER_DIR ?? "").trim();

if (hook) {
  const originalCreate = SnapshotStore.prototype.create;
  SnapshotStore.prototype.create = function createWithFaultInject(
    this: SnapshotStore,
    runtime: Parameters<typeof originalCreate>[0],
    reason?: Parameters<typeof originalCreate>[1],
  ) {
    const store = this as SnapshotStore & { inject?: SnapshotInject };
    const previous = store.inject;
    store.inject = (op, detail) => {
      previous?.(op, detail);
      if (op === hook) onSnapshotHook(op, detail);
    };
    try {
      return originalCreate.call(this, runtime, reason);
    } finally {
      store.inject = previous;
    }
  };
}

await import("../../../src/adapters/node/snapshot-worker.ts");

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
