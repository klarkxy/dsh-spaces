import { lstatSync, realpathSync } from "../../../shared/node/filesystem";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { t } from "../../../shared/i18n";
import {
  DSH_RUNTIME_PACKAGE,
  isExactRuntimeVersion,
  type InstalledRuntime,
  type RuntimeCatalog,
  type RuntimeCatalogEntry,
  type RuntimeInventory,
} from "../../../shared/runtime";
import type { PackageSource } from "../../../shared/types";
import { atomicWrite } from "../atomic";
import { ProcessTerminationError } from "./terminate-process";
import { assertNotRealHome } from "../home/home-guard";
import { currentDiagnosticLogger } from "../diagnostics/operation-log";
import { isAuthorizedProductHome } from "../home/home-guard";
import { runSnapshotWorker } from "../snapshots/snapshot-executor";
import { npmPackumentUrl, npmRegistry, sourceEnv } from "../products/package-source";
import {
  nodeExecutable,
  ensureNode,
  npmCliJs,
  runProcess,
  toolchainEnv,
  toolchainRoot,
} from "./toolchain";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 20_000;
const CATALOG_TIMEOUT_MS = 20_000;
const BIN_REL = join("node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

export type RunProcessFn = (
  command: string,
  args: string[],
  options?: {
    onLine?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shell?: boolean;
  },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type RegistryFetcher = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface RuntimeStoreOptions {
  installWorker?: { file: string; home: string };
  root: string;
  snapshotRoot?: string;
  source: () => PackageSource;
  run?: RunProcessFn;
  fetch?: RegistryFetcher;
}

function parseVersionText(text: string): string | undefined {
  return text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1];
}

function binUnder(prefix: string): string {
  return join(prefix, BIN_REL);
}

function packageJsonNear(bin: string): string | undefined {
  const candidates = [join(dirname(bin), "..", "package.json"), join(dirname(bin), "package.json")];
  return candidates.find((path) => existsSync(path));
}

function readPackageVersion(bin: string): string | undefined {
  const pkgPath = packageJsonNear(bin);
  if (!pkgPath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown; version?: unknown };
    if (parsed.name !== DSH_RUNTIME_PACKAGE) return undefined;
    return typeof parsed.version === "string" && isExactRuntimeVersion(parsed.version)
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}

function npmNear(nodePath: string): string | undefined {
  const dir = dirname(nodePath);
  const candidates = [
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((path) => existsSync(path));
}

function defaultFetch(url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) {
  return fetch(url, { signal: init?.signal, headers: init?.headers });
}

/**
 * Installed DSH CLI versions live under `root/versions/<version>`.
 * This module does not call findDshBin; the bound host CLI is the only
 * non-store runtime a space can run on.
 */
export class RuntimeStore {
  private readonly root: string;
  private readonly snapshotRoot?: string;
  private readonly source: () => PackageSource;
  private readonly run: RunProcessFn;
  private readonly fetchImpl: RegistryFetcher;
  private readonly customRun: boolean;
  private readonly installWorker?: RuntimeStoreOptions["installWorker"];
  private readonly inflight = new Map<string, Promise<InstalledRuntime>>();

  constructor(options: RuntimeStoreOptions) {
    this.root = resolve(options.root);
    this.snapshotRoot = options.snapshotRoot ? resolve(options.snapshotRoot) : undefined;
    assertNotRealHome(this.root);
    this.source = options.source;
    this.customRun = Boolean(options.run);
    this.installWorker = options.installWorker;
    this.run = options.run ?? runProcess;
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  inventory(): RuntimeInventory {
    return { installed: this.listInstalled() };
  }

  async catalog(): Promise<RuntimeCatalog> {
    const log = currentDiagnosticLogger();
    const started = Date.now();
    const url = npmPackumentUrl(this.source(), DSH_RUNTIME_PACKAGE);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "dsh-spaces" },
      });
      if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
      const result = parsePackument(await response.json());
      log?.info("runtime.catalog", "Runtime registry metadata was read.", { status: response.status, versions: result.versions.length, durationMs: Date.now() - started });
      return result;
    } catch (err) {
      log?.error("runtime.catalog-failed", "Runtime registry metadata could not be read.", err, { durationMs: Date.now() - started });
      throw new Error(`failed to fetch ${DSH_RUNTIME_PACKAGE} metadata: ${describeFetchError(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async install(version: string): Promise<InstalledRuntime> {
    const exact = this.requireVersion(version);
    const existing = this.inflight.get(exact);
    if (existing) {
      currentDiagnosticLogger()?.debug("runtime.install-shared", "Runtime installation is already in progress; its result is shared.", { version: exact });
      return existing;
    }
    currentDiagnosticLogger()?.info("runtime.install-started", "Runtime installation requested.", { version: exact, source: this.source(), worker: Boolean(this.installWorker && !this.customRun) });
    const work = this.installWorker && !this.customRun
      ? runSnapshotWorker<InstalledRuntime>(this.installWorker.file, {
        operation: "runtimeInstall", home: this.installWorker.home,
        allowProductHome: isAuthorizedProductHome(this.installWorker.home),
        root: this.snapshotRoot, runtimeRoot: this.root, version: exact,
        packageSource: this.source(), toolchainRoot: toolchainRoot(),
      })
      : this.installOnce(exact);
    const pending = work.then(installed => {
      currentDiagnosticLogger()?.info("runtime.install-completed", "Runtime installation completed.", { version: installed.version });
      return installed;
    }, error => {
      currentDiagnosticLogger()?.error("runtime.install-failed", "Runtime installation failed.", error, { version: exact });
      throw error;
    }).finally(() => {
      if (this.inflight.get(exact) === pending) this.inflight.delete(exact);
    });
    this.inflight.set(exact, pending);
    return pending;
  }

  /** Bin of an installed `versions/<version>` runtime, if present and intact. */
  installedBin(version: string): string | undefined {
    if (!isExactRuntimeVersion(version)) return undefined;
    return this.readInstalled(version)?.bin;
  }

  /** Removes `versions/<version>` after proving it is a real directory inside the store. */
  remove(version: string): void {
    const exact = this.requireVersion(version);
    const dir = join(this.versionsDir(), exact);
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`runtime ${exact} at ${dir} is not a real installed directory`);
    }
    const rootReal = realpathSync(this.root);
    const dirReal = realpathSync(dir);
    const rel = relative(rootReal, dirReal);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`runtime ${exact} resolves outside the runtime store: ${dirReal}`);
    }
    rmSync(dir, { recursive: true });
  }

  private versionsDir(): string {
    return join(this.root, "versions");
  }

  private requireVersion(version: string): string {
    if (!isExactRuntimeVersion(version)) {
      throw new Error(`invalid runtime version: ${version}`);
    }
    return version;
  }

  private listInstalled(): InstalledRuntime[] {
    const dir = this.versionsDir();
    if (!existsSync(dir)) return [];
    const rows: InstalledRuntime[] = [];
    for (const name of readdirSync(dir)) {
      if (!isExactRuntimeVersion(name)) continue;
      const installed = this.readInstalled(name);
      if (installed) rows.push(installed);
    }
    return rows.sort((a, b) => a.version.localeCompare(b.version));
  }

  private readInstalled(version: string): InstalledRuntime | undefined {
    const dir = join(this.versionsDir(), version);
    const bin = binUnder(dir);
    if (!existsSync(bin)) return undefined;
    const actual = readPackageVersion(bin);
    if (actual !== version) return undefined;
    return { version, bin, dir };
  }

  private nodeBin(): string {
    return nodeExecutable() ?? process.execPath;
  }

  private npmJs(): string {
    const found = npmCliJs() ?? npmNear(this.nodeBin());
    if (found) return found;
    if (this.customRun) return join("npm", "bin", "npm-cli.js");
    throw new Error(t("errors.npmMissing"));
  }

  private async probeVersion(bin: string): Promise<string> {
    const log = currentDiagnosticLogger();
    if (!this.customRun && !nodeExecutable()) await ensureNode();
    const initialNode = this.nodeBin();
    const probe = (node: string) => this.run(node, [bin, "--version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
      env: toolchainEnv(),
      shell: false,
    });
    const result = await probe(initialNode);
    const detail = `${result.stdout}\n${result.stderr}`;
    const parsed = parseVersionText(detail);
    log?.write({ level: result.code === 0 && parsed ? "debug" : "error", event: "runtime.version-probe", message: "Runtime version probe exited.", context: { exitCode: result.code, version: parsed ?? null } });
    if (result.code !== 0 || !parsed) {
      throw new Error(t("errors.versionParse", { code: result.code, detail: detail.slice(0, 200) }));
    }
    return parsed;
  }

  private async installOnce(version: string): Promise<InstalledRuntime> {
    const log = currentDiagnosticLogger();
    const present = this.readInstalled(version);
    if (present) {
      log?.debug("runtime.install-present", "The requested runtime is already installed.", { version });
      return present;
    }
    if (!this.customRun) await ensureNode();

    const staging = join(this.root, `.tmp-dsh-${version}-${process.pid}`);
    await rmTree(staging);
    mkdirSync(staging, { recursive: true });

    try {
      const source = this.source();
      atomicWrite(join(staging, ".npmrc"), `registry=${npmRegistry(source)}\n`);
      writeFileSync(
        join(staging, "package.json"),
        `${JSON.stringify({ name: "dsh-spaces-runtime", private: true }, null, 2)}\n`,
        "utf8",
      );
      const spec = `${DSH_RUNTIME_PACKAGE}@${version}`;
      const result = await this.run(
        this.nodeBin(),
        // npm run exports the checkout's legacy-peer-deps setting. That
        // development exception must not strip required peers from a runtime.
        [this.npmJs(), "install", "--prefix", staging, "--no-audit", "--no-fund", "--legacy-peer-deps=false", "--include=peer", spec],
        {
          timeoutMs: INSTALL_TIMEOUT_MS,
          env: toolchainEnv(sourceEnv(source)),
          shell: false,
        },
      );
      log?.write({ level: result.code === 0 ? "info" : "error", event: "runtime.npm-install", message: "Runtime npm installation exited.", context: { version, source, exitCode: result.code, stdout: result.stdout, stderr: result.stderr } });
      const bin = binUnder(staging);
      if (result.code !== 0 || !existsSync(bin)) {
        throw new Error(
          (result.stderr || result.stdout).slice(0, 800) || t("errors.installExited", { code: result.code }),
        );
      }
      const actual = await this.probeVersion(bin);
      if (actual !== version) {
        throw new Error(`installed ${spec} but --version reported ${actual}`);
      }
      if (readPackageVersion(bin) !== version) {
        throw new Error(`installed ${spec} but package.json is not ${version}`);
      }
      log?.debug("runtime.install-verified", "The staged runtime version was verified.", { version });

      mkdirSync(this.versionsDir(), { recursive: true });
      const dest = join(this.versionsDir(), version);
      if (existsSync(dest)) {
        const reused = this.readInstalled(version);
        if (reused) {
          await rmTree(staging);
          return reused;
        }
        await rmTree(dest);
      }
      await rename(staging, dest);
      const installed = this.readInstalled(version);
      if (!installed) throw new Error(`runtime ${version} failed to become readable after install`);
      log?.debug("runtime.install-published", "The verified runtime was published in the local store.", { version });
      atomicWrite(
        join(dest, "meta.json"),
        `${JSON.stringify({ version: installed.version, bin: installed.bin, installedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      return installed;
    } catch (err) {
      if (!(err instanceof ProcessTerminationError)) await rmTree(staging);
      throw err;
    }
  }
}

function rmTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") {
    return `timed out after ${CATALOG_TIMEOUT_MS}ms`;
  }
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 3 && current; i++) {
    if (current instanceof Error) {
      if (current.message && !parts.includes(current.message)) parts.push(current.message);
      current = current.cause;
    } else {
      const text = String(current);
      if (text && !parts.includes(text)) parts.push(text);
      break;
    }
  }
  return parts.join(": ") || "unknown error";
}

function parsePackument(body: unknown): RuntimeCatalog {
  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const time =
    row.time && typeof row.time === "object" ? (row.time as Record<string, unknown>) : {};
  const distTagsRaw =
    row["dist-tags"] && typeof row["dist-tags"] === "object"
      ? (row["dist-tags"] as Record<string, unknown>)
      : {};
  const distTags: Record<string, string> = {};
  for (const [tag, value] of Object.entries(distTagsRaw)) {
    if (typeof value === "string" && value) distTags[tag] = value;
  }
  const versionsRaw =
    row.versions && typeof row.versions === "object" ? (row.versions as Record<string, unknown>) : {};
  const versions: RuntimeCatalogEntry[] = [];
  for (const version of Object.keys(versionsRaw)) {
    if (!isExactRuntimeVersion(version)) continue;
    const publishedAt = typeof time[version] === "string" ? time[version] : undefined;
    versions.push({ version, publishedAt });
  }
  versions.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || b.version.localeCompare(a.version));
  return { versions, distTags };
}
