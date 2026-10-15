import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeSpaceHash, nativePortalFailureHash, parseNativePortalFailureHash, portalFailureDetail,
  PORTAL_FAILURE_REASONS, PORTAL_FAILURE_CODES, NATIVE_PORTAL_FAILURE_HASH_LIMIT, type PortalFailure } from "../src/shared/space-host.ts";
import { renderPortalPage } from "../src/adapters/node/workbench-portal.ts";
import { bindDshCli, invocationProfile } from "../src/adapters/node/spaces-control.ts";
import { NativeHostController } from "../packages/plugin/src/client/native-host.tsx";

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

test("superseded native navigation rejection does not close the latest selection", async () => {
  let rejectFirst!: (error: Error) => void;
  let calls = 0;
  const controller = new NativeHostController({
    role: async () => ({ role: "workspace", profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] }),
    presentationSnapshot: async () => ({ serviceEpoch: "a".repeat(64), managerId: "hub", spaces: [] }),
  } as never, { acquire: async () => { throw Error("unused"); }, release: async () => {} });
  await controller.start({} as HTMLElement);
  Object.assign(controller, { opening: Promise.resolve(), nativeUrl: "http://127.0.0.1:3333/native/" + "a".repeat(32),
    guest: { loadURL: () => ++calls === 1 ? new Promise<void>((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(), remove() {} } });
  controller.select("@dashboard"); await tick();
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
    f.observe(f.nativeUrl + "#selected/1/@settings"); await tick();
    assert.strictEqual(f.controller.getSnapshot(), snapshot);
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
