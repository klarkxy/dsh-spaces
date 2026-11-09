/**
 * `plugin.live.*` plan/execute wiring: the control channel's running-space
 * ops freeze supervisor-local plans and execute through the child's own
 * pluginManager inside the same serialized job lane as every other writer.
 *
 * Covers: running-only admission at plan time, supervisor-local plan kinds,
 * the job-time running/fingerprint re-check, protected-package refusals,
 * serialization against a stopped-writer job, and the inspect
 * `plugins.live` section's not-running / runtime-view answers.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  CONTROL_CHANNEL_PREFIX,
  ControlPublicError,
  type ControlPlanResult,
} from "../../src/shared/control.ts";
import type { CreatorIssueResult } from "../../src/shared/creator.ts";
import type { WorkbenchPlanRequest } from "../../src/shared/workbench.ts";
import { SupervisorControl, type SupervisorControlPorts } from "../../src/adapters/node/supervisor/control.ts";
import { SupervisorCreator, type SupervisorCreatorPorts } from "../../src/adapters/node/supervisor/creator.ts";
import { SupervisorPlans } from "../../src/adapters/node/supervisor/plans.ts";
import { SupervisorLifecycle } from "../../src/adapters/node/supervisor/lifecycle.ts";
import { SupervisorSpaces } from "../../src/adapters/node/supervisor/spaces.ts";
import { SpaceRunRegistry } from "../../src/adapters/node/supervisor/space-runs.ts";
import { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import { WorkbenchJobStore } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import { WorkbenchPublicError } from "../../src/adapters/node/supervisor/errors.ts";
import type { WorkbenchDiagnostics } from "../../src/shared/workbench-product.ts";
import type { ProcessManager } from "../../src/adapters/node/runtime/process-manager.ts";
import type { SpaceBaseCreation } from "../../src/adapters/node/supervisor/base-creation.ts";
import type { NodeSpacesService } from "../../src/adapters/node/products/spaces-service.ts";
import type { SupervisorPlansHost } from "../../src/adapters/node/supervisor/plans.ts";
import { SpaceMessageRouter } from "../../src/adapters/node/message-bus/router.ts";
import type { ChildRemoteClient } from "../../src/adapters/node/supervisor/child-remote.ts";

const temps: string[] = [];
const listeners: Server[] = [];
const HOST_BEARER = "a".repeat(64);
const EPOCH = "e".repeat(64);
const REVISION = "f".repeat(64);

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((accept) => listener.close(() => accept()));
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-live-"));
  temps.push(home);
  return home;
}

function writeProfile(home: string, name: string): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ private: true })}\n`);
}

function writeSpace(home: string, name: string): string {
  const id = `space-${name}`;
  writeProfile(home, id);
  const spacesPath = join(home, "hub", "spaces.json");
  const spaces = existsSync(spacesPath)
    ? (JSON.parse(readFileSync(spacesPath, "utf8")) as { version: 1; order: string[]; meta: Record<string, Record<string, unknown>> })
    : { version: 1 as const, order: [] as string[], meta: {} };
  spaces.meta[id] = { displayName: name, order: spaces.order.length + 1000, createdAt: "2025-01-01T00:00:00.000Z" };
  if (!spaces.order.includes(id)) spaces.order.push(id);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(spacesPath, `${JSON.stringify(spaces, null, 2)}\n`);
  return id;
}

interface Fixture {
  home: string;
  control: SupervisorControl;
  plans: SupervisorPlans;
  plansHostRuns: SpaceRunRegistry;
  jobs: WorkbenchJobStore;
  origin: string;
  mutable: {
    epoch: string;
    revision: string;
    nowMs: number;
    running: Set<string>;
    spawned: Set<string>;
    generations: Map<string, number>;
  };
  localPreviewCalls: WorkbenchPlanRequest[];
  liveCalls: Array<{ request: WorkbenchPlanRequest }>;
  liveAnswer?: (request: WorkbenchPlanRequest) => Promise<unknown>;
}

function makeFixture(home: string, options: { running?: string[] } = {}): Fixture {
  const fixture = {
    home,
    origin: "http://127.0.0.1:1",
    mutable: {
      epoch: EPOCH,
      revision: REVISION,
      nowMs: Date.now(),
      running: new Set(options.running ?? []),
      spawned: new Set(options.running ?? []),
      generations: new Map((options.running ?? []).map((id) => [id, 1])),
    },
    localPreviewCalls: [] as WorkbenchPlanRequest[],
    liveCalls: [] as Array<{ request: WorkbenchPlanRequest }>,
  } as Fixture;
  const lifecycle = new SupervisorLifecycle(() => {});
  let ownerAlive = true;
  lifecycle.handle = {
    owner: {
      kind: "web",
      pid: process.pid,
      nonce: "n".repeat(32),
      startedAt: new Date().toISOString(),
      endpoint: "http://127.0.0.1:1",
    },
    release: async () => { ownerAlive = false; },
  } as never;
  const lock = new HomeOperationLock(home);
  const registry = new ProfileRegistry(home);
  const runs = new SpaceRunRegistry();
  const jobs = new WorkbenchJobStore({ home });
  const processes = {
    statusOf: (name: string) => (fixture.mutable.running.has(name) ? "running" : "stopped"),
  } as unknown as ProcessManager;
  const inventory = new SupervisorSpaces({
    home, registry, lifecycle, runs,
    processes: () => processes,
    managerId: () => "spaces-hub",
  });
  const creator = new SupervisorCreator({
    home,
    origin: () => fixture.origin,
    now: () => new Date(fixture.mutable.nowMs),
    fetch: globalThis.fetch.bind(globalThis),
    lifecycle,
    lock,
    registry,
    runs,
    jobs: () => jobs,
    managerId: () => "spaces-hub",
    cli: () => ({ bin: join(home, "cli", "lib", "bin.js"), version: "0.2.2-rc.1" }),
    spaces: () => ({}) as NodeSpacesService,
    bases: {} as SpaceBaseCreation,
    hostBearerEquals: (value) => value === HOST_BEARER,
    assertOwner: () => undefined,
    currentServiceEpoch: () => fixture.mutable.epoch,
    stateRevision: () => fixture.mutable.revision,
    registeredSpaceIds: () => inventory.listSpaces().map((row) => row.id),
    maintenance: () => false,
    hasComponent: () => false,
    ensureViewBridge: async () => undefined,
    ensureLlmBridge: async () => undefined,
    installedRuntimeBin: () => join(home, "cli", "lib", "bin.js"),
    pluginAdd: async () => undefined,
    observeChildWork: (action) => action(),
    setActiveJob: () => undefined,
  } satisfies SupervisorCreatorPorts);

  const plansHost: SupervisorPlansHost = {
    home,
    lifecycle,
    runs,
    instances: () => ({ writeLifecyclePlan() {}, consumeLifecyclePlan() {}, readLifecyclePlan: () => undefined }) as never,
    lock,
    registry,
    now: () => new Date(fixture.mutable.nowMs),
    messageBus: new SpaceMessageRouter(),
    options: { home, bin: "" },
    jobs: () => jobs,
    maintenance: () => null,
    closeHttp: async () => undefined,
    dropWritable: () => undefined,
    requireSpace: (id) => inventory.requireSpace(id),
    requireManaged: (id) => inventory.requireSpace(id),
    protectSpecial: (id, opts) => inventory.protectSpecial(id, opts),
    statusOf: (id) => (fixture.mutable.running.has(id) ? "running" : "stopped"),
    ownedSpaceIds: () => inventory.ownedSpaceIds(),
    stopOwned: async () => undefined,
    stopOwnedAll: async () => undefined,
    startSpace: async (id) => ({ spaceId: id }),
    readLlmPolicy: () => ({ inheritMain: false }),
    writeLlmPolicy: () => undefined,
    pluginLive: async (request) => {
      fixture.liveCalls.push({ request });
      if (fixture.liveAnswer) await fixture.liveAnswer(request);
      return { spaceId: request.spaceId };
    },
    currentServiceEpoch: () => fixture.mutable.epoch,
    stateRevision: () => fixture.mutable.revision,
    productObservation: () => ({ serviceEpoch: fixture.mutable.epoch, expectedRevision: fixture.mutable.revision }),
    assertLiveContext: () => undefined,
  };
  fixture.plans = new SupervisorPlans(plansHost);
  fixture.plansHostRuns = runs;

  const controlPorts: SupervisorControlPorts = {
    creator,
    origin: () => fixture.origin,
    now: () => new Date(fixture.mutable.nowMs),
    hostBearerEquals: (value) => value === HOST_BEARER,
    currentServiceEpoch: () => fixture.mutable.epoch,
    stateRevision: () => fixture.mutable.revision,
    writable: () => true,
    maintenance: () => false,
    dshVersion: () => "0.2.2-rc.1",
    jobs: () => jobs,
    maintenanceService: () => null,
    managerId: () => "spaces-hub",
    listSpaces: () => inventory.listSpaces(),
    requireSpace: (spaceId) => inventory.requireSpace(spaceId),
    unmanaged: (id) => runs.unmanaged.has(id),
    detail: async () => ({ plugins: [] }),
    diagnostics: (spaceId): WorkbenchDiagnostics => ({ spaceId, status: "stopped", logs: [], backups: [] }),
    llmPolicy: () => ({ inheritMain: false }),
    observeTaskActivity: async () => "idle",
    admitSubmission: () => {
      if (!ownerAlive) throw new WorkbenchPublicError("workbench/read-only");
    },
    assertWritable: () => {
      if (!ownerAlive) throw new WorkbenchPublicError("workbench/read-only");
    },
    assertLiveContext: (context) => {
      if (context.serviceEpoch !== fixture.mutable.epoch || context.expectedRevision !== fixture.mutable.revision) {
        throw new WorkbenchPublicError("workbench/conflict");
      }
    },
    previewPlan: async (request) => {
      throw new WorkbenchPublicError("workbench/unsupported", `unexpected previewPlan ${request.kind}`);
    },
    previewLocalPlan: (request) => {
      fixture.localPreviewCalls.push(request);
      return fixture.plans.previewLocal(request);
    },
    executePlan: (planId, ctx) => fixture.plans.executePlan(planId, ctx),
    startSpace: async (spaceId) => ({ spaceId }),
    childRemote: (spaceId, generation, serviceEpoch) => {
      if (!fixture.mutable.running.has(spaceId) || !fixture.mutable.spawned.has(spaceId)) return undefined;
      if (serviceEpoch !== fixture.mutable.epoch) return undefined;
      // A structural stub: pluginLive executes the frozen request; the
      // plugins.live read surfaces this stub's honest failure.
      return {
        call: async () => {
          throw new ControlPublicError("control/unavailable", "stub remote");
        },
      } as unknown as ChildRemoteClient;
    },
    observeChildWork: (action) => action(),
    setActiveJob: () => undefined,
    afterPlanJobSettled: () => undefined,
    templates: () => [],
    stagedImport: () => { throw new WorkbenchPublicError("workbench/not-found", "no staged import"); },
    sharePreview: async () => { throw new WorkbenchPublicError("workbench/unavailable", "no staging"); },
    runProductCommand: async () => ({}),
    uiAutomation: () => undefined,
  };
  fixture.control = new SupervisorControl(controlPorts);
  fixture.jobs = jobs;
  return fixture;
}

interface IdentityServer {
  origin: string;
  bearer: string;
}

async function startIdentityServer(expected: { home: string; profile: string }): Promise<IdentityServer> {
  const bearer = "c".repeat(64);
  const server = createServer((req, res) => {
    const fail = (status: number) => { res.writeHead(status); res.end(); };
    if (req.method !== "POST" || req.headers.authorization !== `Bearer ${bearer}`) return fail(401);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString()) as { nonce?: unknown };
        if (req.url !== "/identity") return fail(404);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ nonce: input.nonce, home: resolve(expected.home), profile: expected.profile }));
      } catch {
        fail(400);
      }
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); });
  });
  listeners.push(server);
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, bearer };
}

async function call(fx: Fixture, op: string, bearer: string, body: unknown) {
  const response = await fetch(`${fx.origin}${CONTROL_CHANNEL_PREFIX}${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
  return { status: response.status, body: parsed };
}

async function serve(fx: Fixture): Promise<void> {
  const server = createServer((req, res) => {
    void (async () => {
      if (await fx.control.handle(req, res)) return;
      res.writeHead(404); res.end();
    })();
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); accept(); });
  });
  listeners.push(server);
  const port = (server.address() as { port: number }).port;
  fx.origin = `http://127.0.0.1:${port}`;
}

async function issueScope(fx: Fixture, listener: IdentityServer): Promise<string> {
  const result = await call(fx, "issue", HOST_BEARER, {
    origin: listener.origin,
    bearer: listener.bearer,
    home: fx.home,
    profile: "web",
  });
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return (result.body.value as CreatorIssueResult).scopes.control!;
}

const NPM_SOURCE = { npm: { packageName: "dsh-plugin-a", version: "1.2.3" } };

test("plugin.live.* ops require a running space at plan time and freeze supervisor-local kinds", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  writeSpace(home, "beta");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  // Stopped space: every live op refuses with guidance to the stopped ops.
  for (const body of [
    { op: "plugin.live.install", spaceId: "space-beta", params: { source: NPM_SOURCE } },
    { op: "plugin.live.update", spaceId: "space-beta", params: { packageName: "dsh-plugin-a", version: "1.2.3" } },
    { op: "plugin.live.entry", spaceId: "space-beta", params: { entryId: "include:e1", enabled: false } },
    { op: "plugin.live.remove", spaceId: "space-beta", params: { packageName: "dsh-plugin-a" } },
  ]) {
    const result = await call(fx, "plan", scope, body);
    assert.equal(result.body.error?.code, "control/conflict", JSON.stringify(body));
    assert.match(result.body.error?.message ?? "", /requires a running space/i);
    assert.match(result.body.error?.message ?? "", /stopped/i);
  }
  assert.equal(fx.localPreviewCalls.length, 0);

  // Running space: each op freezes its own supervisor-local kind and the
  // approval facts name the running application path.
  const cases: Array<{ body: unknown; kind: string }> = [
    { body: { op: "plugin.live.install", spaceId: "space-alpha", params: { source: NPM_SOURCE } }, kind: "plugin.live.install" },
    { body: { op: "plugin.live.update", spaceId: "space-alpha", params: { packageName: "dsh-plugin-a", version: "1.2.3" } }, kind: "plugin.live.update" },
    { body: { op: "plugin.live.entry", spaceId: "space-alpha", params: { entryId: "include:e1", enabled: false } }, kind: "plugin.live.entry" },
    { body: { op: "plugin.live.remove", spaceId: "space-alpha", params: { packageName: "dsh-plugin-a" } }, kind: "plugin.live.remove" },
  ];
  for (const { body, kind } of cases) {
    const result = await call(fx, "plan", scope, body);
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    const plan = result.body.value as ControlPlanResult;
    assert.equal(plan.op, (body as { op: string }).op);
    assert.ok(plan.changes.some((line) => /own plugin manager/i.test(line)), JSON.stringify(plan.changes));
    assert.ok(plan.changes.some((line) => /no supervisor-side profile write/i.test(line)), JSON.stringify(plan.changes));
  }
  assert.deepEqual(fx.localPreviewCalls.map((row) => row.kind), [
    "plugin.live.install", "plugin.live.update", "plugin.live.entry", "plugin.live.remove",
  ]);
});

test("closed params are enforced for the live ops before any freeze", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const invalid: unknown[] = [
    { op: "plugin.live.install", spaceId: "space-alpha" },
    { op: "plugin.live.install", spaceId: "space-alpha", params: {} },
    { op: "plugin.live.install", spaceId: "space-alpha", params: { source: { npm: { packageName: "x", version: "latest" } } } },
    { op: "plugin.live.update", spaceId: "space-alpha", params: { packageName: "x" } },
    { op: "plugin.live.update", spaceId: "space-alpha", params: { packageName: "x", version: "^1" } },
    { op: "plugin.live.update", spaceId: "space-alpha", params: { packageName: "@deepseek-ai/dsh-base", version: "0.2.2-rc.1" } },
    { op: "plugin.live.entry", spaceId: "space-alpha", params: { entryId: "has space", enabled: true } },
    { op: "plugin.live.entry", spaceId: "space-alpha", params: { entryId: "include:e1" } },
    { op: "plugin.live.remove", spaceId: "space-alpha", params: { packageName: "@dsh-spaces/plugin" } },
    { op: "plugin.live.remove", spaceId: "space-alpha", params: { packageName: "x", extra: 1 } },
  ];
  for (const body of invalid) {
    const result = await call(fx, "plan", scope, body);
    assert.equal(result.body.error?.code, "control/invalid-input", JSON.stringify(body));
  }
  assert.equal(fx.localPreviewCalls.length, 0);
});

test("plugin.live.install refuses approvedBuilds instead of silently dropping them", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const result = await call(fx, "plan", scope, {
    op: "plugin.live.install",
    spaceId: "space-alpha",
    params: { source: { npm: { packageName: "dsh-plugin-a", version: "1.2.3", approvedBuilds: ["dep@1.0.0"] } } },
  });
  assert.equal(result.body.error?.code, "control/unsupported");
  assert.match(result.body.error?.message ?? "", /plugin\.install/i);
  assert.equal(fx.localPreviewCalls.length, 0, "no plan was frozen for an unmappable option");
});

test("execute runs a live plan through pluginLive inside the serialized job", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const plan = (await call(fx, "plan", scope, {
    op: "plugin.live.entry", spaceId: "space-alpha", params: { entryId: "include:e1", enabled: true },
  })).body.value as ControlPlanResult;
  const first = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-live-entry" });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  await fx.jobs.whenIdle();
  assert.equal(fx.liveCalls.length, 1);
  assert.deepEqual(fx.liveCalls[0]?.request, {
    kind: "plugin.live.entry", spaceId: "space-alpha", entryId: "include:e1", enabled: true,
  });
  const job = fx.jobs.job("req-live-entry");
  assert.equal(job.status, "succeeded");
  assert.equal(job.kind, "control.execute");
});

test("a space that stops between plan and job fails the job without calling the child", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const plan = (await call(fx, "plan", scope, {
    op: "plugin.live.remove", spaceId: "space-alpha", params: { packageName: "dsh-plugin-a" },
  })).body.value as ControlPlanResult;
  // The space stops between execute admission and the frozen fingerprint:
  // the observed-state check consumes the plan instead of submitting.
  fx.mutable.running.delete("space-alpha");
  const result = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-stale-live" });
  assert.equal(result.body.error?.code, "control/request-conflict");
  await fx.jobs.whenIdle();
  assert.equal(fx.liveCalls.length, 0, "the child was never contacted");
  const second = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-stale-live2" });
  assert.equal(second.body.error?.code, "control/plan-consumed");
});

test("execute-time fingerprint refuses a restarted generation before pluginLive runs", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  const spaceId = "space-alpha";
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  // Freeze via the supervisor-local plan path exactly like the channel does.
  const plan = fx.plans.previewLocal({ kind: "plugin.live.update", spaceId, packageName: "dsh-plugin-a", version: "1.2.3" });
  // Restart bumps the generation: the execute-time fingerprint recomputes
  // and refuses before pluginLive sees the request.
  fx.plansHostRuns.nextGeneration(spaceId);
  const job = await fx.jobs.submit({ kind: "plan.execute", planId: plan.id }, "req-live-stale", (ctx) =>
    fx.plans.executePlan(plan.id, ctx),
  );
  await fx.jobs.whenIdle();
  assert.equal(fx.jobs.job(job.id).status, "failed");
  assert.equal(fx.liveCalls.length, 0);
});

test("previewLocal refuses live ops on stopped and protected spaces", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  assert.throws(
    () => fx.plans.previewLocal({ kind: "plugin.live.remove", spaceId: "space-ghost", packageName: "x" }),
    (error) => error instanceof WorkbenchPublicError && (error.code === "workbench/not-found" || error.code === "workbench/conflict"),
  );
  // Reserved profiles are refused before any freeze — not-found when they
  // are not registered spaces, protected when they are.
  for (const id of ["web", "desktop", "spaces-hub"]) {
    assert.throws(
      () => fx.plans.previewLocal({ kind: "plugin.live.remove", spaceId: id, packageName: "x" }),
      (error) => error instanceof WorkbenchPublicError &&
        (error.code === "workbench/protected" || error.code === "workbench/not-found"),
      `${id} must be refused`,
    );
  }
  // A registered but stopped space conflicts at previewLocal too.
  writeSpace(home, "beta");
  assert.throws(
    () => fx.plans.previewLocal({ kind: "plugin.live.remove", spaceId: "space-beta", packageName: "x" }),
    (error) => error instanceof WorkbenchPublicError && error.code === "workbench/conflict",
  );
});

test("live ops serialize with a stopped-writer job on the same lane", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const livePlan = (await call(fx, "plan", scope, {
    op: "plugin.live.entry", spaceId: "space-alpha", params: { entryId: "include:e1", enabled: false },
  })).body.value as ControlPlanResult;

  const order: string[] = [];
  fx.liveAnswer = async () => {
    order.push("live-start");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    order.push("live-end");
  };
  const liveJob = await call(fx, "execute", scope, { planId: livePlan.controlPlanId, requestId: "req-live-serial" });
  assert.equal(liveJob.body.ok, true, JSON.stringify(liveJob.body));
  await fx.jobs.submit({ kind: "plan.execute", planId: "manual-stop-sim" }, "req-manual-stop", async () => {
    order.push("stopped-writer");
    return { spaceId: "space-alpha" };
  });
  await fx.jobs.whenIdle();
  // Both jobs settle on the same lane; the live write did not interleave
  // with the stopped-writer job.
  assert.deepEqual(order, ["live-start", "live-end", "stopped-writer"]);
  assert.equal(fx.jobs.job("req-live-serial").status, "succeeded");
  assert.equal(fx.jobs.job("req-manual-stop").status, "succeeded");
});

test("inspect plugins.live reports the running runtime view and not-running for a stopped space", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  writeSpace(home, "beta");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  // Stopped space: control/not-running, never an empty fabricated list.
  const stopped = await call(fx, "read", scope, { view: "inspect", spaceId: "space-beta", sections: ["plugins.live"] });
  assert.equal(stopped.body.ok, true, JSON.stringify(stopped.body));
  const stoppedLive = (stopped.body.value as { pluginsLive?: { ok: boolean; code?: string } }).pluginsLive;
  assert.equal(stoppedLive?.ok, false);
  assert.equal(stoppedLive?.code, "control/not-running");

  // Running space with the stub client: the section reports the remote's
  // honest failure rather than inventing rows.
  const running = await call(fx, "read", scope, { view: "inspect", spaceId: "space-alpha", sections: ["plugins.live"] });
  assert.equal(running.body.ok, true, JSON.stringify(running.body));
  const runningLive = (running.body.value as { pluginsLive?: { ok: boolean; code?: string } }).pluginsLive;
  assert.equal(runningLive?.ok, false);
  assert.equal(runningLive?.code, "control/unavailable");
});
