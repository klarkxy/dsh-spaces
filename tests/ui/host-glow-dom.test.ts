import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { bindInitialLoopbackHttp } from "../../src/adapters/node/server/workbench-http.ts";

const SHOTS = resolve(".sandbox/host-glow-ui");
const EPOCH = "aa".repeat(32);
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const { server, port } = await bindInitialLoopbackHttp(() => createServer((req, res) => handler(req, res)));
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
const json = (res: ServerResponse, value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

type Activity = { attention: string; working: string } | "fail" | "bad-shape";

/** Dark picture for the fixture: the host tokens the dock reads, plus the page background. */
const DARK_TOKENS: Record<string, string> = {
  "--dsw-alias-bg-base": "#202127",
  "--dsw-alias-label-primary": "#eceef2",
  "--dsw-alias-label-secondary": "#b4b8c0",
  "--dsw-alias-border-l2": "#3a3c44",
  "--dsw-alias-border-l3": "#3a3c44",
  "--dsw-specific-sidebar-fill": "#18191d",
  "--dsw-alias-interactive-bg-hover": "#2a2c33",
  "--dsw-alias-interactive-bg-active": "#31333b",
};

type LightReading = { layer: { opacity: string; hue: string }; ring: { opacity: string; hue: string; animation: string }; rail: { hue: string } };

/**
 * One reading of the three light surfaces, taken in the page. Plain JS in a
 * string so the test runner's transpiler adds no helpers to it. The ring is
 * read from its real pseudo-element, and colours are classified by hue so the
 * check does not depend on the theme's tint strength. Chromium may report a
 * mixed colour as `rgb(...)` or `color(srgb ...)`; both are handled.
 */
const READ_LIGHT = `(() => {
  const channels = text => {
    const rgb = /rgba?\\(\\s*([\\d.]+)[ ,]+([\\d.]+)[ ,]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+))?/.exec(text);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    const srgb = /color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?/.exec(text);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    return null;
  };
  const hue = text => {
    const c = channels(text);
    if (!c || c[3] < 0.05) return "none";
    const r = c[0], g = c[1], b = c[2];
    if (g > r && g > b) return "green";
    if (r > b && g > b && Math.abs(r - g) <= 90) return "yellow";
    return "other";
  };
  const layer = document.querySelector(".dsh-host-glow");
  const rail = document.querySelector(".dsh-host-rail");
  const button = document.querySelector('[data-pinned="true"]');
  const ring = getComputedStyle(button, "::after");
  return {
    layer: { opacity: getComputedStyle(layer).opacity, hue: hue(getComputedStyle(layer).boxShadow) },
    ring: { opacity: ring.opacity, hue: hue(ring.borderTopColor), animation: ring.animationName },
    rail: { hue: hue(getComputedStyle(rail).boxShadow) },
  };
})()`;

test("DOM: current-space light is green/yellow, yellow wins, clears and never guesses", { timeout: 90000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-glow.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  let activity: Activity = { attention: "none", working: "idle" };
  let activityReads = 0;
  const server = await serve((req, res) => {
    if (req.url === "/client.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/directory") { json(res, { serviceEpoch: EPOCH, managerId: "hub", spaces: [{ id: "coding", displayName: "Coding", status: "stopped", generation: 0, attention: "required" }] }); return; }
    if (req.url === "/activity") {
      activityReads++;
      if (activity === "fail") { res.writeHead(503); res.end("no"); return; }
      json(res, activity === "bad-shape" ? { attention: "none", working: "busy", extra: 1 } : activity); return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<style>html,body,#root{margin:0;height:100%}#root{position:relative}main{height:100%}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style><div id="root"><main><textarea aria-label="Main draft"></textarea></main><div data-shell-overlay></div></div><script src="/client.js"></script>');
  });
  t.after(() => server.close());
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 560 }, locale: "zh-CN" });
  await page.goto(server.origin);
  const dock = page.locator("[data-spaces-native]");
  const main = page.locator('[data-pinned="true"]');
  await main.waitFor();
  const glow = () => dock.getAttribute("data-host-glow");
  const status = () => page.locator(".dsh-host-glow-status").innerText();
  const settle = (value: string | null) => page.waitForFunction(v => (document.querySelector("[data-spaces-native]")?.getAttribute("data-host-glow") ?? null) === v, value, { timeout: 8000 });
  const layerOpacity = () => page.locator(".dsh-host-glow").evaluate(el => getComputedStyle(el).opacity);
  const reading = (): Promise<LightReading> => page.evaluate(READ_LIGHT);
  /**
   * Every transition on the page has ended. Only transitions count: the
   * existing sub-space attention halo in the fixture is an infinite animation
   * by design and never finishes.
   */
  const transitionsEnded = () => page.waitForFunction(`document.getAnimations()
    .filter(animation => animation instanceof CSSTransition)
    .every(animation => animation.playState === "finished" || animation.playState === "idle")`, null, { timeout: 8000 });
  /**
   * All three light surfaces rest on their final state: the rail edge, the
   * pinned ring (read from the real pseudo-element, after every transition has
   * ended) and the host-page layer. `hue` is "none" for no light.
   */
  const settled = async (hue: "green" | "yellow" | "none") => {
    const state = { green: "working", yellow: "attention", none: "none" }[hue];
    await page.waitForFunction(`(document.querySelector("[data-spaces-native]")?.getAttribute("data-host-glow") ?? "none") === ${JSON.stringify(state)}`, null, { timeout: 8000 });
    await transitionsEnded();
    await page.waitForFunction(`(() => {
      const read = ${READ_LIGHT};
      const hue = ${JSON.stringify(hue)};
      const on = hue !== "none";
      return read.layer.opacity === (on ? "1" : "0") && read.ring.opacity === (on ? "1" : "0") &&
        (!on || (read.rail.hue === hue && read.layer.hue === hue && read.ring.hue === hue));
    })()`, null, { timeout: 8000 });
    const final = await reading();
    if (hue === "none") {
      assert.equal(final.layer.opacity, "0"); assert.equal(final.ring.opacity, "0");
    } else {
      assert.deepEqual([final.rail.hue, final.layer.hue, final.ring.hue], [hue, hue, hue], `rail, page edge and ring all rest on ${hue}`);
      assert.deepEqual([final.layer.opacity, final.ring.opacity], ["1", "1"]);
      assert.equal(final.ring.animation, "none", "the ring never loops");
    }
    return final;
  };
  const shot = async (name: string) => { await transitionsEnded(); return page.screenshot({ path: resolve(SHOTS, `${name}.png`), mask: [page.locator('[data-space-id="coding"]')], maskColor: "#808080" }); };
  const useDark = () => page.evaluate(`(() => {
    const tokens = ${JSON.stringify(DARK_TOKENS)};
    document.documentElement.style.background = "#202127"; document.body.style.background = "#202127"; document.body.style.color = "#eceef2";
    document.body.setAttribute("data-ds-dark-theme", "");
    for (const name of Object.keys(tokens)) document.documentElement.style.setProperty(name, tokens[name]);
  })()`);
  const useLight = () => page.evaluate(`(() => {
    const tokens = ${JSON.stringify(DARK_TOKENS)};
    document.documentElement.style.background = ""; document.body.style.background = ""; document.body.style.color = "";
    document.body.removeAttribute("data-ds-dark-theme");
    for (const name of Object.keys(tokens)) document.documentElement.style.removeProperty(name);
  })()`);

  // Idle and known-quiet: no light at all, and the sub-space halo keeps its own channel.
  await useDark();
  await settle(null);
  assert.equal(await dock.locator(".dsh-host-glow").getAttribute("data-glow"), null);
  await settled("none");
  assert.equal(await status(), "");
  assert.equal(await main.getAttribute("aria-label"), "Desktop \u00b7 \u4e3b\u7a7a\u95f4");
  assert.equal(await page.locator('[data-space-id="coding"]').getAttribute("data-attention"), "required", "sub-space halo untouched");
  const none = await shot("1-none");

  // Working -> green.
  activity = { attention: "none", working: "busy" };
  await settle("working");
  await settled("green");
  assert.equal(await main.getAttribute("data-glow"), "working");
  assert.equal(await status(), "\u6b63\u5728\u5de5\u4f5c");
  assert.match(await main.getAttribute("aria-label") ?? "", /\u6b63\u5728\u5de5\u4f5c$/);
  const green = await page.locator(".dsh-host-glow").evaluate(el => getComputedStyle(el).boxShadow);
  assert.equal(await page.locator(".dsh-host-glow").evaluate(el => getComputedStyle(el).pointerEvents), "none");
  assert.equal(await page.locator(".dsh-host-glow").evaluate(el => getComputedStyle(el).animationName), "none");
  await shot("2-working-green");

  // Yellow wins over working: no green is left on any surface once it settles.
  activity = { attention: "required", working: "busy" };
  await settle("attention");
  await settled("yellow");
  assert.equal(await status(), "\u7b49\u5f85\u5904\u7406");
  assert.notEqual(await page.locator(".dsh-host-glow").evaluate(el => getComputedStyle(el).boxShadow), green, "yellow differs from green");
  await shot("3-attention-yellow-wins");

  // Attention alone is yellow too, and a confirmed attention is not suppressed by an unknown working.
  activity = { attention: "required", working: "idle" };
  await page.waitForTimeout(1800); assert.equal(await glow(), "attention");
  activity = { attention: "required", working: "unknown" };
  await page.waitForTimeout(1800); assert.equal(await glow(), "attention", "required stays yellow even when working is unknown");

  // Attention unknown: green is not guessed while a pending approval cannot be ruled out.
  activity = { attention: "unknown", working: "busy" };
  await settle(null);
  await settled("none");
  const unknown = await shot("4-unknown-no-light");
  assert.equal(Buffer.compare(none, unknown), 0, "unknown looks exactly like no light");

  // Back to green, then cleared when the status disappears.
  activity = { attention: "none", working: "busy" };
  await settle("working");
  await settled("green");
  activity = { attention: "none", working: "idle" };
  await settle(null);
  await settled("none");
  assert.equal(await main.getAttribute("data-glow"), null);
  assert.equal(await status(), "");
  assert.equal(await main.getAttribute("aria-label"), "Desktop \u00b7 \u4e3b\u7a7a\u95f4");

  // A failed read and a malformed report both revoke a standing light; nothing is retained.
  activity = { attention: "required", working: "busy" };
  await settle("attention");
  activity = "fail";
  await settle(null);
  await settled("none");
  activity = { attention: "none", working: "busy" };
  await settle("working");
  activity = "bad-shape";
  await settle(null);
  await settled("none");

  // The layer never takes clicks or focus away from the host page.
  await page.getByRole("textbox", { name: "Main draft" }).fill("keep my draft");
  assert.equal(await page.getByRole("textbox", { name: "Main draft" }).inputValue(), "keep my draft");

  // Light theme: stronger tint than dark, same attribute contract, both lights settled before the picture.
  activity = { attention: "none", working: "busy" };
  await settle("working");
  const darkStrength = await dock.evaluate(el => getComputedStyle(el).getPropertyValue("--dsh-glow-strength").trim());
  await useLight();
  await page.evaluate(() => document.documentElement.setAttribute("data-ds-theme-source", "light"));
  const lightStrength = await dock.evaluate(el => getComputedStyle(el).getPropertyValue("--dsh-glow-strength").trim());
  assert.notEqual(lightStrength, darkStrength);
  await settled("green");
  await shot("5-working-light");
  activity = { attention: "required", working: "idle" };
  await settle("attention");
  await settled("yellow");
  await shot("6-attention-light");
  await page.evaluate(() => document.documentElement.removeAttribute("data-ds-theme-source"));

  // Reduced motion: no transition on any light surface.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => [
    getComputedStyle(document.querySelector(".dsh-host-glow")!).transitionDuration,
    getComputedStyle(document.querySelector('[data-pinned="true"]')!, "::after").transitionDuration,
  ]);
  assert.deepEqual(reduced.map(v => v.split(",").every(part => parseFloat(part) === 0)), [true, true]);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Forced colours: solid system-colour borders, yellow solid and green dashed.
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(await page.locator(".dsh-host-glow").evaluate(el => getComputedStyle(el).borderTopStyle), "solid");
  activity = { attention: "none", working: "busy" };
  await settle("working");
  await transitionsEnded();
  assert.equal(await page.locator(".dsh-host-glow").evaluate(el => getComputedStyle(el).borderTopStyle), "dashed");
  await shot("7-forced-colors-working");
  await page.emulateMedia({ forcedColors: "none" });

  assert.ok(activityReads > 4, "the light is a plain periodic read");
  assert.equal(await page.getByRole("alert").count(), 0);
  void layerOpacity;

  // The light is only drawn over host content while that content is shown.
  activity = { attention: "none", working: "busy" };
  await settle("working");
  // CSS gate on its own: with the report still "working", a layer that is not the shown surface stays dark.
  await page.evaluate(() => document.querySelector(".dsh-host-glow")!.removeAttribute("data-surface"));
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".dsh-host-glow")!).opacity === "0");
  assert.equal(await glow(), "working", "the report is unchanged; only the surface gate closed");
  await page.evaluate(() => document.querySelector(".dsh-host-glow")!.setAttribute("data-surface", "current"));
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".dsh-host-glow")!).opacity === "1");
  // Plain Chromium has no Electron <webview>, so leaving the host page ends in the controller's terminal failure (which also revokes the light by design).
  await page.locator("button[aria-label*='\u8bbe\u7f6e'], button[aria-label*='Settings']").first().click();
  await page.waitForFunction(() => document.querySelector(".dsh-host-glow")?.getAttribute("data-surface") === null);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".dsh-host-glow")!).opacity === "0");
});

test("DOM: a host without hostActivity never lights up and runs no poller", { timeout: 30000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const urls: string[] = [];
  const server = await serve((req, res) => {
    urls.push(req.url ?? "");
    if (req.url === "/client.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/directory") { json(res, { serviceEpoch: EPOCH, managerId: "hub", spaces: [] }); return; }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<style>html,body,#root{margin:0;height:100%}#root{position:relative}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style><div id="root"><main></main><div data-shell-overlay></div></div><script src="/client.js"></script>');
  });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" });
  await page.goto(server.origin);
  await page.locator('[data-pinned="true"]').waitFor();
  await page.waitForTimeout(2000);
  assert.equal(await page.locator("[data-spaces-native]").getAttribute("data-host-glow"), null);
  assert.equal(urls.includes("/activity"), false);
});
