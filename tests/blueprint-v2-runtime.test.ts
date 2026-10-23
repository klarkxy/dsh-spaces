import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { BlueprintRuntimeError, inspectBlueprintRuntime } from "../src/adapters/node/blueprint/blueprint-runtime.ts";

const dirs: string[] = [];
const BUILTIN = "fixture-optional-bundle";
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bpv2-runtime-")); dirs.push(dir); return dir;
}
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function bundle(root: string, name: string, version: string, patch: string | string[] = "patch.json"): string {
  const dir = join(root, "node_modules", ...name.split("/"));
  write(join(dir, "package.json"), { name, version, dsh: { bundle: { patch } } });
  for (const [index, file] of (Array.isArray(patch) ? patch : [patch]).entries()) {
    write(join(dir, file), [{ insert: [{ id: `${name}-${index}`, name }] }]);
  }
  return dir;
}
function runtime(): { home: string; bin: string; installation: string; builtin: string } {
  const home = temp(); const installation = temp(); const bin = join(installation, "lib", "bin.js");
  write(bin, "export {};\n");
  write(join(installation, "package.json"), { name: "@deepseek-ai/dsh", version: "0.2.0-rc.2", type: "module" });
  const boot = join(installation, "node_modules", "@deepseek-ai", "dsh-app-boot");
  write(join(boot, "package.json"), { name: "@deepseek-ai/dsh-app-boot", version: "0.2.0-rc.2", type: "module", main: "lib/index.js" });
  write(join(boot, "lib", "index.js"), `
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
export const PROFILE_TEMPLATES = { web: { bundles: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'] } };
export const OPTIONAL_BUNDLES = ['${BUILTIN}', 'fixture-missing-bundle'];
export const PROFILES_DIR = 'profiles';
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';
export function loadProfileDirectory() { throw new Error('must not initialize'); }
export function mountRootInclude() { throw new Error('must not launch'); }
export function resolveBundleDir(binName,name,anchor,profile) {
 for (const file of [anchor,join(profile,'package.json')]) {
  for (const dir of createRequire(file).resolve.paths(name) ?? []) {
   if (existsSync(join(dir,name,'package.json'))) return join(dir,name);
  }
 }
 throw new Error('unresolved');
}
export function loadOverlayPatches(binName,file) { return JSON.parse(readFileSync(file,'utf8')); }
export function loadOptionalPatches(binName,file) { return existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : undefined; }
export function composeEntries(layers) { return layers.flatMap(layer => layer.flatMap(p => p.insert ?? [])); }
`);
  const exportsDir = join(installation, "node_modules", "resolve.exports");
  write(join(exportsDir, "package.json"), { name: "resolve.exports", type: "module", main: "index.js" });
  write(join(exportsDir, "index.js"), "export function resolve() { return []; }\n");
  bundle(installation, "@deepseek-ai/dsh-base", "0.2.0-rc.2");
  bundle(installation, "@deepseek-ai/dsh-web-app", "0.2.0-rc.2");
  const builtin = bundle(installation, BUILTIN, "2.3.4", ["first.json", "second.json"]);
  return { home, bin, installation, builtin };
}

test("optional builtins resolve only from the bound installation and ordered patch files enter the fingerprint", async () => {
  const fixture = runtime();
  const first = await inspectBlueprintRuntime({ ...fixture, builtinPackages: [BUILTIN] });
  assert.deepEqual(first.builtinLayers?.map(p => [p.name, p.version]), [[BUILTIN, "2.3.4"]]);
  assert.deepEqual(first.builtinLayers?.[0]?.patches, [
    { insert: [{ id: `${BUILTIN}-0`, name: BUILTIN }] }, { insert: [{ id: `${BUILTIN}-1`, name: BUILTIN }] },
  ]);
  assert.equal(first.baseLayers.length, 2);
  assert.equal(first.baseEntries.some((p: any) => p.name === BUILTIN), false);
  write(join(fixture.builtin, "second.json"), [{ insert: [{ id: "changed", name: BUILTIN }] }]);
  const second = await inspectBlueprintRuntime({ ...fixture, builtinPackages: [BUILTIN] });
  assert.notEqual(first.fingerprint, second.fingerprint);
  const manifest = JSON.parse(readFileSync(join(fixture.builtin, "package.json"), "utf8"));
  manifest.version = "2.3.5"; write(join(fixture.builtin, "package.json"), manifest);
  assert.notEqual(second.fingerprint, (await inspectBlueprintRuntime(fixture)).fingerprint);
  assert.equal(existsSync(join(fixture.home, "profiles")), false);
  assert.equal(existsSync(join(fixture.home, "sessions")), false);
  assert.equal(existsSync(join(fixture.home, "storages")), false);
});

test("unavailable requested builtin cannot be satisfied by a Home-local shadow or an npm package", async () => {
  const fixture = runtime();
  bundle(fixture.home, "fixture-missing-bundle", "1.0.0");
  await assert.rejects(inspectBlueprintRuntime({ ...fixture, builtinPackages: ["fixture-missing-bundle"] }),
    (error: unknown) => error instanceof BlueprintRuntimeError && error.code === "bundle-unresolved");
  bundle(fixture.installation, "npm-only", "1.0.0");
  await assert.rejects(inspectBlueprintRuntime({ ...fixture, builtinPackages: ["npm-only"] }),
    (error: unknown) => error instanceof BlueprintRuntimeError && error.code === "builtin-unsupported");
  await assert.rejects(inspectBlueprintRuntime({ ...fixture, builtinPackages: ["@deepseek-ai/dsh-base"] }),
    (error: unknown) => error instanceof BlueprintRuntimeError && error.code === "builtin-unsupported");
});

test("builtin manifest identity and every patch path are validated without profile writes", async () => {
  const fixture = runtime();
  const file = join(fixture.builtin, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  write(file, { ...manifest, name: "foreign-package" });
  await assert.rejects(inspectBlueprintRuntime({ ...fixture, builtinPackages: [BUILTIN] }),
    (error: unknown) => error instanceof BlueprintRuntimeError && error.code === "manifest-invalid");
  write(file, { ...manifest, dsh: { bundle: { patch: ["first.json", "../outside.json"] } } });
  await assert.rejects(inspectBlueprintRuntime({ ...fixture, builtinPackages: [BUILTIN] }),
    (error: unknown) => error instanceof BlueprintRuntimeError && error.code === "bundle-patch-escape");
  assert.equal(existsSync(join(fixture.home, "profiles")), false);
});

test("bound official DSH inspection exposes available OPTIONAL_BUNDLES read-only", async (t) => {
  const bin = process.env.DSH_BLUEPRINT_TEST_BIN ?? process.env.DSH_TEST_CLI_BIN ?? join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(bin)) { t.skip("official bound DSH installation unavailable"); return; }
  const version = JSON.parse(readFileSync(join(bin, "..", "..", "package.json"), "utf8")).version;
  const home = temp();
  const inspected = await inspectBlueprintRuntime({ home, bin });
  assert.equal(inspected.versions.dsh, version);
  assert.ok(inspected.builtinLayers?.some(layer => layer.name === "@deepseek-ai/dsh-experimental-agent-team-profile"));
  for (const layer of inspected.builtinLayers ?? []) assert.equal(layer.version, version);
  assert.equal(existsSync(join(home, "profiles")), false);
  assert.equal(existsSync(join(home, "sessions")), false);
  assert.equal(existsSync(join(home, "storages")), false);
});
