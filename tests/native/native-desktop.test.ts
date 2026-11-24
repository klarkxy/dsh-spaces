import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeSpaceHash, nativePortalFailureHash, parseNativePortalFailureHash, portalFailureDetail,
  PORTAL_FAILURE_REASONS, PORTAL_FAILURE_CODES, NATIVE_PORTAL_FAILURE_HASH_LIMIT, parseNativeCreateIntent,
  parseNativeDetailIntent,
  type PortalFailure } from "../../src/shared/space-host.ts";
import { renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";
import { bindDshCli, invocationProfile } from "../../src/adapters/node/products/spaces-service.ts";
import { NATIVE_SELECTION_DEADLINE_MS, NativeHostController } from "../../packages/plugin/src/client/ui/native-controller.ts";
import { WorkbenchRemoteError } from "../../packages/plugin/src/client/workbench-remote.ts";
import { nativeTexts } from "../../packages/plugin/src/client/ui/native-texts.ts";
import { NativeBrowserHost } from "../../packages/plugin/src/client/native-browser-host.ts";
import type { ClientFailureReport, DesktopLaunchState } from "../../packages/plugin/src/types.ts";
import { BROWSER_RELAY, BROWSER_RESULT, nativeBrowserFragment, parseNativeBrowserFragment, browserProtocolScript,
  type BrowserRelay } from "../../src/shared/browser-guest.ts";
import { parseNavDiag } from "../../src/shared/nav-diag.ts";

const browserIdentity = { spaceId: "browser", generation: 1, serviceEpoch: "a".repeat(64), origin: "http://127.0.0.1:3335", channel: "child-channel" };

/** Ready host record for one fixture. Epoch and manager come from that fixture, not a hidden fallback. */
function readyLaunchRecord(serviceEpoch: string, managerId: string | null): DesktopLaunchState {
  return { operationId: "launch-one", phase: "ready", serviceEpoch, managerId, reasons: [], failure: null };
}
function readyLaunchApi(serviceEpoch: string, managerId: string | null, calls?: string[]) {
  return {
    beginDesktopLaunch: async () => { calls?.push("begin"); return readyLaunchRecord(serviceEpoch, managerId); },
    desktopLaunchState: async () => readyLaunchRecord(serviceEpoch, managerId),
  };
}
const browserPresent = (tabId = "tab-a"): Extract<BrowserRelay, { kind: "present" }> => ({ source: BROWSER_RELAY,
  requestId: "request-" + tabId, kind: "present", identity: browserIdentity, tabId, url: "https://example.com/",
  viewport: { x: 10, y: 80, width: 700, height: 500 } });

test("native Browser fragments reject extra commands, credentials, noncanonical data and oversized payloads", () => {
  const request = browserPresent();
  assert.deepEqual(parseNativeBrowserFragment(nativeBrowserFragment("browser", request)!, "browser"), request);
  for (const value of [{ ...request, execute: "private" }, { ...request, url: "file:///private" },
    { ...request, url: "https://user:secret@example.com/" }, { ...request, viewport: { ...request.viewport, width: Infinity } },
    { ...request, identity: { ...browserIdentity, serviceEpoch: "different" } }]) assert.equal(nativeBrowserFragment("browser", value), null);
  for (const hash of ["#browser/%", "#browser/" + "x".repeat(131073), "#browser/" + encodeURIComponent(JSON.stringify(request, null, 1)),
    "#browser/" + encodeURIComponent(JSON.stringify(request).replace('"kind":"present"', '"kind":"hide","kind":"present"'))]) {
    assert.equal(parseNativeBrowserFragment(hash, "browser"), null);
  }
  const context = { URL, TextEncoder, result: null };
  new Script(browserProtocolScript() + '\nresult = parseNativeBrowserFragment(' + JSON.stringify(nativeBrowserFragment("browser", request)) + ', "browser");').runInNewContext(context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), request);
});

test("official Browser leases retain live tab navigation, clip bounds, expire and never reacquire a failed tab", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  class Guest extends EventTarget {
    style = {}; hidden = true; url = "about:blank"; title = ""; attributes = new Map<string, string>(); removed = false;
    setAttribute(k: string, v: string) { this.attributes.set(k, v); }
    loadURL(url: string) { this.url = url; this.title = "loaded"; return Promise.resolve(); }
    getURL() { return this.url; } getTitle() { return this.title; } remove() { this.removed = true; }
  }
  const elements: Guest[] = [], acquired: string[] = [], released: string[] = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Guest() } });
  t.after(() => Reflect.deleteProperty(globalThis, "document"));
  const bridge = { acquire: async (workspace: string) => { acquired.push(workspace); return { lease: "lease-" + acquired.length, partition: "partition-" + workspace }; },
    release: async (id: string) => { released.push(id); } };
  const host = new NativeBrowserHost(bridge, { hidden: false, getBoundingClientRect: () => ({ width: 800, height: 600 }),
    append: (el: Guest) => { elements.push(el); queueMicrotask(() => el.dispatchEvent(new Event("dom-ready"))); } } as unknown as HTMLElement);
  t.after(() => host.stop());
  assert.equal((await host.present(browserPresent())).ok, true);
  elements[0]!.url = "https://example.com/linked";
  elements[0]!.title = "live page";
  assert.equal((await host.present(browserPresent("tab-b"))).ok, true);
  const back = await host.present(browserPresent());
  assert(back.ok); assert.equal(back.observations[0]!.url, "https://example.com/linked");
  assert.equal(acquired.length, 2); assert.equal(acquired[0], acquired[1]);
  assert.equal(elements[1]!.hidden, true); assert.equal(elements[0]!.hidden, false);
  assert.deepEqual(elements[0]!.style, { left: "10px", top: "80px", width: "700px", height: "500px" });
  elements[0]!.dispatchEvent(new Event("render-process-gone"));
  assert.equal((await host.present(browserPresent("tab-b"))).ok, true);
  assert.equal(elements[1]!.hidden, false);
  assert.equal((await host.present(browserPresent())).ok, false);
  assert.equal(elements[1]!.hidden, true, "a failed selection cannot leave the previous tab visible");
  host.hide(); assert.equal(elements[1]!.hidden, true);
  t.mock.timers.tick(2501); await tick();
  assert.equal(elements.every(el => el.removed), true); assert.equal(released.length, 2);
  assert.equal((await host.present(browserPresent())).ok, false); assert.equal(acquired.length, 2);
  assert.equal((await host.present(browserPresent("tab-c"))).ok, true);
  assert.notEqual(acquired[2], acquired[0]);
});

test("native portal admits Browser requests only from its registered manager and correlates results", () => {
  const listeners = new Map<string, (event?: unknown) => void>(), writes: string[] = [], replies: unknown[] = [];
  const managerWindow = { postMessage: (data: unknown, origin: string) => replies.push({ data, origin }) };
  const location = { origin: "http://127.0.0.1:3333", hash: "#selected/1/@settings", replace(hash: string) { writes.push(hash); this.hash = hash; } };
  const script = renderPortalPage({ parentOrigin: location.origin, channel: "b".repeat(32) }, "http://127.0.0.1:3334", true)
    .split("<script>")[1].split("</script>")[0];
  new Script(script + `\nframe=managerFrame;managerReady=true;snapshot=${JSON.stringify({ serviceEpoch: browserIdentity.serviceEpoch, managerId: "hub",
    spaces: [{ id: "browser", generation: 1, status: "running" }] })};`).runInNewContext({
    location, URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
    managerFrame: { contentWindow: managerWindow, getBoundingClientRect: () => ({ width: 800, height: 600 }) },
    fetch: () => new Promise(() => {}), setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    window: { addEventListener: (name: string, fn: (event?: unknown) => void) => listeners.set(name, fn) },
  });
  const receive = listeners.get("message")!, request = browserPresent();
  for (const event of [
    { source: {}, origin: "http://127.0.0.1:3334", data: request },
    { source: managerWindow, origin: "http://foreign.example", data: request },
    { source: managerWindow, origin: "http://127.0.0.1:3334", data: { ...request, identity: { ...browserIdentity, generation: 2 } } },
    { source: managerWindow, origin: "http://127.0.0.1:3334", data: { ...request, viewport: { ...request.viewport, width: 900 } } },
  ]) receive(event);
  assert.deepEqual(writes, []);
  receive({ source: managerWindow, origin: "http://127.0.0.1:3334", data: request });
  assert.equal(writes.length, 1);
  const latest = browserPresent("tab-b");
  receive({ source: managerWindow, origin: "http://127.0.0.1:3334", data: latest });
  assert.equal(writes.length, 2);
  const result = { source: BROWSER_RESULT, requestId: "wrong-request", ok: true, mode: "native", tabId: "tab-a", observations: [] };
  location.hash = nativeBrowserFragment("browser-result", result)!; listeners.get("hashchange")!();
  assert.equal(replies.length, 0);
  result.requestId = request.requestId;
  location.hash = nativeBrowserFragment("browser-result", result)!; listeners.get("hashchange")!();
  assert.equal(replies.length, 0);
  result.requestId = latest.requestId;
  location.hash = nativeBrowserFragment("browser-result", result)!; listeners.get("hashchange")!();
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ data: result, origin: "http://127.0.0.1:3334" }]);
  listeners.get("hashchange")!(); assert.equal(replies.length, 1);
});

test("pending Browser acquisition is released when its presenter is disposed", async () => {
  let acquired!: (value: { lease: string; partition: string }) => void;
  const released: string[] = [];
  const host = new NativeBrowserHost({ acquire: () => new Promise(resolve => { acquired = resolve; }),
    release: async lease => { released.push(lease); } }, {} as HTMLElement);
  const pending = host.present(browserPresent());
  host.stop(); acquired({ lease: "late-browser", partition: "isolated" });
  assert.equal((await pending).ok, false); assert.deepEqual(released, ["late-browser"]);
});

test("native navigation has closed variants, separate system IDs and bounded request IDs", () => {
  assert.deepEqual(parseNativeSpaceHash("#select/7/@settings"), { kind: "select", requestId: 7, target: "@settings" });
  assert.deepEqual(parseNativeSpaceHash("#select/7/coding/2"), { kind: "select", requestId: 7, target: "coding", targetGeneration: 2 });
  for (const hash of ["#select/1/@settings/1", "#selected/1/coding/1", "#select/1/coding/-1", "#select/1/coding/01", "#select/1/coding/9007199254740992"])
    assert.equal(parseNativeSpaceHash(hash), null);
  assert.equal(parseNativeSpaceHash("#selected/8/coding")?.target, "coding");
  for (const value of ["#select/0/coding", "#select/1/../web", "#select/1/coding/extra", "#run/1/coding", "#select/1/@admin", "#select/999999999999999999/coding", "#select/1/%40settings"]) assert.equal(parseNativeSpaceHash(value), null);
});
test("both portal scripts remain valid JS; native is a bounded mode of existing manager chain", () => {
  for (const native of [false, true]) {
    const html = renderPortalPage({ parentOrigin: "http://127.0.0.1:3333", channel: "a".repeat(32) }, "http://127.0.0.1:3334", native);
    new Script(html.split("<script>")[1].split("</script>")[0]);
    assert.ok(!html.includes("executeJavaScript"));
  }
});
test("official Desktop binds only its own exact sibling CLI version and actual invocation", t => {
  const root = mkdtempSync(join(tmpdir(), "spaces-native-bind-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js");
  const bin = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  for (const [file, name] of [[entry, "@deepseek-ai/dsh-desktop-host"], [bin, "@deepseek-ai/dsh"]]) {
    mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "");
    writeFileSync(join(file, "../../package.json"), JSON.stringify({ name, version: "0.1.7-rc.2" }));
  }
  assert.equal(bindDshCli(entry)?.bin, bin);
  assert.equal(invocationProfile([process.execPath, entry, root, join(root, "home/profiles/desktop")]), "desktop");
  assert.equal(invocationProfile([process.execPath, entry, root, join(root, "home/profiles/other")]), null);
  writeFileSync(join(bin, "../../package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.7-alpha.1" }));
  assert.equal(bindDshCli(entry), null);
});
test("late native lease is released on plugin disposal; discovery never initializes", async () => {
  let acquire!: (value: { lease: string; partition: string }) => void;
  const released: string[] = [], calls: string[] = [];
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
    portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
    returnTarget: async () => ({ available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + "b".repeat(32), reasons: [] }),
    bootstrap: async () => { throw Error("must not bootstrap"); }, initialize: async () => { calls.push("initialize"); throw Error(); },
  }, { acquire: () => new Promise(resolve => { acquire = resolve; }), release: async id => { released.push(id); } });
  await controller.start({} as HTMLElement); controller.select("@settings"); await tick(); controller.stop();
  acquire({ lease: "owned", partition: "test" }); await tick();
  assert.deepEqual(released, ["owned"]); assert.deepEqual(calls, []);
});

test("rail click after a failed native start shows the recorded failure again and never reconnects", async () => {
  let roleCalls = 0, acquires = 0;
  const controller = new NativeHostController({
    role: async () => { roleCalls++; return { role: "workspace", profileId: "desktop", unavailable: true, reasons: ["manager-stopped"] }; },
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => { throw Error("must not read after failure"); },
  } as never, { acquire: async () => { acquires++; throw Error("must not acquire"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  const failed = controller.getSnapshot();
  assert.equal(failed.phase, "failed"); assert.equal(failed.guide, false); assert.ok(failed.error);
  controller.showCurrent();
  assert.equal(controller.getSnapshot().guide, false);
  controller.select("@settings"); await tick();
  const shown = controller.getSnapshot();
  assert.equal(shown.guide, true); assert.equal(shown.phase, "failed"); assert.equal(shown.error, failed.error);
  assert.equal(shown.pending, null); assert.equal(roleCalls, 1); assert.equal(acquires, 0);
});

test("opening with no live supervisor launches it once; a later failure never relaunches", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  let dies = false;
  const epoch = "a".repeat(64);
  const controller = new NativeHostController({
    role: async () => { calls.push("role"); return { role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }; },
    ...readyLaunchApi(epoch, "hub", calls),
    presentationSnapshot: async () => {
      calls.push("directory");
      if (dies) throw Error("The workbench entry is not available yet.");
      return { serviceEpoch: epoch, managerId: "hub", spaces: [] };
    },
    initialize: async () => { calls.push("initialize"); throw Error("must not initialize"); },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  assert.deepEqual(calls, ["role", "begin", "directory"]);
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().selected, "current");
  assert.equal(controller.getSnapshot().guide, false);
  dies = true;
  t.mock.timers.tick(1500); await tick();
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.equal(controller.getSnapshot().guide, false, "background polling must leave main visible");
  assert.equal(calls.filter(call => call === "begin").length, 1);
  assert.equal(calls.filter(call => call === "initialize").length, 0);
  const settled = calls.length;
  await controller.start({} as HTMLElement);
  controller.select("@settings");
  controller.openCreate();
  await tick();
  assert.equal(calls.length, settled, "a terminal directory failure does not begin or initialize again");
  controller.stop();
});

test("registration 404 preserves main unless the user has opened Spaces; failure never reconnects", async () => {
  for (const openSettings of [false, true]) {
    let reject!: (error: Error) => void;
    let reads = 0, begins = 0;
    const epoch = "a".repeat(64);
    const controller = new NativeHostController({
      role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
      ...readyLaunchApi(epoch, "hub"),
      beginDesktopLaunch: async () => { begins++; return readyLaunchRecord(epoch, "hub"); },
      presentationSnapshot: () => { reads++; return new Promise((_resolve, fail) => { reject = fail; }); },
      initialize: async () => { throw Error("must not relaunch"); },
    } as never, { acquire: async () => { throw Error("must not acquire"); }, release: async () => {} });
    const starting = controller.start({} as HTMLElement); await tick();
    assert.equal(controller.getSnapshot().selected, "current");
    assert.equal(controller.getSnapshot().guide, false);
    if (openSettings) controller.select("@settings");
    reject(Error("MAIN_REGISTRATION_REFUSED:404")); await starting;
    assert.equal(controller.getSnapshot().phase, "failed");
    assert.equal(controller.getSnapshot().guide, openSettings);
    assert.equal(controller.getSnapshot().detail, "MAIN_REGISTRATION_REFUSED:404");
    controller.select("@settings");
    assert.equal(controller.getSnapshot().guide, true);
    controller.showCurrent();
    assert.equal(controller.getSnapshot().guide, false);
    await controller.start({} as HTMLElement);
    controller.openCreate();
    controller.select("@settings");
    await tick();
    assert.equal(reads, 1);
    assert.equal(begins, 1);
    assert.equal(controller.getSnapshot().detail, "MAIN_REGISTRATION_REFUSED:404");
    controller.stop();
  }
});

test("a failed launch on open is reported and not retried", async () => {
  let begins = 0, initializes = 0, reads = 0;
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    beginDesktopLaunch: async () => {
      begins++;
      return { operationId: "launch-one", phase: "failed", serviceEpoch: null, managerId: "hub", reasons: ["The supervisor process could not be started."], failure: null };
    },
    desktopLaunchState: async () => { throw Error("must not poll a failed begin"); },
    presentationSnapshot: async () => { reads++; throw Error("The workbench entry is not available yet."); },
    initialize: async () => { initializes++; throw Error("must not initialize"); },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement); await tick();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "failed"); assert.equal(snapshot.guide, false);
  assert.match(snapshot.detail ?? "", /could not be started/);
  controller.select("@settings");
  controller.openCreate();
  await controller.start({} as HTMLElement); await tick();
  assert.equal(begins, 1);
  assert.equal(initializes, 0);
  assert.equal(reads, 0);
  assert.equal(snapshot.detail, controller.getSnapshot().detail);
});

test("other first-read failures stay terminal and never offer a launch", async () => {
  let begins = 0, initializes = 0;
  const epoch = "a".repeat(64);
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub"),
    beginDesktopLaunch: async () => { begins++; return readyLaunchRecord(epoch, "hub"); },
    presentationSnapshot: async () => { throw Error("Maintenance has stopped the manager. The owning service remains blocked."); },
    initialize: async () => { initializes++; throw Error("must not initialize"); },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.equal(controller.getSnapshot().guide, false);
  assert.match(controller.getSnapshot().detail ?? "", /Maintenance has stopped the manager/);
  await controller.start({} as HTMLElement);
  controller.select("@settings");
  controller.openCreate();
  await tick();
  assert.equal(begins, 1);
  assert.equal(initializes, 0);
  assert.equal(controller.getSnapshot().phase, "failed");
});

test("superseded native navigation rejection does not close the latest selection", async () => {
  let rejectFirst!: (error: Error) => void;
  let calls = 0;
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [{ id: "alpha", displayName: "Alpha", status: "running", generation: 1 }] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: "http://127.0.0.1:3333/native/" + "a".repeat(32),
    guest: { loadURL: () => ++calls === 1 ? new Promise<void>((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(), remove() {} } });
  // The dashboard target is gone: it is not a native space target any more, so the rail cannot select it.
  controller.select("@dashboard"); await tick();
  assert.equal(controller.getSnapshot().pending, null);
  controller.select("alpha"); await tick();
  controller.select("@settings"); await tick();
  rejectFirst(Error("ERR_ABORTED")); await tick();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().pending, "@settings");
  controller.stop();
});

test("current native navigation failure terminates its connection", async () => {
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: "http://127.0.0.1:3333/native/" + "a".repeat(32),
    guest: { loadURL: async () => { throw Error("navigation failed"); }, remove() {} } });
  controller.select("@settings"); await tick();
  assert.equal(controller.getSnapshot().phase, "failed");
  controller.stop();
});

test("Desktop clicking a stopped child starts once, ignores stale status and respects newer navigation", async t => {
  const snapshot = { serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [{ id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] };
  let complete!: (value: typeof snapshot) => void, requests = 0;
  const loaded: string[] = [];
  const url = "http://127.0.0.1:3333/native/" + "a".repeat(32);
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(snapshot.serviceEpoch, snapshot.managerId),
    presentationSnapshot: async () => structuredClone(snapshot),
    spaceAction: async request => { requests++; assert.equal(request.action, "open"); return new Promise(resolve => { complete = resolve; }); },
    bootstrap: async () => { throw Error("unused"); },
    initialize: async () => { throw Error("unused"); },
    portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
    returnTarget: async () => { throw Error("unused"); },
  } as import("../../packages/plugin/src/types.ts").WorkbenchGuideApi, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  t.after(() => controller.stop());
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: url,
    guest: { loadURL: async (value: string) => { loaded.push(value); }, focus() {}, remove() {} } });
  controller.select("coding"); controller.select("coding");
  assert.equal(requests, 1); assert.equal(controller.getSnapshot().operation?.spaceId, "coding");
  complete({ ...snapshot, spaces: [{ ...snapshot.spaces[0], status: "running", generation: 1 }] }); await tick();
  assert.equal(loaded.length, 1); assert.match(loaded[0], /\/coding\/1$/);
  assert.equal(controller.getSnapshot().inventory?.spaces[0].status, "running");
  controller.select("coding"); controller.showCurrent();
  complete({ ...snapshot, spaces: [{ ...snapshot.spaces[0], status: "running", generation: 1 }] }); await tick();
  assert.equal(loaded.length, 1, "late successful launch must not steal main");
  assert.equal(controller.getSnapshot().selected, "current");
});

test("running Desktop selections skip lifecycle reads and carry the observed generation", async t => {
  const inventory = { serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [
    { id: "coding", displayName: "Coding", status: "running", generation: 3 },
    { id: "other", displayName: "Other", status: "running", generation: 2 },
  ] };
  let reads = 0, actions = 0;
  const loaded: string[] = [];
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(inventory.serviceEpoch, inventory.managerId),
    presentationSnapshot: async () => { reads++; return inventory; },
    spaceAction: async () => { actions++; throw Error("must not run lifecycle action"); },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  t.after(() => controller.stop()); await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: "http://127.0.0.1:3333/native/" + "a".repeat(32),
    guest: { loadURL: async (url: string) => { loaded.push(url); }, focus() {}, remove() {} } });
  controller.select("coding"); await tick();
  controller.select("other"); await tick();
  controller.select("coding"); await tick();
  assert.equal(actions, 0); assert.equal(reads, 1);
  assert.deepEqual(loaded.map(url => parseNativeSpaceHash(new URL(url).hash)?.targetGeneration), [3, 2, 3]);
  assert.equal(controller.getSnapshot().operation, null);
});

test("a failed Desktop child action reports its original failure without disabling main or retrying", async t => {
  let requests = 0;
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [{ id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] }),
    spaceAction: async () => { requests++; throw Error("original launch failure"); },
  } as never, { acquire: async () => { throw Error("must not open"); }, release: async () => {} });
  t.after(() => controller.stop()); await controller.start({} as HTMLElement);
  controller.select("coding"); await tick();
  assert.equal(requests, 1); assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().operationError, "original launch failure");
  assert.equal(controller.getSnapshot().selected, "current");
});

test("late native acknowledgement cannot overwrite a newer hash request", () => {
  const source = renderPortalPage({ parentOrigin: "http://127.0.0.1:3333", channel: "a".repeat(32) }, "http://127.0.0.1:3334", true)
    .split("<script>")[1].split("</script>")[0];
  const writes: string[] = [];
  const location = { hash: "#select/2/native-b", replace(value: string) { writes.push(value); this.hash = value; } };
  const context = {
    location, AbortController, AbortSignal, TextDecoder,
    fetch: () => new Promise(() => {}),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    window: { addEventListener() {} },
  };
  new Script(source + '\nsend("selected", { requestId: 1, spaceId: "native-a" });\nsend("selected", { requestId: 2, spaceId: "native-b" });').runInNewContext(context);
  assert.deepEqual(writes, ["#selected/2/native-b"]);
});

test("Electron loadURL rejection after exact page acknowledgement remains successful", async () => {
  const url = "http://127.0.0.1:3333/native/" + "a".repeat(32);
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: url,
    guest: { loadURL: async () => { throw Error("ERR_FAILED (-2)"); }, getURL: () => url + "#selected/1/@settings", focus() {}, remove() {} } });
  controller.select("@settings"); await tick();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().selected, "@settings");
  assert.equal(controller.getSnapshot().pending, null);
  controller.stop();
});

test("committed native request still awaits its acknowledgement when Electron rejects loadURL", async () => {
  const url = "http://127.0.0.1:3333/native/" + "a".repeat(32);
  let actual = url + "#select/1/@settings";
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: url,
    guest: { loadURL: async () => { throw Error("ERR_FAILED (-2)"); }, getURL: () => actual, focus() {}, remove() {} } });
  controller.select("@settings"); await tick();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().pending, "@settings");
  actual = url + "#selected/1/@settings";
  (controller as unknown as { observed(): void }).observed();
  assert.equal(controller.getSnapshot().selected, "@settings");
  assert.equal(controller.getSnapshot().pending, null);
  controller.stop();
});

test("the desktop rail opens the settings page and hands over a create intent for a new space", async () => {
  const url = "http://127.0.0.1:3333/native/" + "a".repeat(32);
  const loaded: string[] = [];
  let actual = url;
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: url,
    guest: { loadURL: async (value: string) => { loaded.push(value); actual = value; }, getURL: () => actual, focus() {}, remove() {} } });
  // A plain settings selection carries no create intent.
  controller.select("@settings"); await tick();
  assert.deepEqual(loaded, [url + "#select/1/@settings"]);
  actual = url + "#selected/1/@settings";
  (controller as unknown as { observed(): void }).observed();
  assert.deepEqual(loaded, [url + "#select/1/@settings"], "the plain selection does not write an intent");
  // The create button opens the settings page of the guest and then asks it
  // for the create dialog.
  controller.openCreate(); await tick();
  assert.equal(controller.getSnapshot().pending, "@settings", "the create opens the settings page of the guest");
  assert.deepEqual(loaded, [url + "#select/1/@settings", url + "#select/2/@settings"]);
  actual = url + "#selected/2/@settings";
  (controller as unknown as { observed(): void }).observed();
  assert.equal(controller.getSnapshot().selected, "@settings");
  assert.deepEqual(loaded, [url + "#select/1/@settings", url + "#select/2/@settings", url + "#intent/create/1"]);
  assert.equal(parseNativeCreateIntent(loaded[2]!.slice(url.length)), 1, "the shell writes the fragment the portal parses");
  controller.stop();
});

test("the native portal forwards a create intent only after a completed settings selection", () => {
  const managerOrigin = "http://127.0.0.1:3334";
  const epoch = "a".repeat(64);
  const view = { serviceEpoch: epoch, spaceId: "hub", generation: 1, channel: "manager-channel" };
  const portal = () => {
    const listeners = new Map<string, (event?: unknown) => void>();
    const replies: { data: unknown; origin: string }[] = [];
    const managerWindow = { postMessage: (data: unknown, origin: string) => replies.push({ data, origin }) };
    const location = { origin: "http://127.0.0.1:3333", hash: "", replace(hash: string) { this.hash = hash; } };
    const script = renderPortalPage({ parentOrigin: location.origin, channel: "b".repeat(32) }, managerOrigin, true)
      .split("<script>")[1].split("</script>")[0];
    new Script(script + `
frame=managerFrame;managerReady=true;managerView=${JSON.stringify(view)};
snapshot=${JSON.stringify({ serviceEpoch: epoch, managerId: "hub", spaces: [] })};
`).runInNewContext({
      location, URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
      managerFrame: { contentWindow: managerWindow, getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      fetch: () => new Promise(() => {}), setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
      window: { addEventListener: (name: string, fn: (event?: unknown) => void) => listeners.set(name, fn) },
    });
    const intents = () => replies.filter(reply => (reply.data as { type?: string }).type === "intent");
    return { replies, intents, location,
      hash: (value: string) => { location.hash = value; listeners.get("hashchange")!(); },
      select: (requestId: number) => { location.hash = "#select/" + requestId + "/@settings"; listeners.get("hashchange")!(); },
      answer: (requestId: number) => listeners.get("message")!({ source: managerWindow, origin: managerOrigin,
        data: { source: "dsh-spaces-surface", type: "selected", requestId, target: "@settings", ...view } }) };
  };
  // Without a completed settings selection the intent is ignored.
  const without = portal();
  without.hash("#intent/create/1");
  assert.equal(without.intents().length, 0, "an intent without a settings selection is ignored");
  // A pending selection blocks the intent as well.
  const pending = portal();
  pending.select(1);
  assert.equal(pending.replies.length, 1, "the selection is forwarded to the manager");
  pending.hash("#intent/create/1");
  assert.equal(pending.intents().length, 0, "an intent while a selection is pending is ignored");
  // After the completed settings selection the intent is forwarded once.
  const ready = portal();
  ready.select(1);
  ready.answer(1);
  ready.hash("#intent/create/1");
  assert.equal(ready.intents().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ready.intents()[0])), { data: { source: "dsh-spaces-surface-parent", type: "intent",
    intent: "create", requestId: 1, serviceEpoch: epoch, spaceId: "hub", generation: 1, channel: "manager-channel" },
    origin: managerOrigin });
  ready.hash("#intent/create/1");
  assert.equal(ready.intents().length, 1, "the same request id is never forwarded twice");
  // A request id that does not increase is ignored.
  const replay = portal();
  replay.select(1);
  replay.answer(1);
  replay.hash("#intent/create/2");
  assert.equal(replay.intents().length, 1);
  replay.hash("#intent/create/2");
  replay.hash("#intent/create/1");
  assert.equal(replay.intents().length, 1, "a request id that does not increase is ignored");
  // A malformed fragment is ignored.
  const malformed = portal();
  malformed.select(1);
  malformed.answer(1);
  for (const hash of ["#intent/create", "#intent/create/", "#intent/create/abc", "#intent/create/0", "#intent/create/01",
    "#intent/create/1/extra", "#intent/create/1x", "#intent/create/1.5", "#intent/other/1", "#intent/create/99999999999999999999"]) {
    malformed.hash(hash);
  }
  assert.equal(malformed.intents().length, 0, "a malformed create intent is ignored");
  assert.equal(malformed.replies.filter(reply => (reply.data as { type?: string }).type === "select").length, 1,
    "the portal forwards the selection and nothing else");
});

test("native guide shows sanitized launch reasons after a failed automatic begin", async t => {
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "zh-CN", languages: ["zh-CN"] } });
  t.after(() => Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator }));
  let begins = 0;
  const reasons = ["manager bootstrap failed Bearer abcdef0123456789abcdef0123456789", "see C:\\Users\\x\\.dsh\\logs\\supervisor.log"];
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: null, unavailable: false, reasons: [] }),
    presentationSnapshot: async () => { throw Error("unused"); },
    bootstrap: async () => { throw Error("unused"); },
    portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
    returnTarget: async () => { throw Error("unused"); },
    initialize: async () => { throw Error("must not initialize"); },
    beginDesktopLaunch: async () => {
      begins++;
      return { operationId: "launch-one", phase: "failed", serviceEpoch: null, managerId: null, reasons, failure: null };
    },
    desktopLaunchState: async () => { throw Error("must not poll a failed begin"); },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "failed");
  assert.match(snapshot.error!, /空间服务或页面不可用/);
  assert.ok(snapshot.detail!.includes("manager bootstrap failed Bearer [redacted]"));
  assert.ok(snapshot.detail!.includes("[path]"));
  assert.ok(!snapshot.detail!.includes("C:\\Users"));
  await controller.start({} as HTMLElement);
  controller.select("@settings");
  controller.openCreate();
  assert.equal(begins, 1);
  controller.stop();
});

test("native directory failure shows the sanitized snapshot error", async () => {
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi("a".repeat(64), "hub"),
    presentationSnapshot: async () => { throw Error("snapshot read at C:\\Users\\x\\.dsh\\hub\\spaces.json"); },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "failed");
  assert.ok(snapshot.detail!.includes("snapshot read at [path]"));
  assert.ok(!snapshot.detail!.includes("C:\\Users"));
  controller.stop();
});

test("native failure fragments carry only canonical bounded closed diagnostic fields", () => {
  for (const reason of PORTAL_FAILURE_REASONS) {
    for (const code of PORTAL_FAILURE_CODES) {
      const failure = { reason, code, status: 503 };
      const hash = nativePortalFailureHash(failure)!;
      assert.ok(hash.length <= NATIVE_PORTAL_FAILURE_HASH_LIMIT);
      assert.deepEqual(parseNativePortalFailureHash(hash), failure);
    }
    assert.deepEqual(parseNativePortalFailureHash(nativePortalFailureHash({ reason })!), { reason });
  }
  const encoded = (value: unknown) => "#failed/" + encodeURIComponent(JSON.stringify(value));
  for (const hash of ["#failed", "#failed/", "#failed/%", "#failed/%FF", "#failed/null", "#failed/" + "a".repeat(513),
    encoded({}), encoded([]), encoded({ reason: "unknown" }),
    encoded({ reason: "state-request", code: "workbench/private-token" }),
    encoded({ reason: "state-request", status: "503" }), encoded({ reason: "state-request", status: 600 }),
    encoded({ reason: "state-request", status: 503.5 }),
    encoded({ reason: "state-request", message: "private" }), encoded({ reason: "state-request", grant: "private" }),
    "#failed/" + encodeURIComponent('{"reason":"manager-stopped","reason":"state-request"}'),
    "#failed/" + encodeURIComponent('{ "reason": "state-request" }'),
    "#failed/" + encodeURIComponent(encodeURIComponent('{"reason":"state-request"}'))]) {
    assert.equal(parseNativePortalFailureHash(hash), null, hash);
  }
  assert.equal(nativePortalFailureHash({ reason: "state-request", token: "private" }), null);
});

async function nativeFailureFixture() {
  const calls: string[] = [];
  const controller = new NativeHostController({
    role: async () => { calls.push("role"); return { role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }; },
    ...readyLaunchApi("a".repeat(64), "hub"),
    beginDesktopLaunch: async () => { calls.push("begin"); return readyLaunchRecord("a".repeat(64), "hub"); },
    presentationSnapshot: async () => { calls.push("directory"); return { serviceEpoch: "a".repeat(64), managerId: "hub",
      spaces: [{ id: "hub", displayName: "Manager", generation: 1, status: "running" }] }; },
    initialize: async () => { calls.push("initialize"); throw Error("must not relaunch"); },
  } as never, {
    acquire: async () => { calls.push("acquire"); throw Error("must not reconnect"); },
    release: async () => { calls.push("release"); },
  });
  await controller.start({} as HTMLElement);
  const nativeUrl = "http://127.0.0.1:3333/native/" + "a".repeat(32);
  let actual = nativeUrl;
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl, lease: "synthetic-native-lease",
    guest: { loadURL: async (url: string) => { calls.push("loadURL"); actual = url; },
      getURL: () => actual, remove: () => calls.push("remove"), focus() {} } });
  return { controller, calls, nativeUrl, observe: (url: string) => {
    actual = url;
    (controller as unknown as { observed(): void }).observed();
  } };
}

test("native failure causes use the shared fixed text and remain terminal without reconnect", async () => {
  for (const reason of PORTAL_FAILURE_REASONS) {
    const f = await nativeFailureFixture();
    const failure: PortalFailure = { reason, code: "workbench/unavailable", status: 503 };
    f.observe(f.nativeUrl + nativePortalFailureHash(failure));
    const snapshot = f.controller.getSnapshot();
    assert.equal(snapshot.phase, "failed");
    assert.deepEqual(snapshot.portalFailure, failure);
    assert.equal(snapshot.detail, portalFailureDetail(failure));
    assert.equal(snapshot.inventory, null);
    f.controller.select("@settings");
    await f.controller.start({} as HTMLElement);
    f.controller.openCreate();
    const displayed = f.controller.getSnapshot();
    assert.deepEqual(displayed, { ...snapshot, guide: true });
    f.observe(f.nativeUrl + "#selected/1/@settings"); await tick();
    assert.strictEqual(f.controller.getSnapshot(), displayed);
    assert.deepEqual(f.calls, ["role", "begin", "directory", "remove", "release"]);
  }
});

test("native failure parsing follows exact trusted native origin/path and rejects query or credentials", async () => {
  const fragment = nativePortalFailureHash({ reason: "manager-disconnected" })!;
  for (const suffix of ["#failed", "#failed/%", "#failed/" + encodeURIComponent(JSON.stringify({ reason: "manager-stopped", token: "private" }))]) {
    const f = await nativeFailureFixture();
    f.observe(f.nativeUrl + suffix);
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.equal(f.controller.getSnapshot().portalFailure, null);
    assert.equal(f.controller.getSnapshot().detail, nativeTexts().portalFailureNoDetail);
    assert.ok(f.controller.getSnapshot().failedAt);
    assert.deepEqual(f.calls, ["role", "begin", "directory", "remove", "release"]);
  }
  for (const url of ["http://127.0.0.1:3334/native/" + "a".repeat(32),
    "http://127.0.0.1:3333/native/" + "b".repeat(32),
    "http://127.0.0.1:3333/native/" + "a".repeat(32) + "/extra",
    "http://127.0.0.1:3333/native/" + "a".repeat(32) + "?grant=private",
    "http://user:private@127.0.0.1:3333/native/" + "a".repeat(32), "not a URL"]) {
    const f = await nativeFailureFixture();
    f.observe(url + fragment);
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.equal(f.controller.getSnapshot().portalFailure, null);
    assert.equal(f.controller.getSnapshot().detail, nativeTexts().invalidPortalAddress);
    assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()), /private|grant|user:/);
    assert.deepEqual(f.calls, ["role", "begin", "directory", "remove", "release"]);
  }
});

test("actual native portal HTTP failure emits a safe fragment consumed by the trusted guest", async () => {
  const source = renderPortalPage({ parentOrigin: "http://127.0.0.1:3333", channel: "a".repeat(32) },
    "http://127.0.0.1:3334", true).split("<script>")[1].split("</script>")[0];
  for (const status of [401, 503]) {
    const writes: string[] = [], timers = new Set<number>();
    let requests = 0;
    const location = { origin: "http://127.0.0.1:3333", hash: "", replace(hash: string) { writes.push(hash); this.hash = hash; } };
    new Script(source).runInNewContext({
      location, AbortController, AbortSignal, TextDecoder,
      fetch: async () => {
        requests++;
        return Response.json({ ok: false, error: { code: status === 401 ? "workbench/unauthorized" : "workbench/unavailable",
          message: "http://private/?token=synthetic-native-secret", grant: "synthetic-native-grant" } }, { status });
      },
      setInterval: () => { timers.add(1); return 1; }, clearInterval: (id: number) => timers.delete(id),
      setTimeout: () => 2, clearTimeout() {}, window: { addEventListener() {} },
    });
    await tick();
    assert.equal(writes.length, 1); assert.equal(requests, 1); assert.equal(timers.size, 0);
    const failure = parseNativePortalFailureHash(writes[0])!;
    assert.deepEqual(failure, { reason: "state-request", code: status === 401 ? "workbench/unauthorized" : "workbench/unavailable", status });
    assert.doesNotMatch(decodeURIComponent(writes[0]), /private|secret|grant|token|http:/);
    const f = await nativeFailureFixture();
    f.observe(f.nativeUrl + writes[0]);
    assert.equal(f.controller.getSnapshot().detail, portalFailureDetail(failure));
    assert.deepEqual(f.controller.getSnapshot().portalFailure, failure);
    f.controller.select("@settings"); await tick();
    assert.deepEqual(f.calls, ["role", "begin", "directory", "remove", "release"]);
  }
});

test("native first open prepares the portal alongside launch and only shows green after the page acknowledges", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const inventory = { serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [{ id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] };
  const loads: string[] = []; let handoffs = 0, complete!: (value: typeof inventory) => void;
  class Guest extends EventTarget {
    url = "about:blank"; className = "";
    setAttribute() {} remove() {} focus() {} getURL() { return this.url; }
    async loadURL(url: string) {
      loads.push(url); const u = new URL(url);
      this.url = u.pathname.startsWith("/bootstrap/") ? u.origin + "/native/" + u.searchParams.get("native") : url;
    }
  }
  const guest = new Guest();
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => guest } });
  t.after(() => Reflect.deleteProperty(globalThis, "document"));
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(inventory.serviceEpoch, inventory.managerId),
    presentationSnapshot: async () => structuredClone(inventory),
    portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
    returnTarget: async () => { handoffs++; return { available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + "b".repeat(32), reasons: [] }; },
    spaceAction: () => new Promise(resolve => { complete = resolve; }),
  } as never, { acquire: async () => ({ lease: "test", partition: "isolated" }), release: async () => {} });
  t.after(() => controller.stop());
  await controller.start({ append: () => queueMicrotask(() => {
    guest.dispatchEvent(new Event("dom-ready"));
    guest.dispatchEvent(new Event("did-finish-load"));
    guest.dispatchEvent(new Event("did-stop-loading"));
  }) } as unknown as HTMLElement);
  assert.equal(controller.spaceStatus("coding"), "stopped"); controller.select("coding"); await tick();
  assert.equal(controller.spaceStatus("coding"), "starting"); assert.equal(handoffs, 1); assert.equal(loads.length, 1);
  assert.match(loads[0], /\/bootstrap\/[^?]+\?native=[a-f0-9]{32}$/);
  inventory.spaces[0] = { ...inventory.spaces[0], status: "running", generation: 1 };
  complete(structuredClone(inventory)); await tick();
  assert.equal(controller.spaceStatus("coding"), "opening"); assert.equal(loads.length, 2);
  const request = parseNativeSpaceHash(new URL(guest.url).hash)!;
  guest.url = guest.url.split("#")[0] + `#selected/${request.requestId}/coding`;
  guest.dispatchEvent(new Event("did-navigate-in-page"));
  assert.equal(controller.spaceStatus("coding"), "running");
  controller.showCurrent(); assert.equal(controller.spaceStatus("coding"), "running");
  inventory.spaces[0].generation = 2; t.mock.timers.tick(1500); await tick();
  assert.equal(controller.spaceStatus("coding"), "unopened", "a new process lifetime has not loaded its page");
});

const navToken = "b".repeat(32);
function captureNavLines(throwAfterRecord = false) {
  const lines: string[] = [];
  const prior = console.log;
  console.log = ((first: unknown, ...rest: unknown[]) => {
    if (typeof first === "string" && first.startsWith("dsh-spaces-nav-diag ")) {
      lines.push(first);
      if (throwAfterRecord) throw new Error("diag sink");
      return;
    }
    prior(first, ...rest);
  }) as typeof console.log;
  return { lines, restore: () => { console.log = prior; } };
}
function navRecords(lines: string[]) {
  return lines.map(line => {
    const row = parseNavDiag(line);
    assert.ok(row, line);
    return row;
  });
}
/** Real first guest: bootstrap load rewrites the URL, and append signals dom-ready. */
async function openSettingsGuest(t: import("node:test").TestContext, options?: { failBootstrap?: boolean; calls?: string[] }) {
  const loads: string[] = [], released: string[] = [];
  class Guest extends EventTarget {
    url = "about:blank";
    className = "";
    setAttribute() {}
    remove() {}
    focus() {}
    getURL() { return this.url; }
    async loadURL(url: string) {
      loads.push(url);
      const parsed = new URL(url);
      if (options?.failBootstrap && parsed.pathname.startsWith("/bootstrap/")) throw new Error("bootstrap refused");
      this.url = parsed.pathname.startsWith("/bootstrap/") ? parsed.origin + "/native/" + parsed.searchParams.get("native") : url;
    }
  }
  const guest = new Guest();
  const epoch = "a".repeat(64);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => guest } });
  t.after(() => Reflect.deleteProperty(globalThis, "document"));
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub", options?.calls),
    presentationSnapshot: async () => ({ serviceEpoch: epoch, managerId: "hub", spaces: [] }),
    portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
    returnTarget: async () => ({ available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + navToken, reasons: [] }),
    initialize: async () => { options?.calls?.push("initialize"); throw new Error("must not relaunch"); },
  } as never, {
    acquire: async () => ({ lease: "diag-lease", partition: "isolated" }),
    release: async (id: string) => { released.push(id); },
  });
  t.after(() => controller.stop());
  await controller.start({ append: () => queueMicrotask(() => {
    guest.dispatchEvent(new Event("dom-ready"));
    guest.dispatchEvent(new Event("did-finish-load"));
    guest.dispatchEvent(new Event("did-stop-loading"));
  }) } as unknown as HTMLElement);
  return { controller, guest, loads, released, epoch };
}

test("first selected navigation logs once and a later selection keeps its original result when the log sink throws", async t => {
  const captured = captureNavLines(true);
  t.after(captured.restore);
  const { controller, guest, loads } = await openSettingsGuest(t);
  controller.select("@settings"); await tick();
  assert.equal(loads.length, 2);
  const request = parseNativeSpaceHash(new URL(guest.url).hash)!;
  guest.url = guest.url.split("#")[0] + `#selected/${request.requestId}/@settings`;
  guest.dispatchEvent(new Event("did-navigate-in-page"));
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().selected, "@settings");
  assert.equal(controller.getSnapshot().pending, null);
  const records = navRecords(captured.lines);
  assert.equal(records.at(-1)!.ev, "ready");
  assert.equal(records[0]!.targetKind, "settings");
  assert.ok(records.some(row => row.ev === "bootstrap-load-complete"));
  const logged = captured.lines.join("\n");
  const channel = new URL(loads[0]!).searchParams.get("native")!;
  assert.equal(logged.includes(channel), false);
  assert.equal(logged.includes(navToken), false);
  assert.equal(logged.includes("#selected"), false);
  const closed = captured.lines.length;
  guest.dispatchEvent(new Event("did-start-navigation"));
  controller.select("@settings"); await tick();
  assert.equal(captured.lines.length, closed, "diagnosis ended after the first selected result");
  assert.equal(loads.length, 3);
  assert.match(loads[2]!, /#select\/2\/@settings$/);
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().pending, "@settings");
});

test("ignored subframe and main-frame -3 stay pending, and another main-frame code fails with one release", async t => {
  const captured = captureNavLines();
  t.after(captured.restore);
  const { controller, guest, loads, released } = await openSettingsGuest(t);
  controller.select("@settings"); await tick();
  assert.equal(loads.length, 2);
  assert.equal(controller.getSnapshot().pending, "@settings");
  const secret = "http://user:secret-token@evil.example/private?channel=channel-secret#hash-secret";
  guest.dispatchEvent(Object.assign(new Event("did-fail-load"), { isMainFrame: false, errorCode: -105, validatedURL: secret }));
  guest.dispatchEvent(Object.assign(new Event("did-fail-load"), { isMainFrame: true, errorCode: -3, validatedURL: secret }));
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().pending, "@settings");
  assert.equal(loads.length, 2);
  assert.deepEqual(released, []);
  const ignored = navRecords(captured.lines).filter(row => row.ev === "did-fail-load");
  assert.deepEqual(ignored.map(row => row.errorCode), [-105, -3]);
  assert.ok(ignored.every(row => row.ignored === true));
  const logged = captured.lines.join("\n");
  for (const hidden of ["secret-token", "channel-secret", "hash-secret", "evil.example"]) assert.equal(logged.includes(hidden), false, hidden);
  guest.dispatchEvent(Object.assign(new Event("did-fail-load"), { isMainFrame: true, errorCode: -2, validatedURL: secret }));
  await tick();
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.equal(loads.length, 2);
  assert.deepEqual(released, ["diag-lease"]);
  const failed = controller.getSnapshot();
  assert.equal(failed.detail, nativeTexts().guestLoadFailed.replace("{detail}", "-2"));
  for (const hidden of ["secret-token", "channel-secret", "hash-secret", "evil.example"]) assert.equal((failed.detail ?? "").includes(hidden), false, hidden);
  assert.ok(failed.failedAt);
  assert.ok(!Number.isNaN(Date.parse(failed.failedAt!)));
  assert.ok(navRecords(captured.lines).some(row => row.ev === "fail"));
});

test("a gone renderer reports its reason and exit code and stamps the failure time", async t => {
  const captured = captureNavLines();
  t.after(captured.restore);
  const { controller, guest, released } = await openSettingsGuest(t);
  controller.select("@settings"); await tick();
  assert.equal(controller.getSnapshot().pending, "@settings");
  guest.dispatchEvent(Object.assign(new Event("render-process-gone"), { details: { reason: "crashed", exitCode: 1 } }));
  await tick();
  const failed = controller.getSnapshot();
  assert.equal(failed.phase, "failed");
  assert.equal(failed.detail, nativeTexts().guestProcessGone.replace("{detail}", "crashed, 1"));
  assert.ok(failed.failedAt);
  assert.deepEqual(released, ["diag-lease"]);
  assert.ok(navRecords(captured.lines).some(row => row.ev === "fail"));
});

test("the failed panel renders the failure time", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { NativeHostShell } = await import("../../packages/plugin/src/client/ui/native-shell.tsx");
  const controller = new NativeHostController({} as never, {} as never);
  Object.assign(controller, { state: { phase: "failed", selected: "current", pending: null, guide: true,
    error: nativeTexts().serviceUnavailable, detail: "synthetic detail", failedAt: "2026-11-22T10:15:30.000Z",
    cleanupDetail: null, instanceRetained: null, portalFailure: null, inventory: null,
    navigationIntent: null, createHandoff: false, operation: null, operationError: null, notice: null,
    serviceStopRequest: 0, spaceConfirmation: null, creationFailed: null } });
  const html = renderToStaticMarkup(React.createElement(NativeHostShell, { controller }));
  assert.match(html, /data-reason="failed-at"/);
  assert.match(html, /Failed at|失败时间/);
});

test("the 90 second selection deadline still fails once and does not relaunch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captured = captureNavLines();
  t.after(captured.restore);
  const calls: string[] = [];
  const { controller, loads } = await openSettingsGuest(t, { calls });
  controller.select("@settings"); await tick();
  assert.equal(loads.length, 2);
  assert.equal(controller.getSnapshot().pending, "@settings");
  t.mock.timers.tick(NATIVE_SELECTION_DEADLINE_MS - 1); await tick();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().pending, "@settings");
  t.mock.timers.tick(1); await tick();
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.match(controller.getSnapshot().detail ?? "", /select-load-complete/);
  assert.equal(loads.length, 2);
  const deadline = navRecords(captured.lines).find(row => row.ev === "deadline");
  assert.equal(deadline?.stage, "selection");
  assert.ok(navRecords(captured.lines).some(row => row.ev === "fail"));
  const began = calls.filter(call => call === "begin").length;
  controller.select("@settings");
  controller.openCreate();
  t.mock.timers.tick(NATIVE_SELECTION_DEADLINE_MS); await tick();
  assert.equal(calls.filter(call => call === "begin").length, began);
  assert.equal(calls.includes("initialize"), false);
  assert.equal(loads.length, 2);
  assert.equal(controller.getSnapshot().phase, "failed");
});

test("portal navDiag milestones appear in selectionDeadline detail when deadline expires", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captured = captureNavLines();
  t.after(captured.restore);
  const { controller, guest } = await openSettingsGuest(t);
  controller.select("@settings"); await tick();
  for (const [seq, ev] of [
    [1, "iframe-append"],
    [2, "view-ready"],
    [3, "surface-ready"],
    [4, "select-forward"],
  ] as const) {
    guest.dispatchEvent(Object.assign(new Event("console-message"), {
      message: `dsh-spaces-nav-diag ${JSON.stringify({ v: 1, src: "portal", seq, t: seq * 10, ev })}`,
    }));
  }
  t.mock.timers.tick(NATIVE_SELECTION_DEADLINE_MS); await tick();
  const failed = controller.getSnapshot();
  assert.equal(failed.phase, "failed");
  for (const expected of [
    "portal:iframe-append",
    "portal:view-ready",
    "portal:surface-ready",
    "portal:select-forward",
  ]) {
    assert.ok((failed.detail ?? "").includes(expected), `missing ${expected} in ${failed.detail}`);
  }
});

test("a rejected bootstrap load is recorded once and still fails through the original path", async t => {
  const captured = captureNavLines();
  t.after(captured.restore);
  const { controller, loads, released } = await openSettingsGuest(t, { failBootstrap: true });
  controller.select("@settings"); await tick();
  assert.deepEqual(loads.map(url => new URL(url).pathname.startsWith("/bootstrap/")), [true]);
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.deepEqual(released, ["diag-lease"]);
  const names = navRecords(captured.lines).map(row => row.ev);
  assert.ok(names.includes("bootstrap-load-reject"));
  assert.ok(names.includes("fail"));
  assert.equal(names.includes("bootstrap-load-complete"), false);
  assert.equal(captured.lines.join("\n").includes("bootstrap refused"), false);
  controller.select("@settings"); await tick();
  assert.equal(loads.length, 1);
});

async function flushTurns() {
  for (let i = 0; i < 8; i++) await tick();
}

test("initial about:blank must finish and stop before the first bootstrap loadURL", async t => {
  const captured = captureNavLines();
  t.after(captured.restore);
  const loads: string[] = [];
  let blankCycleDone = false;
  let resolvedWhileBlank = false;
  class Guest extends EventTarget {
    url = "about:blank";
    className = "";
    setAttribute() {}
    remove() {}
    focus() {}
    getURL() { return this.url; }
    async loadURL(url: string) {
      loads.push(url);
      // Electron 44 can resolve a new loadURL from the previous blank finish/stop.
      if (!blankCycleDone) {
        this.url = "about:blank";
        resolvedWhileBlank = true;
        return;
      }
      const parsed = new URL(url);
      this.url = parsed.pathname.startsWith("/bootstrap/") ? parsed.origin + "/native/" + parsed.searchParams.get("native") : url;
    }
  }
  const guest = new Guest();
  const epoch = "a".repeat(64);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => guest } });
  t.after(() => Reflect.deleteProperty(globalThis, "document"));
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: epoch, managerId: "hub", spaces: [] }),
    portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
    returnTarget: async () => ({ available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + navToken, reasons: [] }),
    initialize: async () => { throw new Error("must not relaunch"); },
  } as never, { acquire: async () => ({ lease: "blank-lease", partition: "isolated" }), release: async () => {} });
  t.after(() => controller.stop());
  await controller.start({ append() {} } as unknown as HTMLElement);
  controller.select("@settings");
  await flushTurns();
  assert.equal(loads.length, 0);
  guest.dispatchEvent(new Event("dom-ready"));
  await flushTurns();
  assert.equal(loads.length, 0, "dom-ready must not start bootstrap");
  guest.dispatchEvent(new Event("did-finish-load"));
  await flushTurns();
  assert.equal(loads.length, 0, "did-finish-load must not start bootstrap");
  blankCycleDone = true;
  guest.dispatchEvent(new Event("did-stop-loading"));
  await flushTurns();
  assert.equal(resolvedWhileBlank, false);
  assert.equal(loads.length, 2);
  assert.match(loads[0]!, /\/bootstrap\/[^?]+\?native=[a-f0-9]{32}$/);
  assert.match(loads[1]!, /#select\/1\/@settings$/);
  assert.equal(guest.getURL().startsWith("http://127.0.0.1:3333/native/"), true);
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().pending, "@settings");
  const records = navRecords(captured.lines);
  const domReady = records.findIndex(row => row.ev === "guest-dom-ready");
  const loadStopped = records.findIndex(row => row.ev === "guest-load-stopped");
  const bootstrap = records.findIndex(row => row.ev === "bootstrap-load-start");
  assert.ok(domReady >= 0);
  assert.ok(loadStopped > domReady);
  assert.ok(bootstrap > loadStopped);
  assert.equal(records.filter(row => row.ev === "bootstrap-load-start").length, 1);
  assert.equal(records.filter(row => row.ev === "select-load-start").length, 1);
});

test("native rail shows active creations and keeps seen failed ones until dismissed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const epoch = "a".repeat(64);
  const running = { jobId: "create-1", spaceId: "made-one", displayName: "Made", status: "running" as const, phase: "install", message: "DSH 0.9.9" };
  const unseen = { jobId: "create-2", spaceId: "lost-one", displayName: "Lost", status: "failed" as const, phase: "create", message: "", error: "boom" };
  let current: unknown = { serviceEpoch: epoch, managerId: "hub", spaces: [], creating: [running, unseen] };
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub"),
    presentationSnapshot: async () => current,
    portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
    returnTarget: async () => ({ available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + "b".repeat(32), reasons: [] }),
    initialize: async () => { throw Error("must not initialize"); },
  } as never, { acquire: async () => { throw Error("no guest needed"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  // A failed job never seen active stays hidden; the running one shows.
  assert.deepEqual(controller.visibleCreations().map(row => row.jobId), ["create-1"]);
  // The same job failing after it was seen stays visible as a failed placeholder.
  current = { serviceEpoch: epoch, managerId: "hub", spaces: [],
    creating: [{ ...running, status: "failed", message: "", error: "install broke" }, unseen] };
  t.mock.timers.tick(1500); await tick();
  assert.deepEqual(controller.visibleCreations().map(row => row.jobId), ["create-1"]);
  // Clicking the failed placeholder opens its dialog; dismissing removes it and closes the dialog.
  controller.openCreation(controller.visibleCreations()[0]);
  assert.equal(controller.getSnapshot().creationFailed?.jobId, "create-1");
  controller.closeCreationFailed();
  assert.equal(controller.getSnapshot().creationFailed, null);
  controller.openCreation(controller.visibleCreations()[0]);
  controller.dismissCreation("create-1");
  assert.deepEqual(controller.visibleCreations(), []);
  assert.equal(controller.getSnapshot().creationFailed, null);
  // A running placeholder navigates to the settings surface, like the active job surface.
  current = { serviceEpoch: epoch, managerId: "hub", spaces: [], creating: [running] };
  t.mock.timers.tick(1500); await tick();
  assert.deepEqual(controller.visibleCreations().map(row => row.jobId), ["create-1"]);
  controller.openCreation(controller.visibleCreations()[0]);
  assert.equal(controller.getSnapshot().pending, "@settings");
  controller.stop();
});

test("the native rail halo marks a space needing attention without replacing its status dot", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { NativeHostShell } = await import("../../packages/plugin/src/client/ui/native-shell.tsx");
  const controller = new NativeHostController({} as never, {} as never);
  Object.assign(controller, { state: { phase: "ready", selected: "current", pending: null, error: null, guide: false,
    navigationIntent: null, createHandoff: false, operation: null, operationError: null, notice: null,
    serviceStopRequest: 0, spaceConfirmation: null, creationFailed: null, detail: null, failedAt: null, cleanupDetail: null,
    instanceRetained: null, portalFailure: null,
    inventory: { serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [
      { id: "alpha", displayName: "Alpha", status: "running", generation: 1, attention: "required" },
      { id: "beta", displayName: "Beta", status: "running", generation: 1, attention: "none" },
    ] } } });
  const html = renderToStaticMarkup(React.createElement(NativeHostShell, { controller }));
  const alphaButton = html.match(/<button[^>]*data-space-id="alpha"[^>]*>/)?.[0] ?? "";
  assert.ok(alphaButton.includes('data-attention="required"'), "the native rail shows the attention halo");
  assert.ok(alphaButton.includes('data-space-status="unopened"'), "the status dot stays alongside the halo");
  assert.match(html, /Alpha · (尚未打开|Not opened yet) · (等待处理|Needs attention)/, "the label carries status and the attention hint");
  const betaButton = html.match(/<button[^>]*data-space-id="beta"[^>]*>/)?.[0] ?? "";
  assert.ok(!betaButton.includes('data-attention="required"'), "a 'none' space has no halo");
});

test("the desktop rail space menu opens settings and hands over a detail intent to open the space detail page", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { NativeSpaceMenu } = await import("../../packages/plugin/src/client/ui/native-space-menu.tsx");
  const { attachSurfaceBridge, parseSurfaceIntent } = await import("../../packages/plugin/src/workbench/surface-bridge.ts");

  const menuHtml = renderToStaticMarkup(
    React.createElement(NativeSpaceMenu, {
      space: { id: "alpha", displayName: "Alpha", status: "running", generation: 1 },
      x: 12,
      y: 24,
      busy: false,
      onAction: () => undefined,
      onSettings: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(menuHtml, /打开空间设置|Space settings/);

  // 1. NativeHostController.openSpaceSettings selects @settings and writes #intent/detail/1/alpha.
  const epoch = "a".repeat(64);
  const url = "http://127.0.0.1:3333/native/" + "a".repeat(32);
  const loaded: string[] = [];
  let actual = url;
  const hostCtrl = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: epoch, managerId: "hub", spaces: [{ id: "alpha", displayName: "Alpha", status: "running", generation: 1 }] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await hostCtrl.start({} as HTMLElement);
  Object.assign(hostCtrl, {
    opening: Promise.resolve(),
    nativeUrl: url,
    guest: { loadURL: async (value: string) => { loaded.push(value); actual = value; }, getURL: () => actual, focus() {}, remove() {} },
  });
  hostCtrl.openSpaceSettings("alpha");
  await tick();
  assert.equal(hostCtrl.getSnapshot().pending, "@settings");
  assert.deepEqual(loaded, [url + "#select/1/@settings"]);
  actual = url + "#selected/1/@settings";
  (hostCtrl as unknown as { observed(): void }).observed();
  assert.deepEqual(loaded, [url + "#select/1/@settings", url + "#intent/detail/1/alpha"]);
  assert.equal(hostCtrl.getSnapshot().selected, "@settings");
  hostCtrl.openSpaceSettings("alpha");
  assert.deepEqual(loaded, [url + "#select/1/@settings", url + "#intent/detail/1/alpha", url + "#intent/detail/2/alpha"],
    "when already on @settings, openSpaceSettings hands over the detail intent directly without re-selecting general settings");
  assert.deepEqual(parseNativeDetailIntent("#intent/detail/1/alpha"), { requestId: 1, spaceId: "alpha" });
  hostCtrl.stop();

  // 2. Portal page forwards #intent/detail/<id>/<spaceId> only after @settings selection, and rejects replays or invalid ids.
  const managerOrigin = "http://127.0.0.1:3334";
  const view = { serviceEpoch: epoch, spaceId: "hub", generation: 1, channel: "manager-channel" };
  const makePortal = () => {
    const listeners = new Map<string, (event?: unknown) => void>();
    const replies: { data: unknown; origin: string }[] = [];
    const managerWindow = { postMessage: (data: unknown, origin: string) => replies.push({ data, origin }) };
    const location = { origin: "http://127.0.0.1:3333", hash: "", replace(hash: string) { this.hash = hash; } };
    const script = renderPortalPage({ parentOrigin: location.origin, channel: "b".repeat(32) }, managerOrigin, true)
      .split("<script>")[1].split("</script>")[0];
    new Script(script + `
frame=managerFrame;managerReady=true;managerView=${JSON.stringify(view)};
snapshot=${JSON.stringify({ serviceEpoch: epoch, managerId: "hub", spaces: [{ id: "alpha", displayName: "Alpha", status: "running", generation: 1 }] })};
`).runInNewContext({
      location, URL, TextEncoder, TextDecoder, AbortController, AbortSignal,
      managerFrame: { contentWindow: managerWindow, getBoundingClientRect: () => ({ width: 800, height: 600 }) },
      fetch: () => new Promise(() => {}), setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
      window: { addEventListener: (name: string, fn: (event?: unknown) => void) => listeners.set(name, fn) },
    });
    return {
      location,
      intents: () => replies.filter(reply => (reply.data as { type?: string }).type === "intent"),
      hash: (value: string) => { location.hash = value; listeners.get("hashchange")!(); },
      selectSettings: (requestId: number) => {
        location.hash = "#select/" + requestId + "/@settings";
        listeners.get("hashchange")!();
        listeners.get("message")!({
          source: managerWindow,
          origin: managerOrigin,
          data: { source: "dsh-spaces-surface", type: "selected", requestId, target: "@settings", ...view },
        });
      },
    };
  };
  const without = makePortal();
  without.hash("#intent/detail/1/alpha");
  assert.equal(without.intents().length, 0, "ignored before @settings selection");

  const ready = makePortal();
  ready.selectSettings(1);
  ready.hash("#intent/detail/1/alpha");
  assert.equal(ready.intents().length, 1);
  const forwarded = JSON.parse(JSON.stringify(ready.intents()[0]));
  assert.deepEqual(forwarded, {
    data: {
      source: "dsh-spaces-surface-parent",
      type: "intent",
      intent: "detail",
      requestId: 1,
      targetSpaceId: "alpha",
      ...view,
    },
    origin: managerOrigin,
  });
  for (const bad of ["#intent/detail/1/alpha", "#intent/detail/2/", "#intent/detail/2/@settings", "#intent/detail/2/Bad_ID", "#intent/detail/2/hub", "#intent/detail/3/unknown-space"]) {
    ready.hash(bad);
  }
  assert.equal(ready.intents().length, 1, "replays, manager id, unknown space id and malformed detail intents are ignored");

  // 3. Surface bridge parses the forwarded message and routes to openDetail(spaceId).
  const parentWin = { postMessage() {} };
  const parentOrigin = ready.location.origin;
  const surfaceView = { ...view, parentOrigin };
  assert.deepEqual(
    parseSurfaceIntent({ source: parentWin, origin: parentOrigin, data: forwarded.data }, parentWin, surfaceView),
    { intent: "detail", requestId: 1, targetSpaceId: "alpha" },
  );
  const openedDetails: string[] = [];
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let uiState = {
    boot: "ready",
    selected: "home",
    pendingId: null,
    overlay: null as { type: "settings" } | null,
    viewError: null,
    state: { serviceEpoch: epoch, managerId: "hub", availability: "ready" },
  };
  const fakeWb = {
    getSnapshot: () => uiState,
    subscribe: () => () => undefined,
    closeOverlay: () => { uiState = { ...uiState, overlay: null }; },
    selectHome: () => { uiState = { ...uiState, selected: "home" }; },
    openSettings: () => { uiState = { ...uiState, overlay: { type: "settings" } }; },
    openCreate: () => undefined,
    openDetail: (spaceId: string) => { openedDetails.push(spaceId); },
  };
  const detach = attachSurfaceBridge(
    fakeWb as never,
    surfaceView,
    parentWin,
    (fn) => { messageHandler = fn; return () => { messageHandler = null; }; },
    () => undefined,
  );
  messageHandler!({
    source: parentWin,
    origin: parentOrigin,
    data: { source: "dsh-spaces-surface-parent", type: "select", requestId: 1, target: "@settings", ...view },
  } as unknown as MessageEvent);
  messageHandler!({
    source: parentWin,
    origin: parentOrigin,
    data: forwarded.data,
  } as unknown as MessageEvent);
  assert.deepEqual(openedDetails, ["alpha"]);
  detach();
});

test("NativeHostController reports RPC transport failure context and guest navDiag trail", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reports: ClientFailureReport[] = [];
  let failDirectory = true;
  const epoch = "a".repeat(64);
  const rpcController = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub"),
    presentationSnapshot: async () => {
      if (failDirectory) {
        throw new WorkbenchRemoteError(null, "The workbench request failed.", {
          endpoint: "workbenchGuide/presentationSnapshot",
          failureKind: "rpc-transport",
          connectionState: "disconnected",
        });
      }
      return { serviceEpoch: epoch, managerId: "hub", spaces: [] };
    },
    reportClientFailure: async (report: ClientFailureReport) => { reports.push(report); return { recorded: true }; },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await rpcController.start({} as HTMLElement);
  assert.equal(rpcController.getSnapshot().phase, "failed");
  assert.match(rpcController.getSnapshot().detail ?? "", /workbenchGuide\/presentationSnapshot/);
  assert.match(rpcController.getSnapshot().detail ?? "", /disconnected/);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.surface, "desktop-native");
  assert.equal(reports[0]!.stage, "directory-poll");
  assert.equal(reports[0]!.rpcEndpoint, "workbenchGuide/presentationSnapshot");
  assert.equal(reports[0]!.rpcFailureKind, "rpc-transport");
  assert.equal(reports[0]!.connectionState, "disconnected");

  failDirectory = false;
  let guest!: EventTarget & {
    className: string;
    url: string;
    setAttribute(): void;
    remove(): void;
    focus(): void;
    getURL(): string;
    loadURL(value: string): Promise<void>;
  };
  class Guest extends EventTarget {
    className = "";
    url = "about:blank";
    setAttribute() {}
    remove() {}
    focus() {}
    getURL() { return this.url; }
    async loadURL(value: string) {
      const parsed = new URL(value);
      if (parsed.pathname.startsWith("/bootstrap/")) {
        this.url = parsed.origin + "/native/" + parsed.searchParams.get("native");
        return;
      }
      this.url = value;
    }
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => (guest = new Guest()) },
  });
  t.after(() => previousDocument ? Object.defineProperty(globalThis, "document", previousDocument) : Reflect.deleteProperty(globalThis, "document"));
  const portalReports: ClientFailureReport[] = [];
  const portalController = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: epoch, managerId: "hub", spaces: [] }),
    returnTarget: async () => ({ available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + "b".repeat(32), reasons: [] }),
    reportClientFailure: async (report: ClientFailureReport) => { portalReports.push(report); return { recorded: true }; },
  } as never, { acquire: async () => ({ lease: "lease-1", partition: "isolated" }), release: async () => {} });
  await portalController.start({ append() {} } as unknown as HTMLElement);
  portalController.select("@settings");
  await tick();
  guest.dispatchEvent(new Event("dom-ready"));
  guest.dispatchEvent(new Event("did-finish-load"));
  guest.dispatchEvent(new Event("did-stop-loading"));
  await tick();
  const portalDiag = 'dsh-spaces-nav-diag {"v":1,"src":"portal","seq":1,"t":12,"ev":"fail","reason":"manager-disconnected"}';
  guest.dispatchEvent(Object.assign(new Event("console-message"), { message: portalDiag }));
  guest.url = guest.url.split("#")[0]! + nativePortalFailureHash({ reason: "manager-disconnected" })!;
  guest.dispatchEvent(new Event("did-navigate-in-page"));
  await tick();
  assert.equal(portalController.getSnapshot().phase, "failed");
  assert.equal(portalReports.length, 1);
  assert.equal(portalReports[0]!.stage, "portal");
  assert.deepEqual(portalReports[0]!.portalFailure, { reason: "manager-disconnected" });
  const trail = portalReports[0]!.navTrail ?? [];
  assert.ok(trail.some(row => row.src === "controller" && row.ev === "user-select"));
  assert.ok(trail.some(row => row.src === "portal" && row.ev === "fail" && row.reason === "manager-disconnected"));
});

test("NativeHostController disposedBeforeTerminal distinguishes live remount from terminal failure or stop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const epoch = "a".repeat(64);
  const healthy = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    ...readyLaunchApi(epoch, "hub"),
    presentationSnapshot: async () => ({ serviceEpoch: epoch, managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await healthy.start({} as HTMLElement);
  assert.equal(healthy.disposedBeforeTerminal, false);
  healthy.stop();
  assert.equal(healthy.disposedBeforeTerminal, true);

  const failed = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: true, reasons: ["blocked"] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await failed.start({} as HTMLElement);
  assert.equal(failed.getSnapshot().phase, "failed");
  assert.equal(failed.disposedBeforeTerminal, false);

  const stopped = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    beginDesktopLaunch: async () => ({ operationId: "launch-one", phase: "stopped", serviceEpoch: epoch, managerId: "hub", reasons: [], failure: null }),
    desktopLaunchState: async () => ({ operationId: "launch-one", phase: "stopped", serviceEpoch: epoch, managerId: "hub", reasons: [], failure: null }),
    presentationSnapshot: async () => ({ serviceEpoch: epoch, managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await stopped.start({} as HTMLElement);
  assert.equal(stopped.getSnapshot().phase, "service-stopped");
  stopped.stop();
  assert.equal(stopped.disposedBeforeTerminal, false);
});
