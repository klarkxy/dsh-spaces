import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import type { Page } from "playwright";

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
  launch: (opts?: { headless?: boolean; channel?: string; executablePath?: string }) => Promise<{
    close: () => Promise<void>;
    newPage: () => Promise<Page>;
  }>;
}) {
  if (process.env.DSH_TEST_CHROMIUM) return chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_CHROMIUM });
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
          new Promise((done, fail) => { server.closeAllConnections(); server.close((error) => (error ? fail(error) : done())); }),
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
    chromium: { launch: (opts?: { headless?: boolean; channel?: string; executablePath?: string }) => Promise<{ close: () => Promise<void>; newPage: () => Promise<Page> }> };
  };
  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(supervisor.url, { waitUntil: "networkidle" });
  const browserPage = page;
  await browserPage.setViewportSize({ width: 1280, height: 800 });
  // Home now opens the dashboard; chat is a separate, lazy and persistent view.
  await browserPage.getByRole('button', { name: '聊天', exact: true }).click();
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
    chromium: { launch: (opts?: { headless?: boolean; channel?: string; executablePath?: string }) => Promise<{ close: () => Promise<void>; newPage: () => Promise<Page> }> };
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

test("DOM: space details and runtime tab preview DSH version plans", { timeout: 120_000 }, async (t) => {
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
    chromium: { launch: (opts?: { headless?: boolean; channel?: string; executablePath?: string }) => Promise<{ close: () => Promise<void>; newPage: () => Promise<Page> }> };
  };
  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(supervisor.url, { waitUntil: "networkidle" });

  const previewCalls = () =>
    page.evaluate(
      () =>
        ((window as Window & { __WB_CALLS?: Array<{ method: string; arg?: unknown }> }).__WB_CALLS ?? [])
          .filter((item) => item.method === "preview")
          .map((item) => item.arg),
    );

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "空间" }).click();
  await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "诊断" }).click();
  const select = page.locator("select");
  await select.waitFor({ state: "visible", timeout: 15_000 });
  await select.selectOption("0.2.0");
  await page.getByRole("button", { name: "预览切换" }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await previewCalls(), [{ kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" }]);
  await page.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "运行时" }).click();
  assert.equal(await page.getByRole("button", { name: "预览安装", exact: true }).count(), 0);
  await page.getByRole("button", { name: "删除" }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await previewCalls(), [
    { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" },
    { kind: "runtime.remove", version: "0.3.0" },
  ]);
  await page.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "空间" }).click();
  const alphaRow = page.locator(".dsh-wb-space-row", { hasText: "Alpha" });
  await alphaRow.getByRole("button", { name: "停止" }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await previewCalls(), [
    { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" },
    { kind: "runtime.remove", version: "0.3.0" },
    { kind: "space.stop", spaceId: "alpha" },
  ]);
  await page.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "空间" }).click();
  await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "删除" }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await previewCalls(), [
    { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" },
    { kind: "runtime.remove", version: "0.3.0" },
    { kind: "space.stop", spaceId: "alpha" },
    { kind: "space.delete", spaceId: "alpha", removeData: false },
  ]);
  await page.getByRole("button", { name: "取消" }).click();
});

test("DOM: delayed runtime candidates derive a usable target and keep selections scoped to current space pins", { timeout: 120_000 }, async (t) => {
  const bundled = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [join(audit, "host.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
  });
  let supervisorUrl = "";
  const supervisor = await listen((req, res) => {
    if (req.url === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(bundled.outputFiles[0]?.text ?? "");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body><div id="root"></div>
      <script>window.__WB = ${JSON.stringify({ supervisor: supervisorUrl, child: supervisorUrl, runtimeControls: true })};</script>
      <script src="/host.js"></script></body></html>`);
  });
  supervisorUrl = supervisor.url;
  t.after(() => supervisor.close());
  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as { chromium: Parameters<typeof launchChromium>[0] };
  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const runtime = (version: string) => ({ version, installed: true, host: false, pinnedBy: [], removable: false, compatible: true });

  for (const pin of ["0.1.5-rc.1", null]) {
    await t.test(`initial pin ${pin ?? "unset"}`, async () => {
      const page = await browser.newPage();
      try {
        await page.goto(supervisor.url);
        await page.waitForFunction(() => Boolean(window.__WB_CONTROLLER));
        await page.evaluate(async (version) => {
          window.__WB_SET_PIN!("alpha", version);
          await window.__WB_CONTROLLER!.poll();
        }, pin);
        await page.getByRole("button", { name: "设置", exact: true }).click();
        await page.getByRole("tab", { name: "空间", exact: true }).click();
        await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "诊断", exact: true }).click();
        await page.waitForFunction(() => Boolean(window.__WB_RESOLVE_RUNTIMES));
        const select = page.locator("select");
        const preview = page.getByRole("button", { name: "预览切换", exact: true });
        assert.equal(await select.locator("option").count(), 0);
        assert.equal(await preview.isDisabled(), true);
        await page.evaluate((rows) => window.__WB_RESOLVE_RUNTIMES!(rows), [runtime("0.2.0-rc.2")]);
        await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".dsh-wb-dialog select")?.disabled === false);
        assert.equal(await select.inputValue(), "0.2.0-rc.2");
        assert.equal(await preview.isDisabled(), false, "the displayed single candidate must enable preview without input or reopening");
        await preview.click();
        await page.getByRole("button", { name: "取消", exact: true }).waitFor({ state: "visible" });
        assert.deepEqual(await page.evaluate(() => window.__WB_CALLS?.filter((call) => call.method === "preview").map((call) => call.arg)), [
          { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0-rc.2" },
        ]);
        await page.getByRole("button", { name: "取消", exact: true }).click();

        if (pin === null) return;
        await page.evaluate(() => window.__WB_CONTROLLER!.openDetail("alpha"));
        const refresh = async (versions: string[]) => {
          await page.evaluate(() => { void window.__WB_CONTROLLER!.loadRuntimes(); });
          await page.waitForFunction(() => Boolean(window.__WB_RESOLVE_RUNTIMES));
          await page.evaluate((rows) => window.__WB_RESOLVE_RUNTIMES!(rows), versions.map(runtime));
          await page.waitForFunction(() => document.querySelector<HTMLSelectElement>(".dsh-wb-dialog select")?.disabled === false);
        };
        await refresh(["0.2.0-rc.2", "0.3.0"]);
        await select.selectOption("0.3.0");
        await refresh(["0.2.0-rc.2", "0.3.0", "0.4.0"]);
        assert.equal(await select.inputValue(), "0.3.0", "an explicit choice survives a candidate refresh while valid");
        await refresh(["0.2.0-rc.2", "0.4.0"]);
        assert.equal(await select.inputValue(), "0.2.0-rc.2", "a removed choice derives a current valid target");
        await select.selectOption("0.4.0");
        await page.evaluate(() => window.__WB_CONTROLLER!.openDetail("beta"));
        assert.equal(await select.inputValue(), "0.2.0-rc.2", "the previous space's choice does not carry into another detail");
        await select.selectOption("0.4.0");
        await page.evaluate(async () => {
          window.__WB_SET_PIN!("beta", "0.2.0-rc.2");
          await window.__WB_CONTROLLER!.poll();
        });
        assert.equal(await select.inputValue(), "0.2.0-rc.2", "a changed pin resets the explicit choice");
      } finally {
        await page.close();
      }
    });
  }
});
