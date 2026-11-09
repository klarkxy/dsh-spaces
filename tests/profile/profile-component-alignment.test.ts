import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { alignProfileComponents } from "../../src/adapters/node/profile/profile-component-alignment.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));
function fixture(drifted = true, llmActive = true) {
  const home = mkdtempSync(join(tmpdir(), "dsh-align-")); roots.push(home);
  const profile = join(home, "profiles", "writing");
  const payloadRoot = join(home, "selected");
  const bundles = ["@dsh-spaces/view-bridge", ...(llmActive ? ["@dsh-spaces/llm-bridge"] : [])];
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({ dsh: {profile: {bundles}}, dependencies: {"@dsh-spaces/llm-bridge":"old"} }));
  const patch = join(profile, "cordis.patch.yml");
  writeFileSync(patch, "# retained\n[]\n");
  const installed = (bridge: string) => join(profile, "node_modules", "@dsh-spaces", bridge);
  for (const bridge of ["view-bridge", "llm-bridge"]) {
    const target = join(payloadRoot, bridge); mkdirSync(join(target,"lib"), { recursive: true });
    const peer = bridge === "view-bridge" ? "@deepseek-ai/dsh-client-connection" : "@deepseek-ai/dsh-settings";
    const pkg = {name:`@dsh-spaces/${bridge}`,version:"0.4.0",dsh:{bundle:{patch:"./cordis.patch.yml"}},peerDependencies:{[peer]:">=0.2.0-rc.2"}};
    writeFileSync(join(target,"package.json"), JSON.stringify(pkg));
    for (const path of ["lib/index.js", "lib/client.js", "lib/settings.js"]) writeFileSync(join(target,path), "target");
    writeFileSync(join(target,"cordis.patch.yml"),`- insert:\n    - id: dsh-spaces-${bridge}\n      name: '@dsh-spaces/${bridge}'\n` + (bridge === "view-bridge" ? "- id: settings\n  disabled: true\n- insert:\n    - id: dsh-spaces-settings\n      name: '@dsh-spaces/view-bridge/settings'\n" : ""));
    cpSync(target, installed(bridge), {recursive:true});
    if (drifted) writeFileSync(join(installed(bridge),"package.json"),JSON.stringify({...pkg,peerDependencies:{[peer]:"^0.1.5-rc.2"}}));
  }
  const calls: string[] = [];
  const input = {home, profileId:"writing",payloadRoot,
    install: async(component: "view-bridge"|"llm-bridge"|"browser") => {calls.push(component); cpSync(join(payloadRoot,component),installed(component),{recursive:true});},
    dump: async()=>"- id: agent-default-model\n  config: {}\n- id: dsh-spaces-llm-bridge\n- id: settings\n  disabled: true\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n"};
  return {input,home,profile,patch,calls,installed, marker:join(profile,".dsh-spaces-component-alignment.json")};
}
test("drifted active bridges align together with byte verification", async()=>{
  const f=fixture();
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls,["view-bridge","llm-bridge"]);
  assert.match(readFileSync(f.patch,"utf8"),/retained/);
  assert.equal(existsSync(f.marker),false);
  await alignProfileComponents(f.input);
  assert.equal(f.calls.length,2);
});
test("dependency-only disabled LLM bridge is not activated or replaced",async()=>{
  const f=fixture(true,false); await alignProfileComponents(f.input);
  assert.deepEqual(f.calls,["view-bridge"]);
  assert.match(readFileSync(join(f.installed("llm-bridge"),"package.json"),"utf8"),/0.1.5-rc.2/);
});
test("patch-disabled LLM bundle keeps its installed package",async()=>{
  const f=fixture(); const dump=f.input.dump;
  writeFileSync(f.patch, "- id: dsh-spaces-llm-bridge\n  disabled: true\n");
  f.input.dump=async()=> (await dump()).replace("- id: dsh-spaces-llm-bridge\n", "- id: dsh-spaces-llm-bridge\n  disabled: true\n");
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls,["view-bridge"]);
  assert.match(readFileSync(join(f.installed("llm-bridge"),"package.json"),"utf8"),/0.1.5-rc.2/);
});
test("unscoped native settings cannot start even with current bridge bytes",async()=>{
  const f=fixture(false); const dump=f.input.dump;
  f.input.dump=async()=> (await dump()).replace("- id: settings\n  disabled: true", "- id: settings\n  disabled: false");
  await assert.rejects(alignProfileComponents(f.input),/scoped settings/);
  assert.equal(f.calls.length,0);
});
test("failed installation retains marker and cannot be replayed on launch",async()=>{
  const f=fixture(); let calls=0;
  f.input.install=async()=>{calls++;throw new Error("installation failed");};
  await assert.rejects(alignProfileComponents(f.input),/installation failed/);
  assert.ok(existsSync(f.marker));
  await assert.rejects(alignProfileComponents(f.input),/Interrupted component alignment/);
  assert.equal(calls,1);
});
test("same SDK version with drifted view-bridge bytes is reinstalled from the selected payload",async()=>{
  const f=fixture(false);writeFileSync(join(f.installed("view-bridge"),"lib/index.js"),"changed");
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls,["view-bridge"]);
  assert.equal(readFileSync(join(f.installed("view-bridge"),"lib/index.js"),"utf8"),"target");
  assert.equal(existsSync(f.marker),false);
});
test("same SDK version with drifted LLM bridge bytes is reinstalled from the selected payload",async()=>{
  const f=fixture(false);writeFileSync(join(f.installed("llm-bridge"),"lib/index.js"),"changed");
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls,["llm-bridge"]);
  assert.equal(readFileSync(join(f.installed("llm-bridge"),"lib/index.js"),"utf8"),"target");
  assert.equal(existsSync(f.marker),false);
});
test("an installed browser whose bytes drift is reinstalled from the selected payload",async()=>{
  const f=fixture(false);
  const target=join(f.input.payloadRoot,"browser");mkdirSync(join(target,"lib"),{recursive:true});
  writeFileSync(join(target,"package.json"),JSON.stringify({name:"@dsh-spaces/browser",version:"0.4.0"}));
  writeFileSync(join(target,"lib/index.js"),"target");writeFileSync(join(target,"cordis.patch.yml"),"browser: dummy\n");
  cpSync(target,f.installed("browser"),{recursive:true});
  writeFileSync(join(f.installed("browser"),"lib/index.js"),"changed");
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls,["browser"]);
  assert.equal(readFileSync(join(f.installed("browser"),"lib/index.js"),"utf8"),"target");
  assert.equal(existsSync(f.marker),false);
});
test("a foreign package at the browser path is still rejected instead of replaced",async()=>{
  const f=fixture(false);
  const target=join(f.input.payloadRoot,"browser");mkdirSync(join(target,"lib"),{recursive:true});
  writeFileSync(join(target,"package.json"),JSON.stringify({name:"@dsh-spaces/browser",version:"0.4.0"}));
  writeFileSync(join(target,"lib/index.js"),"target");writeFileSync(join(target,"cordis.patch.yml"),"browser: dummy\n");
  const dir=f.installed("browser");cpSync(target,dir,{recursive:true});
  writeFileSync(join(dir,"package.json"),JSON.stringify({name:"squatter",version:"0.4.0"}));
  writeFileSync(join(dir,"lib/index.js"),"changed");
  await assert.rejects(alignProfileComponents(f.input),/does not match/);
  assert.equal(f.calls.length,0);assert.equal(existsSync(f.marker),false);
});
test("installation readback must match selected bytes",async()=>{
  const f=fixture(); f.input.install=async()=>{};
  await assert.rejects(alignProfileComponents(f.input),/did not match/);
  assert.ok(existsSync(f.marker));assert.match(readFileSync(f.patch,"utf8"),/retained/);
});
test("default web rejects before any profile writes",async()=>{
  const f=fixture();
  await assert.rejects(alignProfileComponents({...f.input,profileId:"web"}),/protected/);
  assert.equal(existsSync(join(f.home,"profiles/web")),false);
});
test("junction profile roots are rejected without touching foreign data",async()=>{
  const f=fixture(); const foreign=mkdtempSync(join(tmpdir(),"dsh-align-foreign-")); roots.push(foreign);
  writeFileSync(join(foreign,"settings.yaml"),"private: fixture\n");
  rmSync(f.profile,{recursive:true});symlinkSync(foreign,f.profile,"junction");
  await assert.rejects(alignProfileComponents(f.input),/ownership path/);
  assert.equal(readFileSync(join(foreign,"settings.yaml"),"utf8"),"private: fixture\n");
  assert.equal(existsSync(f.marker),false);assert.equal(f.calls.length,0);
});
test("a matches override accepts a linked component without an install or a marker", async () => {
  const f = fixture(false);
  writeFileSync(join(f.installed("view-bridge"), "lib/index.js"), "changed");
  writeFileSync(join(f.installed("llm-bridge"), "lib/index.js"), "changed");
  await alignProfileComponents({ ...f.input, matches: () => true });
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.marker), false);
});
test("current bytes that omit a file the payload does not ship are left in place", async () => {
  const f = fixture(false);
  for (const bridge of ["view-bridge", "llm-bridge"]) {
    rmSync(join(f.input.payloadRoot, bridge, "lib", "settings.js"), { force: true });
    rmSync(join(f.installed(bridge), "lib", "settings.js"), { force: true });
  }
  await alignProfileComponents(f.input);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.marker), false);
});
