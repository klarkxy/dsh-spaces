import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { bindInitialLoopbackHttp, startWorkbenchHttp, type WorkbenchHttpRuntime } from "../../src/adapters/node/server/workbench-http.ts";
import { expectedAuthCookieName } from "../../src/adapters/node/server/workbench-http.ts";
import { mintSupervisorPortal } from "../../packages/plugin/src/host/workbench-http.ts";
import { renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";

const EPOCH = "aa".repeat(32), REVISION = "bb".repeat(32);
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const { server, port } = await bindInitialLoopbackHttp(() =>
    createServer((req, res) => { Promise.resolve(handler(req,res)).catch(() => { res.writeHead(500); res.end("fixture-failure"); }); }));
  const origin = `http://127.0.0.1:${port}`;
  return { origin, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
async function body(req: IncomingMessage) { const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
function json(res: ServerResponse, value: unknown) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify(value)); }

test("DOM: Desktop rail exposes live status, keyboard/context actions and one launch without stealing main", { timeout: 30000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const snapshot = { serviceEpoch: EPOCH, managerId: "hub", spaces: [{ id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] };
  const actions: string[] = [];
  let complete: (() => void) | undefined;
  const server = await serve(async (req, res) => {
    if (req.url === "/client.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/directory") { json(res, snapshot); return; }
    if (req.url === "/space-action") {
      const request = await body(req); assert.equal(request.spaceId, "coding"); assert.equal(request.serviceEpoch, EPOCH); actions.push(request.action);
      if (request.action === "open") await new Promise<void>(done => { complete = done; });
      snapshot.spaces[0].status = request.action === "stop" ? "stopped" : "running";
      snapshot.spaces[0].generation++; json(res, snapshot); return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<style>html,body,#root{margin:0;height:100%}#root{position:relative}main{height:100%}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style><div id="root"><main><textarea aria-label="Main draft"></textarea></main><div data-shell-overlay></div></div><script src="/client.js"></script>');
  });
  t.after(() => { complete?.(); return server.close(); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 500 }, locale: "zh-CN" }); await page.goto(server.origin);
  const coding = page.locator('[data-space-id="coding"]'); await coding.waitFor();
  assert.equal(await coding.getAttribute("title"), "Coding · 已停止");
  await coding.click({ button: "right" });
  assert.equal(await page.getByRole("menuitem", { name: "启动", exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole("menuitem", { name: "停止", exact: true }).isDisabled(), true);
  mkdirSync(resolve(".sandbox/desktop-rail-ui-20261026"), { recursive: true });
  await page.screenshot({ path: resolve(".sandbox/desktop-rail-ui-20261026/stopped-menu.png") });
  await page.keyboard.press("Escape"); assert.equal(await coding.evaluate(el => el === document.activeElement), true);
  await coding.dblclick();
  await page.waitForFunction(() => document.querySelector('[data-space-id="coding"]')?.getAttribute("aria-busy") === "true");
  await page.getByRole("button", { name: "Desktop · 主空间", exact: true }).click();
  await page.getByRole("textbox", { name: "Main draft" }).fill("keep my draft");
  assert.deepEqual(actions, ["open"]); complete!();
  await page.waitForFunction(() => document.querySelector('[data-space-id="coding"]')?.getAttribute("title") === "Coding · 尚未打开");
  await coding.focus(); await page.keyboard.press("Shift+F10");
  assert.equal(await page.getByRole("menuitem", { name: "启动", exact: true }).isDisabled(), true);
  await page.getByRole("menuitem", { name: "重启", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-space-id="coding"]')?.hasAttribute("aria-busy"));
  await coding.click({ button: "right" }); await page.getByRole("menuitem", { name: "停止", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-space-id="coding"]')?.getAttribute("title") === "Coding · 已停止");
  assert.deepEqual(actions, ["open", "restart", "stop"]);
  assert.equal(await page.getByRole("textbox", { name: "Main draft" }).inputValue(), "keep my draft");
  assert.equal(await page.getByRole("alert").count(), 0);
});

test("DOM: native startup registration failure leaves main interactive and details available", { timeout: 30000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-startup.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  let reads = 0;
  let respond!: () => void;
  const server = await serve((req, res) => {
    if (req.url === "/client.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/directory") {
      reads++; respond = () => { res.writeHead(503); res.end("MAIN_REGISTRATION_REFUSED:404"); }; return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<style>html,body,#root{margin:0;height:100%}#root{position:relative}main{height:100%}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style>
      <div id="root"><main id="main"><h1>Main</h1><textarea aria-label="Main draft">existing draft</textarea></main><div data-shell-overlay></div></div><script src="/client.js"></script>`);
  });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" }); await page.goto(server.origin);
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  const main = await page.locator("#main").elementHandle();
  await page.getByRole("textbox", { name: "Main draft" }).fill("main draft while connecting");
  assert.equal(reads, 1); respond();
  const settings = page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true });
  await settings.waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(await page.locator("#main").evaluate(el => (el as HTMLElement).inert), false);
  await page.getByRole("textbox", { name: "Main draft" }).fill("main draft after failure");
  await settings.click();
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator('.dsh-host-detail[data-reason="primary"]').innerText(), "失败原因\nMAIN_REGISTRATION_REFUSED:404");
  const failedAt = page.locator('.dsh-host-detail[data-reason="failed-at"]');
  assert.equal(await failedAt.count(), 1);
  assert.match(await failedAt.innerText(), /^失败时间：/);
  await page.getByRole("button", { name: "返回主空间", exact: true }).click();
  await page.getByRole("textbox", { name: "Main draft" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Main draft" }).inputValue(), "main draft after failure");
  assert.equal(await page.locator("#main").evaluate((el, original) => el === original, main), true);
  await page.waitForTimeout(1700);
  assert.equal(reads, 1, "failed discovery is terminal");
});

for (const outcome of ["success", "failed"] as const) test(`DOM: manual service restart ${outcome} requires impact confirmation and preserves main`, { timeout: 60000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  let reads = 0, previews = 0, restarts = 0, running = false;
  let complete!: () => void;
  const server = await serve(async (req, res) => {
    if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/directory") {
      reads++;
      if (!running) { res.writeHead(503); res.end("MAIN_REGISTRATION_REFUSED:404"); }
      else json(res, { serviceEpoch: EPOCH, managerId: "hub", spaces: [{ id: "hub", displayName: "Manager", status: "running", generation: 1 }] });
      return;
    }
    if (req.url === "/restart-preview") { previews++; json(res, { confirmationId: "a".repeat(64), action: "restart", expiresAt: new Date(Date.now() + 300000).toISOString(), spaces: [{ id: "coding", displayName: "Coding", running: true }] }); return; }
    if (req.url === "/restart") {
      assert.deepEqual(await body(req), { confirmationId: "a".repeat(64) }); restarts++;
      await new Promise<void>(done => { complete = done; });
      if (outcome === "success") { running = true; json(res, { ok: true, connected: true, unavailable: false, origin: server.origin, reasons: [] }); }
      else { res.writeHead(503); res.end("Shutdown failed; service not started."); }
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><style>html,body,#root{height:100%;margin:0}#root{position:relative}main{height:100%}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style><div id="root"><main id="main"><textarea aria-label="Main draft"></textarea></main><div data-shell-overlay></div></div><script src="/client.js"></script>');
  });
  t.after(() => { complete?.(); return server.close(); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" }); await page.goto(server.origin);
  await page.getByRole("textbox", { name: "Main draft" }).fill("keep this unsent main draft");
  const main = await page.locator("#main").elementHandle();
  await page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true }).click();
  const previewButton = page.getByRole("button", { name: "手动启动 / 重启 Spaces 服务…", exact: true });
  await previewButton.click();
  await page.getByRole("heading", { name: "重启 Spaces 服务？" }).waitFor();
  assert.match(await page.getByRole("dialog", { name: "Spaces 服务操作" }).innerText(), /Coding.*将停止/);
  assert.equal(restarts, 0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(restarts, 0); assert.equal(reads, 1);
  await previewButton.click();
  await page.getByRole("button", { name: "停止并重启服务", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "正在重启 Spaces 服务" }).waitFor();
  // The main DOM and draft survive the modal operation.
  assert.equal(restarts, 1); complete();
  if (outcome === "success") await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  else {
    await page.getByRole("alert").filter({ hasText: "Shutdown failed" }).waitFor();
    assert.match(await page.locator(".dsh-host-detail").first().innerText(), /MAIN_REGISTRATION_REFUSED:404/);
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
    await page.getByRole("button", { name: "返回主空间", exact: true }).click();
  }
  assert.equal(await page.getByRole("textbox", { name: "Main draft" }).inputValue(), "keep this unsent main draft");
  assert.equal(await page.locator("#main").evaluate((el, original) => el === original, main), true);
  await page.waitForTimeout(1700);
  assert.equal(previews, 2); assert.equal(restarts, 1);
  if (outcome === "failed") assert.equal(reads, 1, "a failed manual operation does not reconnect");
});

test("DOM: reload Spaces view recovers after transient directory failure without restarting backend service", { timeout: 60000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/native-startup.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  let reads = 0, previews = 0, restarts = 0, running = false, missingManager = false;
  const server = await serve(async (req, res) => {
    if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/directory") {
      reads++;
      if (!running) { res.writeHead(503); res.end("TRANSIENT_BRIDGE_ERROR"); }
      else if (missingManager) {
        json(res, { serviceEpoch: EPOCH, managerId: "hub", spaces: [{ id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] });
      } else {
        json(res, { serviceEpoch: EPOCH, managerId: "hub", spaces: [{ id: "hub", displayName: "Spaces", status: "running", generation: 1 }, { id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] });
      }
      return;
    }
    if (req.url === "/restart-preview") { previews++; json(res, { confirmationId: "a".repeat(64), action: "restart", expiresAt: new Date(Date.now() + 300000).toISOString(), spaces: [] }); return; }
    if (req.url === "/restart") { restarts++; res.writeHead(500); res.end("must not restart"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><style>html,body,#root{height:100%;margin:0}#root{position:relative}main{height:100%}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style><div id="root"><main id="main"><textarea aria-label="Main draft"></textarea></main><div data-shell-overlay></div></div><script src="/client.js"></script>');
  });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" }); await page.goto(server.origin);
  await page.getByRole("textbox", { name: "Main draft" }).fill("unsent during view reload");
  const main = await page.locator("#main").elementHandle();
  await page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "空间服务或页面不可用" }).waitFor();
  assert.equal(await page.locator('.dsh-host-detail[data-reason="primary"]').innerText(), "失败原因\nTRANSIENT_BRIDGE_ERROR");

  const reloadButton = page.getByRole("button", { name: "重新加载空间界面", exact: true });
  await reloadButton.click();
  await page.getByRole("alert").filter({ hasText: "TRANSIENT_BRIDGE_ERROR" }).waitFor();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  assert.equal(await page.locator('.dsh-host-detail[data-reason="primary"]').innerText(), "失败原因\nTRANSIENT_BRIDGE_ERROR");
  assert.equal(await page.locator('.dsh-host-detail[data-reason="failed-at"]').count(), 1);
  assert.equal(previews, 0);
  assert.equal(restarts, 0);

  // Snapshot lacking the managerId row in spaces must refuse surface reload and preserve the error screen.
  running = true;
  missingManager = true;
  await reloadButton.click();
  await page.getByRole("alert").filter({ hasText: "Spaces 服务当前未就绪，无法仅重新加载空间界面。" }).waitFor();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  assert.equal(await page.locator('.dsh-host-detail[data-reason="primary"]').innerText(), "失败原因\nTRANSIENT_BRIDGE_ERROR");
  assert.equal(previews, 0);
  assert.equal(restarts, 0);

  missingManager = false;
  await reloadButton.click();
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  await page.locator('[data-space-id="coding"]').waitFor();
  assert.equal(previews, 0);
  assert.equal(restarts, 0);
  assert.ok(reads >= 5);
  assert.equal(await page.getByRole("textbox", { name: "Main draft" }).inputValue(), "unsent during view reload");
  assert.equal(await page.locator("#main").evaluate((el, original) => el === original, main), true);
});

test("DOM: host rail preserves sidebar resize geometry and dragging", { timeout: 30000 }, async t => {
  const bundle = await build({
    stdin: {
      contents: `
        import { attachHostLayout } from "./packages/plugin/src/client/host-layout";
        import { HOST_SHELL_CSS } from "./packages/plugin/src/client/host-shell";
        const style = document.createElement("style");
        style.textContent = HOST_SHELL_CSS;
        document.head.append(style);
        const anchor = document.createElement("div");
        anchor.className = "dsh-host-dock";
        anchor.innerHTML = '<nav class="dsh-host-rail"></nav><main class="dsh-host-surface"></main>';
        document.querySelector("[data-shell-overlay]").append(anchor);
        const layout = attachHostLayout(anchor);
        window.__disposeHostLayout = () => { layout.dispose(); anchor.remove(); };
      `,
      resolveDir: resolve("."),
      loader: "ts",
    },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  const server = await serve((req, res) => {
    if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><style>
      html,body{margin:0;width:100%;height:100%}#frame{height:100%;display:grid;position:relative;overflow:hidden;grid-template-columns:280px minmax(0,1fr)}
      #sidebar{background:#eee}#main{min-width:0;overflow:hidden}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}
      #sidebar-resize{position:absolute;top:0;bottom:0;left:280px;width:12px;transform:translateX(-6px);cursor:col-resize;z-index:3}
    </style><div id="frame"><aside id="sidebar"></aside><main id="main"></main><div data-shell-overlay></div><div id="sidebar-resize"></div></div>
    <script>
      const frame = document.querySelector("#frame"), handle = document.querySelector("#sidebar-resize");
      let drag = null;
      handle.addEventListener("pointerdown", event => {
        drag = { x: event.clientX, width: document.querySelector("#sidebar").getBoundingClientRect().width };
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener("pointermove", event => {
        if (!drag) return;
        const width = drag.width + event.clientX - drag.x;
        frame.style.gridTemplateColumns = width + "px minmax(0,1fr)";
        handle.style.left = width + "px";
      });
      handle.addEventListener("pointerup", () => { drag = null; });
    </script><script src="/client.js"></script>`);
  });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...process.env.DSH_TEST_CHROMIUM ? { executablePath: process.env.DSH_TEST_CHROMIUM } : {} });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(server.origin);
  await page.locator(".dsh-host-rail").waitFor();
  const geometry = () => page.evaluate(() => Object.fromEntries([
    ["frame", "#frame"], ["sidebar", "#sidebar"], ["handle", "#sidebar-resize"], ["rail", ".dsh-host-rail"], ["surface", ".dsh-host-surface"],
  ].map(([key, selector]) => {
    const { x, width } = document.querySelector(selector)!.getBoundingClientRect();
    return [key, { x, right: x + width, width }];
  })) as Record<"frame" | "sidebar" | "handle" | "rail" | "surface", { x: number; right: number; width: number }>);
  const initial = await geometry();
  assert.equal(initial.frame.x, 72);
  assert.equal(initial.frame.width, 1208);
  assert.equal(initial.sidebar.x, 72);
  assert.equal(initial.handle.x + initial.handle.width / 2, initial.sidebar.right);
  assert.equal(initial.rail.x, 0);
  assert.equal(initial.surface.x, 72);
  assert.equal(await page.evaluate(() => document.elementFromPoint(36, 100)?.closest(".dsh-host-rail") !== null), true);
  const handle = await page.locator("#sidebar-resize").boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 60, handle!.y + 100);
  await page.mouse.up();
  const resized = await geometry();
  assert.equal(resized.sidebar.width, 340);
  assert.equal(resized.handle.x + resized.handle.width / 2, resized.sidebar.right);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => (window as any).__disposeHostLayout());
  const restored = await page.locator("#frame").evaluate(el => {
    const { x, width } = el.getBoundingClientRect();
    return { x, width, marginLeft: (el as HTMLElement).style.marginLeft, inlineWidth: (el as HTMLElement).style.width };
  });
  assert.equal(restored.x, 0);
  assert.equal(restored.width, 1280);
  assert.equal(restored.marginLeft, "");
  assert.equal(restored.inlineWidth, "");
});

test("DOM: stale rail and adjacent clicks enter once while preserving native DOM/drafts and authentication", { timeout: 90000 }, async t => {
  const bundle = await build({ entryPoints:[resolve("tests/fixtures/portable-host/client.tsx")], bundle:true, write:false, format:"iife",platform:"browser",jsx:"automatic" });
  const js=bundle.outputFiles[0].text;
  let supervisorOrigin="", managerOrigin="", childOrigin="";
  const calls: string[]=[], viewTargets: string[]=[];
  const space=(id:string,name:string,isHost=false) => ({ id,displayName:name,isHost,hasWebApp:true,icon:"",status:"running",generation:1,managed:true });
  const state={ protocolVersion:2,serviceEpoch:EPOCH,revision:REVISION,role:"manager",managerId:"spaces-hub",availability:"ready",writable:true,maintenance:false,reasons:[],spaces:[space("spaces-hub","Manager",true),space("alpha","Alpha")],jobs:[],cliVersion:"0.1.7-alpha.1" };
  state.spaces[1].status = "stopped";
  const view=(id:string) => ({serviceEpoch:EPOCH,spaceId:id,generation:1,origin:id==="spaces-hub"?managerOrigin:childOrigin,entryOrigin:supervisorOrigin,entryPath:`/view/${id}/1`,channel:`ch-${id}-1`});
  const hint=(id:string) => ({parentOrigin:id==="spaces-hub"?supervisorOrigin:managerOrigin,spaceId:id,generation:1,channel:`ch-${id}-1`,serviceEpoch:EPOCH});
  const html=(role:string,id?:string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;box-sizing:border-box}#root{position:relative}#native{height:100%;padding:20px;box-sizing:border-box}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style></head><body><div id="root">${role==="parent"?'<main id="native"><h1>Original application</h1><textarea aria-label="Original draft"></textarea></main><div data-shell-overlay></div>':'<div data-dsh-boot>Loading</div>'}</div><script>window.__PORTABLE_FIXTURE__=${JSON.stringify({role})};${id?'window.__DSH_SPACES_VIEW__='+JSON.stringify(hint(id))+';':''}</script><script src="/client.js"></script></body></html>`;
  const client = async(role:string,id:string,req:IncomingMessage,res:ServerResponse) => {
    if(req.url==="/client.js"){res.writeHead(200,{"content-type":"text/javascript"});res.end(js);return;}
    if(req.url?.startsWith("/fixture-api/")){
      const method=req.url.slice("/fixture-api/".length),payload=await body(req);calls.push("manager:"+method);
      if (method === "view") viewTargets.push(payload.spaceId);
      if(method==="product") { json(res,{method:"settings",settings:{portStart:3100,portEnd:3199,packageSource:"official",catalogUrl:""},clientDefaults:{locale:"en",theme:"light"},observation:{serviceEpoch:EPOCH,expectedRevision:REVISION}});return; }
      const result=await fetch(supervisorOrigin+"/api/workbench/"+method,{method:"POST",headers:{"content-type":"application/json",origin:managerOrigin,cookie:"operator=fixture-session"},body:JSON.stringify(payload)});
      const data=await result.json(); if(!data.ok)throw Error("fixture result");json(res,data.value);return;
    }
    res.writeHead(200,{"content-type":"text/html"});res.end(html(role,id));
  };
  const child=await serve((req,res)=>client("child","alpha",req,res));childOrigin=child.origin;t.after(()=>child.close());
  const manager=await serve((req,res)=>client("manager","spaces-hub",req,res));managerOrigin=manager.origin;t.after(()=>manager.close());
  const runtime:WorkbenchHttpRuntime={cookieName:()=>"operator",sessionCookie:()=>"fixture-session",sessionEquals:v=>v==="fixture-session",hostBearerEquals:v=>v==="fixture-bearer",consumeBootstrapToken:()=>false,
    supervisorOrigin:()=>supervisorOrigin,managerOrigin:()=>managerOrigin,isWorkspaceOrigin:origin=>origin===childOrigin,
    dispatch:async(method,payload)=>{calls.push("supervisor:"+method);if(method==="state")return state;if(method==="view")return view((payload as {spaceId:string}).spaceId);throw Error("Writes not supported");},entryPage:()=>"",mintHandoff:()=>"",
    viewEntry:async(id,generation,epoch)=>{if(!["spaces-hub","alpha"].includes(id)||generation!=="1"||epoch!==EPOCH)return{status:403,message:"stale"};const origin=view(id).origin;return{setCookies:[`${expectedAuthCookieName(new URL(origin).host)}=fixture-child; Path=/; HttpOnly; SameSite=Strict`],location:origin+"/"};},
  };
  const supervisor=await startWorkbenchHttp(runtime);supervisorOrigin=supervisor.origin;t.after(()=>supervisor.close());
  const parent=await serve(async(req,res)=>{
    if(req.url==="/client.js"){res.writeHead(200,{"content-type":"text/javascript"});res.end(js);return;}
    if(req.url==="/guide/role"){calls.push("guide:role");json(res,{role:"workspace",profileId:"entry",managerId:"spaces-hub",unavailable:false,reasons:[]});return;}
    if(req.url==="/guide/portal"){
      calls.push("guide:portal");const audience=await body(req);
      const path=await mintSupervisorPortal(fetch,{origin:supervisorOrigin,bearer:"fixture-bearer"} as never,audience);
      json(res,{available:true,unavailable:false,origin:supervisorOrigin,path,reasons:[]});return;
    }
    res.writeHead(200,{"content-type":"text/html"});res.end(html("parent"));
  });t.after(()=>parent.close());
  const browser=await chromium.launch({headless:true,...process.env.DSH_TEST_CHROMIUM?{executablePath:process.env.DSH_TEST_CHROMIUM}:{}});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:850},locale:"en-US"});const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const browserConsole: string[] = [];
  page.on("console", message => { if (message.type() === "error" && browserConsole.length < 20) browserConsole.push(message.text().slice(0, 1000).replace(/portal-bootstrap\/[A-Za-z0-9_-]+/g, "portal-bootstrap/[redacted]")); });
  try {
  await page.goto(parent.origin);
  await page.getByRole("button",{name:"Alpha",exact:true}).waitFor();
  await page.getByRole("textbox",{name:"Original draft"}).fill("original draft is retained");
  assert.equal(await page.getByRole("button",{name:"Alpha",exact:true}).getAttribute("data-space-status"), "stopped");
  state.spaces[1].status = "running";
  await page.getByRole("button",{name:"Alpha",exact:true}).dblclick();
  const surface=page.frameLocator("iframe[data-spaces-host-surface]");
  const management=surface.frameLocator("iframe");
  const workspace=management.frameLocator('iframe[data-space-id="alpha"]');
  await workspace.getByRole("textbox",{name:"Space draft"}).fill("space draft is retained");
  assert.equal(viewTargets.filter(id => id === "alpha").length, 1);
  await page.waitForFunction(()=>document.querySelector('button[aria-label="Alpha"]')?.getAttribute("aria-current")==="true");
  assert.equal(page.url(),parent.origin+"/");
  assert.equal(await page.locator("[data-spaces-host-dock]").count(),1);
  assert.equal(await management.locator(".dsh-wb-rail").count(),0);
  assert.equal(await management.locator(".dsh-wb-contained-tools").count(),1);
  assert.equal(await page.locator("#native").evaluate(el=>(el as HTMLElement).inert),true);
  await page.getByRole("button",{name:"Current application",exact:true}).click();
  assert.equal(await page.getByRole("textbox",{name:"Original draft"}).inputValue(),"original draft is retained");
  assert.equal(await page.evaluate(()=>document.getElementById("native")===(window as any).__nativeIdentity),true);
  await page.getByRole("button",{name:"Alpha",exact:true}).click();
  assert.equal(await workspace.getByRole("textbox",{name:"Space draft"}).inputValue(),"space draft is retained");
  await page.getByRole("button",{name:"Spaces Home",exact:true}).click();
  // The manager Home is the native Home view: the space frame is released and no space stays visible.
  await management.locator('iframe[data-space-id="alpha"]').waitFor({state:"hidden"});
  await page.setViewportSize({width:450,height:800});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  mkdirSync(".sandbox/portable-host-evidence",{recursive:true});await page.screenshot({path:".sandbox/portable-host-evidence/in-place-rail.png"});
  await page.getByRole("button",{name:"Current application",exact:true}).click();
  await page.evaluate(()=>(window as any).__disposePortable());
  assert.equal(await page.locator("#root").evaluate(el=>(el as HTMLElement).style.marginLeft),"");
  assert.equal(await page.locator("#root").evaluate(el=>(el as HTMLElement).style.width),"");
  assert.equal(await page.getByRole("textbox",{name:"Original draft"}).inputValue(),"original draft is retained");
  assert.equal(calls.filter(v=>v==="guide:portal").length,1);
  assert.equal(calls.some(v=>/submit|initialize|shutdown|start|preview/.test(v)),false);
  assert.deepEqual(errors,[]);
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const ui = (window as any).__portableController?.getSnapshot();
      return { phase: ui?.phase, error: ui?.error, visible: ui?.visible,
        inventory: ui?.inventory, frameCount: document.querySelectorAll("iframe").length,
        bodyText: document.body.innerText.slice(0, 2000) };
    }).catch(() => null);
    console.error("portable-host browser failure", JSON.stringify({ snapshot, errors, browserConsole, calls }));
    mkdirSync(".sandbox/portable-host-evidence", { recursive: true });
    await page.screenshot({ path: ".sandbox/portable-host-evidence/failed.png" }).catch(() => undefined);
    throw error;
  }
});

test("DOM: terminal portal causes retain exact iframe authentication and never reconnect", { timeout: 90000 }, async t => {
  const bundle = await build({ entryPoints: [resolve("tests/fixtures/portable-host/client.tsx")], bundle: true,
    write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const js = bundle.outputFiles[0].text;
  let channel = "";
  let parentOrigin = "", portalOrigin = "", managerOrigin = "", cause = "", stateReads = 0, viewReads = 0, portalMints = 0;
  const state = { protocolVersion: 2, serviceEpoch: EPOCH, managerId: "spaces-hub", availability: "ready",
    spaces: [{ id: "spaces-hub", displayName: "Manager", generation: 1, status: "running", hasWebApp: true },
      { id: "alpha", displayName: "Alpha", generation: 1, status: "running", hasWebApp: true }] };
  const view = () => ({ serviceEpoch: EPOCH, spaceId: "spaces-hub", generation: 1, channel: "manager-channel",
    origin: managerOrigin, entryOrigin: portalOrigin, entryPath: "/view/spaces-hub/1" });
  const manager = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<script>
      const identity = ${JSON.stringify({ serviceEpoch: EPOCH, spaceId: "spaces-hub", generation: 1, channel: "manager-channel" })};
      const origin = ${JSON.stringify(portalOrigin)};
      window.report = (state, extra = {}) => parent.postMessage({ ...identity, source: "dsh-spaces-view", state, ...extra }, origin);
      report("ready");
      parent.postMessage({ ...identity, source: "dsh-spaces-surface", type: "ready" }, origin);
      addEventListener("message", event => {
        const message = event.data;
        if (event.source !== parent || event.origin !== origin || message.source !== "dsh-spaces-surface-parent") return;
        parent.postMessage({ ...identity, source: "dsh-spaces-surface", type: "selected",
          requestId: message.requestId, target: message.target }, origin);
      });
    </script>`);
  });
  managerOrigin = manager.origin; t.after(() => manager.close());
  const portal = await serve(async (req, res) => {
    if (req.url?.startsWith("/api/workbench/")) {
      if (req.url.endsWith("/view")) { viewReads++; json(res, { ok: true, value: view() }); return; }
      stateReads++;
      if (cause === "state-request") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: { code: "workbench/unavailable", message: "private token must not be exposed" } })); return;
      }
      const value = cause === "state-invalid" ? { ...state, spaces: [{}] }
        : cause === "service-changed" ? { ...state, serviceEpoch: "ff".repeat(32) }
        : cause === "manager-generation-changed" ? { ...state, spaces: state.spaces.map(row => ({ ...row, generation: 2 })) }
        : cause === "manager-stopped" ? { ...state, spaces: state.spaces.map(row => ({ ...row, status: "stopped" })) } : state;
      json(res, { ok: true, value }); return;
    }
    if (req.url?.startsWith("/view/")) { res.writeHead(303, { location: managerOrigin }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(renderPortalPage({ parentOrigin, channel }, managerOrigin));
  });
  portalOrigin = portal.origin; t.after(() => portal.close());
  const parent = await serve(async (req, res) => {
    if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(js); return; }
    if (req.url === "/guide/role") {
      json(res, { role: "workspace", profileId: "entry", managerId: "spaces-hub", unavailable: false, reasons: [] }); return;
    }
    if (req.url === "/guide/portal") {
      portalMints++; const audience = await body(req);
      assert.equal(audience.parentOrigin, parentOrigin);
      channel = audience.channel;
      json(res, { available: true, unavailable: false, origin: portalOrigin,
        path: "/portal-bootstrap/" + "a".repeat(32), reasons: [] }); return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<div id="root"><main id="native">Original application</main><div data-shell-overlay></div></div>
      <script>window.__PORTABLE_FIXTURE__={role:"parent"};</script><script src="/client.js"></script>`);
  });
  parentOrigin = parent.origin; t.after(() => parent.close());
  const browser = await chromium.launch({ headless: true,
    ...process.env.DSH_TEST_CHROMIUM ? { executablePath: process.env.DSH_TEST_CHROMIUM } : {} });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US" });
  for (const reason of ["state-request", "state-invalid", "service-changed", "manager-generation-changed", "manager-stopped", "manager-disconnected"]) {
    cause = ""; stateReads = viewReads = portalMints = 0;
    await page.goto(parentOrigin);
    await page.getByRole("button", { name: "Alpha", exact: true }).waitFor();
    const entry = page.frames().find(frame => frame.url().startsWith(portalOrigin))!;
    // The actual controller channel is generated by the production host.
    await entry.evaluate(origin => {
      window.parent.postMessage({ source: "dsh-spaces-portal", channel: "ff".repeat(16), type: "failed",
        failure: { reason: "manager-disconnected" } }, origin);
    }, parentOrigin);
    assert.equal(await page.evaluate(() => (window as any).__portableController.getSnapshot().phase), "ready");
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    await page.waitForFunction(() => (window as any).__portableController.getSnapshot().visible === "portal");
    const managerFrame = page.frames().find(frame => frame.url().startsWith(managerOrigin))!;
    await managerFrame.evaluate(() => (window as any).report("disconnected", { token: "private unknown field" }));
    assert.equal(await page.evaluate(() => (window as any).__portableController.getSnapshot().phase), "ready");
    if (reason === "manager-disconnected") await managerFrame.evaluate(() => (window as any).report("disconnected"));
    else cause = reason;
    await page.waitForFunction(expected => (window as any).__portableController.getSnapshot().portalFailure?.reason === expected, reason);
    await page.getByRole("button", { name: "Open space management", exact: true }).click();
    const detail = await page.locator("[data-dsh-spaces-detail]").innerText();
    assert.doesNotMatch(detail, /private|token|http:/);
    assert.equal(await page.locator("[data-spaces-host-surface]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Alpha", exact: true }).count(), 0);
    assert.equal(portalMints, 1); assert.equal(viewReads, 1);
    const reads = stateReads;
    await page.getByRole("button", { name: "Spaces Home", exact: true }).click();
    assert.equal(stateReads, reads); assert.equal(portalMints, 1); assert.equal(viewReads, 1);
  }
});

test("DOM: Windows caption controls follow the spaces rail and main sidebar state", { timeout: 30000 }, async t => {
  const bundle = await build({
    stdin: {
      contents: `
        import { attachHostLayout } from "./packages/plugin/src/client/host-layout";
        import { HOST_SHELL_CSS } from "./packages/plugin/src/client/host-shell";
        import { NATIVE_HOST_CSS } from "./packages/plugin/src/client/ui/native-styles";
        const style = document.createElement("style");
        style.textContent = HOST_SHELL_CSS + NATIVE_HOST_CSS;
        document.head.append(style);
        window.__attachHostLayout = () => {
          const anchor = document.createElement("div");
          anchor.className = "dsh-host-dock";
          anchor.setAttribute("data-spaces-native", "");
          anchor.innerHTML = '<button class="dsh-native-rail-toggle" type="button"></button><nav class="dsh-host-rail"></nav><main class="dsh-host-surface"></main>';
          document.querySelector("[data-shell-overlay]").append(anchor);
          window.__layout = attachHostLayout(anchor);
          return true;
        };
        window.__disposeHostLayout = () => { window.__layout.dispose(); document.querySelector(".dsh-host-dock")?.remove(); };
      `,
      resolveDir: resolve("."),
      loader: "ts",
    },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  const server = await serve((req, res) => {
    if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html data-windows-titlebar style="--dsh-windows-titlebar-height:40px"><style>
      html,body{margin:0;width:100%;height:100%}#frame{height:100%;position:relative}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}
      #sidebar{position:absolute;top:0;bottom:0;left:0;width:280px;box-sizing:border-box;background:#eee}
      #sidebar [data-window-drag]{display:flex;justify-content:flex-end;align-items:center;height:40px;box-sizing:border-box}
      #brand{flex:1}
      [data-windows-titlebar] #toggle{position:fixed;left:12px;top:6px;width:28px;height:28px}
      [data-windows-titlebar] [data-sidebar-collapsed] #newsession{position:fixed;left:48px;top:6px}
      html[data-windows-titlebar]:has([data-sidebar-collapsed=true]){--dsh-windows-menu-start:84px}
    </style><div id="frame"><div id="sidebar"><div id="sidebar-root">
      <div data-window-drag><button id="brand">brand</button><button id="toggle">t</button></div>
      <button id="newsession">new session</button>
    </div></div><div data-shell-overlay></div></div>
    <div data-windows-menu style="position:fixed;top:0;left:var(--dsh-windows-menu-start,48px);width:98px;height:40px"></div>
    <script src="/client.js"></script></html>`);
  });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...process.env.DSH_TEST_CHROMIUM ? { executablePath: process.env.DSH_TEST_CHROMIUM } : {} });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(server.origin);
  await page.evaluate(() => (window as any).__attachHostLayout());
  await page.locator(".dsh-host-rail").waitFor();
  const positions = () => page.evaluate(() => {
    const toggle = document.getElementById("toggle")!;
    const rail = document.querySelector<HTMLElement>(".dsh-host-rail");
    return {
      frame: document.getElementById("frame")!.getBoundingClientRect().x,
      toggle: toggle.getBoundingClientRect().x,
      togglePosition: getComputedStyle(toggle).position,
      newsession: document.getElementById("newsession")!.getBoundingClientRect().x,
      menu: document.querySelector("[data-windows-menu]")!.getBoundingClientRect().x,
      railDisplay: rail ? getComputedStyle(rail).display : "removed",
    };
  });

  // Rail shown, main sidebar expanded: the sidebar toggle joins the brand row,
  // the Windows menu opens right of the rail.
  let now = await positions();
  assert.equal(now.frame, 72);
  assert.equal(now.togglePosition, "static");
  assert.ok(now.toggle > 72 + 200, `sidebar toggle lands inside the sidebar column, got ${now.toggle}`);
  assert.equal(now.menu, 120);

  // Rail shown, main sidebar collapsed: the official caption controls keep
  // working, offset by the rail width.
  await page.evaluate(() => document.getElementById("frame")!.setAttribute("data-sidebar-collapsed", "true"));
  now = await positions();
  assert.equal(now.togglePosition, "fixed");
  assert.equal(now.toggle, 84);
  assert.equal(now.newsession, 120);
  assert.equal(now.menu, 156);

  // Rail hidden, main sidebar collapsed: only the rail toggle occupies the
  // caption, so the official controls shrink to a 36px offset.
  await page.evaluate(() => document.querySelector(".dsh-host-dock")!.setAttribute("data-rail-collapsed", ""));
  now = await positions();
  assert.equal(now.frame, 0);
  assert.equal(now.railDisplay, "none");
  assert.equal(now.toggle, 48);
  assert.equal(now.newsession, 84);
  assert.equal(now.menu, 120);
  await page.evaluate(() => document.getElementById("frame")!.removeAttribute("data-sidebar-collapsed"));
  now = await positions();
  assert.equal(now.menu, 84);

  // A collapsed main sidebar that is covered by a space does not move the menu.
  await page.evaluate(() => document.getElementById("frame")!.setAttribute("data-sidebar-collapsed", "true"));
  await page.evaluate(() => (window as any).__layout.cover(true));
  now = await positions();
  assert.equal(now.menu, 84);
  await page.evaluate(() => (window as any).__layout.cover(false));

  // Dispose restores the frame margin.
  await page.evaluate(() => (window as any).__disposeHostLayout());
  const restored = await page.locator("#frame").evaluate(el => ({
    x: el.getBoundingClientRect().x, marginLeft: (el as HTMLElement).style.marginLeft,
  }));
  assert.equal(restored.x, 0);
  assert.equal(restored.marginLeft, "");

  // Without the Windows title bar the rail keeps the legacy 72px margin and
  // caption controls keep the page's own placement.
  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-windows-titlebar");
    document.getElementById("frame")!.removeAttribute("data-sidebar-collapsed");
    (window as any).__attachHostLayout();
  });
  now = await positions();
  assert.equal(now.frame, 72);
  assert.equal(now.togglePosition, "static");
  assert.equal(now.menu, 48);
  await page.evaluate(() => (window as any).__disposeHostLayout());
});

test("DOM: mountNativeHostOverlay handles slot unmount/remount, same-commit key swap, terminal failure preservation, and reloadSurface -> hot-reload", { timeout: 60000 }, async t => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
        import React, { useEffect, useState } from "react";
        import { createRoot } from "react-dom/client";
        import { mountNativeHostOverlay } from "./packages/plugin/src/client/index.tsx";
        const launch = { operationId: "launch-one", phase: "ready" as const, serviceEpoch: ${JSON.stringify(EPOCH)}, managerId: "hub", reasons: [] as string[], failure: null };
        const guide = {
          role: async () => ({ role: "workspace" as const, profileId: "desktop", managerId: "hub", unavailable: false, reasons: [] as string[] }),
          beginDesktopLaunch: async () => { await fetch("/begin", { method: "POST" }); return launch; },
          desktopLaunchState: async () => launch,
          presentationSnapshot: async () => {
            const response = await fetch("/directory");
            if (!response.ok) throw Error(await response.text());
            return response.json();
          },
          initialize: async () => { throw Error("unused"); },
          bootstrap: async () => { throw Error("unused"); },
          portalTarget: async () => ({ available: false, unavailable: false, origin: null, path: null, reasons: [] }),
          returnTarget: async () => { throw Error("unused"); },
        };
        const bridge = { acquire: async () => { throw Error("unused"); }, release: async () => {} };
        const cleanups: Array<() => void> = [];
        let renderOverlay!: () => React.ReactElement;
        mountNativeHostOverlay({
          effect: (fn: () => (() => void) | void) => { const c = fn(); if (c) cleanups.push(c); },
          slots: {
            inject: (_name: string, cb: () => () => void) => cb(),
            register: (_opts: unknown, render: () => React.ReactElement) => { renderOverlay = render; return () => undefined; },
          },
        } as never, guide, bridge);

        let setControls!: React.Dispatch<React.SetStateAction<{ mounted: boolean; slotKey: number; tick: number }>>;
        function HostApp() {
          const [state, setState] = useState({ mounted: true, slotKey: 1, tick: 0 });
          useEffect(() => { setControls = setState; }, []);
          return state.mounted ? <React.Fragment key={state.slotKey}>{renderOverlay()}</React.Fragment> : null;
        }
        createRoot(document.querySelector("[data-shell-overlay]")!).render(<HostApp />);
        (window as unknown as { __slotTest: Record<string, () => void> }).__slotTest = {
          unmount: () => setControls(s => ({ ...s, mounted: false })),
          remount: () => setControls(s => ({ ...s, mounted: true, slotKey: s.slotKey + 1 })),
          swapKey: () => setControls(s => ({ ...s, slotKey: s.slotKey + 1 })),
          rerender: () => setControls(s => ({ ...s, tick: s.tick + 1 })),
          disposePlugin: () => { while (cleanups.length) cleanups.pop()!(); },
        };
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
  });
  let begins = 0, failDirectory = false;
  const server = await serve(async (req, res) => {
    if (req.url === "/client.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/begin") { begins += 1; json(res, { ok: true }); return; }
    if (req.url === "/directory") {
      if (failDirectory) { res.writeHead(503); res.end("DIRECTORY_DOWN"); return; }
      json(res, { serviceEpoch: EPOCH, managerId: "hub", spaces: [{ id: "hub", displayName: "Spaces", status: "running", generation: 1 }, { id: "coding", displayName: "Coding", status: "stopped", generation: 0 }] });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><style>html,body,#root{height:100%;margin:0}#root{position:relative}main{height:100%}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style><div id="root"><main id="main"><textarea aria-label="Main draft"></textarea></main><div data-shell-overlay></div></div><script src="/client.js"></script>');
  });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN" }); await page.goto(server.origin);
  await page.locator('[data-space-id="coding"]').waitFor();
  assert.equal(begins, 1);

  // Ordinary parent re-render with unchanged slotKey keeps the live controller and DOM node without restarting.
  await page.evaluate(() => {
    document.querySelector("[data-spaces-native]")?.setAttribute("data-keep-instance", "1");
    (window as any).__slotTest.rerender();
    (window as any).__slotTest.rerender();
  });
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  assert.equal(await page.evaluate(() => document.querySelector("[data-spaces-native]")?.getAttribute("data-keep-instance")), "1");
  assert.equal(begins, 1, "ordinary parent re-render must not stop or restart controller");

  // 1) Separate unmount -> remount replaces disposedBeforeTerminal controller.
  await page.evaluate(() => (window as any).__slotTest.unmount());
  await page.waitForFunction(() => document.querySelectorAll("[data-spaces-native]").length === 0);
  await page.evaluate(() => (window as any).__slotTest.remount());
  await page.locator('[data-space-id="coding"]').waitFor();
  assert.equal(begins, 2);

  // 2) Same-commit slot key swap renders replacement before old effect cleanup runs.
  await page.evaluate(() => (window as any).__slotTest.swapKey());
  await page.waitForFunction(() => document.querySelectorAll('[data-space-id="coding"]').length === 1);
  // Wait for replacement controller created in effect recovery to finish its launch cycle.
  const deadline = Date.now() + 5000;
  while (begins < 3 && Date.now() < deadline) await page.waitForTimeout(25);
  await page.locator('[data-space-id="coding"]').waitFor();
  assert.equal(begins, 3);

  // 3) Terminal failure persists across unmount/remount, then manual reloadSurface + subsequent hot-reload works.
  failDirectory = true;
  await page.evaluate(() => (window as any).__slotTest.unmount());
  await page.evaluate(() => (window as any).__slotTest.remount());
  await page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true }).waitFor();
  assert.equal(begins, 4);

  await page.evaluate(() => (window as any).__slotTest.unmount());
  await page.evaluate(() => (window as any).__slotTest.remount());
  await page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true }).waitFor();
  assert.equal(begins, 4, "terminal failure stays on the failed controller across remount");

  failDirectory = false;
  await page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true }).click();
  await page.getByRole("button", { name: "重新加载空间界面", exact: true }).click();
  await page.locator('[data-space-id="coding"]').waitFor();
  assert.equal(begins, 4, "manual surface reload stays read-only");

  // Same-commit slot key swap after manual reloadSurface invokes recreate() and resets readOnlyLaunch.
  await page.evaluate(() => (window as any).__slotTest.swapKey());
  const deadline2 = Date.now() + 5000;
  while (begins < 5 && Date.now() < deadline2) await page.waitForTimeout(25);
  await page.locator('[data-space-id="coding"]').waitFor();
  assert.equal(begins, 5, "recreate() after reloadSurface must clear readOnlyLaunch");

  // Hot-reload after manual reloadSurface stops the reloaded controller and boots a fresh one.
  await page.evaluate(() => (window as any).__slotTest.unmount());
  await page.evaluate(() => (window as any).__slotTest.remount());
  await page.locator('[data-space-id="coding"]').waitFor();
  assert.equal(begins, 6);

  await page.evaluate(() => (window as any).__slotTest.disposePlugin());
});
