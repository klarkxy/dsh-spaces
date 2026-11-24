import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import {
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_MANAGER_FILE,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
  HomeLease,
  type HomeControlHandle,
} from "../../src/adapters/node/home/home-lease.ts";
import { canonicalHome, HomeOperationLock } from "../../src/adapters/node/home/home-operation-lock.ts";
import { deriveServiceEpoch, digestHomeIdentity } from "../../src/adapters/node/server/workbench-protocol.ts";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import { resolveHostIdentity } from "../../packages/plugin/src/host/identity.ts";
import { SpacesPlugin, injectHintScript } from "../../packages/plugin/src/host/plugin.ts";
import { WorkbenchHostRuntime } from "../../packages/plugin/src/host/runtime.ts";
import { createWorkbenchHttpClient, mintSupervisorHandoff } from "../../packages/plugin/src/host/workbench-http.ts";
import { describeSupervisorFacts } from "../../packages/plugin/src/host/supervisor-attach.ts";
import { diagnosticLogDirectory } from "../../src/adapters/node/diagnostics/rotating-log.ts";
import { validateSnapshotRoot } from "../../packages/plugin/src/host/supervisor-pack.ts";
import {
  COMPONENT_PAYLOAD_ARGV_FLAG,
  SUPERVISOR_CLI_FLAGS,
  SUPERVISOR_ENDPOINT_FILE,
  bootstrapSupervisor,
  writeEndpointFile,
} from "../../packages/plugin/src/host/supervisor-bootstrap.ts";
import { writeComponentPayloadManifest, validateComponentPayload, COMPONENT_PAYLOAD_PACKAGES } from "../../src/adapters/node/payload/component-payload.ts";
import {
  readSelectedComponentPayload,
  selectComponentPayload,
  stageComponentPayload,
  coldStartLockLabel,
} from "../../src/adapters/node/payload/component-selection.ts";
import { catalogIdSchema, workbenchCommandSchema, workbenchInitializeResultSchema, workbenchViewSchema, workbenchPlanRequestSchema } from "../../packages/plugin/src/host/workbench-schemas.ts";
import { TYPERT } from "../../packages/plugin/src/typert.host.ts";
import {
  createWorkbenchGuideRemote,
  createWorkbenchRemote,
  displayWorkbenchMessage,
  isTrustedLoopbackHref,
  readHostHint,
  WorkbenchRemoteError,
} from "../../packages/plugin/src/client/workbench-remote.ts";
import {
  WORKBENCH_PUBLIC_ERROR as HOST_WORKBENCH_PUBLIC_ERROR,
  WORKBENCH_REMOTE_CODES as HOST_WORKBENCH_REMOTE_CODES,
} from "../../packages/plugin/src/host/remote-errors.ts";
import {
  KNOWN_WORKBENCH_ERROR_CODES,
  LLM_PUBLIC_ERROR,
  SPACES_PUBLIC_ERROR,
  WORKBENCH_PUBLIC_ERROR,
  WORKBENCH_REMOTE_CODES,
} from "../../src/shared/workbench-errors.ts";
import { apply as applyClient, GuidePanelView, ReturnToWorkbenchPanel } from "../../packages/plugin/src/client/index.tsx";
import { homeViewUrl, isHomeView } from "../../packages/plugin/src/client/home-view.ts";
import { GUIDE_COPY } from "../../packages/plugin/src/client/i18n.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { apply as applyViewHost, parseViewEnv } from "../../packages/view-bridge/src/index.ts";
import { startViewBridge, type BootWatch } from "../../packages/view-bridge/src/client.ts";
import { PARENT_PING_SOURCE, acceptParentMessage, postViewState } from "../../packages/view-bridge/src/handshake.ts";

const temps: string[] = [];
const contexts: Context[] = [];
const handles: HomeControlHandle[] = [];
const HEX64_A = "ab".repeat(32);
const HEX64_B = "cd".repeat(32);
const STATE_SINCE = "2026-09-20T00:00:00.000Z";

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      handle.release();
    } catch {
      /* test isolation */
    }
  }
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

function writeRel(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function writePayload(pluginRoot: string, marker = "payload"): string {
  const pkg = (name: string) => `${JSON.stringify({ name, version: "0.2.0" })}\n`;
  const files: Array<[string, string]> = [
    ["package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["manager-plugin"])],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["lib/index.js", `export const marker = ${JSON.stringify(marker)};\n`],
    ["lib/typert.host.js", "export {};\n"],
    ["lib/typert.remote-client.js", "export {};\n"],
    ["lib/client.js", "export {};\n"],
    ["lib/supervisor/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.supervisor)],
    ["lib/supervisor/index.js", "export {};\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export {};\n"],
    ["lib/view-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["view-bridge"])],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/lib/index.js", "export {};\n"],
    ["lib/view-bridge/lib/client.js", "export {};\n"],
    ["lib/view-bridge/lib/settings.js", "export {};\n"],
    ["lib/view-bridge/lib/typert.host.js", "export {};\n"],
    ["lib/browser/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.browser)],
    ["lib/browser/cordis.patch.yml", "browser: dummy\n"],
    ["lib/browser/lib/index.js", "export {};\n"],
    ["lib/browser/lib/client.js", "export {};\n"],
    ["lib/browser/lib/typert.host.js", "export {};\n"],
    ["lib/space-control.js", "export {};\n"],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/package.json", `${JSON.stringify({ name: "playwright-core", version: "1.62.1" })}\n`],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/index.mjs", "export {};\n"],
    ["lib/supervisor/ui-engine/node_modules/playwright-core/index.js", "module.exports = {};\n"],
  ];
  for (const [rel, content] of files) writeRel(pluginRoot, rel, content);
  writeComponentPayloadManifest(join(pluginRoot, "lib"));
  return join(pluginRoot, "lib");
}

async function stubPack(request: { packageRoot: string; destination: string }): Promise<string> {
  mkdirSync(request.destination, { recursive: true });
  const name = request.packageRoot.includes("view-bridge") ? "view-bridge-0.2.0.tgz" : "plugin-0.2.0.tgz";
  const path = join(request.destination, name);
  writeFileSync(path, "tarball");
  return path;
}

function v2State(epoch: string) {
  return {
    protocolVersion: 2 as const,
    serviceEpoch: epoch,
    revision: HEX64_B,
    availability: "ready" as const,
    role: "manager" as const,
    managerId: "spaces-hub",
    owner: { kind: "web" as const, since: STATE_SINCE },
    writable: true,
    mode: "verified-full" as const,
    dshVersion: "0.1.5-rc.1",
    maintenance: false,
    reasons: [],
    spaces: [
      {
        id: "spaces-hub",
        displayName: "Manager",
        isHost: true,
        hasWebApp: true,
        icon: "",
        status: "running",
        generation: 1,
        managed: true,
        dshVersion: null, startWithDesktop: false,
      },
    ],
    jobs: [],
  };
}

function v2Endpoint(home: string, origin: string, bearer: string, nonce: string) {
  return {
    origin,
    bearer,
    protocolVersion: 2 as const,
    homeId: digestHomeIdentity(canonicalHome(home, { allowRealHome: false })),
    serviceEpoch: deriveServiceEpoch(nonce),
  };
}

function leaseWeb(home: string, origin: string): HomeControlHandle {
  const handle = new HomeLease(home, { allowRealHome: false }).acquire("web", `${origin}/`);
  handles.push(handle);
  return handle;
}

function startFixture(options: {
  bearer: string;
  originOut?: { value: string };
  handoff?: string;
  epochRef?: { value: string };
}): Promise<{ origin: string; close: () => Promise<void>; tokens: string[] }> {
  const tokens: string[] = [];
  const server = createServer((req, res) => {
    // Each fixture owns a fresh listener, even if Windows reuses its loopback port.
    // Do not let the shared fetch pool carry a socket into the next fixture.
    res.setHeader("connection", "close");
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
          value: v2State(options.epochRef?.value || HEX64_A),
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
  assert.deepEqual(methodsOf(plugin.guide), ["previewServiceRestart", "previewServiceStop", "stopService", "restartService", "role", "spaceAction", "spaceActivity", "presentationSnapshot", "bootstrap", "returnTarget", "portalTarget", "initialize", "beginDesktopLaunch", "desktopLaunchState", "reportClientFailure"]);
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
  assert.deepEqual(methodsOf(plugin.guide), ["previewServiceRestart", "previewServiceStop", "stopService", "restartService", "role", "spaceAction", "spaceActivity", "presentationSnapshot", "bootstrap", "returnTarget", "portalTarget", "initialize", "beginDesktopLaunch", "desktopLaunchState", "reportClientFailure"]);
  assert.ok(methodsOf(plugin.manager!).includes("state"));
  assert.ok(methodsOf(plugin.manager!).includes("submit"));
  assert.ok(methodsOf(plugin.manager!).includes("product"));
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
  assert.equal(result.unavailable, true);
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
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const spawned: string[][] = [];
  const packedRoots: string[] = [];
  let spawnEntry = "";
  try {
    const result = await bootstrapSupervisor({
      home,
      argv: [process.execPath, bin, "--profile", "web"],
      env: { ...process.env, DSH_HOME: home },
      execPath: process.execPath,
      payloadRoot,
      toolsRoot,
      allowColdStart: true,
      allowRealHome: false,
      timeoutMs: 3_000,
      pollMs: 20,
      pack: async (request) => {
        packedRoots.push(request.packageRoot);
        return stubPack(request);
      },
      fetch: (input, init) => fetch(input, init),
      spawn: (request) => {
        spawned.push([...request.argv]);
        spawnEntry = request.entry;
        const handle = leaseWeb(home, fixture.origin);
        epochRef.value = deriveServiceEpoch(handle.owner.nonce);
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
      },
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
    if (!result.connected) return;
    assert.equal(result.origin, fixture.origin);
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.pluginArtifact));
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.viewBridgeArtifact));
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.controlToolRoot));
    assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.snapshotWorker));
    assert.ok(spawned[0]?.includes(COMPONENT_PAYLOAD_ARGV_FLAG));
    assert.ok(spawned[0]?.includes(toolsRoot));
    assert.match(spawnEntry.replaceAll("\\", "/"), /lib\/supervisor\/index\.js$/);
    assert.ok(spawned[0]?.some((row) => /snapshot-worker\.mjs$/.test(row.replaceAll("\\", "/"))));
    assert.ok(spawned[0]?.some((row) => /[/\\]lib$/.test(row) || row.replaceAll("\\", "/").endsWith("/lib")));
    assert.ok(packedRoots.some((root) => root.replaceAll("\\", "/").includes("/components/")));
    assert.ok(packedRoots.some((root) => root.replaceAll("\\", "/").includes("view-bridge")));
    const selected = readSelectedComponentPayload(home, toolsRoot);
    assert.ok(selected);
    assert.equal(result.payloadDir, selected?.payloadRootLib);
    assert.equal(JSON.stringify({ origin: result.origin }).includes(bearer), false);
  } finally {
    await fixture.close();
  }
});

test("two bootstrap callers serialize preparation and connect to the same single owner", async () => {
  const home = tempDir("dsh-wb-concurrent-");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-concurrent-payload-"));
  const toolsRoot = tempDir("dsh-wb-concurrent-tools-");
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  let spawns = 0;
  let packs = 0;
  const options = {
    home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
    allowRealHome: false, timeoutMs: 3_000, pollMs: 10,
    pack: async (request: { packageRoot: string; destination: string }) => { packs++; return stubPack(request); },
    spawn: () => {
      spawns++;
      const handle = leaseWeb(home, fixture.origin);
      epochRef.value = deriveServiceEpoch(handle.owner.nonce);
      writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
    },
  };
  try {
    const results = await Promise.all([bootstrapSupervisor(options), bootstrapSupervisor(options)]);
    for (const result of results) assert.equal(result.connected, true, JSON.stringify(result));
    assert.equal(spawns, 1);
    assert.equal(packs, 3);
    assert.equal(new HomeOperationLock(toolsRoot).inspect().held, false);
  } finally {
    await fixture.close();
  }
});

test("an actual early child exit is reported promptly with exit code and no second spawn", async () => {
  const home = tempDir("dsh-wb-early-exit-");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-exit-payload-"));
  const toolsRoot = tempDir("dsh-wb-exit-tools-" );
  let spawns = 0;
  const before = Date.now();
  const result = await bootstrapSupervisor({
    home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
    allowRealHome: false, timeoutMs: 30_000, pollMs: 10, pack: stubPack,
    spawn: (request) => {
      spawns++;
      return spawnChild(process.execPath, ["-e", "process.exit(23)"], { env: request.env, stdio: "ignore", windowsHide: true });
    },
  });
  assert.equal(result.connected, false);
  assert.equal(spawns, 1);
  assert.ok(Date.now() - before < 10_000, "must not wait for endpoint timeout");
  assert.match(result.connected ? "" : result.reasons.join(" "), /exit code: 23/);
});

test("an opener that overlaps preparation does not start again after that preparation ends", async () => {
  const home = tempDir("dsh-wb-overlap-");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-overlap-payload-"));
  const toolsRoot = tempDir("dsh-wb-overlap-tools-");
  let ready!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  const hold = new HomeOperationLock(toolsRoot).run(coldStartLockLabel(home), async () => {
    ready();
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  await entered;
  // The previous owner is still on disk at bootstrap invocation, but its
  // release continuation runs before bootstrap resumes its first await.
  finish();
  let spawns = 0;
  let packs = 0;
  const result = await bootstrapSupervisor({
    home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
    allowRealHome: false, timeoutMs: 500, pollMs: 10,
    pack: async (request) => { packs++; return stubPack(request); },
    spawn: () => { spawns++; },
  });
  await hold;
  assert.equal(result.connected, false);
  assert.equal(spawns, 0);
  assert.equal(packs, 0);
});

test("a waiting opener reports the other startup ending without a ready supervisor", async () => {
  const home = tempDir("dsh-wb-waiter-");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-waiter-payload-"));
  const toolsRoot = tempDir("dsh-wb-waiter-tools-");
  let ready!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  const hold = new HomeOperationLock(toolsRoot).run(coldStartLockLabel(home), async () => {
    ready();
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  await entered;
  const pending = bootstrapSupervisor({
    home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
    allowRealHome: false, timeoutMs: 5_000, pollMs: 10,
    pack: stubPack,
    spawn: () => {
      throw new Error("a waiter must never start a second supervisor");
    },
  });
  finish();
  await hold;
  const result = await pending;
  assert.equal(result.connected, false);
  assert.ok(result.reasons.some((row) => /ended without a ready supervisor/i.test(row)));
});

test("bootstrap reuses a missing priorDiscovery instead of probing the entry attach again", async () => {
  const home = tempDir("dsh-wb-prior-");
  writeProfile(home, "web");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-prior-payload-"));
  const toolsRoot = tempDir("dsh-wb-prior-tools-");
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  try {
    // A healthy service exists by the time bootstrap runs; only the
    // lock-internal verification may ping it when the entry probe is skipped.
    const handle = leaseWeb(home, fixture.origin);
    epochRef.value = deriveServiceEpoch(handle.owner.nonce);
    writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
    let pings = 0;
    const trackFetch = async (input: string, init: RequestInit) => {
      if (String(input).includes("/api/workbench/state")) pings += 1;
      return fetch(input, init);
    };
    const result = await bootstrapSupervisor({
      home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
      allowRealHome: false, timeoutMs: 3_000, pollMs: 20,
      fetch: trackFetch,
      pack: stubPack,
      priorDiscovery: { missing: true },
      spawn: () => {
        throw new Error("a discovered service must not be cold-started");
      },
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
    assert.equal(pings, 1);
  } finally {
    await fixture.close();
  }
});

test("bootstrap probes the entry attach when no priorDiscovery is provided", async () => {
  const home = tempDir("dsh-wb-noprior-");
  writeProfile(home, "web");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-noprior-payload-"));
  const toolsRoot = tempDir("dsh-wb-noprior-tools-");
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  try {
    const handle = leaseWeb(home, fixture.origin);
    epochRef.value = deriveServiceEpoch(handle.owner.nonce);
    writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
    let pings = 0;
    const trackFetch = async (input: string, init: RequestInit) => {
      if (String(input).includes("/api/workbench/state")) pings += 1;
      return fetch(input, init);
    };
    const result = await bootstrapSupervisor({
      home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
      allowRealHome: false, timeoutMs: 3_000, pollMs: 20,
      fetch: trackFetch,
      pack: stubPack,
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
    assert.equal(pings, 1);
  } finally {
    await fixture.close();
  }
});

test("bootstrap re-probes the entry attach when priorDiscovery is not a missing verdict", async () => {
  const home = tempDir("dsh-wb-prior-blocked-");
  writeProfile(home, "web");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-prior-blocked-payload-"));
  const toolsRoot = tempDir("dsh-wb-prior-blocked-tools-");
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  try {
    const handle = leaseWeb(home, fixture.origin);
    epochRef.value = deriveServiceEpoch(handle.owner.nonce);
    writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
    const result = await bootstrapSupervisor({
      home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
      allowRealHome: false, timeoutMs: 3_000, pollMs: 20,
      fetch: (input, init) => fetch(input, init),
      pack: stubPack,
      priorDiscovery: { blocked: true, reasons: ["stale claim from an earlier probe"] },
      spawn: () => {
        throw new Error("a discovered service must not be cold-started");
      },
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
  } finally {
    await fixture.close();
  }
});

test("bootstrap reports prepare and launch stages around a real cold start", async () => {
  const home = tempDir("dsh-wb-progress-");
  writeProfile(home, "web");
  const bin = writeCli(home);
  const payloadRoot = writePayload(tempDir("dsh-wb-progress-payload-"));
  const toolsRoot = tempDir("dsh-wb-progress-tools-");
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const stages: string[] = [];
  try {
    const result = await bootstrapSupervisor({
      home, argv: [process.execPath, bin], execPath: process.execPath, payloadRoot, toolsRoot,
      allowRealHome: false, allowColdStart: true, timeoutMs: 3_000, pollMs: 20,
      fetch: (input, init) => fetch(input, init),
      pack: stubPack,
      progress: (stage) => stages.push(stage),
      spawn: () => {
        const handle = leaseWeb(home, fixture.origin);
        epochRef.value = deriveServiceEpoch(handle.owner.nonce);
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
      },
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
    assert.deepEqual(stages, ["prepare", "launch"]);
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

test("v1 supervisor manifest is not a successful payload", async () => {
  const home = tempDir("dsh-wb-v1-payload-");
  writeProfile(home, "web");
  const pluginRoot = tempDir("dsh-wb-v1-pkg-");
  mkdirSync(join(pluginRoot, "lib", "supervisor"), { recursive: true });
  writeFileSync(join(pluginRoot, "package.json"), `${JSON.stringify({ name: "dsh-spaces", version: "0.2.0" })}\n`);
  writeFileSync(join(pluginRoot, "lib", "supervisor", "manifest.json"), `${JSON.stringify({ version: "0.2.0", entry: "index.js" })}\n`);
  writeFileSync(join(pluginRoot, "lib", "supervisor", "index.js"), "export {};\n");
  writeFileSync(join(pluginRoot, "lib", "supervisor", "snapshot-worker.mjs"), "export {};\n");
  let spawned = 0;
  const result = await bootstrapSupervisor({
    home,
    argv: [process.execPath, writeCli(home), "--profile", "web"],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    payloadRoot: join(pluginRoot, "lib"),
    toolsRoot: tempDir("dsh-wb-v1-tools-"),
    allowColdStart: true,
    timeoutMs: 200,
    pack: stubPack,
    spawn: () => {
      spawned += 1;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(spawned, 0);
  assert.ok(result.reasons.some((row) => /schemaVersion|staged|payload/i.test(row)));
});

test("a selected payload with a different digest is replaced by the bundled payload", async () => {
  const home = tempDir("dsh-wb-selected-");
  writeProfile(home, "web");
  const toolsRoot = tempDir("dsh-wb-selected-tools-");
  const firstLib = writePayload(tempDir("dsh-wb-selected-first-"), "first");
  const staged = stageComponentPayload(home, toolsRoot, firstLib);
  const selected = await new HomeOperationLock(toolsRoot).run(coldStartLockLabel(home), async () => selectComponentPayload(home, toolsRoot, staged.digest));
  const bundled = writePayload(tempDir("dsh-wb-selected-bundled-"), "bundled");
  const bundledDigest = validateComponentPayload(bundled).digest;
  assert.notEqual(staged.digest, bundledDigest);
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const spawned: string[][] = [];
  try {
    const result = await bootstrapSupervisor({
      home,
      argv: [process.execPath, writeCli(home), "--profile", "web"],
      env: { ...process.env, DSH_HOME: home },
      execPath: process.execPath,
      payloadRoot: bundled,
      toolsRoot,
      allowColdStart: true,
      timeoutMs: 3_000,
      pollMs: 20,
      pack: stubPack,
      fetch: (input, init) => fetch(input, init),
      spawn: (request) => {
        spawned.push([...request.argv]);
        const handle = leaseWeb(home, fixture.origin);
        epochRef.value = deriveServiceEpoch(handle.owner.nonce);
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
      },
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
    const again = readSelectedComponentPayload(home, toolsRoot);
    assert.ok(again);
    assert.equal(again.digest, bundledDigest);
    assert.ok(spawned[0]?.includes(again.payloadRootLib));
    assert.equal(result.connected && result.payloadDir, again.payloadRootLib);
    assert.ok(existsSync(join(toolsRoot, "components", selected.digest)));
  } finally {
    await fixture.close();
  }
});

test("a selected payload matching the bundled digest launches without restaging", async () => {
  const home = tempDir("dsh-wb-same-");
  writeProfile(home, "web");
  const toolsRoot = tempDir("dsh-wb-same-tools-");
  const bundled = writePayload(tempDir("dsh-wb-same-payload-"), "bundled");
  const staged = stageComponentPayload(home, toolsRoot, bundled);
  const selected = await new HomeOperationLock(toolsRoot).run(coldStartLockLabel(home), async () => selectComponentPayload(home, toolsRoot, staged.digest));
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const spawned: string[][] = [];
  const packedRoots: string[] = [];
  try {
    const result = await bootstrapSupervisor({
      home,
      argv: [process.execPath, writeCli(home), "--profile", "web"],
      env: { ...process.env, DSH_HOME: home },
      execPath: process.execPath,
      payloadRoot: bundled,
      toolsRoot,
      allowColdStart: true,
      timeoutMs: 3_000,
      pollMs: 20,
      pack: async (request) => { packedRoots.push(request.packageRoot); return stubPack(request); },
      fetch: (input, init) => fetch(input, init),
      spawn: (request) => {
        spawned.push([...request.argv]);
        const handle = leaseWeb(home, fixture.origin);
        epochRef.value = deriveServiceEpoch(handle.owner.nonce);
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
      },
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
    assert.ok(packedRoots.includes(selected.packageRoot));
    assert.ok(spawned[0]?.includes(selected.payloadRootLib));
    assert.deepEqual(readdirSync(join(toolsRoot, "components")), [selected.digest]);
    assert.equal(readSelectedComponentPayload(home, toolsRoot)?.digest, selected.digest);
  } finally {
    await fixture.close();
  }
});

test("a well-formed pointer to a payload that fails validation is replaced by the bundled payload", async () => {
  const home = tempDir("dsh-wb-stale-");
  writeProfile(home, "web");
  const toolsRoot = tempDir("dsh-wb-stale-tools-");
  const firstLib = writePayload(tempDir("dsh-wb-stale-first-"), "first");
  const staged = stageComponentPayload(home, toolsRoot, firstLib);
  await new HomeOperationLock(toolsRoot).run(coldStartLockLabel(home), async () => selectComponentPayload(home, toolsRoot, staged.digest));
  rmSync(join(toolsRoot, "components", staged.digest, "lib", "supervisor", "index.js"));
  const bundled = writePayload(tempDir("dsh-wb-stale-bundled-"), "bundled");
  const bundledDigest = validateComponentPayload(bundled).digest;
  const bearer = "B".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const spawned: string[][] = [];
  try {
    const result = await bootstrapSupervisor({
      home,
      argv: [process.execPath, writeCli(home), "--profile", "web"],
      env: { ...process.env, DSH_HOME: home },
      execPath: process.execPath,
      payloadRoot: bundled,
      toolsRoot,
      allowColdStart: true,
      timeoutMs: 3_000,
      pollMs: 20,
      pack: stubPack,
      fetch: (input, init) => fetch(input, init),
      spawn: (request) => {
        spawned.push([...request.argv]);
        const handle = leaseWeb(home, fixture.origin);
        epochRef.value = deriveServiceEpoch(handle.owner.nonce);
        writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
      },
    });
    assert.equal(result.connected, true, result.connected ? "" : result.reasons.join(" | "));
    const again = readSelectedComponentPayload(home, toolsRoot);
    assert.ok(again);
    assert.equal(again.digest, bundledDigest);
    assert.ok(spawned[0]?.includes(again.payloadRootLib));
    assert.ok(existsSync(join(toolsRoot, "components", staged.digest)));
  } finally {
    await fixture.close();
  }
});

test("invalid selected pointer fails closed without falling back to bundled payload", async () => {
  const home = tempDir("dsh-wb-bad-pointer-");
  writeProfile(home, "web");
  const toolsRoot = tempDir("dsh-wb-bad-pointer-tools-");
  const homeDigest = digestHomeIdentity(canonicalHome(home, { allowRealHome: false }));
  const pointer = join(toolsRoot, `selected-${homeDigest}.json`);
  writeFileSync(pointer, "{not-json");
  const original = readFileSync(pointer, "utf8");
  let spawned = 0;
  const result = await bootstrapSupervisor({
    home,
    argv: [process.execPath, writeCli(home), "--profile", "web"],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    payloadRoot: writePayload(tempDir("dsh-wb-bad-pointer-pkg-")),
    toolsRoot,
    allowColdStart: true,
    timeoutMs: 200,
    pack: stubPack,
    spawn: () => {
      spawned += 1;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(spawned, 0);
  assert.ok(result.reasons.some((row) => /pointer is invalid/i.test(row)));
  assert.equal(readFileSync(pointer, "utf8"), original);
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
        res.end(JSON.stringify({ ok: true, value: v2State(HEX64_A) }));
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
    const api = createWorkbenchHttpClient({
      endpoint: {
        origin,
        bearer,
        protocolVersion: 2,
        homeId: HEX64_A,
        serviceEpoch: HEX64_A,
      },
    });
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
      serviceEpoch: HEX64_A,
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
    serviceEpoch: HEX64_A,
    spaceId: "notes",
    generation: 1,
    origin: "http://127.0.0.1:10",
    entryOrigin: "http://127.0.0.1:9",
    entryPath: "/embed/notes",
    channel: "c1",
  });
  assert.equal(ok.success, true);
  assert.equal(workbenchCommandSchema.safeParse({ kind: "recovery.resume" }).success, false);
  assert.equal(workbenchCommandSchema.safeParse({ kind: "controller.acquire" }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "snapshot.restore", snapshotId: "snap-1" }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "controller.release" }).success, false);
  assert.equal(workbenchPlanRequestSchema.safeParse({ kind: "service.shutdown" }).success, true);
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
  assert.equal(readHostHint({ __DSH_SPACES_HOST__: { role: "manager", unavailable: false } })?.role, "manager");
  assert.equal(readHostHint({ __DSH_SPACES_HOST__: { role: "root", unavailable: false } }), null);
  const html = injectHintScript("<head></head>", JSON.stringify({ role: "workspace", unavailable: false }));
  assert.match(html, /__DSH_SPACES_HOST__/);
});

test("known public workbench codes round-trip a redacted reason; unknown errors stay generic", async () => {
  const known: Record<string, string> = {
    ...WORKBENCH_PUBLIC_ERROR,
    ...SPACES_PUBLIC_ERROR,
    ...LLM_PUBLIC_ERROR,
  };
  assert.equal(HOST_WORKBENCH_PUBLIC_ERROR, WORKBENCH_PUBLIC_ERROR);
  assert.equal(HOST_WORKBENCH_REMOTE_CODES, WORKBENCH_REMOTE_CODES);
  assert.deepEqual([...KNOWN_WORKBENCH_ERROR_CODES].sort(), Object.keys(known).sort());
  const sensitive = "C:\\\\Users\\\\admin\\\\.dsh token=live-secret Bearer abcdefghijkl";
  const rejectKnown = async (code: string, message: string, check: (error: WorkbenchRemoteError) => void) => {
    const remote = createWorkbenchRemote({
      rpc: { call: async () => ({ ok: false as const, error: { code, message, details: { token: "live-secret" } } }) },
    });
    await assert.rejects(() => remote.view("notes"), (error: unknown) => {
      assert.ok(error instanceof WorkbenchRemoteError);
      check(error);
      assert.equal(error.message.includes("Try again later"), false);
      assert.equal(error.message.includes(".dsh"), false);
      assert.equal(error.message.includes("live-secret"), false);
      assert.equal(error.message.includes("abcdefghijkl"), false);
      return true;
    });
  };
  for (const code of KNOWN_WORKBENCH_ERROR_CODES) {
    await rejectKnown(code, `bound version mismatch ${sensitive}`, (error) => {
      assert.equal(error.code, code);
      assert.match(error.message, /bound version mismatch/);
      assert.match(error.message, /\[path\]/);
      assert.match(error.message, /token=\[redacted\]/);
      assert.match(error.message, /Bearer \[redacted\]/);
      assert.equal(displayWorkbenchMessage(error), error.message);
    });
    await rejectKnown(code, code, (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, known[code]);
    });
  }
  await rejectKnown("workbench/incompatible", "{\"role\":\"user\",\"content\":\"private-chat\"}", (error) => {
    assert.equal(error.code, "workbench/incompatible");
    assert.equal(error.message, known["workbench/incompatible"]);
    assert.equal(error.message.includes("private-chat"), false);
  });
  await rejectKnown("workbench/failed", "", (error) => {
    assert.equal(error.code, "workbench/failed");
    assert.equal(error.message, known["workbench/failed"]);
  });
  await rejectKnown("constructor", sensitive, (error) => {
    assert.equal(error.code, null);
    assert.equal(error.message, "The workbench request failed.");
  });
  const unknown = createWorkbenchRemote({
    rpc: {
      call: async () => ({
        ok: false as const,
        error: { code: "internal", message: sensitive, details: { authorization: "Bearer abcdefghijkl" } },
      }),
    },
  });
  await assert.rejects(() => unknown.view("notes"), (error: unknown) => {
    assert.ok(error instanceof WorkbenchRemoteError);
    assert.equal(error.code, null);
    assert.equal(error.message, "The workbench request failed.");
    assert.equal(error.message.includes(".dsh"), false);
    assert.equal(error.message.includes("live-secret"), false);
    assert.equal(error.message.includes("abcdefghijkl"), false);
    return true;
  });
  const thrown = createWorkbenchGuideRemote({
    rpc: { call: async () => { throw new Error(sensitive); } },
  });
  await assert.rejects(() => thrown.role(), (error: unknown) => {
    assert.ok(error instanceof WorkbenchRemoteError);
    assert.equal(error.code, null);
    assert.equal(error.message, "The workbench request failed.");
    assert.equal(error.message.includes(".dsh"), false);
    assert.equal(error.message.includes("live-secret"), false);
    assert.equal(error.message.includes("abcdefghijkl"), false);
    return true;
  });
});

test("client apply keeps root ownership and adds a portable overlay for non-manager hosts", () => {
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
  assert.ok(registrations.some((row) => row.name === "shell.overlay" && row.id === "dsh-spaces-host-shell"));
  assert.ok(registrations.some((row) => row.name === "sidebar.panellist" && row.id === "dsh-spaces"));
  assert.ok(registrations.some((row) => row.name === "main" && row.key === "dsh-spaces"));
  assert.equal(typeof ReturnToWorkbenchPanel, "function");
  assert.equal(typeof GuidePanelView, "function");

  registrations.length = 0;
  (globalThis as { __DSH_SPACES_HOST__?: unknown }).__DSH_SPACES_HOST__ = { role: "manager", unavailable: false };
  try {
    applyClient(ctx as never);
    assert.ok(registrations.some((row) => row.name === "root"));
    assert.equal(registrations.some((row) => row.name === "sidebar.panellist"), false);
  } finally {
    delete (globalThis as { __DSH_SPACES_HOST__?: unknown }).__DSH_SPACES_HOST__;
  }
});

test("guide error cards are details-only; initialize is only first healthy startup", () => {
  const en = GUIDE_COPY.en;
  const render = (mode: Parameters<typeof GuidePanelView>[0]["mode"], error: string | null = null) =>
    renderToStaticMarkup(
      createElement(GuidePanelView, {
        locale: "en",
        mode,
        error,
        status: null,
        busy: null,
      }),
    );
  const noRecoveryActions = (html: string) => {
    assert.equal(html.includes("Retry"), false);
    assert.equal(html.includes(en.startAction), false);
    assert.equal(html.includes('data-dsh-spaces-action="initialize"'), false);
    assert.equal(html.includes('data-dsh-spaces-action="enter"'), false);
    assert.equal(html.includes('data-dsh-spaces-copy="details"'), true);
    assert.match(html, /role="alert"/);
  };

  const blocked = render("blocked", "Manager identity is damaged or ambiguous and cannot be guessed.");
  assert.match(blocked, /data-dsh-spaces-guide="blocked"/);
  assert.equal(blocked.includes(en.blockedTitle), true);
  noRecoveryActions(blocked);

  const roleFailed = render("failed", "C:\\\\Users\\\\admin\\\\.dsh token");
  assert.match(roleFailed, /data-dsh-spaces-guide="failed"/);
  assert.equal(roleFailed.includes("[path]"), true);
  assert.equal(roleFailed.includes("C:\\\\Users"), false);
  noRecoveryActions(roleFailed);

  const initFailed = render("init-failed", "The bound DSH CLI could not be validated from the current process.");
  assert.match(initFailed, /data-dsh-spaces-guide="init-failed"/);
  noRecoveryActions(initFailed);

  const enterFailed = render("enter-failed", "The workbench entry is not available yet.");
  assert.match(enterFailed, /data-dsh-spaces-guide="enter-failed"/);
  assert.equal(enterFailed.includes(en.enterBody), true);
  assert.equal(enterFailed.includes(en.startAction), true);
  assert.equal(enterFailed.includes('data-dsh-spaces-action="initialize"'), true);
  assert.equal(enterFailed.includes("Retry"), false);
  assert.equal(enterFailed.includes('data-dsh-spaces-action="enter"'), false);
  assert.equal(enterFailed.includes('data-dsh-spaces-copy="details"'), true);

  const firstInit = render("init");
  assert.match(firstInit, /data-dsh-spaces-guide="init"/);
  assert.equal(firstInit.includes('data-dsh-spaces-action="initialize"'), true);
  assert.equal(firstInit.includes(en.initAction), true);
  assert.equal(firstInit.includes("Retry"), false);
  assert.equal(firstInit.includes(en.startAction), false);
  assert.equal(firstInit.includes('data-dsh-spaces-copy="details"'), false);

  const enter = render("enter");
  assert.match(enter, /data-dsh-spaces-guide="enter"/);
  assert.equal(enter.includes('data-dsh-spaces-action="enter"'), true);
  assert.equal(enter.includes('data-dsh-spaces-action="initialize"'), false);
  assert.equal(enter.includes(en.startAction), false);
  assert.equal(enter.includes("Retry"), false);
});

test("view-bridge ignores invalid env, has no management API, and can ready again after disconnect", () => {
  const hostSrc = readFileSync(new URL("../../packages/view-bridge/src/index.ts", import.meta.url), "utf8");
  const clientSrc = readFileSync(new URL("../../packages/view-bridge/src/client.ts", import.meta.url), "utf8");
  assert.equal(hostSrc.includes("WorkbenchApi"), false);
  assert.equal(hostSrc.includes("workbench-manager"), false);
  assert.equal(clientSrc.includes("createWorkbenchRemote"), false);
  assert.equal(clientSrc.includes('name: "root"'), false);
  assert.equal(parseViewEnv({}), null);
  assert.equal(parseViewEnv({ DSH_SPACES_VIEW_PARENT_ORIGIN: "http://example.com", DSH_SPACES_VIEW_ID: "notes", DSH_SPACES_VIEW_GENERATION: "1", DSH_SPACES_VIEW_CHANNEL: "c1" }), null);
  const ctx = new Context();
  contexts.push(ctx);
  assert.equal(applyViewHost(ctx, {}, {}), null);

  assert.equal(
    parseViewEnv({
      DSH_SPACES_VIEW_PARENT_ORIGIN: "http://127.0.0.1:11",
      DSH_SPACES_VIEW_ID: "notes",
      DSH_SPACES_VIEW_GENERATION: "3",
      DSH_SPACES_VIEW_CHANNEL: "chan-1",
    }),
    null,
  );
  const view = parseViewEnv({
    DSH_SPACES_VIEW_PARENT_ORIGIN: "http://127.0.0.1:11",
    DSH_SPACES_VIEW_ID: "notes",
    DSH_SPACES_VIEW_GENERATION: "3",
    DSH_SPACES_VIEW_CHANNEL: "chan-1",
    DSH_SPACES_VIEW_SERVICE_EPOCH: HEX64_A,
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
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.data.state, "ready");
  assert.equal(posted[0]?.origin, "http://127.0.0.1:11");
  for (const observer of observers) observer();
  for (const observer of observers) observer();
  assert.equal(posted.length, 1, "repeated DOM mutations while ready do not spam parent postMessage");
  conn = "disconnected";
  for (const listener of listeners) listener();
  assert.equal(posted[1]?.data.state, "disconnected");
  conn = "connected";
  for (const listener of listeners) listener();
  assert.equal(posted[2]?.data.state, "ready");
  const ping = {
    origin: "http://127.0.0.1:11",
    source: parent,
    data: { source: PARENT_PING_SOURCE, type: "ping", serviceEpoch: HEX64_A, spaceId: "notes", generation: 3, channel: "chan-1" },
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
  const original = `${JSON.stringify({ version: 1, origin: "http://127.0.0.1:9", bearer: "D".repeat(32) })}\n`;
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), original);
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
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const handle = leaseWeb(home, fixture.origin);
  epochRef.value = deriveServiceEpoch(handle.owner.nonce);
  writeEndpointFile(
    join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE),
    v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce),
  );
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
    const minted = await mintSupervisorHandoff((input, init) => fetch(input, init), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
    assert.equal(minted.startsWith("/bootstrap/"), true);
  } finally {
    await fixture.close();
  }
});

for (const outcome of ["ready", "startup-failed", "registration-refused"] as const) {
  test(`main attachment observes manager startup before registration: ${outcome}`, async () => {
    const home = tempDir("dsh-wb-main-startup-");
    writeProfile(home, "notes");
    const bearer = "a".repeat(64), epochRef = { value: HEX64_A };
    const fixture = await startFixture({ bearer, epochRef });
    const handle = leaseWeb(home, fixture.origin);
    epochRef.value = deriveServiceEpoch(handle.owner.nonce);
    writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE),
      v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
    let reads = 0, registrations = 0;
    try {
      const runtime = new WorkbenchHostRuntime({
        ...identityInput(home, "notes"), supervisorTimeoutMs: 3000,
        connect: () => ({
          state: async () => {
            const state = v2State(epochRef.value);
            reads++;
            if (outcome === "startup-failed") {
              state.spaces[0].status = "crashed";
              return { ...state, reasons: ["manager launch failed"] };
            } else if (reads < 3) state.spaces[0].status = "starting";
            return state;
          },
          startupStatus: async () => ({
            serviceEpoch: epochRef.value,
            managerId: "spaces-hub",
            phase: "starting" as const,
            reasons: [] as string[],
            failure: null,
          }),
        }) as never,
      });
      runtime.onSupervisorAttached(async () => {
        registrations++;
        assert.ok(reads >= 3, "registration must not be sent while startup is pending");
        if (outcome === "registration-refused") throw Error("MAIN_REGISTRATION_REFUSED:404");
      });
      if (outcome === "ready") {
        const snapshot = await runtime.presentationSnapshot();
        assert.equal(snapshot.managerId, "spaces-hub");
        await runtime.presentationSnapshot();
        assert.equal(registrations, 1, "directory polling does not register again");
      } else {
        await assert.rejects(runtime.presentationSnapshot(), outcome === "startup-failed" ? /manager launch failed/ : /MAIN_REGISTRATION_REFUSED:404/);
        assert.equal(registrations, outcome === "startup-failed" ? 0 : 1);
        const count = reads;
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(reads, count, "failure stops the readiness observation");
      }
    } finally { await fixture.close(); }
  });
}

for (const firstRegistration of ["succeeded", "refused"] as const) {
  test(`explicit initialization releases the previous epoch before registering with a replaced service: ${firstRegistration}`, async () => {
    const home = tempDir("dsh-wb-main-replaced-");
    writeProfile(home, "notes");
    const bearer = "a".repeat(64), epochRef = { value: HEX64_A };
    const fixtureA = await startFixture({ bearer, epochRef });
    const handleA = leaseWeb(home, fixtureA.origin);
    epochRef.value = deriveServiceEpoch(handleA.owner.nonce);
    const endpointFile = join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
    writeEndpointFile(endpointFile, v2Endpoint(home, fixtureA.origin, bearer, handleA.owner.nonce));
    const events: string[] = [];
    const runtime = new WorkbenchHostRuntime({
      ...identityInput(home, "notes"), supervisorTimeoutMs: 3000,
      connect: () => ({
        state: async () => v2State(epochRef.value),
        startupStatus: async () => ({
          serviceEpoch: epochRef.value,
          managerId: "spaces-hub",
          phase: "ready" as const,
          reasons: [] as string[],
          failure: null,
        }),
      }) as never,
    });
    const epochA = epochRef.value;
    runtime.onSupervisorAttached(async (endpoint) => {
      events.push(`attach:${endpoint.serviceEpoch}`);
      if (firstRegistration === "refused" && !events.some(e => e === `stopped:${epochA}`)) throw Error("MAIN_REGISTRATION_REFUSED:404");
    }, async (previous) => { events.push(`stopped:${previous}`); });
    try {
      if (firstRegistration === "succeeded") {
        await runtime.presentationSnapshot();
        await runtime.presentationSnapshot();
        assert.deepEqual(events, [`attach:${epochA}`]);
      } else {
        await assert.rejects(runtime.presentationSnapshot(), /MAIN_REGISTRATION_REFUSED:404/);
      }
      await fixtureA.close();
      handleA.release();
      const fixtureB = await startFixture({ bearer, epochRef });
      const handleB = leaseWeb(home, fixtureB.origin);
      epochRef.value = deriveServiceEpoch(handleB.owner.nonce);
      writeEndpointFile(endpointFile, v2Endpoint(home, fixtureB.origin, bearer, handleB.owner.nonce));
      try {
        if (firstRegistration === "succeeded") {
          const stale = await runtime.bootstrap();
          assert.equal(stale.connected, false);
          assert.deepEqual(events, [`attach:${epochA}`]);
        }
        const result = await runtime.initialize();
        assert.equal(result.ok, true);
        assert.equal(result.connected, true);
        await runtime.presentationSnapshot();
        assert.deepEqual(events, [`attach:${epochA}`, `stopped:${epochA}`, `attach:${epochRef.value}`]);
      } finally { await fixtureB.close(); }
    } finally { await fixtureA.close().catch(() => {}); }
  });
}

test("portal entry waits for the already-running startup before minting a one-use ticket", async () => {
  const home = tempDir("dsh-wb-portal-starting-");
  writeProfile(home, "notes");
  const bearer = "P".repeat(32);
  const epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const handle = leaseWeb(home, fixture.origin);
  epochRef.value = deriveServiceEpoch(handle.owner.nonce);
  writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE),
    v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
  let reads = 0, minted = 0;
  try {
    const runtime = new WorkbenchHostRuntime({
      ...identityInput(home, "notes"), supervisorTimeoutMs: 5000,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/workbench/state") {
          const state = v2State(epochRef.value);
          if (++reads < 4) state.spaces[0].status = "starting";
          return new Response(JSON.stringify({ ok: true, value: state }), { status: 200 });
        }
        if (path === "/api/workbench/startupStatus") {
          return new Response(JSON.stringify({
            ok: true,
            value: {
              serviceEpoch: epochRef.value,
              managerId: "spaces-hub",
              phase: reads < 4 ? "starting" : "ready",
              reasons: [],
              failure: null,
            },
          }), { status: 200 });
        }
        if (path === "/internal/portal") {
          assert.ok(reads >= 4, "do not consume an entry while the manager is starting");
          minted++;
          return new Response(JSON.stringify({ path: "/portal-bootstrap/" + "t".repeat(32) }), { status: 200 });
        }
        throw new Error("unexpected startup mutation: " + path);
      },
    });
    const target = await runtime.portalTarget({ parentOrigin: "http://127.0.0.1:3090", channel: "ab".repeat(16) });
    assert.equal(target.available, true);
    assert.equal(minted, 1);
  } finally { await fixture.close(); }
});

for (const failure of ["transport", "unavailable", "epoch", "crashed", "maintenance"] as const) {
  test(`portal startup observation stops after ${failure} failure without mint or replay`, async () => {
    const home = tempDir("dsh-wb-portal-failed-");
    writeProfile(home, "notes");
    const bearer = "Q".repeat(32), epochRef = { value: HEX64_A };
    const fixture = await startFixture({ bearer, epochRef });
    const handle = leaseWeb(home, fixture.origin);
    epochRef.value = deriveServiceEpoch(handle.owner.nonce);
    writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
    let observed = 0, minted = 0;
    try {
      const runtime = new WorkbenchHostRuntime({
        ...identityInput(home, "notes"), supervisorTimeoutMs: 5000,
        fetch: async (input, init) => {
          if (String(input).includes("/internal/portal")) minted++;
          // This test varies the startup observer below, not the initial HTTP
          // discovery. Give discovery a deterministic authenticated state.
          if (String(input).endsWith("/api/workbench/state")) {
            assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${bearer}`);
            return Response.json({ ok: true, value: v2State(epochRef.value) });
          }
          throw new Error("unexpected request before a failed startup observation");
        },
        connect: () => ({ state: async () => {
          observed++;
          if (failure === "transport") throw new Error("fixture disconnected");
          const state = v2State(epochRef.value);
          return { ...state, maintenance: failure === "maintenance", jobs: failure === "maintenance" ? [{id:"failure",kind:"plan.execute",status:"failed"}] : state.jobs, reasons: ["fixture launch failed"],
            availability: failure === "unavailable" ? "unavailable" : state.availability,
            serviceEpoch: failure === "epoch" ? HEX64_B : state.serviceEpoch,
            spaces: state.spaces.map(row => ({ ...row, status: failure === "crashed" ? "crashed" : row.status })),
          };
        } }) as never,
      });
      const result = await runtime.portalTarget({ parentOrigin: "http://127.0.0.1:3090", channel: "ab".repeat(16) });
      assert.equal(result.available, false);
      assert.equal(observed, 1);
      assert.equal(minted, 0);
      if (failure !== "transport") assert.deepEqual(result.reasons, ["fixture launch failed"]);
    } finally { await fixture.close(); }
  });
}

test("snapshotRoot inside replaced Home entries is rejected", () => {
  const home = tempDir("dsh-wb-snap-");
  mkdirSync(join(home, "profiles"), { recursive: true });
  mkdirSync(join(home, "hub"), { recursive: true });
  assert.equal(validateSnapshotRoot(home, join(home, "profiles", "notes")), null);
  assert.equal(validateSnapshotRoot(home, join(home, "hub")), null);
  const outside = tempDir("dsh-wb-snap-out-");
  assert.equal(validateSnapshotRoot(home, outside), outside);
});

test("initialize rejects a CLI that cannot be bound before manager allocation or startup", async () => {
  const home = tempDir("dsh-init-unknown-");
  writeProfile(home, "web");
  const bin = writeCli(home, "latest");
  let attempts = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "web", { argv: [process.execPath, bin, "--profile", "web"] }),
    bootstrap: async () => { attempts++; return { connected: false, origin: null, reasons: ["not run"] }; },
  });
  const result = await runtime.initialize();
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, false);
  assert.equal(attempts, 0);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE)), false);
});

test("initialize refuses an owner record with an unknown kind and preserves owner bytes", async () => {
  const home = tempDir("dsh-init-desktop-");
  writeProfile(home, "web");
  const ownerFile = join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE);
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, nonce: "b".repeat(32), startedAt: new Date().toISOString(), kind: "desktop" });
  writeFileSync(ownerFile, owner);
  let attempts = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "web"),
    bootstrap: async () => { attempts++; return { connected: false, origin: null, reasons: ["not run"] }; },
  });
  const result = await runtime.initialize();
  assert.equal(result.ok, false);
  assert.equal(attempts, 0);
  assert.equal(readFileSync(ownerFile, "utf8"), owner);
  assert.equal(existsSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE)), false);
});

for (const changed of [false, true]) {
  test(`explicit initialize ${changed ? "rejects changed ownership" : "launches after a real exited owner"} using its first discovery`, async () => {
    const home = tempDir("dsh-init-exited-");
    writeProfile(home, "web");
    writeProfile(home, "spaces-hub");
    writeManager(home, "spaces-hub");
    const script = join(home, "exited-owner.mts");
    writeFileSync(script, `import { HomeLease } from ${JSON.stringify(new URL("../../src/adapters/node/home/home-lease.ts", import.meta.url).href)};
new HomeLease(process.argv[2]).acquire("web", "http://127.0.0.1:9/");
process.exit(17);`);
    await new Promise<void>((resolve, reject) => {
      const child = spawnChild(process.execPath, ["--import", "tsx", script, home], { cwd: process.cwd(), stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("exit", code => code === 17 ? resolve() : reject(new Error(`owner exited ${code}`)));
    });
    const lease = new HomeLease(home);
    const inspection = lease.inspect();
    assert.ok("owner" in inspection && inspection.liveness === "dead");
    const ownerFile = join(lease.runDir, HOME_CONTROL_OWNER_FILE);
    const endpointFile = join(lease.controlDir, SUPERVISOR_ENDPOINT_FILE);
    const originalOwner = inspection.owner;
    writeEndpointFile(endpointFile, v2Endpoint(home, "http://127.0.0.1:9", "O".repeat(32), originalOwner.nonce));
    let ownerBytes = readFileSync(ownerFile), endpointBytes = readFileSync(endpointFile);
    const epochRef = { value: HEX64_A };
    const bearer = "N".repeat(32);
    const fixture = await startFixture({ bearer, epochRef });
    let starts = 0;
    const runtime = new WorkbenchHostRuntime({
      ...identityInput(home, "web"),
      payloadRoot: writePayload(tempDir("dsh-init-exited-payload-")),
      toolsRoot: tempDir("dsh-init-exited-tools-"), supervisorTimeoutMs: 3000,
      bootstrap: async options => {
        assert.ok(options.priorDiscovery && "missing" in options.priorDiscovery);
        assert.deepEqual(options.priorDiscovery.previousOwner, originalOwner);
        if (changed) {
          const replacement = { ...originalOwner, nonce: "ef".repeat(16) };
          writeFileSync(ownerFile, JSON.stringify(replacement));
          writeEndpointFile(endpointFile, v2Endpoint(home, "http://127.0.0.1:9", "O".repeat(32), replacement.nonce));
          ownerBytes = readFileSync(ownerFile); endpointBytes = readFileSync(endpointFile);
        }
        return bootstrapSupervisor({ ...options, pack: stubPack, pollMs: 20, spawn: () => {
          starts++;
          assert.equal(lease.inspect().held, false);
          assert.equal(existsSync(endpointFile), false);
          const next = leaseWeb(home, fixture.origin);
          epochRef.value = deriveServiceEpoch(next.owner.nonce);
          writeEndpointFile(endpointFile, v2Endpoint(home, fixture.origin, bearer, next.owner.nonce));
        } });
      },
    });
    try {
      await assert.rejects(() => runtime.presentationSnapshot(), /not available/);
      assert.deepEqual(readFileSync(ownerFile), ownerBytes);
      assert.deepEqual(readFileSync(endpointFile), endpointBytes);
      assert.equal(starts, 0);
      const result = await runtime.initialize();
      assert.equal(result.ok, !changed, result.reasons.join(" | "));
      assert.equal(starts, changed ? 0 : 1);
      const evidence = join(lease.controlDir, "previous-controller-exit.json");
      if (changed) {
        assert.match(result.reasons.join(" "), /ownership changed/);
        assert.deepEqual(readFileSync(ownerFile), ownerBytes);
        assert.deepEqual(readFileSync(endpointFile), endpointBytes);
        assert.equal(existsSync(evidence), false);
      } else {
        assert.ok(result.path?.startsWith("/bootstrap/"));
        assert.match(readFileSync(evidence, "utf8"), /exited-without-releasing-lease/);
      }
    } finally { await fixture.close(); }
  });
}

test("initialize rechecks identity damage that appears after the page loads", async () => {
  const home = tempDir("dsh-init-damaged-");
  writeProfile(home, "web");
  let attempts = 0;
  const runtime = new WorkbenchHostRuntime({
    ...identityInput(home, "web"),
    bootstrap: async () => { attempts++; return { connected: false, origin: null, reasons: ["not run"] }; },
  });
  assert.equal(runtime.identity.recoveryRequired, false);
  mkdirSync(join(home, HOME_CONTROL_DIR_NAME), { recursive: true });
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), "{broken");
  const result = await runtime.initialize();
  assert.equal(result.unavailable, true);
  assert.equal(attempts, 0);
  assert.equal(readFileSync(join(home, HOME_CONTROL_DIR_NAME, HOME_CONTROL_MANAGER_FILE), "utf8"), "{broken");
});

for (const version of ["0.1.5-rc.1", "0.1.5-rc.2"]) {
  test(version + " initialize shares startup but gives each browser a distinct single-use handoff", async () => {
    const home = tempDir("dsh-init-concurrent-");
    writeProfile(home, "web");
    const bin = writeCli(home, version);
    const epochRef = { value: HEX64_A };
    const fixture = await startFixture({ bearer: "G".repeat(32), epochRef });
    let starts = 0;
    const options = {
      ...identityInput(home, "web", { argv: [process.execPath, bin, "--profile", "web"] }),
      fetch: (input: string, init?: RequestInit) => fetch(input, init),
      bootstrap: async () => {
        starts++;
        await new Promise(resolve => setTimeout(resolve, 10));
        writeManager(home, "spaces-hub");
        writeProfile(home, "spaces-hub");
        const handle = leaseWeb(home, fixture.origin);
        epochRef.value = deriveServiceEpoch(handle.owner.nonce);
        const endpoint = v2Endpoint(home, fixture.origin, "G".repeat(32), handle.owner.nonce);
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
      return { connected: false, origin: null, reasons: ["no workbench"] };
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


test("native home keeps the manager origin and skips the Spaces root registration", () => {
  const href = homeViewUrl("http://127.0.0.1:3100/?existing=1#chat");
  assert.equal(href, "http://127.0.0.1:3100/?existing=1&dsh-spaces-home=1#chat");
  assert.equal(isHomeView(href), true);
  assert.equal(isHomeView("http://127.0.0.1:3100/"), false);
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorHint = Object.getOwnPropertyDescriptor(globalThis, "__DSH_SPACES_HOST__");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href } } });
  Object.defineProperty(globalThis, "__DSH_SPACES_HOST__", { configurable: true, value: { role: "manager", unavailable: false } });
  const slots: string[] = [];
  try {
    applyClient({
      get: () => ({}),
      slots: {
        inject: (name: string, callback: () => void) => { slots.push(name); callback(); },
        register: () => () => undefined,
      },
    } as never);
    assert.deepEqual(slots, ["sidebar.brand.mark", "conversation.hero.brand.mark"]);
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (priorHint) Object.defineProperty(globalThis, "__DSH_SPACES_HOST__", priorHint);
    else Reflect.deleteProperty(globalThis, "__DSH_SPACES_HOST__");
  }
});

test("guide Remote preserves bounded maintenance failure details", async () => {
 const home=tempDir("dsh-guide-failure-reason-"); writeProfile(home,"notes");
 const runtime=new WorkbenchHostRuntime(identityInput(home,"notes"));
 runtime.presentationSnapshot=async()=>{throw new Error("EACCES lstat H:/private/file token=fixture-secret-value");};
 const plugin=new SpacesPlugin(pluginContext(),{},runtime);
 await assert.rejects(()=>plugin.guide.presentationSnapshot(),(error:unknown)=>{
  assert.match((error as Error).message,/EACCES lstat \[path\]/);
  assert.doesNotMatch((error as Error).message,/fixture-secret-value/); return true;
 });
});

test("portal Remote preserves the actual entry failure and redacts structured credentials", async () => {
  const home = tempDir("dsh-guide-portal-failure-"); writeProfile(home, "notes");
  const runtime = new WorkbenchHostRuntime(identityInput(home, "notes"));
  runtime.portalTarget = async () => { throw new Error('Selected component payload digest mismatch. {"token":"synthetic-portal-secret"}'); };
  const plugin = new SpacesPlugin(pluginContext(), {}, runtime);
  await assert.rejects(() => plugin.guide.portalTarget({ parentOrigin: "http://127.0.0.1:3090", channel: "ab".repeat(16) }), (error: unknown) => {
    assert.match((error as Error).message, /Selected component payload digest mismatch/);
    assert.doesNotMatch((error as Error).message, /synthetic-portal-secret/);
    return true;
  });
});

function directorySnapshot(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      out[relative(root, path)] = stat.mtimeMs;
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

test("describeSupervisorFacts reports read-only lease and endpoint facts without touching the Home", async () => {
  const home = tempDir("dsh-facts-");
  const readOnly = (expected: string): void => {
    const before = directorySnapshot(home);
    assert.equal(describeSupervisorFacts(home, false, null), expected);
    assert.deepEqual(directorySnapshot(home), before, "describeSupervisorFacts must be read-only");
  };
  readOnly("No controller holds the Home lease. No supervisor endpoint is recorded.");
  const handle = leaseWeb(home, "http://127.0.0.1:9");
  readOnly(`Supervisor PID ${handle.owner.pid} is alive. No supervisor endpoint is recorded.`);
  const endpoint = v2Endpoint(home, "http://127.0.0.1:9", "O".repeat(32), handle.owner.nonce);
  writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), endpoint);
  readOnly(`Supervisor PID ${handle.owner.pid} is alive. A supervisor endpoint is recorded.`);
  assert.equal(
    describeSupervisorFacts(home, false, endpoint),
    `Supervisor PID ${handle.owner.pid} is alive. The recorded endpoint is unchanged.`,
  );
  assert.equal(
    describeSupervisorFacts(home, false, { ...endpoint, serviceEpoch: "ff".repeat(32) }),
    `Supervisor PID ${handle.owner.pid} is alive. The recorded endpoint belongs to a different service epoch.`,
  );
  writeFileSync(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE), "{\n");
  readOnly(`Supervisor PID ${handle.owner.pid} is alive. The recorded supervisor endpoint is unreadable.`);
});

test("describeSupervisorFacts reports ambiguous ownership and a dead recorded owner", async () => {
  const ambiguous = tempDir("dsh-facts-ambiguous-");
  mkdirSync(join(ambiguous, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME), { recursive: true });
  assert.equal(
    describeSupervisorFacts(ambiguous, false, null),
    "Controller ownership is incomplete or ambiguous. No supervisor endpoint is recorded.",
  );

  const home = tempDir("dsh-facts-dead-");
  const script = join(home, "exited-owner.mts");
  writeFileSync(script, `import { HomeLease } from ${JSON.stringify(new URL("../../src/adapters/node/home/home-lease.ts", import.meta.url).href)};
new HomeLease(process.argv[2]).acquire("web", "http://127.0.0.1:9/");
process.exit(17);`);
  await new Promise<void>((resolve, reject) => {
    const child = spawnChild(process.execPath, ["--import", "tsx", script, home], { cwd: process.cwd(), stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 17 ? resolve() : reject(new Error(`owner exited ${code}`)));
  });
  const facts = describeSupervisorFacts(home, false, null);
  assert.match(facts, /^Supervisor PID \d+ is dead\. No supervisor endpoint is recorded\.$/);
});

test("presentationSnapshot reports the attach refusal reasons with the entry failure", async () => {
  const home = tempDir("dsh-snap-reasons-");
  writeProfile(home, "notes");
  leaseWeb(home, "http://127.0.0.1:9");
  const runtime = new WorkbenchHostRuntime({ ...identityInput(home, "notes"), supervisorTimeoutMs: 1000 });
  await assert.rejects(
    () => runtime.presentationSnapshot(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /The workbench entry is not available yet\. A controller holds the Home lease but no supervisor endpoint was found\./,
      );
      return true;
    },
  );
});

test("presentationSnapshot appends supervisor facts to a state transport failure", async () => {
  const home = tempDir("dsh-snap-facts-");
  writeProfile(home, "notes");
  const bearer = "a".repeat(64), epochRef = { value: HEX64_A };
  const fixture = await startFixture({ bearer, epochRef });
  const handle = leaseWeb(home, fixture.origin);
  epochRef.value = deriveServiceEpoch(handle.owner.nonce);
  writeEndpointFile(join(home, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE),
    v2Endpoint(home, fixture.origin, bearer, handle.owner.nonce));
  try {
    const runtime = new WorkbenchHostRuntime({
      ...identityInput(home, "notes"), supervisorTimeoutMs: 3000,
      connect: () => ({
        state: async () => {
          throw new RemoteError("workbench/unavailable", "The workbench request did not reach the supervisor (method: state; cause: ECONNRESET; after 7 ms).", {});
        },
      }) as never,
    });
    await assert.rejects(
      () => runtime.presentationSnapshot(),
      (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.equal(error.code, "workbench/unavailable");
        assert.ok(error.message.startsWith("The workbench request did not reach the supervisor (method: state; cause: ECONNRESET; after 7 ms)."), error.message);
        assert.ok(error.message.endsWith(`Supervisor PID ${handle.owner.pid} is alive. The recorded endpoint is unchanged.`), error.message);
        return true;
      },
    );
  } finally { await fixture.close(); }
});

test("a failed guide call writes a host.guide-failed diagnostic record with the remote name", async () => {
  const home = tempDir("dsh-guide-log-");
  writeProfile(home, "notes");
  const runtime = new WorkbenchHostRuntime(identityInput(home, "notes"));
  runtime.presentationSnapshot = async () => { throw new Error("fixture presentation failure Authorization: Bearer guide-secret"); };
  const plugin = new SpacesPlugin(pluginContext(), {}, runtime);
  await assert.rejects(() => plugin.guide.presentationSnapshot(), /fixture presentation failure/);
  const file = join(diagnosticLogDirectory(home), "host.jsonl");
  const rows = existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event?: string; level?: string; context?: { method?: string } })
    : [];
  const record = rows.find(row => row.event === "host.guide-failed");
  assert.ok(record, "host.guide-failed must be recorded in host.jsonl");
  assert.equal(record.level, "error");
  assert.equal(record.context?.method, "presentationSnapshot");
  assert.equal(readFileSync(file, "utf8").includes("guide-secret"), false);
});

test("WorkbenchRemoteError carries bounded transport metadata and flushes client failures once on reconnect", async () => {
  let state: "connected" | "disconnected" | "connecting" = "disconnected";
  const listeners = new Set<() => void>();
  const sent: Array<{ endpoint: string; report: unknown }> = [];
  let shouldThrow = true;
  const guide = createWorkbenchGuideRemote({
    state: {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    rpc: {
      call: async (_channel: string, endpoint: string, body: { args?: { report?: unknown } }) => {
        if (shouldThrow) throw new Error("C:\\Users\\admin\\.dsh\\secret-token");
        sent.push({ endpoint, report: body.args?.report });
        return { ok: true as const, value: { recorded: true } };
      },
    },
  });
  await assert.rejects(() => guide.presentationSnapshot!(), (error: unknown) => {
    assert.ok(error instanceof WorkbenchRemoteError);
    assert.equal(error.code, null);
    assert.equal(error.message, "The workbench request failed.");
    assert.equal(error.endpoint, "workbenchGuide/presentationSnapshot");
    assert.equal(error.failureKind, "rpc-transport");
    assert.equal(error.connectionState, "disconnected");
    return true;
  });

  const report = {
    surface: "desktop-native" as const,
    stage: "directory-poll" as const,
    detail: "Host RPC interrupted",
    failedAt: "2026-11-24T02:30:00.000Z",
    rpcEndpoint: "workbenchGuide/presentationSnapshot",
    rpcFailureKind: "rpc-transport" as const,
    connectionState: "disconnected" as const,
  };
  const immediate = await guide.reportClientFailure!(report);
  assert.deepEqual(immediate, { recorded: false });
  assert.equal(listeners.size, 1);

  state = "connecting";
  for (const fn of [...listeners]) fn();
  assert.equal(sent.length, 0);
  assert.equal(listeners.size, 1);

  shouldThrow = false;
  state = "connected";
  for (const fn of [...listeners]) fn();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.endpoint, "workbenchGuide/reportClientFailure");
  assert.deepEqual(sent[0]!.report, report);
  assert.equal(listeners.size, 0, "one-shot diagnostic subscription unsubscribes after flushing");

  for (const fn of [...listeners]) fn();
  assert.equal(sent.length, 1);
});

test("workbenchGuide/reportClientFailure writes sanitized host.client-failed entries and rate limits floods", async () => {
  const home = tempDir("dsh-client-log-");
  writeProfile(home, "notes");
  const runtime = new WorkbenchHostRuntime(identityInput(home, "notes"));
  const plugin = new SpacesPlugin(pluginContext(), {}, runtime);
  await assert.rejects(
    () => plugin.guide.reportClientFailure({ surface: "desktop-native", stage: "bad-stage" } as never),
    (error: unknown) => error instanceof RemoteError && error.code === "workbench/invalid-input",
  );
  const res = await plugin.guide.reportClientFailure({
    surface: "desktop-native",
    stage: "portal",
    detail: "Failed C:\\Users\\alice\\.dsh Bearer secret-token",
    failedAt: "2026-11-24T02:30:00.000Z",
    rpcEndpoint: "workbenchGuide/presentationSnapshot",
    rpcFailureKind: "rpc-transport",
    connectionState: "disconnected",
    portalFailure: { reason: "manager-disconnected" },
    navTrail: [
      { v: 1, src: "controller", seq: 1, t: 0, ev: "user-select", targetKind: "settings" },
      { v: 1, src: "portal", seq: 2, t: 15, ev: "fail", reason: "manager-disconnected" },
    ],
  });
  assert.deepEqual(res, { recorded: true });
  const file = join(diagnosticLogDirectory(home), "host.jsonl");
  const raw = readFileSync(file, "utf8");
  assert.equal(raw.includes("secret-token"), false);
  assert.equal(raw.includes("Users\\alice"), false);
  const rows = raw.trim().split("\n").map(line => JSON.parse(line) as {
    event?: string;
    level?: string;
    error?: { message?: string };
    context?: Record<string, unknown>;
  });
  const entry = rows.find(row => row.event === "host.client-failed");
  assert.ok(entry);
  assert.equal(entry.level, "error");
  assert.equal(entry.context?.surface, "desktop-native");
  assert.equal(entry.context?.stage, "portal");
  assert.equal(entry.context?.rpcEndpoint, "workbenchGuide/presentationSnapshot");
  assert.equal(entry.context?.portalReason, "manager-disconnected");
  assert.equal(entry.context?.navCount, 2);
  assert.match(String(entry.context?.navTail), /controller:user-select@0 portal:fail\(manager-disconnected\)@15/);

  for (let i = 0; i < 31; i += 1) {
    const next = await plugin.guide.reportClientFailure({
      surface: "desktop-native",
      stage: "directory-poll",
      detail: "repeat",
      failedAt: "2026-11-24T02:30:01.000Z",
    });
    assert.deepEqual(next, { recorded: true });
  }
  const capped = await plugin.guide.reportClientFailure({
    surface: "desktop-native",
    stage: "directory-poll",
    detail: "over-limit",
    failedAt: "2026-11-24T02:30:02.000Z",
  });
  assert.deepEqual(capped, { recorded: false });
});
