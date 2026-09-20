import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { ProcessTerminationError } from "../src/main/terminate-process.ts";
import { archiveAbsPath } from "../src/main/plugin-library.ts";
import type { CoordinatedUpgrade } from "../src/main/coordinated-upgrade.ts";
import type { RestoreRecoveryReceipt, SnapshotMeta, SnapshotRuntime } from "../src/shared/snapshots.ts";
import type { WorkbenchJobContext } from "../src/adapters/node/workbench-jobs.ts";
import {
  SPACES_PLUGIN_PACKAGE,
  VIEW_BRIDGE_PACKAGE,
  WORKBENCH_PACKAGE_CATALOG_ID,
  WORKBENCH_UPGRADE_MARKER_FILE,
  WORKBENCH_UPGRADE_RECEIPTS_DIR,
  WORKBENCH_UPGRADE_SNAPSHOT_REASON,
  WorkbenchPackageUpgrade,
  WorkbenchPackageUpgradeError,
} from "../src/adapters/node/workbench-package-upgrade.ts";

const temps: string[] = [];
const PLUGIN = SPACES_PLUGIN_PACKAGE;
const BRIDGE = VIEW_BRIDGE_PACKAGE;
const VERSION = "0.2.0";
const MANAGER = "spaces-hub";
const RUNTIME: SnapshotRuntime = { version: "0.1.5-rc.1", root: "/runtime", binRelative: "bin.js" };

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("ROOT nested settlement cannot substitute a different plan", async () => {
  const home = tempHome();
  seedManager(home);
  const planId = randomUUID();
  const snapshotId = randomUUID();
  const marker = { ...crashMarker(home, planId, snapshotId), settlement: {
    schemaVersion: 1, planId: randomUUID(), snapshotId, outcome: "succeeded", rolledBack: false, at: new Date().toISOString(),
  } };
  writeJson(markerPath(home), marker);
  const upgrade = createUpgrade(home, {});
  await assert.rejects(() => upgrade.recover(jobCtx()));
  assert.deepEqual(readJson(markerPath(home)), marker);
});

test("describe returns undefined when artifacts are missing or not official packages", async () => {
  const home = tempHome();
  const missing = createUpgrade(home, {});
  assert.equal(await missing.describe(), undefined);

  const wrong = packPair(tempHome(), { pluginName: "not-the-plugin" });
  const upgrade = createUpgrade(home, {
    pluginArtifact: wrong.plugin,
    viewBridgeArtifact: wrong.bridge,
  });
  assert.equal(await upgrade.describe(), undefined);
  assert.equal(upgrade.hasEvidence(), false);
});

test("describe reports same-version content replacement via file readback, not package version", async () => {
  const home = tempHome();
  seedManager(home);
  const first = packPair(tempHome(), { pluginBody: "first-index" });
  const second = packPair(tempHome(), { pluginBody: "second-index" });
  installPacked(home, MANAGER, first.plugin);
  installPacked(home, MANAGER, first.bridge);

  const stale = createUpgrade(home, first);
  const current = await stale.describe();
  assert.ok(current);
  assert.equal(current.id, WORKBENCH_PACKAGE_CATALOG_ID);
  assert.equal(current.version, VERSION);
  assert.equal(current.installedVersion, VERSION);
  assert.equal(current.updateAvailable, false);

  const next = createUpgrade(home, second);
  const preview = await next.describe();
  assert.ok(preview);
  assert.equal(preview.version, VERSION);
  assert.equal(preview.installedVersion, VERSION);
  assert.equal(preview.updateAvailable, true);
  assert.notEqual(preview.digest, current.digest);
});

test("describe detects supervisor payload byte changes at the same package version", async () => {
  const home = tempHome();
  seedManager(home);
  const first = packPair(tempHome(), { payloadBody: "payload-a" });
  const second = packPair(tempHome(), { payloadBody: "payload-b" });
  installPacked(home, MANAGER, first.plugin);
  installPacked(home, MANAGER, first.bridge);

  const stale = await createUpgrade(home, first).describe();
  const next = await createUpgrade(home, second).describe();
  assert.ok(stale);
  assert.ok(next);
  assert.equal(stale.version, VERSION);
  assert.equal(next.version, VERSION);
  assert.equal(stale.updateAvailable, false);
  assert.equal(next.updateAvailable, true);
  assert.notEqual(next.digest, stale.digest);
});

test("execute rejects wrong catalog, version, digest, and package name without writing a marker", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const upgrade = createUpgrade(home, pair);
  const preview = await upgrade.describe();
  assert.ok(preview);
  const planId = randomUUID();

  await assert.rejects(
    () => upgrade.execute({ planId, catalogId: PLUGIN, version: preview.version, expectedDigest: preview.digest }, jobCtx()),
    matchCode("invalid-input"),
  );
  await assert.rejects(
    () => upgrade.execute({
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: "9.9.9",
      expectedDigest: preview.digest,
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  await assert.rejects(
    () => upgrade.execute({
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: "0".repeat(64),
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(existsSync(markerPath(home)), false);

  const wrong = packPair(tempHome(), { pluginName: "evil-plugin" });
  const bad = createUpgrade(home, wrong);
  await assert.rejects(
    () => bad.execute({
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: VERSION,
      expectedDigest: preview.digest,
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(existsSync(markerPath(home)), false);
});

test("successful execute installs digest-named archives, reads back contents, and does not shut down the supervisor", async () => {
  const home = tempHome();
  seedManager(home);
  const previous = packPair(tempHome(), { pluginBody: "old-bytes", bridgeBody: "old-bridge", payloadBody: "old-payload" });
  const next = packPair(tempHome(), { pluginBody: "new-bytes", bridgeBody: "new-bridge", payloadBody: "new-payload" });
  installPacked(home, MANAGER, previous.plugin);
  installPacked(home, MANAGER, previous.bridge);

  const events: string[] = [];
  const added: string[] = [];
  const upgrade = createUpgrade(home, {
    ...next,
    events,
    pluginAdd: async (dshHome, profile, spec) => {
      events.push("pluginAdd");
      added.push(spec.replaceAll("\\", "/"));
      mockPluginAdd(dshHome, profile, spec);
    },
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  assert.equal(preview.updateAvailable, true);
  const planId = randomUUID();
  const result = await upgrade.execute({
    planId,
    catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
    version: preview.version,
    expectedDigest: preview.digest,
  }, jobCtx());

  assert.match(result.snapshotId, /^[0-9a-f-]{36}$/i);
  assert.equal(upgrade.hasEvidence(), false);
  assert.deepEqual(events, ["stopAll", "create", "pluginAdd", "pluginAdd", "reinitialize"]);
  assert.equal(events.includes("shutdown"), false);
  assert.equal(added.length, 2);
  assert.match(added[0], /dsh-spaces-plugin-[0-9a-f]{32}\.tgz$/);
  assert.match(added[1], /dsh-spaces-view-bridge-[0-9a-f]{32}\.tgz$/);
  assert.notEqual(added[0], archiveAbsPath(home, "dsh-spaces-plugin").replaceAll("\\", "/"));
  assert.equal(readInstalled(home, PLUGIN, "lib/index.js"), "new-bytes");
  assert.equal(readInstalled(home, BRIDGE, "lib/index.js"), "new-bridge");
  assert.equal(readInstalled(home, PLUGIN, "lib/supervisor/index.js"), "new-payload");
  assert.ok(existsSync(added[0]));
  assert.ok(existsSync(added[1]));

  const after = await upgrade.describe();
  assert.ok(after);
  assert.equal(after.updateAvailable, false);
  assert.equal(after.digest, preview.digest);
  const recovered = await upgrade.recover(jobCtx(), planId);
  assert.deepEqual(recovered, {
    planId: planId.toLowerCase(),
    rolledBack: false,
    outcome: "succeeded",
    snapshotId: result.snapshotId,
  });
});

test("known install failure restores the original snapshot and reinitializes the manager once", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const restores: Array<{ id: string; planId?: string }> = [];
  const events: string[] = [];
  const snapshotId = randomUUID();
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    snapshotId,
    pluginAdd: async () => {
      events.push("pluginAdd");
      throw new Error("plugin add failed");
    },
    restore: async (id, planId) => {
      events.push("restore");
      restores.push({ id, planId });
      return dummyRestore(id);
    },
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  const planId = randomUUID();
  await assert.rejects(
    () => upgrade.execute({
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    /plugin add failed/,
  );
  assert.deepEqual(restores, [{ id: snapshotId.toLowerCase(), planId: planId.toLowerCase() }]);
  assert.ok(events.indexOf("create") < events.indexOf("upgradeRecover"));
  assert.ok(events.indexOf("upgradeRecover") < events.indexOf("restore"));
  assert.ok(events.indexOf("restore") < events.lastIndexOf("reinitialize"));
  assert.equal(events.filter((item) => item === "reinitialize").length, 1);
  assert.equal(upgrade.hasEvidence(), false);
  assert.deepEqual(await upgrade.recover(jobCtx(), planId), {
    planId: planId.toLowerCase(),
    rolledBack: true,
    outcome: "rolled-back",
    snapshotId: snapshotId.toLowerCase(),
  });
});

test("unknown subprocess state keeps the marker and does not roll back", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const events: string[] = [];
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    pluginAdd: async () => {
      events.push("pluginAdd");
      throw new ProcessTerminationError("subprocess state unknown");
    },
    restore: async () => {
      events.push("restore");
      return dummyRestore(randomUUID());
    },
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  const planId = randomUUID();
  await assert.rejects(
    () => upgrade.execute({
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    (error: unknown) => error instanceof ProcessTerminationError,
  );
  assert.equal(upgrade.hasEvidence(), true);
  assert.equal(events.includes("restore"), false);
  assert.equal(events.includes("upgradeRecover"), false);
  const marker = readJson(markerPath(home));
  assert.equal(marker.planId, planId.toLowerCase());
  assert.ok(marker.snapshotId);
  assert.equal(marker.settlement, undefined);
});

test("stopAll failure before a snapshot abandons the plan and is not success", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const events: string[] = [];
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    stopAll: async () => {
      events.push("stopAll");
      throw new Error("stop failed");
    },
    restore: async () => {
      events.push("restore");
      return dummyRestore(randomUUID());
    },
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  const planId = randomUUID();
  await assert.rejects(
    () => upgrade.execute({
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    /stop failed/,
  );
  assert.equal(upgrade.hasEvidence(), false);
  assert.equal(events.includes("restore"), false);
  assert.equal(events.includes("reinitialize"), false);
  const recovered = await upgrade.recover(jobCtx(), planId);
  assert.deepEqual(recovered, {
    planId: planId.toLowerCase(),
    rolledBack: false,
    outcome: "abandoned",
  });
  assert.notEqual(recovered?.outcome, "succeeded");
});

test("ProcessTerminationError before a snapshot keeps evidence", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const upgrade = createUpgrade(home, {
    ...pair,
    stopAll: async () => {
      throw new ProcessTerminationError("stopAll state unknown");
    },
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  await assert.rejects(
    () => upgrade.execute({
      planId: randomUUID(),
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    (error: unknown) => error instanceof ProcessTerminationError,
  );
  assert.equal(upgrade.hasEvidence(), true);
  assert.equal(readJson(markerPath(home)).snapshotId, undefined);
});

test("a new instance recovers a crash marker by restoring the recorded snapshot without starting the manager", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const snapshotId = randomUUID();
  const planId = randomUUID();
  writeJson(markerPath(home), crashMarker(home, planId, snapshotId));

  const events: string[] = [];
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    restore: async (id, recoveredPlan) => {
      events.push("restore");
      assert.equal(id, snapshotId.toLowerCase());
      assert.equal(recoveredPlan, planId.toLowerCase());
      return dummyRestore(id);
    },
  });
  const recovered = await upgrade.recover(jobCtx());
  assert.deepEqual(recovered, {
    planId: planId.toLowerCase(),
    rolledBack: true,
    outcome: "rolled-back",
    snapshotId: snapshotId.toLowerCase(),
  });
  assert.equal(upgrade.hasEvidence(), false);
  assert.deepEqual(events, ["stopAll", "upgradeRecover", "restore"]);
  assert.equal(events.includes("reinitialize"), false);
  assert.deepEqual(await upgrade.recover(jobCtx(), planId), recovered);
});

test("interrupted restore journal is recovered before a second restore can finish", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const snapshotId = randomUUID();
  const events: string[] = [];
  let pending = false;
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    snapshotId,
    pluginAdd: async () => {
      events.push("pluginAdd");
      throw new Error("plugin add failed");
    },
    restore: async (id) => {
      events.push("restore");
      if (!pending) {
        pending = true;
        throw new Error("restore interrupted");
      }
      throw new Error("Unfinished restore is pending; call recover() first");
    },
    recoverUpgrade: async ({ receiptPlanId } = {}) => {
      events.push("upgradeRecover");
      if (!pending) return {};
      pending = false;
      const receipt: RestoreRecoveryReceipt = {
        schemaVersion: 1,
        snapshotId: snapshotId.toLowerCase(),
        beforeRestoreId: randomUUID(),
        runtimeVersion: RUNTIME.version,
        binRelative: RUNTIME.binRelative,
        startedAt: "2026-09-13T00:00:00.000Z",
        planId: receiptPlanId,
        outcome: "completed",
      };
      return { restoreCompleted: true, restoreReceipt: receipt };
    },
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  const planId = randomUUID();
  await assert.rejects(
    () => upgrade.execute({
      planId,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    /restore interrupted/,
  );
  assert.equal(upgrade.hasEvidence(), true);
  assert.equal(events.filter((item) => item === "restore").length, 1);

  const recovered = await upgrade.recover(jobCtx(), planId);
  assert.deepEqual(recovered, {
    planId: planId.toLowerCase(),
    rolledBack: true,
    outcome: "rolled-back",
    snapshotId: snapshotId.toLowerCase(),
  });
  assert.equal(events.filter((item) => item === "restore").length, 1);
  assert.equal(events.filter((item) => item === "upgradeRecover").length, 2);
  assert.equal(upgrade.hasEvidence(), false);
  assert.equal(events.includes("reinitialize"), false);
});

test("recover without a snapshot id abandons the plan and is distinguishable from success", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const planId = randomUUID();
  const marker = crashMarker(home, planId, randomUUID());
  delete marker.snapshotId;
  writeJson(markerPath(home), marker);

  const events: string[] = [];
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    restore: async () => {
      events.push("restore");
      return dummyRestore(randomUUID());
    },
  });
  const recovered = await upgrade.recover(jobCtx());
  assert.deepEqual(recovered, {
    planId: planId.toLowerCase(),
    rolledBack: false,
    outcome: "abandoned",
  });
  assert.notEqual(recovered?.outcome, "succeeded");
  assert.equal(upgrade.hasEvidence(), false);
  assert.equal(events.includes("restore"), false);
  const receipt = readJson(receiptPath(home, planId));
  assert.equal(receipt.outcome, "abandoned");
  assert.equal(receipt.rolledBack, false);
});

test("bad, future, and illegal-identity markers are kept and refused", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const upgrade = createUpgrade(home, pair);

  mkdirSync(dirname(markerPath(home)), { recursive: true });
  writeFileSync(markerPath(home), "{not-json");
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  writeJson(markerPath(home), { schemaVersion: 2, kind: "workbench.upgrade", planId: randomUUID() });
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  writeJson(markerPath(home), crashMarker(home, "not-a-uuid", randomUUID()));
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  const badSnapshot = crashMarker(home, randomUUID(), "not-a-snapshot");
  writeJson(markerPath(home), badSnapshot);
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  const foreign = crashMarker(home, randomUUID(), randomUUID());
  foreign.managerId = "coding";
  writeJson(markerPath(home), foreign);
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  const otherHome = crashMarker(home, randomUUID(), randomUUID());
  otherHome.home = join(home, "other-home");
  writeJson(markerPath(home), otherHome);
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);
});

test("bad or mismatched receipts are kept and cannot stand in for this plan", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const upgrade = createUpgrade(home, pair);
  const planId = randomUUID();
  const snapshotId = randomUUID();
  writeJson(markerPath(home), crashMarker(home, planId, snapshotId));
  mkdirSync(dirname(receiptPath(home, planId)), { recursive: true });
  writeFileSync(receiptPath(home, planId), "{not-json");
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);
  assert.equal(readFileSync(receiptPath(home, planId), "utf8"), "{not-json");

  writeJson(receiptPath(home, planId), {
    schemaVersion: 2,
    planId,
    outcome: "succeeded",
    rolledBack: false,
    at: "2026-09-13T00:00:00.000Z",
  });
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  writeJson(receiptPath(home, planId), {
    schemaVersion: 1,
    planId: randomUUID(),
    snapshotId,
    outcome: "succeeded",
    rolledBack: false,
    at: "2026-09-13T00:00:00.000Z",
  });
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  writeJson(receiptPath(home, planId), {
    schemaVersion: 1,
    planId,
    snapshotId: randomUUID(),
    outcome: "succeeded",
    rolledBack: false,
    at: "2026-09-13T00:00:00.000Z",
  });
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);
  assert.equal(readJson(markerPath(home)).planId, planId.toLowerCase());
});

test("hasEvidence treats unreadable marker paths as present", async () => {
  const home = tempHome();
  seedManager(home);
  const upgrade = createUpgrade(home, packPair(tempHome()));
  mkdirSync(markerPath(home), { recursive: true });
  assert.equal(upgrade.hasEvidence(), true);
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(upgrade.hasEvidence(), true);

  rmSync(markerPath(home), { recursive: true, force: true });
  const outside = tempHome();
  try {
    symlinkSync(outside, markerPath(home), process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }
  assert.equal(upgrade.hasEvidence(), true);
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);
});

test("receipt directory junctions are refused and the marker is kept", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const outside = tempHome();
  mkdirSync(join(home, ".dsh-spaces-control"), { recursive: true });
  try {
    symlinkSync(
      outside,
      join(home, ".dsh-spaces-control", WORKBENCH_UPGRADE_RECEIPTS_DIR),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    return;
  }
  const upgrade = createUpgrade(home, {
    ...pair,
    restore: async (id) => dummyRestore(id),
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  await assert.rejects(
    () => upgrade.execute({
      planId: randomUUID(),
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    matchCode("unavailable"),
  );
  assert.equal(upgrade.hasEvidence(), true);
});

test("concurrent execute keeps the first plan identity and recover can filter by planId", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const gate = latch();
  const firstPlan = randomUUID();
  const secondPlan = randomUUID();
  const upgrade = createUpgrade(home, {
    ...pair,
    pluginAdd: async (dshHome, profile, spec) => {
      await gate.promise;
      mockPluginAdd(dshHome, profile, spec);
    },
  });
  const preview = await upgrade.describe();
  assert.ok(preview);
  const first = upgrade.execute({
    planId: firstPlan,
    catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
    version: preview.version,
    expectedDigest: preview.digest,
  }, jobCtx());
  await waitUntil(() => existsSync(markerPath(home)), "marker");

  await assert.rejects(
    () => upgrade.execute({
      planId: secondPlan,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    matchCode("conflict"),
  );
  await assert.rejects(
    () => upgrade.execute({
      planId: firstPlan,
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    matchCode("conflict"),
  );
  assert.equal(readJson(markerPath(home)).planId, firstPlan.toLowerCase());
  assert.equal(await upgrade.recover(jobCtx(), secondPlan), undefined);
  assert.equal(existsSync(markerPath(home)), true);

  gate.release();
  const result = await first;
  assert.ok(result.snapshotId);
  assert.equal(upgrade.hasEvidence(), false);
  assert.deepEqual(await upgrade.recover(jobCtx(), firstPlan), {
    planId: firstPlan.toLowerCase(),
    rolledBack: false,
    outcome: "succeeded",
    snapshotId: result.snapshotId,
  });
  assert.equal(await upgrade.recover(jobCtx(), secondPlan), undefined);
});

function createUpgrade(
  home: string,
  opts: {
    pluginArtifact?: string;
    viewBridgeArtifact?: string;
    events?: string[];
    snapshotId?: string;
    pluginAdd?: typeof mockPluginAdd;
    restore?: CoordinatedUpgrade["restore"];
    recoverUpgrade?: CoordinatedUpgrade["recover"];
    stopAll?: () => Promise<void>;
  },
): WorkbenchPackageUpgrade {
  const events = opts.events ?? [];
  const snapshotId = opts.snapshotId ?? randomUUID();
  return new WorkbenchPackageUpgrade({
    home,
    managerId: () => MANAGER,
    pluginArtifact: opts.pluginArtifact,
    viewBridgeArtifact: opts.viewBridgeArtifact,
    currentRuntime: () => RUNTIME,
    stopAll: opts.stopAll ?? (async () => {
      events.push("stopAll");
    }),
    reinitializeManager: async () => {
      events.push("reinitialize");
    },
    snapshots: {
      create: async (_runtime, reason) => {
        events.push("create");
        assert.equal(reason, WORKBENCH_UPGRADE_SNAPSHOT_REASON);
        return { id: snapshotId } as SnapshotMeta;
      },
    },
    upgrades: {
      restore: opts.restore ?? (async () => {
        events.push("restore");
        throw new Error("restore should not run");
      }),
      recover: opts.recoverUpgrade ?? (async () => {
        events.push("upgradeRecover");
        return {};
      }),
    },
    pluginAdd: opts.pluginAdd ?? mockPluginAdd,
  });
}

function packPair(
  stagingRoot: string,
  opts: {
    pluginBody?: string;
    bridgeBody?: string;
    payloadBody?: string;
    pluginName?: string;
    version?: string;
  } = {},
): { pluginArtifact: string; viewBridgeArtifact: string; plugin: string; bridge: string } {
  const version = opts.version ?? VERSION;
  const pluginDir = join(stagingRoot, "plugin-src");
  const bridgeDir = join(stagingRoot, "bridge-src");
  writeOfficialPackage(pluginDir, opts.pluginName ?? PLUGIN, version, {
    "lib/index.js": opts.pluginBody ?? "plugin-index",
    "lib/client.js": "plugin-client",
    "lib/typert.host.js": "typert-host",
    "lib/typert.remote-client.js": "typert-remote",
    "lib/supervisor/manifest.json": JSON.stringify({ version, entry: "index.js" }),
    "lib/supervisor/index.js": opts.payloadBody ?? "supervisor-entry",
    "lib/supervisor/snapshot-worker.mjs": "snapshot-worker",
  });
  writeOfficialPackage(bridgeDir, BRIDGE, version, {
    "lib/index.js": opts.bridgeBody ?? "bridge-index",
    "lib/client.js": "bridge-client",
  });
  const plugin = join(stagingRoot, "plugin.tgz");
  const bridge = join(stagingRoot, "bridge.tgz");
  packTgz(pluginDir, plugin);
  packTgz(bridgeDir, bridge);
  return { pluginArtifact: plugin, viewBridgeArtifact: bridge, plugin, bridge };
}

function writeOfficialPackage(
  staging: string,
  name: string,
  version: string,
  files: Record<string, string>,
): void {
  const root = join(staging, "package");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

function packTgz(staging: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const packed = spawnSync(tarExecutable(), ["-czf", dest, "-C", staging, "package"], {
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || "tar pack failed");
}

function mockPluginAdd(home: string, profile: string, spec: string): void {
  const unpacked = tempHome();
  const extracted = spawnSync(tarExecutable(), ["-xf", spec, "-C", unpacked], {
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  });
  if (extracted.status !== 0) throw new Error(extracted.stderr || "tar extract failed");
  const pkg = JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const dest = join(home, "profiles", profile, "node_modules", ...pkg.name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(unpacked, "package"), dest, { recursive: true });
  const manifestPath = join(home, "profiles", profile, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  manifest.dependencies = { ...manifest.dependencies, [pkg.name]: pkg.version };
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
  bundles.add(pkg.name);
  manifest.dsh = { profile: { bundles: [...bundles] } };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function installPacked(home: string, profile: string, tgz: string): void {
  mockPluginAdd(home, profile, tgz);
}

function seedManager(home: string): void {
  const dir = join(home, "profiles", MANAGER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  );
}

function crashMarker(home: string, planId: string, snapshotId: string) {
  return {
    schemaVersion: 1,
    kind: "workbench.upgrade",
    planId,
    catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
    version: VERSION,
    expectedDigest: "a".repeat(64),
    home,
    managerId: MANAGER,
    pluginDigest: "b".repeat(64),
    viewBridgeDigest: "c".repeat(64),
    startedAt: "2026-09-13T00:00:00.000Z",
    snapshotId,
  };
}

function dummyRestore(id: string) {
  return {
    restored: { id } as SnapshotMeta,
    beforeRestore: { id } as SnapshotMeta,
  };
}

function jobCtx(signal?: AbortSignal): WorkbenchJobContext {
  return {
    signal: signal ?? new AbortController().signal,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}

function matchCode(code: WorkbenchPackageUpgradeError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof WorkbenchPackageUpgradeError);
    assert.equal(error.code, code);
    return true;
  };
}

function markerPath(home: string): string {
  return join(home, ".dsh-spaces-control", WORKBENCH_UPGRADE_MARKER_FILE);
}

function receiptPath(home: string, planId: string): string {
  return join(home, ".dsh-spaces-control", WORKBENCH_UPGRADE_RECEIPTS_DIR, `${planId.toLowerCase()}.json`);
}

function readInstalled(home: string, packageName: string, rel: string): string {
  return readFileSync(join(home, "profiles", MANAGER, "node_modules", ...packageName.split("/"), rel), "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function tarExecutable(): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-spaces-wb-pkg-"));
  temps.push(dir);
  return dir;
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
