import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { HomeLease } from "../../src/adapters/node/home/home-lease.ts";
import { deriveServiceEpoch, digestHomeIdentity } from "../../src/adapters/node/server/workbench-protocol.ts";
import { canonicalHome } from "../../src/adapters/node/home/home-operation-lock.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { writeEndpointFile } from "../../src/adapters/node/home/supervisor-endpoint.ts";
import { DesktopServiceRestart } from "../../packages/plugin/src/host/service-restart.ts";
import { runDesktopSpaceAction } from "../../packages/plugin/src/host/space-action.ts";
import { validDesktopSpaceAction } from "../../packages/plugin/src/types.ts";
import { readWelcomeNotice, writeWelcomeNotice } from "../../src/adapters/node/home/welcome-notice.ts";
import { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";
import type { WorkbenchApi, WorkbenchState, WorkbenchPlan } from "../../src/shared/workbench.ts";

function fixture(t: TestContext, live = true) {
  const home = mkdtempSync(join(tmpdir(), "dsh-manual-restart-"));
  const owner = new HomeLease(home, { allowRealHome: false });
  let handle = live ? owner.acquire("web", "http://127.0.0.1:34567/") : undefined;
  const endpoint = { origin: "http://127.0.0.1:34567", bearer: "a".repeat(64), protocolVersion: 2 as const,
    homeId: digestHomeIdentity(canonicalHome(home)), serviceEpoch: deriveServiceEpoch(handle?.owner.nonce ?? "a".repeat(32)) };
  const endpointFile = join(home, ".dsh-spaces-control", "endpoint.json");
  if (live) writeEndpointFile(endpointFile, endpoint);
  t.after(() => { handle?.release(); rmSync(home, { recursive: true, force: true }); });
  const state: WorkbenchState = { protocolVersion: 2, serviceEpoch: endpoint.serviceEpoch, revision: "b".repeat(64),
    availability: "ready", role: "manager", managerId: "spaces-hub", owner: { kind: "web", since: new Date().toISOString() },
    writable: true, mode: "verified-full", dshVersion: COMPATIBLE_DSH_CLI_VERSION, maintenance: false, reasons: [], jobs: [],
    spaces: ["spaces-hub", "coding"].map(id => ({ id, displayName: id === "coding" ? "Coding" : "Manager", isHost: id === "spaces-hub",
      hasWebApp: true, icon: "", status: "running", generation: 1, managed: true, dshVersion: null })) };
  let starts = 0, stops = 0, plans = 0, status = "succeeded", refuseSubmit = false, release = true;
  const saved = join(home, ".dsh-spaces-control", "jobs", "shutdown-job.json");
  const api = { state: async () => state,
    preview: async () => ({ id: "shutdown-plan-" + ++plans, kind: "service.shutdown", title: "shutdown", scope: "controller",
      affectedSpaceIds: state.spaces.map(s => s.id), runningSpaceIds: state.spaces.filter(s => s.status === "running").map(s => s.id),
      changes: [], destructive: true, expiresAt: new Date(Date.now() + 300000).toISOString(), serviceEpoch: state.serviceEpoch, stateRevision: state.revision } satisfies WorkbenchPlan),
    submit: async (command: { planId: string }, requestId: string, context: { expectedRevision: string }) => {
      if (refuseSubmit || context.expectedRevision !== state.revision) throw Error("state conflict");
      stops++;
      mkdirSync(join(home, ".dsh-spaces-control", "jobs"), { recursive: true });
      writeFileSync(saved, JSON.stringify({ schemaVersion: 1, id: "shutdown-job", requestId, command: { kind: "plan.execute", planId: command.planId }, status }));
      if (status === "succeeded" && release) { handle?.release(); handle = undefined; unlinkSync(endpointFile); }
      return { id: "shutdown-job" };
    },
  } as unknown as WorkbenchApi;
  const fetchState = async () => new Response(JSON.stringify({ ok: true, value: state }), { headers: { "content-type": "application/json" } });
  const operation = () => new DesktopServiceRestart({ home, allowRealHome: false, assertDesktop() {}, fetch: fetchState, connect: () => api, timeoutMs: 50,
    launch: async (epoch) => { starts++; assert.equal(owner.inspect().held, false); if (live) assert.equal(epoch, endpoint.serviceEpoch);
      return { ok: true, connected: true, unavailable: false, origin: "http://127.0.0.1:34568", reasons: [] }; } });
  return { home, endpoint, endpointFile, state, api, fetchState, operation, saved,
    counts: () => ({ starts, stops, plans }), setStatus(value: string) { status = value; }, keepLease() { release = false; },
    refuse() { refuseSubmit = true; }, replaceOwner() { handle!.release(); handle = owner.acquire("web", endpoint.origin + "/");
      endpoint.serviceEpoch = deriveServiceEpoch(handle.owner.nonce); state.serviceEpoch = endpoint.serviceEpoch; writeEndpointFile(endpointFile, endpoint); },
  };
}

test("manual restart previews real affected spaces, performs one normal shutdown and never replays confirmation", async t => {
  const f = fixture(t), restart = f.operation();
  const preview = await restart.preview();
  assert.deepEqual(preview.spaces.map(s => [s.id, s.running]), [["spaces-hub", true], ["coding", true]]);
  assert.equal(preview.action, "restart"); assert.deepEqual(f.counts(), { starts: 0, stops: 0, plans: 1 });
  assert.equal(JSON.stringify(preview).includes(f.endpoint.bearer), false);
  assert.equal((await restart.execute(preview.confirmationId)).ok, true);
  assert.equal(JSON.parse(readFileSync(f.saved, "utf8")).status, "succeeded");
  await assert.rejects(restart.execute(preview.confirmationId), /invalid or expired/);
  assert.deepEqual(f.counts(), { starts: 1, stops: 1, plans: 1 });
});

test("missing service needs explicit confirmation and launches only once", async t => {
  const f = fixture(t, false), restart = f.operation(), preview = await restart.preview();
  assert.equal(preview.action, "start"); assert.deepEqual(preview.spaces, []);
  assert.equal(f.counts().starts, 0);
  await restart.execute(preview.confirmationId);
  assert.deepEqual(f.counts(), { starts: 1, stops: 0, plans: 0 });
});

for (const change of ["owner", "revision", "expired", "invalid", "refused"] as const) {
  test(`manual confirmation rejects ${change} without launching`, async t => {
    const f = fixture(t), restart = f.operation(), preview = await restart.preview();
    if (change === "owner") f.replaceOwner();
    if (change === "revision") f.state.revision = "c".repeat(64);
    if (change === "expired") t.mock.method(Date, "now", () => Date.parse(preview.expiresAt) + 1);
    if (change === "refused") f.refuse();
    await assert.rejects(restart.execute(change === "invalid" ? "x" : preview.confirmationId));
    assert.equal(f.counts().starts, 0); assert.equal(f.counts().stops, 0);
  });
}

for (const failure of ["failed", "cancelled", "running", "unreadable", "lease-held"] as const) {
  test(`shutdown ${failure} prevents launch and preserves exact job evidence`, async t => {
    const f = fixture(t), restart = f.operation(), preview = await restart.preview();
    if (failure === "lease-held") f.keepLease(); else f.setStatus(failure);
    await assert.rejects(restart.execute(preview.confirmationId));
    const bytes = readFileSync(f.saved, "utf8");
    assert.equal(f.counts().starts, 0); assert.equal(f.counts().stops, 1);
    await assert.rejects(restart.execute(preview.confirmationId));
    assert.equal(readFileSync(f.saved, "utf8"), bytes);
  });
}

test("maintenance and failed authentication cannot produce a restart confirmation", async t => {
  const f = fixture(t); f.state.maintenance = true;
  await assert.rejects(f.operation().preview(), /normal shutdown/);
  f.state.maintenance = false;
  const bytes = readFileSync(f.endpointFile, "utf8");
  writeFileSync(f.endpointFile, "damaged");
  await assert.rejects(f.operation().preview());
  assert.deepEqual(f.counts(), { starts: 0, stops: 0, plans: 0 });
  assert.equal(readFileSync(f.endpointFile, "utf8"), "damaged");
  writeFileSync(f.endpointFile, bytes);
});

test("concurrent confirmation cannot duplicate shutdown or launch", async t => {
  const f = fixture(t), restart = f.operation(), preview = await restart.preview();
  const results = await Promise.allSettled([restart.execute(preview.confirmationId), restart.execute(preview.confirmationId)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.counts().starts, 1); assert.equal(f.counts().stops, 1);
});

test("guide restart privilege is restricted to the actual Desktop profile", async t => {
  const f = fixture(t, false);
  const sdk = join(f.home, "node_modules/@deepseek-ai/dsh"), bin = join(sdk, "lib/bin.js");
  mkdirSync(join(sdk, "lib"), { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION })); writeFileSync(bin, "");
  for (const profile of ["desktop", "coding"]) {
    const dir = join(f.home, "profiles", profile); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), "{}");
    const runtime = new WorkbenchHostRuntime({ home: f.home, argv: [process.execPath, bin, "--profile", profile], baseUrl: pathToFileURL(dir).href,
      env: { DSH_HOME: f.home }, fetch: f.fetchState, connect: () => f.api });
    if (profile === "desktop") assert.equal((await runtime.previewServiceRestart()).action, "start");
    else assert.throws(() => runtime.previewServiceRestart(), /confirmed Desktop/);
    if (profile !== "desktop") await assert.rejects(runtime.spaceAction({ spaceId: "coding", action: "open", serviceEpoch: f.state.serviceEpoch }), /confirmed Desktop/);
  }
});

test("Desktop child actions use current state, one CAS submit and the exact normal stop/restart plan", async t => {
  const f = fixture(t);
  const commands: unknown[] = [], previews: string[] = [];
  let outcome = "succeeded", polls = 0;
  const api = { ...f.api,
    preview: async (request: { kind: string }, context: { expectedRevision: string }) => {
      previews.push(request.kind); assert.equal(context.expectedRevision, f.state.revision);
      return { id: "child-plan", kind: request.kind, scope: "space", destructive: false, affectedSpaceIds: ["coding"], taskActivity: "idle",
        serviceEpoch: f.state.serviceEpoch, stateRevision: f.state.revision, expiresAt: new Date(Date.now() + 50000).toISOString() };
    },
    submit: async (command: unknown, requestId: string, context: { expectedRevision: string }) => {
      commands.push(command); assert.equal(context.expectedRevision, f.state.revision);
      if (outcome === "succeeded") f.state.spaces[1].status = previews.at(-1) === "space.stop" ? "stopped" : "running";
      return { id: "child-job", requestId, status: outcome, message: "launch failed", error: outcome === "failed" ? { message: "original failure" } : undefined };
    },
    job: async () => { polls++; throw Error("read failed"); },
  } as unknown as WorkbenchApi;
  const request = { spaceId: "coding", action: "open" as const, serviceEpoch: f.state.serviceEpoch };
  await runDesktopSpaceAction(api, request); assert.equal(commands.length, 0, "running means open without starting");
  f.state.spaces[1].status = "stopped";
  await runDesktopSpaceAction(api, request);
  assert.deepEqual(commands, [{ kind: "space.start", spaceId: "coding" }]);
  await runDesktopSpaceAction(api, { ...request, action: "stop" });
  await runDesktopSpaceAction(api, { ...request, action: "restart" });
  assert.deepEqual(previews, ["space.stop", "space.restart"]);
  assert.deepEqual(commands.slice(1), [{ kind: "plan.execute", planId: "child-plan" }, { kind: "plan.execute", planId: "child-plan" }]);
  outcome = "failed"; f.state.spaces[1].status = "stopped";
  await assert.rejects(runDesktopSpaceAction(api, request), /original failure/);
  assert.equal(commands.length, 4); assert.equal(polls, 0);
  outcome = "running";
  await assert.rejects(runDesktopSpaceAction(api, request), /read failed/);
  assert.equal(commands.length, 5); assert.equal(polls, 1, "a failed observation never resubmits");
});

test("Desktop child actions reject protected targets, stale service, unavailable state and expanded plans", async t => {
  const f = fixture(t), request = { spaceId: "coding", action: "restart" as const, serviceEpoch: f.state.serviceEpoch };
  for (const spaceId of ["spaces-hub", "desktop", "web", "missing"]) await assert.rejects(runDesktopSpaceAction(f.api, { ...request, spaceId }), /managed child/);
  await assert.rejects(runDesktopSpaceAction(f.api, { ...request, serviceEpoch: "f".repeat(64) }), /changed/);
  f.state.maintenance = true; await assert.rejects(runDesktopSpaceAction(f.api, request), /unavailable/); f.state.maintenance = false;
  f.state.writable = false; await assert.rejects(runDesktopSpaceAction(f.api, request), /read-only/); f.state.writable = true;
  f.state.spaces[1].managed = false; await assert.rejects(runDesktopSpaceAction(f.api, request), /managed child/); f.state.spaces[1].managed = true;
  await assert.rejects(runDesktopSpaceAction(f.api, request), /new review/);
  assert.equal(f.counts().stops, 0);
  for (const invalid of [{ ...request, action: "delete" }, { ...request, spaceId: "../coding" }, { ...request, extra: true }]) assert.equal(validDesktopSpaceAction(invalid), false);
});

test("an already starting child is observed without a duplicate start", async t => {
  const f = fixture(t); f.state.spaces[1].status = "starting";
  let reads = 0;
  const api = { ...f.api, state: async () => { if (++reads === 2) f.state.spaces[1].status = "running"; return f.state; } };
  await runDesktopSpaceAction(api, { spaceId: "coding", action: "open", serviceEpoch: f.state.serviceEpoch });
  assert.equal(reads, 2); assert.equal(f.counts().stops, 0);
});

test("verified Desktop runtime attaches without bootstrap and excludes concurrent child requests", async t => {
  const f = fixture(t);
  const sdk = join(f.home, "node_modules/@deepseek-ai/dsh"), bin = join(sdk, "lib/bin.js");
  mkdirSync(join(sdk, "lib"), { recursive: true }); writeFileSync(bin, "");
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION }));
  const dir = join(f.home, "profiles/desktop"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), "{}");
  let starts = 0, reads = 0;
  f.state.spaces[1].status = "stopped";
  const api = { ...f.api, state: async () => { reads++; return f.state; }, submit: async (command: unknown, requestId: string) => {
    assert.deepEqual(command, { kind: "space.start", spaceId: "coding" }); starts++; f.state.spaces[1].status = "running";
    return { id: "start-job", requestId, status: "succeeded" };
  } } as unknown as WorkbenchApi;
  const runtime = new WorkbenchHostRuntime({ home: f.home, argv: [process.execPath, bin, "--profile", "desktop"], baseUrl: pathToFileURL(dir).href,
    env: { DSH_HOME: f.home }, fetch: f.fetchState, connect: () => api, bootstrap: async () => { throw Error("must not bootstrap"); } });
  const request = { spaceId: "coding", action: "open" as const, serviceEpoch: f.state.serviceEpoch };
  const first = runtime.spaceAction(request);
  await assert.rejects(runtime.spaceAction(request), /already in progress/);
  assert.equal((await first).spaces.find(row => row.id === "coding")?.status, "running");
  assert.equal(reads, 2, "one initial observation and one completion observation");
  await runtime.spaceAction(request);
  assert.equal(reads, 3, "an already-running open uses one authority read");
  assert.equal(starts, 1);
});

test("explicit stop confirms durable completion without starting a replacement service", async t => {
  const f = fixture(t), operation = f.operation(), preview = await operation.preview(true);
  assert.equal(preview.action, "stop");
  await assert.rejects(operation.execute(preview.confirmationId), /invalid or expired/);
  const result = await operation.execute(preview.confirmationId, true);
  assert.equal(result.ok, true); assert.equal(result.connected, false);
  assert.deepEqual(f.counts(), { starts: 0, stops: 1, plans: 1 });
  await assert.rejects(operation.execute(preview.confirmationId, true), /invalid or expired/);
});

test("welcome notice sharing only preserves an actual version acknowledgement", t => {
  const f = fixture(t, false);
  mkdirSync(join(f.home, "profiles", "desktop"), { recursive: true });
  assert.equal(readWelcomeNotice(f.home), undefined);
  writeWelcomeNotice(f.home, undefined);
  assert.equal(readWelcomeNotice(f.home), undefined);
  writeWelcomeNotice(f.home, "2026-09-28.1");
  assert.equal(readWelcomeNotice(f.home), "2026-09-28.1");
  writeWelcomeNotice(f.home, "2026-10-26.1");
  assert.equal(readWelcomeNotice(f.home), "2026-10-26.1");
});

test("busy and unknown child tasks need generation-bound consent before a stop", async t => {
  const f = fixture(t); let submitted = 0;
  for (const taskActivity of ["busy", "unknown"] as const) {
    const api = { ...f.api, preview: async () => ({ id: "impact", kind: "space.stop", scope: "space", destructive: false,
      affectedSpaceIds: ["coding"], taskActivity, serviceEpoch: f.state.serviceEpoch, stateRevision: f.state.revision,
      expiresAt: new Date(Date.now() + 50000).toISOString() }),
      submit: async (_command: unknown, requestId: string) => { submitted++; f.state.spaces[1].status = "stopped";
        return { id: "stopped", requestId, status: "succeeded" }; } } as unknown as WorkbenchApi;
    f.state.spaces[1].status = "running";
    const request = { spaceId: "coding", action: "stop" as const, serviceEpoch: f.state.serviceEpoch };
    await assert.rejects(runDesktopSpaceAction(api, request), /confirm|确认/i);
    const count = submitted;
    await assert.rejects(runDesktopSpaceAction(api, { ...request, interruptAccepted: true, expectedGeneration: 9999 }), /changed|变化/i);
    assert.equal(submitted, count);
    await runDesktopSpaceAction(api, { ...request, interruptAccepted: true, expectedGeneration: f.state.spaces[1].generation! });
    assert.equal(submitted, count + 1);
  }
});

test("Desktop child actions are refused while a space.create is active", async (t) => {
  const f = fixture(t);
  const activeCreate = { id: "create-job", requestId: "create-job", kind: "space.create", status: "running", phase: "install",
    message: "DSH 0.9.9", affectedSpaceIds: ["new-space"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    canCancel: false, subject: { displayName: "New Space", icon: "whale" } };
  f.state.jobs = [activeCreate] as never;
  const calls: string[] = [];
  const api = { ...f.api,
    preview: async () => { calls.push("preview"); throw Error("unreachable"); },
    submit: async () => { calls.push("submit"); throw Error("unreachable"); },
  } as unknown as WorkbenchApi;
  for (const action of ["open", "start"] as const) {
    f.state.spaces[1].status = "stopped";
    await assert.rejects(runDesktopSpaceAction(api, { spaceId: "coding", action, serviceEpoch: f.state.serviceEpoch }), /正在创建空间「New Space」/);
  }
  for (const action of ["stop", "restart"] as const) {
    f.state.spaces[1].status = "running";
    await assert.rejects(runDesktopSpaceAction(api, { spaceId: "coding", action, serviceEpoch: f.state.serviceEpoch }), /正在创建空间「New Space」/);
  }
  f.state.spaces[1].status = "running";
  const state = await runDesktopSpaceAction(api, { spaceId: "coding", action: "open", serviceEpoch: f.state.serviceEpoch });
  assert.equal(state.spaces[1].status, "running");
  assert.deepEqual(calls, []);
});
