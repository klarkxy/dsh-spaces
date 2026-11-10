import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  CONTROL_CHANNEL_PREFIX,
  type ControlContext,
  type ControlInspectResult,
  type ControlLogsResult,
  type ControlOverviewResult,
} from "../../src/shared/control.ts";
import { CREATOR_CHANNEL_PREFIX, type CreatorIssueResult } from "../../src/shared/creator.ts";
import { SupervisorControl, type SupervisorControlPorts } from "../../src/adapters/node/supervisor/control.ts";
import { SupervisorCreator, type SupervisorCreatorPorts } from "../../src/adapters/node/supervisor/creator.ts";
import { SupervisorLifecycle } from "../../src/adapters/node/supervisor/lifecycle.ts";
import { SupervisorSpaces } from "../../src/adapters/node/supervisor/spaces.ts";
import { SpaceRunRegistry } from "../../src/adapters/node/supervisor/space-runs.ts";
import { HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import { ProfileRegistry } from "../../src/adapters/node/profile/profile-registry.ts";
import { WorkbenchJobStore } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import { WorkbenchPublicError } from "../../src/adapters/node/supervisor/errors.ts";
import type { WorkbenchPlanRequest } from "../../src/shared/workbench.ts";
import type { WorkbenchDiagnostics } from "../../src/shared/workbench-product.ts";
import type { DiagnosticLogEntry } from "../../src/shared/diagnostics.ts";
import type { ProcessManager } from "../../src/adapters/node/runtime/process-manager.ts";
import type { SpaceBaseCreation } from "../../src/adapters/node/supervisor/base-creation.ts";
import type { NodeSpacesService } from "../../src/adapters/node/products/spaces-service.ts";
import type { WorkbenchMaintenance } from "../../src/adapters/node/supervisor/types.ts";

const temps: string[] = [];
const listeners: Server[] = [];
const HOST_BEARER = "a".repeat(64);

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-control-"));
  temps.push(home);
  return home;
}

function writeProfile(home: string, name: string): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    private: true,
    dependencies: { "@deepseek-ai/dsh-web-app": "0.1.5-rc.1" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-web-app"] } },
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeSpace(home: string, name: string, meta: Record<string, unknown> = {}): string {
  const id = `space-${name}`;
  writeProfile(home, id);
  const spacesPath = join(home, "hub", "spaces.json");
  const spaces = existsSync(spacesPath)
    ? (JSON.parse(readFileSync(spacesPath, "utf8")) as { version: 1; order: string[]; meta: Record<string, Record<string, unknown>> })
    : { version: 1 as const, order: [] as string[], meta: {} };
  spaces.meta[id] = { displayName: name, order: spaces.order.length + 1000, createdAt: "2025-01-01T00:00:00.000Z", ...meta };
  if (!spaces.order.includes(id)) spaces.order.push(id);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(spacesPath, `${JSON.stringify(spaces, null, 2)}\n`);
  return id;
}

interface Fixture {
  home: string;
  creator: SupervisorCreator;
  control: SupervisorControl;
  ports: SupervisorControlPorts;
  creatorPorts: SupervisorCreatorPorts;
  jobs: WorkbenchJobStore | undefined;
  registry: ProfileRegistry;
  runs: SpaceRunRegistry;
  /** Mutable: serve() rewrites it to the bound loopback origin. */
  origin: string;
  /** Mutable test clock/state the ports close over. */
  mutable: {
    epoch: string;
    revision: string;
    nowMs: number;
    activities: Map<string, "idle" | "busy" | "unknown">;
    running: Set<string>;
  };
  /** Recorded mutation calls the channel's job runners made. */
  previewCalls: unknown[];
  executeCalls: string[];
  startCalls: string[];
  settledHooks: string[];
  /** When set, previewPlan throws this error. */
  previewError?: Error;
  uiAutomation?: import("../../src/adapters/node/supervisor/ui-automation").UiAutomationManager;
}

function makePorts(home: string, options: {
  jobs?: WorkbenchJobStore;
  writable?: boolean;
  running?: string[];
  diagnostics?: (spaceId: string) => WorkbenchDiagnostics;
  detail?: SupervisorControlPorts["detail"];
  maintenanceService?: () => WorkbenchMaintenance | null;
  childRemote?: SupervisorControlPorts["childRemote"];
} = {}): Fixture {
  const fixture = {
    home,
    origin: "http://127.0.0.1:1",
    mutable: {
      epoch: "e".repeat(64),
      revision: "f".repeat(64),
      nowMs: Date.now(),
      activities: new Map<string, "idle" | "busy" | "unknown">(),
      running: new Set(options.running ?? []),
    },
    previewCalls: [] as unknown[],
    executeCalls: [] as string[],
    startCalls: [] as string[],
    settledHooks: [] as string[],
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
  const jobs = options.jobs === undefined && options.writable !== false ? new WorkbenchJobStore({ home }) : options.jobs;
  const processes = {
    statusOf: (name: string) => (fixture.mutable.running.has(name) ? "running" : "stopped"),
  } as unknown as ProcessManager;
  const inventory = new SupervisorSpaces({
    home, registry, lifecycle, runs,
    processes: () => processes,
    managerId: () => "spaces-hub",
  });
  const creatorPorts: SupervisorCreatorPorts = {
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
    assertOwner: () => {
      if (!ownerAlive) throw new WorkbenchPublicError("workbench/read-only");
    },
    currentServiceEpoch: () => fixture.mutable.epoch,
    stateRevision: () => fixture.mutable.revision,
    registeredSpaceIds: () => inventory.listSpaces().map((row) => row.id),
    maintenance: () => false,
    hasComponent: () => false,
    ensureViewBridge: async () => undefined,
    syncMainModels: async () => ({ mainProfile: "web", routes: [], deepseek: false, credentials: [], skipped: [], missingCredentials: [] }),
    installedRuntimeBin: () => join(home, "cli", "lib", "bin.js"),
    pluginAdd: async () => undefined,
    observeChildWork: (action) => action(),
    setActiveJob: () => undefined,
  };
  const creator = new SupervisorCreator(creatorPorts);
  const diagnosticsDefault = (spaceId: string): WorkbenchDiagnostics => ({
    spaceId,
    status: fixture.mutable.running.has(spaceId) ? "running" : "stopped",
    logs: [],
    backups: [],
  });
  const activityOf = (spaceId: string): "idle" | "busy" | "unknown" =>
    fixture.mutable.activities.get(spaceId) ??
    (fixture.mutable.running.has(spaceId) ? "busy" : "idle");
  const controlPorts: SupervisorControlPorts = {
    creator,
    origin: () => fixture.origin,
    now: () => new Date(fixture.mutable.nowMs),
    hostBearerEquals: (value) => value === HOST_BEARER,
    currentServiceEpoch: () => fixture.mutable.epoch,
    stateRevision: () => fixture.mutable.revision,
    writable: () => options.writable !== false,
    maintenance: () => false,
    dshVersion: () => "0.2.0-rc.2",
    jobs: () => jobs,
    maintenanceService: options.maintenanceService ?? (() => null),
    managerId: () => "spaces-hub",
    listSpaces: () => inventory.listSpaces(),
    requireSpace: (spaceId) => inventory.requireSpace(spaceId),
    unmanaged: (id) => runs.unmanaged.has(id),
    detail: options.detail ?? (async () => ({ plugins: [{ name: "dsh-plugin-one", version: "1.0.0" }] })),
    diagnostics: options.diagnostics ?? diagnosticsDefault,
    observeTaskActivity: async (spaceId) => activityOf(spaceId),
    admitSubmission: () => {
      if (options.writable === false || !ownerAlive) throw new WorkbenchPublicError("workbench/read-only");
    },
    assertWritable: () => {
      if (options.writable === false || !ownerAlive) throw new WorkbenchPublicError("workbench/read-only");
    },
    assertLiveContext: (context) => {
      if (context.serviceEpoch !== fixture.mutable.epoch || context.expectedRevision !== fixture.mutable.revision) {
        throw new WorkbenchPublicError("workbench/conflict");
      }
    },
    previewPlan: async (request) => {
      fixture.previewCalls.push(request);
      if (fixture.previewError) throw fixture.previewError;
      const row = request as { kind: string; spaceId: string };
      const kind = row.kind as WorkbenchPlanRequest["kind"];
      const id = `wbplan-${kind}-${fixture.previewCalls.length}`;
      return {
        id,
        kind,
        ...(kind !== "space.delete" ? { taskActivity: activityOf(row.spaceId) } : {}),
        title: kind,
        scope: "space" as const,
        affectedSpaceIds: [row.spaceId],
        runningSpaceIds: fixture.mutable.running.has(row.spaceId) ? [row.spaceId] : [],
        changes: kind === "space.delete"
          ? ["Remove this space's profile and installed plugins.", "Keep this space's isolated sessions and storage on disk."]
          : [kind],
        destructive: kind === "space.delete",
        expiresAt: new Date(fixture.mutable.nowMs + 5 * 60_000).toISOString(),
        serviceEpoch: fixture.mutable.epoch,
        stateRevision: fixture.mutable.revision,
      };
    },
    previewLocalPlan: (request) => {
      fixture.previewCalls.push(request);
      if (fixture.previewError) throw fixture.previewError;
      const row = request as { kind: string; spaceId: string };
      return {
        id: `localplan-${row.kind}-${fixture.previewCalls.length}`,
        kind: row.kind as never,
        title: row.kind,
        scope: "space" as const,
        affectedSpaceIds: [row.spaceId],
        runningSpaceIds: [],
        changes: [row.kind],
        destructive: false,
        expiresAt: new Date(fixture.mutable.nowMs + 5 * 60_000).toISOString(),
        serviceEpoch: fixture.mutable.epoch,
        stateRevision: fixture.mutable.revision,
      };
    },
    executePlan: async (planId) => {
      fixture.executeCalls.push(planId);
      return { spaceId: "space-done" };
    },
    startSpace: async (spaceId) => {
      fixture.startCalls.push(spaceId);
      fixture.mutable.running.add(spaceId);
      return { spaceId };
    },
    childRemote: options.childRemote ?? (() => undefined),
    observeChildWork: (action) => action(),
    setActiveJob: () => undefined,
    afterPlanJobSettled: (jobId) => { fixture.settledHooks.push(jobId); },
    templates: () => [],
    stagedImport: () => { throw new WorkbenchPublicError("workbench/not-found", "no staged import"); },
    sharePreview: async () => { throw new WorkbenchPublicError("workbench/unavailable", "no staging"); },
    runProductCommand: async () => ({}),
    uiAutomation: () => fixture.uiAutomation,
  };
  fixture.creator = creator;
  fixture.control = new SupervisorControl(controlPorts);
  fixture.ports = controlPorts;
  fixture.creatorPorts = creatorPorts;
  fixture.jobs = jobs;
  fixture.registry = registry;
  fixture.runs = runs;
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

interface CallResult {
  status: number;
  body: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
  text: string;
}

type Channel = "control" | "creator";

/** Serve the control handler (and optionally creator) on one loopback port. */
async function serve(fx: Fixture, channels: Channel[] = ["control"]): Promise<void> {
  const server = createServer((req, res) => {
    void (async () => {
      for (const channel of channels) {
        if (channel === "control" && await fx.control.handle(req, res)) return;
        if (channel === "creator" && await fx.creator.handle(req, res)) return;
      }
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

async function call(fx: Fixture, prefix: string, op: string, bearer: string, body: unknown, headers: Record<string, string> = {}): Promise<CallResult> {
  const response = await fetch(`${fx.origin}${prefix}${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: CallResult["body"] = {};
  try {
    parsed = JSON.parse(text) as CallResult["body"];
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, text };
}

const controlCall = (fx: Fixture, op: string, bearer: string, body: unknown, headers?: Record<string, string>) =>
  call(fx, CONTROL_CHANNEL_PREFIX, op, bearer, body, headers);
const creatorCall = (fx: Fixture, op: string, bearer: string, body: unknown) =>
  call(fx, CREATOR_CHANNEL_PREFIX, op, bearer, body);

async function issue(fx: Fixture, listener: IdentityServer, via: Channel = "control"): Promise<CreatorIssueResult> {
  const prefix = via === "control" ? CONTROL_CHANNEL_PREFIX : CREATOR_CHANNEL_PREFIX;
  const result = await call(fx, prefix, "issue", HOST_BEARER, {
    origin: listener.origin,
    bearer: listener.bearer,
    home: fx.home,
    profile: "web",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.value as CreatorIssueResult;
}

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((accept) => listener.close(() => accept()));
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dual scopes: each scope gates only its own channel", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makePorts(home);
  await serve(fx, ["control", "creator"]);
  const listener = await startIdentityServer({ home, profile: "web" });

  const issued = await issue(fx, listener, "control");
  const creatorScope = issued.scopes.creator!;
  const controlScope = issued.scopes.control!;
  assert.match(creatorScope, /^[a-f0-9]{64}$/);
  assert.match(controlScope, /^[a-f0-9]{64}$/);
  assert.notEqual(controlScope, creatorScope);

  // Control scope works on control ops; creator scope and other tokens do not.
  for (const [bearer, expected] of [[controlScope, 200], [creatorScope, 401], [HOST_BEARER, 401]] as const) {
    for (const op of ["context", "read", "job"]) {
      const body = op === "read" ? { view: "overview" } : op === "job" ? { jobId: "j-1" } : {};
      const result = await controlCall(fx, op, bearer, body);
      assert.equal(result.status, expected, `${op} with ${expected === 200 ? "control" : "wrong"} scope`);
    }
  }
  // Creator scope still works on creator ops; control scope does not.
  const creatorContext = await creatorCall(fx, "context", creatorScope, {});
  assert.equal(creatorContext.body.ok, true, JSON.stringify(creatorContext.body));
  const controlOnCreator = await creatorCall(fx, "context", controlScope, {});
  assert.equal(controlOnCreator.status, 401);

  // Neither scope appears in any response or error body.
  for (const result of [creatorContext, controlOnCreator]) {
    assert.ok(!result.text.includes(controlScope) && !result.text.includes(creatorScope));
  }
});

test("issue through the control prefix shares the creator registration", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx, ["control", "creator"]);
  const listener = await startIdentityServer({ home, profile: "web" });

  const issued = await issue(fx, listener, "control");
  // A second issue through either prefix conflicts with the same record.
  const againControl = await controlCall(fx, "issue", HOST_BEARER, {
    origin: listener.origin, bearer: listener.bearer, home: fx.home, profile: "web",
  });
  assert.equal(againControl.body.error?.code, "control/conflict");
  const againCreator = await creatorCall(fx, "issue", HOST_BEARER, {
    origin: listener.origin, bearer: listener.bearer, home: fx.home, profile: "web",
  });
  assert.equal(againCreator.body.error?.code, "creator/conflict");

  // unregister through the control prefix retires both scopes.
  const retired = await controlCall(fx, "unregister", HOST_BEARER, { registrationId: issued.registrationId });
  assert.equal(retired.body.ok, true);
  const staleControl = await controlCall(fx, "context", issued.scopes.control!, {});
  assert.equal(staleControl.status, 401);
  const staleCreator = await creatorCall(fx, "context", issued.scopes.creator!, {});
  assert.equal(staleCreator.status, 401);
});

test("forged Origin, Cookie and sec-fetch-site requests are denied before auth", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const controlScope = issued.scopes.control!;

  for (const headers of [
    { origin: "http://evil.example" },
    { cookie: "dsh-auth-x=1" },
    { "sec-fetch-site": "same-origin" },
  ] as Array<Record<string, string>>) {
    const denied = await controlCall(fx, "context", controlScope, {}, headers);
    assert.equal(denied.status, 403, JSON.stringify(headers));
  }
  const get = await fetch(`${fx.origin}${CONTROL_CHANNEL_PREFIX}context`, { method: "GET" });
  assert.equal(get.status, 405);
  const unknown = await controlCall(fx, "bogus", controlScope, {});
  assert.equal(unknown.status, 404);
});

test("session is declared but unsupported in this phase", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);

  const unauthorized = await controlCall(fx, "session", HOST_BEARER, {});
  assert.equal(unauthorized.status, 401);
  const denied = await controlCall(fx, "session", issued.scopes.control!, {});
  assert.equal(denied.body.error?.code, "control/unsupported");
});

function writeSpaceEntry(home: string, id: string): void {
  const spacesPath = join(home, "hub", "spaces.json");
  const spaces = existsSync(spacesPath)
    ? (JSON.parse(readFileSync(spacesPath, "utf8")) as { version: 1; order: string[]; meta: Record<string, Record<string, unknown>> })
    : { version: 1 as const, order: [] as string[], meta: {} };
  spaces.meta[id] = { displayName: id, order: 1, createdAt: "2025-01-01T00:00:00.000Z" };
  if (!spaces.order.includes(id)) spaces.order.push(id);
  mkdirSync(join(home, "hub"), { recursive: true });
  writeFileSync(spacesPath, `${JSON.stringify(spaces, null, 2)}\n`);
}

test("read refuses protected and unknown targets", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeProfile(home, "desktop");
  writeProfile(home, "spaces-hub");
  // Reserved ids are refused by the channel's own whitelist before any
  // registry lookup, so they need no registered entry here.
  writeSpaceEntry(home, "spaces-hub");
  writeSpace(home, "alpha");
  writeSpace(home, "zeta");
  const fx = makePorts(home);
  fx.runs.unmanaged.add("space-zeta");
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  for (const [spaceId, code] of [
    ["web", "control/protected"],
    ["desktop", "control/protected"],
    ["spaces-hub", "control/protected"],
    ["space-zeta", "control/not-found"],
    ["space-ghost", "control/not-found"],
  ] as const) {
    for (const view of ["inspect", "logs"] as const) {
      const denied = await controlCall(fx, "read", scope, { view, spaceId });
      assert.equal(denied.body.error?.code, code, `${view} ${spaceId}`);
    }
  }
});

test("read overview lists ordinary spaces, creating jobs and sanitized failures", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeProfile(home, "desktop");
  writeProfile(home, "spaces-hub");
  writeSpace(home, "alpha", { dshVersion: "0.2.0-rc.2" });
  writeSpace(home, "beta");
  writeSpace(home, "zeta");
  const fx = makePorts(home, { running: ["space-beta"] });
  fx.runs.unmanaged.add("space-zeta");
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  // Seed a failed job carrying secret-looking text and a failed creation.
  await fx.jobs!.submit({ kind: "space.start", spaceId: "space-alpha" } as never, "req-fail", async () => {
    throw new WorkbenchPublicError("workbench/unavailable", "child died: token=hunter2 Authorization: Bearer abcdefghij");
  });
  await fx.jobs!.submit({ kind: "space.create", input: { name: "fresh" } } as never, "req-create", async () => {
    throw new WorkbenchPublicError("workbench/unavailable", "install exploded");
  });
  await fx.jobs!.whenIdle();

  const result = await controlCall(fx, "read", scope, { view: "overview" });
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  const overview = result.body.value as ControlOverviewResult;
  const ids = overview.spaces.map((space) => space.id).sort();
  assert.deepEqual(ids, ["space-alpha", "space-beta"], "web/desktop/hub/unmanaged are excluded");
  const beta = overview.spaces.find((space) => space.id === "space-beta")!;
  assert.equal(beta.status, "running");
  assert.equal(beta.activity, "busy");
  const alpha = overview.spaces.find((space) => space.id === "space-alpha")!;
  assert.equal(alpha.activity, "idle");
  assert.equal(alpha.dshVersion, "0.2.0-rc.2");

  assert.equal(overview.failedJobs.length, 2);
  assert.ok(overview.failedJobs.some((job) => job.kind === "space.start"));
  const text = JSON.stringify(result.body);
  assert.ok(!text.includes("hunter2"), "secrets are stripped from job projections");
  assert.ok(!text.includes("Bearer abcdefghij"), "bearer text is stripped");
  assert.ok(!text.includes(scope), "the scope never reaches the wire");
  const creating = overview.creating.find((row) => row.spaceId === "space-fresh");
  assert.equal(creating?.status, "failed");
});

test("inspect returns per-section results and isolates section failures", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makePorts(home, {
    detail: async () => { throw new WorkbenchPublicError("workbench/unavailable", "registry read exploded"); },
    diagnostics: (spaceId) => ({
      spaceId,
      status: "stopped",
      lastError: "previous start died",
      logs: [],
      backups: [],
    }),
    maintenanceService: () => ({
      runtimes: async () => [{ version: "0.2.0-rc.2", installed: true, host: true, pinnedBy: [], removable: false, compatible: true }],
    }) as unknown as WorkbenchMaintenance,
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const all = await controlCall(fx, "read", scope, {
    view: "inspect", spaceId: "space-alpha",
    sections: ["plugins", "model", "runtime", "diagnostics", "jobs"],
  });
  assert.equal(all.body.ok, true, JSON.stringify(all.body));
  const inspect = all.body.value as ControlInspectResult;
  assert.equal(inspect.spaceId, "space-alpha");
  assert.deepEqual(inspect.plugins, { ok: false, code: "control/unavailable", message: "registry read exploded" });
  assert.equal(inspect.model?.ok, true);
  if (inspect.model?.ok) {
    assert.equal(inspect.model.value.catalog, null);
    assert.ok(inspect.model.value.catalogReason.length > 0, "catalog absence is explained, not silent");
  }
  assert.equal(inspect.runtime?.ok, true);
  if (inspect.runtime?.ok) {
    assert.equal(inspect.runtime.value.runtimes?.length, 1);
    assert.equal(inspect.runtime.value.dshVersion, null);
  }
  assert.equal(inspect.diagnostics?.ok, true);
  if (inspect.diagnostics?.ok) assert.equal(inspect.diagnostics.value.lastError, "previous start died");
  assert.equal(inspect.jobs?.ok, true);
  if (inspect.jobs?.ok) assert.deepEqual(inspect.jobs.value, []);

  // Default sections are plugins + model only.
  const partial = await controlCall(fx, "read", scope, { view: "inspect", spaceId: "space-alpha" });
  const partialResult = partial.body.value as ControlInspectResult;
  assert.ok("plugins" in partialResult && "model" in partialResult);
  assert.ok(!("runtime" in partialResult) && !("diagnostics" in partialResult) && !("jobs" in partialResult));

  const badInput = await controlCall(fx, "read", scope, { view: "inspect", spaceId: "space-alpha", tail: 5 });
  assert.equal(badInput.body.error?.code, "control/invalid-input");
});

test("logs view returns a sanitized, bounded tail", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const entries: DiagnosticLogEntry[] = [];
  for (let i = 0; i < 260; i += 1) {
    entries.push({ at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, channel: "stdout", text: `line-${i}-${"x".repeat(400)}` });
  }
  entries.push({ at: "2026-01-01T00:01:00Z", channel: "stderr", text: "fatal: token=hunter2 api_key=zzz" });
  const fx = makePorts(home, {
    diagnostics: (spaceId) => ({ spaceId, status: "stopped", logs: entries, logError: "log write skipped", backups: [] }),
  });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const tailed = await controlCall(fx, "read", scope, { view: "logs", spaceId: "space-alpha", tail: 5 });
  const tail = tailed.body.value as ControlLogsResult;
  assert.equal(tail.entries.length, 5);
  const last = tail.entries[tail.entries.length - 1]!;
  assert.ok(!last.text.includes("hunter2"), `sanitized: ${last.text}`);
  assert.equal(tail.logError, "log write skipped");

  const clamped = await controlCall(fx, "read", scope, { view: "logs", spaceId: "space-alpha", tail: 1000 });
  const full = clamped.body.value as ControlLogsResult;
  assert.ok(full.entries.length <= 200, `${full.entries.length} <= 200`);
  const bytes = Buffer.byteLength(JSON.stringify(full.entries), "utf8");
  assert.ok(bytes <= 64 * 1024, `${bytes} <= 64KiB`);
  assert.equal(full.truncated, true);
});

test("read-only supervisor: context and reads stay available, job ops report read-only", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makePorts(home, { jobs: undefined, writable: false });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const context = await controlCall(fx, "context", scope, {});
  assert.equal(context.body.ok, true, JSON.stringify(context.body));
  const value = context.body.value as ControlContext;
  assert.equal(value.writable, false);
  assert.equal(value.busy, false);
  assert.deepEqual(value.spaces, [{ id: "space-alpha", activity: "idle" }]);

  const overview = await controlCall(fx, "read", scope, { view: "overview" });
  assert.equal(overview.body.ok, true);
  assert.deepEqual((overview.body.value as ControlOverviewResult).failedJobs, []);

  const jobRead = await controlCall(fx, "job", scope, { jobId: "req-any" });
  assert.equal(jobRead.body.error?.code, "control/read-only");

  const inspect = await controlCall(fx, "read", scope, {
    view: "inspect", spaceId: "space-alpha", sections: ["jobs", "model"],
  });
  const result = inspect.body.value as ControlInspectResult;
  assert.equal(result.jobs?.ok, false);
  if (!result.jobs?.ok) assert.equal(result.jobs?.code, "control/read-only");
  assert.equal(result.model?.ok, true);
});

test("control job op only reads jobs this registration submitted", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  // A job exists but was not submitted through the control channel.
  const job = await fx.jobs!.submit({ kind: "space.start", spaceId: "space-alpha" } as never, "req-other", async () => {
    throw new WorkbenchPublicError("workbench/not-found");
  });
  assert.ok(job.id);
  const denied = await controlCall(fx, "job", scope, { jobId: job.id });
  assert.equal(denied.body.error?.code, "control/not-found");
});

test("plan freezes stop/start plans with fingerprints and preview impact", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  writeSpace(home, "beta");
  const fx = makePorts(home, { running: ["space-beta"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const stop = await controlCall(fx, "plan", scope, { op: "stop", spaceId: "space-beta" });
  assert.equal(stop.body.ok, true, JSON.stringify(stop.body));
  const stopPlan = stop.body.value as {
    controlPlanId: string; fingerprint: string; op: string; spaceId: string;
    displayName: string; affectedSpaceIds: string[]; changes: string[];
    taskActivity?: string; expiresAt: string;
  };
  assert.equal(stopPlan.op, "stop");
  assert.equal(stopPlan.spaceId, "space-beta");
  assert.equal(stopPlan.displayName, "beta");
  assert.equal(stopPlan.taskActivity, "busy");
  assert.deepEqual(stopPlan.affectedSpaceIds, ["space-beta"]);
  assert.ok(stopPlan.controlPlanId.startsWith(`${issued.registrationId}-`));
  assert.ok(stopPlan.fingerprint.length > 0);
  assert.deepEqual(fx.previewCalls, [{ kind: "space.stop", spaceId: "space-beta" }]);

  const start = await controlCall(fx, "plan", scope, { op: "start", spaceId: "space-alpha" });
  assert.equal(start.body.ok, true, JSON.stringify(start.body));
  const startPlan = start.body.value as typeof stopPlan;
  assert.equal(startPlan.op, "start");
  assert.equal(startPlan.taskActivity, undefined, "start plans carry no taskActivity");
  assert.equal(fx.previewCalls.length, 1, "start never freezes a supervisor preview");

  for (const [body, code] of [
    [{ op: "nuke", spaceId: "space-alpha" }, "control/invalid-input"],
    [{ op: "stop" }, "control/invalid-input"],
    [{ op: "stop", spaceId: "space-alpha", extra: 1 }, "control/invalid-input"],
    [{ op: "stop", spaceId: "web" }, "control/protected"],
    [{ op: "restart", spaceId: "desktop" }, "control/protected"],
    [{ op: "delete", spaceId: "spaces-hub" }, "control/protected"],
    [{ op: "stop", spaceId: "space-ghost" }, "control/not-found"],
  ] as const) {
    const denied = await controlCall(fx, "plan", scope, body);
    assert.equal(denied.body.error?.code, code, JSON.stringify(body));
  }
});

test("execute submits the frozen plan once and replays the same requestId", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  writeSpace(home, "beta");
  const fx = makePorts(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const stopPlan = (await controlCall(fx, "plan", scope, { op: "stop", spaceId: "space-alpha" }))
    .body.value as { controlPlanId: string };
  const startPlan = (await controlCall(fx, "plan", scope, { op: "start", spaceId: "space-beta" }))
    .body.value as { controlPlanId: string };

  const first = await controlCall(fx, "execute", scope, { planId: stopPlan.controlPlanId, requestId: "req-1" });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const job = first.body.value as { id: string; kind: string; status: string; affectedSpaceIds: string[] };
  assert.equal(job.id, "req-1");
  assert.equal(job.kind, "control.execute");
  assert.deepEqual(job.affectedSpaceIds, ["space-alpha"]);
  assert.deepEqual(fx.settledHooks, ["req-1"], "plan jobs get the settled hook");

  // Identical replay returns the original job even after consumption.
  const replay = await controlCall(fx, "execute", scope, { planId: stopPlan.controlPlanId, requestId: "req-1" });
  assert.equal(replay.body.ok, true);
  assert.equal((replay.body.value as { id: string }).id, "req-1");

  // Same requestId with a different command conflicts.
  const conflict = await controlCall(fx, "execute", scope, { planId: startPlan.controlPlanId, requestId: "req-1" });
  assert.equal(conflict.body.error?.code, "control/request-conflict");
  assert.equal(fx.startCalls.length, 0);

  // Same plan with a fresh requestId reads back as consumed.
  const consumed = await controlCall(fx, "execute", scope, { planId: stopPlan.controlPlanId, requestId: "req-2" });
  assert.equal(consumed.body.error?.code, "control/plan-consumed");

  const started = await controlCall(fx, "execute", scope, { planId: startPlan.controlPlanId, requestId: "req-3" });
  assert.equal(started.body.ok, true, JSON.stringify(started.body));

  await fx.jobs!.whenIdle();
  assert.deepEqual(fx.executeCalls, ["wbplan-space.stop-1"]);
  assert.deepEqual(fx.startCalls, ["space-beta"]);
  const settled = fx.jobs!.job("req-3");
  assert.equal(settled.status, "succeeded");

  // The control job op now sees this registration's submissions.
  const read = await controlCall(fx, "job", scope, { jobId: "req-1" });
  assert.equal(read.body.ok, true);
});

test("expired, revision-changed and activity-changed plans are refused", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  writeSpace(home, "beta");
  const fx = makePorts(home, { running: ["space-alpha"] });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const planOf = async (op: string, spaceId: string) =>
    (await controlCall(fx, "plan", scope, { op, spaceId })).body.value as { controlPlanId: string };

  // TTL expiry consumes the plan and reports plan-expired.
  const expired = await planOf("stop", "space-alpha");
  fx.mutable.nowMs += 6 * 60_000;
  const late = await controlCall(fx, "execute", scope, { planId: expired.controlPlanId, requestId: "req-old" });
  assert.equal(late.body.error?.code, "control/plan-expired");
  const again = await controlCall(fx, "execute", scope, { planId: expired.controlPlanId, requestId: "req-old2" });
  assert.equal(again.body.error?.code, "control/plan-consumed");

  // A revision change refuses without consuming.
  const stale = await planOf("stop", "space-alpha");
  fx.mutable.revision = "9".repeat(64);
  const moved = await controlCall(fx, "execute", scope, { planId: stale.controlPlanId, requestId: "req-moved" });
  assert.equal(moved.body.error?.code, "control/request-conflict");
  fx.mutable.revision = "f".repeat(64);
  const revived = await controlCall(fx, "execute", scope, { planId: stale.controlPlanId, requestId: "req-revived" });
  assert.equal(revived.body.ok, true, JSON.stringify(revived.body));

  // An activity change consumes the plan without submitting.
  const watched = await planOf("restart", "space-alpha");
  fx.mutable.activities.set("space-alpha", "idle");
  const drift = await controlCall(fx, "execute", scope, { planId: watched.controlPlanId, requestId: "req-drift" });
  assert.equal(drift.body.error?.code, "control/request-conflict");
  assert.equal(fx.executeCalls.filter((id) => id === "wbplan-space.restart-3").length, 0);
  const replayed = await controlCall(fx, "execute", scope, { planId: watched.controlPlanId, requestId: "req-drift2" });
  assert.equal(replayed.body.error?.code, "control/plan-consumed");
});

test("plans die with the registration: reissued identity cannot execute or read them", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makePorts(home);
  await serve(fx, ["control", "creator"]);
  const listener = await startIdentityServer({ home, profile: "web" });
  const first = await issue(fx, listener);
  const scope = first.scopes.control!;

  const plan = (await controlCall(fx, "plan", scope, { op: "delete", spaceId: "space-alpha" }))
    .body.value as { controlPlanId: string };
  const job = await controlCall(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-del" });
  assert.equal(job.body.ok, true, JSON.stringify(job.body));

  const retired = await controlCall(fx, "unregister", HOST_BEARER, { registrationId: first.registrationId });
  assert.equal(retired.body.ok, true);
  const second = await issue(fx, listener);
  const scope2 = second.scopes.control!;
  assert.notEqual(second.registrationId, first.registrationId);

  const stale = await controlCall(fx, "execute", scope2, { planId: plan.controlPlanId, requestId: "req-del2" });
  assert.equal(stale.body.error?.code, "control/not-found");
  const oldJob = await controlCall(fx, "job", scope2, { jobId: "req-del" });
  assert.equal(oldJob.body.error?.code, "control/not-found");
  const foreignPlan = await controlCall(fx, "execute", scope2, { planId: `${first.registrationId}-bogus`, requestId: "req-x" });
  assert.equal(foreignPlan.body.error?.code, "control/not-found");
});

test("plan and execute refuse a read-only supervisor", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makePorts(home, { jobs: undefined, writable: false });
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const plan = await controlCall(fx, "plan", scope, { op: "stop", spaceId: "space-alpha" });
  assert.equal(plan.body.error?.code, "control/read-only");
  const execute = await controlCall(fx, "execute", scope, { planId: `${issued.registrationId}-x`, requestId: "req-ro" });
  assert.equal(execute.body.error?.code, "control/read-only");

  // Read ops stay available under the same registration.
  const overview = await controlCall(fx, "read", scope, { view: "overview" });
  assert.equal(overview.body.ok, true);
});

test("a preview failure refuses the plan and freezes nothing", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "alpha");
  const fx = makePorts(home);
  fx.previewError = new WorkbenchPublicError("workbench/unavailable", "preview exploded");
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const issued = await issue(fx, listener);
  const scope = issued.scopes.control!;

  const denied = await controlCall(fx, "plan", scope, { op: "stop", spaceId: "space-alpha" });
  assert.equal(denied.body.error?.code, "control/unavailable");
  assert.equal(denied.body.error?.message, "preview exploded");

  fx.previewError = undefined;
  const planned = await controlCall(fx, "plan", scope, { op: "stop", spaceId: "space-alpha" });
  assert.equal(planned.body.ok, true);
});
