import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { parseNativeCreateIntent, type PortalSnapshot } from "../../src/shared/space-host.ts";
import { NativeHostController } from "../../packages/plugin/src/client/native-host.tsx";
import { nativeTexts } from "../../packages/plugin/src/client/ui/native-texts.ts";
import type { DesktopLaunchPhase, DesktopLaunchState, WorkbenchGuideApi, WorkbenchReturnTarget } from "../../packages/plugin/src/types.ts";

const EPOCH = "a".repeat(64);
const OTHER_EPOCH = "c".repeat(64);
const PORTAL: WorkbenchReturnTarget = { available: true, unavailable: false, origin: "http://127.0.0.1:3333", path: "/bootstrap/" + "b".repeat(32), reasons: [] };

function launchRecord(phase: DesktopLaunchPhase, extra: Partial<DesktopLaunchState> = {}): DesktopLaunchState {
  return {
    operationId: "launch-one", phase, serviceEpoch: EPOCH,
    managerId: phase === "discovering" ? null : "hub", reasons: [], failure: null, ...extra,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(r => { resolve = r; }), resolve };
}
async function flush(times = 6) {
  for (let i = 0; i < times; i++) await tick();
}

function harness(t: TestContext, options: { phase?: DesktopLaunchPhase; empty?: boolean; holdAcquire?: boolean; holdPortal?: boolean; holdBegin?: boolean; statusError?: boolean; directoryEpoch?: string; directoryManager?: string | null } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let launch = launchRecord(options.phase ?? "preparing");
  const calls = { begin: 0, status: 0, initialize: 0, bootstrap: 0, directory: 0, portal: 0, acquire: 0, focus: 0, child: 0, release: [] as string[], urls: [] as string[] };
  const operations: string[] = [];
  const acquired = deferred<{ lease: string; partition: string }>();
  const portalHeld = deferred<WorkbenchReturnTarget>();
  const begun = deferred<DesktopLaunchState>();
  class Guest extends EventTarget {
    url = "about:blank";
    setAttribute() {}
    remove() {}
    focus() { calls.focus++; }
    getURL() { return this.url; }
    async loadURL(value: string) {
      calls.urls.push(value);
      const url = new URL(value);
      if (url.pathname.startsWith("/bootstrap/")) { this.url = url.origin + "/native/" + url.searchParams.get("native"); return; }
      this.url = value;
      if (url.hash.startsWith("#select/")) {
        this.url = value.replace("#select/", "#selected/").replace(/\/(\d+)$/, "");
        queueMicrotask(() => this.dispatchEvent(new Event("did-navigate-in-page")));
      }
    }
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Guest() } });
  t.after(() => previousDocument ? Object.defineProperty(globalThis, "document", previousDocument) : Reflect.deleteProperty(globalThis, "document"));
  const directory: PortalSnapshot = { serviceEpoch: options.directoryEpoch ?? EPOCH, managerId: options.directoryManager === undefined ? "hub" : options.directoryManager, spaces: [] };
  const api = {
    role: async () => ({ role: "workspace" as const, profileId: "desktop", managerId: options.empty ? null : "hub", unavailable: false, reasons: [] as string[] }),
    beginDesktopLaunch: async () => {
      calls.begin++;
      const record = options.holdBegin ? await begun.promise : structuredClone(launch);
      if (record.operationId) operations.push(record.operationId);
      return record;
    },
    desktopLaunchState: async () => {
      calls.status++;
      if (options.statusError) throw Error("controlled observation failure");
      return structuredClone(launch);
    },
    presentationSnapshot: async () => { calls.directory++; return structuredClone(directory); },
    initialize: async () => { calls.initialize++; throw Error("must not initialize"); },
    bootstrap: async () => { calls.bootstrap++; throw Error("must not bootstrap"); },
    returnTarget: async () => { calls.portal++; return options.holdPortal && calls.portal === 1 ? portalHeld.promise : { ...PORTAL, reasons: [] }; },
    spaceAction: async () => { calls.child++; throw Error("child must not autostart"); },
  } satisfies WorkbenchGuideApi;
  const bridge = {
    acquire: async () => {
      calls.acquire++;
      return options.holdAcquire && calls.acquire === 1 ? acquired.promise : { lease: "lease-" + calls.acquire, partition: "isolated" };
    },
    release: async (lease: string) => { calls.release.push(lease); },
  };
  const container = { append: (guest: Guest) => queueMicrotask(() => {
    guest.dispatchEvent(new Event("dom-ready"));
    guest.dispatchEvent(new Event("did-finish-load"));
    guest.dispatchEvent(new Event("did-stop-loading"));
  }) } as unknown as HTMLElement;
  const controller = new NativeHostController(api, bridge);
  t.after(() => controller.stop());
  return { controller, api, bridge, calls, operations, acquired, portalHeld, begun, container,
    update: (phase: DesktopLaunchPhase, extra?: Partial<DesktopLaunchState>) => { launch = launchRecord(phase, extra); },
    start: () => controller.start(container),
    next: async () => { t.mock.timers.tick(1500); await flush(); } };
}

test("empty Home begins once and keeps main through every startup phase", async t => {
  const f = harness(t, { empty: true, phase: "discovering" });
  await f.start();
  assert.equal(f.controller.getSnapshot().phase, "discovering");
  assert.equal(f.controller.getSnapshot().selected, "current");
  assert.equal(f.controller.getSnapshot().guide, false);
  for (const phase of ["preparing", "launching", "starting", "connecting"] as const) {
    f.update(phase); await f.next();
    assert.equal(f.controller.getSnapshot().phase, phase);
    assert.equal(f.controller.getSnapshot().selected, "current");
    assert.equal(f.controller.getSnapshot().guide, false);
  }
  f.update("ready"); await f.next();
  const ready = f.controller.getSnapshot();
  assert.equal(ready.phase, "ready");
  assert.equal(ready.selected, "current");
  assert.equal(ready.guide, false);
  assert.equal(ready.inventory?.serviceEpoch, EPOCH);
  assert.equal(ready.inventory?.managerId, "hub");
  assert.equal(f.calls.begin, 1);
  assert.equal(f.calls.portal, 0);
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.focus, 0);
  assert.equal(f.calls.child, 0);
  assert.equal(f.calls.initialize, 0);
  assert.equal(f.calls.bootstrap, 0);
  await f.controller.start(f.container);
  assert.equal(f.calls.begin, 1);
});

test("a rebuilt controller begins again against the same supplied record", async t => {
  // Host-process deduplication is covered by the Phase 2 host tests. This fake only shows each controller joins the record it is given.
  const f = harness(t, { phase: "ready" });
  await f.start();
  const second = new NativeHostController(f.api, f.bridge);
  t.after(() => second.stop());
  await second.start(f.container);
  assert.deepEqual(f.operations, ["launch-one", "launch-one"]);
  assert.equal(f.calls.begin, 2);
  assert.notEqual(second, f.controller);
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(second.getSnapshot().phase, "ready");
  assert.equal(second.getSnapshot().inventory?.managerId, "hub");
});

for (const [label, actions, creates] of [
  ["create then settings", ["create", "settings"], 0],
  ["settings then create", ["settings", "create"], 1],
  ["create then main", ["create", "main"], 0],
] as const) test("latest startup intent " + label, async t => {
  const f = harness(t);
  await f.start();
  for (const action of actions) {
    if (action === "create") f.controller.openCreate();
    if (action === "settings") f.controller.select("@settings");
    if (action === "main") f.controller.showCurrent();
  }
  f.update("ready"); await f.next();
  const delivered = f.calls.urls.filter(url => parseNativeCreateIntent(new URL(url).hash));
  const main = actions.at(-1) === "main";
  assert.equal(delivered.length, creates);
  assert.equal(f.controller.getSnapshot().selected, main ? "current" : "@settings");
  assert.equal(f.controller.getSnapshot().guide, false);
  assert.equal(f.calls.portal, main ? 0 : 1);
  assert.equal(f.calls.child, 0);
  assert.equal(f.calls.begin, 1);
  assert.equal(f.calls.initialize, 0);
});

test("Main cancels a held lease and a later settings click can still open", async t => {
  const f = harness(t, { holdAcquire: true });
  await f.start();
  f.controller.openCreate();
  f.update("ready"); await f.next();
  assert.equal(f.calls.acquire, 1);
  f.controller.showCurrent();
  f.acquired.resolve({ lease: "one", partition: "isolated" });
  await flush();
  assert.equal(f.controller.getSnapshot().selected, "current");
  assert.equal(f.controller.getSnapshot().guide, false);
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.calls.focus, 0);
  assert.equal(f.calls.urls.some(url => new URL(url).hash.startsWith("#select/")), false);
  assert.equal(f.calls.urls.some(url => parseNativeCreateIntent(new URL(url).hash)), false);
  assert.deepEqual(f.calls.release, ["one"]);
  f.controller.select("@settings");
  await flush();
  assert.equal(f.calls.acquire, 2);
  assert.equal(f.calls.focus, 1);
  assert.equal(f.controller.getSnapshot().selected, "@settings");
  assert.equal(f.controller.getSnapshot().pending, null);
  assert.equal(f.calls.urls.filter(url => parseNativeCreateIntent(new URL(url).hash)).length, 0);
});

test("Main cancels a held portal response and a later settings click can still open", async t => {
  const f = harness(t, { holdPortal: true });
  await f.start();
  f.controller.openCreate();
  f.update("ready"); await f.next();
  assert.equal(f.calls.portal, 1);
  assert.equal(f.calls.acquire, 0);
  f.controller.showCurrent();
  f.portalHeld.resolve(PORTAL);
  await flush();
  assert.equal(f.controller.getSnapshot().selected, "current");
  assert.equal(f.calls.focus, 0);
  assert.equal(f.calls.acquire, 0);
  f.controller.select("@settings");
  await flush();
  assert.equal(f.calls.portal, 2);
  assert.equal(f.calls.acquire, 1);
  assert.equal(f.calls.focus, 1);
  assert.equal(f.controller.getSnapshot().selected, "@settings");
});

test("a stopped record stays stopped and a second controller only rejoins it", async t => {
  // Host-process deduplication is covered by the Phase 2 host tests. Both controllers here only observe the same supplied stopped record.
  const stopped = harness(t, { phase: "stopped" });
  await stopped.start();
  assert.equal(stopped.controller.getSnapshot().phase, "service-stopped");
  assert.equal(stopped.controller.getSnapshot().guide, false);
  const reads = stopped.calls.status;
  await stopped.next();
  stopped.controller.select("@settings");
  stopped.controller.openCreate();
  await stopped.controller.start(stopped.container);
  assert.equal(stopped.calls.status, reads);
  assert.equal(stopped.calls.begin, 1);
  assert.equal(stopped.calls.initialize, 0);
  assert.equal(stopped.calls.acquire, 0);
  const again = new NativeHostController(stopped.api, stopped.bridge);
  t.after(() => again.stop());
  await again.start(stopped.container);
  assert.equal(again.getSnapshot().phase, "service-stopped");
  assert.equal(stopped.controller.getSnapshot().phase, "service-stopped");
  assert.equal(stopped.calls.begin, 2);
  assert.equal(stopped.calls.directory, 0);
  assert.equal(stopped.calls.portal, 0);
  assert.equal(stopped.calls.initialize, 0);
  assert.equal(stopped.calls.child, 0);
});

test("a failed launch keeps both reasons and does not retry", async t => {
  const primary = "START_PRIMARY ".repeat(16).trimEnd();
  const failed = harness(t, { phase: "preparing" });
  await failed.start();
  failed.update("failed", { reasons: [primary, "STOP_SECONDARY"], failure: { stage: "endpoint", primaryReason: primary, cleanupReason: "STOP_SECONDARY", instanceRetained: true } });
  await failed.next();
  const failure = failed.controller.getSnapshot();
  assert.equal(failure.phase, "failed");
  assert.equal(failure.guide, false);
  assert.equal(failure.detail, primary);
  assert.equal(failure.cleanupDetail, "STOP_SECONDARY");
  assert.equal(failure.instanceRetained, true);
  failed.controller.select("@settings");
  assert.equal(failed.controller.getSnapshot().guide, true);
  const statusReads = failed.calls.status;
  await failed.next();
  failed.controller.showCurrent();
  failed.controller.openCreate();
  assert.equal(failed.calls.status, statusReads);
  assert.equal(failed.calls.begin, 1);
  assert.equal(failed.calls.initialize, 0);
  assert.equal(failed.calls.acquire, 0);
});

test("an observation error ends the launch without another read", async t => {
  const observed = harness(t, { phase: "preparing", statusError: true });
  await observed.start();
  await observed.next();
  assert.equal(observed.controller.getSnapshot().phase, "failed");
  assert.equal(observed.controller.getSnapshot().guide, false);
  assert.match(observed.controller.getSnapshot().detail ?? "", /controlled observation failure/);
  const observedReads = observed.calls.status;
  await observed.next();
  assert.equal(observed.calls.status, observedReads);
  assert.equal(observed.calls.begin, 1);
});

test("a missing launch observation interface fails without claiming the service stayed down", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let begins = 0;
  const missing = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    beginDesktopLaunch: async () => { begins++; return launchRecord("ready"); },
    presentationSnapshot: async () => { throw Error("must not read"); },
    initialize: async () => { throw Error("must not initialize"); },
    bootstrap: async () => { throw Error("must not bootstrap"); },
    returnTarget: async () => { throw Error("must not open"); },
  } as never, { acquire: async () => { throw Error("must not acquire"); }, release: async () => {} });
  t.after(() => missing.stop());
  await missing.start({} as HTMLElement);
  const detail = missing.getSnapshot().detail ?? "";
  assert.equal(missing.getSnapshot().phase, "failed");
  assert.equal(missing.getSnapshot().guide, false);
  assert.equal(detail, nativeTexts().desktopLaunchUnsupported);
  assert.match(detail, /无法确认|could not be confirmed/);
  assert.doesNotMatch(detail, /没有开始|did not start/);
  await missing.start({} as HTMLElement);
  missing.select("@settings");
  missing.openCreate();
  assert.equal(begins, 0);
});

test("disposal ignores a late launch result", async t => {
  const f = harness(t, { holdBegin: true });
  const pending = f.start();
  await flush();
  assert.equal(f.calls.begin, 1);
  f.controller.stop();
  const snapshot = f.controller.getSnapshot();
  f.begun.resolve(launchRecord("ready"));
  await pending; await flush();
  assert.equal(f.controller.getSnapshot(), snapshot);
  assert.equal(f.calls.directory, 0);
  assert.equal(f.calls.acquire, 0);
});

test("a confirmed manual restart returns a new controller for the supplied record", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const nextEpoch = "d".repeat(64);
  const operations: string[] = [];
  let begins = 0;
  let launch = launchRecord("failed", { operationId: "launch-one", serviceEpoch: null, reasons: ["first launch failed"] });
  const api = {
    role: async () => ({ role: "workspace" as const, profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] as string[] }),
    beginDesktopLaunch: async () => {
      begins++;
      launch = begins === 1
        ? launchRecord("failed", { operationId: "launch-one", serviceEpoch: null, reasons: ["first launch failed"] })
        : launchRecord("ready", { operationId: "launch-two", serviceEpoch: nextEpoch });
      operations.push(launch.operationId!);
      return launch;
    },
    desktopLaunchState: async () => launch,
    presentationSnapshot: async () => ({ serviceEpoch: nextEpoch, managerId: "hub", spaces: [] }),
    initialize: async () => { throw Error("must not initialize"); },
    bootstrap: async () => { throw Error("must not bootstrap"); },
    returnTarget: async () => ({ ...PORTAL }),
    previewServiceRestart: async () => ({ confirmationId: "confirm-1", expiresAt: "2099-01-01T00:00:00.000Z", action: "restart" as const, spaces: [] }),
    restartService: async (confirmationId: string) => {
      assert.equal(confirmationId, "confirm-1");
      return { ok: true, connected: true, unavailable: false, origin: null, reasons: [] };
    },
  };
  const bridge = { acquire: async () => { throw Error("must not acquire"); }, release: async () => {} };
  const current = new NativeHostController(api, bridge);
  t.after(() => current.stop());
  await current.start({} as HTMLElement);
  assert.equal(current.getSnapshot().phase, "failed");
  const next = await current.restartService("confirm-1");
  t.after(() => next.stop());
  assert.notEqual(next, current);
  assert.equal(current.getSnapshot().phase, "failed");
  assert.equal(next.getSnapshot().notice, nativeTexts().serviceStartedNotice);
  await next.start({} as HTMLElement);
  assert.deepEqual(operations, ["launch-one", "launch-two"]);
  assert.equal(begins, 2);
  assert.equal(current.getSnapshot().phase, "failed");
  assert.equal(next.getSnapshot().phase, "ready");
  assert.equal(next.getSnapshot().inventory?.serviceEpoch, nextEpoch);
  assert.equal(next.getSnapshot().inventory?.managerId, "hub");
});

for (const change of [{ operationId: "other-operation" }, { serviceEpoch: OTHER_EPOCH }, { managerId: "other-manager" }] as const)
  test("changed startup authority fails closed " + JSON.stringify(change), async t => {
    const held = { operationId: "first-operation", serviceEpoch: EPOCH, managerId: "hub" };
    const f = harness(t, { phase: "starting" });
    f.update("starting", held);
    await f.start();
    f.update("ready", { ...held, ...change });
    await f.next();
    const snapshot = f.controller.getSnapshot();
    assert.equal(snapshot.phase, "failed");
    assert.equal(snapshot.guide, false);
    assert.equal(snapshot.detail, nativeTexts().launchObservationEnded);
    assert.equal(snapshot.inventory, null);
    assert.doesNotMatch(snapshot.detail ?? "", /other-operation|other-manager|c{16}/);
    assert.equal(f.calls.directory, 0);
    assert.equal(f.calls.initialize, 0);
    assert.equal(f.calls.child, 0);
    const reads = f.calls.status;
    t.mock.timers.tick(10000); await flush();
    assert.equal(f.calls.status, reads);
    assert.equal(f.calls.begin, 1);
  });

test("the first directory fails when its epoch differs from the accepted launch", async t => {
  const epoch = harness(t, { phase: "ready", directoryEpoch: OTHER_EPOCH });
  await epoch.start();
  assert.equal(epoch.controller.getSnapshot().phase, "failed");
  assert.equal(epoch.controller.getSnapshot().inventory, null);
  assert.equal(epoch.controller.getSnapshot().detail, nativeTexts().launchObservationEnded);
  assert.equal(epoch.calls.acquire, 0);
});

test("the first directory fails when its manager differs from the accepted launch", async t => {
  const manager = harness(t, { phase: "ready", directoryManager: "other-manager" });
  await manager.start();
  assert.equal(manager.controller.getSnapshot().phase, "failed");
  assert.equal(manager.controller.getSnapshot().inventory, null);
  assert.equal(manager.calls.child, 0);
});

test("the first directory is published when epoch and manager match the launch", async t => {
  const matched = harness(t, { phase: "ready" });
  await matched.start();
  assert.equal(matched.controller.getSnapshot().phase, "ready");
  assert.equal(matched.controller.getSnapshot().selected, "current");
  assert.equal(matched.controller.getSnapshot().guide, false);
  assert.equal(matched.controller.getSnapshot().inventory?.serviceEpoch, EPOCH);
  assert.equal(matched.controller.getSnapshot().inventory?.managerId, "hub");
});
