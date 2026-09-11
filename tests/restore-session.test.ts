import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MaintenanceGate } from "../src/main/maintenance-gate.ts";
import { RestoreSession } from "../src/main/restore-session.ts";
import { RuntimeStore, type RunProcessFn } from "../src/main/runtime-store.ts";
import { SnapshotStore } from "../src/main/snapshot-store.ts";
import { describeRuntime } from "../src/main/runtime-descriptor.ts";
import type { SnapshotRuntime } from "../src/shared/snapshots.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("restore:pending cleanup failure is completed and does not leave mutations unblocked with pending state", async () => {
  const ctx = sessionHarness({
    inject: (op) => {
      if (op === "restore:pending") throw new Error("simulated I/O error during post-swap cleanup");
    },
  });
  writeFileSync(join(ctx.home, "sessions", "state.txt"), "new");
  await ctx.invokeRestore(ctx.snapshotId);
  assert.equal(readFileSync(join(ctx.home, "sessions", "state.txt"), "utf8"), "old");
  assert.equal(ctx.snapshots.pendingRestore(), undefined);
  assert.equal(ctx.restore.recoveryError, "");
  assert.equal(ctx.maintenance.busy, false);
  assert.equal(await ctx.mutate(() => true), true);
  assert.equal(ctx.runtimes.current()?.bin, ctx.snapshots.runtimeBin(ctx.snapshotId));
  assert.equal(ctx.started, 0);
  assert.ok(ctx.settingsApplied > 0);
});

test("cleanup failure that cannot finishRestore blocks start/write after the gate unlocks", async () => {
  let failComplete = true;
  const ctx = sessionHarness({
    inject: (op) => {
      if (op === "restore:pending") throw new Error("simulated I/O error during post-swap cleanup");
      if (op === "restore:complete" && failComplete) throw new Error("completeRestore cleanup failed");
    },
  });
  writeFileSync(join(ctx.home, "sessions", "state.txt"), "new");
  await assert.rejects(() => ctx.invokeRestore(ctx.snapshotId), /simulated I\/O|cleanup failed/);
  assert.equal(readFileSync(join(ctx.home, "sessions", "state.txt"), "utf8"), "old");
  assert.ok(ctx.snapshots.pendingRestore());
  assert.equal(ctx.maintenance.busy, false);
  assert.match(ctx.restore.recoveryError, /Restore needs recovery/);
  await assert.rejects(() => ctx.mutate(() => true), /Restore needs recovery|unfinished restore/);
  ctx.restore.recoveryError = "";
  await assert.rejects(() => ctx.mutate(() => true), /unfinished restore/);

  failComplete = false;
  await ctx.invokeRestore(ctx.snapshotId);
  assert.equal(ctx.snapshots.pendingRestore(), undefined);
  assert.equal(ctx.restore.recoveryError, "");
  assert.equal(ctx.runtimes.current()?.bin, ctx.snapshots.runtimeBin(ctx.snapshotId));
  assert.equal(await ctx.mutate(() => true), true);
  assert.equal(ctx.started, 0);
});

test("new process startup keeps the same unfinished-restore block and can retry", async () => {
  let failComplete = true;
  const first = sessionHarness({
    inject: (op) => {
      if (op === "restore:pending") throw new Error("simulated I/O error during post-swap cleanup");
      if (op === "restore:complete" && failComplete) throw new Error("completeRestore cleanup failed");
    },
  });
  writeFileSync(join(first.home, "sessions", "state.txt"), "new");
  await assert.rejects(() => first.invokeRestore(first.snapshotId), /simulated I\/O|cleanup failed/);
  assert.ok(first.snapshots.pendingRestore());

  const restarted = reopenSession(first, {
    inject: (op) => {
      if (op === "restore:complete" && failComplete) throw new Error("completeRestore cleanup failed");
    },
  });
  await assert.rejects(() => restarted.startup(), /completeRestore cleanup failed/);
  assert.match(restarted.restore.recoveryError, /Restore needs recovery before spaces can start/);
  assert.equal(restarted.maintenance.busy, false);
  await assert.rejects(() => restarted.mutate(() => true), /Restore needs recovery|unfinished restore/);
  assert.equal(readFileSync(join(first.home, "sessions", "state.txt"), "utf8"), "old");
  assert.ok(restarted.snapshots.pendingRestore());

  failComplete = false;
  await restarted.invokeRestore(first.snapshotId);
  assert.equal(restarted.snapshots.pendingRestore(), undefined);
  assert.equal(restarted.restore.recoveryError, "");
  assert.equal(restarted.runtimes.current()?.bin, restarted.snapshots.runtimeBin(first.snapshotId));
  assert.equal(await restarted.mutate(() => true), true);
});

test("damaged current runtime requires allowDataOnlyBackup and does not borrow the target runtime", async () => {
  const ctx = sessionHarness();
  writeFileSync(join(ctx.home, "sessions", "state.txt"), "new");
  rmSync(ctx.currentBin, { force: true });
  assert.throws(() => ctx.runtimes.current(), /missing/);
  assert.equal(ctx.runtimes.recordedRef()?.version, "1.0.0");

  await assert.rejects(() => ctx.invokeRestore(ctx.snapshotId), /allowDataOnlyBackup|missing or damaged/);
  assert.equal(readFileSync(join(ctx.home, "sessions", "state.txt"), "utf8"), "new");
  assert.equal(ctx.snapshots.pendingRestore(), undefined);

  await ctx.invokeRestore(ctx.snapshotId, { allowDataOnlyBackup: true });
  assert.equal(readFileSync(join(ctx.home, "sessions", "state.txt"), "utf8"), "old");
  const before = ctx.snapshots.list().find((row) => row.reason === "before-restore");
  assert.ok(before);
  assert.equal(before.runtimeMissing, true);
  assert.equal(before.runtimeVersion, "1.0.0");
  assert.equal(existsSync(join(ctx.snapshotRoot, before.id, "runtime")), false);
  assert.throws(() => ctx.snapshots.runtimeBin(before.id), /no runtime|restore target/);
  assert.equal(ctx.snapshots.pendingRestore(), undefined);
  assert.equal(ctx.restore.recoveryError, "");
  assert.equal(ctx.runtimes.current()?.bin, ctx.snapshots.runtimeBin(ctx.snapshotId));
  assert.equal(ctx.started, 0);
});

test("settings failure after pending cleanup stays blocked until reconciliation succeeds", async () => {
  const ctx = sessionHarness();
  let failSettings = true;
  const restore = new RestoreSession({ snapshots: ctx.snapshots, runtimes: ctx.runtimes,
    applyRestoredSettings: () => { if (failSettings) throw new Error("settings could not be applied"); },
  });
  await assert.rejects(ctx.maintenance.run("restore", () => restore.restoreSnapshot(ctx.snapshotId)), /settings could not be applied/);
  assert.equal(ctx.snapshots.pendingRestore(), undefined);
  assert.equal(ctx.maintenance.busy, false);
  assert.throws(() => restore.assertAvailable(false), /Restore needs recovery/);
  assert.equal(ctx.runtimes.current()?.bin, ctx.snapshots.runtimeBin(ctx.snapshotId));
  failSettings = false;
  await restore.recoverOnStartup();
  assert.doesNotThrow(() => restore.assertAvailable(false));
});

test("finishing an earlier pending restore does not claim a different requested snapshot was restored", async () => {
  let failComplete = true;
  const ctx = sessionHarness({ inject: op => {
    if (op === "restore:complete" && failComplete) throw new Error("cleanup failed");
  } });
  writeFileSync(join(ctx.home, "sessions", "state.txt"), "other snapshot");
  const other = ctx.snapshots.create(describeRuntime(ctx.runtimes.current()));
  await assert.rejects(ctx.invokeRestore(ctx.snapshotId), /cleanup failed/);
  failComplete = false;
  await assert.rejects(ctx.invokeRestore(other.id), /previous restore has been completed/);
  assert.equal(readFileSync(join(ctx.home, "sessions", "state.txt"), "utf8"), "old");
  assert.equal(ctx.runtimes.current()?.bin, ctx.snapshots.runtimeBin(ctx.snapshotId));
  assert.equal(ctx.snapshots.pendingRestore(), undefined);
  assert.doesNotThrow(() => ctx.restore.assertAvailable(false));
});

function sessionHarness(opts: { inject?: (op: string, detail?: string) => void } = {}) {
  const root = fakeDir("dsh-restore-session-");
  const home = join(root, "home");
  const snapshotRoot = join(root, "snapshots");
  const runtimeRoot = join(root, "runtime");
  const storeRoot = join(root, "runtimes");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "state.txt"), "old");
  const { bin, runtime } = writeFakeCli(runtimeRoot, "1.0.0");
  const snapshots = new SnapshotStore({ home, root: snapshotRoot, inject: opts.inject });
  const snapshot = snapshots.create(runtime);
  const runtimes = new RuntimeStore({
    root: storeRoot,
    snapshotRoot,
    source: () => "official",
    legacy: () => undefined,
    run: mockRun(),
  });
  mkdirSync(storeRoot, { recursive: true });
  writeFileSync(
    join(storeRoot, "current.json"),
    `${JSON.stringify({ bin, version: "1.0.0", origin: "system" }, null, 2)}\n`,
  );
  return attachSession({
    home,
    snapshotRoot,
    snapshots,
    runtimes,
    snapshotId: snapshot.id,
    currentBin: bin,
    started: 0,
  });
}

function reopenSession(
  ctx: ReturnType<typeof sessionHarness>,
  opts: { inject?: (op: string, detail?: string) => void } = {},
) {
  const snapshots = new SnapshotStore({ home: ctx.home, root: ctx.snapshotRoot, inject: opts.inject });
  return attachSession({
    home: ctx.home,
    snapshotRoot: ctx.snapshotRoot,
    snapshots,
    runtimes: ctx.runtimes,
    snapshotId: ctx.snapshotId,
    currentBin: ctx.currentBin,
    started: 0,
  });
}

function attachSession(input: {
  home: string;
  snapshotRoot: string;
  snapshots: SnapshotStore;
  runtimes: RuntimeStore;
  snapshotId: string;
  currentBin: string;
  started: number;
}) {
  const maintenance = new MaintenanceGate();
  const box = { settingsApplied: 0, started: input.started };
  const restore = new RestoreSession({
    snapshots: input.snapshots,
    runtimes: input.runtimes,
    applyRestoredSettings: () => {
      box.settingsApplied += 1;
    },
  });
  return {
    ...input,
    maintenance,
    restore,
    get settingsApplied() {
      return box.settingsApplied;
    },
    get started() {
      return box.started;
    },
    async invokeRestore(id: string, options?: { allowDataOnlyBackup?: boolean }) {
      return maintenance.run("snapshot-restore", async () => {
        await restore.restoreSnapshot(id, options);
      });
    },
    async mutate<T>(action: () => T | Promise<T>): Promise<T> {
      restore.assertAvailable(false);
      return maintenance.runMutation(async () => action());
    },
    async startup() {
      try {
        await maintenance.run("startup-recovery", async () => {
          await restore.recoverOnStartup();
        });
      } catch (err) {
        if (!restore.recoveryError) {
          restore.recoveryError = `Restore needs recovery before spaces can start: ${String(err)}`;
        }
        throw err;
      }
    },
  };
}

function writeFakeCli(prefix: string, version: string): { bin: string; runtime: SnapshotRuntime } {
  const pkg = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "console.log('dsh')\n", "utf8");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version }, null, 2)}\n`,
    "utf8",
  );
  return {
    bin,
    runtime: {
      root: prefix,
      version,
      binRelative: "node_modules/@deepseek-ai/dsh/lib/bin.js",
    },
  };
}

function mockRun(): RunProcessFn {
  return async (_command, args) => {
    if (args.includes("--version")) {
      const bin = args.find((item) => item.endsWith("bin.js")) ?? args[0];
      const pkg = join(bin, "..", "..", "package.json");
      const requested = existsSync(pkg)
        ? (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version
        : "0.0.0";
      return { code: 0, stdout: `dsh ${requested}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
}

function fakeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
