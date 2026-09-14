import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm as rmAsync } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { type ChildProcess } from "node:child_process";
import { spawnObserved } from "./owned-process-record";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { t } from "../shared/i18n";
import type { PackageSource, RuntimeStatus } from "../shared/types";
import { inferPackageSource } from "../shared/types";
import { atomicWrite, renameDirectoryAsync } from "./atomic";
import { ProcessTerminationError, terminateProcessTree } from "./terminate-process";
import {
  NODE_VERSION,
  PNPM_VERSION,
  nodeArchiveName,
  nodeDownloadUrl,
  npmRegistry,
  sourceEnv,
} from "./package-source";

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface ToolchainConfig {
  packageSource: PackageSource;
  nodeVersion?: string;
  pnpmVersion?: string;
}

let rootOverride: string | undefined;
let sourceOverride: PackageSource | undefined;

export function setToolchainRoot(root: string): void {
  rootOverride = resolve(root);
}

export function toolchainRoot(): string {
  if (process.env.DSH_SPACES_TOOLCHAIN) return resolve(process.env.DSH_SPACES_TOOLCHAIN);
  if (rootOverride) return rootOverride;
  if (process.env.APPDATA) return join(process.env.APPDATA, "dsh-spaces", "toolchain");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "dsh-spaces", "toolchain");
  }
  return join(homedir(), ".config", "dsh-spaces", "toolchain");
}

function configPath(): string {
  return join(toolchainRoot(), "config.json");
}

export function readToolchainConfig(): ToolchainConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { packageSource: sourceOverride ?? inferPackageSource() };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ToolchainConfig>;
    const packageSource: PackageSource =
      parsed.packageSource === "china" || parsed.packageSource === "official"
        ? parsed.packageSource
        : (sourceOverride ?? inferPackageSource());
    return {
      packageSource,
      nodeVersion: parsed.nodeVersion,
      pnpmVersion: parsed.pnpmVersion,
    };
  } catch {
    return { packageSource: sourceOverride ?? inferPackageSource() };
  }
}

export function writeToolchainConfig(patch: Partial<ToolchainConfig>): ToolchainConfig {
  const current = readToolchainConfig();
  const next: ToolchainConfig = {
    packageSource: patch.packageSource ?? current.packageSource,
    nodeVersion: patch.nodeVersion ?? current.nodeVersion,
    pnpmVersion: patch.pnpmVersion ?? current.pnpmVersion,
  };
  atomicWrite(configPath(), `${JSON.stringify(next, null, 2)}\n`);
  sourceOverride = next.packageSource;
  return next;
}

export function setPackageSource(source: PackageSource): void {
  sourceOverride = source;
  writeToolchainConfig({ packageSource: source });
  writeNpmrc(source);
}

export function currentPackageSource(): PackageSource {
  return sourceOverride ?? readToolchainConfig().packageSource;
}

function writeNpmrc(source: PackageSource): void {
  const root = toolchainRoot();
  mkdirSync(root, { recursive: true });
  atomicWrite(join(root, ".npmrc"), `registry=${npmRegistry(source)}\n`);
}

export function findNodeDir(root = toolchainRoot()): string | undefined {
  const preferred = join(root, "node", nodeArchiveName().replace(/\.(zip|tar\.gz)$/, ""));
  if (existsSync(join(preferred, "node.exe")) || existsSync(join(preferred, "bin", "node"))) return preferred;
  const directWin = join(root, "node", "node.exe");
  const directUnix = join(root, "node", "bin", "node");
  if (existsSync(directWin)) return join(root, "node");
  if (existsSync(directUnix)) return join(root, "node");
  const nested = join(root, "node");
  if (!existsSync(nested)) return undefined;
  for (const name of readdirSync(nested)) {
    const dir = join(nested, name);
    if (existsSync(join(dir, "node.exe")) || existsSync(join(dir, "bin", "node"))) return dir;
  }
  return undefined;
}

export function nodeExecutable(): string | undefined {
  const dir = findNodeDir();
  if (!dir) return undefined;
  const win = join(dir, "node.exe");
  const unix = join(dir, "bin", "node");
  if (existsSync(win)) return win;
  if (existsSync(unix)) return unix;
  return undefined;
}

export function npmCliJs(): string | undefined {
  const dir = findNodeDir();
  if (!dir) return undefined;
  const candidates = [
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((path) => existsSync(path));
}

export function pnpmCjs(): string | undefined {
  const path = join(toolchainRoot(), "pnpm", "node_modules", "pnpm", "bin", "pnpm.cjs");
  return existsSync(path) ? path : undefined;
}

export function shimDir(): string {
  return join(toolchainRoot(), "bin");
}

export function toolchainEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const source = currentPackageSource();
  const nodeDir = findNodeDir();
  const pathParts = [shimDir(), nodeDir, nodeDir ? join(nodeDir, "bin") : undefined, extra.PATH ?? extra.Path ?? process.env.PATH]
    .filter((part): part is string => Boolean(part));
  const path = pathParts.join(process.platform === "win32" ? ";" : ":");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...sourceEnv(source),
    ...extra,
    PATH: path,
    npm_config_ignore_workspace_root_check: extra.npm_config_ignore_workspace_root_check ?? "true",
  };
  if (process.platform === "win32") env.Path = path;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function lastUsefulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    onLine?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shell?: boolean;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;
  return new Promise((resolveRun, reject) => {
    const child: ChildProcess = spawnObserved(command, args, {
      windowsHide: true,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: options.env ?? toolchainEnv(),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).then(
        () => reject(new Error(`${command} timed out after ${timeoutMs}ms`)), reject,
      );
    }, timeoutMs);
    const take = (chunk: Buffer, which: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      if (which === "stdout") stdout += text;
      else stderr += text;
      const line = lastUsefulLine(text.replace(/\r/g, "\n"));
      if (line) options.onLine?.(line);
    };
    child.stdout?.on("data", (chunk: Buffer) => take(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => take(chunk, "stderr"));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      resolveRun({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function downloadFile(url: string, dest: string, onLine?: (line: string) => void): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const result = await runProcess(
    "curl",
    ["-L", "--fail", "--retry", "3", "--retry-delay", "2", "-o", dest, url],
    { onLine, timeoutMs: DOWNLOAD_TIMEOUT_MS, env: process.env },
  );
  if (result.code !== 0) {
    throw new Error(
      t("errors.downloadFailed", {
        code: result.code,
        detail: (result.stderr || result.stdout).slice(0, 400),
        url,
      }),
    );
  }
  if (!existsSync(dest)) throw new Error(t("errors.downloadEmpty", { url }));
}

async function extractArchiveAsync(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const result = await runProcess("tar", ["-xf", archive, "-C", dest], {
    timeoutMs: 120_000,
    env: process.env,
  });
  if (result.code !== 0) {
    throw new Error(
      t("errors.extractFailed", {
        code: result.code,
        detail: (result.stderr || result.stdout).slice(0, 400),
      }),
    );
  }
}

function writePnpmShim(nodePath: string, pnpmJs: string): void {
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "pnpm.cmd"),
      `@echo off\r\n"${nodePath}" "${pnpmJs}" %*\r\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "pnpm.ps1"),
      `& "${nodePath}" "${pnpmJs}" @args\r\n`,
      "utf8",
    );
    return;
  }
  const shim = join(dir, "pnpm");
  writeFileSync(shim, `#!/bin/sh\nexec "${nodePath}" "${pnpmJs}" "$@"\n`, { encoding: "utf8", mode: 0o755 });
}

export async function ensureNode(onLine?: (line: string) => void): Promise<string> {
  const existing = nodeExecutable();
  if (existing && await supportsCliEntry(existing)) return existing;
  const source = currentPackageSource();
  const root = toolchainRoot();
  const archive = nodeArchiveName();
  const url = nodeDownloadUrl(source);
  const zip = join(tmpdir(), archive);
  onLine?.(t("cli.downloadingNode", { version: NODE_VERSION }));
  if (!existsSync(zip)) {
    await downloadFile(url, zip, onLine);
  }
  const dest = join(root, "node");
  mkdirSync(dest, { recursive: true });
  const staging = join(dest, `.install-${randomUUID()}`);
  const distribution = archive.replace(/\.(zip|tar\.gz)$/, "");
  const published = join(dest, distribution);
  const previous = join(dest, `.previous-${randomUUID()}`);
  onLine?.(t("cli.extractingNode"));
  try {
    await extractArchiveAsync(zip, staging);
    const extracted = join(staging, distribution);
    const executable = process.platform === "win32" ? "node.exe" : join("bin", "node");
    if (!await supportsCliEntry(join(extracted, executable))) {
      throw new Error(t("errors.nodeExtractFailed", { dest: staging }));
    }
    // Retain older distributions: a running space may still own their executable.
    if (existsSync(published)) await renameDirectoryAsync(published, previous);
    try { await renameDirectoryAsync(extracted, published); }
    catch (error) {
      if (existsSync(previous)) await renameDirectoryAsync(previous, published);
      throw error;
    }
  } finally { await rmAsync(staging, { recursive: true, force: true }); }
  const node = nodeExecutable()!;
  writeToolchainConfig({ nodeVersion: NODE_VERSION, packageSource: source });
  writeNpmrc(source);
  return node;
}

/** New DSH entry points use import.meta.main; old managed Node 22.16 silently exits. */
async function supportsCliEntry(node: string): Promise<boolean> {
  if (!existsSync(node)) return false;
  try {
    const result = await runProcess(node, ["--input-type=module", "-e", "process.stdout.write(typeof import.meta.main)"], { timeoutMs: 10_000 });
    return result.code === 0 && result.stdout.trim() === "boolean";
  } catch (error) {
    if (error instanceof ProcessTerminationError) throw error;
    return false;
  }
}

export async function ensurePnpm(onLine?: (line: string) => void): Promise<string> {
  const existing = pnpmCjs();
  const node = nodeExecutable();
  if (!node) throw new Error(t("errors.nodeMissing"));
  if (existing) {
    writePnpmShim(node, existing);
    return existing;
  }
  const npmJs = npmCliJs();
  if (!npmJs) throw new Error(t("errors.npmMissing"));
  const prefix = join(toolchainRoot(), "pnpm");
  mkdirSync(prefix, { recursive: true });
  onLine?.(t("cli.installingPnpmVersion", { version: PNPM_VERSION }));
  const result = await runProcess(
    node,
    [npmJs, "install", "--prefix", prefix, "--no-fund", "--no-audit", `pnpm@${PNPM_VERSION}`],
    { onLine, env: toolchainEnv() },
  );
  const pnpmJs = pnpmCjs();
  if (!pnpmJs) {
    throw new Error(
      t("errors.pnpmInstallFailed", {
        code: result.code,
        detail: (result.stderr || result.stdout).slice(0, 800),
      }),
    );
  }
  writePnpmShim(node, pnpmJs);
  writeToolchainConfig({ pnpmVersion: PNPM_VERSION });
  return pnpmJs;
}

export function runtimeProbe(): RuntimeStatus {
  return {
    node: Boolean(nodeExecutable()),
    pnpm: Boolean(pnpmCjs()),
    cli: false,
    packageSource: currentPackageSource(),
  };
}
