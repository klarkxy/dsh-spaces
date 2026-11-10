import { existsSync } from "node:fs";
import { execSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { spawnObserved } from "./owned-process-record";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { terminateProcessTree } from "./terminate-process";
import {
  nodeExecutable,
  toolchainEnv,
} from "./toolchain";

let cachedBin: string | undefined;
let selectedBin: ((profile?: string) => string | undefined) | undefined;

/** A persisted selection is authoritative; resolver errors must not trigger a fallback install. Pass undefined to restore discovery. */
export function setSelectedDshResolver(resolver: ((profile?: string) => string | undefined) | undefined): void {
  selectedBin = resolver;
}
let managedPrefixOverride: string | undefined;
let managedNodeOverride: string | undefined;

function binUnder(nodeModulesRoot: string): string {
  return join(nodeModulesRoot, "@deepseek-ai", "dsh", "lib", "bin.js");
}

export function setManagedCliPrefix(prefix: string): void {
  managedPrefixOverride = resolve(prefix);
}

/** Supervisor `--node` / a known Node binary. Not an Electron-as-Node fallback. */
export function setManagedNodeExecutable(exe?: string): void {
  managedNodeOverride = exe ? resolve(exe) : undefined;
}

function isElectronProcess(): boolean {
  return typeof process.versions.electron === "string" && process.versions.electron.length > 0;
}

export function managedCliPrefix(): string {
  if (process.env.DSH_SPACES_CLI) return resolve(process.env.DSH_SPACES_CLI);
  if (managedPrefixOverride) return managedPrefixOverride;
  if (process.env.APPDATA) return join(process.env.APPDATA, "dsh-spaces", "dsh-cli");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "dsh-spaces", "dsh-cli");
  }
  return join(homedir(), ".config", "dsh-spaces", "dsh-cli");
}

export function dshBinCandidates(options: {
  managedPrefix?: string;
  appData?: string;
  npmGlobalRoot?: string;
} = {}): string[] {
  const prefix = options.managedPrefix ?? managedCliPrefix();
  const appData = options.appData ?? process.env.APPDATA;
  const candidates: string[] = [binUnder(join(prefix, "node_modules"))];
  if (appData) {
    candidates.push(binUnder(join(appData, "npm", "node_modules")));
  }
  if (options.npmGlobalRoot) {
    candidates.push(binUnder(options.npmGlobalRoot));
  }
  return candidates;
}

function probeNpmGlobalRoot(): string | undefined {
  try {
    const root = execSync("npm root -g", {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

export function findDshBin(profile?: string): string | undefined {
  return selectedBin ? selectedBin(profile) : discoverDshBin();
}

export function discoverDshBin(): string | undefined {
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  const candidates = dshBinCandidates({ npmGlobalRoot: probeNpmGlobalRoot() });
  const found = candidates.find((path) => existsSync(path));
  if (found) cachedBin = found;
  return found;
}

export function resetDshBinCache(): void {
  cachedBin = undefined;
}

export class DshCliNotFoundError extends Error {
  readonly name = "DshCliNotFoundError";
  constructor(profile?: string) {
    super(
      profile
        ? `No bound DSH CLI resolved for profile "${profile}". Bind one with --bin or pin a runtime; nothing was installed.`
        : "No bound or discovered DSH CLI. Nothing was installed.",
    );
  }
}

/**
 * Resolve the CLI binary for a profile. A missing or undiscoverable binary is a
 * hard failure: Spaces never downloads or installs a DSH runtime on demand.
 */
export function ensureDshCli(profile?: string): Promise<string> {
  const existing = findDshBin(profile);
  if (!existing) return Promise.reject(new DshCliNotFoundError(profile));
  return Promise.resolve(existing);
}

/** An explicitly bound Host runtime wins, including Electron's ASAR-capable Node. */
export function spawnNode(args: string[], options: SpawnOptions = {}): ChildProcess {
  const managed = managedNodeOverride ?? nodeExecutable();
  const exe = managed ?? process.execPath;
  const env = toolchainEnv({ ...(options.env as Record<string, string | undefined> | undefined) });
  if (exe === process.execPath && isElectronProcess()) env.ELECTRON_RUN_AS_NODE = "1";
  else delete env.ELECTRON_RUN_AS_NODE;
  return spawnObserved(exe, args, {
    ...options,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env,
  });
}

export async function runDsh(
  dshHome: string,
  args: string[],
  options: { timeoutMs?: number; profile?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const bin = await ensureDshCli(options.profile);
  return new Promise((resolvePromise, reject) => {
    const child = spawnNode([bin, ...args], {
      env: {
        DSH_HOME: dshHome,
        npm_config_ignore_workspace_root_check: "true",
      },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).then(
        () => reject(new Error(`DSH command timed out after ${timeoutMs}ms`)), reject,
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      const exitCode = code ?? 1;
      const detail = exitCode !== 0 && stdout.trim()
        ? [stderr, stdout].filter((part) => part.trim()).join("\n")
        : stderr;
      resolvePromise({ stdout, stderr: detail, code: exitCode });
    });
  });
}

let pluginTail: Promise<void> = Promise.resolve();

export function enqueuePlugin<T>(work: () => Promise<T>): Promise<T> {
  const run = pluginTail.then(work, work);
  pluginTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
