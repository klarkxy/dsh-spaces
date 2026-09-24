import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const audit = join(root, "tests", "fixtures", "workbench-ui");
const playwrightRoot = process.env.DSH_TEST_PLAYWRIGHT || join(root, "node_modules/playwright");
const VIEW_EPOCH = "aa".repeat(32);

function routeView(
  url: URL,
  childUrl: string,
  res: ServerResponse,
): boolean {
  if (!url.pathname.startsWith("/view/")) return false;
  const epoch = url.searchParams.get("epoch");
  if (!epoch || !/^[a-f0-9]{64}$/.test(epoch) || epoch !== VIEW_EPOCH) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("epoch");
    return true;
  }
  const id = url.pathname.slice("/view/".length).split("/")[0] ?? "";
  res.writeHead(302, { location: `${childUrl}/${id}` });
  res.end();
  return true;
}

async function launchChromium(chromium: {
  launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{
    close: () => Promise<void>;
    newPage: () => Promise<unknown>;
  }>;
}) {
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

test("DOM: home navigation keeps the same iframe node and textarea draft", { timeout: 120_000 }, async (t) => {
  const bundled = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [join(audit, "host.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: "host.js",
  });
  const hostJs = bundled.outputFiles[0]?.text ?? "";
  const childHtml = readFileSync(join(audit, "child.html"), "utf8");

  const child = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(childHtml);
  });
  t.after(() => child.close());

  let supervisorUrl = "";
  const supervisor = await listen((req, res) => {
    const url = new URL(req.url ?? "/", supervisorUrl || "http://127.0.0.1");
    if (routeView(url, child.url, res)) return;
    if (url.pathname === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(hostJs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>workbench fixture</title></head>
  <body>
    <div id="root" style="height:100vh"></div>
    <script>window.__WB = ${JSON.stringify({ supervisor: supervisorUrl, child: child.url })};</script>
    <script src="/host.js"></script>
  </body>
</html>`);
  });
  supervisorUrl = supervisor.url;
  t.after(() => supervisor.close());

  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as {
    chromium: { launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{ close: () => Promise<void>; newPage: () => Promise<Page> }> };
  };
  type Page = {
    goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
    getByRole: (role: string, opts: { name: string }) => { click: () => Promise<void> };
    locator: (sel: string) => {
      waitFor: (opts?: { state?: string; timeout?: number }) => Promise<void>;
      evaluate: (fn: (el: Element) => unknown) => Promise<unknown>;
    };
    frameLocator: (sel: string) => { locator: (sel: string) => { fill: (v: string) => Promise<void>; inputValue: () => Promise<string> } };
    evaluate: (fn: () => unknown) => Promise<unknown>;
  };
  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(supervisor.url, { waitUntil: "networkidle" });
  const browserPage = page as unknown as import("playwright").Page;
  await browserPage.setViewportSize({ width: 1280, height: 800 });
  const home = browserPage.frameLocator('[data-home-view]');
  await home.locator('textarea').fill('home draft');
  assert.equal(await browserPage.getByRole('tab').count(), 0, 'management is absent from the home');
  await browserPage.getByRole('button', { name: '设置', exact: true }).click();
  const close = browserPage.locator('[data-settings-close]');
  assert.equal(await close.evaluate(el => document.activeElement === el), true);
  await browserPage.getByRole('button', { name: 'English', exact: true }).click();
  await browserPage.evaluate(() => document.documentElement.style.setProperty('--dsw-alias-bg-base', '#ffffff'));
  await browserPage.getByRole('button', { name: 'Dark', exact: true }).click();
  assert.equal(await browserPage.locator('[data-settings-dialog]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(24, 25, 29)', 'explicit dark theme overrides host colors');
  await browserPage.getByRole('button', { name: 'Light', exact: true }).click();
  assert.equal(await browserPage.locator('[data-settings-dialog]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  await browserPage.getByRole('button', { name: '中文', exact: true }).click();
  await browserPage.getByRole('tab', { name: '高级', exact: true }).click();
  await browserPage.setViewportSize({ width: 390, height: 520 });
  await browserPage.locator('[data-settings-home]').waitFor({ state: 'visible' });
  await browserPage.locator('.dsh-wb-settings-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const rect = await close.boundingBox();
  assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= 520 && rect.x + rect.width <= 390, 'close stays in the viewport');
  await close.click();
  assert.equal(await browserPage.getByRole('button', { name: '设置', exact: true }).evaluate(el => document.activeElement === el), true, 'focus returns to settings trigger');
  await browserPage.getByRole('button', { name: '设置', exact: true }).click();
  await browserPage.keyboard.press('Escape');
  assert.equal(await browserPage.locator('[data-settings-dialog]').count(), 0);
  assert.equal(await home.locator('textarea').inputValue(), 'home draft');
  await browserPage.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Alpha" }).click();
  const iframe = page.locator('iframe[data-space-id="alpha"]');
  await iframe.waitFor({ state: "attached", timeout: 15_000 });
  const iframeSrc = await iframe.evaluate((el) => (el as HTMLIFrameElement).getAttribute("src"));
  assert.equal(typeof iframeSrc, "string");
  assert.match(String(iframeSrc), new RegExp(`[?&]epoch=${VIEW_EPOCH}$`));
  const frame = page.frameLocator('iframe[data-space-id="alpha"]');
  await frame.locator("textarea").fill("draft-keep");
  await iframe.evaluate((el) => {
    (window as Window & { __iframe?: Element }).__iframe = el;
  });
  await page.getByRole("button", { name: "首页" }).click();
  const stillAttached = await page.evaluate(
    () => document.querySelector('iframe[data-space-id="alpha"]') !== null,
  );
  assert.equal(stillAttached, true);
  const sameNode = await page.evaluate(
    () => (window as Window & { __iframe?: Element }).__iframe === document.querySelector('iframe[data-space-id="alpha"]'),
  );
  assert.equal(sameNode, true);
  await page.getByRole("button", { name: "Alpha" }).click();
  const sameAfterReturn = await page.evaluate(
    () => (window as Window & { __iframe?: Element }).__iframe === document.querySelector('iframe[data-space-id="alpha"]'),
  );
  assert.equal(sameAfterReturn, true);
  assert.equal(await home.locator("textarea").inputValue(), "home draft");
  const draft = await frame.locator("textarea").inputValue();
  assert.equal(draft, "draft-keep");
});

test("DOM: settings, templates, share and plugin navigation use the product API", { timeout: 120_000 }, async (t) => {
  const bundled = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [join(audit, "host.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: "host.js",
  });
  const hostJs = bundled.outputFiles[0]?.text ?? "";
  const childHtml = readFileSync(join(audit, "child.html"), "utf8");

  const child = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(childHtml);
  });
  t.after(() => child.close());

  let supervisorUrl = "";
  const supervisor = await listen((req, res) => {
    const url = new URL(req.url ?? "/", supervisorUrl || "http://127.0.0.1");
    if (routeView(url, child.url, res)) return;
    if (url.pathname === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(hostJs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>workbench fixture</title></head>
  <body>
    <div id="root" style="height:100vh"></div>
    <script>window.__WB = ${JSON.stringify({ supervisor: supervisorUrl, child: child.url })};</script>
    <script src="/host.js"></script>
  </body>
</html>`);
  });
  supervisorUrl = supervisor.url;
  t.after(() => supervisor.close());

  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as {
    chromium: { launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{ close: () => Promise<void>; newPage: () => Promise<Page> }> };
  };
  type Locator = {
    click: () => Promise<void>;
    fill: (v: string) => Promise<void>;
    waitFor: (opts?: { state?: string; timeout?: number }) => Promise<void>;
    inputValue: () => Promise<string>;
    getByRole: (role: string, opts: { name: string }) => Locator;
    first: () => Locator;
    locator: (sel: string) => Locator;
  };
  type Page = {
    goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
    getByRole: (role: string, opts: { name: string }) => Locator;
    locator: (sel: string) => Locator;
    evaluate: (fn: () => unknown) => Promise<unknown>;
  };
  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(supervisor.url, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "高级" }).click();
  await page.locator("[data-settings-home]").waitFor({ state: "visible", timeout: 15_000 });
  const port = await page.locator("[data-settings-home] input[type=\"number\"]").first().inputValue();
  assert.equal(port, "3100");
  await page.evaluate(() => {
    const save = document.querySelector("[data-settings-home] button.primary") as HTMLButtonElement | null;
    save?.click();
    const close = document.querySelector("[data-settings-close]") as HTMLButtonElement | null;
    close?.click();
  });

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "模板" }).click();
  await page.locator("[data-templates]").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("button", { name: "导出分享" }).click();
  const downloads = await page.evaluate(
    () => (window as Window & { __WB_DOWNLOADS?: Array<{ fileName: string }> }).__WB_DOWNLOADS ?? [],
  );
  assert.deepEqual(downloads, [{ fileName: "alpha.dshspace" }]);

  await page.getByRole("tab", { name: "插件" }).click();
  await page.locator("[data-catalog]").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("[data-library]").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("button", { name: "刷新目录" }).click();
  const calls = (await page.evaluate(
    () => (window as Window & { __WB_CALLS?: Array<{ method: string; arg?: { method?: string; kind?: string } }> }).__WB_CALLS ?? [],
  )) as Array<{ method: string; arg?: { method?: string; kind?: string } }>;
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "settings"));
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "templates"));
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "catalog"));
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "library"));
  assert.ok(calls.some((item) => item.method === "submit" && item.arg?.kind === "catalog.refresh"));
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "share.export"));
});
