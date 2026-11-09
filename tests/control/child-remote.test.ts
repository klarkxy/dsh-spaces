/**
 * ChildRemoteClient + runLivePlan against an in-process DSH /api fixture.
 *
 * The fixture reproduces the verified 0.2.2-rc.1 wire contract:
 *   GET /?token=…          → 303 + Set-Cookie dsh-auth-* (launch exchange)
 *   POST /api/<endpoint>   → cookie gate + client-request envelope +
 *                            server-response envelope {ok,value|error}
 * covered cases: wire shape, whitelist + args closure, cookie secrecy,
 * not-running / generation guard, non-JSON and ok:false failures,
 * read-back verification failures, protected packages, the plugins.live
 * ordering view, and single-writer serialization through the job tail.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, test } from "node:test";
import {
  ChildRemoteClient,
  readLivePluginView,
  runLivePlan,
  type ChildRemotePorts,
} from "../../src/adapters/node/supervisor/child-remote.ts";
import { ControlPublicError } from "../../src/shared/control.ts";
import type { WorkbenchJobContext } from "../../src/adapters/node/maintenance/workbench-jobs.ts";
import type { LivePlanRequest } from "../../src/adapters/node/supervisor/child-remote.ts";

const COOKIE_NAME = "dsh-auth-aaaa";
const COOKIE_VALUE = "signed-cookie-value-0123456789abcdef";
const LAUNCH_TOKEN = "fixture-launch-token-0001";

interface CapturedRequest {
  url: string;
  cookie?: string;
  origin?: string;
  contentType?: string;
  body?: {
    type?: string;
    rpcId?: string;
    method?: string;
    payload?: { args?: Record<string, unknown> };
  };
}

interface FakeChild {
  origin: string;
  launchUrl: string;
  port: number;
  calls: CapturedRequest[];
  answers: Map<string, { ok: boolean; value: unknown }>;
  cookieGate: boolean;
  /** The cookie value the gate accepts; the exchange always mints COOKIE_VALUE. */
  expectedCookie: string;
  rawResponse?: { status: number; contentType: string; body: string };
  close(): Promise<void>;
}

const listeners: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of listeners.splice(0)) await close();
});

async function startFakeChild(): Promise<FakeChild> {
  const fake: FakeChild = {
    origin: "",
    launchUrl: "",
    port: 0,
    calls: [],
    answers: new Map(),
    cookieGate: true,
    expectedCookie: COOKIE_VALUE,
    close: async () => undefined,
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === LAUNCH_TOKEN) {
        res.writeHead(303, {
          location: "./",
          "set-cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Max-Age=60; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const endpoint = url.pathname.slice("/api/".length);
        const chunks: Buffer[] = [];
        for await (const part of req) chunks.push(part as Buffer);
        let body: CapturedRequest["body"];
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest["body"];
        } catch {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("body is not JSON");
          return;
        }
        fake.calls.push({
          url: url.pathname,
          cookie: req.headers.cookie,
          origin: req.headers.origin,
          contentType: req.headers["content-type"],
          body,
        });
        if (fake.cookieGate && req.headers.cookie !== `${COOKIE_NAME}=${fake.expectedCookie}`) {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("dsh web authentication required\n");
          return;
        }
        if (fake.rawResponse) {
          res.writeHead(fake.rawResponse.status, { "content-type": fake.rawResponse.contentType });
          res.end(fake.rawResponse.body);
          return;
        }
        const answer = fake.answers.get(endpoint) ?? { ok: false, value: { code: "gateway/invocation-unavailable", message: `no active Remote method exports ${endpoint}` } };
        const result = answer.ok
          ? { ok: true as const, value: answer.value }
          : { ok: false as const, error: answer.value };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: body?.rpcId ?? "bad", result }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    })();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolvePromise(); });
  });
  const port = (server.address() as { port: number }).port;
  fake.port = port;
  fake.origin = `http://127.0.0.1:${port}`;
  fake.launchUrl = `${fake.origin}/?token=${LAUNCH_TOKEN}`;
  const close = server.close.bind(server);
  fake.close = () =>
    new Promise<void>((resolvePromise, reject) => {
      server.closeAllConnections();
      close((err) => (err ? reject(err) : resolvePromise()));
    });
  listeners.push(fake.close);
  return fake;
}

interface MutableState {
  status: "running" | "starting" | "stopping" | "stopped" | "crashed" | "unknown";
  generation: number;
  spawned: boolean;
  epoch: string;
}

function makePorts(fake: FakeChild, state: MutableState): ChildRemotePorts {
  return {
    statusOf: () => state.status,
    generationOf: () => state.generation,
    spawned: () => state.spawned,
    urlOf: () => fake.launchUrl,
    portOf: () => fake.port,
    currentServiceEpoch: () => state.epoch,
    fetch: globalThis.fetch.bind(globalThis),
  };
}

function runningState(): MutableState {
  return { status: "running", generation: 7, spawned: true, epoch: "e".repeat(64) };
}

function jobContext(): WorkbenchJobContext & { phases: string[]; messages: string[] } {
  const phases: string[] = [];
  const messages: string[] = [];
  return {
    phases,
    messages,
    signal: new AbortController().signal,
    phase: (phase: string) => { phases.push(phase); },
    message: (message: string) => { messages.push(message); },
    cancellable: () => undefined,
    result: () => undefined,
  };
}

function code(error: unknown): string {
  assert.ok(error instanceof ControlPublicError, `expected ControlPublicError, got ${String(error)}`);
  return (error as ControlPublicError).code;
}

async function clientFor(fake: FakeChild, state = runningState()): Promise<{ client: ChildRemoteClient; state: MutableState }> {
  const ports = makePorts(fake, state);
  return { client: new ChildRemoteClient(ports, "space-alpha", state.generation, state.epoch), state };
}

test("unary call uses the verified client-request wire shape and cookie gate", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/listPlugins", { ok: true, value: [{ entryId: "include:e1", moduleName: "dsh-plugin-a", enabled: true }] });
  const { client } = await clientFor(fake);

  const rows = await client.call("pluginManager/listPlugins", {}) as Array<Record<string, unknown>>;
  assert.equal(rows[0]?.entryId, "include:e1");

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0]!;
  assert.equal(call.url, "/api/pluginManager/listPlugins");
  assert.equal(call.cookie, `${COOKIE_NAME}=${COOKIE_VALUE}`);
  assert.equal(call.origin, fake.origin);
  assert.equal(call.contentType, "application/json");
  assert.equal(call.body?.type, "client-request");
  assert.equal(call.body?.method, "pluginManager/listPlugins");
  assert.deepEqual(call.body?.payload, { args: {} });
  assert.ok(typeof call.body?.rpcId === "string" && call.body.rpcId.length > 0);
});

test("a failed exchange and a refused cookie surface as control/unavailable", async () => {
  // No launch endpoint: the cookie exchange cannot even be attempted.
  const fake = await startFakeChild();
  fake.launchUrl = "";
  const { client } = await clientFor(fake);
  await assert.rejects(
    () => client.call("pluginManager/listPlugins", {}),
    (error) => code(error) === "control/unavailable",
  );
  assert.equal(fake.calls.length, 0, "no /api request may fire without the session cookie");

  // A wrong launch token means no Set-Cookie: control/unavailable, once.
  const strict = await startFakeChild();
  strict.launchUrl = `${strict.origin}/?token=WRONG`;
  const bad = new ChildRemoteClient(makePorts(strict, runningState()), "space-alpha", 7, "e".repeat(64));
  await assert.rejects(
    () => bad.call("pluginManager/listPlugins", {}),
    (error) => code(error) === "control/unavailable",
  );
  assert.equal(strict.calls.length, 0);

  // A cookie the gate does not accept (401) is control/unavailable too —
  // never a second exchange and never a retry.
  const gate = await startFakeChild();
  gate.answers.set("pluginManager/listPlugins", { ok: true, value: [] });
  gate.expectedCookie = "a-different-cookie-value-0000000000000000";
  gate.launchUrl = `${gate.origin}/?token=${LAUNCH_TOKEN}`;
  const second = new ChildRemoteClient(makePorts(gate, runningState()), "space-alpha", 7, "e".repeat(64));
  await assert.rejects(
    () => second.call("pluginManager/listPlugins", {}, AbortSignal.timeout(5_000)),
    (error) => code(error) === "control/unavailable",
  );
  assert.equal(gate.calls.length, 1, "a refused call is never retried");
});

test("methods and args outside the whitelist never reach the wire", async () => {
  const fake = await startFakeChild();
  const { client } = await clientFor(fake);

  await assert.rejects(
    () => client.call("sessionController/list" as never, {}),
    (error) => code(error) === "control/unsupported",
  );
  await assert.rejects(
    () => client.call("pluginManager/setBundleEnabled" as never, { name: "x", enabled: true }),
    (error) => code(error) === "control/unsupported",
  );
  await assert.rejects(
    () => client.call("pluginManager/installBundle", { spec: "x@1.0.0", options: {}, evil: true }),
    (error) => code(error) === "control/invalid-input",
  );
  assert.equal(fake.calls.length, 0, "no request may leave the supervisor for a refused call");
});

test("cookie and launch token never leak into results or error text", async () => {
  const fake = await startFakeChild();
  fake.cookieGate = false;
  fake.rawResponse = {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      type: "server-response",
      rpcId: "x",
      result: { ok: false, error: { code: "gateway/internal", message: `leak ${COOKIE_VALUE} ${LAUNCH_TOKEN}`, details: {} } },
    }),
  };
  const { client } = await clientFor(fake);
  const error = await client.call("pluginManager/listPlugins", {}).then(
    () => assert.fail("must reject"),
    (failure) => failure,
  );
  const text = String((error as Error).message);
  assert.ok(!text.includes(COOKIE_VALUE), "cookie value leaked into the error");
  assert.ok(!text.includes(LAUNCH_TOKEN), "launch token leaked into the error");
  assert.match(text, /\[redacted\]/);
});

test("a non-JSON response and a malformed envelope fail as control/failed", async () => {
  const fake = await startFakeChild();
  const { client } = await clientFor(fake);
  fake.rawResponse = { status: 200, contentType: "text/html", body: "<html>nope</html>" };
  await assert.rejects(() => client.call("pluginManager/listPlugins", {}), (error) => code(error) === "control/failed");

  fake.rawResponse = { status: 200, contentType: "application/json", body: JSON.stringify({ wrong: true }) };
  await assert.rejects(() => client.call("pluginManager/listPlugins", {}), (error) => code(error) === "control/failed");

  fake.rawResponse = { status: 200, contentType: "application/json", body: "{" };
  await assert.rejects(() => client.call("pluginManager/listPlugins", {}), (error) => code(error) === "control/failed");
});

test("not-running, missing ownership and generation change are refused before any exchange", async () => {
  const fake = await startFakeChild();
  for (const state of [
    { status: "stopped" as const, generation: 7, spawned: true, epoch: "e".repeat(64) },
    { status: "crashed" as const, generation: 7, spawned: true, epoch: "e".repeat(64) },
    { status: "running" as const, generation: 8, spawned: true, epoch: "e".repeat(64) },
    { status: "running" as const, generation: 7, spawned: false, epoch: "e".repeat(64) },
    { status: "running" as const, generation: 7, spawned: true, epoch: "f".repeat(64) },
  ]) {
    const client = new ChildRemoteClient(makePorts(fake, state), "space-alpha", 7, "e".repeat(64));
    await assert.rejects(
      () => client.call("pluginManager/listPlugins", {}),
      (error) => code(error) === "control/not-running",
    );
  }
  assert.equal(fake.calls.length, 0);
});

test("an ok:false remote result surfaces its own code and sanitized message", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/removeBundle", { ok: false, value: { code: "remote-access/denied", message: "denied by policy", details: {} } });
  const { client } = await clientFor(fake);
  const error = await client.call("pluginManager/removeBundle", { name: "dsh-plugin-a" }).then(
    () => assert.fail("must reject"),
    (failure) => failure as ControlPublicError,
  );
  assert.equal(error.code, "control/failed");
  assert.match(error.message, /remote-access\/denied/);
  assert.match(error.message, /denied by policy/);
});

test("plugins.live view preserves load order and manifest bundle order", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/listPlugins", {
    ok: true,
    value: [
      { entryId: "include:a", moduleName: "first", enabled: true, fiberPhase: "active" },
      { entryId: "include:b", moduleName: "second", enabled: false, fiberPhase: null },
    ],
  });
  fake.answers.set("pluginManager/listBundles", {
    ok: true,
    value: [
      { name: "@deepseek-ai/dsh-base", version: "0.2.2-rc.1", enabled: true, installed: false, official: true },
      { name: "dsh-plugin-a", version: "1.0.0", enabled: true, installed: true, source: "1.0.0" },
    ],
  });
  const { client } = await clientFor(fake);
  const view = await readLivePluginView(client);
  assert.equal(view.running, true);
  assert.deepEqual(view.plugins.map((row) => row.entryId), ["include:a", "include:b"]);
  assert.deepEqual(view.plugins.map((row) => row.enabled), [true, false]);
  assert.deepEqual(view.bundles.map((row) => row.name), ["@deepseek-ai/dsh-base", "dsh-plugin-a"]);
  assert.equal(view.bundles[1]?.installed, true);
  assert.equal(view.truncated, false);
});

test("plugins.live reports the remote failure instead of substituting another source", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/listPlugins", {
    ok: false,
    value: { code: "gateway/service-unavailable", message: "plugin manager is unavailable", details: {} },
  });
  const { client } = await clientFor(fake);
  const error = await readLivePluginView(client).then(
    () => assert.fail("must reject"),
    (failure) => failure as ControlPublicError,
  );
  assert.equal(error.code, "control/failed");
  assert.match(error.message, /service-unavailable/);
});

test("plugin.live.install calls installBundle, waits the settlement and verifies read-back", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/installBundle", {
    ok: true,
    value: { changed: true, application: "applied", stage: "enable", target: "dsh-plugin-a@1.2.3", bundle: "dsh-plugin-a", version: "1.2.3" },
  });
  fake.answers.set("pluginManager/waitForInstall", { ok: true, value: null });
  fake.answers.set("pluginManager/listBundles", {
    ok: true,
    value: [{ name: "dsh-plugin-a", version: "1.2.3", enabled: true, installed: true, source: "1.2.3" }],
  });
  const { client } = await clientFor(fake);
  const ctx = jobContext();
  const result = await runLivePlan(client, {
    kind: "plugin.live.install",
    spaceId: "space-alpha",
    source: { npm: { packageName: "dsh-plugin-a", version: "1.2.3", approvedBuilds: ["dep@1.0.0"] } },
  } as LivePlanRequest, ctx);

  const install = fake.calls.find((row) => row.url.endsWith("/pluginManager/installBundle"))!;
  const options = install.body?.payload?.args?.options as Record<string, unknown>;
  assert.equal(install.body?.payload?.args?.spec, "dsh-plugin-a@1.2.3");
  assert.equal(options.saveExact, true);
  assert.deepEqual(options.approvedBuilds, ["dep@1.0.0"]);
  assert.ok(typeof options.requestId === "string" && options.requestId.startsWith("control-"));
  const wait = fake.calls.find((row) => row.url.endsWith("/pluginManager/waitForInstall"))!;
  assert.equal(wait.body?.payload?.args?.requestId, options.requestId);
  assert.ok(result && Array.isArray((result as { steps?: unknown[] }).steps));
  assert.deepEqual(ctx.phases, ["install", "verify"]);
});

test("plugin.live.install fails honestly when the read-back does not match", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/installBundle", {
    ok: true,
    value: { changed: true, application: "applied", stage: "enable", target: "dsh-plugin-a@1.2.3", bundle: "dsh-plugin-a", version: "1.2.3" },
  });
  fake.answers.set("pluginManager/waitForInstall", { ok: true, value: null });
  fake.answers.set("pluginManager/listBundles", {
    ok: true,
    value: [{ name: "dsh-plugin-a", version: "9.9.9", enabled: true, installed: true }],
  });
  const { client } = await clientFor(fake);
  await assert.rejects(
    () => runLivePlan(client, {
      kind: "plugin.live.install",
      spaceId: "space-alpha",
      source: { npm: { packageName: "dsh-plugin-a", version: "1.2.3" } },
    } as LivePlanRequest, jobContext()),
    (error) => code(error) === "control/failed" && /read back version/.test((error as Error).message),
  );
});

test("plugin.live.install reports pending build keys instead of installing twice", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/installBundle", {
    ok: true,
    value: {
      changed: true, application: "failed", stage: "install", target: "dsh-plugin-a@1.2.3",
      error: { code: "operation-error", diagnostic: "ignored build scripts" },
      pendingBuilds: ["dep@1.0.0"],
    },
  });
  fake.answers.set("pluginManager/waitForInstall", { ok: true, value: null });
  const { client } = await clientFor(fake);
  const error = await runLivePlan(client, {
    kind: "plugin.live.install",
    spaceId: "space-alpha",
    source: { npm: { packageName: "dsh-plugin-a", version: "1.2.3" } },
  } as LivePlanRequest, jobContext()).then(
    () => assert.fail("must reject"),
    (failure) => failure as ControlPublicError,
  );
  assert.equal(error.code, "control/failed");
  assert.match(error.message, /dep@1\.0\.0/);
  assert.match(error.message, /approvedBuilds/);
  assert.equal(fake.calls.length, 2, "installBundle + waitForInstall only: no retry and no second install");
  assert.ok(fake.calls.every((row) => !row.url.endsWith("/installBundle") || row === fake.calls[0]), "installBundle ran exactly once");
});

test("plugin.live.update, entry and remove call their official methods and verify read-back", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/updateBundle", {
    ok: true,
    value: { from: "1.0.0", to: "1.1.0", step: "install", result: { changed: true, application: "applied", stage: "install", target: "dsh-plugin-a" } },
  });
  fake.answers.set("pluginManager/listPlugins", {
    ok: true,
    value: [
      { entryId: "include:e1", moduleName: "dsh-plugin-a", enabled: false, fiberPhase: null },
      { entryId: "include:e2", moduleName: "@dsh-spaces/view-bridge", enabled: true, fiberPhase: "active" },
    ],
  });
  fake.answers.set("pluginManager/setPluginEnabled", {
    ok: true,
    value: { changed: true, application: "applied", stage: "enable", target: "include:e1", enabled: true },
  });
  fake.answers.set("pluginManager/removeBundle", {
    ok: true,
    value: { changed: true, application: "applied", stage: "remove", target: "dsh-plugin-a" },
  });
  // Update: install → wait → verify all hit the child's own manager.
  fake.answers.set("pluginManager/listBundles", {
    ok: true,
    value: [{ name: "dsh-plugin-a", version: "1.1.0", enabled: true, installed: true, source: "1.1.0" }],
  });
  const { client } = await clientFor(fake);
  await runLivePlan(client, {
    kind: "plugin.live.update", spaceId: "space-alpha", packageName: "dsh-plugin-a", version: "1.1.0",
  } as LivePlanRequest, jobContext());
  const update = fake.calls.find((row) => row.url.endsWith("/pluginManager/updateBundle"))!;
  const updateArgs = update.body?.payload?.args as Record<string, unknown>;
  assert.equal(updateArgs.name, "dsh-plugin-a");
  assert.equal(updateArgs.version, "1.1.0");
  assert.equal(Object.keys(updateArgs).sort().join(","), "name,options,version");
  assert.ok(typeof (updateArgs.options as Record<string, unknown>).requestId === "string");

  // Entry enable (P7): protected entries are refused without a remote write.
  await assert.rejects(
    () => runLivePlan(client, {
      kind: "plugin.live.entry", spaceId: "space-alpha", entryId: "include:e2", enabled: false,
    } as LivePlanRequest, jobContext()),
    (error) => code(error) === "control/protected",
  );
  // A new client with a fresh fake would reuse calls; check no remote write
  // beyond listPlugins happened for the refused entry.
  assert.equal(fake.calls.filter((row) => row.url.endsWith("/setPluginEnabled")).length, 0);

  // Enabled entry toggles through setPluginEnabled with the exact wire fields.
  fake.answers.set("pluginManager/listPlugins", {
    ok: true,
    value: [{ entryId: "include:e1", moduleName: "dsh-plugin-a", enabled: true, fiberPhase: "active" }],
  });
  await runLivePlan(client, {
    kind: "plugin.live.entry", spaceId: "space-alpha", entryId: "include:e1", enabled: true,
  } as LivePlanRequest, jobContext());
  const toggle = fake.calls.find((row) => row.url.endsWith("/setPluginEnabled"))!;
  assert.deepEqual(toggle.body?.payload?.args, { id: "include:e1", enabled: true });

  // Remove: read-back still shows the package installed → honest failure.
  fake.answers.set("pluginManager/listBundles", {
    ok: true,
    value: [{ name: "dsh-plugin-a", version: "1.1.0", enabled: true, installed: true }],
  });
  await assert.rejects(
    () => runLivePlan(client, {
      kind: "plugin.live.remove", spaceId: "space-alpha", packageName: "dsh-plugin-a",
    } as LivePlanRequest, jobContext()),
    (error) => code(error) === "control/failed" && /still installed/.test((error as Error).message),
  );
});

test("protected packages are refused locally for install, update and remove", async () => {
  const fake = await startFakeChild();
  const { client } = await clientFor(fake);
  for (const request of [
    { kind: "plugin.live.install", spaceId: "space-alpha", source: { npm: { packageName: "@dsh-spaces/view-bridge", version: "1.0.0" } } },
    { kind: "plugin.live.install", spaceId: "space-alpha", source: { npm: { packageName: "@dsh-spaces/plugin", version: "0.5.0" } } },
    { kind: "plugin.live.update", spaceId: "space-alpha", packageName: "@dsh-spaces/llm-bridge", version: "1.0.1" },
    { kind: "plugin.live.remove", spaceId: "space-alpha", packageName: "@deepseek-ai/dsh-base" },
    { kind: "plugin.live.remove", spaceId: "space-alpha", packageName: "@klarkxy/dsh-dev-index" },
  ] as LivePlanRequest[]) {
    await assert.rejects(
      () => runLivePlan(client, request, jobContext()),
      (error) => code(error) === "control/protected" || code(error) === "control/invalid-input",
    );
  }
  const remoteCalls = fake.calls.filter((row) => !row.url.endsWith("/listPlugins") && !row.url.endsWith("/listBundles"));
  assert.equal(remoteCalls.length, 0, "no protected package ever reached the child");
});

test("a generation change between exchange and call refuses control/not-running", async () => {
  const fake = await startFakeChild();
  fake.answers.set("pluginManager/listPlugins", { ok: true, value: [] });
  const state = runningState();
  const ports = makePorts(fake, state);
  const client = new ChildRemoteClient(ports, "space-alpha", 7, state.epoch);
  // Flip the generation after the client was bound: the next call must see
  // the mismatch before exchanging anything.
  state.generation = 8;
  await assert.rejects(
    () => client.call("pluginManager/listPlugins", {}),
    (error) => code(error) === "control/not-running",
  );
  assert.equal(fake.calls.length, 0);
});
