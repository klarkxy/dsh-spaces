import { lstatSync } from "../../../shared/node/filesystem";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { HOME_CONTROL_DIR_NAME } from "./home-lease";
import { readRuntimeRef } from "../runtime/runtime-descriptor";

export const CONTROL_TOOLCHAIN_FILE = "toolchain.json";
export const HOME_MUTATION_JOURNAL = ".dsh-spaces-mutation.json";


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
    join(home, HOME_MUTATION_JOURNAL),
    join(home, HOME_CONTROL_DIR_NAME, "plugin-mutation.json"),
    join(home, HOME_CONTROL_DIR_NAME, "workbench-upgrade.json"),
    join(home, HOME_CONTROL_DIR_NAME, "manager-bootstrap.json"),
  ].some(path => {
    try { lstatSync(path); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  });
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







