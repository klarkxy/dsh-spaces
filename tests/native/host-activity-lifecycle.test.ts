import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import {
  HostActivityPoller,
  HOST_ACTIVITY_POLL_MS,
  HOST_ACTIVITY_READ_TIMEOUT_MS,
  type HostActivityTimers,
  type HostGlow,
} from "../../packages/plugin/src/client/host-activity.ts";
import { HostShellController, type HostShellEnvironment } from "../../packages/plugin/src/client/host-shell-state.ts";
import { NativeHostController } from "../../packages/plugin/src/client/ui/native-controller.ts";
import { createWorkbenchGuideRemote } from "../../packages/plugin/src/client/workbench-remote.ts";
import type { WorkbenchGuideApi } from "../../packages/plugin/src/types.ts";

/**
 * Bounded, abortable reads of the current-space light.
 *
 * A read that never settles, that ignores its AbortSignal, or that settles
 * after the poller was stopped and started again must never keep or revive a
 * light. A timeout is not a retry: the next read waits the ordinary cadence.
 * Manual clocks and hostile transports only; nothing real is touched.
 */

type Report = { attention: "required" | "none" | "unknown"; working: "busy" | "idle" | "unknown" };
const busy: Report = { attention: "none", working: "busy" };
const needsYou: Report = { attention: "required", working: "idle" };

function manualTimers() {
  const entries: { id: number; ms: number; handler: () => void; cleared: boolean; fired: boolean }[] = [];
  let seq = 0;
  const timers: HostActivityTimers = {
    setTimeout: (handler, ms) => { const id = ++seq; entries.push({ id, ms, handler, cleared: false, fired: false }); return id; },
    clearTimeout: id => { const entry = entries.find(row => row.id === id); if (entry) entry.cleared = true; },
  };
  const live = (ms: number) => entries.filter(row => row.ms === ms && !row.cleared && !row.fired);
  const fireLatest = (ms: number): boolean => {
    const entry = [...live(ms)].pop();
    if (!entry) return false;
    entry.fired = true; entry.handler();
    return true;
  };
  return { entries, timers, live, fireLatest };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A transport that ignores its AbortSignal entirely: it only settles when the test says so. */
function hostileRead() {
  const calls: { signal: AbortSignal; gate: ReturnType<typeof deferred<unknown>> }[] = [];
  return {
    calls,
    read: (signal: AbortSignal) => { const gate = deferred<unknown>(); calls.push({ signal, gate }); return gate.promise; },
  };
}

test("the read deadline is five seconds and cadence is separate", () => {
  assert.equal(HOST_ACTIVITY_READ_TIMEOUT_MS, 5000);
  assert.equal(HOST_ACTIVITY_POLL_MS, 1500);
});

test("a read that hangs forever withdraws the standing light at its deadline and aborts the request", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  const transport = hostileRead();
  const poller = new HostActivityPoller(transport.read, glow => applied.push(glow), clock.timers);
  poller.start(); await tick();
  transport.calls[0]!.gate.resolve(busy); await tick();
  assert.deepEqual(applied, ["working"]);

  // Next sample hangs: the old green is held only until the deadline.
  assert.equal(clock.fireLatest(HOST_ACTIVITY_POLL_MS), true); await tick();
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[1]!.signal.aborted, false);
  assert.deepEqual(applied, ["working"]);
  assert.equal(clock.live(HOST_ACTIVITY_READ_TIMEOUT_MS).length, 1, "the in-flight read is on a deadline");
  assert.equal(clock.fireLatest(HOST_ACTIVITY_READ_TIMEOUT_MS), true); await tick();
  assert.equal(transport.calls[1]!.signal.aborted, true, "the deadline aborts the request");
  assert.deepEqual(applied, ["working", null], "a timed-out read leaves no stale light");
  poller.stop();
});

test("a timeout is not an early retry: the next read waits the ordinary cadence", async () => {
  const clock = manualTimers();
  const transport = hostileRead();
  const poller = new HostActivityPoller(transport.read, () => {}, clock.timers);
  poller.start(); await tick();
  assert.equal(transport.calls.length, 1);
  clock.fireLatest(HOST_ACTIVITY_READ_TIMEOUT_MS); await tick();
  assert.equal(transport.calls.length, 1, "no read starts at the deadline");
  assert.equal(clock.live(HOST_ACTIVITY_POLL_MS).length, 1, "only the ordinary cadence is armed");
  clock.fireLatest(HOST_ACTIVITY_POLL_MS); await tick();
  assert.equal(transport.calls.length, 2);
  assert.equal(clock.entries.every(entry => entry.ms === HOST_ACTIVITY_POLL_MS || entry.ms === HOST_ACTIVITY_READ_TIMEOUT_MS), true, "no other delay is ever used");
  poller.stop();
});

test("stop aborts the read in flight, withdraws the light at once and cancels its deadline", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  const transport = hostileRead();
  const poller = new HostActivityPoller(transport.read, glow => applied.push(glow), clock.timers);
  poller.start(); await tick();
  transport.calls[0]!.gate.resolve(needsYou); await tick();
  clock.fireLatest(HOST_ACTIVITY_POLL_MS); await tick();
  assert.equal(transport.calls[1]!.signal.aborted, false);
  poller.stop();
  assert.equal(transport.calls[1]!.signal.aborted, true, "stop aborts the request in flight");
  assert.deepEqual(applied, ["attention", null], "the light is withdrawn immediately");
  assert.equal(clock.live(HOST_ACTIVITY_READ_TIMEOUT_MS).length, 0, "the deadline timer is cancelled");
  assert.equal(clock.live(HOST_ACTIVITY_POLL_MS).length, 0);
  // The transport ignored the abort and settles anyway, either way.
  transport.calls[1]!.gate.resolve(busy); await tick();
  assert.deepEqual(applied, ["attention", null], "a late answer after stop is dropped");
});

test("an old read settling after stop-then-start can neither light nor darken the new generation", async () => {
  for (const settle of ["resolve", "reject"] as const) {
    const clock = manualTimers();
    const applied: HostGlow[] = [];
    const transport = hostileRead();
    const poller = new HostActivityPoller(transport.read, glow => applied.push(glow), clock.timers);
    poller.start(); await tick();            // generation 1, read #0 hangs
    poller.stop();
    poller.start(); await tick();            // generation 2, read #1
    assert.equal(transport.calls.length, 2, "the new generation reads on its own");
    assert.equal(transport.calls[0]!.signal.aborted, true);
    assert.equal(transport.calls[1]!.signal.aborted, false, "the new read is not aborted by the old stop");

    transport.calls[1]!.gate.resolve(needsYou); await tick();
    assert.deepEqual(applied, ["attention"]);

    // The abandoned generation answers late, with the opposite state or an error.
    if (settle === "resolve") transport.calls[0]!.gate.resolve(busy); else transport.calls[0]!.gate.reject(new Error("late"));
    await tick();
    assert.deepEqual(applied, ["attention"], `a late ${settle} of the old generation changes nothing`);
    assert.equal(clock.live(HOST_ACTIVITY_POLL_MS).length, 1, "exactly one cadence belongs to the new generation");
    poller.stop();
  }
});

test("a transport that ignores abort and never settles still cannot hold the light", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  const transport = hostileRead();
  const poller = new HostActivityPoller(transport.read, glow => applied.push(glow), clock.timers);
  poller.start(); await tick();
  transport.calls[0]!.gate.resolve(busy); await tick();
  for (let round = 0; round < 3; round++) {
    clock.fireLatest(HOST_ACTIVITY_POLL_MS); await tick();
    clock.fireLatest(HOST_ACTIVITY_READ_TIMEOUT_MS); await tick();   // deadline, transport still pending
  }
  assert.deepEqual(applied, ["working", null]);
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.calls.slice(1).every(call => call.signal.aborted), true);
  // The never-settled promises are never awaited by anything the poller schedules.
  assert.equal(clock.live(HOST_ACTIVITY_POLL_MS).length, 1);
  poller.stop();
});

test("a read function that throws synchronously reads as no light, not as a crash", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  let first = true;
  const poller = new HostActivityPoller(() => { if (first) { first = false; return Promise.resolve(busy); } throw new Error("sync boom"); }, glow => applied.push(glow), clock.timers);
  poller.start(); await tick();
  clock.fireLatest(HOST_ACTIVITY_POLL_MS); await tick();
  assert.deepEqual(applied, ["working", null]);
  assert.equal(clock.live(HOST_ACTIVITY_POLL_MS).length, 1);
  poller.stop();
});

test("the real guide remote hands its AbortSignal to the RPC call", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const connection = { rpc: { call: async (_channel: string, _endpoint: string, _payload: unknown, signal?: AbortSignal) => { seen.push(signal); return { ok: true, value: busy }; } } };
  const guide = createWorkbenchGuideRemote(connection as never);
  const controller = new AbortController();
  await guide.hostActivity!(controller.signal);
  assert.equal(seen[0], controller.signal, "the signal reaches connection.rpc.call");
});

test("an RPC that only settles when its signal aborts is bounded by the poller end to end", async () => {
  const clock = manualTimers();
  const applied: HostGlow[] = [];
  let answer: Report | "hang" = busy;
  const connection = { rpc: { call: (_c: string, _e: string, _p: unknown, signal?: AbortSignal) => answer === "hang"
    ? new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
    : Promise.resolve({ ok: true, value: answer }) } };
  const guide = createWorkbenchGuideRemote(connection as never);
  const poller = new HostActivityPoller(signal => guide.hostActivity!(signal), glow => applied.push(glow), clock.timers);
  poller.start(); await tick();
  assert.deepEqual(applied, ["working"]);
  answer = "hang";
  clock.fireLatest(HOST_ACTIVITY_POLL_MS); await tick();
  clock.fireLatest(HOST_ACTIVITY_READ_TIMEOUT_MS); await tick();
  assert.deepEqual(applied, ["working", null]);
  poller.stop();
});

function portableEnv(clock: ReturnType<typeof manualTimers>): HostShellEnvironment {
  return {
    origin: () => "http://127.0.0.1:3101",
    channel: () => "ab".repeat(16),
    setTimeout: (handler, ms) => clock.timers.setTimeout(handler, ms) as ReturnType<typeof setTimeout>,
    clearTimeout: timer => clock.timers.clearTimeout(timer),
  };
}

test("the portable shell stop-then-start never overlaps the old request and the old answer cannot light the new one", async () => {
  const clock = manualTimers();
  const transport = hostileRead();
  const guide = { hostActivity: (signal?: AbortSignal) => transport.read(signal!), role: () => new Promise(() => {}) } as unknown as WorkbenchGuideApi;
  const controller = new HostShellController(guide, portableEnv(clock));
  controller.start(); await tick();
  assert.equal(transport.calls.length, 1);
  controller.stop();
  assert.equal(transport.calls[0]!.signal.aborted, true, "stop aborts the old request");
  controller.start(); await tick();
  assert.equal(transport.calls.length, 2, "the restarted shell issues its own request");
  assert.equal(transport.calls[1]!.signal.aborted, false);

  transport.calls[1]!.gate.resolve(needsYou); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "attention");
  transport.calls[0]!.gate.resolve(busy); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "attention", "the old generation cannot change the new light");
  controller.stop();
  assert.equal(controller.getSnapshot().hostGlow, null);
});

test("the native controller withdraws a standing light when its read hangs past the deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hang = false;
  const signals: AbortSignal[] = [];
  const guide = {
    hostActivity: (signal?: AbortSignal) => { signals.push(signal!); return hang ? new Promise<never>(() => {}) : Promise.resolve(busy); },
    role: () => new Promise(() => {}),
  } as unknown as WorkbenchGuideApi;
  const controller = new NativeHostController(guide, { acquire: async () => { throw new Error("no guest"); }, release: async () => {} });
  void controller.start({} as HTMLElement);
  await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "working");
  hang = true;
  t.mock.timers.tick(HOST_ACTIVITY_POLL_MS); await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, "working", "held only until the deadline");
  t.mock.timers.tick(HOST_ACTIVITY_READ_TIMEOUT_MS); await tick(); await tick();
  assert.equal(controller.getSnapshot().hostGlow, null, "a hung read does not keep the light");
  assert.equal(signals.at(-1)!.aborted, true);
  controller.stop();
});
