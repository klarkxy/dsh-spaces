import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { CoordinatedUpgrade } from "../src/adapters/node/coordinated-upgrade.ts";
import { RuntimeStore, type RunProcessFn } from "../src/adapters/node/runtime-store.ts";
import { runSnapshotWorker, SnapshotExecutor } from "../src/adapters/node/snapshot-executor.ts";
import { retargetTree, SnapshotStore } from "../src/adapters/node/snapshot-store.ts";
import { RESTORE_STAGE_DIR, type SnapshotRuntime } from "../src/shared/snapshots.ts";

const FILE_COUNT = 900;
const FILE_BYTES = 8192;
const HEARTBEAT_MS = 15;
const STALL_MS = 80;
const BASE = "@deepseek-ai/dsh-base";
const WEB = "@deepseek-ai/dsh-web-app";
const temps: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let workerFile = "";

afterEach(() => {
  for (const dir of temps.splice(0)) rmChecked(dir);
});

after(() => {
  if (workerFile) rmChecked(dirname(workerFile));
});

before(async () => {
  workerFile = await compileWorker();
});

test("sync snapshot create stalls the HTTP heartbeat; worker create does not", async () => {
  const worker = requireWorker();
  const sync = snapshotCreateFixture("dsh-sync-create-");
  fillTree(join(sync.home, "profiles", "coding", "payload"), FILE_COUNT);
  const syncPulse = await withHeartbeat(() => {
    sync.store.create(sync.runtime);
  });
  const asyncFix = snapshotCreateFixture("dsh-async-create-");
  fillTree(join(asyncFix.home, "profiles", "coding", "payload"), FILE_COUNT);
  const executor = new SnapshotExecutor({ home: asyncFix.home, root: asyncFix.root, workerFile: worker });
  const asyncPulse = await withHeartbeat(() => executor.create(asyncFix.runtime, "upgrade"));

  assert.equal(executor.list().length, 1);
  assert.ok(asyncPulse.elapsed >= 0);
  if (syncPulse.elapsed >= STALL_MS) {
    assert.equal(syncPulse.during, 0, `sync snapshot create must block the loop (${syncPulse.elapsed}ms, hits=${syncPulse.during})`);
  }
  if (asyncPulse.elapsed >= STALL_MS) {
    assert.ok(
      asyncPulse.during > 0,
      `worker snapshot create must keep HTTP responding (${asyncPulse.elapsed}ms, hits=${asyncPulse.during})`,
    );
  }
});

test("worker restore/completeRestore refuse and keep pending evidence", async () => {
  const worker = requireWorker();
  const { home, root, store } = pendingStageFixture("dsh-fail-restore-");
  const pendingPath = join(root, "pending-restore.json");
  const pendingBytes = readFileSync(pendingPath);
  const executor = new SnapshotExecutor({ home, root, workerFile: worker });
  const pulse = await withHeartbeat(async () => {
    await assert.rejects(() => executor.completeRestore(), /not supported/);
    await assert.rejects(() => executor.restore("59ca7cee-0c06-4610-bc95-e86849247cef"), /not supported/);
    await assert.rejects(
      () => runSnapshotWorker(worker, {
        home,
        root,
        operation: "restore",
        id: "59ca7cee-0c06-4610-bc95-e86849247cef",
      }),
      /not supported/,
    );
  });
  assert.ok(pulse.elapsed >= 0);
  assert.deepEqual(readFileSync(pendingPath), pendingBytes);
  assert.ok(store.pendingRestore());
  assert.equal(existsSync(join(home, RESTORE_STAGE_DIR)), true);

  const missingWorker = join(dirname(worker), "missing-snapshot-worker.mjs");
  const missing = new SnapshotExecutor({ home, root, workerFile: missingWorker });
  await assert.rejects(() => missing.delete("59ca7cee-0c06-4610-bc95-e86849247cef"), /Snapshot worker exited|Cannot find|ENOENT|not found/i);
  assert.deepEqual(readFileSync(pendingPath), pendingBytes);
});

test("coordinated restore is unsupported and never invokes snapshot mutation", async (t) => {
  const ctx = await upgradeHarness(t);
  const calls: string[] = [];
  const before = readFileSync(join(ctx.home, "profiles", "coding", "package.json"), "utf8");
  ctx.upgrade = makeUpgrade(ctx, {
    snapshots: {
      create: async () => {
        calls.push("create");
        throw new Error("snapshot create must not run");
      },
      restore: async () => {
        calls.push("restore");
        throw new Error("snapshot restore must not run");
      },
      completeRestore: async () => {
        calls.push("completeRestore");
      },
      pendingRestore: () => undefined,
      recover: async () => {
        calls.push("recover");
        return undefined;
      },
      preview: () => {
        calls.push("preview");
        throw new Error("snapshot preview must not run");
      },
      runtimeBin: () => {
        calls.push("runtimeBin");
        throw new Error("snapshot runtimeBin must not run");
      },
    },
  });
  await assert.rejects(
    () => ctx.upgrade.restore("59ca7cee-0c06-4610-bc95-e86849247cef"),
    /Snapshot restore is not supported/,
  );
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(join(ctx.home, "profiles", "coding", "package.json"), "utf8"), before);
  assert.equal(ctx.stopped, false);
  assert.equal(ctx.drained, false);
});

test("upgrade copy/rm through the snapshot worker keeps heartbeat and the same commit result", async (t) => {
  const worker = requireWorker();
  const ctx = await upgradeHarness(t, worker);
  fillTree(join(ctx.home, "profiles", "coding", "payload"), FILE_COUNT);
  const pulse = await withHeartbeat(async () => {
    const result = await ctx.upgrade.upgrade("0.9.9");
    assert.equal(result.version, "0.9.9");
  });
  assert.equal(readFileSync(join(ctx.home, "profiles", "web", "cordis.patch.yml"), "utf8"), "web-bytes\n");
  assert.equal(JSON.parse(readFileSync(join(ctx.home, "profiles", "coding", "package.json"), "utf8")).dependencies[BASE], "0.2.0");
  assert.equal(existsSync(join(ctx.home, ".dsh-spaces-upgrade")), false);
  assert.equal(existsSync(join(ctx.home, "profiles", "coding", "payload", "b0", "f0.dat")), true);
  if (pulse.elapsed >= STALL_MS) {
    assert.ok(pulse.during > 0, `upgrade tree copy/rm blocked HTTP (${pulse.elapsed}ms, hits=${pulse.during})`);
  }
});

test("worker copy failure leaves live profiles untouched", async (t) => {
  const worker = requireWorker();
  const ctx = await upgradeHarness(t, worker);
  const outside = fakeDir(t, "dsh-copy-outside-");
  writeFileSync(join(outside, "secret.txt"), "nope\n");
  linkDir(outside, join(ctx.home, "profiles", "coding", "node_modules", "escaped"));
  const fakeSnap = {
    id: "59ca7cee-0c06-4610-bc95-e86849247cef",
    createdAt: new Date().toISOString(),
    reason: "upgrade",
    home: ctx.home,
    runtimeVersion: "0.1.1-rc.2",
    binRelative: "node_modules/@deepseek-ai/dsh/lib/bin.js",
    profiles: ["coding", "headless", "web"],
    size: 1,
    presence: {
      profiles: true,
      sessions: false,
      storages: false,
      hub: false,
      "settings.yaml": false,
      "cordis.patch.yml": false,
    },
  };
  ctx.upgrade = makeUpgrade(ctx, {
    workerFile: worker,
    snapshots: {
      create: async () => fakeSnap,
      restore: async () => {
        throw new Error("restore should not run");
      },
      completeRestore: () => undefined,
      pendingRestore: () => undefined,
      recover: () => undefined,
      preview: () => fakeSnap,
      runtimeBin: () => ctx.runtimes.current()!.bin,
    },
  });
  await assert.rejects(() => ctx.upgrade.upgrade("0.9.9"), /External link is not in snapshot scope/);
  assert.equal(JSON.parse(readFileSync(join(ctx.home, "profiles", "coding", "package.json"), "utf8")).dependencies[BASE], "0.1.1-rc.2");
});

test("upgrade recover is unsupported and leaves staged bytes and junction targets untouched", async (t) => {
  const worker = requireWorker();
  const ctx = await upgradeHarness(t, worker);
  const stage = join(ctx.home, ".dsh-spaces-upgrade");
  fillTree(stage, FILE_COUNT);
  await assert.rejects(() => ctx.upgrade.recover(), /Upgrade recovery is not supported/);
  assert.equal(existsSync(join(stage, "b0", "f0.dat")), true);

  rmChecked(stage);
  const outside = fakeDir(t, "dsh-outside-");
  writeFileSync(join(outside, "keep.txt"), "safe\n");
  linkDir(outside, stage);
  await assert.rejects(() => ctx.upgrade.recover(), /Upgrade recovery is not supported/);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "safe\n");
  assert.equal(existsSync(stage) && lstatSync(stage).isSymbolicLink(), true);
});

test("runtime leftover staging rm keeps the HTTP heartbeat and still installs", async () => {
  const root = fakeDirPath("dsh-runtime-io-");
  const leftover = join(root, `.tmp-dsh-0.1.1-rc.2-${process.pid}`);
  fillTree(leftover, FILE_COUNT);
  const runtime = new RuntimeStore({
    root,
    source: () => "official",
    legacy: () => undefined,
    run: mockInstallRun(),
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const pulse = await withHeartbeat(async () => {
    const installed = await runtime.install("0.1.1-rc.2");
    assert.equal(installed.version, "0.1.1-rc.2");
    assert.equal(existsSync(installed.bin), true);
  });
  assert.equal(existsSync(leftover), false);
  if (pulse.elapsed >= STALL_MS) {
    assert.ok(pulse.during > 0, `runtime staging rm blocked HTTP (${pulse.elapsed}ms, hits=${pulse.during})`);
  }
});

test("sync rename of a large published runtime tree stalls HTTP; install publish does not", async () => {
  const syncRoot = fakeDirPath("dsh-rename-sync-");
  const syncSrc = join(syncRoot, "src");
  const syncDest = join(syncRoot, "dest");
  fillTree(syncSrc, FILE_COUNT);
  const syncPulse = await withHeartbeat(() => {
    renameSync(syncSrc, syncDest);
  });

  const fixtureReady = deferred();
  const releaseInstall = deferred();
  let fixturePrepared = false;
  const root = fakeDirPath("dsh-rename-async-");
  const runtime = new RuntimeStore({
    root,
    source: () => "official",
    legacy: () => undefined,
    run: async (_command, args) => {
      if (args.includes("install")) {
        try {
          const spec = args.find((item) => item.startsWith("@deepseek-ai/dsh@"));
          assert.ok(spec);
          const version = spec.slice("@deepseek-ai/dsh@".length);
          const prefix = args[args.indexOf("--prefix") + 1];
          writeCandidate(prefix, version, version, version);
          fillTree(join(prefix, "bulk"), FILE_COUNT);
        } catch (err) {
          fixtureReady.reject(err);
          throw err;
        }
        fixturePrepared = true;
        fixtureReady.resolve();
        await releaseInstall.promise;
        return { code: 0, stdout: "added", stderr: "" };
      }
      if (args.includes("--version")) {
        const bin = args.find((item) => item.endsWith("bin.js")) ?? args[0];
        const pkg = join(bin, "..", "..", "package.json");
        const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
        return { code: 0, stdout: `dsh ${version}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const pendingInstall = runtime.install("0.1.1-rc.2");
  try {
    await Promise.race([
      fixtureReady.promise,
      pendingInstall.then(
        () => {
          if (!fixturePrepared) throw new Error("runtime.install finished before fixtureReady");
        },
        (err: unknown) => {
          fixtureReady.reject(err);
          throw err;
        },
      ),
    ]);
    const pulse = await withHeartbeat(async () => {
      releaseInstall.resolve();
      const installed = await pendingInstall;
      assert.equal(existsSync(join(installed.dir, "bulk", "b0", "f0.dat")), true);
    });
    if (syncPulse.elapsed >= STALL_MS) {
      assert.equal(syncPulse.during, 0, `sync renameSync must block the loop (${syncPulse.elapsed}ms, hits=${syncPulse.during})`);
    }
    if (pulse.elapsed >= STALL_MS) {
      assert.ok(pulse.during > 0, `async runtime publish rename blocked HTTP (${pulse.elapsed}ms, hits=${pulse.during})`);
    }
  } finally {
    releaseInstall.resolve();
    await pendingInstall.then(() => undefined, () => undefined);
  }
});

test("sync retargetTree stalls HTTP; worker retarget keeps the heartbeat and rewrites junctions", async () => {
  const worker = requireWorker();
  const syncRoot = fakeDirPath("dsh-retarget-sync-");
  fillTree(syncRoot, FILE_COUNT);
  const syncPulse = await withHeartbeat(() => {
    retargetTree(syncRoot, join(syncRoot, "old"), syncRoot);
  });

  const home = fakeDirPath("dsh-retarget-async-");
  const live = join(home, "profiles");
  const staged = join(home, "stage-profiles");
  mkdirSync(join(live, "coding", "node_modules"), { recursive: true });
  fillTree(join(live, "coding", "payload"), FILE_COUNT);
  const linked = join(live, "coding", "node_modules", "linked");
  linkDir(join(live, "coding", "payload"), linked);
  const pulse = await withHeartbeat(async () => {
    await runSnapshotWorker(worker, {
      home,
      operation: "retargetTree",
      dir: live,
      oldRoot: staged,
      newRoot: live,
    });
  });
  assert.equal(existsSync(join(live, "coding", "payload", "b0", "f0.dat")), true);
  if (syncPulse.elapsed >= STALL_MS) {
    assert.equal(syncPulse.during, 0, `sync retargetTree must block the loop (${syncPulse.elapsed}ms, hits=${syncPulse.during})`);
  }
  if (pulse.elapsed >= STALL_MS) {
    assert.ok(pulse.during > 0, `worker retargetTree blocked HTTP (${pulse.elapsed}ms, hits=${pulse.during})`);
  }
});

function requireWorker(): string {
  assert.ok(workerFile, "snapshot worker was not compiled");
  return workerFile;
}

async function compileWorker(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dsh-snap-worker-"));
  assertTempPath(dir);
  const outfile = join(dir, "snapshot-worker.mjs");
  const src = join(repoRoot, "src", "adapters/node", "snapshot-worker.ts");
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [src],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    banner: {
      js: 'import { createRequire as __spacesCreateRequire } from "node:module"; const require = __spacesCreateRequire(import.meta.url);',
    },
  });
  return outfile;
}

function snapshotCreateFixture(prefix: string): {
  home: string;
  root: string;
  store: SnapshotStore;
  runtime: SnapshotRuntime;
} {
  const home = fakeDirPath(prefix);
  const root = fakeDirPath(`${prefix}snaps-`);
  const runtimeDir = fakeDirPath(`${prefix}rt-`);
  mkdirSync(join(home, "profiles", "coding"), { recursive: true });
  writeFileSync(join(runtimeDir, "bin.js"), "cli\n");
  const runtime: SnapshotRuntime = { version: "1.0.0", root: runtimeDir, binRelative: "bin.js" };
  return { home, root, store: new SnapshotStore({ home, root }), runtime };
}

function pendingStageFixture(prefix: string): { home: string; root: string; store: SnapshotStore } {
  const home = fakeDirPath(prefix);
  const root = fakeDirPath(`${prefix}snaps-`);
  mkdirSync(join(home, "profiles"), { recursive: true });
  const store = new SnapshotStore({ home, root });
  writeFileSync(
    join(root, "pending-restore.json"),
    `${JSON.stringify({
      snapshotId: "59ca7cee-0c06-4610-bc95-e86849247cef",
      beforeRestoreId: "ae95e8a4-691a-4aeb-852b-876076372daa",
      runtimeVersion: "1.0.0",
      binRelative: "bin.js",
      startedAt: new Date().toISOString(),
    })}\n`,
  );
  fillTree(join(home, RESTORE_STAGE_DIR, "backup"), FILE_COUNT);
  return { home, root, store };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withHeartbeat(work: () => void | Promise<void>): Promise<{ during: number; elapsed: number }> {
  const { origin, close } = await listenLocal();
  let hits = 0;
  let polling = true;
  const poll = (async () => {
    while (polling) {
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
        if (response.ok) hits += 1;
      } catch {
        /* the probe itself must not fail the test */
      }
    }
  })();
  await delay(HEARTBEAT_MS * 2);
  const before = hits;
  const started = Date.now();
  try {
    await work();
    return { during: hits - before, elapsed: Date.now() - started };
  } finally {
    polling = false;
    await poll;
    await close();
  }
}

async function listenLocal(): Promise<{ origin: string; close: () => Promise<void> }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const port = await listenPort(server);
    if (!forbiddenPort(port)) {
      return {
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((resolveClose, reject) => {
            server.close((err) => (err ? reject(err) : resolveClose()));
          }),
      };
    }
    await closeServer(server);
  }
  throw new Error("could not bind a localhost probe port outside the reserved ranges");
}

function listenPort(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("probe server did not bind"));
        return;
      }
      resolvePort(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
  });
}

function forbiddenPort(port: number): boolean {
  return (port >= 3100 && port <= 3199) || (port >= 34000 && port <= 34999);
}

function fillTree(root: string, files: number): void {
  mkdirSync(root, { recursive: true });
  const buf = Buffer.alloc(FILE_BYTES, 7);
  for (let i = 0; i < files; i++) {
    const dir = join(root, `b${i % 20}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.dat`), buf);
  }
}

interface Harness {
  home: string;
  snapshots: SnapshotStore | SnapshotExecutor;
  runtimes: RuntimeStore;
  upgrade: CoordinatedUpgrade;
  drained: boolean;
  stopped: boolean;
}

async function upgradeHarness(t: { after: (fn: () => void) => void }, worker?: string): Promise<Harness> {
  const home = fakeDir(t, "dsh-home-");
  const snapRoot = fakeDir(t, "dsh-snaps-");
  const runtimeRoot = fakeDir(t, "dsh-runtime-");
  seedProfiles(home);
  const runtimes = new RuntimeStore({
    root: runtimeRoot,
    source: () => "official",
    legacy: () => undefined,
    run: mockInstallRun(),
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  await runtimes.install("0.1.1-rc.2");
  runtimes.select("0.1.1-rc.2");
  const snapshots = worker
    ? new SnapshotExecutor({ home, root: snapRoot, workerFile: worker })
    : new SnapshotStore({ home, root: snapRoot });
  const ctx: Harness = {
    home,
    snapshots,
    runtimes,
    upgrade: undefined as unknown as CoordinatedUpgrade,
    drained: false,
    stopped: false,
  };
  ctx.upgrade = makeUpgrade(ctx, worker ? { workerFile: worker } : {});
  return ctx;
}

function makeUpgrade(ctx: Harness, overrides: Partial<ConstructorParameters<typeof CoordinatedUpgrade>[0]> = {}) {
  return new CoordinatedUpgrade({
    home: ctx.home,
    profiles: () => ["web", "coding", "headless"],
    stopAll: async () => {
      ctx.stopped = true;
    },
    drainPlugins: async () => {
      ctx.drained = true;
    },
    snapshots: ctx.snapshots,
    runtimes: ctx.runtimes,
    runtimeDescriptor: () => descriptor(ctx.runtimes),
    runCli: async (_bin, stagedHome, args) => mockCli(stagedHome, args),
    smokeWeb: async ({ home }) => {
      assert.ok(home.includes(".dsh-spaces-upgrade"));
    },
    ...overrides,
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

async function mockCli(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (args.includes("--dump-config")) {
    const name = args[args.indexOf("--profile") + 1];
    if (name === "notes") {
      return {
        code: 0,
        stdout:
          "- id: session-persistence-jsonl\n  config:\n    root: sessions\n- id: storage-json\n  config:\n    root: storages\n",
        stderr: "",
      };
    }
    if (name === "web") return { code: 0, stdout: "- id: dsh-web-app\n", stderr: "" };
    return { code: 0, stdout: isolationDump(name), stderr: "" };
  }
  if (args.includes("plugin") && args.includes("add")) {
    const name = args[args.indexOf("--profile") + 1];
    const spec = args.at(-1) ?? "";
    const at = spec.lastIndexOf("@");
    const pkg = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const dir = join(home, "profiles", name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = { ...manifest.dependencies, [pkg]: version };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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
      if (version === "0.1.1-rc.2") writeCandidate(prefix, version, version, version);
      else writeCandidate(prefix, version, "0.2.0", "0.2.1");
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

function seedProfiles(home: string): void {
  writeProfile(home, "web", {
    bundles: [BASE, WEB],
    dependencies: { [BASE]: "0.1.1-rc.2", [WEB]: "0.1.1-rc.2" },
    patch: "web-bytes\n",
  });
  writeProfile(home, "coding", {
    bundles: [BASE, WEB, "dsh-outline"],
    dependencies: { [BASE]: "0.1.1-rc.2", [WEB]: "0.1.1-rc.2", "dsh-outline": "1.2.3" },
    patch: isolationPatch("coding"),
  });
  writeProfile(home, "headless", {
    bundles: [BASE],
    dependencies: { [BASE]: "0.1.1-rc.2" },
  });
}

function writeProfile(
  home: string,
  name: string,
  opts: { bundles: string[]; dependencies: Record<string, string>; patch?: string },
): void {
  const dir = join(home, "profiles", name);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ dependencies: opts.dependencies, dsh: { profile: { bundles: opts.bundles } } }, null, 2)}\n`,
  );
  if (opts.patch !== undefined) writeFileSync(join(dir, "cordis.patch.yml"), opts.patch);
}

function writeCandidate(prefix: string, cli: string, base: string, web: string): string {
  const pkg = join(prefix, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "console.log('dsh')\n");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({
      name: "@deepseek-ai/dsh",
      version: cli,
      dependencies: { [BASE]: `^${base}`, [WEB]: `^${web}` },
    }, null, 2)}\n`,
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
  return bin;
}

function isolationPatch(name: string): string {
  return `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${name}/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${name}/storages')\n`;
}

function isolationDump(name: string): string {
  return isolationPatch(name);
}

function linkDir(target: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (process.platform === "win32") {
    symlinkSync(resolve(target), dest, "junction");
    return;
  }
  symlinkSync(relative(dirname(dest), target) || ".", dest);
}

function fakeDir(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = fakeDirPath(prefix);
  t.after(() => rmChecked(dir));
  return dir;
}

function fakeDirPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function assertTempPath(dir: string): string {
  const resolved = resolve(dir);
  const root = resolve(tmpdir());
  if (resolved.toLowerCase() === root.toLowerCase()) {
    throw new Error("refusing to delete tmpdir");
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  const a = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const b = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  if (!a.startsWith(b)) {
    throw new Error(`refusing to touch path outside tmpdir: ${resolved}`);
  }
  return resolved;
}

function rmChecked(dir: string): void {
  const path = assertTempPath(dir);
  if (!existsSync(path)) return;
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    const st = lstatSync(current);
    if (st.isSymbolicLink() || st.isFile()) {
      unlinkSync(current);
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(current)) walk(join(current, name));
      rmdirSync(current);
    }
  };
  try {
    walk(path);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}
