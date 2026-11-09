/**
 * Control channel plan ops beyond lifecycle: plugin.install (exact source),
 * plugin.remove, plugin.toggle, runtime.set and llm-policy.set.
 * Covers closed params validation, op → workbench plan mapping, normalized
 * params on the frozen plan, and the llm-policy stopped-only rule (D5).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  CONTROL_CHANNEL_PREFIX,
  type ControlPlanResult,
} from "../../src/shared/control.ts";
import type { CreatorIssueResult } from "../../src/shared/creator.ts";
import type { WorkbenchPlanRequest } from "../../src/shared/workbench.ts";
import { SupervisorControl, type SupervisorControlPorts } from "../../src/adapters/node/supervisor/control.ts";
import { SupervisorCreator, type SupervisorCreatorPorts } from "../../src/adapters/node/supervisor/creator.ts";
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

const temps: string[] = [];
const listeners: Server[] = [];
const HOST_BEARER = "a".repeat(64);

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-control-ops-"));
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
  jobs: WorkbenchJobStore;
  origin: string;
  mutable: {
    epoch: string;
    revision: string;
    nowMs: number;
    running: Set<string>;
  };
  previewCalls: WorkbenchPlanRequest[];
  localPreviewCalls: WorkbenchPlanRequest[];
  executeCalls: string[];
  uiAutomation?: import("../../src/adapters/node/supervisor/ui-automation").UiAutomationManager;
}

function makeFixture(home: string, options: { running?: string[] } = {}): Fixture {
  const fixture = {
    home,
    origin: "http://127.0.0.1:1",
    mutable: {
      epoch: "e".repeat(64),
      revision: "f".repeat(64),
      nowMs: Date.now(),
      running: new Set(options.running ?? []),
    },
    previewCalls: [] as WorkbenchPlanRequest[],
    localPreviewCalls: [] as WorkbenchPlanRequest[],
    executeCalls: [] as string[],
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
  void ownerAlive;
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
    cli: () => ({ bin: join(home, "cli", "lib", "bin.js"), version: "0.2.0-rc.2" }),
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
  const echoPreview = (request: WorkbenchPlanRequest, prefix: string, calls: WorkbenchPlanRequest[]) => {
    calls.push(request);
    const target = "spaceId" in request ? request.spaceId : "";
    return {
      id: `${prefix}-${request.kind}-${calls.length}`,
      kind: request.kind,
      title: request.kind,
      scope: "space" as const,
      affectedSpaceIds: target ? [target] : [],
      runningSpaceIds: fixture.mutable.running.has(target) ? [target] : [],
      changes: [`preview:${request.kind}`],
      destructive: false,
      expiresAt: new Date(fixture.mutable.nowMs + 5 * 60_000).toISOString(),
      serviceEpoch: fixture.mutable.epoch,
      stateRevision: fixture.mutable.revision,
    };
  };
  const controlPorts: SupervisorControlPorts = {
    creator,
    origin: () => fixture.origin,
    now: () => new Date(fixture.mutable.nowMs),
    hostBearerEquals: (value) => value === HOST_BEARER,
    currentServiceEpoch: () => fixture.mutable.epoch,
    stateRevision: () => fixture.mutable.revision,
    writable: () => true,
    maintenance: () => false,
    dshVersion: () => "0.2.0-rc.2",
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
    previewPlan: async (request) => echoPreview(request, "wbplan", fixture.previewCalls),
    previewLocalPlan: (request) => echoPreview(request, "localplan", fixture.localPreviewCalls),
    executePlan: async (planId) => {
      fixture.executeCalls.push(planId);
      return { spaceId: "space-done" };
    },
    startSpace: async (spaceId) => ({ spaceId }),
    childRemote: () => undefined,
    observeChildWork: (action) => action(),
    setActiveJob: () => undefined,
    afterPlanJobSettled: () => undefined,
    templates: () => [],
    stagedImport: () => { throw new WorkbenchPublicError("workbench/not-found", "no staged import"); },
    sharePreview: async () => { throw new WorkbenchPublicError("workbench/unavailable", "no staging"); },
    runProductCommand: async () => ({}),
    uiAutomation: () => fixture.uiAutomation,
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

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((accept) => listener.close(() => accept()));
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NPM_SOURCE = { npm: { packageName: "dsh-plugin-a", version: "1.2.3" } };
const GITHUB_SOURCE = {
  github: { owner: "klarkxy", repo: "dsh-plugins", commit: "a".repeat(40), path: "plugins/dsh-b", packageName: "@scope/dsh-b" },
};

test("plugin.install maps to the exact-source maintenance plan and echoes normalized params", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const npm = await call(fx, "plan", scope, { op: "plugin.install", spaceId: "space-alpha", params: { source: NPM_SOURCE } });
  assert.equal(npm.body.ok, true, JSON.stringify(npm.body));
  const npmPlan = npm.body.value as ControlPlanResult;
  assert.deepEqual(fx.previewCalls.at(-1), {
    kind: "plugin.install.spec",
    spaceId: "space-alpha",
    source: { npm: { packageName: "dsh-plugin-a", version: "1.2.3" } },
  });
  assert.deepEqual(npmPlan.params, { source: { kind: "npm", packageName: "dsh-plugin-a", version: "1.2.3", approvedBuilds: [] } });
  assert.equal(npmPlan.taskActivity, "idle");

  const git = await call(fx, "plan", scope, {
    op: "plugin.install",
    spaceId: "space-alpha",
    params: { source: { github: { ...GITHUB_SOURCE.github, approvedBuilds: ["dep@1.0.0"] } } },
  });
  assert.equal(git.body.ok, true, JSON.stringify(git.body));
  const gitPlan = git.body.value as ControlPlanResult;
  assert.deepEqual(fx.previewCalls.at(-1), {
    kind: "plugin.install.spec",
    spaceId: "space-alpha",
    source: {
      github: { owner: "klarkxy", repo: "dsh-plugins", commit: "a".repeat(40), path: "plugins/dsh-b", packageName: "@scope/dsh-b", approvedBuilds: ["dep@1.0.0"] },
    },
  });
  const source = gitPlan.params && "source" in gitPlan.params ? gitPlan.params.source : undefined;
  assert.equal(source?.kind, "github");
  if (source?.kind === "github") assert.deepEqual(source.approvedBuilds, ["dep@1.0.0"]);
});

test("plugin source validation rejects non-exact pins, bad commits, paths and protected packages", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const bad: unknown[] = [
    { npm: { packageName: "dsh-plugin-a", version: "latest" } },
    { npm: { packageName: "dsh-plugin-a", version: "^1.2.3" } },
    { npm: { packageName: "@deepseek-ai/dsh-web-app", version: "0.2.1-rc.2" } },
    { npm: { packageName: "@dsh-spaces/plugin", version: "0.5.0" } },
    { github: { owner: "a", repo: "b", commit: "main", packageName: "p" } },
    { github: { owner: "a", repo: "b", commit: "a".repeat(39), packageName: "p" } },
    { github: { owner: "a", repo: "b", commit: "a".repeat(40), packageName: "@dsh-spaces/plugin" } },
    { github: { owner: "a", repo: "b", commit: "a".repeat(40), path: "../x", packageName: "p" } },
    { github: { owner: "a", repo: "b", commit: "a".repeat(40), path: "x\\y", packageName: "p" } },
    { github: { owner: "a", repo: "b", commit: "a".repeat(40), path: "x//y", packageName: "p" } },
    { github: { owner: "a", repo: "b", commit: "a".repeat(40), path: "x/.hidden ok", packageName: "p" } },
    { npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["*"] } },
    { npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["dep@git+https://example.com/o/r.git#abc"] } },
    { npm: { packageName: "p", version: "1.0.0", approvedBuilds: ["github.com/org/dep"] } },
    { npm: { packageName: "p", version: "1.0.0" }, github: {} },
    {},
    ["npm", "github"],
  ];
  for (const source of bad) {
    const result = await call(fx, "plan", scope, { op: "plugin.install", spaceId: "space-alpha", params: { source } });
    assert.equal(result.body.error?.code, "control/invalid-input", JSON.stringify(source));
  }
  assert.equal(fx.previewCalls.length, 0, "no invalid source ever reached the workbench preview");
});

test("plan params are a closed shape per op and required exactly where expected", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const invalid: unknown[] = [
    { op: "plugin.install", spaceId: "space-alpha" }, // missing params
    { op: "plugin.install", spaceId: "space-alpha", params: { source: NPM_SOURCE, extra: 1 } },
    { op: "plugin.remove", spaceId: "space-alpha", params: { packageName: "p", extra: 1 } },
    { op: "plugin.remove", spaceId: "space-alpha", params: {} },
    { op: "plugin.toggle", spaceId: "space-alpha", params: { packageName: "p" } },
    { op: "plugin.toggle", spaceId: "space-alpha", params: { packageName: "p", enabled: "yes" } },
    { op: "plugin.toggle", spaceId: "space-alpha", params: { packageName: "@deepseek-ai/dsh-base", enabled: true } },
    { op: "runtime.set", spaceId: "space-alpha", params: { version: "latest" } },
    { op: "runtime.set", spaceId: "space-alpha", params: {} },
    { op: "llm-policy.set", spaceId: "space-alpha", params: { inheritMain: "true" } },
    { op: "llm-policy.set", spaceId: "space-alpha", params: { inheritMain: true, extra: 1 } },
    { op: "start", spaceId: "space-alpha", params: {} },
    { op: "nuke", spaceId: "space-alpha", params: {} },
  ];
  for (const body of invalid) {
    const result = await call(fx, "plan", scope, body);
    assert.equal(result.body.error?.code, "control/invalid-input", JSON.stringify(body));
  }
});

test("remove, toggle and runtime.set map to their maintenance plans", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const remove = await call(fx, "plan", scope, { op: "plugin.remove", spaceId: "space-alpha", params: { packageName: "dsh-plugin-a" } });
  assert.equal(remove.body.ok, true, JSON.stringify(remove.body));
  assert.deepEqual(fx.previewCalls.at(-1), { kind: "plugin.remove", spaceId: "space-alpha", packageName: "dsh-plugin-a" });

  const toggle = await call(fx, "plan", scope, { op: "plugin.toggle", spaceId: "space-alpha", params: { packageName: "dsh-plugin-a", enabled: false } });
  assert.equal(toggle.body.ok, true, JSON.stringify(toggle.body));
  assert.deepEqual(fx.previewCalls.at(-1), { kind: "plugin.toggle", spaceId: "space-alpha", pluginId: "dsh-plugin-a", enabled: false });
  assert.deepEqual((toggle.body.value as ControlPlanResult).params, { packageName: "dsh-plugin-a", enabled: false });

  const runtime = await call(fx, "plan", scope, { op: "runtime.set", spaceId: "space-alpha", params: { version: "0.2.1-rc.2" } });
  assert.equal(runtime.body.ok, true, JSON.stringify(runtime.body));
  assert.deepEqual(fx.previewCalls.at(-1), { kind: "space.runtime.set", spaceId: "space-alpha", version: "0.2.1-rc.2" });
  const runtimePlan = runtime.body.value as ControlPlanResult;
  assert.deepEqual(runtimePlan.params, { version: "0.2.1-rc.2" });
  assert.equal(runtimePlan.taskActivity, "idle", "mutation ops carry the frozen activity snapshot");
});

test("llm-policy.set requires a stopped space at plan time", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  writeSpace(home, "beta");
  const fx = makeFixture(home, { running: ["space-beta"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const running = await call(fx, "plan", scope, { op: "llm-policy.set", spaceId: "space-beta", params: { inheritMain: true } });
  assert.equal(running.body.error?.code, "control/conflict");
  assert.match(running.body.error?.message ?? "", /plan a stop first/i);
  assert.equal(fx.localPreviewCalls.length, 0, "no plan was frozen for a running space");

  const stopped = await call(fx, "plan", scope, { op: "llm-policy.set", spaceId: "space-alpha", params: { inheritMain: true } });
  assert.equal(stopped.body.ok, true, JSON.stringify(stopped.body));
  const plan = stopped.body.value as ControlPlanResult;
  assert.deepEqual(fx.localPreviewCalls, [{ kind: "space.llm-policy.set", spaceId: "space-alpha", inheritMain: true }]);
  assert.deepEqual(plan.params, { inheritMain: true });
});

test("execute runs a plugin plan job through the frozen workbench plan id", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makeFixture(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const plan = (await call(fx, "plan", scope, {
    op: "plugin.install", spaceId: "space-alpha", params: { source: NPM_SOURCE },
  })).body.value as ControlPlanResult;
  const first = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-inst" });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  await fx.jobs.whenIdle();
  assert.deepEqual(fx.executeCalls, ["wbplan-plugin.install.spec-1"]);
  assert.equal(fx.jobs.job("req-inst").status, "succeeded");
});
