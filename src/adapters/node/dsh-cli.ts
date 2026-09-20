import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { spawnObserved } from "./owned-process-record";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { t } from "../../shared/i18n";
import { DSH_DEFAULT_CHANNEL, DSH_RUNTIME_PACKAGE } from "../../shared/runtime";
import type { CliEnsureStatus, PackageSource, PluginQueueSnapshot, RuntimeStatus } from "../../shared/types";
import { npmRegistry } from "./package-source";
import { terminateProcessTree } from "./terminate-process";
import {
  currentPackageSource,
  ensureNode,
  ensurePnpm,
  nodeExecutable,
  npmCliJs,
  pnpmCjs,
  runProcess,
  runtimeProbe,
  setPackageSource,
  toolchainEnv,
} from "./toolchain";

export const DSH_CLI_SPEC = `${DSH_RUNTIME_PACKAGE}@${DSH_DEFAULT_CHANNEL}`;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

let cachedBin: string | undefined;
let selectedBin: (() => string | undefined) | undefined;

/** A persisted selection is authoritative; resolver errors must not trigger a fallback install. */
export function setSelectedDshResolver(resolver: () => string | undefined): void {
  selectedBin = resolver;
}
let managedPrefixOverride: string | undefined;
let managedNodeOverride: string | undefined;
let ensuring: Promise<string> | undefined;
let cliStatus: CliEnsureStatus = {
  state: "idle",
  message: "",
};
const cliListeners = new Set<(status: CliEnsureStatus) => void>();

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

export function findDshBin(): string | undefined {
  return selectedBin ? selectedBin() : findLegacyDshBin();
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

function setCliStatus(next: CliEnsureStatus): void {
  cliStatus = next;
  for (const listener of cliListeners) listener(cliStatus);
}

export function cliStatusSnapshot(): CliEnsureStatus {
  if (cliStatus.state === "idle") {
    return { ...cliStatus, message: t("cli.idleMessage") };
  }
  return cliStatus;
}

export function onCliStatus(listener: (status: CliEnsureStatus) => void): () => void {
  cliListeners.add(listener);
  return () => cliListeners.delete(listener);
}

export function dshBin(): string {
  const found = findDshBin();
  if (!found) {
    throw new Error(t("errors.cliNotFound"));
  }
  return found;
}

async function runManagedInstall(
  argsForPnpm: string[],
  argsForNpm: string[],
  onLine: (line: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const node = nodeExecutable();
  if (!node) throw new Error(t("errors.managedNodeMissing"));
  const pnpmJs = pnpmCjs();
  if (pnpmJs) {
    return runProcess(node, [pnpmJs, ...argsForPnpm], { onLine, timeoutMs: INSTALL_TIMEOUT_MS });
  }
  const npmJs = npmCliJs();
  if (npmJs) {
    return runProcess(node, [npmJs, ...argsForNpm], { onLine, timeoutMs: INSTALL_TIMEOUT_MS });
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

  const onLine = (line: string) => {
    setCliStatus({ state: "installing", step: "cli", message: line.slice(0, 200) });
  };

  setCliStatus({
    state: "installing",
    step: "cli",
    message: t("cli.installingCli", { spec: DSH_CLI_SPEC }),
  });
  console.log(`dsh-cli: installing ${DSH_CLI_SPEC} into ${prefix}`);
  try {
    const result = await runManagedInstall(
      ["add", "--dir", prefix, DSH_CLI_SPEC],
      ["install", "--prefix", prefix, "--no-fund", "--no-audit", "--loglevel", "notice", DSH_CLI_SPEC],
      onLine,
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
  setCliStatus({ state: "checking", message: t("cli.lookingCli") });
  const existing = findDshBin();
  if (existing) {
    setCliStatus({ state: "ready", message: existing });
    return existing;
  }
  setCliStatus({
    state: "installing",
    message: t("cli.installingCli", { spec: DSH_CLI_SPEC }),
  });
  try {
    const bin = await installManagedCli();
    cachedBin = bin;
    setCliStatus({ state: "ready", message: bin });
    return bin;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setCliStatus({ state: "error", message });
    throw err;
  }
}

export function ensureDshCli(): Promise<string> {
  const existing = findDshBin();
  if (existing) {
    if (cliStatus.state !== "ready" || cliStatus.message !== existing) {
      setCliStatus({ state: "ready", message: existing });
    }
    return Promise.resolve(existing);
  }
  if (!ensuring) {
    ensuring = doEnsure().finally(() => {
      ensuring = undefined;
    });
  }
  return ensuring;
}

export function getRuntimeStatus(): RuntimeStatus {
  const probe = runtimeProbe();
  return { ...probe, cli: Boolean(findDshBin()) };
}

let ensuringRuntime: Promise<string> | undefined;

export function ensureRuntime(source?: PackageSource): Promise<string> {
  if (!ensuringRuntime) {
    ensuringRuntime = doEnsureRuntime(source).finally(() => {
      ensuringRuntime = undefined;
    });
  }
  return ensuringRuntime;
}

async function doEnsureRuntime(source?: PackageSource): Promise<string> {
  try {
    if (source) setPackageSource(source);
    const existing = findDshBin();
    if (existing && nodeExecutable() && pnpmCjs()) {
      // Older DSH snapshots do not need a newer Node to reopen offline.
      if (readFileSync(existing, "utf8").includes("import.meta.main")) await ensureNode();
      await ensurePnpm();
      setCliStatus({ state: "ready", message: existing });
      return existing;
    }
    setCliStatus({ state: "installing", step: "node", message: t("cli.installingNode") });
    await ensureNode((line) => {
      setCliStatus({ state: "installing", step: "node", message: line.slice(0, 200) });
    });
    setCliStatus({ state: "installing", step: "pnpm", message: t("cli.installingPnpm") });
    await ensurePnpm((line) => {
      setCliStatus({ state: "installing", step: "pnpm", message: line.slice(0, 200) });
    });
    setCliStatus({ state: "installing", step: "cli", message: t("cli.installingCli", { spec: DSH_CLI_SPEC }) });
    const bin = await ensureDshCli();
    setCliStatus({ state: "ready", message: bin });
    return bin;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setCliStatus({ state: "error", message });
    throw err;
  }
}

/** Prefer the managed Node; fall back to Electron-as-Node only inside Electron. */
export function spawnNode(args: string[], options: SpawnOptions = {}): ChildProcess {
  const managed = nodeExecutable() ?? managedNodeOverride;
  const exe = managed ?? process.execPath;
  const env = toolchainEnv({ ...(options.env as Record<string, string | undefined> | undefined) });
  if (!managed && isElectronProcess()) env.ELECTRON_RUN_AS_NODE = "1";
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
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const bin = await ensureDshCli();
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

let pending = 0;
let current: string | undefined;
const queueListeners = new Set<(snap: PluginQueueSnapshot) => void>();

function emitQueue(): void {
  const snap = { pending, current };
  for (const listener of queueListeners) listener(snap);
}

export function onPluginQueue(listener: (snap: PluginQueueSnapshot) => void): () => void {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

export function pluginQueueSnapshot(): PluginQueueSnapshot {
  return { pending, current };
}

let pluginTail: Promise<void> = Promise.resolve();

export function drainPluginQueue(): Promise<void> {
  return pluginTail;
}

export function enqueuePlugin<T>(label: string, work: () => Promise<T>): Promise<T> {
  pending += 1;
  emitQueue();
  const run = pluginTail.then(
    async () => {
      current = label;
      emitQueue();
      try {
        return await work();
      } finally {
        pending -= 1;
        current = undefined;
        emitQueue();
      }
    },
    async () => {
      current = label;
      emitQueue();
      try {
        return await work();
      } finally {
        pending -= 1;
        current = undefined;
        emitQueue();
      }
    },
  );
  pluginTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function dshVersion(dshHome: string): Promise<string> {
  const { stdout, stderr, code } = await runDsh(dshHome, ["--version"], { timeoutMs: 20_000 });
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  if (!match) {
    throw new Error(t("errors.versionParse", { code, detail: text.slice(0, 200) }));
  }
  return match[1];
}

export async function addWebApp(dshHome: string, name: string): Promise<void> {
  await enqueuePlugin(t("queue.pluginAdd", { name }), async () => {
    const version = await dshVersion(dshHome);
    const spec = `@deepseek-ai/dsh-web-app@${version}`;
    const { stdout, stderr, code } = await runDsh(dshHome, ["plugin", "--profile", name, "add", spec]);
    if (code !== 0) {
      throw new Error(
        t("errors.pluginAddFailed", { spec, code, detail: (stderr || stdout).slice(0, 800) }),
      );
    }
  });
}
