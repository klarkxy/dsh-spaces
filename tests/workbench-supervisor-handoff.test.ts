import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  COMPONENT_PAYLOAD_ENTRIES,
  COMPONENT_PAYLOAD_MANIFEST_REL,
  COMPONENT_PAYLOAD_PACKAGES,
  writeComponentPayloadManifest,
  type ValidatedComponentPayload,
} from "../src/adapters/node/component-payload.ts";
import { spawnComponentLauncher } from "../src/adapters/node/component-handoff.ts";
import { HomeController } from "../src/adapters/node/home-controller.ts";
import type { PatchWriter } from "../src/adapters/node/patch-writer.ts";
import type { ProcessRuntime } from "../src/adapters/node/process-manager.ts";
import { deriveServiceEpoch } from "../src/adapters/node/workbench-protocol.ts";
import {
  assertHandoffTokenMatchesSelectedPayload,
  bindSupervisorComponentPayload,
  createWorkbenchSupervisor,
  parseSupervisorArgs,
  preflightSupervisorComponentPayload,
  supervisorCliArgs,
  validateSupervisorComponentPayload,
  WorkbenchSupervisorRuntime,
  type WorkbenchMaintenance,
  type WorkbenchSupervisorHandle,
} from "../src/adapters/node/workbench-supervisor.ts";
import { expectedAuthCookieName } from "../src/adapters/node/workbench-http.ts";
import type { WorkbenchPlan, WorkbenchPlanRequest } from "../src/shared/workbench.ts";
import { main as supervisorMain } from "../packages/supervisor/src/index.ts";

const temps: string[] = [];
const live: ChildProcess[] = [];
const handles: WorkbenchSupervisorHandle[] = [];
const extraPids: number[] = [];

describe("supervisor component-payload cold start", { concurrency: 1 }, () => {
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      await handle.close();
    } catch {
      /* keep lease semantics */
    }
    await new Promise<void>((resolveClose) => handle.server.close(() => resolveClose()));
  }
  for (const child of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const pid of extraPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await delay(80);
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      await delay(80);
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(join(dirname(dir), `${basename(dir)}-snapshots`), { recursive: true, force: true });
  }
});

test("CLI round-trips --component-payload with the other Node-only path flags", () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const worker = join(payload.packageRoot, ...COMPONENT_PAYLOAD_ENTRIES["installation-worker"].split("/"));
  const viewTgz = join(home, "view.tgz");
  const llmTgz = join(home, "llm.tgz");
  writeFileSync(viewTgz, "view-archive");
  writeFileSync(llmTgz, "llm-archive");
  const argv = [
    "--home",
    home,
    "--bin",
    bin,
    "--node",
    process.execPath,
    "--port",
    "0",
    "--snapshot-worker",
    worker,
    "--view-bridge-artifact",
    viewTgz,
    "--llm-bridge-artifact",
    llmTgz,
    "--component-payload",
    payload.payloadRootLib,
  ];
  const parsed = parseSupervisorArgs(argv);
  assert.equal(parsed.componentPayloadRoot, payload.payloadRootLib);
  assert.equal(parsed.snapshotWorkerFile, worker);
  assert.equal(parsed.viewBridgeArtifact, viewTgz);
  assert.equal(parsed.llmBridgeArtifact, llmTgz);
  const emitted = supervisorCliArgs(parsed);
  assert.deepEqual(parseSupervisorArgs(emitted).componentPayloadRoot, payload.payloadRootLib);
  assert.equal(emitted.includes("--component-payload"), true);
  assert.equal(emitted[emitted.indexOf("--component-payload") + 1], payload.payloadRootLib);
  assert.equal(parseSupervisorArgs(["--home", home, "--bin", bin]).componentPayloadRoot, undefined);
});

test("CLI main and bind refuse a missing or tampered v2 manifest", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const missing = tempDir("dsh-spaces-handoff-missing-");
  mkdirSync(join(missing, "lib"), { recursive: true });
  const missingLib = join(missing, "lib");
  await assert.rejects(
    () => supervisorMain(["--home", home, "--bin", bin, "--component-payload", missingLib]),
    /manifest|schemaVersion|invalid|missing/i,
  );
  assert.throws(
    () => bindSupervisorComponentPayload({ home, bin, componentPayloadRoot: missingLib }),
    /manifest|schemaVersion|invalid|missing/i,
  );

  const payload = dummyPayloadLib();
  writeFileSync(
    join(payload.packageRoot, ...COMPONENT_PAYLOAD_MANIFEST_REL.split("/")),
    `${JSON.stringify({ schemaVersion: 1, entry: "index.js" })}\n`,
  );
  await assert.rejects(
    () => supervisorMain(["--home", home, "--bin", bin, "--component-payload", payload.payloadRootLib]),
    /schemaVersion|invalid/i,
  );
  await assert.rejects(
    () => createWorkbenchSupervisor({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      createMaintenance: () => fakeMaintenance(),
    }),
    /schemaVersion|invalid/i,
  );
});

test("a valid payload binds the same-group worker and supervisor assets and starts", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);
  const worker = join(payload.packageRoot, ...COMPONENT_PAYLOAD_ENTRIES["installation-worker"].split("/"));
  const supervisorDir = join(payload.packageRoot, "lib", "supervisor");

  const bound = bindSupervisorComponentPayload({
    home,
    bin,
    componentPayloadRoot: payload.payloadRootLib,
    ...packed,
  });
  assert.equal(bound.componentPayloadRoot, payload.payloadRootLib);
  assert.equal(bound.snapshotWorkerFile, worker);
  assert.equal(bound.supervisorAssetRoot, supervisorDir);
  assert.equal(bound.viewBridgeArtifact, packed.viewBridgeArtifact);
  assert.equal(bound.llmBridgeArtifact, packed.llmBridgeArtifact);

  const otherWorker = join(home, "other-worker.mjs");
  writeFileSync(otherWorker, "export const other = 1;\n");
  assert.throws(
    () => bindSupervisorComponentPayload({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      snapshotWorkerFile: otherWorker,
    }),
    /snapshot-worker is not from the selected component group/,
  );
  assert.throws(
    () => bindSupervisorComponentPayload({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      viewBridgeArtifact: join(home, "missing-view.tgz"),
    }),
    /view-bridge-artifact is missing/,
  );

  const handle = await startWithPayload(home, bin, payload);
  assert.match(handle.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const state = await handle.runtime.state();
  assert.ok(state.managerId);
  assert.notEqual(state.availability, "unavailable");
});

test("missing artifact tuple is rejected before HTTP or owner writes", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);
  await assert.rejects(
    () => createWorkbenchSupervisor({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      createMaintenance: () => fakeMaintenance(),
    }),
    /plugin, view-bridge, and llm-bridge artifacts/i,
  );
  await assert.rejects(
    () => createWorkbenchSupervisor({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: packed.viewBridgeArtifact,
      createMaintenance: () => fakeMaintenance(),
    }),
    /plugin, view-bridge, and llm-bridge artifacts/i,
  );
  assert.equal(new HomeController(home).inspect().held, false);
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "endpoint.json")), false);
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "host.bearer")), false);
});

test("mixed same-version view or llm archive bytes fail before HTTP or owner writes", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);
  const mixedView = dummyPayloadLib({ viewBody: "export const view = 'tampered';\n" });
  const mixedLlm = dummyPayloadLib({ llmBody: "export const llm = 'tampered';\n" });
  const viewMix = packGroupArtifacts(mixedView, tempDir("dsh-spaces-handoff-mix-view-"));
  const llmMix = packGroupArtifacts(mixedLlm, tempDir("dsh-spaces-handoff-mix-llm-"));
  await assert.rejects(
    () => preflightSupervisorComponentPayload({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: viewMix.viewBridgeArtifact,
      llmBridgeArtifact: packed.llmBridgeArtifact,
    }),
    /view-bridge|artifact|match|digest|version/i,
  );
  await assert.rejects(
    () => preflightSupervisorComponentPayload({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: packed.viewBridgeArtifact,
      llmBridgeArtifact: llmMix.llmBridgeArtifact,
    }),
    /llm-bridge|artifact|match|digest|version/i,
  );
  await assert.rejects(
    () => createWorkbenchSupervisor({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: viewMix.viewBridgeArtifact,
      llmBridgeArtifact: packed.llmBridgeArtifact,
      createMaintenance: () => fakeMaintenance(),
    }),
    /view-bridge|artifact|match|digest|version/i,
  );
  assert.equal(new HomeController(home).inspect().held, false);
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "endpoint.json")), false);
});

test("token-accept preflight validates artifacts before HomeController.accept", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);
  const mixedView = dummyPayloadLib({ viewBody: "export const view = 'other';\n" });
  const viewMix = packGroupArtifacts(mixedView, tempDir("dsh-spaces-handoff-accept-mix-"));
  await assert.rejects(
    () => preflightSupervisorComponentPayload({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: viewMix.viewBridgeArtifact,
      llmBridgeArtifact: packed.llmBridgeArtifact,
    }),
    /view-bridge|artifact|match|digest|version/i,
  );
  assert.equal(new HomeController(home).inspect().held, false);
  const ready = await preflightSupervisorComponentPayload({
    home,
    bin,
    componentPayloadRoot: payload.payloadRootLib,
    ...packed,
  });
  assert.equal(ready.pluginArtifact, packed.pluginArtifact);
  assert.equal(new HomeController(home).inspect().held, false);
});

test("threaded payload stages reuse the launch validation conclusion", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);

  // Validate once, then remove the manifest: every stage below can only pass
  // by reusing that conclusion instead of re-reading and re-hashing the group.
  const selected = validateSupervisorComponentPayload(payload.payloadRootLib);
  rmSync(join(payload.packageRoot, ...COMPONENT_PAYLOAD_MANIFEST_REL.split("/")));

  const bound = bindSupervisorComponentPayload({
    home,
    bin,
    componentPayloadRoot: payload.payloadRootLib,
    ...packed,
  }, selected);
  assert.equal(bound.componentPayloadRoot, selected.payloadRootLib);
  const matched = assertHandoffTokenMatchesSelectedPayload(
    { artifactDigest: payload.digest },
    bound.componentPayloadRoot,
    undefined,
    selected,
  );
  assert.equal(matched.digest, payload.digest);
  const runtime = new WorkbenchSupervisorRuntime({
    home,
    bin,
    componentPayloadRoot: bound.componentPayloadRoot,
    ...packed,
  }, selected);
  await runtime.close();
});

test("a threaded launch boots with the reused payload conclusion", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);
  const selected = validateSupervisorComponentPayload(payload.payloadRootLib);

  // Artifact tuple and tar digest checks still run against the reused payload.
  const mixedView = dummyPayloadLib({ viewBody: "export const view = 'tampered';\n" });
  const viewMix = packGroupArtifacts(mixedView, tempDir("dsh-spaces-handoff-thread-mix-"));
  await assert.rejects(
    () => preflightSupervisorComponentPayload({
      home,
      bin,
      componentPayloadRoot: payload.payloadRootLib,
      pluginArtifact: packed.pluginArtifact,
      viewBridgeArtifact: viewMix.viewBridgeArtifact,
      llmBridgeArtifact: packed.llmBridgeArtifact,
    }, selected),
    /view-bridge|artifact|match|digest|version/i,
  );

  const handle = await startSupervisor(home, bin, {
    componentPayloadRoot: payload.payloadRootLib,
    ...packed,
  }, selected);
  const state = await handle.runtime.state();
  assert.ok(state.managerId);
  assert.notEqual(state.availability, "unavailable");

  // Without a threaded validation the same tampered group still fails closed.
  const fresh = dummyPayloadLib();
  rmSync(join(fresh.packageRoot, ...COMPONENT_PAYLOAD_MANIFEST_REL.split("/")));
  await assert.rejects(
    () => createWorkbenchSupervisor({
      home,
      bin,
      componentPayloadRoot: fresh.payloadRootLib,
      createMaintenance: () => fakeMaintenance(),
    }),
    /manifest|missing|invalid/i,
  );
});

test("CLI round-trips --accept-handoff only with an explicit nonzero port", () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  assert.throws(
    () => parseSupervisorArgs(["--home", home, "--bin", bin, "--accept-handoff"]),
    /nonzero --port/,
  );
  assert.throws(
    () => parseSupervisorArgs(["--home", home, "--bin", bin, "--port", "0", "--accept-handoff"]),
    /nonzero --port/,
  );
  const parsed = parseSupervisorArgs(["--home", home, "--bin", bin, "--port", "3210", "--accept-handoff"]);
  assert.equal(parsed.acceptHandoff, true);
  assert.equal(parsed.port, 3210);
  assert.equal(supervisorCliArgs(parsed).includes("--accept-handoff"), true);
});

test("missing IPC accept-handoff does not write runtime owner files", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const cli = fileURLToPath(new URL("../packages/supervisor/src/index.ts", import.meta.url));
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    cli,
    "--home",
    home,
    "--bin",
    bin,
    "--port",
    "32111",
    "--accept-handoff",
  ], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env },
  });
  live.push(child);
  const result = await new Promise<{ code: number | null; stderr: string }>((resolveWait) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => resolveWait({ code, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /inherited IPC|accept-handoff|invalid/i);
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "endpoint.json")), false);
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "host.bearer")), false);
  assert.equal(existsSync(join(home, ".dsh-spaces-control", "jobs")), false);
  assert.equal(new HomeController(home).inspect().held, false);
});

test("failed stop blocks direct LLM and credential writes", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  writeProfile(home, "alpha", { name: "alpha" });
  const handle = await startSupervisor(home, bin, {
    processRuntime: {
      spawn: spawnFixture(),
      prepareHome: async () => undefined,
      kill: async () => undefined,
      gracefulWaitMs: 30,
      forceWaitMs: 10,
      readyTimeoutMs: 8_000,
      pollMs: 20,
    },
  });
  const started = await handle.runtime.state();
  await handle.runtime.submit(
    { kind: "space.start", spaceId: "alpha" },
    "p1-start",
    { serviceEpoch: started.serviceEpoch, expectedRevision: started.revision },
  );
  await waitJob(handle, "p1-start");
  const prep = await handle.runtime.job("p1-start");
  assert.equal(prep.status, "succeeded", JSON.stringify({ prep, state: await handle.runtime.state() }));
  const beforeStop = await handle.runtime.state();
  const shutdown = await handle.runtime.preview(
    { kind: "service.shutdown" },
    { serviceEpoch: beforeStop.serviceEpoch, expectedRevision: beforeStop.revision },
  );
  await handle.runtime.submit(
    { kind: "plan.execute", planId: shutdown.id },
    "p1-shutdown",
    { serviceEpoch: beforeStop.serviceEpoch, expectedRevision: beforeStop.revision },
  );
  await waitJob(handle, "p1-shutdown");
  assert.equal((await handle.runtime.job("p1-shutdown")).status, "failed");
  assert.equal(new HomeController(home).inspect().held, true);
  await assert.rejects(
    () => handle.runtime.llm({ method: "setDefault", model: null, expectedRevision: 0 }),
    /Stop failed|unavailable|refused/i,
  );
  await assert.rejects(
    () => handle.runtime.dispatch("llmCredential", { method: "saveConnectionWithCredential" }),
    /Stop failed|unavailable|refused/i,
  );
  const blockedState = await handle.runtime.state();
  await assert.rejects(
    () => handle.runtime.submit(
      { kind: "space.update", spaceId: "alpha", displayName: "nope" },
      "p1-update",
      { serviceEpoch: blockedState.serviceEpoch, expectedRevision: blockedState.revision },
    ),
    /Stop failed|unavailable|refused/i,
  );
});

test("accepted startup failure closes HTTP and keeps the run owner", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const portA = await freePort();
  const portB = await freePort();
  const acquired = new HomeController(home).acquire("web", `http://127.0.0.1:${portA}`);
  await assert.rejects(
    () => startSupervisor(home, bin, { port: portB, acceptedHandle: acquired }),
    /endpoint origin does not match|unavailable/i,
  );
  assert.equal(new HomeController(home).inspect().held, true);
  if ("owner" in new HomeController(home).inspect()) {
    assert.equal((new HomeController(home).inspect() as { owner: { nonce: string } }).owner.nonce, acquired.owner.nonce);
  }
  await assert.rejects(() => fetch(`http://127.0.0.1:${portB}/`, { signal: AbortSignal.timeout(500) }));
});

test("accepted owner cannot report startup success when manager spawn fails", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const port = await freePort();
  const acquired = new HomeController(home).acquire("web", `http://127.0.0.1:${port}`);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);
  await assert.rejects(
    () => startSupervisor(home, bin, {
      port,
      acceptedHandle: acquired,
      componentPayloadRoot: payload.payloadRootLib,
      ...packed,
      pluginAdd: async (_home, profile) => {
        writeProfile(home, profile, {
          dependencies: { "@dsh-spaces/plugin": "1.0.0" },
          dsh: { profile: { bundles: ["@dsh-spaces/plugin"] } },
        });
      },
      processRuntime: {
        spawn: () => {
          throw new Error("fixture manager spawn rejected");
        },
        prepareHome: async () => undefined,
        readyTimeoutMs: 100,
        pollMs: 10,
      },
    }),
    /did not start the manager|did not bind a ready manager view|unavailable/i,
  );
  const inspect = new HomeController(home).inspect();
  assert.equal(inspect.held, true);
  if (!("owner" in inspect)) throw new Error("expected owner");
  assert.equal(inspect.owner.nonce, acquired.owner.nonce);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }));
});

test("accepted owner cannot report startup success when residue blocks manager start", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const port = await freePort();
  const acquired = new HomeController(home).acquire("web", `http://127.0.0.1:${port}`);
  mkdirSync(join(home, ".dsh-spaces-upgrade"), { recursive: true });
  writeFileSync(join(home, ".dsh-spaces-upgrade", "journal.json"), `${JSON.stringify({ version: 1 })}\n`);
  const payload = dummyPayloadLib();
  const packed = packGroupArtifacts(payload, home);
  await assert.rejects(
    () => startSupervisor(home, bin, {
      port,
      acceptedHandle: acquired,
      componentPayloadRoot: payload.payloadRootLib,
      ...packed,
    }),
    /did not start the manager|did not bind a ready manager view|unavailable/i,
  );
  const inspect = new HomeController(home).inspect();
  assert.equal(inspect.held, true);
  if (!("owner" in inspect)) throw new Error("expected owner");
  assert.equal(inspect.owner.nonce, acquired.owner.nonce);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }));
});

test("handoff token digest must match the bound selected payload", () => {
  const payload = dummyPayloadLib();
  assert.throws(
    () => assertHandoffTokenMatchesSelectedPayload({ artifactDigest: "a".repeat(64) }, payload.payloadRootLib),
    /artifactDigest does not match/,
  );
  const selected = assertHandoffTokenMatchesSelectedPayload(
    { artifactDigest: payload.digest },
    payload.payloadRootLib,
  );
  assert.equal(selected.digest, payload.digest);
  assert.throws(
    () => assertHandoffTokenMatchesSelectedPayload(
      { artifactDigest: payload.digest },
      payload.payloadRootLib,
      join(payload.packageRoot, "lib", "index.js"),
    ),
    /Supervisor entry is not from the selected component group/,
  );
});

test("accepted owner is injected without acquire and uses a new bearer", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const port = await freePort();
  const acquired = new HomeController(home).acquire("web", `http://127.0.0.1:${port}`);
  const beforeNonce = acquired.owner.nonce;
  const handle = await startSupervisor(home, bin, {
    port,
    acceptedHandle: acquired,
  });
  const inspect = new HomeController(home).inspect();
  assert.equal(inspect.held, true);
  if (!("owner" in inspect)) throw new Error("expected owner");
  assert.equal(inspect.owner.nonce, beforeNonce);
  assert.equal(inspect.owner.pid, process.pid);
  assert.equal(handle.origin, `http://127.0.0.1:${port}`);
  const state = await handle.runtime.state();
  assert.equal(state.serviceEpoch, deriveServiceEpoch(beforeNonce));
  assert.ok(state.managerId);
  assert.equal(state.spaces.find((space) => space.id === state.managerId)?.status, "running");
  const bearer = readFileSync(join(home, ".dsh-spaces-control", "host.bearer"), "utf8").trim();
  assert.match(bearer, /^[a-f0-9]{64}$/);
  await assert.throws(() => new HomeController(home).acquire("web"), /busy|already/i);
});

test("library supervisor without CLI exit capability refuses upgrade before stop", async () => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  let stopped = false;
  let refused = "";
  const handle = await startSupervisor(home, bin, {
    createMaintenance: (ports) => ({
      ...fakeMaintenance(),
      execute: async (planId, ctx) => {
        if (!ports.packageUpgrade) throw new Error("packageUpgrade missing");
        try {
          return await ports.packageUpgrade.execute({
            planId,
            catalogId: "bundled-workbench",
            version: "1.0.0",
            expectedDigest: "a".repeat(64),
          }, ctx);
        } catch (error) {
          refused = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    }),
    processRuntime: {
      spawn: spawnFixture(),
      prepareHome: async () => undefined,
      kill: async () => {
        stopped = true;
      },
    },
  });
  const state = await handle.runtime.state();
  const planId = randomUUID();
  const job = await handle.runtime.submit(
    { kind: "plan.execute", planId },
    "lib-upgrade-job",
    { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision },
  );
  await waitJob(handle, "lib-upgrade-job");
  const settled = await handle.runtime.job("lib-upgrade-job");
  assert.equal(settled.status, "failed");
  assert.match(refused, /tools root|handoff port/i);
  assert.equal(stopped, false);
  assert.equal(new HomeController(home).inspect().held, true);
});

test("failed stop does not transfer; failed persist does not transfer; durable success finalizes", async (t) => {
  const home = tempDir("dsh-spaces-handoff-home-");
  const bin = writeFakeCli(home);
  const payload = dummyPayloadLib();
  const tools = tempDir("dsh-spaces-handoff-tools-");
  const originalNpmCache = process.env.npm_config_cache;
  process.env.npm_config_cache = join(tools, "npm-cache");
  t.after(() => {
    if (originalNpmCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = originalNpmCache;
  });
  const packed = packGroupArtifacts(payload, home);
  writeProfile(home, "alpha", {
    name: "alpha",
    dependencies: { "@dsh-spaces/view-bridge": "3.0.0" },
    dsh: { profile: { bundles: ["@dsh-spaces/view-bridge"] } },
  });
  cpSync(
    join(payload.packageRoot, "lib", "view-bridge"),
    join(home, "profiles", "alpha", "node_modules", "@dsh-spaces", "view-bridge"),
    { recursive: true },
  );

  const stub = writeStubLauncher(home);
  const stamp = join(home, "commit-stamp.json");
  let exited = false;
  let runtime: WorkbenchSupervisorRuntime | undefined;
  const handle = await startSupervisor(home, bin, {
    componentPayloadRoot: payload.payloadRootLib,
    controlToolRoot: tools,
    ...packed,
    dumpConfig: async (profile) => `${dumpText(profile)}- id: settings\n  disabled: true\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n`,
    onNormalExit: () => {
      exited = true;
    },
    spawnLauncher: (options) => {
      const launcher = spawnComponentLauncher({
        ...options,
        launcherEntry: stub,
        execArgv: [],
        cwd: tools,
        env: { ...process.env, DSH_TEST_COMMIT_STAMP: stamp },
      });
      extraPids.push(launcher.pid);
      return launcher;
    },
    createMaintenance: () => ({
      ...fakeMaintenance(),
      execute: async (planId, ctx) => {
        if (!runtime) throw new Error("runtime missing");
        const snapshotId = randomUUID();
        try {
          await runtime.handoffWorkbenchPackage({ planId, snapshotId, payload }, ctx);
        } catch (error) {
          (runtime as WorkbenchSupervisorRuntime & { lastHandoffError?: string }).lastHandoffError =
            error instanceof Error ? error.message : String(error);
          throw error;
        }
        return { snapshotId };
      },
    }),
  });
  runtime = handle.runtime;
  const started = await handle.runtime.state();
  await handle.runtime.submit(
    { kind: "space.start", spaceId: "alpha" },
    "start-alpha",
    { serviceEpoch: started.serviceEpoch, expectedRevision: started.revision },
  );
  await waitJob(handle, "start-alpha");
  const startedJob = await handle.runtime.job("start-alpha");
  assert.equal(startedJob.status, "succeeded", JSON.stringify(startedJob));
  const running = await handle.runtime.state();
  assert.equal(running.spaces.find((space) => space.id === "alpha")?.status, "running");
  const blocked = await handle.runtime.submit(
    { kind: "plan.execute", planId: "blocked-upgrade" },
    "blocked-upgrade",
    { serviceEpoch: running.serviceEpoch, expectedRevision: running.revision },
  );
  await waitJob(handle, "blocked-upgrade");
  const blockedJob = await handle.runtime.job("blocked-upgrade");
  assert.equal(blockedJob.status, "failed");
  assert.match(
    (runtime as WorkbenchSupervisorRuntime & { lastHandoffError?: string }).lastHandoffError ?? "",
    /still running|handoff was not started/i,
  );
  assert.equal(exited, false);
  assert.equal(existsSync(stamp), false);
  assert.equal(new HomeController(home).inspect().held, true);
  if ("owner" in new HomeController(home).inspect()) {
    assert.equal((new HomeController(home).inspect() as { owner: { pid: number } }).owner.pid, process.pid);
  }

  await stopAllOwned(handle);

  let persistOnce = true;
  const persistHome = tempDir("dsh-spaces-handoff-home-");
  const persistBin = writeFakeCli(persistHome);
  const persistPayload = dummyPayloadLib();
  const persistTools = tempDir("dsh-spaces-handoff-tools-");
  const persistPacked = packGroupArtifacts(persistPayload, persistHome);
  let persistRuntime: WorkbenchSupervisorRuntime | undefined;
  let persistExited = false;
  let persistSpawned = false;
  const persistHandle = await startSupervisor(persistHome, persistBin, {
    componentPayloadRoot: persistPayload.payloadRootLib,
    controlToolRoot: persistTools,
    ...persistPacked,
    onNormalExit: () => {
      persistExited = true;
    },
    jobsInject: (op, id) => {
      if (op !== "write") return;
      const file = join(persistHome, ".dsh-spaces-control", "jobs", `${id}.json`);
      if (!existsSync(file)) return;
      const rec = JSON.parse(readFileSync(file, "utf8")) as { phase?: string; status?: string };
      if (rec.phase === "handoff-pending" && rec.status === "running") {
        if (!persistOnce) throw new Error("persist fail");
        persistOnce = false;
      }
    },
    spawnLauncher: (options) => {
      persistSpawned = true;
      const launcher = spawnComponentLauncher({
        ...options,
        launcherEntry: stub,
        execArgv: [],
        cwd: persistTools,
      });
      extraPids.push(launcher.pid);
      return launcher;
    },
    createMaintenance: () => ({
      ...fakeMaintenance(),
      execute: async (planId, ctx) => {
        if (!persistRuntime) throw new Error("runtime missing");
        const snapshotId = randomUUID();
        await persistRuntime.handoffWorkbenchPackage({ planId, snapshotId, payload: persistPayload }, ctx);
        return { snapshotId };
      },
    }),
  });
  persistRuntime = persistHandle.runtime;
  await stopAllOwned(persistHandle);
  const persistState = await persistHandle.runtime.state();
  await persistHandle.runtime.submit(
    { kind: "plan.execute", planId: "persist-upgrade" },
    "persist-upgrade",
    { serviceEpoch: persistState.serviceEpoch, expectedRevision: persistState.revision },
  );
  await waitJob(persistHandle, "persist-upgrade");
  const persistJob = await persistHandle.runtime.job("persist-upgrade");
  assert.equal(persistJob.status, "failed");
  assert.equal(persistSpawned, false);
  assert.equal(persistExited, false);
  assert.equal(new HomeController(persistHome).inspect().held, true);
  if ("owner" in new HomeController(persistHome).inspect()) {
    assert.equal((new HomeController(persistHome).inspect() as { owner: { pid: number } }).owner.pid, process.pid);
  }

  writeFileSync(stamp, "");
  const ready = await handle.runtime.state();
  await handle.runtime.submit(
    { kind: "plan.execute", planId: "ok-upgrade" },
    "ok-upgrade",
    { serviceEpoch: ready.serviceEpoch, expectedRevision: ready.revision },
  );
  await waitJob(handle, "ok-upgrade");
  const okJob = await handle.runtime.job("ok-upgrade");
  assert.equal(okJob.status, "succeeded", JSON.stringify({ okJob, lastHandoffError: (runtime as WorkbenchSupervisorRuntime & { lastHandoffError?: string }).lastHandoffError }));
  assert.equal(okJob.phase, "handoff-pending");
  await waitUntil(() => exited || existsSync(stamp) && readFileSync(stamp, "utf8").trim().length > 0, "handoff commit");
  assert.equal(okJob.phase, "handoff-pending");
  const commitRaw = readFileSync(stamp, "utf8").trim();
  assert.notEqual(commitRaw, "");
  const commit = JSON.parse(commitRaw.split("\n")[0] ?? "{}") as { digest?: string; argv?: string[] };
  assert.equal(commit.digest, payload.digest);
  assert.equal(commit.argv?.includes("--accept-handoff"), true);
  assert.equal(commit.argv?.includes("--component-payload"), true);
  assert.equal(exited, true);
  const after = new HomeController(home).inspect();
  assert.equal(after.held, true);
  if ("owner" in after) {
    assert.notEqual(after.owner.pid, process.pid);
  }
});
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeRel(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function dummyPayloadLib(opts: { viewBody?: string; llmBody?: string } = {}): ValidatedComponentPayload {
  const root = tempDir("dsh-spaces-handoff-payload-");
  const files: Array<[string, string]> = [
    ["package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["manager-plugin"], version: "1.0.0" })}\n`],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["LICENSE", "x\n"],
    ["lib/index.js", "export const plugin = 1;\n"],
    ["lib/typert.host.js", "export const host = 1;\n"],
    ["lib/typert.remote-client.js", "export const remote = 1;\n"],
    ["lib/client.js", "export const client = 1;\n"],
    ["lib/supervisor/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES.supervisor, version: "2.0.0" })}\n`],
    ["lib/supervisor/index.js", "export const supervisor = 1;\n"],
    ["lib/supervisor/launcher.mjs", "export const launcher = 1;\n"],
    ["lib/supervisor/LICENSE", "x\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export const worker = 1;\n"],
    ["lib/view-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["view-bridge"], version: "3.0.0" })}\n`],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/LICENSE", "x\n"],
    ["lib/view-bridge/lib/index.js", opts.viewBody ?? "export const view = 1;\n"],
    ["lib/view-bridge/lib/client.js", "export const viewClient = 1;\n"],
    ["lib/view-bridge/lib/settings.js", "export const viewSettings = 1;\n"],
    ["lib/llm-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], version: "4.0.0" })}\n`],
    ["lib/llm-bridge/cordis.patch.yml", "llm: dummy\n"],
    ["lib/llm-bridge/LICENSE", "x\n"],
    ["lib/llm-bridge/lib/index.js", opts.llmBody ?? "export const llm = 1;\n"],
  ];
  for (const [rel, content] of files) writeRel(root, rel, content);
  return writeComponentPayloadManifest(join(root, "lib"));
}

function tarExecutable(): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

function packNpmTar(sourceDir: string, destTgz: string): string {
  const staging = tempDir("dsh-spaces-handoff-tar-");
  cpSync(sourceDir, join(staging, "package"), { recursive: true });
  const packed = spawnSync(tarExecutable(), ["-czf", destTgz, "-C", staging, "package"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout || "tar pack failed");
  }
  return destTgz;
}

function packGroupArtifacts(
  payload: ValidatedComponentPayload,
  destDir: string,
): { pluginArtifact: string; viewBridgeArtifact: string; llmBridgeArtifact: string } {
  mkdirSync(destDir, { recursive: true });
  return {
    pluginArtifact: packNpmTar(payload.packageRoot, join(destDir, "plugin.tgz")),
    viewBridgeArtifact: packNpmTar(join(payload.packageRoot, "lib", "view-bridge"), join(destDir, "view.tgz")),
    llmBridgeArtifact: packNpmTar(join(payload.packageRoot, "lib", "llm-bridge"), join(destDir, "llm.tgz")),
  };
}

function writeFakeCli(home: string, version = "0.1.5-rc.1"): string {
  const root = join(home, "cli");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  writeFileSync(join(root, "lib", "bin.js"), "console.log('fake-dsh');\n");
  return join(root, "lib", "bin.js");
}

function writeProfile(home: string, name: string, pkg: unknown = {}): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  const record = pkg as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };
  const manifest = {
    ...record,
    dependencies: {
      "@deepseek-ai/dsh-web-app": "0.1.5-rc.1",
      ...(record.dependencies ?? {}),
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-web-app",
          ...((record.dsh?.profile?.bundles ?? []).filter((item) => item !== "@deepseek-ai/dsh-web-app")),
        ],
      },
    },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    `- id: session-persistence-jsonl\n  config:\n    root: keep\n- id: storage-json\n  config:\n    root: keep\n`,
  );
}

function dumpText(profile: string): string {
  return `
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('hub/${profile}/sessions')
- id: storage-json
  config:
    root: !!js dshHomePath('hub/${profile}/storages')
`;
}

const FIXTURE = `
const http = require("node:http");
const port = Number(process.env.DSH_TEST_PORT);
const cookieName = process.env.DSH_TEST_COOKIE_NAME || "dsh-auth-fixture";
const token = "fixture-launch-secret";
const cookie = cookieName + "=session";
const server = http.createServer((req, res) => {
  if (req.url && req.url.includes("token=" + token)) {
    res.writeHead(303, { location: "/", "set-cookie": cookie + "; HttpOnly; Path=/; SameSite=Strict" });
    return res.end();
  }
  if (req.headers.cookie !== cookie) {
    res.writeHead(401); return res.end("authentication required");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: { ok: true, value: {} } }));
});
server.listen(port, "127.0.0.1", () => console.log("dsh web: http://127.0.0.1:" + port + "/?token=" + token));
`;

function spawnFixture(): ProcessRuntime["spawn"] {
  return (args: string[], options: SpawnOptions = {}): ChildProcess => {
    const port = args[args.indexOf("--port") + 1];
    const child = spawn(process.execPath, ["-e", FIXTURE], {
      ...options,
      env: {
        ...process.env,
        ...(options.env as Record<string, string | undefined> | undefined),
        DSH_TEST_PORT: String(port),
        DSH_TEST_COOKIE_NAME: expectedAuthCookieName(`127.0.0.1:${port}`),
      },
    });
    live.push(child);
    child.once("exit", () => {
      const at = live.indexOf(child);
      if (at >= 0) live.splice(at, 1);
    });
    return child;
  };
}

function fakePatchWriter(home: string): PatchWriter {
  return {
    verify: async () => undefined,
    ensureWorkbenchPatch: () => undefined,
    patchPath: (name: string) => join(home, "profiles", name, "cordis.patch.yml"),
  } as unknown as PatchWriter;
}

function fakeMaintenance(): WorkbenchMaintenance {
  return {
    preview: async (request: WorkbenchPlanRequest): Promise<WorkbenchPlan> => ({
      id: "maint-plan",
      kind: request.kind,
      title: request.kind,
      scope: "home",
      affectedSpaceIds: [],
      runningSpaceIds: [],
      changes: ["delegated"],
      destructive: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      serviceEpoch: "a".repeat(64),
      stateRevision: "b".repeat(64),
    }),
    execute: async () => ({ snapshotId: "snap-1" }),
    plugins: async () => [],
    snapshots: async () => [],
    snapshot: async () => {
      throw new Error("missing");
    },
    runtimes: async () => [],
    backups: async () => [],
    recover: async () => undefined,
  };
}

async function startSupervisor(
  home: string,
  bin: string,
  extra: Partial<Parameters<typeof createWorkbenchSupervisor>[0]> = {},
  validated?: ValidatedComponentPayload,
): Promise<WorkbenchSupervisorHandle> {
  const handle = await createWorkbenchSupervisor({
    home,
    bin,
    port: extra.port ?? 0,
    // Disjoint from tests/workbench-supervisor.test.ts (34000-34999); files run concurrently.
    portStart: 36000,
    portEnd: 36999,
    patchWriter: fakePatchWriter(home),
    processRuntime: extra.processRuntime ?? {
      spawn: spawnFixture(),
      prepareHome: async () => undefined,
      gracefulWaitMs: 5_000,
      forceWaitMs: 20,
      readyTimeoutMs: 8_000,
      fetchTimeoutMs: 2_000,
      pollMs: 40,
      kill: async (pid, kind) => {
        if (kind === "kill") return;
        const child = live.find((item) => item.pid === pid);
        if (!child || !child.kill("SIGTERM")) throw new Error("fixture child could not be stopped");
      },
    },
    runCli: extra.runCli ?? (async (args) => {
      const profile = args[args.indexOf("--profile") + 1] ?? "web";
      if (profile === "web" && args.includes("--from-default-profile")) {
        return {
          code: 1,
          stdout: "",
          stderr: "error: profile web is shipped and cannot be a custom profile target; omit --from-default-profile",
        };
      }
      if (args.includes("--from-default-profile")) {
        writeProfile(home, profile, {
          dependencies: { "@dsh-spaces/plugin": "0.2.0" },
          dsh: { profile: { bundles: ["@dsh-spaces/plugin"] } },
        });
      } else if (profile === "web" && args.includes("--dump-config")) {
        writeProfile(home, "web");
      }
      return { code: 0, stdout: dumpText(profile), stderr: "" };
    }),
    dumpConfig: extra.dumpConfig ?? (async (profile) => dumpText(profile)),
    createMaintenance: extra.createMaintenance ?? (() => fakeMaintenance()),
    ...extra,
  }, validated);
  handles.push(handle);
  return handle;
}

async function startWithPayload(
  home: string,
  bin: string,
  payload: ValidatedComponentPayload,
): Promise<WorkbenchSupervisorHandle> {
  return startSupervisor(home, bin, {
    componentPayloadRoot: payload.payloadRootLib,
    ...packGroupArtifacts(payload, home),
  });
}

async function stopAllOwned(handle: WorkbenchSupervisorHandle): Promise<void> {
  const initial = await handle.runtime.state();
  const running = initial.spaces.filter((space) => space.managed && (space.status === "running" || space.status === "starting"));
  for (const space of running) {
    const context = {
      serviceEpoch: (await handle.runtime.state()).serviceEpoch,
      expectedRevision: (await handle.runtime.state()).revision,
    };
    const plan = await handle.runtime.preview({ kind: "space.stop", spaceId: space.id }, context);
    const requestId = `stop-${space.id}-${randomUUID().slice(0, 8)}`;
    await handle.runtime.submit(
      { kind: "plan.execute", planId: plan.id },
      requestId,
      {
        serviceEpoch: (await handle.runtime.state()).serviceEpoch,
        expectedRevision: (await handle.runtime.state()).revision,
      },
    );
    await waitJob(handle, requestId);
    const stoppedJob = await handle.runtime.job(requestId);
    assert.equal(stoppedJob.status, "succeeded", JSON.stringify(stoppedJob));
  }
}

async function waitJob(handle: WorkbenchSupervisorHandle, id: string): Promise<void> {
  await waitUntil(async () => {
    const job = await handle.runtime.job(id);
    return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
  }, `job ${id}`);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(port);
      });
    });
  });
}

function writeStubLauncher(home: string): string {
  const file = join(home, "stub-launcher.mjs");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
process.on("message", (raw) => {
  if (!raw || typeof raw !== "object" || raw.type !== "handoff-commit") return;
  const stamp = process.env.DSH_TEST_COMMIT_STAMP;
  if (stamp) {
    appendFileSync(stamp, JSON.stringify({ digest: raw.artifactDigest, argv: raw.runtime?.argv ?? [] }) + "\\n");
  }
  process.send?.({ v: 1, type: "commit-ack" });
});
setInterval(() => {}, 1e9);
`,
  );
  return file;
}
