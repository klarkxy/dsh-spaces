import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import {
  FULL_SPACES_PACKAGE,
  WorkbenchMaintenance,
  type MaintenanceFetcher,
} from "../src/adapters/node/workbench-maintenance.ts";
import type { WorkbenchMaintenancePorts } from "../src/adapters/node/workbench-maintenance-ports.ts";
import type { HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import {
  WorkbenchJobError,
  type WorkbenchJobContext,
} from "../src/adapters/node/workbench-jobs.ts";
import { isHubPluginArchive, readPluginLibrary } from "../src/adapters/node/plugin-library.ts";
import { listProfilePlugins } from "../src/adapters/node/plugin-ops.ts";
import { ProfileRegistry } from "../src/adapters/node/profile-registry.ts";
import type { CoordinatedUpgrade } from "../src/adapters/node/coordinated-upgrade.ts";
import type { DiagnosticsService } from "../src/adapters/node/diagnostics.ts";
import type { SnapshotExecutor } from "../src/adapters/node/snapshot-executor.ts";
import type { SnapshotRuntime } from "../src/shared/snapshots.ts";
import type { ProfileStatus } from "../src/shared/types.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-plugins");
const BASE = "@deepseek-ai/dsh-base";
const WEB = "@deepseek-ai/dsh-web-app";
const SAMPLES = [
  { name: "dsh-sample-notes", version: "1.0.0", kind: "notes", ping: "notes-ok" },
  { name: "dsh-sample-sketch", version: "2.1.0", kind: "sketch", ping: "sketch-ok" },
  { name: "dsh-sample-relay", version: "0.4.2", kind: "relay", ping: "relay-ok" },
  { name: "dsh-sample-crash", version: "3.0.0", kind: "crash", ping: null },
  { name: "dsh-sample-broken", version: "9.9.9", kind: "broken", ping: null },
] as const;

const temps: string[] = [];
const contexts: Context[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose();
    } catch {
      /* isolate */
    }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("sample plugins load as distinct Cordis plugins and a crash does not kill the host", async () => {
  const ctx = new Context();
  contexts.push(ctx);
  const notes = new (await loadFixture("dsh-sample-notes")).default(ctx);
  const sketch = new (await loadFixture("dsh-sample-sketch")).default(ctx);
  const relay = new (await loadFixture("dsh-sample-relay")).default(ctx);
  assert.equal(notes.ping(), "notes-ok");
  assert.deepEqual(notes.list(), ["inbox", "scratch"]);
  assert.equal(sketch.ping(), "sketch-ok");
  assert.deepEqual(sketch.canvas(), { width: 320, height: 240 });
  assert.equal(relay.ping(), "relay-ok");
  assert.equal(relay.hop("a", "b"), "a->b");
  const Crash = (await loadFixture("dsh-sample-crash")).default;
  assert.throws(() => new Crash(), /dsh-sample-crash exploded during start/);
  assert.equal(notes.ping(), "notes-ok");
  const client = await import(pathToFileURL(join(FIXTURES, "dsh-sample-sketch", "client.js")).href);
  assert.deepEqual(client.apply(), { id: "dsh-sample-sketch", surface: "canvas" });
});

test("workbench installs sample plugins from packed tarballs and keeps A when B fails", async () => {
  const packed = packAll();
  const { home, maintenance, state } = harness(packed);
  writeManifest(home, "notes", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  writeManifest(home, "lab", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  state.status.notes = "stopped";
  state.status.lab = "stopped";

  for (const sample of SAMPLES.filter((row) => row.ping)) {
    const plan = await maintenance.preview({
      kind: "plugin.install",
      spaceIds: ["coding"],
      catalogId: sample.name,
      version: sample.version,
    });
    assert.ok(plan.changes.some((line) => line.includes(`${sample.name}@${sample.version}`)));
    await maintenance.execute(plan.id, jobCtx());
    const installed = listProfilePlugins(home, "coding").find((item) => item.name === sample.name);
    assert.ok(installed, sample.name);
    assert.equal(installed.version, sample.version);
    assert.equal(installed.resolvedVersion, sample.version);
    const loaded = await importInstalled(home, "coding", sample.name);
    assert.equal(new loaded.default({ provide() {} }).ping(), sample.ping);
  }

  const crashPlan = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["coding"],
    catalogId: "dsh-sample-crash",
    version: "3.0.0",
  });
  await maintenance.execute(crashPlan.id, jobCtx());
  const Crash = (await importInstalled(home, "coding", "dsh-sample-crash")).default;
  assert.throws(() => new Crash(), /exploded during start/);
  const stillNotes = await importInstalled(home, "coding", "dsh-sample-notes");
  assert.equal(new stillNotes.default({ provide() {} }).ping(), "notes-ok");

  const batch = await maintenance.preview({
    kind: "plugin.install",
    spaceIds: ["notes", "lab"],
    catalogId: "dsh-sample-broken",
    version: "9.9.9",
  });
  await assert.rejects(
    () => maintenance.execute(batch.id, jobCtx()),
    (error: unknown) => {
      assert.ok(error instanceof WorkbenchJobError);
      assert.equal(error.code, "workbench/failed");
      assert.equal(error.context?.spaceId, "notes");
      assert.equal(error.context?.packageName, "dsh-sample-broken");
      assert.equal(error.context?.stage, "install");
      assert.match(error.message, /missing peer|The job failed|dsh-sample-broken/);
      return true;
    },
  );
  assert.equal(listProfilePlugins(home, "notes").some((item) => item.name === "dsh-sample-broken"), false);
  assert.equal(listProfilePlugins(home, "lab").some((item) => item.name === "dsh-sample-broken"), false);
  assert.equal(
    readPluginLibrary(home).some((entry) => entry.spec === "dsh-sample-broken@9.9.9"),
    true,
  );

  const listed = await maintenance.plugins("dsh-sample-sketch");
  const sketch = listed.find((row) => row.packageName === "dsh-sample-sketch");
  assert.ok(sketch);
  assert.equal(sketch.version, "2.1.0");
  assert.ok(sketch.installedIn.includes("coding"));
  const broken = (await maintenance.plugins("dsh-sample-broken")).find((row) => row.packageName === "dsh-sample-broken");
  assert.ok(broken);
  assert.equal(broken.installedIn.includes("notes"), false);
  assert.equal(broken.installedIn.includes("lab"), false);
});

async function loadFixture(name: string) {
  return import(pathToFileURL(join(FIXTURES, name, "index.js")).href) as Promise<{
    default: new (ctx?: unknown) => { ping?: () => string; list?: () => string[]; canvas?: () => unknown; hop?: (a: string, b: string) => string };
  }>;
}

async function importInstalled(home: string, space: string, name: string) {
  const index = join(home, "profiles", space, "node_modules", name, "index.js");
  assert.equal(existsSync(index), true, index);
  return import(pathToFileURL(index).href) as Promise<{
    default: new (ctx?: unknown) => { ping: () => string };
  }>;
}

function packAll(): Record<string, { tarball: Buffer; version: string }> {
  const out: Record<string, { tarball: Buffer; version: string }> = {};
  for (const sample of SAMPLES) {
    out[sample.name] = { tarball: packPlugin(sample.name), version: sample.version };
  }
  return out;
}

function packPlugin(name: string): Buffer {
  const staging = tempDir("dsh-sample-pack-");
  const inner = join(staging, "package");
  cpSync(join(FIXTURES, name), inner, { recursive: true });
  const tgz = join(staging, `${name}.tgz`);
  const packed = spawnSync("tar", ["-czf", tgz, "-C", staging, "package"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (packed.status !== 0 || !existsSync(tgz)) {
    throw new Error(`tar pack ${name} failed: ${packed.stderr || packed.stdout}`);
  }
  return readFileSync(tgz);
}

function harness(packed: Record<string, { tarball: Buffer; version: string }>) {
  const home = tempDir("dsh-sample-home-");
  writeManifest(home, "coding", { bundles: [BASE, WEB], dependencies: { [BASE]: "1", [WEB]: "1" } });
  writeManifest(home, "spaces-hub", {
    bundles: [BASE, WEB, FULL_SPACES_PACKAGE],
    dependencies: { [BASE]: "1", [WEB]: "1", [FULL_SPACES_PACKAGE]: "0.2.0" },
  });
  const state = {
    status: { coding: "running", "spaces-hub": "running" } as Record<string, ProfileStatus>,
    stopped: [] as string[],
    started: [] as string[],
  };
  const runtime: SnapshotRuntime = { version: "0.1.5-rc.1", root: home, binRelative: "bin.js" };
  const ports: WorkbenchMaintenancePorts = {
    home,
    registry: new ProfileRegistry(home),
    lock: { run: async (_label, action) => action() } as HomeOperationLock,
    snapshots: {
      list: () => [],
      preview: () => {
        throw new Error("unused");
      },
      pendingRestore: () => undefined,
      create: async () => {
        throw new Error("unused");
      },
      restore: async () => {
        throw new Error("snapshot restore must not be called");
      },
      recover: async () => undefined,
      delete: async () => undefined,
    } as SnapshotExecutor,
    runtimes: {
      inventory: () => ({ installed: [], current: { version: runtime.version, bin: "bin.js", origin: "store" as const } }),
      catalog: async () => ({ versions: [], distTags: {} }),
      install: async () => ({ version: runtime.version, bin: "bin.js", dir: home }),
    } as WorkbenchMaintenancePorts["runtimes"],
    upgrades: {
      preview: () => ({ version: runtime.version, profiles: [] }),
      upgrade: async () => {
        throw new Error("unused");
      },
      restore: async () => {
        throw new Error("restore not stubbed");
      },
      recover: async () => {
        throw new Error("recover not stubbed");
      },
    } as CoordinatedUpgrade,
    diagnostics: {
      get: () => ({ name: "coding", status: "stopped", logs: [], backups: [], canRestore: false }),
    } as DiagnosticsService,
    managerId: () => "spaces-hub",
    assertWritable: () => undefined,
    validateSpace: (spaceId: string, allowManager?: boolean) => {
      if (!(spaceId in state.status) && !["coding", "spaces-hub", "notes", "lab"].includes(spaceId)) {
        throw new Error("unknown space");
      }
      if (!allowManager && spaceId === "spaces-hub") throw new Error("manager protected");
    },
    statusOf: (spaceId: string) => state.status[spaceId] ?? "stopped",
    ownedSpaceIds: () => [...new Set(["spaces-hub", "coding", ...Object.keys(state.status)])],
    stopSpace: async (spaceId: string) => {
      state.stopped.push(spaceId);
      state.status[spaceId] = "stopped";
    },
    stopAll: async () => {
      for (const id of Object.keys(state.status)) {
        state.stopped.push(id);
        state.status[id] = "stopped";
      }
    },
    startSpace: async (spaceId: string) => {
      state.started.push(spaceId);
      state.status[spaceId] = "running";
    },
    currentRuntime: () => runtime,
    reinitializeManager: async () => undefined,
    setMaintenance: () => undefined,
    isCompatibleRuntime: (version: string) => version === runtime.version,
    observation: () => ({
      serviceEpoch: "c".repeat(64),
      expectedRevision: "d".repeat(64),
    }),
  };
  const maintenance = new WorkbenchMaintenance(ports, {
    packageSource: "official",
    fetch: sampleFetch(packed),
    pluginAdd: async (dshHome, profile, spec) => addFromPackedTarball(dshHome, profile, spec),
    pluginRemove: async () => undefined,
  });
  return { home, maintenance, state };
}

function sampleFetch(packed: Record<string, { tarball: Buffer; version: string }>): MaintenanceFetcher {
  return async (url) => {
    const tarballName = Object.keys(packed).find((name) => url.includes(`${name}-`) && url.endsWith(".tgz"));
    if (tarballName) {
      const bytes = packed[tarballName]!.tarball;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    const name = Object.keys(packed).find((item) => url.includes(encodeURIComponent(item)) || url.endsWith(`/${item}`));
    if (!name) {
      return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const version = packed[name]!.version;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        name,
        versions: {
          [version]: { dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } },
        },
        "dist-tags": { latest: version },
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

async function addFromPackedTarball(home: string, profile: string, spec: string): Promise<void> {
  assert.equal(isHubPluginArchive(home, spec), true);
  const normalized = spec.replaceAll("\\", "/");
  const library = readPluginLibrary(home).find((item) => item.tarball && normalized.endsWith(item.tarball));
  assert.ok(library, "install spec must be a hub library tarball");
  if (library.packageName === "dsh-sample-broken") {
    throw new Error("cli exited 1: missing peer @deepseek-ai/cordis");
  }
  const dest = join(home, "profiles", profile, "node_modules", library.packageName);
  extractNpmTarball(spec, dest);
  const installed = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as { name: string; version: string };
  const manifestPath = join(home, "profiles", profile, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  manifest.dependencies = { ...manifest.dependencies, [installed.name]: installed.version };
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
  bundles.add(installed.name);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ dependencies: manifest.dependencies, dsh: { profile: { bundles: [...bundles] } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(home, "profiles", profile, "pnpm-lock.yaml"),
    JSON.stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: Object.fromEntries(
            Object.entries(manifest.dependencies).map(([name, specifier]) => [name, { specifier, version: specifier }]),
          ),
        },
      },
    }),
  );
}

function extractNpmTarball(tgz: string, dest: string): void {
  const staging = tempDir("dsh-sample-extract-");
  const unpacked = spawnSync("tar", ["-xf", tgz, "-C", staging], { encoding: "utf8", windowsHide: true });
  if (unpacked.status !== 0) {
    throw new Error(`tar extract failed: ${unpacked.stderr || unpacked.stdout}`);
  }
  const inner = join(staging, "package");
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(inner, dest, { recursive: true });
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

function jobCtx(): WorkbenchJobContext {
  return {
    signal: new AbortController().signal,
    phase: () => undefined,
    message: () => undefined,
    cancellable: () => undefined,
    result: () => undefined,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
