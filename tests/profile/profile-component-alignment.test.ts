import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { alignProfileComponents, RETIRED_LLM_BRIDGE } from "../../src/adapters/node/profile/profile-component-alignment.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));
function fixture(drifted = true, retired = false) {
  const home = mkdtempSync(join(tmpdir(), "dsh-align-")); roots.push(home);
  const profile = join(home, "profiles", "writing");
  const payloadRoot = join(home, "selected");
  const bundles = ["@dsh-spaces/view-bridge", ...(retired ? [RETIRED_LLM_BRIDGE] : [])];
  mkdirSync(profile, { recursive: true });
  const manifestPath = join(profile, "package.json");
  writeFileSync(manifestPath, JSON.stringify({ dsh: {profile: {bundles}}, dependencies: {"@dsh-spaces/view-bridge":"old", ...(retired ? {[RETIRED_LLM_BRIDGE]:"old"} : {})} }));
  const patch = join(profile, "cordis.patch.yml");
  writeFileSync(patch, "# retained\n[]\n");
  const installed = (component: string) => join(profile, "node_modules", "@dsh-spaces", component);
  const target = join(payloadRoot, "view-bridge"); mkdirSync(join(target,"lib"), { recursive: true });
  const peer = "@deepseek-ai/dsh-client-connection";
  const pkg = {name:"@dsh-spaces/view-bridge",version:"0.4.0",dsh:{bundle:{patch:"./cordis.patch.yml"}},peerDependencies:{[peer]:">=0.2.0-rc.2"}};
  writeFileSync(join(target,"package.json"), JSON.stringify(pkg));
  for (const path of ["lib/index.js", "lib/client.js", "lib/settings.js"]) writeFileSync(join(target,path), "target");
  writeFileSync(join(target,"cordis.patch.yml"),"- insert:\n    - id: dsh-spaces-view-bridge\n      name: '@dsh-spaces/view-bridge'\n- id: settings\n  disabled: true\n- insert:\n    - id: dsh-spaces-settings\n      name: '@dsh-spaces/view-bridge/settings'\n");
  cpSync(target, installed("view-bridge"), {recursive:true});
  if (drifted) writeFileSync(join(installed("view-bridge"),"package.json"),JSON.stringify({...pkg,peerDependencies:{[peer]:"^0.1.5-rc.2"}}));
  if (retired) {
    mkdirSync(join(installed("llm-bridge"), "lib"), { recursive: true });
    writeFileSync(join(installed("llm-bridge"), "package.json"), JSON.stringify({name:RETIRED_LLM_BRIDGE,version:"0.3.0",dsh:{bundle:{patch:"./cordis.patch.yml"}}}));
    writeFileSync(join(installed("llm-bridge"), "cordis.patch.yml"), "- insert:\n    - id: dsh-spaces-llm-bridge\n      name: '@dsh-spaces/llm-bridge'\n");
  }
  const calls: string[] = [];
  const removes: string[] = [];
  const input = {home, profileId:"writing",payloadRoot,
    install: async(component: "view-bridge"|"browser") => {calls.push(component); cpSync(join(payloadRoot,component),installed(component),{recursive:true});},
    remove: async(name: string) => {
      removes.push(name);
      const current = JSON.parse(readFileSync(manifestPath, "utf8"));
      current.dsh.profile.bundles = current.dsh.profile.bundles.filter((row: string) => row !== name);
      delete current.dependencies[name];
      writeFileSync(manifestPath, JSON.stringify(current));
      rmSync(installed("llm-bridge"), { recursive: true, force: true });
    },
    dump: async()=>"- id: agent-default-model\n  config: {}\n- id: settings\n  disabled: true\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n"};
  const bundlesNow = (): string[] => JSON.parse(readFileSync(manifestPath, "utf8")).dsh.profile.bundles;
  return {input,home,profile,patch,calls,removes,installed,bundlesNow, marker:join(profile,".dsh-spaces-component-alignment.json")};
}
test("a drifted view bridge aligns with byte verification", async()=>{
  const f=fixture();
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls,["view-bridge"]);
  assert.match(readFileSync(f.patch,"utf8"),/retained/);
  assert.equal(existsSync(f.marker),false);
  await alignProfileComponents(f.input);
  assert.equal(f.calls.length,1);
  assert.deepEqual(f.removes,[]);
});
test("an older space drops the retired LLM bridge once through the official remove", async()=>{
  const f=fixture(true,true);
  await alignProfileComponents(f.input);
  assert.deepEqual(f.removes,[RETIRED_LLM_BRIDGE]);
  assert.deepEqual(f.bundlesNow(),["@dsh-spaces/view-bridge"]);
  assert.equal(existsSync(f.installed("llm-bridge")),false);
  assert.deepEqual(f.calls,["view-bridge"]);
  assert.equal(existsSync(f.marker),false);
  await alignProfileComponents(f.input);
  assert.deepEqual(f.removes,[RETIRED_LLM_BRIDGE]);
});
test("a retired LLM bridge without a removal port rejects before writes", async()=>{
  const f=fixture(false,true);
  await assert.rejects(alignProfileComponents({...f.input,remove:undefined}),/retired LLM bridge/);
  assert.equal(existsSync(f.marker),false);
  assert.deepEqual(f.bundlesNow(),["@dsh-spaces/view-bridge",RETIRED_LLM_BRIDGE]);
  assert.equal(f.calls.length,0);
});
test("a failed retired-bridge removal keeps its marker and is never replayed", async()=>{
  const f=fixture(false,true); let removes=0;
  f.input.remove=async()=>{removes++;throw new Error("remove failed");};
  await assert.rejects(alignProfileComponents(f.input),/remove failed/);
  assert.ok(existsSync(f.marker));
  assert.match(readFileSync(f.marker,"utf8"),/llm-bridge/);
  await assert.rejects(alignProfileComponents(f.input),/Interrupted component alignment/);
  assert.equal(removes,1);
  assert.equal(f.calls.length,0);
});
test("a removal that leaves the bundle in place reports the membership and keeps evidence", async()=>{
  const f=fixture(false,true);
  f.input.remove=async()=>{};
  await assert.rejects(alignProfileComponents(f.input),/unexpected bundle membership/);
  assert.ok(existsSync(f.marker));
  assert.equal(f.calls.length,0);
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
  await alignProfileComponents({ ...f.input, matches: () => true });
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.marker), false);
});
test("current bytes that omit a file the payload does not ship are left in place", async () => {
  const f = fixture(false);
  rmSync(join(f.input.payloadRoot, "view-bridge", "lib", "settings.js"), { force: true });
  rmSync(join(f.installed("view-bridge"), "lib", "settings.js"), { force: true });
  await alignProfileComponents(f.input);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.marker), false);
});
