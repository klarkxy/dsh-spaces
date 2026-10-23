import { lstatSync, realpathSync } from "../../../src/shared/node/filesystem";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HOME_CONTROL_DIR_NAME } from "../../../src/adapters/node/home/home-controller.ts";
import { isCompatibleDshCliVersion } from "../../../src/adapters/node/products/spaces-control.ts";
import {
  CONTROL_TOOLCHAIN_FILE,
  EXIT,
  Fail,
  fail,
  inspectNamedDir,
  inspectNamedFile,
  type Json,
} from "./common.ts";

export interface BoundCli {
  bin: string;
  version: string;
  allowedVerify: boolean;
  allowedWrite: boolean;
}

export interface ResolvedResources {
  cli?: BoundCli;
  cliError?: "CLI_NOT_ABSOLUTE" | "RUNTIME_UNBOUND";
  snapshotRoot?: string;
  runtimeRoot?: string;
  toolchainRoot?: string;
  toolchain: Json;
  missing: string[];
}

export function bindCli(cli: string, required: boolean): BoundCli {
  if (!isAbsolute(cli)) {
    throw fail(EXIT.usage, "USAGE", required ? "verify requires an absolute --cli path." : "--cli must be an absolute path.");
  }
  try {
    const bin = resolve(cli);
    const st = lstatSync(bin);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("cli");
    const manifest = join(dirname(bin), "..", "package.json");
    const manStat = lstatSync(manifest);
    if (manStat.isSymbolicLink() || !manStat.isFile()) throw new Error("cli");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "@deepseek-ai/dsh" || typeof pkg.version !== "string") throw new Error("cli");
    return {
      bin: realpathSync(bin),
      version: pkg.version,
      allowedVerify: isCompatibleDshCliVersion(pkg.version),
      allowedWrite: isCompatibleDshCliVersion(pkg.version),
    };
  } catch (error) {
    if (error instanceof Fail) throw error;
    throw fail(EXIT.runtime, "RUNTIME_UNBOUND", "The --cli path is not a bound DSH CLI.");
  }
}

export function publicRuntime(cli: BoundCli | undefined, cliError?: ResolvedResources["cliError"]): Json {
  if (cli) return { bound: true, version: cli.version, allowed: cli.allowedVerify };
  if (cliError) return { bound: false, code: cliError };
  return { bound: false };
}

function trustAbsoluteDir(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim() || !isAbsolute(raw)) return undefined;
  const resolved = resolve(raw);
  const state = inspectNamedDir(resolved);
  if (state !== "ok") return undefined;
  try {
    return realpathSync(resolved);
  } catch {
    return undefined;
  }
}

function readToolchainFile(home: string): { record: Record<string, unknown> | undefined; status: Json } {
  const path = join(home, HOME_CONTROL_DIR_NAME, CONTROL_TOOLCHAIN_FILE);
  const state = inspectNamedFile(path);
  if (state === "missing") return { record: undefined, status: { recorded: false } };
  if (state !== "ok") {
    return { record: undefined, status: { recorded: true, unreadable: true, code: state.toUpperCase() } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { record: undefined, status: { recorded: true, unreadable: true, code: "UNREADABLE" } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { record: undefined, status: { recorded: true, unreadable: true, code: "UNREADABLE" } };
  }
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1) {
    return { record: undefined, status: { recorded: true, unreadable: true, code: "UNSUPPORTED_VERSION" } };
  }
  return { record: row, status: { recorded: true, version: 1 } };
}

export function resolveResources(home: string, flags: Record<string, string>): ResolvedResources {
  const file = readToolchainFile(home);
  const missing: string[] = [];
  let cli: BoundCli | undefined;
  let cliError: ResolvedResources["cliError"];
  if (flags.cli) {
    try {
      cli = bindCli(flags.cli, false);
    } catch (error) {
      cliError = error instanceof Fail && error.body.code === "USAGE" ? "CLI_NOT_ABSOLUTE" : "RUNTIME_UNBOUND";
    }
  } else if (typeof file.record?.bin === "string" && file.record.bin.trim()) {
    try {
      cli = bindCli(file.record.bin, false);
      if (typeof file.record.dshVersion === "string" && file.record.dshVersion !== cli.version) {
        cli = undefined;
        file.status = { recorded: true, unreadable: true, code: "VERSION_MISMATCH" };
      }
    } catch {
      file.status = { ...file.status, verified: false, code: "RUNTIME_UNBOUND" };
    }
  }

  const snapshotRoot = flags.snapshotRoot
    ? trustAbsoluteDir(flags.snapshotRoot)
    : trustAbsoluteDir(file.record?.snapshotRoot);
  const runtimeRoot = flags.runtimeRoot
    ? trustAbsoluteDir(flags.runtimeRoot)
    : trustAbsoluteDir(file.record?.runtimeRoot);
  const toolchainRoot = trustAbsoluteDir(file.record?.toolchainRoot);

  if (flags.snapshotRoot && !snapshotRoot) {
    throw fail(EXIT.usage, "USAGE", "--snapshot-root must be an existing real directory.");
  }
  if (flags.runtimeRoot && !runtimeRoot) {
    throw fail(EXIT.usage, "USAGE", "--runtime-root must be an existing real directory.");
  }
  if (!snapshotRoot) missing.push("snapshot-root");
  if (!runtimeRoot) missing.push("runtime-root");
  if (!cli) missing.push("cli");

  const toolchain: Json = {
    ...file.status,
    hasSnapshotRoot: Boolean(snapshotRoot),
    hasRuntimeRoot: Boolean(runtimeRoot),
    writeAllowed: cli?.allowedWrite === true,
    ...(cli ? { dshVersion: cli.version } : {}),
    ...(missing.length ? { missing } : {}),
  };

  return { cli, cliError, snapshotRoot, runtimeRoot, toolchainRoot, toolchain, missing };
}

