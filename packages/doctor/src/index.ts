import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HomeLockBusyError,
  HomeOperationLock,
  type HomeLockInspect,
} from "../../../src/adapters/node/home-operation-lock.ts";
import { assertDumpPatched } from "../../../src/core/domain/isolation.ts";
import { normalizeSpacesFile } from "../../../src/core/domain/registry.ts";
import { terminateProcessTree } from "../../../src/main/terminate-process.ts";
import { RESTORE_STAGE_DIR } from "../../../src/shared/snapshots.ts";
import { PROFILE_NAME_RE, type SpacesFile } from "../../../src/shared/types.ts";

const MUTATION_JOURNAL = ".dsh-spaces-mutation.json";
const ALLOWED_CLI = new Set(["0.1.5-rc.1", "0.1.5-rc.2"]);
const STDOUT_LIMIT = 256 * 1024;
const EXIT = { ok: 0, usage: 2, lock: 3, verify: 4, profile: 5, runtime: 6, recovery: 10 } as const;

type Json = Record<string, unknown>;
class Fail extends Error {
  constructor(
    readonly exit: number,
    readonly body: Json,
  ) {
    super(String(body.code ?? "FAIL"));
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { command, flags } = parseArgv(argv);
    if (!command) throw fail(EXIT.usage, "USAGE", "Commands: doctor, verify, unlock, recover, rollback.");
    const homeFlag = requireFlag(flags, "home", "Explicit --home is required; this CLI never uses ~/.dsh.");
    if (command === "recover" || command === "rollback") throw recoveryUnavailable(command);
    const lock = new HomeOperationLock(homeFlag);
    if (command === "doctor") return print({ ok: true, command, ...inspectHome(lock, flags.cli) });
    if (command === "unlock") return runUnlock(lock);
    if (command === "verify") return await runVerify(lock, flags);
    throw fail(EXIT.usage, "USAGE", "Commands: doctor, verify, unlock, recover, rollback.");
  } catch (error) {
    if (error instanceof Fail) return print(error.body, error.exit);
    const text = error instanceof Error ? error.message : "";
    if (/refusing to use the real DSH home/i.test(text)) {
      return print(
        { ok: false, code: "REAL_HOME", message: "Refusing the production DSH home. Pass a disposable --home." },
        EXIT.usage,
      );
    }
    return print({ ok: false, code: "HOME_INVALID", message: "The --home directory is not a usable DSH home." }, EXIT.usage);
  }
}

function parseArgv(argv: string[]): { command: string | undefined; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--home" || token === "--cli" || token === "--profile") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw fail(EXIT.usage, "USAGE", `Missing value for ${token}.`);
      flags[token.slice(2)] = value;
      i += 1;
      continue;
    }
    if (token.startsWith("-")) throw fail(EXIT.usage, "USAGE", "Unknown flag.");
    rest.push(token);
  }
  if (rest.length > 1) throw fail(EXIT.usage, "USAGE", "Unexpected extra arguments.");
  return { command: rest[0], flags };
}

function requireFlag(flags: Record<string, string>, name: string, message: string): string {
  const value = flags[name]?.trim();
  if (!value) throw fail(EXIT.usage, "USAGE", message);
  return value;
}

function inspectHome(lock: HomeOperationLock, cli: string | undefined): Json {
  return {
    registry: readRegistry(lock.home),
    journals: { mutation: readMutationJournal(lock.home), restore: readRestoreJournal(lock.home) },
    lock: publicLock(lock.inspect()),
    runtime: publicRuntime(cli),
  };
}

function publicRuntime(cli: string | undefined): Json {
  if (!cli) return { bound: false };
  try {
    const bound = bindCli(cli);
    return { bound: true, version: bound.version, allowed: bound.allowed };
  } catch (error) {
    if (error instanceof Fail && error.body.code === "USAGE") return { bound: false, code: "CLI_NOT_ABSOLUTE" };
    return { bound: false, code: "RUNTIME_UNBOUND" };
  }
}

function readRegistry(home: string): Json {
  const hubPath = join(home, "hub");
  const filePath = join(hubPath, "spaces.json");
  if (!lexists(hubPath) && !lexists(filePath)) return { status: "missing" };
  if (lexists(hubPath) && !exactChildDir(home, "hub")) return { status: "invalid", code: "UNREADABLE" };
  const file = containedPath(home, ["hub", "spaces.json"], "file");
  if (!file) return lexists(filePath) ? { status: "invalid", code: "UNREADABLE" } : { status: "missing" };
  try {
    const parsed = normalizeSpacesFile(JSON.parse(readFileSync(file, "utf8")) as SpacesFile);
    const order = parsed.order.filter((name) => name === "web" || PROFILE_NAME_RE.test(name));
    return { status: "ok", version: parsed.version, onboarded: Boolean(parsed.onboarded), order };
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    return { status: "invalid", code: /version/i.test(text) || /版本/.test(text) ? "UNSUPPORTED_VERSION" : "UNREADABLE" };
  }
}

function readMutationJournal(home: string): Json | null {
  const path = join(home, MUTATION_JOURNAL);
  if (!lexists(path)) return null;
  const file = containedPath(home, [MUTATION_JOURNAL], "file");
  if (!file) return { present: true, unreadable: true };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const op = parsed.op === "create" || parsed.op === "verify" ? parsed.op : "unknown";
    const phase = typeof parsed.phase === "string" && /^[a-z0-9-]{1,32}$/.test(parsed.phase) ? parsed.phase : "unknown";
    const spaceId =
      typeof parsed.spaceId === "string" && (parsed.spaceId === "web" || PROFILE_NAME_RE.test(parsed.spaceId))
        ? parsed.spaceId
        : "unknown";
    return { present: true, op, phase, spaceId };
  } catch {
    return { present: true, unreadable: true };
  }
}

function readRestoreJournal(home: string): Json {
  const stage = join(home, RESTORE_STAGE_DIR);
  if (!lexists(stage) && !lexists(join(stage, "journal.json"))) return { needed: false };
  if (!exactChildDir(home, RESTORE_STAGE_DIR)) return { needed: true, unreadable: true };
  const file = containedPath(home, [RESTORE_STAGE_DIR, "journal.json"], "file");
  if (!file) return lexists(join(stage, "journal.json")) ? { needed: true, unreadable: true } : { needed: false };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { phase?: unknown };
    const phase =
      parsed.phase === "copying" || parsed.phase === "swapping" || parsed.phase === "swapped" ? parsed.phase : "unknown";
    return { needed: true, phase };
  } catch {
    return { needed: true, unreadable: true };
  }
}

function recoveryBlocksVerify(home: string): boolean {
  const mutation = readMutationJournal(home);
  const restore = readRestoreJournal(home);
  return Boolean(mutation) || restore.needed === true;
}

function publicLock(row: HomeLockInspect): Json {
  if (!row.held) return { held: false };
  if ("reclaim" in row && row.reclaim) return { held: true, reclaim: true };
  if ("incomplete" in row && row.incomplete) return { held: true, incomplete: true };
  if ("ambiguous" in row && row.ambiguous) return { held: true, ambiguous: true, reason: row.reason };
  if ("owner" in row) return { held: true, owner: row.owner };
  return { held: true, incomplete: true };
}

function runUnlock(lock: HomeOperationLock): number {
  const result = lock.unlockDead();
  if (result.unlocked) return print({ ok: true, command: "unlock", unlocked: true });
  const reason = result.reason;
  if (reason === "not-held") {
    return print({ ok: true, command: "unlock", unlocked: false, reason, message: unlockMessage(reason) });
  }
  return print({ ok: false, command: "unlock", unlocked: false, reason, message: unlockMessage(reason) }, EXIT.lock);
}

function unlockMessage(reason: string): string {
  if (reason === "owner-alive") return "The home lock is held by a live process and was not stolen.";
  if (reason === "ambiguous") return "The home lock path is ambiguous and was not stolen.";
  if (reason === "incomplete") return "The home lock is incomplete and was not stolen.";
  if (reason === "reclaim-in-progress") return "The home lock is being reclaimed and was not stolen.";
  if (reason === "remove-failed") return "The home lock could not be removed safely.";
  if (reason === "not-held") return "No home lock is held.";
  return "The home lock could not be cleared.";
}

async function runVerify(lock: HomeOperationLock, flags: Record<string, string>): Promise<number> {
  const profile = requireFlag(flags, "profile", "verify requires --profile.");
  const cli = bindCli(requireFlag(flags, "cli", "verify requires an absolute --cli path."));
  if (!cli.allowed) throw fail(EXIT.runtime, "RUNTIME_REFUSED", "Only DSH CLI 0.1.5-rc.1 and 0.1.5-rc.2 can verify.");
  assertProfileName(profile);
  try {
    const dump = await lock.run("verify", async () => {
      if (recoveryBlocksVerify(lock.home)) {
        throw fail(
          EXIT.recovery,
          "RECOVERY_NEEDED",
          "A previous space operation did not finish. Use Desktop recovery; doctor will not write during recovery.",
        );
      }
      assertProfile(lock.home, profile);
      const text = await dumpConfig(lock.home, cli.bin, profile);
      assertDumpPatched(text, profile);
      return text;
    });
    return print({ ok: true, command: "verify", profile, valid: Boolean(dump) });
  } catch (error) {
    if (error instanceof HomeLockBusyError) {
      throw fail(EXIT.lock, "LOCK_HELD", "verify needs the home lock and will not steal it.");
    }
    if (error instanceof Fail) throw error;
    throw fail(EXIT.verify, "VERIFY_FAILED", "Isolation dump did not match the expected roots.");
  }
}

function assertProfileName(name: string): void {
  if (/[\\/]/.test(name) || name.includes("..") || name.includes("\0") || name.includes(":")) {
    throw fail(EXIT.profile, "INVALID_PROFILE", "Profile names cannot be paths.");
  }
  if (name === "web") throw fail(EXIT.profile, "HOST_DENIED", "The web profile cannot be patched or verified this way.");
  if (!PROFILE_NAME_RE.test(name)) throw fail(EXIT.profile, "INVALID_PROFILE", "Profile names cannot be paths.");
}

function assertProfile(home: string, name: string): void {
  assertProfileName(name);
  if (!exactChildDir(home, "profiles")) {
    throw fail(
      EXIT.profile,
      lexists(join(home, "profiles")) ? "PROFILE_SYMLINK" : "UNKNOWN_PROFILE",
      lexists(join(home, "profiles")) ? "Profile path escaped through a symlink." : "That profile was not found.",
    );
  }
  const dir = containedPath(home, ["profiles", name], "dir");
  if (!dir) {
    throw fail(
      EXIT.profile,
      lexists(join(home, "profiles", name)) ? "PROFILE_SYMLINK" : "UNKNOWN_PROFILE",
      lexists(join(home, "profiles", name)) ? "Profile path escaped through a symlink." : "That profile was not found.",
    );
  }
  for (const file of ["package.json", "cordis.patch.yml"]) {
    if (!lexists(join(dir, file))) continue;
    if (!containedPath(home, ["profiles", name, file], "file")) {
      throw fail(EXIT.profile, "PROFILE_SYMLINK", "Profile path escaped through a symlink.");
    }
  }
}

function bindCli(cli: string): { bound: true; bin: string; version: string; allowed: boolean } {
  if (!isAbsolute(cli)) throw fail(EXIT.usage, "USAGE", "verify requires an absolute --cli path.");
  try {
    const bin = resolve(cli);
    const st = lstatSync(bin);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("cli");
    const manifest = join(dirname(bin), "..", "package.json");
    const manStat = lstatSync(manifest);
    if (manStat.isSymbolicLink() || !manStat.isFile()) throw new Error("cli");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== "@deepseek-ai/dsh" || typeof pkg.version !== "string") throw new Error("cli");
    return { bound: true, bin: realpathSync(bin), version: pkg.version, allowed: ALLOWED_CLI.has(pkg.version) };
  } catch (error) {
    if (error instanceof Fail) throw error;
    throw fail(EXIT.runtime, "RUNTIME_UNBOUND", "The --cli path is not a bound DSH CLI.");
  }
}

async function dumpConfig(home: string, bin: string, profile: string): Promise<string> {
  const child = spawn(process.execPath, [bin, "--profile", profile, "--dump-config"], {
    env: { ...process.env, DSH_HOME: home },
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let overflow = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    if (overflow) return;
    if (stdout.length + chunk.length > STDOUT_LIMIT) {
      overflow = true;
      stdout = "";
      void stopChild(child);
      return;
    }
    stdout += chunk.toString("utf8");
  });
  child.stderr?.resume();
  const timeoutMs = Number(process.env.DSH_SPACES_DOCTOR_DUMP_MS) || 30_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopChild(child);
  }, timeoutMs);
  try {
    const code = await new Promise<number>((resolveClose, rejectClose) => {
      child.on("error", (error) => rejectClose(error));
      child.on("close", (status) => resolveClose(status ?? 1));
    });
    if (timedOut || overflow) {
      await stopChild(child);
      throw fail(EXIT.verify, "DUMP_FAILED", "dump-config did not finish cleanly.");
    }
    if (code !== 0) throw fail(EXIT.verify, "DUMP_FAILED", "dump-config did not finish cleanly.");
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  try {
    await terminateProcessTree(child);
  } catch {
    /* wait for a confirmed close before releasing the home lock */
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveClose) => {
    child.once("exit", () => resolveClose());
  });
}

function exactChildDir(home: string, name: string): string | null {
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

function containedPath(home: string, parts: string[], kind: "file" | "dir"): string | null {
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

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function same(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function inside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (same(r, t)) return true;
  return t.toLowerCase().startsWith((r.endsWith(sep) ? r : r + sep).toLowerCase());
}

function recoveryUnavailable(command: string): Fail {
  return fail(
    EXIT.recovery,
    "RECOVERY_UNAVAILABLE",
    "Standalone doctor cannot recover or roll back a home in this phase. Open Desktop DSH Spaces, wait until no other process holds the home lock, and use its restore recovery. Do not delete .dsh-spaces-restore or lock residue by hand.",
    { command },
  );
}

function fail(exit: number, code: string, message: string, extra: Json = {}): Fail {
  return new Fail(exit, { ok: false, code, message, ...extra });
}

function print(body: Json, exit: number = EXIT.ok): number {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  return exit;
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(entry));
  } catch {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  }
}

if (invokedAsCli()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
