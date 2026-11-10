/**
 * Host-side Creator shell: trusted-main gating, tool registration, preset and
 * approval gates, and the issue/identity/scope handshake against a fake
 * supervisor. The server-side creator contract lives in src/shared/creator.ts;
 * this test only exercises the host plugin surface.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
} from "../../src/adapters/node/home/home-lease.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { SpacesPlugin } from "../../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";
import { MainSpaceCreatorService } from "../../packages/plugin/src/host/main-space-creator.ts";
import { installMainSpaceGuidance, CREATOR_GUIDANCE } from "../../packages/plugin/src/host/main-space-guidance.ts";
import type { EscalationApprove } from "../../packages/plugin/src/host/main-space-tools.ts";

/**
 * Whether the optional real escalation package resolves locally. The default
 * (non-injected) gate dynamically imports it; the real-gate test is skipped
 * until the devDependency is installed rather than faked by an injected seam.
 */
const HAS_DSH_SANDBOX = (() => {
  try {
    createRequire(import.meta.url).resolve("@deepseek-ai/dsh-sandbox");
    return true;
  } catch {
    return false;
  }
})();

const temps: string[] = [];
const contexts: Context[] = [];
const listeners: Array<{ close(): Promise<void> }> = [];
const services: MainSpaceCreatorService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    try { await service.close(); } catch { /* isolation */ }
  }
  for (const server of listeners.splice(0)) await server.close();
  for (const ctx of contexts.splice(0)) {
    try { await ctx.fiber.dispose(); } catch { /* isolation */ }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Register a service for guaranteed listener teardown in afterEach. */
function tracked(service: MainSpaceCreatorService): MainSpaceCreatorService {
  services.push(service);
  return service;
}

/**
 * Test-double approveEscalation with the real fail-closed semantics: like the
 * real gate it forwards the call identity to the approver — toolName, callId,
 * agent, the justification as reason, and the exec signal — then throws on any
 * non-grant outcome, so a module-resolution failure can never be mistaken for
 * a real rejection.
 */
const approveStub: EscalationApprove = async (req, approval) => {
  if (!approval.approver) throw new Error("approval unavailable");
  const value = await approval.approver.request({
    toolName: approval.toolName,
    callId: approval.callId as string | undefined,
    agent: approval.agent as object,
    reason: req.justification,
    signal: approval.signal,
  });
  if (value !== "allowed-once") throw new Error(`space creation not approved (${value})`);
  return "danger-full-access";
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeProfile(home: string, name: string): void {
  const dir = join(home, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `dsh-profile-${name}` })}\n`);
}

function writeManager(home: string, profileId: string): void {
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE),
    `${JSON.stringify({ version: 1, profileId, createdAt: "2026-11-07T00:00:00.000Z" })}\n`,
  );
}

function writeCli(root: string): string {
  const pkg = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION })}\n`);
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

function identityInput(home: string, profile: string) {
  const bin = writeCli(home);
  return {
    home,
    allowRealHome: false as const,
    argv: [process.execPath, bin, "--profile", profile],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    baseUrl: `${pathToFileURL(join(home, "profiles", profile)).href}/`,
  };
}

function pluginContext(): Context {
  const ctx = new Context();
  contexts.push(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// Service stubs
// ---------------------------------------------------------------------------

interface StubTools {
  registered: Map<string, { name: string; execute(args: Record<string, unknown>, exec: unknown): Promise<unknown> }>;
}

function provideCoreServices(ctx: Context, opts: {
  home: string;
  profile: string;
  preset?: string;
  approvalOutcome?: string;
  approvalSeen?: Array<{ toolName: string; reason?: string }>;
}): StubTools {
  const tools: StubTools = { registered: new Map() };
  ctx.provide("tools", {
    register(def: { name: string }) {
      tools.registered.set(def.name, def as never);
      return () => { tools.registered.delete(def.name); };
    },
  });
  ctx.provide("agentPresets", { composedPreset: () => opts.preset ?? "cordis" });
  ctx.provide("sandboxPolicy", { resolve: () => ({ mode: "workspace-write" }) });
  ctx.provide("profileContext", { home: opts.home, name: opts.profile });
  ctx.provide("systemPrompt", {
    section(section: { name: string }) {
      return () => undefined;
    },
  });
  if (opts.approvalOutcome) {
    ctx.provide("approval", {
      async request(req: { toolName: string; reason?: string }) {
        opts.approvalSeen?.push({ toolName: req.toolName, reason: req.reason });
        return opts.approvalOutcome;
      },
    });
  }
  return tools;
}

function execArgs(overrides: { agent?: object; signal?: AbortSignal } = {}) {
  return {
    signal: overrides.signal ?? AbortSignal.timeout(10_000),
    ...(overrides.agent === undefined ? {} : { agent: overrides.agent }),
  };
}

async function settle(predicate: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("settle timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Fake supervisor implementing the Creator channel handshake.
// ---------------------------------------------------------------------------

interface FakeSupervisor {
  origin: string;
  bearer: string;
  serviceEpoch: string;
  scope: string;
  calls: Array<{ op: string; auth: string; headers: Record<string, unknown>; body: Record<string, unknown> }>;
  /** Last identity-callback transport diagnosis (port + socket cause, never a token). */
  callbackFailure: { port: string; cause: string } | null;
  /** When set, createPreview answers with these plugins in the plan input. */
  previewPlugins?: Array<Record<string, unknown>>;
  /** When true, unregister replies with a failure envelope. */
  refuseUnregister?: boolean;
  /** When true, issue replies with a failure envelope. */
  refuseIssue?: boolean;
}

async function startRefusingSupervisor(): Promise<FakeSupervisor> {
  const supervisor = await startFakeSupervisor(mkdtempSync(join(tmpdir(), "dsh-refuse-")));
  supervisor.refuseIssue = true;
  return supervisor;
}

async function startFakeSupervisor(home: string): Promise<FakeSupervisor> {
  const bearer = "b".repeat(64);
  const scope = "c".repeat(64);
  const serviceEpoch = "d".repeat(64);
  const calls: FakeSupervisor["calls"] = [];
  const fake: FakeSupervisor = { origin: "", bearer, serviceEpoch, scope, calls, callbackFailure: null };

  const server = createServer(async (req, res) => {
    const reply = (body: unknown) => {
      // Close every reply so the shared fetch pool cannot carry a dead socket
      // into the next fixture listener on a reused loopback port.
      res.setHeader("connection", "close");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    if (!url.startsWith("/internal/creator/v1/")) {
      res.writeHead(404); res.end(); return;
    }
    const op = url.slice("/internal/creator/v1/".length);
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    calls.push({
      op,
      auth: String(req.headers.authorization ?? ""),
      headers: {
        origin: req.headers.origin,
        cookie: req.headers.cookie,
        "sec-fetch-site": req.headers["sec-fetch-site"],
      },
      body,
    });
    const auth = String(req.headers.authorization ?? "");
    try {
      if (op === "issue") {
        if (auth !== `Bearer ${bearer}`) return reply({ ok: false, error: { code: "workbench/unauthorized", message: "issuer" } });
        if (fake.refuseIssue) return reply({ ok: false, error: { code: "creator/unavailable", message: "issue refused" } });
        const nonce = "n".repeat(64);
        let callback: Response;
        try {
          callback = await fetch(`${body.origin}/identity`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${body.bearer}`, connection: "close" },
            body: JSON.stringify({ nonce }),
          });
        } catch (failure) {
          // Diagnose the callback transport failure: port and socket cause,
          // never the callback bearer or body.
          const cause = failure instanceof Error ? (failure as Error & { cause?: unknown }).cause : undefined;
          fake.callbackFailure = {
            port: String(body.origin ?? "").replace(/^.*:/, ""),
            cause: cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
              ? (cause as { code: string }).code
              : failure instanceof Error ? failure.message : "fetch failed",
          };
          throw failure;
        }
        const proof = await callback.json() as { nonce?: string; home?: string; profile?: string };
        if (proof.nonce !== nonce) return reply({ ok: false, error: { code: "creator/unavailable", message: "bad proof" } });
        return reply({ ok: true, value: { registrationId: "reg-1", scopes: { creator: scope, control: "e".repeat(64) }, serviceEpoch } });
      }
      if (op === "unregister") {
        if (auth !== `Bearer ${bearer}`) return reply({ ok: false, error: { code: "workbench/unauthorized", message: "issuer" } });
        if (fake.refuseUnregister) return reply({ ok: false, error: { code: "creator/unregistered", message: "unregister refused" } });
        return reply({ ok: true, value: { unregistered: true } });
      }
      if (auth !== `Bearer ${scope}`) {
        return reply({ ok: false, error: { code: "workbench/unauthorized", message: "scope" } });
      }
      if (op === "context") {
        return reply({ ok: true, value: { protocolVersion: 1, serviceEpoch, revision: "r1", writable: true, maintenance: false, createBusy: false, dshVersion: COMPATIBLE_DSH_CLI_VERSION, modelSources: ["main", "local"] } });
      }
      if (op === "createPreview") {
        const plugins = fake.previewPlugins ?? [];
        return reply({ ok: true, value: {
          id: "plan-1", kind: "creator.create", serviceEpoch, stateRevision: "r1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(), fingerprint: "fp",
          input: { name: "demo", modelSource: "main", startAfterCreate: false, plugins },
          steps: [{ step: "prepare" }, { step: "create" }, { step: "result" }],
        } });
      }
      if (op === "createExecute") {
        return reply({ ok: true, value: { id: "job-1", requestId: body.requestId, kind: "creator.create", status: "queued", phase: "prepare", message: "", affectedSpaceIds: [], createdAt: "t", updatedAt: "t", canCancel: false } });
      }
      if (op === "job") {
        return reply({ ok: true, value: { id: body.jobId, requestId: "req-1", kind: "creator.create", status: "succeeded", phase: "result", message: "", affectedSpaceIds: [], createdAt: "t", updatedAt: "t", canCancel: false, result: { spaceId: "demo" } } });
      }
      reply({ ok: false, error: { code: "workbench/not-found", message: "op" } });
    } catch (err) {
      reply({ ok: false, error: { code: "creator/failed", message: String(err) } });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  listeners.push({
    close: () => new Promise<void>((done, fail) => {
      server.closeAllConnections();
      server.close((err) => (err ? fail(err) : done()));
    }),
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  fake.origin = origin;
  return fake;
}

function endpointFor(supervisor: { origin: string; bearer: string; serviceEpoch: string }) {
  return {
    origin: supervisor.origin,
    bearer: supervisor.bearer,
    protocolVersion: 2 as const,
    homeId: "h".repeat(64),
    serviceEpoch: supervisor.serviceEpoch,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("only the confirmed web/desktop main host gets the Creator service", () => {
  const home = tempDir("dsh-creator-main-");
  writeProfile(home, "web");
  writeProfile(home, "notes");
  writeProfile(home, "spaces-hub");
  writeManager(home, "spaces-hub");

  const web = new WorkbenchHostRuntime(identityInput(home, "web"));
  assert.equal(web.isTrustedMainHost, true);
  const child = new WorkbenchHostRuntime(identityInput(home, "notes"));
  assert.equal(child.isTrustedMainHost, false);
  const manager = new WorkbenchHostRuntime(identityInput(home, "spaces-hub"));
  assert.equal(manager.isTrustedMainHost, false);

  const ctx = pluginContext();
  const plugin = new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(identityInput(home, "web")));
  assert.ok(plugin.creator);
  const other = new SpacesPlugin(pluginContext(), {}, child);
  assert.equal(other.creator, null);
  const hub = new SpacesPlugin(pluginContext(), {}, manager);
  assert.equal(hub.creator, null);
});

test("main host registers the four Creator tools; non-main hosts register none", async () => {
  const home = tempDir("dsh-creator-tools-");
  writeProfile(home, "web");
  writeProfile(home, "notes");
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, { home, profile: "web" });
  new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(identityInput(home, "web")));
  await settle(() => tools.registered.size === 4);
  assert.deepEqual([...tools.registered.keys()].sort(), [
    "spaces_context",
    "spaces_create_execute",
    "spaces_create_preview",
    "spaces_job",
  ]);

  const childCtx = pluginContext();
  const childTools = provideCoreServices(childCtx, { home, profile: "notes" });
  new SpacesPlugin(childCtx, {}, new WorkbenchHostRuntime(identityInput(home, "notes")));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(childTools.registered.size, 0);
});

test("tools refuse agents that are not on the Creator preset", async () => {
  const home = tempDir("dsh-creator-preset-");
  writeProfile(home, "web");
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, { home, profile: "web", preset: "standard" });
  new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(identityInput(home, "web")));
  await settle(() => tools.registered.size === 4);

  const context = tools.registered.get("spaces_context")!;
  await assert.rejects(
    () => context.execute({}, execArgs({ agent: { ctx, session: {} } })),
    /requires Creator mode/,
  );
  await assert.rejects(() => context.execute({}, execArgs()), /requires Creator mode/);
});

test("issue → identity challenge → scoped calls use the minted scope, never cookies", async () => {
  const home = tempDir("dsh-creator-handshake-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  ctx.provide("profileContext", { home, name: "web" });
  const service = tracked(new MainSpaceCreatorService(ctx));
  await service.attach(endpointFor(supervisor));

  const value = await service.context();
  assert.equal(value.serviceEpoch, supervisor.serviceEpoch);
  assert.equal(value.writable, true);

  const issue = supervisor.calls.find((row) => row.op === "issue");
  assert.ok(issue);
  assert.equal(issue.auth, `Bearer ${supervisor.bearer}`);
  assert.equal(issue.headers.origin, undefined);
  assert.equal(issue.headers.cookie, undefined);
  assert.equal(issue.headers["sec-fetch-site"], undefined);
  assert.equal(issue.body.profile, "web");
  const contextCall = supervisor.calls.find((row) => row.op === "context");
  assert.equal(contextCall?.auth, `Bearer ${supervisor.scope}`);
  assert.equal(contextCall?.headers.origin, undefined);
  assert.equal(contextCall?.headers.cookie, undefined);

  await service.close();
  const unregister = supervisor.calls.find((row) => row.op === "unregister");
  assert.ok(unregister);
  assert.equal(unregister.body.registrationId, "reg-1");
});

test("execute requires a previewed plan and then approves once with plan facts", async () => {
  const home = tempDir("dsh-creator-exec-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, {
    home, profile: "web", approvalOutcome: "allowed-once", approvalSeen,
  });
  const service = tracked(new MainSpaceCreatorService(ctx));
  await service.attach(endpointFor(supervisor));

  // Directly exercise the tool definitions with a real service instance.
  const { installMainSpaceTools } = await import("../../packages/plugin/src/host/main-space-tools.ts");
  const runtime = new WorkbenchHostRuntime(identityInput(home, "web"));
  installMainSpaceTools(ctx, runtime, service, { approve: approveStub });
  await settle(() => tools.registered.size === 4);

  const execute = tools.registered.get("spaces_create_execute")!;
  const agent = { ctx, session: {} };
  await assert.rejects(
    () => execute.execute({ planId: "never-previewed", requestId: "req-x" }, execArgs({ agent })),
    /previewed again/,
  );
  assert.equal(supervisor.calls.some((row) => row.op === "createExecute"), false);

  const preview = tools.registered.get("spaces_create_preview")!;
  const plan = await preview.execute({ input: { name: "demo" } }, execArgs({ agent })) as { id: string };
  assert.equal(plan.id, "plan-1");

  const job = await execute.execute({ planId: "plan-1", requestId: "req-1" }, execArgs({ agent })) as { id: string };
  assert.equal(job.id, "job-1");
  assert.equal(approvalSeen.length, 1);
  assert.equal(approvalSeen[0].toolName, "spaces_create_execute");
  assert.match(approvalSeen[0].reason ?? "", /Create space "demo"/);
  assert.match(approvalSeen[0].reason ?? "", /no extra plugins/);
  const submit = supervisor.calls.find((row) => row.op === "createExecute");
  assert.equal(submit?.body.planId, "plan-1");
  assert.equal(submit?.body.requestId, "req-1");

  const jobTool = tools.registered.get("spaces_job")!;
  const read = await jobTool.execute({ jobId: "job-1" }, execArgs({ agent })) as { status: string };
  assert.equal(read.status, "succeeded");

  await service.close();
});

test("a rejected approval never reaches createExecute", async () => {
  const home = tempDir("dsh-creator-deny-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "rejected", approvalSeen });
  const service = tracked(new MainSpaceCreatorService(ctx));
  await service.attach(endpointFor(supervisor));
  const { installMainSpaceTools } = await import("../../packages/plugin/src/host/main-space-tools.ts");
  installMainSpaceTools(ctx, new WorkbenchHostRuntime(identityInput(home, "web")), service, { approve: approveStub });
  await settle(() => tools.registered.size === 4);

  const agent = { ctx, session: {} };
  const preview = tools.registered.get("spaces_create_preview")!;
  await preview.execute({ input: { name: "demo" } }, execArgs({ agent }));
  const execute = tools.registered.get("spaces_create_execute")!;
  // The rejection must be the approval decision itself, never a missing module.
  await assert.rejects(
    () => execute.execute({ planId: "plan-1", requestId: "req-1" }, execArgs({ agent })),
    (error) => error instanceof Error && /not approved \(rejected\)/.test(error.message),
  );
  assert.equal(approvalSeen.length, 1, "the approval was actually consulted");
  assert.equal(supervisor.calls.some((row) => row.op === "createExecute"), false);
});

test("a failed issue is terminal for the endpoint: same rejection, no retry", async () => {
  const home = tempDir("dsh-creator-retry-");
  writeProfile(home, "web");
  const refusing = await startRefusingSupervisor();
  const ctx = pluginContext();
  ctx.provide("profileContext", { home, name: "web" });
  const service = tracked(new MainSpaceCreatorService(ctx));
  // attach issues the registration at once; its refusal is the attach result.
  await assert.rejects(() => service.attach(endpointFor(refusing)), /creator\/unavailable/);
  assert.equal(refusing.calls.filter((row) => row.op === "issue").length, 1);
  await assert.rejects(() => service.context(), /creator\/unavailable/);
  await assert.rejects(() => service.context(), /creator\/unavailable/);
  assert.equal(
    refusing.calls.filter((row) => row.op === "issue").length,
    1,
    "failed issue must not retry for the same endpoint",
  );
});

test("an issue whose serviceEpoch differs from the attached endpoint is refused", async () => {
  const home = tempDir("dsh-creator-epoch-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  ctx.provide("profileContext", { home, name: "web" });
  const service = tracked(new MainSpaceCreatorService(ctx));
  const endpoint = endpointFor(supervisor);
  // Attach with a different epoch than the issue result will report.
  await assert.rejects(() => service.attach({ ...endpoint, serviceEpoch: "e".repeat(64) }), /REGISTRATION_CHANGED|REGISTRATION_INVALID/);
  await assert.rejects(() => service.context(), /REGISTRATION_CHANGED|REGISTRATION_INVALID|creator\/unavailable/);
});

test("approvedBuilds are surfaced in the execute approval", async () => {
  const home = tempDir("dsh-creator-builds-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  supervisor.previewPlugins = [
    { kind: "npm", packageName: "@acme/tool", version: "1.2.3", approvedBuilds: ["@acme/tool"] },
  ];
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "allowed-once", approvalSeen });
  const service = tracked(new MainSpaceCreatorService(ctx));
  await service.attach(endpointFor(supervisor));
  const { installMainSpaceTools } = await import("../../packages/plugin/src/host/main-space-tools.ts");
  installMainSpaceTools(ctx, new WorkbenchHostRuntime(identityInput(home, "web")), service, { approve: approveStub });
  await settle(() => tools.registered.size === 4);
  const agent = { ctx, session: {} };
  const preview = tools.registered.get("spaces_create_preview")!;
  await preview.execute({ input: { name: "demo", plugins: [{ npm: { packageName: "@acme/tool", version: "1.2.3", approvedBuilds: ["@acme/tool"] } }] } }, execArgs({ agent }));
  const execute = tools.registered.get("spaces_create_execute")!;
  await execute.execute({ planId: "plan-1", requestId: "req-1" }, execArgs({ agent }));
  assert.equal(approvalSeen.length, 1);
  assert.match(approvalSeen[0].reason ?? "", /@acme\/tool@1\.2\.3/);
  assert.match(approvalSeen[0].reason ?? "", /allowBuilds for @acme\/tool/);
  assert.match(approvalSeen[0].reason ?? "", /persist/);
});

test("close reports a failed unregister instead of swallowing it", async () => {
  const home = tempDir("dsh-creator-close-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  supervisor.refuseUnregister = true;
  const ctx = pluginContext();
  ctx.provide("profileContext", { home, name: "web" });
  const service = tracked(new MainSpaceCreatorService(ctx));
  await service.attach(endpointFor(supervisor));
  await service.context();
  await assert.rejects(() => service.close(), /unregister|creator\//);
});

test(
  "real approveEscalation gate: allowed-once submits, rejected does not (default dynamic import)",
  { skip: !HAS_DSH_SANDBOX && "requires the @deepseek-ai/dsh-sandbox devDependency" },
  async () => {
    const home = tempDir("dsh-creator-real-gate-");
    writeProfile(home, "web");
    const supervisor = await startFakeSupervisor(home);
    const ctx = pluginContext();
    const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
    // No approve override: the tool executes the real dsh-sandbox
    // approveEscalation, which consults the provided approval service itself.
    const tools = provideCoreServices(ctx, {
      home, profile: "web", approvalOutcome: "allowed-once", approvalSeen,
    });
    const service = tracked(new MainSpaceCreatorService(ctx));
    await service.attach(endpointFor(supervisor));
    const { installMainSpaceTools } = await import("../../packages/plugin/src/host/main-space-tools.ts");
    installMainSpaceTools(ctx, new WorkbenchHostRuntime(identityInput(home, "web")), service);
    await settle(() => tools.registered.size === 4);

    const agent = { ctx, session: {} };
    const preview = tools.registered.get("spaces_create_preview")!;
    await preview.execute({ input: { name: "demo" } }, execArgs({ agent }));
    const execute = tools.registered.get("spaces_create_execute")!;
    const job = await execute.execute({ planId: "plan-1", requestId: "req-1" }, execArgs({ agent })) as { id: string };
    assert.equal(job.id, "job-1");
    assert.equal(approvalSeen.length, 1);
    assert.match(approvalSeen[0].reason ?? "", /Create space "demo"/);
    assert.ok(supervisor.calls.some((row) => row.op === "createExecute"));
  },
);

test(
  "real approveEscalation gate: a rejected outcome fails closed before submit",
  { skip: !HAS_DSH_SANDBOX && "requires the @deepseek-ai/dsh-sandbox devDependency" },
  async () => {
    const home = tempDir("dsh-creator-real-deny-");
    writeProfile(home, "web");
    const supervisor = await startFakeSupervisor(home);
    const ctx = pluginContext();
    const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
    const tools = provideCoreServices(ctx, {
      home, profile: "web", approvalOutcome: "rejected", approvalSeen,
    });
    const service = tracked(new MainSpaceCreatorService(ctx));
    await service.attach(endpointFor(supervisor));
    const { installMainSpaceTools } = await import("../../packages/plugin/src/host/main-space-tools.ts");
    installMainSpaceTools(ctx, new WorkbenchHostRuntime(identityInput(home, "web")), service);
    await settle(() => tools.registered.size === 4);

    const agent = { ctx, session: {} };
    const preview = tools.registered.get("spaces_create_preview")!;
    await preview.execute({ input: { name: "demo" } }, execArgs({ agent }));
    const execute = tools.registered.get("spaces_create_execute")!;
    await assert.rejects(() => execute.execute({ planId: "plan-1", requestId: "req-1" }, execArgs({ agent })));
    assert.equal(approvalSeen.length, 1, "the real gate consulted the approver");
    assert.equal(supervisor.calls.some((row) => row.op === "createExecute"), false);
  },
);

test("Creator guidance section renders only under the cordis preset", async () => {
  const home = tempDir("dsh-creator-guide-");
  writeProfile(home, "web");
  const ctx = pluginContext();
  const sections: Array<{ name: string; text: (ctx: { agent?: { ctx: Context } }) => string }> = [];
  ctx.provide("systemPrompt", {
    section(section: { name: string; text: unknown }) {
      sections.push(section as never);
      return () => undefined;
    },
  });
  ctx.provide("agentPresets", {
    composedPreset: (agentCtx: Context) => (agentCtx as Context & { preset?: string }).preset ?? "cordis",
  });
  installMainSpaceGuidance(ctx);
  await settle(() => sections.length === 1);
  const section = sections[0];
  assert.equal(section.name, "dsh-spaces.creator-guidance");
  const agentCtx = new Context() as Context & { preset?: string };
  contexts.push(agentCtx);
  assert.equal(section.text({ agent: { ctx: agentCtx } }), CREATOR_GUIDANCE);
  agentCtx.preset = "standard";
  assert.equal(section.text({ agent: { ctx: agentCtx } }), "");
  assert.equal(section.text({}), "");
});
