import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Script } from "node:vm";
import { renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";
import { WorkbenchController } from "../../packages/plugin/src/workbench/store.ts";
import { parseSurfaceSelection, attachSurfaceBridge } from "../../packages/plugin/src/workbench/surface-bridge.ts";
import type { WorkbenchApi, WorkbenchState, WorkbenchView } from "../../src/shared/workbench.ts";

const epoch = "a".repeat(64), origin = "http://127.0.0.1:3101";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const state: WorkbenchState = {
    protocolVersion: 2, serviceEpoch: epoch, revision: "b".repeat(64), availability: "ready", role: "manager",
    managerId: "hub", owner: { kind: "web", since: "2026-10-27T00:00:00Z" }, writable: true,
    mode: "verified-full", dshVersion: "0.2.1-rc.2", maintenance: false, reasons: [], jobs: [],
    spaces: ["hub", "alpha", "beta"].map(id => ({ id, displayName: id, isHost: id === "hub", hasWebApp: true,
      icon: "", status: "running", generation: 1, managed: true, dshVersion: null })),
  };
  let reads = 0, views = 0;
  const timers: Array<() => void> = [];
  const api = {
    state: async () => { reads++; return structuredClone(state); },
    view: async (spaceId: string): Promise<WorkbenchView> => {
      views++;
      return { spaceId, generation: state.spaces.find(s => s.id === spaceId)!.generation, serviceEpoch: state.serviceEpoch,
        origin, entryOrigin: "http://127.0.0.1:3100", entryPath: `/view/${spaceId}`, channel: `channel-${spaceId}` };
    },
    submit: async () => { throw Error("navigation must not submit commands"); },
  } as unknown as WorkbenchApi;
  const controller = new WorkbenchController(api, { storage: { getItem: () => null, setItem() {} },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, hidden: () => false,
    onVisibilityChange: () => () => {}, addMessageListener: () => () => {} });
  t.after(() => controller.stop());
  const windows = new Map<string, object>();
  const message = (id: string, status: "ready" | "failed" | "disconnected") => {
    const view = controller.views.get(id)!.view!;
    controller.handleMessage({ origin, source: windows.get(id), data: { ...view, source: "dsh-spaces-view", state: status } });
  };
  const ready = async (id: string) => {
    controller.selectSpace(id); await flush();
    const child = {}; windows.set(id, child);
    controller.registerIframeWindow(id, state.spaces.find(s => s.id === id)!.generation, child);
    message(id, "ready");
    assert.equal(controller.getSnapshot().selected, id);
  };
  return { state, api, controller, ready, message, timers, counts: () => ({ reads, views }) };
}

test("warm host switching commits immediately with no state read, entry request or remount", async t => {
  const f = fixture(t), c = f.controller;
  await c.poll(); await f.ready("alpha"); await f.ready("beta"); c.selectHome();
  const alpha = c.views.get("alpha"), beta = c.views.get("beta"), before = f.counts();
  for (const id of ["alpha", "beta", "alpha"]) {
    const selecting = c.selectRunningSpace(id, () => true, 1);
    assert.equal(c.getSnapshot().selected, id, "the page is selected before any asynchronous read");
    assert.equal(c.getSnapshot().pendingId, null);
    assert.equal(await selecting, true);
  }
  assert.deepEqual(f.counts(), before);
  assert.equal(c.views.get("alpha"), alpha); assert.equal(c.views.get("beta"), beta);
});

test("first or legacy host selection reads authority once before loading", async t => {
  const f = fixture(t), c = f.controller;
  await c.poll();
  assert.equal(await c.selectRunningSpace("alpha", () => true, 1), true); await flush();
  assert.deepEqual(f.counts(), { reads: 2, views: 1 });
  await f.ready("alpha"); c.selectHome();
  const before = f.counts();
  assert.equal(await c.selectRunningSpace("alpha"), true);
  assert.deepEqual(f.counts(), { ...before, reads: before.reads + 1 });
});

for (const change of ["stopped", "stopping", "crashed", "removed", "generation", "epoch", "no-web", "maintenance", "unavailable",
  "failed", "disconnected", "unmounted", "desktop-generation"] as const) {
  test(`warm cache refuses immediate reuse after ${change}`, async t => {
    const f = fixture(t), c = f.controller;
    await c.poll(); await f.ready("alpha"); c.selectHome();
    const space = f.state.spaces[1];
    if (["stopped", "stopping", "crashed"].includes(change)) space.status = change as "stopped" | "stopping" | "crashed";
    if (change === "removed") f.state.spaces.splice(1, 1);
    if (change === "generation") space.generation++;
    if (change === "epoch") f.state.serviceEpoch = "c".repeat(64);
    if (change === "no-web") space.hasWebApp = false;
    if (change === "maintenance") f.state.maintenance = true;
    if (change === "unavailable") f.state.availability = "unavailable";
    await c.poll();
    if (change === "failed" || change === "disconnected") f.message("alpha", change);
    if (change === "unmounted") c.registerIframeWindow("alpha", 1, null);
    let release!: (state: WorkbenchState) => void;
    f.api.state = () => new Promise(resolve => { release = resolve; });
    const selecting = c.selectRunningSpace("alpha", () => true, change === "desktop-generation" ? 2 : 1);
    assert.equal(c.getSnapshot().selected, "home");
    if (change === "failed" || change === "disconnected") {
      assert.equal(await selecting, false); assert.equal(release, undefined, "failed views are not reconnected"); return;
    }
    assert.ok(release, "invalid cache must consult authority");
    release(structuredClone(f.state)); await selecting;
  });
}

test("a delayed selection read cannot resurrect a stopped cached page", async t => {
  const f = fixture(t), c = f.controller;
  await c.poll(); await f.ready("alpha"); c.selectHome();
  const stale = structuredClone(f.state), read = f.api.state;
  let release!: (value: WorkbenchState) => void;
  f.api.state = () => new Promise(resolve => { release = resolve; });
  const selecting = c.selectRunningSpace("alpha", () => true, 2);
  f.state.spaces[1].status = "stopped"; f.api.state = read; await c.poll();
  release(stale);
  assert.equal(await selecting, false); assert.equal(c.views.get("alpha"), undefined);
  assert.equal(c.getSnapshot().selected, "home");
});

test("an unfinished newer poll cannot make a fresh selection reuse the old generation", async t => {
  const f = fixture(t), c = f.controller;
  await c.poll(); await f.ready("alpha"); c.selectHome();
  const responses: Array<(value: WorkbenchState) => void> = [];
  f.api.state = () => new Promise(resolve => { responses.push(resolve); });
  const selecting = c.selectRunningSpace("alpha", () => true, 2);
  const polling = c.poll();
  f.state.spaces[1].generation = 2;
  responses[0](structuredClone(f.state));
  assert.equal(await selecting, true); await flush();
  assert.equal(c.views.get("alpha")?.generation, 2);
  assert.equal(c.views.get("alpha")?.status, "pending", "the new page needs its own handshake");
  assert.equal(c.getSnapshot().visibleSpaceId, null);
  responses[1](structuredClone(f.state)); await polling;
});

test("selection keeps background invalidation polling alive and a failed read ends it", async t => {
  const f = fixture(t), c = f.controller;
  c.start(); await flush();
  const read = f.api.state;
  let release!: (value: WorkbenchState) => void;
  f.api.state = () => new Promise(resolve => { release = resolve; });
  const polling = c.poll();
  f.api.state = read;
  const before = f.timers.length;
  assert.equal(await c.selectRunningSpace("alpha", () => true, 1), true);
  release(structuredClone(f.state)); await polling;
  assert.ok(f.timers.length > before);
  f.state.spaces[1].status = "stopped";
  f.timers.at(-1)!(); await flush();
  assert.equal(c.getSnapshot().state?.spaces[1].status, "stopped");
  c.selectHome();
  f.api.state = async () => { throw Error("discovery failed"); };
  const scheduled = f.timers.length;
  assert.equal(await c.selectRunningSpace("beta", () => true, 1), false);
  assert.equal(f.timers.length, scheduled, "no retry timer after failed discovery");
});

test("failed discovery and superseded intents cannot use the warm cache", async t => {
  const f = fixture(t), c = f.controller;
  await c.poll(); await f.ready("alpha"); c.selectHome();
  assert.equal(await c.selectRunningSpace("alpha", () => false, 1), false);
  f.api.state = async () => { throw Error("service lost"); }; await c.poll();
  assert.equal(await c.selectRunningSpace("alpha", () => true, 1), false);
  assert.equal(c.getSnapshot().selected, "home");
});

test("a pending poll cannot erase a selection discovery failure", async t => {
  const f = fixture(t), c = f.controller;
  await c.poll();
  let fail!: (error: Error) => void, finish!: (value: WorkbenchState) => void;
  f.api.state = () => new Promise((_resolve, reject) => { fail = reject; });
  const selecting = c.selectRunningSpace("alpha", () => true, 1);
  f.api.state = () => new Promise(resolve => { finish = resolve; });
  const polling = c.poll();
  fail(Error("original discovery failure")); assert.equal(await selecting, false);
  const error = c.getSnapshot().error; assert.ok(error);
  finish(structuredClone(f.state)); await polling;
  assert.equal(c.getSnapshot().error, error);
  assert.equal(await c.selectRunningSpace("alpha", () => true, 1), false);
});

test("an explicit newer running generation can replace an old failed surface without retrying it", async t => {
  const f = fixture(t), c = f.controller;
  await c.poll();
  c.selectSpace("alpha"); await flush();
  const old = {}; c.registerIframeWindow("alpha", 1, old);
  c.handleMessage({ origin, source: old, data: { ...c.views.get("alpha")!.view, source: "dsh-spaces-view", state: "failed" } });
  assert.equal(c.getSnapshot().viewError?.spaceId, "alpha");
  f.state.spaces[1].generation = 2;
  const replies: Array<{ type: string }> = [], parent = { postMessage: (data: { type: string }) => replies.push(data) };
  let receive!: (event: MessageEvent) => void;
  const view = { parentOrigin: origin, serviceEpoch: epoch, spaceId: "hub", generation: 1, channel: "manager" };
  const dispose = attachSurfaceBridge(c, view, parent, listener => { receive = listener; return () => {}; }); t.after(dispose);
  receive({ origin, source: parent, data: { source: "dsh-spaces-surface-parent", type: "select", requestId: 1,
    serviceEpoch: epoch, spaceId: "hub", generation: 1, channel: "manager", target: "alpha", targetGeneration: 2 } } as unknown as MessageEvent);
  await flush();
  assert.equal(c.views.get("alpha")?.generation, 2);
  assert.equal(c.views.get("alpha")?.status, "pending");
  const fresh = {}; c.registerIframeWindow("alpha", 2, fresh);
  c.handleMessage({ origin, source: fresh, data: { ...c.views.get("alpha")!.view, source: "dsh-spaces-view", state: "ready" } });
  await flush();
  assert.deepEqual(replies.map(row => row.type), ["ready", "selected"]);
  assert.equal(c.getSnapshot().selected, "alpha"); assert.equal(f.counts().views, 2);
});

test("surface generation hint stays inside the authenticated presentation envelope", () => {
  const parent = {}, view = { parentOrigin: origin, spaceId: "hub", generation: 1, serviceEpoch: epoch, channel: "manager" };
  const data = { ...view, parentOrigin: undefined, source: "dsh-spaces-surface-parent", type: "select", requestId: 1, target: "alpha", targetGeneration: 2 };
  Reflect.deleteProperty(data, "parentOrigin");
  const event = { source: parent, origin, data };
  assert.deepEqual(parseSurfaceSelection(event, parent, view), { requestId: 1, target: "alpha", targetGeneration: 2 });
  for (const patch of [{ targetGeneration: -1 }, { targetGeneration: 0.5 }, { targetGeneration: "2" },
    { targetGeneration: Number.MAX_SAFE_INTEGER + 1 }, { targetGeneration: undefined }, { target: "@settings" }, { target: null }, { execute: "x" }]) {
    assert.equal(parseSurfaceSelection({ ...event, data: { ...data, ...patch } }, parent, view), null);
  }
  assert.equal(parseSurfaceSelection({ ...event, source: {} }, parent, view), null);
  assert.equal(parseSurfaceSelection({ ...event, origin: "http://127.0.0.1:9" }, parent, view), null);
});

test("native portal forwards the generation hint and acknowledges only the current request", () => {
  const replies: unknown[] = [], writes: string[] = [];
  const location = { hash: "#select/2/alpha/3", replace(hash: string) { this.hash = hash; writes.push(hash); } };
  const source = renderPortalPage({ parentOrigin: origin, channel: "b".repeat(32) }, "http://127.0.0.1:3102", true)
    .split("<script>")[1].split("</script>")[0];
  new Script(source + `
    snapshot = { managerId: "hub", spaces: [{ id: "alpha" }] };
    managerView = { spaceId: "hub", serviceEpoch: "${epoch}", generation: 1, channel: "manager" };
    managerReady = true; frame = { contentWindow: { postMessage: capture } };
    nativeSelection();
    send("selected", { requestId: 1, spaceId: "alpha" });
    send("selected", { requestId: 2, spaceId: "alpha" });
  `).runInNewContext({ location, AbortController, AbortSignal, TextDecoder,
    capture: (message: unknown) => replies.push(message), fetch: () => new Promise(() => {}),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, window: { addEventListener() {} } });
  assert.equal(replies.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(replies[0])), { source: "dsh-spaces-surface-parent", type: "select", requestId: 2,
    serviceEpoch: epoch, spaceId: "hub", generation: 1, channel: "manager", target: "alpha", targetGeneration: 3 });
  assert.deepEqual(writes, ["#selected/2/alpha"]);
});
