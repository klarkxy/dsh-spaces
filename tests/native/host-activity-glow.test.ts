import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import {
  composeHostGlow,
  parseHostActivity,
  HostActivityPoller,
  HOST_ACTIVITY_POLL_MS,
  HOST_ACTIVITY_READ_TIMEOUT_MS,
  type HostActivityTimers,
  type HostGlow,
} from "../../packages/plugin/src/client/host-activity.ts";
import { HostShellController, type HostShellEnvironment } from "../../packages/plugin/src/client/host-shell-state.ts";
import { NativeHostController } from "../../packages/plugin/src/client/ui/native-controller.ts";
import { createWorkbenchGuideRemote, WorkbenchRemoteError } from "../../packages/plugin/src/client/workbench-remote.ts";
import type { WorkbenchGuideApi } from "../../packages/plugin/src/types.ts";

/**
 * Isolated regression of the current-native-space activity light.
 *
 * Contract fixed in the group goal: the host reports raw
 * `{ attention, working }` over `workbenchGuide/hostActivity`; the client
 * composes exactly one light, yellow wins, unknown is never guessed, and a
 * vanished state is withdrawn instead of kept. These tests pin the client
 * half of that contract plus the poller lifecycle inside both shells.
 * They use manual or mocked timers only; no real Home, profile, server or
 * browser is touched.
 */

type Report = { attention: "required" | "none" | "unknown"; working: "busy" | "idle" | "unknown" };
const report = (attention: Report["attention"], working: Report["working"]): Report => ({ attention, working });

/** Manual clock: every scheduled delay is recorded, callbacks fire only when told to. */
function manualTimers() {
  const entries: { id: number; ms: number; handler: () => void; cleared: boolean; fired: boolean }[] = [];
  let seq = 0;
  const timers: HostActivityTimers = {
    setTimeout: (handler, ms) => { const id = ++seq; entries.push({ id, ms, handler, cleared: false, fired: false }); return id; },
    clearTimeout: id => { const entry = entries.find(row => row.id === id); if (entry) entry.cleared = true; },
  };
  return {
    entries,
    timers,
    /** Fire the most recent live cadence timer (the read deadline is a different timer); false when none is scheduled. */
    fireLatest(): boolean {
      const entry = [...entries].reverse().find(row => !row.cleared && !row.fired && row.ms === HOST_ACTIVITY_POLL_MS);
      if (!entry) return false;
      entry.fired = true;
      entry.handler();
      return true;
    },
    liveCount(): number {
      return entries.filter(row => !row.cleared && !row.fired && row.ms === HOST_ACTIVITY_POLL_MS).length;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// 1. The wire shape is a closed object with closed values.
// ---------------------------------------------------------------------------

test("hostActivity reports parse only the closed two-field shape with closed values", () => {
  for (const attention of ["required", "none", "unknown"] as const) {
    for (const working of ["busy", "idle", "unknown"] as const) {
      assert.deepEqual(parseHostActivity(report(attention, working)), report(attention, working));
    }
  }
  for (const value of [
    null, undefined, "required", 42, true, [],
    {},
    { attention: "none" },
    { working: "busy" },
    { attention: "none", working: "busy", extra: true },
    { attention: "maybe", working: "busy" },
    { attention: "none", working: "working" },
    { attention: "none", working: "busy", attention2: "none" },
    { attention: null, working: "idle" },
    { attention: "none", working: undefined },
  ]) assert.equal(parseHostActivity(value), null, JSON.stringify(value));
});

// ---------------------------------------------------------------------------
// 2. Composition: one light, yellow first, green only on a known-quiet host.
// ---------------------------------------------------------------------------

test("the composed light maps every raw state pair and yellow always wins", () => {
  // Yellow: any pending approval/question outranks everything, including real work.
  assert.equal(composeHostGlow(report("required", "busy")), "attention");
  assert.equal(composeHostGlow(report("required", "idle")), "attention");
  assert.equal(composeHostGlow(report("required", "unknown")), "attention");
  // Green: actual work with attention affirmatively quiet.
  assert.equal(composeHostGlow(report("none", "busy")), "working");
  assert.equal(composeHostGlow(report("none", "idle")), null);
  // Unknown attention never produces green: a pending approval cannot be ruled out.
  assert.equal(composeHostGlow(report("unknown", "busy")), null);
  assert.equal(composeHostGlow(report("none", "unknown")), null);
  assert.equal(composeHostGlow(report("unknown", "idle")), null);
  assert.equal(composeHostGlow(report("unknown", "unknown")), null);
  // A missing or malformed report is no light, never a guess.
  assert.equal(composeHostGlow(null), null);
});

// ---------------------------------------------------------------------------
// 3. Poller semantics: change-only apply, fixed cadence, no retry, hard stop.
// ---------------------------------------------------------------------------

test("the poller applies only on change and keeps one fixed cadence even after failures", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  let current: unknown = report("none", "busy");
  let fail = false;
  let reads = 0;
  const poller = new HostActivityPoller(
    async () => { reads++; if (fail) throw new Error("rpc dead"); return current; },
    glow => applied.push(glow),
    clock.timers,
  );
  poller.start();
  await tick();
  assert.deepEqual(applied, ["working"]);
  const cadence = () => clock.entries.filter(entry => entry.ms === HOST_ACTIVITY_POLL_MS);
  assert.equal(cadence().length, 1);
  assert.equal(cadence()[0]!.ms, HOST_ACTIVITY_POLL_MS, "the next read waits the fixed cadence");

  // Same report again: no duplicate apply.
  assert.equal(clock.fireLatest(), true);
  await tick();
  assert.deepEqual(applied, ["working"], "an unchanged state is not re-applied");
  assert.equal(reads, 2);

  // Yellow preempts green, then a transport failure withdraws the light.
  current = report("required", "busy");
  clock.fireLatest(); await tick();
  assert.deepEqual(applied, ["working", "attention"]);
  fail = true;
  clock.fireLatest(); await tick();
  assert.deepEqual(applied, ["working", "attention", null], "a failed read clears instead of keeping stale state");

  // The failure did not accelerate anything: every cadence delay stays the fixed cadence.
  assert.equal(clock.entries.every(entry => entry.ms === HOST_ACTIVITY_POLL_MS || entry.ms === HOST_ACTIVITY_READ_TIMEOUT_MS), true, "polling never retries early");

  // Recovery on the next ordinary tick, and a malformed payload reads as no light.
  fail = false;
  current = report("none", "busy");
  clock.fireLatest(); await tick();
  assert.deepEqual(applied, ["working", "attention", null, "working"]);
  current = { attention: "none", working: "busy", futureField: 1 };
  clock.fireLatest(); await tick();
  assert.deepEqual(applied, ["working", "attention", null, "working", null], "a malformed report is unknown, not green");
  poller.stop();
});

test("the poller never overlaps reads and ignores a read that settles after stop", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  const gates: (ReturnType<typeof deferred<unknown>> | undefined)[] = [];
  let reads = 0;
  const poller = new HostActivityPoller(
    async () => { reads++; const gate = deferred<unknown>(); gates.push(gate); return gate.promise; },
    glow => applied.push(glow),
    clock.timers,
  );
  poller.start();
  await tick();
  assert.equal(reads, 1);
  assert.equal(clock.liveCount(), 0, "no next read is scheduled while one is in flight");

  gates[0]!.resolve(report("required", "idle"));
  await tick();
  assert.deepEqual(applied, ["attention"]);
  assert.equal(clock.liveCount(), 1, "the cadence resumes only after the read settled");

  // Stop with the second read still in flight: the light clears now, the cadence
  // never re-arms, and the late answer cannot put anything back.
  clock.fireLatest();
  await tick();
  assert.equal(reads, 2);
  poller.stop();
  assert.deepEqual(applied, ["attention", null], "stop withdraws the light immediately");
  gates[1]!.resolve(report("none", "busy"));
  await tick();
  assert.deepEqual(applied, ["attention", null], "a read settling after stop is dropped");
  assert.equal(clock.liveCount(), 0, "nothing is scheduled after stop");
  assert.equal(clock.fireLatest(), false, "no cadence survives stop");
  assert.equal(reads, 2, "nothing polls after stop");
});

test("stop while only the cadence waits cancels the scheduled read", async () => {
  const clock = manualTimers();
  let reads = 0;
  const applied: HostGlow[] = [];
  const poller = new HostActivityPoller(async () => { reads++; return report("none", "idle"); }, glow => applied.push(glow), clock.timers);
  poller.start();
  await tick();
  assert.equal(reads, 1);
  assert.equal(clock.liveCount(), 1);
  poller.stop();
  assert.equal(clock.liveCount(), 0, "the pending cadence timer is cancelled");
  clock.fireLatest();
  await tick();
  assert.equal(reads, 1, "the cancelled read never happens");
  assert.deepEqual(applied, [], "a stopped-never-lit poller applies nothing");
});

test("a stopped poller can be started again and observes fresh state only", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  let current: unknown = report("none", "busy");
  const poller = new HostActivityPoller(async () => current, glow => applied.push(glow), clock.timers);
  poller.start();
  await tick();
  poller.stop();
  assert.deepEqual(applied, ["working", null]);
  current = report("required", "idle");
  poller.start();
  await tick();
  assert.deepEqual(applied, ["working", null, "attention"], "restart reads anew instead of reviving the old value");
  poller.start();
  assert.equal(clock.entries.filter(entry => entry.ms === HOST_ACTIVITY_POLL_MS).length >= 1, true);
  poller.stop();
});

test("the documented cadence is the fixed 1.5s of the native directory refresh", () => {
  assert.equal(HOST_ACTIVITY_POLL_MS, 1500);
});

// ---------------------------------------------------------------------------
// 4. Wire contract: exact endpoint, transport failure shape.
// ---------------------------------------------------------------------------

test("the guide remote calls exactly workbenchGuide/hostActivity with empty args", async () => {
  const calls: { channel: string; endpoint: string; payload: unknown }[] = [];
  const connection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload: unknown) => {
        calls.push({ channel, endpoint, payload });
        return { ok: true, value: report("none", "idle") };
      },
    },
  };
  const guide = createWorkbenchGuideRemote(connection as never);
  const value = await guide.hostActivity!();
  assert.deepEqual(calls, [{ channel: "/api", endpoint: "workbenchGuide/hostActivity", payload: { args: {} } }]);
  assert.deepEqual(value, report("none", "idle"));
});

test("a transport failure of hostActivity surfaces as rpc-transport so the poller clears the light", async () => {
  const connection = { rpc: { call: async () => { throw new Error("socket gone"); } } };
  const guide = createWorkbenchGuideRemote(connection as never);
  const error = await guide.hostActivity!().then(() => null, (cause: unknown) => cause);
  assert.ok(error instanceof WorkbenchRemoteError);
  assert.equal(error.failureKind, "rpc-transport");
  assert.equal(error.endpoint, "workbenchGuide/hostActivity");

  const backend = { rpc: { call: async () => ({ ok: false, error: { code: "workbench/unavailable", message: "x" } }) } };
  const backendGuide = createWorkbenchGuideRemote(backend as never);
  const backendError = await backendGuide.hostActivity!().then(() => null, (cause: unknown) => cause);
  assert.ok(backendError instanceof WorkbenchRemoteError, "a backend refusal is an error the poller reads as no-light");
});

// ---------------------------------------------------------------------------
// 5. Portable shell wiring: independent of the portal, cleared with the controller.
// ---------------------------------------------------------------------------

function portableEnv(clock: ReturnType<typeof manualTimers>): HostShellEnvironment {
  return {
    origin: () => "http://127.0.0.1:3101",
    channel: () => "ab".repeat(16),
    setTimeout: (handler, ms) => clock.timers.setTimeout(handler, ms) as ReturnType<typeof setTimeout>,
    clearTimeout: timer => clock.timers.clearTimeout(timer),
  };
}

test("the portable shell lights up before and without the portal and withdraws on stop", async () => {
  const clock = manualTimers();
  let current: unknown = report("none", "busy");
  const guide = {
    hostActivity: async () => current,
    // The boot sequence never finishes: the light must not depend on it.
    role: () => new Promise(() => {}),
    portalTarget: async () => { throw new Error("must not be reached"); },
    initialize: async () => { throw new Error("must not be reached"); },
    bootstrap: async () => { throw new Error("must not be reached"); },
    returnTarget: async () => { throw new Error("must not be reached"); },
  } as unknown as WorkbenchGuideApi;
  const controller = new HostShellController(guide, portableEnv(clock));
  controller.start();
  await tick();
  assert.equal(controller.getSnapshot().phase, "loading");
  assert.equal(controller.getSnapshot().hostGlow, "working", "the light belongs to the space, not to the portal boot");

  current = report("required", "busy");
  clock.fireLatest(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "attention", "yellow preempts green in the live shell");

  current = report("unknown", "busy");
  clock.fireLatest(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, null, "unknown attention never keeps or guesses a light");

  current = report("none", "busy");
  clock.fireLatest(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "working");
  controller.stop();
  assert.equal(controller.getSnapshot().hostGlow, null, "stopping the controller withdraws the light");
  clock.fireLatest(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, null, "nothing reports after stop");
});

test("the portable shell stays dark and healthy when the host offers no hostActivity", async () => {
  const clock = manualTimers();
  const guide = {
    role: () => new Promise(() => {}),
    portalTarget: async () => { throw new Error("unused"); },
    initialize: async () => { throw new Error("unused"); },
    bootstrap: async () => { throw new Error("unused"); },
    returnTarget: async () => { throw new Error("unused"); },
  } as unknown as WorkbenchGuideApi;
  const controller = new HostShellController(guide, portableEnv(clock));
  controller.start();
  await tick();
  assert.equal(controller.getSnapshot().hostGlow, null);
  clock.fireLatest();
  controller.stop();
  assert.equal(controller.getSnapshot().hostGlow, null, "an older host simply has no light");
});

// ---------------------------------------------------------------------------
// 6. Native shell wiring: starts with the controller, dies with it.
// ---------------------------------------------------------------------------

function nativeBridge() {
  return { acquire: async () => { throw new Error("no guest in this test"); }, release: async () => {} };
}

test("the native controller polls the light on its own lifecycle and stop withdraws it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current: unknown = report("none", "busy");
  let fail = false;
  let reads = 0;
  const guide = {
    hostActivity: async () => { reads++; if (fail) throw new Error("rpc dead"); return current; },
    role: () => new Promise(() => {}),
  } as unknown as WorkbenchGuideApi;
  const controller = new NativeHostController(guide, nativeBridge());
  void controller.start({} as HTMLElement);
  await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "working", "the light starts with the controller, before any launch settles");

  current = report("required", "busy");
  t.mock.timers.tick(HOST_ACTIVITY_POLL_MS);
  await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "attention", "yellow preempts green in the native shell");

  fail = true;
  t.mock.timers.tick(HOST_ACTIVITY_POLL_MS);
  await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, null, "an RPC failure withdraws the light instead of keeping it stale");

  fail = false;
  current = report("none", "busy");
  t.mock.timers.tick(HOST_ACTIVITY_POLL_MS);
  await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "working", "the next ordinary sample reports what it got");

  const beforeStop = reads;
  controller.stop();
  assert.equal(controller.getSnapshot().hostGlow, null, "stopping the controller withdraws the light");
  t.mock.timers.tick(HOST_ACTIVITY_POLL_MS * 10);
  await tick(); await tick();
  assert.equal(reads, beforeStop, "a stopped controller never polls again");
});

test("a terminal native failure stops the light with the controller lifecycle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current: unknown = report("required", "busy");
  const guide = {
    hostActivity: async () => current,
    role: async () => ({ role: "workspace", profileId: "desktop", unavailable: true, reasons: ["manager-stopped"] }),
    presentationSnapshot: async () => { throw new Error("unused"); },
  } as unknown as WorkbenchGuideApi;
  const controller = new NativeHostController(guide, nativeBridge());
  await controller.start({} as HTMLElement);
  await tick(); await tick();
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.equal(controller.getSnapshot().hostGlow, null, "the failed terminal controller carries no live light");
  const snapshot = controller.getSnapshot().hostGlow;
  current = report("none", "busy");
  t.mock.timers.tick(HOST_ACTIVITY_POLL_MS * 10);
  await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, snapshot, "nothing revives polling inside a terminal controller");
  controller.stop();
});
