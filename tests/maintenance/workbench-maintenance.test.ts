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
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import {
  FULL_SPACES_PACKAGE,
  WORKBENCH_MAINTENANCE_ERROR,
  WORKBENCH_PLAN_TTL_MS,
  WORKBENCH_PLUGIN_MUTATION_FILE,
  WORKBENCH_PLUGIN_REGISTRY_FILE,
  WorkbenchMaintenance,
  WorkbenchMaintenanceError,
  type MaintenanceFetcher,
} from "../../src/adapters/node/maintenance/workbench-maintenance.ts";
import type { WorkbenchMaintenancePorts } from "../../src/adapters/node/maintenance/workbench-maintenance-ports.ts";
import {
  WORKBENCH_CONTROL_DIR_NAME,
  WorkbenchJobAbortError,
  WorkbenchJobError,
  type WorkbenchJobContext,
} from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import { ProcessTerminationError } from "../../src/adapters/node/runtime/terminate-process.ts";
import { DiagnosticsService } from "../../src/adapters/node/diagnostics/diagnostics.ts";
import { CATALOG_CACHE_FILE } from "../../src/adapters/node/products/plugin-catalog.ts";
import { isHubPluginArchive, PLUGIN_LIBRARY_FILE, readPluginLibrary } from "../../src/adapters/node/products/plugin-library.ts";
import { listProfilePlugins } from "../../src/adapters/node/products/plugin-ops.ts";
import { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import { SnapshotStore } from "../../src/adapters/node/snapshots/snapshot-store.ts";
import type { SnapshotExecutor } from "../../src/adapters/node/snapshots/snapshot-executor.ts";
import type { SnapshotRuntime } from "../../src/shared/snapshots.ts";
import type { WorkbenchPlanRequest } from "../../src/shared/workbench.ts";
import type { ProfileStatus } from "../../src/shared/types.ts";

const BASE = "@deepseek-ai/dsh-base";
const WEB = "@deepseek-ai/dsh-web-app";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("preview hands space and controller actions to supervisor runtime", async () => {
  const { maintenance } = harness();
  await assert.rejects(() => maintenance.preview({ kind: "space.stop", spaceId: "space-coding" }), matchCode("workbench/runtime-handoff"));
  await assert.rejects(() => maintenance.preview({ kind: "service.shutdown" }), matchCode("workbench/runtime-handoff"));
  await assert.rejects(() => maintenance.preview({ kind: "controller.release" } as never), matchCode("workbench/unsupported"));
  await assert.rejects(() => maintenance.preview({ kind: "controller.shutdown" } as never), matchCode("workbench/unsupported"));
});

test("preview rejects raw spec, filepath, git url, and extra command fields", async () => {
  const { maintenance } = harness();
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["space-coding"],
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
        spaceIds: ["space-coding"],
        catalogId: "file:C:/tmp/plugin.tgz",
        version: "1.2.3",
      }),
    matchCode("workbench/invalid-input"),
  );
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["space-coding"],
        catalogId: "github:example/git-bundle",
        version: "1.2.3",
      }),
    matchCode("workbench/invalid-input"),
  );
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "plugin.install",
        spaceIds: ["space-coding"],
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
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  clock.now += WORKBENCH_PLAN_TTL_MS + 1;
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/expired"));

  clock.now = Date.parse("2026-09-12T01:00:00.000Z");
  const fresh = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  state.status["space-coding"] = "stopped";
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
    () => maintenance.preview({ kind: "plugin.remove", spaceId: "space-coding", packageName: BASE }),
    matchCode("workbench/forbidden"),
  );
  await assert.rejects(
    () => maintenance.preview({ kind: "plugin.remove", spaceId: "space-coding", packageName: FULL_SPACES_PACKAGE }),
    matchCode("workbench/forbidden"),
  );
  await assert.rejects(
    () => maintenance.preview({ kind: "plugin.toggle", spaceId: "spaces-hub", pluginId: "dsh-outline", enabled: true }),
    matchCode("workbench/forbidden"),
  );
});

test("cleanup-manager only removes the management package from an ordinary profile and does not copy data", async () => {
  const { home, maintenance, state } = harness();
  writeManifest(home, "space-coding", {
    bundles: [BASE, WEB, FULL_SPACES_PACKAGE],
    dependencies: { [BASE]: "1", [WEB]: "1", [FULL_SPACES_PACKAGE]: "0.2.0" },
  });
  mkdirSync(join(home, "hub", "space-coding"), { recursive: true });
  writeFileSync(join(home, "hub", "space-coding", "notes.txt"), "keep-user-data\n");
  const plan = await maintenance.preview({ kind: "plugin.cleanup-manager", spaceId: "space-coding" });
  assert.equal(plan.destructive, true);
  assert.match(plan.changes.join("\n"), /not copied or migrated/i);
  await maintenance.execute(plan.id, jobCtx());
  const plugins = listProfilePlugins(home, "space-coding").map((item) => item.name);
  assert.equal(plugins.includes(FULL_SPACES_PACKAGE), false);
  assert.equal(readFileSync(join(home, "hub", "space-coding", "notes.txt"), "utf8"), "keep-user-data\n");
  assert.deepEqual(state.started, ["space-coding"]);
});

test("plugin install and remove write profile files that listProfilePlugins can read back", async () => {
  const { home, maintenance, state } = harness();
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  assert.equal(plan.scope, "space");
  assert.ok(plan.changes.some((line) => line.includes("dsh-outline@1.2.3")));
  assert.ok(plan.changes.some((line) => /restart/i.test(line)));
  assert.deepEqual(plan.runningSpaceIds, ["space-coding"]);
  const result = await maintenance.execute(plan.id, jobCtx());
  assert.equal(result, undefined);
  const installed = listProfilePlugins(home, "space-coding");
  assert.equal(installed.some((item) => item.name === "dsh-outline" && item.version === "1.2.3"), true);
  const library = readPluginLibrary(home);
  assert.equal(library.some((entry) => entry.packageName === "dsh-outline" && entry.spec === "dsh-outline@1.2.3"), true);
  assert.deepEqual(state.stopped, ["space-coding"]);
  assert.deepEqual(state.started, ["space-coding"]);

  const remove = await maintenance.preview({ kind: "plugin.remove", spaceId: "space-coding", packageName: "dsh-outline" });
  await maintenance.execute(remove.id, jobCtx());
  assert.equal(listProfilePlugins(home, "space-coding").some((item) => item.name === "dsh-outline"), false);
});

test("batch plugin install stops at the first failure and does not run later spaces", async () => {
  const { home, maintenance, state } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      if (profile === "space-notes") throw new Error("notes install failed");
      await addFromTarball(dshHome, profile, spec);
    },
  });
  writeManifest(home, "space-notes", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  writeManifest(home, "space-lab", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  state.status["space-notes"] = "stopped";
  state.status["space-lab"] = "stopped";
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["space-coding", "space-notes", "space-lab"],
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
      assert.equal(error.context?.spaceId, "space-notes");
      assert.equal(error.context?.packageName, "dsh-outline");
      assert.equal(error.context?.stage, "install");
      assert.equal(error.context?.pluginAttribution, "known");
      return matchCode("workbench/failed")(error);
    },
  );
  assert.equal(listProfilePlugins(home, "space-coding").some((item) => item.name === "dsh-outline"), true);
  assert.equal(listProfilePlugins(home, "space-notes").some((item) => item.name === "dsh-outline"), false);
  assert.equal(listProfilePlugins(home, "space-lab").some((item) => item.name === "dsh-outline"), false);
  const reported = messages.join("\n");
  assert.match(reported, /notes/);
  assert.match(reported, /dsh-outline/);
  assert.match(reported, /install/);
  assert.doesNotMatch(reported, /空间 space-coding/);
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
    spaceIds: ["space-coding"],
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
    spaceId: "space-coding",
    pluginId: "urzeye/dsh-outline",
    enabled: true,
  });
  assert.ok(plan.changes.some((line) => /install\/remove/i.test(line)));
  assert.ok(plan.changes.some((line) => /not a hot toggle/i.test(line)));
});

test("snapshot create failure does not reinitialize or restart the manager", async () => {
  const { maintenance, state } = harness({
    snapshotsCreate: async () => {
      throw new Error("snapshot create failed");
    },
  });
  const plan = await maintenance.preview({ kind: "snapshot.create" });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
  assert.equal(state.reinitialized, 0);
  assert.equal(state.started.length, 0);
  assert.equal(state.maintenance.at(-1), true);
});

test("snapshot create is whole-home, stops owned spaces, and public DTO strips home and bin", async () => {
  const { home, maintenance, state, snapRoot, runtime } = snapshotHarness();
  const plan = await maintenance.preview({ kind: "snapshot.create" });
  assert.equal(plan.scope, "home");
  assert.ok(plan.affectedSpaceIds.includes("spaces-hub"));
  assert.ok(plan.affectedSpaceIds.includes("space-coding"));
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
  assert.ok(existsSync(join(home, "profiles", "space-coding")));
});

test("space.runtime.set re-apply at the host version installs it into the store", async () => {
  const installs: string[] = [];
  const { maintenance, home, state } = harness({
    install: async (version) => { installs.push(version); return { bin: "bin.js", version, dir: home }; },
    installedBin: (version) => (installs.includes(version) ? "bin.js" : undefined),
    hostRuntime: () => ({ bin: "host-bin.js", version: "0.2.0-rc.3" }),
  });
  new ProfileRegistry(home).updateMeta("space-coding", { dshVersion: "0.2.0-rc.3" });
  state.status["space-coding"] = "stopped";
  const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version: "0.2.0-rc.3" });
  assert.equal(plan.title, "Re-apply DSH 0.2.0-rc.3 to space-coding");
  assert.ok(plan.changes.some((row) => row.includes("Download and install DSH 0.2.0-rc.3.")),
    `expected the download step in: ${JSON.stringify(plan.changes)}`);
  await maintenance.execute(plan.id, jobCtx());
  assert.deepEqual(installs, ["0.2.0-rc.3"], "the host version is installed into the Spaces runtime store");
});

test("global runtime install requests and saved legacy plans are unsupported without writes", async () => {
  let installs = 0;
  const { maintenance, home, state } = harness({ install: async () => { installs += 1; throw new Error("must not install"); } });
  const removed = { kind: "runtime.install", version: "0.2.0-rc.2" };
  await assert.rejects(() => maintenance.preview(removed as unknown as WorkbenchPlanRequest), matchCode("workbench/unsupported"));
  const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version: "0.2.0-rc.2" });
  const path = join(home, ".dsh-spaces-control", "plans", `${plan.id}.json`);
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  legacy.command = removed;
  legacy.public.kind = removed.kind;
  const bytes = JSON.stringify(legacy);
  writeFileSync(path, bytes);
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/unsupported"));
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.equal(installs, 0);
  assert.deepEqual(state.stopped, []);
});

test("saved deleted commands are unsupported at the plan boundary and their bytes stay", async () => {
  const { maintenance, home, state } = harness();
  const plan = await maintenance.preview({ kind: "snapshot.create" });
  const path = join(home, ".dsh-spaces-control", "plans", `${plan.id}.json`);
  const original = readFileSync(path);
  const deleted = [
    { kind: "snapshot.restore", snapshotId: "11111111-1111-1111-1111-111111111111" },
    { kind: "config.restore", spaceId: "space-coding", backupId: "cordis.patch.yml.bak-1" },
    { kind: "runtime.upgrade" },
    { kind: "workbench.upgrade" },
    { kind: "controller.release" },
    { kind: "controller.shutdown" },
  ];
  for (const command of deleted) {
    const saved = JSON.parse(original.toString("utf8")) as { command: unknown; public: { kind: string } };
    saved.command = command;
    saved.public.kind = command.kind;
    const bytes = JSON.stringify(saved);
    writeFileSync(path, bytes);
    await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/unsupported"));
    assert.equal(readFileSync(path, "utf8"), bytes);
  }
  writeFileSync(path, original);
  assert.equal(state.reinitialized, 0);
  assert.equal(state.stopAll, 0);
  assert.deepEqual(state.started, []);
});

function writeRuntimeTree(version: string): { bin: string; root: string } {
  const root = tempDir(`dsh-spaces-rt-${version.replace(/\W/g, "_")}-`);
  const dsh = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(dsh, "lib"), { recursive: true });
  const bin = join(dsh, "lib", "bin.js");
  writeFileSync(bin, "console.log('cli');\n");
  writeFileSync(join(dsh, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  return { bin, root };
}

test("space.runtime.set preview rejects invalid versions, protected targets, and unsupported plugins", async () => {
  const { maintenance, home } = harness();
  new ProfileRegistry(home).updateMeta("space-coding", { dshVersion: "0.9.9" });
  const reject = async (request: unknown, code: string, pattern?: RegExp) => {
    await assert.rejects(() => maintenance.preview(request as never), (error: unknown) => {
      assert.ok(error instanceof WorkbenchMaintenanceError);
      assert.equal(error.code, code);
      if (pattern) assert.match(error.message, pattern);
      return true;
    });
  };
  await reject({ kind: "space.runtime.set", spaceId: "spaces-hub", version: "0.2.0-rc.2" }, "workbench/forbidden");
  await reject({ kind: "space.runtime.set", spaceId: "missing", version: "0.2.0-rc.2" }, "workbench/not-found");
  await reject({ kind: "space.runtime.set", spaceId: "space-coding", version: "latest" }, "workbench/invalid-input");
  await reject(
    { kind: "space.runtime.set", spaceId: "space-coding", version: "0.0.1-rc.1" },
    "workbench/invalid-input",
    /below the minimum 0\.2\.0-rc\.2/,
  );
  await reject(
    { kind: "space.runtime.set", spaceId: "space-coding", version: "0.2.0-rc.2" },
    "workbench/invalid-input",
    /Downgrading a space's DSH version is not allowed\./,
  );
  const bridge = join(home, "profiles", "space-coding", "node_modules", "@dsh-spaces", "view-bridge");
  mkdirSync(bridge, { recursive: true });
  writeFileSync(
    join(bridge, "package.json"),
    `${JSON.stringify({
      name: "@dsh-spaces/view-bridge",
      version: "0.2.0",
      peerDependencies: { "@deepseek-ai/dsh": "^9.9.0" },
    })}\n`,
  );
  await reject(
    { kind: "space.runtime.set", spaceId: "space-coding", version: "0.9.9" },
    "workbench/invalid-input",
    /These plugins do not support DSH 0\.9\.9: @dsh-spaces\/view-bridge \(@deepseek-ai\/dsh@\^9\.9\.0\)\. Remove or upgrade them first\./,
  );
});

test("space.runtime.set rejects an installed third-party DSH peer before switch effects", async () => {
  let installs = 0;
  const { maintenance, home, state } = harness({
    install: async () => {
      installs += 1;
      throw new Error("must not install");
    },
  });
  const profile = join(home, "profiles", "space-coding");
  const manifestPath = join(profile, "package.json");
  const original = readFileSync(manifestPath, "utf8");
  const plans = join(home, ".dsh-spaces-control", "plans");
  const version = "0.2.1-alpha.2";
  const reset = () => {
    writeFileSync(manifestPath, original);
    rmSync(join(profile, "node_modules"), { recursive: true, force: true });
  };
  const place = (name: string, options: { enabled?: boolean; declared?: boolean; peers?: Record<string, unknown>; extra?: Record<string, unknown>; raw?: string; omitManifest?: boolean }) => {
    reset();
    const manifest = JSON.parse(original) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
    if (options.declared !== false) manifest.dependencies[name] = "1.0.0";
    const bundles = new Set(manifest.dsh.profile.bundles);
    if (options.enabled) bundles.add(name);
    manifest.dsh.profile.bundles = [...bundles];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (options.omitManifest) return;
    const dir = join(profile, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), "export default {};\n");
    writeFileSync(
      join(dir, "package.json"),
      options.raw ?? `${JSON.stringify({
        name,
        version: "1.0.0",
        type: "module",
        main: "index.js",
        peerDependencies: options.peers ?? {},
        ...options.extra,
      })}\n`,
    );
  };
  const rejectSwitch = async (pattern: RegExp) => {
    await assert.rejects(() => maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version }), (error: unknown) => {
      assert.ok(error instanceof WorkbenchMaintenanceError);
      assert.equal(error.code, "workbench/invalid-input");
      assert.match(error.message, pattern);
      return true;
    });
    assert.equal(existsSync(plans), false);
    assert.equal(installs, 0);
    assert.deepEqual(state.stopped, []);
    assert.deepEqual(state.started, []);
    assert.equal(new ProfileRegistry(home).scan().find((row) => row.name === "space-coding")?.meta?.dshVersion, undefined);
  };

  place("acceptance-peer-fixture", {
    peers: { "@deepseek-ai/dsh": "<0.1.0" },
  });
  await rejectSwitch(/acceptance-peer-fixture \(@deepseek-ai\/dsh@<0\.1\.0\)/);
  assert.equal(
    readFileSync(join(profile, "node_modules", "acceptance-peer-fixture", "package.json"), "utf8").includes('"<0.1.0"'),
    true,
  );

  place("acceptance-peer-fixture", {
    peers: { "@deepseek-ai/dsh": "<0.1.0" },
    extra: { peerDependenciesMeta: { "@deepseek-ai/dsh": { optional: true } } },
  });
  await rejectSwitch(/acceptance-peer-fixture \(@deepseek-ai\/dsh@<0\.1\.0\)/);

  place("acceptance-peer-fixture", {
    enabled: true,
    peers: { "@deepseek-ai/dsh": ">=0.2.1-alpha.2", "@deepseek-ai/dsh-client-connection": "<0.1.0" },
  });
  await rejectSwitch(/acceptance-peer-fixture \(@deepseek-ai\/dsh-client-connection@<0\.1\.0\)/);

  place("../outside", { omitManifest: true });
  await rejectSwitch(/not a package name/);
  assert.equal(existsSync(join(profile, "outside", "package.json")), false);
});

test("space.runtime.set still accepts a compatible installed third-party plugin", async () => {
  let installs = 0;
  const { maintenance, home, state } = harness({
    install: async () => {
      installs += 1;
      throw new Error("must not install");
    },
  });
  const profile = join(home, "profiles", "space-coding");
  const manifestPath = join(profile, "package.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
    dsh: { profile: { bundles: string[] } };
  };
  const version = "0.2.1-alpha.2";
  const place = (name: string, options: { enabled?: boolean; peers?: Record<string, string>; omitManifest?: boolean }) => {
    rmSync(join(profile, "node_modules"), { recursive: true, force: true });
    const manifest = structuredClone(original);
    manifest.dependencies[name] = "1.0.0";
    if (options.enabled) manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, name];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (options.omitManifest) return;
    const dir = join(profile, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({
      name,
      version: "1.0.0",
      peerDependencies: options.peers ?? {},
    })}\n`);
  };
  const allow = async () => {
    const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version });
    assert.equal(plan.kind, "space.runtime.set");
    assert.equal(installs, 0);
    assert.deepEqual(state.stopped, []);
    assert.equal(new ProfileRegistry(home).scan().find((row) => row.name === "space-coding")?.meta?.dshVersion, undefined);
  };

  place("acceptance-peer-fixture", { enabled: true, peers: { "@deepseek-ai/dsh": ">=0.2.1-alpha.2" } });
  await allow();
  place("acceptance-peer-fixture", { peers: { "@deepseek-ai/dsh": ">=0.2.1-alpha.2", react: "^19.0.0" } });
  await allow();
  place("acceptance-peer-fixture", { enabled: true, omitManifest: true });
  await allow();
  place("@deepseek-ai/dsh-base", { enabled: true, peers: { "@deepseek-ai/dsh": "<0.1.0" } });
  await allow();
});

test("space.runtime.set execute rechecks a manifest changed after preview before stop or pin", async () => {
  let installs = 0;
  const { maintenance, home, state } = harness({
    install: async () => {
      installs += 1;
      throw new Error("must not install");
    },
    installedBin: (version) => (version === "0.2.1-alpha.2" || version === "0.1.5-rc.1" ? "bin.js" : undefined),
  });
  const profile = join(home, "profiles", "space-coding");
  const manifestPath = join(profile, "package.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
    dsh: { profile: { bundles: string[] } };
  };
  const version = "0.2.1-alpha.2";
  const pluginDir = join(profile, "node_modules", "acceptance-peer-fixture");
  const pluginManifest = join(pluginDir, "package.json");
  const writePlugin = (range: string, enabled: boolean) => {
    const manifest = structuredClone(original);
    manifest.dependencies["acceptance-peer-fixture"] = "1.0.0";
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== "acceptance-peer-fixture");
    if (enabled) manifest.dsh.profile.bundles.push("acceptance-peer-fixture");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(pluginManifest, `${JSON.stringify({
      name: "acceptance-peer-fixture",
      version: "1.0.0",
      peerDependencies: { "@deepseek-ai/dsh": range },
    })}\n`);
  };

  writePlugin(">=0.2.1-alpha.2", true);
  assert.equal(state.status["space-coding"], "running");
  const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version });
  writePlugin("<0.1.0", false);
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), (error: unknown) => {
    assert.ok(error instanceof WorkbenchMaintenanceError);
    assert.equal(error.code, "workbench/invalid-input");
    assert.match(error.message, /acceptance-peer-fixture \(@deepseek-ai\/dsh@<0\.1\.0\)/);
    return true;
  });
  assert.equal(installs, 0);
  assert.deepEqual(state.stopped, []);
  assert.deepEqual(state.started, []);
  assert.equal(state.status["space-coding"], "running");
  assert.equal(new ProfileRegistry(home).scan().find((row) => row.name === "space-coding")?.meta?.dshVersion, undefined);
  assert.match(readFileSync(pluginManifest, "utf8"), /<0\.1\.0/);
  assert.equal(JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "plans", `${plan.id}.json`), "utf8")).status, "previewed");

  state.status["space-coding"] = "stopped";
  writePlugin("workspace:*", true);
  const again = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version });
  assert.deepEqual(await maintenance.execute(again.id, jobCtx()), { spaceId: "space-coding", dshVersion: version });
  assert.equal(installs, 0);
  assert.deepEqual(state.stopped, []);
  assert.equal(new ProfileRegistry(home).scan().find((row) => row.name === "space-coding")?.meta?.dshVersion, version);
});

test("space.runtime.set rechecks authoritative engine requirements before any switch effects", async () => {
  const version = "0.2.1-rc.2";
  let installs = 0;
  const { maintenance, home, state } = harness({
    install: async () => { installs++; throw new Error("must not install"); },
    installedBin: () => "bin.js",
  });
  const profile = join(home, "profiles", "space-coding");
  const manifestPath = join(profile, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies["engine-fixture"] = "1.0.0";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const pluginDir = join(profile, "node_modules", "engine-fixture");
  mkdirSync(pluginDir, { recursive: true });
  const pluginPath = join(pluginDir, "package.json");
  const writePlugin = (engines: unknown, peers: unknown) => writeFileSync(pluginPath, JSON.stringify({
    name: "engine-fixture", version: "1.0.0", engines, peerDependencies: peers,
  }));
  for (const incompatible of [{ dsh: "<0.1.0" }, { dsh: 42 }, null]) {
    // A compatible engine supersedes both stale and malformed peer declarations.
    writePlugin({ dsh: ">=0.2.1-alpha.4" }, null);
    const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version });
    writePlugin(incompatible, { "@deepseek-ai/dsh": "workspace:*" });
    await assert.rejects(maintenance.execute(plan.id, jobCtx()), (error: unknown) => {
      assert.ok(error instanceof WorkbenchMaintenanceError);
      assert.equal(error.code, "workbench/invalid-input");
      assert.match(error.message, /engines/);
      return true;
    });
    assert.equal(installs, 0);
    assert.deepEqual(state.stopped, []);
    assert.deepEqual(state.started, []);
    assert.equal(new ProfileRegistry(home).scan().find(row => row.name === "space-coding")?.meta?.dshVersion, undefined);
    assert.equal(JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "plans", `${plan.id}.json`), "utf8")).status, "previewed");
  }
});

test("space.runtime.set pins the version for a stopped space without installing official plugins", async () => {
  const runtime = writeRuntimeTree("0.2.0-rc.3");
  const specs: string[] = [];
  const { maintenance, home, state } = harness({
    installedBin: (version) => (version === "0.2.0-rc.3" ? runtime.bin : undefined),
    pluginAdd: async (_dshHome, _profile, spec) => {
      specs.push(spec);
    },
  });
  state.status["space-coding"] = "stopped";
  const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version: "0.2.0-rc.3" });
  assert.ok(plan.changes.some((line) => /Pin space-coding to DSH 0\.2\.0-rc\.3\./.test(line)), plan.changes.join(" | "));
  assert.ok(plan.changes.some((line) => /already installed/.test(line)));
  assert.ok(plan.changes.some((line) => /Official plugins come from DSH 0\.2\.0-rc\.3 itself\./.test(line)), plan.changes.join(" | "));
  const result = await maintenance.execute(plan.id, jobCtx());
  assert.deepEqual(result, { spaceId: "space-coding", dshVersion: "0.2.0-rc.3" });
  const meta = new ProfileRegistry(home).scan().find((row) => row.name === "space-coding")?.meta;
  assert.equal(meta?.dshVersion, "0.2.0-rc.3");
  assert.deepEqual(specs, []);
  assert.equal(state.stopped.includes("space-coding"), false);
  assert.equal(state.started.includes("space-coding"), false);
});

test("space.runtime.set downloads a missing runtime and restarts a running space", async () => {
  const runtime = writeRuntimeTree("0.2.0-rc.3");
  const installed = new Map<string, string>();
  const installs: string[] = [];
  const specs: string[] = [];
  const { maintenance, state } = harness({
    installedBin: (version) => installed.get(version),
    install: async (version) => {
      installs.push(version);
      installed.set(version, runtime.bin);
      return { version, bin: runtime.bin, dir: runtime.root };
    },
    pluginAdd: async (_dshHome, _profile, spec) => {
      specs.push(spec);
    },
  });
  const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version: "0.2.0-rc.3" });
  assert.ok(plan.changes.some((line) => /Download and install DSH 0\.2\.0-rc\.3\./.test(line)), plan.changes.join(" | "));
  assert.ok(plan.changes.some((line) => /coding will be stopped and started again\./.test(line)));
  await maintenance.execute(plan.id, jobCtx());
  assert.deepEqual(installs, ["0.2.0-rc.3"]);
  assert.deepEqual(state.stopped, ["space-coding"]);
  assert.deepEqual(state.started, ["space-coding"]);
  assert.equal(specs.filter((spec) => spec.startsWith("@deepseek-ai/")).length, 0);
});

test("a failed restart after the pin leaves the pin written and the space stopped", async () => {
  const runtime = writeRuntimeTree("0.2.0-rc.3");
  const { maintenance, home, state } = harness({
    installedBin: (version) => (version === "0.2.0-rc.3" ? runtime.bin : undefined),
  });
  state.onStart = () => {
    throw new Error("spawn exploded");
  };
  const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version: "0.2.0-rc.3" });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), /spawn exploded/);
  const meta = new ProfileRegistry(home).scan().find((row) => row.name === "space-coding")?.meta;
  assert.equal(meta?.dshVersion, "0.2.0-rc.3");
  assert.deepEqual(state.stopped, ["space-coding"]);
  assert.equal(state.status["space-coding"], "stopped");
});

test("runtime.remove refuses host, pinned, and missing versions and removes an unused one", async () => {
  const removed: string[] = [];
  const { maintenance, home } = harness({
    installedBin: (version) => (version === "0.9.9" ? "bin.js" : undefined),
    remove: (version) => removed.push(version),
  });
  new ProfileRegistry(home).updateMeta("space-coding", { dshVersion: "0.7.7" });
  const reject = async (version: string, pattern: RegExp) => {
    await assert.rejects(() => maintenance.preview({ kind: "runtime.remove", version }), (error: unknown) => {
      assert.ok(error instanceof WorkbenchMaintenanceError);
      assert.equal(error.code, "workbench/invalid-input");
      assert.match(error.message, pattern);
      return true;
    });
  };
  await reject("0.1.5-rc.1", /is the host runtime\./);
  await reject("0.7.7", /is pinned by space-coding\./);
  await reject("0.6.6", /is not installed in the Spaces runtime store\./);
  const plan = await maintenance.preview({ kind: "runtime.remove", version: "0.9.9" });
  const result = await maintenance.execute(plan.id, jobCtx());
  assert.deepEqual(result, { runtimeVersion: "0.9.9" });
  assert.deepEqual(removed, ["0.9.9"]);
});

test("runtime inventory reports host, pinnedBy, and removable flags", async () => {
  const { maintenance, home } = harness({
    inventory: () => ({
      installed: [
        { version: "0.1.5-rc.1", bin: "bin.js", dir: home },
        { version: "0.9.9", bin: "bin.js", dir: home },
        { version: "0.7.7", bin: "bin.js", dir: home },
      ],
    }),
    installedBin: () => "bin.js",
  });
  new ProfileRegistry(home).updateMeta("space-coding", { dshVersion: "0.9.9" });
  const rows = await maintenance.runtimes();
  const byVersion = new Map(rows.map((row) => [row.version, row]));
  assert.equal(byVersion.get("0.1.5-rc.1")?.host, true);
  assert.deepEqual(byVersion.get("0.1.5-rc.1")?.pinnedBy, []);
  assert.equal(byVersion.get("0.1.5-rc.1")?.removable, false);
  assert.equal(byVersion.get("0.9.9")?.host, false);
  assert.deepEqual(byVersion.get("0.9.9")?.pinnedBy, ["space-coding"]);
  assert.equal(byVersion.get("0.9.9")?.removable, false);
  assert.equal(byVersion.get("0.7.7")?.removable, true);
  assert.equal(byVersion.get("0.1.5-rc.2")?.installed, false);
  assert.equal(byVersion.get("0.1.5-rc.2")?.removable, false);
  assert.equal("current" in (byVersion.get("0.1.5-rc.1") ?? {}), false);
});

test("lost progress persistence or uncertain child termination keeps the plan open as unfinished evidence", async () => {
  for (const failure of [new WorkbenchJobError("workbench/persist-failed"), new ProcessTerminationError("unknown child")]) {
    const { maintenance, home, state } = harness();
    const plan = await maintenance.preview({ kind: "space.runtime.set", spaceId: "space-coding", version: "0.2.0-rc.2" });
    const ctx = jobCtx();
    const phase = ctx.phase;
    ctx.phase = value => { if (value === "runtime") throw failure; phase(value); };
    await assert.rejects(() => maintenance.execute(plan.id, ctx), (error: unknown) =>
      error instanceof WorkbenchJobError && ["workbench/persist-failed", "workbench/failed"].includes(error.code));
    assert.equal(JSON.parse(readFileSync(join(home, ".dsh-spaces-control", "plans", `${plan.id}.json`), "utf8")).status, "running");
    assert.equal(state.reinitialized, 0);
    assert.equal(state.maintenance.at(-1), true);
  }
});

test("cancel is honored before mutation and ignored after the irreversible point", async () => {
  const { home, maintenance, state } = harness();
  const aborting = new AbortController();
  state.onStop = () => aborting.abort();
  const cancelled = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(
    () => maintenance.execute(cancelled.id, jobCtx(aborting.signal)),
    (error: unknown) => error instanceof WorkbenchJobAbortError,
  );
  assert.equal(listProfilePlugins(home, "space-coding").some((item) => item.name === "dsh-outline"), false);
  assert.deepEqual(state.started, ["space-coding"]);

  const late = new AbortController();
  const { maintenance: second, home: home2, state: state2 } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      late.abort();
      await addFromTarball(dshHome, profile, spec);
    },
  });
  const plan = await second.preview({
    kind: "plugin.install",
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await second.execute(plan.id, jobCtx(late.signal));
  assert.equal(listProfilePlugins(home2, "space-coding").some((item) => item.name === "dsh-outline"), true);
  assert.deepEqual(state2.started, ["space-coding"]);
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
  const before = readManifest(home, "space-coding");
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
  assert.equal(readManifest(home, "space-coding").dependencies?.["dsh-outline"], "1.2.3");
  assert.notDeepEqual(readManifest(home, "space-coding"), before);
  assert.equal(state.started.includes("space-coding"), false);
  assert.equal(state.status["space-coding"], "stopped");
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
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(
    () => maintenance.execute(plan.id, jobCtx()),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.context?.spaceId, "space-coding");
      assert.equal(error.context?.packageName, "dsh-outline");
      assert.equal(error.context?.pluginAttribution, "known");
      assert.equal(error.context?.stage, "install");
      assert.match(error.message, /coding/);
      assert.match(error.message, /dsh-outline/);
      assert.match(error.message, /missing peer/);
      return true;
    },
  );
});

test("plugin lock mismatch fails verification and interrupted mutation stays open as evidence", async () => {
  const { home, maintenance, state } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      await addFromTarball(dshHome, profile, spec);
      writeFileSync(join(dshHome, "profiles", profile, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    },
  });
  writeFileSync(join(home, "profiles", "space-coding", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const plan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["space-coding"],
    catalogId: "urzeye/dsh-outline",
    version: "1.2.3",
  });
  await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
  assert.equal(existsSync(join(home, WORKBENCH_CONTROL_DIR_NAME, WORKBENCH_PLUGIN_MUTATION_FILE)), true);
  assert.equal(state.started.includes("space-coding"), false);
});

test("owned file tarball pins are verified against the actual installed version", async () => {
  const { home, maintenance } = harness({ pluginAdd: async (dshHome, profile, spec) => {
    await addFromTarball(dshHome, profile, spec);
    const manifest = readManifest(dshHome, profile);
    manifest.dependencies!["dsh-outline"] = `file:${spec.replaceAll("\\", "/")}`;
    writeFileSync(join(dshHome, "profiles", profile, "package.json"), JSON.stringify(manifest));
    writeFixtureLock(dshHome, profile, manifest.dependencies!);
  } });
  const plan = await maintenance.preview({ kind: "plugin.install", spaceIds: ["space-coding"], catalogId: "urzeye/dsh-outline", version: "1.2.3" });
  await maintenance.execute(plan.id, jobCtx());
  assert.match(readManifest(home, "space-coding").dependencies!["dsh-outline"], /^file:/);
  assert.equal(JSON.parse(readFileSync(join(home, "profiles", "space-coding", "node_modules", "dsh-outline", "package.json"), "utf8")).version, "1.2.3");
});

test("manifest-only plugin installation cannot be reported as successful", async () => {
  const { maintenance } = harness({ pluginAdd: async (dshHome, profile, spec) => {
    await addFromTarball(dshHome, profile, spec);
    rmSync(join(dshHome, "profiles", profile, "node_modules", "dsh-outline", "package.json"));
  } });
  const plan = await maintenance.preview({ kind: "plugin.install", spaceIds: ["space-coding"], catalogId: "urzeye/dsh-outline", version: "1.2.3" });
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

test("snapshot restore preview and execute are unsupported", async () => {
  const { home, maintenance, state } = harness();
  const snapshotId = "11111111-1111-1111-1111-111111111111";
  const codingManifest = join(home, "profiles", "space-coding", "package.json");
  const before = readFileSync(codingManifest);
  await assert.rejects(
    () => maintenance.preview({ kind: "snapshot.restore", snapshotId } as never),
    matchCode("workbench/unsupported"),
  );
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
  await assert.rejects(() => maintenance.execute(planId, jobCtx()), matchCode("workbench/unsupported"));
  assert.deepEqual(readFileSync(codingManifest), before);
});

test("config restore preview is unsupported and does not restore or reinitialize", async () => {
  const { home, maintenance, state } = harness();
  state.backups = [{ id: "cordis.patch.yml.bak-1", createdAt: "2026-01-01T00:00:00.000Z", size: 10, tooLarge: false }];
  const codingManifest = join(home, "profiles", "space-coding", "package.json");
  const before = readFileSync(codingManifest);
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "config.restore",
        spaceId: "spaces-hub",
        backupId: "cordis.patch.yml.bak-1",
      } as never),
    matchCode("workbench/unsupported"),
  );
  await assert.rejects(
    () =>
      maintenance.preview({
        kind: "config.restore",
        spaceId: "space-coding",
        backupId: "cordis.patch.yml.bak-1",
      } as never),
    matchCode("workbench/unsupported"),
  );
  assert.equal(state.reinitialized, 0);
  assert.equal(state.started.includes("space-coding"), false);
  assert.deepEqual(readFileSync(codingManifest), before);
});

test("unknown errors become the static public message and plans are not executed without the write lock", async () => {
  const { maintenance, state } = harness();
  state.writable = false;
  await assert.rejects(() => maintenance.preview({ kind: "snapshot.create" }), (error: unknown) => {
    assert.ok(error instanceof WorkbenchMaintenanceError);
    assert.equal(error.code, "workbench/forbidden");
    assert.match(error.message, /owner missing/);
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
    assert.match(error.message, /ENOENT/);
    assert.equal(error.message.includes("abcd"), false);
    assert.equal(error.message.includes("bin.js"), false);
    assert.equal(error.message.includes("C:\\"), false);
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
  backups: Array<{ id: string; createdAt: string; size: number; tooLarge: boolean }>;
  onStop?: () => void;
  onStart?: () => void;
  stopAllImpl?: () => Promise<void>;
}

interface HarnessOverrides {
  now?: () => Date;
  fetch?: MaintenanceFetcher;
  compatible?: (version: string) => boolean;
  pluginAdd?: (home: string, profile: string, spec: string) => Promise<void>;
  snapshotsCreate?: SnapshotExecutor["create"];
  log?: (message: string, error?: unknown) => void;
  inventory?: () => { installed: Array<{ version: string; bin: string; dir: string }> };
  installedBin?: (version: string) => string | undefined;
  hostRuntime?: () => { bin: string; version: string } | null;
  install?: (version: string) => Promise<{ version: string; bin: string; dir: string }>;
  remove?: (version: string) => void;
}

function harness(overrides: HarnessOverrides = {}) {
  const home = tempDir("dsh-spaces-maint-");
  writeManifest(home, "space-coding", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  writeManifest(home, "spaces-hub", {
    bundles: [BASE, WEB, FULL_SPACES_PACKAGE],
    dependencies: { [BASE]: "1", [WEB]: "1", [FULL_SPACES_PACKAGE]: "0.2.0" },
  });
  const registry = new ProfileRegistry(home);
  registry.ensureHubDir();
  registry.updateMeta("space-coding", { createdAt: "2025-01-01T00:00:00.000Z" });
  const state: HarnessState = {
    writable: true,
    status: { "space-coding": "running", "spaces-hub": "running" },
    stopped: [],
    started: [],
    stopAll: 0,
    reinitialized: 0,
    maintenance: [],
    order: [],
    backups: [],
  };
  const maintenance = createMaintenance(home, state, overrides);
  return { home, state, maintenance };
}

function createMaintenance(
  home: string,
  state: HarnessState,
  overrides: HarnessOverrides = {},
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
      create: overrides.snapshotsCreate ?? (async () => {
        throw new Error("snapshot create not stubbed");
      }),
      delete: async () => undefined,
    } as unknown as SnapshotExecutor,
    runtimes: {
      inventory: overrides.inventory ?? (() => ({
        installed: [{ version: "0.1.5-rc.1", bin: "bin.js", dir: home }],
      })),
      catalog: async () => ({ versions: [{ version: "0.1.5-rc.2" }], distTags: { next: "0.1.5-rc.2" } }),
      install: overrides.install ?? (async (version: string) => ({ version, bin: "bin.js", dir: home })),
      installedBin: overrides.installedBin ?? ((version: string) => (version === "0.1.5-rc.1" ? "bin.js" : undefined)),
      remove: overrides.remove ?? (() => {
        throw new Error("runtime remove not stubbed");
      }),
    } as unknown as WorkbenchMaintenancePorts["runtimes"],
    diagnostics: {
      get: (name: string) => ({
        name,
        status: state.status[name] ?? "stopped",
        logs: [],
        backups: state.backups,
        canRestore: name !== "web",
      }),
    } as unknown as DiagnosticsService,
    managerId: () => "spaces-hub",
    assertWritable: () => {
      if (!state.writable) throw new Error("owner missing C:\\\\Users\\\\admin\\\\.dsh");
    },
    validateSpace: (spaceId: string, allowManager?: boolean) => {
      if (!(spaceId in state.status) && !["space-coding", "spaces-hub"].includes(spaceId)) throw new Error("unknown space");
      if (!allowManager && spaceId === "spaces-hub") throw new Error("manager protected");
    },
    statusOf: (spaceId: string) => state.status[spaceId] ?? "stopped",
    ownedSpaceIds: () => [...new Set(["spaces-hub", "space-coding", ...Object.keys(state.status)])],
    stopSpace: async (spaceId: string) => {
      state.onStop?.();
      state.stopped.push(spaceId);
      state.status[spaceId] = "stopped";
    },
    stopAll: async () => {
      if (state.stopAllImpl) return state.stopAllImpl();
      state.order.push("stopAll");
      state.stopAll += 1;
      for (const id of ["spaces-hub", "space-coding"]) {
        state.stopped.push(id);
        state.status[id] = "stopped";
      }
    },
    startSpace: async (spaceId: string) => {
      state.onStart?.();
      state.started.push(spaceId);
      state.status[spaceId] = "running";
    },
    currentRuntime: () => runtime,
    hostRuntime: overrides.hostRuntime ?? (() => ({ bin: "bin.js", version: runtime.version })),
    reinitializeManager: async () => {
      state.order.push("reinitialize");
      state.reinitialized += 1;
    },
    setMaintenance: (active: boolean) => {
      state.maintenance.push(active);
    },
    isCompatibleRuntime: overrides.compatible ?? ((version: string) => version === "0.1.5-rc.1"),
    observation: () => ({ serviceEpoch: "c".repeat(64), expectedRevision: "d".repeat(64) }),
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
  writeManifest(home, "space-coding", { bundles: [BASE], dependencies: { [BASE]: "1" } });
  writeManifest(home, "spaces-hub", { bundles: [BASE, FULL_SPACES_PACKAGE], dependencies: { [BASE]: "1", [FULL_SPACES_PACKAGE]: "0.2.0" } });
  const registry = new ProfileRegistry(home);
  registry.ensureHubDir();
  registry.updateMeta("space-coding", { createdAt: "2025-01-01T00:00:00.000Z" });
  writeFileSync(join(home, "settings.yaml"), "settings\n");
  const store = new SnapshotStore({ home, root: snapRoot });
  const state: HarnessState = {
    writable: true,
    status: { "space-coding": "running", "spaces-hub": "running" },
    stopped: [],
    started: [],
    stopAll: 0,
    reinitialized: 0,
    maintenance: [],
    order: [],
    backups: [],
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
      installedBin: (version: string) => (version === runtime.version ? join(runtimeDir, "bin.js") : undefined),
      remove: () => {
        throw new Error("runtime remove not stubbed");
      },
    } as unknown as WorkbenchMaintenancePorts["runtimes"],
    diagnostics: { get: () => ({ name: "space-coding", status: "stopped", logs: [], backups: [], canRestore: true }) } as unknown as DiagnosticsService,
    managerId: () => "spaces-hub",
    assertWritable: () => undefined,
    validateSpace: (spaceId: string, allowManager?: boolean) => {
      if (!["space-coding", "spaces-hub"].includes(spaceId)) throw new Error("unknown");
      if (!allowManager && spaceId === "spaces-hub") throw new Error("manager");
    },
    statusOf: (spaceId: string) => state.status[spaceId] ?? "stopped",
    ownedSpaceIds: () => ["spaces-hub", "space-coding"],
    stopSpace: async (spaceId: string) => {
      state.stopped.push(spaceId);
      state.status[spaceId] = "stopped";
    },
    stopAll: async () => {
      state.stopAll += 1;
      for (const id of ["spaces-hub", "space-coding"]) {
        state.stopped.push(id);
        state.status[id] = "stopped";
      }
    },
    startSpace: async (spaceId: string) => {
      state.started.push(spaceId);
      state.status[spaceId] = "running";
    },
    currentRuntime: () => runtime,
    hostRuntime: () => ({ bin: "bin.js", version: runtime.version }),
    reinitializeManager: async () => {
      state.reinitialized += 1;
    },
    setMaintenance: (active: boolean) => {
      state.maintenance.push(active);
    },
    isCompatibleRuntime: (version: string) => version === runtime.version,
    observation: () => ({ serviceEpoch: "c".repeat(64), expectedRevision: "d".repeat(64) }),
  };
  return {
    home,
    snapRoot,
    runtime,
    state,
    maintenance: new WorkbenchMaintenance(ports, { packageSource: "official", fetch: defaultOutlineFetch() }),
  };
}

function executorFromStore(store: SnapshotStore): SnapshotExecutor {
  return {
    list: () => store.list(),
    preview: (id: string) => store.preview(id),
    runtimeBin: (id: string) => store.runtimeBin(id),
    runtimeRoot: (id: string) => store.runtimeRoot(id),
    create: async (runtime: SnapshotRuntime, reason?: string) => store.create(runtime, reason),
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

test("unsupported snapshot runtime fails before stopping spaces", async()=>{
 const {maintenance,state}=snapshotHarness();
 (maintenance as any).ports.currentRuntime=()=>{throw new Error("unsupported snapshot runtime layout");};
 const plan=await maintenance.preview({kind:"snapshot.create"});
 await assert.rejects(()=>maintenance.execute(plan.id,jobCtx()),/unsupported snapshot runtime layout/);
 assert.equal(state.stopAll,0); assert.deepEqual(state.maintenance,[]);
});

// ---------------------------------------------------------------------------
// plugin.install.spec — the control channel's exact-source variant (D4).
// rejectRawSpec is untouched: this kind carries the normalized source itself.
// ---------------------------------------------------------------------------

/** pnpm persists git resolutions in pnpm-lock.yaml, not the dep specifier. */
function writeGitLock(home: string, profile: string, name: string, spec: string): void {
  const body = spec.replace(/^github:/, "https://github.com/").replace(/^git\+/, "");
  const [repoPart, fragment = ""] = body.split("#");
  const repo = repoPart!.replace(/\.git$/, "");
  const segments = fragment.split("&").filter(Boolean);
  const commit = segments.find((part) => !part.startsWith("path:") && !part.startsWith("semver:")) ?? "";
  const path = segments.find((part) => part.startsWith("path:"))?.slice(5);
  const resolution = `{commit: '${commit}', repo: '${repo}', type: git${path ? `, path: ${JSON.stringify(path)}` : ""}}`;
  const depPath = `git+${repo}#${commit}${path ? `&path:${path}` : ""}`;
  writeFileSync(
    join(home, "profiles", profile, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      ${name}:\n        specifier: '${spec}'\n        version: '${depPath}'\n\nsnapshots:\n  ${name}@${depPath}:\n    resolution: ${resolution}\n`,
  );
}

function addGitFixture(home: string, profile: string, name: string, spec: string): void {
  const manifest = readManifest(home, profile);
  manifest.dependencies = { ...manifest.dependencies, [name]: spec };
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
  bundles.add(name);
  writeFileSync(
    join(home, "profiles", profile, "package.json"),
    `${JSON.stringify({ dependencies: manifest.dependencies, dsh: { profile: { bundles: [...bundles] } } }, null, 2)}\n`,
  );
  const installedDir = join(home, "profiles", profile, "node_modules", ...name.split("/"));
  mkdirSync(installedDir, { recursive: true });
  writeFileSync(join(installedDir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  writeGitLock(home, profile, name, spec);
}

test("plugin.install.spec preview rejects anything that is not a closed exact source", async () => {
  const { maintenance } = harness();
  const bad: unknown[] = [
    { kind: "plugin.install.spec", spaceId: "space-coding" },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: "dsh-plugin@1.0.0" },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { npm: { packageName: "p", version: "latest" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { npm: { packageName: "p", version: "^1.0.0" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { npm: { packageName: "@deepseek-ai/dsh-web-app", version: "0.2.0-rc.2" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { npm: { packageName: "@dsh-spaces/plugin", version: "1.0.0" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { github: { owner: "o", repo: "r", commit: "main", packageName: "p" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { github: { owner: "o", repo: "r", commit: "a".repeat(39), packageName: "p" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { github: { owner: "o", repo: "r", commit: "a".repeat(40), path: "../x", packageName: "p" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { github: { owner: "o", repo: "r", commit: "a".repeat(40), path: "x\\y", packageName: "p" } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["*"] } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["github.com/o/r"] } } },
    { kind: "plugin.install.spec", spaceId: "space-coding", source: { npm: { packageName: "p", version: "1.0.0" } }, extra: 1 },
  ];
  for (const request of bad) {
    await assert.rejects(
      () => maintenance.preview(request as never),
      matchCode("workbench/invalid-input"),
      JSON.stringify(request),
    );
  }
  // Target protection applies before source validation.
  await assert.rejects(
    () => maintenance.preview({
      kind: "plugin.install.spec", spaceId: "spaces-hub",
      source: { npm: { packageName: "p", version: "1.0.0" } },
    }),
    matchCode("workbench/forbidden"),
  );
  await assert.rejects(
    () => maintenance.preview({
      kind: "plugin.install.spec", spaceId: "space-ghost",
      source: { npm: { packageName: "p", version: "1.0.0" } },
    }),
    matchCode("workbench/not-found"),
  );
});

test("plugin.install.spec npm: writes allowBuilds verbatim, installs the pinned spec", async () => {
  const specs: string[] = [];
  const { home, maintenance, state } = harness({
    pluginAdd: async (dshHome, profile, spec) => {
      specs.push(`${profile} <- ${spec}`);
      const name = spec.split("@")[0] === "" ? `@${spec.split("@")[1]}` : spec.split("@")[0]!;
      const version = spec.slice(spec.lastIndexOf("@") + 1);
      await addNamed(dshHome, profile, name === "" ? spec : name, version);
    },
  });
  state.status["space-coding"] = "running";

  const plan = await maintenance.preview({
    kind: "plugin.install.spec",
    spaceId: "space-coding",
    source: { npm: { packageName: "dsh-plugin-a", version: "1.2.3", approvedBuilds: ["dsh-plugin-a", "dep@1.0.0"] } },
  });
  assert.ok(plan.changes.some((line) => line.includes("dsh-plugin-a@1.2.3")));
  assert.ok(plan.changes.some((line) => /dsh-plugin-a, dep@1\.0\.0/.test(line)));
  assert.ok(plan.changes.some((line) => /Stop and restart/.test(line)));

  await maintenance.execute(plan.id, jobCtx());
  assert.deepEqual(specs, ["space-coding <- dsh-plugin-a@1.2.3"]);
  const policy = readFileSync(join(home, "profiles", "space-coding", "pnpm-workspace.yaml"), "utf8");
  assert.match(policy, /dangerouslyAllowAllBuilds: false/);
  assert.match(policy, /dsh-plugin-a: true/);
  assert.match(policy, /dep@1\.0\.0: true/);
  const installed = listProfilePlugins(home, "space-coding");
  assert.ok(installed.some((item) => item.name === "dsh-plugin-a" && item.version === "1.2.3"));
  assert.deepEqual(state.stopped, ["space-coding"]);
  assert.deepEqual(state.started, ["space-coding"]);
});

test("plugin.install.spec github: lockfile read-back proves repo, commit and subdirectory", async () => {
  const goodSpec = `github:org/repo#${"a".repeat(40)}&path:/plugins/dsh-b`;
  const badSpec = `github:org/repo#${"b".repeat(40)}&path:/plugins/dsh-b`;
  for (const spec of [goodSpec, badSpec]) {
    const { home, maintenance } = harness({
      pluginAdd: async (dshHome, profile) => addGitFixture(dshHome, profile, "dsh-b", spec),
    });
    const plan = await maintenance.preview({
      kind: "plugin.install.spec",
      spaceId: "space-coding",
      source: { github: { owner: "org", repo: "repo", commit: "a".repeat(40), path: "plugins/dsh-b", packageName: "dsh-b" } },
    });
    assert.ok(plan.changes.some((line) => /org\/repo\/plugins\/dsh-b#a{40}/.test(line)));
    if (spec === goodSpec) {
      await maintenance.execute(plan.id, jobCtx());
      assert.equal(listProfilePlugins(home, "space-coding").some((item) => item.name === "dsh-b"), true);
    } else {
      // A mismatched lockfile resolution is an honest failure, not a fix-up.
      await assert.rejects(() => maintenance.execute(plan.id, jobCtx()), matchCode("workbench/failed"));
    }
  }
});

test("plugin.install.spec reports pending build keys without approving them", async () => {
  const { home, maintenance } = harness({
    pluginAdd: async () => {
      throw new Error(
        `dsh plugin add failed (exit 1): ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED\n` +
        `allowBuilds:\n  github.com/org/dep: true\n`,
      );
    },
  });
  const plan = await maintenance.preview({
    kind: "plugin.install.spec",
    spaceId: "space-coding",
    source: { github: { owner: "org", repo: "dep", commit: "a".repeat(40), packageName: "dep" } },
  });
  await assert.rejects(
    () => maintenance.execute(plan.id, jobCtx()),
    (error: unknown) => /Pending builds awaiting approval: github\.com\/org\/dep/.test((error as Error).message),
  );
  // Deny-by-default policy was still written before the attempted install.
  const policy = readFileSync(join(home, "profiles", "space-coding", "pnpm-workspace.yaml"), "utf8");
  assert.match(policy, /dangerouslyAllowAllBuilds: false/);
});
