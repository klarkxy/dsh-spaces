import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { OperationLock } from "../../core/ports/operation-lock";
import { assertNotRealHome } from "./home-guard";

export type { OperationLock } from "../../core/ports/operation-lock";

export const HOME_LOCK_DIR_NAME = ".dsh-spaces-lock";
export const HOME_LOCK_OWNER_FILE = "owner.json";
export const HOME_RECLAIM_DIR_NAME = ".dsh-spaces-reclaim";

export interface HomeLockOwner {
  pid: number;
  nonce: string;
  startedAt: string;
  label: string;
}

export type HomeLockInspect =
  | { held: false; lockDir: string }
  | { held: true; incomplete: true; lockDir: string }
  | { held: true; reclaim: true; lockDir: string }
  | { held: true; ambiguous: true; reason: string; lockDir: string }
  | { held: true; owner: HomeLockOwner; lockDir: string };

export type UnlockDeadResult =
  | { unlocked: false; reason: "not-held" }
  | { unlocked: false; reason: "incomplete" }
  | { unlocked: false; reason: "reclaim-in-progress" }
  | { unlocked: false; reason: "ambiguous"; detail: string }
  | { unlocked: false; reason: "owner-alive"; pid: number }
  | { unlocked: false; reason: "remove-failed"; detail: string }
  | { unlocked: true; owner: HomeLockOwner };

interface LockStore {
  nonce: string;
  generation: number;
}

export class HomeLockBusyError extends Error {
  readonly name = "HomeLockBusyError";
  constructor(
    message: string,
    readonly inspection: HomeLockInspect,
  ) {
    super(message);
  }
}

export class HomeLockReleaseError extends Error {
  readonly name = "HomeLockReleaseError";
}

/**
 * Cross-process home lock. Ownership is exclusive `mkdir` of
 * `{canonicalHome}/.dsh-spaces-lock` (outside snapshot-replaced hub/profiles).
 * Nested `run` is reentrant only while this instance still owns the active generation.
 * Dead-owner reclaim takes exclusive `{canonicalHome}/.dsh-spaces-reclaim` first;
 * acquisition honors that guard and never auto-steals incomplete state.
 */
export class HomeOperationLock implements OperationLock {
  readonly home: string;
  readonly lockDir: string;
  readonly reclaimDir: string;
  private readonly ownerFile: string;
  private readonly als = new AsyncLocalStorage<LockStore>();
  private tail: Promise<unknown> = Promise.resolve();
  private nonce: string | undefined;
  private activeGeneration = 0;

  constructor(home: string, options: { allowRealHome?: boolean } = {}) {
    this.home = canonicalHome(home, options);
    this.lockDir = join(this.home, HOME_LOCK_DIR_NAME);
    this.reclaimDir = join(this.home, HOME_RECLAIM_DIR_NAME);
    this.ownerFile = join(this.lockDir, HOME_LOCK_OWNER_FILE);
  }

  inspect(): HomeLockInspect {
    return inspectLock(this.lockDir, this.ownerFile, this.reclaimDir);
  }

  unlockDead(): UnlockDeadResult {
    const first = this.inspect();
    if (!first.held) return { unlocked: false, reason: "not-held" };
    if ("reclaim" in first && first.reclaim) {
      return { unlocked: false, reason: "reclaim-in-progress" };
    }
    if ("ambiguous" in first && first.ambiguous) {
      return { unlocked: false, reason: "ambiguous", detail: first.reason };
    }
    if ("incomplete" in first && first.incomplete) {
      return { unlocked: false, reason: "incomplete" };
    }
    if (!("owner" in first)) return { unlocked: false, reason: "incomplete" };

    const liveness = pidLiveness(first.owner.pid);
    if (liveness !== "dead") {
      return { unlocked: false, reason: "owner-alive", pid: first.owner.pid };
    }

    try {
      mkdirSync(this.reclaimDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return { unlocked: false, reason: "reclaim-in-progress" };
      throw error;
    }

    try {
      const owner = readOwnerFile(this.ownerFile);
      if (!owner) {
        dropReclaim(this.reclaimDir);
        return { unlocked: false, reason: "not-held" };
      }
      if (owner === "ambiguous") {
        dropReclaim(this.reclaimDir);
        return { unlocked: false, reason: "ambiguous", detail: "lock owner file is a symlink" };
      }
      if (owner.nonce !== first.owner.nonce || owner.pid !== first.owner.pid) {
        dropReclaim(this.reclaimDir);
        return { unlocked: false, reason: "owner-alive", pid: owner.pid };
      }
      removeOwnedLock(this.ownerFile, this.lockDir, owner.nonce);
      dropReclaim(this.reclaimDir);
      return { unlocked: true, owner };
    } catch (error) {
      return {
        unlocked: false,
        reason: "remove-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  run<T>(label: string, action: () => Promise<T>): Promise<T> {
    const name = requireLabel(label);
    if (this.isReentrant()) return action();

    let endTurn!: () => void;
    const turn = new Promise<void>((resolveTurn) => {
      endTurn = resolveTurn;
    });
    const previous = this.tail;
    this.tail = previous.then(
      () => turn,
      () => turn,
    );

    return (async () => {
      try {
        await previous;
        if (this.isReentrant()) return await action();
        this.acquire(name);
        const nonce = this.nonce!;
        const generation = this.activeGeneration;
        try {
          return await this.als.run({ nonce, generation }, action);
        } finally {
          this.finishOwnership(nonce);
        }
      } finally {
        endTurn();
      }
    })();
  }

  private isReentrant(): boolean {
    const store = this.als.getStore();
    return (
      store !== undefined &&
      this.nonce !== undefined &&
      store.nonce === this.nonce &&
      store.generation === this.activeGeneration
    );
  }

  private acquire(label: string): void {
    const existing = this.inspect();
    if (existing.held) throw busyError(existing);

    try {
      mkdirSync(this.lockDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw busyError(this.inspect());
      throw error;
    }

    const raced = this.inspect();
    if (("reclaim" in raced && raced.reclaim) || ("ambiguous" in raced && raced.ambiguous)) {
      abortUncommittedLock(this.lockDir, this.ownerFile);
      throw busyError(raced);
    }

    const owner: HomeLockOwner = {
      pid: process.pid,
      nonce: randomBytes(16).toString("hex"),
      startedAt: new Date().toISOString(),
      label,
    };
    try {
      writeFileSync(this.ownerFile, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch {
      this.nonce = undefined;
      throw new HomeLockBusyError(
        `home lock creation did not finish writing owner; lock remains held to fail closed (${this.lockDir})`,
        this.inspect(),
      );
    }
    this.nonce = owner.nonce;
    this.activeGeneration += 1;
  }

  private finishOwnership(nonce: string): void {
    this.activeGeneration += 1;
    this.nonce = undefined;
    removeOwnedLock(this.ownerFile, this.lockDir, nonce);
  }
}

export function canonicalHome(home: string, options: { allowRealHome?: boolean } = {}): string {
  if (typeof home !== "string" || !home.trim()) throw new Error("DSH home is required");
  const resolved = resolve(home.trim());
  if (!options.allowRealHome) assertNotRealHome(resolved);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`DSH home does not exist: ${resolved}`);
    throw error;
  }
  if (!options.allowRealHome) assertNotRealHome(canonical);
  const st = lstatSync(canonical);
  if (st.isSymbolicLink()) {
    throw new Error(`DSH home resolves to a symlink: ${canonical}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`DSH home must be a directory: ${canonical}`);
  }
  return canonical;
}

function requireLabel(label: string): string {
  const name = label.trim();
  if (!name) throw new Error("Home lock label is required");
  return name;
}

function inspectLock(lockDir: string, ownerFile: string, reclaimDir: string): HomeLockInspect {
  try {
    const reclaimStat = lstatSync(reclaimDir);
    if (reclaimStat.isSymbolicLink()) {
      return { held: true, ambiguous: true, reason: "reclaim path is a symlink", lockDir };
    }
    if (!reclaimStat.isDirectory()) {
      return { held: true, ambiguous: true, reason: "reclaim path is not a directory", lockDir };
    }
    return { held: true, reclaim: true, lockDir };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let lockStat;
  try {
    lockStat = lstatSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { held: false, lockDir };
    }
    throw error;
  }
  if (lockStat.isSymbolicLink()) {
    return { held: true, ambiguous: true, reason: "lock directory is a symlink", lockDir };
  }
  if (!lockStat.isDirectory()) {
    return { held: true, ambiguous: true, reason: "lock path is not a directory", lockDir };
  }

  const owner = readOwnerFile(ownerFile);
  if (owner === undefined) return { held: true, incomplete: true, lockDir };
  if (owner === "ambiguous") {
    return { held: true, ambiguous: true, reason: "lock owner file is a symlink", lockDir };
  }
  return { held: true, owner, lockDir };
}

function readOwnerFile(ownerFile: string): HomeLockOwner | "ambiguous" | undefined {
  let ownerStat;
  try {
    ownerStat = lstatSync(ownerFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (ownerStat.isSymbolicLink()) return "ambiguous";
  if (!ownerStat.isFile()) return "ambiguous";
  let raw: string;
  try {
    raw = readFileSync(ownerFile, "utf8");
  } catch {
    return undefined;
  }
  return parseOwner(raw);
}

function parseOwner(raw: string): HomeLockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const row = parsed as Record<string, unknown>;
  if (!Number.isInteger(row.pid) || (row.pid as number) <= 0) return undefined;
  if (typeof row.nonce !== "string" || !row.nonce) return undefined;
  if (typeof row.startedAt !== "string" || !row.startedAt) return undefined;
  if (typeof row.label !== "string" || !row.label.trim()) return undefined;
  return {
    pid: row.pid as number,
    nonce: row.nonce,
    startedAt: row.startedAt,
    label: row.label.trim(),
  };
}

function pidLiveness(pid: number): "alive" | "dead" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    // ESRCH is the only proof the owner is gone. EPERM means the process exists
    // (or is inaccessible); treat that as live and refuse to steal.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "alive";
  }
}

function removeOwnedLock(ownerFile: string, lockDir: string, nonce: string): void {
  let lockStat;
  try {
    lockStat = lstatSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new HomeLockReleaseError(`home lock path is ambiguous during release: ${lockDir}`);
  }

  const owner = readOwnerFile(ownerFile);
  if (owner === undefined) {
    throw new HomeLockReleaseError(`home lock owner is missing during release; lock left in place: ${lockDir}`);
  }
  if (owner === "ambiguous") {
    throw new HomeLockReleaseError(`home lock owner path is ambiguous during release: ${ownerFile}`);
  }
  if (owner.nonce !== nonce) {
    throw new HomeLockReleaseError("home lock release nonce mismatch; lock left in place");
  }
  try {
    unlinkSync(ownerFile);
    rmdirSync(lockDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HomeLockReleaseError(`home lock release failed; lock left in place: ${detail}`);
  }
}

function abortUncommittedLock(lockDir: string, ownerFile: string): void {
  try {
    lstatSync(ownerFile);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    rmdirSync(lockDir);
  } catch {
    /* lock dir is no longer the empty directory we just created */
  }
}

function dropReclaim(reclaimDir: string): void {
  try {
    const st = lstatSync(reclaimDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new HomeLockReleaseError(`reclaim path is ambiguous: ${reclaimDir}`);
    }
    rmdirSync(reclaimDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function busyError(inspection: HomeLockInspect): HomeLockBusyError {
  if (!inspection.held) {
    return new HomeLockBusyError(`home lock is busy (${inspection.lockDir})`, inspection);
  }
  if ("reclaim" in inspection && inspection.reclaim) {
    return new HomeLockBusyError(
      `home lock reclaim is in progress: ${inspection.lockDir}`,
      inspection,
    );
  }
  if ("ambiguous" in inspection && inspection.ambiguous) {
    return new HomeLockBusyError(
      `home lock path is ambiguous (${inspection.reason}): ${inspection.lockDir}`,
      inspection,
    );
  }
  if ("incomplete" in inspection && inspection.incomplete) {
    return new HomeLockBusyError(
      `home lock is incomplete and cannot be stolen: ${inspection.lockDir}`,
      inspection,
    );
  }
  if ("owner" in inspection) {
    return new HomeLockBusyError(
      `home lock is held by pid ${inspection.owner.pid} (${inspection.owner.label})`,
      inspection,
    );
  }
  return new HomeLockBusyError(`home lock is busy (${inspection.lockDir})`, inspection);
}
