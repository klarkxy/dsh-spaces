/**
 * Host-side Control (空间总控) surface: trusted-main gating of the
 * spacesMainChannel service, the space-control bundle's read-only tools, and
 * the control transport against a fake supervisor. The server-side contract
 * lives in src/shared/control.ts and tests/control/control-channel.test.ts;
 * this test only exercises the host plugin and tool package.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { Context, symbols } from "@deepseek-ai/cordis";
import { load } from "js-yaml";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
} from "../../src/adapters/node/home/home-lease.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { CONTROL_CHANNEL_PREFIX } from "../../src/shared/control.ts";
import { SpacesPlugin } from "../../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";
import { MainSpaceCreatorService } from "../../packages/plugin/src/host/main-space-creator.ts";
import { MainSpaceControlService } from "../../packages/plugin/src/host/main-space-control.ts";
import spaceControlPlugin from "../../packages/plugin/src/space-control/index.ts";

const temps: string[] = [];
const contexts: Context[] = [];
const listeners: Array<{ close(): Promise<void> }> = [];
const services: MainSpaceCreatorService[] = [];
const controls: MainSpaceControlService[] = [];

afterEach(async () => {
  for (const service of controls.splice(0)) {
    try { await service.close(); } catch { /* isolation */ }
  }
  for (const service of services.splice(0)) {
    try { await service.close(); } catch { /* isolation */ }
  }
  for (const server of listeners.splice(0)) await server.close();
  for (const ctx of contexts.splice(0)) {
    try { await ctx.fiber.dispose(); } catch { /* isolation */ }
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

interface StubTools {
  registered: Map<string, { name: string; execute(args: Record<string, unknown>, exec: unknown): Promise<unknown> }>;
}

function provideCoreServices(ctx: Context, opts: {
  home: string;
  profile: string;
  preset?: string;
  approvalOutcome?: string;
  approvalSeen?: Array<{ toolName: string; reason?: string }>;
  savedImages?: Array<{ data: Uint8Array; mediaType: string; name?: string }>;
  saveImageError?: Error;
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
  ctx.provide("attachments", {
    async saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
      if (opts.saveImageError) throw opts.saveImageError;
      opts.savedImages?.push(input);
      return {
        attachmentId: `att-${opts.savedImages?.length ?? 0}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1280,
        height: 720,
      };
    },
  } as never);
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

/**
 * Test-double approveEscalation with the real fail-closed semantics: it
 * forwards the call identity to the approver — toolName, callId, agent, the
 * justification as reason — then throws on any non-grant outcome, so a
 * module-resolution failure can never be mistaken for a real rejection.
 */
const approveStub = async (
  req: { requestedMode: string; justification: string },
  approval: {
    approver?: { request(input: Record<string, unknown>): Promise<string> };
    agent?: unknown;
    callId?: unknown;
    toolName: string;
    signal?: AbortSignal;
  },
): Promise<string> => {
  if (!approval.approver) throw new Error("approval unavailable");
  const value = await approval.approver.request({
    toolName: approval.toolName,
    callId: approval.callId as string | undefined,
    agent: approval.agent as object,
    reason: req.justification,
    signal: approval.signal,
  });
  if (value !== "allowed-once") throw new Error(`not approved (${value})`);
  return "danger-full-access";
};

async function settle(predicate: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("settle timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Fake supervisor: creator issue + control read surface on one loopback port.
// ---------------------------------------------------------------------------

interface FakeSupervisor {
  origin: string;
  bearer: string;
  serviceEpoch: string;
  creatorScope: string;
  controlScope: string;
  calls: Array<{ op: string; auth: string; body: Record<string, unknown>; headers: Record<string, unknown> }>;
}

async function startFakeSupervisor(home: string): Promise<FakeSupervisor> {
  const fake: FakeSupervisor = {
    origin: "",
    bearer: "b".repeat(64),
    serviceEpoch: "d".repeat(64),
    creatorScope: "c".repeat(64),
    controlScope: "e".repeat(64),
    calls: [],
  };
  const server = createServer(async (req, res) => {
    const reply = (body: unknown, status = 200) => {
      res.setHeader("connection", "close");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    const auth = String(req.headers.authorization ?? "");
    try {
      if (url.startsWith("/internal/creator/v1/")) {
        const op = url.slice("/internal/creator/v1/".length);
        fake.calls.push({ op, auth, body, headers: { origin: req.headers.origin, cookie: req.headers.cookie } });
        if (op === "issue") {
          const nonce = "n".repeat(64);
          const callback = await fetch(`${body.origin}/identity`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${body.bearer}`, connection: "close" },
            body: JSON.stringify({ nonce }),
          });
          const proof = await callback.json() as { nonce?: string; home?: string; profile?: string };
          if (proof.nonce !== nonce || proof.home !== resolve(home)) {
            return reply({ ok: false, error: { code: "creator/unavailable", message: "bad proof" } });
          }
          return reply({ ok: true, value: { registrationId: "reg-1", scopes: { creator: fake.creatorScope, control: fake.controlScope }, serviceEpoch: fake.serviceEpoch } });
        }
        if (op === "unregister") return reply({ ok: true, value: { unregistered: true } });
        return reply({ ok: false, error: { code: "creator/unsupported", message: "op" } });
      }
      if (url.startsWith(CONTROL_CHANNEL_PREFIX)) {
        const op = url.slice(CONTROL_CHANNEL_PREFIX.length);
        fake.calls.push({ op: `control/${op}`, auth, body, headers: { origin: req.headers.origin, cookie: req.headers.cookie } });
        if (auth !== `Bearer ${fake.controlScope}`) return reply({ error: "unauthorized" }, 401);
        if (op === "context") {
          return reply({ ok: true, value: { protocolVersion: 1, serviceEpoch: fake.serviceEpoch, revision: "r1", writable: true, maintenance: false, busy: false, dshVersion: COMPATIBLE_DSH_CLI_VERSION, spaces: [{ id: "space-alpha", activity: "idle" }] } });
        }
        if (op === "read" && body.view === "overview") {
          return reply({ ok: true, value: { view: "overview", protocolVersion: 1, serviceEpoch: fake.serviceEpoch, revision: "r1", writable: true, maintenance: false, busy: false, dshVersion: null, spaces: [{ id: "space-alpha", displayName: "Alpha", status: "running", generation: 1, dshVersion: null, activity: "busy" }], creating: [], failedJobs: [], truncated: false } });
        }
        if (op === "read" && body.view === "inspect") {
          return reply({ ok: true, value: { view: "inspect", spaceId: body.spaceId, plugins: { ok: true, value: [{ name: "dsh-plugin-one", version: "1.0.0" }] }, model: { ok: true, value: { inheritMain: true, catalog: null } } } });
        }
        if (op === "read" && body.view === "logs") {
          return reply({ ok: true, value: { view: "logs", spaceId: body.spaceId, status: "stopped", entries: [{ at: "2026-01-01T00:00:00Z", channel: "stdout", text: `tail-${body.tail}` }], truncated: false } });
        }
        if (op === "read" && body.view === "templates") {
          return reply({ ok: true, value: { view: "templates", templates: [{
            id: "dev-template-1", name: "dev", displayName: "Dev Template", createdAt: "2026-01-01T00:00:00.000Z",
            source: { dshVersion: "0.2.2-rc.1", base: "web" },
            plugins: [{ packageName: "dsh-plugin-a", source: "npm", resolvedVersion: "1.2.3", installSpec: "dsh-plugin-a@1.2.3" }],
            hasConfig: false,
          }], truncated: false } });
        }
        if (op === "import.preview") {
          return reply({ ok: true, value: {
            importId: "imp-1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            preview: {
              manifest: { formatVersion: 1, kind: "dsh-space", exportedAt: "2026-01-01T00:00:00.000Z", source: { base: "web", dshVersion: "0.2.2-rc.1" }, space: { displayName: "Shared Space" } },
              plugins: [{ packageName: "dsh-plugin-a", resolvedVersion: "1.2.3", source: "npm", installSpec: "dsh-plugin-a@1.2.3" }],
              hasConfig: false,
              unknownSources: [],
            },
          } });
        }
        if (op === "plan") {
          const params0 = body.params as Record<string, unknown> | undefined;
          const spaceId = typeof body.spaceId === "string"
            ? body.spaceId
            : typeof params0?.name === "string" ? `space-${params0.name}` : "space-ghost";
          const params = body.params as Record<string, unknown> | undefined;
          // Mirror the server: echo normalized params back on the frozen plan.
          let echoedParams: Record<string, unknown> | undefined;
          if (params && typeof params.source === "object" && params.source) {
            const src = params.source as { npm?: Record<string, unknown>; github?: Record<string, unknown> };
            echoedParams = {
              source: src.npm
                ? { kind: "npm", packageName: src.npm.packageName, version: src.npm.version, approvedBuilds: src.npm.approvedBuilds ?? [] }
                : { kind: "github", ...src.github, approvedBuilds: src.github?.approvedBuilds ?? [] },
            };
          } else if (params) {
            echoedParams = params;
          }
          return reply({ ok: true, value: {
            protocolVersion: 1,
            controlPlanId: `reg-1-${body.op}-plan`,
            fingerprint: "fp-frozen",
            op: body.op,
            spaceId,
            displayName: spaceId === "space-alpha" ? "Alpha" : spaceId,
            affectedSpaceIds: [spaceId],
            changes: [body.op === "delete" ? "Remove this space's profile and installed plugins." : `space.${body.op}`],
            ...(echoedParams ? { params: echoedParams } : {}),
            ...(body.op === "stop" || body.op === "restart" ? { taskActivity: "busy" } : {}),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          } });
        }
        if (op === "execute") {
          return reply({ ok: true, value: {
            id: String(body.requestId), requestId: String(body.requestId), kind: "control.execute",
            status: "queued", phase: "queued", message: "", affectedSpaceIds: ["space-alpha"],
            createdAt: "t", updatedAt: "t", canCancel: false,
          } });
        }
        if (op === "job") {
          if (body.jobId === "job-missing") {
            return reply({ ok: false, error: { code: "control/not-found", message: "That item was not found." } });
          }
          return reply({ ok: true, value: {
            id: String(body.jobId), requestId: String(body.jobId), kind: "control.execute",
            status: "succeeded", phase: "succeeded", message: "", affectedSpaceIds: ["space-alpha"],
            createdAt: "t", updatedAt: "t", canCancel: false,
          } });
        }
        if (op === "ui.open") {
          return reply({ ok: true, value: {
            uiSessionId: `ui-${body.spaceId}-1`,
            spaceId: body.spaceId,
            generation: 1,
            viewport: { width: 1280, height: 720 },
            path: "/",
          } });
        }
        if (op === "ui.snapshot") {
          const formats = Array.isArray(body.formats) ? body.formats as string[] : ["aria"];
          const value: Record<string, unknown> = {
            uiSessionId: body.uiSessionId,
            spaceId: "space-alpha",
            title: "Alpha Space",
            path: body.ref ? "/" : "/",
            truncated: false,
          };
          for (const format of formats) {
            if (format === "aria") value.aria = '- button "Send" [ref=e3]';
            if (format === "text") value.text = "Alpha page text";
            if (format === "html") value.html = "<main>alpha</main>";
            if (format === "screenshot") {
              // A real tiny PNG; the tool must persist it, never echo base64.
              const png = Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                "base64",
              );
              value.screenshot = png.toString("base64");
              value.screenshotBytes = png.byteLength;
            }
          }
          return reply({ ok: true, value });
        }
        if (op === "ui.act") {
          return reply({ ok: true, value: { done: true, path: "/" } });
        }
        if (op === "ui.eval") {
          return reply({ ok: true, value: { value: { echoed: (body as { script?: string }).script?.length ?? 0 }, truncated: false } });
        }
        if (op === "ui.close") {
          return reply({ ok: true, value: { closed: true } });
        }
        return reply({ ok: false, error: { code: "control/unsupported", message: "That command is not supported." } });
      }
      reply({ error: "not found" }, 404);
    } catch (err) {
      reply({ ok: false, error: { code: "control/failed", message: String(err) } });
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
  fake.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
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

test("spacesMainChannel is provided only on the trusted main host", async () => {
  const home = tempDir("dsh-control-main-");
  writeProfile(home, "web");
  writeProfile(home, "notes");
  writeProfile(home, "spaces-hub");
  writeManager(home, "spaces-hub");

  const webCtx = pluginContext();
  const webTools = provideCoreServices(webCtx, { home, profile: "web" });
  const webPlugin = new SpacesPlugin(webCtx, {}, new WorkbenchHostRuntime(identityInput(home, "web")));
  assert.ok(webPlugin.control, "web provides the control service");
  const provided = (webCtx as Context & { spacesMainChannel?: MainSpaceControlService }).spacesMainChannel;
  assert.ok(provided instanceof MainSpaceControlService, "spacesMainChannel resolves on ctx");
  // Property access returns a fresh traceable proxy per read; the original
  // slot unwraps to the plugin-owned service instance.
  assert.equal(
    (provided as unknown as { [symbols.original]?: unknown })[symbols.original],
    webPlugin.control,
  );
  // The real inject path resolves: the space-control bundle mounts on this
  // context and registers exactly its three read-only tools.
  const controlFiber = webCtx.plugin(spaceControlPlugin);
  await settle(() => webTools.registered.has("spaces_overview"));
  assert.equal((controlFiber as unknown as { state: number }).state, 2, "inject ['spacesMainChannel','tools'] resolved");
  for (const name of ["spaces_overview", "spaces_inspect", "spaces_logs"]) {
    assert.ok(webTools.registered.has(name), `${name} registered through inject`);
  }

  for (const profile of ["notes", "spaces-hub"] as const) {
    const ctx = pluginContext();
    provideCoreServices(ctx, { home, profile });
    const plugin = new SpacesPlugin(ctx, {}, new WorkbenchHostRuntime(identityInput(home, profile)));
    assert.equal(plugin.control, null, `${profile} must not provide spacesMainChannel`);
    assert.equal((ctx as Context & { spacesMainChannel?: unknown }).spacesMainChannel, undefined);
    // The bundle's inject requirement genuinely gates it: without the service
    // the fiber stays inactive and no tool is registered.
    const blocked = ctx.plugin(spaceControlPlugin);
    assert.equal((blocked as unknown as { state: number }).state, 0, `${profile}: space-control fiber waits on spacesMainChannel`);
  }
});

test("the plugin patch row and package metadata carry the canonical ids", () => {
  const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const pluginPatch = load(readFileSync(join(repo, "packages/plugin/cordis.patch.yml"), "utf8")) as Array<{ insert?: Array<{ id?: string; name?: string }> }>;
  const row = pluginPatch.flatMap((patch) => (Array.isArray(patch.insert) ? patch.insert : [])).find((entry) => entry.id === "dsh-space-control");
  assert.ok(row, "packages/plugin/cordis.patch.yml must insert dsh-space-control");
  assert.equal(row.name, "@dsh-spaces/plugin/space-control");

  // space-control is a subpath export inside the plugin package, never a
  // dependency: a file:/link: spec inside the tarball cannot be installed.
  const pkg = JSON.parse(readFileSync(join(repo, "packages/plugin/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };
  assert.equal(pkg.exports?.["./space-control"], "./lib/space-control.js");
  assert.equal(pkg.dependencies?.["@dsh-spaces/space-control"], undefined);
  for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
    assert.equal(typeof spec === "string" && /^(?:file|link|workspace|portal):/.test(spec), false, `${dep}@${spec} is not installable from the tarball`);
  }
  const rootPkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.equal(rootPkg.dependencies?.["@dsh-spaces/space-control"], undefined);
  assert.equal(existsSync(join(repo, "packages/space-control/package.json")), false, "no standalone space-control package remains");

  for (const rel of ["packages/view-bridge/cordis.patch.yml", "packages/llm-bridge/cordis.patch.yml"]) {
    const text = readFileSync(join(repo, rel), "utf8");
    assert.equal(text.includes("dsh-space-control"), false, `${rel} must not carry the main-space-only row`);
  }
});

test("control calls mint the control scope once and use it as the bearer, never cookies", async () => {
  const home = tempDir("dsh-control-wire-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  ctx.provide("profileContext", { home, name: "web" });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);

  const context = await control.context();
  assert.equal(context.serviceEpoch, supervisor.serviceEpoch);
  assert.deepEqual(context.spaces, [{ id: "space-alpha", activity: "idle" }]);
  const issue = supervisor.calls.find((row) => row.op === "issue");
  assert.ok(issue, "the shared issue ran once through the creator service");
  const contextCall = supervisor.calls.find((row) => row.op === "control/context");
  assert.equal(contextCall?.auth, `Bearer ${supervisor.controlScope}`);
  assert.equal(contextCall?.headers.origin, undefined);
  assert.equal(contextCall?.headers.cookie, undefined);

  const overview = await control.overview() as { view?: string; spaces: Array<{ id: string }> };
  assert.equal(overview.view, "overview");
  assert.equal(overview.spaces[0]?.id, "space-alpha");
  const readCall = supervisor.calls.find((row) => row.op === "control/read");
  assert.equal(readCall?.auth, `Bearer ${supervisor.controlScope}`);
  assert.equal(JSON.stringify(readCall?.body), JSON.stringify({ view: "overview" }));

  const inspect = await control.inspect("space-alpha", ["runtime", "jobs"]) as { view?: string };
  assert.equal(inspect.view, "inspect");
  const inspectCall = supervisor.calls.filter((row) => row.op === "control/read").at(-1);
  assert.deepEqual(inspectCall?.body, { view: "inspect", spaceId: "space-alpha", sections: ["runtime", "jobs"] });

  const logs = await control.logs("space-alpha", 12);
  assert.equal(logs.entries[0]?.text, "tail-12");
});

test("control errors pass through verbatim and the scope never reaches output", async () => {
  const home = tempDir("dsh-control-err-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, { home, profile: "web" });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);

  await assert.rejects(() => control.job("job-missing"), /control\/not-found/);
  const failure = await control.job("job-missing").then(
    () => assert.fail("job must reject"),
    (err: unknown) => String(err instanceof Error ? err.message : err),
  );
  assert.equal(failure.includes(supervisor.controlScope), false, "the scope never appears in errors");

  spaceControlPlugin.apply(ctx);
  await settle(() => tools.registered.size === 13);
  const rendered = tools.registered.get("spaces_inspect")! as unknown as {
    output?: { render(args: unknown, value: unknown): Array<{ text: string }> };
  };
  const text = rendered.output?.render({}, { ok: true })[0]?.text ?? "";
  assert.equal(text.includes(supervisor.controlScope), false, "tool output never contains the scope");
});

test("the three read-only tools close their arguments and forward bounded inputs", async () => {
  const home = tempDir("dsh-control-tools-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, { home, profile: "web" });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx);
  await settle(() => tools.registered.size === 13);
  assert.deepEqual([...tools.registered.keys()].sort(), [
    "spaces_control_job",
    "spaces_execute",
    "spaces_import_preview",
    "spaces_inspect",
    "spaces_logs",
    "spaces_overview",
    "spaces_plan",
    "spaces_templates",
    "spaces_ui_act",
    "spaces_ui_close",
    "spaces_ui_eval",
    "spaces_ui_open",
    "spaces_ui_snapshot",
  ]);

  const overview = tools.registered.get("spaces_overview")!;
  const value = await overview.execute({}, execArgs()) as { spaces: Array<{ id: string }> };
  assert.equal(value.spaces[0]?.id, "space-alpha");
  await assert.rejects(() => overview.execute({ extra: 1 }, execArgs()), /unknown field "extra"/);

  const inspect = tools.registered.get("spaces_inspect")!;
  await inspect.execute({ spaceId: "space-alpha", sections: ["plugins", "jobs"] }, execArgs());
  const inspectCall = supervisor.calls.filter((row) => row.op === "control/read").at(-1);
  assert.deepEqual(inspectCall?.body, { view: "inspect", spaceId: "space-alpha", sections: ["plugins", "jobs"] });
  for (const args of [
    { spaceId: "space-alpha", bogus: 1 },
    { spaceId: "bad id" },
    { spaceId: "space-alpha", sections: ["plugins", "secrets"] },
    { spaceId: "space-alpha", sections: [] },
    { spaceId: "space-alpha", tail: 4 },
  ]) {
    await assert.rejects(() => inspect.execute(args, execArgs()), /spaces_inspect/);
  }

  const logs = tools.registered.get("spaces_logs")!;
  const tailed = await logs.execute({ spaceId: "space-alpha", tail: 7 }, execArgs()) as { entries: Array<{ text: string }> };
  assert.equal(tailed.entries[0]?.text, "tail-7");
  await assert.rejects(() => logs.execute({ spaceId: "space-alpha", tail: 0 }, execArgs()), /tail/);
  await assert.rejects(() => logs.execute({ spaceId: "space-alpha", tail: "200" }, execArgs()), /tail/);

  // The Creator job tool and session tools are not part of this bundle.
  for (const forbidden of ["spaces_job", "spaces_session_send", "spaces_sessions"]) {
    assert.equal(tools.registered.has(forbidden), false, `${forbidden} must not be registered`);
  }
});

test("a supervisor without the control channel fails as control/unsupported, terminal", async () => {
  const home = tempDir("dsh-control-old-");
  writeProfile(home, "web");
  // An older supervisor mints only the creator scope on issue.
  const server = createServer(async (req, res) => {
    res.setHeader("connection", "close");
    res.writeHead(200, { "content-type": "application/json" });
    if ((req.url ?? "") === "/internal/creator/v1/issue") {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(part as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { origin?: string; bearer?: string };
      const nonce = "n".repeat(64);
      const callback = await fetch(`${body.origin}/identity`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${body.bearer}`, connection: "close" },
        body: JSON.stringify({ nonce }),
      });
      const proof = await callback.json() as { nonce?: string; home?: string };
      assert.equal(proof.nonce, nonce);
      assert.equal(proof.home, resolve(home));
      res.end(JSON.stringify({ ok: true, value: { registrationId: "reg-old", scopes: { creator: "c".repeat(64) }, serviceEpoch: "d".repeat(64) } }));
      return;
    }
    res.end(JSON.stringify({ ok: false, error: { code: "creator/unsupported", message: "old" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  listeners.push({
    close: () => new Promise<void>((done, fail) => {
      server.closeAllConnections();
      server.close((err) => (err ? fail(err) : done()));
    }),
  });
  const port = (server.address() as { port: number }).port;
  const ctx = pluginContext();
  ctx.provide("profileContext", { home, name: "web" });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  await creator.attach(endpointFor({ origin: `http://127.0.0.1:${port}`, bearer: "b".repeat(64), serviceEpoch: "d".repeat(64) }));
  control.attach(endpointFor({ origin: `http://127.0.0.1:${port}`, bearer: "b".repeat(64), serviceEpoch: "d".repeat(64) }));
  await assert.rejects(() => control.context(), /control\/unsupported/);
  await assert.rejects(() => control.overview(), /control\/unsupported/);
  await assert.rejects(() => control.inspect("space-alpha"), /control\/unsupported/);
});

test("spaces_plan freezes through the channel; execute asks approval then submits", async () => {
  const home = tempDir("dsh-control-exec-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, {
    home, profile: "web", approvalOutcome: "allowed-once", approvalSeen,
  });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const plan = tools.registered.get("spaces_plan")!;
  const frozen = await plan.execute({ op: "stop", spaceId: "space-alpha" }, execArgs({ agent })) as {
    controlPlanId: string; spaceId: string; displayName: string; taskActivity?: string;
  };
  assert.equal(frozen.spaceId, "space-alpha");
  assert.equal(frozen.displayName, "Alpha");
  assert.equal(frozen.taskActivity, "busy");
  const planCall = supervisor.calls.find((row) => row.op === "control/plan");
  assert.equal(planCall?.auth, `Bearer ${supervisor.controlScope}`);
  assert.equal(approvalSeen.length, 0, "planning never asks for approval");

  const execute = tools.registered.get("spaces_execute")!;
  const job = await execute.execute(
    { planId: frozen.controlPlanId, requestId: "req-stop-1" },
    execArgs({ agent }),
  ) as { id: string; kind: string };
  assert.equal(job.id, "req-stop-1");
  assert.equal(job.kind, "control.execute");
  assert.equal(approvalSeen.length, 1);
  const reason = approvalSeen[0].reason ?? "";
  assert.match(reason, /Stop space "Alpha" \(space-alpha\)/);
  assert.match(reason, /affecting space-alpha/);
  assert.match(reason, /busy/);

  const jobTool = tools.registered.get("spaces_control_job")!;
  const stored = await jobTool.execute({ jobId: "req-stop-1" }, execArgs({ agent })) as { status: string };
  assert.equal(stored.status, "succeeded");
});

test("delete approval text names the target and the irreversible consequence", async () => {
  const home = tempDir("dsh-control-del-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "allowed-once", approvalSeen });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  const toolsMap = tools.registered;
  await settle(() => toolsMap.size === 13);

  const agent = { ctx, session: {} };
  const plan = toolsMap.get("spaces_plan")!;
  const frozen = await plan.execute({ op: "delete", spaceId: "space-alpha" }, execArgs({ agent })) as { controlPlanId: string };
  await toolsMap.get("spaces_execute")!.execute(
    { planId: frozen.controlPlanId, requestId: "req-del" },
    execArgs({ agent }),
  );
  const reason = approvalSeen[0]?.reason ?? "";
  assert.match(reason, /Delete space "Alpha" \(space-alpha\)/);
  assert.match(reason, /cannot be undone/i);
});

test("a rejected or missing approval submits nothing; unplanned ids fail before approval", async () => {
  const home = tempDir("dsh-control-deny-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "rejected", approvalSeen });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const plan = tools.registered.get("spaces_plan")!;
  const frozen = await plan.execute({ op: "restart", spaceId: "space-alpha" }, execArgs({ agent })) as { controlPlanId: string };
  const execute = tools.registered.get("spaces_execute")!;
  await assert.rejects(
    () => execute.execute({ planId: frozen.controlPlanId, requestId: "req-nogo" }, execArgs({ agent })),
    /not approved \(rejected\)/,
  );
  assert.equal(approvalSeen.length, 1, "the approval was actually consulted");
  assert.equal(
    supervisor.calls.some((row) => row.op === "control/execute"),
    false,
    "a rejected approval never reaches the supervisor",
  );

  // A plan id this host never froze fails before any approval is asked.
  await assert.rejects(
    () => execute.execute({ planId: "reg-1-never-planned", requestId: "req-nogo2" }, execArgs({ agent })),
    /must be created again/,
  );
  assert.equal(approvalSeen.length, 1, "no second approval consult");
});

test("plugin.install approval names the exact source and every approved build script", async () => {
  const home = tempDir("dsh-control-inst-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "allowed-once", approvalSeen });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const plan = tools.registered.get("spaces_plan")!;
  const commit = "a".repeat(40);
  const frozen = await plan.execute({
    op: "plugin.install",
    spaceId: "space-alpha",
    params: {
      source: {
        github: { owner: "klarkxy", repo: "dsh-plugins", commit, path: "plugins/dsh-b", packageName: "@scope/dsh-b", approvedBuilds: ["dep@1.0.0", "esbuild"] },
      },
    },
  }, execArgs({ agent })) as { controlPlanId: string };
  await tools.registered.get("spaces_execute")!.execute(
    { planId: frozen.controlPlanId, requestId: "req-inst" },
    execArgs({ agent }),
  );
  const reason = approvalSeen[0]?.reason ?? "";
  assert.match(reason, new RegExp(`Install plugin github:klarkxy/dsh-plugins#${commit}&path:/plugins/dsh-b`));
  assert.match(reason, /dep@1\.0\.0, esbuild/);
  assert.match(reason, /space-alpha/);

  const planCall = supervisor.calls.find((row) => row.op === "control/plan");
  assert.deepEqual(planCall?.body.params, {
    source: { github: { owner: "klarkxy", repo: "dsh-plugins", commit, path: "plugins/dsh-b", packageName: "@scope/dsh-b", approvedBuilds: ["dep@1.0.0", "esbuild"] } },
  });
});

test("runtime.set and llm-policy.set approvals name the from/to change", async () => {
  const home = tempDir("dsh-control-pol-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "allowed-once", approvalSeen });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const plan = tools.registered.get("spaces_plan")!;
  const execute = tools.registered.get("spaces_execute")!;

  const rt = await plan.execute(
    { op: "runtime.set", spaceId: "space-alpha", params: { version: "0.2.1-rc.2" } },
    execArgs({ agent }),
  ) as { controlPlanId: string };
  await execute.execute({ planId: rt.controlPlanId, requestId: "req-rt" }, execArgs({ agent }));
  assert.match(approvalSeen.at(-1)?.reason ?? "", /Switch "Alpha" \(space-alpha\) to DSH runtime 0\.2\.1-rc\.2/);

  const pol = await plan.execute(
    { op: "llm-policy.set", spaceId: "space-alpha", params: { inheritMain: false } },
    execArgs({ agent }),
  ) as { controlPlanId: string };
  await execute.execute({ planId: pol.controlPlanId, requestId: "req-pol" }, execArgs({ agent }));
  assert.match(approvalSeen.at(-1)?.reason ?? "", /Set model policy of "Alpha" \(space-alpha\) to inheritMain=false/);
});

test("plugin.live.* approvals name the running-space application and the exact target", async () => {
  const home = tempDir("dsh-control-live-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "allowed-once", approvalSeen });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const plan = tools.registered.get("spaces_plan")!;
  const execute = tools.registered.get("spaces_execute")!;

  const commit = "b".repeat(40);
  const inst = await plan.execute({
    op: "plugin.live.install", spaceId: "space-alpha",
    params: { source: { github: { owner: "klarkxy", repo: "dsh-plugins", commit, packageName: "@scope/dsh-b" } } },
  }, execArgs({ agent })) as { controlPlanId: string };
  await execute.execute({ planId: inst.controlPlanId, requestId: "req-li" }, execArgs({ agent }));
  let reason = approvalSeen.at(-1)?.reason ?? "";
  assert.match(reason, new RegExp(`Install plugin github:klarkxy/dsh-plugins#${commit}`));
  assert.match(reason, /inside the running space/);
  assert.match(reason, /own plugin manager/);
  assert.match(reason, /no build scripts approved/);

  const entry = await plan.execute(
    { op: "plugin.live.entry", spaceId: "space-alpha", params: { entryId: "include:dsh-plugin-a", enabled: false } },
    execArgs({ agent }),
  ) as { controlPlanId: string };
  await execute.execute({ planId: entry.controlPlanId, requestId: "req-le" }, execArgs({ agent }));
  reason = approvalSeen.at(-1)?.reason ?? "";
  assert.match(reason, /Disable plugin entry include:dsh-plugin-a/);
  assert.match(reason, /inside the running space/);

  const upd = await plan.execute(
    { op: "plugin.live.update", spaceId: "space-alpha", params: { packageName: "dsh-plugin-a", version: "1.2.3" } },
    execArgs({ agent }),
  ) as { controlPlanId: string };
  await execute.execute({ planId: upd.controlPlanId, requestId: "req-lu" }, execArgs({ agent }));
  reason = approvalSeen.at(-1)?.reason ?? "";
  assert.match(reason, /Update plugin dsh-plugin-a to 1\.2\.3/);
  assert.match(reason, /inside the running space/);

  const rem = await plan.execute(
    { op: "plugin.live.remove", spaceId: "space-alpha", params: { packageName: "dsh-plugin-a" } },
    execArgs({ agent }),
  ) as { controlPlanId: string };
  await execute.execute({ planId: rem.controlPlanId, requestId: "req-lr" }, execArgs({ agent }));
  reason = approvalSeen.at(-1)?.reason ?? "";
  assert.match(reason, /Remove plugin dsh-plugin-a from "Alpha"/);
  assert.match(reason, /inside the running space/);
});

test("spaces_templates and spaces_import_preview forward through the channel", async () => {
  const home = tempDir("dsh-control-imp-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, { home, profile: "web" });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const templates = tools.registered.get("spaces_templates")!;
  const view = await templates.execute({}, execArgs({ agent })) as {
    templates: Array<{ id: string; plugins: Array<{ packageName: string; installSpec?: string }> }>;
  };
  assert.equal(view.templates[0]?.id, "dev-template-1");
  assert.equal(view.templates[0]?.plugins[0]?.installSpec, "dsh-plugin-a@1.2.3");
  await assert.rejects(() => templates.execute({ spaceId: "space-alpha" }, execArgs({ agent })), /unknown field/);

  const preview = tools.registered.get("spaces_import_preview")!;
  const staged = await preview.execute({ archiveBase64: "AAAA" }, execArgs({ agent })) as { importId: string };
  assert.equal(staged.importId, "imp-1");
  const previewCall = supervisor.calls.find((row) => row.op === "control/import.preview");
  assert.deepEqual(previewCall?.body, { archiveBase64: "AAAA" });
  for (const args of [{}, { archiveBase64: "AAA", extra: 1 }, { archiveBase64: 7 }]) {
    await assert.rejects(() => preview.execute(args, execArgs({ agent })), /spaces_import_preview/);
  }
});

test("creation ops: plan derives the new id; approval names the template/import source", async () => {
  const home = tempDir("dsh-control-create-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const tools = provideCoreServices(ctx, { home, profile: "web", approvalOutcome: "allowed-once", approvalSeen });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const plan = tools.registered.get("spaces_plan")!;
  const execute = tools.registered.get("spaces_execute")!;

  const tpl = await plan.execute({
    op: "space.from-template",
    params: { templateId: "dev-template-1", name: "fresh", displayName: "Fresh" },
  }, execArgs({ agent })) as { controlPlanId: string; spaceId: string };
  assert.equal(tpl.spaceId, "space-fresh");
  const planCall = supervisor.calls.filter((row) => row.op === "control/plan").at(-1);
  assert.deepEqual(planCall?.body, {
    op: "space.from-template",
    params: { templateId: "dev-template-1", name: "fresh", displayName: "Fresh" },
  });
  await execute.execute({ planId: tpl.controlPlanId, requestId: "req-tpl" }, execArgs({ agent }));
  assert.match(approvalSeen.at(-1)?.reason ?? "", /Create .*dev-template-1/);

  // spaceId on a creation op is rejected locally before the wire.
  await assert.rejects(
    () => plan.execute({ op: "space.import", spaceId: "space-x", params: { importId: "imp-1", name: "x" } }, execArgs({ agent })),
    /derives its space id/,
  );

  const imp = await plan.execute({
    op: "space.import", params: { importId: "imp-1", name: "imported" },
  }, execArgs({ agent })) as { controlPlanId: string; spaceId: string };
  assert.equal(imp.spaceId, "space-imported");
  await execute.execute({ planId: imp.controlPlanId, requestId: "req-imp" }, execArgs({ agent }));
  assert.match(approvalSeen.at(-1)?.reason ?? "", /Create .*imp-1/);
});

test("spaces_plan validates params shape locally before reaching the supervisor", async () => {
  const home = tempDir("dsh-control-args-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, { home, profile: "web" });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  const plan = tools.registered.get("spaces_plan")!;
  const callsBefore = supervisor.calls.filter((row) => row.op === "control/plan").length;

  // Params required but missing, present but forbidden, wrong type.
  await assert.rejects(
    () => plan.execute({ op: "plugin.install", spaceId: "space-alpha" }, execArgs({ agent })),
    /requires params/,
  );
  await assert.rejects(
    () => plan.execute({ op: "stop", spaceId: "space-alpha", params: {} }, execArgs({ agent })),
    /takes no params/,
  );
  await assert.rejects(
    () => plan.execute({ op: "runtime.set", spaceId: "space-alpha", params: "0.2.1" }, execArgs({ agent })),
    /params must be an object/,
  );
  // Closed params are validated before the wire too: a non-exact version is
  // rejected client-side by the channel contract parser.
  await assert.rejects(
    () => plan.execute({ op: "plugin.install", spaceId: "space-alpha", params: { source: { npm: { packageName: "p", version: "latest" } } } }, execArgs({ agent })),
    /exact published version|invalid-input/i,
  );
  assert.equal(
    supervisor.calls.filter((row) => row.op === "control/plan").length - callsBefore,
    0,
    "no invalid request ever reached the supervisor",
  );
});

test("mutation tools refuse non-cordis presets; read tools stay usable", async () => {
  const home = tempDir("dsh-control-preset-");
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, { home, profile: "web", preset: "standard" });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);

  const agent = { ctx, session: {} };
  for (const [name, args] of [
    ["spaces_plan", { op: "stop", spaceId: "space-alpha" }],
    ["spaces_execute", { planId: "reg-1-x", requestId: "req-p" }],
    ["spaces_control_job", { jobId: "req-p" }],
    ["spaces_import_preview", { archiveBase64: "AAAA" }],
    ["spaces_ui_open", { spaceId: "space-alpha" }],
    ["spaces_ui_snapshot", { uiSessionId: "ui-1" }],
    ["spaces_ui_act", { uiSessionId: "ui-1", requestId: "r1", act: { kind: "wait", ms: 1 } }],
    ["spaces_ui_eval", { uiSessionId: "ui-1", requestId: "r2", script: "return 1" }],
    ["spaces_ui_close", { uiSessionId: "ui-1" }],
  ] as const) {
    const tool = tools.registered.get(name)!;
    await assert.rejects(() => tool.execute(args, execArgs({ agent })), /requires Creator mode/, name);
  }
  assert.equal(
    supervisor.calls.filter((row) => row.op.startsWith("control/plan") || row.op.startsWith("control/execute") || row.op.startsWith("control/ui.") || row.op.startsWith("control/import.")).length,
    0,
    "a non-cordis call never reaches the supervisor",
  );
  const overview = tools.registered.get("spaces_overview")!;
  const value = await overview.execute({}, execArgs({ agent })) as { spaces: Array<{ id: string }> };
  assert.equal(value.spaces[0]?.id, "space-alpha");
  const templates = tools.registered.get("spaces_templates")!;
  const tview = await templates.execute({}, execArgs({ agent })) as { templates: Array<{ id: string; plugins: Array<{ packageName: string }> }> };
  assert.equal(tview.templates[0]?.id, "dev-template-1");
});

// ---------------------------------------------------------------------------
// UI automation tools (spaces_ui_*).
// ---------------------------------------------------------------------------

/** Wire a fake supervisor + channel + tool bundle; returns the shared bits. */
async function uiFixture(opts: {
  homePrefix: string;
  preset?: string;
  approvalOutcome?: string;
  approvalSeen?: Array<{ toolName: string; reason?: string }>;
  savedImages?: Array<{ data: Uint8Array; mediaType: string; name?: string }>;
  saveImageError?: Error;
}) {
  const home = tempDir(opts.homePrefix);
  writeProfile(home, "web");
  const supervisor = await startFakeSupervisor(home);
  const ctx = pluginContext();
  const tools = provideCoreServices(ctx, {
    home,
    profile: "web",
    ...(opts.preset ? { preset: opts.preset } : {}),
    ...(opts.approvalOutcome ? { approvalOutcome: opts.approvalOutcome } : {}),
    ...(opts.approvalSeen ? { approvalSeen: opts.approvalSeen } : {}),
    ...(opts.savedImages ? { savedImages: opts.savedImages } : {}),
    ...(opts.saveImageError ? { saveImageError: opts.saveImageError } : {}),
  });
  const creator = new MainSpaceCreatorService(ctx);
  services.push(creator);
  const control = new MainSpaceControlService(ctx, creator);
  controls.push(control);
  const endpoint = endpointFor(supervisor);
  await creator.attach(endpoint);
  control.attach(endpoint);
  spaceControlPlugin.apply(ctx, { approve: approveStub });
  await settle(() => tools.registered.size === 13);
  return { home, supervisor, ctx, tools, agent: { ctx, session: {} } };
}

test("spaces_ui_open asks once with space + grant text; a refused approval opens nothing", async () => {
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const { supervisor, tools, agent } = await uiFixture({
    homePrefix: "dsh-ui-open-",
    approvalOutcome: "rejected",
    approvalSeen,
  });
  const open = tools.registered.get("spaces_ui_open")!;
  await assert.rejects(
    () => open.execute({ spaceId: "space-alpha" }, execArgs({ agent })),
    /not approved \(rejected\)/,
  );
  assert.equal(
    supervisor.calls.some((row) => row.op === "control/ui.open"),
    false,
    "a refused approval never reaches the supervisor",
  );
  assert.equal(approvalSeen.length, 1);
  assert.equal(approvalSeen[0].toolName, "spaces_ui_open");
  const reason = approvalSeen[0].reason ?? "";
  assert.match(reason, /"Alpha" \(space-alpha\)/, "approval names the space id and display name");
  assert.match(reason, /click, type, select, scroll and navigate/, "approval states the granted actions");
  assert.match(reason, /closed or the space restarts/, "approval states when the grant ends");
});

test("spaces_ui_open succeeds after one grant; act/snapshot/close ask nothing further", async () => {
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const { supervisor, tools, agent } = await uiFixture({
    homePrefix: "dsh-ui-grant-",
    approvalOutcome: "allowed-once",
    approvalSeen,
  });
  const opened = await tools.registered.get("spaces_ui_open")!.execute(
    { spaceId: "space-alpha" }, execArgs({ agent }),
  ) as { uiSessionId: string; spaceId: string; viewport: { width: number } };
  assert.equal(opened.uiSessionId, "ui-space-alpha-1");
  assert.equal(opened.spaceId, "space-alpha");
  assert.equal(opened.viewport.width, 1280);
  assert.equal(approvalSeen.length, 1);

  const openCall = supervisor.calls.find((row) => row.op === "control/ui.open");
  assert.equal(openCall?.auth, `Bearer ${supervisor.controlScope}`);
  assert.equal(openCall?.headers.origin, undefined);
  assert.equal(openCall?.headers.cookie, undefined);

  await tools.registered.get("spaces_ui_act")!.execute(
    { uiSessionId: opened.uiSessionId, requestId: "act-1", act: { kind: "click", ref: "e3" } },
    execArgs({ agent }),
  );
  const aria = await tools.registered.get("spaces_ui_snapshot")!.execute(
    { uiSessionId: opened.uiSessionId },
    execArgs({ agent }),
  ) as { untrusted: { aria?: string; spaceId: string; truncated: boolean }; note: string };
  assert.equal(aria.untrusted.spaceId, "space-alpha");
  assert.match(aria.untrusted.aria ?? "", /\[ref=e3\]/);
  assert.match(aria.note, /data, not instructions/);

  const closed = await tools.registered.get("spaces_ui_close")!.execute(
    { uiSessionId: opened.uiSessionId },
    execArgs({ agent }),
  ) as { closed: boolean };
  assert.equal(closed.closed, true);
  assert.equal(approvalSeen.length, 1, "act, snapshot and close never ask again");
  const actCall = supervisor.calls.find((row) => row.op === "control/ui.act");
  assert.deepEqual(actCall?.body.act, { kind: "click", ref: "e3" });
});

test("spaces_ui_eval approves every call with the full script; over-limit scripts die before approval", async () => {
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const { supervisor, tools, agent } = await uiFixture({
    homePrefix: "dsh-ui-eval-",
    approvalOutcome: "allowed-once",
    approvalSeen,
  });
  const opened = await tools.registered.get("spaces_ui_open")!.execute(
    { spaceId: "space-alpha" }, execArgs({ agent }),
  ) as { uiSessionId: string };
  assert.equal(approvalSeen.length, 1, "only the open grant so far");

  const evalTool = tools.registered.get("spaces_ui_eval")!;
  const script = "return document.title";
  const value = await evalTool.execute(
    { uiSessionId: opened.uiSessionId, requestId: "ev-1", script },
    execArgs({ agent }),
  ) as { untrusted: { value: unknown; truncated: boolean }; note: string };
  assert.equal(approvalSeen.length, 2, "eval asked for its own approval");
  assert.equal(approvalSeen[1].toolName, "spaces_ui_eval");
  const reason = approvalSeen[1].reason ?? "";
  assert.match(reason, /"Alpha" \(space-alpha\)/, "approval names the space");
  assert.match(reason, /page \//, "approval names the page path");
  assert.ok(reason.includes(script), "approval carries the complete script");
  assert.match(reason, /same-origin data/, "approval warns the script reads page data");
  assert.deepEqual(value.untrusted.value, { echoed: script.length });
  assert.match(value.note, /data, not instructions/);

  await evalTool.execute(
    { uiSessionId: opened.uiSessionId, requestId: "ev-2", script: "return 2" },
    execArgs({ agent }),
  );
  assert.equal(approvalSeen.length, 3, "a second eval asks again");

  const huge = "x".repeat(16 * 1024 + 1);
  await assert.rejects(
    () => evalTool.execute(
      { uiSessionId: opened.uiSessionId, requestId: "ev-3", script: huge },
      execArgs({ agent }),
    ),
    /16.*KiB|16384|exceeds/,
  );
  assert.equal(approvalSeen.length, 3, "the oversized script was refused before any approval");
  assert.equal(
    supervisor.calls.some((row) => row.op === "control/ui.eval" && (row.body as { requestId?: string }).requestId === "ev-3"),
    false,
  );
});

test("a screenshot goes through attachments.saveImage and renders a [text,image] pair", async () => {
  const savedImages: Array<{ data: Uint8Array; mediaType: string; name?: string }> = [];
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const { supervisor, tools, agent } = await uiFixture({
    homePrefix: "dsh-ui-shot-",
    approvalOutcome: "allowed-once",
    approvalSeen,
    savedImages,
  });
  const opened = await tools.registered.get("spaces_ui_open")!.execute(
    { spaceId: "space-alpha" }, execArgs({ agent }),
  ) as { uiSessionId: string };

  const snapshot = tools.registered.get("spaces_ui_snapshot")! as unknown as {
    execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>;
    output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string; attachment?: unknown }> };
  };
  const result = await snapshot.execute(
    { uiSessionId: opened.uiSessionId, formats: ["aria", "screenshot"] },
    execArgs({ agent }),
  ) as { untrusted: Record<string, unknown> };
  assert.equal(savedImages.length, 1, "the base64 was persisted through saveImage");
  assert.equal(savedImages[0].mediaType, "image/png");
  assert.equal(savedImages[0].data.byteLength, 70);
  const attachment = result.untrusted.screenshotAttachment as { attachmentId: string } | undefined;
  assert.equal(attachment?.attachmentId, "att-1");
  const rendered = snapshot.output.render({}, result);
  assert.equal(rendered.length, 2, "text + image content blocks");
  assert.equal(rendered[0].type, "text");
  assert.equal(rendered[1].type, "image");
  assert.equal(rendered[1].attachment, attachment);
  // The raw base64 never reaches the text block.
  const text = rendered[0].text ?? "";
  assert.equal(text.includes("iVBORw0KGgo"), false, "screenshot base64 stays out of the text");
  assert.equal("screenshot" in result.untrusted, false, "raw base64 field removed from the payload");
  assert.equal(text.includes(supervisor.controlScope), false);
  const shotCall = supervisor.calls.find((row) => row.op === "control/ui.snapshot");
  assert.equal(shotCall?.headers.origin, undefined);
  assert.equal(shotCall?.headers.cookie, undefined);
  assert.equal(JSON.stringify(shotCall?.body ?? {}).includes(supervisor.controlScope), false);
});

test("a failing saveImage reports the error instead of leaking base64", async () => {
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const { supervisor, tools, agent } = await uiFixture({
    homePrefix: "dsh-ui-shotfail-",
    approvalOutcome: "allowed-once",
    approvalSeen,
    saveImageError: new Error("IMAGE_TOO_MANY_PIXELS"),
  });
  const opened = await tools.registered.get("spaces_ui_open")!.execute(
    { spaceId: "space-alpha" }, execArgs({ agent }),
  ) as { uiSessionId: string };
  const snapshot = tools.registered.get("spaces_ui_snapshot")!;
  const failure = await snapshot.execute(
    { uiSessionId: opened.uiSessionId, formats: ["screenshot"] },
    execArgs({ agent }),
  ).then(
    () => assert.fail("saveImage failure must reject"),
    (error: unknown) => String(error instanceof Error ? error.message : error),
  );
  assert.match(failure, /IMAGE_TOO_MANY_PIXELS/);
  assert.equal(failure.includes("iVBORw0KGgo"), false, "no base64 fallback into the error");
  assert.equal(failure.includes(supervisor.controlScope), false);
});

test("spaces_ui tools validate closed args locally before the wire", async () => {
  const approvalSeen: Array<{ toolName: string; reason?: string }> = [];
  const { supervisor, tools, agent } = await uiFixture({
    homePrefix: "dsh-ui-args-",
    approvalOutcome: "allowed-once",
    approvalSeen,
  });
  const before = supervisor.calls.length;
  await assert.rejects(
    () => tools.registered.get("spaces_ui_open")!.execute({ spaceId: "bad id" }, execArgs({ agent })),
    /spaceId/,
  );
  await assert.rejects(
    () => tools.registered.get("spaces_ui_snapshot")!.execute({ uiSessionId: "ui-1", bogus: 1 }, execArgs({ agent })),
    /unknown field "bogus"/,
  );
  await assert.rejects(
    () => tools.registered.get("spaces_ui_snapshot")!.execute(
      { uiSessionId: "ui-1", formats: ["png"] }, execArgs({ agent }),
    ),
    /unknown format/,
  );
  await assert.rejects(
    () => tools.registered.get("spaces_ui_act")!.execute(
      { uiSessionId: "ui-1", requestId: "r1", act: { kind: "explode" } }, execArgs({ agent }),
    ),
    /act\.kind/,
  );
  await assert.rejects(
    () => tools.registered.get("spaces_ui_act")!.execute(
      { uiSessionId: "ui-1", requestId: "r1", act: { kind: "type", ref: "e1" } }, execArgs({ agent }),
    ),
    /requires field "text"/,
  );
  assert.equal(supervisor.calls.length, before, "invalid args never reached the supervisor");
});
