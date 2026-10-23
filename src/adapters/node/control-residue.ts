import { lstatSync } from "../../shared/node/filesystem";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { defaultPidAlive, HOME_CONTROL_DIR_NAME, type PidAliveFn } from "./home-controller";
import { readRuntimeRef } from "./runtime-descriptor";

export const CONTROL_JOBS_DIR_NAME = "jobs";
export const CONTROL_INSTANCES_DIR_NAME = "instances";
export const CONTROL_TOOLCHAIN_FILE = "toolchain.json";
export const HOME_UPGRADE_STAGE_DIR = ".dsh-spaces-upgrade";
export const HOME_UPGRADE_JOURNAL_FILE = "journal.json";
export const HOME_MUTATION_JOURNAL = ".dsh-spaces-mutation.json";

const TERMINAL_JOB_STATUS = new Set(["succeeded", "failed", "cancelled"]);
const UNFINISHED_JOB_STATUS = new Set(["queued", "running"]);

export interface VerifiedHomeToolchain {
  kind: "verified";
  bin: string;
  nodeExe: string;
  dshVersion: string;
  runtimeRoot?: string;
  snapshotRoot?: string;
  toolchainRoot?: string;
}

export type HomeToolchainInspect =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | StaleHomeToolchain
  | VerifiedHomeToolchain;

/**
 * A complete record whose bound DSH binary was replaced by a host update (or
 * whose recorded Node executable moved). This is a superseded host binding,
 * not interrupted maintenance: its directories are still authoritative and the
 * next Supervisor start binds the current host CLI and rewrites the record.
 */
export interface StaleHomeToolchain {
  kind: "stale";
  reason: string;
  runtimeRoot?: string;
  snapshotRoot?: string;
  toolchainRoot?: string;
}

/** Any interrupted Home maintenance evidence blocks a new writer, even when unreadable. */
export function hasUnfinishedMaintenance(home: string, snapshotRoot?: string): boolean {
  const toolchain = inspectHomeToolchain(home);
  if (toolchain.kind === "invalid") return true;
  const root = (toolchain.kind === "verified" || toolchain.kind === "stale" ? toolchain.snapshotRoot : undefined) ??
    snapshotRoot ?? join(resolve(home, ".."), `${basename(home)}-snapshots`);
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  return [
    join(root, "pending-restore.json"),
    join(home, ".dsh-spaces-restore", "journal.json"),
    join(home, HOME_UPGRADE_STAGE_DIR, HOME_UPGRADE_JOURNAL_FILE),
    join(home, HOME_MUTATION_JOURNAL),
    join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json"),
    join(home, HOME_CONTROL_DIR_NAME, "workbench-upgrade.json"),
    join(home, HOME_CONTROL_DIR_NAME, "manager-bootstrap.json"),
  ].some(path => {
    try { lstatSync(path); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  });
}

/** Read-only scan of leftover control-dir work. Never writes or kills. */
export function inspectControlResidue(
  home: string,
  ownsRecord?: (value: Record<string, unknown>) => boolean,
  pidAlive: PidAliveFn = defaultPidAlive,
): string[] {
  return [
    ...inspectJobs(join(home, HOME_CONTROL_DIR_NAME, CONTROL_JOBS_DIR_NAME)),
    ...inspectInstances(join(home, HOME_CONTROL_DIR_NAME, CONTROL_INSTANCES_DIR_NAME), ownsRecord, pidAlive),
    ...inspectExistingFile(
      join(home, HOME_UPGRADE_STAGE_DIR, HOME_UPGRADE_JOURNAL_FILE),
      "An upgrade journal is unfinished and was not replayed.",
    ),
    ...inspectExistingFile(join(home, HOME_MUTATION_JOURNAL), "A Spaces operation left unfinished evidence. Writes are blocked."),
    ...inspectExistingFile(join(home, HOME_CONTROL_DIR_NAME, "workbench-upgrade.json"), "A workbench package update left unfinished evidence. Writes are blocked."),
  ];
}

export function inspectHomeToolchain(home: string): HomeToolchainInspect {
  const path = join(home, HOME_CONTROL_DIR_NAME, CONTROL_TOOLCHAIN_FILE);
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: "The Home toolchain record could not be read." };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { kind: "invalid", reason: "The Home toolchain record is ambiguous." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "invalid", reason: "The Home toolchain record is truncated or unreadable." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "The Home toolchain record is not a valid object." };
  }
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1) {
    return { kind: "invalid", reason: "The Home toolchain record uses an unsupported version." };
  }
  if (typeof row.bin !== "string" || !row.bin.trim() || typeof row.nodeExe !== "string" || !row.nodeExe.trim()) {
    return { kind: "invalid", reason: "The Home toolchain record is incomplete." };
  }
  if (typeof row.dshVersion !== "string" || !row.dshVersion.trim()) {
    return { kind: "invalid", reason: "The Home toolchain record is missing a verified DSH version." };
  }
  for (const key of ["runtimeRoot", "snapshotRoot", "toolchainRoot"]) {
    if (row[key] !== undefined && (typeof row[key] !== "string" || !isAbsolute(row[key] as string))) {
      return { kind: "invalid", reason: "The Home resource record contains an invalid directory." };
    }
  }
  const roots = {
    runtimeRoot: row.runtimeRoot as string | undefined,
    snapshotRoot: row.snapshotRoot as string | undefined,
    toolchainRoot: row.toolchainRoot as string | undefined,
  };
  // The record is complete. A binary or Node executable that no longer matches
  // means a host update superseded the binding; that is not maintenance.
  const probed = readRuntimeRef(row.bin);
  if (!probed) {
    return { kind: "stale", reason: "The bound DSH binary is no longer present; a host update replaced it.", ...roots };
  }
  if (probed.version !== row.dshVersion) {
    return { kind: "stale", reason: "The bound DSH binary version changed after a host update.", ...roots };
  }
  if (!existsSync(row.nodeExe)) {
    return { kind: "stale", reason: "The bound Node executable is no longer present.", ...roots };
  }
  return {
    kind: "verified",
    bin: probed.bin,
    nodeExe: row.nodeExe,
    dshVersion: probed.version,
    ...roots,
  };
}

function inspectJobs(dir: string): string[] {
  const state = inspectNamedDir(dir);
  if (state === "missing") return [];
  if (state === "ambiguous") return ["Workbench job records are ambiguous and were not cleared."];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"));
  } catch {
    return ["Workbench job records could not be read."];
  }
  const reasons: string[] = [];
  for (const name of names) {
    const reason = inspectJobFile(join(dir, name));
    if (reason) reasons.push(reason);
  }
  return unique(reasons);
}

function inspectJobFile(path: string): string | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "A workbench job record could not be read and was not cleared.";
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return "A workbench job record is ambiguous and was not cleared.";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "A workbench job record is truncated or unreadable and was not replayed.";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "A workbench job record is truncated or unreadable and was not replayed.";
  }
  const row = parsed as Record<string, unknown>;
  if (row.schemaVersion !== 1) {
    return "A workbench job record uses an unsupported schema and was not replayed.";
  }
  if (typeof row.status !== "string" || !row.status) {
    return "A workbench job record is truncated and was not replayed.";
  }
  if (UNFINISHED_JOB_STATUS.has(row.status)) {
    return "Interrupted workbench jobs must be recovered before new changes.";
  }
  if (!TERMINAL_JOB_STATUS.has(row.status)) {
    return "A workbench job record has an unknown status and was not replayed.";
  }
  return undefined;
}

function inspectInstances(
  dir: string,
  ownsRecord?: (value: Record<string, unknown>) => boolean,
  pidAlive: PidAliveFn = defaultPidAlive,
): string[] {
  const state = inspectNamedDir(dir);
  if (state === "missing") return [];
  if (state === "ambiguous") return ["Instance records are ambiguous and were not adopted."];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return ["Instance records could not be read."];
  }
  for (const name of names) {
    const blocking = inspectInstanceFile(join(dir, name), name.slice(0, -5), ownsRecord, pidAlive);
    if (blocking) {
      return ["Leftover instance records were not adopted and unknown processes were not killed."];
    }
  }
  return [];
}

function inspectInstanceFile(
  path: string,
  spaceId: string,
  ownsRecord: ((value: Record<string, unknown>) => boolean) | undefined,
  pidAlive: PidAliveFn,
): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return true;
  }
  if (st.isSymbolicLink() || !st.isFile()) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const value = parsed as Record<string, unknown>;
  if (value.spaceId !== spaceId) return true;
  if (ownsRecord?.(value)) return false;
  if (typeof value.pid !== "number" || typeof value.startedAt !== "string") return true;
  return pidAlive(value.pid, value.startedAt) !== "dead";
}

function inspectExistingFile(path: string, reason: string): string[] {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [reason];
  }
  if (st.isSymbolicLink() || !st.isFile()) return [reason];
  return [reason];
}

function inspectNamedDir(path: string): "ok" | "missing" | "ambiguous" {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "ambiguous";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return "ambiguous";
  return "ok";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
