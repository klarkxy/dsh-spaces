import { lstatSync, realpathSync } from "../../../../shared/node/filesystem";
import { type ChildProcess } from "node:child_process";
import { spawnObserved } from "../../runtime/owned-process-record";
import { terminateProcessTree } from "../../runtime/terminate-process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isExactRuntimeVersion } from "../../../../shared/runtime";

/** Fixture exact version for tests. Not a product allowlist. */
export const COMPATIBLE_DSH_CLI_VERSION = "0.1.5-rc.1";

/** Any exact npm version can bind. Tags, ranges, and junk stay out. */
export function isCompatibleDshCliVersion(version: string): boolean {
  return isExactRuntimeVersion(version);
}

export const DSH_CLI_PACKAGE = "@deepseek-ai/dsh";

export const CLI_OUTPUT_CAP = 256 * 1024;
export const DEFAULT_CLI_TIMEOUT_MS = 60_000;

export class CliInterruptedError extends Error {
  readonly name = "CliInterruptedError";
}

export interface BoundCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BoundCliRunner = (args: readonly string[]) => Promise<BoundCliResult>;

export interface BoundRuntime {
  bin: string;
  version: string;
}

export function invocationProfile(argv: readonly string[]): string | null {
  const desktop = desktopHostRuntime(argv[1] ?? "");
  if (desktop) {
    try {
      if (argv.length < 4 || realpathSync(argv[2]) !== desktop.root ||
          !/[/\\]profiles[/\\]desktop$/.test(resolve(argv[3]))) return null;
      return "desktop";
    } catch { return null; }
  }
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--profile") {
      const name = args[i + 1];
      if (!name || name.startsWith("-")) return null;
      return name;
    }
  }
  if (args[0] === "web") return "web";
  return null;
}

export function bindDshCli(argv1: string): BoundRuntime | null {
  const desktop = desktopHostRuntime(argv1);
  if (desktop) {
    const cli = bindDshCli(join(desktop.root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    return cli?.version === desktop.version ? cli : null;
  }
  try {
    const bin = resolve(argv1);
    const realBin = realpathSync(bin);
    if (!lstatSync(realBin).isFile()) return null;
    const manifestPath = join(dirname(bin), "..", "package.json");
    const manifestStat = lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) return null;
    const realManifest = realpathSync(manifestPath);
    const pkg = JSON.parse(readFileSync(realManifest, "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== DSH_CLI_PACKAGE) return null;
    if (typeof pkg.version !== "string" || !isExactRuntimeVersion(pkg.version)) return null;
    return { bin: realBin, version: pkg.version };
  } catch {
    return null;
  }
}


/** Official Desktop's own argv entry and bundled runtime, never a renderer brand flag. */
function desktopHostRuntime(entry: string): { root: string; version: string } | null {
  try {
    const bin = realpathSync(resolve(entry));
    if (!bin.endsWith(join("dsh-desktop-host", "lib", "index.js")) || !lstatSync(bin).isFile()) return null;
    const manifest = join(dirname(bin), "..", "package.json");
    if (lstatSync(manifest).isSymbolicLink()) return null;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.name !== "@deepseek-ai/dsh-desktop-host" || !isExactRuntimeVersion(pkg.version)) return null;
    const root = realpathSync(resolve(dirname(bin), "../../../.."));
    return { root, version: pkg.version };
  } catch { return null; }
}

export function spawnBoundCli(
  execPath: string,
  bin: string,
  home: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  timeoutMs = DEFAULT_CLI_TIMEOUT_MS,
): Promise<BoundCliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawnObserved(execPath, [bin, ...args], {
      env: { ...env, DSH_HOME: home },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void finishInterrupted(child);
    }, timeoutMs);
    const take = (current: string, chunk: Buffer): string => {
      if (current.length >= CLI_OUTPUT_CAP) return current;
      const text = chunk.toString("utf8");
      const room = CLI_OUTPUT_CAP - current.length;
      return current + (text.length > room ? text.slice(0, room) : text);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = take(stderr, chunk);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CliInterruptedError());
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) reject(new CliInterruptedError());
      else resolveRun({ stdout, stderr, code: code ?? 1 });
    });

    async function finishInterrupted(owned: ChildProcess): Promise<void> {
      try {
        await terminateProcessTree(owned);
      } catch {
        try {
          owned.kill();
        } catch {
          /* still wait for close */
        }
      }
      if (owned.exitCode !== null || owned.signalCode !== null) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new CliInterruptedError());
        }
        return;
      }
      owned.once("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new CliInterruptedError());
      });
    }
  });
}
