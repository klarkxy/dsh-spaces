import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeSpaceHash } from "../src/shared/space-host.ts";
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
