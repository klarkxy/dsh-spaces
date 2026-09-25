import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { startWorkbenchHttp, type WorkbenchHttpRuntime } from "../src/adapters/node/workbench-http.ts";
import { expectedAuthCookieName } from "../src/adapters/node/workbench-http.ts";
import { mintSupervisorPortal } from "../packages/plugin/src/host/workbench-http.ts";

const EPOCH = "aa".repeat(32), REVISION = "bb".repeat(32);
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { Promise.resolve(handler(req,res)).catch(() => { res.writeHead(500); res.end("fixture-failure"); }); });
  await new Promise<void>(done => server.listen(0,"127.0.0.1",done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
async function body(req: IncomingMessage) { const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
function json(res: ServerResponse, value: unknown) { res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify(value)); }

test("DOM: in-place rail keeps native DOM/drafts and the authenticated manager origin chain", { timeout: 90000 }, async t => {
  const bundle = await build({ entryPoints:[resolve("tests/fixtures/portable-host/client.tsx")], bundle:true, write:false, format:"iife",platform:"browser",jsx:"automatic" });
  const js=bundle.outputFiles[0].text;
  let supervisorOrigin="", managerOrigin="", childOrigin="";
  const calls: string[]=[];
  const space=(id:string,name:string,isHost=false) => ({ id,displayName:name,isHost,hasWebApp:true,isolation:"verified",icon:"",status:"running",generation:1,managed:true,needsIsolation:false });
  const state={ protocolVersion:2,serviceEpoch:EPOCH,revision:REVISION,role:"manager",managerId:"spaces-hub",availability:"ready",writable:true,maintenance:false,reasons:[],spaces:[space("spaces-hub","Manager",true),space("alpha","Alpha")],jobs:[],cliVersion:"0.1.7-alpha.1" };
  const view=(id:string) => ({serviceEpoch:EPOCH,spaceId:id,generation:1,origin:id==="spaces-hub"?managerOrigin:childOrigin,entryOrigin:supervisorOrigin,entryPath:`/view/${id}/1`,channel:`ch-${id}-1`});
  const hint=(id:string) => ({parentOrigin:id==="spaces-hub"?supervisorOrigin:managerOrigin,spaceId:id,generation:1,channel:`ch-${id}-1`,serviceEpoch:EPOCH});
  const html=(role:string,id?:string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;box-sizing:border-box}#root{position:relative}#native{height:100%;padding:20px;box-sizing:border-box}[data-shell-overlay]{position:absolute;inset:0;pointer-events:none}</style></head><body><div id="root">${role==="parent"?'<main id="native"><h1>Original application</h1><textarea aria-label="Original draft"></textarea></main><div data-shell-overlay></div>':'<div data-dsh-boot>Loading</div>'}</div><script>window.__PORTABLE_FIXTURE__=${JSON.stringify({role})};${id?'window.__DSH_SPACES_VIEW__='+JSON.stringify(hint(id))+';':''}</script><script src="/client.js"></script></body></html>`;
  const client = async(role:string,id:string,req:IncomingMessage,res:ServerResponse) => {
    if(req.url==="/client.js"){res.writeHead(200,{"content-type":"text/javascript"});res.end(js);return;}
    if(req.url?.startsWith("/fixture-api/")){
      const method=req.url.slice("/fixture-api/".length),payload=await body(req);calls.push("manager:"+method);
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
  await page.getByRole("button",{name:"Alpha",exact:true}).click();
  const surface=page.frameLocator("iframe[data-spaces-host-surface]");
  const management=surface.frameLocator("iframe");
  const workspace=management.frameLocator('iframe[data-space-id="alpha"]');
  await workspace.getByRole("textbox",{name:"Space draft"}).fill("space draft is retained");
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
  await management.locator(".dsh-wb-home-surface").waitFor({state:"visible"});
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
