import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPACE_ATTENTION_CHANNEL,
  attentionIdentityFromEnv,
  composeSpaceGlow,
  parseSpaceAttentionReport,
  type SpaceAttentionTransport,
} from "../../src/shared/space-attention.ts";
import { SupervisorAttention } from "../../src/adapters/node/supervisor/attention.ts";
import { SupervisorLlm } from "../../src/adapters/node/supervisor/llm.ts";
import { LLM_ACTIVITY_CHANNEL } from "../../src/shared/llm-activity.ts";
import { SpaceRunRegistry } from "../../src/adapters/node/supervisor/space-runs.ts";
import { SpaceAttentionProbe, installSpaceAttention } from "../../packages/view-bridge/src/attention.ts";
import { LlmActivity } from "../../packages/view-bridge/src/activity.ts";
import { workbenchSpaceSchema } from "../../packages/plugin/src/host/workbench-schemas.ts";
import { computeHostActivity, computeHostAttention, computeHostWorking, parseHostActivity } from "../../packages/plugin/src/host/host-activity.ts";
import { HostActivityPoller, composeHostGlow, parseHostActivity as parseClientHostActivity, type HostGlow } from "../../packages/plugin/src/client/host-activity.ts";

const EPOCH = "ab".repeat(32);

test("the host workbench schema accepts the projected attention field and only its closed values", () => {
  const space = {
    id: "alpha", displayName: "Alpha", isHost: false, hasWebApp: true, icon: "",
    status: "running", generation: 2, managed: true, dshVersion: null, startWithDesktop: false,
  };
  assert.equal(workbenchSpaceSchema.safeParse(space).success, true, "older states without attention stay valid");
  for (const attention of ["required", "none", "unknown"]) {
    assert.equal(workbenchSpaceSchema.safeParse({ ...space, attention }).success, true, attention);
  }
  assert.equal(workbenchSpaceSchema.safeParse({ ...space, attention: "busy" }).success, false);
  for (const working of ["busy", "idle", "unknown"]) {
    assert.equal(workbenchSpaceSchema.safeParse({ ...space, working }).success, true, working);
  }
  assert.equal(workbenchSpaceSchema.safeParse({ ...space, working: "required" }).success, false);
});

test("composeSpaceGlow gives yellow attention priority over green working and hides green when attention is unknown", () => {
  assert.equal(composeSpaceGlow("required", "idle"), "attention");
  assert.equal(composeSpaceGlow("required", "busy"), "attention");
  assert.equal(composeSpaceGlow("required", "unknown"), "attention");
  assert.equal(composeSpaceGlow("none", "busy"), "working");
  assert.equal(composeSpaceGlow("none", "idle"), null);
  assert.equal(composeSpaceGlow("none", "unknown"), null);
  assert.equal(composeSpaceGlow("unknown", "busy"), null);
  assert.equal(composeSpaceGlow(undefined, "busy"), null);
});

test("SupervisorLlm.workingOf projects the latest child activity and degrades on stale identity", () => {
  const runs = new SpaceRunRegistry();
  runs.nextGeneration("alpha");
  const llm = new SupervisorLlm({ publicStatus: () => "running", currentServiceEpoch: () => EPOCH, runs });
  const transport = fakeTransport();
  llm.attachChild("alpha", transport, 1, EPOCH);
  assert.equal(llm.workingOf("alpha"), "unknown");
  transport.emit({ type: LLM_ACTIVITY_CHANNEL, kind: "state", spaceId: "alpha", generation: 1, serviceEpoch: EPOCH, revision: 1, status: "busy" });
  assert.equal(llm.workingOf("alpha"), "busy");
  transport.emit({ type: LLM_ACTIVITY_CHANNEL, kind: "state", spaceId: "alpha", generation: 1, serviceEpoch: EPOCH, revision: 2, status: "idle" });
  assert.equal(llm.workingOf("alpha"), "idle");
  runs.nextGeneration("alpha");
  assert.equal(llm.workingOf("alpha"), "unknown");
});

test("computeHostActivity computes attention and working independently and degrades missing services to unknown", () => {
  const cleanSources = {
    typertGateway: { getPendingRemoteEvents: () => [] as { event: string; agentId: unknown }[] },
    sessions: { list: () => [{ id: "s1" }] },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [] } } }) },
    agents: { list: () => [{ status: "running" }] },
  };
  assert.deepEqual(computeHostActivity(cleanSources), { attention: "none", working: "busy" });
  assert.equal(computeHostAttention({ ...cleanSources, typertGateway: { getPendingRemoteEvents: () => [{ event: "approval/request", agentId: "s1" }] } }), "required");
  assert.equal(computeHostWorking({ agents: { list: () => [{ status: "idle" }] } }), "idle");
  assert.equal(computeHostWorking({}), "unknown");
  assert.deepEqual(parseHostActivity({ attention: "none", working: "busy" }), { attention: "none", working: "busy" });
  assert.equal(parseHostActivity({ attention: "none", working: "busy", extra: 1 }), undefined);
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

test("child attention isolates per-channel and per-session errors and degrades missing userQuestions to unknown", () => {
  const transport = fakeTransport();
  const s1 = { id: "s-1" };
  const s2 = { id: "s-2" };

  // A throwing first session must not mask an active question in a later session.
  const laterRequired = new SpaceAttentionProbe(identity, transport, () => ({
    typertGateway: { getPendingRemoteEvents: () => [] },
    sessions: { list: () => [s1, s2] },
    sessionProjections: {
      snapshot: (session) => {
        if (session === s1) throw new Error("session 1 disposed mid-scan");
        return { values: { userQuestions: { active: [{ callId: "q-2" }] } } };
      },
    },
  }));
  assert.equal(laterRequired.compute(), "required");

  // A throwing gateway read must not mask an active session question.
  const gatewayThrows = new SpaceAttentionProbe(identity, transport, () => ({
    typertGateway: { getPendingRemoteEvents: () => { throw new Error("gateway read failed"); } },
    sessions: { list: () => [s2] },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [{ callId: "q-2" }] } } }) },
  }));
  assert.equal(gatewayThrows.compute(), "required");

  // A missing or throwing session list must not mask a confirmed gateway approval.
  const sessionsThrows = new SpaceAttentionProbe(identity, transport, () => ({
    typertGateway: { getPendingRemoteEvents: () => [{ event: "approval/request", agentId: "a-1" }] },
    sessions: { list: () => { throw new Error("sessions unavailable"); } },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [] } } }) },
  }));
  assert.equal(sessionsThrows.compute(), "required");

  // Missing or malformed userQuestions projections on live sessions degrade to unknown (never none),
  // preventing composeSpaceGlow(attention, "busy") from lighting a false working green ring.
  for (const badSnapshot of [
    {},
    { values: {} },
    { values: { userQuestions: null } },
    { values: { userQuestions: {} } },
    { values: { userQuestions: { active: "not-an-array" } } },
  ]) {
    const probe = new SpaceAttentionProbe(identity, transport, () => ({
      typertGateway: { getPendingRemoteEvents: () => [] },
      sessions: { list: () => [s1] },
      sessionProjections: { snapshot: () => badSnapshot as { values?: Record<string, unknown> } },
    }));
    assert.equal(probe.compute(), "unknown");
    assert.equal(composeSpaceGlow(probe.compute(), "busy"), null);
  }
});

test("computeHostAttention and computeHostWorking isolate thrown list reads and share closed wire validation", () => {
  assert.equal(computeHostAttention({
    typertGateway: { getPendingRemoteEvents: () => [{ event: "user-questions/request", agentId: "a-1" }] },
    sessions: { list: () => { throw new Error("sessions list failed"); } },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [] } } }) },
  }), "required");
  const s1 = { id: "s-1" }, s2 = { id: "s-2" };
  assert.equal(computeHostAttention({
    typertGateway: { getPendingRemoteEvents: () => [] },
    sessions: { list: () => [s1, s2] },
    sessionProjections: {
      snapshot: (session) => {
        if (session === s1) throw new Error("first session failed");
        return { values: { userQuestions: { active: [{ callId: "q-2" }] } } };
      },
    },
  }), "required");
  assert.equal(computeHostAttention({
    typertGateway: { getPendingRemoteEvents: () => [] },
    sessions: { list: () => [s1] },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  }), "unknown");
  assert.equal(computeHostWorking({ agents: { list: () => { throw new Error("agents failed"); } } }), "unknown");
  assert.equal(computeHostWorking({ agents: { list: () => [{ status: "starting" }] } }), "unknown");

  assert.deepEqual(parseClientHostActivity({ attention: "required", working: "idle" }), { attention: "required", working: "idle" });
  assert.equal(composeHostGlow(parseClientHostActivity({ attention: "none", working: "busy" })), "working");
  for (const invalid of [
    null,
    [],
    {},
    { attention: "none" },
    { attention: "none", working: "busy", extra: true },
    { attention: "busy", working: "busy" },
    { attention: "none", working: "required" },
  ]) {
    assert.equal(parseHostActivity(invalid), undefined);
    assert.equal(parseClientHostActivity(invalid), null);
  }
});

test("HostActivityPoller aborts timed-out reads, clears timers on stop, and ignores stale epochs", async () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimerId = 0;
  const fakeTimers = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++nextTimerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
  };
  const applied: HostGlow[] = [];
  const reads: { signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const poller = new HostActivityPoller(
    (signal) => new Promise((resolve, reject) => { reads.push({ signal, resolve, reject }); }),
    (glow) => { applied.push(glow); },
    fakeTimers,
    1500,
    5000,
  );

  poller.start();
  assert.equal(poller.active, true);
  assert.equal(reads.length, 1);

  // First read resolves working -> applies "working" and schedules 1500ms interval timer.
  reads[0].resolve({ attention: "none", working: "busy" });
  await flush();
  assert.deepEqual(applied, ["working"]);
  const intervalEntry = [...timers.entries()].find(([, item]) => item.ms === 1500);
  assert.ok(intervalEntry, "next poll interval is scheduled after settling");

  // Trigger second read and let its 5000ms deadline expire -> aborts signal and resets glow to null.
  timers.delete(intervalEntry[0]);
  intervalEntry[1].fn();
  assert.equal(reads.length, 2);
  const deadlineEntry = [...timers.entries()].find(([, item]) => item.ms === 5000);
  assert.ok(deadlineEntry, "read deadline timer is armed while read is in flight");
  timers.delete(deadlineEntry[0]);
  deadlineEntry[1].fn();
  await flush();
  assert.equal(reads[1].signal.aborted, true, "timed-out read signal is aborted");
  assert.deepEqual(applied, ["working", null]);

  // Trigger third read -> resolves "attention", then trigger fourth in-flight read and call stop().
  const retryEntry = [...timers.entries()].find(([, item]) => item.ms === 1500)!;
  timers.delete(retryEntry[0]);
  retryEntry[1].fn();
  reads[2].resolve({ attention: "required", working: "busy" });
  await flush();
  assert.deepEqual(applied, ["working", null, "attention"]);

  const fourthEntry = [...timers.entries()].find(([, item]) => item.ms === 1500)!;
  timers.delete(fourthEntry[0]);
  fourthEntry[1].fn();
  assert.equal(reads.length, 4);
  poller.stop();
  assert.equal(poller.active, false);
  assert.equal(reads[3].signal.aborted, true, "stop() aborts in-flight read");
  assert.equal(timers.size, 0, "stop() clears all interval and deadline timers");
  assert.deepEqual(applied, ["working", null, "attention", null]);

  // Late resolution from the stopped epoch cannot re-light glow or re-arm timers.
  reads[3].resolve({ attention: "required", working: "busy" });
  await flush();
  assert.equal(timers.size, 0);
  assert.deepEqual(applied, ["working", null, "attention", null]);
});

test("LlmActivity deduplicates consecutive identical state pushes while replying to observe requests", () => {
  const transport = fakeTransport();
  let agentList: readonly { status: "running" | "idle" }[] | undefined;
  const activity = new LlmActivity(identity, transport, () => agentList as never);
  assert.equal(transport.sent.length, 1);
  assert.equal((transport.sent[0] as { status: string; kind: string }).status, "unknown");
  activity.publish();
  assert.equal(transport.sent.length, 1, "unchanged unknown state is not resent");

  transport.emit({
    type: LLM_ACTIVITY_CHANNEL,
    ...identity,
    kind: "request",
    requestId: "obs-1",
    operation: "observe",
    reservationId: "res-1",
  });
  assert.equal(transport.sent.length, 2, "explicit observe request still receives a reply");
  assert.equal((transport.sent[1] as { kind: string }).kind, "reply");

  agentList = [{ status: "running" }];
  activity.publish();
  activity.publish();
  assert.equal(transport.sent.length, 3, "unchanged busy state is not resent");
  assert.equal((transport.sent[2] as { status: string }).status, "busy");

  activity.close();
  assert.equal(transport.sent.length, 4, "closing transitions busy back to unknown once");
  assert.equal((transport.sent[3] as { status: string }).status, "unknown");
});
