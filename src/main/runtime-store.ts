import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { t } from "../shared/i18n";
import {
  DSH_RUNTIME_PACKAGE,
  isExactRuntimeVersion,
  type InstalledRuntime,
  type RuntimeCatalog,
  type RuntimeCatalogEntry,
  type RuntimeCurrent,
  type RuntimeInventory,
  type RuntimeOrigin,
  type RuntimeRef,
} from "../shared/runtime";
import type { PackageSource } from "../shared/types";
import { atomicWrite } from "./atomic";
import { ProcessTerminationError } from "./terminate-process";
import { assertNotRealHome } from "./home-guard";
import { isAuthorizedProductHome } from "./home-guard";
import { runSnapshotWorker } from "./snapshot-executor";
import { npmPackumentUrl, npmRegistry, sourceEnv } from "./package-source";
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
const CATALOG_ATTEMPTS = 3;
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
  legacy: () => RuntimeRef | undefined;
  run?: RunProcessFn;
  fetch?: RegistryFetcher;
}

interface CurrentPointer {
  version: string;
  bin: string;
  origin: RuntimeOrigin;
}

function parseVersionText(text: string): string | undefined {
  return text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)?.[1];
}

function isInside(root: string, file: string): boolean {
  const rel = relative(resolve(root), resolve(file));
  if (!rel || isAbsolute(rel)) return false;
  return !rel.split(/[/\\]/).includes("..");
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
 * `select` commits the current pointer after coordinated upgrade checks.
 * This module does not call findDshBin; a stored pointer is never replaced
 * by a cached system/managed lookup.
 */
export class RuntimeStore {
  private readonly root: string;
  private readonly snapshotRoot?: string;
  private readonly source: () => PackageSource;
  private readonly legacy: () => RuntimeRef | undefined;
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
    this.legacy = options.legacy;
    this.customRun = Boolean(options.run);
    this.installWorker = options.installWorker;
    this.run = options.run ?? runProcess;
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  inventory(): RuntimeInventory {
    return { installed: this.listInstalled(), current: this.current() };
  }

  current(): RuntimeCurrent | undefined {
    const pointer = this.readPointer();
    if (pointer) return this.resolvePointer(pointer);
    const legacy = this.legacy();
    if (!legacy) return undefined;
    if (!existsSync(legacy.bin) || !isExactRuntimeVersion(legacy.version)) return undefined;
    const actual = readPackageVersion(legacy.bin);
    if (actual !== legacy.version) return undefined;
    return {
      bin: resolve(legacy.bin),
      version: actual,
      origin: this.originOf(legacy.bin),
    };
  }

  /** Pointer version/bin without resolving files. Damaged JSON is treated as unknown. */
  recordedRef(): RuntimeRef | undefined {
    try {
      const pointer = this.readPointer();
      return pointer ? { bin: pointer.bin, version: pointer.version } : undefined;
    } catch {
      return undefined;
    }
  }

  async catalog(): Promise<RuntimeCatalog> {
    const url = npmPackumentUrl(this.source(), DSH_RUNTIME_PACKAGE);
    let lastMessage = "unknown error";
    for (let attempt = 0; attempt < CATALOG_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { accept: "application/json", "user-agent": "dsh-spaces" },
        });
        if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
        return parsePackument(await response.json());
      } catch (err) {
        lastMessage = describeFetchError(err);
        const retryable =
          !(err instanceof Error && err.name === "AbortError") &&
          !/^npm registry HTTP 4\d\d$/.test(lastMessage);
        if (!retryable || attempt === CATALOG_ATTEMPTS - 1) break;
        await sleep(200 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`failed to fetch ${DSH_RUNTIME_PACKAGE} metadata: ${lastMessage}`);
  }

  async install(version: string): Promise<InstalledRuntime> {
    const exact = this.requireVersion(version);
    const existing = this.inflight.get(exact);
    if (existing) return existing;
    const work = this.installWorker && !this.customRun
      ? runSnapshotWorker<InstalledRuntime>(this.installWorker.file, {
        operation: "runtimeInstall", home: this.installWorker.home,
        allowProductHome: isAuthorizedProductHome(this.installWorker.home),
        root: this.snapshotRoot, runtimeRoot: this.root, version: exact,
        packageSource: this.source(), legacy: this.legacy(), toolchainRoot: toolchainRoot(),
      })
      : this.installOnce(exact);
    const pending = work.finally(() => {
      if (this.inflight.get(exact) === pending) this.inflight.delete(exact);
    });
    this.inflight.set(exact, pending);
    return pending;
  }

  select(version: string): RuntimeCurrent {
    const installed = this.requireInstalled(this.requireVersion(version));
    return this.commit({
      version: installed.version,
      bin: installed.bin,
      origin: "store",
    });
  }

  async selectExisting(ref: RuntimeRef): Promise<RuntimeCurrent> {
    const version = this.requireVersion(ref.version);
    const bin = resolve(ref.bin);
    if (!existsSync(bin)) throw new Error(`runtime binary not found: ${bin}`);
    const actual = await this.probeVersion(bin);
    if (actual !== version) {
      throw new Error(`runtime at ${bin} reports ${actual}, expected ${version}`);
    }
    const fromFile = readPackageVersion(bin);
    if (fromFile !== actual) {
      throw new Error(`runtime metadata is unreadable: ${bin}`);
    }
    const origin = this.originOf(bin);
    return this.commit({ version: fromFile, bin, origin });
  }

  private versionsDir(): string {
    return join(this.root, "versions");
  }

  private pointerPath(): string {
    return join(this.root, "current.json");
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

  private requireInstalled(version: string): InstalledRuntime {
    const installed = this.readInstalled(version);
    if (!installed) throw new Error(`runtime ${version} is not installed`);
    return installed;
  }

  private readPointer(): CurrentPointer | undefined {
    const path = this.pointerPath();
    if (!existsSync(path)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("runtime current pointer is unreadable");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("runtime current pointer is damaged");
    const row = parsed as Record<string, unknown>;
    if (typeof row.bin !== "string" || !row.bin) throw new Error("runtime current pointer is damaged");
    if (typeof row.version !== "string" || !isExactRuntimeVersion(row.version)) {
      throw new Error("runtime current pointer is damaged");
    }
    const actualOrigin = this.originOf(row.bin);
    const origin: RuntimeOrigin = actualOrigin === "snapshot" ? actualOrigin :
      row.origin === "store" || row.origin === "managed" || row.origin === "system"
        ? row.origin
        : actualOrigin;
    return { version: row.version, bin: resolve(row.bin), origin };
  }

  private resolvePointer(pointer: CurrentPointer): RuntimeCurrent {
    if (!existsSync(pointer.bin)) {
      throw new Error(`selected runtime is missing: ${pointer.bin}`);
    }
    const actual = readPackageVersion(pointer.bin);
    if (!actual) {
      throw new Error(`selected runtime metadata is unreadable: ${pointer.bin}`);
    }
    if (actual !== pointer.version) {
      throw new Error(`selected runtime reports ${actual}, expected ${pointer.version}`);
    }
    return { bin: pointer.bin, version: actual, origin: pointer.origin };
  }

  private originOf(bin: string): RuntimeOrigin {
    if (isInside(this.versionsDir(), bin)) return "store";
    if (this.snapshotRoot && isInside(this.snapshotRoot, bin)) return "snapshot";
    const normalized = resolve(bin).split(/[/\\]/).join(sep).toLowerCase();
    if (normalized.includes(`${sep}dsh-spaces${sep}dsh-cli${sep}`)) return "managed";
    return "system";
  }

  private commit(pointer: CurrentPointer): RuntimeCurrent {
    mkdirSync(this.root, { recursive: true });
    atomicWrite(this.pointerPath(), `${JSON.stringify(pointer, null, 2)}\n`);
    return { bin: pointer.bin, version: pointer.version, origin: pointer.origin };
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
    if (!this.customRun && !nodeExecutable()) await ensureNode();
    const initialNode = this.nodeBin();
    const probe = (node: string) => this.run(node, [bin, "--version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
      env: toolchainEnv(),
      shell: false,
    });
    let result = await probe(initialNode);
    // Node 22.16 silently skips import.meta.main. Upgrade only when the CLI
    // cannot report a version; working older snapshots remain offline-capable.
    if (!this.customRun && result.code === 0 && !result.stdout.trim() && !result.stderr.trim()) {
      await ensureNode();
      if (this.nodeBin() !== initialNode) result = await probe(this.nodeBin());
    }
    const detail = `${result.stdout}\n${result.stderr}`;
    const parsed = parseVersionText(detail);
    if (result.code !== 0 || !parsed) {
      throw new Error(t("errors.versionParse", { code: result.code, detail: detail.slice(0, 200) }));
    }
    return parsed;
  }

  private async installOnce(version: string): Promise<InstalledRuntime> {
    const present = this.readInstalled(version);
    if (present) return present;
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
        [this.npmJs(), "install", "--prefix", staging, "--no-audit", "--no-fund", spec],
        {
          timeoutMs: INSTALL_TIMEOUT_MS,
          env: toolchainEnv(sourceEnv(source)),
          shell: false,
        },
      );
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
      await renameTree(staging, dest);
      const installed = this.readInstalled(version);
      if (!installed) throw new Error(`runtime ${version} failed to become readable after install`);
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

/** Same-volume directory publish. Retry scanner locks without blocking the HTTP loop. */
async function renameTree(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
