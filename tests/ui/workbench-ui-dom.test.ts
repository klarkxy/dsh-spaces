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
const root = join(here, "..", "..");
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

test("DOM: native settings creation entry is clickable and reveals its space", { timeout: 120_000 }, async (t) => {
  const bundled = await esbuild.build({
    absWorkingDir: root, entryPoints: [join(audit, "host.tsx")], bundle: true,
    write: false, format: "iife", platform: "browser", jsx: "automatic",
  });
  const childHtml = readFileSync(join(audit, "child.html"), "utf8");
  const child = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(childHtml); });
  t.after(() => child.close());
  let supervisorUrl = "";
  const supervisor = await listen((req, res) => {
    const url = new URL(req.url ?? "/", supervisorUrl || "http://127.0.0.1");
    if (routeView(url, child.url, res)) return;
    if (url.pathname === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundled.outputFiles[0]?.text ?? ""); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script>window.__WB = ${JSON.stringify({ supervisor: supervisorUrl, child: child.url, nativeSettingsControls: true })};</script><script src="/host.js"></script></body></html>`);
  });
  supervisorUrl = supervisor.url;
  t.after(() => supervisor.close());
  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as { chromium: Parameters<typeof launchChromium>[0] };
  const browser = await launchChromium(chromium); t.after(() => browser.close());
  const page = await browser.newPage();
  for (const source of ["main", "local"]) {
    await page.goto(supervisor.url);
    await page.getByRole("button", { name: "新建空间", exact: true }).click();
    const form = page.getByRole("dialog", { name: "创建空间", exact: true });
    const models = form.getByRole("combobox", { name: "模型来源", exact: true });
    assert.deepEqual(await models.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ["main", "local"]);
    assert.equal(await models.inputValue(), "main");
    assert.equal(await form.locator('[name="base"], [name="browser"]').count(), 0);
    assert.doesNotMatch(await form.textContent() ?? '', /Browser|浏览器空间|封存/);
    const version = form.getByRole('combobox', { name: 'DSH 版本', exact: true });
    await models.selectOption(source);
    await version.selectOption(source === 'local' ? '0.2.0-rc.2' : '0.2.1-rc.2');
    await form.getByRole("textbox", { name: "名称", exact: true }).fill("native-created");
    await form.getByRole("button", { name: "创建", exact: true }).click();
    // The created space is entered directly; the settings page releases it.
    await page.locator('iframe[data-space-id="alpha"][data-visible="true"]').waitFor({ state: "visible" });
    const commands = await page.evaluate(() => window.__WB_CALLS?.filter(row => row.method === "submit").map(row => row.arg));
    const input = (commands?.[0] as { input: { base: string; baseVersion: string; modelSource?: string } }).input;
    assert.equal(input.base, 'web');
    assert.equal(input.baseVersion, source === 'local' ? '0.2.0-rc.2' : '0.2.1-rc.2');
    assert.equal(input.modelSource, source);
    assert.equal(await page.locator(".dsh-wb-settings-page").count(), 0, "the settings page must release the selected space surface");
    assert.equal(await page.frameLocator('iframe[data-space-id="alpha"]').locator("textarea").isVisible(), true);
    const draft = page.frameLocator('iframe[data-space-id="alpha"]').locator("textarea");
    await draft.fill("warm-switch-draft");
    const switched = await page.evaluate(async () => {
      const controller = window.__WB_CONTROLLER!;
      const frame = document.querySelector('iframe[data-space-id="alpha"]');
      const views = window.__WB_CALLS!.filter(call => call.method === "view").length;
      controller.selectHome();
      const switching = controller.selectRunningSpace("alpha", () => true, 1);
      const immediate = controller.getSnapshot().selected === "alpha" && controller.getSnapshot().pendingId === null;
      return { immediate, accepted: await switching,
        sameNode: frame === document.querySelector('iframe[data-space-id="alpha"]'),
        extraViews: window.__WB_CALLS!.filter(call => call.method === "view").length - views };
    });
    assert.deepEqual(switched, { immediate: true, accepted: true, sameNode: true, extraViews: 0 });
    assert.equal(await draft.inputValue(), "warm-switch-draft");
  }
});

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
  await browserPage.getByRole('button', { name: '维护', exact: true }).click();
  await browserPage.getByRole('tab', { name: '服务', exact: true }).click();
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
  await page.getByRole("button", { name: "维护", exact: true }).click();
  await page.getByRole("tab", { name: "服务" }).click();
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
  await page.getByRole("tab", { name: "空间模板" }).click();
  await page.locator("[data-templates]").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("tab", { name: "导出", exact: true }).click();
  await page.getByRole("button", { name: "导出分享" }).click();
  const downloads = await page.evaluate(
    () => (window as Window & { __WB_DOWNLOADS?: Array<{ fileName: string }> }).__WB_DOWNLOADS ?? [],
  );
  assert.deepEqual(downloads, [{ fileName: "alpha.dshspace" }]);

  // The plugin catalogue, the published versions and the upgrade belong to the
  // plugin section of the space detail page now.
  await page.getByRole("tab", { name: "空间", exact: true }).click();
  await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "管理…" }).click();
  await page.locator("[data-space-section=\"plugins\"]").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("[data-space-plugin-entry=\"catalog.demo\"]").click();
  await page.waitForFunction(() => {
    const select = document.querySelector<HTMLSelectElement>("[data-space-plugin-versions=\"true\"]");
    return Boolean(select && select.options.length > 0);
  });
  assert.equal(
    await page.locator("[data-space-plugin-versions=\"true\"]").inputValue(),
    "2.0.0",
    "the version list defaults to the newest published version",
  );
  await page.getByRole("button", { name: "刷新目录" }).click();
  await page.locator("[data-space-plugin-upgrade=\"catalog.demo\"]").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("[data-space-plugin-upgrade=\"catalog.demo\"]").click();
  await page.waitForFunction(() =>
    (window as Window & { __WB_CALLS?: Array<{ method: string; arg?: { kind?: string } }> }).__WB_CALLS?.some(
      (call) => call.method === "preview" && (call.arg as { kind?: string } | undefined)?.kind === "plugin.install",
    ) === true,
  );
  const upgrade = (await page.evaluate(
    () => (window as Window & { __WB_CALLS?: Array<{ method: string; arg?: unknown }> }).__WB_CALLS ?? [],
  )).find((call) => call.method === "preview" && (call.arg as { kind?: string })?.kind === "plugin.install");
  assert.deepEqual(upgrade?.arg, {
    kind: "plugin.install",
    spaceIds: ["alpha"],
    catalogId: "demo",
    version: "2.0.0",
  });
  const calls = (await page.evaluate(
    () => (window as Window & { __WB_CALLS?: Array<{ method: string; arg?: { method?: string; kind?: string } }> }).__WB_CALLS ?? [],
  )) as Array<{ method: string; arg?: { method?: string; kind?: string } }>;
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "settings"));
  assert.ok(calls.some((item) => item.method === "submit" && item.arg?.kind === "settings.update"),
    "clicking 保存服务设置 must submit settings.update through the form handler");
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "templates"));
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "catalog"));
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "library"));
  assert.ok(calls.some((item) => item.method === "product" && item.arg?.method === "plugin.versions"),
    "the plugin section reads the published versions");
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
  await page.getByRole("tab", { name: "空间", exact: true }).click();
  await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "管理…" }).click();
  const select = page.locator("[data-dsh-target=\"true\"]");
  await select.waitFor({ state: "visible", timeout: 15_000 });
  await select.selectOption("0.2.0");
  await page.getByRole("button", { name: "预览切换" }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await previewCalls(), [{ kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" }]);
  await page.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "维护", exact: true }).click();
  await page.getByRole("tab", { name: "DSH 版本" }).click();
  assert.equal(await page.getByRole("button", { name: "预览安装", exact: true }).count(), 0);
  await page.getByRole("button", { name: "删除" }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await previewCalls(), [
    { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" },
    { kind: "runtime.remove", version: "0.3.0" },
  ]);
  await page.getByRole("button", { name: "取消" }).click();

  // D1: a stop runs from its preview, so no confirmation dialog appears.
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "空间", exact: true }).click();
  await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "管理…" }).click();
  const detail = page.locator("[data-space-detail=\"true\"]");
  await detail.waitFor({ state: "visible", timeout: 15_000 });
  await detail.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForTimeout(500);
  assert.deepEqual(await previewCalls(), [
    { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" },
    { kind: "runtime.remove", version: "0.3.0" },
    { kind: "space.stop", spaceId: "alpha" },
  ]);
  assert.equal(await page.getByRole("button", { name: "取消", exact: true }).count(), 0, "a plain stop does not ask again");

  // A deletion still asks. The auto-confirmed stop closed the settings
  // surface, so open it again and wait for the leaving copy of the detail
  // page to unmount before aiming at the danger zone.
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("tab", { name: "空间", exact: true }).click();
  await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "管理…" }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-space-detail=\"true\"]").length === 1);
  await page.locator("[data-space-section=\"danger\"]").getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await previewCalls(), [
    { kind: "space.runtime.set", spaceId: "alpha", version: "0.2.0" },
    { kind: "runtime.remove", version: "0.3.0" },
    { kind: "space.stop", spaceId: "alpha" },
    { kind: "space.delete", spaceId: "alpha", removeData: false },
  ]);
  await page.getByRole("button", { name: "取消" }).click();
});

test("DOM: dialogs trap and restore focus, names validate live, the menu answers arrows and copy reports its status", { timeout: 120_000 }, async (t) => {
  const bundled = await esbuild.build({
    absWorkingDir: root, entryPoints: [join(audit, "host.tsx")], bundle: true,
    write: false, format: "iife", platform: "browser", jsx: "automatic",
  });
  const childHtml = readFileSync(join(audit, "child.html"), "utf8");
  const child = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(childHtml); });
  t.after(() => child.close());
  let supervisorUrl = "";
  const supervisor = await listen((req, res) => {
    const url = new URL(req.url ?? "/", supervisorUrl || "http://127.0.0.1");
    if (routeView(url, child.url, res)) return;
    if (url.pathname === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundled.outputFiles[0]?.text ?? ""); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body><div id="root" style="height:100vh"></div><script>window.__WB = ${JSON.stringify({ supervisor: supervisorUrl, child: child.url })};</script><script src="/host.js"></script></body></html>`);
  });
  supervisorUrl = supervisor.url;
  t.after(() => supervisor.close());
  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as { chromium: Parameters<typeof launchChromium>[0] };
  const browser = await launchChromium(chromium); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { (window as unknown as { __copied: string[] }).__copied.push(text); } },
    });
  });
  await page.goto(supervisor.url);

  // Escape closes the create dialog and returns focus to its trigger.
  const create = page.getByRole("button", { name: "新建空间", exact: true }).first();
  await create.click();
  const dialog = page.getByRole("dialog", { name: "创建空间", exact: true });
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.equal(await create.evaluate((el) => el === document.activeElement), true, "focus returns to the create button");

  // An invalid name disables Create and shows the inline hint; a valid one enables it.
  await create.click();
  await dialog.waitFor();
  const nameField = dialog.locator('input[name="name"]');
  await nameField.fill("Bad_Name");
  await page.locator("#dsh-wb-create-name-invalid").waitFor();
  assert.equal(await nameField.getAttribute("aria-invalid"), "true");
  assert.equal(await dialog.getByRole("button", { name: "创建", exact: true }).isDisabled(), true);
  await nameField.fill("ok-name");
  assert.equal(await dialog.getByRole("button", { name: "创建", exact: true }).isDisabled(), false);
  await page.keyboard.press("Escape");

  // The space menu moves over enabled items with arrows and closes on Escape.
  const alpha = page.locator('button[aria-label="Alpha · 运行中"]');
  await alpha.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "空间操作" });
  await menu.waitFor();
  const active = () => page.evaluate(() => document.activeElement?.textContent ?? "");
  const first = await active();
  await page.keyboard.press("ArrowDown");
  assert.notEqual(await active(), first, "ArrowDown moves to the next enabled item");
  await page.keyboard.press("ArrowUp");
  assert.equal(await active(), first);
  await page.keyboard.press("End");
  assert.notEqual(await active(), first, "End jumps to the last enabled item");
  await page.keyboard.press("Home");
  assert.equal(await active(), first, "Home jumps back to the first enabled item");
  await page.keyboard.press("Escape");
  assert.equal(await menu.count(), 0);
  assert.equal(await alpha.evaluate((el) => el === document.activeElement), true, "closing returns focus to the rail button");

  // The copy button reports success and failure inline.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "空间", exact: true }).click();
  await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "管理…" }).click();
  await page.locator('[data-space-section="diagnostics"]').waitFor();
  const copy = page.getByRole("button", { name: "复制脱敏日志", exact: true });
  await copy.click();
  await page.getByRole("status").filter({ hasText: "已复制" }).waitFor();
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: undefined });
  });
  await copy.click();
  await page.getByRole("status").filter({ hasText: "复制失败" }).waitFor();
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
        await page.locator(".dsh-wb-space-row", { hasText: "Alpha" }).getByRole("button", { name: "管理…", exact: true }).click();
        await page.waitForFunction(() => Boolean(window.__WB_RESOLVE_RUNTIMES));
        const select = page.locator("[data-dsh-target=\"true\"]");
        const preview = page.getByRole("button", { name: "预览切换", exact: true });
        assert.equal(await select.locator("option").count(), 0);
        assert.equal(await preview.isDisabled(), true);
        await page.evaluate((rows) => window.__WB_RESOLVE_RUNTIMES!(rows), [runtime("0.2.0-rc.2")]);
        await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("[data-dsh-target=\"true\"]")?.disabled === false);
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
          await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("[data-dsh-target=\"true\"]")?.disabled === false);
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
