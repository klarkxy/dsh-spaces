import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { MAX_ICON_DATA_URL_CHARS, MAX_ICON_SVG_BYTES } from "../packages/plugin/src/workbench/icons.ts";
import { MAX_ICON_SOURCE_BYTES } from "../packages/plugin/src/workbench/fit-icon.ts";
import { WORKBENCH_CSS } from "../packages/plugin/src/workbench/styles.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightRoot = process.env.DSH_TEST_PLAYWRIGHT || join(root, "node_modules/playwright");

type Page = {
  setContent: (html: string) => Promise<void>;
  evaluate: <T>(fn: () => Promise<T> | T) => Promise<T>;
};

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

test("browser shrinks an oversized image and keeps a small one", { timeout: 60_000 }, async () => {
  const bundled = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [join(root, "packages/plugin/src/workbench/fit-icon.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "FitIcon",
    platform: "browser",
  });
  const source = (bundled.outputFiles[0]?.text ?? "").replaceAll("</script", "<\\/script");
  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as {
    chromium: {
      launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{
        close: () => Promise<void>;
        newPage: () => Promise<Page>;
      }>;
    };
  };
  const browser = await launchChromium(chromium);
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8"><script>${source}</script>`);
    const report = await page.evaluate(async () => {
      const fit = (window as unknown as {
        FitIcon: { readLocalIcon: (file: File) => Promise<{ ok: true; icon: string } | { ok: false; reason: string }> };
      }).FitIcon;

      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 900;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let offset = 0; offset < pixels.data.length; offset += 65536) {
        crypto.getRandomValues(pixels.data.subarray(offset, Math.min(pixels.data.length, offset + 65536)));
      }
      for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255;
      ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("blob");
      const noisy = new File([blob], "shot.png", { type: "image/png" });
      const original = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(noisy);
      });
      const shrunk = await fit.readLocalIcon(noisy);
      let shrunkWidth = 0;
      let shrunkHeight = 0;
      if (shrunk.ok) {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error("preview"));
          element.src = shrunk.icon;
        });
        shrunkWidth = image.naturalWidth;
        shrunkHeight = image.naturalHeight;
      }

      const smallCanvas = document.createElement("canvas");
      smallCanvas.width = 8;
      smallCanvas.height = 8;
      const smallCtx = smallCanvas.getContext("2d");
      if (!smallCtx) throw new Error("small canvas");
      smallCtx.fillStyle = "#36c";
      smallCtx.fillRect(0, 0, 8, 8);
      const smallBlob = await new Promise<Blob | null>((resolve) => smallCanvas.toBlob(resolve, "image/png"));
      if (!smallBlob) throw new Error("small blob");
      const small = new File([smallBlob], "icon.png", { type: "image/png" });
      const smallUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(small);
      });
      const kept = await fit.readLocalIcon(small);

      const svg = new File(
        ['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c33"/></svg>'],
        "mark.svg",
        { type: "image/svg+xml" },
      );
      const vector = await fit.readLocalIcon(svg);
      const hostile = await fit.readLocalIcon(new File(
        ['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>'],
        "bad.svg",
        { type: "image/svg+xml" },
      ));
      const hugeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#393"/><!--${"x".repeat(70_000)}--></svg>`;
      const rasterized = await fit.readLocalIcon(new File([hugeSvg], "big.svg", { type: "image/svg+xml" }));
      const fake = await fit.readLocalIcon(new File([new Uint8Array(300_000)], "fake.png", { type: "image/png" }));
      const text = await fit.readLocalIcon(new File(["hello"], "notes.txt", { type: "text/plain" }));

      return {
        originalLength: original.length,
        noisySize: noisy.size,
        hugeSvgLength: hugeSvg.length,
        shrunk,
        shrunkWidth,
        shrunkHeight,
        smallUrl,
        kept,
        vector,
        hostile,
        rasterized,
        fake,
        text,
      };
    });

    assert.ok(report.originalLength > MAX_ICON_DATA_URL_CHARS, `fixture png was only ${report.originalLength} chars`);
    assert.equal(report.shrunk.ok, true);
    if (report.shrunk.ok) {
      assert.ok(report.shrunk.icon.length <= MAX_ICON_DATA_URL_CHARS);
      assert.ok(report.shrunk.icon.length < report.originalLength);
      assert.ok(report.shrunkWidth <= 256);
      assert.equal(report.shrunkHeight, Math.round((report.shrunkWidth * 900) / 1600));
    }
    assert.equal(report.kept.ok, true);
    if (report.kept.ok) assert.equal(report.kept.icon, report.smallUrl);
    assert.equal(report.vector.ok, true);
    if (report.vector.ok) assert.equal(report.vector.icon.startsWith("data:image/svg+xml;base64,"), true);
    assert.deepEqual(report.hostile, { ok: false, reason: "invalid" });
    assert.ok(report.hugeSvgLength > MAX_ICON_SVG_BYTES);
    assert.equal(report.rasterized.ok, true);
    if (report.rasterized.ok) {
      assert.equal(report.rasterized.icon.startsWith("data:image/png;base64,"), true);
      assert.ok(report.rasterized.icon.length <= MAX_ICON_DATA_URL_CHARS);
    }
    assert.ok(report.noisySize < MAX_ICON_SOURCE_BYTES);
    assert.deepEqual(report.fake, { ok: false, reason: "invalid" });
    assert.deepEqual(report.text, { ok: false, reason: "invalid" });
  } finally {
    await browser.close();
  }
});

test("create dialog shrinks a chosen image before it can be saved", { timeout: 60_000 }, async (t) => {
  const bundled = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [join(root, "tests/fixtures/fit-icon-ui/host.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
  });
  const source = bundled.outputFiles[0]?.text ?? "";
  const server = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/host.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(source);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>icon picker</title><div id="root"></div><script src="/host.js"></script>`);
  });
  t.after(() => server.close());

  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as {
    chromium: {
      launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{
        close: () => Promise<void>;
        newPage: () => Promise<PickerPage>;
      }>;
    };
  };
  const browser = await launchChromium(chromium);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url, { waitUntil: "networkidle" });
  assert.equal(await page.locator("#create").isDisabled(), false);

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1400;
    canvas.height = 800;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < pixels.data.length; offset += 65536) {
      crypto.getRandomValues(pixels.data.subarray(offset, Math.min(pixels.data.length, offset + 65536)));
    }
    ctx.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("blob");
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("input");
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "Codex.png", { type: "image/png" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.waitForSelector(".dsh-wb-icon-preview img");
  const length = Number(await page.locator("#length").innerText());
  const preview = await page.locator(".dsh-wb-icon-preview img").getAttribute("src");
  assert.ok(length > 0 && length <= MAX_ICON_DATA_URL_CHARS);
  assert.equal(preview?.length, length);
  assert.equal(await page.locator("#create").isDisabled(), false);
  assert.equal(await page.locator('[aria-label="Spaces"]').getAttribute("aria-pressed"), "false");

  await page.evaluate(() => {
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("input");
    const transfer = new DataTransfer();
    transfer.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForSelector(".dsh-wb-alert");
  assert.match(await page.locator(".dsh-wb-alert").innerText(), /缩小后仍然太大|本地图片/);
  assert.equal(await page.locator("#create").isDisabled(), true);

  await page.getByRole("button", { name: "使用默认图标" }).click();
  await page.waitForFunction(() => document.getElementById("length")?.textContent === "0");
  assert.equal(await page.locator("#create").isDisabled(), false);
  assert.equal(await page.locator(".dsh-wb-icon-preview").count(), 0);
});

type PickerPage = {
  goto: (url: string, opts?: { waitUntil?: "networkidle" }) => Promise<unknown>;
  evaluate: <T>(fn: () => Promise<T> | T) => Promise<T>;
  waitForSelector: (selector: string) => Promise<unknown>;
  waitForFunction: (fn: () => boolean) => Promise<unknown>;
  locator: (selector: string) => {
    innerText: () => Promise<string>;
    getAttribute: (name: string) => Promise<string | null>;
    isDisabled: () => Promise<boolean>;
    count: () => Promise<number>;
  };
  getByRole: (role: string, opts: { name: string }) => { click: () => Promise<void> };
};

test("rail icons stay in their buttons when host image rules use !important", { timeout: 60_000 }, async () => {
  const require = createRequire(join(playwrightRoot, "index.js"));
  const { chromium } = require("playwright") as {
    chromium: {
      launch: (opts?: { headless?: boolean; channel?: string }) => Promise<{
        close: () => Promise<void>;
        newPage: () => Promise<Page>;
      }>;
    };
  };
  const browser = await launchChromium(chromium);
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><meta charset=\"utf-8\"><div id=\"root\"></div>");
    const images = await page.evaluate(() => {
      const brandCanvas = document.createElement("canvas");
      brandCanvas.width = 512;
      brandCanvas.height = 512;
      const brandCtx = brandCanvas.getContext("2d");
      if (!brandCtx) throw new Error("canvas");
      brandCtx.fillStyle = "#48a";
      brandCtx.fillRect(0, 0, 512, 512);
      const spaceCanvas = document.createElement("canvas");
      spaceCanvas.width = 256;
      spaceCanvas.height = 256;
      const spaceCtx = spaceCanvas.getContext("2d");
      if (!spaceCtx) throw new Error("canvas");
      spaceCtx.fillStyle = "#c46";
      spaceCtx.fillRect(0, 0, 256, 256);
      return { brand: brandCanvas.toDataURL("image/png"), space: spaceCanvas.toDataURL("image/png") };
    });
    await page.setContent(`<!doctype html><style>${WORKBENCH_CSS}
button, img, aside, div { width: auto !important; height: auto !important; max-width: none !important; overflow: visible !important; display: block !important; }
</style>
<div class="dsh-workbench" style="height:640px">
  <aside class="dsh-wb-rail">
    <button class="dsh-wb-rail-btn" id="home"><img class="dsh-wb-glyph-img" src="${images.brand}" alt=""><span class="dsh-wb-sr">首页</span></button>
    <div class="dsh-wb-rail-list">
      <button class="dsh-wb-rail-btn" id="a"><img class="dsh-wb-glyph-img" src="${images.space}" alt=""></button>
      <button class="dsh-wb-rail-btn" id="b"><img class="dsh-wb-glyph-img" src="${images.space}" alt=""></button>
    </div>
  </aside>
  <div class="dsh-wb-main" id="main"></div>
</div>`);
    const box = await page.evaluate(() => {
      const home = document.getElementById("home")?.getBoundingClientRect();
      const a = document.getElementById("a")?.getBoundingClientRect();
      const b = document.getElementById("b")?.getBoundingClientRect();
      const rail = document.querySelector(".dsh-wb-rail")?.getBoundingClientRect();
      const main = document.getElementById("main")?.getBoundingClientRect();
      const label = document.querySelector(".dsh-wb-sr")?.getBoundingClientRect();
      return {
        rail: rail ? { w: rail.width, h: rail.height } : { w: 0, h: 0 },
        home: home ? { w: home.width, h: home.height } : { w: 0, h: 0 },
        a: a ? { w: a.width, h: a.height } : { w: 0, h: 0 },
        b: b ? { w: b.width, h: b.height } : { w: 0, h: 0 },
        main: main ? { w: main.width, x: main.x } : { w: 0, x: 0 },
        label: label ? { w: label.width, h: label.height } : { w: 0, h: 0 },
      };
    });
    assert.equal(box.rail.w, 72);
    assert.equal(box.home.w, 48);
    assert.equal(box.home.h, 48);
    assert.equal(box.a.w, 48);
    assert.equal(box.b.h, 48);
    assert.ok(box.main.w > 400);
    assert.ok(box.main.x >= 72);
    assert.equal(box.label.w, 1);
    assert.equal(box.label.h, 1);
  } finally {
    await browser.close();
  }
});

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
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}
