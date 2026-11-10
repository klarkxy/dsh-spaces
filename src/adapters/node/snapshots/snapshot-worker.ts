import { inside, lexists, lstatSync, realpathSync } from "../../../shared/node/filesystem";
import { readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { runRuntimeInstallation } from "../runtime/runtime-installation";
import { renameDirectory } from "../atomic";
import { authorizeProductHome, samePath } from "../home/home-guard";
import {
  clearRuntimeFallback,
  copyLinkedTree,
  retargetTree,
  SnapshotStore,
} from "./snapshot-store";
import type { SnapshotRuntime } from "../../../shared/snapshots";
import type { PackageSource } from "../../../shared/types";
import { ProcessTerminationError } from "../runtime/terminate-process";

type SnapshotWorkerOperation =
  | "runtimeInstall"
  | "create"
  | "delete"
  | "copyLinkedTree"
  | "removeTree"
  | "renameTree"
  | "retargetTree"
  | "clearRuntimeFallback";

const input = workerData as {
  home: string;
  root?: string;
  operation: SnapshotWorkerOperation;
  allowProductHome?: boolean;
  runtime?: SnapshotRuntime;
  id?: string;
  reason?: string;
  src?: string;
  dest?: string;
  fallbackRuntimeRoot?: string;
  target?: string;
  dir?: string;
  oldRoot?: string;
  newRoot?: string;
  profiles?: string;
  runtimeRoot?: string;
  version?: string;
  packageSource?: PackageSource;
  toolchainRoot?: string;
};

void (async () => {
try {
  if (input.allowProductHome) authorizeProductHome(input.home);
  const result = await dispatch(input);
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof ProcessTerminationError ? "ProcessTerminationError" : "Error" });
} finally {
  parentPort!.close();
}
})();

function dispatch(data: typeof input): unknown {
  if (data.operation === "runtimeInstall") {
    return runRuntimeInstallation({
      home: data.home,
      runtimeRoot: data.runtimeRoot!,
      version: data.version!,
      packageSource: data.packageSource!,
      snapshotRoot: data.root,
      toolchainRoot: data.toolchainRoot,
    });
  }
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
  const store = new SnapshotStore({ home: data.home, root: data.root! });
  if (data.operation === "create") return store.create(data.runtime!, data.reason);
  if (data.operation === "delete") {
    store.delete(data.id!);
    return undefined;
  }
  throw new Error(`Unsupported snapshot worker operation: ${data.operation}`);
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


function assertContained(root: string, target: string, label: string): void {
  const resolved = resolve(target);
  if (!inside(root, resolved) && !samePath(root, resolved)) {
    throw new Error(`Refusing to touch path outside ${label}: ${resolved}`);
  }
  if (!lexists(resolved)) return;
  const st = lstatSync(resolved);
  if (st.isSymbolicLink()) return;
  const real = realpathSync(resolved);
  const realRoot = lexists(root) ? (lstatSync(root).isSymbolicLink() ? resolve(root) : realpathSync(root)) : resolve(root);
  if (!inside(realRoot, real) && !samePath(realRoot, real)) {
    throw new Error(`Refusing to touch path outside ${label}: ${real}`);
  }
}

