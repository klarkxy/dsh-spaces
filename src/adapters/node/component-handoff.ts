/** Node-only one-shot component launcher handshake. Secrets travel only over inherited IPC. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./atomic";
import { validateComponentPayload, type ValidatedComponentPayload } from "./component-payload";
import { isAuthorizedProductHome } from "./home-guard";
import { COMPONENT_STAGED_DIR_NAME, selectComponentPayload, type ComponentHomeAccess } from "./component-selection";
import {
  defaultPidAlive,
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
  HomeController,
  homeControlDigest,
  type ControlKind,
  type HomeControlHandle,
  type HomeControlHandoffToken,
  type PidAliveFn,
} from "./home-controller";
import { canonicalHome } from "./home-operation-lock";
import { deriveServiceEpoch } from "./workbench-protocol";

export const COMPONENT_HANDOFF_IPC_VERSION = 1 as const;
export const COMPONENT_HANDOFF_RECEIPT_FILE = "handoff-receipt.json";
export const COMPONENT_HANDOFF_DEADLINE_MS = 30_000;
export const COMPONENT_HANDOFF_FLAG = "--accept-handoff";
export const COMPONENT_HANDOFF_CODE = "component-handoff/failed" as const;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HANDOFF_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const RECEIPT_KEYS = [
  "schemaVersion",
  "handoffId",
  "phase",
  "artifactDigest",
  "status",
  "startedAt",
  "updatedAt",
  "code",
] as const;

export type ComponentHandoffFailureCode =
  | "missing-confirmation"
  | "token-mismatch"
  | "old-alive"
  | "old-ambiguous"
  | "timeout"
  | "select-failed"
  | "spawn-failed"
  | "accept-failed"
  | "invalid-commit"
  | "reservation";

export type ComponentHandoffPhase =
  | "waiting"
  | "selected"
  | "spawned"
  | "authorized"
  | "accepted"
  | "failed";

export type ComponentHandoffReceipt = {
  schemaVersion: 1;
  handoffId: string;
  phase: ComponentHandoffPhase;
  artifactDigest: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  updatedAt: string;
  code?: ComponentHandoffFailureCode;
};

export type ComponentHandoffRuntimeLaunch = {
  execPath: string;
  entry: string;
  argv: readonly string[];
  execArgv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type ComponentHandoffCommit = {
  token: HomeControlHandoffToken;
  home: string;
  toolsRoot: string;
  artifactDigest: string;
  oldPid: number;
  oldStartedAt: string;
  cleanStopConfirmed: boolean;
  runtime: ComponentHandoffRuntimeLaunch;
  deadlineMs?: number;
  allowRealHome?: boolean;
};

export type ComponentHandoffIpcCommit = ComponentHandoffCommit & {
  v: typeof COMPONENT_HANDOFF_IPC_VERSION;
  type: "handoff-commit";
};

export type ComponentHandoffCommitAck = {
  v: typeof COMPONENT_HANDOFF_IPC_VERSION;
  type: "commit-ack";
};

export type AcceptHandoffReadyMessage = {
  v: typeof COMPONENT_HANDOFF_IPC_VERSION;
  type: "ready-to-accept";
  pid: number;
  startedAt: string;
};

export type AcceptHandoffTokenMessage = {
  v: typeof COMPONENT_HANDOFF_IPC_VERSION;
  type: "handoff-token";
  token: HomeControlHandoffToken;
};

export type AcceptHandoffAcceptedMessage = {
  v: typeof COMPONENT_HANDOFF_IPC_VERSION;
  type: "accepted";
  pid: number;
  startedAt: string;
};

export type AcceptHandoffFailedMessage = {
  v: typeof COMPONENT_HANDOFF_IPC_VERSION;
  type: "failed";
  code: ComponentHandoffFailureCode;
};

export class ComponentHandoffError extends Error {
  readonly name = "ComponentHandoffError";
  readonly code: ComponentHandoffFailureCode;
  constructor(message: string, code: ComponentHandoffFailureCode) {
    super(message);
    this.code = code;
  }
}

export type SpawnComponentLauncherOptions = {
  home: string;
  launcherEntry: string;
  execPath?: string;
  execArgv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowRealHome?: boolean;
};

export type ComponentLauncherHandle = {
  readonly pid: number;
  readonly startedAt: string;
  sendCommit(commit: ComponentHandoffCommit): Promise<void>;
  disconnect(): void;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
};

export type ComponentLauncherDependencies = {
  pidAlive?: PidAliveFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ipc?: NodeJS.Process;
};

export type AcceptHandoffSession = {
  readonly startedAt: string;
  readonly token: Promise<HomeControlHandoffToken>;
  reportAccepted(): void;
  reportFailed(code: ComponentHandoffFailureCode): void;
};

export function componentLauncherSrcPath(): string {
  return fileURLToPath(new URL("../../../packages/supervisor/src/launcher.ts", import.meta.url));
}

export function createComponentHandoffBinding(
  home: string,
  ownerNonce: string,
  artifactDigest: string,
  handoffId = randomBytes(16).toString("hex"),
  access?: ComponentHomeAccess,
): { homeDigest: string; handoffId: string; serviceEpoch: string; artifactDigest: string } {
  if (!HEX64.test(artifactDigest)) {
    throw new ComponentHandoffError("artifactDigest must be 64 lowercase hex characters.", "invalid-commit");
  }
  if (!HANDOFF_ID_RE.test(handoffId)) {
    throw new ComponentHandoffError("handoffId is invalid.", "invalid-commit");
  }
  return {
    homeDigest: homeControlDigest(home, homeAccess(home, access)),
    handoffId,
    serviceEpoch: deriveServiceEpoch(ownerNonce),
    artifactDigest,
  };
}

export function spawnComponentLauncher(options: SpawnComponentLauncherOptions): ComponentLauncherHandle {
  const access = homeAccess(options.home, options);
  const home = canonicalHome(options.home, access);
  if (typeof options.launcherEntry !== "string" || !options.launcherEntry.trim()) {
    throw new ComponentHandoffError("A launcher entry is required.", "invalid-commit");
  }
  const execPath = options.execPath ?? process.execPath;
  const args = [...(options.execArgv ?? []), options.launcherEntry];
  assertArgvHasNoSecretShape(args);
  assertEnvHasNoSecretNames(options.env);
  const child = spawn(execPath, args, {
    cwd: options.cwd ?? dirname(options.launcherEntry),
    env: options.env ? { ...options.env } : { ...process.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    shell: false,
    detached: true,
  });
  let stderr = "";
  child.stdout?.on("data", () => {
    /* drain so status lines cannot fill the pipe and stall the launcher */
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });
  child.once("exit", (code, signal) => {
    exitResult = { code, signal };
  });
  if (!child.pid) {
    throw new ComponentHandoffError("The one-shot launcher could not be started.", "spawn-failed");
  }
  child.unref();
  const startedAt = new Date().toISOString();
  return {
    pid: child.pid,
    startedAt,
    sendCommit(commit: ComponentHandoffCommit) {
      if (canonicalHome(commit.home, homeAccess(commit.home, commit)) !== home) {
        return Promise.reject(new ComponentHandoffError("Commit Home does not match the launcher Home.", "invalid-commit"));
      }
      const payload: ComponentHandoffIpcCommit = {
        v: COMPONENT_HANDOFF_IPC_VERSION,
        type: "handoff-commit",
        ...commit,
        allowRealHome: commit.allowRealHome === true || options.allowRealHome === true,
      };
      return sendIpc(child, payload).then(() => waitForCommitAck(child));
    },
    disconnect() {
      try {
        child.disconnect();
      } catch {
        /* already disconnected */
      }
    },
    waitForExit() {
      if (spawnError) {
        return Promise.reject(
          new ComponentHandoffError("The one-shot launcher could not be started.", "spawn-failed"),
        );
      }
      if (exitResult) {
        return Promise.resolve({ ...exitResult, stderr });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stderr });
      }
      return new Promise((resolveWait, rejectWait) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          child.off("error", onError);
          resolveWait({ code, signal, stderr });
        };
        const onError = (error: Error) => {
          child.off("exit", onExit);
          rejectWait(
            new ComponentHandoffError(
              error.message && !HEX64.test(error.message)
                ? "The one-shot launcher could not be started."
                : "The one-shot launcher could not be started.",
              "spawn-failed",
            ),
          );
        };
        child.once("exit", onExit);
        child.once("error", onError);
      });
    },
  };
}

export function beginAcceptHandoffChild(options: { deadlineMs?: number } = {}): AcceptHandoffSession {
  if (typeof process.send !== "function") {
    throw new ComponentHandoffError("Accept-handoff requires inherited IPC.", "invalid-commit");
  }
  const startedAt = new Date().toISOString();
  const ready: AcceptHandoffReadyMessage = {
    v: COMPONENT_HANDOFF_IPC_VERSION,
    type: "ready-to-accept",
    pid: process.pid,
    startedAt,
  };
  process.send(ready);
  const deadlineMs = clampDeadline(options.deadlineMs);
  const token = new Promise<HomeControlHandoffToken>((resolveToken, rejectToken) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new ComponentHandoffError("Timed out waiting for the handoff token.", "timeout"));
    }, deadlineMs);
    const finish = (error?: unknown, value?: HomeControlHandoffToken) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) rejectToken(error);
      else resolveToken(value as HomeControlHandoffToken);
    };
    const onMessage = (raw: unknown) => {
      try {
        finish(undefined, parseTokenMessage(raw));
      } catch (error) {
        finish(error);
      }
    };
    const onDisconnect = () => {
      finish(new ComponentHandoffError("Launcher IPC disconnected before the token arrived.", "accept-failed"));
    };
    process.on("message", onMessage);
    process.on("disconnect", onDisconnect);
    if (!process.connected) onDisconnect();
  });
  return {
    startedAt,
    token,
    reportAccepted() {
      const accepted: AcceptHandoffAcceptedMessage = {
        v: COMPONENT_HANDOFF_IPC_VERSION,
        type: "accepted",
        pid: process.pid,
        startedAt,
      };
      process.send?.(accepted);
    },
    reportFailed(code: ComponentHandoffFailureCode) {
      const failed: AcceptHandoffFailedMessage = {
        v: COMPONENT_HANDOFF_IPC_VERSION,
        type: "failed",
        code,
      };
      process.send?.(failed);
    },
  };
}

/**
 * Child-side helper for `--accept-handoff`. Accepts the run lock before any
 * backend writer or management HTTP is created. IPC `accepted` is sent only
 * after `startup` resolves (HTTP/manager ready). Lock acceptance alone is not
 * startup success. On failure the lock evidence is left in place; callers
 * must not release after a later startup error.
 */
export async function acceptHandoffFromIpc(input: {
  home: string;
  kind: ControlKind;
  endpoint?: string;
  allowRealHome?: boolean;
  deadlineMs?: number;
  startup: (handle: HomeControlHandle) => void | Promise<void>;
}): Promise<HomeControlHandle> {
  if (typeof input.startup !== "function") {
    throw new ComponentHandoffError("Accept-handoff startup confirmation is required.", "invalid-commit");
  }
  const session = beginAcceptHandoffChild({ deadlineMs: input.deadlineMs });
  try {
    const token = await session.token;
    const handle = await new HomeController(input.home, homeAccess(input.home, input)).acceptHandoff({
      token,
      kind: input.kind,
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
    });
    await input.startup(handle);
    session.reportAccepted();
    return handle;
  } catch (error) {
    try {
      session.reportFailed("accept-failed");
    } catch {
      /* IPC may already be gone */
    }
    throw error;
  }
}

export async function runComponentLauncher(deps: ComponentLauncherDependencies = {}): Promise<number> {
  const ipc = deps.ipc ?? process;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  let commit: ComponentHandoffCommit | undefined;
  const startedAt = new Date().toISOString();
  try {
    commit = await waitForCommit(ipc, now);
    await executeLauncher(commit, { now, sleep, pidAlive, startedAt });
    writeStatus("succeeded");
    return 0;
  } catch (error) {
    const code = error instanceof ComponentHandoffError ? error.code : "invalid-commit";
    if (commit) {
      try {
        writeReceipt(commit.home, {
          schemaVersion: 1,
          handoffId: commit.token.handoffId,
          phase: "failed",
          artifactDigest: commit.artifactDigest,
          status: "failed",
          startedAt,
          updatedAt: new Date().toISOString(),
          code,
        }, commit);
      } catch {
        /* evidence write is best-effort; original lock/pointer stay */
      }
    }
    writeStatus(`failed code=${code}`);
    try {
      process.stderr.write(`${code}\n`);
    } catch {
      /* ignore */
    }
    return 1;
  }
}

export function readHandoffReceipt(home: string, access?: ComponentHomeAccess): ComponentHandoffReceipt | undefined {
  const file = receiptPath(canonicalHome(home, homeAccess(home, access)));
  let st;
  try {
    st = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ComponentHandoffError("Handoff receipt could not be read.", "invalid-commit");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ComponentHandoffError("Handoff receipt is not a regular file.", "invalid-commit");
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new ComponentHandoffError("Handoff receipt could not be read.", "invalid-commit");
  }
  return parseReceipt(raw);
}

async function executeLauncher(
  commit: ComponentHandoffCommit,
  deps: { now: () => number; sleep: (ms: number) => Promise<void>; pidAlive: PidAliveFn; startedAt: string },
): Promise<void> {
  const access = homeAccess(commit.home, commit);
  const home = canonicalHome(commit.home, access);
  const record = (phase: ComponentHandoffReceipt["phase"], status: ComponentHandoffReceipt["status"] = "running") =>
    writeReceipt(
      home,
      {
        schemaVersion: 1,
        handoffId: commit.token.handoffId,
        phase,
        artifactDigest: commit.artifactDigest,
        status,
        startedAt: deps.startedAt,
        updatedAt: new Date().toISOString(),
      },
      access,
    );
  record("waiting");
  if (commit.cleanStopConfirmed !== true) {
    throw new ComponentHandoffError("Clean stop was not confirmed.", "missing-confirmation");
  }
  if (commit.artifactDigest !== commit.token.artifactDigest) {
    throw new ComponentHandoffError("Commit digest does not match the token.", "token-mismatch");
  }
  if (homeControlDigest(home, access) !== commit.token.homeDigest) {
    throw new ComponentHandoffError("Commit Home does not match the token.", "token-mismatch");
  }
  const original = assertLauncherReservation(home, commit.token, access);
  if (commit.oldPid !== original.pid || commit.oldStartedAt !== original.startedAt) {
    throw new ComponentHandoffError(
      "Commit old owner identity does not match the reservation original.",
      "invalid-commit",
    );
  }
  const staged = readStagedPayload(commit);
  const supervisorEntry = resolveManifestSupervisorEntry(staged);
  assertCommitEntryMatches(commit, supervisorEntry);
  assertNoTransportSecrets(commit);
  const deadlineMs = clampDeadline(commit.deadlineMs);
  const deadline = deps.now() + deadlineMs;
  await waitForOldGone(original, deps, deadline);
  let selected;
  try {
    selected = selectComponentPayload(home, commit.toolsRoot, commit.artifactDigest, access);
  } catch {
    throw new ComponentHandoffError("Component pointer could not be selected.", "select-failed");
  }
  if (selected.digest !== commit.artifactDigest) {
    throw new ComponentHandoffError("Selected digest does not match the reservation.", "select-failed");
  }
  const selectedEntry = resolveManifestSupervisorEntry(selected);
  if (!sameResolved(selectedEntry, supervisorEntry)) {
    throw new ComponentHandoffError("Selected supervisor entry does not match the staged entry.", "select-failed");
  }
  record("selected");

  const child = spawnTarget(commit, selectedEntry);
  record("spawned");
  const ready = await waitForReady(child, deadline, deps);
  if (ready.pid !== child.pid) {
    killChild(child);
    throw new ComponentHandoffError("Target ready pid does not match the spawned process.", "accept-failed");
  }
  const controller = new HomeController(home, access);
  try {
    await controller.authorizeHandoff({
      token: commit.token,
      target: { pid: ready.pid, startedAt: ready.startedAt },
    });
  } catch {
    throw new ComponentHandoffError("Launcher could not authorize the new supervisor.", "accept-failed");
  }
  record("authorized");
  const tokenMessage: AcceptHandoffTokenMessage = {
    v: COMPONENT_HANDOFF_IPC_VERSION,
    type: "handoff-token",
    token: commit.token,
  };
  await sendIpc(child, tokenMessage, "accept-failed");
  await waitForAccepted(child, ready, deadline, deps);
  try {
    child.unref();
  } catch {
    /* already unref'd or exited */
  }
  record("accepted", "succeeded");
}

function spawnTarget(commit: ComponentHandoffCommit, entry: string): ChildProcess {
  const argv = withAcceptFlag(commit.runtime.argv);
  const args = [...(commit.runtime.execArgv ?? []), entry, ...argv];
  assertArgvHasNoSecret(args, commit.token);
  let child: ChildProcess;
  try {
    child = spawn(commit.runtime.execPath, args, {
      cwd: commit.runtime.cwd ?? dirname(entry),
      env: commit.runtime.env ? { ...commit.runtime.env } : { ...process.env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      shell: false,
      detached: true,
    });
  } catch {
    throw new ComponentHandoffError("The new supervisor could not be started.", "spawn-failed");
  }
  child.stdout?.on("data", () => {
    /* drain */
  });
  child.stderr?.on("data", () => {
    /* drain; do not copy secrets to the launcher log */
  });
  child.once("error", () => {
    /* waitChildMessage settles the handshake; do not reclaim the lock */
  });
  if (!child.pid) {
    throw new ComponentHandoffError("The new supervisor could not be started.", "spawn-failed");
  }
  return child;
}

function withAcceptFlag(argv: readonly string[]): string[] {
  const out = argv.filter((row) => row !== COMPONENT_HANDOFF_FLAG);
  return [COMPONENT_HANDOFF_FLAG, ...out];
}

async function waitForOldGone(
  original: { pid: number; startedAt: string },
  deps: { now: () => number; sleep: (ms: number) => Promise<void>; pidAlive: PidAliveFn },
  deadline: number,
): Promise<void> {
  let disconnected = !process.connected;
  process.once("disconnect", () => {
    disconnected = true;
  });
  while (deps.now() < deadline) {
    const liveness = deps.pidAlive(original.pid, original.startedAt);
    if (disconnected && liveness === "dead") return;
    if (disconnected && liveness === "ambiguous") {
      throw new ComponentHandoffError("Previous owner pid liveness is ambiguous.", "old-ambiguous");
    }
    await deps.sleep(25);
  }
  const liveness = deps.pidAlive(original.pid, original.startedAt);
  if (!disconnected) {
    throw new ComponentHandoffError("Timed out waiting for the previous owner to disconnect.", "timeout");
  }
  if (liveness === "alive") {
    throw new ComponentHandoffError("Previous owner is still alive.", "old-alive");
  }
  if (liveness === "ambiguous") {
    throw new ComponentHandoffError("Previous owner pid liveness is ambiguous.", "old-ambiguous");
  }
}

function assertLauncherReservation(
  home: string,
  token: HomeControlHandoffToken,
  access?: ComponentHomeAccess,
): { pid: number; startedAt: string } {
  const controller = new HomeController(home, homeAccess(home, access));
  const inspection = controller.inspect();
  if (!inspection.held || !("handoff" in inspection) || !inspection.handoff || !("owner" in inspection)) {
    throw new ComponentHandoffError("Launcher does not hold the run reservation.", "reservation");
  }
  if (inspection.owner.pid !== process.pid) {
    throw new ComponentHandoffError("Launcher does not hold the run reservation.", "reservation");
  }
  if (inspection.handoff.phase !== "launcher") {
    throw new ComponentHandoffError("Handoff is not in the launcher phase.", "token-mismatch");
  }
  const binding = inspection.handoff.binding;
  if (
    binding.homeDigest !== token.homeDigest ||
    binding.handoffId !== token.handoffId ||
    binding.serviceEpoch !== token.serviceEpoch ||
    binding.artifactDigest !== token.artifactDigest ||
    inspection.owner.nonce !== token.nonce
  ) {
    throw new ComponentHandoffError("Handoff token does not match the run reservation.", "token-mismatch");
  }
  if (!secretMatchesOwnerFile(home, token.secret)) {
    throw new ComponentHandoffError("Handoff token secret does not match the run reservation.", "token-mismatch");
  }
  return { pid: inspection.handoff.original.pid, startedAt: inspection.handoff.original.startedAt };
}

function secretMatchesOwnerFile(home: string, secret: string): boolean {
  const file = join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE);
  let raw: string;
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    raw = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const row = parsed as Record<string, unknown>;
  if (row.version !== 2 || typeof row.secretHash !== "string") return false;
  return timingSafeEqualHex(row.secretHash, hashSecret(secret));
}

function waitForCommit(ipc: NodeJS.Process, now: () => number): Promise<ComponentHandoffCommit> {
  if (typeof ipc.send !== "function") {
    return Promise.reject(new ComponentHandoffError("Launcher requires inherited IPC.", "invalid-commit"));
  }
  return new Promise((resolveCommit, rejectCommit) => {
    let settled = false;
    void now;
    const timer = setTimeout(() => {
      finish(new ComponentHandoffError("Timed out waiting for the handoff commit.", "timeout"));
    }, COMPONENT_HANDOFF_DEADLINE_MS);
    const finish = (error?: unknown, value?: ComponentHandoffCommit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipc.off("message", onMessage);
      if (error) rejectCommit(error);
      else resolveCommit(value as ComponentHandoffCommit);
    };
    const onMessage = (raw: unknown) => {
      try {
        const parsed = parseCommit(raw);
        try {
          ipc.send?.({ v: COMPONENT_HANDOFF_IPC_VERSION, type: "commit-ack" } satisfies ComponentHandoffCommitAck);
        } catch {
          finish(new ComponentHandoffError("Launcher could not acknowledge the commit.", "invalid-commit"));
          return;
        }
        finish(undefined, parsed);
      } catch (error) {
        finish(error);
      }
    };
    ipc.on("message", onMessage);
  });
}

function waitForReady(
  child: ChildProcess,
  deadline: number,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<AcceptHandoffReadyMessage> {
  return waitChildMessage(child, deadline, deps, (raw) => parseReady(raw), "spawn-failed");
}

function waitForAccepted(
  child: ChildProcess,
  ready: AcceptHandoffReadyMessage,
  deadline: number,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  return waitChildMessage(child, deadline, deps, (raw) => {
    if (!isPlainObject(raw) || raw.v !== 1) {
      throw new ComponentHandoffError("Target accept message is invalid.", "accept-failed");
    }
    if (raw.type === "failed") {
      throw new ComponentHandoffError("Target reported accept failure.", "accept-failed");
    }
    if (raw.type !== "accepted") {
      throw new ComponentHandoffError("Target did not report accepted.", "accept-failed");
    }
    if (raw.pid !== ready.pid || raw.startedAt !== ready.startedAt) {
      throw new ComponentHandoffError("Accepted identity does not match ready-to-accept.", "accept-failed");
    }
    return true;
  }, "accept-failed").then(() => undefined);
}

function waitChildMessage<T>(
  child: ChildProcess,
  deadline: number,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
  parse: (raw: unknown) => T,
  timeoutCode: ComponentHandoffFailureCode,
): Promise<T> {
  return new Promise((resolveMessage, rejectMessage) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) rejectMessage(error);
      else resolveMessage(value as T);
    };
    const onMessage = (raw: unknown) => {
      try {
        finish(undefined, parse(raw));
      } catch (error) {
        finish(error);
      }
    };
    const onExit = (code: number | null) => {
      finish(new ComponentHandoffError(`Target exited ${code ?? "null"} before handshake completed.`, timeoutCode));
    };
    const onError = () => {
      finish(new ComponentHandoffError("Target process failed before handshake completed.", timeoutCode));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    const poll = async () => {
      while (!settled && deps.now() < deadline) await deps.sleep(25);
      if (!settled) finish(new ComponentHandoffError("Timed out waiting for the target handshake.", timeoutCode));
    };
    void poll();
  });
}

function parseCommit(raw: unknown): ComponentHandoffCommit {
  if (!isPlainObject(raw) || raw.v !== 1 || raw.type !== "handoff-commit") {
    throw new ComponentHandoffError("Launcher commit message is invalid.", "invalid-commit");
  }
  const token = parseToken(raw.token);
  if (typeof raw.home !== "string" || !raw.home.trim()) {
    throw new ComponentHandoffError("Commit home is required.", "invalid-commit");
  }
  if (typeof raw.toolsRoot !== "string" || !raw.toolsRoot.trim()) {
    throw new ComponentHandoffError("Commit toolsRoot is required.", "invalid-commit");
  }
  if (typeof raw.artifactDigest !== "string" || !HEX64.test(raw.artifactDigest)) {
    throw new ComponentHandoffError("Commit artifactDigest is invalid.", "invalid-commit");
  }
  if (!Number.isInteger(raw.oldPid) || (raw.oldPid as number) <= 0) {
    throw new ComponentHandoffError("Commit oldPid is invalid.", "invalid-commit");
  }
  if (typeof raw.oldStartedAt !== "string" || !Number.isFinite(Date.parse(raw.oldStartedAt))) {
    throw new ComponentHandoffError("Commit oldStartedAt is invalid.", "invalid-commit");
  }
  if (typeof raw.cleanStopConfirmed !== "boolean") {
    throw new ComponentHandoffError("Commit cleanStopConfirmed is required.", "invalid-commit");
  }
  const runtime = parseRuntime(raw.runtime);
  const deadlineMs = raw.deadlineMs === undefined ? undefined : requireDeadline(raw.deadlineMs);
  return {
    token,
    home: raw.home,
    toolsRoot: raw.toolsRoot,
    artifactDigest: raw.artifactDigest,
    oldPid: raw.oldPid as number,
    oldStartedAt: raw.oldStartedAt,
    cleanStopConfirmed: raw.cleanStopConfirmed,
    runtime,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(raw.allowRealHome === true ? { allowRealHome: true } : {}),
  };
}

function parseRuntime(raw: unknown): ComponentHandoffRuntimeLaunch {
  if (!isPlainObject(raw)) throw new ComponentHandoffError("Commit runtime is invalid.", "invalid-commit");
  if (typeof raw.execPath !== "string" || !isAbsolute(resolve(raw.execPath))) {
    throw new ComponentHandoffError("Commit runtime.execPath is invalid.", "invalid-commit");
  }
  if (typeof raw.entry !== "string" || !raw.entry.trim()) {
    throw new ComponentHandoffError("Commit runtime.entry is invalid.", "invalid-commit");
  }
  if (!Array.isArray(raw.argv) || raw.argv.some((row) => typeof row !== "string")) {
    throw new ComponentHandoffError("Commit runtime.argv is invalid.", "invalid-commit");
  }
  const execArgv = raw.execArgv;
  if (execArgv !== undefined && (!Array.isArray(execArgv) || execArgv.some((row) => typeof row !== "string"))) {
    throw new ComponentHandoffError("Commit runtime.execArgv is invalid.", "invalid-commit");
  }
  const env = raw.env;
  if (env !== undefined && (!isPlainObject(env) || Object.values(env).some((row) => typeof row !== "string" && row !== undefined))) {
    throw new ComponentHandoffError("Commit runtime.env is invalid.", "invalid-commit");
  }
  return {
    execPath: raw.execPath,
    entry: raw.entry,
    argv: raw.argv as string[],
    ...(execArgv ? { execArgv: execArgv as string[] } : {}),
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    ...(env ? { env: env as NodeJS.ProcessEnv } : {}),
  };
}

function parseTokenMessage(raw: unknown): HomeControlHandoffToken {
  if (!isPlainObject(raw) || raw.v !== 1 || raw.type !== "handoff-token") {
    throw new ComponentHandoffError("Handoff token message is invalid.", "token-mismatch");
  }
  return parseToken(raw.token);
}

function parseReady(raw: unknown): AcceptHandoffReadyMessage {
  if (!isPlainObject(raw) || raw.v !== 1 || raw.type !== "ready-to-accept") {
    throw new ComponentHandoffError("Target ready-to-accept message is invalid.", "spawn-failed");
  }
  if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) {
    throw new ComponentHandoffError("Target ready pid is invalid.", "spawn-failed");
  }
  if (typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) {
    throw new ComponentHandoffError("Target ready startedAt is invalid.", "spawn-failed");
  }
  return {
    v: 1,
    type: "ready-to-accept",
    pid: raw.pid as number,
    startedAt: raw.startedAt,
  };
}

function parseToken(raw: unknown): HomeControlHandoffToken {
  if (!isPlainObject(raw) || raw.v !== 1) {
    throw new ComponentHandoffError("Handoff token is invalid.", "invalid-commit");
  }
  if (typeof raw.nonce !== "string" || !HEX32.test(raw.nonce)) {
    throw new ComponentHandoffError("Handoff token nonce is invalid.", "invalid-commit");
  }
  if (typeof raw.secret !== "string" || !HEX64.test(raw.secret)) {
    throw new ComponentHandoffError("Handoff token secret is invalid.", "invalid-commit");
  }
  if (typeof raw.homeDigest !== "string" || !HEX64.test(raw.homeDigest)) {
    throw new ComponentHandoffError("Handoff token homeDigest is invalid.", "invalid-commit");
  }
  if (typeof raw.handoffId !== "string" || !HANDOFF_ID_RE.test(raw.handoffId)) {
    throw new ComponentHandoffError("Handoff token handoffId is invalid.", "invalid-commit");
  }
  if (typeof raw.serviceEpoch !== "string" || !HEX64.test(raw.serviceEpoch)) {
    throw new ComponentHandoffError("Handoff token serviceEpoch is invalid.", "invalid-commit");
  }
  if (typeof raw.artifactDigest !== "string" || !HEX64.test(raw.artifactDigest)) {
    throw new ComponentHandoffError("Handoff token artifactDigest is invalid.", "invalid-commit");
  }
  return Object.freeze({
    v: 1 as const,
    homeDigest: raw.homeDigest,
    handoffId: raw.handoffId,
    serviceEpoch: raw.serviceEpoch,
    artifactDigest: raw.artifactDigest,
    nonce: raw.nonce,
    secret: raw.secret,
  });
}

function parseReceipt(raw: string): ComponentHandoffReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ComponentHandoffError("Handoff receipt is not valid JSON.", "invalid-commit");
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
    throw new ComponentHandoffError("Handoff receipt schema is unknown.", "invalid-commit");
  }
  for (const key of Object.keys(parsed)) {
    if (!(RECEIPT_KEYS as readonly string[]).includes(key)) {
      throw new ComponentHandoffError("Handoff receipt has unknown fields.", "invalid-commit");
    }
  }
  if (typeof parsed.handoffId !== "string" || !HANDOFF_ID_RE.test(parsed.handoffId)) {
    throw new ComponentHandoffError("Handoff receipt handoffId is invalid.", "invalid-commit");
  }
  if (typeof parsed.artifactDigest !== "string" || !HEX64.test(parsed.artifactDigest)) {
    throw new ComponentHandoffError("Handoff receipt artifactDigest is invalid.", "invalid-commit");
  }
  if (
    parsed.phase !== "waiting" &&
    parsed.phase !== "selected" &&
    parsed.phase !== "spawned" &&
    parsed.phase !== "authorized" &&
    parsed.phase !== "accepted" &&
    parsed.phase !== "failed"
  ) {
    throw new ComponentHandoffError("Handoff receipt phase is invalid.", "invalid-commit");
  }
  if (parsed.status !== "running" && parsed.status !== "succeeded" && parsed.status !== "failed") {
    throw new ComponentHandoffError("Handoff receipt status is invalid.", "invalid-commit");
  }
  if (typeof parsed.startedAt !== "string" || typeof parsed.updatedAt !== "string") {
    throw new ComponentHandoffError("Handoff receipt timestamps are invalid.", "invalid-commit");
  }
  if (parsed.code !== undefined && !isFailureCode(parsed.code)) {
    throw new ComponentHandoffError("Handoff receipt code is invalid.", "invalid-commit");
  }
  const receipt: ComponentHandoffReceipt = {
    schemaVersion: 1,
    handoffId: parsed.handoffId,
    phase: parsed.phase,
    artifactDigest: parsed.artifactDigest,
    status: parsed.status,
    startedAt: parsed.startedAt,
    updatedAt: parsed.updatedAt,
  };
  if (parsed.code) receipt.code = parsed.code;
  return receipt;
}

function writeReceipt(home: string, receipt: ComponentHandoffReceipt, access?: ComponentHomeAccess): void {
  const canonical = canonicalHome(home, homeAccess(home, access));
  const dir = join(canonical, HOME_CONTROL_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new ComponentHandoffError("Control directory is not a real directory.", "invalid-commit");
  }
  if (!sameResolved(realpathSync(dir), dir)) {
    throw new ComponentHandoffError("Control directory is a path alias.", "invalid-commit");
  }
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    handoffId: receipt.handoffId,
    phase: receipt.phase,
    artifactDigest: receipt.artifactDigest,
    status: receipt.status,
    startedAt: receipt.startedAt,
    updatedAt: receipt.updatedAt,
  };
  if (receipt.code) payload.code = receipt.code;
  atomicWrite(receiptPath(canonical), `${JSON.stringify(payload)}\n`);
}

function receiptPath(home: string): string {
  return join(home, HOME_CONTROL_DIR_NAME, COMPONENT_HANDOFF_RECEIPT_FILE);
}

function waitForCommitAck(child: ChildProcess): Promise<void> {
  return new Promise((resolveAck, rejectAck) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new ComponentHandoffError("Timed out waiting for launcher commit acknowledgement.", "invalid-commit"));
    }, 10_000);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) rejectAck(error);
      else resolveAck();
    };
    const onMessage = (raw: unknown) => {
      if (isPlainObject(raw) && raw.v === 1 && raw.type === "commit-ack") finish();
    };
    const onExit = () => {
      finish(new ComponentHandoffError("Launcher exited before acknowledging the commit.", "invalid-commit"));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function sendIpc(
  child: ChildProcess,
  payload: object,
  code: ComponentHandoffFailureCode = "invalid-commit",
): Promise<void> {
  return new Promise((resolveSend, rejectSend) => {
    if (!child.connected) {
      rejectSend(new ComponentHandoffError("IPC is not connected.", code));
      return;
    }
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      if (error) rejectSend(new ComponentHandoffError("IPC send did not complete.", code));
      else resolveSend();
    };
    const ok = child.send(payload, (error) => finish(error));
    if (!ok) finish(new Error("ipc send failed"));
  });
}

function homeAccess(home: string, access?: ComponentHomeAccess): { allowRealHome?: boolean } {
  if (access?.allowRealHome === true || isAuthorizedProductHome(home)) return { allowRealHome: true };
  return {};
}

function clampDeadline(value: number | undefined): number {
  if (value === undefined) return COMPONENT_HANDOFF_DEADLINE_MS;
  return Math.min(120_000, Math.max(100, value));
}

function requireDeadline(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ComponentHandoffError("Commit deadlineMs is invalid.", "invalid-commit");
  }
  return value;
}

function readStagedPayload(commit: ComponentHandoffCommit): ValidatedComponentPayload {
  const lib = join(resolve(commit.toolsRoot), COMPONENT_STAGED_DIR_NAME, commit.artifactDigest, "lib");
  try {
    const staged = validateComponentPayload(lib);
    if (staged.digest !== commit.artifactDigest) {
      throw new ComponentHandoffError("Staged component payload digest does not match.", "select-failed");
    }
    return staged;
  } catch (error) {
    if (error instanceof ComponentHandoffError) throw error;
    throw new ComponentHandoffError("Component pointer could not be selected.", "select-failed");
  }
}

function resolveManifestSupervisorEntry(payload: ValidatedComponentPayload): string {
  const abs = resolve(payload.packageRoot, payload.manifest.components.supervisor.entry);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new ComponentHandoffError("Selected supervisor entry is missing.", "invalid-commit");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ComponentHandoffError("Selected supervisor entry is not a regular file.", "invalid-commit");
  }
  try {
    return realpathSync(abs);
  } catch {
    throw new ComponentHandoffError("Selected supervisor entry could not be resolved.", "invalid-commit");
  }
}

function assertCommitEntryMatches(commit: ComponentHandoffCommit, resolved: string): void {
  const givenAbs = resolve(commit.runtime.cwd ?? dirname(commit.runtime.entry), commit.runtime.entry);
  let st;
  try {
    st = lstatSync(givenAbs);
  } catch {
    throw new ComponentHandoffError("Commit runtime.entry is not the selected supervisor entry.", "invalid-commit");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ComponentHandoffError("Commit runtime.entry is not the selected supervisor entry.", "invalid-commit");
  }
  let givenReal: string;
  try {
    givenReal = realpathSync(givenAbs);
  } catch {
    throw new ComponentHandoffError("Commit runtime.entry is not the selected supervisor entry.", "invalid-commit");
  }
  if (!sameResolved(givenReal, resolved)) {
    throw new ComponentHandoffError("Commit runtime.entry is not the selected supervisor entry.", "invalid-commit");
  }
}

function assertNoTransportSecrets(commit: ComponentHandoffCommit): void {
  const runtime = commit.runtime;
  const pieces = [
    ...runtime.argv,
    ...(runtime.execArgv ?? []),
    runtime.entry,
    runtime.execPath,
    ...(runtime.cwd ? [runtime.cwd] : []),
  ];
  const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...(runtime.env ?? {}) };
  assertEnvHasNoSecretNames(effectiveEnv);
  for (const value of Object.values(effectiveEnv)) {
    if (typeof value === "string") pieces.push(value);
  }
  assertArgvHasNoSecret(pieces, commit.token);
}

function assertArgvHasNoSecret(argv: readonly string[], token: HomeControlHandoffToken): void {
  assertArgvHasNoSecretShape(argv);
  for (const row of argv) {
    if (row.includes(token.secret) || row.includes(token.nonce)) {
      throw new ComponentHandoffError("Handoff secrets must not appear on argv or in environment values.", "invalid-commit");
    }
  }
}

function assertArgvHasNoSecretShape(argv: readonly string[]): void {
  for (const row of argv) {
    if (/(^|_)(token|secret|nonce)($|_)/i.test(row) && HEX64.test(row)) {
      throw new ComponentHandoffError("Handoff secret must not appear on argv.", "invalid-commit");
    }
  }
}

function assertEnvHasNoSecretNames(env?: NodeJS.ProcessEnv): void {
  if (!env) return;
  for (const key of Object.keys(env)) {
    if (/handoff[-_]?token|handoff[-_]?secret|control[-_]?nonce|dsh[-_]?handoff/i.test(key)) {
      throw new ComponentHandoffError("Handoff secrets must not travel in environment variables.", "invalid-commit");
    }
  }
}

function writeStatus(line: string): void {
  try {
    process.stdout.write(`status=${line}\n`);
  } catch {
    /* ignore */
  }
}

function killChild(child: ChildProcess): void {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  } catch {
    /* leave the child; do not reclaim the lock */
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isFailureCode(value: unknown): value is ComponentHandoffFailureCode {
  return (
    value === "missing-confirmation" ||
    value === "token-mismatch" ||
    value === "old-alive" ||
    value === "old-ambiguous" ||
    value === "timeout" ||
    value === "select-failed" ||
    value === "spawn-failed" ||
    value === "accept-failed" ||
    value === "invalid-commit" ||
    value === "reservation"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameResolved(a: string, b: string): boolean {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
