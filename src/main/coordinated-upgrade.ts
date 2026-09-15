import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { withoutChildObservation, type ChildObservation } from "./owned-process-record";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginQueueSnapshot, spawnNode } from "./dsh-cli";
import { assertNotRealHome, isAuthorizedProductHome, samePath } from "./home-guard";
import { runSnapshotWorker, type SnapshotWorkerOperation } from "./snapshot-executor";
import { assertDumpPatched } from "./patch-writer";
import { listProfilePlugins } from "./plugin-ops";
import { clearRuntimeFallback, copyLinkedTree, retargetTree } from "./snapshot-store";
import { ProcessTerminationError, terminateProcessTree } from "./terminate-process";
import { dshSessionCookie, dshSessionList, waitForDshEndpoint } from "./dsh-endpoint";
import { toolchainEnv } from "./toolchain";
import { renameDirectory as renameSync } from "./atomic";
import { sanitizeLogText } from "./diagnostics";
import { PROTECTED_PLUGIN_PACKAGES } from "../shared/types";
import { isExactRuntimeVersion } from "../shared/runtime";
import type { PendingRestore, RestoreResult, RestoreRecoveryReceipt, SnapshotMeta, SnapshotRuntime } from "../shared/snapshots";
import type { SnapshotRestoreOptions } from "./snapshot-store";
import type {
  OfficialPluginChange,
  UpgradePhase,
  UpgradePreview,
  UpgradeProgress,
  UpgradeProfilePreview,
  UpgradeResult,
} from "../shared/upgrade";

const OFFICIAL = new Set<string>(PROTECTED_PLUGIN_PACKAGES);
const BASE_PKG = "@deepseek-ai/dsh-base";
const WEB_PKG = "@deepseek-ai/dsh-web-app";
const STAGE_DIR = ".dsh-spaces-upgrade";
const JOURNAL = "journal.json";
const BACKUP_PROFILES = "backup-profiles";
const PLUGIN_TIMEOUT_MS = 180_000;
const DUMP_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 10 * 60_000;
const SMOKE_TIMEOUT_MS = 60_000;

export type RunCliFn = (
  bin: string,
  home: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type SmokeWebFn = (input: {
  bin: string;
  home: string;
  register: (child: ChildProcess) => void;
}) => Promise<void>;

export interface RuntimeStoreLike {
  install(version: string): Promise<{ version: string; bin: string; dir: string }>;
  select(version: string): { version: string; bin: string };
  selectExisting(ref: { bin: string; version: string }): Promise<{ version: string; bin: string }>;
  current(): { version: string; bin: string } | undefined;
  inventory(): { installed: Array<{ version: string; bin: string }> };
}

export interface SnapshotStoreLike {
  create(runtime: SnapshotRuntime, reason?: string): SnapshotMeta | Promise<SnapshotMeta>;
  restore(id: string, currentRuntime: SnapshotRuntime, options?: SnapshotRestoreOptions): RestoreResult | Promise<RestoreResult>;
  completeRestore(): void | Promise<void>;
  pendingRestore(): PendingRestore | undefined;
  recover(): PendingRestore | undefined | Promise<PendingRestore | undefined>;
  recoveryReceipt?(): RestoreRecoveryReceipt | undefined;
  preview(id: string): SnapshotMeta;
  runtimeBin(id: string): string;
}

export interface CoordinatedUpgradeOptions {
  home: string;
  profiles: () => string[];
  stopAll: () => Promise<void>;
  drainPlugins?: () => Promise<void>;
  snapshots: SnapshotStoreLike;
  runtimes: RuntimeStoreLike;
  runtimeDescriptor: () => SnapshotRuntime;
  observeChild?: () => ChildObservation;
  onProgress?: (progress: UpgradeProgress) => void;
  runCli?: RunCliFn;
  smokeWeb?: SmokeWebFn;
  fetch?: typeof fetch;
  kill?: (pid: number) => Promise<void>;
  smokeTimeoutMs?: number;
  inject?: (op: string) => void;
  /** Packed snapshot-worker.mjs; large profile copy/rm run there. Tests may omit it. */
  workerFile?: string;
  workerExecArgv?: string[];
}

interface UpgradeJournal {
  planId?: string;
  phase: "preparing" | "committing";
  snapshotId: string;
  version: string;
  startedAt: string;
  originalRuntime?: SnapshotRuntime;
}

interface Pins {
  requested: Record<string, string>;
  installed: Record<string, string>;
  bundles: string[];
}

export class CoordinatedUpgrade {
  private readonly home: string;
  private readonly children = new Set<ChildProcess>();
  private committed = false;
  private readonly progressListeners = new Set<(progress: UpgradeProgress) => void>();

  onProgress(listener: (progress: UpgradeProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  }

  constructor(private readonly opts: CoordinatedUpgradeOptions) {
    assertNotRealHome(opts.home);
    this.home = resolve(opts.home);
  }

  preview(version: string): UpgradePreview {
    const exact = requireVersion(version);
    const names = this.opts.profiles();
    const currentVersion = this.opts.runtimes.current()?.version;
    const officialTargets = this.resolveOfficialFromInstalled(exact);
    const profiles: UpgradeProfilePreview[] = names.map((name) => {
      let plugins: ReturnType<typeof listProfilePlugins> = [];
      try {
        plugins = listProfilePlugins(this.home, name);
      } catch {
        plugins = [];
      }
      const official: OfficialPluginChange[] = [];
      const thirdParty: string[] = [];
      for (const plugin of plugins) {
        if (OFFICIAL.has(plugin.name)) {
          const to = plugin.name === BASE_PKG ? officialTargets?.base : officialTargets?.web;
          official.push({ name: plugin.name, from: plugin.version ?? undefined, to });
        } else {
          thirdParty.push(plugin.name);
        }
      }
      return { name, official, thirdParty };
    });
    return { version: exact, currentVersion, profiles, officialTargets };
  }

  async upgrade(version: string, planId?: string): Promise<UpgradeResult> {
    if (planId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(planId)) throw new Error("Invalid upgrade plan identity");
    const exact = requireVersion(version);
    this.assertClear();
    this.committed = false;
    const names = this.opts.profiles();
    if (names.length === 0) throw new Error("No profiles to upgrade");
    if (!names.includes("web")) throw new Error("web profile is required for upgrade smoke");

    this.progress("drain");
    await (this.opts.drainPlugins ?? defaultDrainPlugins)();
    this.progress("stop");
    await this.opts.stopAll();

    this.progress("snapshot");
    const originalRuntime = this.opts.runtimeDescriptor();
    const snapshot = await this.opts.snapshots.create(originalRuntime, "upgrade");
    this.writeJournal({
      phase: "preparing",
      planId,
      originalRuntime,
      snapshotId: snapshot.id,
      version: exact,
      startedAt: new Date().toISOString(),
    });

    try {
      this.progress("install", exact);
      const installed = await this.opts.runtimes.install(exact);
      const official = resolveOfficialVersions(installed.bin);
      const stageHome = this.stageHome();
      await this.discardPath(stageHome);
      mkdirSync(stageHome, { recursive: true });

      this.progress("stage");
      await this.materializeStage(stageHome, names);
      for (const name of names) {
        await this.stageProfile(installed.bin, stageHome, name, official);
      }

      this.progress("verify");
      for (const name of names) {
        await this.verifyProfile(installed.bin, stageHome, name);
      }

      this.progress("smoke");
      await this.smoke(installed.bin, stageHome);
      await this.ensureCandidatesGone();

      this.progress("commit");
      this.writeJournal({
        phase: "committing",
        planId,
        originalRuntime,
        snapshotId: snapshot.id,
        version: exact,
        startedAt: new Date().toISOString(),
      });
      await this.clearFallback(join(stageHome, "profiles"), installed.dir);
      await this.commitProfiles(stageHome);
      this.opts.runtimes.select(exact);
      this.clearJournal();
      this.committed = true;
      await this.discardStage();
      this.progress("done");
      return { version: exact, snapshotId: snapshot.id, profiles: names, official };
    } catch (err) {
      try {
        await this.ensureCandidatesGone();
      } catch (killErr) {
        throw combine(err, killErr);
      }
      if (!this.committed && this.readJournal()?.phase !== "committing") {
        this.clearJournal();
        await this.discardStage();
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.committed = false;
    }
  }

  async restore(_id: string, _planId?: string): Promise<RestoreResult> {
    throw new Error("Snapshot restore is not supported.");
  }

  async recover(_options: { receiptPlanId?: string } = {}): Promise<{ upgradeRolledBack?: boolean; upgradePlanId?: string; restoreCompleted?: boolean;
    restoreRolledBack?: boolean; restoreReceipt?: RestoreRecoveryReceipt }> {
    throw new Error("Upgrade recovery is not supported.");
  }

  private assertClear(): void {
    if (this.opts.snapshots.pendingRestore()) {
      throw new Error("Unfinished restore is pending; call recover() first");
    }
    if (this.readJournal()) {
      throw new Error("Unfinished upgrade is pending; call recover() first");
    }
  }

  private async materializeStage(stageHome: string, names: string[]): Promise<void> {
    const liveProfiles = join(this.home, "profiles");
    const stagedProfiles = join(stageHome, "profiles");
    if (!lexists(liveProfiles)) throw new Error("Live profiles directory is missing");
    await this.copyTree(liveProfiles, stagedProfiles, this.opts.runtimeDescriptor().root);
    // pnpm re-resolves file:../../hub/plugins dependencies while updating
    // official bundles. Their owned archives must exist in the staged Home.
    const archives = join(this.home, "hub", "plugins");
    if (lexists(archives)) {
      const stat = lstatSync(archives);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Owned plugin archives are not a regular directory");
      mkdirSync(join(stageHome, "hub"), { recursive: true });
      await this.copyTree(archives, join(stageHome, "hub", "plugins"));
    }
    for (const name of names) {
      if (!lexists(join(stagedProfiles, name))) {
        throw new Error(`Profile ${name} was not copied into the upgrade stage`);
      }
    }
    for (const extra of [".credentials.yaml", ".anonymous-user-id", "settings.yaml", "cordis.patch.yml"]) {
      const src = join(this.home, extra);
      if (!lexists(src)) continue;
      const st = lstatSync(src);
      if (st.isFile()) copyFileSync(src, join(stageHome, extra));
    }
  }

  private async stageProfile(
    bin: string,
    stageHome: string,
    name: string,
    official: { base: string; web: string },
  ): Promise<void> {
    const dir = join(stageHome, "profiles", name);
    const beforePins = readPins(dir);
    const beforePatch = name === "web" ? readPatchBytes(dir) : undefined;
    const used = usedOfficial(dir);
    if (used.base) await this.pluginAdd(bin, stageHome, name, `${BASE_PKG}@${official.base}`);
    if (used.web) await this.pluginAdd(bin, stageHome, name, `${WEB_PKG}@${official.web}`);
    const afterPins = readPins(dir);
    if (!samePins(beforePins, afterPins)) {
      throw new Error(`Third-party plugins changed while staging ${name}`);
    }
    if (name === "web") {
      const afterPatch = readPatchBytes(dir);
      if (!sameBytes(beforePatch, afterPatch)) {
        throw new Error("web cordis.patch.yml must not change during upgrade");
      }
    }
  }

  private async pluginAdd(bin: string, home: string, name: string, spec: string): Promise<void> {
    const result = await this.runCli(bin, home, ["plugin", "--profile", name, "add", spec], PLUGIN_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new Error(
        `dsh plugin add ${spec} in ${name} failed (${result.code}): ${`${result.stdout}\n${result.stderr}`.slice(-1600)}`,
      );
    }
  }

  private async verifyProfile(bin: string, stageHome: string, name: string): Promise<void> {
    const result = await this.runCli(bin, stageHome, ["--profile", name, "--dump-config"], DUMP_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new Error(
        `dump-config ${name} failed (${result.code}): ${(result.stderr || result.stdout).slice(0, 400)}`,
      );
    }
    if (name === "web") return;
    if (usedOfficial(join(stageHome, "profiles", name)).web) {
      assertDumpPatched(result.stdout, name);
    }
  }

  private async smoke(bin: string, stageHome: string): Promise<void> {
    const smoke = this.opts.smokeWeb ?? ((input) => this.defaultSmoke(input));
    await smoke({
      bin,
      home: stageHome,
      register: (child) => this.track(child),
    });
  }

  private async defaultSmoke(input: {
    bin: string;
    home: string;
    register: (child: ChildProcess) => void;
  }): Promise<void> {
    const port = await ephemeralPort();
    const child = this.spawnCandidate(
      [input.bin, "--profile", "web", "--no-open", "--host", "127.0.0.1", "--port", String(port)],
      {
        env: toolchainEnv({ DSH_HOME: input.home }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    input.register(child);
    this.track(child);
    const timeoutMs = this.opts.smokeTimeoutMs ?? SMOKE_TIMEOUT_MS;
    const fetchImpl = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`upgrade smoke timed out after ${timeoutMs}ms`)), timeoutMs);
    child.once("error", (err) => abort.abort(err));
    let output = "";
    let checking = "endpoint announcement";
    const capture = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4000); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    try {
      const url = await waitForDshEndpoint(child, port, abort.signal, timeoutMs);
      checking = "browser authentication";
      const cookie = await dshSessionCookie(url, fetchImpl, abort.signal);
      checking = "session API";
      await waitForSessionList(port, fetchImpl, abort.signal, timeoutMs, cookie);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} (${checking})${output ? `\n${sanitizeLogText(output)}` : ""}`);
    } finally {
      clearTimeout(timer);
      await this.release(child);
    }
  }

  private async commitProfiles(stageHome: string): Promise<void> {
    const live = join(this.home, "profiles");
    const staged = join(stageHome, "profiles");
    const backup = this.profilesBackup();
    assertContained(this.home, live, "live profiles");
    assertContained(stageHome, staged, "staged profiles");
    assertContained(this.stageRoot(), backup, "profile backup");
    if (lexists(backup)) await this.discardPath(backup);
    this.hook("commit:backup");
    if (lexists(live)) await this.renameTree(live, backup);
    try {
      this.hook("commit:swap");
      await this.renameTree(staged, live);
      this.hook("commit:retarget");
      if (lstatSync(live).isDirectory()) await this.retarget(live, staged, live);
    } catch (err) {
      await this.restoreProfilesBackup();
      throw err;
    }
  }

  private async restoreProfilesBackup(): Promise<void> {
    if (this.stageIsLink()) return;
    const live = join(this.home, "profiles");
    const backup = this.profilesBackup();
    if (!lexists(backup) || lstatSync(backup).isSymbolicLink()) return;
    assertContained(this.stageRoot(), backup, "profile backup");
    if (lexists(live)) await this.discardPath(live);
    await this.renameTree(backup, live);
  }

  private async rollbackSnapshot(snapshotId: string): Promise<void> {
    await this.restoreProfilesBackup();
    const originalRuntime = this.readJournal()?.originalRuntime;
    if (originalRuntime) await this.clearFallback(join(this.home, "profiles"), originalRuntime.root);
    const result = await this.opts.snapshots.restore(snapshotId, this.opts.runtimeDescriptor());
    await this.opts.runtimes.selectExisting({
      bin: this.opts.snapshots.runtimeBin(snapshotId),
      version: result.restored.runtimeVersion,
    });
    await this.opts.snapshots.completeRestore();
  }

  private async runCli(
    bin: string,
    home: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.opts.runCli) return this.opts.runCli(bin, home, args, timeoutMs);
    return this.defaultRunCli(bin, home, args, timeoutMs);
  }

  private defaultRunCli(
    bin: string,
    home: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = this.spawnCandidate([bin, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: toolchainEnv({ DSH_HOME: home }),
    });
    this.track(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    return new Promise((resolveRun, reject) => {
      const finish = (released: boolean, fn: () => void) => {
        if (settled) return;
        settled = true;
        if (released) this.children.delete(child);
        fn();
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        const timeoutErr = new Error(`dsh ${args.join(" ")} timed out after ${timeoutMs}ms`);
        this.release(child).then(
          () => finish(true, () => reject(timeoutErr)),
          (killErr: unknown) => finish(false, () => reject(combine(timeoutErr, killErr))),
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
        if (timedOut) return;
        finish(true, () => reject(err));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        finish(true, () => resolveRun({ code: code ?? 1, stdout, stderr }));
      });
    });
  }

  private track(child: ChildProcess): void {
    if (this.children.has(child)) return;
    this.children.add(child);
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", () => undefined);
  }

  private spawnCandidate(args: string[], options: SpawnOptions): ChildProcess {
    const observation = this.opts.observeChild?.();
    let child: ChildProcess;
    try { child = observation ? withoutChildObservation(() => spawnNode(args, options)) : spawnNode(args, options); }
    catch (error) { observation?.cancel(); throw error; }
    this.track(child);
    observation?.attach(child);
    return child;
  }

  private async release(child: ChildProcess): Promise<void> {
    await this.stopOwned(child);
    this.children.delete(child);
  }

  private async stopOwned(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (this.opts.kill) {
      if (!child.pid) throw new Error("Candidate process has no pid");
      await this.opts.kill(child.pid);
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`Candidate process ${child.pid} did not exit after kill`);
      }
      return;
    }
    await terminateProcessTree(child);
  }

  private async ensureCandidatesGone(): Promise<void> {
    const errors: string[] = [];
    for (const child of [...this.children]) {
      try {
        await this.stopOwned(child);
        this.children.delete(child);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length > 0) {
      throw new ProcessTerminationError(`Candidate processes still running: ${errors.join("; ")}`);
    }
  }

  private resolveOfficialFromInstalled(version: string): { base: string; web: string } | undefined {
    const installed = this.opts.runtimes.inventory().installed.find((row) => row.version === version);
    if (!installed) return undefined;
    try {
      return resolveOfficialVersions(installed.bin);
    } catch {
      return undefined;
    }
  }

  private progress(phase: UpgradePhase, detail?: string): void {
    this.opts.onProgress?.({ phase, detail });
    for (const listener of this.progressListeners) listener({ phase, detail });
  }

  private hook(op: string): void {
    this.opts.inject?.(op);
  }

  private stageRoot(): string {
    return join(this.home, STAGE_DIR);
  }

  private stageHome(): string {
    return join(this.stageRoot(), "home");
  }

  private profilesBackup(): string {
    return join(this.stageRoot(), BACKUP_PROFILES);
  }

  private journalPath(): string {
    return join(this.stageRoot(), JOURNAL);
  }

  private stageIsLink(): boolean {
    const dir = this.stageRoot();
    return lexists(dir) && lstatSync(dir).isSymbolicLink();
  }

  private writeJournal(journal: UpgradeJournal): void {
    const dir = this.stageRoot();
    assertContained(this.home, dir, "upgrade stage");
    if (lexists(dir) && lstatSync(dir).isSymbolicLink()) unlinkSync(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.journalPath(), `${JSON.stringify(journal, null, 2)}\n`);
  }

  private readJournal(): UpgradeJournal | undefined {
    if (this.stageIsLink()) return undefined;
    const path = this.journalPath();
    if (!lexists(path) || lstatSync(path).isSymbolicLink()) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as UpgradeJournal;
      if (parsed.phase !== "preparing" && parsed.phase !== "committing") return undefined;
      if (typeof parsed.snapshotId !== "string" || typeof parsed.version !== "string") return undefined;
      return parsed;
    } catch {
      throw new Error("Upgrade journal is unreadable");
    }
  }

  private clearJournal(): void {
    if (this.stageIsLink()) return;
    const path = this.journalPath();
    if (lexists(path) && lstatSync(path).isFile()) unlinkSync(path);
  }

  private async discardStage(): Promise<void> {
    await this.discardPath(this.stageRoot());
  }

  private async discardPath(target: string): Promise<void> {
    if (!lexists(target)) return;
    if (samePath(target, this.home)) throw new Error("Refusing to delete DSH home");
    assertContained(this.home, target, "controlled directory");
    const st = lstatSync(target);
    if (st.isSymbolicLink() || st.isFile()) {
      unlinkSync(target);
      return;
    }
    await this.runIo("removeTree", { target });
  }

  private async copyTree(src: string, dest: string, fallbackRuntimeRoot?: string): Promise<void> {
    await this.runIo("copyLinkedTree", { src, dest, fallbackRuntimeRoot });
  }

  private async renameTree(src: string, dest: string): Promise<void> {
    await this.runIo("renameTree", { src, dest });
  }

  private async retarget(dir: string, oldRoot: string, newRoot: string): Promise<void> {
    await this.runIo("retargetTree", { dir, oldRoot, newRoot });
  }

  private async clearFallback(profiles: string, runtimeRoot: string): Promise<void> {
    await this.runIo("clearRuntimeFallback", { profiles, runtimeRoot });
  }

  private async runIo(
    operation: "copyLinkedTree" | "removeTree" | "renameTree" | "retargetTree" | "clearRuntimeFallback",
    args: Record<string, unknown>,
  ): Promise<void> {
    const workerFile = this.opts.workerFile ?? packedSnapshotWorkerFile();
    if (!workerFile) {
      this.runIoLocal(operation, args);
      return;
    }
    await runSnapshotWorker(workerFile, {
      home: this.home,
      operation,
      allowProductHome: isAuthorizedProductHome(this.home),
      ...args,
    }, this.opts.workerExecArgv ?? []);
  }

  private runIoLocal(operation: SnapshotWorkerOperation, args: Record<string, unknown>): void {
    if (operation === "copyLinkedTree") {
      copyLinkedTree(String(args.src), String(args.dest), args.fallbackRuntimeRoot ? String(args.fallbackRuntimeRoot) : undefined);
      return;
    }
    if (operation === "renameTree") {
      renameSync(String(args.src), String(args.dest));
      return;
    }
    if (operation === "retargetTree") {
      retargetTree(String(args.dir), String(args.oldRoot), String(args.newRoot));
      return;
    }
    if (operation === "clearRuntimeFallback") {
      clearRuntimeFallback(String(args.profiles), String(args.runtimeRoot));
      return;
    }
    rmLinkAware(String(args.target));
  }
}

function packedSnapshotWorkerFile(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const names = ["snapshot-worker.mjs", join("..", "snapshot-worker.mjs")];
  for (const name of names) {
    const candidate = unpackAsarPath(join(here, name));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function unpackAsarPath(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

function requireVersion(version: string): string {
  if (!isExactRuntimeVersion(version)) throw new Error(`invalid runtime version: ${version}`);
  return version;
}

async function defaultDrainPlugins(): Promise<void> {
  const start = Date.now();
  while (pluginQueueSnapshot().pending > 0) {
    if (Date.now() - start > DRAIN_TIMEOUT_MS) throw new Error("Plugin queue drain timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

export function resolveOfficialVersions(bin: string): { base: string; web: string } {
  if (!existsSync(bin)) throw new Error(`Candidate CLI binary is missing: ${bin}`);
  let realBin: string;
  try {
    realBin = realpathSync(bin);
  } catch {
    throw new Error(`Candidate CLI binary is not resolvable: ${bin}`);
  }
  const req = createRequire(realBin);
  return {
    base: requireInstalledVersion(req, BASE_PKG),
    web: requireInstalledVersion(req, WEB_PKG),
  };
}

function requireInstalledVersion(req: NodeRequire, name: string): string {
  let pkgPath: string;
  try {
    pkgPath = req.resolve(`${name}/package.json`);
  } catch {
    throw new Error(`Candidate CLI does not resolve installed ${name}`);
  }
  const pkg = readPkg(pkgPath);
  if (!pkg || pkg.name !== name || typeof pkg.version !== "string" || !isExactRuntimeVersion(pkg.version)) {
    throw new Error(`Candidate CLI resolved ${name} without an exact installed version`);
  }
  return pkg.version;
}

function readPkg(path: string): { name?: unknown; version?: unknown; dependencies?: unknown; dsh?: unknown } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      name?: unknown;
      version?: unknown;
      dependencies?: unknown;
      dsh?: unknown;
    };
  } catch {
    return undefined;
  }
}

function usedOfficial(profileDir: string): { base: boolean; web: boolean } {
  const pkg = readPkg(join(profileDir, "package.json"));
  const deps = pkg?.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies as object) : [];
  const bundles = bundlesOf(pkg);
  const names = new Set([...deps, ...bundles]);
  return { base: names.has(BASE_PKG), web: names.has(WEB_PKG) };
}

function bundlesOf(pkg: { dsh?: unknown } | undefined): string[] {
  const dsh = pkg?.dsh;
  if (!dsh || typeof dsh !== "object") return [];
  const profile = (dsh as { profile?: { bundles?: unknown } }).profile;
  if (!profile || !Array.isArray(profile.bundles)) return [];
  return profile.bundles.filter((item): item is string => typeof item === "string");
}

function readPins(profileDir: string): Pins {
  const pkg = readPkg(join(profileDir, "package.json"));
  const deps =
    pkg?.dependencies && typeof pkg.dependencies === "object"
      ? (pkg.dependencies as Record<string, unknown>)
      : {};
  const requested: Record<string, string> = {};
  const installed: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (OFFICIAL.has(name) || typeof spec !== "string") continue;
    requested[name] = spec;
    const version = packageVersionAt(join(profileDir, "node_modules", ...name.split("/"), "package.json"), name);
    if (version) installed[name] = version;
  }
  return { requested, installed, bundles: bundlesOf(pkg) };
}

function packageVersionAt(path: string, expectedName: string): string | undefined {
  const pkg = readPkg(path);
  if (!pkg || pkg.name !== expectedName || typeof pkg.version !== "string") return undefined;
  return isExactRuntimeVersion(pkg.version) ? pkg.version : undefined;
}

function samePins(before: Pins, after: Pins): boolean {
  return (
    sameRecord(before.requested, after.requested) &&
    sameRecord(before.installed, after.installed) &&
    before.bundles.length === after.bundles.length &&
    before.bundles.every((name, index) => name === after.bundles[index])
  );
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function readPatchBytes(profileDir: string): Buffer | undefined {
  const path = join(profileDir, "cordis.patch.yml");
  if (!lexists(path)) return undefined;
  return readFileSync(path);
}

function sameBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.equals(b);
}

function combine(primary: unknown, extra: unknown): Error {
  const first = primary instanceof Error ? primary.message : String(primary);
  const second = extra instanceof Error ? extra.message : String(extra);
  const Failure = primary instanceof ProcessTerminationError || extra instanceof ProcessTerminationError
    ? ProcessTerminationError : Error;
  const err = new Failure(`${second} (after: ${first})`);
  err.cause = primary instanceof Error ? primary : extra;
  return err;
}

async function waitForSessionList(
  port: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
  cookie?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    if (signal.aborted) throw abortError(signal);
    try {
      await dshSessionList(port, fetchImpl, signal, cookie);
      return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await sleep(200, signal);
    }
  }
  throw new Error(`upgrade smoke failed: ${last}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close((err) => {
        if (err) reject(err);
        else if (addr && typeof addr === "object") resolvePort(addr.port);
        else reject(new Error("Could not bind a localhost port for upgrade smoke"));
      });
    });
  });
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertContained(root: string, target: string, label: string): void {
  const resolved = resolve(target);
  if (!isInside(root, resolved) && !samePath(root, resolved)) {
    throw new Error(`Refusing to touch path outside ${label}: ${resolved}`);
  }
  if (!lexists(resolved)) return;
  const st = lstatSync(resolved);
  if (st.isSymbolicLink()) return;
  const real = realpathSync(resolved);
  const realRoot = lexists(root) ? (lstatSync(root).isSymbolicLink() ? resolve(root) : realpathSync(root)) : resolve(root);
  if (!isInside(realRoot, real) && !samePath(realRoot, real)) {
    throw new Error(`Refusing to touch path outside ${label}: ${real}`);
  }
}

function isInside(root: string, target: string): boolean {
  const r = canon(root);
  const t = canon(target);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function canon(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rmLinkAware(path: string): void {
  if (!lexists(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.isFile()) {
    unlinkSync(path);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) rmLinkAware(join(path, name));
    rmdirSync(path);
  }
}
