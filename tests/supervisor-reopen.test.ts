import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HomeController, type HomeControlOwner } from "../src/adapters/node/home-controller.ts";
import { retirePreviousSupervisor } from "../src/adapters/node/supervisor-launch.ts";
import { attachExistingSupervisor } from "../packages/plugin/src/host/supervisor-attach.ts";
import { DesktopServiceClient } from "../src/adapters/desktop/service-client.ts";
import { createDesktopStartup } from "../src/main/desktop-startup.ts";
import { WorkbenchJobStore } from "../src/adapters/node/workbench-jobs.ts";
import { WorkbenchSupervisorRuntime } from "../src/adapters/node/workbench-supervisor.ts";

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

test("real exited owner: discovery is read-only, a new desktop open reaches one launch", async () => {
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
  let launches = 0;
  const client = new DesktopServiceClient({ home, payloadRoot: home,
    bootstrap: async () => {
      launches++;
      retirePreviousSupervisor(home, owner, false);
      const next = controller.acquire("web", "http://127.0.0.1:9");
      assert.notEqual(next.owner.nonce, owner.nonce);
      next.release();
      return { connected: false, origin: null, reasons: ["Injected startup failure"] };
    },
  });
  const startup = createDesktopStartup({
    connect: async () => { await client.connect(); }, status: () => client.publicState().status,
    canStart: () => true, start: () => client.start({ nodeExe: process.execPath, cliBin: "test-cli" }),
  });
  await startup.open();
  assert.equal(launches, 1);
  assert.deepEqual(client.publicState().reasons, ["Injected startup failure"]);
  await startup.environmentPrepared();
  await startup.open();
  assert.equal(launches, 1, "an in-session failure is not relaunched");
  assert.equal(existsSync(endpointFile), false);
  const evidence = readFileSync(join(controller.controlDir, "previous-controller-exit.json"), "utf8");
  assert.match(evidence, /exited-without-releasing-lease/);
  assert.ok(!evidence.includes(owner.nonce) && !evidence.includes("B".repeat(32)));
  assert.equal(readFileSync(jobs, "utf8"), '{"status":"failed","stage":"unknown"}');
  client.dispose();
});

test("dead web owner without an endpoint permits a new launch", async () => {
  const home = tempHome();
  const owner = await exitedHolder(home, "web", false);
  assert.ok("missing" in await attachExistingSupervisor({ home, allowRealHome: false }));
  retirePreviousSupervisor(home, owner, false);
  assert.equal(new HomeController(home).inspect().held, false);
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
    const runtime = Object.assign(Object.create(WorkbenchSupervisorRuntime.prototype), {
      home, controlDir: controller.controlDir, jobs, handle: lease, reasons: [],
      relinquishKind: null, relinquishJobId: null, pendingHandoff: undefined,
      options: { onNormalExit: () => { exited = true; } }, httpClose: async () => {},
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstSubmission = jobs.submit({ kind: "plan.execute", planId: "earlier-plan" }, "earlier-job", async () => { await firstGate; });
    const shutdownSubmission = jobs.submit({ kind: "plan.execute", planId: "shutdown-plan" }, "shutdown-job", async ctx => {
      ctx.phase("finalizing");
      runtime.relinquishKind = "service.shutdown";
      runtime.relinquishJobId = "shutdown-job";
      failShutdownWrite = failPersistence;
    });
    await firstSubmission;
    const earlierSettled = jobs.whenIdle().then(() => runtime.afterPlanJobSettled("earlier-job"));
    await shutdownSubmission;
    const shutdownSettled = jobs.whenIdle().then(() => runtime.afterPlanJobSettled("shutdown-job"));
    releaseFirst();
    await Promise.all([earlierSettled, shutdownSettled]);
    assert.equal(exited, !failPersistence);
    assert.equal(controller.inspect().held, failPersistence);
    const saved = JSON.parse(readFileSync(join(controller.controlDir, "jobs", "shutdown-job.json"), "utf8"));
    assert.equal(saved.status, failPersistence ? "running" : "succeeded");
    if (failPersistence) lease.release();
  }
});
