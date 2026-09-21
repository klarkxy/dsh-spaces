import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDesktopStartup } from "../src/main/desktop-startup.ts";
import type { DesktopServicePublicStatus } from "../src/shared/desktop-shell.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options: {
  ready?: boolean;
  attached?: DesktopServicePublicStatus;
  attach?: () => Promise<DesktopServicePublicStatus>;
  start?: () => Promise<void>;
} = {}) {
  let status: DesktopServicePublicStatus = "idle";
  let ready = options.ready ?? true;
  let preparing = false;
  let installationFailed = false;
  let connects = 0;
  let starts = 0;
  const events: string[] = [];
  const startup = createDesktopStartup({
    status: () => status,
    canStart: () => ready && !preparing && !installationFailed,
    connect: async () => {
      connects += 1;
      events.push("connect");
      status = "connecting";
      status = options.attach ? await options.attach() : options.attached ?? "stopped";
      events.push(status);
    },
    start: async () => {
      starts += 1;
      events.push("start");
      status = "connecting";
      if (options.start) await options.start();
      status = "connected";
    },
  });
  return {
    startup, events,
    status: () => status,
    counts: () => ({ connects, starts }),
    setReady: (value: boolean) => { ready = value; },
    setPreparing: (value: boolean) => { preparing = value; },
    setInstallationFailed: () => { installationFailed = true; },
    setStatus: (value: DesktopServicePublicStatus) => { status = value; },
  };
}

test("opening an installed desktop attaches first and cold-starts once without a click", async () => {
  const h = harness();
  await h.startup.open();
  assert.deepEqual(h.events, ["connect", "stopped", "start"]);
  assert.equal(h.status(), "connected");
  assert.deepEqual(h.counts(), { connects: 1, starts: 1 });
});

test("a healthy existing service is attached without a second controller", async () => {
  const h = harness({ attached: "connected" });
  await h.startup.open();
  assert.equal(h.status(), "connected");
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});

test("a healthy existing service does not require a local runtime installation", async () => {
  const h = harness({ attached: "connected", ready: false });
  await h.startup.open();
  assert.equal(h.status(), "connected");
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});

test("a new computer waits for installation, then opens automatically without another attach", async () => {
  const h = harness({ ready: false });
  await h.startup.open();
  assert.equal(h.status(), "stopped");
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
  h.setReady(true);
  await h.startup.environmentPrepared();
  assert.equal(h.status(), "connected");
  assert.deepEqual(h.counts(), { connects: 1, starts: 1 });
});

test("incomplete preparation never starts a service", async () => {
  const h = harness({ ready: false });
  await h.startup.open();
  await h.startup.environmentPrepared();
  assert.equal(h.status(), "stopped");
  assert.equal(h.counts().starts, 0);
});

test("partially installed files do not start a service while installation is still running", async () => {
  const h = harness();
  h.setPreparing(true);
  await h.startup.open();
  assert.equal(h.counts().starts, 0);
  h.setPreparing(false);
  await h.startup.environmentPrepared();
  assert.equal(h.counts().starts, 1);
});

test("installation finishing during initial attach waits for the verified absence", async () => {
  const attached = deferred<DesktopServicePublicStatus>();
  const h = harness({ ready: false, attach: () => attached.promise });
  const opening = h.startup.open();
  h.setReady(true);
  await h.startup.environmentPrepared();
  assert.equal(h.counts().starts, 0);
  attached.resolve("stopped");
  await opening;
  assert.equal(h.status(), "connected");
  assert.deepEqual(h.counts(), { connects: 1, starts: 1 });
});

test("installation finishing before open does not bypass the initial attach", async () => {
  const h = harness();
  await h.startup.environmentPrepared();
  assert.deepEqual(h.counts(), { connects: 0, starts: 0 });
  await h.startup.open();
  assert.deepEqual(h.counts(), { connects: 1, starts: 1 });
});

test("installation finishing during a blocked attach cannot start another controller", async () => {
  const attached = deferred<DesktopServicePublicStatus>();
  const h = harness({ ready: false, attach: () => attached.promise });
  const opening = h.startup.open();
  h.setReady(true);
  await h.startup.environmentPrepared();
  attached.resolve("unavailable");
  await opening;
  await h.startup.environmentPrepared();
  assert.equal(h.status(), "unavailable");
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});

test("overlapping opens share a single attach and start", async () => {
  const attached = deferred<DesktopServicePublicStatus>();
  const h = harness({ attach: () => attached.promise });
  const first = h.startup.open();
  const second = h.startup.open();
  assert.equal(first, second);
  attached.resolve("stopped");
  await Promise.all([first, second]);
  assert.deepEqual(h.counts(), { connects: 1, starts: 1 });
});

test("overlapping installation notifications share the pending startup", async () => {
  const started = deferred<void>();
  const h = harness({ ready: false, start: () => started.promise });
  await h.startup.open();
  h.setReady(true);
  const first = h.startup.environmentPrepared();
  const second = h.startup.environmentPrepared();
  assert.equal(first, second);
  assert.equal(h.counts().starts, 1);
  started.resolve();
  await Promise.all([first, second]);
  assert.equal(h.status(), "connected");
});

test("a blocked or stale endpoint remains a failure with no automatic bootstrap", async () => {
  const h = harness({ attached: "unavailable" });
  await h.startup.open();
  await h.startup.environmentPrepared();
  await h.startup.open();
  assert.equal(h.status(), "unavailable");
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});

test("an attach exception is reported once, not retried by later startup signals", async () => {
  const failure = new Error("Controller identity is ambiguous");
  const h = harness({ attach: async () => { throw failure; } });
  await assert.rejects(h.startup.open(), (error) => error === failure);
  await assert.rejects(h.startup.open(), (error) => error === failure);
  await h.startup.environmentPrepared();
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});

test("a failed cold start is never automatically attempted again", async () => {
  const failure = new Error("Packaged supervisor payload is missing");
  const h = harness({ start: async () => { throw failure; } });
  await assert.rejects(h.startup.open(), (error) => error === failure);
  // Even a later clean-looking observation cannot turn failure into another launch.
  h.setStatus("stopped");
  await h.startup.environmentPrepared();
  await assert.rejects(h.startup.open(), (error) => error === failure);
  assert.deepEqual(h.counts(), { connects: 1, starts: 1 });
});

test("a synchronous startup exception also consumes the single automatic attempt", async () => {
  let starts = 0;
  const startup = createDesktopStartup({
    connect: async () => {}, status: () => "stopped", canStart: () => true,
    start: () => { starts += 1; throw new Error("invalid snapshot root"); },
  });
  await assert.rejects(startup.open(), /invalid snapshot root/);
  await startup.environmentPrepared();
  assert.equal(starts, 1);
});

test("a user-stopped service stays stopped after a successful automatic launch", async () => {
  const h = harness();
  await h.startup.open();
  h.setStatus("stopped");
  await h.startup.open();
  await h.startup.environmentPrepared();
  assert.equal(h.status(), "stopped");
  assert.deepEqual(h.counts(), { connects: 1, starts: 1 });
});

test("a user-stopped service also stays stopped after attaching an existing service", async () => {
  const h = harness({ attached: "connected" });
  await h.startup.open();
  h.setStatus("stopped");
  await h.startup.environmentPrepared();
  assert.equal(h.status(), "stopped");
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});

test("a later status change after a blocked launch does not trigger a second attempt", async () => {
  const h = harness({ attached: "unavailable" });
  await h.startup.open();
  h.setStatus("stopped");
  await h.startup.environmentPrepared();
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});

test("read-only status polling cannot continue a launch or replay a failed installation", async () => {
  const h = harness({ ready: false });
  await h.startup.open();
  h.setReady(true);
  for (let i = 0; i < 20; i += 1) assert.equal(h.status(), "stopped");
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
  // Only successful preparation emits this continuation, never its error handler.
  await h.startup.environmentPrepared();
  assert.equal(h.counts().starts, 1);
});

test("Electron wires launch and successful installation to the same coordinator", () => {
  const main = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  assert.match(main, /const startup = createDesktopStartup\(/);
  assert.match(main, /canStart: \(\) => !preparing && cliStatusSnapshot\(\)\.state !== "error" &&\s+toolchain\.kind !== "invalid" && toolsReady\(\)/);
  assert.match(main, /await startup\.open\(\)/);
  assert.match(main, /preparing = false;\s+await startup\.environmentPrepared\(\)/);
  assert.ok(main.indexOf('if (lastService.status === "unavailable") return "unavailable";') <
    main.indexOf('if (cliStatusSnapshot().state === "error" || !toolsReady()) return "needs-tools";'), "real attach failures must not become an install prompt");
  const acceptance = readFileSync(new URL("../scripts/verify-spaces-desktop.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(acceptance, /await start\.click\(\)/);
  assert.match(acceptance, /desktop launch automatically connected or started the workbench/);
});


test("a late attach cannot auto-start partially installed files after installation failed", async () => {
  const attached = deferred<DesktopServicePublicStatus>();
  const h = harness({ ready: false, attach: () => attached.promise });
  h.setPreparing(true);
  const opening = h.startup.open();
  h.setReady(true);
  h.setInstallationFailed();
  h.setPreparing(false);
  attached.resolve("stopped");
  await opening;
  assert.deepEqual(h.counts(), { connects: 1, starts: 0 });
});
