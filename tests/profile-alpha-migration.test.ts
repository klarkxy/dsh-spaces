import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { migrateProfileToAlpha } from "../src/adapters/node/profile-alpha-migration.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, {recursive: true, force: true})));
function fixture(legacy = true, llmActive = true) {
  const home = mkdtempSync(join(tmpdir(), "dsh-alpha-migrate-")); roots.push(home);
  const profile = join(home, "profiles", "writing");
  const payloadRoot = join(home, "selected");
  const bundles = ["@dsh-spaces/view-bridge", ...(llmActive ? ["@dsh-spaces/llm-bridge"] : [])];
  mkdirSync(profile, { recursive: true }); mkdirSync(join(home, "hub", "writing"), {recursive: true});
  writeFileSync(join(profile, "package.json"), JSON.stringify({ dsh: {profile: {bundles}}, dependencies: {"@dsh-spaces/llm-bridge":"old"} }));
  const patch = join(profile, "cordis.patch.yml");
  writeFileSync(patch, legacy ? "# retained\n- id: settings\n  config:\n    path: !!js dshHomePath('hub/writing/settings.yaml')\n" : "[]\n");
  const installed = (bridge: string) => join(profile, "node_modules", "@dsh-spaces", bridge);
  for (const bridge of ["view-bridge", "llm-bridge"]) {
    const target = join(payloadRoot, bridge); mkdirSync(join(target,"lib"), { recursive: true });
    const peer = bridge === "view-bridge" ? "@deepseek-ai/dsh-client-connection" : "@deepseek-ai/dsh-settings";
    writeFileSync(join(target,"package.json"), JSON.stringify({name:`@dsh-spaces/${bridge}`,peerDependencies:{[peer]:"^0.1.7-alpha.1"}}));
    for (const path of ["cordis.patch.yml", "lib/index.js", "lib/client.js", "lib/settings.js"]) writeFileSync(join(target,path), "alpha");
    cpSync(target, installed(bridge), {recursive:true});
    if (legacy) writeFileSync(join(installed(bridge),"package.json"),JSON.stringify({name:`@dsh-spaces/${bridge}`,peerDependencies:{[peer]:"^0.1.5-rc.2"}}));
  }
  const calls: string[] = [];
  const input = {home, profileId:"writing",payloadRoot,
    install: async(bridge: "view-bridge"|"llm-bridge") => {calls.push(bridge); cpSync(join(payloadRoot,bridge),installed(bridge),{recursive:true});},
    dump: async()=>"- id: agent-default-model\n  config: {}\n- id: dsh-spaces-llm-bridge\n- id: settings\n  disabled: true\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n"};
  return {input,home,profile,patch,calls,installed, marker:join(profile,".dsh-spaces-alpha-migration.json")};
}
test("legacy active bridges and settings migrate together with byte verification", async()=>{
  const f=fixture();
  writeFileSync(join(f.home,"hub/writing/settings.yaml"),"agent-default-model:\n  provider: local\n  model: demo\n");
  await migrateProfileToAlpha(f.input);
  assert.deepEqual(f.calls,["view-bridge","llm-bridge"]);
  assert.match(readFileSync(f.patch,"utf8"),/retained/);
  assert.doesNotMatch(readFileSync(f.patch,"utf8"),/settings.yaml/);
  assert.match(readFileSync(f.patch,"utf8"),/provider: local/);
  assert.ok(existsSync(join(f.home,"hub/writing/settings.yaml.migrated")));
  assert.equal(existsSync(f.marker),false);
  await migrateProfileToAlpha(f.input);
  assert.equal(f.calls.length,2);
});
test("dependency-only disabled LLM bridge is not activated or replaced",async()=>{
  const f=fixture(true,false); await migrateProfileToAlpha(f.input);
  assert.deepEqual(f.calls,["view-bridge"]);
  assert.match(readFileSync(join(f.installed("llm-bridge"),"package.json"),"utf8"),/0.1.5-rc.2/);
});
test("patch-disabled legacy LLM bundle keeps its local-provider behavior",async()=>{
  const f=fixture(); const dump=f.input.dump;
  f.input.dump=async()=> (await dump()).replace("- id: dsh-spaces-llm-bridge\n", "- id: dsh-spaces-llm-bridge\n  disabled: true\n");
  await migrateProfileToAlpha(f.input);
  assert.deepEqual(f.calls,["view-bridge"]);
  assert.match(readFileSync(join(f.installed("llm-bridge"),"package.json"),"utf8"),/0.1.5-rc.2/);
});
test("unscoped native settings cannot start even with current bridge bytes",async()=>{
  const f=fixture(false); const dump=f.input.dump;
  f.input.dump=async()=> (await dump()).replace("- id: settings\n  disabled: true", "- id: settings\n  disabled: false");
  await assert.rejects(migrateProfileToAlpha(f.input),/scoped alpha settings/);
  assert.equal(f.calls.length,0);
});
test("failed installation retains marker and cannot be replayed on launch",async()=>{
  const f=fixture(); let calls=0;
  f.input.install=async()=>{calls++;throw new Error("installation failed");};
  await assert.rejects(migrateProfileToAlpha(f.input),/installation failed/);
  assert.ok(existsSync(f.marker));
  await assert.rejects(migrateProfileToAlpha(f.input),/Interrupted alpha/);
  assert.equal(calls,1);
});
test("same SDK version with mismatched component bytes is rejected without repair",async()=>{
  const f=fixture(false);writeFileSync(join(f.installed("view-bridge"),"lib/index.js"),"changed");
  await assert.rejects(migrateProfileToAlpha(f.input),/does not match/);
  assert.equal(f.calls.length,0);assert.equal(existsSync(f.marker),false);
});
test("installation readback must match selected bytes before legacy settings retire",async()=>{
  const f=fixture(); f.input.install=async()=>{};
  await assert.rejects(migrateProfileToAlpha(f.input),/did not match/);
  assert.ok(existsSync(f.marker));assert.match(readFileSync(f.patch,"utf8"),/settings.yaml/);
});
test("default web rejects before any profile or migration writes",async()=>{
  const f=fixture();
  await assert.rejects(migrateProfileToAlpha({...f.input,profileId:"web"}),/protected/);
  assert.equal(existsSync(join(f.home,"profiles/web")),false);
});
test("removing legacy settings path preserves unrelated data and credential roots",async()=>{
  const f=fixture();
  const extra="- id: storage-json\n  config:\n    root: custom-storage\n- id: credentials\n  config:\n    path: custom-credentials\n";
  writeFileSync(f.patch,readFileSync(f.patch,"utf8")+extra);
  await migrateProfileToAlpha(f.input);
  const result=readFileSync(f.patch,"utf8");
  assert.match(result,/root: custom-storage/);assert.match(result,/path: custom-credentials/);
});
test("junction data roots are rejected without touching foreign settings",async()=>{
  const f=fixture(); const foreign=mkdtempSync(join(tmpdir(),"dsh-alpha-foreign-")); roots.push(foreign);
  writeFileSync(join(foreign,"settings.yaml"),"private: fixture\n");
  rmSync(join(f.home,"hub/writing"),{recursive:true});symlinkSync(foreign,join(f.home,"hub/writing"),"junction");
  await assert.rejects(migrateProfileToAlpha(f.input),/ownership path/);
  assert.equal(readFileSync(join(foreign,"settings.yaml"),"utf8"),"private: fixture\n");
  assert.equal(existsSync(f.marker),false);assert.equal(f.calls.length,0);
});
test("current alpha bytes that omit a file the payload does not ship are left in place", async () => {
  const f = fixture(false);
  for (const bridge of ["view-bridge", "llm-bridge"]) {
    rmSync(join(f.input.payloadRoot, bridge, "lib", "settings.js"), { force: true });
    rmSync(join(f.installed(bridge), "lib", "settings.js"), { force: true });
  }
  await migrateProfileToAlpha(f.input);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.marker), false);
});
