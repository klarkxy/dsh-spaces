import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  COMPONENT_PAYLOAD_PACKAGES, COMPONENT_PAYLOAD_REQUIRED_FILES, writeComponentPayloadManifest,
} from "../src/adapters/node/component-payload.ts";
import { coldStartLockLabel, readSelectedComponentPayload, stageComponentPayload } from "../src/adapters/node/component-selection.ts";
import { inspectControlResidue, resolveControlToolsRoot } from "../src/adapters/node/control-residue.ts";
import {
  assertDevelopmentPath, assertDevelopmentServiceIdle, DEVELOPMENT_UPDATE_FILE,
  installDevelopmentPayload, refreshDevelopmentRuntime, verifyDevelopmentInstallation,
  stopDevelopmentService,
} from "../src/adapters/node/development-refresh.ts";
import { HomeController } from "../src/adapters/node/home-controller.ts";
import { HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import { deriveServiceEpoch } from "../src/adapters/node/workbench-protocol.ts";
import type { WorkbenchApi, WorkbenchState } from "../src/shared/workbench.ts";

function write(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dsh-dev-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), toolsRoot = join(root, "tools"), source = join(root, "plugin");
  for (const dir of [home, toolsRoot]) mkdirSync(dir);
  for (const [name, files] of Object.entries(COMPONENT_PAYLOAD_REQUIRED_FILES)) {
    for (const file of files) write(join(source, file), file.endsWith("package.json")
      ? JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES[name as keyof typeof COMPONENT_PAYLOAD_PACKAGES], version: "0.4.0" })
      : `fixture: ${file}\n`);
  }
  const payload = writeComponentPayloadManifest(join(source, "lib"));
  const staged = stageComponentPayload(home, toolsRoot, payload.payloadRootLib);
  const controller = new HomeController(home);
  const manager = await controller.ensureManager();
  const modules = join(home, "profiles", manager.profileId, "node_modules", "@dsh-spaces");
  const pluginArtifact = join(root, "plugin.tgz"), bridgeArtifact = join(root, "view.tgz");
  write(pluginArtifact, "packed-plugin"); write(bridgeArtifact, "packed-bridge");
  const input = { home, toolsRoot, managerId: manager.profileId, payload: staged, pluginArtifact, bridgeArtifact };
  let installs = 0;
  const install = async (_profile: string, archive: string) => {
    installs++;
    assert.equal(new HomeOperationLock(home).inspect().held, true);
    assert.equal(new HomeOperationLock(toolsRoot).inspect().held, true);
    assert.equal(controller.inspect().held, true);
    assert.ok(existsSync(join(home, ".dsh-spaces-control", DEVELOPMENT_UPDATE_FILE)));
    const plugin = archive.includes("dev-plugin-");
    cpSync(plugin ? staged.packageRoot : join(staged.payloadRootLib, "view-bridge"), join(modules, plugin ? "plugin" : "view-bridge"), { recursive: true });
  };
  const run = (action: typeof install = install) => new HomeOperationLock(toolsRoot).run(coldStartLockLabel(home),
    () => installDevelopmentPayload({ ...input, install: action }));
  return { root, home, toolsRoot, source, payload, staged, controller, manager, modules, input, install, run, installs: () => installs };
}

test("same-version development install selects exact bytes and preserves Home data", async t => {
  const f = await fixture(t);
  // Model data without touching the protected default trees, even in tests.
  const data = join(f.home, "hub", f.manager.profileId, "sessions", "keep.jsonl");
  write(data, "existing conversation\n");
  const result = await f.run();
  assert.equal(result.status, "updated");
  assert.equal(f.installs(), 2);
  assert.equal(readSelectedComponentPayload(f.home, f.toolsRoot)?.digest, f.payload.digest);
  verifyDevelopmentInstallation(f.home, f.manager.profileId, f.payload);
  assert.equal(readFileSync(data, "utf8"), "existing conversation\n");
  assert.equal(f.controller.inspect().held, false);
  assert.equal(existsSync(join(f.home, ".dsh-spaces-control", DEVELOPMENT_UPDATE_FILE)), false);
  assert.equal(existsSync(join(f.home, "profiles/web")), false);
  assert.equal(existsSync(join(f.home, "sessions")), false);
  assert.equal(existsSync(join(f.home, "storages")), false);
});

test("failure between installs keeps evidence, does not select, and refuses replay", async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(f.run(async (profile, archive) => {
    if (++calls === 2) throw new Error("second install failed");
    await f.install(profile, archive);
  }), /second install failed/);
  assert.equal(readSelectedComponentPayload(f.home, f.toolsRoot), undefined);
  assert.ok(inspectControlResidue(f.home).some(s => s.includes("update left unfinished evidence")));
  await assert.rejects(f.run(), /Unfinished maintenance evidence/);
  assert.equal(calls, 2);
  assert.equal(f.controller.inspect().held, false);
  assert.equal(new HomeOperationLock(f.home).inspect().held, false);
});

test("installed-byte mismatch blocks component selection", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(async (profile, archive) => {
    await f.install(profile, archive);
    if (archive.includes("dev-view-")) write(join(f.modules, "view-bridge/lib/client.js"), "wrong client");
  }), /Installed view bridge differs/);
  assert.equal(readSelectedComponentPayload(f.home, f.toolsRoot), undefined);
  assert.ok(existsSync(join(f.home, ".dsh-spaces-control", DEVELOPMENT_UPDATE_FILE)));
});

test("failure after pointer commit preserves evidence and never replays installation", async t => {
  const f = await fixture(t);
  const marker = join(f.home, ".dsh-spaces-control", DEVELOPMENT_UPDATE_FILE);
  const original = fs.unlinkSync;
  const fault = t.mock.method(fs, "unlinkSync", (path: Parameters<typeof fs.unlinkSync>[0]) => {
    if (path === marker) throw new Error("completion write failed");
    return original(path);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.run(), /completion write failed/);
    assert.equal(readSelectedComponentPayload(f.home, f.toolsRoot)?.digest, f.payload.digest);
    assert.ok(existsSync(marker));
    await assert.rejects(f.run(), /Unfinished maintenance evidence/);
    assert.equal(f.installs(), 2);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
});

test("install refuses missing cold-start reservation before calling the installer", async t => {
  const f = await fixture(t);
  await assert.rejects(installDevelopmentPayload({ ...f.input, install: f.install }), /cold-start reservation/);
  assert.equal(f.installs(), 0);
});

test("competing controller prevents installation without changing its ownership", async t => {
  const f = await fixture(t);
  const owner = f.controller.acquire("web");
  try { await assert.rejects(f.run(), /control|owner|held/i); }
  finally { owner.release(); }
  assert.equal(f.installs(), 0);
});

test("an unfinished Home write is never unlocked or replayed", async t => {
  const f = await fixture(t);
  await new HomeOperationLock(f.home).run("other-write", async () => {
    await assert.rejects(f.run(), /lock|held/i);
    assert.equal(new HomeOperationLock(f.home).inspect().held, true);
  });
  assert.equal(f.installs(), 0);
});

test("existing maintenance evidence blocks development before install", async t => {
  const f = await fixture(t);
  const marker = join(f.home, ".dsh-spaces-control/plugin-mutation.json");
  write(marker, "do not change");
  await assert.rejects(f.run(), /Unfinished maintenance/);
  assert.equal(readFileSync(marker, "utf8"), "do not change");
  assert.equal(f.installs(), 0);
});

test("unchanged payload uses recorded tools root even when Electron userData differs", async t => {
  const f = await fixture(t);
  await f.run();
  const bin = join(f.root, "cli/lib/bin.js");
  write(bin, "");
  write(join(f.root, "cli/package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.2" }));
  write(join(f.home, ".dsh-spaces-control/toolchain.json"), JSON.stringify({
    version: 1, bin, nodeExe: process.execPath, dshVersion: "0.1.5-rc.2", toolchainRoot: f.toolsRoot,
  }));
  const userData = join(f.root, "new-electron-data");
  assert.equal(resolveControlToolsRoot(f.home, userData), f.toolsRoot);
  const result = await refreshDevelopmentRuntime({ home: f.home, userData, payloadRoot: f.payload.payloadRootLib });
  assert.equal(result.status, "current");
  assert.equal(existsSync(userData), false);
});

test("fresh Home is left to the ordinary first-install workflow", async t => {
  const f = await fixture(t);
  const home = join(f.root, "fresh-home");
  const result = await refreshDevelopmentRuntime({ home, userData: join(f.root, "app"), payloadRoot: f.payload.payloadRootLib });
  assert.equal(result.status, "first-install");
  assert.equal(existsSync(join(home, "profiles")), false);
});

test("development refuses real Home even with packaged/allow-real-home opt-ins", () => {
  assert.throws(() => assertDevelopmentPath(join(homedir(), ".dsh")), /real DSH Home/);
  assert.throws(() => assertDevelopmentPath(join(homedir(), ".dsh", "profiles", "web")), /real DSH Home/);
});

test("packing destination and every ancestor reject junctions before writes", async t => {
  const f = await fixture(t);
  const target = join(f.root, "unrelated");
  mkdirSync(target);
  symlinkSync(target, join(f.toolsRoot, "development-artifacts"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertDevelopmentPath(join(f.toolsRoot, "development-artifacts", f.payload.digest)), /symlink or junction/);
  assert.equal(existsSync(join(target, f.payload.digest)), false);
});

test("fast successful shutdown may release ownership before submit returns", async t => {
  const f = await fixture(t);
  const controllerModule = new URL("../src/adapters/node/home-controller.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {HomeController} from ${JSON.stringify(controllerModule)};
    const lease = new HomeController(process.argv[1]).acquire('web', 'http://127.0.0.1:3100');
    process.on('message', () => { lease.release(); process.exit(0); });
    process.send('ready');
  `, f.home], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, "message");
  const held = f.controller.inspect();
  assert.ok(held.held && "owner" in held);
  const epoch = deriveServiceEpoch(held.owner.nonce);
  const api = {
    state: async () => ({ writable: true, availability: "ready", maintenance: false, reasons: [], jobs: [], spaces: [], serviceEpoch: epoch, revision: "b".repeat(64) }),
    preview: async () => ({ id: "plan", serviceEpoch: epoch, stateRevision: "b".repeat(64) }),
    submit: async (command: unknown, requestId: string) => {
      const exited = once(child, "exit");
      child.send("shutdown");
      await exited;
      write(join(f.home, ".dsh-spaces-control/jobs/receipt.json"), JSON.stringify({ command, requestId, status: "succeeded" }));
      return { id: "receipt" };
    },
  } as unknown as WorkbenchApi;
  await stopDevelopmentService(f.home, api);
  assert.equal(f.controller.inspect().held, false);
});

test("service refresh refuses jobs, maintenance and active ordinary spaces", () => {
  const ready = { writable: true, availability: "ready", maintenance: false, reasons: [], jobs: [], spaces: [], managerId: "spaces-hub" } as unknown as WorkbenchState;
  assert.doesNotThrow(() => assertDevelopmentServiceIdle(ready));
  assert.throws(() => assertDevelopmentServiceIdle({ ...ready, maintenance: true }), /not healthy/);
  assert.throws(() => assertDevelopmentServiceIdle({ ...ready, jobs: [{ status: "running" }] as WorkbenchState["jobs"] }), /job is still running/);
  assert.throws(() => assertDevelopmentServiceIdle({ ...ready, spaces: [{ id: "ordinary", status: "running" }] as WorkbenchState["spaces"] }), /ordinary space is active/);
});
