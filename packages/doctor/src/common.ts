import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WRITE_CLI_VERSION = "0.1.5-rc.1";
export const VERIFY_CLI_VERSIONS = new Set(["0.1.5-rc.1", "0.1.5-rc.2"]);
export const STDOUT_LIMIT = 256 * 1024;
export const MUTATION_JOURNAL = ".dsh-spaces-mutation.json";
export const UPGRADE_STAGE_DIR = ".dsh-spaces-upgrade";
export const UPGRADE_JOURNAL_FILE = "journal.json";
export const CONTROL_TOOLCHAIN_FILE = "toolchain.json";
export const CONTROL_INSTANCES_DIR = "instances";
export const CONTROL_PLANS_DIR = "plans";
export const PLUGIN_MUTATION_FILE = "plugin-mutation.json";
export const PLUGIN_MUTATION_FILES_DIR = "plugin-mutation-files";
export const PLUGIN_MUTATION_ARCHIVE_DIR = "plugin-mutation-archive";
export const DOCTOR_CONTROL_KIND = "web" as const;

export const EXIT = {
  ok: 0,
  usage: 2,
  lock: 3,
  verify: 4,
  profile: 5,
  runtime: 6,
  recovery: 10,
} as const;

export type Json = Record<string, unknown>;

export class Fail extends Error {
  readonly name = "Fail";
  constructor(
    readonly exit: number,
    readonly body: Json,
  ) {
    super(String(body.code ?? "FAIL"));
  }
}

export function fail(exit: number, code: string, message: string, extra: Json = {}): Fail {
  return new Fail(exit, { ok: false, code, message, ...extra });
}

export function print(body: Json, exit: number = EXIT.ok): number {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  return exit;
}

export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function same(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

export function inside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (same(r, t)) return true;
  return t.toLowerCase().startsWith((r.endsWith(sep) ? r : r + sep).toLowerCase());
}

export function exactChildDir(home: string, name: string): string | null {
  const path = join(home, name);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    const real = realpathSync(path);
    return same(real, path) && inside(home, real) ? real : null;
  } catch {
    return null;
  }
}

export function containedPath(home: string, parts: string[], kind: "file" | "dir"): string | null {
  let current = home;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) return null;
    const next = join(current, part);
    let st;
    try {
      st = lstatSync(next);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return null;
    current = next;
  }
  try {
    const st = lstatSync(current);
    if (kind === "file" ? !st.isFile() : !st.isDirectory()) return null;
    const real = realpathSync(current);
    return same(real, current) && inside(home, real) ? real : null;
  } catch {
    return null;
  }
}

export function readErrno(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

export function inspectNamedDir(path: string): "ok" | "missing" | "unreadable" | "ambiguous" {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    const code = readErrno(error);
    if (code === "ENOENT") return "missing";
    return "unreadable";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return "ambiguous";
  try {
    const real = realpathSync(path);
    return same(real, path) ? "ok" : "ambiguous";
  } catch {
    return "ambiguous";
  }
}

export function inspectNamedFile(path: string): "ok" | "missing" | "unreadable" | "ambiguous" {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    const code = readErrno(error);
    if (code === "ENOENT") return "missing";
    return "unreadable";
  }
  if (st.isSymbolicLink() || !st.isFile()) return "ambiguous";
  return "ok";
}

export function doctorEntryPath(): string | undefined {
  try {
    return realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

export function runningToolPaths(): string[] {
  const paths: string[] = [];
  try {
    paths.push(realpathSync(process.execPath));
  } catch {
    paths.push(resolve(process.execPath));
  }
  const entry = process.argv[1];
  if (entry) {
    try {
      paths.push(realpathSync(resolve(entry)));
    } catch {
      if (isAbsolute(entry)) paths.push(resolve(entry));
    }
  }
  const self = doctorEntryPath();
  if (self) {
    paths.push(self);
    paths.push(dirname(self));
  }
  return paths;
}

export function pathInsideAny(target: string, candidates: string[]): boolean {
  return candidates.some((candidate) => inside(target, candidate));
}
