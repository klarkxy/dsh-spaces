/**
 * P6 creation ops — `space.from-template` / `space.import` — and the
 * `templates` read view + `import.preview` staging op of the control
 * channel. Covers: bounded templates projection, content-only import
 * staging, closed params, plan-time refusals (missing template, name
 * taken, dead importId), frozen changes naming plugin sources and the
 * no-allowBuilds statement, never-started product commands, and the
 * source-digest drift check at execute.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  CONTROL_CHANNEL_PREFIX,
  CONTROL_IMPORT_PREVIEW_BODY_LIMIT,
  ControlPublicError,
  type ControlPlanResult,
  type ControlTemplatesResult,
} from "../../src/shared/control.ts";
import type { CreatorIssueResult } from "../../src/shared/creator.ts";
import type { SpaceSharePreview, SpaceTemplate } from "../../src/shared/space-share.ts";
import { packSpaceShare } from "../../src/adapters/node/products/space-share.ts";
import type { WorkbenchProductCommand } from "../../src/shared/workbench-product.ts";
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
  const home = mkdtempSync(join(tmpdir(), "dsh-spaces-import-"));
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
    templates: SpaceTemplate[];
    staged: Map<string, { expiresAt: string; preview: SpaceSharePreview }>;
  };
  productCalls: WorkbenchProductCommand[];
}

function makeFixture(home: string): Fixture {
  const fixture = {
    home,
    origin: "http://127.0.0.1:1",
    mutable: {
      epoch: EPOCH,
      revision: REVISION,
      nowMs: Date.now(),
      templates: [] as SpaceTemplate[],
      staged: new Map<string, { expiresAt: string; preview: SpaceSharePreview }>(),
    },
    productCalls: [] as WorkbenchProductCommand[],
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
    statusOf: () => "stopped",
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
    assertOwner: () => {
      if (!ownerAlive) throw new WorkbenchPublicError("workbench/read-only");
    },
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
      throw new WorkbenchPublicError("workbench/unsupported", `unexpected previewLocalPlan ${request.kind}`);
    },
    executePlan: async () => {
      throw new WorkbenchPublicError("workbench/unsupported", "unexpected executePlan");
    },
    startSpace: async (spaceId) => ({ spaceId }),
    templates: () => fixture.mutable.templates,
    stagedImport: (importId) => {
      const staged = fixture.mutable.staged.get(importId);
      if (!staged) throw new Error("That import is not available.");
      if (Date.parse(staged.expiresAt) <= fixture.mutable.nowMs) {
        fixture.mutable.staged.delete(importId);
        throw new Error("That import has expired.");
      }
      return staged;
    },
    sharePreview: async (archiveBase64) => {
      const staged = {
        expiresAt: new Date(fixture.mutable.nowMs + 5 * 60_000).toISOString(),
        preview: previewFromArchive(archiveBase64),
      };
      const importId = `imp-${fixture.mutable.staged.size + 1}`;
      fixture.mutable.staged.set(importId, staged);
      return { importId, ...staged };
    },
    runProductCommand: async (command) => {
      fixture.productCalls.push(command);
      return { product: command.kind === "template.create" || command.kind === "space.import"
        ? { kind: command.kind, import: { definition: "imported", plugins: "completed", start: "not-run", errors: [], pendingManual: [] } }
        : undefined };
    },
    childRemote: () => undefined,
    observeChildWork: (action) => action(),
    setActiveJob: () => undefined,
    afterPlanJobSettled: () => undefined,
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

/** A real share zip whose plugin manifest carries npm + git rows. */
function previewFromArchive(archiveBase64: string): SpaceSharePreview {
  void archiveBase64;
  return SHARE_PREVIEW;
}

const SHARE_PREVIEW: SpaceSharePreview = {
  manifest: {
    formatVersion: 1,
    kind: "dsh-space",
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { base: "web", dshVersion: "0.2.2-rc.1" },
    space: { displayName: "Shared Space" },
  },
  plugins: [
    { packageName: "dsh-plugin-a", resolvedVersion: "1.2.3", source: "npm", installSpec: "dsh-plugin-a@1.2.3" },
    { packageName: "dsh-plugin-git", resolvedVersion: null, source: "git", installSpec: "github:o/r#abc" },
  ],
  hasConfig: false,
  unknownSources: ["dsh-plugin-git"],
};

function shareArchive(): string {
  const share = {
    manifest: SHARE_PREVIEW.manifest,
    plugins: SHARE_PREVIEW.plugins,
  };
  return packSpaceShare(share).toString("base64");
}

const TEMPLATE: SpaceTemplate = {
  id: "dev-template-1",
  name: "dev",
  displayName: "Dev Template",
  createdAt: "2026-01-01T00:00:00.000Z",
  plugins: [
    { packageName: "dsh-plugin-a", resolvedVersion: "1.2.3", source: "npm", installSpec: "dsh-plugin-a@1.2.3" },
    { packageName: "dsh-plugin-manual", resolvedVersion: null, source: "manual" },
  ],
  recipe: {
    schemaVersion: 1,
    displayName: "Dev Template",
    plugins: [
      { packageName: "dsh-plugin-a", resolvedVersion: "1.2.3", source: "npm", installSpec: "dsh-plugin-a@1.2.3" },
      { packageName: "dsh-plugin-manual", resolvedVersion: null, source: "manual" },
    ],
    source: { base: "web", baseVersion: "0.2.2-rc.1", dshVersion: "0.2.2-rc.1" },
  },
};

test("read templates returns the bounded library projection and refuses spaceId", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makeFixture(home);
  fx.mutable.templates = [TEMPLATE];
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const result = await call(fx, "read", scope, { view: "templates" });
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  const view = result.body.value as { view: string } & ControlTemplatesResult;
  assert.equal(view.view, "templates");
  assert.equal(view.templates.length, 1);
  const row = view.templates[0]!;
  assert.equal(row.id, "dev-template-1");
  assert.equal(row.name, "dev");
  assert.equal(row.displayName, "Dev Template");
  assert.equal(row.source?.dshVersion, "0.2.2-rc.1");
  assert.equal(row.hasConfig, false);
  assert.deepEqual(row.plugins.map((plugin) => plugin.packageName), ["dsh-plugin-a", "dsh-plugin-manual"]);
  assert.equal(row.plugins[0]?.installSpec, "dsh-plugin-a@1.2.3");

  const withId = await call(fx, "read", scope, { view: "templates", spaceId: "space-x" });
  assert.equal(withId.body.error?.code, "control/invalid-input");
});

test("import.preview stages archive content — never a path — and enforces the share bound", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makeFixture(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const staged = await call(fx, "import.preview", scope, { archiveBase64: shareArchive() });
  assert.equal(staged.body.ok, true, JSON.stringify(staged.body));
  const value = staged.body.value as { importId: string; expiresAt: string; preview: SpaceSharePreview };
  assert.equal(value.importId, "imp-1");
  assert.ok(Date.parse(value.expiresAt) > fixtureNow(fx));
  assert.equal(value.preview.plugins.length, 2);

  for (const body of [
    {},
    { archiveBase64: 42 },
    { archiveBase64: "AAAA", path: "C:\\tmp\\x.dshspace" },
    { archiveBase64: "AAAA", extra: 1 },
  ]) {
    const denied = await call(fx, "import.preview", scope, body);
    assert.equal(denied.body.error?.code, "control/invalid-input", JSON.stringify(body));
  }
});

function fixtureNow(fx: Fixture): number {
  return fx.mutable.nowMs;
}

test("space.from-template refuses a missing template and a taken name at plan time", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  writeSpace(home, "taken");
  const fx = makeFixture(home);
  fx.mutable.templates = [TEMPLATE];
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  for (const [params, code] of [
    [{ templateId: "nope", name: "fresh" }, "control/not-found"],
    [{ templateId: "dev-template-1", name: "taken" }, "control/conflict"],
    [{ templateId: "dev-template-1", name: "Bad Name" }, "control/invalid-input"],
    [{ templateId: "dev-template-1", name: "web" }, "control/invalid-input"],
    [{ name: "fresh" }, "control/invalid-input"],
    [{ templateId: "dev-template-1" }, "control/invalid-input"],
  ] as const) {
    const denied = await call(fx, "plan", scope, { op: "space.from-template", params });
    assert.equal(denied.body.error?.code, code, JSON.stringify(params));
  }
  assert.equal(fx.productCalls.length, 0);
});

test("space.from-template freezes creation, sources and the no-allowBuilds statement; job never starts", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makeFixture(home);
  fx.mutable.templates = [TEMPLATE];
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const planned = await call(fx, "plan", scope, {
    op: "space.from-template",
    params: { templateId: "dev-template-1", name: "fresh", displayName: "Fresh Space" },
  });
  assert.equal(planned.body.ok, true, JSON.stringify(planned.body));
  const plan = planned.body.value as ControlPlanResult;
  assert.equal(plan.op, "space.from-template");
  assert.equal(plan.spaceId, "space-fresh", "the derived id is frozen on the plan");
  assert.equal(plan.displayName, "Fresh Space");
  assert.deepEqual(plan.affectedSpaceIds, ["space-fresh"]);
  assert.ok(plan.changes.some((line) => /space-fresh/.test(line) && /not started/.test(line)), JSON.stringify(plan.changes));
  assert.ok(plan.changes.some((line) => /dsh-plugin-a@1\.2\.3/.test(line)), JSON.stringify(plan.changes));
  assert.ok(plan.changes.some((line) => /Pending manual.*dsh-plugin-manual/.test(line)), JSON.stringify(plan.changes));
  assert.ok(plan.changes.some((line) => /No build-script approvals/.test(line)), JSON.stringify(plan.changes));
  assert.deepEqual(plan.params, { templateId: "dev-template-1", name: "fresh", displayName: "Fresh Space" });

  const job = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-tpl-1" });
  assert.equal(job.body.ok, true, JSON.stringify(job.body));
  await fx.jobs.whenIdle();
  assert.deepEqual(fx.productCalls, [{
    kind: "template.create",
    templateId: "dev-template-1",
    name: "fresh",
    displayName: "Fresh Space",
  }]);
  const settled = fx.jobs.job("req-tpl-1");
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.affectedSpaceIds[0], "space-fresh");
});

test("space.import refuses a dead importId at plan; a valid plan consumes it exactly once", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makeFixture(home);
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  const dead = await call(fx, "plan", scope, { op: "space.import", params: { importId: "imp-ghost", name: "fresh" } });
  assert.equal(dead.body.error?.code, "control/not-found");

  const staged = await call(fx, "import.preview", scope, { archiveBase64: shareArchive() });
  const { importId } = staged.body.value as { importId: string };
  const planned = await call(fx, "plan", scope, { op: "space.import", params: { importId, name: "imported" } });
  assert.equal(planned.body.ok, true, JSON.stringify(planned.body));
  const plan = planned.body.value as ControlPlanResult;
  assert.equal(plan.spaceId, "space-imported");
  assert.equal(plan.displayName, "Shared Space", "defaults to the share display name");
  assert.ok(plan.changes.some((line) => /dsh-plugin-a@1\.2\.3/.test(line)));
  assert.ok(plan.changes.some((line) => /Pending manual.*dsh-plugin-git/.test(line)));

  const job = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-imp-1" });
  assert.equal(job.body.ok, true, JSON.stringify(job.body));
  await fx.jobs.whenIdle();
  assert.deepEqual(fx.productCalls, [{ kind: "space.import", importId, name: "imported" }]);
  assert.equal(fx.jobs.job("req-imp-1").status, "succeeded");
});

test("a created space or an expired import between plan and execute consumes the plan without submitting", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makeFixture(home);
  fx.mutable.templates = [TEMPLATE];
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  // Race 1: someone creates space-fresh between plan and execute → conflict.
  const tplPlan = (await call(fx, "plan", scope, {
    op: "space.from-template", params: { templateId: "dev-template-1", name: "fresh" },
  })).body.value as ControlPlanResult;
  writeSpace(home, "fresh");
  const drift = await call(fx, "execute", scope, { planId: tplPlan.controlPlanId, requestId: "req-drift-1" });
  assert.equal(drift.body.error?.code, "control/request-conflict");
  assert.equal(fx.productCalls.length, 0);
  const replay = await call(fx, "execute", scope, { planId: tplPlan.controlPlanId, requestId: "req-drift-2" });
  assert.equal(replay.body.error?.code, "control/plan-consumed");

  // Race 2: the staged import expires before execute → consumed, no submit.
  const staged = await call(fx, "import.preview", scope, { archiveBase64: shareArchive() });
  const { importId } = staged.body.value as { importId: string };
  const impPlan = (await call(fx, "plan", scope, {
    op: "space.import", params: { importId, name: "later" },
  })).body.value as ControlPlanResult;
  fx.mutable.nowMs += 6 * 60_000;
  const stale = await call(fx, "execute", scope, { planId: impPlan.controlPlanId, requestId: "req-stale-1" });
  // Plan TTL is also 5 minutes; whichever guard fires first is a refusal.
  assert.ok(
    ["control/plan-expired", "control/request-conflict"].includes(stale.body.error?.code ?? ""),
    JSON.stringify(stale.body),
  );
  assert.equal(fx.productCalls.length, 0);
});

test("creation ops share the closed plan contract: no spaceId, closed params, requestId idempotency", async () => {
  const home = tempHome();
  writeProfile(home, "web");
  const fx = makeFixture(home);
  fx.mutable.templates = [TEMPLATE];
  await serve(fx);
  const listener = await startIdentityServer({ home, profile: "web" });
  const scope = await issueScope(fx, listener);

  for (const body of [
    { op: "space.from-template", spaceId: "space-x", params: { templateId: "t", name: "fresh" } },
    { op: "space.import", params: { importId: "imp-1", name: "fresh", extra: 1 } },
    { op: "space.import", params: { importId: "not valid id!", name: "fresh" } },
    { op: "space.from-template", params: { templateId: "t", name: "x".repeat(40) } },
  ]) {
    const denied = await call(fx, "plan", scope, body);
    assert.equal(denied.body.error?.code, "control/invalid-input", JSON.stringify(body));
  }

  const plan = (await call(fx, "plan", scope, {
    op: "space.from-template", params: { templateId: "dev-template-1", name: "idem" },
  })).body.value as ControlPlanResult;
  const first = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-idem" });
  assert.equal(first.body.ok, true);
  const replay = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-idem" });
  assert.equal(replay.body.ok, true, "same requestId replays the original job");
  assert.equal((replay.body.value as { id: string }).id, "req-idem");
  const other = await call(fx, "execute", scope, { planId: plan.controlPlanId, requestId: "req-idem-2" });
  assert.equal(other.body.error?.code, "control/plan-consumed");
  assert.equal(fx.productCalls.length, 1);
});
