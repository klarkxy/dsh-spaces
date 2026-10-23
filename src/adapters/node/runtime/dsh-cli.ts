import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { spawnObserved } from "./owned-process-record";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { t } from "../../../shared/i18n";
import { DSH_DEFAULT_VERSION, DSH_RUNTIME_PACKAGE } from "../../../shared/runtime";
import { npmRegistry } from "../products/package-source";
import { terminateProcessTree } from "./terminate-process";
import {
  currentPackageSource,
  nodeExecutable,
  npmCliJs,
  pnpmCjs,
  runProcess,
  toolchainEnv,
} from "./toolchain";

export const DSH_CLI_SPEC = `${DSH_RUNTIME_PACKAGE}@${DSH_DEFAULT_VERSION}`;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

let cachedBin: string | undefined;
let selectedBin: ((profile?: string) => string | undefined) | undefined;

/** A persisted selection is authoritative; resolver errors must not trigger a fallback install. */
export function setSelectedDshResolver(resolver: (profile?: string) => string | undefined): void {
  selectedBin = resolver;
}
let managedPrefixOverride: string | undefined;
let managedNodeOverride: string | undefined;
let ensuring: Promise<string> | undefined;

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
  return selectedBin ? selectedBin(profile) : findLegacyDshBin();
}

export function findLegacyDshBin(): string | undefined {
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  const candidates = dshBinCandidates({ npmGlobalRoot: probeNpmGlobalRoot() });
  const found = candidates.find((path) => existsSync(path));
  if (found) cachedBin = found;
  return found;
}

export function resetDshBinCache(): void {
  cachedBin = undefined;
  ensuring = undefined;
}

async function runManagedInstall(
  argsForPnpm: string[],
  argsForNpm: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const node = nodeExecutable();
  if (!node) throw new Error(t("errors.managedNodeMissing"));
  const pnpmJs = pnpmCjs();
  if (pnpmJs) {
    return runProcess(node, [pnpmJs, ...argsForPnpm], { timeoutMs: INSTALL_TIMEOUT_MS });
  }
  const npmJs = npmCliJs();
  if (npmJs) {
    return runProcess(node, [npmJs, ...argsForNpm], { timeoutMs: INSTALL_TIMEOUT_MS });
  }
  throw new Error(t("errors.noPackageManager"));
}

async function installManagedCli(): Promise<string> {
  const prefix = managedCliPrefix();
  const bin = binUnder(join(prefix, "node_modules"));
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, ".npmrc"), `registry=${npmRegistry(currentPackageSource())}\n`, "utf8");
  writeFileSync(
    join(prefix, "package.json"),
    `${JSON.stringify(
      {
        name: "dsh-spaces-cli",
        private: true,
        description: "Managed DSH CLI install for DSH Spaces",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`dsh-cli: installing ${DSH_CLI_SPEC} into ${prefix}`);
  try {
    const result = await runManagedInstall(
      ["add", "--dir", prefix, DSH_CLI_SPEC],
      ["install", "--prefix", prefix, "--no-fund", "--no-audit", "--loglevel", "notice", DSH_CLI_SPEC],
    );
    if (existsSync(bin)) return bin;
    throw new Error(
      (result.stderr || result.stdout).slice(0, 800) || t("errors.installExited", { code: result.code }),
    );
  } catch (err) {
    if (existsSync(bin)) return bin;
    throw err;
  }
}

async function doEnsure(): Promise<string> {
  const existing = findDshBin();
  if (existing) return existing;
  const bin = await installManagedCli();
  cachedBin = bin;
  return bin;
}

export function ensureDshCli(profile?: string): Promise<string> {
  const existing = findDshBin(profile);
  if (existing) return Promise.resolve(existing);
  if (!ensuring) {
    ensuring = doEnsure().finally(() => {
      ensuring = undefined;
    });
  }
  return ensuring;
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

export function enqueuePlugin<T>(_label: string, work: () => Promise<T>): Promise<T> {
  const run = pluginTail.then(work, work);
  pluginTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
