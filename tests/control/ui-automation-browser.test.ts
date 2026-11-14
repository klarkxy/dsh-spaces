/**
 * Real-browser UI automation acceptance: a local HTTP fixture plays the
 * child space (cookie-gated root, buttons, inputs, script/style payloads)
 * and the real playwright-core engine drives a system Chrome/Edge channel.
 * Requires a system Edge or Chrome install; the whole file skips when the
 * deterministic channel probe finds neither. Never downloads a browser.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPublicError } from "../../src/shared/control.ts";
import { UiAutomationManager, type UiAutomationPorts } from "../../src/adapters/node/supervisor/ui-automation.ts";
import { findBrowserChannel, PlaywrightUiEngine } from "../../src/adapters/node/supervisor/ui-playwright.ts";
import { bindInitialLoopbackHttp } from "../../src/adapters/node/server/workbench-http.ts";

const TOKEN = randomBytes(12).toString("hex");
const COOKIE = `dsh-auth-fixture=${randomBytes(12).toString("hex")}`;
const COOKIE_VALUE = COOKIE.split("=", 2)[1]!;

const PAGE = `<!doctype html><html><head><style>body{color:#000}</style>
<script>window.__fixtureScript = "should-not-appear";</script></head>
<body>
<h1>Fixture Space</h1>
<button id="go" onclick="document.getElementById('count').textContent = 'clicked'">Go</button>
<span id="count">idle</span>
<input id="name" aria-label="Name" />
<select id="choice"><option value="a">A</option><option value="b">B</option></select>
<a href="/inner?q=1">Inner</a>
<div id="img" data-large="${"A".repeat(600)}" style="border:0">x</div>
<img id="thumb" src="data:image/png;base64,${"iVBORw0KGgo".repeat(80)}" />
</body></html>`;

let server: Server;
let origin = "";
let manager: UiAutomationManager;
const REG = "reg-1";
const mutable = { status: "running" as const, generation: 3, epoch: "e".repeat(64) };

before(async () => {
  const bound = await bindInitialLoopbackHttp(() => createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (url.searchParams.get("token") === TOKEN) {
      // Simulated launch exchange: 303 + Set-Cookie + clean redirect.
      res.writeHead(303, { "set-cookie": `${COOKIE}; HttpOnly; Path=/`, location: "./" });
      res.end();
      return;
    }
    const cookie = req.headers.cookie ?? "";
    if (!cookie.includes(COOKIE.split("=", 2)[0]!)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("gate");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }));
  server = bound.server;
  origin = `http://127.0.0.1:${bound.port}`;
  const ports: UiAutomationPorts = {
    requireSpace: (spaceId) => (spaceId === "space-fixture" ? spaceId : (() => { throw new Error("not found"); })()),
    managerId: () => "spaces-hub",
    unmanaged: () => false,
    statusOf: () => mutable.status,
    generationOf: () => mutable.generation,
    spawned: () => true,
    urlOf: () => `${origin}/?token=${TOKEN}`,
    portOf: () => (server.address() as { port: number }).port,
    currentServiceEpoch: () => mutable.epoch,
    fetch: globalThis.fetch.bind(globalThis),
    resolveEngine: () => PlaywrightUiEngine.create(),
  };
  manager = new UiAutomationManager(ports);
});

after(async () => {
  await manager?.closeAll();
  server?.close();
});

test("without the cookie the fixture gate denies the page", async () => {
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 403);
  const withCookie = await fetch(`${origin}/`, { headers: { cookie: COOKIE } });
  assert.equal(withCookie.status, 200);
});

test("ui automation over the real system browser", async (t) => {
  const channel = findBrowserChannel();
  if (!channel) {
    t.skip("no system Chrome/Edge installation found");
    return;
  }
  const opened = await manager.open(REG, "space-fixture");
  assert.match(opened.uiSessionId, /^ui-[a-f0-9]{32}$/);
  assert.equal(opened.path, "/");
  assert.deepEqual(opened.viewport, { width: 1280, height: 720 });
  assert.ok(!JSON.stringify(opened).includes(COOKIE_VALUE));
  assert.ok(!JSON.stringify(opened).includes(TOKEN));

  // Idempotent re-open.
  assert.equal((await manager.open(REG, "space-fixture")).uiSessionId, opened.uiSessionId);

  const snap = await manager.snapshot(REG, { uiSessionId: opened.uiSessionId });
  assert.equal(snap.title, "");
  assert.match(snap.aria ?? "", /button "Go" \[ref=e\d+\]/);
  const goRef = (snap.aria!.match(/button "Go" \[ref=(e\d+)\]/) ?? [])[1]!;

  // html format is sanitized: no script/style content, no style attributes,
  // oversized data: payload attributes stripped.
  const html = (await manager.snapshot(REG, {
    uiSessionId: opened.uiSessionId, formats: ["html"],
  })).html!;
  assert.ok(!html.includes("should-not-appear"), html.slice(0, 200));
  assert.ok(!/style=/.test(html), html.slice(0, 200));
  assert.ok(!html.includes("A".repeat(600)), "oversized base64-like attribute stripped");
  assert.ok(!html.includes("iVBORw0KGgo".repeat(80)), "data: URI attribute stripped");
  assert.ok(html.includes('data-large="[stripped]"'), "attribute name is kept");

  // click by ref changes page state; act idempotent by requestId.
  await manager.act(REG, { uiSessionId: opened.uiSessionId, requestId: "r-click", act: { kind: "click", ref: goRef } });
  const afterClick = await manager.snapshot(REG, { uiSessionId: opened.uiSessionId });
  assert.match(afterClick.aria ?? "", /clicked/);
  await manager.act(REG, { uiSessionId: opened.uiSessionId, requestId: "r-click", act: { kind: "click", ref: goRef } });
  await assert.rejects(
    () => manager.act(REG, { uiSessionId: opened.uiSessionId, requestId: "r-click", act: { kind: "wait", ms: 1 } }),
    (error: unknown) => error instanceof ControlPublicError && error.code === "control/request-conflict");

  // type into the input by ref, then eval reads values — but document.cookie
  // is HttpOnly and never visible to page script or the result.
  const inputRef = (snap.aria!.match(/textbox "Name" \[ref=(e\d+)\]/) ?? [])[1]!;
  await manager.act(REG, { uiSessionId: opened.uiSessionId, requestId: "r-type", act: { kind: "type", ref: inputRef, text: "abc" } });
  const evaluated = await manager.eval(REG, {
    uiSessionId: opened.uiSessionId, requestId: "r-eval",
    script: "return { name: document.getElementById('name').value, cookie: document.cookie, cookies: document.cookie.length }",
  });
  const value = evaluated.value as { name?: string; cookie?: string };
  assert.equal(value.name, "abc");
  assert.equal(value.cookie, "", "the HttpOnly session cookie is not readable");
  assert.ok(!JSON.stringify(evaluated).includes(COOKIE_VALUE));

  // screenshot arrives as PNG bytes for the host to persist.
  const shot = await manager.snapshot(REG, {
    uiSessionId: opened.uiSessionId, formats: ["screenshot"], ref: goRef,
  });
  assert.equal(Buffer.from(shot.screenshot!, "base64").subarray(0, 4).toString("hex"), "89504e47");

  // navigate stays inside the space root.
  await manager.act(REG, { uiSessionId: opened.uiSessionId, requestId: "r-nav", act: { kind: "navigate", path: "/inner?q=1" } });
  const inner = await manager.snapshot(REG, { uiSessionId: opened.uiSessionId });
  assert.equal(inner.path, "/inner?q=1");

  // close releases the session; subsequent ops report not-found.
  await manager.close(REG, opened.uiSessionId);
  await assert.rejects(() => manager.snapshot(REG, { uiSessionId: opened.uiSessionId }),
    (error: unknown) => error instanceof ControlPublicError && error.code === "control/not-found");
});
