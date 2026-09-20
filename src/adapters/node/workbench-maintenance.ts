import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWrite } from "../../main/atomic";
import { applyXpEmbedCompatibility, XP_EMBED_COMPATIBILITY_NOTE, XP_PACKAGE_NAME, XP_SUPPORTED_VERSION } from "./xp-compatibility";
import { assertNotRealHome } from "../../main/home-guard";
import { CATALOG_CACHE_FILE, lookupCatalogEntry, parseAnyCatalog, seedCatalog } from "../../main/plugin-catalog";
import {
  archiveAbsPath,
  archiveRelPath,
  isHubPluginArchive,
  lookupLibraryEntry,
  readPluginLibrary,
  upsertLibraryEntry,
} from "../../main/plugin-library";
import {
  isProtectedPlugin,
  listAllProfilePlugins,
  listProfilePlugins,
  pluginAdd as defaultPluginAdd,
  pluginRemove as defaultPluginRemove,
  resolveInstallSpec,
  setSpacePlugin as defaultSetSpacePlugin,
} from "../../main/plugin-ops";
import { npmPackumentUrl } from "../../main/package-source";
import { currentPackageSource } from "../../main/toolchain";
import { ProcessTerminationError } from "../../main/terminate-process";
import { WorkbenchJobError } from "./workbench-jobs";
import { isGitSpec, isInstallableEntry, isSafeSpec, matchesPluginQuery, pluginAliases, pluginDisplayName } from "../../shared/plugin";
import { isExactRuntimeVersion } from "../../shared/runtime";
import { BACKUP_FILE_PREFIX, type ConfigBackupMeta } from "../../shared/diagnostics";
import type { PackageSource, PluginCatalogEntry, PluginLibraryEntry } from "../../shared/types";
import { PROFILE_NAME_RE, PROTECTED_PLUGIN_PACKAGES } from "../../shared/types";
import type { RestoreRecoveryReceipt, SnapshotMeta } from "../../shared/snapshots";
import type {
  WorkbenchBackup,
  WorkbenchJob,
  WorkbenchPlan,
  WorkbenchPlanRequest,
  WorkbenchPlugin,
  WorkbenchRuntime,
  WorkbenchPackageRelease,
  WorkbenchSnapshot,
} from "../../shared/workbench";
import {
  WORKBENCH_CONTROL_DIR_NAME,
  WorkbenchJobAbortError,
  type WorkbenchJobContext,
  type WorkbenchJobResult,
} from "./workbench-jobs";
import type { WorkbenchMaintenancePorts } from "./workbench-maintenance-ports";

export const WORKBENCH_PLANS_DIR_NAME = "plans";
export const WORKBENCH_PLUGIN_REGISTRY_FILE = "plugin-registry.json";
export const WORKBENCH_PLUGIN_MUTATION_FILE = "plugin-mutation.json";
export const WORKBENCH_PLUGIN_MUTATION_FILES_DIR = "plugin-mutation-files";
export const WORKBENCH_PLAN_TTL_MS = 5 * 60 * 1000;
export const FULL_SPACES_PACKAGE = "@dsh-spaces/plugin";
export const UPGRADE_STAGE_DIR = ".dsh-spaces-upgrade";
export const UPGRADE_JOURNAL_FILE = "journal.json";

export const WORKBENCH_MAINTENANCE_ERROR = {
  "workbench/invalid-input": "The request is not a valid workbench maintenance plan.",
  "workbench/not-found": "That maintenance target was not found.",
  "workbench/expired": "This plan has expired. Preview the action again.",
  "workbench/stale": "The target changed after preview. Preview the action again.",
  "workbench/conflict": "This plan was already executed.",
  "workbench/forbidden": "This maintenance action is not allowed for the selected target.",
  "workbench/runtime-handoff": "This action is handled by the supervisor runtime, not maintenance.",
  "workbench/unsupported": "That runtime version cannot be used for this action.",
  "workbench/cancelled": "The maintenance job was cancelled.",
  "workbench/failed": "The maintenance operation failed.",
} as const;

export type WorkbenchMaintenanceErrorCode = keyof typeof WORKBENCH_MAINTENANCE_ERROR;

const DOWNLOAD_TIMEOUT_MS = 20_000;
const PROTECTED_PACKAGES = new Set<string>([...PROTECTED_PLUGIN_PACKAGES, FULL_SPACES_PACKAGE]);
const HANDOFF_KINDS = new Set<WorkbenchPlanRequest["kind"]>([
  "space.stop",
  "space.restart",
  "space.delete",
  "controller.release",
  "controller.shutdown",
]);
const PLAN_SCHEMA = 1;
const PLAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const CATALOG_ID_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$|^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PROFILE_FILE_NAMES = ["package.json", "pnpm-lock.yaml", "pnpm-lock.yml", "cordis.patch.yml"] as const;

export class WorkbenchMaintenanceError extends Error {
  readonly name = "WorkbenchMaintenanceError";
  constructor(
    readonly code: WorkbenchMaintenanceErrorCode,
    message: string = WORKBENCH_MAINTENANCE_ERROR[code],
  ) {
    super(WORKBENCH_MAINTENANCE_ERROR[code] || message);
  }
}

export type MaintenanceFetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

export type PluginMutator = (home: string, profile: string, spec: string) => Promise<void>;

export interface WorkbenchMaintenanceOptions {
  now?: () => Date;
  fetch?: MaintenanceFetcher;
  pluginAdd?: PluginMutator;
  pluginRemove?: PluginMutator;
  setSpacePlugin?: typeof defaultSetSpacePlugin;
  packageSource?: PackageSource;
  log?: (message: string, error?: unknown) => void;
}

export interface WorkbenchRecoveryOutcome {
  restoreCompleted: boolean;
  restoreRolledBack?: boolean;
  restorePlanId?: string;
  upgradeRolledBack: boolean;
  /**
   * Snapshot/upgrade/plugin-mutation journals were inspected and are in a known-good state.
   * Does not prove arbitrary space/plugin jobs finished.
   */
  consistent: boolean;
  /**
   * True only after a pending snapshot restore or upgrade journal was reconciled.
   * Supervisor may settle that maintenance job. Never mass-settle unrelated interrupted jobs,
   * and never true merely because no journal exists.
   */
  settleInterruptedJobs: boolean;
  message: string;
  /** Pending restore id captured before recover. Bind settlement to this snapshot only. */
  snapshotId?: string;
  /** Plugin-mutation plan id, only when a whole-home restore completed. */
  pluginPlanId?: string;
  /** Upgrade journal plan id captured before recover. Bind settlement to this plan only. */
  upgradePlanId?: string;
  workbenchPlanId?: string;
  workbenchRolledBack?: boolean;
  workbenchSucceeded?: boolean;
}

type ResolvedCommand =
  | {
      kind: "plugin.install";
      spaceIds: string[];
      catalogId: string;
      packageName: string;
      version: string;
    }
  | { kind: "plugin.remove"; spaceId: string; packageName: string }
  | { kind: "plugin.toggle"; spaceId: string; pluginId: string; packageName: string; enabled: boolean }
  | { kind: "plugin.cleanup-manager"; spaceId: string; packageName: string }
  | { kind: "snapshot.create" }
  | { kind: "snapshot.restore"; snapshotId: string }
  | { kind: "snapshot.delete"; snapshotId: string }
  | { kind: "config.restore"; spaceId: string; backupId: string }
  | { kind: "runtime.install"; version: string }
  | { kind: "runtime.upgrade"; version: string }
  | { kind: "workbench.upgrade"; catalogId: "bundled-workbench"; version: string; expectedDigest: string };

type PlanStatus = "previewed" | "running" | "succeeded" | "failed" | "cancelled";

interface StoredPlan {
  schemaVersion: 1;
  id: string;
  public: WorkbenchPlan;
  command: ResolvedCommand;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  status: PlanStatus;
  startedAt?: string;
  finishedAt?: string;
}

interface PluginMutationExpected {
  spaceId: string;
  action: "install" | "remove";
  packageName: string;
  version?: string;
}

interface PluginMutationJournal {
  schemaVersion: 1;
  phase: "prepared" | "mutating" | "failed";
  planId?: string;
  spaceIds: string[];
  expected: PluginMutationExpected[];
  startedAt: string;
}

interface Packument {
  name?: unknown;
  description?: unknown;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: string }; description?: unknown }>;
}

/**
 * Maintenance application service. Supervisor runtime supplies ports; this
 * module does not create a ProcessManager, HomeController, or job engine.
 */
export class WorkbenchMaintenance {
  private readonly now: () => Date;
  private readonly fetchImpl: MaintenanceFetcher;
  private readonly pluginAddImpl: PluginMutator;
  private readonly pluginRemoveImpl: PluginMutator;
  private readonly setSpacePluginImpl: typeof defaultSetSpacePlugin;
  private readonly source: () => PackageSource;
  private readonly logImpl?: (message: string, error?: unknown) => void;
  private recovery?: WorkbenchRecoveryOutcome;

  constructor(
    private readonly ports: WorkbenchMaintenancePorts,
    options: WorkbenchMaintenanceOptions = {},
  ) {
    assertNotRealHome(ports.home);
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch ?? defaultFetcher;
    this.pluginAddImpl = options.pluginAdd ?? defaultPluginAdd;
    this.pluginRemoveImpl = options.pluginRemove ?? defaultPluginRemove;
    this.setSpacePluginImpl = options.setSpacePlugin ?? defaultSetSpacePlugin;
    this.source = () => options.packageSource ?? currentPackageSource();
    this.logImpl = options.log;
  }

  recoveryOutcome(): WorkbenchRecoveryOutcome | undefined {
    return this.recovery ? { ...this.recovery } : undefined;
  }

  async preview(request: WorkbenchPlanRequest): Promise<WorkbenchPlan> {
    this.assertWritable();
    try {
      return await this.ports.lock.run("workbench.preview", async () => {
        const parsed = parsePlanRequest(request);
        if (HANDOFF_KINDS.has(parsed.kind)) {
          throw new WorkbenchMaintenanceError("workbench/runtime-handoff");
        }
        const built = await this.buildPlan(parsed);
        this.writePlan(built);
        return {
          ...built.public,
          affectedSpaceIds: [...built.public.affectedSpaceIds],
          runningSpaceIds: [...built.public.runningSpaceIds],
          changes: [...built.public.changes],
        };
      });
    } catch (error) {
      throw this.fail(error, "preview");
    }
  }

  async execute(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJobResult | void> {
    this.assertWritable();
    try {
      return await this.ports.lock.run("workbench.execute", () => this.executeLocked(planId, ctx));
    } catch (error) {
      throw this.fail(error, "execute");
    }
  }

  async plugins(query: string): Promise<WorkbenchPlugin[]> {
    if (typeof query !== "string" || query.length > 80) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    const catalog = this.catalogEntries();
    const library = readPluginLibrary(this.ports.home);
    const installed = this.installedBySpace();
    const rows = new Map<string, WorkbenchPlugin>();

    const put = (row: WorkbenchPlugin) => {
      const key = row.packageName.toLowerCase();
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, row);
        return;
      }
      const installedIn = unique([...existing.installedIn, ...row.installedIn]);
      rows.set(key, {
        ...existing,
        title: existing.title || row.title,
        description: existing.description || row.description,
        version: existing.version ?? row.version,
        installedIn,
        protected: existing.protected || row.protected,
      });
    };

    for (const entry of catalog) {
      put(this.pluginFromCatalog(entry, installed));
    }
    for (const entry of library) {
      put(this.pluginFromLibrary(entry, installed));
    }
    for (const [spaceId, list] of Object.entries(installed)) {
      for (const item of list) {
        put({
          id: item.name,
          title: item.name,
          packageName: item.name,
          description: "",
          version: item.version ?? null,
          installedIn: [spaceId],
          protected: item.protected || isGuardedPackage(item.name),
        });
      }
    }

    const q = query.trim();
    let list = [...rows.values()];
    if (q) {
      list = list.filter((row) =>
        matchesPluginQuery(
          {
            id: row.id,
            repo: row.packageName,
            owner: row.packageName,
            packageName: row.packageName,
            description: row.description,
            tags: [],
          },
          q,
        ) || row.packageName.toLowerCase() === q.toLowerCase() || row.id.toLowerCase() === q.toLowerCase(),
      );
    }
    if (q && list.length === 0 && isNpmPackageId(q)) {
      const remote = await this.lookupNpmPackage(q);
      if (remote) list = [remote];
    }
    list.sort((a, b) => a.title.localeCompare(b.title) || a.packageName.localeCompare(b.packageName));
    return list.map(publicPlugin);
  }

  async snapshots(): Promise<WorkbenchSnapshot[]> {
    try {
      return this.ports.snapshots.list().map(publicSnapshot);
    } catch (error) {
      throw this.fail(error, "snapshots.list");
    }
  }

  async snapshot(id: string): Promise<WorkbenchSnapshot> {
    if (typeof id !== "string" || !id) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    try {
      return publicSnapshot(this.ports.snapshots.preview(id));
    } catch (error) {
      throw this.fail(error, "snapshots.preview", "workbench/not-found");
    }
  }

  async runtimes(): Promise<WorkbenchRuntime[]> {
    let installed: Array<{ version: string }> = [];
    let current: string | undefined;
    try {
      const inventory = this.ports.runtimes.inventory();
      installed = inventory.installed.filter((row) => isExactRuntimeVersion(row.version));
      if (inventory.current && isExactRuntimeVersion(inventory.current.version)) {
        current = inventory.current.version;
      }
    } catch (error) {
      throw this.fail(error, "runtimes.inventory");
    }
    const versions = new Set(installed.map((row) => row.version));
    if (current) versions.add(current);
    try {
      const catalog = await this.ports.runtimes.catalog();
      for (const row of catalog.versions) {
        if (isExactRuntimeVersion(row.version)) versions.add(row.version);
      }
    } catch (error) {
      this.log("runtimes.catalog", error);
    }
    const installedSet = new Set(installed.map((row) => row.version));
    return [...versions]
      .sort((a, b) => a.localeCompare(b))
      .map((version) => ({
        version,
        installed: installedSet.has(version),
        current: current === version,
        compatible: this.ports.isCompatibleRuntime(version),
      }));
  }

  async backups(spaceId: string): Promise<WorkbenchBackup[]> {
    this.targetSpace(spaceId, true);
    try {
      return this.ports.diagnostics.get(spaceId).backups.map(publicBackup);
    } catch (error) {
      throw this.fail(error, "diagnostics.get", "workbench/not-found");
    }
  }

  async workbenchPackage(): Promise<WorkbenchPackageRelease | null> {
    return await this.ports.packageUpgrade?.describe() ?? null;
  }

  async recover(ctx?: WorkbenchJobContext): Promise<void> {
    this.resetRecoveryOutcome();
    this.assertWritable();
    const context = ctx ?? silentJobContext();
    try {
      await this.ports.lock.run("workbench.recover", () => this.recoverLocked(context));
    } catch (error) {
      throw this.fail(error, "recover");
    }
  }

  private assertWritable(): void {
    try {
      this.ports.assertWritable();
    } catch (error) {
      throw this.fail(error, "assertWritable", "workbench/forbidden");
    }
  }

  private async executeLocked(planId: string, ctx: WorkbenchJobContext): Promise<WorkbenchJobResult | void> {
    const stored = this.readPlan(planId);
    if (stored.status !== "previewed") throw new WorkbenchMaintenanceError("workbench/conflict");
    this.assertFresh(stored);
    const rebuilt = await this.buildPlan(requestFromCommand(stored.command));
    if (rebuilt.fingerprint !== stored.fingerprint) {
      throw new WorkbenchMaintenanceError("workbench/stale");
    }
    ctx.phase("prepare");
    ctx.message(stored.public.title);
    ctx.cancellable(true);
    this.throwIfAborted(ctx);
    this.markPlan(stored, "running");
    let irreversible = false;
    try {
      const withIrreversible = async <T>(work: () => Promise<T>): Promise<T> => {
        irreversible = true;
        ctx.cancellable(false);
        return work();
      };
      switch (stored.command.kind) {
        case "plugin.install":
          await this.runPluginInstall(stored.command, ctx, stored.id, () => {
            irreversible = true;
          });
          this.markPlan(stored, "succeeded");
          return;
        case "plugin.remove":
          await this.runPluginRemove(stored.command, ctx, stored.id, () => {
            irreversible = true;
          });
          this.markPlan(stored, "succeeded");
          return;
        case "plugin.toggle":
          await this.runPluginToggle(stored.command, ctx, stored.id, () => {
            irreversible = true;
          });
          this.markPlan(stored, "succeeded");
          return;
        case "plugin.cleanup-manager":
          await this.runCleanupManager(stored.command, ctx, stored.id, () => {
            irreversible = true;
          });
          this.markPlan(stored, "succeeded");
          return;
        case "snapshot.create":
          return await this.finishPlan(stored, () => withIrreversible(() => this.runSnapshotCreate(ctx)));
        case "snapshot.restore": {
          const snapshotId = stored.command.snapshotId;
          return await this.finishPlan(stored, () => withIrreversible(() => this.runSnapshotRestore(snapshotId, ctx, stored.id)));
        }
        case "snapshot.delete": {
          const snapshotId = stored.command.snapshotId;
          await withIrreversible(() => this.runSnapshotDelete(snapshotId, ctx));
          this.markPlan(stored, "succeeded");
          return;
        }
        case "config.restore": {
          const command = stored.command;
          await withIrreversible(() => this.runConfigRestore(command, ctx));
          this.markPlan(stored, "succeeded");
          return;
        }
        case "runtime.install": {
          const version = stored.command.version;
          return await this.finishPlan(stored, () => withIrreversible(() => this.runRuntimeInstall(version, ctx)));
        }
        case "runtime.upgrade": {
          const version = stored.command.version;
          const planId = stored.id;
          return await this.finishPlan(stored, () => withIrreversible(() => this.runRuntimeUpgrade(version, ctx, planId)));
        }
        case "workbench.upgrade": {
          const upgrade = this.ports.packageUpgrade;
          if (!upgrade) throw new WorkbenchMaintenanceError("workbench/unsupported");
          const command = stored.command;
          return await this.finishPlan(stored, () => withIrreversible(async () => {
            this.ports.setMaintenance(true);
            try {
              return await upgrade.execute({ ...command, planId: stored.id }, ctx);
            } catch (error) {
              this.log("workbench package update", error);
              if (upgrade.hasEvidence()) throw new WorkbenchJobError("workbench/recovery-required");
              throw error;
            } finally {
              // The package transaction owns manager reinitialization. Do not run it twice.
              if (!upgrade.hasEvidence()) this.ports.setMaintenance(false);
            }
          }));
        }
      }
    } catch (error) {
      if (uncertainMaintenance(error)) {
        this.ports.setMaintenance(true);
      } else if (error instanceof WorkbenchJobAbortError && !irreversible) {
        this.markPlan(stored, "cancelled");
      } else {
        this.markPlan(stored, "failed");
      }
      throw this.fail(error, "execute");
    }
  }

  private async finishPlan<T>(stored: StoredPlan, work: () => Promise<T>): Promise<T> {
    const result = await work();
    this.markPlan(stored, "succeeded");
    return result;
  }

  private async recoverLocked(ctx: WorkbenchJobContext): Promise<void> {
    ctx.phase("inspect");
    ctx.message("Inspecting unfinished restore and upgrade state.");
    ctx.cancellable(false);
    const packageUpgrade = this.ports.packageUpgrade;
    if (packageUpgrade) {
      const active = packageUpgrade.hasEvidence();
      const planIds = (this.ports.unfinishedPlanIds?.() ?? []).filter(id => {
        try { return this.readPlan(id).command.kind === "workbench.upgrade"; }
        catch { return false; }
      });
      if (active || planIds.length) {
        this.ports.setMaintenance(true);
        const candidates: Array<string | undefined> = active ? [undefined] : planIds;
        for (const planId of candidates) {
          const result = await packageUpgrade.recover(ctx, planId);
          if (!result) continue;
          if (packageUpgrade.hasEvidence() || !this.liveHomeConsistent() || !this.homeConfigReadable()) {
            throw new WorkbenchMaintenanceError("workbench/failed");
          }
          this.verifyRecoveredRuntime();
          this.recovery = {
            restoreCompleted: false, upgradeRolledBack: false,
            consistent: true, settleInterruptedJobs: true,
            workbenchPlanId: result.planId, workbenchRolledBack: result.rolledBack,
            workbenchSucceeded: result.outcome === "succeeded",
            message: "The workbench package transaction was reconciled using its own plan evidence.",
          };
          this.ports.setMaintenance(false);
          return;
        }
      }
    }
    const pending = this.inspectPendingRestore();
    const journal = this.readUpgradeJournal();
    const pluginMutation = this.readPluginMutation();
    const runningPlan = this.hasRunningPlan();
    let receipt: RestoreRecoveryReceipt | undefined;
    try { receipt = this.ports.snapshots.recoveryReceipt?.(); }
    catch {
      this.setFailedRecovery("Restore recovery evidence is unreadable and was left in place.");
      this.keepMaintenanceFlag();
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    const pendingSnapshotId = pending.status === "pending" ? pending.value?.snapshotId : undefined;
    const expectedRuntimeVersion = pending.status === "pending" ? pending.value?.runtimeVersion : undefined;
    const pluginPlanId = pluginMutation.status === "open" ? pluginMutation.planId : undefined;
    const upgradePlanId = journal.status === "preparing" || journal.status === "committing" ? journal.planId : undefined;

    if (pending.status === "unreadable" || journal.status === "unreadable" || journal.status === "unknown" || pluginMutation.status === "unreadable") {
      this.log("recover refused to clear unreadable maintenance metadata", pending.error ?? journal.error);
      this.setFailedRecovery("Unreadable snapshot, upgrade, or plugin-mutation evidence was left in place.");
      this.keepMaintenanceFlag();
      throw new WorkbenchMaintenanceError("workbench/failed");
    }

    const receiptPlanId = pending.value?.planId ??
      (receipt?.planId && this.ports.hasUnfinishedPlan?.(receipt.planId) ? receipt.planId : undefined);
    const needsHomeRecover = pending.status === "pending" || Boolean(receiptPlanId) || journal.status === "preparing" || journal.status === "committing";
    if (!needsHomeRecover) {
      if (pluginMutation.status === "open" || runningPlan) {
        this.setFailedRecovery("A plugin or plan mutation did not finish. Interrupted work was not replayed or cancelled.");
        this.keepMaintenanceFlag();
        throw new WorkbenchMaintenanceError("workbench/failed");
      }
      this.recovery = {
        restoreCompleted: false,
        upgradeRolledBack: false,
        consistent: true,
        settleInterruptedJobs: false,
        message: "No pending snapshot or upgrade journal. Other interrupted jobs were not evaluated.",
      };
      return;
    }

    this.ports.setMaintenance(true);
    ctx.phase("stop");
    try {
      await this.ports.stopAll();
    } catch (error) {
      this.log("recover stopAll", error);
      this.setFailedRecovery("Owned instances could not be stopped; restore pointers were not changed.");
      throw this.fail(error, "recover");
    }

    ctx.phase("recover");
    let result: Awaited<ReturnType<WorkbenchMaintenancePorts["upgrades"]["recover"]>>;
    try {
      result = await this.ports.upgrades.recover({ receiptPlanId });
    } catch (error) {
      this.log("upgrades.recover", error);
      this.setFailedRecovery("Snapshot or upgrade recovery failed. Diagnostic journals were left in place.");
      throw this.fail(error, "recover");
    }

    const stillPending = this.inspectPendingRestore();
    const stillJournal = this.readUpgradeJournal();
    if (stillPending.status !== "none" || stillJournal.status !== "none") {
      this.setFailedRecovery("Snapshot or upgrade journals are still ambiguous.");
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    const restoredNow = result.restoreCompleted === true && pending.status === "pending";
    if (pluginMutation.status === "open") {
      if (restoredNow) {
        this.clearPluginMutation();
      } else if (result.upgradeRolledBack !== true) {
        this.setFailedRecovery("Upgrade staging was cleared, but plugin mutation evidence is still unresolved.");
        throw new WorkbenchMaintenanceError("workbench/failed");
      }
    }

    if (result.restoreCompleted === true || result.restoreRolledBack === true || result.upgradeRolledBack === true) {
      if (!this.homeConfigReadable()) {
        this.setFailedRecovery("Home configuration could not be read after recovery. Jobs were not settled.");
        throw new WorkbenchMaintenanceError("workbench/failed");
      }
      const recoveredReceipt = result.restoreReceipt;
      const expected = result.restoreRolledBack && recoveredReceipt
        ? this.ports.snapshots.preview(recoveredReceipt.beforeRestoreId).runtimeVersion
        : result.restoreCompleted ? recoveredReceipt?.runtimeVersion ?? expectedRuntimeVersion : undefined;
      this.verifyRecoveredRuntime(expected);
    }

    ctx.phase("reinitialize");
    await this.ports.reinitializeManager();
    this.ports.setMaintenance(false);
    this.recovery = {
      restoreCompleted: result.restoreCompleted === true,
      restoreRolledBack: result.restoreRolledBack === true,
      restorePlanId: result.restoreReceipt?.planId,
      upgradeRolledBack: result.upgradeRolledBack === true,
      consistent: true,
      settleInterruptedJobs: true,
      message: "Pending snapshot or upgrade state was reconciled.",
      snapshotId: result.restoreReceipt?.snapshotId ?? pendingSnapshotId,
      pluginPlanId: restoredNow ? pluginPlanId : undefined,
      upgradePlanId: result.upgradeRolledBack === true ? result.upgradePlanId ?? upgradePlanId : undefined,
    };
  }

  private async buildPlan(request: WorkbenchPlanRequest): Promise<StoredPlan> {
    const createdAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + WORKBENCH_PLAN_TTL_MS).toISOString();
    const id = randomUUID();
    switch (request.kind) {
      case "plugin.install":
        return this.planPluginInstall(id, createdAt, expiresAt, request);
      case "plugin.remove":
        return this.planPluginRemove(id, createdAt, expiresAt, request);
      case "plugin.toggle":
        return this.planPluginToggle(id, createdAt, expiresAt, request);
      case "plugin.cleanup-manager":
        return this.planCleanupManager(id, createdAt, expiresAt, request);
      case "snapshot.create":
        return this.planSnapshotCreate(id, createdAt, expiresAt);
      case "snapshot.restore":
        return this.planSnapshotRestore(id, createdAt, expiresAt, request.snapshotId);
      case "snapshot.delete":
        return this.planSnapshotDelete(id, createdAt, expiresAt, request.snapshotId);
      case "config.restore":
        return this.planConfigRestore(id, createdAt, expiresAt, request);
      case "runtime.install":
        return this.planRuntimeInstall(id, createdAt, expiresAt, request.version);
      case "runtime.upgrade":
        return this.planRuntimeUpgrade(id, createdAt, expiresAt, request.version);
      case "workbench.upgrade":
        return this.planWorkbenchUpgrade(id, createdAt, expiresAt, request);
      default:
        throw new WorkbenchMaintenanceError("workbench/runtime-handoff");
    }
  }

  private async planPluginInstall(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.install" }>,
  ): Promise<StoredPlan> {
    const spaceIds = unique(request.spaceIds.map((spaceId) => this.targetSpace(spaceId, false)));
    if (spaceIds.length === 0) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    const version = requireExactVersion(request.version);
    const entry = await this.resolveNpmCatalog(request.catalogId, version, true);
    const packageName = requirePackageName(entry);
    assertGuardedPackage(packageName);
    const runningSpaceIds = this.runningOf(spaceIds);
    const command: ResolvedCommand = {
      kind: "plugin.install",
      spaceIds,
      catalogId: entry.id,
      packageName,
      version,
    };
    const changes = [
      `Install ${packageName}@${version} into ${spaceIds.join(", ")}.`,
      runningSpaceIds.length
        ? `Stop and restart running workspaces: ${runningSpaceIds.join(", ")}.`
        : "No running workspace needs to stop.",
      "The plugin change is not a hot reload; restart is required.",
      ...(packageName === XP_PACKAGE_NAME && version === XP_SUPPORTED_VERSION ? [XP_EMBED_COMPATIBILITY_NOTE] : []),
    ];
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.install",
      title: `Install ${packageName}@${version}`,
      scope: "space",
      affectedSpaceIds: spaceIds,
      runningSpaceIds,
      changes,
      destructive: false,
      expiresAt,
    });
  }

  private async planPluginRemove(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.remove" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    const packageName = requirePackageName({ packageName: request.packageName, installSpec: request.packageName });
    assertGuardedPackage(packageName);
    if (!this.spaceHasPlugin(spaceId, packageName)) {
      throw new WorkbenchMaintenanceError("workbench/not-found");
    }
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = { kind: "plugin.remove", spaceId, packageName };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.remove",
      title: `Remove ${packageName} from ${spaceId}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        `Remove ${packageName} from ${spaceId}.`,
        runningSpaceIds.length ? `Stop and restart ${spaceId}.` : "Workspace is stopped.",
        "The plugin change is not a hot reload; restart is required.",
      ],
      destructive: true,
      expiresAt,
    });
  }

  private async planPluginToggle(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.toggle" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    const packageName = this.resolveTogglePackage(spaceId, request.pluginId, request.enabled);
    assertGuardedPackage(packageName);
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = {
      kind: "plugin.toggle",
      spaceId,
      pluginId: request.pluginId,
      packageName,
      enabled: request.enabled,
    };
    const action = request.enabled ? "Install" : "Remove";
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.toggle",
      title: `${action} ${packageName} on ${spaceId}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        `${action} ${packageName} on ${spaceId} using the existing install/remove semantics.`,
        runningSpaceIds.length ? `Stop and restart ${spaceId}.` : "Workspace is stopped.",
        "This is not a hot toggle; the workspace must restart to apply the change.",
      ],
      destructive: !request.enabled,
      expiresAt,
    });
  }

  private async planCleanupManager(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "plugin.cleanup-manager" }>,
  ): Promise<StoredPlan> {
    const spaceId = this.targetSpace(request.spaceId, false);
    if (!this.spaceHasPlugin(spaceId, FULL_SPACES_PACKAGE)) {
      throw new WorkbenchMaintenanceError("workbench/not-found");
    }
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = {
      kind: "plugin.cleanup-manager",
      spaceId,
      packageName: FULL_SPACES_PACKAGE,
    };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "plugin.cleanup-manager",
      title: `Remove the management plugin from ${spaceId}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        `Remove ${FULL_SPACES_PACKAGE} from ordinary workspace ${spaceId}.`,
        "User data is not copied or migrated.",
        runningSpaceIds.length ? `Stop and restart ${spaceId}.` : "Workspace is stopped.",
      ],
      destructive: true,
      expiresAt,
    });
  }

  private planSnapshotCreate(id: string, createdAt: string, expiresAt: string): StoredPlan {
    const affectedSpaceIds = this.owned();
    const runningSpaceIds = this.runningOf(affectedSpaceIds);
    const command: ResolvedCommand = { kind: "snapshot.create" };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "snapshot.create",
      title: "Create a whole-home snapshot",
      scope: "home",
      affectedSpaceIds,
      runningSpaceIds,
      changes: [
        "Snapshot the entire Home using the existing snapshot format.",
        "Stop every owned workspace, including the manager.",
        "Other workspaces are not started again after the snapshot.",
        `Current runtime ${this.currentVersionLabel()}.`,
      ],
      destructive: false,
      expiresAt,
    });
  }

  private planSnapshotRestore(id: string, createdAt: string, expiresAt: string, snapshotId: string): StoredPlan {
    const meta = this.requireSnapshot(snapshotId);
    if (meta.runtimeMissing) throw new WorkbenchMaintenanceError("workbench/unsupported");
    const affectedSpaceIds = this.owned();
    const runningSpaceIds = this.runningOf(affectedSpaceIds);
    const command: ResolvedCommand = { kind: "snapshot.restore", snapshotId: meta.id };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "snapshot.restore",
      title: `Restore whole-home snapshot ${meta.id}`,
      scope: "home",
      affectedSpaceIds,
      runningSpaceIds,
      changes: [
        `Restore snapshot ${meta.id} taken at ${meta.createdAt}.`,
        `Runtime ${meta.runtimeVersion}.`,
        "Stop every owned workspace, including the manager, then backup, stage, verify, and swap.",
        "The manager is reinitialized after restore. Other workspaces are not started automatically.",
      ],
      destructive: true,
      expiresAt,
    });
  }

  private planSnapshotDelete(id: string, createdAt: string, expiresAt: string, snapshotId: string): StoredPlan {
    const meta = this.requireSnapshot(snapshotId);
    const pending = this.inspectPendingRestore();
    if (pending.status === "unreadable") throw new WorkbenchMaintenanceError("workbench/failed");
    if (pending.status === "pending") throw new WorkbenchMaintenanceError("workbench/stale");
    const command: ResolvedCommand = { kind: "snapshot.delete", snapshotId: meta.id };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "snapshot.delete",
      title: `Delete snapshot ${meta.id}`,
      scope: "home",
      affectedSpaceIds: [...meta.profiles],
      runningSpaceIds: [],
      changes: [`Delete snapshot ${meta.id} taken at ${meta.createdAt}.`],
      destructive: true,
      expiresAt,
    });
  }

  private planConfigRestore(
    id: string,
    createdAt: string,
    expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "config.restore" }>,
  ): StoredPlan {
    const spaceId = this.targetSpace(request.spaceId, true);
    const backupId = parseBackupId(request.backupId);
    let meta: ConfigBackupMeta;
    try {
      const found = this.ports.diagnostics.get(spaceId).backups.find((row) => row.id === backupId);
      if (!found) throw new WorkbenchMaintenanceError("workbench/not-found");
      meta = found;
    } catch (error) {
      throw this.fail(error, "diagnostics.get", "workbench/not-found");
    }
    const runningSpaceIds = this.runningOf([spaceId]);
    const command: ResolvedCommand = { kind: "config.restore", spaceId, backupId };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "config.restore",
      title: `Restore configuration backup on ${spaceId}`,
      scope: "space",
      affectedSpaceIds: [spaceId],
      runningSpaceIds,
      changes: [
        `Restore configuration backup ${meta.id} created at ${meta.createdAt} on ${spaceId}.`,
        runningSpaceIds.length ? `Stop ${spaceId} before replacing the configuration.` : "Workspace is stopped.",
      ],
      destructive: true,
      expiresAt,
    });
  }

  private async planWorkbenchUpgrade(
    id: string, createdAt: string, expiresAt: string,
    request: Extract<WorkbenchPlanRequest, { kind: "workbench.upgrade" }>,
  ): Promise<StoredPlan> {
    const release = await this.workbenchPackage();
    if (!release || !release.updateAvailable) throw new WorkbenchMaintenanceError("workbench/unsupported");
    if (request.catalogId !== release.id || request.version !== release.version) {
      throw new WorkbenchMaintenanceError("workbench/stale");
    }
    const affectedSpaceIds = this.owned();
    return this.storeable(id, createdAt, expiresAt, { ...request, expectedDigest: release.digest }, {
      kind: "workbench.upgrade", title: `Update workbench to ${release.version}`,
      scope: "home", affectedSpaceIds, runningSpaceIds: this.runningOf(affectedSpaceIds),
      changes: [
        `Update the manager and view bridge from the bundled workbench package ${release.version}.`,
        "Stop all owned instances, including the manager, and create a whole-home snapshot.",
        "A failed update restores the whole Home. Other workspaces are not restarted automatically.",
        "The supervisor entry remains available. Its running program updates on the next cold start.",
      ], destructive: true, expiresAt,
    });
  }

  private planRuntimeInstall(id: string, createdAt: string, expiresAt: string, version: string): StoredPlan {
    const exact = requireExactVersion(version);
    const command: ResolvedCommand = { kind: "runtime.install", version: exact };
    const compatible = this.ports.isCompatibleRuntime(exact);
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "runtime.install",
      title: `Install runtime ${exact}`,
      scope: "home",
      affectedSpaceIds: this.owned(),
      runningSpaceIds: [],
      changes: [
        `Install runtime ${exact} without switching the current runtime.`,
        compatible
          ? "This version is marked compatible."
          : "This version is not marked compatible and remains an unverified candidate.",
      ],
      destructive: false,
      expiresAt,
    });
  }

  private planRuntimeUpgrade(id: string, createdAt: string, expiresAt: string, version: string): StoredPlan {
    const exact = requireExactVersion(version);
    if (!this.ports.isCompatibleRuntime(exact)) {
      throw new WorkbenchMaintenanceError("workbench/unsupported");
    }
    let preview;
    try {
      preview = this.ports.upgrades.preview(exact);
    } catch (error) {
      throw this.fail(error, "upgrades.preview");
    }
    const affectedSpaceIds = this.owned();
    const runningSpaceIds = this.runningOf(affectedSpaceIds);
    const command: ResolvedCommand = { kind: "runtime.upgrade", version: exact };
    return this.storeable(id, createdAt, expiresAt, command, {
      kind: "runtime.upgrade",
      title: `Upgrade runtime to ${exact}`,
      scope: "home",
      affectedSpaceIds,
      runningSpaceIds,
      changes: [
        `Upgrade runtime from ${preview.currentVersion ?? this.currentVersionLabel()} to ${preview.version}.`,
        "Stop every owned workspace, including the manager.",
        "Create a whole-home snapshot, stage, smoke, then commit. Failure rolls back the known snapshot.",
        "Other workspaces are not started automatically after the upgrade.",
      ],
      destructive: true,
      expiresAt,
    });
  }

  private async runPluginInstall(
    command: Extract<ResolvedCommand, { kind: "plugin.install" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ) {
    await this.mutatePlugins(
      command.spaceIds,
      ctx,
      planId,
      command.spaceIds.map((spaceId) => ({
        spaceId,
        action: "install",
        packageName: command.packageName,
        version: command.version,
      })),
      async () => {
        ctx.phase("download");
        ctx.message(`Downloading ${command.packageName}@${command.version}.`);
        const spec = await this.ensureExactNpmLibrary(command.catalogId, command.packageName, command.version);
        this.throwIfAborted(ctx);
        markIrreversible();
        ctx.cancellable(false);
        ctx.phase("install");
        ctx.message(`Installing ${command.packageName}@${command.version}.`);
        for (const spaceId of command.spaceIds) {
          await this.pluginAddImpl(this.ports.home, spaceId, spec);
          if (command.packageName === XP_PACKAGE_NAME && command.version === XP_SUPPORTED_VERSION) {
            applyXpEmbedCompatibility(this.ports.home, spaceId);
          }
        }
      },
    );
  }

  private async runPluginRemove(
    command: Extract<ResolvedCommand, { kind: "plugin.remove" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ) {
    await this.mutatePlugins(
      [command.spaceId],
      ctx,
      planId,
      [{ spaceId: command.spaceId, action: "remove", packageName: command.packageName }],
      async () => {
        markIrreversible();
        ctx.cancellable(false);
        ctx.phase("remove");
        ctx.message(`Removing ${command.packageName}.`);
        await this.pluginRemoveImpl(this.ports.home, command.spaceId, command.packageName);
      },
    );
  }

  private async runPluginToggle(
    command: Extract<ResolvedCommand, { kind: "plugin.toggle" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ) {
    await this.mutatePlugins(
      [command.spaceId],
      ctx,
      planId,
      [
        {
          spaceId: command.spaceId,
          action: command.enabled ? "install" : "remove",
          packageName: command.packageName,
        },
      ],
      async () => {
        markIrreversible();
        ctx.cancellable(false);
        ctx.phase("toggle");
        ctx.message(`${command.enabled ? "Installing" : "Removing"} ${command.packageName}.`);
        await this.setSpacePluginImpl(
          this.ports.home,
          command.spaceId,
          command.pluginId,
          command.enabled,
          (name) => this.ports.statusOf(name) === "running",
        );
      },
    );
  }

  private async runCleanupManager(
    command: Extract<ResolvedCommand, { kind: "plugin.cleanup-manager" }>,
    ctx: WorkbenchJobContext,
    planId: string,
    markIrreversible: () => void,
  ) {
    await this.mutatePlugins(
      [command.spaceId],
      ctx,
      planId,
      [{ spaceId: command.spaceId, action: "remove", packageName: command.packageName }],
      async () => {
        markIrreversible();
        ctx.cancellable(false);
        ctx.phase("cleanup");
        ctx.message(`Removing ${FULL_SPACES_PACKAGE}.`);
        await this.pluginRemoveImpl(this.ports.home, command.spaceId, command.packageName);
      },
    );
  }

  private async mutatePlugins(
    spaceIds: string[],
    ctx: WorkbenchJobContext,
    planId: string,
    expected: PluginMutationExpected[],
    mutate: () => Promise<void>,
  ) {
    const running = this.runningOf(spaceIds);
    ctx.phase("stop");
    ctx.cancellable(true);
    for (const spaceId of running) {
      this.throwIfAborted(ctx);
      await this.ports.stopSpace(spaceId);
    }
    if (ctx.signal.aborted) {
      await this.startRequired(running);
      throw new WorkbenchJobAbortError();
    }
    this.writePluginMutation(planId, spaceIds, expected);
    try {
      await mutate();
      ctx.phase("verify");
      for (const row of expected) verifyPluginReadback(this.ports.home, row);
      this.clearPluginMutation();
    } catch (error) {
      if (error instanceof WorkbenchJobAbortError && this.pluginTargetsUnchanged(spaceIds)) {
        this.clearPluginMutation();
        await this.startRequired(running);
        throw error;
      }
      this.failPluginMutation();
      throw error;
    }
    await this.startRequired(running);
  }

  private async runSnapshotCreate(ctx: WorkbenchJobContext): Promise<WorkbenchJobResult> {
    return this.withMaintenance(ctx, async () => {
      ctx.phase("stop");
      ctx.cancellable(true);
      ctx.message("Stopping owned workspaces.");
      this.throwIfAborted(ctx);
      await this.ports.stopAll();
      this.throwIfAborted(ctx);
      ctx.cancellable(false);
      ctx.phase("snapshot");
      ctx.message("Creating a whole-home snapshot.");
      const meta = await this.ports.snapshots.create(this.ports.currentRuntime(), "workbench");
      ctx.result({ snapshotId: meta.id });
      return { snapshotId: meta.id };
    });
  }

  private async runSnapshotRestore(snapshotId: string, ctx: WorkbenchJobContext, planId: string): Promise<WorkbenchJobResult> {
    return this.withMaintenance(ctx, async () => {
      ctx.phase("stop");
      ctx.cancellable(true);
      ctx.message("Stopping owned workspaces.");
      this.throwIfAborted(ctx);
      await this.ports.stopAll();
      this.throwIfAborted(ctx);
      ctx.cancellable(false);
      ctx.phase("restore");
      ctx.message("Restoring the whole-home snapshot.");
      await this.ports.upgrades.restore(snapshotId, planId);
      ctx.result({ snapshotId });
      return { snapshotId };
    });
  }

  private async runSnapshotDelete(snapshotId: string, ctx: WorkbenchJobContext) {
    ctx.phase("delete");
    ctx.cancellable(false);
    ctx.message("Deleting the snapshot.");
    await this.ports.snapshots.delete(snapshotId);
  }

  private async runConfigRestore(
    command: Extract<ResolvedCommand, { kind: "config.restore" }>,
    ctx: WorkbenchJobContext,
  ) {
    ctx.phase("prepare");
    ctx.cancellable(false);
    ctx.message("Restoring configuration.");
    this.persistProfileEvidence(command.spaceId, "config-restore");
    ctx.phase("restore");
    await this.ports.diagnostics.restoreBackup(command.spaceId, command.backupId);
    if (command.spaceId === this.ports.managerId()) {
      this.ports.setMaintenance(true);
      try {
        ctx.phase("reinitialize");
        await this.ports.reinitializeManager();
        this.ports.setMaintenance(false);
      } catch (error) {
        this.log("reinitializeManager after manager config restore", error);
        throw error;
      }
    }
  }

  private async runRuntimeInstall(version: string, ctx: WorkbenchJobContext): Promise<WorkbenchJobResult> {
    ctx.phase("install");
    ctx.cancellable(true);
    this.throwIfAborted(ctx);
    ctx.cancellable(false);
    ctx.message(`Installing runtime ${version}.`);
    const installed = await this.ports.runtimes.install(version);
    ctx.result({ runtimeVersion: installed.version });
    return { runtimeVersion: installed.version };
  }

  private async runRuntimeUpgrade(version: string, ctx: WorkbenchJobContext, planId: string): Promise<WorkbenchJobResult> {
    if (!this.ports.isCompatibleRuntime(version)) {
      throw new WorkbenchMaintenanceError("workbench/unsupported");
    }
    return this.withMaintenance(ctx, async () => {
      ctx.phase("prepare");
      ctx.cancellable(true);
      this.throwIfAborted(ctx);
      ctx.cancellable(false);
      ctx.message(`Upgrading runtime to ${version}.`);
      const unsubscribe = this.ports.upgrades.onProgress?.(progress => {
        ctx.phase(progress.phase);
        // The phase is a fixed enum; CLI details can contain private paths.
        ctx.message(`Runtime maintenance: ${progress.phase}.`);
      });
      let result;
      try { result = await this.ports.upgrades.upgrade(version, planId); }
      finally { unsubscribe?.(); }
      ctx.phase("done");
      ctx.result({ runtimeVersion: result.version, snapshotId: result.snapshotId });
      return { runtimeVersion: result.version, snapshotId: result.snapshotId };
    });
  }

  private async withMaintenance<T>(ctx: WorkbenchJobContext, action: () => Promise<T>): Promise<T> {
    this.ports.setMaintenance(true);
    try {
      const result = await action();
      ctx.phase("reinitialize");
      ctx.message("Reinitializing the manager.");
      await this.ports.reinitializeManager();
      this.ports.setMaintenance(false);
      return result;
    } catch (error) {
      if (uncertainMaintenance(error)) {
        this.ports.setMaintenance(true);
        throw error;
      }
      if (this.liveHomeConsistent()) {
        try {
          await this.ports.reinitializeManager();
          this.ports.setMaintenance(false);
        } catch (reinitError) {
          this.log("reinitializeManager after consistent failure", reinitError);
        }
      } else {
        this.log("skipping reinitializeManager; live home is not proven consistent", error);
      }
      throw error;
    }
  }

  private async resolveNpmCatalog(catalogId: string, version: string, register: boolean): Promise<PluginCatalogEntry> {
    rejectRawSpec(catalogId);
    let entry = this.findCatalog(catalogId);
    if (!entry && isNpmPackageId(catalogId)) {
      const packument = await this.fetchPackument(catalogId);
      const name = typeof packument.name === "string" && packument.name ? packument.name : catalogId;
      assertVersionInPackument(packument, version);
      entry = npmCatalogEntry(name);
      if (register) this.registerCatalogEntry(entry);
    }
    if (!entry) throw new WorkbenchMaintenanceError("workbench/not-found");
    if (entry.installMethod !== "npm" || isGitSpec(entry.installSpec ?? "") || !isInstallableEntry(entry)) {
      throw new WorkbenchMaintenanceError("workbench/forbidden");
    }
    const packageName = requirePackageName(entry);
    if (!isSafeSpec(packageName) || isGitSpec(packageName)) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    if (lookupCatalogEntry(this.ports.home, entry.id)) {
      try {
        await resolveInstallSpec(this.ports.home, { catalogId: entry.id });
      } catch (error) {
        throw this.fail(error, "resolveInstallSpec");
      }
    }
    const packument = await this.fetchPackument(packageName);
    assertVersionInPackument(packument, version);
    return entry;
  }

  private async ensureExactNpmLibrary(catalogId: string, packageName: string, version: string): Promise<string> {
    const id = `${packageName}@${version}`.toLowerCase();
    const existing = lookupLibraryEntry(this.ports.home, id) ?? lookupLibraryEntry(this.ports.home, packageName);
    if (existing?.tarball && existing.spec === `${packageName}@${version}`) {
      const abs = resolve(this.ports.home, existing.tarball);
      if (isHubPluginArchive(this.ports.home, abs)) return abs;
    }
    const packument = await this.fetchPackument(packageName);
    const tarball = packument.versions?.[version]?.dist?.tarball;
    if (!tarball || !/^https:\/\//i.test(tarball)) {
      throw new WorkbenchMaintenanceError("workbench/not-found");
    }
    const dest = archiveAbsPath(this.ports.home, id);
    const packed = await this.fetchImpl(rewriteTarballUrl(tarball, this.source()));
    if (!packed.ok) throw new WorkbenchMaintenanceError("workbench/failed");
    const bytes = Buffer.from(await packed.arrayBuffer());
    if (bytes.length === 0) throw new WorkbenchMaintenanceError("workbench/failed");
    writeAtomicBin(dest, bytes);
    const entry: PluginLibraryEntry = {
      id,
      spec: `${packageName}@${version}`,
      packageName,
      title: packageName,
      catalogId,
      tarball: archiveRelPath(id),
      source: "catalog",
      downloadedAt: this.now().toISOString(),
    };
    upsertLibraryEntry(this.ports.home, entry);
    return dest;
  }

  private async lookupNpmPackage(name: string): Promise<WorkbenchPlugin | undefined> {
    try {
      const packument = await this.fetchPackument(name);
      const packageName = typeof packument.name === "string" && packument.name ? packument.name : name;
      const latest = packument["dist-tags"]?.latest;
      const version = latest && isExactRuntimeVersion(latest) ? latest : null;
      const description =
        (typeof packument.description === "string" && packument.description) ||
        (version && typeof packument.versions?.[version]?.description === "string"
          ? String(packument.versions[version]?.description)
          : "");
      return publicPlugin({
        id: packageName,
        title: packageName,
        packageName,
        description,
        version,
        installedIn: [],
        protected: isGuardedPackage(packageName),
      });
    } catch (error) {
      this.log("npm lookup", error);
      return undefined;
    }
  }

  private async fetchPackument(name: string): Promise<Packument> {
    const url = npmPackumentUrl(this.source(), name);
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new WorkbenchMaintenanceError("workbench/not-found");
    const json = await response.json();
    if (!json || typeof json !== "object") throw new WorkbenchMaintenanceError("workbench/failed");
    return json as Packument;
  }

  private catalogEntries(): PluginCatalogEntry[] {
    const unique = new Map<string, PluginCatalogEntry>();
    for (const entry of seedCatalog().entries) unique.set(entry.id, entry);
    for (const entry of this.readJsonCatalog(join(this.ports.home, "hub", CATALOG_CACHE_FILE))) {
      unique.set(entry.id, entry);
    }
    for (const entry of this.registeredCatalog()) unique.set(entry.id, entry);
    return [...unique.values()];
  }

  private registeredCatalog(): PluginCatalogEntry[] {
    return this.readJsonCatalog(this.registryPath());
  }

  private findCatalog(id: string): PluginCatalogEntry | undefined {
    const key = id.trim().toLowerCase();
    const registered = this.registeredCatalog();
    const hit =
      registered.find((entry) => entry.id === key || entry.packageName?.toLowerCase() === key) ??
      lookupCatalogEntry(this.ports.home, id) ??
      this.catalogEntries().find((entry) => entry.id === key || entry.packageName?.toLowerCase() === key);
    return hit;
  }

  private registerCatalogEntry(entry: PluginCatalogEntry): void {
    const current = this.registeredCatalog().filter((item) => item.id !== entry.id);
    current.push(entry);
    atomicWrite(
      this.registryPath(),
      `${JSON.stringify({ meta: { schemaVersion: 1, generatedAt: this.now().toISOString(), count: current.length, contentHash: "workbench-registry" }, entries: current }, null, 2)}\n`,
    );
  }

  private readJsonCatalog(path: string): PluginCatalogEntry[] {
    if (!existsSync(path)) return [];
    try {
      return parseAnyCatalog(JSON.parse(readFileSync(path, "utf8"))).entries;
    } catch (error) {
      this.log(`catalog ${path}`, error);
      return [];
    }
  }

  private pluginFromCatalog(entry: PluginCatalogEntry, installed: Record<string, ReturnType<typeof listProfilePlugins>>): WorkbenchPlugin {
    const packageName = entry.packageName || entry.installSpec || entry.id;
    return {
      id: entry.id,
      title: pluginDisplayName(entry),
      packageName,
      description: entry.summaryEn || entry.summary || entry.description,
      version: null,
      installedIn: spacesUsing(installed, packageName, entry.installSpec),
      protected: isGuardedPackage(packageName),
    };
  }

  private pluginFromLibrary(entry: PluginLibraryEntry, installed: Record<string, ReturnType<typeof listProfilePlugins>>): WorkbenchPlugin {
    return {
      id: entry.id,
      title: entry.title || entry.packageName,
      packageName: entry.packageName,
      description: "",
      version: versionFromSpec(entry.spec),
      installedIn: spacesUsing(installed, entry.packageName, entry.spec),
      protected: isGuardedPackage(entry.packageName),
    };
  }

  private installedBySpace(): Record<string, ReturnType<typeof listProfilePlugins>> {
    return listAllProfilePlugins(this.ports.home, this.owned());
  }

  private resolveTogglePackage(spaceId: string, pluginId: string, enabled: boolean): string {
    rejectRawSpec(pluginId);
    const library = lookupLibraryEntry(this.ports.home, pluginId);
    if (library) return library.packageName;
    const catalog = this.findCatalog(pluginId);
    if (catalog?.packageName) return catalog.packageName;
    const installed = listProfilePlugins(this.ports.home, spaceId).find(
      (item) => item.name === pluginId || item.name.toLowerCase() === pluginId.toLowerCase(),
    );
    if (installed) return installed.name;
    if (!enabled) return pluginId;
    throw new WorkbenchMaintenanceError("workbench/not-found");
  }

  private spaceHasPlugin(spaceId: string, packageName: string): boolean {
    return listProfilePlugins(this.ports.home, spaceId).some(
      (item) => item.name === packageName || pluginAliases({ spec: packageName, packageName }).includes(item.name),
    );
  }

  private targetSpace(spaceId: string, allowManager: boolean): string {
    if (typeof spaceId !== "string" || !PROFILE_NAME_RE.test(spaceId)) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    const manager = this.ports.managerId();
    if (!allowManager && manager && spaceId === manager) {
      throw new WorkbenchMaintenanceError("workbench/forbidden");
    }
    try {
      this.ports.validateSpace(spaceId, allowManager);
    } catch (error) {
      this.log("validateSpace", error);
      if (!this.ports.ownedSpaceIds().includes(spaceId)) {
        throw new WorkbenchMaintenanceError("workbench/not-found");
      }
      throw new WorkbenchMaintenanceError("workbench/forbidden");
    }
    return spaceId;
  }

  private owned(): string[] {
    return unique(this.ports.ownedSpaceIds());
  }

  private runningOf(spaceIds: string[]): string[] {
    return spaceIds.filter((id) => {
      const status = this.ports.statusOf(id);
      return status === "running" || status === "starting";
    });
  }

  private currentVersionLabel(): string {
    try {
      const version = this.ports.currentRuntime().version;
      return isExactRuntimeVersion(version) ? version : "unknown";
    } catch {
      return "unknown";
    }
  }

  private requireSnapshot(id: string): SnapshotMeta {
    try {
      return this.ports.snapshots.preview(id);
    } catch (error) {
      throw this.fail(error, "snapshots.preview", "workbench/not-found");
    }
  }

  private storeable(
    id: string,
    createdAt: string,
    expiresAt: string,
    command: ResolvedCommand,
    plan: Omit<WorkbenchPlan, "id">,
  ): StoredPlan {
    const publicPlan: WorkbenchPlan = { id, ...plan };
    return {
      schemaVersion: PLAN_SCHEMA,
      id,
      public: publicPlan,
      command,
      fingerprint: this.fingerprintFor(command),
      createdAt,
      expiresAt,
      status: "previewed",
    };
  }

  private fingerprintFor(command: ResolvedCommand): string {
    const pending = this.inspectPendingRestore();
    if (pending.status === "unreadable") throw new WorkbenchMaintenanceError("workbench/failed");
    const journal = this.readUpgradeJournal();
    if (journal.status === "unreadable") throw new WorkbenchMaintenanceError("workbench/failed");
    const spaces = this.spaceFingerprint(affectedFromCommand(command));
    const payload = {
      command,
      managerId: this.ports.managerId(),
      spaces,
      runtime: this.currentVersionLabel(),
      pendingRestore: pending.status === "pending" ? pending.value?.snapshotId ?? null : null,
      upgradeJournal: journal.status,
      snapshot: "snapshotId" in command ? snapshotFingerprint(this.requireSnapshot(command.snapshotId)) : null,
    };
    return createHash("sha256").update(JSON.stringify(sortKeys(payload))).digest("hex");
  }

  private spaceFingerprint(spaceIds: string[]): unknown {
    const ids = spaceIds.length ? spaceIds : this.owned();
    return ids.map((id) => ({
      id,
      status: this.ports.statusOf(id),
      plugins: listProfilePluginsSafe(this.ports.home, id).map((item) => ({ name: item.name, version: item.version ?? null })),
    }));
  }

  private writePlan(plan: StoredPlan): void {
    atomicWrite(this.planPath(plan.id), `${JSON.stringify(plan)}\n`);
  }

  private readPlan(id: string): StoredPlan {
    if (typeof id !== "string" || !PLAN_ID_RE.test(id)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    const path = this.planPath(id);
    if (!existsSync(path)) throw new WorkbenchMaintenanceError("workbench/not-found");
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredPlan;
      if (parsed.schemaVersion !== PLAN_SCHEMA || parsed.id !== id || !parsed.public || !parsed.command) {
        throw new WorkbenchMaintenanceError("workbench/invalid-input");
      }
      if (!isPlanStatus(parsed.status)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
      if (typeof parsed.createdAt !== "string" || !ISO_DATE_RE.test(parsed.createdAt)) {
        throw new WorkbenchMaintenanceError("workbench/invalid-input");
      }
      if (typeof parsed.expiresAt !== "string" || !ISO_DATE_RE.test(parsed.expiresAt)) {
        throw new WorkbenchMaintenanceError("workbench/invalid-input");
      }
      return parsed;
    } catch (error) {
      if (error instanceof WorkbenchMaintenanceError) throw error;
      throw this.fail(error, "readPlan", "workbench/invalid-input");
    }
  }

  private assertFresh(plan: StoredPlan): void {
    if (typeof plan.expiresAt !== "string" || !ISO_DATE_RE.test(plan.expiresAt)) {
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
    }
    const expires = Date.parse(plan.expiresAt);
    if (!Number.isFinite(expires)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
    if (expires <= this.now().getTime()) throw new WorkbenchMaintenanceError("workbench/expired");
  }

  private markPlan(plan: StoredPlan, status: PlanStatus): void {
    plan.status = status;
    const ts = this.now().toISOString();
    if (status === "running") plan.startedAt = ts;
    if (status === "succeeded" || status === "failed" || status === "cancelled") plan.finishedAt = ts;
    try { this.writePlan(plan); }
    catch (error) {
      this.log("plan settlement persistence", error);
      throw new WorkbenchJobError("workbench/persist-failed");
    }
  }

  private planPath(id: string): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLANS_DIR_NAME, `${id}.json`);
  }

  private registryPath(): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_REGISTRY_FILE);
  }

  private inspectPendingRestore(): {
    status: "none" | "pending" | "unreadable";
    value?: ReturnType<WorkbenchMaintenancePorts["snapshots"]["pendingRestore"]>;
    error?: unknown;
  } {
    try {
      const pending = this.ports.snapshots.pendingRestore() ?? this.ports.snapshots.restoreJournal?.();
      return pending ? { status: "pending", value: pending } : { status: "none" };
    } catch (error) {
      this.log("pendingRestore", error);
      return { status: "unreadable", error };
    }
  }

  private resetRecoveryOutcome(): void {
    this.recovery = {
      restoreCompleted: false,
      upgradeRolledBack: false,
      consistent: false,
      settleInterruptedJobs: false,
      message: "",
    };
  }

  private setFailedRecovery(message: string): void {
    this.recovery = {
      restoreCompleted: false,
      upgradeRolledBack: false,
      consistent: false,
      settleInterruptedJobs: false,
      message,
    };
  }

  private keepMaintenanceFlag(): void {
    try {
      this.ports.setMaintenance(true);
    } catch (error) {
      this.log("setMaintenance", error);
    }
  }

  private liveHomeConsistent(): boolean {
    const pending = this.inspectPendingRestore();
    const journal = this.readUpgradeJournal();
    return pending.status === "none" && journal.status === "none";
  }

  private pluginMutationPath(): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILE);
  }

  private pluginMutationFilesDir(): string {
    return join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILES_DIR);
  }

  private writePluginMutation(planId: string, spaceIds: string[], expected: PluginMutationExpected[]): void {
    if (this.readPluginMutation().status !== "none") {
      throw new WorkbenchMaintenanceError("workbench/conflict");
    }
    const filesRoot = this.pluginMutationFilesDir();
    for (const spaceId of spaceIds) this.copyProfileEvidence(spaceId, join(filesRoot, spaceId));
    const journal: PluginMutationJournal = {
      schemaVersion: 1,
      phase: "prepared",
      planId,
      spaceIds,
      expected,
      startedAt: this.now().toISOString(),
    };
    atomicWrite(this.pluginMutationPath(), `${JSON.stringify(journal, null, 2)}\n`);
  }

  private failPluginMutation(): void {
    const path = this.pluginMutationPath();
    if (!existsSync(path)) return;
    try {
      const journal = JSON.parse(readFileSync(path, "utf8")) as PluginMutationJournal;
      journal.phase = "failed";
      atomicWrite(path, `${JSON.stringify(journal, null, 2)}\n`);
    } catch (error) {
      this.log("failPluginMutation", error);
    }
  }

  private clearPluginMutation(): void {
    const path = this.pluginMutationPath();
    if (existsSync(path)) rmSync(path, { force: true });
    const files = this.pluginMutationFilesDir();
    if (existsSync(files)) rmSync(files, { recursive: true, force: true });
  }

  private readPluginMutation(): { status: "none" | "open" | "unreadable"; planId?: string } {
    const path = this.pluginMutationPath();
    if (!existsSync(path)) return { status: "none" };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PluginMutationJournal;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.spaceIds)) return { status: "unreadable" };
      if (parsed.phase === "prepared" || parsed.phase === "mutating" || parsed.phase === "failed") {
        return {
          status: "open",
          planId: typeof parsed.planId === "string" && parsed.planId.trim() ? parsed.planId : undefined,
        };
      }
      return { status: "unreadable" };
    } catch {
      return { status: "unreadable" };
    }
  }

  private homeConfigReadable(): boolean {
    return (
      containedHomeEntry(this.ports.home, ["settings.yaml"], "file") ||
      containedHomeEntry(this.ports.home, ["profiles"], "dir") ||
      containedHomeEntry(this.ports.home, ["hub", "spaces.json"], "file")
    );
  }

  private verifyRecoveredRuntime(expectedVersion?: string): void {
    let current: { version?: string } | undefined;
    try {
      current = this.ports.currentRuntime();
    } catch (error) {
      this.log("currentRuntime after recover", error);
      this.setFailedRecovery("The current runtime pointer could not be read after recovery. Jobs were not settled.");
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    if (!current?.version) {
      this.setFailedRecovery("The current runtime pointer is missing after recovery. Jobs were not settled.");
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    if (expectedVersion && current.version !== expectedVersion) {
      this.setFailedRecovery("Runtime pointer did not match the restored snapshot.");
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
  }

  private pluginTargetsUnchanged(spaceIds: string[]): boolean {
    const root = this.pluginMutationFilesDir();
    for (const spaceId of spaceIds) {
      const liveDir = join(this.ports.home, "profiles", spaceId);
      const evidenceDir = join(root, spaceId);
      for (const name of PROFILE_FILE_NAMES) {
        const live = join(liveDir, name);
        const evidence = join(evidenceDir, name);
        const liveExists = existsSync(live);
        const evidenceExists = existsSync(evidence);
        if (liveExists !== evidenceExists) return false;
        if (liveExists && readFileSync(live, "utf8") !== readFileSync(evidence, "utf8")) return false;
      }
    }
    return true;
  }

  private persistProfileEvidence(spaceId: string, reason: string): void {
    this.copyProfileEvidence(spaceId, join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, "config-evidence", reason, spaceId));
  }

  private copyProfileEvidence(spaceId: string, destDir: string): void {
    const srcDir = join(this.ports.home, "profiles", spaceId);
    mkdirSync(destDir, { recursive: true });
    for (const name of PROFILE_FILE_NAMES) {
      const src = join(srcDir, name);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(destDir, name));
    }
  }

  private hasRunningPlan(): boolean {
    const dir = join(this.ports.home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLANS_DIR_NAME);
    if (!existsSync(dir)) return false;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as { status?: unknown };
        if (parsed.status === "running") return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  private readUpgradeJournal(): {
    status: "none" | "preparing" | "committing" | "unreadable" | "unknown";
    planId?: string;
    error?: unknown;
  } {
    const path = join(this.ports.home, UPGRADE_STAGE_DIR, UPGRADE_JOURNAL_FILE);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile()) return { status: "unreadable" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
      return { status: "unreadable", error };
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { phase?: unknown; planId?: unknown };
      if (parsed.phase !== "preparing" && parsed.phase !== "committing") return { status: "unknown" };
      const planId = typeof parsed.planId === "string" && PLAN_ID_RE.test(parsed.planId) ? parsed.planId : undefined;
      return { status: parsed.phase, planId };
    } catch (error) {
      return { status: "unreadable", error };
    }
  }

  private async startRequired(spaceIds: string[]): Promise<void> {
    for (const spaceId of spaceIds) {
      await this.ports.startSpace(spaceId);
    }
  }

  private throwIfAborted(ctx: WorkbenchJobContext): void {
    if (ctx.signal.aborted) throw new WorkbenchJobAbortError();
  }

  private log(message: string, error?: unknown): void {
    this.logImpl?.(message, error);
  }

  private fail(error: unknown, op: string, code: WorkbenchMaintenanceErrorCode = "workbench/failed"): never {
    if (error instanceof ProcessTerminationError) throw new WorkbenchJobError("workbench/recovery-required");
    if (error instanceof WorkbenchJobError) throw error;
    if (error instanceof WorkbenchMaintenanceError || error instanceof WorkbenchJobAbortError) throw error;
    this.log(op, error);
    throw new WorkbenchMaintenanceError(code);
  }
}

function uncertainMaintenance(error: unknown): boolean {
  return error instanceof ProcessTerminationError || error instanceof WorkbenchJobError &&
    (error.code === "workbench/persist-failed" || error.code === "workbench/recovery-required");
}

function parsePlanRequest(input: unknown): WorkbenchPlanRequest {
  if (!isPlainObject(input)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  const kind = input.kind;
  switch (kind) {
    case "space.stop":
    case "space.restart": {
      expectKeys(input, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceId(input.spaceId) };
    }
    case "space.delete": {
      expectKeys(input, ["kind", "spaceId", "removeData"]);
      if (typeof input.removeData !== "boolean") throw new WorkbenchMaintenanceError("workbench/invalid-input");
      return { kind, spaceId: parseSpaceId(input.spaceId), removeData: input.removeData };
    }
    case "plugin.install": {
      expectKeys(input, ["kind", "spaceIds", "catalogId", "version"]);
      return {
        kind,
        spaceIds: parseSpaceIds(input.spaceIds),
        catalogId: parseCatalogId(input.catalogId),
        version: requireExactVersion(input.version),
      };
    }
    case "plugin.remove": {
      expectKeys(input, ["kind", "spaceId", "packageName"]);
      return { kind, spaceId: parseSpaceId(input.spaceId), packageName: parsePackageName(input.packageName) };
    }
    case "plugin.toggle": {
      expectKeys(input, ["kind", "spaceId", "pluginId", "enabled"]);
      if (typeof input.enabled !== "boolean") throw new WorkbenchMaintenanceError("workbench/invalid-input");
      return {
        kind,
        spaceId: parseSpaceId(input.spaceId),
        pluginId: parseCatalogId(input.pluginId),
        enabled: input.enabled,
      };
    }
    case "plugin.cleanup-manager": {
      expectKeys(input, ["kind", "spaceId"]);
      return { kind, spaceId: parseSpaceId(input.spaceId) };
    }
    case "snapshot.create": {
      expectKeys(input, ["kind"]);
      return { kind };
    }
    case "snapshot.restore":
    case "snapshot.delete": {
      expectKeys(input, ["kind", "snapshotId"]);
      return { kind, snapshotId: parseSnapshotId(input.snapshotId) };
    }
    case "config.restore": {
      expectKeys(input, ["kind", "spaceId", "backupId"]);
      return { kind, spaceId: parseSpaceId(input.spaceId), backupId: parseBackupId(input.backupId) };
    }
    case "runtime.install":
    case "runtime.upgrade": {
      expectKeys(input, ["kind", "version"]);
      return { kind, version: requireExactVersion(input.version) };
    }
    case "workbench.upgrade": {
      expectKeys(input, ["kind", "catalogId", "version"]);
      if (input.catalogId !== "bundled-workbench") throw new WorkbenchMaintenanceError("workbench/invalid-input");
      return { kind, catalogId: "bundled-workbench", version: requireExactVersion(input.version) };
    }
    case "controller.release":
    case "controller.shutdown": {
      expectKeys(input, ["kind"]);
      return { kind };
    }
    default:
      throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
}

function requestFromCommand(command: ResolvedCommand): WorkbenchPlanRequest {
  switch (command.kind) {
    case "plugin.install":
      return { kind: command.kind, spaceIds: command.spaceIds, catalogId: command.catalogId, version: command.version };
    case "plugin.remove":
      return { kind: command.kind, spaceId: command.spaceId, packageName: command.packageName };
    case "plugin.toggle":
      return { kind: command.kind, spaceId: command.spaceId, pluginId: command.pluginId, enabled: command.enabled };
    case "plugin.cleanup-manager":
      return { kind: command.kind, spaceId: command.spaceId };
    case "snapshot.create":
      return { kind: command.kind };
    case "snapshot.restore":
    case "snapshot.delete":
      return { kind: command.kind, snapshotId: command.snapshotId };
    case "config.restore":
      return { kind: command.kind, spaceId: command.spaceId, backupId: command.backupId };
    case "runtime.install":
    case "runtime.upgrade":
      return { kind: command.kind, version: command.version };
    case "workbench.upgrade":
      return { kind: command.kind, catalogId: command.catalogId, version: command.version };
  }
}

function affectedFromCommand(command: ResolvedCommand): string[] {
  switch (command.kind) {
    case "plugin.install":
      return command.spaceIds;
    case "plugin.remove":
    case "plugin.toggle":
    case "plugin.cleanup-manager":
    case "config.restore":
      return [command.spaceId];
    default:
      return [];
  }
}

function parseSpaceId(value: unknown): string {
  if (typeof value !== "string" || !PROFILE_NAME_RE.test(value)) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  return value;
}

function parseSpaceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  return unique(value.map(parseSpaceId));
}

function parseCatalogId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 214 || !CATALOG_ID_RE.test(value.trim())) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  rejectRawSpec(value);
  return value.trim();
}

function parsePackageName(value: unknown): string {
  if (typeof value !== "string" || !isNpmPackageId(value) || !isSafeSpec(value)) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  rejectRawSpec(value);
  return value;
}

function parseSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 80 || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  return value;
}

function parseBackupId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(BACKUP_FILE_PREFIX) || value !== value.split(/[/\\]/).pop()) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  return value;
}

function requireExactVersion(value: unknown): string {
  if (typeof value !== "string" || !isExactRuntimeVersion(value)) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  return value;
}

function requirePackageName(entry: { packageName?: string; installSpec?: string }): string {
  const name = entry.packageName || entry.installSpec;
  if (!name || !isNpmPackageId(name) || isGitSpec(name)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  return name;
}

function assertGuardedPackage(packageName: string): void {
  if (isGuardedPackage(packageName) || isProtectedPlugin(packageName)) {
    throw new WorkbenchMaintenanceError("workbench/forbidden");
  }
}

function isGuardedPackage(packageName: string): boolean {
  return PROTECTED_PACKAGES.has(packageName);
}

function isNpmPackageId(value: string): boolean {
  return value.length > 0 && value.length <= 214 && NPM_NAME_RE.test(value) && !value.startsWith(".") && !value.includes("\\");
}

function rejectRawSpec(value: string): void {
  const lower = value.toLowerCase();
  if (
    lower.includes("file:") ||
    lower.includes("git+") ||
    lower.includes("github:") ||
    lower.includes("http:") ||
    lower.includes("https:") ||
    lower.includes("\\\\") ||
    value.includes("..") ||
    value.includes(";") ||
    value.includes("|") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\")
  ) {
    throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
}

function expectKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
  for (const key of required) {
    if (!(key in value)) throw new WorkbenchMaintenanceError("workbench/invalid-input");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function sameResolved(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function containedHomeEntry(home: string, parts: string[], kind: "file" | "dir"): boolean {
  let current = home;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) return false;
    const next = join(current, part);
    try {
      const st = lstatSync(next);
      if (st.isSymbolicLink()) return false;
      current = next;
    } catch {
      return false;
    }
  }
  try {
    const st = lstatSync(current);
    if (kind === "file") {
      if (!st.isFile()) return false;
      readFileSync(current, "utf8");
    } else if (!st.isDirectory()) {
      return false;
    }
    const real = realpathSync(current);
    const root = resolve(home);
    const prefix = root.endsWith(sep) ? root : root + sep;
    return sameResolved(real, current) && (sameResolved(real, root) || real.toLowerCase().startsWith(prefix.toLowerCase()));
  } catch {
    return false;
  }
}

function publicPlugin(row: WorkbenchPlugin): WorkbenchPlugin {
  return {
    id: row.id,
    title: row.title,
    packageName: row.packageName,
    description: row.description,
    version: row.version,
    installedIn: [...row.installedIn],
    protected: row.protected,
  };
}

function publicSnapshot(meta: SnapshotMeta): WorkbenchSnapshot {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    reason: meta.reason,
    runtimeVersion: meta.runtimeVersion,
    spaceIds: [...meta.profiles],
    bytes: meta.size,
    restorable: meta.runtimeMissing !== true,
  };
}

function publicBackup(meta: ConfigBackupMeta): WorkbenchBackup {
  return { id: meta.id, createdAt: meta.createdAt, reason: "configuration" };
}

function snapshotFingerprint(meta: SnapshotMeta): unknown {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    runtimeVersion: meta.runtimeVersion,
    profiles: meta.profiles,
    size: meta.size,
    restorable: meta.runtimeMissing !== true,
  };
}

function spacesUsing(
  installed: Record<string, ReturnType<typeof listProfilePlugins>>,
  packageName: string,
  spec?: string,
): string[] {
  const names = new Set(pluginAliases({ packageName, spec: spec || packageName }));
  return Object.entries(installed)
    .filter(([, list]) => list.some((item) => names.has(item.name)))
    .map(([name]) => name);
}

function listProfilePluginsSafe(home: string, name: string): ReturnType<typeof listProfilePlugins> {
  try {
    return listProfilePlugins(home, name);
  } catch {
    return [];
  }
}

function versionFromSpec(spec: string): string | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const version = spec.slice(at + 1);
  return isExactRuntimeVersion(version) ? version : null;
}

function npmCatalogEntry(packageName: string): PluginCatalogEntry {
  const scoped = packageName.startsWith("@");
  const [owner, repo] = scoped ? packageName.slice(1).split("/") : ["npm", packageName];
  return {
    id: packageName.toLowerCase(),
    repo: repo || packageName,
    owner: owner || "npm",
    url: `https://www.npmjs.com/package/${packageName}`,
    tier: "verified-npm",
    packageName,
    installMethod: "npm",
    installSpec: packageName,
    runsBuildScript: false,
    description: packageName,
    tags: [],
    stars: 0,
    hasClient: false,
  };
}

function assertVersionInPackument(packument: Packument, version: string): void {
  const tarball = packument.versions?.[version]?.dist?.tarball;
  if (typeof tarball !== "string" || !tarball) throw new WorkbenchMaintenanceError("workbench/not-found");
}

function rewriteTarballUrl(url: string, source: PackageSource): string {
  if (source !== "china") return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "registry.npmjs.org" || parsed.hostname.endsWith(".npmjs.org")) {
      parsed.protocol = "https:";
      parsed.hostname = "registry.npmmirror.com";
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

function writeAtomicBin(file: string, contents: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return value === "previewed" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function verifyPluginReadback(home: string, expected: PluginMutationExpected): void {
  const plugins = listProfilePlugins(home, expected.spaceId);
  const hit = plugins.find((item) => item.name === expected.packageName);
  const manifestPath = join(home, "profiles", expected.spaceId, "package.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> })
    : { dependencies: {} };
  const lockPath = ["pnpm-lock.yaml", "pnpm-lock.yml"]
    .map((name) => join(home, "profiles", expected.spaceId, name))
    .find((path) => existsSync(path));
  const installedPath = join(home, "profiles", expected.spaceId, "node_modules", ...expected.packageName.split("/"), "package.json");
  if (expected.action === "install") {
    if (!hit) throw new WorkbenchMaintenanceError("workbench/failed");
    const declared = manifest.dependencies?.[expected.packageName];
    const fromOwnedArchive = typeof declared === "string" && declared.startsWith("file:") &&
      isHubPluginArchive(home, resolve(home, "profiles", expected.spaceId, declared.slice(5)));
    if (!declared || (expected.version && declared !== expected.version && !fromOwnedArchive)) {
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    if (!existsSync(installedPath) || !lockPath) throw new WorkbenchMaintenanceError("workbench/failed");
    const installed = JSON.parse(readFileSync(installedPath, "utf8")) as { name?: string; version?: string };
    if (installed.name !== expected.packageName || !installed.version || !isExactRuntimeVersion(installed.version) ||
      (expected.version && installed.version !== expected.version)) {
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    const lock = parseYaml(readFileSync(lockPath, "utf8"));
    const entry = lock?.importers?.["."]?.dependencies?.[expected.packageName];
    if (!entry || entry.specifier !== declared || typeof entry.version !== "string" || !entry.version) {
      throw new WorkbenchMaintenanceError("workbench/failed");
    }
    return;
  }
  if (hit || manifest.dependencies?.[expected.packageName]) throw new WorkbenchMaintenanceError("workbench/failed");
  if (lockPath && parseYaml(readFileSync(lockPath, "utf8"))?.importers?.["."]?.dependencies?.[expected.packageName]) {
    throw new WorkbenchMaintenanceError("workbench/failed");
  }
}

async function defaultFetcher(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: init?.headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function silentJobContext(): WorkbenchJobContext {
  return {
    signal: new AbortController().signal,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}

export type { WorkbenchJob, WorkbenchJobContext, WorkbenchJobResult };
