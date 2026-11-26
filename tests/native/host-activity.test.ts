import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import {
  computeHostActivity,
  computeHostAttention,
  computeHostWorking,
  parseHostActivity,
  readHostActivity,
  type HostActivitySources,
} from "../../packages/plugin/src/host/host-activity.ts";
import { hostActivityProjectionSchema } from "../../packages/plugin/src/host/workbench-schemas.ts";
import { TYPERT } from "../../packages/plugin/src/typert.host.ts";
import { TYPERT_REMOTE } from "../../packages/plugin/src/typert.remote-client.ts";
import { createWorkbenchGuideRemote } from "../../packages/plugin/src/client/workbench-remote.ts";
import { WorkbenchGuideHost } from "../../packages/plugin/src/host/workbench-guide.ts";
import { SpacesPlugin } from "../../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";

function sources(overrides: Partial<HostActivitySources> = {}): HostActivitySources {
  return {
    typertGateway: { getPendingRemoteEvents: () => [] as { event: string; agentId: unknown }[] },
    sessions: { list: () => [] as unknown[] },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [], settled: [] } } }) },
    agents: { list: () => [] as { status: string }[] },
    ...overrides,
  };
}

test("host attention is required only for pending approvals or answerable questions", () => {
  const base = sources();
  assert.equal(computeHostAttention(base), "none");

  const unrelated = sources({ typertGateway: { getPendingRemoteEvents: () => [{ event: "other/event", agentId: "s-1" }] } });
  assert.equal(computeHostAttention(unrelated), "none");

  const approval = sources({ typertGateway: { getPendingRemoteEvents: () => [{ event: "approval/request", agentId: "s-1" }] } });
  assert.equal(computeHostAttention(approval), "required");

  const questionEvent = sources({ typertGateway: { getPendingRemoteEvents: () => [{ event: "user-questions/request", agentId: "s-1" }] } });
  assert.equal(computeHostAttention(questionEvent), "required");

  const activeCard = sources({
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [{ callId: "c-1" }], settled: [] } } }) },
  });
  assert.equal(computeHostAttention(activeCard), "required");

  const settled = sources({
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: [], settled: [{ callId: "c-1" }] } } }) },
  });
  assert.equal(computeHostAttention(settled), "none");
});

test("a missing or malformed userQuestions projection is unknown, never a false quiet", () => {
  // The official registry serves an empty values map when the unit is not registered.
  const unregistered = sources({
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  });
  assert.equal(computeHostAttention(unregistered), "unknown");
  // And a working agent must not turn that into a green light downstream.
  assert.deepEqual(computeHostActivity(sources({
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    agents: { list: () => [{ status: "running" }] },
  })), { attention: "unknown", working: "busy" });
  for (const malformed of [
    { userQuestions: null },
    { userQuestions: {} },
    { userQuestions: { active: "yes" } },
    { userQuestions: { settled: [] } },
    { userQuestions: "active" },
  ]) {
    const degraded = sources({
      sessions: { list: () => [{ id: "s-1" }] },
      sessionProjections: { snapshot: () => ({ values: malformed }) },
    });
    assert.equal(computeHostAttention(degraded), "unknown", JSON.stringify(malformed));
  }
  // Coverage is per session: one unreadable session degrades even when others are clean.
  let calls = 0;
  const partial = sources({
    sessions: { list: () => [{ id: "s-1" }, { id: "s-2" }] },
    sessionProjections: {
      snapshot: () => (++calls === 1
        ? { values: { userQuestions: { active: [] } } }
        : { values: {} }),
    },
  });
  assert.equal(computeHostAttention(partial), "unknown");
});

test("a confirmed pending approval or question stays required regardless of projection coverage", () => {
  const approval = sources({
    typertGateway: { getPendingRemoteEvents: () => [{ event: "approval/request", agentId: "s-1" }] },
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  });
  assert.equal(computeHostAttention(approval), "required");
  const question = sources({
    typertGateway: { getPendingRemoteEvents: () => [{ event: "user-questions/request", agentId: "s-1" }] },
    sessions: { list: () => [{ id: "s-1" }] },
    sessionProjections: { snapshot: () => { throw new Error("projection read failed"); } },
  });
  assert.equal(computeHostAttention(question), "required");
  // An active card wins even when a later session's projection is unreadable.
  let calls = 0;
  const cardFirst = sources({
    sessions: { list: () => [{ id: "s-1" }, { id: "s-2" }] },
    sessionProjections: {
      snapshot: () => (++calls === 1
        ? { values: { userQuestions: { active: [{ callId: "c-1" }] } } }
        : { values: {} }),
    },
  });
  assert.equal(computeHostAttention(cardFirst), "required");
});

test("attention degrades to unknown when a required service is missing or a read throws", () => {
  assert.equal(computeHostAttention({}), "unknown");
  assert.equal(computeHostAttention(sources({ typertGateway: undefined })), "unknown");
  assert.equal(computeHostAttention(sources({ sessions: undefined })), "unknown");
  assert.equal(computeHostAttention(sources({ sessionProjections: undefined })), "unknown");
  const throwing = sources({
    sessionProjections: { snapshot: () => { throw new Error("session gone"); } },
    sessions: { list: () => [{ id: "s-1" }] },
  });
  assert.equal(computeHostAttention(throwing), "unknown", "a single throwing read degrades without a confirmed signal");
  assert.deepEqual(computeHostActivity(throwing), { attention: "unknown", working: "idle" });
});

/** Sessions whose projection behavior is keyed by id: valid quiet, active card, missing, or throwing. */
function mixedSessions(
  entries: readonly (readonly [id: string, kind: "quiet" | "active" | "missing" | "throw"])[],
  gateway?: HostActivitySources["typertGateway"],
): HostActivitySources {
  return sources({
    ...(gateway === undefined ? {} : { typertGateway: gateway }),
    sessions: { list: () => entries.map(([id]) => ({ id })) },
    sessionProjections: {
      snapshot: (session) => {
        const id = (session as { id: string }).id;
        const kind = entries.find(([entry]) => entry === id)?.[1];
        if (kind === "throw") throw new Error("projection read failed");
        if (kind === "missing") return { values: {} };
        return { values: { userQuestions: { active: kind === "active" ? [{ callId: `c-${id}` }] : [] } } };
      },
    },
  });
}

test("attention aggregation is order-independent: a confirmed card wins in every permutation", () => {
  const arrangements: (readonly (readonly [string, "quiet" | "active" | "missing" | "throw"])[])[] = [
    [["s-1", "active"], ["s-2", "missing"]],
    [["s-1", "missing"], ["s-2", "active"]],
    [["s-1", "throw"], ["s-2", "active"]],
    [["s-1", "active"], ["s-2", "throw"]],
    [["s-1", "quiet"], ["s-2", "missing"], ["s-3", "active"], ["s-4", "throw"]],
  ];
  for (const entries of arrangements) {
    assert.equal(computeHostAttention(mixedSessions(entries)), "required", JSON.stringify(entries));
  }
  // One channel's failure never masks what the other channel confirmed.
  const absentProjectionService = sources({
    typertGateway: { getPendingRemoteEvents: () => [{ event: "approval/request", agentId: "s-1" }] },
    sessions: undefined,
    sessionProjections: undefined,
  });
  assert.equal(computeHostAttention(absentProjectionService), "required", "gateway pending survives a missing projection channel");
  const throwingGateway = mixedSessions(
    [["s-1", "active"]],
    { getPendingRemoteEvents: () => { throw new Error("gateway gone"); } },
  );
  assert.equal(computeHostAttention(throwingGateway), "required", "an active card survives a failing gateway channel");
  const missingGateway = mixedSessions([["s-1", "active"]], undefined);
  assert.equal(computeHostAttention({ ...missingGateway, typertGateway: undefined }), "required", "an active card survives an absent gateway channel");
});

test("attention aggregation only reports none for full coverage, and unknown for coverage gaps without a signal", () => {
  assert.equal(computeHostAttention(mixedSessions([["s-1", "quiet"], ["s-2", "quiet"]])), "none");
  assert.equal(computeHostAttention(mixedSessions([])), "none", "no live sessions is a fully covered quiet");
  assert.equal(computeHostAttention(mixedSessions([["s-1", "missing"], ["s-2", "quiet"]])), "unknown");
  assert.equal(computeHostAttention(mixedSessions([["s-1", "throw"], ["s-2", "quiet"]])), "unknown");
  assert.equal(computeHostAttention(mixedSessions([["s-1", "missing"], ["s-2", "missing"]])), "unknown");
  const degradedGatewayQuiet = mixedSessions(
    [["s-1", "quiet"]],
    { getPendingRemoteEvents: () => { throw new Error("gateway gone"); } },
  );
  assert.equal(computeHostAttention(degradedGatewayQuiet), "unknown", "a failing gateway degrades an otherwise quiet scan");
});

test("host working is busy only when an agent is running; unrecognized values are unknown, never idle", () => {
  assert.equal(computeHostWorking(sources()), "idle", "no live agents means idle");
  assert.equal(computeHostWorking(sources({ agents: { list: () => [{ status: "idle" }] } })), "idle");
  assert.equal(computeHostWorking(sources({ agents: { list: () => [{ status: "idle" }, { status: "running" }] } })), "busy");
  assert.equal(computeHostWorking(sources({ agents: { list: () => [{ status: "starting" }] } })), "unknown");
  assert.equal(computeHostWorking(sources({ agents: { list: () => [{}] } })), "unknown");
  assert.equal(computeHostWorking(sources({ agents: undefined })), "unknown");
});

test("the two dimensions are independent: one degraded read never masks the other", () => {
  const attentionUnknown = computeHostActivity(sources({ typertGateway: undefined, agents: { list: () => [{ status: "running" }] } }));
  assert.deepEqual(attentionUnknown, { attention: "unknown", working: "busy" });
  const workingUnknown = computeHostActivity(sources({ agents: undefined }));
  assert.deepEqual(workingUnknown, { attention: "none", working: "unknown" });
  const throwing = computeHostActivity(sources({
    typertGateway: { getPendingRemoteEvents: () => { throw new Error("gateway gone"); } },
    agents: { list: () => { throw new Error("agents gone"); } },
  }));
  assert.deepEqual(throwing, { attention: "unknown", working: "unknown" });
});

test("parseHostActivity accepts only the closed wire shape", () => {
  const valid = { attention: "none", working: "idle" };
  assert.deepEqual(parseHostActivity(valid), valid);
  assert.deepEqual(parseHostActivity({ attention: "required", working: "busy" }), { attention: "required", working: "busy" });
  assert.deepEqual(parseHostActivity({ attention: "unknown", working: "unknown" }), { attention: "unknown", working: "unknown" });
  for (const invalid of [
    { attention: "none" },
    { working: "idle" },
    { attention: "none", working: "idle", extra: true },
    { attention: "busy", working: "idle" },
    { attention: "none", working: "running" },
    { attention: "none", working: "idle", serviceEpoch: "a".repeat(64) },
    null, [], "none", 0, true,
  ]) {
    assert.equal(parseHostActivity(invalid), undefined, JSON.stringify(invalid));
  }
  assert.equal(hostActivityProjectionSchema.safeParse(valid).success, true);
  assert.equal(hostActivityProjectionSchema.safeParse({ attention: "required", working: "busy" }).success, true);
  assert.equal(hostActivityProjectionSchema.safeParse({ ...valid, extra: true }).success, false);
});

test("readHostActivity resolves services lazily from the owning context", () => {
  const ctx = new Context();
  ctx.provide("typertGateway", { getPendingRemoteEvents: () => [] } as never);
  ctx.provide("sessions", { list: () => [] } as never);
  ctx.provide("sessionProjections", { snapshot: () => ({ values: {} }) } as never);
  ctx.provide("agents", { list: () => [{ status: "idle" }] } as never);
  try {
    assert.deepEqual(readHostActivity(ctx), { attention: "none", working: "idle" });
  } finally {
    void ctx.fiber.dispose();
  }
  const empty = new Context();
  try {
    assert.deepEqual(readHostActivity(empty), { attention: "unknown", working: "unknown" }, "missing services are unknown, never guessed");
  } finally {
    void empty.fiber.dispose();
  }
});

test("the guide answers the sampler projection only when one was installed", async () => {
  const projection = { attention: "required" as const, working: "busy" as const };
  const withSampler = new WorkbenchGuideHost(new Context(), {} as never, () => projection);
  assert.deepEqual(await withSampler.hostActivity(), projection);
  const without = new WorkbenchGuideHost(new Context(), {} as never);
  assert.deepEqual(await without.hostActivity(), { attention: "unknown", working: "unknown" });
  const failing = new WorkbenchGuideHost(new Context(), {} as never, () => { throw new Error("sampler exploded"); });
  assert.deepEqual(await failing.hostActivity(), { attention: "unknown", working: "unknown" }, "a throwing sampler degrades, never errors the read");
});

test("hostActivity is a no-arg strict guide endpoint on both faces, validated by the closed schema", async () => {
  const host = TYPERT.invocations.find((row) => row.namespace === "workbenchGuide" && row.method === "hostActivity");
  const remote = TYPERT_REMOTE.descriptors.find((row) => row.namespace === "workbenchGuide" && row.method === "hostActivity");
  assert.ok(host, "host descriptor exists");
  assert.ok(remote, "remote descriptor exists");
  assert.deepEqual(host.parameters, []);
  assert.deepEqual(remote.parameters, []);
  assert.equal(host.result.mode, "strict");
  const codec = host.result.create();
  for (const valid of [
    { attention: "none", working: "idle" },
    { attention: "required", working: "busy" },
    { attention: "unknown", working: "unknown" },
  ]) {
    assert.equal(codec.safeParse(valid).success, true, JSON.stringify(valid));
  }
  for (const invalid of [
    { attention: "none", working: "idle", extra: true },
    { attention: "busy", working: "idle" },
    { attention: "none", working: "running" },
    { attention: "none" },
  ]) {
    assert.equal(codec.safeParse(invalid).success, false, JSON.stringify(invalid));
  }
  const calls: { endpoint: string; args: unknown }[] = [];
  const value = { attention: "required", working: "busy" };
  const guide = createWorkbenchGuideRemote({
    rpc: {
      async call(_channel: string, endpoint: string, body: { args?: unknown }) {
        calls.push({ endpoint, args: body.args });
        return { ok: true, value };
      },
    },
  } as never);
  assert.equal(typeof guide.hostActivity, "function", "the client exposes the optional endpoint");
  assert.deepEqual(await guide.hostActivity!(), value);
  assert.deepEqual(calls, [{ endpoint: "workbenchGuide/hostActivity", args: {} }]);
});

const wiringRoot = mkdtempSync(join(tmpdir(), "host-activity-wiring-"));

function writeIsolatedProfile(home: string, profile: string): string {
  const cli = join(home, "cli");
  mkdirSync(join(cli, "lib"), { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION }));
  const bin = join(cli, "lib/bin.js");
  writeFileSync(bin, "export {};\n");
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `isolated-${profile}` }));
  return dir;
}

function isolatedRuntime(home: string, profile: string): WorkbenchHostRuntime {
  const dir = writeIsolatedProfile(home, profile);
  return new WorkbenchHostRuntime({
    home,
    allowRealHome: false,
    argv: [process.execPath, join(home, "cli/lib/bin.js"), "--profile", profile],
    env: { DSH_HOME: home },
    execPath: process.execPath,
    baseUrl: pathToFileURL(dir).href + "/",
    supervisorTimeoutMs: 2000,
    bootstrap: async () => ({ connected: false, origin: null, reasons: ["not started in this unit test"] }),
  });
}

function provideActivityServices(ctx: Context): void {
  ctx.provide("typertGateway", { getPendingRemoteEvents: () => [] } as never);
  ctx.provide("sessions", { list: () => [] } as never);
  ctx.provide("sessionProjections", { snapshot: () => ({ values: {} }) } as never);
  ctx.provide("agents", { list: () => [{ status: "running" }] } as never);
}

test("the plugin projects host activity only on the trusted main host, never across spaces", async () => {
  for (const [profile, trusted] of [["web", true], ["notes", false]] as const) {
    const home = mkdtempSync(join(wiringRoot, `${profile}-`));
    const runtime = isolatedRuntime(home, profile);
    assert.equal(runtime.isTrustedMainHost, trusted, `${profile} trust`);
    const ctx = new Context();
    provideActivityServices(ctx);
    try {
      const plugin = new SpacesPlugin(ctx, {}, runtime);
      const projection = await plugin.guide.hostActivity();
      if (trusted) {
        assert.deepEqual(projection, { attention: "none", working: "busy" }, "the main host reads its own agents");
      } else {
        assert.deepEqual(projection, { attention: "unknown", working: "unknown" }, "a child profile never sees the host projection even with services present");
      }
    } finally {
      await ctx.fiber.dispose();
    }
  }
});

test("a desktop main host projects its own activity the same way", async () => {
  const home = mkdtempSync(join(wiringRoot, "desktop-"));
  const runtime = isolatedRuntime(home, "desktop");
  assert.equal(runtime.isTrustedMainHost, true);
  const ctx = new Context();
  provideActivityServices(ctx);
  try {
    const plugin = new SpacesPlugin(ctx, {}, runtime);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await plugin.guide.hostActivity(), { attention: "none", working: "busy" });
  } finally {
    await ctx.fiber.dispose();
  }
});
