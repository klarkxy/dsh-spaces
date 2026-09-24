import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import { atomicWrite } from "./atomic";
import { samePath } from "./home-guard";
import { PROFILE_NAME_RE, RESERVED_PROFILE_NAMES } from "../../shared/types";
import { HomeLockBusyError, HomeOperationLock, canonicalHome } from "./home-operation-lock";
import { deriveServiceEpoch, digestHomeIdentity } from "./workbench-protocol";

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

export type HomeControlHandoffPhase = "launcher" | "authorized";

export type HomeControlHandoffErrorCode =
  | "not-held"
  | "nonce-mismatch"
  | "pid-mismatch"
  | "home-mismatch"
  | "binding-mismatch"
  | "phase-mismatch"
  | "duplicate"
  | "invalid-target"
  | "invalid-token"
  | "incomplete"
  | "ambiguous"
  | "busy"
  | "write-failed";

/** Reservation bound into the run-owner record. Node-only; not a public DTO. */
export interface HomeControlHandoffBinding {
  homeDigest: string;
  handoffId: string;
  serviceEpoch: string;
  artifactDigest: string;
}

/**
 * Capability returned to the trusted Node launcher. `secret` is never copied
 * into inspect() or public workbench DTOs.
 */
export interface HomeControlHandoffToken {
  readonly v: 1;
  readonly homeDigest: string;
  readonly handoffId: string;
  readonly serviceEpoch: string;
  readonly artifactDigest: string;
  readonly nonce: string;
  readonly secret: string;
}

export interface HomeControlHandoffEvidence {
  phase: HomeControlHandoffPhase;
  binding: HomeControlHandoffBinding;
  original: { pid: number; kind: ControlKind; startedAt: string };
  target?: { pid: number; startedAt: string };
}

export interface HomeControlTransferToLauncherRequest {
  nonce: string;
  binding: HomeControlHandoffBinding;
  /** Defaults to this process. Spawned launcher pid must already exist. */
  launcher?: { pid: number; startedAt: string };
}

export interface HomeControlAuthorizeHandoffRequest {
  token: HomeControlHandoffToken;
  target: { pid: number; startedAt: string };
}

export interface HomeControlAcceptHandoffRequest {
  token: HomeControlHandoffToken;
  kind: ControlKind;
  endpoint?: string;
}

export type HomeControlInspect =
  | { held: false; runDir: string }
  | { held: true; incomplete: true; runDir: string }
  | { held: true; reclaim: true; runDir: string }
  | { held: true; ambiguous: true; reason: string; runDir: string }
  | {
      held: true;
      owner: HomeControlOwner;
      liveness: PidLiveness;
      runDir: string;
      handoff?: HomeControlHandoffEvidence;
    };

export type ReclaimDeadResult =
  | { reclaimed: false; reason: "not-held" }
  | { reclaimed: false; reason: "incomplete" }
  | { reclaimed: false; reason: "reclaim-in-progress" }
  | { reclaimed: false; reason: "ambiguous"; detail: string }
  | { reclaimed: false; reason: "owner-alive"; pid: number }
  | { reclaimed: false; reason: "remove-failed"; detail: string }
  | { reclaimed: false; reason: "handoff" }
  | { reclaimed: true; owner: HomeControlOwner };

export interface HomeControlHandle {
  readonly owner: HomeControlOwner;
  release(beforeRelease?: () => void): void;
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

export class HomeControlHandoffError extends Error {
  readonly name = "HomeControlHandoffError";
  constructor(
    message: string,
    readonly code: HomeControlHandoffErrorCode,
  ) {
    super(message);
  }
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
      release: (beforeRelease) => {
        removeOwnedRun(this.ownerFile, this.runDir, owner.nonce, beforeRelease);
      },
    };
  }

  /**
   * Current owner (this process.pid + nonce) atomically replaces occupancy
   * with a one-shot launcher in the same run directory. Caller confirms stop;
   * this method only checks identity and keeps the lock held.
   */
  async transferToLauncher(request: HomeControlTransferToLauncherRequest): Promise<HomeControlHandoffToken> {
    return this.withHandoffLock(() => this.transferToLauncherLocked(request));
  }

  /**
   * Launcher occupancy (this process.pid + token) binds the new Supervisor
   * pid/startedAt. Those values must come from this trusted local process.
   */
  async authorizeHandoff(request: HomeControlAuthorizeHandoffRequest): Promise<HomeControlHandoffToken> {
    return this.withHandoffLock(() => this.authorizeHandoffLocked(request));
  }

  /**
   * New Supervisor accepts only if token + current record + this process.pid
   * match the launcher-authorized target. Disk-readable state alone is not enough.
   */
  async acceptHandoff(request: HomeControlAcceptHandoffRequest): Promise<HomeControlHandle> {
    return this.withHandoffLock(() => this.acceptHandoffLocked(request));
  }

  reclaimDead(options?: { expectedOwner: HomeControlOwner; beforeRelease: (owner: HomeControlOwner) => void }): ReclaimDeadResult {
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
    if ("handoff" in first && first.handoff) {
      return { reclaimed: false, reason: "handoff" };
    }
    if (!("owner" in first)) return { reclaimed: false, reason: "incomplete" };
    if (options && !sameControlOwner(first.owner, options.expectedOwner)) {
      return { reclaimed: false, reason: "ambiguous", detail: "controller changed since this launch began" };
    }
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
      if (owner.state === "missing") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "not-held" };
      }
      if (owner.state === "symlink") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "ambiguous", detail: "control owner file is a symlink" };
      }
      if (owner.state === "unknown") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "ambiguous", detail: owner.reason };
      }
      if (owner.state === "handoff") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "handoff" };
      }
      if (!sameControlOwner(owner.owner, first.owner)) {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "owner-alive", pid: owner.owner.pid };
      }
      const liveness = this.pidAlive(owner.owner.pid, owner.owner.startedAt);
      if (liveness === "ambiguous") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "ambiguous", detail: "owner pid liveness is ambiguous" };
      }
      if (liveness !== "dead") {
        dropReclaim(this.reclaimDir);
        return { reclaimed: false, reason: "owner-alive", pid: owner.owner.pid };
      }
      removeOwnedRun(this.ownerFile, this.runDir, owner.owner.nonce, () => options?.beforeRelease(owner.owner));
      dropReclaim(this.reclaimDir);
      return { reclaimed: true, owner: owner.owner };
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

  private async withHandoffLock<T>(action: () => T): Promise<T> {
    try {
      return await this.lock.run("control-handoff", async () => action());
    } catch (error) {
      if (error instanceof HomeLockBusyError) {
        throw new HomeControlHandoffError(
          `handoff is blocked by the home transaction lock: ${error.message}`,
          "busy",
        );
      }
      throw error;
    }
  }

  private transferToLauncherLocked(request: HomeControlTransferToLauncherRequest): HomeControlHandoffToken {
    const binding = requireBinding(request.binding);
    this.assertHomeDigest(binding.homeDigest);
    const current = this.requireMutableOwnerFile();
    if (current.state === "handoff") {
      throw new HomeControlHandoffError("handoff is already in progress", "duplicate");
    }
    const owner = current.owner;
    this.assertCurrentOwner(owner, request.nonce);
    if (!secretsEqual(binding.serviceEpoch, deriveServiceEpoch(owner.nonce))) {
      throw new HomeControlHandoffError(
        "handoff serviceEpoch does not match the current owner",
        "binding-mismatch",
      );
    }
    const launcher = this.requireLiveProcess(request.launcher ?? { pid: process.pid, startedAt: new Date().toISOString() });
    const nonce = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const disk: HandoffDiskRecord = {
      version: 2,
      phase: "launcher",
      pid: launcher.pid,
      nonce,
      startedAt: launcher.startedAt,
      handoffId: binding.handoffId,
      homeDigest: binding.homeDigest,
      serviceEpoch: binding.serviceEpoch,
      artifactDigest: binding.artifactDigest,
      secretHash: hashSecret(secret),
      original: {
        pid: owner.pid,
        nonce: owner.nonce,
        startedAt: owner.startedAt,
        kind: owner.kind,
        ...(owner.endpoint ? { endpoint: owner.endpoint } : {}),
      },
    };
    replaceOwnerFile(this.ownerFile, disk);
    return freezeToken({ ...binding, nonce, secret });
  }

  private authorizeHandoffLocked(request: HomeControlAuthorizeHandoffRequest): HomeControlHandoffToken {
    const token = requireToken(request.token);
    this.assertHomeDigest(token.homeDigest);
    const current = this.requireHandoffFile();
    if (current.disk.phase !== "launcher") {
      throw new HomeControlHandoffError(
        "handoff is not waiting for launcher authorization",
        current.disk.phase === "authorized" ? "duplicate" : "phase-mismatch",
      );
    }
    this.assertLauncherCaller(current, token);
    const target = this.requireLiveProcess(request.target);
    const disk: HandoffDiskRecord = {
      ...current.disk,
      phase: "authorized",
      target: { pid: target.pid, startedAt: target.startedAt },
    };
    replaceOwnerFile(this.ownerFile, disk);
    return freezeToken(token);
  }

  private acceptHandoffLocked(request: HomeControlAcceptHandoffRequest): HomeControlHandle {
    const token = requireToken(request.token);
    this.assertHomeDigest(token.homeDigest);
    const kind = requireKind(request.kind);
    const endpoint = request.endpoint === undefined ? undefined : parseControlEndpoint(request.endpoint);
    const current = this.requireHandoffFile();
    if (current.disk.phase !== "authorized" || !current.disk.target) {
      throw new HomeControlHandoffError("handoff is not authorized for a new supervisor", "phase-mismatch");
    }
    assertTokenMatchesDisk(token, current.disk);
    if (process.pid !== current.disk.target.pid) {
      throw new HomeControlHandoffError("accepting process is not the authorized target", "pid-mismatch");
    }
    if (this.pidAlive(process.pid, current.disk.target.startedAt) !== "alive") {
      throw new HomeControlHandoffError("authorized target startedAt does not match this process", "invalid-target");
    }
    const owner: HomeControlOwner = {
      pid: current.disk.target.pid,
      nonce: randomBytes(16).toString("hex"),
      startedAt: current.disk.target.startedAt,
      kind,
      ...(endpoint ? { endpoint } : {}),
    };
    replaceOwnerFile(this.ownerFile, serializeLegacyOwner(owner));
    return {
      owner,
      release: (beforeRelease) => {
        removeOwnedRun(this.ownerFile, this.runDir, owner.nonce, beforeRelease);
      },
    };
  }

  private requireMutableOwnerFile(): { state: "legacy"; owner: HomeControlOwner } | { state: "handoff"; occupant: HomeControlOwner; disk: HandoffDiskRecord } {
    const inspection = this.inspect();
    if (!inspection.held) {
      throw new HomeControlHandoffError("control run lock is not held", "not-held");
    }
    if ("reclaim" in inspection && inspection.reclaim) {
      throw new HomeControlHandoffError("control reclaim is in progress", "busy");
    }
    if ("incomplete" in inspection && inspection.incomplete) {
      throw new HomeControlHandoffError("control owner is incomplete", "incomplete");
    }
    if ("ambiguous" in inspection && inspection.ambiguous) {
      throw new HomeControlHandoffError(`control owner is ambiguous (${inspection.reason})`, "ambiguous");
    }
    const owner = readOwnerFile(this.ownerFile);
    if (owner.state === "legacy") return owner;
    if (owner.state === "handoff") return owner;
    if (owner.state === "missing") {
      throw new HomeControlHandoffError("control owner is incomplete", "incomplete");
    }
    if (owner.state === "symlink") {
      throw new HomeControlHandoffError("control owner path is a symlink", "ambiguous");
    }
    throw new HomeControlHandoffError(owner.reason, "ambiguous");
  }

  private requireHandoffFile(): { state: "handoff"; occupant: HomeControlOwner; disk: HandoffDiskRecord } {
    const current = this.requireMutableOwnerFile();
    if (current.state !== "handoff") {
      throw new HomeControlHandoffError("control owner is not in a handoff", "phase-mismatch");
    }
    return current;
  }

  private assertHomeDigest(homeDigest: string): void {
    if (!secretsEqual(homeDigest, digestHomeIdentity(this.home))) {
      throw new HomeControlHandoffError("handoff home digest does not match this Home", "home-mismatch");
    }
  }

  private assertCurrentOwner(owner: HomeControlOwner, nonce: string): void {
    if (!secretsEqual(owner.nonce, nonce)) {
      throw new HomeControlHandoffError("handoff nonce does not match the current owner", "nonce-mismatch");
    }
    if (owner.pid !== process.pid) {
      throw new HomeControlHandoffError("handoff must be initiated by the current owner process", "pid-mismatch");
    }
  }

  private assertLauncherCaller(
    current: { occupant: HomeControlOwner; disk: HandoffDiskRecord },
    token: HomeControlHandoffToken,
  ): void {
    assertTokenMatchesDisk(token, current.disk);
    if (current.occupant.pid !== process.pid) {
      throw new HomeControlHandoffError("handoff must be continued by the current launcher process", "pid-mismatch");
    }
  }

  private requireLiveProcess(input: { pid: number; startedAt: string }): { pid: number; startedAt: string } {
    const pid = requirePid(input.pid);
    const startedAt = requireStartedAt(input.startedAt);
    const liveness = this.pidAlive(pid, startedAt);
    if (liveness !== "alive") {
      throw new HomeControlHandoffError("target pid is not a live process", "invalid-target");
    }
    return { pid, startedAt };
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

export function homeControlDigest(home: string, options: HomeControllerOptions = {}): string {
  return digestHomeIdentity(canonicalHome(home, options));
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
  if (owner.state === "missing") return { held: true, incomplete: true, runDir };
  if (owner.state === "symlink") {
    return { held: true, ambiguous: true, reason: "control owner file is a symlink", runDir };
  }
  if (owner.state === "unknown") {
    return { held: true, ambiguous: true, reason: owner.reason, runDir };
  }
  if (owner.state === "handoff") {
    return {
      held: true,
      owner: owner.occupant,
      liveness: pidAlive(owner.occupant.pid, owner.occupant.startedAt),
      runDir,
      handoff: publicHandoffEvidence(owner.disk),
    };
  }
  return { held: true, owner: owner.owner, liveness: pidAlive(owner.owner.pid, owner.owner.startedAt), runDir };
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

interface HandoffDiskRecord {
  version: 2;
  phase: HomeControlHandoffPhase;
  pid: number;
  nonce: string;
  startedAt: string;
  handoffId: string;
  homeDigest: string;
  serviceEpoch: string;
  artifactDigest: string;
  secretHash: string;
  original: {
    pid: number;
    nonce: string;
    startedAt: string;
    kind: ControlKind;
    endpoint?: string;
  };
  target?: { pid: number; startedAt: string };
}

type OwnerFileState =
  | { state: "missing" }
  | { state: "symlink" }
  | { state: "unknown"; reason: string }
  | { state: "legacy"; owner: HomeControlOwner }
  | { state: "handoff"; occupant: HomeControlOwner; disk: HandoffDiskRecord };

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HANDOFF_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function readOwnerFile(ownerFile: string): OwnerFileState {
  let ownerStat;
  try {
    ownerStat = lstatSync(ownerFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    throw error;
  }
  if (ownerStat.isSymbolicLink()) return { state: "symlink" };
  if (!ownerStat.isFile()) {
    return { state: "unknown", reason: "control owner path is not a regular file" };
  }
  let raw: string;
  try {
    raw = readFileSync(ownerFile, "utf8");
  } catch {
    return { state: "missing" };
  }
  return parseOwnerRecord(raw);
}

function parseOwnerRecord(raw: string): OwnerFileState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "missing" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "missing" };
  const row = parsed as Record<string, unknown>;
  if (row.version === 2) {
    const disk = parseHandoffRecord(row);
    if (!disk) {
      return { state: "unknown", reason: "control owner handoff record is unknown or damaged" };
    }
    return {
      state: "handoff",
      occupant: {
        pid: disk.pid,
        nonce: disk.nonce,
        startedAt: disk.startedAt,
        kind: disk.original.kind,
      },
      disk,
    };
  }
  if (row.version !== undefined && row.version !== 1) {
    return { state: "unknown", reason: "control owner record uses an unknown schema" };
  }
  const owner = parseLegacyOwner(row);
  if (!owner) return { state: "missing" };
  return { state: "legacy", owner };
}

function parseLegacyOwner(row: Record<string, unknown>): HomeControlOwner | undefined {
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

function parseHandoffRecord(row: Record<string, unknown>): HandoffDiskRecord | undefined {
  if (row.phase !== "launcher" && row.phase !== "authorized") return undefined;
  if (!Number.isInteger(row.pid) || (row.pid as number) <= 0) return undefined;
  if (typeof row.nonce !== "string" || !HEX32.test(row.nonce)) return undefined;
  if (typeof row.startedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt))) return undefined;
  if (typeof row.handoffId !== "string" || !HANDOFF_ID_RE.test(row.handoffId)) return undefined;
  if (typeof row.homeDigest !== "string" || !HEX64.test(row.homeDigest)) return undefined;
  if (typeof row.serviceEpoch !== "string" || !HEX64.test(row.serviceEpoch)) return undefined;
  if (typeof row.artifactDigest !== "string" || !HEX64.test(row.artifactDigest)) return undefined;
  if (typeof row.secretHash !== "string" || !HEX64.test(row.secretHash)) return undefined;
  if (!row.original || typeof row.original !== "object" || Array.isArray(row.original)) return undefined;
  const originalRow = row.original as Record<string, unknown>;
  const original = parseLegacyOwner({
    pid: originalRow.pid,
    nonce: originalRow.nonce,
    startedAt: originalRow.startedAt,
    kind: originalRow.kind,
    ...(originalRow.endpoint !== undefined ? { endpoint: originalRow.endpoint } : {}),
  });
  if (!original) return undefined;
  let target: { pid: number; startedAt: string } | undefined;
  if (row.target !== undefined) {
    if (!row.target || typeof row.target !== "object" || Array.isArray(row.target)) return undefined;
    const targetRow = row.target as Record<string, unknown>;
    if (!Number.isInteger(targetRow.pid) || (targetRow.pid as number) <= 0) return undefined;
    if (typeof targetRow.startedAt !== "string" || !Number.isFinite(Date.parse(targetRow.startedAt))) return undefined;
    target = { pid: targetRow.pid as number, startedAt: targetRow.startedAt };
  }
  if (row.phase === "launcher" && target) return undefined;
  if (row.phase === "authorized" && !target) return undefined;
  return {
    version: 2,
    phase: row.phase,
    pid: row.pid as number,
    nonce: row.nonce,
    startedAt: row.startedAt,
    handoffId: row.handoffId,
    homeDigest: row.homeDigest,
    serviceEpoch: row.serviceEpoch,
    artifactDigest: row.artifactDigest,
    secretHash: row.secretHash,
    original: {
      pid: original.pid,
      nonce: original.nonce,
      startedAt: original.startedAt,
      kind: original.kind,
      ...(original.endpoint ? { endpoint: original.endpoint } : {}),
    },
    ...(target ? { target } : {}),
  };
}

function serializeLegacyOwner(owner: HomeControlOwner): HomeControlOwner {
  const payload: HomeControlOwner = {
    pid: owner.pid,
    nonce: owner.nonce,
    startedAt: owner.startedAt,
    kind: owner.kind,
  };
  if (owner.endpoint) payload.endpoint = owner.endpoint;
  return payload;
}

function writeOwnerFile(ownerFile: string, owner: HomeControlOwner): void {
  writeFileSync(ownerFile, `${JSON.stringify(serializeLegacyOwner(owner))}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function replaceOwnerFile(ownerFile: string, payload: unknown): void {
  const tmp = `${ownerFile}.${process.pid}.tmp`;
  try {
    atomicWrite(ownerFile, `${JSON.stringify(payload)}\n`);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* leave any tmp; never delete owner.json */
    }
    throw new HomeControlHandoffError(
      `handoff owner write failed; previous owner left in place: ${error instanceof Error ? error.message : String(error)}`,
      "write-failed",
    );
  }
}

export function sameControlOwner(a: HomeControlOwner, b: HomeControlOwner): boolean {
  return a.pid === b.pid && a.nonce === b.nonce && a.kind === b.kind &&
    a.startedAt === b.startedAt && a.endpoint === b.endpoint;
}

/** Narrow eligibility for new-launch retirement; legacy inspection stays read-only. */
export function validLaunchOwner(owner: { pid: number; nonce: string; startedAt: string }): boolean {
  return Number.isSafeInteger(owner.pid) && owner.pid > 0 && /^[a-f0-9]{32}$/.test(owner.nonce) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(owner.startedAt) &&
    Number.isFinite(Date.parse(owner.startedAt));
}

function removeOwnedRun(ownerFile: string, runDir: string, nonce: string, beforeRelease?: () => void): void {
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
  if (owner.state === "missing") {
    throw new HomeControlReleaseError(`control owner is missing during release; lock left in place: ${runDir}`);
  }
  if (owner.state === "symlink") {
    throw new HomeControlReleaseError(`control owner path is ambiguous during release: ${ownerFile}`);
  }
  if (owner.state === "unknown") {
    throw new HomeControlReleaseError(`control owner is unknown during release; lock left in place: ${owner.reason}`);
  }
  if (owner.state === "handoff") {
    throw new HomeControlReleaseError("control release refused during handoff; lock left in place");
  }
  if (owner.owner.nonce !== nonce) {
    throw new HomeControlReleaseError("control release nonce mismatch; lock left in place");
  }
  try {
    // Related endpoint cleanup must happen while this owner still excludes a successor.
    beforeRelease?.();
    unlinkSync(ownerFile);
    rmdirSync(runDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HomeControlReleaseError(`control release failed; lock left in place: ${detail}`);
  }
}

function publicHandoffEvidence(disk: HandoffDiskRecord): HomeControlHandoffEvidence {
  return {
    phase: disk.phase,
    binding: {
      homeDigest: disk.homeDigest,
      handoffId: disk.handoffId,
      serviceEpoch: disk.serviceEpoch,
      artifactDigest: disk.artifactDigest,
    },
    original: {
      pid: disk.original.pid,
      kind: disk.original.kind,
      startedAt: disk.original.startedAt,
    },
    ...(disk.target ? { target: { pid: disk.target.pid, startedAt: disk.target.startedAt } } : {}),
  };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function freezeToken(input: HomeControlHandoffBinding & { nonce: string; secret: string }): HomeControlHandoffToken {
  return Object.freeze({
    v: 1 as const,
    homeDigest: input.homeDigest,
    handoffId: input.handoffId,
    serviceEpoch: input.serviceEpoch,
    artifactDigest: input.artifactDigest,
    nonce: input.nonce,
    secret: input.secret,
  });
}

function requireBinding(binding: HomeControlHandoffBinding): HomeControlHandoffBinding {
  if (!binding || typeof binding !== "object") {
    throw new HomeControlHandoffError("handoff binding is required", "invalid-token");
  }
  return {
    homeDigest: requireHex64("homeDigest", binding.homeDigest),
    handoffId: requireHandoffId(binding.handoffId),
    serviceEpoch: requireHex64("serviceEpoch", binding.serviceEpoch),
    artifactDigest: requireHex64("artifactDigest", binding.artifactDigest),
  };
}

function requireToken(token: HomeControlHandoffToken): HomeControlHandoffToken {
  if (!token || typeof token !== "object" || token.v !== 1) {
    throw new HomeControlHandoffError("handoff token is invalid", "invalid-token");
  }
  if (typeof token.nonce !== "string" || !HEX32.test(token.nonce)) {
    throw new HomeControlHandoffError("handoff token nonce is invalid", "invalid-token");
  }
  if (typeof token.secret !== "string" || !HEX64.test(token.secret)) {
    throw new HomeControlHandoffError("handoff token secret is invalid", "invalid-token");
  }
  const binding = requireBinding(token);
  return freezeToken({ ...binding, nonce: token.nonce, secret: token.secret });
}

function requireHex64(name: string, value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new HomeControlHandoffError(`${name} must be a 64-character lowercase hex digest`, "invalid-token");
  }
  return value;
}

function requireHandoffId(value: unknown): string {
  if (typeof value !== "string" || !HANDOFF_ID_RE.test(value)) {
    throw new HomeControlHandoffError("handoffId is invalid", "invalid-token");
  }
  return value;
}

function requirePid(pid: unknown): number {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    throw new HomeControlHandoffError("target pid is invalid", "invalid-target");
  }
  return pid as number;
}

function requireStartedAt(value: unknown): string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new HomeControlHandoffError("target startedAt is invalid", "invalid-target");
  }
  return value;
}

function assertTokenMatchesDisk(token: HomeControlHandoffToken, disk: HandoffDiskRecord): void {
  if (!secretsEqual(token.homeDigest, disk.homeDigest) || token.handoffId !== disk.handoffId) {
    throw new HomeControlHandoffError("handoff token does not match the current reservation", "binding-mismatch");
  }
  if (token.serviceEpoch !== disk.serviceEpoch || token.artifactDigest !== disk.artifactDigest) {
    throw new HomeControlHandoffError("handoff token does not match the current reservation", "binding-mismatch");
  }
  if (!secretsEqual(token.nonce, disk.nonce)) {
    throw new HomeControlHandoffError("handoff token nonce does not match the current launcher", "nonce-mismatch");
  }
  if (!secretsEqual(hashSecret(token.secret), disk.secretHash)) {
    throw new HomeControlHandoffError("handoff token secret does not match the current reservation", "invalid-token");
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
  if ("handoff" in inspection && inspection.handoff) {
    return new HomeControlBusyError(
      `control run lock is held by handoff ${inspection.handoff.phase} (${inspection.handoff.binding.handoffId})`,
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
