/**
 * Test-only snapshot worker. Dispatches through the original SnapshotStore and
 * the original IO helpers. Inject is the existing SnapshotStore.inject seam,
 * configured from DSH_FAULT_* env so SnapshotExecutor need not grow a debug API.
 * Do not pack this as a product worker.
 */
import { appendFileSync, lstatSync, mkdirSync, readdirSync, rmdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { renameDirectory } from "../src/adapters/node/atomic.ts";
import { authorizeProductHome, samePath } from "../src/adapters/node/home-guard.ts";
import {
  clearRuntimeFallback,
  copyLinkedTree,
  retargetTree,
  SnapshotStore,
  type SnapshotRestoreOptions,
} from "../src/adapters/node/snapshot-store.ts";
import type { SnapshotRuntime } from "../src/shared/snapshots.ts";

type SnapshotWorkerOperation =
  | "create"
  | "restore"
  | "recover"
  | "delete"
  | "completeRestore"
  | "copyLinkedTree"
  | "removeTree"
  | "renameTree"
  | "retargetTree"
  | "clearRuntimeFallback"
  | "runtimeInstall";

const input = workerData as {
  home: string;
  root?: string;
  operation: SnapshotWorkerOperation;
  allowProductHome?: boolean;
  runtime?: SnapshotRuntime;
  id?: string;
  reason?: string;
  options?: SnapshotRestoreOptions;
  src?: string;
  dest?: string;
  fallbackRuntimeRoot?: string;
  target?: string;
  dir?: string;
  oldRoot?: string;
  newRoot?: string;
  profiles?: string;
  runtimeRoot?: string;
};

const hook = String(process.env.DSH_FAULT_SNAPSHOT_HOOK ?? "").trim();
const action = String(process.env.DSH_FAULT_SNAPSHOT_ACTION ?? "").trim();
const markerDir = String(process.env.DSH_FAULT_MARKER_DIR ?? "").trim();

try {
  if (input.allowProductHome) authorizeProductHome(input.home);
  const result = dispatch(input);
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  parentPort!.close();
}

function dispatch(data: typeof input): unknown {
  if (data.operation === "copyLinkedTree") {
    copyLinkedTree(data.src!, data.dest!, data.fallbackRuntimeRoot);
    return undefined;
  }
  if (data.operation === "removeTree") {
    removeTreeContained(data.home, data.target!);
    return undefined;
  }
  if (data.operation === "renameTree") {
    renameDirectory(data.src!, data.dest!);
    return undefined;
  }
  if (data.operation === "retargetTree") {
    retargetTree(data.dir!, data.oldRoot!, data.newRoot!);
    return undefined;
  }
  if (data.operation === "clearRuntimeFallback") {
    clearRuntimeFallback(data.profiles!, data.runtimeRoot!);
    return undefined;
  }
  if (data.operation === "restore" || data.operation === "recover" || data.operation === "completeRestore") {
    throw new Error("Snapshot restore is not supported.");
  }
  const store = new SnapshotStore({
    home: data.home,
    root: data.root!,
    inject: hook ? onSnapshotHook : undefined,
  });
  if (data.operation === "create") return store.create(data.runtime!, data.reason);
  if (data.operation === "delete") {
    store.delete(data.id!);
    return undefined;
  }
  throw new Error(`Unsupported snapshot worker operation: ${data.operation}`);
}

function onSnapshotHook(op: string, detail?: string): void {
  if (op !== hook) return;
  writeMarker({
    kind: "snapshot",
    op,
    detail: detail ?? null,
    pid: process.pid,
    action,
    at: new Date().toISOString(),
  });
  if (action === "kill") {
    process.kill(process.pid, "SIGKILL");
  }
  throw new Error(`fault inject ${op}`);
}

function writeMarker(payload: Record<string, unknown>): void {
  if (!markerDir) throw new Error("DSH_FAULT_MARKER_DIR is required when a snapshot hook fires");
  mkdirSync(markerDir, { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(join(markerDir, "fault-marker.json"), body);
  appendFileSync(join(markerDir, "fault-marker.jsonl"), `${JSON.stringify(payload)}\n`);
}

function removeTreeContained(root: string, target: string): void {
  if (!lexists(target)) return;
  if (samePath(target, root)) throw new Error("Refusing to delete DSH home");
  assertContained(root, target, "controlled directory");
  rmLinkAware(target);
}

function rmLinkAware(path: string): void {
  if (!lexists(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isFile()) {
    unlinkSync(path);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) rmLinkAware(join(path, name));
    rmdirSync(path);
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertContained(root: string, target: string, label: string): void {
  const resolved = resolve(target);
  if (!isInside(root, resolved) && !samePath(root, resolved)) {
    throw new Error(`Refusing to touch path outside ${label}: ${resolved}`);
  }
  if (!lexists(resolved)) return;
  const st = lstatSync(resolved);
  if (st.isSymbolicLink()) return;
  const real = realpathSync(resolved);
  const realRoot = lexists(root) ? (lstatSync(root).isSymbolicLink() ? resolve(root) : realpathSync(root)) : resolve(root);
  if (!isInside(realRoot, real) && !samePath(realRoot, real)) {
    throw new Error(`Refusing to touch path outside ${label}: ${real}`);
  }
}

function isInside(root: string, target: string): boolean {
  const r = canon(root);
  const t = canon(target);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function canon(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
