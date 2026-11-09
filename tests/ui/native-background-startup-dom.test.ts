import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

const PAGE = `<!doctype html><style>html,body,#root{height:100%;margin:0}#root{position:relative}main{height:100%;padding:25px;box-sizing:border-box}textarea{position:absolute;bottom:15px;width:80%;height:140px;box-sizing:border-box}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style><div id="root"><main id="main"><h1>Original main</h1><textarea aria-label="Main draft"></textarea></main><div data-shell-overlay></div></div><script src="/client.js"></script>`;

async function serve(script: string) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(script); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}

async function open(browser: Browser, origin: string, locale: string, path = "/") {
  const context = await browser.newContext({ locale, viewport: { width: 1000, height: 650 } });
  const page = await context.newPage();
  await page.goto(origin + path);
  await page.locator("[data-spaces-native]").waitFor();
  await page.waitForFunction(() => window.__fixture.counts.begin === 1);
  return { context, page };
}

test("DOM: background startup keeps the same main input through success and failure", { timeout: 120000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-background-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const server = await serve(bundle.outputFiles[0].text);
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const locale of ["zh-CN", "en-US"] as const) for (const outcome of ["ready", "failed"] as const) {
    const { context, page } = await open(browser, server.origin, locale);
    try { await checkMain(page, locale, outcome); }
    finally { await context.close(); }
  }
});

async function checkMain(page: Page, locale: "zh-CN" | "en-US", outcome: "ready" | "failed") {
  const zh = locale.startsWith("zh");
  const input = page.getByRole("textbox", { name: "Main draft" });
  const handle = await input.elementHandle();
  const settings = page.getByRole("button", { name: zh ? /^设置/ : /^Settings/ });
  const create = page.getByRole("button", { name: zh ? "新建空间" : "New space", exact: true });
  assert.equal(await settings.isEnabled(), true);
  assert.equal(await create.isEnabled(), true);
  const typed = "unsent during preparation " + locale;
  await input.fill(typed);
  assert.equal(await input.evaluate(el => el === document.activeElement), true);
  const label = zh ? "准备中" : "Preparing";
  const status = page.locator(".dsh-native-startup-status");
  assert.equal(await status.getAttribute("aria-label"), label);
  assert.equal(await status.innerText(), label);
  const rail = await page.locator(".dsh-host-rail").boundingBox();
  const bounds = await status.boundingBox();
  assert.ok(rail && bounds);
  assert.equal(await page.locator(".dsh-native-rail-toggle").isVisible(), false, "the caption rail toggle stays hidden without a Windows title bar");
  assert.ok(Math.abs(rail.width - 72) < 1, "rail stays 72px");
  assert.ok(bounds.x + bounds.width <= rail.x + rail.width + 1, "startup status stays inside the rail");
  await page.evaluate(next => next === "failed" ? window.__fixture.fail() : window.__fixture.phase("ready"), outcome);
  await page.waitForFunction(next => window.__fixture.state().phase === next, outcome);
  assert.equal(await input.evaluate((el, original) => el === original, handle), true);
  assert.equal(await input.evaluate(el => el === document.activeElement), true);
  assert.equal(await input.inputValue(), typed);
  assert.equal(await page.locator("#main").evaluate(el => (el as HTMLElement).inert), false);
  assert.equal(await page.locator(".dsh-host-guide").count(), 0);
  const quiet = await page.evaluate(() => window.__fixture.counts);
  assert.equal(quiet.begin, 1);
  assert.equal(quiet.oldInitialize, 0);
  assert.equal(quiet.child, 0);
  assert.equal(quiet.acquire, 0);
  assert.equal(quiet.focus, 0);
  if (outcome === "ready") return;
  assert.equal(await page.getByText("CONTROLLED_PRIMARY").count(), 0);
  assert.equal(await page.getByText("CONTROLLED_CLEANUP").count(), 0);
  assert.equal(await page.getByText(zh ? "进程记录已保留。" : "The process record was kept.").count(), 0);
  await page.getByRole("button", { name: zh ? /不可用/ : /unavailable/i }).click();
  assert.equal(await page.locator("[data-reason=primary]").innerText(), (zh ? "失败原因" : "Failure") + "\nCONTROLLED_PRIMARY");
  assert.equal(await page.locator("[data-reason=cleanup]").innerText(), (zh ? "随后停止结果" : "Stop result afterwards") + "\nCONTROLLED_CLEANUP");
  assert.equal(await page.locator("[data-reason=instance]").innerText(), (zh ? "进程记录" : "Process record") + "\n" + (zh ? "进程记录已保留。" : "The process record was kept."));
  await page.locator('[data-space-id="desktop"]').click();
  assert.equal(await input.inputValue(), typed);
  assert.equal(await page.locator(".dsh-host-guide").count(), 0);
}

for (const [label, actions, creates, navigates] of [
  ["create then settings", ["create", "settings"], 0, true],
  ["settings then create", ["settings", "create"], 1, true],
  ["create then main", ["create", "main"], 0, false],
] as const) test("DOM: latest background intent " + label, { timeout: 60000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-background-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const server = await serve(bundle.outputFiles[0].text);
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { context, page } = await open(browser, server.origin, "zh-CN");
  t.after(() => context.close());
  for (const action of actions) {
    if (action === "create") await page.getByRole("button", { name: "新建空间", exact: true }).click();
    if (action === "settings") await page.getByRole("button", { name: /^设置/ }).click();
    if (action === "main") await page.locator('[data-space-id="desktop"]').click();
  }
  await page.evaluate(() => window.__fixture.phase("ready"));
  await page.waitForFunction(main => window.__fixture.state().phase === "ready" && window.__fixture.state().selected === (main ? "current" : "@settings"), !navigates);
  const counts = await page.evaluate(() => window.__fixture.counts);
  assert.equal(counts.urls.filter(url => new URL(url).hash.startsWith("#intent/create/")).length, creates);
  assert.equal(counts.acquire, navigates ? 1 : 0);
  assert.equal(counts.child, 0);
  assert.equal(counts.oldInitialize, 0);
  assert.equal(counts.focus, navigates ? 1 : 0);
});

test("DOM: Windows caption toggle hides and remembers the spaces rail", { timeout: 60000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-background-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const server = await serve(bundle.outputFiles[0].text);
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1000, height: 650 } });
  t.after(() => context.close());
  // Init scripts run before the parser creates the root element, so the
  // attribute is applied as soon as it appears.
  await context.addInitScript({
    content: `
      (function () {
        function apply() {
          document.documentElement.setAttribute("data-windows-titlebar", "");
          document.documentElement.style.setProperty("--dsh-windows-titlebar-height", "40px");
        }
        if (document.documentElement) apply();
        else new MutationObserver(function (_, observer) { if (document.documentElement) { apply(); observer.disconnect(); } }).observe(document, { childList: true });
      })();
    `,
  });
  const page = await context.newPage();
  await page.goto(server.origin);
  await page.locator("[data-spaces-native]").waitFor();
  const collapse = page.getByRole("button", { name: "收起空间栏", exact: true });
  await collapse.waitFor();
  assert.equal(await collapse.getAttribute("aria-expanded"), "true");
  const captionBox = await collapse.boundingBox();
  assert.ok(captionBox && Math.abs(captionBox.x - 12) < 1, `rail toggle sits in the caption, got ${captionBox?.x}`);
  assert.equal(await page.locator("#root").evaluate(el => el.getBoundingClientRect().x), 72);
  await collapse.click();
  const expand = page.getByRole("button", { name: "展开空间栏", exact: true });
  await expand.waitFor();
  assert.equal(await expand.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".dsh-host-rail").isHidden(), true);
  assert.equal(await page.locator("#root").evaluate(el => el.getBoundingClientRect().x), 0);
  assert.equal(await page.locator(".dsh-native-container").evaluate(el => getComputedStyle(el).left), "0px");
  assert.equal(await page.evaluate(() => localStorage.getItem("dsh-spaces.native.rail")), "collapsed");
  await page.reload();
  await page.locator("[data-spaces-native]").waitFor();
  const remembered = page.getByRole("button", { name: "展开空间栏", exact: true });
  await remembered.waitFor();
  assert.equal(await page.locator(".dsh-host-rail").isHidden(), true, "a reload keeps the remembered collapsed rail");
  assert.equal(await page.locator("#root").evaluate(el => el.getBoundingClientRect().x), 0);
  await remembered.click();
  await page.getByRole("button", { name: "收起空间栏", exact: true }).waitFor();
  assert.equal(await page.locator(".dsh-host-rail").isVisible(), true);
  assert.equal(await page.locator("#root").evaluate(el => el.getBoundingClientRect().x), 72);
  assert.equal(await page.evaluate(() => localStorage.getItem("dsh-spaces.native.rail")), "expanded");
});

test("DOM: remounting a stopped record rejoins it without opening a guest", { timeout: 60000 }, async t => {
  // This page supplies one stopped record to each mounted controller. It does not prove that a real host process deduplicates launches.
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-background-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const server = await serve(bundle.outputFiles[0].text);
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { context, page } = await open(browser, server.origin, "zh-CN", "/?phase=stopped");
  t.after(() => context.close());
  await page.waitForFunction(() => window.__fixture.state().phase === "service-stopped");
  const first = await page.evaluate(() => window.__fixture.counts);
  assert.equal(first.begin, 1);
  assert.equal(first.directory, 0);
  assert.equal(first.oldInitialize, 0);
  assert.equal(first.child, 0);
  assert.equal(first.acquire, 0);
  await page.evaluate(() => window.__fixture.remount());
  await page.waitForFunction(() => window.__fixture.counts.begin === 2 && window.__fixture.state().phase === "service-stopped");
  const second = await page.evaluate(() => window.__fixture.counts);
  assert.equal(second.directory, 0);
  assert.equal(second.oldInitialize, 0);
  assert.equal(second.child, 0);
  assert.equal(second.acquire, 0);
  assert.equal(second.focus, 0);
  assert.equal(await page.locator("#main").evaluate(el => (el as HTMLElement).inert), false);
});
