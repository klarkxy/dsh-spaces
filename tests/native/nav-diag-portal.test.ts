import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";
import { startWorkbenchHttp, type WorkbenchHttpRuntime } from "../../src/adapters/node/server/workbench-http.ts";
import { parseNavDiag, type NavDiagRecord } from "../../src/shared/nav-diag.ts";
import { parseNativePortalFailureHash } from "../../src/shared/space-host.ts";

const ORIGIN = "http://127.0.0.1:3333";
const MANAGER = "http://127.0.0.1:3334";
const EPOCH = "a".repeat(64);
const CHANNEL = "manager-channel";
const LEAK = "leak-sentinel-private-message";
const SPACE_NAME = "LeakSpaceName";

const portalSource = () => renderPortalPage(
  { parentOrigin: ORIGIN, channel: "b".repeat(32) },
  MANAGER,
  true,
).split("<script>")[1]!.split("</script>")[0]!;

type TimerRow = { fn: () => void; ms: number };
type Posted = { data: Record<string, unknown>; origin: string };

function records(logs: string[]): NavDiagRecord[] {
  return logs.map(line => {
    const row = parseNavDiag(line);
    assert.ok(row, line);
    return row;
  });
}

async function boot(options: { failState?: { status: number; code: string; message: string }; throwConsole?: boolean } = {}) {
  const logs: string[] = [];
  const fetches: string[] = [];
  const posts: Posted[] = [];
  const appended: unknown[] = [];
  const timers = new Map<number, TimerRow>();
  const listeners = new Map<string, (event?: { source?: unknown; origin?: string; data?: unknown }) => void>();
  let timerId = 0;
  const managerWindow = { postMessage: (data: Record<string, unknown>, origin: string) => { posts.push({ data, origin }); } };
  const iframe = {
    title: "", referrerPolicy: "", allow: "", src: "", removed: false, onload: undefined as undefined | (() => void),
    contentWindow: managerWindow,
    addEventListener: (type: string, fn: () => void) => { if (type === "load") iframe.onload = fn; },
    remove: () => { iframe.removed = true; },
  };
  const location = { origin: ORIGIN, hash: "#select/1/@settings", replace(value: string) { this.hash = value; } };
  const state = {
    protocolVersion: 2, availability: "ready", serviceEpoch: EPOCH, managerId: "hub",
    spaces: [{ id: "hub", displayName: SPACE_NAME, status: "running", generation: 1, hasWebApp: true }],
  };
  const view = {
    spaceId: "hub", generation: 1, serviceEpoch: EPOCH, entryOrigin: ORIGIN, origin: MANAGER,
    entryPath: "/view/hub/1", channel: CHANNEL,
  };
  const schedule = (fn: () => void, ms?: number) => {
    const id = ++timerId;
    timers.set(id, { fn, ms: ms ?? 0 });
    return id;
  };
  new Script(portalSource()).runInNewContext({
    location, URL, TextDecoder, AbortController, AbortSignal,
    console: { log: (line: unknown) => { if (options.throwConsole) throw new Error("console failed"); logs.push(String(line)); } },
    document: {
      getElementById: () => ({ remove() {} }),
      createElement: () => iframe,
      body: { append: (node: unknown) => { appended.push(node); } },
    },
    window: { addEventListener: (name: string, fn: (event?: { source?: unknown; origin?: string; data?: unknown }) => void) => listeners.set(name, fn) },
    fetch: async (url: string) => {
      fetches.push(url);
      const method = url.slice(url.lastIndexOf("/") + 1);
      if (options.failState && method === "state") {
        return Response.json({ ok: false, error: { code: options.failState.code, message: options.failState.message } }, { status: options.failState.status });
      }
      if (method === "state") return Response.json({ ok: true, value: state });
      if (method === "view") return Response.json({ ok: true, value: view });
      throw new Error("unexpected " + method);
    },
    setTimeout: schedule, clearTimeout: (id?: number) => { if (id != null) timers.delete(id); },
    setInterval: schedule, clearInterval: (id?: number) => { if (id != null) timers.delete(id); },
  });
  await tick();
  return { logs, fetches, posts, appended, timers, listeners, iframe, managerWindow, location };
}

function deliver(world: Awaited<ReturnType<typeof boot>>, data: Record<string, unknown>, origin = MANAGER, source: unknown = world.managerWindow) {
  world.listeners.get("message")!({ source, origin, data });
}

const identity = { serviceEpoch: EPOCH, spaceId: "hub", generation: 1, channel: CHANNEL };
const viewReady = { source: "dsh-spaces-view", state: "ready", ...identity };
const surfaceReady = { source: "dsh-spaces-surface", type: "ready", ...identity };

function timerOf(world: Awaited<ReturnType<typeof boot>>, ms: number): TimerRow {
  const rows = [...world.timers.values()].filter(row => row.ms === ms);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

function assertClosed(logs: string[]) {
  const text = logs.join("\n");
  assert.equal(text.includes(EPOCH), false);
  assert.equal(text.includes(CHANNEL), false);
  assert.equal(text.includes(SPACE_NAME), false);
  assert.equal(text.includes(LEAK), false);
  assert.equal(text.includes("/view/hub/1"), false);
}

test("native portal handshake reaches the first settings selection and then stops logging", async () => {
  const world = await boot();
  assert.equal(world.appended.length, 1);
  assert.equal(world.fetches.length, 2);
  const ready = timerOf(world, 35000);
  world.iframe.onload?.();
  deliver(world, viewReady);
  deliver(world, surfaceReady);
  assert.equal(world.posts.filter(post => post.data.type === "select").length, 1);
  const beforeStale = world.logs.length;
  ready.fn();
  assert.equal(world.logs.length, beforeStale);
  assert.equal(world.location.hash, "#select/1/@settings");
  deliver(world, { source: "dsh-spaces-surface", type: "selected", requestId: 1, target: "@settings", ...identity });
  assert.equal(world.location.hash, "#selected/1/@settings");
  const rows = records(world.logs);
  assert.deepEqual(rows.map(row => row.ev), [
    "document-start", "api-request", "api-result", "select-receive", "api-request", "api-result",
    "iframe-append", "iframe-load", "view-ready", "surface-ready", "select-forward", "select-result",
  ]);
  assert.equal(rows[1]!.stage, "state");
  assert.deepEqual({ status: rows[2]!.status, ok: rows[2]!.ok, stage: rows[2]!.stage }, { status: 200, ok: true, stage: "state" });
  assert.equal(rows[5]!.stage, "view");
  assert.equal(rows[8]!.accepted, true);
  assert.equal(rows[9]!.accepted, true);
  assert.equal(rows.at(-1)!.result, "selected");
  assertClosed(world.logs);
  const marked = world.logs.length;
  timerOf(world, 1500).fn();
  await tick();
  world.listeners.get("pagehide")!();
  assert.equal(world.logs.length, marked);
});

test("rejected manager messages keep the real 35s view deadline and stop further fetch and iframe work", async () => {
  const world = await boot();
  const ready = timerOf(world, 35000);
  assert.equal(ready.ms, 35000);
  const foreign = { postMessage() {} };
  deliver(world, viewReady, MANAGER, foreign);
  deliver(world, viewReady, "http://127.0.0.1:9");
  deliver(world, { ...viewReady, serviceEpoch: "b".repeat(64) });
  deliver(world, { ...surfaceReady, serviceEpoch: "c".repeat(64) });
  assert.equal(world.posts.filter(post => post.data.type === "select").length, 0);
  assert.equal(world.location.hash, "#select/1/@settings");
  const fetches = world.fetches.length;
  const frames = world.appended.length;
  const poll = timerOf(world, 1500);
  ready.fn();
  assert.deepEqual(parseNativePortalFailureHash(world.location.hash), { reason: "view-ready-timeout" });
  const rows = records(world.logs);
  assert.equal(rows.find(row => row.ev === "deadline")!.stage, "view");
  assert.equal(rows.find(row => row.ev === "fail")!.reason, "view-ready-timeout");
  assert.equal(rows.at(-1)!.ev, "terminal");
  const marked = world.logs.length;
  poll.fn();
  await tick();
  assert.equal(world.logs.length, marked);
  assert.equal(world.fetches.length, fetches);
  assert.equal(world.appended.length, frames);
  assert.equal(world.iframe.removed, true);
  assertClosed(world.logs);
});

test("a ready manager that never answers selection ends on the real 35s selection deadline", async () => {
  const world = await boot();
  world.iframe.onload?.();
  deliver(world, viewReady);
  deliver(world, surfaceReady);
  const selection = timerOf(world, 35000);
  assert.equal(selection.ms, 35000);
  selection.fn();
  assert.equal(world.location.hash, "#rejected/1/@settings");
  const rows = records(world.logs);
  const deadline = rows.find(row => row.ev === "deadline");
  assert.equal(deadline?.stage, "selection");
  assert.equal(rows.at(-1)!.ev, "select-result");
  assert.equal(rows.at(-1)!.result, "rejected");
  const marked = world.logs.length;
  timerOf(world, 1500).fn();
  await tick();
  world.listeners.get("pagehide")!();
  deliver(world, { source: "dsh-spaces-surface", type: "selected", requestId: 1, target: "@settings", ...identity });
  assert.equal(world.logs.length, marked);
  assert.equal(world.location.hash, "#rejected/1/@settings");
  assertClosed(world.logs);
});

test("portal HTTP failure keeps the status and code and omits the server message", async () => {
  const world = await boot({ failState: { status: 401, code: "workbench/unauthorized", message: LEAK } });
  assert.deepEqual(parseNativePortalFailureHash(world.location.hash), {
    reason: "state-request", code: "workbench/unauthorized", status: 401,
  });
  const rows = records(world.logs);
  assert.deepEqual(rows.map(row => row.ev), ["document-start", "api-request", "api-result", "fail", "terminal"]);
  assert.deepEqual(
    { stage: rows[2]!.stage, status: rows[2]!.status, ok: rows[2]!.ok, code: rows[2]!.code },
    { stage: "state", status: 401, ok: false, code: "workbench/unauthorized" },
  );
  assert.equal(rows[3]!.reason, "state-request");
  assert.equal(rows[3]!.status, 401);
  assert.equal(world.fetches.length, 1);
  assert.equal(world.appended.length, 0);
  assert.equal(world.logs.join("\n").includes(LEAK), false);
});

test("pagehide is terminal and later timers do not log", async () => {
  const world = await boot();
  const ready = timerOf(world, 35000);
  const poll = timerOf(world, 1500);
  world.listeners.get("pagehide")!();
  const rows = records(world.logs);
  assert.equal(rows.at(-1)!.ev, "terminal");
  const marked = world.logs.length;
  ready.fn();
  poll.fn();
  await tick();
  world.listeners.get("pagehide")!();
  assert.equal(world.logs.length, marked);
  assert.equal(world.location.hash, "#select/1/@settings");
  assert.equal(world.iframe.removed, false);
});

test("a throwing diagnostic console still produces the original HTTP failure", async () => {
  const world = await boot({ failState: { status: 503, code: "workbench/unavailable", message: LEAK }, throwConsole: true });
  assert.deepEqual(parseNativePortalFailureHash(world.location.hash), {
    reason: "state-request", code: "workbench/unavailable", status: 503,
  });
  assert.equal(world.logs.length, 0);
  assert.equal(world.appended.length, 0);
});

test("child bootstrap script keeps the destination and logs markers without the token", async () => {
  const token = "synthetic-bootstrap-token";
  const dest = "http://127.0.0.1:43111/?token=" + token;
  const secret = "synthetic-bootstrap-secret";
  let origin = "http://127.0.0.1:9";
  const host: WorkbenchHttpRuntime = {
    cookieName: () => "dsh-auth-test",
    sessionCookie: () => "session",
    sessionEquals: value => value === "session",
    consumeBootstrapToken: () => false,
    hostBearerEquals: () => false,
    supervisorOrigin: () => origin,
    managerOrigin: () => MANAGER,
    isWorkspaceOrigin: () => false,
    dispatch: async () => { throw new Error("unused"); },
    entryPage: () => "",
    mintHandoff: () => "",
    viewEntry: async () => ({ setCookies: [`dsh-auth=${secret}; Path=/; HttpOnly; SameSite=Strict`], location: dest }),
  };
  const http = await startWorkbenchHttp(host, 0);
  origin = http.origin;
  try {
    const response = await fetch(`${origin}/view/hub/1?epoch=${EPOCH}`, { headers: { cookie: "dsh-auth-test=session" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    assert.equal(response.headers.get("set-cookie")?.includes(secret), true);
    const html = await response.text();
    const metaAt = html.indexOf('<meta http-equiv="refresh"');
    const scriptAt = html.indexOf("<script>");
    assert.ok(metaAt !== -1 && scriptAt !== -1 && metaAt < scriptAt);
    assert.equal(html.includes(`content="0;url=${dest}"`), true);
    assert.equal(html.includes(secret), false);
    const order: string[] = [];
    let replaced = "";
    const logs: string[] = [];
    new Script(html.slice(scriptAt + "<script>".length, html.indexOf("</script>"))).runInNewContext({
      console: { log: (line: unknown) => { logs.push(String(line)); order.push("log"); } },
      location: { replace: (value: string) => { replaced = value; order.push("replace"); } },
    });
    assert.deepEqual(order, ["log", "replace", "log"]);
    assert.equal(replaced, dest);
    assert.deepEqual(records(logs).map(row => row.ev), ["script-run", "replace-call"]);
    assert.equal(logs.join("\n").includes(token), false);
    assert.equal(logs.join("\n").includes(dest), false);
  } finally {
    await http.close();
  }
});
