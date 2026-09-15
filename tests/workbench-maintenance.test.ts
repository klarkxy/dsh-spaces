import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import {
  FULL_SPACES_PACKAGE,
  UPGRADE_JOURNAL_FILE,
  UPGRADE_STAGE_DIR,
  WORKBENCH_MAINTENANCE_ERROR,
  WORKBENCH_PLAN_TTL_MS,
  WORKBENCH_PLUGIN_MUTATION_FILE,
  WORKBENCH_PLUGIN_REGISTRY_FILE,
  WorkbenchMaintenance,
  WorkbenchMaintenanceError,
  type MaintenanceFetcher,
} from "../src/adapters/node/workbench-maintenance.ts";
import type { WorkbenchMaintenancePorts } from "../src/adapters/node/workbench-maintenance-ports.ts";
import {
  WORKBENCH_CONTROL_DIR_NAME,
  WorkbenchJobAbortError,
  WorkbenchJobError,
  type WorkbenchJobContext,
} from "../src/adapters/node/workbench-jobs.ts";
import { CoordinatedUpgrade } from "../src/main/coordinated-upgrade.ts";
import { ProcessTerminationError } from "../src/main/terminate-process.ts";
import { DiagnosticsService } from "../src/main/diagnostics.ts";
import { CATALOG_CACHE_FILE } from "../src/main/plugin-catalog.ts";
import { isHubPluginArchive, PLUGIN_LIBRARY_FILE, readPluginLibrary } from "../src/main/plugin-library.ts";
import { listProfilePlugins } from "../src/main/plugin-ops.ts";
import { ProfileRegistry } from "../src/main/profile-registry.ts";
import { RuntimeStore, type RunProcessFn } from "../src/main/runtime-store.ts";
import { SnapshotStore } from "../src/main/snapshot-store.ts";
import type { SnapshotExecutor } from "../src/main/snapshot-executor.ts";
import type { SnapshotRuntime } from "../src/shared/snapshots.ts";
import type { ProfileStatus } from "../src/shared/types.ts";

const BASE = "@deepseek-ai/dsh-base";
const WEB = "@deepseek-ai/dsh-web-app";
const temps: string[] = [];

test("ROOT package preview binds server content and executes without a second manager restart", async () => {
  let digest = "a".repeat(64);
  const inputs: unknown[] = [];
  const packageUpgrade = {
    describe: async () => ({ id: "bundled-workbench", version: "0.2.0", installedVersion: "0.2.0", digest, updateAvailable: true }),
    hasEvidence: () => false,
    execute: async (input: unknown) => { inputs.push(input); return { snapshotId: "saved-snapshot" }; },
  } as unknown as WorkbenchMaintenancePorts["packageUpgrade"];
  const { maintenance, state } = harness({ packageUpgrade });
  const request = { kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" } as const;
  const stale = await maintenance.preview(request);
  digest = "b".repeat(64);
  await assert.rejects(() => maintenance.execute(stale.id, jobCtx()), matchCode("workbench/stale"));
  assert.equal(inputs.length, 0);
  const plan = await maintenance.preview(request);
  assert.equal(plan.scope, "home");
  assert.deepEqual(plan.runningSpaceIds, ["spaces-hub", "coding"]);
  assert.equal(JSON.stringify(plan).includes(digest), false);
  await maintenance.execute(plan.id, jobCtx());
  assert.deepEqual(inputs, [{ ...request, expectedDigest: digest, planId: plan.id }]);
  assert.equal(state.reinitialized, 0, "module owns reinitialization; wrapper must not restart it again");
  assert.deepEqual(state.maintenance, [true, false]);
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ROOT abandoned package recovery cannot report successful update", async () => {
  let active = true;
  const packageUpgrade = {
    hasEvidence: () => active,
    recover: async () => {
      active = false;
      return { planId: "11111111-1111-4111-8111-111111111111", rolledBack: false, outcome: "abandoned" };
    },
  } as unknown as WorkbenchMaintenancePorts["packageUpgrade"];
  const { maintenance } = harness({ packageUpgrade });
  await assert.rejects(() => maintenance.recover(), matchCode("workbench/forbidden"));
  assert.equal(active, true);
  assert.equal(maintenance.recoveryOutcome(), undefined);
});

test("preview hands space and controller actions to supervisor runtime", async () => {
  const { maintenance } = harness();
  await assert.rejects(() => maintenance.preview({ kind: "space.stop", spaceId: "coding" }), matchCode("workbench/runtime-handoff"));
  await assert.rejects(() => maintenance.preview({ kind: "controller.release" }), matchCode("workbench/runtime-handoff"));
  await assert.rejects(() => maintenance.preview({ kind: "controller.shutdown" }), matchCode("workbench/runtime-handoff"));
});

test("preview rejects raw spec, filepath, git url, and extra command fields", async () => {
  const { maintenance } = harness();
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["coding"],
        catalogId: "urzeye/dsh-outline",
        version: "1.2.3",
        spec: "dsh-outline@1.2.3",
      } as never),
    matchCode("workbench/invalid-input"),
  );
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["coding"],
        catalogId: "file:C:/tmp/plugin.tgz",
        version: "1.2.3",
      }),
    matchCode("workbench/invalid-input"),
  );
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["coding"],
        catalogId: "github:example/git-bundle",
        version: "1.2.3",
      }),
    matchCode("workbench/invalid-input"),
  );
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["coding"],
        catalogId: "example/git-bundle",
        version: "1.0.0",
      }),
    matchCode("workbench/forbidden"),
  );
});

test("execute rejects an expired plan and a fingerprint changed by space status", async () => {
  const clock = { now: Date.parse("2026-09-12T00:00:00.000Z") };
  const { maintenance, state } = harness({ now: () => new Date(clock.now) });
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  clock.now += WORKBENCH_PLAN_TTL_MS + 1;
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/expired"));

  clock.now = Date.parse("2026-09-12T01:00:00.000Z");
  const fresh = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  state.status.coding = "stopped";
  await assert.rejects(() => maintenance.execute(fresh.id, jobCtx()), matchCode("workbench/stale"));
});

test("manager profile, official packages, and full Spaces cannot be mutated", async () => {
  const { maintenance } = harness();
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["spaces-hub"],
        catalogId: "urzeye/dsh-outline",
        version: "1.2.3",
      }),
    matchCode("workbench/forbidden"),
  );
  await assert.rejects(
    () => maintenance.preview({ kind: "plugin.remove", spaceId: "coding", packageName: BASE }),
    matchCode("workbench/forbidden"),
  );
  await assert.rejects(
    () => maintenance.preview({ kind: "plugin.remove", spaceId: "coding", packageName: FULL_SPACES_PACKAGE }),
    matchCode("workbench/forbidden"),
  );
  await assert.rejects(
    () => maintenance.preview({ kind: "plugin.toggle", spaceId: "spaces-hub", pluginId: "dsh-outline", enabled: true }),
    matchCode("workbench/forbidden"),
  );
});

test("cleanup-manager only removes the management package from an ordinary profile and does not copy data", async () => {
  const { home, maintenance, state } = harness();
  writeManifest(home, "coding", {
    bundles: [BASE, WEB, FULL_SPACES_PACKAGE],
    dependencies: { [BASE]: "1", [WEB]: "1", [FULL_SPACES_PACKAGE]: "0.2.0" },
  });
  mkdirSync(join(home, "hub", "coding"), { recursive: true });
  writeFileSync(join(home, "hub", "coding", "notes.txt"), "keep-user-data\n");
  const plan = await maintenance.preview({ kind: "plugin.cleanup-manager", spaceId: "coding" });
  assert.equal(plan.destructive, true);
  assert.match(plan.changes.join("\n"), /not copied or migrated/i);
  await maintenance.execute(plan.id, jobCtx());
  const plugins = listProfilePlugins(home, "coding").map((item) => item.name);
  assert.equal(plugins.includes(FULL_SPACES_PACKAGE), false);
  assert.equal(readFileSync(join(home, "hub", "coding", "notes.txt"), "utf8"), "keep-user-data\n");
  assert.deepEqual(state.started, ["coding"]);
});

test("plugin install and remove write profile files that listProfilePlugins can read back", async () => {
  const { home, maintenance, state } = harness();
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  assert.equal(plan.scope, "space");
  assert.ok(plan.changes.some((line) => line.includes("dsh-outline@1.2.3")));
  assert.ok(plan.changes.some((line) => /restart/i.test(line)));
  assert.deepEqual(plan.runningSpaceIds, ["coding"]);
  const result = await maintenance.execute(plan.id, jobCtx());
  assert.equal(result, undefined);
  const installed = listProfilePlugins(home, "coding");
  assert.equal(installed.some((item) => item.name === "dsh-outline" && item.version === "1.2.3"), true);
  const library = readPluginLibrary(home);
  assert.equal(library.some((entry) => entry.packageName === "dsh-outline" && entry.spec === "dsh-outline@1.2.3"), true);
  assert.deepEqual(state.stopped, ["coding"]);
  assert.deepEqual(state.started, ["coding"]);

  const remove = await maintenance.preview({ kind: "plugin.remove", spaceId: "coding", packageName: "dsh-outline" });
  await maintenance.execute(remove.id, jobCtx());
  assert.equal(listProfilePlugins(home, "coding").some((item) => item.name === "dsh-outline"), false);
});

test("batch plugin install stops at the first failure and does not run later spaces", async () => {
  const { home, maintenance, state } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      if (profile === "notes") throw new Error("notes install failed");
      await addFromTarball(dshHome, profile, spec);
    },
  });
  writeManifest(home, "notes", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  writeManifest(home, "lab", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  state.status.notes = "stopped";
  state.status.lab = "stopped";
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding", "notes", "lab"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  const messages: string[] = [];
  const ctx = jobCtx();
  const capturing = {
    ...ctx,
    message: (text: string) => {
      messages.push(text);
    },
  };
  await assert.rejects(
    () => maintenance.execute(plan.id, capturing),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.context?.spaceId, "notes");
      assert.equal(error.context?.packageName, "dsh-outline");
      assert.equal(error.context?.stage, "install");
      assert.equal(error.context?.pluginAttribution, "known");
      return matchCode("workbench/failed")(error);
    },
  );
  assert.equal(listProfilePlugins(home, "coding").some((item) => item.name === "dsh-outline"), true);
  assert.equal(listProfilePlugins(home, "notes").some((item) => item.name === "dsh-outline"), false);
  assert.equal(listProfilePlugins(home, "lab").some((item) => item.name === "dsh-outline"), false);
  const reported = messages.join("\n");
  assert.match(reported, /notes/);
  assert.match(reported, /dsh-outline/);
  assert.match(reported, /install/);
  assert.doesNotMatch(reported, /空间 coding/);
});

test("readonly plugin query does not sync the library or write the catalog cache", async () => {
  const { home, maintenance } = harness();
  const libraryPath = join(home, "hub", PLUGIN_LIBRARY_FILE);
  const cachePath = join(home, "hub", CATALOG_CACHE_FILE);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(libraryPath, `${JSON.stringify({ plugins: [] }, null, 2)}\n`);
  const before = readFileSync(libraryPath, "utf8");
  const rows = await maintenance.plugins("outline");
  assert.ok(rows.some((row) => row.packageName === "dsh-outline"));
  assert.equal(readFileSync(libraryPath, "utf8"), before);
  assert.equal(existsSync(cachePath), false);
  assert.ok(rows.every((row) => !("tarball" in row) && !("spec" in row) && !("path" in row)));
});

test("exact npm id query returns a server-side catalog candidate without writing hub cache", async () => {
  const { home, maintenance } = harness({
    fetch: packumentFetch({
      "dsh-new-plugin": {
        name: "dsh-new-plugin",
        versions: { "2.0.0": { dist: { tarball: "https://registry.npmjs.org/dsh-new-plugin/-/dsh-new-plugin-2.0.0.tgz" } } },
        "dist-tags": { latest: "2.0.0" },
      },
    }),
  });
  const rows = await maintenance.plugins("dsh-new-plugin");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].packageName, "dsh-new-plugin");
  assert.equal(rows[0].version, null);
  assert.equal(existsSync(join(home, "hub", CATALOG_CACHE_FILE)), false);
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "dsh-new-plugin",
    version: "2.0.0",
  });
  assert.ok(existsSync(join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_REGISTRY_FILE)));
  assert.equal(existsSync(join(home, "hub", CATALOG_CACHE_FILE)), false);
  assert.ok(plan.changes.some((line) => line.includes("dsh-new-plugin@2.0.0")));
});

test("toggle plan uses install/remove semantics and says a restart is required", async () => {
  const { maintenance } = harness();
  const plan = await maintenance.preview({
    kind: "plugin.toggle",
    spaceId: "coding",
    pluginId: "urzeye/dsh-outline",
    enabled: true,
  });
  assert.ok(plan.changes.some((line) => /install\/remove/i.test(line)));
  assert.ok(plan.changes.some((line) => /not a hot toggle/i.test(line)));
});

test("snapshot create is whole-home, stops owned spaces, and public DTO strips home and bin", async () => {
  const { home, maintenance, state, snapRoot, runtime } = snapshotHarness();
  const plan = await maintenance.preview({ kind: "snapshot.create" });
  assert.equal(plan.scope, "home");
  assert.ok(plan.affectedSpaceIds.includes("spaces-hub"));
  assert.ok(plan.affectedSpaceIds.includes("coding"));
  assert.ok(plan.changes.some((line) => /entire Home/i.test(line)));
  const result = await maintenance.execute(plan.id, jobCtx());
  assert.equal(typeof result?.snapshotId, "string");
  assert.equal(state.stopAll, 1);
  assert.deepEqual(state.started, []);
  assert.equal(state.reinitialized, 1);
  assert.deepEqual(state.maintenance, [true, false]);
  const listed = await maintenance.snapshots();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, result?.snapshotId);
  assert.equal("home" in listed[0], false);
  assert.equal("binRelative" in listed[0], false);
  assert.equal("bin" in listed[0], false);
  const raw = JSON.parse(readFileSync(join(snapRoot, listed[0].id, "manifest.json"), "utf8")) as { home: string; binRelative: string };
  assert.ok(raw.home);
  assert.ok(raw.binRelative);
  const one = await maintenance.snapshot(listed[0].id);
  assert.equal(one.restorable, true);
  assert.equal(one.runtimeVersion, runtime.version);
  assert.ok(existsSync(join(home, "profiles", "coding")));
});

test("runtime upgrade of an incompatible version is refused, but install remains a candidate", async () => {
  const { maintenance } = harness({ compatible: () => false });
  await assert.rejects(
    () => maintenance.preview({ kind: "runtime.upgrade", version: "0.1.5-rc.2" }),
    matchCode("workbench/unsupported"),
  );
  const plan = await maintenance.preview({ kind: "runtime.install", version: "0.1.5-rc.2" });
  assert.ok(plan.changes.some((line) => /unverified candidate/i.test(line)));
  const result = await maintenance.execute(plan.id, jobCtx());
  assert.equal(result?.runtimeVersion, "0.1.5-rc.2");
});

test("lost progress persistence or uncertain child termination keeps the plan open for recovery", async () => {
  for (const failure of [new WorkbenchJobError("workbench/persist-failed"), new ProcessTerminationError("unknown child")]) {
    const { maintenance, home, state } = harness();
    const plan = await maintenance.preview({ kind: "runtime.install", version: "0.1.5-rc.1" });
    const ctx = jobCtx();
    const phase = ctx.phase;
    ctx.phase = value => { if (value === "install") throw failure; phase(value); };
    await assert.rejects(() => maintenance.execute(plan.id, ctx), (error: unknown) =>
      error instanceof WorkbenchJobError && ["workbench/persist-failed", "workbench/failed"].includes(error.code));
    assert.equal(JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "plans", `${plan.id}.json`), "utf8")).status, "running");
    assert.equal(state.reinitialized, 0);
    assert.equal(state.maintenance.at(-1), true);
  }
});

test("upgrade failure with proven live home may reinitialize the manager", async () => {
  const ctx = await upgradeHarness();
  const plan = await ctx.maintenance.preview({ kind: "runtime.upgrade", version: "0.9.9" });
  assert.equal(plan.scope, "home");
  await assert.rejects(() => ctx.maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.1.1-rc.2");
  assert.equal(ctx.runtimes.current()?.version, "0.1.1-rc.2");
  assert.equal(existsSync(join(ctx.home, UPGRADE_STAGE_DIR, UPGRADE_JOURNAL_FILE)), false);
  assert.deepEqual(ctx.order.filter((item) => item === "reinitialize" || item === "upgrade-fail"), [
    "upgrade-fail",
    "reinitialize",
  ]);
});

test("upgrade failure with leftover journal must not start the manager", async () => {
  const { maintenance, state, home } = harness({
    compatible: () => true,
  });
  mkdirSync(join(home, UPGRADE_STAGE_DIR), { recursive: true });
  writeFileSync(
    join(home, UPGRADE_STAGE_DIR, UPGRADE_JOURNAL_FILE),
    `${JSON.stringify({ phase: "committing", snapshotId: "s", version: "0.9.9", startedAt: "2026-09-12T00:00:00.000Z" })}\n`,
  );
  state.upgrade = async () => {
    throw new Error("commit failed");
  };
  const plan = await maintenance.preview({ kind: "runtime.upgrade", version: "0.9.9" });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
  assert.equal(state.reinitialized, 0);
  assert.equal(state.maintenance.at(-1), true);
  assert.equal(existsSync(join(home, UPGRADE_STAGE_DIR, UPGRADE_JOURNAL_FILE)), true);
});

test("cancel is honored before mutation and ignored after the irreversible point", async () => {
  const { home, maintenance, state } = harness();
  const aborting = new AbortController();
  state.onStop = () => aborting.abort();
  const cancelled = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(
    () => maintenance.execute(cancelled.id, jobCtx(aborting.signal)),
    (error: unknown) => error instanceof WorkbenchJobAbortError,
  );
  assert.equal(listProfilePlugins(home, "coding").some((item) => item.name === "dsh-outline"), false);
  assert.deepEqual(state.started, ["coding"]);

  const late = new AbortController();
  const { maintenance: second, home: home2, state: state2 } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      late.abort();
      await addFromTarball(dshHome, profile, spec);
    },
  });
  const plan = await second.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await second.execute(plan.id, jobCtx(late.signal));
  assert.equal(listProfilePlugins(home2, "coding").some((item) => item.name === "dsh-outline"), true);
  assert.deepEqual(state2.started, ["coding"]);
});

test("recover reconciles a pending snapshot and refuses to wipe an unreadable upgrade journal", async () => {
  let pending: {
    snapshotId: string;
    beforeRestoreId: string;
    runtimeVersion: string;
    binRelative: string;
    startedAt: string;
  } | undefined = {
    snapshotId: "11111111-1111-1111-1111-111111111111",
    beforeRestoreId: "22222222-2222-2222-2222-222222222222",
    runtimeVersion: "0.1.5-rc.1",
    binRelative: "bin.js",
    startedAt: "2026-09-12T00:00:00.000Z",
  };
  let recoveredPending = false;
  const { maintenance, state } = harness({
    pendingRestore: () => pending,
    recoverUpgrade: async () => {
      recoveredPending = true;
      pending = undefined;
      return { restoreCompleted: true };
    },
  });
  await assert.rejects(() => maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(recoveredPending, false);
  assert.ok(pending);
  assert.equal(state.reinitialized, 0);
  assert.equal(state.restoreCalls, 0);
  assert.equal(maintenance.recoveryOutcome(), undefined);

  const blocked = harness();
  mkdirSync(join(blocked.home, UPGRADE_STAGE_DIR), { recursive: true });
  const journal = join(blocked.home, UPGRADE_STAGE_DIR, UPGRADE_JOURNAL_FILE);
  writeFileSync(journal, "{not-json");
  const journalBefore = readFileSync(journal);
  let recovered = false;
  blocked.state.recoverUpgrade = async () => {
    recovered = true;
    return {};
  };
  await assert.rejects(() => blocked.maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(recovered, false);
  assert.deepEqual(readFileSync(journal), journalBefore);
  assert.equal(blocked.maintenance.recoveryOutcome(), undefined);
  assert.equal(blocked.state.reinitialized, 0);
});

test("unreadable pending restore is a conservative recover failure and does not settle jobs", async () => {
  const { maintenance, state } = harness({
    pendingRestore: () => {
      throw new Error("unreadable restore record");
    },
  });
  await assert.rejects(() => maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(maintenance.recoveryOutcome(), undefined);
  assert.equal(state.restoreCalls, 0);
  assert.equal(state.reinitialized, 0);
});

test("recover resets a previous true outcome and empty journals do not settle unrelated jobs", async () => {
  let pending: {
    snapshotId: string;
    beforeRestoreId: string;
    runtimeVersion: string;
    binRelative: string;
    startedAt: string;
  } | undefined = {
    snapshotId: "11111111-1111-1111-1111-111111111111",
    beforeRestoreId: "22222222-2222-2222-2222-222222222222",
    runtimeVersion: "0.1.5-rc.1",
    binRelative: "bin.js",
    startedAt: "2026-09-12T00:00:00.000Z",
  };
  let recovered = false;
  const { maintenance } = harness({
    pendingRestore: () => pending,
    recoverUpgrade: async () => {
      recovered = true;
      pending = undefined;
      return { restoreCompleted: true };
    },
  });
  await assert.rejects(() => maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  await assert.rejects(() => maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(recovered, false);
  assert.ok(pending);
  assert.equal(maintenance.recoveryOutcome(), undefined);
});

test("recover does not change pointers when stopAll fails", async () => {
  let recovered = false;
  const { maintenance, state } = harness({
    pendingRestore: () => ({
      snapshotId: "11111111-1111-1111-1111-111111111111",
      beforeRestoreId: "22222222-2222-2222-2222-222222222222",
      runtimeVersion: "0.1.5-rc.1",
      binRelative: "bin.js",
      startedAt: "2026-09-12T00:00:00.000Z",
    }),
    recoverUpgrade: async () => {
      recovered = true;
      return { restoreCompleted: true };
    },
  });
  state.stopAllImpl = async () => {
    throw new Error("stop failed");
  };
  await assert.rejects(() => maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(recovered, false);
  assert.equal(state.reinitialized, 0);
  assert.equal(state.stopAll, 0);
  assert.equal(state.restoreCalls, 0);
  assert.equal(maintenance.recoveryOutcome(), undefined);
});

test("upgrade stage rollback does not clear plugin-mutation evidence", async () => {
  const { home, maintenance, state } = harness();
  mkdirSync(join(home, UPGRADE_STAGE_DIR), { recursive: true });
  const journal = join(home, UPGRADE_STAGE_DIR, UPGRADE_JOURNAL_FILE);
  writeFileSync(
    journal,
    `${JSON.stringify({ phase: "preparing", planId: "plan-upgrade-1", snapshotId: "11111111-1111-1111-1111-111111111111" })}\n`,
  );
  const mutation = `${JSON.stringify({
    schemaVersion: 1,
    phase: "mutating",
    planId: "plan-plugin-1",
    spaceIds: ["coding"],
    expected: [],
    startedAt: "2026-01-01T00:00:00.000Z",
  })}\n`;
  mkdirSync(join(home, WORKBENCH_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILE), mutation);
  const journalBefore = readFileSync(journal);
  state.recoverUpgrade = async () => {
    rmSync(journal, { force: true });
    return { upgradeRolledBack: true };
  };
  await assert.rejects(() => maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(readFileSync(join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILE), "utf8"), mutation);
  assert.deepEqual(readFileSync(journal), journalBefore);
  assert.equal(state.reinitialized, 0);
  assert.equal(state.restoreCalls, 0);
});

test("runtime upgrade execute passes the stored plan id", async () => {
  const { maintenance, state } = harness();
  state.upgrade = async (version) => ({
    version,
    snapshotId: "11111111-1111-1111-1111-111111111111",
    profiles: ["coding", "spaces-hub"],
    official: {},
  });
  const plan = await maintenance.preview({ kind: "runtime.upgrade", version: "0.1.5-rc.1" });
  await maintenance.execute(plan.id, jobCtx());
  assert.equal(state.lastUpgradePlanId, plan.id);
});

test("recover does not treat a junctioned profiles directory as readable home config", async () => {
  let pending: {
    snapshotId: string;
    beforeRestoreId: string;
    runtimeVersion: string;
    binRelative: string;
    startedAt: string;
  } | undefined = {
    snapshotId: "11111111-1111-1111-1111-111111111111",
    beforeRestoreId: "22222222-2222-2222-2222-222222222222",
    runtimeVersion: "0.1.5-rc.1",
    binRelative: "bin.js",
    startedAt: "2026-09-12T00:00:00.000Z",
  };
  let recovered = false;
  const { home, maintenance, state } = harness({
    pendingRestore: () => pending,
    recoverUpgrade: async () => {
      recovered = true;
      pending = undefined;
      return { restoreCompleted: true };
    },
  });
  const profiles = join(home, "profiles");
  const hidden = join(home, "elsewhere-profiles");
  rmSync(hidden, { recursive: true, force: true });
  rmSync(profiles, { recursive: true, force: true });
  mkdirSync(hidden, { recursive: true });
  symlinkSync(hidden, profiles, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => maintenance.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(recovered, false);
  assert.ok(pending);
  assert.equal(state.restoreCalls, 0);
  assert.equal(maintenance.recoveryOutcome(), undefined);
});

test("plugin mutation failure keeps diagnostic files, stops the target, and does not fake a manifest rollback", async () => {
  const { home, maintenance, state } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      await addFromTarball(dshHome, profile, spec);
      mkdirSync(join(dshHome, "profiles", profile, "node_modules", "dsh-outline"), { recursive: true });
      writeFileSync(
        join(dshHome, "profiles", profile, "node_modules", "dsh-outline", "package.json"),
        `${JSON.stringify({ name: "dsh-outline", version: "9.9.9" }, null, 2)}\n`,
      );
    },
  });
  const before = readManifest(home, "coding");
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
  assert.equal(readManifest(home, "coding").dependencies?.["dsh-outline"], "1.2.3");
  assert.notDeepEqual(readManifest(home, "coding"), before);
  assert.equal(state.started.includes("coding"), false);
  assert.equal(state.status.coding, "stopped");
  assert.equal(existsSync(join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILE)), true);
});

test("plugin install failure names space, stage, and package", async () => {
  const { maintenance } = harness({
    pluginAdd: async () => {
      throw new Error("cli exited 1: missing peer");
    },
  });
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(
    () => maintenance.execute(plan.id, jobCtx()),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.context?.spaceId, "coding");
      assert.equal(error.context?.packageName, "dsh-outline");
      assert.equal(error.context?.pluginAttribution, "known");
      assert.equal(error.context?.stage, "install");
      assert.match(error.message, /The job failed/);
      return true;
    },
  );
});

test("plugin lock mismatch fails verification and interrupted mutation stays open for recover", async () => {
  const { home, maintenance, state } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      await addFromTarball(dshHome, profile, spec);
      writeFileSync(join(dshHome, "profiles", profile, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    },
  });
  writeFileSync(join(home, "profiles", "coding", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
  assert.equal(existsSync(join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILE)), true);

  const again = createMaintenance(home, state, { fetch: defaultOutlineFetch(), pluginAdd: addFromTarball });
  await assert.rejects(() => again.recover(jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(state.started.includes("coding"), false);
});

test("owned file tarball pins are verified against the actual installed version", async () => {
  const { home, maintenance } = harness({ pluginAdd: async (dshHome, profile, spec) => {
    await addFromTarball(dshHome, profile, spec);
    const manifest = readManifest(dshHome, profile);
    manifest.dependencies!["dsh-outline"] = `file:${spec.replaceAll("\\", "/")}`;
    writeFileSync(join(dshHome, "profiles", profile, "package.json"), JSON.stringify(manifest));
    writeFixtureLock(dshHome, profile, manifest.dependencies!);
  } });
  const plan = await maintenance.preview({ kind: "plugin.install", spaceIds: ["coding"], catalogId: "urzeye/dsh-outline", version: "1.2.3" });
  await maintenance.execute(plan.id, jobCtx());
  assert.match(readManifest(home, "coding").dependencies!["dsh-outline"], /^file:/);
  assert.equal(JSON.parse(readFileSync(join(home, "profiles", "coding", "node_modules", "dsh-outline", "package.json"), "utf8")).version, "1.2.3");
});

test("manifest-only plugin installation cannot be reported as successful", async () => {
  const { maintenance } = harness({ pluginAdd: async (dshHome, profile, spec) => {
    await addFromTarball(dshHome, profile, spec);
    rmSync(join(dshHome, "profiles", profile, "node_modules", "dsh-outline", "package.json"));
  } });
  const plan = await maintenance.preview({ kind: "plugin.install", spaceIds: ["coding"], catalogId: "urzeye/dsh-outline", version: "1.2.3" });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
});

test("plans are consumed once and invalid plan records are rejected without rewriting", async () => {
  const { home, maintenance, snapRoot, runtime, state } = snapshotHarness();
  const plan = await maintenance.preview({ kind: "snapshot.create" });
  const first = await maintenance.execute(plan.id, jobCtx());
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/conflict"));
  assert.equal((await maintenance.snapshots()).length, 1);
  assert.equal(first?.snapshotId, (await maintenance.snapshots())[0]?.id);

  const future = join(home, WORKBENCH_CONTROL_DIR_NAME, "plans", `${plan.id}.json`);
  const raw = JSON.parse(readFileSync(future, "utf8")) as { schemaVersion: number; expiresAt: string };
  assert.equal(raw.schemaVersion, 1);
  const badId = "bad-schema";
  const badPath = join(home, WORKBENCH_CONTROL_DIR_NAME, "plans", `${badId}.json`);
  writeFileSync(badPath, `${JSON.stringify({ ...raw, id: badId, schemaVersion: 999, status: "previewed" }, null, 2)}\n`);
  const before = readFileSync(badPath, "utf8");
  await assert.rejects(() => maintenance.execute(badId, jobCtx()), matchCode("workbench/invalid-input"));
  assert.equal(readFileSync(badPath, "utf8"), before);

  const expiredPath = join(home, WORKBENCH_CONTROL_DIR_NAME, "plans", "bad-date.json");
  writeFileSync(
    expiredPath,
    `${JSON.stringify({ ...raw, id: "bad-date", expiresAt: "not-a-date", status: "previewed" }, null, 2)}\n`,
  );
  const dateBefore = readFileSync(expiredPath, "utf8");
  await assert.rejects(() => maintenance.execute("bad-date", jobCtx()), matchCode("workbench/invalid-input"));
  assert.equal(readFileSync(expiredPath, "utf8"), dateBefore);
  await assert.rejects(() => maintenance.execute("../escape", jobCtx()), matchCode("workbench/invalid-input"));
  assert.ok(existsSync(join(snapRoot, first?.snapshotId ?? "missing", "manifest.json")));
  assert.equal(runtime.version, "0.1.5-rc.1");
  assert.equal(state.stopAll >= 1, true);
});

test("config restore preview is forbidden", async () => {
  const { maintenance, state } = harness();
  state.backups = [{ id: "cordis.patch.yml.bak-1", createdAt: "2026-01-01T00:00:00.000Z", size: 10, tooLarge: false }];
  await assert.rejects(
    () => maintenance.preview({
      kind: "config.restore",
      spaceId: "spaces-hub",
      backupId: "cordis.patch.yml.bak-1",
    }),
    matchCode("workbench/forbidden"),
  );
});

test("snapshot restore preview and execute are forbidden", async () => {
  const { home, maintenance, state } = harness();
  const snapshotId = "11111111-1111-1111-1111-111111111111";
  const codingManifest = join(home, "profiles", "coding", "package.json");
  const before = readFileSync(codingManifest);
  await assert.rejects(
    () => maintenance.preview({ kind: "snapshot.restore", snapshotId }),
    matchCode("workbench/forbidden"),
  );
  assert.equal(state.restoreCalls, 0);
  assert.equal(existsSync(join(home, WORKBENCH_CONTROL_DIR_NAME, "plans")), false);
  assert.deepEqual(readFileSync(codingManifest), before);

  const planId = "plan-snapshot-restore";
  const planDir = join(home, WORKBENCH_CONTROL_DIR_NAME, "plans");
  mkdirSync(planDir, { recursive: true });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  writeFileSync(
    join(planDir, `${planId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      id: planId,
      public: {
        id: planId,
        kind: "snapshot.restore",
        title: "Restore whole-home snapshot",
        scope: "home",
        affectedSpaceIds: [],
        runningSpaceIds: [],
        changes: [],
        destructive: true,
        expiresAt,
      },
      command: { kind: "snapshot.restore", snapshotId },
      fingerprint: "fp",
      createdAt: new Date().toISOString(),
      expiresAt,
      status: "previewed",
    })}\n`,
  );
  await assert.rejects(() => maintenance.execute(planId, jobCtx()), matchCode("workbench/forbidden"));
  assert.equal(state.restoreCalls, 0);
  assert.deepEqual(readFileSync(codingManifest), before);
});

test("manager config restore reinitializes the manager; ordinary restore stays stopped", async () => {
  const { home, maintenance, state } = harness();
  state.backups = [{ id: "cordis.patch.yml.bak-1", createdAt: "2026-01-01T00:00:00.000Z", size: 10, tooLarge: false }];
  const codingManifest = join(home, "profiles", "coding", "package.json");
  const before = readFileSync(codingManifest);
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "config.restore",
        spaceId: "spaces-hub",
        backupId: "cordis.patch.yml.bak-1",
      }),
    matchCode("workbench/forbidden"),
  );
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "config.restore",
        spaceId: "coding",
        backupId: "cordis.patch.yml.bak-1",
      }),
    matchCode("workbench/forbidden"),
  );
  assert.deepEqual(state.restored, []);
  assert.equal(state.reinitialized, 0);
  assert.equal(state.started.includes("coding"), false);
  assert.deepEqual(readFileSync(codingManifest), before);
});

test("unknown errors become the static public message and plans are not executed without the write lock", async () => {
  const { maintenance, state } = harness();
  state.writable = false;
  await assert.rejects(() => maintenance.preview({ kind: "snapshot.create" }), (error: unknown) => {
    assert.ok(error instanceof WorkbenchMaintenanceError);
    assert.equal(error.code, "workbench/forbidden");
    assert.equal(error.message, WORKBENCH_MAINTENANCE_ERROR["workbench/forbidden"]);
    assert.equal(error.message.includes("C:\\"), false);
    return true;
  });
  const logs: string[] = [];
  const exploding = harness({
    snapshotsCreate: async () => {
      throw new Error("ENOENT C:\\\\secret\\\\home\\\\bin.js token=abcd");
    },
    log: (message, error) => {
      logs.push(`${message}:${error instanceof Error ? error.message : String(error)}`);
    },
  });
  exploding.state.writable = true;
  const plan = await exploding.maintenance.preview({ kind: "snapshot.create" });
  await assert.rejects(() => exploding.maintenance.execute(plan.id, jobCtx()), (error: unknown) => {
    assert.ok(error instanceof WorkbenchMaintenanceError);
    assert.equal(error.message, WORKBENCH_MAINTENANCE_ERROR["workbench/failed"]);
    assert.equal(String(error.message).includes("token="), false);
    assert.equal(String(error.message).includes("bin.js"), false);
    return true;
  });
  assert.ok(logs.some((line) => line.includes("bin.js")));
});

interface HarnessState {
  writable: boolean;
  status: Record<string, ProfileStatus>;
  stopped: string[];
  started: string[];
  stopAll: number;
  reinitialized: number;
  maintenance: boolean[];
  order: string[];
  restored: string[];
  backups: Array<{ id: string; createdAt: string; size: number; tooLarge: boolean }>;
  restoreCalls: number;
  onStop?: () => void;
  stopAllImpl?: () => Promise<void>;
  pendingRestore?: () => ReturnType<SnapshotExecutor["pendingRestore"]>;
  recoverUpgrade?: CoordinatedUpgrade["recover"];
  lastUpgradePlanId?: string;
  upgrade?: (version: string, planId?: string) => Promise<{ version: string; snapshotId: string; profiles: string[]; official: { base?: string; web?: string } }>;
}

function harness(overrides: {
  packageUpgrade?: WorkbenchMaintenancePorts["packageUpgrade"];
  now?: () => Date;
  fetch?: MaintenanceFetcher;
  compatible?: (version: string) => boolean;
  pluginAdd?: (home: string, profile: string, spec: string) => Promise<void>;
  snapshotsCreate?: SnapshotExecutor["create"];
  pendingRestore?: () => ReturnType<SnapshotExecutor["pendingRestore"]>;
  recoverUpgrade?: CoordinatedUpgrade["recover"];
  log?: (message: string, error?: unknown) => void;
} = {}) {
  const home = tempDir("dsh-spaces-maint-");
  writeManifest(home, "coding", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  writeManifest(home, "spaces-hub", {
    bundles: [BASE, WEB, FULL_SPACES_PACKAGE],
    dependencies: { [BASE]: "1", [WEB]: "1", [FULL_SPACES_PACKAGE]: "0.2.0" },
  });
  const state: HarnessState = {
    writable: true,
    status: { coding: "running", "spaces-hub": "running" },
    stopped: [],
    started: [],
    stopAll: 0,
    reinitialized: 0,
    maintenance: [],
    order: [],
    restored: [],
    backups: [],
    restoreCalls: 0,
    pendingRestore: overrides.pendingRestore,
    recoverUpgrade: overrides.recoverUpgrade,
  };
  const maintenance = createMaintenance(home, state, overrides);
  return { home, state, maintenance };
}

function createMaintenance(
  home: string,
  state: HarnessState,
  overrides: {
    packageUpgrade?: WorkbenchMaintenancePorts["packageUpgrade"];
    now?: () => Date;
    fetch?: MaintenanceFetcher;
    compatible?: (version: string) => boolean;
    pluginAdd?: (home: string, profile: string, spec: string) => Promise<void>;
    snapshotsCreate?: SnapshotExecutor["create"];
    pendingRestore?: () => ReturnType<SnapshotExecutor["pendingRestore"]>;
    recoverUpgrade?: CoordinatedUpgrade["recover"];
    log?: (message: string, error?: unknown) => void;
  } = {},
): WorkbenchMaintenance {
  const runtime: SnapshotRuntime = { version: "0.1.5-rc.1", root: home, binRelative: "bin.js" };
  const ports: WorkbenchMaintenancePorts = {
    home,
    registry: new ProfileRegistry(home),
    lock: { run: async (_label, action) => action() } as HomeOperationLock,
    snapshots: {
      list: () => [],
      preview: () => {
        throw new Error("missing snapshot");
      },
      runtimeBin: () => "bin.js",
      runtimeRoot: () => home,
      pendingRestore: () => state.pendingRestore?.() ?? overrides.pendingRestore?.(),
      completeRestore: () => undefined,
      create: overrides.snapshotsCreate ?? (async () => {
        throw new Error("snapshot create not stubbed");
      }),
      restore: async () => {
        state.restoreCalls += 1;
        throw new Error("snapshot restore must not be called");
      },
      recover: async () => state.pendingRestore?.(),
      delete: async () => undefined,
    } as SnapshotExecutor,
    runtimes: {
      inventory: () => ({
        installed: [{ version: "0.1.5-rc.1", bin: "bin.js", dir: home }],
        current: { version: "0.1.5-rc.1", bin: "bin.js", origin: "store" as const },
      }),
      catalog: async () => ({ versions: [{ version: "0.1.5-rc.2" }], distTags: { next: "0.1.5-rc.2" } }),
      install: async (version: string) => ({ version, bin: "bin.js", dir: home }),
    } as WorkbenchMaintenancePorts["runtimes"],
    upgrades: {
      preview: (version: string) => ({ version, currentVersion: "0.1.5-rc.1", profiles: [] }),
      upgrade: async (version: string, planId?: string) => {
        state.lastUpgradePlanId = planId;
        if (state.upgrade) return state.upgrade(version, planId);
        throw new Error("upgrade not stubbed");
      },
      restore: async () => {
        throw new Error("restore not stubbed");
      },
      recover: async () => {
        state.order.push("recover");
        return state.recoverUpgrade ? state.recoverUpgrade() : overrides.recoverUpgrade ? overrides.recoverUpgrade() : {};
      },
    } as CoordinatedUpgrade,
    diagnostics: {
      get: (name: string) => ({
        name,
        status: state.status[name] ?? "stopped",
        logs: [],
        backups: state.backups,
        canRestore: name !== "web",
      }),
      restoreBackup: async (name: string) => {
        state.restored.push(name);
        state.stopped.push(name);
        state.status[name] = "stopped";
      },
    } as DiagnosticsService,
    managerId: () => "spaces-hub",
    assertWritable: () => {
      if (!state.writable) throw new Error("owner missing C:\\\\Users\\\\admin\\\\.dsh");
    },
    validateSpace: (spaceId: string, allowManager?: boolean) => {
      if (!(spaceId in state.status) && !["coding", "spaces-hub"].includes(spaceId)) throw new Error("unknown space");
      if (!allowManager && spaceId === "spaces-hub") throw new Error("manager protected");
    },
    statusOf: (spaceId: string) => state.status[spaceId] ?? "stopped",
    ownedSpaceIds: () => [...new Set(["spaces-hub", "coding", ...Object.keys(state.status)])],
    stopSpace: async (spaceId: string) => {
      state.onStop?.();
      state.stopped.push(spaceId);
      state.status[spaceId] = "stopped";
    },
    stopAll: async () => {
      if (state.stopAllImpl) return state.stopAllImpl();
      state.order.push("stopAll");
      state.stopAll += 1;
      for (const id of ["spaces-hub", "coding"]) {
        state.stopped.push(id);
        state.status[id] = "stopped";
      }
    },
    startSpace: async (spaceId: string) => {
      state.started.push(spaceId);
      state.status[spaceId] = "running";
    },
    currentRuntime: () => runtime,
    reinitializeManager: async () => {
      state.order.push("reinitialize");
      state.reinitialized += 1;
    },
    setMaintenance: (active: boolean) => {
      state.maintenance.push(active);
    },
    isCompatibleRuntime: overrides.compatible ?? ((version: string) => version === "0.1.5-rc.1"),
    packageUpgrade: overrides.packageUpgrade,
  };
  return new WorkbenchMaintenance(ports, {
    now: overrides.now,
    fetch: overrides.fetch ?? defaultOutlineFetch(),
    packageSource: "official",
    pluginAdd: overrides.pluginAdd ?? addFromTarball,
    pluginRemove: removeFromManifest,
    setSpacePlugin: async (dshHome, profile, id, enabled) => {
      if (enabled) await addNamed(dshHome, profile, id === "urzeye/dsh-outline" ? "dsh-outline" : id, "1.2.3");
      else await removeFromManifest(dshHome, profile, id === "urzeye/dsh-outline" ? "dsh-outline" : id);
      return { running: [] };
    },
    log: overrides.log,
  });
}

function snapshotHarness() {
  const home = tempDir("dsh-spaces-snap-");
  const snapRoot = tempDir("dsh-spaces-snap-root-");
  const runtimeDir = tempDir("dsh-spaces-rt-");
  writeFileSync(join(runtimeDir, "bin.js"), "cli\n");
  const runtime: SnapshotRuntime = { version: "0.1.5-rc.1", root: runtimeDir, binRelative: "bin.js" };
  writeManifest(home, "coding", { bundles: [BASE], dependencies: { [BASE]: "1" } });
  writeManifest(home, "spaces-hub", { bundles: [BASE, FULL_SPACES_PACKAGE], dependencies: { [BASE]: "1", [FULL_SPACES_PACKAGE]: "0.2.0" } });
  writeFileSync(join(home, "settings.yaml"), "settings\n");
  const store = new SnapshotStore({ home, root: snapRoot });
  const state: HarnessState = {
    writable: true,
    status: { coding: "running", "spaces-hub": "running" },
    stopped: [],
    started: [],
    stopAll: 0,
    reinitialized: 0,
    maintenance: [],
    order: [],
    restored: [],
    backups: [],
    restoreCalls: 0,
  };
  const ports: WorkbenchMaintenancePorts = {
    home,
    registry: new ProfileRegistry(home),
    lock: { run: async (_label, action) => action() } as HomeOperationLock,
    snapshots: executorFromStore(store),
    runtimes: {
      inventory: () => ({ installed: [{ version: runtime.version, bin: join(runtimeDir, "bin.js"), dir: runtimeDir }] }),
      catalog: async () => ({ versions: [], distTags: {} }),
      install: async (version: string) => ({ version, bin: join(runtimeDir, "bin.js"), dir: runtimeDir }),
    } as WorkbenchMaintenancePorts["runtimes"],
    upgrades: {
      preview: (version: string) => ({ version, profiles: [] }),
      upgrade: async () => {
        throw new Error("unused");
      },
      restore: async (id: string) => store.restore(id, runtime),
      recover: async () => {
        const pending = store.recover() ?? store.pendingRestore();
        if (pending) store.completeRestore();
        return pending ? { restoreCompleted: true } : {};
      },
    } as CoordinatedUpgrade,
    diagnostics: { get: () => ({ name: "coding", status: "stopped", logs: [], backups: [], canRestore: true }) } as DiagnosticsService,
    managerId: () => "spaces-hub",
    assertWritable: () => undefined,
    validateSpace: (spaceId: string, allowManager?: boolean) => {
      if (!["coding", "spaces-hub"].includes(spaceId)) throw new Error("unknown");
      if (!allowManager && spaceId === "spaces-hub") throw new Error("manager");
    },
    statusOf: (spaceId: string) => state.status[spaceId] ?? "stopped",
    ownedSpaceIds: () => ["spaces-hub", "coding"],
    stopSpace: async (spaceId: string) => {
      state.stopped.push(spaceId);
      state.status[spaceId] = "stopped";
    },
    stopAll: async () => {
      state.stopAll += 1;
      for (const id of ["spaces-hub", "coding"]) {
        state.stopped.push(id);
        state.status[id] = "stopped";
      }
    },
    startSpace: async (spaceId: string) => {
      state.started.push(spaceId);
      state.status[spaceId] = "running";
    },
    currentRuntime: () => runtime,
    reinitializeManager: async () => {
      state.reinitialized += 1;
    },
    setMaintenance: (active: boolean) => {
      state.maintenance.push(active);
    },
    isCompatibleRuntime: (version: string) => version === runtime.version,
  };
  return {
    home,
    snapRoot,
    runtime,
    state,
    maintenance: new WorkbenchMaintenance(ports, { packageSource: "official", fetch: defaultOutlineFetch() }),
  };
}

async function upgradeHarness() {
  const home = tempDir("dsh-spaces-upg-");
  const snapRoot = tempDir("dsh-spaces-upg-snap-");
  const runtimeRoot = tempDir("dsh-spaces-upg-rt-");
  seedUpgradeProfiles(home);
  const runtimes = new RuntimeStore({
    root: runtimeRoot,
    source: () => "official",
    legacy: () => undefined,
    run: mockInstallRun(),
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  await runtimes.install("0.1.1-rc.2");
  runtimes.select("0.1.1-rc.2");
  const snapshots = new SnapshotStore({ home, root: snapRoot });
  const order: string[] = [];
  const inner = new CoordinatedUpgrade({
    home,
    profiles: () => ["web", "coding"],
    stopAll: async () => undefined,
    drainPlugins: async () => undefined,
    snapshots,
    runtimes,
    runtimeDescriptor: () => descriptor(runtimes),
    runCli: async (_bin, stagedHome, args) => mockUpgradeCli(stagedHome, args),
    smokeWeb: async () => {
      order.push("upgrade-fail");
      throw new Error("smoke failed C:\\\\secret\\\\bin.js");
    },
  });
  const state: HarnessState = {
    writable: true,
    status: { web: "running", coding: "running", "spaces-hub": "running" },
    stopped: [],
    started: [],
    stopAll: 0,
    reinitialized: 0,
    maintenance: [],
    order: [],
    restored: [],
    backups: [],
    restoreCalls: 0,
  };
  const ports: WorkbenchMaintenancePorts = {
    home,
    registry: new ProfileRegistry(home),
    lock: { run: async (_label, action) => action() } as HomeOperationLock,
    snapshots: executorFromStore(snapshots),
    runtimes,
    upgrades: inner,
    diagnostics: { get: () => ({ name: "coding", status: "stopped", logs: [], backups: [], canRestore: true }) } as DiagnosticsService,
    managerId: () => "spaces-hub",
    assertWritable: () => undefined,
    validateSpace: () => undefined,
    statusOf: (spaceId: string) => state.status[spaceId] ?? "stopped",
    ownedSpaceIds: () => ["web", "coding", "spaces-hub"],
    stopSpace: async (spaceId: string) => {
      state.stopped.push(spaceId);
      state.status[spaceId] = "stopped";
    },
    stopAll: async () => {
      state.stopAll += 1;
    },
    startSpace: async (spaceId: string) => {
      state.started.push(spaceId);
    },
    currentRuntime: () => descriptor(runtimes),
    reinitializeManager: async () => {
      order.push("reinitialize");
      state.reinitialized += 1;
    },
    setMaintenance: (active: boolean) => {
      state.maintenance.push(active);
    },
    isCompatibleRuntime: (version: string) => version === "0.9.9" || version === "0.1.1-rc.2",
  };
  return {
    home,
    runtimes,
    order,
    maintenance: new WorkbenchMaintenance(ports, { packageSource: "official", fetch: defaultOutlineFetch() }),
  };
}

function executorFromStore(store: SnapshotStore): SnapshotExecutor {
  return {
    list: () => store.list(),
    preview: (id: string) => store.preview(id),
    runtimeBin: (id: string) => store.runtimeBin(id),
    runtimeRoot: (id: string) => store.runtimeRoot(id),
    pendingRestore: () => store.pendingRestore(),
    completeRestore: () => store.completeRestore(),
    create: async (runtime: SnapshotRuntime, reason?: string) => store.create(runtime, reason),
    restore: async (id: string, runtime?: SnapshotRuntime) => store.restore(id, runtime),
    recover: async () => store.recover(),
    delete: async (id: string) => {
      store.delete(id);
    },
  } as SnapshotExecutor;
}

function jobCtx(signal?: AbortSignal): WorkbenchJobContext {
  const abort = signal ?? new AbortController().signal;
  return {
    signal: abort,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}

function matchCode(code: WorkbenchMaintenanceError["code"] | WorkbenchJobError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof WorkbenchMaintenanceError || error instanceof WorkbenchJobError);
    assert.equal(error.code, code);
    return true;
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeManifest(
  home: string,
  name: string,
  opts: { bundles: string[]; dependencies: Record<string, string> },
): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ dependencies: opts.dependencies, dsh: { profile: { bundles: opts.bundles } } }, null, 2)}\n`,
  );
}

function readManifest(home: string, name: string): {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
} {
  return JSON.parse(readFileSync(join(home, "profiles", name, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
}

async function addFromTarball(home: string, profile: string, spec: string): Promise<void> {
  assert.equal(isHubPluginArchive(home, spec), true);
  const entry = readPluginLibrary(home).find((item) => item.tarball && resolve(home, item.tarball) === resolve(spec));
  assert.ok(entry, "install spec must be a hub library tarball");
  const version = entry.spec.includes("@") ? entry.spec.slice(entry.spec.lastIndexOf("@") + 1) : "0.0.0";
  await addNamed(home, profile, entry.packageName, version);
}

async function addNamed(home: string, profile: string, packageName: string, version: string): Promise<void> {
  const manifest = readManifest(home, profile);
  manifest.dependencies = { ...manifest.dependencies, [packageName]: version };
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
  bundles.add(packageName);
  writeFileSync(
    join(home, "profiles", profile, "package.json"),
    `${JSON.stringify({ dependencies: manifest.dependencies, dsh: { profile: { bundles: [...bundles] } } }, null, 2)}\n`,
  );
  const installedDir = join(home, "profiles", profile, "node_modules", ...packageName.split("/"));
  mkdirSync(installedDir, { recursive: true });
  writeFileSync(join(installedDir, "package.json"), JSON.stringify({ name: packageName, version }));
  writeFixtureLock(home, profile, manifest.dependencies);
}

function writeFixtureLock(home: string, profile: string, dependencies: Record<string, string>) {
  writeFileSync(join(home, "profiles", profile, "pnpm-lock.yaml"), JSON.stringify({
    lockfileVersion: "9.0", importers: { ".": { dependencies: Object.fromEntries(
      Object.entries(dependencies).map(([name, specifier]) => [name, { specifier, version: specifier }]),
    ) } },
  }));
}

async function removeFromManifest(home: string, profile: string, packageName: string): Promise<void> {
  const manifest = readManifest(home, profile);
  const dependencies = { ...manifest.dependencies };
  delete dependencies[packageName];
  const bundles = (manifest.dsh?.profile?.bundles ?? []).filter((item) => item !== packageName);
  writeFileSync(
    join(home, "profiles", profile, "package.json"),
    `${JSON.stringify({ dependencies, dsh: { profile: { bundles } } }, null, 2)}\n`,
  );
  writeFixtureLock(home, profile, dependencies);
}

function defaultOutlineFetch(): MaintenanceFetcher {
  return packumentFetch({
    "dsh-outline": {
      name: "dsh-outline",
      versions: {
        "1.2.3": {
          dist: { tarball: "https://registry.npmjs.org/dsh-outline/-/dsh-outline-1.2.3.tgz" },
          description: "outline",
        },
      },
      "dist-tags": { latest: "1.2.3" },
    },
    "dsh-new-plugin": {
      name: "dsh-new-plugin",
      versions: {
        "2.0.0": { dist: { tarball: "https://registry.npmjs.org/dsh-new-plugin/-/dsh-new-plugin-2.0.0.tgz" } },
      },
      "dist-tags": { latest: "2.0.0" },
    },
  });
}

function packumentFetch(packuments: Record<string, object>): MaintenanceFetcher {
  return async (url) => {
    const tarball = Object.keys(packuments).find((name) => url.includes(`${name}-`) && url.endsWith(".tgz"));
    if (tarball) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      };
    }
    const name = Object.keys(packuments).find((item) => url.includes(encodeURIComponent(item)) || url.endsWith(`/${item}`));
    if (!name) {
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => packuments[name],
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

function seedUpgradeProfiles(home: string): void {
  writeManifest(home, "web", { bundles: [BASE, WEB], dependencies: { [BASE]: "0.1.1-rc.2", [WEB]: "0.1.1-rc.2" } });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "web-bytes\n");
  writeManifest(home, "coding", {
    bundles: [BASE, WEB, "dsh-outline"],
    dependencies: { [BASE]: "0.1.1-rc.2", [WEB]: "0.1.1-rc.2", "dsh-outline": "1.2.3" },
  });
  writeFileSync(
    join(home, "profiles", "coding", "cordis.patch.yml"),
    `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/coding/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/coding/storages')\n`,
  );
  writeManifest(home, "spaces-hub", {
    bundles: [BASE, WEB, FULL_SPACES_PACKAGE],
    dependencies: { [BASE]: "0.1.1-rc.2", [WEB]: "0.1.1-rc.2", [FULL_SPACES_PACKAGE]: "0.2.0" },
  });
}

function descriptor(runtimes: RuntimeStore): SnapshotRuntime {
  const current = runtimes.current();
  if (!current) throw new Error("no current runtime");
  const root = resolve(dirname(current.bin), "..", "..", "..", "..");
  return {
    version: current.version,
    root,
    binRelative: relative(root, current.bin).split(/[/\\]/).join("/"),
  };
}

async function mockUpgradeCli(
  home: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (args.includes("--dump-config")) {
    const name = args[args.indexOf("--profile") + 1];
    if (name === "coding") {
      return {
        code: 0,
        stdout:
          `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/coding/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/coding/storages')\n`,
        stderr: "",
      };
    }
    return { code: 0, stdout: "- id: dsh-web-app\n", stderr: "" };
  }
  if (args.includes("plugin") && args.includes("add")) {
    const name = args[args.indexOf("--profile") + 1];
    const spec = args.at(-1) ?? "";
    const at = spec.lastIndexOf("@");
    const pkg = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const manifest = readManifest(home, name);
    manifest.dependencies = { ...manifest.dependencies, [pkg]: version };
    writeFileSync(
      join(home, "profiles", name, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return { code: 0, stdout: "added", stderr: "" };
  }
  return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
}

function mockInstallRun(): RunProcessFn {
  return async (_command, args) => {
    if (args.includes("install")) {
      const spec = args.find((item) => item.startsWith("@deepseek-ai/dsh@"));
      assert.ok(spec);
      const version = spec.slice("@deepseek-ai/dsh@".length);
      const prefix = args[args.indexOf("--prefix") + 1];
      writeCandidate(prefix, version, version === "0.1.1-rc.2" ? version : "0.2.0", version === "0.1.1-rc.2" ? version : "0.2.1");
      return { code: 0, stdout: "added", stderr: "" };
    }
    if (args.includes("--version")) {
      const bin = args.find((item) => item.endsWith("bin.js")) ?? args[0];
      const pkg = join(bin, "..", "..", "package.json");
      const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
      return { code: 0, stdout: `dsh ${version}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

function writeCandidate(prefix: string, cli: string, base: string, web: string): void {
  const pkg = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "lib", "bin.js"), "console.log('dsh')\n");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version: cli, dependencies: { [BASE]: `^${base}`, [WEB]: `^${web}` } }, null, 2)}\n`,
  );
  mkdirSync(join(prefix, "node_modules", "@deepseek-ai", "dsh-base"), { recursive: true });
  writeFileSync(
    join(prefix, "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
    `${JSON.stringify({ name: BASE, version: base }, null, 2)}\n`,
  );
  mkdirSync(join(prefix, "node_modules", "@deepseek-ai", "dsh-web-app"), { recursive: true });
  writeFileSync(
    join(prefix, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"),
    `${JSON.stringify({ name: WEB, version: web }, null, 2)}\n`,
  );
}
