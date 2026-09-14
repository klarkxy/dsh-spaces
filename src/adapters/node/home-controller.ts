import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../main/atomic";
import { samePath } from "../../main/home-guard";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../shared/types";
import { HomeOperationLock, canonicalHome } from "./home-operation-lock";

export const HOME_CONTROL_DIR_NAME = ".dsh-spaces-control";
export const HOME_CONTROL_MANAGER_FILE = "manager.json";
export const HOME_CONTROL_RUN_DIR_NAME = "run";
export const HOME_CONTROL_OWNER_FILE = "owner.json";
export const HOME_CONTROL_RECLAIM_DIR_NAME = "reclaim";
export const MANAGER_PROFILE_BASE = "spaces-hub";

export type ControlKind = "desktop" | "web";
export type ProfileRole = "manager" | "workspace" | "uninitialized";
export type PidLiveness = "alive" | "dead" | "ambiguous";
export type PidAliveFn = (pid: number, startedAt: string) => PidLiveness;

export interface HomeControllerOptions {
  pidAlive?: PidAliveFn;
  allowRealHome?: boolean;
}

export interface ManagerIdentity {
  profileId: string;
  needsBootstrap: boolean;
}

export interface HomeControlOwner {
  pid: number;
  nonce: string;
  startedAt: string;
  kind: ControlKind;
  endpoint?: string;
}

export type HomeControlInspect =
  | { held: false; runDir: string }
  | { held: true; incomplete: true; runDir: string }
  | { held: true; reclaim: true; runDir: string }
  | { held: true; ambiguous: true; reason: string; runDir: string }
  | { held: true; owner: HomeControlOwner; liveness: PidLiveness; runDir: string };

export type ReclaimDeadResult =
  | { reclaimed: false; reason: "not-held" }
  | { reclaimed: false; reason: "incomplete" }
  | { reclaimed: false; reason: "reclaim-in-progress" }
  | { reclaimed: false; reason: "ambiguous"; detail: string }
  | { reclaimed: false; reason: "owner-alive"; pid: number }
  | { reclaimed: false; reason: "remove-failed"; detail: string }
  | { reclaimed: true; owner: HomeControlOwner };

export interface HomeControlHandle {
  readonly owner: HomeControlOwner;
  release(): void;
}

interface ManagerRecord {
  version: 1;
  profileId: string;
  createdAt: string;
}

export class HomeControlBusyError extends Error {
  readonly name = "HomeControlBusyError";
  constructor(
    message: string,
    readonly inspection: HomeControlInspect,
  ) {
    super(message);
  }
}

export class HomeControlReleaseError extends Error {
  readonly name = "HomeControlReleaseError";
}

export class HomeControlPathError extends Error {
  readonly name = "HomeControlPathError";
}

/**
 * Independent manager identity + long-lived runtime ownership for one canonical home.
 * Control state lives in `{canonicalHome}/.dsh-spaces-control` (not snapshot-replaced).
 * Runtime ownership does not hold the home transaction lock; ensureManager writes do.
 */
export class HomeController {
  readonly home: string;
  readonly controlDir: string;
  readonly runDir: string;
  readonly reclaimDir: string;
  private readonly managerFile: string;
  private readonly ownerFile: string;
  private readonly pidAlive: PidAliveFn;
  private readonly lock: HomeOperationLock;

  constructor(home: string, options: HomeControllerOptions = {}) {
    this.home = canonicalHome(home, options);
    this.controlDir = join(this.home, HOME_CONTROL_DIR_NAME);
    this.managerFile = join(this.controlDir, HOME_CONTROL_MANAGER_FILE);
    this.runDir = join(this.controlDir, HOME_CONTROL_RUN_DIR_NAME);
    this.ownerFile = join(this.runDir, HOME_CONTROL_OWNER_FILE);
    this.reclaimDir = join(this.controlDir, HOME_CONTROL_RECLAIM_DIR_NAME);
    this.pidAlive = options.pidAlive ?? defaultPidAlive;
    this.lock = new HomeOperationLock(this.home, options);
  }

  async ensureManager(): Promise<ManagerIdentity> {
    // Existing identity is a read-only fact. A dead maintenance lock must not
    // prevent the stable entry from opening its recovery controls.
    const recorded = this.readManagerRecord();
    if (recorded && recorded !== "ambiguous") return this.toIdentity(recorded);
    return this.lock.run("ensure-manager", async () => {
      const existing = this.readManagerRecord();
      if (existing === "ambiguous") {
        throw new HomeControlPathError(
          `manager identity is damaged or ambiguous and cannot be rebuilt: ${this.managerFile}`,
        );
      }
      if (existing) return this.toIdentity(existing);
      const profileId = this.chooseManagerProfileId();
      const record: ManagerRecord = {
        version: 1,
        profileId,
        createdAt: new Date().toISOString(),
      };
      this.writeManagerRecord(record);
      const written = this.readManagerRecord();
      if (written === "ambiguous" || !written) {
        throw new HomeControlPathError(`manager identity was not persisted: ${this.managerFile}`);
      }
      return this.toIdentity(written);
    });
  }

  roleOf(profileId: string): ProfileRole {
    const name = requireProfileId(profileId);
    const record = this.readManagerRecord();
    if (record === "ambiguous") {
      throw new HomeControlPathError(
        `manager identity is damaged or ambiguous and cannot be guessed: ${this.managerFile}`,
      );
    }
    if (record && record.profileId === name) return "manager";
    if (this.profileNameTaken(name)) return "workspace";
    return "uninitialized";
  }

  inspect(): HomeControlInspect {
    return inspectRunLock(this.controlDir, this.runDir, this.ownerFile, this.reclaimDir, this.pidAlive);
  }

  acquire(kind: ControlKind, endpoint?: string): HomeControlHandle {
    const ownerKind = requireKind(kind);
    const normalizedEndpoint = endpoint === undefined ? undefined : parseControlEndpoint(endpoint);
    const existing = this.inspect();
    if (existing.held) throw busyError(existing);

    this.ensureControlDir();
    try {
      mkdirSync(this.runDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw busyError(this.inspect());
      throw error;
    }

    const raced = this.inspect();
    if (("reclaim" in raced && raced.reclaim) || ("ambiguous" in raced && raced.ambiguous)) {
      abortUncommittedRun(this.runDir, this.ownerFile);
      throw busyError(raced);
    }

    const owner: HomeControlOwner = {
      pid: process.pid,
      nonce: randomBytes(16).toString("hex"),
      startedAt: new Date().toISOString(),
      kind: ownerKind,
      ...(normalizedEndpoint ? { endpoint: normalizedEndpoint } : {}),
    };
    try {
      writeOwnerFile(this.ownerFile, owner);
    } catch {
      throw new HomeControlBusyError(
        `control ownership creation did not finish writing owner; lock remains held to fail closed (${this.runDir})`,
        this.inspect(),
      );
    }
    return {
      owner,
      release: () => {
        removeOwnedRun(this.ownerFile, this.runDir, owner.nonce);
      },
    };
  }

  reclaimDead(): ReclaimDeadResult {
    const first = this.inspect();
    if (!first.held) return { reclaimed: false, reason: "not-held" };
    if ("reclaim" in first && first.reclaim) {
      return { reclaimed: false, reason: "reclaim-in-progress" };
    }
    if ("ambiguous" in first && first.ambiguous) {
      return { reclaimed: false, reason: "ambiguous", detail: first.reason };
    }
    if ("incomplete" in first && first.incomplete) {
      return { reclaimed: false, reason: "incomplete" };
    }
    if (!("owner" in first)) return { reclaimed: false, reason: "incomplete" };
    if (first.liveness === "ambiguous") {
      return { reclaimed: false, reason: "ambiguous", detail: "owner pid liveness is ambiguous" };
    }
    if (first.liveness !== "dead") {
      return { reclaimed: false, reason: "owner-alive", pid: first.owner.pid };
    }

    this.ensureControlDir();
    try {
      mkdirSync(this.reclaimDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return { reclaimed: false, reason: "reclaim-in-progress" };
      throw error;
    }

    try {
      const owner = readOwnerFile(this.ownerFile);
      if (!owner) {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "not-held" };
      }
      if (owner === "ambiguous") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "ambiguous", detail: "control owner file is a symlink" };
      }
      if (owner.nonce !== first.owner.nonce || owner.pid !== first.owner.pid) {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "owner-alive", pid: owner.pid };
      }
      const liveness = this.pidAlive(owner.pid, owner.startedAt);
      if (liveness === "ambiguous") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "ambiguous", detail: "owner pid liveness is ambiguous" };
      }
      if (liveness !== "dead") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "owner-alive", pid: owner.pid };
      }
      removeOwnedRun(this.ownerFile, this.runDir, owner.nonce);
      dropReclaim(this.reclaimDir);
      return { reclaimed: true, owner };
    } catch (error) {
      try {
        dropReclaim(this.reclaimDir);
      } catch {
        /* keep the original remove failure */
      }
      return {
        reclaimed: false,
        reason: "remove-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private toIdentity(record: ManagerRecord): ManagerIdentity {
    return {
      profileId: record.profileId,
      needsBootstrap: !this.profileNameTaken(record.profileId),
    };
  }

  private readManagerRecord(): ManagerRecord | "ambiguous" | undefined {
    const control = inspectNamedDir(this.controlDir);
    if (control === "missing") return undefined;
    if (control !== "ok") return "ambiguous";
    return readManagerFile(this.managerFile);
  }

  private writeManagerRecord(record: ManagerRecord): void {
    this.ensureControlDir();
    const current = readManagerFile(this.managerFile);
    if (current === "ambiguous") {
      throw new HomeControlPathError(
        `manager identity is damaged or ambiguous and cannot be rebuilt: ${this.managerFile}`,
      );
    }
    if (current) {
      throw new HomeControlPathError("refusing to overwrite a valid manager identity");
    }
    atomicWrite(this.managerFile, `${JSON.stringify(record)}\n`);
  }

  private chooseManagerProfileId(): string {
    const taken = this.existingProfileNames();
    if (isAvailableManagerId(MANAGER_PROFILE_BASE, taken)) return MANAGER_PROFILE_BASE;
    for (let n = 2; n < 10_000; n += 1) {
      const id = `${MANAGER_PROFILE_BASE}-${n}`;
      if (isAvailableManagerId(id, taken)) return id;
    }
    throw new Error("no available spaces-hub profile id");
  }

  private existingProfileNames(): Set<string> {
    const dir = join(this.home, "profiles");
    const state = inspectNamedDir(dir);
    if (state === "missing") return new Set();
    if (state !== "ok") {
      throw new HomeControlPathError(`profiles directory is ambiguous: ${dir}`);
    }
    const names = new Set<string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      names.add(entry.name);
    }
    return names;
  }

  private profileNameTaken(name: string): boolean {
    for (const existing of this.existingProfileNames()) {
      if (profileNamesEqual(existing, name)) return true;
    }
    return false;
  }

  private ensureControlDir(): void {
    try {
      mkdirSync(this.controlDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    const state = inspectNamedDir(this.controlDir);
    if (state !== "ok") {
      throw new HomeControlPathError(`control directory is not a real directory: ${this.controlDir}`);
    }
  }
}

export function parseControlEndpoint(raw: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw !== raw.trim()) {
    throw new Error("control endpoint must be a clean http://127.0.0.1 URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("control endpoint must be a clean http://127.0.0.1 URL");
  }
  if (url.protocol !== "http:") {
    throw new Error("control endpoint must be a clean http://127.0.0.1 URL");
  }
  if (url.hostname !== "127.0.0.1") {
    throw new Error("control endpoint must bind 127.0.0.1");
  }
  if (url.username || url.password) {
    throw new Error("control endpoint must not include credentials");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("control endpoint must not include a path");
  }
  if (url.search || url.hash) {
    throw new Error("control endpoint must not include query or fragment");
  }
  return url.href;
}

export function defaultPidAlive(pid: number, startedAt: string): PidLiveness {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "alive";
  }
  const ownerStart = Date.parse(startedAt);
  if (!Number.isFinite(ownerStart)) return "ambiguous";
  if (pid === process.pid) {
    const selfStart = Date.now() - process.uptime() * 1000;
    if (ownerStart < selfStart - 2000) return "ambiguous";
  }
  return "alive";
}

function requireKind(kind: string): ControlKind {
  if (kind === "desktop" || kind === "web") return kind;
  throw new Error("control kind must be desktop or web");
}

function requireProfileId(profileId: string): string {
  if (typeof profileId !== "string" || !profileId.trim() || profileId !== profileId.trim()) {
    throw new Error("profile id is required");
  }
  if (profileId.includes("/") || profileId.includes("\\") || profileId.includes("..") || profileId.includes("\0")) {
    throw new Error("profile id cannot be a path");
  }
  return profileId;
}

function profileNamesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isAvailableManagerId(id: string, taken: Set<string>): boolean {
  if (!PROFILE_NAME_RE.test(id)) return false;
  if ((RESERVED_PROFILE_NAMES as readonly string[]).some((name) => profileNamesEqual(name, id))) return false;
  for (const name of taken) {
    if (profileNamesEqual(name, id)) return false;
  }
  return true;
}

function inspectNamedDir(path: string): "ok" | "missing" | "ambiguous" {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (st.isSymbolicLink()) return "ambiguous";
  if (!st.isDirectory()) return "ambiguous";
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return "ambiguous";
  }
  if (!samePath(real, path)) return "ambiguous";
  return "ok";
}

function inspectRunLock(
  controlDir: string,
  runDir: string,
  ownerFile: string,
  reclaimDir: string,
  pidAlive: PidAliveFn,
): HomeControlInspect {
  const control = inspectNamedDir(controlDir);
  if (control === "ambiguous") {
    return { held: true, ambiguous: true, reason: "control directory is a symlink or alias", runDir };
  }

  try {
    const reclaimStat = lstatSync(reclaimDir);
    if (reclaimStat.isSymbolicLink()) {
      return { held: true, ambiguous: true, reason: "reclaim path is a symlink", runDir };
    }
    if (!reclaimStat.isDirectory()) {
      return { held: true, ambiguous: true, reason: "reclaim path is not a directory", runDir };
    }
    return { held: true, reclaim: true, runDir };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let runStat;
  try {
    runStat = lstatSync(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { held: false, runDir };
    }
    throw error;
  }
  if (runStat.isSymbolicLink()) {
    return { held: true, ambiguous: true, reason: "run directory is a symlink", runDir };
  }
  if (!runStat.isDirectory()) {
    return { held: true, ambiguous: true, reason: "run path is not a directory", runDir };
  }
  try {
    if (!samePath(realpathSync(runDir), runDir)) {
      return { held: true, ambiguous: true, reason: "run directory is a path alias", runDir };
    }
  } catch {
    return { held: true, ambiguous: true, reason: "run directory is a path alias", runDir };
  }

  const owner = readOwnerFile(ownerFile);
  if (owner === undefined) return { held: true, incomplete: true, runDir };
  if (owner === "ambiguous") {
    return { held: true, ambiguous: true, reason: "control owner file is a symlink", runDir };
  }
  return { held: true, owner, liveness: pidAlive(owner.pid, owner.startedAt), runDir };
}

function readManagerFile(managerFile: string): ManagerRecord | "ambiguous" | undefined {
  let st;
  try {
    st = lstatSync(managerFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "ambiguous";
  }
  if (st.isSymbolicLink() || !st.isFile()) return "ambiguous";
  let raw: string;
  try {
    raw = readFileSync(managerFile, "utf8");
  } catch {
    return "ambiguous";
  }
  return parseManager(raw);
}

function parseManager(raw: string): ManagerRecord | "ambiguous" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "ambiguous";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "ambiguous";
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1) return "ambiguous";
  if (typeof row.profileId !== "string" || !isAvailableManagerId(row.profileId, new Set())) return "ambiguous";
  if (typeof row.createdAt !== "string" || !row.createdAt) return "ambiguous";
  return {
    version: 1,
    profileId: row.profileId,
    createdAt: row.createdAt,
  };
}

function readOwnerFile(ownerFile: string): HomeControlOwner | "ambiguous" | undefined {
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

function parseOwner(raw: string): HomeControlOwner | undefined {
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
  if (row.kind !== "desktop" && row.kind !== "web") return undefined;
  const owner: HomeControlOwner = {
    pid: row.pid as number,
    nonce: row.nonce,
    startedAt: row.startedAt,
    kind: row.kind,
  };
  if (row.endpoint !== undefined) {
    try {
      owner.endpoint = parseControlEndpoint(String(row.endpoint));
    } catch {
      return undefined;
    }
  }
  return owner;
}

function writeOwnerFile(ownerFile: string, owner: HomeControlOwner): void {
  const payload: HomeControlOwner = {
    pid: owner.pid,
    nonce: owner.nonce,
    startedAt: owner.startedAt,
    kind: owner.kind,
  };
  if (owner.endpoint) payload.endpoint = owner.endpoint;
  writeFileSync(ownerFile, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function removeOwnedRun(ownerFile: string, runDir: string, nonce: string): void {
  let runStat;
  try {
    runStat = lstatSync(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
    throw new HomeControlReleaseError(`control run path is ambiguous during release: ${runDir}`);
  }

  const owner = readOwnerFile(ownerFile);
  if (owner === undefined) {
    throw new HomeControlReleaseError(`control owner is missing during release; lock left in place: ${runDir}`);
  }
  if (owner === "ambiguous") {
    throw new HomeControlReleaseError(`control owner path is ambiguous during release: ${ownerFile}`);
  }
  if (owner.nonce !== nonce) {
    throw new HomeControlReleaseError("control release nonce mismatch; lock left in place");
  }
  try {
    unlinkSync(ownerFile);
    rmdirSync(runDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HomeControlReleaseError(`control release failed; lock left in place: ${detail}`);
  }
}

function abortUncommittedRun(runDir: string, ownerFile: string): void {
  try {
    lstatSync(ownerFile);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    rmdirSync(runDir);
  } catch {
    /* run dir is no longer the empty directory we just created */
  }
}

function dropReclaim(reclaimDir: string): void {
  try {
    const st = lstatSync(reclaimDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new HomeControlReleaseError(`reclaim path is ambiguous: ${reclaimDir}`);
    }
    rmdirSync(reclaimDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function busyError(inspection: HomeControlInspect): HomeControlBusyError {
  if (!inspection.held) {
    return new HomeControlBusyError(`control run lock is busy (${inspection.runDir})`, inspection);
  }
  if ("reclaim" in inspection && inspection.reclaim) {
    return new HomeControlBusyError(`control reclaim is in progress: ${inspection.runDir}`, inspection);
  }
  if ("ambiguous" in inspection && inspection.ambiguous) {
    return new HomeControlBusyError(
      `control run path is ambiguous (${inspection.reason}): ${inspection.runDir}`,
      inspection,
    );
  }
  if ("incomplete" in inspection && inspection.incomplete) {
    return new HomeControlBusyError(
      `control run lock is incomplete and cannot be stolen: ${inspection.runDir}`,
      inspection,
    );
  }
  if ("owner" in inspection) {
    if (inspection.liveness === "ambiguous") {
      return new HomeControlBusyError(
        `control run lock owner pid is ambiguous; not stolen: ${inspection.runDir}`,
        inspection,
      );
    }
    if (inspection.liveness === "dead") {
      return new HomeControlBusyError(
        `control run lock is held by dead pid ${inspection.owner.pid}; reclaim required`,
        inspection,
      );
    }
    return new HomeControlBusyError(
      `control run lock is held by pid ${inspection.owner.pid} (${inspection.owner.kind})`,
      inspection,
    );
  }
  return new HomeControlBusyError(`control run lock is busy (${inspection.runDir})`, inspection);
}
