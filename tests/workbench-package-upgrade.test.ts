import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { ProcessTerminationError } from "../src/adapters/node/terminate-process.ts";
import { archiveAbsPath, pluginLibraryPath, readPluginLibrary } from "../src/adapters/node/plugin-library.ts";
import type { CoordinatedUpgrade } from "../src/adapters/node/coordinated-upgrade.ts";
import type { SnapshotMeta, SnapshotRuntime } from "../src/shared/snapshots.ts";
import { WorkbenchJobStore, type WorkbenchJobContext } from "../src/adapters/node/workbench-jobs.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  SPACES_PLUGIN_PACKAGE,
  VIEW_BRIDGE_PACKAGE,
  WORKBENCH_PACKAGE_CATALOG_ID,
  WORKBENCH_UPGRADE_MARKER_FILE,
  WORKBENCH_UPGRADE_RECEIPTS_DIR,
  WORKBENCH_UPGRADE_SNAPSHOT_REASON,
  WorkbenchPackageUpgrade,
  WorkbenchPackageUpgradeError,
  type WorkbenchPackageHandoffInput,
} from "../src/adapters/node/workbench-package-upgrade.ts";
import { writeComponentPayloadManifest, validateComponentPayload } from "../src/adapters/node/component-payload.ts";
import type { PluginFetcher } from "../src/adapters/node/plugin-ops.ts";
import type { PackOneRequest } from "../packages/plugin/src/host/supervisor-pack.ts";

const temps: string[] = [];
const PLUGIN = SPACES_PLUGIN_PACKAGE;
const BRIDGE = VIEW_BRIDGE_PACKAGE;
const VERSION = "0.2.0";
const NEXT_VERSION = "0.3.0";
const MANAGER = "spaces-hub";
const RUNTIME: SnapshotRuntime = { version: "0.1.5-rc.1", root: "/runtime", binRelative: "bin.js" };

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
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
  assert.deepEqual(
    events.filter((row) => row !== "handoff" && !row.startsWith("digest:")),
    ["stopAll", "create", "pluginAdd", "pluginAdd"],
  );
  assert.equal(events.includes("handoff"), true);
  assert.equal(events.includes("reinitialize"), false);
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

  const installedLib = join(home, "profiles", MANAGER, "node_modules", ...PLUGIN.split("/"), "lib");
  const installed = validateComponentPayload(installedLib);
  const handed = events.filter((row) => row.startsWith("digest:"));
  assert.equal(handed[0], `digest:${installed.digest}`);
  const after = await upgrade.describe();
  assert.ok(after);
  assert.equal(after.updateAvailable, false);
  assert.equal(after.digest, preview.digest);
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
  const receipt = readJson(receiptPath(home, planId));
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.rolledBack, false);
  assert.equal(receipt.snapshotId, result.snapshotId);
});

test("execute without a handoff port or toolsRoot is unavailable before stop", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const events: string[] = [];
  const upgrade = createUpgrade(home, { ...pair, events, omitHandoff: true });
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
  assert.equal(events.includes("stopAll"), false);
  assert.equal(events.includes("create"), false);
  assert.equal(events.includes("handoff"), false);
  assert.equal(existsSync(markerPath(home)), false);
});

test("mismatched manifest component version is rejected before stop and leaves the archive", async () => {
  const home = tempHome();
  seedManager(home);
  const events: string[] = [];
  const pair = packPair(tempHome(), { mismatchManifestVersion: true });
  const original = readFileSync(pair.plugin);
  const upgrade = createUpgrade(home, { ...pair, events });
  assert.equal(await upgrade.describe(), undefined);
  await assert.rejects(
    () => upgrade.execute({
      planId: randomUUID(),
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: VERSION,
      expectedDigest: "a".repeat(64),
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(events.includes("stopAll"), false);
  assert.equal(events.includes("handoff"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.deepEqual(readFileSync(pair.plugin), original);
});

test("unknown manifest field is rejected before stop and leaves the archive", async () => {
  const home = tempHome();
  seedManager(home);
  const events: string[] = [];
  const pair = packPair(tempHome(), { extraManifestField: true });
  const original = readFileSync(pair.plugin);
  const upgrade = createUpgrade(home, { ...pair, events });
  assert.equal(await upgrade.describe(), undefined);
  await assert.rejects(
    () => upgrade.execute({
      planId: randomUUID(),
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: VERSION,
      expectedDigest: "a".repeat(64),
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(events.includes("stopAll"), false);
  assert.equal(events.includes("handoff"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.deepEqual(readFileSync(pair.plugin), original);
});

test("missing llm-bridge or tampered worker in the candidate is rejected before stop", async () => {
  const home = tempHome();
  seedManager(home);
  const events: string[] = [];
  for (const pair of [packPair(tempHome(), { omitLlm: true }), packPair(tempHome(), { tamperWorker: true })]) {
    events.length = 0;
    const upgrade = createUpgrade(home, { ...pair, events });
    assert.equal(await upgrade.describe(), undefined);
    await assert.rejects(
      () => upgrade.execute({
        planId: randomUUID(),
        catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
        version: VERSION,
        expectedDigest: "a".repeat(64),
      }, jobCtx()),
      matchCode("invalid-input"),
    );
    assert.equal(events.includes("stopAll"), false);
    assert.equal(events.includes("handoff"), false);
    assert.equal(existsSync(markerPath(home)), false);
  }
});

test("known install failure after snapshot reports the original error and does not restore", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
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
    /plugin add failed/,
  );
  assert.equal(events.includes("restore"), false);
  assert.equal(events.includes("upgradeRecover"), false);
  assert.equal(events.includes("handoff"), false);
  assert.equal(upgrade.hasEvidence(), false);
  const receipt = readJson(receiptPath(home, planId));
  assert.equal(receipt.outcome, "abandoned");
  assert.equal(receipt.rolledBack, false);
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
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
  assert.equal(events.includes("handoff"), false);
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
  const receipt = readJson(receiptPath(home, planId));
  assert.equal(receipt.outcome, "abandoned");
  assert.notEqual(receipt.outcome, "succeeded");
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

test("a leftover crash marker is not restored and recover is unsupported", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const snapshotId = randomUUID();
  const planId = randomUUID();
  const marker = crashMarker(home, planId, snapshotId);
  writeJson(markerPath(home), marker);

  const events: string[] = [];
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    restore: async () => {
      events.push("restore");
      return dummyRestore(snapshotId);
    },
  });
  const before = readFileSync(markerPath(home));
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.deepEqual(readFileSync(markerPath(home)), before);
  assert.equal(events.includes("restore"), false);
  assert.equal(events.includes("upgradeRecover"), false);
  assert.equal(upgrade.hasEvidence(), true);
});

test("install failure after snapshot does not start a restore journal", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome());
  const events: string[] = [];
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    snapshotId: randomUUID(),
    pluginAdd: async () => {
      events.push("pluginAdd");
      throw new Error("plugin add failed");
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
    /plugin add failed/,
  );
  assert.equal(events.includes("restore"), false);
  await assert.rejects(() => upgrade.recover(jobCtx(), planId), matchCode("unavailable"));
});

test("recover without a snapshot id is unsupported and leaves the marker", async () => {
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
  const before = readFileSync(markerPath(home));
  await assert.rejects(() => upgrade.recover(jobCtx()), matchCode("unavailable"));
  assert.deepEqual(readFileSync(markerPath(home)), before);
  assert.equal(events.includes("restore"), false);
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
  await assert.rejects(() => upgrade.recover(jobCtx(), secondPlan), matchCode("unavailable"));
  assert.equal(existsSync(markerPath(home)), true);

  gate.release();
  const result = await first;
  assert.ok(result.snapshotId);
  assert.equal(upgrade.hasEvidence(), false);
  await assert.rejects(() => upgrade.recover(jobCtx(), firstPlan), matchCode("unavailable"));
  const receipt = readJson(receiptPath(home, firstPlan));
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.snapshotId, result.snapshotId);
  await assert.rejects(() => upgrade.recover(jobCtx(), secondPlan), matchCode("unavailable"));
});

test("prepare downloads a changed version and reuses the library cache", async () => {
  const home = tempHome();
  seedManager(home);
  const first = packPair(tempHome(), { pluginBody: "plugin-a", payloadBody: "payload-a" });
  const second = packPair(tempHome(), { version: NEXT_VERSION, pluginBody: "plugin-b", payloadBody: "payload-b" });
  const fetches: string[] = [];
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const upgrade = createUpgrade(home, {
    pluginArtifact: first.plugin,
    viewBridgeArtifact: first.bridge,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({
      [VERSION]: first.plugin,
      [NEXT_VERSION]: second.plugin,
    }, VERSION, fetches),
  });

  const latest = await upgrade.prepare({ version: "latest" }, jobCtx());
  assert.equal(latest.id, WORKBENCH_PACKAGE_CATALOG_ID);
  assert.equal(latest.version, VERSION);
  const tarballGets = fetches.filter((url) => url.includes(".tgz"));
  assert.equal(tarballGets.length, 1);
  assert.equal(tarballGets.some((url) => url.includes(NEXT_VERSION)), false);

  fetches.length = 0;
  const cached = await upgrade.prepare({ version: VERSION }, jobCtx());
  assert.equal(cached.version, VERSION);
  assert.equal(fetches.filter((url) => url.includes(".tgz")).length, 0);

  const library = readPluginLibrary(home);
  const entry = library.find((row) => row.packageName === PLUGIN && row.spec === `${PLUGIN}@${VERSION}`);
  assert.ok(entry);
  const fromLibrary = await upgrade.prepare({ libraryId: entry.id }, jobCtx());
  assert.equal(fromLibrary.version, VERSION);
  assert.equal(fetches.filter((url) => url.includes(".tgz")).length, 0);

  const next = await upgrade.prepare({ version: NEXT_VERSION }, jobCtx());
  assert.equal(next.version, NEXT_VERSION);
  assert.notEqual(next.digest, latest.digest);
  assert.equal(fetches.filter((url) => url.includes(".tgz")).length, 1);
  assert.equal(fetches.some((url) => url.includes(NEXT_VERSION)), true);

  const described = await upgrade.describe();
  assert.ok(described);
  assert.equal(described.version, NEXT_VERSION);
  assert.equal(described.digest, next.digest);
  assert.equal(events.includes("stopAll"), false);
  assert.equal(events.includes("pluginAdd"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
});

test("prepare rejects same-version bridge bytes from outside the selected group", async () => {
  for (const packageName of [BRIDGE, "@dsh-spaces/llm-bridge"]) {
    const home = tempHome();
    seedManager(home);
    const source = packPair(tempHome());
    const events: string[] = [];
    const upgrade = createUpgrade(home, {
      toolsRoot: tempHome(), events,
      fetchImpl: pluginFetch({ [VERSION]: source.plugin }, VERSION),
      pack: async (request) => {
        const pkg = JSON.parse(readFileSync(join(request.packageRoot, "package.json"), "utf8"));
        if (pkg.name !== packageName) return tarPack(request);
        const substitute = join(tempHome(), "substitute");
        cpSync(request.packageRoot, substitute, { recursive: true });
        writeFileSync(join(substitute, "lib", "index.js"), "different implementation, same package version");
        return tarPack({ ...request, packageRoot: substitute });
      },
    });
    await assert.rejects(() => upgrade.prepare({ version: VERSION }, jobCtx()), /bytes do not match/);
    assert.equal(events.includes("stopAll"), false);
    assert.equal(events.includes("pluginAdd"), false);
    assert.equal(existsSync(markerPath(home)), false);
    assert.equal(await upgrade.describe(), undefined);
  }
});

test("prepare cancel aborts a stalled download body and unblocks the job tail", async () => {
  const home = tempHome();
  seedManager(home);
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const events: string[] = [];
  let tarSignal: AbortSignal | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyStarted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes(".tgz")) {
      tarSignal = init?.signal;
      bodyStarted = true;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new Uint8Array([1]));
        },
      }));
    }
    return new Response(JSON.stringify({
      name: PLUGIN,
      "dist-tags": { latest: VERSION },
      versions: {
        [VERSION]: { dist: { tarball: `https://registry.npmjs.org/${PLUGIN}/-/${PLUGIN}-${VERSION}.tgz` } },
      },
    }));
  }) as typeof fetch;
  const jobs = new WorkbenchJobStore({ home });
  const upgrade = createUpgrade(home, {
    events,
    toolsRoot,
    pack: tarPack,
    downloadTimeoutMs: 5_000,
    stopAll: async () => {
      events.push("stopAll");
      throw new Error("must not stop");
    },
  });
  try {
    await jobs.submit(
      { kind: "workbench.prepare", version: VERSION },
      "stalled-prepare",
      async (ctx) => ({ product: { kind: "workbench.prepare", candidate: await upgrade.prepare({ version: VERSION }, ctx) } }),
    );
    for (let i = 0; i < 200 && !bodyStarted; i++) await delay(10);
    assert.equal(bodyStarted, true);
    const accepted = await jobs.cancel("stalled-prepare");
    assert.equal(accepted.canCancel, false);
    let nextRan = false;
    const next = jobs.runExclusive(async () => {
      nextRan = true;
    });
    await jobs.whenIdle();
    assert.equal(tarSignal?.aborted, true);
    assert.equal(jobs.job("stalled-prepare").status, "cancelled");
    await next;
    assert.equal(nextRan, true);
    assert.equal(events.includes("stopAll"), false);
    assert.equal(existsSync(markerPath(home)), false);
    assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
    assert.equal(await upgrade.describe(), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    try {
      streamController?.close();
    } catch {
      // Abort already closed the stalled body.
    }
    await jobs.whenIdle();
  }
});

test("prepare download timeout on a stalled tarball body preserves the previous candidate", async () => {
  const home = tempHome();
  seedManager(home);
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const good = packPair(tempHome(), { pluginBody: "kept-candidate" });
  const events: string[] = [];
  let stallNext = false;
  let tarStarted = false;
  const catalog = pluginFetch({ [VERSION]: good.plugin, [NEXT_VERSION]: good.plugin }, VERSION);
  const fetchImpl: PluginFetcher = async (url, init) => {
    if (stallNext && String(url).includes(".tgz")) {
      tarStarted = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: () => new Promise<ArrayBuffer>((_, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (init?.signal?.aborted) {
            fail();
            return;
          }
          init?.signal?.addEventListener("abort", fail, { once: true });
        }),
      };
    }
    return catalog(url, init);
  };
  const upgrade = createUpgrade(home, {
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl,
    downloadTimeoutMs: 80,
  });
  const prepared = await upgrade.prepare({ version: VERSION }, jobCtx());
  stallNext = true;
  await assert.rejects(
    () => upgrade.prepare({ version: NEXT_VERSION }, jobCtx()),
    /timed out|failed/i,
  );
  assert.equal(tarStarted, true);
  const described = await upgrade.describe();
  assert.ok(described);
  assert.equal(described.digest, prepared.digest);
  assert.equal(events.includes("stopAll"), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
});

test("prepare rejects exclusive version plus libraryId without downloading", async () => {
  const home = tempHome();
  const fetches: string[] = [];
  const events: string[] = [];
  const upgrade = createUpgrade(home, {
    events,
    pack: tarPack,
    fetchImpl: pluginFetch({ [VERSION]: packPair(tempHome()).plugin }, VERSION, fetches),
  });
  await assert.rejects(
    () => upgrade.prepare({ version: VERSION, libraryId: `${PLUGIN}@${VERSION}` }, jobCtx()),
    matchCode("invalid-input"),
  );
  await assert.rejects(
    () => upgrade.prepare({ version: "latest", libraryId: `${PLUGIN}@${VERSION}` }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(fetches.length, 0);
  assert.equal(events.includes("stopAll"), false);
});

test("failed prepare does not stop, install, or change the selected pointer", async () => {
  const home = tempHome();
  seedManager(home);
  const good = packPair(tempHome(), { pluginBody: "good-plugin" });
  const bad = packPair(tempHome(), { version: NEXT_VERSION, omitLlm: true });
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const added: string[] = [];
  const upgrade = createUpgrade(home, {
    ...good,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({
      [VERSION]: good.plugin,
      [NEXT_VERSION]: bad.plugin,
    }, VERSION),
    pluginAdd: async (dshHome, profile, spec) => {
      added.push(spec);
      mockPluginAdd(dshHome, profile, spec);
    },
  });

  const prepared = await upgrade.prepare({ version: VERSION }, jobCtx());
  await assert.rejects(
    () => upgrade.prepare({ version: NEXT_VERSION }, jobCtx()),
    matchCode("invalid-input"),
  );
  const described = await upgrade.describe();
  assert.ok(described);
  assert.equal(described.digest, prepared.digest);
  assert.equal(described.version, VERSION);
  assert.equal(events.includes("stopAll"), false);
  assert.equal(events.includes("create"), false);
  assert.equal(events.includes("handoff"), false);
  assert.equal(added.length, 0);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
});

test("tamper or delete after prepare is rejected before stop and leaves the pointer", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome(), { pluginBody: "live-plugin" });
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({ [VERSION]: pair.plugin }, VERSION),
  });
  const prepared = await upgrade.prepare({ version: VERSION }, jobCtx());
  const pluginTgz = walkFiles(toolsRoot).find((path) => path.replaceAll("\\", "/").endsWith(`dsh-spaces-plugin-${VERSION}.tgz`));
  assert.ok(pluginTgz);
  writeFileSync(pluginTgz, Buffer.concat([readFileSync(pluginTgz), Buffer.from("x")]));
  await assert.rejects(
    () => upgrade.execute({
      planId: randomUUID(),
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: prepared.version,
      expectedDigest: prepared.digest,
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(events.includes("stopAll"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);

  const toolsRoot2 = tempHome();
  const pointer2 = plantPointer(toolsRoot2);
  const again = createUpgrade(home, {
    ...pair,
    events,
    toolsRoot: toolsRoot2,
    pack: tarPack,
    fetchImpl: pluginFetch({ [VERSION]: pair.plugin }, VERSION),
  });
  const prepared2 = await again.prepare({ version: VERSION }, jobCtx());
  const packed = walkFiles(toolsRoot2).filter((path) => path.endsWith(".tgz"));
  assert.ok(packed.length > 0);
  for (const file of packed) unlinkSync(file);
  events.length = 0;
  await assert.rejects(
    () => again.execute({
      planId: randomUUID(),
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: prepared2.version,
      expectedDigest: prepared2.digest,
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(events.includes("stopAll"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer2.path, "utf8"), pointer2.bytes);
});

test("replacing the prepared candidate refuses an old preview digest", async () => {
  const home = tempHome();
  seedManager(home);
  const first = packPair(tempHome(), { pluginBody: "first" });
  const second = packPair(tempHome(), { version: NEXT_VERSION, pluginBody: "second" });
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const upgrade = createUpgrade(home, {
    pluginArtifact: first.plugin,
    viewBridgeArtifact: first.bridge,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({
      [VERSION]: first.plugin,
      [NEXT_VERSION]: second.plugin,
    }, VERSION),
  });
  const preview = await upgrade.prepare({ version: VERSION }, jobCtx());
  const next = await upgrade.prepare({ version: NEXT_VERSION }, jobCtx());
  assert.notEqual(next.digest, preview.digest);
  await assert.rejects(
    () => upgrade.execute({
      planId: randomUUID(),
      catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
      version: preview.version,
      expectedDigest: preview.digest,
    }, jobCtx()),
    matchCode("invalid-input"),
  );
  assert.equal(events.includes("stopAll"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
  const current = await upgrade.describe();
  assert.ok(current);
  assert.equal(current.digest, next.digest);
});

test("execute after prepare installs the packed group and hands off the pre-staged payload", async () => {
  const home = tempHome();
  seedManager(home);
  const previous = packPair(tempHome(), { pluginBody: "old-bytes", payloadBody: "old-payload" });
  const next = packPair(tempHome(), { pluginBody: "prepared-bytes", payloadBody: "prepared-payload" });
  installPacked(home, MANAGER, previous.plugin);
  installPacked(home, MANAGER, previous.bridge);
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const upgrade = createUpgrade(home, {
    pluginArtifact: previous.plugin,
    viewBridgeArtifact: previous.bridge,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({ [VERSION]: next.plugin }, VERSION),
    pluginAdd: async (dshHome, profile, spec) => {
      events.push("pluginAdd");
      mockPluginAdd(dshHome, profile, spec);
    },
  });
  const prepared = await upgrade.prepare({ version: VERSION }, jobCtx());
  assert.equal(prepared.updateAvailable, true);
  const result = await upgrade.execute({
    planId: randomUUID(),
    catalogId: WORKBENCH_PACKAGE_CATALOG_ID,
    version: prepared.version,
    expectedDigest: prepared.digest,
  }, jobCtx());
  assert.match(result.snapshotId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(
    events.filter((row) => row !== "handoff" && !row.startsWith("digest:")),
    ["stopAll", "create", "pluginAdd", "pluginAdd"],
  );
  assert.equal(readInstalled(home, PLUGIN, "lib/index.js"), "prepared-bytes");
  assert.equal(readInstalled(home, PLUGIN, "lib/supervisor/index.js"), "prepared-payload");
  const installedLib = join(home, "profiles", MANAGER, "node_modules", ...PLUGIN.split("/"), "lib");
  const installed = validateComponentPayload(installedLib);
  const handed = events.filter((row) => row.startsWith("digest:"));
  assert.equal(handed[0], `digest:${installed.digest}`);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
});

test("corrupt or future plugin library is left unchanged and is not downloaded over", async () => {
  const home = tempHome();
  seedManager(home);
  mkdirSync(join(home, "hub"), { recursive: true });
  const libraryPath = pluginLibraryPath(home);
  const original = JSON.stringify({ schemaVersion: 999, plugins: [{ broken: true }] });
  writeFileSync(libraryPath, original);
  const fetches: string[] = [];
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const pair = packPair(tempHome());
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({ [VERSION]: pair.plugin }, VERSION, fetches),
  });
  await assert.rejects(() => upgrade.prepare({ version: VERSION }, jobCtx()), matchCode("unavailable"));
  assert.equal(readFileSync(libraryPath, "utf8"), original);
  assert.equal(fetches.length, 0);
  assert.equal(events.includes("stopAll"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);

  writeFileSync(libraryPath, "{not-json");
  await assert.rejects(() => upgrade.prepare({ version: "latest" }, jobCtx()), matchCode("unavailable"));
  assert.equal(readFileSync(libraryPath, "utf8"), "{not-json");
  assert.equal(fetches.length, 0);
});

test("prepare does not create Home entries through a workbench-prepare or digest junction", async () => {
  const home = tempHome();
  seedManager(home);
  const pair = packPair(tempHome(), { pluginBody: "junction-plugin" });
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const sneak = join(home, "sneak");
  mkdirSync(sneak, { recursive: true });
  const linked = tryJunction(sneak, join(toolsRoot, "workbench-prepare"));
  if (!linked) return;
  const before = walkFiles(home);
  const upgrade = createUpgrade(home, {
    ...pair,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({ [VERSION]: pair.plugin }, VERSION),
  });
  await assert.rejects(() => upgrade.prepare({ version: VERSION }, jobCtx()), matchCode("unavailable"));
  assert.deepEqual(walkFiles(home), before);
  assert.equal(events.includes("stopAll"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);

  const toolsRoot2 = tempHome();
  const pointer2 = plantPointer(toolsRoot2);
  const events2: string[] = [];
  const second = createUpgrade(home, {
    ...pair,
    events: events2,
    toolsRoot: toolsRoot2,
    pack: tarPack,
    fetchImpl: pluginFetch({ [VERSION]: pair.plugin }, VERSION),
  });
  const prepared = await second.prepare({ version: VERSION }, jobCtx());
  const staged = readdirSync(join(toolsRoot2, "components")).filter((name) => name !== "." && name !== "..");
  assert.equal(staged.length, 1);
  const digestDir = join(toolsRoot2, "workbench-prepare", staged[0]);
  assert.equal(existsSync(digestDir), true);
  rmSync(digestDir, { recursive: true, force: true });
  const sneak2 = join(home, "sneak-digest");
  mkdirSync(sneak2, { recursive: true });
  const sneakBefore = walkFiles(sneak2);
  if (!tryJunction(sneak2, digestDir)) return;
  await assert.rejects(
    () => second.prepare({ version: VERSION }, jobCtx()),
    matchCode("unavailable"),
  );
  assert.deepEqual(walkFiles(sneak2), sneakBefore);
  assert.equal(events2.includes("stopAll"), false);
  assert.equal(readFileSync(pointer2.path, "utf8"), pointer2.bytes);
  assert.equal(prepared.version, VERSION);
});

test("prepare rejects an archive whose plugin version is not the pinned version", async () => {
  const home = tempHome();
  seedManager(home);
  const other = packPair(tempHome(), { version: NEXT_VERSION, pluginBody: "other-version" });
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const upgrade = createUpgrade(home, {
    pluginArtifact: other.plugin,
    viewBridgeArtifact: other.bridge,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({
      [VERSION]: other.plugin,
      [NEXT_VERSION]: other.plugin,
    }, NEXT_VERSION),
  });
  const prepared = await upgrade.prepare({ version: NEXT_VERSION }, jobCtx());
  await assert.rejects(
    () => upgrade.prepare({ version: VERSION }, jobCtx()),
    matchCode("invalid-input"),
  );
  const described = await upgrade.describe();
  assert.ok(described);
  assert.equal(described.digest, prepared.digest);
  assert.equal(described.version, NEXT_VERSION);
  assert.equal(events.includes("stopAll"), false);
  assert.equal(existsSync(markerPath(home)), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
});

test("prepare accepts mixed component versions when the plugin matches the pin", async () => {
  const home = tempHome();
  seedManager(home);
  const mixed = packPair(tempHome(), {
    version: NEXT_VERSION,
    supervisorVersion: VERSION,
    viewVersion: "0.1.5",
    llmVersion: "0.4.0",
    pluginBody: "mixed-plugin",
  });
  const events: string[] = [];
  const toolsRoot = tempHome();
  const pointer = plantPointer(toolsRoot);
  const upgrade = createUpgrade(home, {
    ...mixed,
    events,
    toolsRoot,
    pack: tarPack,
    fetchImpl: pluginFetch({ [NEXT_VERSION]: mixed.plugin }, NEXT_VERSION),
  });
  const prepared = await upgrade.prepare({ version: NEXT_VERSION }, jobCtx());
  assert.equal(prepared.version, NEXT_VERSION);
  assert.equal(events.includes("stopAll"), false);
  assert.equal(readFileSync(pointer.path, "utf8"), pointer.bytes);
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
    omitHandoff?: boolean;
    handoff?: (input: WorkbenchPackageHandoffInput) => Promise<void>;
    toolsRoot?: string;
    fetchImpl?: PluginFetcher;
    pack?: (request: PackOneRequest) => Promise<string>;
    downloadTimeoutMs?: number;
  },
): WorkbenchPackageUpgrade {
  const events = opts.events ?? [];
  const snapshotId = opts.snapshotId ?? randomUUID();
  const toolsRoot = opts.toolsRoot ?? tempHome();
  return new WorkbenchPackageUpgrade({
    home,
    managerId: () => MANAGER,
    pluginArtifact: opts.pluginArtifact,
    viewBridgeArtifact: opts.viewBridgeArtifact,
    toolsRoot: opts.omitHandoff ? undefined : toolsRoot,
    handoff: opts.omitHandoff
      ? undefined
      : opts.handoff ?? (async (input) => {
        events.push("handoff");
        events.push(`digest:${input.payload.digest}`);
      }),
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
    fetchImpl: opts.fetchImpl,
    pack: opts.pack,
    downloadTimeoutMs: opts.downloadTimeoutMs,
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
    supervisorVersion?: string;
    viewVersion?: string;
    llmVersion?: string;
    omitLlm?: boolean;
    tamperWorker?: boolean;
    mismatchManifestVersion?: boolean;
    extraManifestField?: boolean;
  } = {},
): { pluginArtifact: string; viewBridgeArtifact: string; plugin: string; bridge: string } {
  const version = opts.version ?? VERSION;
  const supervisorVersion = opts.supervisorVersion ?? version;
  const viewVersion = opts.viewVersion ?? version;
  const llmVersion = opts.llmVersion ?? version;
  const pluginDir = join(stagingRoot, "plugin-src");
  const bridgeDir = join(stagingRoot, "bridge-src");
  const pluginName = opts.pluginName ?? PLUGIN;
  const files: Record<string, string> = {
    "cordis.patch.yml": "plugin: dummy\n",
    "lib/index.js": opts.pluginBody ?? "plugin-index",
    "lib/client.js": "plugin-client",
    "lib/typert.host.js": "typert-host",
    "lib/typert.remote-client.js": "typert-remote",
    "lib/supervisor/package.json": JSON.stringify({ name: "@dsh-spaces/supervisor", version: supervisorVersion }),
    "lib/supervisor/index.js": opts.payloadBody ?? "supervisor-entry",
    "lib/supervisor/launcher.mjs": "launcher",
    "lib/supervisor/snapshot-worker.mjs": "snapshot-worker",
    "lib/view-bridge/package.json": JSON.stringify({ name: BRIDGE, version: viewVersion }),
    "lib/view-bridge/cordis.patch.yml": "view: dummy\n",
    "lib/view-bridge/lib/index.js": opts.bridgeBody ?? "bridge-index",
    "lib/view-bridge/lib/client.js": "bridge-client",
    "lib/view-bridge/lib/settings.js": "bridge-settings",
    "lib/llm-bridge/package.json": JSON.stringify({ name: "@dsh-spaces/llm-bridge", version: llmVersion }),
    "lib/llm-bridge/cordis.patch.yml": "llm: dummy\n",
    "lib/llm-bridge/lib/index.js": "llm-index",
  };
  if (opts.omitLlm) {
    delete files["lib/llm-bridge/package.json"];
    delete files["lib/llm-bridge/cordis.patch.yml"];
    delete files["lib/llm-bridge/lib/index.js"];
  }
  writeOfficialPackage(pluginDir, pluginName, version, files);
  const packageRoot = join(pluginDir, "package");
  if (pluginName === PLUGIN && !opts.omitLlm) {
    writeComponentPayloadManifest(join(packageRoot, "lib"));
  } else {
    writeFileSync(
      join(packageRoot, "lib", "supervisor", "manifest.json"),
      JSON.stringify({ version, entry: "index.js" }),
    );
  }
  if (opts.tamperWorker) {
    writeFileSync(join(packageRoot, "lib", "supervisor", "snapshot-worker.mjs"), "tampered-worker");
  }
  if (opts.mismatchManifestVersion || opts.extraManifestField) {
    const manifestPath = join(packageRoot, "lib", "supervisor", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> & {
      components: Record<string, { version?: string }>;
    };
    if (opts.mismatchManifestVersion) {
      manifest.components["manager-plugin"].version = "9.9.9";
    }
    if (opts.extraManifestField) {
      manifest.extra = true;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeOfficialPackage(bridgeDir, BRIDGE, viewVersion, {
    "cordis.patch.yml": "view: dummy\n",
    "lib/index.js": opts.bridgeBody ?? "bridge-index",
    "lib/client.js": "bridge-client",
    "lib/settings.js": "bridge-settings",
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

async function tarPack(request: PackOneRequest): Promise<string> {
  mkdirSync(request.destination, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(request.packageRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const safe = pkg.name.replace(/^@/, "").replaceAll("/", "-");
  const dest = join(request.destination, `${safe}-${pkg.version}.tgz`);
  const staging = tempHome();
  cpSync(request.packageRoot, join(staging, "package"), { recursive: true });
  packTgz(staging, dest);
  return dest;
}

function pluginFetch(
  tarballs: Record<string, string>,
  latest: string,
  urls?: string[],
): PluginFetcher {
  const bytes = new Map(Object.entries(tarballs).map(([version, path]) => [version, readFileSync(path)]));
  return async (url) => {
    urls?.push(url);
    if (!url.includes(".tgz")) {
      const versions: Record<string, { dist: { tarball: string } }> = {};
      for (const version of Object.keys(tarballs)) {
        versions[version] = {
          dist: { tarball: `https://registry.npmjs.org/${PLUGIN}/-/${PLUGIN}-${version}.tgz` },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: PLUGIN,
          "dist-tags": { latest },
          versions,
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const version = Object.keys(tarballs).find((row) => url.includes(`plugin-${row}.tgz`));
    const body = version ? bytes.get(version) : undefined;
    if (!body) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

function tryJunction(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function plantPointer(toolsRoot: string): { path: string; bytes: string } {
  const path = join(toolsRoot, `selected-${"a".repeat(64)}.json`);
  const bytes = `${JSON.stringify({
    schemaVersion: 2,
    homeDigest: "a".repeat(64),
    artifactDigest: "b".repeat(64),
  }, null, 2)}\n`;
  writeFileSync(path, bytes);
  return { path, bytes };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
