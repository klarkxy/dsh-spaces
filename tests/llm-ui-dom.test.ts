import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import type { Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixture = join(root, "tests", "fixtures", "llm-ui", "host.tsx");
const SECRET = "sk-browser-never-store";

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

test("DOM: model center saves through the credential channel and never stores the key", { timeout: 120_000 }, async (t) => {
  const bundled = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [fixture],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: "host.js",
  });
  const hostJs = bundled.outputFiles[0]?.text ?? "";
  const page = await listen((req, res) => {
    if (req.url === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(hostJs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>llm fixture</title></head>
  <body>
    <div id="root"></div>
    <script src="/host.js"></script>
  </body>
</html>`);
  });
  t.after(() => page.close());

  const require = createRequire(join(root, "node_modules/playwright/index.js"));
  const { chromium } = require("playwright") as {
    chromium: {
      launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{
        close: () => Promise<void>;
        newPage: () => Promise<Page>;
      }>;
    };
  };
  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const tab = await browser.newPage();
  await tab.goto(page.url, { waitUntil: "networkidle" });
  await tab.locator("[data-llm-center]").waitFor({ state: "attached", timeout: 15_000 });
  await tab.getByRole("button", { name: "New connection" }).click();
  await tab.getByRole("button", { name: "Next" }).click();
  await tab.locator('[data-llm-field="displayName"]').fill("Browser mock");
  await tab.locator('[data-llm-field="baseURL"]').fill("http://127.0.0.1:9/v1");
  await tab.locator("[data-llm-secret]").fill(SECRET);
  await tab.getByRole("button", { name: "Next" }).click();
  await tab.locator('[data-llm-field="modelId"]').fill("demo-large");
  await tab.getByRole("button", { name: "Add model" }).click();
  await tab.getByRole("button", { name: "Next" }).click();
  await tab.getByRole("button", { name: "Save" }).click();
  await tab.locator("[data-llm-editor]").waitFor({ state: "detached", timeout: 15_000 });
  await tab.locator("[data-llm-list]").waitFor({ state: "attached", timeout: 15_000 });
  const values = (await tab.evaluate(() =>
    [...document.querySelectorAll("input,textarea")].map((el) => (el as HTMLInputElement).value),
  )) as string[];
  assert.equal(values.some((value) => value.includes(SECRET)), false);
  assert.equal(await tab.locator("[data-llm-secret]").count(), 0);
  const storage = (await tab.evaluate(() => ({
    local: { ...window.localStorage },
    session: { ...window.sessionStorage },
  }))) as { local: Record<string, string>; session: Record<string, string> };
  assert.equal(JSON.stringify(storage).includes(SECRET), false);
  const llm = (await tab.evaluate(() => window.__LLM)) as { secrets: string[]; saved: boolean };
  assert.deepEqual(llm.secrets, [SECRET]);
  assert.equal(llm.saved, true);
  await tab.getByRole("radio", { name: "All shared connections" }).click();
  await tab.locator("[data-llm-map-select]").selectOption(CONNECTION_OPTION);
  await tab.locator("[data-llm-map-apply]").click();
  const after = await tab.evaluate(() => window.__LLM);
  assert.equal((after as { policyMode?: string }).policyMode, "all");
  assert.equal(Array.isArray((after as { mapped?: unknown[] }).mapped), true);
});

const CONNECTION_OPTION = "11111111-1111-4111-8111-111111111111";

test("DOM: space bindings isolate late reads and writes and apply only complete visible spaces", {timeout:120_000}, async t => {
  const bundled = await esbuild.build({absWorkingDir:root, entryPoints:[join(here,'fixtures/llm-ui/binding.tsx')], bundle:true, write:false, format:'iife', platform:'browser', jsx:'automatic'});
  const server = await listen((req,res) => {
    res.setHeader('content-type',req.url === '/host.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/host.js' ? bundled.outputFiles[0]!.text : '<div id="root"></div><script src="/host.js"></script>');
  });
  t.after(() => server.close());
  const {chromium} = createRequire(join(root,'node_modules/playwright/index.js'))('playwright');
  const browser = await chromium.launch({headless:true}); t.after(() => browser.close());
  const page: Page = await browser.newPage();
  const checked = () => page.locator('[data-llm-spaces] input[type=checkbox]').evaluateAll(rows => rows.filter(row => (row as HTMLInputElement).checked).map(row => row.parentElement?.textContent?.trim()));
  const flush = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.goto(server.url+'?mode=race');
  await page.waitForFunction(() => (window as any).__BINDING.resolve.a);
  await page.locator('select').first().selectOption('b');
  assert.equal(await page.locator('input[name=llm-mode]').count(),0);
  await page.waitForFunction(() => (window as any).__BINDING.resolve.b);
  await page.evaluate(() => (window as any).__BINDING.resolve.b());
  await page.getByLabel('conn-b',{exact:true}).waitFor();
  await page.evaluate(() => (window as any).__BINDING.resolve.a()); await flush();
  assert.ok((await checked()).includes('conn-b')); assert.ok(!(await checked()).includes('conn-a'));
  await page.getByLabel('conn-c',{exact:true}).click();
  await page.waitForFunction(() => (window as any).__BINDING.writes.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).__BINDING.writes[0]),['b',{mode:'selected',connectionIds:['conn-b','conn-c']}]);

  await page.goto(server.url+'?mode=write'); await page.getByLabel('conn-a',{exact:true}).waitFor();
  await page.getByLabel('conn-c',{exact:true}).click();
  await page.waitForFunction(() => (window as any).__BINDING.resolve.write);
  await page.locator('select').first().selectOption('b'); await page.getByLabel('conn-b',{exact:true}).waitFor();
  await page.evaluate(() => (window as any).__BINDING.resolve.write()); await flush();
  assert.ok((await checked()).includes('conn-b')); assert.ok(!(await checked()).includes('conn-a'));

  await page.goto(server.url+'?mode=hidden'); await page.getByLabel('conn-a',{exact:true}).waitFor();
  assert.equal(await page.locator('button').last().isDisabled(),true);
  assert.deepEqual(await page.evaluate(() => (window as any).__BINDING.plans),[]);
  await page.goto(server.url+'?mode=pinned'); await page.getByLabel('conn-a',{exact:true}).waitFor();
  await page.locator('button').last().click();
  await page.waitForFunction(() => (window as any).__BINDING.plans.length === 1);
  const plan = await page.evaluate(() => (window as any).__BINDING.plans[0]);
  assert.deepEqual(plan[0],['a']); assert.deepEqual(plan[2],[{spaceId:'a',status:'running',generation:1,catalogRevision:1,busy:false,serviceEpoch:'epoch'}]);
  await page.evaluate(() => (window as any).__BINDING.pin('b')); await page.getByLabel('conn-b',{exact:true}).waitFor();
  await page.locator('button').last().click();
  await page.waitForFunction(() => (window as any).__BINDING.plans.length === 2);
  assert.deepEqual(await page.evaluate(() => (window as any).__BINDING.plans[1][0]),['b']);
  await page.goto(server.url+'?mode=incomplete'); await page.getByLabel('conn-a',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('b (unknown)',{exact:true}).isDisabled(),true);
  await page.locator('button').last().click();
  await page.waitForFunction(() => (window as any).__BINDING.plans.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).__BINDING.plans[0][0]),['a']);
});

async function launchChromium(chromium: {
  launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{
    close: () => Promise<void>;
    newPage: () => Promise<Page>;
  }>;
}) {
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return await chromium.launch({ headless: true });
  }
}
