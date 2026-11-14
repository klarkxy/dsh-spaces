import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { canonicalHome } from "../../src/adapters/node/home/home-operation-lock.ts";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
  HomeLease,
  type HomeControlHandle,
} from "../../src/adapters/node/home/home-lease.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { deriveServiceEpoch, digestHomeIdentity } from "../../src/adapters/node/server/workbench-protocol.ts";
import { CREATOR_CHANNEL_PREFIX } from "../../src/shared/creator.ts";
import { createWorkbenchGuideRemote } from "../../packages/plugin/src/client/workbench-remote.ts";
import { SpacesPlugin } from "../../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime, type WorkbenchHostRuntimeOptions } from "../../packages/plugin/src/host/runtime.ts";
import { SUPERVISOR_ENDPOINT_FILE, writeEndpointFile } from "../../packages/plugin/src/host/supervisor-bootstrap.ts";
import { desktopLaunchStateSchema } from "../../packages/plugin/src/host/workbench-schemas.ts";
import type { DesktopLaunchState } from "../../packages/plugin/src/types.ts";
import { TYPERT } from "../../packages/plugin/src/typert.host.ts";
import { TYPERT_REMOTE } from "../../packages/plugin/src/typert.remote-client.ts";

const root = mkdtempSync(join(tmpdir(), "desktop-autostart-phase2b-"));

const idle: DesktopLaunchState = {
  operationId: null,
  phase: "idle",
  serviceEpoch: null,
  managerId: null,
  reasons: [],
  failure: null,
};

function freshHome(prefix: string): string {
  return mkdtempSync(join(root, prefix));
}

function writeCli(home: string): string {
  const cli = join(home, "cli");
  mkdirSync(join(cli, "lib"), { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION }));
  const bin = join(cli, "lib/bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

function writeProfile(home: string, profile: string): string {
  const dir = join(home, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `isolated-${profile}` }));
  return dir;
}

function runtimeOptions(home: string, profile: string, extra: Partial<WorkbenchHostRuntimeOptions> = {}): WorkbenchHostRuntimeOptions {
  const dir = writeProfile(home, profile);
  const bin = writeCli(home);
  return {
    home,
    allowRealHome: false,
    argv: [process.execPath, bin, "--profile", profile],
    env: { DSH_HOME: home },
    execPath: process.execPath,
    baseUrl: pathToFileURL(dir).href + "/",
    supervisorTimeoutMs: 2000,
    ...extra,
  };
}

/** Web rejection only needs the invocation and loader base path. The profile directory stays absent. */
function webInvocation(home: string): WorkbenchHostRuntimeOptions {
  const bin = writeCli(home);
  const base = join(home, "profiles", "web");
  return {
    home,
    allowRealHome: false,
    argv: [process.execPath, bin, "--profile", "web"],
    env: { DSH_HOME: home },
    execPath: process.execPath,
    baseUrl: pathToFileURL(base).href + "/",
    supervisorTimeoutMs: 2000,
  };
}

function managerState(epoch: string) {
  return {
    protocolVersion: 2 as const,
    serviceEpoch: epoch,
    revision: "b".repeat(64),
    availability: "ready" as const,
    role: "manager" as const,
    managerId: "spaces-hub",
    owner: { kind: "web" as const, since: "2026-11-01T00:00:00.000Z" },
    writable: true,
    mode: "verified-full" as const,
    dshVersion: COMPATIBLE_DSH_CLI_VERSION,
    maintenance: false,
    reasons: [] as string[],
    jobs: [],
    spaces: [{
      id: "spaces-hub",
      displayName: "Manager",
      isHost: true,
      hasWebApp: true,
      icon: "",
      status: "running",
      generation: 1,
      managed: true,
      dshVersion: null, startWithDesktop: false,
    }],
  };
}

class CountingRuntime extends WorkbenchHostRuntime {
  begins = 0;
  override async beginDesktopLaunch(): Promise<DesktopLaunchState> {
    this.begins += 1;
    return super.beginDesktopLaunch();
  }
}

function provideMain(ctx: Context, home: string): void {
  ctx.provide("profileContext", { home, name: "desktop" } as never);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("registration server has no port");
  return address.port;
}

async function untilPhase(runtime: WorkbenchHostRuntime, phase: DesktopLaunchState["phase"]): Promise<DesktopLaunchState> {
  let last: DesktopLaunchState | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await runtime.desktopLaunchState();
    if (last.phase === phase) return last;
    if ((last.phase === "failed" || last.phase === "stopped") && phase !== last.phase) throw new Error(JSON.stringify(last));
    await delay(20);
  }
  throw new Error(`launch stayed ${last?.phase}: ${JSON.stringify(last)}`);
}

test("guide launch methods are no-arg and share one strict result shape", async () => {
  const names = ["beginDesktopLaunch", "desktopLaunchState"] as const;
  for (const name of names) {
    const host = TYPERT.invocations.find((row) => row.namespace === "workbenchGuide" && row.method === name);
    const remote = TYPERT_REMOTE.descriptors.find((row) => row.namespace === "workbenchGuide" && row.method === name);
    assert.ok(host);
    assert.ok(remote);
    assert.deepEqual(host.parameters, []);
    assert.deepEqual(remote.parameters, []);
    assert.equal(host.result.mode, "strict");
    assert.equal(remote.result.mode, "strict");
    const codec = host.result.create();
    const ready = {
      ...idle,
      operationId: "op-1",
      phase: "ready" as const,
      serviceEpoch: "a".repeat(64),
      managerId: "spaces-hub",
    };
    assert.equal(codec.safeParse(idle).success, true);
    assert.equal(desktopLaunchStateSchema.safeParse(idle).success, true);
    assert.equal(codec.safeParse(ready).success, true);
    assert.equal(desktopLaunchStateSchema.safeParse(ready).success, true);
    for (const invalid of [
      { ...idle, extra: true },
      { ...idle, token: "secret" },
      { ...idle, phase: "paused" },
      { ...idle, serviceEpoch: "nope" },
      { ...ready, serviceEpoch: "g".repeat(64) },
    ]) {
      assert.equal(codec.safeParse(invalid).success, false);
      assert.equal(desktopLaunchStateSchema.safeParse(invalid).success, false);
    }
  }
  const calls: { endpoint: string; args: unknown }[] = [];
  const guide = createWorkbenchGuideRemote({
    rpc: {
      async call(_channel: string, endpoint: string, body: { args?: unknown }) {
        calls.push({ endpoint, args: body.args });
        return { ok: true, value: idle };
      },
    },
  } as never);
  assert.deepEqual(await guide.beginDesktopLaunch!(), idle);
  assert.deepEqual(await guide.desktopLaunchState!(), idle);
  assert.deepEqual(calls, [
    { endpoint: "workbenchGuide/beginDesktopLaunch", args: {} },
    { endpoint: "workbenchGuide/desktopLaunchState", args: {} },
  ]);
});

test("confirmed Desktop schedules one background launch and stays connecting until Main registers", async () => {
  const home = freshHome("desktop-");
  const registrations: string[] = [];
  const fetches: string[] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let releaseIssue = (): void => undefined;
  const issueGate = new Promise<void>((resolve) => { releaseIssue = resolve; });
  let lease: HomeControlHandle | undefined;
  let endpoint: { origin: string; bearer: string; protocolVersion: 2; homeId: string; serviceEpoch: string } | undefined;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.url?.endsWith("/issue")) {
      registrations.push(req.url);
      await issueGate;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, value: { registrationId: "desktop-main", scopes: { creator: "s".repeat(64) }, serviceEpoch: endpoint!.serviceEpoch } }));
  });
  const port = await listen(server);
  let bootstraps = 0;
  const options = runtimeOptions(home, "desktop", {
    fetch: async (input) => {
      fetches.push(String(input));
      throw new Error("unexpected fetch");
    },
    connect: () => ({ state: async () => managerState(endpoint!.serviceEpoch) }) as never,
    bootstrap: async (request) => {
      bootstraps += 1;
      request.progress?.("prepare");
      await gate;
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", `http://127.0.0.1:${port}/`);
      writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), JSON.stringify({ version: 1, profileId: "spaces-hub", createdAt: "2026-11-01T00:00:00.000Z" }));
      endpoint = {
        origin: `http://127.0.0.1:${port}`,
        bearer: "c".repeat(64),
        protocolVersion: 2,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
        serviceEpoch: deriveServiceEpoch(lease.owner.nonce),
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
      return { connected: true, origin: endpoint.origin, endpoint, payloadDir: home, toolsDir: home };
    },
  });
  const runtime = new CountingRuntime(options);
  const ctx = new Context();
  provideMain(ctx, home);
  try {
    assert.equal(runtime.qualifiesForAutomaticDesktopLaunch(), true);
    const plugin = new SpacesPlugin(ctx, {}, runtime);
    assert.equal(runtime.begins, 1);
    assert.equal(bootstraps, 0);
    const preparing = await untilPhase(runtime, "preparing");
    assert.equal(bootstraps, 1);
    assert.equal(registrations.length, 0);
    assert.equal(fetches.some((url) => url.includes("handoff") || url.includes("portal") || url.includes("/internal/bootstrap")), false);
    release();
    const connecting = await untilPhase(runtime, "connecting");
    assert.equal(connecting.operationId, preparing.operationId);
    await delay(40);
    // The Creator registration is in flight: the launch waits for it.
    assert.equal((await plugin.guide.desktopLaunchState!()).phase, "connecting");
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.includes(CREATOR_CHANNEL_PREFIX), true);
    assert.equal(runtime.begins, 1);
    releaseIssue();
    const ready = await untilPhase(runtime, "ready");
    assert.equal(ready.operationId, preparing.operationId);
    assert.equal(registrations.length, 1);
    assert.equal(bootstraps, 1);
    assert.equal((await plugin.guide.beginDesktopLaunch!()).operationId, ready.operationId);
    assert.equal(runtime.begins, 2);
    assert.equal(bootstraps, 1);
    assert.equal(registrations.length, 1);
    let late = 0;
    runtime.onSupervisorAttached(async () => { late += 1; });
    await delay(40);
    assert.equal(late, 1);
    await delay(40);
    assert.equal(late, 1);
    assert.equal((await runtime.desktopLaunchState()).phase, "ready");
    const again = new Context();
    provideMain(again, home);
    const remounted = new CountingRuntime(options);
    try {
      new SpacesPlugin(again, {}, remounted);
      await delay(40);
      assert.equal(remounted.begins, 1);
      assert.equal(registrations.length, 1);
      assert.equal(bootstraps, 1);
      assert.equal((await remounted.desktopLaunchState()).operationId, ready.operationId);
      assert.equal((await remounted.desktopLaunchState()).phase, "ready");
    } finally {
      await again.fiber.dispose();
    }
  } finally {
    release();
    releaseIssue();
    await ctx.fiber.dispose();
    const current = lease as HomeControlHandle | undefined;
    current?.release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejected Main registration is a terminal Desktop launch and is not replayed", async () => {
  const home = freshHome("refused-");
  const registrations: string[] = [];
  let lease: HomeControlHandle | undefined;
  let endpoint: { origin: string; bearer: string; protocolVersion: 2; homeId: string; serviceEpoch: string } | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url?.endsWith("/issue")) registrations.push(Buffer.concat(chunks).toString());
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "creator/forbidden", message: "Main registration refused." } }));
  });
  const port = await listen(server);
  let bootstraps = 0;
  const runtime = new CountingRuntime(runtimeOptions(home, "desktop", {
    connect: () => ({ state: async () => managerState(endpoint!.serviceEpoch) }) as never,
    bootstrap: async () => {
      bootstraps += 1;
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", `http://127.0.0.1:${port}/`);
      endpoint = {
        origin: `http://127.0.0.1:${port}`,
        bearer: "d".repeat(64),
        protocolVersion: 2,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
        serviceEpoch: deriveServiceEpoch(lease.owner.nonce),
      };
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
      return { connected: true, origin: endpoint.origin, endpoint, payloadDir: home, toolsDir: home };
    },
  }));
  const ctx = new Context();
  provideMain(ctx, home);
  try {
    new SpacesPlugin(ctx, {}, runtime);
    const failed = await untilPhase(runtime, "failed");
    assert.match(failed.reasons.join(" "), /Main registration refused/);
    assert.equal(registrations.length, 1);
    assert.equal(bootstraps, 1);
    await delay(50);
    assert.equal((await runtime.beginDesktopLaunch()).operationId, failed.operationId);
    assert.equal((await runtime.desktopLaunchState()).phase, "failed");
    assert.equal(registrations.length, 1);
    assert.equal(bootstraps, 1);
    assert.equal(runtime.begins, 2);
  } finally {
    await ctx.fiber.dispose();
    const current = lease as HomeControlHandle | undefined;
    current?.release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("disposal keeps the launch record and does not schedule another begin", async () => {
  const home = freshHome("dispose-");
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let lease: HomeControlHandle | undefined;
  let endpoint: { origin: string; bearer: string; protocolVersion: 2; homeId: string; serviceEpoch: string } | undefined;
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  const port = await listen(server);
  let bootstraps = 0;
  const runtime = new CountingRuntime(runtimeOptions(home, "desktop", {
    connect: () => ({ state: async () => managerState(endpoint!.serviceEpoch) }) as never,
    bootstrap: async (request) => {
      bootstraps += 1;
      request.progress?.("prepare");
      await gate;
      lease = new HomeLease(home, { allowRealHome: false }).acquire("web", `http://127.0.0.1:${port}/`);
      endpoint = {
        origin: `http://127.0.0.1:${port}`,
        bearer: "e".repeat(64),
        protocolVersion: 2,
        homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
        serviceEpoch: deriveServiceEpoch(lease.owner.nonce),
      };
      return { connected: true, origin: endpoint.origin, endpoint, payloadDir: home, toolsDir: home };
    },
  }));
  const ctx = new Context();
  try {
    new SpacesPlugin(ctx, {}, runtime);
    const preparing = await untilPhase(runtime, "preparing");
    assert.equal(runtime.begins, 1);
    await ctx.fiber.dispose();
    release();
    const failed = await untilPhase(runtime, "failed");
    assert.equal(failed.operationId, preparing.operationId);
    assert.match(failed.reasons.join(" "), /MAIN_CLOSED/);
    assert.equal(runtime.begins, 1);
    assert.equal(bootstraps, 1);
    assert.equal((await runtime.desktopLaunchState()).operationId, preparing.operationId);
  } finally {
    release();
    const current = lease as HomeControlHandle | undefined;
    current?.release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("manager, Web, and managed child profiles do not schedule a Desktop launch", async () => {
  const managerHome = freshHome("manager-");
  mkdirSync(join(managerHome, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(join(managerHome, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), JSON.stringify({ version: 1, profileId: "spaces-hub", createdAt: "2026-11-01T00:00:00.000Z" }));
  let managerBootstraps = 0;
  const managerRuntime = new CountingRuntime(runtimeOptions(managerHome, "spaces-hub", {
    bootstrap: async () => {
      managerBootstraps += 1;
      return { connected: false, origin: null, reasons: ["not started in this unit test"] };
    },
  }));
  const managerCtx = new Context();
  const webHome = freshHome("web-");
  const webRuntime = new CountingRuntime(webInvocation(webHome));
  const webCtx = new Context();
  const childRuntime = new CountingRuntime(runtimeOptions(freshHome("child-"), "notes"));
  const childCtx = new Context();
  try {
    assert.equal(managerRuntime.qualifiesForAutomaticDesktopLaunch(), false);
    assert.equal(webRuntime.qualifiesForAutomaticDesktopLaunch(), false);
    assert.equal(childRuntime.qualifiesForAutomaticDesktopLaunch(), false);
    const manager = new SpacesPlugin(managerCtx, {}, managerRuntime);
    const web = new SpacesPlugin(webCtx, {}, webRuntime);
    const child = new SpacesPlugin(childCtx, {}, childRuntime);
    await delay(30);
    assert.equal(managerRuntime.begins, 0);
    assert.equal(webRuntime.begins, 0);
    assert.equal(childRuntime.begins, 0);
    assert.equal(managerBootstraps, 1);
    assert.equal(manager.manager !== null, true);
    assert.equal(web.manager, null);
    assert.equal(child.manager, null);
    assert.equal(existsSync(join(webHome, "profiles", "web")), false);
    await assert.rejects(() => web.guide.beginDesktopLaunch!(), (error: unknown) => error instanceof RemoteError);
    await assert.rejects(() => child.guide.desktopLaunchState!(), (error: unknown) => error instanceof RemoteError);
    assert.equal(webRuntime.begins, 1);
    assert.equal(childRuntime.begins, 0);
    assert.equal(existsSync(join(webHome, "profiles", "web")), false);
  } finally {
    await managerCtx.fiber.dispose();
    await webCtx.fiber.dispose();
    await childCtx.fiber.dispose();
  }
});

test("a rejected background begin is recorded as a safe reason and does not open a launch", async () => {
  const home = freshHome("guard-log-");
  const logged: string[] = [];
  const ctx = new Context();
  const logger = ctx.logger;
  const previous = logger.error;
  logger.error = (format: unknown, ...param: unknown[]) => {
    logged.push([format, ...param].map((value) => value instanceof Error ? value.message : String(value)).join(" "));
  };
  class RejectingRuntime extends CountingRuntime {
    override async beginDesktopLaunch(): Promise<DesktopLaunchState> {
      this.begins += 1;
      throw new Error("HOST_LAUNCH_GUARD_FAILED token=synthetic-secret C:/private/fixture");
    }
  }
  const runtime = new RejectingRuntime(runtimeOptions(home, "desktop"));
  try {
    assert.equal(runtime.qualifiesForAutomaticDesktopLaunch(), true);
    new SpacesPlugin(ctx, {}, runtime);
    await delay(30);
    assert.equal(runtime.begins, 1);
    assert.equal(logged.some((message) => message.includes("HOST_LAUNCH_GUARD_FAILED")), true);
    assert.equal(logged.some((message) => /synthetic-secret|C:\/private/.test(message)), false);
    const state = await runtime.desktopLaunchState();
    assert.equal(state.operationId, null);
    assert.equal(state.phase, "idle");
    assert.equal(runtime.begins, 1);
  } finally {
    logger.error = previous;
    await ctx.fiber.dispose();
  }
});
