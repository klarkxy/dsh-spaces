import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const audit = join(root, "tests", "fixtures", "workbench-ui");
const playwrightRoot = process.env.DSH_TEST_PLAYWRIGHT ||
  "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";

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
    if (url.pathname.startsWith("/view/")) {
      const id = url.pathname.slice("/view/".length);
      res.writeHead(302, { location: `${child.url}/${id}` });
      res.end();
      return;
    }
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

  const require = createRequire(pathToFileURL(join(playwrightRoot, "index.js")).href);
  const { chromium } = require(playwrightRoot) as {
    chromium: { launch: (opts?: { headless?: boolean }) => Promise<{ close: () => Promise<void>; newPage: () => Promise<Page> }> };
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
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(supervisor.url, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Alpha" }).click();
  const iframe = page.locator('iframe[data-space-id="alpha"]');
  await iframe.waitFor({ state: "attached", timeout: 15_000 });
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
  const draft = await frame.locator("textarea").inputValue();
  assert.equal(draft, "draft-keep");
});
