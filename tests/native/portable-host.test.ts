import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as tick } from "node:timers/promises";
import { WorkbenchPortalGrants, portalCsp, renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";
import { Script } from "node:vm";
import { parseSpaceHostAudience, parsePortalSnapshot, parsePortalFailure, PORTAL_FAILURE_REASONS, portalMessage } from "../../src/shared/space-host.ts";
import { startWorkbenchHttp, type WorkbenchHttpRuntime } from "../../src/adapters/node/server/workbench-http.ts";
import { HostShellController, type HostShellEnvironment } from "../../packages/plugin/src/client/host-shell-state.ts";
import type { WorkbenchGuideApi } from "../../packages/plugin/src/types.ts";
import { parseSurfaceSelection, attachSurfaceBridge } from "../../packages/plugin/src/workbench/surface-bridge.ts";
import { mintSupervisorPortal } from "../../packages/plugin/src/host/workbench-http.ts";
import { startViewBridge, type ViewConnectionState } from "../../packages/view-bridge/src/client.ts";

const channel = "ab".repeat(16), epoch = "cd".repeat(32), parentOrigin = "http://127.0.0.1:3090";
const audience = { parentOrigin, channel };
const inventory = { serviceEpoch: epoch, managerId: "spaces-hub", spaces: [
  { id: "spaces-hub", displayName: "Manager", generation: 1, status: "running" },
  { id: "alpha", displayName: "Alpha", generation: 1, status: "running" },
  { id: "beta", displayName: "Beta", generation: 2, status: "stopped" },
] };

test("repeated manager readiness does not resend a pending selection or extend its deadline", () => {
  const html = renderPortalPage(audience, "http://127.0.0.1:3091");
  const source = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const startup = source.lastIndexOf("\nvoid refresh();");
  assert(startup > 0);
  const sent: unknown[] = [];
  let timers = 0;
  new Script(source.slice(0, startup) + `
    managerReady = true;
    frame = { contentWindow: { postMessage: value => received.push(value) } };
    managerView = { serviceEpoch: "${epoch}", spaceId: "spaces-hub", generation: 1, channel: "manager-view" };
    pending = { requestId: 1, spaceId: "alpha" };
    forwardSelection(); forwardSelection(); forwardSelection();
    pending = { requestId: 2, spaceId: "beta" };
    forwardSelection(); forwardSelection();
  `).runInNewContext({ received: sent, AbortController,
    window: { addEventListener() {} },
    setTimeout: () => ++timers, clearTimeout() {},
  });
  assert.deepEqual(sent.map(value => (value as { requestId: number }).requestId), [1, 2]);
  assert.equal(timers, 2);
});

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

test("portal inventory accepts the closed attention field and rejects other values", () => {
  const withAttention = {
    ...inventory,
    spaces: [
      { id: "spaces-hub", displayName: "Manager", generation: 1, status: "running", attention: "none", working: "idle" },
      { id: "alpha", displayName: "Alpha", generation: 1, status: "running", attention: "required", working: "busy" },
      { id: "beta", displayName: "Beta", generation: 2, status: "stopped", attention: "unknown", working: "unknown" },
    ],
  };
  assert.deepEqual(parsePortalSnapshot(withAttention), withAttention);
  for (const bad of ["busy", "error", "idle", "yes", "REQUIRED", 1, null, true]) {
    assert.equal(parsePortalSnapshot({ ...withAttention, spaces: [{ ...withAttention.spaces[0], attention: bad }] }), null, JSON.stringify(bad));
  }
  for (const bad of ["required", "none", "running", 1, null, true]) {
    assert.equal(parsePortalSnapshot({ ...withAttention, spaces: [{ ...withAttention.spaces[0], working: bad }] }), null, JSON.stringify(bad));
  }
});

test("the portable rail marks each space button green when working and yellow when needing attention without full-screen glow", async () => {
  const { PortableHostShell } = await import("../../packages/plugin/src/client/host-shell.tsx");
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const f = fixture();
  Object.assign(f.controller, {
    ui: { phase: "ready", role: { role: "workspace", profileId: "entry", managerId: "spaces-hub", unavailable: false, reasons: [] },
      inventory: { serviceEpoch: epoch, managerId: "spaces-hub", spaces: [
        { id: "spaces-hub", displayName: "Manager", generation: 1, status: "running" },
        { id: "alpha", displayName: "Alpha", generation: 1, status: "running", attention: "required", working: "busy" },
        { id: "beta", displayName: "Beta", generation: 2, status: "running", attention: "none", working: "busy" },
        { id: "gamma", displayName: "Gamma", generation: 3, status: "running", attention: "none", working: "idle" },
      ] },
      portal: { src: "http://127.0.0.1:3091/portal-bootstrap/x", origin: "http://127.0.0.1:3091", channel }, visible: "portal",
      selected: null, pending: null, detail: null, portalFailure: null, error: null, creationFailed: null, hostGlow: "working" },
  });
  const html = renderToStaticMarkup(React.createElement(PortableHostShell, { controller: f.controller }));
  assert.ok(!html.includes("dsh-host-glow"), "no full-screen host glow element is rendered");
  assert.ok(html.includes('data-attention="required"'), "the portable rail shows the attention halo");
  const pinnedButton = html.match(/<button[^>]*data-pinned="true"[^>]*>/)?.[0] ?? "";
  assert.ok(pinnedButton.includes('data-glow="working"'), "the pinned main space button shows working green glow");
  const alphaButton = html.match(/<button[^>]*data-space-id="alpha"[^>]*>/)?.[0] ?? "";
  assert.ok(alphaButton.includes('data-glow="attention"'), "attention yellow overrides working green on alpha");
  assert.match(alphaButton, /Alpha · (等待处理|Needs attention)/, "the attention label suffix is announced");
  const betaButton = html.match(/<button[^>]*data-space-id="beta"[^>]*>/)?.[0] ?? "";
  assert.ok(betaButton.includes('data-glow="working"'), "a running space without pending attention shows green glow");
  assert.ok(!betaButton.includes('data-attention="required"'), "a 'none' space has no attention halo");
  assert.match(betaButton, /Beta · (正在工作|Working)/, "the working label suffix is announced");
  const gammaButton = html.match(/<button[^>]*data-space-id="gamma"[^>]*>/)?.[0] ?? "";
  assert.ok(!gammaButton.includes("data-glow="), "an idle space has no glow");
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
  const nativeUrl = origin + "/native/" + channel;
  assert.equal((await fetch(nativeUrl)).status, 403);
  assert.equal((await fetch(nativeUrl, { headers: { cookie: "operator=test-session", origin: parentOrigin } })).status, 403);
  assert.equal((await fetch(nativeUrl, { headers: { cookie: "operator=test-session", "sec-fetch-site": "cross-site" } })).status, 403);
  const native = await fetch(nativeUrl, { headers: { cookie: "operator=test-session" } });
  assert.equal(native.status, 200);
  assert.match(native.headers.get("content-security-policy")!, /frame-ancestors 'none'$/);
  assert.match(await native.text(), /const native = true/);
  assert.equal((await fetch(origin + "/api/workbench/state", { method: "POST", headers: { cookie: "operator=test-session", origin: parentOrigin }, body: "{}" })).status, 403);
});

function fixture(origin = parentOrigin, hasManager = true) {
  const calls: string[] = [], timers = new Map<number, () => void>(); let timer = 0;
  const env: HostShellEnvironment = { origin: () => origin, channel: () => channel,
    setTimeout: fn => { timers.set(++timer, fn); return timer as never; }, clearTimeout: id => { timers.delete(id as never); } };
  const guide: WorkbenchGuideApi = {
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

test("real Web portal selection failure is accepted immediately by the strict host envelope", async () => {
  const f = fixture(); f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
  f.controller.handleMessage(f.event({ type: 'state', snapshot: inventory })); f.controller.select('alpha');
  const requestId = f.controller.getSnapshot().pending;
  const sent: any[] = [];
  const source = renderPortalPage(audience, 'http://127.0.0.1:3103').match(/<script>([\s\S]*)<\/script>/)![1];
  new Script(source + `\nrejected(${requestId}, "alpha");`).runInNewContext({
    parent: { postMessage: (value: unknown) => sent.push(value) }, window: { addEventListener() {} },
    location: { origin: 'http://127.0.0.1:3088' }, document: {}, AbortController, AbortSignal,
    fetch: () => new Promise(() => {}), setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  });
  assert.equal(sent.length, 1);
  assert.equal(Object.keys(sent[0]).sort().join(','), 'channel,requestId,source,type');
  f.controller.handleMessage({ source: f.frame, origin: 'http://127.0.0.1:3088', data: sent[0] });
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.controller.getSnapshot().error, 'entry');
  f.controller.stop();
});

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

test("cached stopped rows reach manager authority, latest click wins, and failed channels do not reconnect", async () => {
  const f = fixture(); f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
  f.controller.handleMessage(f.event({ type: "state", snapshot: inventory }));
  f.controller.select("beta"); assert.equal(f.messages.length, 1); assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.messages[0].spaceId, "beta");
  f.controller.select("alpha"); const old = f.messages[1].requestId;
  f.controller.select(null); const current = f.messages[2].requestId;
  f.controller.handleMessage(f.event({ type: "selected", requestId: old, spaceId: "alpha" }));
  assert.equal(f.controller.getSnapshot().pending, current);
  f.controller.showCurrent();
  f.controller.handleMessage(f.event({ type: "selected", requestId: current, spaceId: null }));
  assert.equal(f.controller.getSnapshot().visible, "current");
  f.controller.handleMessage(f.event({ type: "failed", failure: { reason: "manager-disconnected" } }));
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

test("a stopped supervisor offers one explicit start that cold-starts only on click", async () => {
  const f = fixture();
  let portalCalls = 0;
  f.guide.portalTarget = async () => {
    f.calls.push("portalTarget"); portalCalls += 1;
    if (portalCalls === 1) return { available: false, unavailable: false, origin: null, path: null, reasons: [] };
    return { available: true, unavailable: false, origin: "http://127.0.0.1:3088", path: "/portal-bootstrap/" + "a".repeat(32), reasons: [] };
  };
  f.controller.start(); await tick();
  assert.equal(f.controller.getSnapshot().phase, "start");
  assert.deepEqual(f.calls, ["role", "portalTarget"]);
  await f.controller.initialize();
  assert.equal(f.calls.filter(name => name === "initialize").length, 1);
  assert.deepEqual(f.calls, ["role", "portalTarget", "initialize", "portalTarget"]);
  await f.controller.initialize();
  assert.equal(f.calls.filter(name => name === "initialize").length, 1);
  f.controller.stop();
});

test("a permanently unavailable supervisor still fails without a start affordance", async () => {
  const f = fixture();
  f.guide.portalTarget = async () => { f.calls.push("portalTarget"); return { available: false, unavailable: true, origin: null, path: null, reasons: ["blocked"] }; };
  f.controller.start(); await tick();
  assert.equal(f.controller.getSnapshot().phase, "failed");
  assert.equal(f.controller.getSnapshot().error, "entry");
  assert.deepEqual(f.calls, ["role", "portalTarget"]);
  f.controller.stop();
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

test("manager surface validates existing parent generation and cannot navigate through a stopped entry", async () => {
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
  await tick();
  assert.equal((replies[0] as { type: string }).type, "selection-failed");
  listener!(event("alpha", 2) as never);
  await tick();
  assert.deepEqual(navigations, ["alpha"]);
  assert.equal((replies[1] as { type: string }).type, "selected");
  listener!(event(null, 1) as never); assert.equal(replies.length, 2);
  dispose(); assert.equal(listener, null);
});

test("the native surface opens the create dialog only for a valid create intent", async () => {
  const appSource = readFileSync(new URL("../../packages/plugin/src/workbench/app.tsx", import.meta.url), "utf8");
  assert.ok(!appSource.includes("parent.location"), "the guest must not read the cross-origin parent location");
  assert.ok(!appSource.includes("isNativeCreateIntent"), "the guest must not read the create intent from the parent");
  const replies: unknown[] = [];
  const parent = { postMessage: (data: unknown) => replies.push(data) };
  const view = { parentOrigin, spaceId: "spaces-hub", generation: 1, serviceEpoch: epoch, channel: "manager-channel" };
  const opened: string[] = [];
  let ui: any = { boot: "ready", state: { ...inventory, availability: "available" }, selected: "home", pendingId: null, viewError: null, overlay: null };
  const subscribers = new Set<() => void>();
  const notify = () => { for (const fn of subscribers) fn(); };
  const controller = {
    subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
    getSnapshot: () => ui,
    selectHome() { ui = { ...ui, selected: "home" }; notify(); },
    closeOverlay() { ui = { ...ui, overlay: null }; notify(); },
    openSettings() { ui = { ...ui, overlay: { type: "settings" } }; notify(); },
    openCreate() { opened.push("create"); ui = { ...ui, overlay: { type: "create" } }; notify(); },
    selectRunningSpace() { return false; },
  };
  let listener: ((e: MessageEvent) => void) | null = null;
  const pages: (string | null)[] = [];
  const dispose = attachSurfaceBridge(controller as never, view, parent, fn => { listener = fn; return () => { listener = null; }; },
    page => { pages.push(page); });
  assert.equal((replies[0] as { type: string }).type, "ready"); replies.length = 0;
  const event = (data: object, overrides: object = {}) => ({ source: parent, origin: parentOrigin, data, ...overrides });
  const selection = (requestId: number) => event({ source: "dsh-spaces-surface-parent", type: "select", requestId,
    serviceEpoch: epoch, spaceId: "spaces-hub", generation: 1, channel: view.channel, target: "@settings" });
  const intent = (requestId: number, data: object = {}, overrides: object = {}) => event({ source: "dsh-spaces-surface-parent",
    type: "intent", intent: "create", requestId, serviceEpoch: epoch, spaceId: "spaces-hub", generation: 1, channel: view.channel, ...data }, overrides);
  // The intent only counts on the settings page of the native surface.
  listener!(intent(1) as never); await tick();
  assert.deepEqual(opened, [], "an intent before the settings page is ignored");
  listener!(selection(1) as never); await tick();
  assert.deepEqual(pages, ["settings"]);
  assert.equal((replies.at(-1) as { type: string }).type, "selected");
  listener!(intent(2) as never); await tick();
  assert.deepEqual(opened, ["create"], "a valid create intent opens the dialog once");
  listener!(intent(2) as never); await tick();
  assert.deepEqual(opened, ["create"], "a repeated create intent is ignored");
  for (const broken of [intent(3, { intent: "delete" }), intent(4, { type: "select" }), intent(5, { source: "other" }),
    intent(6, { serviceEpoch: "ff".repeat(32) }), intent(7, { channel: "other" }), intent(8, { spaceId: "alpha" }),
    intent(9, { generation: 2 }), intent(10, { requestId: 0 }), intent(11, { requestId: 1.5 }), intent(12, { token: "private" }),
    intent(13, {}, { origin: "http://127.0.0.1:1" }), intent(14, {}, { source: {} })]) {
    listener!(broken as never); await tick();
  }
  assert.deepEqual(opened, ["create"], "an invalid create intent is ignored");
  dispose();
  // A portable surface has no create intent at all.
  const portable: string[] = [];
  let portableListener: ((e: MessageEvent) => void) | null = null;
  const disposePortable = attachSurfaceBridge({ ...controller, openCreate() { portable.push("create"); } } as never, view, parent,
    fn => { portableListener = fn; return () => { portableListener = null; }; });
  portableListener!(intent(20) as never); await tick();
  assert.deepEqual(portable, [], "a portable surface ignores the create intent");
  disposePortable();
});

test("host surfaces take background and text color from DSH 0.2 theme tokens", async () => {
  const { HOST_SHELL_CSS } = await import("../../packages/plugin/src/client/host-shell.tsx");
  const clientIndex = await readFile(new URL("../../packages/plugin/src/client/index.tsx", import.meta.url), "utf8");
  const rule = (name: string) => HOST_SHELL_CSS.split(`${name} {`)[1]?.split("}")[0] ?? "";
  for (const name of [".dsh-host-surface", ".dsh-host-loading"]) {
    assert.ok(rule(name).includes("--dsw-alias-bg-base"), name);
    assert.ok(rule(name).includes("color:var(--dsw-alias-label-primary"), name);
  }
  assert.ok(rule(".dsh-host-guide").includes("color:var(--dsw-alias-label-primary"));
  assert.ok(rule(".dsh-host-rail").includes("--dsw-alias-bg-base"));
  assert.ok(clientIndex.includes('background: "var(--dsw-alias-bg-base'));
  assert.ok(clientIndex.includes('color: "var(--dsw-alias-label-primary'));
  for (const text of [HOST_SHELL_CSS, clientIndex]) assert.ok(!text.includes("--dsw-alias-app-bg"));
});

test("every --dsw-* token used in source exists in the installed DSH client UI", () => {
  // Taken from the installed @deepseek-ai client packages (this checkout: 0.2.2-rc.1),
  // not a frozen allowlist. A token counts when official CSS or JS uses it.
  const sdkTokens = installedClientThemeTokens();
  assert.ok(sdkTokens.has("--dsw-radius-sm"), "installed client UI did not expose --dsw-radius-sm");
  const roots = [new URL("../../src", import.meta.url), new URL("../../packages", import.meta.url)];
  const pending = roots.map(url => fileURLToPath(url));
  const used = new Map<string, string[]>();
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "lib") pending.push(path); continue; }
      if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
      for (const token of readFileSync(path, "utf8").match(/--dsw-[a-z0-9-]+/g) ?? [])
        used.set(token, [...(used.get(token) ?? []), path]);
    }
  }
  for (const [token, files] of used)
    assert.ok(sdkTokens.has(token), `${token} is not used by the installed DSH client UI (used in ${[...new Set(files)].join(", ")})`);
});

function installedClientThemeTokens(): Set<string> {
  const root = fileURLToPath(new URL("../../node_modules/@deepseek-ai", import.meta.url));
  const tokens = new Set<string>();
  const pending = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(dsh-client-ui-|dsh-experimental-client-ui-|dsh-brand)/.test(entry.name))
    .map((entry) => join(root, entry.name));
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") pending.push(path);
        continue;
      }
      if (!/\.(css|js)$/.test(entry.name)) continue;
      for (const token of readFileSync(path, "utf8").match(/--dsw-[a-z0-9-]+/g) ?? []) tokens.add(token);
    }
  }
  assert.ok(tokens.size > 10, "installed DSH client UI did not expose theme tokens");
  return tokens;
}

test("failed portal reads its failure once without reconnect or launch", async () => {
  const f = fixture();
  f.guide.portalTarget = async () => { f.calls.push("portalTarget"); return { available: false, unavailable: true, origin: null, path: null, reasons: [] }; };
  f.guide.presentationSnapshot = async () => { f.calls.push("presentationSnapshot"); throw new Error("Snapshot failed EACCES lstat C:\\private\\file"); };
  f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
  await tick();
  assert.match(f.controller.getSnapshot().detail!, /EACCES lstat \[path\]/);
  assert.deepEqual(f.calls, ["role", "portalTarget", "presentationSnapshot"]);
  assert.equal(f.controller.getSnapshot().portal, null); f.controller.stop();
});

test("failed initialization preserves sanitized reported reasons instead of a generic snapshot error", async () => {
  const f = fixture(parentOrigin, false);
  f.guide.initialize = async () => {
    f.calls.push("initialize");
    return { ok: false, connected: false, unavailable: true, origin: null, path: null, managerId: null,
      reasons: ["Selected component payload digest mismatch.", "EACCES lstat C:\\private\\payload; token=synthetic-private-token"] };
  };
  f.guide.presentationSnapshot = async () => { f.calls.push("presentationSnapshot"); throw new Error("The workbench entry is not available yet."); };
  f.controller.start(); await tick(); await f.controller.initialize(); await tick();
  const ui = f.controller.getSnapshot();
  assert.equal(ui.phase, "failed"); assert.equal(ui.error, "unavailable");
  assert.match(ui.detail!, /^Selected component payload digest mismatch\.\nEACCES lstat \[path\]/);
  assert.doesNotMatch(ui.detail!, /synthetic-private|C:\\private|not available yet/);
  await f.controller.initialize();
  assert.deepEqual(f.calls, ["role", "initialize"]); f.controller.stop();
});

test("thrown initialization and portal causes are sanitized and retained without another read or launch", async () => {
  for (const stage of ["initialize", "portalTarget"] as const) {
    const f = fixture(parentOrigin, stage === "portalTarget");
    f.guide[stage] = async () => {
      f.calls.push(stage);
      throw new Error("Plugin load failed EACCES open C:\\private\\plugin; Authorization: Bearer synthetic-private-token");
    };
    f.guide.presentationSnapshot = async () => { f.calls.push("presentationSnapshot"); throw new Error("Generic unavailable"); };
    f.controller.start(); await tick();
    if (stage === "initialize") await f.controller.initialize();
    await tick();
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.match(f.controller.getSnapshot().detail!, /Plugin load failed EACCES open \[path\]/);
    assert.doesNotMatch(f.controller.getSnapshot().detail!, /synthetic-private|C:\\private|Generic unavailable/);
    assert.deepEqual(f.calls, ["role", stage]); f.controller.stop();
  }
});

test("unavailable role and portal retain their reported reason", async () => {
  for (const stage of ["role", "portalTarget"] as const) {
    const f = fixture();
    if (stage === "role") f.guide.role = async () => {
      f.calls.push("role");
      return { role: "workspace", profileId: "entry", managerId: "spaces-hub", unavailable: true, reasons: ["Host ownership is ambiguous."] };
    };
    else f.guide.portalTarget = async () => {
      f.calls.push("portalTarget");
      return { available: false, unavailable: true, origin: null, path: null, reasons: ["Host ownership is ambiguous."] };
    };
    f.controller.start(); await tick();
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.equal(f.controller.getSnapshot().detail, "Host ownership is ambiguous.");
    assert.deepEqual(f.calls, stage === "role" ? ["role"] : ["role", "portalTarget"]); f.controller.stop();
  }
});

test("late initialization and portal errors cannot cross controller lifetimes", async () => {
  for (const stage of ["initialize", "portalTarget"] as const) {
    const f = fixture(parentOrigin, stage === "portalTarget");
    const pending = Promise.withResolvers<never>();
    const originalInitialize = f.guide.initialize, originalPortalTarget = f.guide.portalTarget;
    f.guide[stage] = () => { f.calls.push(stage); return pending.promise; };
    f.controller.start(); await tick();
    const initializing = stage === "initialize" ? f.controller.initialize() : Promise.resolve();
    f.controller.stop();
    f.guide.initialize = originalInitialize; f.guide.portalTarget = originalPortalTarget;
    f.controller.start(); await tick();
    const current = f.controller.getSnapshot();
    pending.reject(new Error("Obsolete lifetime failure")); await initializing; await tick();
    assert.strictEqual(f.controller.getSnapshot(), current);
    assert.equal(current.detail, null); f.controller.stop();
  }
});

test("late failure observation cannot replace a newer cause or keep old detail on a new launch", async () => {
  const f = fixture(); const observed = Promise.withResolvers<never>();
  f.guide.portalTarget = async () => { f.calls.push("portalTarget"); return { available: false, unavailable: true, origin: null, path: null, reasons: [] }; };
  f.guide.presentationSnapshot = () => { f.calls.push("presentationSnapshot"); return observed.promise; };
  f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
  f.controller.stop();
  f.guide.portalTarget = async () => {
    f.calls.push("portalTarget");
    return { available: false, unavailable: true, origin: null, path: null, reasons: ["New lifetime cause"] };
  };
  f.controller.start(); await tick();
  observed.reject(new Error("Obsolete snapshot failure")); await tick();
  assert.equal(f.controller.getSnapshot().detail, "New lifetime cause");
  assert.equal(f.calls.filter(name => name === "presentationSnapshot").length, 1);
  f.controller.stop();
  f.guide.portalTarget = async () => { f.calls.push("portalTarget"); return { available: true, unavailable: false, origin: "http://127.0.0.1:3088", path: "/portal-bootstrap/" + "a".repeat(32), reasons: [] }; };
  f.controller.start();
  assert.equal(f.controller.getSnapshot().detail, null); await tick(); f.controller.stop();
});

test("a queued entry timeout from an old lifetime cannot fail the new portal", async () => {
  const f = fixture(); f.controller.start(); await tick();
  const oldTimeout = [...f.timers.values()][0];
  f.controller.stop(); f.controller.start(); await tick();
  const current = f.controller.getSnapshot(); oldTimeout();
  assert.strictEqual(f.controller.getSnapshot(), current);
  assert.equal(current.phase, "connecting"); f.controller.stop();
});

test("guide details redact complete authentication headers",async()=>{
 const {publicGuideDetail}=await import("../../packages/plugin/src/client/guide-detail.ts");
 assert.doesNotMatch(publicGuideDetail("Authorization: Basic c3ludGhldGljOm9ubHk="),/c3ludGhldGlj/);
 assert.doesNotMatch(publicGuideDetail("Cookie: sid=synthetic-one; remember=synthetic-two"),/synthetic-/);
});

function portalFixture() {
  const origin = "http://127.0.0.1:3088", managerOrigin = "http://127.0.0.1:3091";
  let state: unknown = { ...inventory, protocolVersion: 2, availability: "ready",
    spaces: inventory.spaces.map(row => ({ ...row, hasWebApp: true })) };
  const view = { spaceId: "spaces-hub", generation: 1, serviceEpoch: epoch, origin: managerOrigin,
    entryOrigin: origin, entryPath: "/view/spaces-hub/1", channel: "manager-channel" };
  const sent: any[] = [], forwarded: any[] = [], requests: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const listeners = new Map<string, (event: any) => void>();
  let clock = 0, removed = 0, response: (() => Response | Promise<Response>) | null = null;
  const frame = { contentWindow: { postMessage: (message: unknown) => forwarded.push(message) },
    addEventListener() {}, remove: () => removed++ };
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const deadline = new AbortController();
  const script = renderPortalPage(audience, managerOrigin).match(/<script>([\s\S]*)<\/script>/)![1];
  new Script(script).runInNewContext({
    parent, window: { addEventListener: (name: string, fn: (event: any) => void) => listeners.set(name, fn) },
    location: { origin }, document: { createElement: () => frame, body: { append() {} }, getElementById: () => ({ remove() {} }) },
    AbortController, AbortSignal: { any: AbortSignal.any, timeout: () => deadline.signal }, TextDecoder,
    fetch: async (path: string, options: RequestInit) => {
      requests.push(path);
      if (response) return response();
      if (options.signal?.aborted) throw new Error("private aborted request");
      return Response.json({ ok: true, value: path.endsWith("/state") ? state : view });
    },
    setInterval: (fn: () => void, ms: number) => { timers.set(++clock, { fn, ms }); return clock; },
    clearInterval: (id: number) => timers.delete(id),
    setTimeout: (fn: () => void, ms: number) => { timers.set(++clock, { fn, ms }); return clock; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const message = (data: object, overrides: object = {}) => listeners.get("message")!({
    source: frame.contentWindow, origin: managerOrigin,
    data: { serviceEpoch: view.serviceEpoch, spaceId: view.spaceId, generation: view.generation, channel: view.channel, source: "dsh-spaces-view", ...data }, ...overrides,
  });
  const select = (spaceId = "alpha", requestId = 1) => listeners.get("message")!({ source: parent, origin: parentOrigin,
    data: { source: "dsh-spaces-portal-parent", channel, type: "select", requestId, spaceId } });
  const refresh = async () => { [...timers.values()].find(timer => timer.ms === 1500)?.fn(); await tick(); };
  return { sent, forwarded, requests, timers, frame, view, message, select, refresh, deadline,
    removed: () => removed, setState: (next: unknown) => { state = next; }, state: () => state as any,
    setResponse: (next: (() => Response | Promise<Response>) | null) => { response = next; } };
}

test("portal forwards a cached stopped member once for current manager authorization", async () => {
  const p = portalFixture(); await tick();
  p.select("beta"); await tick();
  p.message({ state: "ready" });
  p.message({ source: "dsh-spaces-surface", type: "ready" });
  assert.equal(p.forwarded.length, 1);
  assert.equal(p.forwarded[0].target, "beta");
  assert.equal(p.requests.filter(path => path.endsWith("/view")).length, 1);
  p.select("spaces-hub", 2); p.select("unknown", 3);
  assert.equal(p.forwarded.length, 1);
  assert.equal(p.sent.filter(message => message.type === "selection-failed").length, 2);
});

test("portal failure DTO rejects arbitrary codes, credentials, URLs and unbounded status", () => {
  assert.deepEqual(parsePortalFailure({ reason: "state-request", status: 503, code: "workbench/unavailable" }),
    { reason: "state-request", status: 503, code: "workbench/unavailable" });
  for (const value of [null, [], {}, { reason: "https://private/token" },
    { reason: "state-request", code: "workbench/private-token" }, { reason: "state-request", status: NaN },
    { reason: "state-request", status: Infinity }, { reason: "state-request", status: 503.5 },
    { reason: "state-request", status: 600 }, { reason: "state-request", status: 99 },
    { reason: "state-request", status: "401" }, { reason: "state-request", code: undefined },
    { reason: "state-request", message: "private error" }, { reason: "state-request", grant: "private" },
    { reason: "state-request", url: "http://private" }]) assert.equal(parsePortalFailure(value), null);
  assert.deepEqual(parsePortalFailure(Object.assign(Object.create({ code: "private", status: "private" }), { reason: "state-request" })),
    { reason: "state-request" });
});

test("host keeps each terminal portal cause and rejects malicious authenticated envelopes", async () => {
  for (const reason of PORTAL_FAILURE_REASONS) {
    const f = fixture(); f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
    const failure = { reason, code: "workbench/unavailable", status: 503 };
    const valid = f.event({ type: "failed", failure });
    for (const event of [{ ...valid, source: {} }, { ...valid, origin: "http://127.0.0.1:1" },
      f.event({ ...valid.data, channel: "ff".repeat(16) }), f.event({ ...valid.data, source: "other" }),
      f.event({ ...valid.data, token: "private" }), f.event({ type: "failed", failure: { reason, code: "workbench/secret" } }),
      f.event({ type: "failed", failure: { reason, error: "private error" } })]) {
      f.controller.handleMessage(event);
      assert.equal(f.controller.getSnapshot().phase, "connecting");
    }
    f.guide.presentationSnapshot = async () => { throw Error("Generic private error must not replace a known cause"); };
    f.controller.handleMessage(valid);
    const failed = f.controller.getSnapshot();
    assert.deepEqual(failed.portalFailure, failure);
    assert.equal(failed.phase, "failed"); assert.equal(failed.portal, null); assert.equal(failed.inventory, null);
    assert.match(failed.detail!, /HTTP 503.*workbench\/unavailable/);
    if (reason === "state-request" || reason === "manager-disconnected") assert.equal(failed.error, "unavailable");
    f.controller.handleMessage(f.event({ type: "failed", failure: { reason: "manager-stopped" } }));
    f.controller.select(null); await f.controller.initialize(); await tick();
    assert.strictEqual(f.controller.getSnapshot().portalFailure, failed.portalFailure);
    assert.deepEqual(f.calls, ["role", "portalTarget"]); f.controller.stop();
  }
});

test("rendered portal distinguishes state HTTP, transport, deadline, malformed and invalid data", async () => {
  const cases = [
    { name: "401", reason: "state-request", response: () => Response.json({ ok: false, error: { code: "workbench/unauthorized", message: "private token" } }, { status: 401 }), code: "workbench/unauthorized", status: 401 },
    { name: "503", reason: "state-request", response: () => Response.json({ ok: false, error: { code: "workbench/unavailable" } }, { status: 503 }), code: "workbench/unavailable", status: 503 },
    { name: "unknown code", reason: "state-request", response: () => Response.json({ ok: false, error: { code: "workbench/private-token", url: "http://private/grant" } }, { status: 403 }), status: 403 },
    { name: "HTTP non-JSON", reason: "state-request", response: () => new Response("private failure", { status: 503 }), status: 503 },
    { name: "transport", reason: "state-request", response: () => { throw Error("http://private/?token=private"); }, code: "portal/transport-failed" },
    { name: "deadline", reason: "state-request", response: () => { throw Error("private deadline"); }, code: "portal/request-deadline" },
    { name: "malformed", reason: "state-invalid", response: () => new Response("private not JSON"), code: "portal/response-invalid", status: 200 },
    { name: "invalid envelope", reason: "state-invalid", response: () => Response.json({ token: "private" }), code: "portal/response-invalid", status: 200 },
    { name: "invalid data", reason: "state-invalid", response: () => Response.json({ ok: true, value: { protocolVersion: 2 } }) },
  ];
  for (const item of cases) {
    const p = portalFixture(); await tick();
    if (item.name === "deadline") p.deadline.abort();
    p.setResponse(item.response); await p.refresh();
    const failures = p.sent.filter(message => message.type === "failed");
    assert.equal(failures.length, 1, item.name);
    assert.deepEqual(JSON.parse(JSON.stringify(failures[0].failure)), { reason: item.reason,
      ...(item.code ? { code: item.code } : {}), ...(item.status ? { status: item.status } : {}) });
    assert.doesNotMatch(JSON.stringify(failures), /private|http:|token|grant/);
    const count = p.requests.length; await p.refresh(); p.select();
    assert.equal(p.requests.length, count); assert.equal(p.timers.size, 0);
  }
});

test("rendered portal distinguishes epoch, generation, manager stop, view errors and readiness deadline", async () => {
  for (const reason of ["service-changed", "manager-generation-changed", "manager-stopped", "manager-disconnected", "manager-view-failed", "view-ready-timeout",
    "manager-view-request", "manager-view-invalid"]) {
    const p = portalFixture(); await tick();
    if (reason === "manager-view-request") p.setResponse(() => Response.json({ ok: false, error: { code: "workbench/forbidden" } }, { status: 403 }));
    if (reason === "manager-view-invalid") p.setResponse(() => Response.json({ ok: true, value: { ...p.view, origin: "http://private" } }));
    p.select(); await tick();
    if (reason === "service-changed") { p.setState({ ...p.state(), serviceEpoch: "ff".repeat(32) }); await p.refresh(); }
    if (reason === "manager-generation-changed" || reason === "manager-stopped") {
      p.setState({ ...p.state(), spaces: p.state().spaces.map((row: any) => row.id === "spaces-hub"
        ? { ...row, ...(reason === "manager-stopped" ? { status: "stopped" } : { generation: 2 }) } : row) });
      await p.refresh();
    }
    if (reason === "manager-disconnected" || reason === "manager-view-failed") p.message({ state: reason === "manager-disconnected" ? "disconnected" : "failed", message: "http://private/token" });
    if (reason === "view-ready-timeout") [...p.timers.values()].find(timer => timer.ms === 35000)!.fn();
    const failures = p.sent.filter(message => message.type === "failed");
    assert.equal(failures.length, 1, reason); assert.equal(failures[0].failure.reason, reason);
    assert.doesNotMatch(JSON.stringify(failures), /private|http:|token/);
    const count = p.requests.length;
    p.message({ state: "ready" }); p.select(); await p.refresh();
    assert.equal(p.requests.length, count); assert.equal(p.timers.size, 0);
    assert.equal(p.removed(), reason.startsWith("manager-view-") && reason !== "manager-view-failed" ? 0 : 1);
  }
});

test("portal detects manager stop and generation change before a manager iframe is opened", async () => {
  for (const reason of ["manager-stopped", "manager-generation-changed"]) {
    const p = portalFixture(); await tick();
    p.setState({ ...p.state(), spaces: p.state().spaces.map((row: any) => row.id === "spaces-hub"
      ? { ...row, ...(reason === "manager-stopped" ? { status: "stopped" } : { generation: 2 }) } : row) });
    await p.refresh();
    assert.equal(p.sent.at(-1).failure.reason, reason);
    assert.equal(p.requests.some(path => path.endsWith("/view")), false);
  }
});

test("portal entry deadline has its own terminal cause and cannot be replaced by later state", async () => {
  const f = fixture(); f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
  [...f.timers.values()][0]();
  assert.deepEqual(f.controller.getSnapshot().portalFailure, { reason: "portal-entry-timeout" });
  assert.equal(f.controller.getSnapshot().error, "unavailable");
  assert.match(f.controller.getSnapshot().detail!, /entry deadline/);
  f.controller.handleMessage(f.event({ type: "state", snapshot: inventory }));
  assert.equal(f.controller.getSnapshot().phase, "failed");
  assert.deepEqual(f.calls, ["role", "portalTarget"]); f.controller.stop();
});

test("portal uses exact manager origin/source/identity and both readiness signals before forwarding", async () => {
  const p = portalFixture(); await tick(); p.select(); await tick();
  for (const overrides of [{ source: {} }, { origin: parentOrigin }]) p.message({ state: "disconnected" }, overrides);
  for (const identity of [{ channel: "wrong" }, { serviceEpoch: "ff".repeat(32) }, { generation: 2 }, { spaceId: "alpha" }, { source: "other" }, { token: "private" }])
    p.message({ state: "disconnected", ...identity });
  assert.equal(p.sent.some(message => message.type === "failed"), false);
  p.message({ source: "dsh-spaces-surface", type: "ready" });
  assert.equal(p.forwarded.length, 0);
  // Exercise the real bridge through initial SDK connecting/disconnected, then boot handoff.
  let connectionState: ReturnType<ViewConnectionState["getSnapshot"]> = undefined, subscriber = () => {};
  let boot: { parentElement: ParentNode } | null = { parentElement: {} as ParentNode };
  const bridge = startViewBridge({ slots: { inject: (_name, effect) => effect() } },
    { ...p.view, parentOrigin: "http://127.0.0.1:3088" }, {
      parent: { postMessage: (data: unknown) => p.message(data as object) },
      connection: { state: { getSnapshot: () => connectionState, subscribe: fn => { subscriber = fn; return () => {}; } } },
      bootWatch: { findBoot: () => boot, hasAppDom: () => true, observe: () => () => {} },
      addMessageListener: () => () => {}, delay: () => 1, cancelDelay() {},
    });
  connectionState = "connecting"; subscriber();
  connectionState = "disconnected"; subscriber();
  assert.equal(p.sent.some(message => message.type === "failed"), false);
  boot = null; connectionState = "connected"; subscriber();
  assert.equal(p.forwarded.length, 1);
  p.message({ source: "dsh-spaces-surface", type: "selection-failed", requestId: 1, target: "alpha" });
  assert.equal(p.sent.at(-1).type, "selection-failed");
  assert.equal(p.sent.some(message => message.type === "failed"), false);
  connectionState = "disconnected"; subscriber();
  assert.equal(p.sent.at(-1).failure.reason, "manager-disconnected");
  const count = p.requests.length;
  connectionState = "connected"; subscriber(); p.select(); await p.refresh();
  assert.equal(p.requests.length, count); assert.equal(p.sent.filter(message => message.type === "failed").length, 1);
  bridge();
});

test("portal creation entries validate strictly and project from jobs", async () => {
  const { projectSpaceCreations, spaceCreateStep } = await import("../../src/shared/space-host.ts");
  const base = { serviceEpoch: "a".repeat(64), managerId: null, spaces: [] };
  assert.deepEqual(parsePortalSnapshot(base), { serviceEpoch: base.serviceEpoch, managerId: null, spaces: [] });
  const creation = { jobId: "j1", spaceId: "new-space", displayName: "New", status: "running", phase: "install", message: "DSH 0.9.9", icon: "whale" };
  const withCreating = parsePortalSnapshot({ ...base, creating: [creation] });
  assert.deepEqual(withCreating?.creating, [creation]);
  const failed = { ...creation, status: "failed", error: "boom", message: "" };
  assert.deepEqual(parsePortalSnapshot({ ...base, creating: [failed] })?.creating, [failed]);
  for (const bad of [
    { ...creation, error: "x" },                       // error on a non-failed entry
    { ...creation, spaceId: "BAD" },
    { ...creation, status: "succeeded" },
    { ...creation, extra: 1 },
    { ...creation, icon: "javascript:alert(1)" },
    { ...creation, jobId: "x".repeat(81) },
    { ...creation, message: "x".repeat(2001) },
  ]) assert.equal(parsePortalSnapshot({ ...base, creating: [bad] }), null, JSON.stringify(bad));
  assert.equal(parsePortalSnapshot({ ...base, creating: Array(17).fill(creation) }), null);
  assert.deepEqual(spaceCreateStep("install").index, 0);
  assert.deepEqual(spaceCreateStep("create").index, 1);
  assert.deepEqual(spaceCreateStep("view-bridge").index, 2);
  assert.deepEqual(spaceCreateStep("models-sync").index, 3);
  // The creator pipeline's later stages share the last step instead of
  // rewinding to 0: plugin installs, the optional start and the result phase.
  for (const phase of ["plugins", "plugin", "start", "result"]) {
    assert.deepEqual(spaceCreateStep(phase).index, 3, `phase ${phase}`);
  }
  const creatorPath = ["prepare", "install", "create", "view-bridge", "models-sync", "plugins", "start", "result"];
  const creatorSteps = creatorPath.map((phase) => spaceCreateStep(phase).index);
  assert.ok(creatorSteps.every((step, i) => i === 0 || step >= creatorSteps[i - 1]), `creator steps: ${creatorSteps.join(",")}`);
  assert.deepEqual(spaceCreateStep("mystery").index, 0);
  const job = (over: Record<string, unknown>) => ({ id: "j", kind: "space.create", status: "running", phase: "create",
    message: "", affectedSpaceIds: [], createdAt: "t", updatedAt: "t", canCancel: false, ...over });
  const rows = projectSpaceCreations([
    job({ id: "a", result: { spaceId: "made-one" }, subject: { displayName: "Made", icon: "code" } }),
    job({ id: "b", status: "succeeded", result: { spaceId: "skip-me" } }),
    job({ id: "c", kind: "space.start" }),
    job({ id: "d", status: "failed", affectedSpaceIds: ["lost-one"], error: { code: "workbench/failed", message: "nope" }, updatedAt: "2026-01-01" }),
  ]);
  assert.deepEqual(rows.map(r => [r.jobId, r.spaceId, r.status]), [["a", "made-one", "running"], ["d", "lost-one", "failed"]]);
  assert.equal(rows[1].error, "nope");
  const many = Array.from({ length: 10 }, (_, i) =>
    job({ id: `f${i}`, status: "failed", affectedSpaceIds: [`lost-${i}`], error: { message: "x" }, updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}` }));
  assert.equal(projectSpaceCreations(many).filter(r => r.status === "failed").length, 8);
  // creator.create jobs project through the same placeholder contract.
  const creatorJob = (over: Record<string, unknown>) => ({ id: "j", kind: "creator.create", status: "running", phase: "plugins",
    message: "@acme/tool", affectedSpaceIds: ["space-demo"], createdAt: "t", updatedAt: "t", canCancel: false, ...over });
  const creatorRows = projectSpaceCreations([
    creatorJob({ id: "run", subject: { displayName: "Demo Space", icon: "whale" } }),
    creatorJob({ id: "dead", status: "failed", error: { code: "creator/failed", message: "install broke" }, updatedAt: "2026-01-02" }),
    creatorJob({ id: "done", status: "succeeded", result: { spaceId: "space-demo" } }),
  ]);
  assert.deepEqual(creatorRows.map(r => [r.jobId, r.spaceId, r.displayName, r.status, r.phase]),
    [["run", "space-demo", "Demo Space", "running", "plugins"], ["dead", "space-demo", "space-demo", "failed", "plugins"]]);
  assert.equal(creatorRows[1].error, "install broke");
  assert.equal(creatorRows[0].icon, "whale");
});

test("host rail shows active creations and keeps seen failed ones until dismissed", async () => {
  const f = fixture(); f.controller.start(); await tick(); f.controller.registerFrame(f.frame);
  const running = { jobId: "create-1", spaceId: "made-one", displayName: "Made", status: "running" as const, phase: "install", message: "DSH 0.9.9" };
  const unseen = { jobId: "create-2", spaceId: "lost-one", displayName: "Lost", status: "failed" as const, phase: "create", message: "", error: "boom" };
  f.controller.handleMessage(f.event({ type: "state", snapshot: { ...inventory, creating: [running, unseen] } }));
  assert.deepEqual(f.controller.visibleCreations().map(row => row.jobId), ["create-1"]);
  f.controller.handleMessage(f.event({ type: "state", snapshot: { ...inventory,
    creating: [{ ...running, status: "failed", message: "", error: "install broke" }, unseen] } }));
  assert.deepEqual(f.controller.visibleCreations().map(row => row.jobId), ["create-1"]);
  f.controller.openCreation(f.controller.visibleCreations()[0]);
  assert.equal(f.controller.getSnapshot().creationFailed?.jobId, "create-1");
  f.controller.closeCreationFailed();
  assert.equal(f.controller.getSnapshot().creationFailed, null);
  f.controller.openCreation(f.controller.visibleCreations()[0]);
  f.controller.dismissCreation("create-1");
  assert.deepEqual(f.controller.visibleCreations(), []);
  assert.equal(f.controller.getSnapshot().creationFailed, null);
  f.controller.handleMessage(f.event({ type: "state", snapshot: { ...inventory, creating: [running] } }));
  f.controller.openCreation(f.controller.visibleCreations()[0]);
  assert.equal((f.messages.at(-1) as { type?: string; spaceId?: string | null }).type, "select");
  assert.equal((f.messages.at(-1) as { spaceId?: string | null }).spaceId, null);
  f.controller.stop();
});

test("creation rail entries and failure dialog render labels, steps and actions", async (t) => {
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "zh-CN", languages: ["zh-CN"] } });
  t.after(() => {
    if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { CreationRailEntry, CreationFailureDialog } = await import("../../packages/plugin/src/client/ui/creation-rail.tsx");
  const el = React.createElement;
  const running = el(CreationRailEntry, { creation: { jobId: "c1", spaceId: "made-one", displayName: "Made", status: "running", phase: "create", message: "" }, layoutId: "x", onSelect: () => {} });
  const runningMarkup = renderToStaticMarkup(running);
  assert.match(runningMarkup, /data-creation-step="2"/);
  assert.match(runningMarkup, /data-creation-total="4"/);
  assert.match(runningMarkup, /Made · 正在创建/);
  assert.match(runningMarkup, /title="Made · 正在创建 · 第 2\/4 步：创建空间配置"/);
  assert.doesNotMatch(runningMarkup, /dsh-wb-creation-failed/);
  const queued = renderToStaticMarkup(el(CreationRailEntry, { creation: { jobId: "c2", spaceId: "wait-one", displayName: "Wait", status: "queued", phase: "", message: "" }, layoutId: "x", onSelect: () => {} }));
  assert.match(queued, /Wait · 等待开始/);
  assert.match(queued, /data-creation-status="queued"/);
  const failed = renderToStaticMarkup(el(CreationRailEntry, { creation: { jobId: "c3", spaceId: "lost-one", displayName: "Lost", status: "failed", phase: "create", message: "", error: "install broke", icon: "whale" }, layoutId: "x", onSelect: () => {} }));
  assert.match(failed, /data-creation-status="failed"/);
  assert.match(failed, /Lost · 创建失败：install broke/);
  assert.match(failed, /dsh-wb-creation-failed/);
  const dialog = renderToStaticMarkup(el(CreationFailureDialog, { creation: { jobId: "c3", spaceId: "lost-one", displayName: "Lost", status: "failed", phase: "create", message: "", error: "install broke" }, onView: () => {}, onDismiss: () => {}, onClose: () => {} }));
  assert.match(dialog, /空间「Lost」创建失败/);
  assert.match(dialog, /install broke/);
  assert.match(dialog, /查看任务/);
  assert.match(dialog, /移除/);
  assert.doesNotMatch(dialog, /class="dsh-host-action danger"/);
});

test("HostShellController stops activityPoller, clears poll timers, and resets hostGlow on terminal fail", async () => {
  const f = fixture();
  let clock = 0;
  const timers = new Map<number, () => void>();
  const pendingReads: { signal: AbortSignal | undefined; resolve: (value: { attention: "required" | "none" | "unknown"; working: "busy" | "idle" | "unknown" }) => void }[] = [];
  f.guide.hostActivity = (signal) => {
    f.calls.push("hostActivity");
    return new Promise((resolve) => { pendingReads.push({ signal, resolve }); });
  };
  const controller = new HostShellController(f.guide, {
    origin: () => parentOrigin,
    channel: () => channel,
    setTimeout: (fn) => { timers.set(++clock, fn); return clock as never; },
    clearTimeout: (id) => { timers.delete(id as never); },
  });

  controller.start();
  await tick();
  controller.registerFrame(f.frame);
  controller.handleMessage(f.event({ type: "state", snapshot: inventory }));
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(pendingReads.length, 1);

  // First hostActivity sample resolves working -> sets hostGlow to "working" and schedules next poll timer.
  pendingReads[0].resolve({ attention: "none", working: "busy" });
  await tick();
  assert.equal(controller.getSnapshot().hostGlow, "working");
  assert.equal(timers.size, 1, "next hostActivity poll timer is scheduled");

  // Fire the scheduled poll timer so a second hostActivity read (with its deadline timer) is in flight.
  const [pollTimerId, pollTimerFn] = [...timers.entries()][0];
  timers.delete(pollTimerId);
  pollTimerFn();
  assert.equal(pendingReads.length, 2);
  assert.equal(timers.size, 1, "read deadline timer is active during in-flight hostActivity");

  // Entering terminal failed state aborts the in-flight read, clears all poller timers, and resets hostGlow to null.
  controller.handleMessage(f.event({ type: "failed", failure: { reason: "manager-disconnected" } }));
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.equal(controller.getSnapshot().hostGlow, null);
  assert.equal(pendingReads[1].signal?.aborted, true, "in-flight hostActivity signal is aborted on fail");
  assert.equal(timers.size, 0, "no activityPoller or controller timers remain after fail");

  // Late resolution cannot restore hostGlow or schedule another poll in failed state.
  pendingReads[1].resolve({ attention: "required", working: "busy" });
  await tick();
  assert.equal(controller.getSnapshot().hostGlow, null);
  assert.equal(timers.size, 0);
  assert.equal(pendingReads.length, 2);
  controller.stop();

  // Startup failure after hostActivity already settled also resets hostGlow and stops polling.
  const g = fixture();
  let gClock = 0;
  const gTimers = new Map<number, () => void>();
  const portalGate = Promise.withResolvers<Awaited<ReturnType<typeof g.guide.portalTarget>>>();
  g.guide.hostActivity = async () => ({ attention: "required", working: "idle" });
  g.guide.portalTarget = () => portalGate.promise;
  const gController = new HostShellController(g.guide, {
    origin: () => parentOrigin,
    channel: () => channel,
    setTimeout: (fn) => { gTimers.set(++gClock, fn); return gClock as never; },
    clearTimeout: (id) => { gTimers.delete(id as never); },
  });
  gController.start();
  await tick();
  assert.equal(gController.getSnapshot().hostGlow, "attention");
  portalGate.resolve({ available: false, unavailable: true, origin: null, path: null, reasons: ["blocked"] });
  await tick();
  assert.equal(gController.getSnapshot().phase, "failed");
  assert.equal(gController.getSnapshot().hostGlow, null);
  assert.equal(gTimers.size, 0);
  gController.stop();
});
