import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOME_CONTROL_DIR_NAME } from "../node/home-controller";
import { readRuntimeRef } from "../../main/runtime-descriptor";

export const CONTROL_JOBS_DIR_NAME = "jobs";
export const CONTROL_INSTANCES_DIR_NAME = "instances";
export const CONTROL_TOOLCHAIN_FILE = "toolchain.json";
export const HOME_UPGRADE_STAGE_DIR = ".dsh-spaces-upgrade";
export const HOME_UPGRADE_JOURNAL_FILE = "journal.json";
export const HOME_MUTATION_JOURNAL = ".dsh-spaces-mutation.json";

const TERMINAL_JOB_STATUS = new Set(["succeeded", "failed", "cancelled"]);
const UNFINISHED_JOB_STATUS = new Set(["queued", "running", "recovery-required"]);

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
  | VerifiedHomeToolchain;

/** Read-only scan of leftover control-dir work. Never writes or kills. */
export function inspectControlResidue(home: string, ownsRecord?: (value: Record<string, unknown>) => boolean): string[] {
  return [
    ...inspectJobs(join(home, HOME_CONTROL_DIR_NAME, CONTROL_JOBS_DIR_NAME)),
    ...inspectInstances(join(home, HOME_CONTROL_DIR_NAME, CONTROL_INSTANCES_DIR_NAME), ownsRecord),
    ...inspectExistingFile(
      join(home, HOME_UPGRADE_STAGE_DIR, HOME_UPGRADE_JOURNAL_FILE),
      "An upgrade journal is unfinished and was not replayed.",
    ),
    ...inspectExistingFile(join(home, HOME_MUTATION_JOURNAL), "A Spaces operation needs recovery."),
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
  const probed = readRuntimeRef(row.bin);
  if (!probed) {
    return {
      kind: "invalid",
      reason: "The Home toolchain binary could not be verified from files next to it.",
    };
  }
  if (probed.version !== row.dshVersion) {
    return {
      kind: "invalid",
      reason: "The Home toolchain binary version does not match the recorded DSH version.",
    };
  }
  if (!existsSync(row.nodeExe)) {
    return { kind: "invalid", reason: "The Home toolchain Node executable is missing." };
  }
  for (const key of ["runtimeRoot", "snapshotRoot", "toolchainRoot"]) {
    if (row[key] !== undefined && (typeof row[key] !== "string" || !isAbsolute(row[key] as string))) {
      return { kind: "invalid", reason: "The Home resource record contains an invalid directory." };
    }
  }
  return {
    kind: "verified",
    bin: probed.bin,
    nodeExe: row.nodeExe,
    dshVersion: probed.version,
    runtimeRoot: row.runtimeRoot as string | undefined,
    snapshotRoot: row.snapshotRoot as string | undefined,
    toolchainRoot: row.toolchainRoot as string | undefined,
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

function inspectInstances(dir: string, ownsRecord?: (value: Record<string, unknown>) => boolean): string[] {
  const state = inspectNamedDir(dir);
  if (state === "missing") return [];
  if (state === "ambiguous") return ["Instance records are ambiguous and were not adopted."];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return ["Instance records could not be read."];
  }
  if (names.every(name => {
    if (!ownsRecord) return false;
    try {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) &&
        value.spaceId === name.slice(0, -5) && ownsRecord(value);
    } catch { return false; }
  })) return [];
  return ["Leftover instance records were not adopted and unknown processes were not killed."];
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
