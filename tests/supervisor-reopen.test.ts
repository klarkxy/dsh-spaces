import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HomeController, type HomeControlOwner } from "../src/adapters/node/home-controller.ts";
import { retirePreviousSupervisor } from "../src/adapters/node/supervisor-launch.ts";
import { attachExistingSupervisor } from "../packages/plugin/src/host/supervisor-attach.ts";
import { WorkbenchJobStore } from "../src/adapters/node/workbench-jobs.ts";
import { SpaceMessageRouter } from "../src/adapters/node/message-bus/router.ts";
import { SupervisorLifecycle } from "../src/adapters/node/supervisor/lifecycle.ts";
import { SpaceRunRegistry } from "../src/adapters/node/supervisor/space-runs.ts";
import { SupervisorPlans } from "../src/adapters/node/supervisor/plans.ts";
import { HomeOperationLock } from "../src/adapters/node/home-operation-lock.ts";
import { ProfileRegistry } from "../src/adapters/node/profile-registry.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "spaces-reopen-"));
  homes.push(home);
  return home;
}
async function exitedHolder(home: string, kind = "web", endpoint = true, bindOrigin = true): Promise<HomeControlOwner> {
  const script = join(home, "holder.mts");
  writeFileSync(script, `
import { HomeController } from ${JSON.stringify(new URL("../src/adapters/node/home-controller.ts", import.meta.url).href)};
import { writeEndpointFile, endpointHomeId, endpointServiceEpoch } from ${JSON.stringify(new URL("../packages/plugin/src/host/supervisor-endpoint.ts", import.meta.url).href)};
import { join } from 'node:path';
const home = process.argv[2];
const controller = new HomeController(home);
const handle = controller.acquire(${JSON.stringify(kind)}, ${bindOrigin ? "'http://127.0.0.1:9'" : "undefined"});
if (${endpoint}) writeEndpointFile(join(controller.controlDir, 'endpoint.json'), { origin:'http://127.0.0.1:9',bearer:'B'.repeat(32),protocolVersion:2,homeId:endpointHomeId(home),serviceEpoch:endpointServiceEpoch(handle.owner.nonce) });
process.exit(17);
`);
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, home], {
      cwd: process.cwd(), env: { ...process.env, DSH_SPACES_HOME: home, DSH_HOME: home },
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 17 ? accept() : reject(new Error(`${code}: ${stderr}`)));
  });
  const inspection = new HomeController(home).inspect();
  assert.ok("owner" in inspection);
  assert.equal(inspection.liveness, "dead");
  return inspection.owner;
}

test("real exited owner: discovery is read-only, a new launch retires it once", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home);
  const controller = new HomeController(home);
  const ownerFile = join(controller.runDir, "owner.json");
  const endpointFile = join(controller.controlDir, "endpoint.json");
  const bytes = readFileSync(ownerFile);
  const endpointBytes = readFileSync(endpointFile);
  const jobs = join(home, "interrupted-job.json");
  writeFileSync(jobs, '{"status":"failed","stage":"unknown"}');
  const attached = await attachExistingSupervisor({ home, allowRealHome: false });
  assert.ok("missing" in attached && attached.previousOwner);
  assert.deepEqual(readFileSync(ownerFile), bytes);
  assert.deepEqual(readFileSync(endpointFile), endpointBytes);
  assert.throws(() => controller.acquire("web"), /dead pid/);
  retirePreviousSupervisor(home, owner, false);
  const next = controller.acquire("web", "http://127.0.0.1:9");
  assert.notEqual(next.owner.nonce, owner.nonce);
  next.release();
  assert.equal(existsSync(endpointFile), false);
  const evidence = readFileSync(join(controller.controlDir, "previous-controller-exit.json"), "utf8");
  assert.match(evidence, /exited-without-releasing-lease/);
  assert.ok(!evidence.includes(owner.nonce) && !evidence.includes("B".repeat(32)));
  assert.equal(readFileSync(jobs, "utf8"), '{"status":"failed","stage":"unknown"}');
});

test("dead web owner without an endpoint permits a new launch", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home, "web", false);
  assert.ok("missing" in await attachExistingSupervisor({ home, allowRealHome: false }));
  retirePreviousSupervisor(home, owner, false);
  assert.equal(new HomeController(home).inspect().held, false);
});

test("a dead owner with unfinished maintenance retains its lease, endpoint and evidence", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home);
  const controller = new HomeController(home);
  const ownerFile = join(controller.runDir, "owner.json");
  const endpointFile = join(controller.controlDir, "endpoint.json");
  const ownerBytes = readFileSync(ownerFile), endpointBytes = readFileSync(endpointFile);
  for (const relative of [
    ".dsh-spaces-restore/journal.json", ".dsh-spaces-upgrade/journal.json",
    ".dsh-spaces-mutation.json", ".dsh-spaces-control/plugin-mutation.json",
    ".dsh-spaces-control/workbench-upgrade.json", ".dsh-spaces-control/manager-bootstrap.json",
    ".dsh-spaces-lock/owner.json",
  ]) {
    const marker = join(home, relative);
    mkdirSync(join(marker, ".."), { recursive: true });
    writeFileSync(marker, "{unfinished");
    assert.throws(() => retirePreviousSupervisor(home, owner, false), /Unfinished Home maintenance/);
    assert.deepEqual(readFileSync(ownerFile), ownerBytes);
    assert.deepEqual(readFileSync(endpointFile), endpointBytes);
    assert.equal(readFileSync(marker, "utf8"), "{unfinished");
    assert.equal(existsSync(join(controller.controlDir, "previous-controller-exit.json")), false);
    rmSync(marker);
  }
});

test("a toolchain record superseded by a host update does not block retiring a dead owner", async () => {
  for (const mode of ["version-changed", "binary-gone"]) {
    const home = tempHome();
    const owner = await exitedHolder(home);
    const controller = new HomeController(home);
    const cliRoot = join(home, "cli");
    mkdirSync(join(cliRoot, "lib"), { recursive: true });
    writeFileSync(join(cliRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0-rc.4" }));
    const bin = mode === "binary-gone" ? join(home, "removed", "lib", "bin.js") : join(cliRoot, "lib", "bin.js");
    if (mode === "version-changed") writeFileSync(bin, "export {};");
    const snapshots = tempHome();
    writeFileSync(join(controller.controlDir, "toolchain.json"), JSON.stringify({
      version: 1, bin, nodeExe: process.execPath, dshVersion: "0.2.0-rc.2", snapshotRoot: snapshots,
    }));
    retirePreviousSupervisor(home, owner, false);
    assert.equal(existsSync(join(controller.controlDir, "previous-controller-exit.json")), true, mode);
    assert.equal(existsSync(join(controller.controlDir, "endpoint.json")), false, mode);
  }
});

test("pending restore evidence in a stale record's snapshot root still prevents lease retirement", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home);
  const controller = new HomeController(home);
  const snapshots = tempHome();
  writeFileSync(join(snapshots, "pending-restore.json"), "{unfinished");
  writeFileSync(join(controller.controlDir, "toolchain.json"), JSON.stringify({
    version: 1, bin: join(home, "gone", "lib", "bin.js"), nodeExe: process.execPath, dshVersion: "0.2.0-rc.2", snapshotRoot: snapshots,
  }));
  assert.throws(() => retirePreviousSupervisor(home, owner, false), /Unfinished Home maintenance/);
  assert.equal(existsSync(join(controller.controlDir, "previous-controller-exit.json")), false);
});

test("pending restore evidence in bound, explicit and default snapshot roots prevents lease retirement", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home);
  const controller = new HomeController(home);
  const ownerFile = join(controller.runDir, "owner.json");
  const endpointFile = join(controller.controlDir, "endpoint.json");
  const ownerBytes = readFileSync(ownerFile), endpointBytes = readFileSync(endpointFile);
  const toolchain = join(controller.controlDir, "toolchain.json");
  const cliRoot = join(home, "cli");
  mkdirSync(join(cliRoot, "lib"), { recursive: true });
  writeFileSync(join(cliRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0-rc.2" }));
  const bin = join(cliRoot, "lib", "bin.js");
  writeFileSync(bin, "export {};");
  for (const mode of ["bound", "explicit", "default"]) {
    const root = mode === "default" ? home + "-snapshots" : tempHome();
    if (mode === "default") { mkdirSync(root); homes.push(root); }
    const pending = join(root, "pending-restore.json");
    writeFileSync(pending, "{unfinished");
    if (mode === "bound") writeFileSync(toolchain, JSON.stringify({
      version: 1, bin, nodeExe: process.execPath, dshVersion: "0.2.0-rc.2", snapshotRoot: root,
    }));
    assert.throws(() => retirePreviousSupervisor(home, owner, false, mode === "explicit" ? root : undefined), /Unfinished Home maintenance/);
    assert.deepEqual(readFileSync(ownerFile), ownerBytes);
    assert.deepEqual(readFileSync(endpointFile), endpointBytes);
    assert.equal(readFileSync(pending, "utf8"), "{unfinished");
    assert.equal(existsSync(join(controller.controlDir, "previous-controller-exit.json")), false);
    rmSync(pending);
    if (mode === "bound") rmSync(toolchain);
  }
  writeFileSync(toolchain, "{unknown snapshot binding");
  assert.throws(() => retirePreviousSupervisor(home, owner, false), /Unfinished Home maintenance/);
  assert.deepEqual(readFileSync(ownerFile), ownerBytes);
  assert.deepEqual(readFileSync(endpointFile), endpointBytes);
});

test("legacy desktop owner without an endpoint permits a new user launch only after its process exits", async () => {
  const home = tempHome();
  const controller = new HomeController(home);
  const live = controller.acquire("desktop");
  assert.ok("blocked" in await attachExistingSupervisor({ home, allowRealHome: false }));
  live.release();
  const owner = await exitedHolder(home, "desktop", false, false);
  const before = readFileSync(join(controller.runDir, "owner.json"));
  const attached = await attachExistingSupervisor({ home, allowRealHome: false });
  assert.ok("missing" in attached && attached.previousOwner?.kind === "desktop");
  assert.deepEqual(readFileSync(join(controller.runDir, "owner.json")), before);
  retirePreviousSupervisor(home, owner, false);
  const next = controller.acquire("web", "http://127.0.0.1:9");
  assert.notEqual(next.owner.nonce, owner.nonce);
  next.release();
  const evidence = JSON.parse(readFileSync(join(controller.controlDir, "previous-controller-exit.json"), "utf8"));
  assert.equal(evidence.kind, "desktop");
});

test("a launch cannot retire an owner different from the one it observed", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home);
  const controller = new HomeController(home);
  const endpointFile = join(controller.controlDir, "endpoint.json");
  const before = readFileSync(endpointFile);
  assert.throws(() => retirePreviousSupervisor(home, { ...owner, nonce: "ab".repeat(16) }, false), /changed/);
  assert.deepEqual(readFileSync(endpointFile), before);
  assert.equal(controller.inspect().held, true);
});

test("dead ownership cannot authorize removal of a mismatched endpoint", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home);
  const controller = new HomeController(home);
  const endpointFile = join(controller.controlDir, "endpoint.json");
  const endpoint = JSON.parse(readFileSync(endpointFile, "utf8"));
  endpoint.serviceEpoch = "ab".repeat(32);
  writeFileSync(endpointFile, JSON.stringify(endpoint));
  const before = readFileSync(endpointFile);
  assert.ok("blocked" in await attachExistingSupervisor({ home, allowRealHome: false }));
  assert.throws(() => retirePreviousSupervisor(home, owner, false), /could not be retired/);
  assert.deepEqual(readFileSync(endpointFile), before);
  assert.equal(controller.inspect().held, true);
});

test("dead foreign and incomplete ownership are not classified as absence", async () => {
  const foreign = tempHome();
  await exitedHolder(foreign, "desktop");
  assert.ok("blocked" in await attachExistingSupervisor({ home: foreign, allowRealHome: false }));
  const incomplete = tempHome();
  const controller = new HomeController(incomplete);
  mkdirSync(controller.runDir, { recursive: true });
  assert.ok("blocked" in await attachExistingSupervisor({ home: incomplete, allowRealHome: false }));
  assert.throws(() => retirePreviousSupervisor(incomplete, undefined, false), /changed/);
});

test("endpoint cleanup runs while ownership excludes a successor and failures propagate", () => {
  const home = tempHome();
  const controller = new HomeController(home);
  const owner = controller.acquire("web");
  assert.throws(() => owner.release(() => {
    assert.throws(() => new HomeController(home).acquire("web"), /held/);
    throw new Error("injected endpoint release failure");
  }), /injected endpoint release failure/);
  assert.equal(controller.inspect().held, true);
  owner.release();
  const successor = controller.acquire("web");
  let staleCleanupCalled = false;
  assert.throws(() => owner.release(() => { staleCleanupCalled = true; }), /nonce mismatch/);
  assert.equal(staleCleanupCalled, false);
  successor.release();
});

test("malformed dead owner metadata stays blocked and is never copied into exit evidence", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home, "web", false);
  const controller = new HomeController(home);
  const path = join(controller.runDir, "owner.json");
  for (const corrupted of [
    { ...owner, nonce: "not-an-owner-nonce" },
    { ...owner, startedAt: "not-a-date token=secret-sentinel" },
  ]) {
    writeFileSync(path, JSON.stringify(corrupted));
    const before = readFileSync(path);
    assert.ok("blocked" in await attachExistingSupervisor({ home, allowRealHome: false }));
    assert.throws(() => retirePreviousSupervisor(home, corrupted, false));
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(join(controller.controlDir, "previous-controller-exit.json")), false);
  }
});

test("a delayed launch does not relaunch after its observed owner was already retired", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home);
  retirePreviousSupervisor(home, owner, false);
  assert.throws(() => retirePreviousSupervisor(home, owner, false), /changed|already/);
});

test("an earlier queued plan cannot authorize shutdown using its own persisted success", async () => {
  for (const failPersistence of [true, false]) {
    const home = tempHome();
    const controller = new HomeController(home);
    const lease = controller.acquire("web");
    let failShutdownWrite = false;
    const jobs = new WorkbenchJobStore({ home, inject: (op, id) => {
      if (op === "write" && id === "shutdown-job" && failShutdownWrite) throw new Error("injected persistence failure");
    } });
    let exited = false;
    // Real finalization methods and job queue, with only the HTTP/CLI exit
    // ports replaced. The earlier callback sees the same shared idle queue.
    const lifecycle = new SupervisorLifecycle();
    lifecycle.handle = lease;
    const runs = new SpaceRunRegistry();
    const messageBus = new SpaceMessageRouter();
    const options = { home, bin: "", onNormalExit: () => { exited = true; } };
    const supervisorPlans = new SupervisorPlans({
      home, lifecycle, runs, messageBus, options,
      jobs: () => jobs,
      instances: () => { throw new Error("not used"); },
      lock: new HomeOperationLock(home), registry: new ProfileRegistry(home),
      now: () => new Date(),
      dashboard: () => null,
      dashboardHost: () => { throw new Error("not used"); },
      maintenance: () => null,
      closeHttp: async () => {},
      dropWritable: () => {
        lifecycle.handle?.release(() => {});
        lifecycle.handle = undefined;
      },
      requireSpace: (spaceId) => spaceId, requireManaged: (spaceId) => spaceId,
      protectSpecial: () => {}, statusOf: () => "stopped", ownedSpaceIds: () => [],
      stopOwned: async () => {}, stopOwnedAll: async () => {},
      startSpace: async () => undefined,
      currentServiceEpoch: () => "", stateRevision: () => "",
      productObservation: () => ({ serviceEpoch: "", expectedRevision: "" }),
      assertLiveContext: () => {},
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstSubmission = jobs.submit({ kind: "plan.execute", planId: "earlier-plan" }, "earlier-job", async () => { await firstGate; });
    const shutdownSubmission = jobs.submit({ kind: "plan.execute", planId: "shutdown-plan" }, "shutdown-job", async ctx => {
      ctx.phase("finalizing");
      lifecycle.relinquishKind = "service.shutdown";
      lifecycle.relinquishJobId = "shutdown-job";
      failShutdownWrite = failPersistence;
    });
    await firstSubmission;
    const earlierSettled = jobs.whenIdle().then(() => supervisorPlans.afterPlanJobSettled("earlier-job"));
    await shutdownSubmission;
    const shutdownSettled = jobs.whenIdle().then(() => supervisorPlans.afterPlanJobSettled("shutdown-job"));
    releaseFirst();
    await Promise.all([earlierSettled, shutdownSettled]);
    assert.equal(exited, !failPersistence);
    assert.equal(controller.inspect().held, failPersistence);
    const saved = JSON.parse(readFileSync(join(controller.controlDir, "jobs", "shutdown-job.json"), "utf8"));
    assert.equal(saved.status, failPersistence ? "running" : "succeeded");
    if (failPersistence) lease.release();
  }
});

test("shutdown persistence diagnostics distinguish failure before stopping from failure after stopping", async () => {
  for (const beforeStop of [true, false]) {
    const home = tempHome();
    const controller = new HomeController(home);
    const lease = controller.acquire("web");
    const ownerBefore = readFileSync(join(controller.controlDir, "run", "owner.json"));
    const lifecycle = new SupervisorLifecycle();
    lifecycle.handle = lease;
    let writes = 0;
    let stopCalls = 0;
    let normalExit = false;
    const jobs = new WorkbenchJobStore({
      home,
      inject: (operation) => {
        // Queue admission and running state precede the first stopping phase.
        if (operation === "write" && ++writes === (beforeStop ? 3 : 4)) {
          throw new Error("controlled shutdown phase persistence failure");
        }
      },
    });
    const epoch = "a".repeat(64);
    const plans = new SupervisorPlans({
      home, lifecycle, runs: new SpaceRunRegistry(), messageBus: new SpaceMessageRouter(),
      options: { home, bin: "", onNormalExit: () => { normalExit = true; } },
      lock: new HomeOperationLock(home), registry: new ProfileRegistry(home),
      now: () => new Date(), jobs: () => jobs,
      instances: () => ({ writeLifecyclePlan() {}, consumeLifecyclePlan() {} }) as never,
      dashboard: () => null, dashboardHost: () => { throw new Error("not used"); },
      maintenance: () => null, closeHttp: async () => { throw new Error("must retain HTTP"); },
      dropWritable: () => { throw new Error("must retain ownership"); },
      requireSpace: id => id, requireManaged: id => id, protectSpecial: () => {},
      statusOf: () => "running", ownedSpaceIds: () => ["spaces-hub"],
      stopOwned: async () => {}, stopOwnedAll: async () => { stopCalls++; },
      startSpace: async () => undefined, currentServiceEpoch: () => epoch,
      stateRevision: () => "revision",
      productObservation: () => ({ serviceEpoch: epoch, expectedRevision: "revision" }),
      assertLiveContext: () => {},
    });
    const plan = plans.previewLocal({ kind: "service.shutdown" });
    await jobs.submit({ kind: "plan.execute", planId: plan.id }, "phase-write-failure", async ctx => {
      lifecycle.activeJobId = "phase-write-failure";
      try { await plans.executePlan(plan.id, ctx); }
      finally { lifecycle.activeJobId = undefined; }
    });
    await jobs.whenIdle();
    await plans.afterPlanJobSettled("phase-write-failure");
    assert.equal(stopCalls, beforeStop ? 0 : 1);
    assert.equal(jobs.job("phase-write-failure").status, "failed");
    assert.equal(lifecycle.shutdownFailure, beforeStop ? "before-stop" : "final-save");
    assert.equal(normalExit, false);
    assert.deepEqual(readFileSync(join(controller.controlDir, "run", "owner.json")), ownerBefore);
    assert.throws(() => lifecycle.assertWritable(), beforeStop ? /before stopping began/ : /Owned processes stopped/);
    if (beforeStop) assert.doesNotMatch(lifecycle.reasons.join(" "), /Owned processes stopped/);
    else assert.match(lifecycle.reasons.join(" "), /Owned processes stopped/);
    lease.release();
  }
});
