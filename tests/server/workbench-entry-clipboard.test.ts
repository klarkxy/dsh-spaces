import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderEntryPage,
  startWorkbenchHttp,
  type WorkbenchHttpRuntime,
} from "../../src/adapters/node/server/workbench-http.ts";
import { renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";

const HOST = "127.0.0.1";
const EPOCH = "aa".repeat(32);
const SHARE = "DSHBP1:J:clipboard-write-ok";
const SESSION = "session";
const COOKIE = "dsh-auth-test";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const playwrightRoot = process.env.DSH_TEST_PLAYWRIGHT || join(root, "node_modules/playwright");

const MANAGER_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>manager</title></head>
<body>
<button id="copy" type="button">copy</button>
<p id="status">idle</p>
<script>
document.getElementById("copy").addEventListener("click", async () => {
  const status = document.getElementById("status");
  try {
    await navigator.clipboard.writeText(${JSON.stringify(SHARE)});
    status.textContent = "wrote";
  } catch (error) {
    status.textContent = "fail:" + (error && error.name ? error.name : "error");
  }
});
</script>
</body>
</html>`;

const IFRAME_WITH_ALLOW =
  '<iframe id="manager-frame" title="spaces-hub" hidden allow="clipboard-write *"></iframe>';
const IFRAME_WITHOUT_ALLOW = '<iframe id="manager-frame" title="spaces-hub" hidden></iframe>';

type Chromium = {
  launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{
    close: () => Promise<void>;
    newContext: (opts?: { permissions?: string[] }) => Promise<BrowserContext>;
  }>;
};

type BrowserContext = {
  close: () => Promise<void>;
  grantPermissions: (permissions: string[], opts?: { origin?: string }) => Promise<void>;
  addCookies: (cookies: Array<{ name: string; value: string; url: string; httpOnly?: boolean; sameSite?: string }>) => Promise<void>;
  newPage: () => Promise<Page>;
};

type Locator = {
  click: () => Promise<void>;
  waitFor: (opts?: { state?: string; timeout?: number }) => Promise<void>;
  textContent: () => Promise<string | null>;
  getAttribute: (name: string) => Promise<string | null>;
  evaluate: <T>(fn: (element: HTMLElement) => T) => Promise<T>;
};

type FrameLocator = { locator: (sel: string) => Locator; frameLocator: (sel: string) => FrameLocator };

type RouteResponse = { text: () => Promise<string> };
type Route = {
  fetch: () => Promise<RouteResponse>;
  fulfill: (options: { response: RouteResponse; body: string }) => Promise<void>;
};

type Page = {
  goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
  locator: (sel: string) => Locator;
  frameLocator: (sel: string) => FrameLocator;
  route: (pattern: string, handler: (route: Route) => Promise<void>) => Promise<void>;
  evaluate: (fn: () => unknown) => Promise<unknown>;
  bringToFront: () => Promise<void>;
  close: () => Promise<void>;
};

function liveState() {
  return {
    protocolVersion: 2,
    serviceEpoch: EPOCH,
    revision: "bb".repeat(32),
    availability: "ready",
    role: "manager",
    managerId: "spaces-hub",
    owner: { kind: "web", since: "2026-09-21T00:00:00.000Z" },
    writable: true,
    mode: "verified-full",
    dshVersion: "0.1.5-rc.2",
    maintenance: false,
    reasons: [],
    spaces: [
      {
        id: "spaces-hub",
        displayName: "Hub",
        status: "running",
        generation: 1,
        hasWebApp: true,
      },
    ],
    jobs: [],
  };
}

function entryHtml(): string {
  return renderEntryPage({
    managerRunning: true,
    managerViewPath: "/view/spaces-hub/1",
    maintenance: false,
    writable: true,
    reasons: [],
    serviceEpoch: EPOCH,
  });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({
        url: `http://${HOST}:${address.port}`,
        close: () =>
          new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

async function launchChromium(chromium: Chromium) {
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

function runtime(input: {
  originOf: () => string;
  managerUrl: () => string;
  page: () => string;
}): WorkbenchHttpRuntime {
  return {
    cookieName: () => COOKIE,
    sessionCookie: () => SESSION,
    sessionEquals: (value) => value === SESSION,
    consumeBootstrapToken: () => false,
    hostBearerEquals: (value) => value === "test-bearer",
    supervisorOrigin: input.originOf,
    managerOrigin: () => input.managerUrl(),
    isWorkspaceOrigin: () => false,
    dispatch: async (method) => {
      if (method === "state") return liveState();
      throw new Error(method);
    },
    entryPage: input.page,
    viewEntry: async () => ({
      setCookies: [],
      location: `${input.managerUrl()}/`,
    }),
    mintHandoff: () => "",
  };
}

async function clickIframeCopy(page: Page): Promise<string> {
  await page.locator("#manager-frame").waitFor({ state: "visible", timeout: 15_000 });
  const copy = page.frameLocator("#manager-frame").locator("#copy");
  await copy.waitFor({ state: "visible", timeout: 15_000 });
  await copy.click();
  const status = page.frameLocator("#manager-frame").locator("#status");
  await status.waitFor({ state: "visible", timeout: 15_000 });
  for (let i = 0; i < 20; i += 1) {
    const text = (await status.textContent()) ?? "";
    if (text !== "idle") return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await status.textContent()) ?? "";
}

async function withClipboardFixture(
  t: { after: (fn: () => Promise<void>) => void },
  pageHtml: string,
): Promise<{ httpOrigin: string; page: Page }> {
  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as { chromium: Chromium };
  const manager = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(MANAGER_PAGE);
  });
  t.after(() => manager.close());

  let origin = `http://${HOST}:9`;
  const http = await startWorkbenchHttp(
    runtime({
      originOf: () => origin,
      managerUrl: () => manager.url,
      page: () => pageHtml,
    }),
    0,
  );
  origin = http.origin;
  t.after(() => http.close());

  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  t.after(() => context.close());
  const primed = await context.newPage();
  await primed.goto(manager.url, { waitUntil: "load" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: manager.url });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: http.origin });
  await primed.close();
  await context.addCookies([
    { name: COOKIE, value: SESSION, url: http.origin, httpOnly: true, sameSite: "Strict" },
  ]);
  const page = await context.newPage();
  await page.goto(http.origin, { waitUntil: "load" });
  return { httpOrigin: http.origin, page };
}

test("entry page delegates clipboard-write on the guarded manager iframe", () => {
  const html = entryHtml();
  assert.equal(html.includes(IFRAME_WITH_ALLOW), true);
  assert.doesNotMatch(html, /clipboard-read/);
  assert.doesNotMatch(html, /permissions-policy/i);
  assert.match(html, /\/view\/" \+ encodeURIComponent\(manager\.id\)/);
});

test("two-origin Chromium write uses iframe delegation; top-level read only", { timeout: 120_000 }, async (t) => {
  const { httpOrigin, page } = await withClipboardFixture(t, entryHtml());
  const headers = await fetch(httpOrigin, { headers: { cookie: `${COOKIE}=${SESSION}` } });
  assert.equal(headers.ok, true);
  const csp = headers.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-src 'self' http:\/\/127\.0\.0\.1:\*/);
  assert.equal(headers.headers.get("permissions-policy"), null);

  const status = await clickIframeCopy(page);
  assert.equal(status, "wrote");
  await page.bringToFront();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, SHARE);
});

test("granting ephemeral clipboard permission does not replace iframe clipboard-write delegation", { timeout: 120_000 }, async (t) => {
  const html = entryHtml().replace(IFRAME_WITH_ALLOW, IFRAME_WITHOUT_ALLOW);
  assert.equal(html.includes("allow="), false);
  const { page } = await withClipboardFixture(t, html);
  const status = await clickIframeCopy(page);
  assert.match(status, /^fail:/);
  await page.bringToFront();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.notEqual(copied, SHARE);
});

const PORTAL_CHANNEL = "cc".repeat(16);
const MANAGER_CHANNEL = "manager-clipboard-view";

async function withPortalClipboardFixture(
  t: { after: (fn: () => Promise<void>) => void },
  options: { legacyInner?: boolean; missingOuterAllow?: boolean } = {},
) {
  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as { chromium: Chromium };
  const manager = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(MANAGER_PAGE);
  });
  t.after(() => manager.close());
  let origin = `http://${HOST}:9`, portalPath = "";
  const parent = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body>
<iframe id="portal-frame" title="Spaces surface" src="${origin}${portalPath}" ${options.missingOuterAllow ? "" : 'allow="clipboard-write"'} style="width:800px;height:600px;border:0"></iframe>
<script>
let selected = false;
window.addEventListener('message', event => {
 const frame = document.getElementById('portal-frame');
 if (selected || event.source !== frame.contentWindow || event.origin !== ${JSON.stringify(origin)} ||
     event.data?.source !== 'dsh-spaces-portal' || event.data?.channel !== ${JSON.stringify(PORTAL_CHANNEL)} || event.data?.type !== 'state') return;
 selected = true;
 frame.contentWindow.postMessage({source:'dsh-spaces-portal-parent',channel:${JSON.stringify(PORTAL_CHANNEL)},type:'select',requestId:1,spaceId:null}, ${JSON.stringify(origin)});
});
</script></body></html>`);
  });
  t.after(() => parent.close());
  const host = runtime({ originOf: () => origin, managerUrl: () => manager.url, page: entryHtml });
  host.dispatch = async method => {
    if (method === "state") return liveState();
    if (method === "view") return { spaceId: "spaces-hub", generation: 1, serviceEpoch: EPOCH,
      entryOrigin: origin, entryPath: "/view/spaces-hub/1", origin: manager.url, channel: MANAGER_CHANNEL };
    throw new Error(method);
  };
  const http = await startWorkbenchHttp(host, 0); origin = http.origin;
  t.after(() => http.close());
  const minted = await fetch(`${origin}/internal/portal`, { method: "POST",
    headers: { "content-type": "application/json", origin, authorization: "Bearer test-bearer" },
    body: JSON.stringify({ parentOrigin: parent.url, channel: PORTAL_CHANNEL }),
  });
  assert.equal(minted.status, 200);
  portalPath = (await minted.json() as { path: string }).path;
  const bootstrap = await fetch(`${origin}/view/spaces-hub/1?epoch=${EPOCH}`, { headers: { cookie: `${COOKIE}=${SESSION}` } });
  assert.equal(bootstrap.headers.get("permissions-policy"), null);
  assert.match(await bootstrap.text(), /http-equiv="refresh"/);
  const browser = await launchChromium(chromium); t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  t.after(() => context.close());
  const page = await context.newPage();
  if (options.legacyInner) {
    // route() intercepts the initial request, not each hop of a redirect chain.
    await page.route(`${origin}/portal-bootstrap/*`, async route => {
      const response = await route.fetch(); const body = await response.text();
      const old = body.replace('frame.allow = "clipboard-write " + view.origin;', 'frame.allow = "clipboard-write";');
      assert.notEqual(old, body, "regression fixture must remove the exact-origin delegation");
      await route.fulfill({ response, body: old });
    });
  }
  await page.goto(parent.url, { waitUntil: "load" });
  const portal = page.frameLocator("#portal-frame");
  const innerFrame = portal.locator('iframe[title="Spaces workbench"]');
  await innerFrame.waitFor({ state: "visible", timeout: 15_000 });
  const managerFrame = portal.frameLocator('iframe[title="Spaces workbench"]');
  const copy = managerFrame.locator("#copy"); await copy.waitFor({ state: "visible", timeout: 15_000 });
  const status = managerFrame.locator("#status");
  return { page, origin, managerOrigin: manager.url, innerFrame, status, copy };
}

function clipboardPolicy() {
  const policy = (document as Document & { featurePolicy?: { allowsFeature(feature: string): boolean } }).featurePolicy;
  return { origin: location.origin, write: policy?.allowsFeature("clipboard-write"), read: policy?.allowsFeature("clipboard-read") };
}

async function clickPortalCopy(fixture: Awaited<ReturnType<typeof withPortalClipboardFixture>>) {
  await fixture.copy.click();
  for (let i = 0; i < 40; i++) {
    const status = await fixture.status.textContent();
    if (status !== "idle") return status;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return fixture.status.textContent();
}

test("portal scopes clipboard-write to its validated final manager origin", () => {
  const html = renderPortalPage({ parentOrigin: "http://127.0.0.1:19786", channel: PORTAL_CHANNEL }, "http://127.0.0.1:3101");
  assert.match(html, /view\.origin !== audience\.managerOrigin/);
  assert.match(html, /frame\.allow = "clipboard-write " \+ view\.origin/);
  assert.doesNotMatch(html, /clipboard-write \*/);
  assert.doesNotMatch(html, /clipboard-read/);
});

test("three-origin portal delegates write across Supervisor bootstrap navigation and denies clipboard-read", { timeout: 120_000 }, async t => {
  const fixture = await withPortalClipboardFixture(t);
  assert.equal(await fixture.innerFrame.getAttribute("allow"), `clipboard-write ${fixture.managerOrigin}`);
  assert.match(await fixture.innerFrame.getAttribute("src") ?? "", new RegExp(`^${fixture.origin}/view/`));
  const policy = await fixture.status.evaluate(clipboardPolicy);
  assert.deepEqual(policy, { origin: fixture.managerOrigin, write: true, read: false });
  assert.equal(await clickPortalCopy(fixture), "wrote");
  await fixture.page.bringToFront();
  assert.equal(await fixture.page.evaluate(() => navigator.clipboard.readText()), SHARE);
});

test("three-origin portal reproduces the bare-src delegation failure after manager navigation", { timeout: 120_000 }, async t => {
  const fixture = await withPortalClipboardFixture(t, { legacyInner: true });
  assert.equal(await fixture.innerFrame.getAttribute("allow"), "clipboard-write");
  assert.equal((await fixture.status.evaluate(clipboardPolicy)).write, false);
  assert.match(await clickPortalCopy(fixture) ?? "", /^fail:/);
});

test("three-origin portal cannot grant clipboard-write when its parent omits delegation", { timeout: 120_000 }, async t => {
  const fixture = await withPortalClipboardFixture(t, { missingOuterAllow: true });
  assert.equal((await fixture.status.evaluate(clipboardPolicy)).write, false);
  assert.match(await clickPortalCopy(fixture) ?? "", /^fail:/);
});
