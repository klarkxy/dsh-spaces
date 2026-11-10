import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPACE_ATTENTION_CHANNEL,
  attentionIdentityFromEnv,
  parseSpaceAttentionReport,
  type SpaceAttentionTransport,
} from "../../src/shared/space-attention.ts";
import { SupervisorAttention } from "../../src/adapters/node/supervisor/attention.ts";
import { SpaceRunRegistry } from "../../src/adapters/node/supervisor/space-runs.ts";
import { SpaceAttentionProbe, installSpaceAttention } from "../../packages/view-bridge/src/attention.ts";
import { workbenchSpaceSchema } from "../../packages/plugin/src/host/workbench-schemas.ts";

const EPOCH = "ab".repeat(32);

test("the host workbench schema accepts the projected attention field and only its closed values", () => {
  const space = {
    id: "alpha", displayName: "Alpha", isHost: false, hasWebApp: true, icon: "",
    status: "running", generation: 2, managed: true, dshVersion: null,
  };
  assert.equal(workbenchSpaceSchema.safeParse(space).success, true, "older states without attention stay valid");
  for (const attention of ["required", "none", "unknown"]) {
    assert.equal(workbenchSpaceSchema.safeParse({ ...space, attention }).success, true, attention);
  }
  assert.equal(workbenchSpaceSchema.safeParse({ ...space, attention: "busy" }).success, false);
});
const identity = { spaceId: "alpha", generation: 2, serviceEpoch: EPOCH };

type Listener = (...args: any[]) => void;
function fakeTransport(connected = true): Omit<SpaceAttentionTransport, "connected"> & { sent: unknown[]; emit(raw: unknown): void; fire(event: string): void; listeners: Map<string, Listener[]>; connected: boolean } {
  const listeners = new Map<string, Listener[]>();
  let live = connected;
  const transport = {
    sent: [] as unknown[],
    listeners,
    get connected() { return live; },
    set connected(value: boolean) { live = value; },
    send(message: unknown, callback?: (error: Error | null) => void) { transport.sent.push(message); callback?.(null); return true; },
    on(event: string, listener: Listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    off(event: string, listener: Listener) { listeners.set(event, (listeners.get(event) ?? []).filter(fn => fn !== listener)); },
    emit(raw: unknown) { for (const fn of listeners.get("message") ?? []) fn(raw); },
    fire(event: string) { for (const fn of listeners.get(event) ?? []) fn(); },
  };
  return transport;
}

test("attention identity requires the full supervisor-injected launch triple", () => {
  assert.equal(attentionIdentityFromEnv({}), undefined);
  assert.deepEqual(attentionIdentityFromEnv({
    DSH_SPACES_VIEW_ID: "alpha", DSH_SPACES_VIEW_GENERATION: "2", DSH_SPACES_VIEW_SERVICE_EPOCH: EPOCH,
  }), identity);
  for (const env of [
    { DSH_SPACES_VIEW_ID: "alpha" },
    { DSH_SPACES_VIEW_ID: "bad id!", DSH_SPACES_VIEW_GENERATION: "2", DSH_SPACES_VIEW_SERVICE_EPOCH: EPOCH },
    { DSH_SPACES_VIEW_ID: "alpha", DSH_SPACES_VIEW_GENERATION: "-1", DSH_SPACES_VIEW_SERVICE_EPOCH: EPOCH },
    { DSH_SPACES_VIEW_ID: "alpha", DSH_SPACES_VIEW_GENERATION: "2", DSH_SPACES_VIEW_SERVICE_EPOCH: "not-hex" },
  ]) assert.throws(() => attentionIdentityFromEnv(env));
});

test("attention reports are identity-bound, revisioned and strictly parsed", () => {
  const valid = { type: SPACE_ATTENTION_CHANNEL, kind: "state", ...identity, revision: 1, attention: "required" };
  assert.deepEqual(parseSpaceAttentionReport(valid, identity), valid);
  for (const value of [
    { ...valid, attention: "maybe" },
    { ...valid, kind: "request" },
    { ...valid, revision: -1 },
    { ...valid, spaceId: "beta" },
    { ...valid, generation: 3 },
    { ...valid, serviceEpoch: "cd".repeat(32) },
    { ...valid, type: "dsh-spaces:other" },
    null, [], "required",
  ]) assert.equal(parseSpaceAttentionReport(value, identity), undefined, JSON.stringify(value));
});

test("child attention computes required only for pending approvals and questions", () => {
  const sent: unknown[] = [];
  const transport = {
    connected: true,
    send: (message: unknown, cb?: (error: Error | null) => void) => { sent.push(message); cb?.(null); },
    on() {}, off() {},
  };
  const sources = {
    typertGateway: { getPendingRemoteEvents: () => [] as { event: string; agentId: unknown }[] },
    sessions: { list: () => [{ id: "s-1" }] as unknown[] },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [], settled: [] } } }) },
  };
  const attention = new SpaceAttentionProbe(identity, transport, () => sources);
  assert.equal(attention.compute(), "none");
  sources.typertGateway.getPendingRemoteEvents = () => [{ event: "other/event", agentId: "s-1" }];
  assert.equal(attention.compute(), "none", "unrelated pending events do not require attention");
  sources.typertGateway.getPendingRemoteEvents = () => [{ event: "approval/request", agentId: "s-1" }];
  assert.equal(attention.compute(), "required");
  sources.typertGateway.getPendingRemoteEvents = () => [{ event: "user-questions/request", agentId: "s-1" }];
  assert.equal(attention.compute(), "required");
  sources.typertGateway.getPendingRemoteEvents = () => [];
  sources.sessionProjections.snapshot = () => ({ values: { userQuestions: { active: [{ callId: "c-1" } as never], settled: [] } } });
  assert.equal(attention.compute(), "required", "an active timed question card requires attention");
  sources.sessionProjections.snapshot = () => ({ values: { userQuestions: { active: [], settled: [{ callId: "c-1" } as never] } } });
  assert.equal(attention.compute(), "none");
  attention.close();
});

test("missing or failing services report unknown, never a guessed state", () => {
  const transport = fakeTransport();
  const empty = new SpaceAttentionProbe(identity, transport, () => ({}));
  assert.equal(empty.compute(), "unknown");
  const partial = new SpaceAttentionProbe(identity, transport, () => ({
    typertGateway: { getPendingRemoteEvents: () => [] },
    sessions: { list: () => [] },
    sessionProjections: undefined,
  }));
  assert.equal(partial.compute(), "unknown");
  const throwing = new SpaceAttentionProbe(identity, transport, () => ({
    typertGateway: { getPendingRemoteEvents: () => [] },
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => { throw new Error("session gone"); } },
  }));
  assert.equal(throwing.compute(), "unknown");
});

test("the child pushes reports only when the computed attention changes", () => {
  const transport = fakeTransport();
  const sources = {
    typertGateway: { getPendingRemoteEvents: () => [] as { event: string; agentId: unknown }[] },
    sessions: { list: () => [] as unknown[] },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  };
  const attention = new SpaceAttentionProbe(identity, transport, () => sources);
  attention.poll();
  attention.poll();
  assert.equal(transport.sent.length, 1, "unchanged attention is not resent");
  assert.deepEqual(transport.sent[0], { type: SPACE_ATTENTION_CHANNEL, kind: "state", ...identity, revision: 1, attention: "none" });
  sources.typertGateway.getPendingRemoteEvents = () => [{ event: "approval/request", agentId: "s-1" }];
  attention.poll();
  assert.equal(transport.sent.length, 2);
  assert.equal((transport.sent[1] as { attention: string }).attention, "required");
  assert.equal((transport.sent[1] as { revision: number }).revision, 2);
  sources.typertGateway.getPendingRemoteEvents = () => [];
  attention.poll();
  assert.equal((transport.sent[2] as { attention: string }).attention, "none");
  transport.connected = false;
  attention.poll();
  assert.equal(transport.sent.length, 3, "a disconnected transport does not send");
  attention.close();
});

test("installSpaceAttention never joins approval/question waterfalls and clears its interval on dispose", () => {
  const transport = fakeTransport();
  const listeners = new Map<string, ((...args: any[]) => unknown)[]>();
  const services: Record<string, unknown> = {
    typertGateway: { getPendingRemoteEvents: () => [{ event: "approval/request", agentId: "s-1" }] },
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [], settled: [] } } }) },
  };
  const ctx = {
    get: (name: string) => services[name],
    on(event: string, listener: (...args: any[]) => unknown) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    effect: (fn: () => () => void) => { dispose = fn(); },
  };
  let dispose!: () => void;
  const attention = installSpaceAttention(ctx as never, {
    DSH_SPACES_VIEW_ID: "alpha", DSH_SPACES_VIEW_GENERATION: "2", DSH_SPACES_VIEW_SERVICE_EPOCH: EPOCH,
  }, transport);
  assert.ok(attention);
  assert.equal(transport.sent.length, 1, "the initial report is pushed eagerly");
  assert.equal((transport.sent[0] as { attention: string }).attention, "required");
  assert.equal(listeners.has("approval/request"), false, "the probe must not sit in the approval waterfall");
  assert.equal(listeners.has("user-questions/request"), false, "the probe must not sit in the question waterfall");
  assert.equal(listeners.has("session/event"), true);
  dispose();
  transport.fire("disconnect");
});

test("the supervisor caches the newest report per live child identity and drops exits", () => {
  const runs = new SpaceRunRegistry();
  runs.nextGeneration("alpha");
  runs.nextGeneration("alpha");
  const attention = new SupervisorAttention({ runs, currentServiceEpoch: () => EPOCH });
  const transport = fakeTransport();
  const dispose = attention.attachChild("alpha", transport, 2, EPOCH);
  assert.equal(attention.attentionOf("alpha"), "unknown", "no report yet");
  const report = (revision: number, state: string, overrides: object = {}) =>
    ({ type: SPACE_ATTENTION_CHANNEL, kind: "state", spaceId: "alpha", generation: 2, serviceEpoch: EPOCH, revision, attention: state, ...overrides });
  transport.emit(report(1, "required"));
  assert.equal(attention.attentionOf("alpha"), "required");
  transport.emit(report(1, "none"));
  assert.equal(attention.attentionOf("alpha"), "required", "an equal revision is stale");
  transport.emit(report(0, "none"));
  assert.equal(attention.attentionOf("alpha"), "required", "an older revision is stale");
  transport.emit(report(2, "bad-value"));
  assert.equal(attention.attentionOf("alpha"), "required", "a malformed report is dropped");
  transport.emit(report(2, "none", { generation: 9 }));
  assert.equal(attention.attentionOf("alpha"), "required", "a foreign identity is dropped");
  transport.emit(report(2, "none"));
  assert.equal(attention.attentionOf("alpha"), "none");
  transport.emit(report(3, "required", { type: "dsh-spaces:other" }));
  assert.equal(attention.attentionOf("alpha"), "none", "another channel is dropped");
  assert.equal(attention.attentionOf("beta"), "unknown", "a space with no session is unknown");
  assert.equal(attention.attentionOf("alpha"), "none");
  runs.nextGeneration("alpha");
  assert.equal(attention.attentionOf("alpha"), "unknown", "a new generation makes the report stale");
  runs.generations.set("alpha", 2);
  dispose();
  transport.emit(report(4, "required"));
  assert.equal(attention.attentionOf("alpha"), "unknown", "a disposed session reports nothing");
  transport.fire("exit");
});

test("a reattach replaces the previous session and transport listeners", () => {
  const runs = new SpaceRunRegistry();
  runs.nextGeneration("alpha");
  const attention = new SupervisorAttention({ runs, currentServiceEpoch: () => EPOCH });
  const first = fakeTransport();
  const second = fakeTransport();
  attention.attachChild("alpha", first, 1, EPOCH);
  attention.attachChild("alpha", second, 1, EPOCH);
  assert.equal(first.listeners.get("message")?.length ?? 0, 0, "the stale session is detached");
  const report = { type: SPACE_ATTENTION_CHANNEL, kind: "state", spaceId: "alpha", generation: 1, serviceEpoch: EPOCH, revision: 1, attention: "required" };
  first.emit(report);
  assert.equal(attention.attentionOf("alpha"), "unknown", "the detached transport cannot report");
  second.emit(report);
  assert.equal(attention.attentionOf("alpha"), "required");
});
