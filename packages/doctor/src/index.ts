import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { HomeLockBusyError, HomeOperationLock } from "../../../src/adapters/node/home-operation-lock.ts";
import { assertDumpPatched } from "../../../src/core/domain/isolation.ts";
import { terminateProcessTree } from "../../../src/main/terminate-process.ts";
import { authorizeProductHome } from "../../../src/main/home-guard.ts";
import { PROFILE_NAME_RE } from "../../../src/shared/types.ts";
import {
  EXIT,
  Fail,
  STDOUT_LIMIT,
  containedPath,
  exactChildDir,
  fail,
  lexists,
  print,
} from "./common.ts";
import { inspectHome, recoveryBlocksVerify } from "./inspect.ts";
import { runRecover, runRollback, runUnlock } from "./recover.ts";
import { bindCli, resolveResources } from "./resources.ts";

export async function main(argv: string[]): Promise<number> {
  try {
    const { command, flags } = parseArgv(argv);
    if (!command) throw fail(EXIT.usage, "USAGE", "Commands: doctor, verify, unlock, recover, rollback.");
    const homeFlag = requireFlag(flags, "home", "Explicit --home is required; this CLI never uses ~/.dsh.");
    if (flags.allowRealHome === "1") authorizeProductHome(realpathSync(resolve(homeFlag)));
    const lock = new HomeOperationLock(homeFlag);
    if (command === "doctor") {
      const resources = resolveResources(lock.home, flags);
      return print({
        ok: true,
        command,
        ...inspectHome(lock, resources.cli, resources.toolchain, resources.cliError),
      });
    }
    if (command === "unlock") return runUnlock(lock);
    if (command === "verify") return await runVerify(lock, flags);
    if (command === "recover") return await runRecover(lock, flags);
    if (command === "rollback") return await runRollback(lock, flags);
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
    if (token === "--dry-run") {
      flags.dryRun = "1";
      continue;
    }
    if (token === "--allow-real-home") {
      flags.allowRealHome = "1";
      continue;
    }
    if (
      token === "--home" ||
      token === "--cli" ||
      token === "--profile" ||
      token === "--snapshot" ||
      token === "--snapshot-root" ||
      token === "--runtime-root"
    ) {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw fail(EXIT.usage, "USAGE", `Missing value for ${token}.`);
      const key =
        token === "--snapshot-root" ? "snapshotRoot" : token === "--runtime-root" ? "runtimeRoot" : token.slice(2);
      flags[key] = value;
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

async function runVerify(lock: HomeOperationLock, flags: Record<string, string>): Promise<number> {
  const profile = requireFlag(flags, "profile", "verify requires --profile.");
  const cli = bindCli(requireFlag(flags, "cli", "verify requires an absolute --cli path."), true);
  if (!cli.allowedVerify) throw fail(EXIT.runtime, "RUNTIME_REFUSED", "Only DSH CLI 0.1.5-rc.1 and 0.1.5-rc.2 can verify.");
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
