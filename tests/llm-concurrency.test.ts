import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EventEmitter } from "node:events";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { type StreamChunk } from "@deepseek-ai/dsh-llm";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import { createHomeLlmHost } from "../src/adapters/node/llm-host.ts";
import { SupervisorLlm, type SupervisorLlmHost } from "../src/adapters/node/supervisor/llm.ts";
import { SupervisorLifecycle } from "../src/adapters/node/supervisor/lifecycle.ts";
import { SpaceRunRegistry } from "../src/adapters/node/supervisor/space-runs.ts";
import type { GlobalLlmHost, LlmApplyCommand } from "../src/core/application/global-llm-host.ts";
import type { WorkbenchJobContext, WorkbenchJobStore } from "../src/adapters/node/workbench-jobs.ts";
import type { HomeControlHandle } from "../src/adapters/node/home-controller.ts";
import type { WorkbenchSpace } from "../src/shared/workbench.ts";
import { LlmActivity, installLlmActivity } from "../packages/llm-bridge/src/activity.ts";
import {
  LLM_ACTIVITY_CHANNEL, LLM_ACTIVITY_TIMEOUT_MS, parseActivityReport, type LlmActivityIdentity,
} from "../packages/llm-bridge/src/activity-protocol.ts";
import { FileLlmCatalogStore } from "../src/adapters/node/llm-catalog-store.ts";
import { FileLlmCredentialStore } from "../src/adapters/node/llm-credential-store.ts";
import { FileLlmPolicyStore } from "../src/adapters/node/llm-policy-store.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import { LLM_ERROR } from "../src/core/domain/llm-connections.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("two catalog writers with the same expected revision keep exactly one commit", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-llm-cas-"));
  temps.push(home);
  const left = new GlobalLlmService(
    new FileLlmCatalogStore(home),
    new FileLlmPolicyStore(home),
    new FileLlmCredentialStore(home),
    async () => ["alpha"],
  );
  const right = new GlobalLlmService(
    new FileLlmCatalogStore(home),
    new FileLlmPolicyStore(home),
    new FileLlmCredentialStore(home),
    async () => ["alpha"],
  );
  const draft = (name: string) => ({
    displayName: name,
    providerConfig: {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "demo-large" }],
    },
    auth: { kind: "none" as const },
  });
  const results = await Promise.allSettled([
    left.saveConnection(draft("left"), 0),
    right.saveConnection(draft("right"), 0),
  ]);
  const ok = results.filter((item) => item.status === "fulfilled");
  const failed = results.filter((item) => item.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as PromiseRejectedResult).reason.code, LLM_ERROR.REVISION_CONFLICT);
  const catalog = await left.readCatalog();
  assert.equal(catalog.revision, 1);
  assert.equal(Object.keys(catalog.connections).length, 1);
});

const activityIdentity: LlmActivityIdentity = { spaceId: "space-alpha", generation: 1, serviceEpoch: "a".repeat(64) };
const activityEnv = {
  DSH_SPACES_VIEW_ID: activityIdentity.spaceId,
  DSH_SPACES_VIEW_GENERATION: "1",
  DSH_SPACES_VIEW_SERVICE_EPOCH: activityIdentity.serviceEpoch,
};

class ActivityPipe extends EventEmitter {
  connected = true;
  peer?: ActivityPipe;
  sent: unknown[] = [];
  deliver: (message: unknown) => boolean = () => true;
  sendError: (message: unknown) => Error | null = () => null;
  send(message: unknown, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    if (!this.connected) { callback(new Error("disconnected")); return false; }
    const error = this.sendError(message);
    if (error) { callback(error); return false; }
    queueMicrotask(() => {
      if (this.deliver(message)) this.peer?.emit("message", message);
      callback(null);
    });
    return true;
  }
}

function activityPipes() {
  const parent = new ActivityPipe(), child = new ActivityPipe();
  parent.peer = child;
  child.peer = parent;
  return { parent, child };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function maintenanceAgent(status: "idle" | "running" = "idle") {
  let pending: ReturnType<typeof deferred> | undefined;
  let signal: AbortController | undefined;
  const agent = {
    status,
    async whenIdle() {
      let observed;
      do { observed = pending; await observed?.promise; } while (observed !== pending);
    },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (pending || agent.status !== "idle") throw new Error("agent already has active work");
      const completion = deferred();
      pending = completion;
      signal = new AbortController();
      return (async () => {
        try { return await task(signal!.signal); }
        finally { pending = undefined; completion.resolve(); }
      })();
    },
    cancel() { signal?.abort(); },
  };
  return agent;
}

async function flushActivity() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function activitySupervisor() {
  const home = mkdtempSync(join(tmpdir(), "dsh-llm-activity-"));
  temps.push(home);
  const runs = new SpaceRunRegistry();
  runs.generations.set(activityIdentity.spaceId, 1);
  runs.llmApplied.set(activityIdentity.spaceId, 0);
  const lifecycle = new SupervisorLifecycle();
  lifecycle.handle = {} as HomeControlHandle;
  let llmHost: GlobalLlmHost;
  let status: WorkbenchSpace["status"] = "running";
  let stops = 0, starts = 0;
  let beforeStop = async () => {};
  const host: SupervisorLlmHost = {
    home, runs, lifecycle, llmHost: () => llmHost, jobs: () => ({} as WorkbenchJobStore),
    managerId: () => null, llmBridgeArtifact: () => undefined, observeChildWork: (action) => action(),
    requireManaged: (id) => id, installArtifact: async () => {}, artifactDigest: () => "",
    homeProfileNames: () => [activityIdentity.spaceId], publicStatus: () => status,
    currentServiceEpoch: () => activityIdentity.serviceEpoch,
    stopOwned: async () => {
      await beforeStop();
      stops++;
      status = "stopped";
    },
    startSpace: async () => {
      starts++;
      runs.nextGeneration(activityIdentity.spaceId);
      status = "running";
      return undefined;
    },
  };
  const supervisor = new SupervisorLlm(host);
  llmHost = createHomeLlmHost(home, {
    listSpaceIds: async () => [activityIdentity.spaceId],
    instances: {
      list: async () => supervisor.listLlmInstances(),
      get: async (id) => supervisor.listLlmInstances().find((row) => row.spaceId === id),
      markApplied: async (id, revision) => { runs.llmApplied.set(id, revision); },
    },
    assertWritable: () => {},
    submitApply: async () => { throw new Error("test executes the job directly"); },
  });
  const ctx: WorkbenchJobContext = {
    signal: new AbortController().signal,
    phase: () => {}, message: () => {}, cancellable: () => {}, result: () => {},
  };
  const command = (): LlmApplyCommand => ({
    kind: "llm.apply", spaceIds: [activityIdentity.spaceId], catalogRevision: 0,
    observations: supervisor.listLlmInstances(),
  });
  return {
    supervisor, runs, command, ctx,
    get stops() { return stops; }, get starts() { return starts; },
    beforeStop: (action: () => Promise<void>) => { beforeStop = action; },
    status: (next: WorkbenchSpace["status"]) => { status = next; },
  };
}

test("official stream waterfall stays busy through overlapping iterators and returns idle on finish", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const ctx = new Context();
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(LlmRuntime);
  let adapterCalls = 0;
  ctx.on("llm/stream", () => (async function* () {
    adapterCalls++;
    yield { type: "text-delta", text: "controlled in-memory delta" } as StreamChunk;
  })());
  installLlmActivity(ctx, activityEnv, child);
  await flushActivity();
  try {
    const command = setup.command();
    assert.equal(command.observations[0].busy, false);
    assert.equal(command.observations[0].status, "running");
    const left = ctx.llm.stream({ provider: "in-memory", model: "test", messages: [] })[Symbol.asyncIterator]();
    const right = ctx.llm.stream({ provider: "in-memory", model: "test", messages: [] })[Symbol.asyncIterator]();
    assert.equal((await left.next()).done, false);
    assert.equal((await right.next()).done, false);
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].busy, true);
    await assert.rejects(setup.supervisor.runLlmApply(command, setup.ctx), { code: LLM_ERROR.SPACE_BUSY });
    assert.equal(setup.stops, 0);
    await left.next();
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].busy, true);
    await right.next();
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].busy, false);
    assert.equal(adapterCalls, 2);
    await setup.supervisor.runLlmApply(setup.command(), setup.ctx);
    assert.equal(setup.stops, 1);
    assert.equal(setup.starts, 1);
  } finally {
    detach();
    await ctx.fiber.dispose();
  }
});

test("stream failure and consumer return release activity only after iterator cleanup", async () => {
  const { child } = activityPipes();
  const activity = new LlmActivity(activityIdentity, child, () => []);
  const cleanup = deferred(), cleaning = deferred();
  try {
    const stream = activity.stream(() => (async function* () {
      try {
        yield { type: "text-delta", text: "partial" } as StreamChunk;
      } finally {
        cleaning.resolve();
        await cleanup.promise;
      }
    })())[Symbol.asyncIterator]();
    await stream.next();
    const closed = stream.return!();
    await cleaning.promise;
    assert.equal(activity.status(), "busy");
    cleanup.resolve();
    await closed;
    assert.equal(activity.status(), "idle");
    const failed = activity.stream(() => { throw new Error("original dispatch failure"); })[Symbol.asyncIterator]();
    await assert.rejects(failed.next(), /original dispatch failure/);
    assert.equal(activity.status(), "idle");
    const iterationFailed = activity.stream(() => (async function* () {
      yield { type: "text-delta", text: "partial" } as StreamChunk;
      throw new Error("original iteration failure");
    })())[Symbol.asyncIterator]();
    await iterationFailed.next();
    await assert.rejects(iterationFailed.next(), /original iteration failure/);
    assert.equal(activity.status(), "idle");
  } finally {
    cleanup.resolve();
    activity.close();
  }
});

test("running agents and unknown activity refuse apply; agent idle clears busy", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  let agents: Array<ReturnType<typeof maintenanceAgent>> | undefined = [maintenanceAgent("running")];
  const activity = new LlmActivity(activityIdentity, child, () => agents);
  try {
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].busy, true);
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.SPACE_BUSY });
    agents![0].status = "idle";
    activity.publish();
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].busy, false);
    agents = undefined;
    activity.publish();
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "unknown");
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.APPLY_FAILED });
    assert.equal(setup.stops, 0);
    setup.status("stopped");
    await setup.supervisor.runLlmApply(setup.command(), setup.ctx);
    assert.equal(setup.starts, 0);
  } finally {
    activity.close();
    detach();
  }
});

test("fresh idle reservation denies raced stream consumption and releases after failed stop", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => []);
  await flushActivity();
  let calls = 0;
  setup.beforeStop(async () => {
    const stream = activity.stream(() => {
      calls++;
      return (async function* () {})();
    })[Symbol.asyncIterator]();
    await assert.rejects(stream.next(), { code: LLM_ERROR.SPACE_BUSY });
    throw new Error("original stop failure");
  });
  try {
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), /original stop failure/);
    assert.equal(calls, 0);
    assert.equal(setup.stops, 0);
    assert.equal(setup.starts, 0);
    assert.equal(activity.status(), "idle");
    const stream = activity.stream(() => (async function* () {
      calls++;
      yield { type: "text-delta", text: "new explicitly consumed stream" } as StreamChunk;
    })())[Symbol.asyncIterator]();
    await stream.next();
    assert.equal(calls, 1);
    await stream.return!();
  } finally {
    activity.close();
    detach();
  }
});

test("fresh reservation refuses active work even when its state notification has not reached the supervisor", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const agents = [maintenanceAgent()];
  const activity = new LlmActivity(activityIdentity, child, () => agents);
  await flushActivity();
  const command = setup.command();
  // Deliberately withhold agent/status to model the IPC observation/admission race.
  agents[0].status = "running";
  try {
    await assert.rejects(setup.supervisor.runLlmApply(command, setup.ctx), { code: LLM_ERROR.APPLY_FAILED });
    assert.equal(setup.stops, 0);
    assert.equal(setup.starts, 0);
    agents[0].status = "idle";
    activity.publish();
    await flushActivity();
    await setup.supervisor.runLlmApply(setup.command(), setup.ctx);
    assert.equal(setup.starts, 1);
  } finally {
    activity.close();
    detach();
  }
});

test("activity reports cannot cross child identity, generation or epoch; disconnect invalidates idle", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => []);
  await flushActivity();
  try {
    const base = { type: LLM_ACTIVITY_CHANNEL, kind: "state", status: "idle", revision: 999, ...activityIdentity };
    parent.emit("message", { ...base, generation: 2 });
    parent.emit("message", { ...base, serviceEpoch: "b".repeat(64) });
    parent.emit("message", { ...base, spaceId: "space-beta" });
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "running");
    setup.runs.nextGeneration(activityIdentity.spaceId);
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "unknown");
    setup.runs.generations.set(activityIdentity.spaceId, 1);
    parent.connected = false;
    parent.emit("disconnect");
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "unknown");
    assert.equal(parent.listenerCount("message"), 0);
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.APPLY_FAILED });
    assert.equal(setup.stops, 0);
  } finally {
    activity.close();
    detach();
  }
});

test("startup probe timeout does not overwrite a later authoritative idle report", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  // The bootstrap request precedes bridge loading; its original message is lost.
  await flushActivity();
  const activity = new LlmActivity(activityIdentity, child, () => []);
  try {
    await flushActivity();
    t.mock.timers.tick(LLM_ACTIVITY_TIMEOUT_MS + 1);
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "running");
    await setup.supervisor.runLlmApply(setup.command(), setup.ctx);
    assert.equal(setup.starts, 1);
  } finally {
    activity.close();
    detach();
  }
});

test("lost reserve reply refuses stop and releases only that request's admission", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => []);
  await flushActivity();
  child.deliver = (raw) => (raw as { reserved?: boolean }).reserved !== true;
  const apply = setup.supervisor.runLlmApply(setup.command(), setup.ctx);
  const failed = assert.rejects(apply, { code: LLM_ERROR.APPLY_FAILED });
  try {
    await flushActivity();
    t.mock.timers.tick(LLM_ACTIVITY_TIMEOUT_MS + 1);
    await failed;
    assert.equal(setup.stops, 0);
    assert.equal(setup.starts, 0);
    const stream = activity.stream(() => (async function* () {
      yield { type: "text-delta", text: "explicit request after failed admission" } as StreamChunk;
    })())[Symbol.asyncIterator]();
    assert.equal((await stream.next()).done, false);
    await stream.return!();
    child.deliver = () => true;
    await flushActivity();
    await setup.supervisor.runLlmApply(setup.command(), setup.ctx);
    assert.equal(setup.starts, 1);
  } finally {
    activity.close();
    detach();
  }
});

test("activity protocol rejects malformed status and unordered revisions", async () => {
  const base = { type: LLM_ACTIVITY_CHANNEL, kind: "state", status: "idle", revision: 1, ...activityIdentity };
  for (const status of [undefined, false, ["idle"], {}, "ready"]) {
    assert.equal(parseActivityReport({ ...base, status }, activityIdentity), undefined);
  }
  assert.equal(parseActivityReport({ ...base, revision: -1 }, activityIdentity), undefined);
  assert.equal(parseActivityReport({ ...base, revision: Number.MAX_SAFE_INTEGER + 1 }, activityIdentity), undefined);
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => []);
  try {
    await flushActivity();
    parent.emit("message", { ...base, status: "busy", revision: 100 });
    parent.emit("message", { ...base, status: "idle", revision: 99 });
    assert.equal(setup.supervisor.listLlmInstances()[0].busy, true);
  } finally {
    activity.close();
    detach();
  }
});

test("reporting failure refuses apply without blocking ordinary model streams", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => []);
  try {
    await flushActivity();
    child.sendError = (raw) => (raw as { kind?: string }).kind === "state" ? new Error("report send failure") : null;
    activity.publish();
    assert.equal(activity.status(), "unknown");
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.APPLY_FAILED });
    assert.equal(setup.stops, 0);
    let calls = 0;
    const stream = activity.stream(() => (async function* () {
      calls++;
      yield { type: "text-delta", text: "normal work continues after reporting failure" } as StreamChunk;
    })())[Symbol.asyncIterator]();
    assert.equal((await stream.next()).done, false);
    await stream.return!();
    assert.equal(calls, 1);
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "unknown");
  } finally {
    activity.close();
    detach();
  }
});

test("reporting disconnect retains an existing reservation but never gates an unreserved stream", async () => {
  const { parent, child } = activityPipes();
  const activity = new LlmActivity(activityIdentity, child, () => []);
  child.emit("message", {
    type: LLM_ACTIVITY_CHANNEL, ...activityIdentity, kind: "request",
    requestId: "reserve-request", operation: "reserve", reservationId: "exact-reservation",
  });
  child.emit("disconnect");
  await assert.rejects(activity.stream(() => (async function* () {})())[Symbol.asyncIterator]().next(), {
    code: LLM_ERROR.SPACE_BUSY,
  });
  const unreserved = new LlmActivity(activityIdentity, parent, () => []);
  parent.emit("disconnect");
  const stream = unreserved.stream(() => (async function* () {
    yield { type: "text-delta", text: "ordinary request after disconnected reporter" } as StreamChunk;
  })())[Symbol.asyncIterator]();
  assert.equal((await stream.next()).done, false);
  await stream.return!();
  assert.equal(unreserved.status(), "unknown");
});

for (const missing of ["release delivery", "release acknowledgement"] as const) {
  test(`failed ${missing} retains stop failure and unknown admission despite later idle reports`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const setup = activitySupervisor();
    const { parent, child } = activityPipes();
    const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
    const activity = new LlmActivity(activityIdentity, child, () => []);
    await flushActivity();
    setup.beforeStop(async () => { throw new Error("original owned stop failure"); });
    if (missing === "release delivery") parent.deliver = (raw) => (raw as { operation?: string }).operation !== "release";
    else child.deliver = (raw) => (raw as { released?: boolean }).released !== true;
    const failed = assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx),
      /original owned stop failure; LLM apply reservation release could not be confirmed/);
    try {
      await flushActivity();
      t.mock.timers.tick(LLM_ACTIVITY_TIMEOUT_MS + 1);
      await failed;
      assert.equal(setup.stops, 0);
      assert.equal(setup.starts, 0);
      activity.publish();
      await flushActivity();
      assert.equal(setup.supervisor.listLlmInstances()[0].status, "unknown");
      const requestsBefore = parent.sent.length;
      await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx),
        /reservation release could not be confirmed/);
      assert.equal(parent.sent.length, requestsBefore);
      if (missing === "release delivery") {
        await assert.rejects(activity.stream(() => (async function* () {})())[Symbol.asyncIterator]().next(), {
          code: LLM_ERROR.SPACE_BUSY,
        });
      } else {
        const stream = activity.stream(() => (async function* () {})())[Symbol.asyncIterator]();
        assert.equal((await stream.next()).done, true);
      }
    } finally {
      activity.close();
      detach();
    }
  });
}

test("agents service readiness publishes initial idle and removal publishes unknown without a model request", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const ctx = new Context();
  installLlmActivity(ctx, activityEnv, child);
  try {
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "unknown");
    const registry = await ctx.plugin(AgentRegistry);
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "running");
    assert.equal(setup.supervisor.listLlmInstances()[0].busy, false);
    await registry.dispose();
    await flushActivity();
    assert.equal(setup.supervisor.listLlmInstances()[0].status, "unknown");
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.APPLY_FAILED });
    assert.equal(setup.stops, 0);
  } finally {
    detach();
    await ctx.fiber.dispose();
  }
});

test("maintenance before and after a stream refuses apply without cancelling or continuing the original task", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const agent = maintenanceAgent();
  const activity = new LlmActivity(activityIdentity, child, () => [agent]);
  const beforeStream = deferred(), afterStream = deferred(), streamed = deferred();
  let maintenanceSignal: AbortSignal | undefined;
  let completed = false;
  await flushActivity();
  const task = agent.runMaintenance(async signal => {
    maintenanceSignal = signal;
    await beforeStream.promise;
    for await (const _chunk of activity.stream(() => (async function* () {
      yield { type: "text-delta", text: "controlled maintenance chunk" } as StreamChunk;
    })())) {}
    streamed.resolve();
    await afterStream.promise;
    completed = true;
    return "original task result";
  });
  try {
    await flushActivity();
    assert.equal(agent.status, "idle");
    assert.equal(activity.status(), "busy");
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.SPACE_BUSY });
    assert.equal(setup.stops, 0);
    assert.equal(maintenanceSignal!.aborted, false);
    beforeStream.resolve();
    await streamed.promise;
    await flushActivity();
    assert.equal(activity.status(), "busy");
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.SPACE_BUSY });
    assert.equal(setup.stops, 0);
    assert.equal(completed, false);
    afterStream.resolve();
    assert.equal(await task, "original task result");
    await flushActivity();
    assert.equal(activity.status(), "idle");
    assert.equal(setup.stops, 0);
    await setup.supervisor.runLlmApply(setup.command(), setup.ctx);
    assert.equal(setup.stops, 1);
    assert.equal(setup.starts, 1);
  } finally {
    beforeStream.resolve(); afterStream.resolve(); await task;
    activity.close(); detach();
  }
});

test("maintenance already active at bridge attachment is unobservable until genuine settlement", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const agent = maintenanceAgent(), finish = deferred();
  let signal: AbortSignal | undefined;
  const task = agent.runMaintenance(async current => { signal = current; await finish.promise; });
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => [agent]);
  try {
    await flushActivity();
    assert.equal(agent.status, "idle");
    assert.equal(activity.status(), "unknown");
    await assert.rejects(setup.supervisor.runLlmApply(setup.command(), setup.ctx), { code: LLM_ERROR.APPLY_FAILED });
    assert.equal(signal!.aborted, false);
    finish.resolve(); await task;
    await flushActivity();
    assert.equal(activity.status(), "idle");
    assert.equal(setup.stops, 0);
  } finally {
    finish.resolve(); await task; activity.close(); detach();
  }
});

test("reservation excludes newly arriving maintenance and its own cancellation allows stop to settle", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const agent = maintenanceAgent();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => [agent]);
  let originalTaskCalls = 0;
  setup.beforeStop(async () => {
    assert.throws(() => agent.runMaintenance(async () => { originalTaskCalls++; }), { code: LLM_ERROR.SPACE_BUSY });
    // The official disposer cancels then awaits whenIdle. Admission must not
    // make that bounded resource cleanup wait for the later IPC release.
    agent.cancel();
    await agent.whenIdle();
  });
  try {
    await flushActivity();
    await setup.supervisor.runLlmApply(setup.command(), setup.ctx);
    assert.equal(originalTaskCalls, 0);
    assert.equal(setup.stops, 1);
    assert.equal(setup.starts, 1);
    assert.equal(activity.status(), "idle");
  } finally {
    agent.cancel(); activity.close(); detach();
  }
});

test("atomic native claim refuses a maintenance alias raced after the idle observation", async () => {
  const setup = activitySupervisor();
  const { parent, child } = activityPipes();
  const agent = maintenanceAgent();
  const original = agent.runMaintenance.bind(agent), finish = deferred();
  const detach = setup.supervisor.attachChild(activityIdentity.spaceId, parent, 1, activityIdentity.serviceEpoch);
  const activity = new LlmActivity(activityIdentity, child, () => [agent]);
  await flushActivity();
  const command = setup.command();
  let signal: AbortSignal | undefined;
  const task = original(async current => { signal = current; await finish.promise; });
  try {
    assert.equal(activity.status(), "idle");
    await assert.rejects(setup.supervisor.runLlmApply(command, setup.ctx), { code: LLM_ERROR.APPLY_FAILED });
    assert.equal(signal!.aborted, false);
    assert.equal(setup.stops, 0);
    finish.resolve(); await task;
    await flushActivity();
    assert.equal(activity.status(), "idle");
    assert.equal(setup.starts, 0);
  } finally {
    finish.resolve(); await task; activity.close(); detach();
  }
});

test("missing maintenance lifetime or a non-writable guard refuses idle proof", async () => {
  const { child } = activityPipes();
  const unsupported = new LlmActivity(activityIdentity, child, () => [{ status: "idle" }]);
  assert.equal(unsupported.status(), "unknown");
  unsupported.close();
  const agent = maintenanceAgent();
  Object.freeze(agent);
  const fixed = new LlmActivity(activityIdentity, child, () => [agent]);
  try {
    await flushActivity();
    assert.equal(fixed.status(), "unknown");
  } finally { fixed.close(); }
});
