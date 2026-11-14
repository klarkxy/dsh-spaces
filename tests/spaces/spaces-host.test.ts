import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { RemoteError, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import {
  CLI_OUTPUT_CAP,
  COMPATIBLE_DSH_CLI_VERSION,
  MUTATION_JOURNAL_NAME,
  NodeSpacesService,
  PUBLIC_ERROR,
  SpacesPublicError,
  spawnBoundCli,
  type BoundCliResult,
  type SpacesLoaderView,
} from "../../src/adapters/node/products/spaces-service";
import { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock";
import { writeRegisteredSpace } from "../fixtures/space.ts";
import { SpacesRemote } from "../../packages/plugin/src/host/spaces-service";
import { SPACES_REMOTE_CODES, WORKBENCH_REMOTE_CODES } from "../../packages/plugin/src/host/remote-errors";
import { TYPERT, workbenchCommandSchema } from "../../packages/plugin/src/typert.host";
import { TYPERT_REMOTE } from "../../packages/plugin/src/typert.remote-client";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeCli(root: string, version = COMPATIBLE_DSH_CLI_VERSION): string {
  const pkg = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

function writeWeb(home: string): void {
  const dir = join(home, "profiles", "web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: "dsh-profile-web",
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    })}\n`,
  );
  writeFileSync(join(dir, "cordis.patch.yml"), "[]\n");
}

function writeWorkbench(home: string, name: string): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: `dsh-profile-${name}`,
      dependencies: { "@deepseek-ai/dsh-web-app": "0.1.5-rc.2" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    })}\n`,
  );
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${name}/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${name}/storages')\n`,
  );
}

function isolatedDump(name: string): string {
  return `- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('hub/${name}/sessions')\n- id: storage-json\n  config:\n    root: !!js dshHomePath('hub/${name}/storages')\n`;
}

function defaultLoader(): SpacesLoaderView {
  return {
    entries() {
      return [
        { options: { id: "session-persistence-jsonl", config: { root: "!!js dshHomePath('sessions')" } } },
        { options: { id: "storage-json", config: { root: "!!js dshHomePath('storages')" } } },
      ];
    },
  };
}

function control(home: string, extra: Partial<ConstructorParameters<typeof NodeSpacesService>[0]> = {}) {
  const bin = extra.argv?.[1] ?? writeCli(home);
  return new NodeSpacesService({
    home,
    env: { ...process.env, DSH_HOME: home },
    argv: extra.argv ?? [process.execPath, bin, "--profile", "web"],
    baseUrl: extra.baseUrl ?? `${pathToFileURL(join(home, "profiles", "web")).href}/`,
    loader: extra.loader ?? defaultLoader(),
    ...extra,
  });
}

test("a CLI that cannot be bound stays unknown-readonly and cannot mutate", async () => {
  const home = tempDir("dsh-spaces-host-ver-");
  writeWeb(home);
  const bin = writeCli(home, "latest");
  const spaces = control(home, { argv: [process.execPath, bin, "--profile", "web"] });
  const overview = await spaces.overview();
  assert.equal(overview.capabilities.mode, "unknown-readonly");
  assert.equal(overview.capabilities.canCreate, false);
  await assert.rejects(() => spaces.create({ name: "notes" }), (error: unknown) => {
    assert.ok(error instanceof SpacesPublicError);
    assert.equal(error.code, "spaces/read-only");
    return true;
  });
});

test("invalid filesystem names are rejected before a creation journal is written", async () => {
  const home = tempDir("dsh-spaces-host-bad-name-");
  writeWeb(home);
  const spaces = control(home);
  const names = process.platform === "win32" ? ["notes\n", "con", "com1", "nul"] : ["notes\n"];
  for (const name of names) await assert.rejects(spaces.create({ name }), (error: unknown) => error instanceof SpacesPublicError && error.code === "spaces/invalid-input");
  assert.equal((await spaces.overview()).capabilities.canCreate, true);
});

test("overview does not auto-unlock; doctor owns unlockDead", async () => {
  const home = tempDir("dsh-spaces-host-unlock-");
  writeWeb(home);
  const inner = new HomeOperationLock(home);
  let unlocked = 0;
  const spaces = control(home, {
    lock: {
      run: (label, action) => inner.run(label, action),
      inspect: () => inner.inspect(),
      unlockDead: () => {
        unlocked += 1;
        return inner.unlockDead();
      },
    },
  });
  await spaces.overview();
  await spaces.detail("web");
  assert.equal(unlocked, 0);
});

test("create uses a real HomeOperationLock and is not denied by its own lock", async () => {
  const home = tempDir("dsh-spaces-host-create-");
  writeWeb(home);
  const calls: string[][] = [];
  const spaces = control(home, {
    runCli: async (args) => {
      calls.push([...args]);
      const name = args[args.indexOf("--profile") + 1];
      if (args.includes("--from-default-profile")) writeWorkbench(home, name);
      return { code: 0, stdout: isolatedDump(name), stderr: "" };
    },
  });
  const created = await spaces.create({ name: "notes", displayName: "Notes" });
  assert.equal(created.id, "space-notes");
  assert.equal(created.status, "unknown");
  assert.equal(created.isHost, false);
  assert.deepEqual(calls[0], ["--profile", "space-notes", "--from-default-profile", "web", "--dump-config"]);
  const overview = await spaces.overview();
  assert.equal(overview.capabilities.mode, "verified-full");
  assert.equal(overview.capabilities.canCreate, true);
  assert.equal(overview.spaces.find((row) => row.id === "web")?.status, "running");
  assert.equal(overview.spaces.find((row) => row.id === "space-notes")?.status, "unknown");
});

test("external overview stays busy while a real lock is held", async () => {
  const home = tempDir("dsh-spaces-host-busy-");
  writeWeb(home);
  const lock = new HomeOperationLock(home);
  const spaces = control(home, { lock });
  await lock.run("foreign", async () => {
    const overview = await spaces.overview();
    assert.equal(overview.capabilities.canCreate, false);
    assert.ok(overview.capabilities.reasons.includes("A home operation lock is already held."));
    assert.notEqual(overview.capabilities.mode, "verified-full");
  });
});

test("an observer of the same control instance does not inherit an active mutation's authority", async () => {
  const home = tempDir("dsh-spaces-host-observer-");
  writeWeb(home); writeRegisteredSpace(home, "space-notes");
  let resolveDump!: (result: BoundCliResult) => void;
  let entered!: () => void;
  let calls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const spaces = control(home, { runCli: async () => {
    calls += 1;
    if (calls === 1) {
      writeWorkbench(home, "space-x");
      entered();
      return new Promise<BoundCliResult>(resolve => { resolveDump = resolve; });
    }
    return { code: 0, stdout: isolatedDump("space-x"), stderr: "" };
  } });
  const creating = spaces.create({ name: "x" });
  await ready;
  assert.equal((await spaces.overview()).capabilities.canCreate, false);
  resolveDump({ code: 0, stdout: "", stderr: "" });
  assert.equal((await creating).id, "space-x");
  assert.equal((await spaces.overview()).capabilities.canCreate, true);
});

test("loader without live roots cannot enable create", async () => {
  const home = tempDir("dsh-spaces-host-loader-");
  writeWeb(home);
  const spaces = control(home, { loader: { entries: () => [] } });
  const overview = await spaces.overview();
  assert.equal(overview.capabilities.canCreate, false);
  assert.equal(overview.capabilities.mode, "verified-limited");
});

test("a parseable registry with malformed metadata is recovery-only", async () => {
  const home = tempDir("dsh-spaces-host-registry-shape-");
  writeWeb(home); mkdirSync(join(home, "hub"));
  writeFileSync(join(home, "hub", "spaces.json"), JSON.stringify({ version: 1, order: [], meta: { web: { displayName: 17, order: 0 } } }));
  const spaces = control(home);
  assert.equal((await spaces.overview()).capabilities.mode, "recovery-only");
  await assert.rejects(spaces.create({ name: "notes" }));
});

test("corrupt registry and blocked journal are recovery-only", async () => {
  const home = tempDir("dsh-spaces-host-recovery-");
  writeWeb(home);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(join(home, "hub", "spaces.json"), "{\"version\":2}\n");
  const spaces = control(home);
  const overview = await spaces.overview();
  assert.equal(overview.capabilities.mode, "recovery-only");
  assert.equal(overview.capabilities.canCreate, false);

  const home2 = tempDir("dsh-spaces-host-journal-");
  writeWeb(home2);
  mkdirSync(join(home2, MUTATION_JOURNAL_NAME));
  const blocked = await control(home2).overview();
  assert.equal(blocked.capabilities.mode, "recovery-only");
});

test("identity uses ctx.baseUrl, not loader.config.baseUrl", async () => {
  const home = tempDir("dsh-spaces-host-base-");
  writeWeb(home);
  writeWorkbench(home, "coding");
  const webUrl = `${pathToFileURL(join(home, "profiles", "web")).href}/`;
  const codingUrl = `${pathToFileURL(join(home, "profiles", "coding")).href}/`;
  const confirmed = await control(home, {
    baseUrl: webUrl,
    loader: { config: { baseUrl: codingUrl }, entries: defaultLoader().entries },
  }).overview();
  assert.equal(confirmed.capabilities.hostSpaceId, "web");
  assert.equal(confirmed.capabilities.mode, "verified-full");

  const denied = await control(home, {
    baseUrl: codingUrl,
    loader: { config: { baseUrl: webUrl }, entries: defaultLoader().entries },
  }).overview();
  assert.equal(denied.capabilities.hostSpaceId, null);
  assert.equal(denied.capabilities.mode, "unknown-readonly");
});

test("escaped profile links and host aliases are not listed", async () => {
  const home = tempDir("dsh-spaces-host-link-");
  writeWeb(home);
  const outside = tempDir("dsh-spaces-host-outside-");
  writeFileSync(join(outside, "secret.json"), "{\"token\":\"nope\"}\n");
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(outside, join(home, "profiles", "leaked"), type);
  symlinkSync(join(home, "profiles", "web"), join(home, "profiles", "alias"), type);
  const overview = await control(home).overview();
  const ids = overview.spaces.map((row) => row.id);
  assert.deepEqual(ids, ["web"]);
  assert.ok(!JSON.stringify(overview).includes("secret"));
  assert.ok(!JSON.stringify(overview).includes(outside));
});

test("redirected profiles root is recovery-only and blocks create", async () => {
  const home = tempDir("dsh-spaces-host-redir-");
  const realProfiles = tempDir("dsh-spaces-host-redir-profiles-");
  mkdirSync(join(realProfiles, "web"), { recursive: true });
  writeFileSync(
    join(realProfiles, "web", "package.json"),
    `${JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } } })}\n`,
  );
  symlinkSync(realProfiles, join(home, "profiles"), process.platform === "win32" ? "junction" : "dir");
  const spaces = control(home, { baseUrl: `${pathToFileURL(join(realProfiles, "web")).href}/` });
  const overview = await spaces.overview();
  assert.equal(overview.capabilities.mode, "recovery-only");
  await assert.rejects(() => spaces.create({ name: "notes" }), (error: unknown) => {
    assert.ok(error instanceof SpacesPublicError);
    assert.equal(error.code, "spaces/unavailable");
    return true;
  });
});

test("snapshots require matching home, space membership, and ISO createdAt", async () => {
  const home = tempDir("dsh-spaces-host-snap-");
  writeWeb(home);
  writeRegisteredSpace(home, "space-notes");
  const root = tempDir("dsh-spaces-host-snap-root-");
  const id = "11111111-1111-1111-1111-111111111111";
  mkdirSync(join(root, id));
  writeFileSync(
    join(root, id, "manifest.json"),
    `${JSON.stringify({
      id,
      createdAt: "yesterday",
      home,
      profiles: ["space-notes"],
      runtimeVersion: "0.1.5-rc.1",
    })}\n`,
  );
  const bad = await control(home, { snapshotRoot: root }).detail("space-notes");
  assert.deepEqual(bad.snapshots, []);

  writeFileSync(
    join(root, id, "manifest.json"),
    `${JSON.stringify({
      id,
      createdAt: "2026-09-11T12:00:00.000Z",
      home: join(home, "other"),
      profiles: ["space-notes"],
      runtimeVersion: "0.1.5-rc.1",
    })}\n`,
  );
  const otherHome = await control(home, { snapshotRoot: root }).detail("space-notes");
  assert.deepEqual(otherHome.snapshots, []);

  writeFileSync(
    join(root, id, "manifest.json"),
    `${JSON.stringify({
      id,
      createdAt: "2026-09-11T12:00:00.000Z",
      home,
      profiles: ["space-notes"],
      runtimeVersion: "0.1.5-rc.1",
    })}\n`,
  );
  const ok = await control(home, { snapshotRoot: root }).detail("space-notes");
  assert.deepEqual(ok.snapshots, [{ id, createdAt: "2026-09-11T12:00:00.000Z", runtimeVersion: "0.1.5-rc.1" }]);
  const web = await control(home, { snapshotRoot: root }).detail("web");
  assert.deepEqual(web.snapshots, []);
});

test("an interrupted create keeps the mutation journal and requires recovery", async () => {
  const home2 = tempDir("dsh-spaces-host-verify-int-");
  writeWeb(home2);
  const interrupted = control(home2, {
    runCli: async () => {
      throw new Error("spawn failed");
    },
  });
  await assert.rejects(() => interrupted.create({ name: "notes" }), SpacesPublicError);
  const stuck = await interrupted.overview();
  assert.equal(stuck.capabilities.mode, "recovery-only");
});

test("unknown keys are denied with allowlisted codes", async () => {
  const home = tempDir("dsh-spaces-host-deny-");
  writeWeb(home);
  const spaces = control(home);
  await assert.rejects(
    () => spaces.create({ name: "notes", extra: true } as never),
    (error: unknown) => {
      assert.ok(error instanceof SpacesPublicError);
      assert.equal(error.code, "spaces/invalid-input");
      return true;
    },
  );
});

test("plugin versions omit path and credential specs", async () => {
  const home = tempDir("dsh-spaces-host-plugins-");
  writeWeb(home);
  writeRegisteredSpace(home, "space-notes");
  writeFileSync(
    join(home, "profiles", "space-notes", "package.json"),
    `${JSON.stringify({
      dependencies: {
        "@deepseek-ai/dsh-web-app": "0.1.5-rc.2",
        "local-plugin": "file:../secret.tgz",
        "git-plugin": "git+https://user:token@example.com/repo.git",
      },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } },
    })}\n`,
  );
  const detail = await control(home).detail("space-notes");
  assert.deepEqual(
    detail.plugins.find((row) => row.name === "@deepseek-ai/dsh-web-app"),
    { name: "@deepseek-ai/dsh-web-app", version: "0.1.5-rc.2" },
  );
  assert.equal(detail.plugins.find((row) => row.name === "local-plugin")?.version, null);
  assert.equal(detail.plugins.find((row) => row.name === "git-plugin")?.version, null);
  assert.ok(!JSON.stringify(detail).includes("token"));
  assert.ok(!JSON.stringify(detail).includes("file:"));
});

test("bound CLI timeout waits for the child and caps output", async () => {
  const home = tempDir("dsh-spaces-host-cli-");
  const hang = join(home, "hang.js");
  writeFileSync(hang, "setInterval(() => {}, 1000);\n");
  const started = Date.now();
  await assert.rejects(
    () => spawnBoundCli(process.execPath, hang, home, process.env, [], 200),
    (error: unknown) => {
      assert.equal((error as Error).name, "CliInterruptedError");
      return true;
    },
  );
  assert.ok(Date.now() - started >= 200);

  const noisy = join(home, "noisy.js");
  writeFileSync(noisy, "process.stdout.write('x'.repeat(300000));\n");
  const result: BoundCliResult = await spawnBoundCli(process.execPath, noisy, home, process.env, [], 5_000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, CLI_OUTPUT_CAP);
});

test("Typert descriptors are strict spaces remotes and Host injects loader", () => {
  assert.deepEqual(SpacesRemote.inject, ["loader"]);
  assert.equal(TYPERT.package, "dsh-spaces");
  assert.equal(TYPERT.face, "host");
  assert.deepEqual(
    TYPERT.invocations.map((row) => `${row.namespace}/${row.method}`),
    [
      "workbenchGuide/role",
      "workbenchGuide/presentationSnapshot",
      "workbenchGuide/spaceActivity",
      "workbenchGuide/spaceAction",
      "workbenchGuide/bootstrap",
      "workbenchGuide/returnTarget",
      "workbenchGuide/portalTarget",
      "workbenchGuide/initialize",
      "workbenchGuide/previewServiceRestart",
      "workbenchGuide/previewServiceStop",
      "workbenchGuide/stopService",
      "workbenchGuide/restartService",
      "workbenchGuide/beginDesktopLaunch",
      "workbenchGuide/desktopLaunchState",
      "spaces/overview",
      "spaces/detail",
      "workbench/state",
      "workbench/startupStatus",
      "workbench/detail",
      "workbench/submit",
      "workbench/job",
      "workbench/cancel",
      "workbench/view",
    "workbench/preview",
    "workbench/product",
      "workbench/plugins",
      "workbench/snapshots",
      "workbench/snapshot",
      "workbench/runtimes",
      "workbench/backups",
    ],
  );
  assert.equal(TYPERT_REMOTE.package, "dsh-spaces");
  assert.equal(TYPERT_REMOTE.descriptors.length, TYPERT.invocations.length);
  const actionCodec = TYPERT.invocations.find(row => row.method === "spaceAction")!.parameters[0].codec.create();
  const action = { spaceId: "coding", action: "open", serviceEpoch: "a".repeat(64) };
  assert.equal(actionCodec.safeParse(action).success, true);
  for (const invalid of [{ ...action, action: "delete" }, { ...action, spaceId: "../web" }, { ...action, extra: true }, { ...action, serviceEpoch: "stale" }]) {
    assert.equal(actionCodec.safeParse(invalid).success, false);
  }
  assert.equal(
    TYPERT.invocations.some((row) => row.method === "create" || row.method === "verify"),
    false,
  );
  const parsed = workbenchCommandSchema.safeParse({ kind: "space.create", input: { name: "notes" }, extra: "nope" });
  assert.equal(parsed.success, false);
  const failure = new RemoteError("spaces/host-denied", PUBLIC_ERROR["spaces/host-denied"], {});
  assert.equal(failure.isDSHRemoteError, true);
  assert.equal(remoteErrorOf(failure)?.code, "spaces/host-denied");
  assert.deepEqual(SPACES_REMOTE_CODES, [
    "spaces/read-only",
    "spaces/host-denied",
    "spaces/invalid-input",
    "spaces/not-found",
    "spaces/already-exists",
    "spaces/locked",
    "spaces/unavailable",
  ]);
  assert.ok(WORKBENCH_REMOTE_CODES.includes("workbench/forbidden"));
});
