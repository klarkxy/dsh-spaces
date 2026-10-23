import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { HomeController } from "../src/adapters/node/home-controller.ts";
import { deriveServiceEpoch, digestHomeIdentity } from "../src/adapters/node/workbench-protocol.ts";
import { canonicalHome } from "../src/adapters/node/home-operation-lock.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../src/adapters/node/spaces-control.ts";
import { writeEndpointFile } from "../src/adapters/node/supervisor-endpoint.ts";
import { DesktopServiceRestart } from "../packages/plugin/src/host/service-restart.ts";
import { WorkbenchHostRuntime } from "../packages/plugin/src/host/runtime.ts";
import type { WorkbenchApi, WorkbenchState, WorkbenchPlan } from "../src/shared/workbench.ts";

function fixture(t: TestContext, live = true) {
  const home = mkdtempSync(join(tmpdir(), "dsh-manual-restart-"));
  const owner = new HomeController(home, { allowRealHome: false });
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
  }
});
