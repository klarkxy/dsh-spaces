import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  HomeControlBusyError,
  HomeController,
  defaultPidAlive,
} from "../../../src/adapters/node/home-controller.ts";
import {
  HomeLockBusyError,
  HomeOperationLock,
} from "../../../src/adapters/node/home-operation-lock.ts";
import {
  WORKBENCH_CONTROL_DIR_NAME,
  WORKBENCH_JOBS_DIR_NAME,
  WorkbenchJobError,
  WorkbenchJobStore,
} from "../../../src/adapters/node/workbench-jobs.ts";
import { atomicWrite } from "../../../src/main/atomic.ts";
import { WorkbenchPackageUpgrade, type WorkbenchPackageRecovery } from "../../../src/adapters/node/workbench-package-upgrade.ts";
import { CoordinatedUpgrade } from "../../../src/main/coordinated-upgrade.ts";
import { describeRuntime } from "../../../src/main/runtime-descriptor.ts";
import { RuntimeStore, type RunProcessFn } from "../../../src/main/runtime-store.ts";
import { SnapshotStore } from "../../../src/main/snapshot-store.ts";
import { SNAPSHOT_ID_RE, type SnapshotMeta } from "../../../src/shared/snapshots.ts";
import { PROFILE_NAME_RE } from "../../../src/shared/types.ts";
import {
  CONTROL_PLANS_DIR,
  DOCTOR_CONTROL_KIND,
  EXIT,
  Fail,
  PLUGIN_MUTATION_ARCHIVE_DIR,
  PLUGIN_MUTATION_FILE,
  containedPath,
  fail,
  inspectNamedDir,
  inspectNamedFile,
  lexists,
  print,
  type Json,
} from "./common.ts";
import {
  findingsFromInspect,
  publicControl,
  publicLock,
  readInstances,
  readJobs,
  readManager,
  readMutationJournal,
  readPlans,
  readPluginMutation,
  readPluginMutationRecord,
  readRestoreJournal,
  readUpgradeJournal,
  type InstanceRow,
} from "./inspect.ts";
import {
  assertToolIndependent,
  requireWriteResources,
  resolveResources,
  syncHomeToolchain,
  verifyBoundRuntime,
  type BoundCli,
  type ResolvedResources,
} from "./resources.ts";

function spawnVersionProbe(): RunProcessFn {
  return async (command, args, options) => {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        env: options?.env ?? process.env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        child.kill();
      }, options?.timeoutMs ?? 20_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectRun(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveRun({ code: code ?? 1, stdout, stderr });
      });
    });
  };
}

function listProfiles(home: string): string[] {
  const dir = join(home, "profiles");
  if (inspectNamedDir(dir) !== "ok") return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => name === "web" || PROFILE_NAME_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

function snapshotImpact(meta?: SnapshotMeta): Json {
  if (!meta) {
    return {
      replaces: ["profiles", "sessions", "storages", "hub", "settings.yaml", "cordis.patch.yml"],
      preserves: [".credentials.yaml", ".anonymous-user-id", ".dsh-spaces-control"],
    };
  }
  return {
    snapshotId: meta.id,
    runtimeVersion: meta.runtimeVersion,
    profiles: meta.profiles,
    presence: meta.presence,
    reason: meta.reason,
    replaces: ["profiles", "sessions", "storages", "hub", "settings.yaml", "cordis.patch.yml"],
    preserves: [".credentials.yaml", ".anonymous-user-id", ".dsh-spaces-control"],
    createsBeforeRestore: true,
  };
}

function journalsUnknown(home: string): string | undefined {
  const restore = readRestoreJournal(home);
  if (restore.unreadable) return "A restore journal is unreadable. Original bytes were left in place.";
  const upgrade = readUpgradeJournal(home);
  if (upgrade.unreadable) return "An upgrade journal is unreadable or uses an unknown phase. Original bytes were left in place.";
  const plugin = readPluginMutation(home);
  if (plugin.unreadable) return "Plugin-mutation evidence is unreadable and was not cleared.";
  const mutation = readMutationJournal(home);
  if (mutation && mutation.unreadable) return "A space mutation journal is unreadable and was not cleared.";
  return undefined;
}

function hasPendingHomeWork(home: string): boolean {
  const restore = readRestoreJournal(home);
  const upgrade = readUpgradeJournal(home);
  return restore.needed === true || upgrade.needed === true;
}

function hasWorkbenchPackageWork(home: string): boolean {
  return lexists(join(home, WORKBENCH_CONTROL_DIR_NAME, "workbench-upgrade.json"));
}

/** Inspect identities without constructing the job store, which persists crash classification. */
function unfinishedPlanIds(home: string): string[] {
  const dir = containedPath(home, [WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME], "dir");
  if (!dir) return [];
  const ids = new Set<string>();
  for (const name of readdirSync(dir).filter(name => name.endsWith(".json"))) {
    const path = containedPath(home, [WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, name], "file");
    if (!path) continue;
    try {
      const row = JSON.parse(readFileSync(path, "utf8"));
      if (row.schemaVersion !== 1 || row.kind !== "plan.execute" || !["queued", "running", "recovery-required"].includes(row.status)) continue;
      const planId = readJobPlanId(home, name.slice(0, -5));
      if (planId) ids.add(planId);
    } catch { /* Unreadable jobs are left for the normal diagnostic path. */ }
  }
  return [...ids];
}

function pluginMutationOpen(home: string): boolean {
  const plugin = readPluginMutation(home);
  return plugin.present === true && plugin.unreadable !== true;
}

async function reclaimDeadControl(controller: HomeController): Promise<void> {
  const inspect = controller.inspect();
  if (!inspect.held) return;
  if ("owner" in inspect && inspect.liveness === "dead") {
    const result = controller.reclaimDead();
    if (!result.reclaimed) {
      throw fail(EXIT.lock, "LOCK_HELD", "Dead control ownership could not be reclaimed.", {
        reason: result.reason,
      });
    }
    return;
  }
  if ("reclaim" in inspect && inspect.reclaim) {
    throw fail(EXIT.lock, "LOCK_HELD", "Home run-control is being reclaimed and was not stolen.");
  }
  if ("ambiguous" in inspect && inspect.ambiguous) {
    throw fail(EXIT.lock, "LOCK_HELD", "Home run-control is ambiguous and was not stolen.");
  }
  if ("incomplete" in inspect && inspect.incomplete) {
    throw fail(EXIT.lock, "LOCK_HELD", "Home run-control is incomplete and was not stolen.");
  }
  throw fail(EXIT.lock, "LOCK_HELD", "Home run-control is held by a live process and was not stolen.");
}

function reclaimDeadLock(lock: HomeOperationLock): void {
  const inspect = lock.inspect();
  if (!inspect.held) return;
  const result = lock.unlockDead();
  if (result.unlocked || result.reason === "not-held") return;
  throw fail(EXIT.lock, "LOCK_HELD", "The home lock is held or ambiguous and was not stolen.", {
    reason: result.reason,
  });
}

function reclaimDeadInstances(rows: InstanceRow[]): { reclaimed: number; blocked: boolean } {
  let reclaimed = 0;
  for (const row of rows) {
    if (row.liveness === "dead" && row.schema === "ok" && row.pid && row.startedAt) {
      const again = defaultPidAlive(row.pid, row.startedAt);
      if (again !== "dead") {
        return { reclaimed, blocked: true };
      }
      try {
        unlinkSync(row.path);
        reclaimed += 1;
      } catch {
        return { reclaimed, blocked: true };
      }
      continue;
    }
    if (row.liveness !== "dead") {
      return { reclaimed, blocked: true };
    }
  }
  return { reclaimed, blocked: false };
}

function makeUpgrade(input: {
  home: string;
  snapshots: SnapshotStore;
  runtimes: RuntimeStore;
  cli: BoundCli;
}): CoordinatedUpgrade {
  return new CoordinatedUpgrade({
    home: input.home,
    profiles: () => listProfiles(input.home),
    stopAll: async () => {
      /* Offline CLI never starts instances; live leftovers already refused. */
    },
    drainPlugins: async () => {
      /* No DSH service in standalone doctor. */
    },
    snapshots: input.snapshots,
    runtimes: input.runtimes,
    runtimeDescriptor: () => describeRuntime({ bin: input.cli.bin, version: input.cli.version }),
  });
}

function makeStores(home: string, snapshotRoot: string, runtimeRoot: string): {
  snapshots: SnapshotStore;
  runtimes: RuntimeStore;
} {
  const snapshots = new SnapshotStore({ home, root: snapshotRoot });
  const runtimes = new RuntimeStore({
    root: runtimeRoot,
    snapshotRoot,
    source: () => "official",
    legacy: () => undefined,
    run: spawnVersionProbe(),
  });
  return { snapshots, runtimes };
}

function readJobPlanId(home: string, jobId: string): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_JOBS_DIR_NAME, `${jobId}.json`), "utf8"),
    ) as { command?: { planId?: unknown } };
    return typeof parsed.command?.planId === "string" ? parsed.command.planId : undefined;
  } catch {
    return undefined;
  }
}

function homeConfigReadable(home: string): boolean {
  return Boolean(
    containedPath(home, ["settings.yaml"], "file") ||
      containedPath(home, ["profiles"], "dir") ||
      containedPath(home, ["hub", "spaces.json"], "file"),
  );
}

function remainingReasons(remaining: Json[]): string[] {
  return remaining.map((row) => {
    if (row.reason === "unreadable") return "An unreadable job record was left in place.";
    if (row.kind === "plan.execute") return "A running plan has no matching restore evidence.";
    return "A workbench job still requires recovery.";
  });
}

function markHandledPlan(home: string, planId: string, status: "succeeded" | "failed" | "cancelled"): void {
  const path = join(home, WORKBENCH_CONTROL_DIR_NAME, CONTROL_PLANS_DIR, `${planId}.json`);
  if (inspectNamedFile(path) !== "ok") return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || parsed.id !== planId) return;
    parsed.status = status;
    parsed.finishedAt = new Date().toISOString();
    atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    /* keep original plan bytes */
  }
}

function archivePluginMutation(home: string): boolean {
  const live = join(home, WORKBENCH_CONTROL_DIR_NAME, PLUGIN_MUTATION_FILE);
  if (inspectNamedFile(live) !== "ok") return false;
  const dir = join(home, WORKBENCH_CONTROL_DIR_NAME, PLUGIN_MUTATION_ARCHIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `plugin-mutation-${Date.now()}.json`);
  try {
    copyFileSync(live, dest);
    unlinkSync(live);
    return true;
  } catch {
    return lexists(dest) && !lexists(live);
  }
}

function requireVerifiedRuntime(
  runtimes: RuntimeStore,
  expectedVersion?: string,
): { bin: string; version: string } {
  let current;
  try {
    current = runtimes.current();
  } catch {
    throw fail(
      EXIT.recovery,
      "RUNTIME_UNREADABLE",
      "The current runtime pointer could not be read after recovery. Jobs were not settled.",
    );
  }
  if (!current?.bin || !current.version) {
    throw fail(
      EXIT.recovery,
      "RUNTIME_UNREADABLE",
      "The current runtime pointer is missing after recovery. Jobs were not settled.",
    );
  }
  const verified = verifyBoundRuntime(current.bin, current.version);
  if (expectedVersion && verified.version !== expectedVersion) {
    throw fail(EXIT.recovery, "RUNTIME_MISMATCH", "Runtime pointer did not match the restored snapshot.");
  }
  return verified;
}

async function settleJobs(home: string, outcome: {
  restoreCompleted: boolean;
  restoreRolledBack?: boolean;
  restorePlanId?: string;
  upgradeRolledBack: boolean;
  upgradePlanId?: string;
  wholeHomeRolledBack: boolean;
  snapshotId?: string;
  pluginPlanId?: string;
  workbench?: WorkbenchPackageRecovery;
}): Promise<{ settled: Json[]; remaining: Json[]; unreadableStore: boolean }> {
  let store: WorkbenchJobStore;
  try {
    store = new WorkbenchJobStore({ home });
  } catch (error) {
    if (error instanceof WorkbenchJobError) {
      return {
        settled: [],
        remaining: [{ reason: "unreadable", kind: "unknown", status: "recovery-required" }],
        unreadableStore: true,
      };
    }
    throw error;
  }
  const plans = readPlans(home);
  const settled: Json[] = [];
  const remaining: Json[] = [];
  for (const job of store.list()) {
    if (job.status !== "recovery-required") continue;

    if (job.phase === "queued") {
      try {
        const updated = await store.settleRecovery(job.id, {
          status: "cancelled",
          message: "Cancelled by offline doctor recovery; the job had not started.",
        });
        settled.push({ id: updated.id, status: updated.status, kind: updated.kind });
      } catch {
        remaining.push({ kind: job.kind, status: job.status, phase: job.phase, reason: "unreadable" });
      }
      continue;
    }

    const planId = job.kind === "plan.execute" ? readJobPlanId(home, job.id) : undefined;
    const plan = planId ? plans.find((row) => row.id === planId) : undefined;
    let settlement: { status: "succeeded" | "failed" | "cancelled"; message: string } | undefined;
    if (job.kind === "plan.execute" && plan?.kind === "workbench.upgrade" && outcome.workbench && outcome.workbench.planId === planId) {
      settlement = outcome.workbench.outcome === "succeeded"
        ? { status: "succeeded", message: "Workbench package update completed; its receipt was verified by doctor." }
        : { status: "failed", message: "Workbench package update was rolled back or abandoned by doctor." };
    } else if (
      job.kind === "plan.execute" &&
      plan?.kind === "snapshot.restore" &&
      (outcome.restoreCompleted || outcome.restoreRolledBack) &&
      outcome.restorePlanId === planId &&
      typeof outcome.snapshotId === "string" &&
      plan.snapshotId === outcome.snapshotId
    ) {
      settlement = outcome.restoreRolledBack
        ? { status: "failed", message: "Interrupted whole-home restore was rolled back by offline doctor." }
        : { status: "succeeded", message: "Whole-home restore completed by offline doctor." };
    } else if (
      job.kind === "plan.execute" &&
      plan?.kind === "runtime.upgrade" &&
      outcome.upgradeRolledBack &&
      outcome.upgradePlanId === planId
    ) {
      settlement = { status: "failed", message: "Runtime upgrade was rolled back by offline doctor." };
    } else if (
      job.kind === "plan.execute" &&
      typeof plan?.kind === "string" &&
      String(plan.kind).startsWith("plugin.") &&
      outcome.wholeHomeRolledBack &&
      outcome.pluginPlanId &&
      planId === outcome.pluginPlanId
    ) {
      settlement = {
        status: "failed",
        message: "Plugin mutation was overwritten by a whole-home rollback. Audit evidence was kept.",
      };
    } else if (job.kind === "recovery.resume" && (outcome.restoreCompleted || outcome.restoreRolledBack || outcome.upgradeRolledBack)) {
      settlement = { status: "succeeded", message: "Pending snapshot or upgrade state was reconciled." };
    }

    if (!settlement) {
      remaining.push({ kind: job.kind, status: job.status, phase: job.phase, reason: "no-evidence" });
      continue;
    }
    try {
      const updated = await store.settleRecovery(job.id, settlement);
      settled.push({ id: updated.id, status: updated.status, kind: updated.kind });
      if (planId) markHandledPlan(home, planId, settlement.status);
    } catch {
      remaining.push({ kind: job.kind, status: job.status, phase: job.phase, reason: "unreadable" });
    }
  }
  return { settled, remaining, unreadableStore: false };
}

function finishOrBlock(input: {
  command: string;
  restoreCompleted: boolean;
  upgradeRolledBack: boolean;
  runtimeVersion?: string;
  jobs: { settled: Json[]; remaining: Json[]; unreadableStore: boolean };
  extra?: Json;
  blockers?: string[];
}): number {
  const blockers = [
    ...(input.blockers ?? []),
    ...remainingReasons(input.jobs.remaining),
    ...(input.jobs.unreadableStore ? ["Job records could not be opened after the lease was held."] : []),
  ];
  if (blockers.length) {
    throw fail(EXIT.recovery, "RECOVERY_REQUIRED", "Recovery is still required. Unknown records were left in place.", {
      command: input.command,
      recoveryRequired: true,
      restoreCompleted: input.restoreCompleted,
      upgradeRolledBack: input.upgradeRolledBack,
      ...(input.runtimeVersion ? { runtimeVersion: input.runtimeVersion } : {}),
      jobs: { settled: input.jobs.settled, remaining: input.jobs.remaining },
      blockers,
      instancesStopped: true,
      reopenWorkbench: false,
      ...input.extra,
    });
  }
  return printRecover({
    ok: true,
    command: input.command,
    controllerKind: DOCTOR_CONTROL_KIND,
    restoreCompleted: input.restoreCompleted,
    upgradeRolledBack: input.upgradeRolledBack,
    ...(input.runtimeVersion ? { runtimeVersion: input.runtimeVersion } : {}),
    jobs: { settled: input.jobs.settled, remaining: input.jobs.remaining },
    recoveryRequired: false,
    instancesStopped: true,
    reopenWorkbench: true,
    message:
      input.command === "rollback"
        ? "Whole-home rollback finished. Instances were left stopped. Reopen the workbench."
        : "Offline recovery finished. Instances were left stopped. Reopen the workbench.",
    ...input.extra,
  });
}

function diagnose(lock: HomeOperationLock, resources: ResolvedResources): Json {
  const controller = new HomeController(lock.home);
  const restore = readRestoreJournal(lock.home);
  const upgrade = readUpgradeJournal(lock.home);
  const plugin = readPluginMutation(lock.home);
  const control = publicControl(controller.inspect());
  const manager = readManager(controller);
  const jobs = readJobs(lock.home);
  const instances = readInstances(lock.home);
  return {
    restore,
    upgrade,
    plugin,
    lock: publicLock(lock.inspect()),
    control,
    manager,
    jobs,
    instances: instances.public,
    toolchain: resources.toolchain,
    findings: findingsFromInspect({
      restore,
      upgrade,
      plugin,
      lock: publicLock(lock.inspect()),
      control,
      manager,
      jobs,
      instances: instances.public,
      toolchain: resources.toolchain,
    }),
    recoveryMode: instances.recoveryMode,
  };
}

export async function runRecover(lock: HomeOperationLock, flags: Record<string, string>): Promise<number> {
  const resources = resolveResources(lock.home, flags);
  const dryRun = flags.dryRun === "1";
  const diagnosis = diagnose(lock, resources);
  const unknown = journalsUnknown(lock.home);
  const instances = readInstances(lock.home);

  if (dryRun) {
    return printRecover({
      ok: true,
      command: "recover",
      dryRun: true,
      controllerKind: DOCTOR_CONTROL_KIND,
      impact: snapshotImpact(),
      target: hasPendingHomeWork(lock.home) ? "pending-home-journals" : "jobs-and-dead-records",
      blockers: [
        ...(unknown ? [unknown] : []),
        ...(instances.recoveryMode ? ["Live or identity-ambiguous instances block directory swap."] : []),
        ...((diagnosis.findings as string[]) ?? []),
      ],
      missing: resources.missing,
      instancesStopped: true,
      message: "Dry-run only. No lock, control lease, journal, or snapshot was changed.",
    });
  }

  if (unknown) {
    throw fail(EXIT.recovery, "RECOVERY_NEEDED", unknown, { command: "recover" });
  }

  if ((hasPendingHomeWork(lock.home) || hasWorkbenchPackageWork(lock.home)) && !resources.snapshotRoot) {
    throw fail(
      EXIT.usage,
      "SNAPSHOT_ROOT_REQUIRED",
      "recover needs --snapshot-root or toolchain.json snapshotRoot. An empty directory was not initialized as old snapshots.",
      { command: "recover", missing: resources.missing },
    );
  }

  const write = requireWriteResources(resources, "recover");
  assertToolIndependent(lock.home, write.cli.bin);

  if (pluginMutationOpen(lock.home) && !hasPendingHomeWork(lock.home)) {
    throw fail(
      EXIT.recovery,
      "PLUGIN_MUTATION_OPEN",
      "Plugin mutation evidence is present. Doctor will not rebuild a single manifest. Pass rollback --snapshot <id> for a whole-home restore.",
      { command: "recover" },
    );
  }

  const controller = new HomeController(lock.home);
  await reclaimDeadControl(controller);
  reclaimDeadLock(lock);

  let handle;
  try {
    handle = controller.acquire(DOCTOR_CONTROL_KIND);
  } catch (error) {
    if (error instanceof HomeControlBusyError) {
      throw fail(EXIT.lock, "LOCK_HELD", "Home run-control is held and was not stolen.");
    }
    throw error;
  }

  try {
    return await lock.run("recover", async () => {
      const currentInstances = readInstances(lock.home);
      if (currentInstances.recoveryMode) {
        const deadOnly = currentInstances.rows.every((row) => row.liveness === "dead");
        if (!deadOnly) {
          throw fail(
            EXIT.recovery,
            "RECOVERY_MODE",
            "Leftover instances are live or identity-ambiguous. Recovery mode: directories were not swapped and PIDs were not killed.",
            { command: "recover", instances: currentInstances.public },
          );
        }
      }
      const reclaimed = reclaimDeadInstances(currentInstances.rows);
      if (reclaimed.blocked) {
        throw fail(
          EXIT.recovery,
          "RECOVERY_MODE",
          "A leftover instance could not be proven dead. PIDs were not killed.",
          { command: "recover" },
        );
      }

      const stores = makeStores(lock.home, write.snapshotRoot, write.runtimeRoot);
      const interruptedPlans = unfinishedPlanIds(lock.home);
      const plans = readPlans(lock.home);
      const packagePlanIds = interruptedPlans.filter(id => plans.some(plan => plan.id === id && plan.kind === "workbench.upgrade"));
      if (hasWorkbenchPackageWork(lock.home) || packagePlanIds.length) {
        const managerPath = containedPath(lock.home, [WORKBENCH_CONTROL_DIR_NAME, "manager.json"], "file");
        const managerId = () => {
          if (!managerPath || inspectNamedFile(managerPath) !== "ok") return null;
          const row = JSON.parse(readFileSync(managerPath, "utf8"));
          return typeof row.profileId === "string" && controller.roleOf(row.profileId) === "manager" ? row.profileId : null;
        };
        const packageUpgrade = new WorkbenchPackageUpgrade({
          home: lock.home, managerId,
          snapshots: { create: async (...args) => stores.snapshots.create(...args) },
          upgrades: makeUpgrade({ home: lock.home, ...stores, cli: write.cli }),
          currentRuntime: () => describeRuntime({ bin: write.cli.bin, version: write.cli.version }),
          stopAll: async () => {
            if (readInstances(lock.home).recoveryMode) throw fail(EXIT.recovery, "RECOVERY_MODE", "Instance identity must be resolved before package recovery.");
          },
          reinitializeManager: async () => { /* Offline doctor leaves all instances stopped. */ },
        });
        const ids: Array<string | undefined> = packageUpgrade.hasEvidence() ? [undefined] : packagePlanIds;
        for (const planId of ids) {
          const workbench = await packageUpgrade.recover({
            signal: new AbortController().signal, phase: () => {}, message: () => {}, cancellable: () => {}, result: () => {},
          }, planId);
          if (!workbench) continue;
          if (packageUpgrade.hasEvidence() || hasPendingHomeWork(lock.home) || !homeConfigReadable(lock.home)) {
            throw fail(EXIT.recovery, "RECOVERY_NEEDED", "Workbench package recovery left unresolved Home evidence.");
          }
          const expected = workbench.snapshotId ? stores.snapshots.preview(workbench.snapshotId).runtimeVersion : undefined;
          const verified = stores.runtimes.current() || workbench.rolledBack
            ? requireVerifiedRuntime(stores.runtimes, expected)
            : verifyBoundRuntime(write.cli.bin, write.cli.version);
          if (expected && verified.version !== expected) throw fail(EXIT.recovery, "RUNTIME_MISMATCH", "Workbench package recovery runtime does not match its snapshot.");
          syncHomeToolchain(lock.home, verified, write);
          const jobs = await settleJobs(lock.home, {
            restoreCompleted: false, upgradeRolledBack: false, wholeHomeRolledBack: false, workbench,
          });
          return finishOrBlock({
            command: "recover", restoreCompleted: false, upgradeRolledBack: false, runtimeVersion: verified.version, jobs,
            blockers: pluginMutationOpen(lock.home) ? ["Unrelated plugin mutation evidence remains unresolved."] : [],
            extra: { workbench, instancesReclaimed: reclaimed.reclaimed },
          });
        }
      }
      let pendingSnapshotId: string | undefined;
      let expectedRuntimeVersion: string | undefined;
      let restorePending = false;
      let receipt: ReturnType<SnapshotStore["recoveryReceipt"]>;
      let receiptPlanId: string | undefined;
      try {
        const pending = stores.snapshots.pendingRestore() ?? stores.snapshots.restoreJournal();
        restorePending = Boolean(pending);
        receipt = stores.snapshots.recoveryReceipt();
        receiptPlanId = pending?.planId ?? (receipt?.planId && interruptedPlans.includes(receipt.planId)
          ? receipt.planId : undefined);
        pendingSnapshotId = pending?.snapshotId;
        expectedRuntimeVersion = pending?.runtimeVersion;
      } catch {
        throw fail(
          EXIT.recovery,
          "RECOVERY_NEEDED",
          "Pending restore metadata is unreadable. Original bytes were left in place.",
          { command: "recover" },
        );
      }

      const needsHomeRecover = hasPendingHomeWork(lock.home) || Boolean(pendingSnapshotId) || Boolean(receiptPlanId);
      let restoreCompleted = false;
      let restoreRolledBack = false;
      let upgradeRolledBack = false;
      let upgradePlanId: string | undefined;
      if (needsHomeRecover) {
        const upgrade = makeUpgrade({ home: lock.home, ...stores, cli: write.cli });
        try {
          const result = await upgrade.recover({ receiptPlanId });
          restoreCompleted = result.restoreCompleted === true;
          restoreRolledBack = result.restoreRolledBack === true;
          upgradeRolledBack = result.upgradeRolledBack === true;
          upgradePlanId = result.upgradePlanId;
          receipt = result.restoreReceipt;
          if (receipt) {
            pendingSnapshotId = receipt.snapshotId;
            expectedRuntimeVersion = restoreRolledBack
              ? stores.snapshots.preview(receipt.beforeRestoreId).runtimeVersion : receipt.runtimeVersion;
          }
        } catch (error) {
          if (error instanceof Fail) throw error;
          throw fail(
            EXIT.recovery,
            "RECOVERY_NEEDED",
            "Snapshot or upgrade recovery failed. Diagnostic journals were left in place.",
            { command: "recover" },
          );
        }
      }

      const stillRestore = readRestoreJournal(lock.home);
      const stillUpgrade = readUpgradeJournal(lock.home);
      if (stillRestore.needed === true || stillUpgrade.needed === true) {
        throw fail(
          EXIT.recovery,
          "RECOVERY_NEEDED",
          "Snapshot or upgrade journals are still present after recover.",
          { command: "recover" },
        );
      }

      const wholeHome = restoreCompleted || restoreRolledBack || upgradeRolledBack;
      const restoredNow = restoreCompleted && restorePending;
      if (wholeHome && !homeConfigReadable(lock.home)) {
        throw fail(
          EXIT.recovery,
          "HOME_UNREADABLE",
          "Home configuration could not be read after recovery. Jobs were not settled.",
          { command: "recover" },
        );
      }

      let runtimeVersion: string | undefined;
      if (wholeHome) {
        const verified = requireVerifiedRuntime(stores.runtimes, expectedRuntimeVersion);
        runtimeVersion = verified.version;
        syncHomeToolchain(lock.home, verified, write);
      }

      const mutation = readPluginMutationRecord(lock.home);
      if (mutation.status === "unreadable") {
        throw fail(
          EXIT.recovery,
          "RECOVERY_REQUIRED",
          "Plugin-mutation evidence is unreadable and was not cleared.",
          { command: "recover", recoveryRequired: true, reopenWorkbench: false },
        );
      }

      const jobs = await settleJobs(lock.home, {
        restoreCompleted,
        restoreRolledBack,
        restorePlanId: receipt?.planId,
        upgradeRolledBack,
        upgradePlanId,
        wholeHomeRolledBack: restoredNow,
        snapshotId: pendingSnapshotId,
        pluginPlanId: restoredNow ? mutation.planId : undefined,
      });

      const blockers: string[] = [];
      if (mutation.status === "open" && !restoredNow) {
        blockers.push(
          "Plugin mutation evidence is still present. Doctor will not rebuild a single manifest. Pass rollback --snapshot <id> for a whole-home restore.",
        );
      }
      if (restoredNow && mutation.status === "open") {
        if (!archivePluginMutation(lock.home)) {
          blockers.push("Plugin-mutation evidence could not be archived after whole-home restore.");
        }
      }

      return finishOrBlock({
        command: "recover",
        restoreCompleted,
        upgradeRolledBack,
        runtimeVersion,
        jobs,
        blockers,
        extra: { instancesReclaimed: reclaimed.reclaimed, restoreRolledBack },
      });
    });
  } catch (error) {
    if (error instanceof HomeLockBusyError) {
      throw fail(EXIT.lock, "LOCK_HELD", "recover needs the home lock and will not steal it.");
    }
    throw error;
  } finally {
    handle.release();
  }
}

export async function runRollback(lock: HomeOperationLock, flags: Record<string, string>): Promise<number> {
  const snapshotId = flags.snapshot?.trim();
  if (!snapshotId) {
    throw fail(EXIT.usage, "USAGE", "rollback requires --snapshot <id>. Snapshot ids are not guessed.");
  }
  if (!SNAPSHOT_ID_RE.test(snapshotId)) {
    throw fail(EXIT.usage, "USAGE", "rollback requires a snapshot UUID.");
  }

  const resources = resolveResources(lock.home, flags);
  const dryRun = flags.dryRun === "1";
  const unknown = journalsUnknown(lock.home);
  const instances = readInstances(lock.home);

  if (unknown) {
    throw fail(EXIT.recovery, "RECOVERY_NEEDED", unknown, { command: "rollback" });
  }
  if (hasPendingHomeWork(lock.home)) {
    throw fail(
      EXIT.recovery,
      "RECOVERY_NEEDED",
      "Unfinished restore or upgrade journals exist. Run recover before rollback.",
      { command: "rollback" },
    );
  }

  const write = requireWriteResources(resources, "rollback");
  assertToolIndependent(lock.home, write.cli.bin);
  const stores = makeStores(lock.home, write.snapshotRoot, write.runtimeRoot);
  let preview: SnapshotMeta;
  try {
    preview = stores.snapshots.preview(snapshotId);
  } catch {
    throw fail(EXIT.recovery, "SNAPSHOT_NOT_FOUND", "That snapshot was not found in the given snapshot root.", {
      command: "rollback",
    });
  }

  if (dryRun) {
    return printRecover({
      ok: true,
      command: "rollback",
      dryRun: true,
      controllerKind: DOCTOR_CONTROL_KIND,
      target: snapshotId,
      impact: snapshotImpact(preview),
      blockers: instances.recoveryMode
        ? ["Live or identity-ambiguous instances block directory swap."]
        : [],
      instancesStopped: true,
      message: "Dry-run only. No lock, control lease, journal, or snapshot was changed.",
    });
  }

  const controller = new HomeController(lock.home);
  await reclaimDeadControl(controller);
  reclaimDeadLock(lock);
  let handle;
  try {
    handle = controller.acquire(DOCTOR_CONTROL_KIND);
  } catch (error) {
    if (error instanceof HomeControlBusyError) {
      throw fail(EXIT.lock, "LOCK_HELD", "Home run-control is held and was not stolen.");
    }
    throw error;
  }

  try {
    return await lock.run("rollback", async () => {
      const currentInstances = readInstances(lock.home);
      if (currentInstances.recoveryMode && !currentInstances.rows.every((row) => row.liveness === "dead")) {
        throw fail(
          EXIT.recovery,
          "RECOVERY_MODE",
          "Leftover instances are live or identity-ambiguous. Recovery mode: directories were not swapped and PIDs were not killed.",
          { command: "rollback", instances: currentInstances.public },
        );
      }
      const reclaimed = reclaimDeadInstances(currentInstances.rows.filter((row) => row.liveness === "dead"));
      if (currentInstances.recoveryMode && reclaimed.blocked) {
        throw fail(EXIT.recovery, "RECOVERY_MODE", "A leftover instance could not be proven dead. PIDs were not killed.");
      }

      const upgrade = makeUpgrade({ home: lock.home, ...stores, cli: write.cli });
      let result;
      try {
        result = await upgrade.restore(snapshotId);
      } catch (error) {
        if (error instanceof Fail) throw error;
        throw fail(EXIT.recovery, "ROLLBACK_FAILED", "Whole-home rollback did not finish.", { command: "rollback" });
      }
      const pending = stores.snapshots.pendingRestore();
      if (pending) {
        throw fail(EXIT.recovery, "RECOVERY_NEEDED", "Restore completed the swap but pending state remained.");
      }
      if (!homeConfigReadable(lock.home)) {
        throw fail(
          EXIT.recovery,
          "HOME_UNREADABLE",
          "Home configuration could not be read after rollback. Jobs were not settled.",
          { command: "rollback" },
        );
      }
      const verified = requireVerifiedRuntime(stores.runtimes, result.restored.runtimeVersion);
      syncHomeToolchain(lock.home, verified, write);

      const mutation = readPluginMutationRecord(lock.home);
      if (mutation.status === "unreadable") {
        throw fail(
          EXIT.recovery,
          "RECOVERY_REQUIRED",
          "Plugin-mutation evidence is unreadable and was not cleared.",
          { command: "rollback", recoveryRequired: true, reopenWorkbench: false },
        );
      }

      const jobs = await settleJobs(lock.home, {
        restoreCompleted: true,
        upgradeRolledBack: false,
        wholeHomeRolledBack: true,
        snapshotId,
        pluginPlanId: mutation.planId,
      });

      const blockers: string[] = [];
      if (mutation.status === "open" && !archivePluginMutation(lock.home)) {
        blockers.push("Plugin-mutation evidence could not be archived after whole-home restore.");
      }

      return finishOrBlock({
        command: "rollback",
        restoreCompleted: true,
        upgradeRolledBack: false,
        runtimeVersion: verified.version,
        jobs,
        blockers,
        extra: {
          snapshotId: result.restored.id,
          beforeRestoreId: result.beforeRestore.id,
          instancesReclaimed: reclaimed.reclaimed,
        },
      });
    });
  } catch (error) {
    if (error instanceof HomeLockBusyError) {
      throw fail(EXIT.lock, "LOCK_HELD", "rollback needs the home lock and will not steal it.");
    }
    if (error instanceof Fail) throw error;
    throw fail(EXIT.recovery, "ROLLBACK_FAILED", "Whole-home rollback did not finish.", { command: "rollback" });
  } finally {
    handle.release();
  }
}

function printRecover(body: Json, exit: number = EXIT.ok): number {
  return print(body, exit);
}

export async function runUnlock(lock: HomeOperationLock): Promise<number> {
  const controller = new HomeController(lock.home);
  const control = controller.inspect();
  if (control.held) {
    if ("owner" in control && control.liveness === "dead") {
      const reclaimed = controller.reclaimDead();
      if (!reclaimed.reclaimed) {
        return print(
          {
            ok: false,
            command: "unlock",
            unlocked: false,
            reason: reclaimed.reason,
            message: "Dead control ownership could not be reclaimed.",
          },
          EXIT.lock,
        );
      }
    } else if (!("owner" in control && control.liveness === "dead")) {
      const reason =
        "reclaim" in control && control.reclaim
          ? "reclaim-in-progress"
          : "ambiguous" in control && control.ambiguous
            ? "ambiguous"
            : "incomplete" in control && control.incomplete
              ? "incomplete"
              : "owner-alive";
      return print(
        {
          ok: false,
          command: "unlock",
          unlocked: false,
          reason,
          message: "Home run-control is live or ambiguous and was not stolen.",
        },
        EXIT.lock,
      );
    }
  }

  const result = lock.unlockDead();
  if (result.unlocked) return print({ ok: true, command: "unlock", unlocked: true, controlReclaimed: control.held });
  const reason = result.reason;
  if (reason === "not-held") {
    return print({ ok: true, command: "unlock", unlocked: false, reason, message: "No home lock is held." });
  }
  return print(
    { ok: false, command: "unlock", unlocked: false, reason, message: unlockMessage(reason) },
    EXIT.lock,
  );
}

function unlockMessage(reason: string): string {
  if (reason === "owner-alive") return "The home lock is held by a live process and was not stolen.";
  if (reason === "ambiguous") return "The home lock path is ambiguous and was not stolen.";
  if (reason === "incomplete") return "The home lock is incomplete and was not stolen.";
  if (reason === "reclaim-in-progress") return "The home lock is being reclaimed and was not stolen.";
  if (reason === "remove-failed") return "The home lock could not be removed safely.";
  if (reason === "not-held") return "No home lock is held.";
  return "The home lock could not be cleared.";
}
