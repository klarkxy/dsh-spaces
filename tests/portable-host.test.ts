import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { WorkbenchPortalGrants, portalCsp } from "../src/adapters/node/workbench-portal.ts";
import { parseSpaceHostAudience, parsePortalSnapshot, portalMessage } from "../src/shared/space-host.ts";
import { startWorkbenchHttp, type WorkbenchHttpRuntime } from "../src/adapters/node/workbench-http.ts";
import { HostShellController, type HostShellEnvironment } from "../packages/plugin/src/client/host-shell-state.ts";
import { parseSurfaceSelection, attachSurfaceBridge } from "../packages/plugin/src/workbench/surface-bridge.ts";
import { mintSupervisorPortal } from "../packages/plugin/src/host/workbench-http.ts";

const channel = "ab".repeat(16), epoch = "cd".repeat(32), parentOrigin = "http://127.0.0.1:3090";
const audience = { parentOrigin, channel };
const inventory = { serviceEpoch: epoch, managerId: "spaces-hub", spaces: [
  { id: "spaces-hub", displayName: "Manager", generation: 1, status: "running" },
  { id: "alpha", displayName: "Alpha", generation: 1, status: "running" },
  { id: "beta", displayName: "Beta", generation: 2, status: "stopped" },
] };

test("host transport requires exact same-site origin, bounded channel, and closed fields", () => {
  assert.deepEqual(parseSpaceHostAudience(audience), audience);
  for (const parentOrigin of ["null", "dsh-app://app", "https://127.0.0.1:9", "http://localhost:9", "http://127.0.0.1:9/", "http://user@127.0.0.1", "http://127.0.0.1/?x=1", "http://example.com"]) {
    assert.equal(parseSpaceHostAudience({ parentOrigin, channel }), null, parentOrigin);
  }
  for (const value of [{ ...audience, token: "secret" }, { ...audience, channel: "a" }, { ...audience, channel: "<script>" }, null, []]) {
    assert.equal(parseSpaceHostAudience(value), null);
  }
});

test("portal inventory rejects unknown data, duplicate identities and invalid generations", () => {
  assert.deepEqual(parsePortalSnapshot(inventory), inventory);
  for (const value of [{ ...inventory, token: "x" }, { ...inventory, spaces: [...inventory.spaces, inventory.spaces[0]] },
    { ...inventory, spaces: [{ ...inventory.spaces[0], path: "/private" }] },
    { ...inventory, spaces: [{ ...inventory.spaces[0], generation: -1 }] }, { ...inventory, serviceEpoch: "old" }]) {
    assert.equal(parsePortalSnapshot(value), null);
  }
});

test("portal grants are one-use, audience-bound, bounded and not durable", () => {
  let now = 0;
  const grants = new WorkbenchPortalGrants(() => now);
  const input = { ...audience }, token = grants.mint(input);
  input.parentOrigin = "http://evil.example";
  assert.throws(() => grants.mint(audience));
  assert.deepEqual(grants.consume(token), audience);
  assert.equal(grants.consume(token), null);
  assert.deepEqual(grants.page(channel), audience);
  now = 300001;
  assert.equal(grants.page(channel), null);
  const next = grants.mint(audience);
  now += 60001;
  assert.equal(grants.consume(next), null);
  assert.equal(new WorkbenchPortalGrants().consume(token), null);
  for (let i = 0; i < 128; i++) grants.mint({ ...audience, channel: i.toString(16).padStart(32, "0") });
  assert.throws(() => grants.mint({ ...audience, channel: "ff".repeat(16) }));
});

test("CSP admits only the selected parent, manager and supervisor, not arbitrary websites", () => {
  const csp = portalCsp(audience, "http://127.0.0.1:3091");
  assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:3090$/);
  assert.match(csp, /frame-src 'self' http:\/\/127\.0\.0\.1:3091;/);
  assert.equal(csp.includes("*"), false);
  assert.throws(() => portalCsp(audience, "https://example.com"));
});

test("live HTTP portal mint requires Node credentials and exact origin; grants never loosen API auth", async t => {
  let origin = "";
  const runtime: WorkbenchHttpRuntime = {
    cookieName: () => "operator", sessionCookie: () => "test-session", sessionEquals: value => value === "test-session",
    consumeBootstrapToken: () => false, hostBearerEquals: value => value === "test-host-bearer",
    supervisorOrigin: () => origin, managerOrigin: () => "http://127.0.0.1:3091", isWorkspaceOrigin: value => value === parentOrigin,
    dispatch: async () => inventory, entryPage: () => "", mintHandoff: () => "",
    viewEntry: async () => ({ setCookies: [], location: "http://127.0.0.1:3091/" }),
  };
  const server = await startWorkbenchHttp(runtime); origin = server.origin;
  t.after(() => server.close());
  const mint = (headers: Record<string, string>, data: unknown = audience) => fetch(origin + "/internal/portal", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data), redirect: "manual",
  });
  assert.equal((await mint({ cookie: "operator=test-session", origin })).status, 403);
  assert.equal((await mint({ authorization: "Bearer test-host-bearer", origin: parentOrigin })).status, 403);
  assert.equal((await mint({ authorization: "Bearer test-host-bearer", origin }, { ...audience, extra: true })).status, 400);
  assert.equal((await mint({ authorization: "Bearer test-host-bearer", origin }, { data: "x".repeat(2048) })).status, 413);
  const minted = await mint({ authorization: "Bearer test-host-bearer", origin });
  assert.equal(minted.status, 200);
  const { path } = await minted.json();
  assert.match(path, /^\/portal-bootstrap\/[A-Za-z0-9_-]{32}$/);
  assert.equal((await fetch(origin + path, { headers: { "sec-fetch-site": "cross-site" }, redirect: "manual" })).status, 403);
  const exchange = await fetch(origin + path, { redirect: "manual" });
  assert.equal(exchange.status, 303);
  assert.match(exchange.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const page = origin + exchange.headers.get("location");
  assert.equal((await fetch(origin + path, { redirect: "manual" })).status, 401);
  assert.equal((await fetch(page)).status, 401);
  const loaded = await fetch(page, { headers: { cookie: "operator=test-session" } });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.headers.get("cache-control"), "no-store");
  assert.equal(loaded.headers.get("content-security-policy"), portalCsp(audience, "http://127.0.0.1:3091"));
  const html = await loaded.text();
  assert.equal(html.includes("test-host-bearer"), false);
  assert.equal(html.includes("test-session"), false);
  assert.match(html, /event\.source !== parent/);
  assert.equal((await fetch(origin + "/api/workbench/state", { method: "POST", headers: { cookie: "operator=test-session", origin: parentOrigin }, body: "{}" })).status, 403);
});

function fixture(origin = parentOrigin, hasManager = true) {
  const calls: string[] = [], timers = new Map<number, () => void>(); let timer = 0;
  const env: HostShellEnvironment = { origin: () => origin, channel: () => channel,
    setTimeout: fn => { timers.set(++timer, fn); return timer as never; }, clearTimeout: id => { timers.delete(id as never); } };
  const guide = {
    role: async () => { calls.push("role"); return { role: "workspace" as const, profileId: "entry", managerId: hasManager ? "spaces-hub" : null, unavailable: false, reasons: [] }; },
    bootstrap: async () => { throw new Error("not used by renderer"); },
    returnTarget: async () => { throw new Error("must not navigate"); },
    initialize: async () => { calls.push("initialize"); return { ok: true, connected: true, unavailable: false, origin: "http://127.0.0.1:3088", path: "/bootstrap/never-navigate", managerId: "spaces-hub", reasons: [] }; },
    portalTarget: async () => { calls.push("portalTarget"); return { available: true, unavailable: false, origin: "http://127.0.0.1:3088", path: "/portal-bootstrap/" + "a".repeat(32), reasons: [] }; },
  };
  const controller = new HostShellController(guide, env);
  const messages: Array<Record<string, unknown>> = [];
  const frame = { postMessage: (data: unknown) => { messages.push(data as Record<string, unknown>); } };
  const event = (data: object) => ({ source: frame, origin: "http://127.0.0.1:3088", data: { source: "dsh-spaces-portal", channel, ...data } });
  return { controller, guide, calls, timers, messages, frame, event };
}

test("presentation attaches once without management or top-level handoff; source/origin checks are exact", async () => {
  const f = fixture(); f.controller.start(); await tick();
  assert.deepEqual(f.calls, ["role", "portalTarget"]);
  f.controller.registerFrame(f.frame);
  const event = f.event({ type: "state", snapshot: inventory });
  assert.equal(portalMessage({ ...event, source: {} }, f.frame, event.origin, channel), null);
  assert.equal(portalMessage({ ...event, origin: "http://127.0.0.1:1" }, f.frame, event.origin, channel), null);
  assert.equal(portalMessage(event, null, event.origin, channel), null);
  f.controller.handleMessage({ ...event, source: {} });
  assert.equal(f.controller.getSnapshot().inventory, null);
  f.controller.handleMessage(event);
  assert.equal(f.controller.getSnapshot().phase, "ready");
  f.controller.select("alpha"); const requestId = f.messages[0].requestId;
  assert.equal(f.controller.getSnapshot().visible, "current");
  f.controller.handleMessage(f.event({ type: "selected", requestId, spaceId: "alpha", extra: true }));
  assert.equal(f.controller.getSnapshot().visible, "current");
  f.controller.handleMessage(f.event({ type: "selected", requestId, spaceId: "alpha" }));
  assert.equal(f.controller.getSnapshot().visible, "portal");
  assert.equal(f.controller.getSnapshot().selected, "alpha");
  f.controller.showCurrent();
  assert.equal(f.controller.getSnapshot().portal?.src.endsWith("a".repeat(32)), true);
  assert.deepEqual(f.calls, ["role", "portalTarget"]);
  f.controller.stop(); assert.equal(f.timers.size, 0);
});

test("stopped spaces do not start, latest click wins, stale lifetime and failed channels do not reconnect", async () => {
  const f = fixture(); f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
  f.controller.handleMessage(f.event({ type: "state", snapshot: inventory }));
  f.controller.select("beta"); assert.equal(f.messages.length, 0); assert.equal(f.controller.getSnapshot().error, "stopped");
  f.controller.select("alpha"); const old = f.messages[0].requestId;
  f.controller.select(null); const current = f.messages[1].requestId;
  f.controller.handleMessage(f.event({ type: "selected", requestId: old, spaceId: "alpha" }));
  assert.equal(f.controller.getSnapshot().pending, current);
  f.controller.showCurrent();
  f.controller.handleMessage(f.event({ type: "selected", requestId: current, spaceId: null }));
  assert.equal(f.controller.getSnapshot().visible, "current");
  f.controller.handleMessage(f.event({ type: "failed" }));
  assert.equal(f.controller.getSnapshot().phase, "failed"); assert.equal(f.controller.getSnapshot().portal, null);
  f.controller.handleMessage(f.event({ type: "state", snapshot: inventory }));
  await tick(); assert.deepEqual(f.calls, ["role", "portalTarget"]); f.controller.stop();
});

test("unsupported native or remote transport is rejected before initialization writes", async () => {
  for (const origin of ["dsh-app://app", "https://remote.example", "http://localhost:3000"]) {
    const f = fixture(origin, false); f.controller.start(); await tick();
    await f.controller.initialize();
    assert.equal(f.controller.getSnapshot().error, "unsupported");
    assert.deepEqual(f.calls, ["role"]); f.controller.stop();
  }
});

test("explicit initialize discards the legacy navigation handoff and late responses after disposal", async () => {
  const f = fixture(parentOrigin, false); f.controller.start(); await tick();
  assert.equal(f.controller.getSnapshot().phase, "initialize");
  await f.controller.initialize();
  assert.deepEqual(f.calls, ["role", "initialize", "portalTarget"]);
  assert.equal(f.controller.getSnapshot().portal!.src.includes("bootstrap/never"), false);
  f.controller.stop();
  const g = fixture(); const pending = Promise.withResolvers<Awaited<ReturnType<typeof g.guide.role>>>();
  g.guide.role = () => pending.promise;
  g.controller.start(); g.controller.stop(); pending.resolve(await f.guide.role()); await tick();
  assert.equal(g.controller.getSnapshot().portal, null); assert.deepEqual(g.calls, []);
});

test("manager surface validates existing parent generation and cannot navigate through a stopped entry", () => {
  const replies: unknown[] = []; const parent = { postMessage: (data: unknown) => replies.push(data) };
  const view = { parentOrigin, spaceId: "spaces-hub", generation: 1, serviceEpoch: epoch, channel: "manager-channel" };
  let listener: ((e: MessageEvent) => void) | null = null; let sub = () => {};
  let ui = { boot: "ready", state: { ...inventory, availability: "available" }, selected: "home", pendingId: null, viewError: null };
  const navigations: string[] = [];
  const controller = { subscribe(fn: () => void) { sub = fn; return () => {}; }, getSnapshot: () => ui,
    selectHome() { ui = { ...ui, selected: "home" }; sub(); }, selectRunningSpace(id: string) {
      if (id !== "alpha") return false;
      navigations.push(id); ui = { ...ui, selected: id }; sub(); return true;
    } };
  const dispose = attachSurfaceBridge(controller as never, view, parent, fn => { listener = fn; return () => { listener = null; }; });
  assert.equal((replies[0] as { type: string }).type, "ready"); replies.length = 0;
  const event = (target: string | null, requestId: number) => ({ source: parent, origin: parentOrigin, data: {
    source: "dsh-spaces-surface-parent", type: "select", requestId, serviceEpoch: epoch, spaceId: "spaces-hub", generation: 1, channel: view.channel, target,
  } });
  assert.equal(parseSurfaceSelection({ ...event("alpha", 1), source: {} }, parent, view), null);
  assert.equal(parseSurfaceSelection({ ...event("alpha", 1), origin: "http://127.0.0.1:1" }, parent, view), null);
  listener!(event("beta", 1) as never);
  assert.equal((replies[0] as { type: string }).type, "selection-failed");
  listener!(event("alpha", 2) as never);
  assert.deepEqual(navigations, ["alpha"]);
  assert.equal((replies[1] as { type: string }).type, "selected");
  listener!(event(null, 1) as never); assert.equal(replies.length, 2);
  dispose(); assert.equal(listener, null);
});
