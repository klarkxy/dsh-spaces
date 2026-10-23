import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { startWorkbenchHttp, type WorkbenchHttpRuntime } from "../../src/adapters/node/server/workbench-http.ts";
import { expectedAuthCookieName } from "../../src/adapters/node/server/workbench-http.ts";
import { mintSupervisorPortal } from "../../packages/plugin/src/host/workbench-http.ts";
import { renderPortalPage } from "../../src/adapters/node/server/workbench-portal.ts";

const EPOCH = "aa".repeat(32), REVISION = "bb".repeat(32);
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { Promise.resolve(handler(req,res)).catch(() => { res.writeHead(500); res.end("fixture-failure"); }); });
  await new Promise<void>(done => server.listen(0,"127.0.0.1",done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
async function body(req: IncomingMessage) { const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
function json(res: ServerResponse, value: unknown) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify(value)); }

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
  const page = await browser.newPage(); await page.goto(server.origin);
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
  assert.equal(await page.locator(".dsh-host-detail").innerText(), "MAIN_REGISTRATION_REFUSED:404");
  await page.getByRole("button", { name: "当前应用", exact: true }).click();
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
  const page = await browser.newPage(); await page.goto(server.origin);
  await page.getByRole("textbox", { name: "Main draft" }).fill("keep this unsent main draft");
  const main = await page.locator("#main").elementHandle();
  await page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true }).click();
  const previewButton = page.getByRole("button", { name: "手动启动 / 重启 Spaces 服务…", exact: true });
  await previewButton.click();
  await page.getByRole("heading", { name: "确认重启 Spaces 服务" }).waitFor();
  assert.match(await page.getByRole("region", { name: "确认服务操作" }).innerText(), /Coding（coding）.*将停止/);
  assert.equal(restarts, 0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(restarts, 0); assert.equal(reads, 1);
  await previewButton.click();
  await page.getByRole("button", { name: "确认停止并重启服务", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "正在正常停止" }).waitFor();
  // The accepted operation still completes when the user returns to main.
  await page.getByRole("button", { name: "当前应用", exact: true }).click();
  await page.getByRole("textbox", { name: "Main draft" }).waitFor();
  assert.equal(restarts, 1); complete();
  if (outcome === "success") await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  else {
    await page.getByRole("button", { name: "设置 · 空间服务不可用（查看详情）", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Shutdown failed" }).waitFor();
    assert.match(await page.locator(".dsh-host-detail").first().innerText(), /MAIN_REGISTRATION_REFUSED:404/);
    await page.getByRole("button", { name: "当前应用", exact: true }).click();
  }
  assert.equal(await page.getByRole("textbox", { name: "Main draft" }).inputValue(), "keep this unsent main draft");
  assert.equal(await page.locator("#main").evaluate((el, original) => el === original, main), true);
  await page.waitForTimeout(1700);
  assert.equal(previews, 2); assert.equal(restarts, 1);
  if (outcome === "failed") assert.equal(reads, 1, "a failed manual operation does not reconnect");
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
  assert.equal(await page.locator("#root").evaluate(el=>(el as HTMLElement).style.paddingLeft),"");
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
