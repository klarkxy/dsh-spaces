import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeSpaceHash, nativePortalFailureHash, parseNativePortalFailureHash, portalFailureDetail,
  PORTAL_FAILURE_REASONS, PORTAL_FAILURE_CODES, NATIVE_PORTAL_FAILURE_HASH_LIMIT, parseNativeCreateIntent,
  type PortalFailure } from "../../src/shared/space-host.ts";
import { renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";
import { bindDshCli, invocationProfile } from "../../src/adapters/node/products/spaces-service.ts";
import { NativeHostController } from "../../packages/plugin/src/client/native-host.tsx";
import { NativeBrowserHost } from "../../packages/plugin/src/client/native-browser-host.ts";
import { BROWSER_RELAY, BROWSER_RESULT, nativeBrowserFragment, parseNativeBrowserFragment, browserProtocolScript,
  type BrowserRelay } from "../../src/shared/browser-guest.ts";

const browserIdentity = { spaceId: "browser", generation: 1, serviceEpoch: "a".repeat(64), origin: "http://127.0.0.1:3335", channel: "child-channel" };
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
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
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

test("opening with no live supervisor launches it once; a later failure never relaunches", async () => {
  const calls: string[] = [];
  let live = false, dies = false;
  const controller = new NativeHostController({
    role: async () => { calls.push("role"); return { role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }; },
    presentationSnapshot: async () => {
      calls.push("directory");
      if (!live || dies) throw Error("The workbench entry is not available yet.");
      return { serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] };
    },
    initialize: async () => { calls.push("initialize"); live = true; return { ok: true, connected: true, unavailable: false, origin: null, path: null, managerId: "hub", reasons: [] }; },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  assert.deepEqual(calls, ["role", "directory", "initialize", "directory"]);
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().selected, "current");
  assert.equal(controller.getSnapshot().guide, false);
  // The supervisor dies later in this session: the next poll fails terminally.
  dies = true;
  await new Promise(resolve => setTimeout(resolve, 1600)); await tick();
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.equal(controller.getSnapshot().guide, false, "background polling must leave main visible");
  assert.equal(calls.filter(call => call === "initialize").length, 1);
  controller.stop();
});

test("registration 404 preserves main unless the user has opened Spaces; failure never reconnects", async () => {
  for (const openSettings of [false, true]) {
    let reject!: (error: Error) => void;
    let reads = 0;
    const controller = new NativeHostController({
      role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
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
    await controller.initialize(); await tick();
    assert.equal(reads, 1);
    assert.equal(controller.getSnapshot().detail, "MAIN_REGISTRATION_REFUSED:404");
    controller.stop();
  }
});

test("a failed launch on open is reported and not retried", async () => {
  let initializes = 0;
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    presentationSnapshot: async () => { throw Error("The workbench entry is not available yet."); },
    initialize: async () => { initializes++; return { ok: false, connected: false, unavailable: false, origin: null, path: null, managerId: "hub", reasons: ["The supervisor process could not be started."] }; },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement); await tick();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "failed"); assert.equal(snapshot.guide, false);
  assert.match(snapshot.detail ?? "", /could not be started/);
  controller.select("@settings"); await controller.initialize(); await tick();
  assert.equal(initializes, 1);
});

test("other first-read failures stay terminal and never offer a launch", async () => {
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    presentationSnapshot: async () => { throw Error("Maintenance has stopped the manager. The owning service remains blocked."); },
    initialize: async () => { throw Error("must not initialize"); },
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  assert.equal(controller.getSnapshot().phase, "failed");
  await controller.initialize();
  assert.equal(controller.getSnapshot().phase, "failed");
});

test("superseded native navigation rejection does not close the latest selection", async () => {
  let rejectFirst!: (error: Error) => void;
  let calls = 0;
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
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
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: "http://127.0.0.1:3333/native/" + "a".repeat(32),
    guest: { loadURL: async () => { throw Error("navigation failed"); }, remove() {} } });
  controller.select("@settings"); await tick();
  assert.equal(controller.getSnapshot().phase, "failed");
  controller.stop();
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

test("native guide shows sanitized initialize reasons after a failed start", async () => {
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: null, unavailable: false, reasons: [] }),
    presentationSnapshot: async () => { throw Error("unused"); },
    bootstrap: async () => { throw Error("unused"); },
    returnTarget: async () => { throw Error("unused"); },
    initialize: async () => ({ ok: false, connected: false, unavailable: false, origin: null, path: null, managerId: null,
      reasons: ["manager bootstrap failed Bearer abcdef0123456789abcdef0123456789", "see C:\\Users\\x\\.dsh\\logs\\supervisor.log"] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  assert.equal(controller.getSnapshot().phase, "initialize");
  await controller.initialize();
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.phase, "failed");
  assert.match(snapshot.error!, /空间服务或页面不可用/);
  assert.ok(snapshot.detail!.includes("manager bootstrap failed Bearer [redacted]"));
  assert.ok(snapshot.detail!.includes("[path]"));
  assert.ok(!snapshot.detail!.includes("C:\\Users"));
  controller.stop();
});

test("native directory failure shows the sanitized snapshot error", async () => {
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
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
    f.controller.select("@settings"); await f.controller.initialize();
    const displayed = f.controller.getSnapshot();
    assert.deepEqual(displayed, { ...snapshot, guide: true });
    f.observe(f.nativeUrl + "#selected/1/@settings"); await tick();
    assert.strictEqual(f.controller.getSnapshot(), displayed);
    assert.deepEqual(f.calls, ["role", "directory", "remove", "release"]);
  }
});

test("native failure parsing follows exact trusted native origin/path and rejects query or credentials", async () => {
  const fragment = nativePortalFailureHash({ reason: "manager-disconnected" })!;
  for (const suffix of ["#failed", "#failed/%", "#failed/" + encodeURIComponent(JSON.stringify({ reason: "manager-stopped", token: "private" }))]) {
    const f = await nativeFailureFixture();
    f.observe(f.nativeUrl + suffix);
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.equal(f.controller.getSnapshot().portalFailure, null);
    assert.equal(f.controller.getSnapshot().detail, null);
    assert.deepEqual(f.calls, ["role", "directory", "remove", "release"]);
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
    assert.equal(f.controller.getSnapshot().detail, null);
    assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()), /private|grant|user:/);
    assert.deepEqual(f.calls, ["role", "directory", "remove", "release"]);
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
    assert.deepEqual(f.calls, ["role", "directory", "remove", "release"]);
  }
});
