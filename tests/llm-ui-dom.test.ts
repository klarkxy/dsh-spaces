import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

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
        newPage: () => Promise<BrowserPage>;
      }>;
    };
  };
  type BrowserPage = {
    goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
    getByRole: (role: string, opts: { name: string }) => { click: () => Promise<void> };
    locator: (sel: string) => {
      fill: (v: string) => Promise<void>;
      click: () => Promise<void>;
      count: () => Promise<number>;
      waitFor: (opts?: { state?: string; timeout?: number }) => Promise<void>;
      selectOption: (v: string) => Promise<void>;
    };
    content: () => Promise<string>;
    evaluate: (fn: () => unknown) => Promise<unknown>;
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
