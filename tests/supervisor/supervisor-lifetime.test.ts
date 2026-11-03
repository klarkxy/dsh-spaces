import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  bindSupervisorLifetime,
  requireHostChannel,
  type LifetimeDeps,
  type SupervisorStopTarget,
} from "../../packages/supervisor/src/lifetime.ts";

interface Call {
  method: string;
  args: Record<string, unknown>;
}

function fakeChannel(connected = true) {
  const emitter = new EventEmitter();
  return { connected, once: (event: string, listener: () => void) => emitter.once(event, listener), emitter };
}

function fakeDeps() {
  const calls: Call[] = [];
  const exited: number[] = [];
  const stderr: string[] = [];
  const deps: LifetimeDeps = {
    exit: (code) => { exited.push(code); },
    writeStderr: (text) => { stderr.push(text); },
    diagnostics: {
      recordNormalStop: (args: Record<string, unknown>) => { calls.push({ method: "recordNormalStop", args }); },
      recordFailure: (_error: unknown, args: Record<string, unknown>) => { calls.push({ method: "recordFailure", args }); },
    } as never,
  };
  return { calls, exited, stderr, deps };
}

function target(impl?: () => Promise<void>) {
  let closes = 0;
  const handle: SupervisorStopTarget = {
    close: async () => { closes++; await impl?.(); },
  };
  return { handle, closes: () => closes };
}

test("requireHostChannel refuses missing or dead channels and returns a live one", () => {
  assert.throws(() => requireHostChannel(undefined), /launching host channel is missing/);
  assert.throws(() => requireHostChannel(fakeChannel(false)), /launching host channel is missing/);
  const live = fakeChannel(true);
  assert.equal(requireHostChannel(live), live);
});

test("host disconnect closes once, records host-exit, and exits zero", async () => {
  const channel = fakeChannel();
  const { handle, closes } = target();
  const { calls, exited, deps } = fakeDeps();
  bindSupervisorLifetime({ handle: Promise.resolve(handle), hostChannel: channel, deps });
  channel.emitter.emit("disconnect");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes(), 1);
  assert.deepEqual(exited, [0]);
  assert.deepEqual(calls, [{ method: "recordNormalStop", args: { exit: 0, signal: "host-exit" } }]);
});

test("disconnect before handle ready still stops once the handle resolves", async () => {
  const channel = fakeChannel();
  const { handle, closes } = target();
  const { exited, deps } = fakeDeps();
  let resolveHandle!: (value: SupervisorStopTarget) => void;
  const pending = new Promise<SupervisorStopTarget>((resolve) => { resolveHandle = resolve; });
  bindSupervisorLifetime({ handle: pending, hostChannel: channel, deps });
  channel.emitter.emit("disconnect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes(), 0);
  resolveHandle(handle);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closes(), 1);
  assert.deepEqual(exited, [0]);
});

test("disconnect with a failing close records failure without exit and never exits", async () => {
  const channel = fakeChannel();
  const { handle } = target(async () => { throw new Error("close blew up"); });
  const { calls, exited, deps } = fakeDeps();
  bindSupervisorLifetime({ handle: Promise.resolve(handle), hostChannel: channel, deps });
  channel.emitter.emit("disconnect");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(exited, []);
  assert.deepEqual(calls, [{ method: "recordFailure", args: { signal: "host-exit" } }]);
});

test("signal with a failing close keeps the existing exit-1 behavior", async () => {
  const channel = fakeChannel();
  const { handle } = target(async () => { throw new Error("close blew up"); });
  const { calls, exited, stderr, deps } = fakeDeps();
  const lifetime = bindSupervisorLifetime({ handle: Promise.resolve(handle), hostChannel: channel, deps });
  lifetime.onSignal("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(exited, [1]);
  assert.deepEqual(calls, [{ method: "recordFailure", args: { exit: 1, signal: "SIGTERM" } }]);
  assert.match(stderr.join(""), /close blew up/);
});

test("signal and disconnect racing only close the handle once", async () => {
  const channel = fakeChannel();
  const { handle, closes } = target();
  const { exited, deps } = fakeDeps();
  const lifetime = bindSupervisorLifetime({ handle: Promise.resolve(handle), hostChannel: channel, deps });
  lifetime.onSignal("SIGTERM");
  channel.emitter.emit("disconnect");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closes(), 1);
  assert.deepEqual(exited, [0]);
});
