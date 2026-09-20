import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "./atomic";
import { assertNotRealHome } from "./home-guard";
import { ProcessTerminationError } from "./terminate-process";

export interface ChildObservation {
  attach(child: ChildProcess): void;
  cancel(): void;
}

const observationScope = new AsyncLocalStorage<() => ChildObservation>();
const observed = new Map<string, { record: Record<string, unknown>; child: ChildProcess }>();
const recordKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export function ownsObservedChild(home: string, value: Record<string, unknown>): boolean {
  if (typeof value.spaceId !== "string" || !/^maintenance-[a-f0-9]{12}$/.test(value.spaceId)) return false;
  const current = observed.get(recordKey(join(home, ".dsh-spaces-control", "instances", `${value.spaceId}.json`)));
  return Boolean(current && current.child.exitCode === null && current.child.signalCode === null &&
    ["version", "kind", "spaceId", "pid", "startedAt"].every(key => value[key] === current.record[key]));
}

/** Propagates the owning Home through asynchronous CLI/package-manager work. */
export function withChildObservation<T>(factory: () => ChildObservation, action: () => T): T {
  return observationScope.run(factory, action);
}

/** Profile supervisors and upgrade candidates already keep their own records. */
export function withoutChildObservation<T>(action: () => T): T {
  return observationScope.exit(action);
}

export function spawnObserved(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const observation = observationScope.getStore()?.();
  let child: ChildProcess;
  try { child = spawn(command, args, options); }
  catch (error) { observation?.cancel(); throw error; }
  try { observation?.attach(child); }
  catch {
    // Keep the intent: callers must not remove files while this child may write.
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("error", () => {});
    throw new ProcessTerminationError("Subprocess identity could not be persisted; recovery is required.");
  }
  return child;
}

/** Persist before spawning. An interrupted intent without a PID stays ambiguous. */
export function observeMaintenanceChild(home: string, onWriteFailure: () => void): ChildObservation {
  assertNotRealHome(home);
  const directory = join(home, ".dsh-spaces-control", "instances");
  const spaceId = `maintenance-${randomBytes(6).toString("hex")}`;
  const file = join(directory, `${spaceId}.json`);
  const record = { version: 1, kind: "maintenance", spaceId, startedAt: new Date().toISOString() };
  mkdirSync(directory, { recursive: true });
  atomicWrite(file, JSON.stringify({ ...record, phase: "spawning" }));
  const cancel = () => {
    observed.delete(recordKey(file));
    try { unlinkSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") onWriteFailure(); }
  };
  return {
    cancel,
    attach(child) {
      if (!child.pid) { child.once("error", cancel); return; }
      child.once("exit", cancel);
      try {
        const actual = { ...record, pid: child.pid };
        atomicWrite(file, JSON.stringify(actual));
        observed.set(recordKey(file), { record: actual, child });
      }
      catch (error) { onWriteFailure(); throw error; }
    },
  };
}
