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
} from "../src/adapters/node/workbench-http.ts";

const HOST = "127.0.0.1";
const EPOCH = "aa".repeat(32);
const SHARE = "DSHBP1:J:clipboard-write-ok";
const SESSION = "session";
const COOKIE = "dsh-auth-test";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
};

type Page = {
  goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
  locator: (sel: string) => Locator;
  frameLocator: (sel: string) => { locator: (sel: string) => Locator };
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
    owner: { kind: "supervisor", since: "2026-09-21T00:00:00.000Z" },
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
