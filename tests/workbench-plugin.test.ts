import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
} from "../src/adapters/node/home-controller.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../src/adapters/node/spaces-control.ts";
import { resolveHostIdentity } from "../packages/plugin/src/host/identity.ts";
import { SpacesPlugin, injectHintScript } from "../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime } from "../packages/plugin/src/host/runtime.ts";
import { createWorkbenchHttpClient, mintSupervisorHandoff } from "../packages/plugin/src/host/workbench-http.ts";
import { validateSnapshotRoot } from "../packages/plugin/src/host/supervisor-pack.ts";
import {
  SUPERVISOR_CLI_FLAGS,
  SUPERVISOR_ENDPOINT_FILE,
  bootstrapSupervisor,
  writeEndpointFile,
} from "../packages/plugin/src/host/supervisor-bootstrap.ts";
import { catalogIdSchema, workbenchCommandSchema, workbenchInitializeResultSchema, workbenchViewSchema, workbenchPackageResultSchema, workbenchPlanRequestSchema } from "../packages/plugin/src/host/workbench-schemas.ts";
import { GUIDE_METHODS, TYPERT } from "../packages/plugin/src/typert.host.ts";
import {
  createWorkbenchGuideRemote,
  createWorkbenchRemote,
  displayWorkbenchMessage,
  isTrustedLoopbackHref,
  readHostHint,
  WorkbenchRemoteError,
} from "../packages/plugin/src/client/workbench-remote.ts";
import { apply as applyClient, ReturnToWorkbenchPanel } from "../packages/plugin/src/client/index.tsx";
import { GUIDE_COPY } from "../packages/plugin/src/client/i18n.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { apply as applyViewHost, parseViewEnv } from "../packages/view-bridge/src/index.ts";
import { startViewBridge, type BootWatch } from "../packages/view-bridge/src/client.ts";
import { PARENT_PING_SOURCE, acceptParentMessage, postViewState } from "../packages/view-bridge/src/handshake.ts";

const temps: string[] = [];
const contexts: Context[] = [];

test("package update RPC preserves a missing candidate and rejects browser paths", async () => {
  const endpoints: string[] = [];
  const remote = createWorkbenchRemote({ rpc: { call: async (_channel: string, endpoint: string) => {
    endpoints.push(endpoint);
    return { ok: true, value: null };
  } } } as never);
  assert.equal(await remote.workbenchPackage?.(), null);
  assert.deepEqual(endpoints, ["workbench/workbenchPackage"]);
  const request = { kind: "workbench.upgrade", catalogId: "bundled-workbench", version: "0.2.0" };
  assert.deepEqual(workbenchPlanRequestSchema.parse(request), request);
  assert.equal(workbenchPlanRequestSchema.safeParse({ ...request, path: "C:/replacement.tgz" }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ ...request, expectedDigest: "a".repeat(64) }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ ...request, catalogId: "file:replacement.tgz" }).success, false);
  assert.equal(workbenchPackageResultSchema.parse(null), null);
});

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose();
    } catch {
      /* test isolation */
    }
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
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME));
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE),
    `${JSON.stringify({ version: 1, profileId, createdAt: "2026-09-12T00:00:00.000Z" })}\n`,
  );
}

function writeCli(root: string, version = COMPATIBLE_DSH_CLI_VERSION): string {
  const pkg = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version })}\n`);
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

function identityInput(home: string, profile: string, extra: { argv?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const bin = extra.argv?.[1] ?? writeCli(home);
  return {
    home,
    allowRealHome: false as const,
    argv: extra.argv ?? [process.execPath, bin, "--profile", profile],
    env: extra.env ?? { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    baseUrl: `${pathToFileURL(join(home, "profiles", profile)).href}/`,
  };
}

function methodsOf(service: object): string[] {
  return remoteMethods(service).map((row) => row.exportName ?? row.method);
}

function writePayload(pluginRoot: string): string {
  const lib = join(pluginRoot, "lib");
  const supervisor = join(lib, "supervisor");
  const viewBridge = join(lib, "view-bridge");
  mkdirSync(supervisor, { recursive: true });
  mkdirSync(viewBridge, { recursive: true });
  writeFileSync(join(pluginRoot, "package.json"), `${JSON.stringify({ name: "@dsh-spaces/plugin", version: "0.2.0" })}\n`);
  writeFileSync(join(viewBridge, "package.json"), `${JSON.stringify({ name: "@dsh-spaces/view-bridge", version: "0.2.0" })}\n`);
  writeFileSync(join(supervisor, "manifest.json"), `${JSON.stringify({ version: "0.2.0", entry: "index.js" })}\n`);
  writeFileSync(join(supervisor, "index.js"), "export {};\n");
  writeFileSync(join(supervisor, "snapshot-worker.mjs"), "export {};\n");
  return lib;
}

async function stubPack(request: { packageRoot: string; destination: string }): Promise<string> {
  mkdirSync(request.destination, { recursive: true });
  const name = request.packageRoot.includes("view-bridge") ? "view-bridge-0.2.0.tgz" : "plugin-0.2.0.tgz";
  const path = join(request.destination, name);
  writeFileSync(path, "tarball");
  return path;
}

function startFixture(options: {
  bearer: string;
  originOut?: { value: string };
  handoff?: string;
}): Promise<{ origin: string; close: () => Promise<void>; tokens: string[] }> {
  const tokens: string[] = [];
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? "");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/workbench/state") {
      if (auth !== `Bearer ${options.bearer}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: { code: "workbench/unauthorized", message: "no" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          value: {
            role: "manager",
            managerId: "spaces-hub",
            owner: null,
            writable: true,
            mode: "verified-full",
            dshVersion: "0.1.5-rc.1",
            maintenance: false,
            recoveryRequired: false,
            reasons: [],
            spaces: [{ id: "spaces-hub", displayName: "Manager", isHost: true, hasWebApp: true, isolation: "verified", icon: "", status: "running", generation: 1, managed: true, needsIsolation: false }],
            jobs: [],
          },
        }),
      );
      return;
    }
    if (url.pathname === "/internal/bootstrap" && req.method === "POST") {
      if (auth !== `Bearer ${options.bearer}`) {
        res.writeHead(401);
        res.end("{}");
        return;
      }
      const token = randomUUID().replaceAll("-", "");
      tokens.push(token);
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: options.handoff ?? `${origin}/bootstrap/${token}` }));
      return;
    }
    if (url.pathname.startsWith("/bootstrap/") && req.method === "GET") {
      const token = url.pathname.slice("/bootstrap/".length);
      if (!tokens.includes(token)) {
        res.writeHead(401);
        res.end("no");
        return;
      }
      tokens.splice(tokens.indexOf(token), 1);
      res.writeHead(303, {
        location: "/",
        "set-cookie": "dsh-auth-test=session; Path=/; HttpOnly; SameSite=Strict",
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
      if (options.originOut) options.originOut.value = origin;
      resolve({
        origin,
        tokens,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function pluginContext(): Context {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide("webServer", {
    tapIndex() {
      return () => undefined;
    },
  });
  return ctx;
}

test("roleOf uses the current profile id: manager, workspace, uninitialized, corrupt", () => {
  const home = tempDir("dsh-wb-roles-");
  writeProfile(home, "web");
  writeProfile(home, "spaces-hub");
  writeProfile(home, "notes");
  writeManager(home, "spaces-hub");

  const manager = resolveHostIdentity(identityInput(home, "spaces-hub"));
  assert.equal(manager.role, "manager");
  assert.equal(manager.recoveryRequired, false);
  assert.equal(manager.profileId, "spaces-hub");
  assert.equal(manager.managerId, "spaces-hub");

  const workspace = resolveHostIdentity(identityInput(home, "notes"));
  assert.equal(workspace.role, "workspace");
  assert.equal(workspace.recoveryRequired, false);
  assert.equal(new WorkbenchHostRuntime(identityInput(home, "notes")).shouldRegisterManager, false);

  const uninitializedHome = tempDir("dsh-wb-uninit-");
  writeProfile(uninitializedHome, "web");
  const uninitialized = resolveHostIdentity(identityInput(uninitializedHome, "ghost"));
  assert.equal(uninitialized.role, "uninitialized");
  assert.equal(uninitialized.recoveryRequired, false);
  assert.equal(uninitialized.confirmed, true);

  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), "{\n");
  const corrupt = resolveHostIdentity(identityInput(home, "notes"));
  assert.equal(corrupt.recoveryRequired, true);
  assert.equal(corrupt.role, "uninitialized");
  assert.equal(new WorkbenchHostRuntime(identityInput(home, "notes")).shouldRegisterManager, false);
});

test("ordinary and corrupt profiles register only the guide Remote", () => {
  const home = tempDir("dsh-wb-ordinary-");
  writeProfile(home, "notes");
  const ctx = pluginContext();
  const runtime = new WorkbenchHostRuntime(identityInput(home, "notes"));
  const plugin = new SpacesPlugin(ctx, {}, runtime);
  assert.equal(plugin.manager, null);
  assert.equal(plugin.spaces, null);
  assert.deepEqual(methodsOf(plugin.guide), ["role", "bootstrap", "returnTarget", "initialize"]);
  assert.equal(plugin.guide.typertRemote.namespace, "workbenchGuide");
});

test("manager profile registers manager WorkbenchApi and compatibility reads, not create/verify", () => {
  const home = tempDir("dsh-wb-manager-");
  writeProfile(home, "spaces-hub");
  writeManager(home, "spaces-hub");
  const ctx = pluginContext();
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "spaces-hub"),
    bootstrap: async () => ({
      connected: false,
      origin: null,
      reasons: ["not started in this unit test"],
    }),
  });
  assert.equal(runtime.shouldRegisterManager, true);
  const plugin = new SpacesPlugin(ctx, {}, runtime);
  assert.ok(plugin.manager);
  assert.ok(plugin.spaces);
  assert.deepEqual(methodsOf(plugin.guide), ["role", "bootstrap", "returnTarget", "initialize"]);
  assert.ok(methodsOf(plugin.manager!).includes("state"));
  assert.ok(methodsOf(plugin.manager!).includes("submit"));
  assert.equal(methodsOf(plugin.spaces!).includes("create"), false);
  assert.equal(methodsOf(plugin.spaces!).includes("verify"), false);
  assert.deepEqual(methodsOf(plugin.spaces!), ["overview", "detail"]);
});

test("guide bootstrap refuses damaged identity and does not clear locks", async () => {
  const home = tempDir("dsh-wb-lock-");
  writeProfile(home, "web");
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME));
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), "{not-json");
  mkdirSync(join(home, ".dsh-spaces-lock"));
  const runtime = new WorkbenchHostRuntime(identityInput(home, "web"));
  const result = await runtime.bootstrap();
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.connected, false);
  assert.equal(result.origin, null);
  assert.ok(readFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), "utf8").includes("{not-json"));
});

test("bootstrap copies payload, packs artifacts, passes CLI flags, and pings before connected", async () => {
  const home = tempDir("dsh-wb-boot-");
  writeProfile(home, "web");
  const bin = writeCli(home);
  const pluginRoot = tempDir("dsh-wb-plugin-pkg-");
  const payloadRoot = writePayload(pluginRoot);
  const toolsRoot = tempDir("dsh-wb-tools-");
  const bearer = "B".repeat(32);
  const fixture = await startFixture({ bearer });
  const spawned: string[][] = [];
  try {
    const result = await bootstrapSupervisor({
      home,
      argv: [process.execPath, bin, "--profile", "web"],
      env: { ...process.env, DSH_HOME: home },
      execPath: process.execPath,
      payloadRoot,
      toolsRoot,
      allowColdStart: true,
      timeoutMs: 3_000,
      pollMs: 20,
      pack: stubPack,
      fetch: (input, init) => fetch(input, init),
      spawn: (request) => {
        spawned.push([...request.argv]);
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), {
          origin: fixture.origin,
          bearer,
        });
      },
    });
    assert.equal(result.connected, true);
    if (!result.connected) return;
    assert.equal(result.origin, fixture.origin);
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.pluginArtifact));
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.viewBridgeArtifact));
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.controlToolRoot));
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.snapshotWorker));
    assert.ok(spawned[0]?.includes(toolsRoot));
    assert.equal(JSON.stringify({ origin: result.origin }).includes(bearer), false);
  } finally {
    await fixture.close();
  }
});

test("missing supervisor payload diagnoses instead of mocking a connection", async () => {
  const home = tempDir("dsh-wb-missing-sup-");
  writeProfile(home, "web");
  const bin = writeCli(home);
  const result = await bootstrapSupervisor({
    home,
    argv: [process.execPath, bin, "--profile", "web"],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    payloadRoot: tempDir("dsh-wb-empty-payload-"),
    toolsRoot: tempDir("dsh-wb-empty-tools-"),
    timeoutMs: 200,
  });
  assert.equal(result.connected, false);
  assert.ok(result.reasons.some((row) => /payload/i.test(row)));
});

test("manager HTTP client posts to /api/workbench/<method> and sanitizes errors", async () => {
  const bearer = "C".repeat(32);
  let seenAuth = "";
  let seenUrl = "";
  const server = createServer((req, res) => {
    seenAuth = String(req.headers.authorization ?? "");
    seenUrl = String(req.url ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${bearer}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: { code: "secret", message: join(tmpdir(), "token") } }));
        return;
      }
      if (req.url === "/api/workbench/state") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            value: {
              role: "manager",
              managerId: "spaces-hub",
              owner: null,
              writable: true,
              mode: "verified-full",
              dshVersion: "0.1.5-rc.1",
              maintenance: false,
              recoveryRequired: false,
              reasons: [],
              spaces: [],
              jobs: [],
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "ENOENT", message: "C:\\\\secret\\\\token" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const api = createWorkbenchHttpClient({ endpoint: { origin, bearer } });
    const state = await api.state();
    assert.equal(state.role, "manager");
    assert.equal(seenAuth, `Bearer ${bearer}`);
    assert.equal(seenUrl, "/api/workbench/state");
    await assert.rejects(() => api.job("job-1"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "workbench/unavailable");
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("typert schemas reject extra fields, tokens, and non-loopback views", () => {
  assert.equal(workbenchCommandSchema.safeParse({ kind: "space.start", spaceId: "notes", extra: true }).success, false);
  assert.equal(workbenchCommandSchema.safeParse({ kind: "plugin.install", spaceIds: ["notes"], catalogId: "file:../x", version: "1.0.0" }).success, false);
  assert.equal(catalogIdSchema.safeParse("@scope/name").success, true);
  assert.equal(catalogIdSchema.safeParse("git+https://example.com/repo.git").success, false);
  assert.equal(
    workbenchViewSchema.safeParse({
      spaceId: "notes",
      generation: 1,
      origin: "http://example.com",
      entryOrigin: "http://127.0.0.1:9",
      entryPath: "/entry",
      channel: "c1",
    }).success,
    false,
  );
  const ok = workbenchViewSchema.safeParse({
    spaceId: "notes",
    generation: 1,
    origin: "http://127.0.0.1:10",
    entryOrigin: "http://127.0.0.1:9",
    entryPath: "/embed/notes",
    channel: "c1",
  });
  assert.equal(ok.success, true);
});

test("client remotes sanitize unknown errors and refuse non-loopback return URLs", async () => {
  const connection = {
    rpc: {
      call: async () => ({ ok: false as const, error: { code: "internal", message: "C:\\\\Users\\\\admin\\\\.dsh", details: {} } }),
    },
  };
  const guide = createWorkbenchGuideRemote(connection);
  await assert.rejects(() => guide.role(), (error: unknown) => {
    assert.ok(error instanceof WorkbenchRemoteError);
    assert.equal(error.code, null);
    assert.equal(displayWorkbenchMessage(error).includes(".dsh"), false);
    return true;
  });
  assert.equal(isTrustedLoopbackHref("http://127.0.0.1:9", "/"), "http://127.0.0.1:9/");
  assert.equal(isTrustedLoopbackHref("http://127.0.0.1:9", "//evil"), null);
  assert.equal(isTrustedLoopbackHref("http://example.com", "/"), null);
  assert.equal(readHostHint({ __DSH_SPACES_HOST__: { role: "manager", recoveryRequired: false } })?.role, "manager");
  assert.equal(readHostHint({ __DSH_SPACES_HOST__: { role: "root", recoveryRequired: false } }), null);
  const html = injectHintScript("<head></head>", JSON.stringify({ role: "workspace", recoveryRequired: false }));
  assert.match(html, /__DSH_SPACES_HOST__/);
});

test("client apply registers root only for manager hints and a return entry otherwise", () => {
  const registrations: Array<{ name: string; id?: string; key?: string }> = [];
  const ctx = {
    get: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
    slots: {
      inject(name: string, callback: () => void) {
        callback();
      },
      register(options: { name: string; id?: string; key?: string }) {
        registrations.push(options);
        return () => undefined;
      },
    },
  };
  applyClient(ctx as never);
  assert.equal(registrations.some((row) => row.name === "root"), false);
  assert.ok(registrations.some((row) => row.name === "sidebar.panellist" && row.id === "dsh-spaces"));
  assert.ok(registrations.some((row) => row.name === "main" && row.key === "dsh-spaces"));
  assert.equal(typeof ReturnToWorkbenchPanel, "function");

  registrations.length = 0;
  (globalThis as { __DSH_SPACES_HOST__?: unknown }).__DSH_SPACES_HOST__ = { role: "manager", recoveryRequired: false };
  try {
    applyClient(ctx as never);
    assert.ok(registrations.some((row) => row.name === "root"));
    assert.equal(registrations.some((row) => row.name === "sidebar.panellist"), false);
  } finally {
    delete (globalThis as { __DSH_SPACES_HOST__?: unknown }).__DSH_SPACES_HOST__;
  }
});

test("view-bridge ignores invalid env, has no management API, and can ready again after disconnect", () => {
  const hostSrc = readFileSync(new URL("../packages/view-bridge/src/index.ts", import.meta.url), "utf8");
  const clientSrc = readFileSync(new URL("../packages/view-bridge/src/client.ts", import.meta.url), "utf8");
  assert.equal(hostSrc.includes("WorkbenchApi"), false);
  assert.equal(hostSrc.includes("workbench-manager"), false);
  assert.equal(clientSrc.includes("createWorkbenchRemote"), false);
  assert.equal(clientSrc.includes('name: "root"'), false);
  assert.equal(parseViewEnv({}), null);
  assert.equal(parseViewEnv({ DSH_SPACES_VIEW_PARENT_ORIGIN: "http://example.com", DSH_SPACES_VIEW_ID: "notes", DSH_SPACES_VIEW_GENERATION: "1", DSH_SPACES_VIEW_CHANNEL: "c1" }), null);
  const ctx = new Context();
  contexts.push(ctx);
  assert.equal(applyViewHost(ctx, {}, {}), null);

  const view = parseViewEnv({
    DSH_SPACES_VIEW_PARENT_ORIGIN: "http://127.0.0.1:11",
    DSH_SPACES_VIEW_ID: "notes",
    DSH_SPACES_VIEW_GENERATION: "3",
    DSH_SPACES_VIEW_CHANNEL: "chan-1",
  });
  assert.ok(view);
  const posted: Array<{ data: { state: string }; origin: string }> = [];
  const parent = {
    postMessage(data: { state: string }, origin: string) {
      posted.push({ data, origin });
    },
  };
  const box = { nodes: ["boot"] };
  const observers: Array<() => void> = [];
  const watch: BootWatch = {
    findBoot: () => (box.nodes.includes("boot") ? { parentElement: box as unknown as ParentNode } : null),
    hasAppDom: () => box.nodes.includes("app"),
    observe: (_container, onChange) => {
      observers.push(onChange);
      return () => undefined;
    },
  };
  let conn: "connected" | "disconnected" | "connecting" = "connected";
  const listeners: Array<() => void> = [];
  const stop = startViewBridge(
    {
      slots: {
        inject(_name, callback) {
          callback();
          return () => undefined;
        },
      },
    },
    view!,
    {
      parent,
      parentSource: parent,
      timeoutMs: 5_000,
      bootWatch: watch,
      connection: {
        state: {
          getSnapshot: () => conn,
          subscribe: (listener) => {
            listeners.push(listener);
            return () => undefined;
          },
        },
      },
    },
  );
  assert.equal(posted.length, 0);
  box.nodes = ["app"];
  for (const observer of observers) observer();
  assert.equal(posted[0]?.data.state, "ready");
  assert.equal(posted[0]?.origin, "http://127.0.0.1:11");
  conn = "disconnected";
  for (const listener of listeners) listener();
  assert.equal(posted[1]?.data.state, "disconnected");
  conn = "connected";
  for (const listener of listeners) listener();
  assert.equal(posted[2]?.data.state, "ready");
  const ping = {
    origin: "http://127.0.0.1:11",
    source: parent,
    data: { source: PARENT_PING_SOURCE, type: "ping", spaceId: "notes", generation: 3, channel: "chan-1" },
  };
  const addMessage = startViewBridge(
    { slots: { inject: (_n, cb) => { cb(); return () => undefined; } } },
    view!,
    {
      parent,
      parentSource: parent,
      timeoutMs: 5_000,
      bootWatch: watch,
      connection: { state: { getSnapshot: () => "connected" as const, subscribe: () => () => undefined } },
      addMessageListener: (listener) => {
        listener(ping as MessageEvent);
        return () => undefined;
      },
    },
  );
  assert.ok(posted.some((row) => row.data.state === "ready"));
  stop();
  addMessage();
  const accepted = acceptParentMessage(
    { origin: "http://127.0.0.1:11", source: parent, data: posted[0]?.data },
    view!,
    parent,
  );
  assert.equal(accepted?.state, "ready");
  assert.equal(
    acceptParentMessage({ origin: "http://127.0.0.1:99", source: parent, data: posted[0]?.data }, view!, parent),
    null,
  );
  assert.equal(postViewState(parent, view!, "failed"), true);
  assert.ok(!JSON.stringify(posted).includes("token"));
});

test("ordinary profile does not cold-start a second controller", async () => {
  const home = tempDir("dsh-wb-ordinary-boot-");
  writeProfile(home, "notes");
  writeProfile(home, "spaces-hub");
  writeManager(home, "spaces-hub");
  let spawned = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "notes"),
    payloadRoot: writePayload(tempDir("dsh-wb-ord-pkg-")),
    toolsRoot: tempDir("dsh-wb-ord-tools-"),
    supervisorTimeoutMs: 500,
    bootstrap: async (options) => {
      if (options.allowColdStart) spawned += 1;
      return bootstrapSupervisor({ ...options, pack: stubPack, spawn: () => {
        spawned += 1;
      } });
    },
  });
  const result = await runtime.bootstrap();
  assert.equal(result.connected, false);
  assert.equal(spawned, 0);
  assert.ok(result.reasons.some((row) => /second controller|not found|ping/i.test(row)));
});

test("stale endpoint with a live foreign owner is not overwritten", async () => {
  const home = tempDir("dsh-wb-stale-");
  writeProfile(home, "spaces-hub");
  writeManager(home, "spaces-hub");
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME), { recursive: true });
  writeFileSync(
    join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE),
    `${JSON.stringify({
      pid: process.pid,
      nonce: "a".repeat(32),
      startedAt: new Date().toISOString(),
      kind: "web",
      endpoint: "http://127.0.0.1:1/",
    })}\n`,
  );
  const original = { origin: "http://127.0.0.1:9", bearer: "D".repeat(32) };
  writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), original);
  let spawned = 0;
  const result = await bootstrapSupervisor({
    home,
    argv: [process.execPath, writeCli(home), "--profile", "spaces-hub"],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    payloadRoot: writePayload(tempDir("dsh-wb-stale-pkg-")),
    toolsRoot: tempDir("dsh-wb-stale-tools-"),
    allowColdStart: true,
    allowRealHome: false,
    timeoutMs: 500,
    pack: stubPack,
    spawn: () => {
      spawned += 1;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(spawned, 0);
  const kept = readFileSync(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), "utf8");
  assert.ok(kept.includes("127.0.0.1:9"));
});

test("returnTarget mints a one-time /bootstrap path and cookie exchange 303s to /", async () => {
  const home = tempDir("dsh-wb-handoff-");
  writeProfile(home, "notes");
  const bearer = "E".repeat(32);
  const fixture = await startFixture({ bearer });
  writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), {
    origin: fixture.origin,
    bearer,
  });
  try {
    const runtime = new WorkbenchHostRuntime({
      ...identityInput(home, "notes"),
      fetch: (input, init) => fetch(input, init),
    });
    const target = await runtime.returnTarget();
    assert.equal(target.available, true);
    assert.equal(target.origin, fixture.origin);
    assert.equal(target.path?.startsWith("/bootstrap/"), true);
    assert.equal(JSON.stringify(target).includes(bearer), false);
    const href = isTrustedLoopbackHref(target.origin!, target.path!);
    assert.ok(href);
    const response = await fetch(href, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.match(String(response.headers.get("set-cookie")), /HttpOnly/);
    const minted = await mintSupervisorHandoff((input, init) => fetch(input, init), {
      origin: fixture.origin,
      bearer,
    });
    assert.equal(minted.startsWith("/bootstrap/"), true);
  } finally {
    await fixture.close();
  }
});

test("snapshotRoot inside replaced Home entries is rejected", () => {
  const home = tempDir("dsh-wb-snap-");
  mkdirSync(join(home, "profiles"), { recursive: true });
  mkdirSync(join(home, "hub"), { recursive: true });
  assert.equal(validateSnapshotRoot(home, join(home, "profiles", "notes")), null);
  assert.equal(validateSnapshotRoot(home, join(home, "hub")), null);
  const outside = tempDir("dsh-wb-snap-out-");
  assert.equal(validateSnapshotRoot(home, outside), outside);
});

test("initialize rejects unknown CLI before manager allocation or startup", async () => {
  const home = tempDir("dsh-init-unknown-");
  writeProfile(home, "web");
  const bin = writeCli(home, "0.1.5-rc.3");
  let attempts = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "web", { argv: [process.execPath, bin, "--profile", "web"] }),
    bootstrap: async () => { attempts++; return { connected: false, reasons: ["not run"] }; },
  });
  const result = await runtime.initialize();
  assert.equal(result.ok, false);
  assert.equal(attempts, 0);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE)), false);
});

test("initialize refuses a desktop lease without an endpoint and preserves owner bytes", async () => {
  const home = tempDir("dsh-init-desktop-");
  writeProfile(home, "web");
  const ownerFile = join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE);
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, nonce: "b".repeat(32), startedAt: new Date().toISOString(), kind: "desktop" });
  writeFileSync(ownerFile, owner);
  let attempts = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "web"),
    bootstrap: async () => { attempts++; return { connected: false, reasons: ["not run"] }; },
  });
  const result = await runtime.initialize();
  assert.equal(result.ok, false);
  assert.equal(attempts, 0);
  assert.equal(readFileSync(ownerFile, "utf8"), owner);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE)), false);
});

test("initialize rechecks identity damage that appears after the page loads", async () => {
  const home = tempDir("dsh-init-damaged-");
  writeProfile(home, "web");
  let attempts = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "web"),
    bootstrap: async () => { attempts++; return { connected: false, reasons: ["not run"] }; },
  });
  assert.equal(runtime.identity.recoveryRequired, false);
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), "{broken");
  const result = await runtime.initialize();
  assert.equal(result.recoveryRequired, true);
  assert.equal(attempts, 0);
  assert.equal(readFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), "utf8"), "{broken");
});

for (const version of ["0.1.5-rc.1", "0.1.5-rc.2"]) {
  test(version + " initialize shares startup but gives each browser a distinct single-use handoff", async () => {
    const home = tempDir("dsh-init-concurrent-");
    writeProfile(home, "web");
    const bin = writeCli(home, version);
    const fixture = await startFixture({ bearer: "G".repeat(32) });
    const endpoint = { origin: fixture.origin, bearer: "G".repeat(32) };
    let starts = 0;
    const options = {
      ...identityInput(home, "web", { argv: [process.execPath, bin, "--profile", "web"] }),
      bootstrap: async () => {
        starts++;
        await new Promise(resolve => setTimeout(resolve, 10));
        writeManager(home, "spaces-hub");
        writeProfile(home, "spaces-hub");
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
        return { connected: true as const, origin: fixture.origin, endpoint, payloadDir: home, toolsDir: home };
      },
    };
    try {
      const first = new WorkbenchHostRuntime(options);
      const second = new WorkbenchHostRuntime(options);
      const results = await Promise.all([first.initialize(), second.initialize()]);
      assert.equal(starts, 1);
      assert.ok(results.every(r => r.ok && r.managerId === "spaces-hub"));
      assert.notEqual(results[0].path, results[1].path);
      for (const result of results) {
        const href = result.origin! + result.path!;
        const accepted = await fetch(href, { redirect: "manual" }); await accepted.body?.cancel();
        assert.equal(accepted.status, 303);
        const replayed = await fetch(href, { redirect: "manual" }); await replayed.body?.cancel();
        assert.equal(replayed.status, 401);
      }
      assert.equal(first.shouldRegisterManager, false);
      assert.equal(second.shouldRegisterManager, false);
    } finally { await fixture.close(); }
  });
}

test("removing a loaded ordinary profile never turns a query into a cold start", async () => {
  const home = tempDir("dsh-init-removed-");
  writeProfile(home, "web");
  let coldStarts = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "web"),
    bootstrap: async options => {
      if (options.allowColdStart) coldStarts++;
      return { connected: false, reasons: ["no workbench"] };
    },
  });
  const target = join(home, "profiles", "web");
  assert.ok(target.startsWith(home));
  rmSync(target, { recursive: true, force: true });
  assert.equal(runtime.identity.role, "uninitialized");
  await runtime.bootstrap();
  await runtime.returnTarget();
  assert.equal((await runtime.initialize()).ok, false);
  assert.equal(coldStarts, 0);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE)), false);
});
