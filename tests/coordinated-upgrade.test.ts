import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { CoordinatedUpgrade, resolveOfficialVersions } from "../src/main/coordinated-upgrade.ts";
import { RuntimeStore, type RunProcessFn } from "../src/main/runtime-store.ts";
import { SnapshotStore } from "../src/main/snapshot-store.ts";
import type { SnapshotRuntime } from "../src/shared/snapshots.ts";

const BASE = "@deepseek-ai/dsh-base";
const WEB = "@deepseek-ai/dsh-web-app";

test("preview lists every profile including hidden and does not guess CLI version for official plugins", async (t) => {
  const ctx = await harness(t);
  await ctx.runtimes.install("0.9.9");
  const preview = ctx.upgrade.preview("0.9.9");
  assert.deepEqual(
    preview.profiles.map((row) => row.name),
    ["web", "coding", "headless"],
  );
  assert.equal(preview.officialTargets?.base, "0.2.0");
  assert.equal(preview.officialTargets?.web, "0.2.1");
  const coding = preview.profiles.find((row) => row.name === "coding");
  assert.ok(coding?.thirdParty.includes("dsh-outline"));
  assert.equal(coding?.official.find((row) => row.name === BASE)?.to, "0.2.0");
  assert.notEqual(preview.officialTargets?.base, "0.9.9");
});

test("upgrade stages on an isolated home, rewrites junctions, then commits official versions only", async (t) => {
  const ctx = await harness(t);
  mkdirSync(join(ctx.home, "hub", "plugins"), { recursive: true });
  writeFileSync(join(ctx.home, "hub", "plugins", "owned.tgz"), "owned archive bytes");
  const modules = join(ctx.home, "profiles", "coding", "node_modules");
  mkdirSync(join(modules, ".pnpm"), { recursive: true });
  writeFileSync(join(modules, ".modules.yaml"), JSON.stringify({
    virtualStoreDir: join(modules, ".pnpm"), storeDir: "leave-the-shared-store-alone", layoutVersion: 5,
  }));
  const phases: string[] = [];
  ctx.upgrade = makeUpgrade(ctx, { onProgress: (progress) => {
    phases.push(progress.phase);
    if (progress.phase === "verify") assert.equal(readFileSync(join(ctx.home, ".dsh-spaces-upgrade", "home", "hub", "plugins", "owned.tgz"), "utf8"), "owned archive bytes");
    if (progress.phase === "verify") {
      const staged = join(ctx.home, ".dsh-spaces-upgrade", "home", "profiles", "coding", "node_modules");
      const metadata = JSON.parse(readFileSync(join(staged, ".modules.yaml"), "utf8"));
      assert.equal(metadata.virtualStoreDir, join(staged, ".pnpm"));
      assert.equal(metadata.storeDir, "leave-the-shared-store-alone");
    }
  } });
  const result = await ctx.upgrade.upgrade("0.9.9");
  assert.equal(result.version, "0.9.9");
  assert.equal(result.official.base, "0.2.0");
  assert.equal(result.official.web, "0.2.1");
  assert.equal(ctx.drained, true);
  assert.equal(ctx.stopped, true);
  assert.equal(ctx.runtimes.current()?.version, "0.9.9");
  assert.equal(JSON.parse(readFileSync(join(modules, ".modules.yaml"), "utf8")).virtualStoreDir, join(modules, ".pnpm"));
  assert.equal(readFileSync(join(ctx.home, "profiles", "web", "cordis.patch.yml"), "utf8"), "web-bytes\n");
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.2.0");
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[WEB], "0.2.1");
  assert.equal(readManifest(ctx.home, "coding").dependencies?.["dsh-outline"], "1.2.3");
  assert.equal(readManifest(ctx.home, "headless").dependencies?.[BASE], "0.2.0");
  assert.equal(readManifest(ctx.home, "headless").dependencies?.[WEB], undefined);
  assert.equal(readFileSync(join(ctx.home, ".credentials.yaml"), "utf8"), "secret-key\n");
  assert.equal(readFileSync(join(ctx.home, ".anonymous-user-id"), "utf8"), "machine-1\n");
  assert.ok(ctx.pluginAdds.every((spec) => !spec.includes("@0.9.9")));
  assert.ok(ctx.pluginAdds.includes(`${BASE}@0.2.0`));
  assert.ok(ctx.pluginAdds.includes(`${WEB}@0.2.1`));
  assert.ok(ctx.dumps.includes("coding"));
  assert.ok(ctx.dumps.includes("web"));
  assert.ok(ctx.dumps.includes("headless"));
  const linked = resolveLink(join(ctx.home, "profiles", "coding", "node_modules", "linked"));
  assert.ok(isInsidePath(join(ctx.home, "profiles"), linked), linked);
  assert.equal(existsSync(join(ctx.home, ".dsh-spaces-upgrade")), false);
  assert.ok(phases.includes("stage"));
  assert.ok(phases.includes("smoke"));
  assert.ok(phases.includes("commit"));
  assert.equal(ctx.smokeHomes.some((home) => home.includes(".dsh-spaces-upgrade")), true);
  assert.equal(ctx.snapshots.list().some((row) => row.reason === "upgrade"), true);
});

test("failure before commit leaves live profiles untouched and kills registered candidate processes", async (t) => {
  const ctx = await harness(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  });
  ctx.upgrade = makeUpgrade(ctx, {
    smokeWeb: async ({ register }) => {
      register(child);
      throw new Error("smoke failed");
    },
  });
  await assert.rejects(() => ctx.upgrade.upgrade("0.9.9"), /smoke failed/);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.1.1-rc.2");
  assert.equal(ctx.runtimes.current()?.version, "0.1.1-rc.2");
  assert.equal(ctx.restores, 0);
});

test("workbench with web plugin fails dump when isolation roots are missing", async (t) => {
  const ctx = await harness(t);
  writeProfile(ctx.home, "notes", {
    bundles: [BASE, WEB],
    dependencies: { [BASE]: "0.1.1-rc.2", [WEB]: "0.1.1-rc.2" },
    patch: "- id: unrelated\n",
  });
  ctx.upgrade = makeUpgrade(ctx, {}, () => ["web", "coding", "headless", "notes"]);
  await assert.rejects(() => ctx.upgrade.upgrade("0.9.9"), /dumpRootMismatch|session-persistence-jsonl|storage-json/);
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.1.1-rc.2");
  assert.equal(ctx.runtimes.current()?.version, "0.1.1-rc.2");
  assert.ok(ctx.dumps.includes("notes"));
  assert.ok(ctx.dumps.includes("web"));
});

test("commit rename and retarget failures restore old profiles and snapshot runtime", async (t) => {
  for (const op of ["commit:backup", "commit:swap", "commit:retarget"]) {
    const ctx = await harness(t);
    ctx.upgrade = makeUpgrade(ctx, {
      inject: (hook) => {
        if (hook === op) throw new Error(`fail ${op}`);
      },
    });
    await assert.rejects(() => ctx.upgrade.upgrade("0.9.9"), new RegExp(`fail ${op}`));
    assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.1.1-rc.2");
    assert.equal(readFileSync(join(ctx.home, "profiles", "web", "cordis.patch.yml"), "utf8"), "web-bytes\n");
    assert.equal(ctx.runtimes.current()?.version, "0.1.1-rc.2");
    assert.equal(ctx.snapshots.pendingRestore(), undefined);
    assert.ok(ctx.snapshots.list().some((row) => row.reason === "upgrade"));
  }
});

test("kill failure keeps stage and journal and does not restore or delete live profiles", async (t) => {
  const ctx = await harness(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  });
  ctx.upgrade = makeUpgrade(ctx, {
    smokeWeb: async ({ register }) => {
      register(child);
      throw new Error("smoke failed");
    },
    kill: async () => {
      throw new Error("busy");
    },
  });
  await assert.rejects(() => ctx.upgrade.upgrade("0.9.9"), /busy/);
  assert.equal(child.exitCode === null && child.signalCode === null, true);
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.1.1-rc.2");
  assert.equal(existsSync(join(ctx.home, ".dsh-spaces-upgrade", "journal.json")), true);
  assert.equal(ctx.runtimes.current()?.version, "0.1.1-rc.2");
});

test("recover and restore are not supported", async (t) => {
  const ctx = await harness(t);
  await assert.rejects(() => ctx.upgrade.recover(), /not supported/);
  await assert.rejects(() => ctx.upgrade.restore("snap-1"), /not supported/);
});

test.skip("recover rebuilds the snapshot runtime after an interrupted commit and allows a later upgrade", async (t) => {
  const ctx = await harness(t);
  const snap = ctx.snapshots.create(descriptor(ctx.runtimes), "upgrade");
  const stage = join(ctx.home, ".dsh-spaces-upgrade");
  mkdirSync(stage, { recursive: true });
  writeFileSync(
    join(stage, "journal.json"),
    `${JSON.stringify({ phase: "committing", snapshotId: snap.id, version: "0.9.9", startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  renameSync(join(ctx.home, "profiles"), join(stage, "backup-profiles"));
  mkdirSync(join(ctx.home, "profiles", "web"), { recursive: true });
  writeFileSync(join(ctx.home, "profiles", "web", "cordis.patch.yml"), "half-committed\n");
  const recovered = await ctx.upgrade.recover();
  assert.equal(recovered.upgradeRolledBack, true);
  assert.equal(readFileSync(join(ctx.home, "profiles", "web", "cordis.patch.yml"), "utf8"), "web-bytes\n");
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.1.1-rc.2");
  assert.equal(ctx.runtimes.current()?.version, "0.1.1-rc.2");
  assert.equal(ctx.runtimes.current()?.bin, ctx.snapshots.runtimeBin(snap.id));
  assert.equal(existsSync(stage), false);
  const result = await ctx.upgrade.upgrade("0.9.9");
  assert.equal(result.version, "0.9.9");
});

test("discarding a junctioned stage unlinks the junction without deleting the target tree", async (t) => {
  const ctx = await harness(t);
  const outside = fakeDir(t, "dsh-outside-");
  writeFileSync(join(outside, "keep.txt"), "safe\n");
  const stage = join(ctx.home, ".dsh-spaces-upgrade");
  linkDir(outside, stage);
  await assert.rejects(() => ctx.upgrade.recover(), /not supported/);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "safe\n");
  assert.equal(lstatSync(stage).isSymbolicLink(), true);
});

test.skip("successful restore selects the snapshot runtime and completes pending state without network install", async (t) => {
  const ctx = await harness(t);
  await ctx.upgrade.upgrade("0.9.9");
  const snap = ctx.snapshots.list().find((row) => row.reason === "upgrade");
  assert.ok(snap);
  writeFileSync(join(ctx.home, "profiles", "coding", "cordis.patch.yml"), "after-upgrade\n");
  const installsBefore = ctx.installs.slice();
  const result = await ctx.upgrade.restore(snap.id);
  assert.equal(result.restored.id, snap.id);
  assert.equal(ctx.snapshots.pendingRestore(), undefined);
  assert.equal(readFileSync(join(ctx.home, "profiles", "coding", "cordis.patch.yml"), "utf8"), isolationPatch("coding"));
  assert.equal(ctx.runtimes.current()?.version, snap.runtimeVersion);
  assert.equal(ctx.runtimes.current()?.bin, ctx.snapshots.runtimeBin(snap.id));
  assert.deepEqual(ctx.installs, installsBefore);
});

test("resolveOfficialVersions uses realpath and createRequire, and refuses range-only manifests", (t) => {
  const root = fakeDir(t, "dsh-cli-");
  const bin = writeCandidate(root, "0.9.9", "0.2.0", "0.2.1");
  const linked = join(root, "alias-bin.js");
  try {
    symlinkSync(resolve(bin), linked, "file");
    const official = resolveOfficialVersions(linked);
    assert.equal(official.base, "0.2.0");
    assert.equal(official.web, "0.2.1");
  } catch (err) {
    if (process.platform !== "win32") throw err;
    const official = resolveOfficialVersions(bin);
    assert.equal(official.base, "0.2.0");
    assert.equal(official.web, "0.2.1");
  }

  const rangeOnly = fakeDir(t, "dsh-cli-range-");
  const pkg = join(rangeOnly, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  const rangeBin = join(pkg, "lib", "bin.js");
  writeFileSync(rangeBin, "console.log('dsh')\n");
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify({
      name: "@deepseek-ai/dsh",
      version: "0.9.9",
      dependencies: { [BASE]: "^0.2.0", [WEB]: "^0.2.1" },
    }, null, 2)}\n`,
  );
  assert.throws(() => resolveOfficialVersions(rangeBin), /does not resolve installed/);
});

test.skip("upgrade accepts generated fallback links and preserves global patches and committed profiles on recovery", async (t) => {
  const ctx = await harness(t);
  const current = descriptor(ctx.runtimes);
  const shared = join(ctx.home, "profiles", "node_modules");
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(current.root, "shared-sdk"));
  writeFileSync(join(current.root, "shared-sdk", "index.js"), "sdk");
  symlinkSync(join(current.root, "shared-sdk"), join(shared, "shared-sdk"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(ctx.home, "cordis.patch.yml"), "# global configuration\n");
  ctx.upgrade = makeUpgrade(ctx, { runCli: async (_bin, stagedHome, args) => {
    assert.equal(readFileSync(join(stagedHome, "cordis.patch.yml"), "utf8"), "# global configuration\n");
    assert.equal(existsSync(join(stagedHome, "profiles", "node_modules", "shared-sdk")), false);
    return mockCli(ctx, stagedHome, args);
  } });
  await ctx.upgrade.upgrade("0.9.9");
  await ctx.upgrade.recover();
  assert.equal(ctx.runtimes.current()?.version, "0.9.9");
  assert.equal(readManifest(ctx.home, "coding").dependencies?.[BASE], "0.2.0");
});

test.skip("restore recovery consumes only the requested receipt and leaves a later runtime selection alone", async t => {
  const ctx = await harness(t);
  const snapshotRoot = fakeDir(t, "dsh-receipt-");
  ctx.snapshots = new SnapshotStore({ home: ctx.home, root: snapshotRoot,
    inject: op => { if (op === "restore:swap") throw new Error("interrupted before swap"); } });
  const snapshot = ctx.snapshots.create(descriptor(ctx.runtimes));
  const marker = join(ctx.home, "settings.yaml");
  writeFileSync(marker, "before-restore data\n");
  const planId = "12345678-1234-1234-1234-123456789abc";
  await assert.rejects(async () => ctx.snapshots.restore(snapshot.id, descriptor(ctx.runtimes), { planId }), /interrupted/);
  ctx.snapshots = new SnapshotStore({ home: ctx.home, root: snapshotRoot });
  ctx.upgrade = makeUpgrade(ctx);
  const recovered = await ctx.upgrade.recover({ receiptPlanId: planId });
  assert.equal(recovered.restoreRolledBack, true);
  assert.equal(recovered.restoreReceipt?.planId, planId);
  assert.equal(readFileSync(marker, "utf8"), "before-restore data\n");
  assert.deepEqual(await ctx.upgrade.recover({ receiptPlanId: "22345678-1234-1234-1234-123456789abc" }), {});
  await ctx.runtimes.install("0.9.9");
  ctx.runtimes.select("0.9.9");
  assert.deepEqual(await ctx.upgrade.recover(), {});
  assert.equal(ctx.runtimes.current()?.version, "0.9.9");
});

test.skip("successful restore persists the exact plan for recovery after job persistence is interrupted", async t => {
  const ctx = await harness(t);
  const snapshot = ctx.snapshots.create(descriptor(ctx.runtimes));
  const planId = "32345678-1234-1234-1234-123456789abc";
  await ctx.upgrade.restore(snapshot.id, planId);
  assert.equal(ctx.snapshots.pendingRestore(), undefined);
  const recovered = await ctx.upgrade.recover({ receiptPlanId: planId });
  assert.equal(recovered.restoreCompleted, true);
  assert.equal(recovered.restoreReceipt?.planId, planId);
  assert.equal(recovered.restoreReceipt?.snapshotId, snapshot.id);
});

interface Harness {
  home: string;
  runtimeRoot: string;
  snapshots: SnapshotStore;
  runtimes: RuntimeStore;
  upgrade: CoordinatedUpgrade;
  drained: boolean;
  stopped: boolean;
  pluginAdds: string[];
  dumps: string[];
  smokeHomes: string[];
  restores: number;
  installs: string[];
}

async function harness(t: { after: (fn: () => void) => void }): Promise<Harness> {
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
  const snapshots = new SnapshotStore({ home, root: snapRoot });
  const ctx: Harness = {
    home,
    runtimeRoot,
    snapshots,
    runtimes,
    upgrade: undefined as unknown as CoordinatedUpgrade,
    drained: false,
    stopped: false,
    pluginAdds: [],
    dumps: [],
    smokeHomes: [],
    restores: 0,
    installs: [],
  };
  const install = runtimes.install.bind(runtimes);
  runtimes.install = async (version: string) => {
    ctx.installs.push(version);
    return install(version);
  };
  ctx.upgrade = makeUpgrade(ctx);
  return ctx;
}

function makeUpgrade(
  ctx: Harness,
  overrides: Partial<ConstructorParameters<typeof CoordinatedUpgrade>[0]> = {},
  profiles?: () => string[],
) {
  return new CoordinatedUpgrade({
    home: ctx.home,
    profiles: profiles ?? (() => ["web", "coding", "headless"]),
    stopAll: async () => {
      ctx.stopped = true;
    },
    drainPlugins: async () => {
      ctx.drained = true;
    },
    snapshots: ctx.snapshots,
    runtimes: ctx.runtimes,
    runtimeDescriptor: () => descriptor(ctx.runtimes),
    runCli: async (_bin, home, args) => mockCli(ctx, home, args),
    smokeWeb: async ({ home }) => {
      ctx.smokeHomes.push(home);
      assert.ok(home.includes(".dsh-spaces-upgrade"));
      assert.equal(existsSync(join(ctx.home, "profiles", "coding", "package.json")), true);
      const staged = readManifest(home, "coding");
      assert.equal(staged.dependencies?.[BASE], "0.2.0");
      const live = readManifest(ctx.home, "coding");
      assert.equal(live.dependencies?.[BASE], "0.1.1-rc.2");
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

async function mockCli(
  ctx: Harness,
  home: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (args.includes("--dump-config")) {
    const name = args[args.indexOf("--profile") + 1];
    ctx.dumps.push(name);
    if (name === "coding") {
      return { code: 0, stdout: isolationDump("coding"), stderr: "" };
    }
    if (name === "web") {
      return { code: 0, stdout: "- id: dsh-web-app\n", stderr: "" };
    }
    if (name === "notes") {
      return {
        code: 0,
        stdout:
          "- id: session-persistence-jsonl\n  config:\n    root: sessions\n- id: storage-json\n  config:\n    root: storages\n",
        stderr: "",
      };
    }
    return { code: 0, stdout: "- id: other\n", stderr: "" };
  }
  if (args.includes("plugin") && args.includes("add")) {
    const name = args[args.indexOf("--profile") + 1];
    const spec = args.at(-1) ?? "";
    ctx.pluginAdds.push(spec);
    const at = spec.lastIndexOf("@");
    const pkg = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const dir = join(home, "profiles", name);
    const manifest = readManifest(home, name);
    manifest.dependencies = { ...manifest.dependencies, [pkg]: version };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    assert.ok(home.includes(".dsh-spaces-upgrade"), "plugin add must target the staged home");
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
  mkdirSync(join(home, "profiles", "coding", "node_modules", ".pnpm"), { recursive: true });
  mkdirSync(join(home, "profiles", "coding", "node_modules", "dsh-outline"), { recursive: true });
  writeFileSync(join(home, "profiles", "coding", "node_modules", ".pnpm", "store.txt"), "dep\n");
  writeFileSync(
    join(home, "profiles", "coding", "node_modules", "dsh-outline", "package.json"),
    `${JSON.stringify({ name: "dsh-outline", version: "1.2.3" }, null, 2)}\n`,
  );
  linkDir(
    join(home, "profiles", "coding", "node_modules", ".pnpm"),
    join(home, "profiles", "coding", "node_modules", "linked"),
  );
  writeProfile(home, "headless", {
    bundles: [BASE],
    dependencies: { [BASE]: "0.1.1-rc.2" },
  });
  writeFileSync(join(home, ".credentials.yaml"), "secret-key\n");
  writeFileSync(join(home, ".anonymous-user-id"), "machine-1\n");
  writeFileSync(join(home, "settings.yaml"), "settings\n");
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
    `${JSON.stringify(
      {
        name: "@deepseek-ai/dsh",
        version: cli,
        dependencies: { [BASE]: `^${base}`, [WEB]: `^${web}` },
      },
      null,
      2,
    )}\n`,
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

function readManifest(home: string, name: string): {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
} {
  return JSON.parse(readFileSync(join(home, "profiles", name, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
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

function resolveLink(path: string): string {
  const raw = String(readlinkSync(path));
  return isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
}

function isInsidePath(root: string, target: string): boolean {
  const r = resolve(root).toLowerCase();
  const t = resolve(target).toLowerCase();
  return t === r || t.startsWith(`${r}\\`) || t.startsWith(`${r}/`);
}

function fakeDir(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmTree(dir));
  return dir;
}

function rmTree(path: string): void {
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
