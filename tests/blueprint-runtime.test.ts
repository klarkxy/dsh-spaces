import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BlueprintRuntimeError,
  composeBlueprintRuntime,
  inspectBlueprintRuntime,
  resolveBlueprintModule,
} from "../src/adapters/node/blueprint-runtime.ts";

const temps: string[] = [];
const realHome = join(homedir(), ".dsh");
const here = fileURLToPath(import.meta.url);
const sourcePath = join(dirname(here), "../src/adapters/node/blueprint-runtime.ts");
const jsYamlPath = createRequire(here).resolve("js-yaml");
const officialBin = officialRc2Bin();

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("product source is read-only official runtime, not a patch engine or version allowlist", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /\bloadProfile\s*\(/);
  assert.doesNotMatch(source, /\binitProfile\s*\(/);
  assert.doesNotMatch(source, /\bhealProfilesModuleFallback\s*\(/);
  assert.doesNotMatch(source, /\bboot\s*\(/);
  assert.doesNotMatch(source, /\bwriteProfileManifest\s*\(/);
  assert.doesNotMatch(source, /\bcomposeProfile\s*\(/);
  assert.doesNotMatch(source, /AppData/);
  assert.doesNotMatch(source, /Roaming/);
  assert.doesNotMatch(source, /0\.1\.5-rc\.2/);
  assert.doesNotMatch(source, /hub\/plugins/);
  assert.match(source, /createRequire/);
  assert.match(source, /pathToFileURL/);
  assert.match(source, /mountRootInclude/);
  assert.match(source, /caller still/);
});

test("fixture: inspect reports actual base/web versions without inferring dsh and without profiles/web", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  const inspected = await inspectBlueprintRuntime({ home, bin: runtime.bin });
  assert.equal(inspected.versions.dsh, "9.9.9-fixture");
  assert.equal(inspected.versions.base, "1.2.3-base");
  assert.equal(inspected.versions.webApp, "2.3.4-web");
  assert.notEqual(inspected.versions.base, inspected.versions.dsh);
  assert.equal(inspected.baseLayers.length, 2);
  assert.equal(inspected.baseLayers[0]?.name, "@deepseek-ai/dsh-base");
  assert.equal(inspected.baseLayers[0]?.version, "1.2.3-base");
  assert.equal(inspected.baseLayers[1]?.name, "@deepseek-ai/dsh-web-app");
  assert.equal(inspected.baseLayers[1]?.version, "2.3.4-web");
  assert.equal(inspected.homePatches.length, 0);
  const shared = asEntries(inspected.baseEntries).find((row) => row.id === "shared");
  assert.deepEqual(shared?.config, { a: 9 });
  assert.equal(Object.prototype.hasOwnProperty.call(shared?.config ?? {}, "b"), false);
  assert.match(inspected.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(home, "cordis.patch.yml")), false);
  assertNoSacredWrites(home);
  assert.equal(existsSync(join(home, "profiles")), false);
});

test("fixture: missing Home patch is [] and is distinct from empty or corrupt evidence", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  const missing = await inspectBlueprintRuntime({ home, bin: runtime.bin });
  assert.deepEqual(missing.homePatches, []);
  writeFileSync(join(home, "cordis.patch.yml"), "[]\n");
  const empty = await inspectBlueprintRuntime({ home, bin: runtime.bin });
  assert.deepEqual(empty.homePatches, []);
  assert.notEqual(missing.fingerprint, empty.fingerprint);
  writeFileSync(join(home, "cordis.patch.yml"), "id: not-an-array\n");
  await assertRejects(inspectBlueprintRuntime({ home, bin: runtime.bin }), "home-patch-invalid");
  writeFileSync(join(home, "cordis.patch.yml"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  await assertRejects(inspectBlueprintRuntime({ home, bin: runtime.bin }), "utf8-invalid");
  assertNoSacredWrites(home);
});

test("fixture: Home !!js tags are data and quoted !!js strings stay strings", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeFileSync(
    join(home, "cordis.patch.yml"),
    "- id: demo\n  config: !!js dshHomePath('sessions')\n- id: quoted\n  config: \"!!js not-a-tag\"\n",
  );
  const inspected = await inspectBlueprintRuntime({ home, bin: runtime.bin });
  assert.deepEqual(inspected.homePatches, [
    { id: "demo", config: { __jsExpr: "dshHomePath('sessions')" } },
    { id: "quoted", config: "!!js not-a-tag" },
  ]);
  assertNoSacredWrites(home);
});

test("fixture: fingerprint changes when Home or base patch bytes change", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  const first = await inspectBlueprintRuntime({ home, bin: runtime.bin });
  writeFileSync(join(home, "cordis.patch.yml"), "- id: later\n");
  const afterHome = await inspectBlueprintRuntime({ home, bin: runtime.bin });
  assert.notEqual(afterHome.fingerprint, first.fingerprint);
  const beforeBase = afterHome.fingerprint;
  writeFileSync(join(runtime.baseDir, "cordis.patch.yml"), "- insert:\n    - id: base-row\n      name: '@deepseek-ai/dsh-base'\n");
  const afterBase = await inspectBlueprintRuntime({ home, bin: runtime.bin });
  assert.notEqual(afterBase.fingerprint, beforeBase);
  assertNoSacredWrites(home);
});

test("fixture: compose uses official skipped id/name/group warnings and insert/replace order", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  const composed = await composeBlueprintRuntime(
    { home, bin: runtime.bin },
    {
      spaceId: "coding",
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      patch: [
        { id: "missing", config: { a: 1 } },
        { id: "shared", name: "wrong" },
        { id: "base-row", insert: [{ id: "child", name: "x" }] },
        { insert: [{ id: "tail", name: "t" }] },
        { id: "shared", config: { a: 3 } },
      ],
    },
  );
  assert.deepEqual(composed.warnings, [
    'patch: entry "missing" not found',
    'patch: name mismatch for "shared" (expected "shared", got "wrong"), skipping',
    'patch insert: entry "base-row" is not a group',
  ]);
  const entries = asEntries(composed.entries);
  const shared = entries.find((row) => row.id === "shared");
  assert.deepEqual(shared?.config, { a: 3 });
  assert.equal(entries.some((row) => row.id === "tail"), true);
  assert.equal(composed.layers[0]?.version, "1.2.3-base");
  assert.equal(composed.layers[1]?.version, "2.3.4-web");
  assert.equal(readFileSync(join(home, "profiles", "coding", "package.json"), "utf8").includes("1.2.3-base"), false);
  assert.equal(existsSync(join(home, "profiles", "web")), false);
  assert.equal(existsSync(join(home, "sessions")), false);
  assert.equal(existsSync(join(home, "storages")), false);
});

test("fixture: compose includes actual Home overlay after supplied patch", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  writeFileSync(join(home, "cordis.patch.yml"), "- id: shared\n  config:\n    a: 7\n    home: true\n");
  const composed = await composeBlueprintRuntime(
    { home, bin: runtime.bin },
    {
      spaceId: "coding",
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      patch: [{ id: "shared", config: { a: 4, supplied: true } }],
    },
  );
  const shared = asEntries(composed.entries).find((row) => row.id === "shared");
  assert.deepEqual(shared?.config, { a: 7, home: true });
});

test("fixture: install-first layer identity ignores a profile-local shadow copy", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  const shadow = join(home, "profiles", "coding", "node_modules", "@deepseek-ai", "dsh-base");
  mkdirSync(shadow, { recursive: true });
  writeFileSync(
    join(shadow, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh-base", version: "0.0.1-shadow", dsh: { bundle: { patch: "./cordis.patch.yml" } } })}\n`,
  );
  writeFileSync(join(shadow, "cordis.patch.yml"), "- insert:\n    - id: shadow\n      name: shadow\n");
  const composed = await composeBlueprintRuntime(
    { home, bin: runtime.bin },
    { spaceId: "coding", bundles: ["@deepseek-ai/dsh-base"], patch: [] },
  );
  assert.equal(composed.layers[0]?.version, "1.2.3-base");
  assert.equal(composed.layers[0]?.packageDir.toLowerCase().includes("0.0.1-shadow"), false);
  assert.equal(asEntries(composed.entries).some((row) => row.id === "shadow"), false);
});

test("fixture: missing or escaping bundle patch fails and does not write the target", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  const pkg = join(runtime.dshDir, "node_modules", "no-patch-bundle");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "no-patch-bundle", version: "1.0.0" })}\n`);
  await assertRejects(
    composeBlueprintRuntime({ home, bin: runtime.bin }, { spaceId: "coding", bundles: ["no-patch-bundle"], patch: [] }),
    "bundle-patch-missing",
  );
  const escape = join(runtime.dshDir, "node_modules", "escape-bundle");
  mkdirSync(escape, { recursive: true });
  writeFileSync(
    join(escape, "package.json"),
    `${JSON.stringify({ name: "escape-bundle", version: "1.0.0", dsh: { bundle: { patch: "../cordis.patch.yml" } } })}\n`,
  );
  await assertRejects(
    composeBlueprintRuntime({ home, bin: runtime.bin }, { spaceId: "coding", bundles: ["escape-bundle"], patch: [] }),
    "bundle-patch-escape",
  );
  const before = readFileSync(join(home, "profiles", "coding", "package.json"));
  assert.deepEqual(readFileSync(join(home, "profiles", "coding", "package.json")), before);
  assert.equal(existsSync(join(home, "profiles", "coding", "cordis.patch.yml")), false);
});

test("fixture: changed files during a call are rejected", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime({ mutate: true });
  writeSpace(home, "coding");
  await assertRejects(
    composeBlueprintRuntime(
      { home, bin: runtime.bin },
      { spaceId: "coding", bundles: ["mutate-bundle"], patch: [] },
    ),
    "observation-changed",
  );
});

test("fixture: CJS main and ESM-only exports resolve without executing plugins", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  const cjs = await resolveBlueprintModule(
    { home, bin: runtime.bin },
    { spaceId: "coding", specifier: "cjs-plugin" },
  );
  assert.equal(cjs.packageName, "cjs-plugin");
  assert.equal(cjs.packageVersion, "1.0.0");
  assert.equal(cjs.builtin, false);
  assert.ok(cjs.resolvedPath && /cjs-plugin[\\/]index\.cjs$/i.test(cjs.resolvedPath));
  const esm = await resolveBlueprintModule(
    { home, bin: runtime.bin },
    { spaceId: "coding", specifier: "esm-only-plugin" },
  );
  assert.ok(esm.resolvedPath && /esm-only-plugin[\\/]esm\.js$/i.test(esm.resolvedPath));
  const extra = await resolveBlueprintModule(
    { home, bin: runtime.bin },
    { spaceId: "coding", specifier: "esm-only-plugin/extra" },
  );
  assert.ok(extra.resolvedPath && /esm-only-plugin[\\/]extra\.js$/i.test(extra.resolvedPath));
  await assertRejects(
    resolveBlueprintModule({ home, bin: runtime.bin }, { spaceId: "coding", specifier: "esm-only-plugin/nope" }),
    "module-unresolved",
  );
  const throwing = await resolveBlueprintModule(
    { home, bin: runtime.bin },
    { spaceId: "coding", specifier: "throwing-plugin" },
  );
  assert.ok(throwing.resolvedPath);
  assert.equal(existsSync(join(dirname(throwing.resolvedPath!), "executed.txt")), false);
});

test("fixture: unsupported specifiers and unknown cordis builtins are rejected", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  for (const specifier of ["./rel", "../up", "/abs", "file:x", "https://example.test/x", "C:\\abs", "pkg/..", "pkg/.", "pkg//x"]) {
    await assertRejects(
      resolveBlueprintModule({ home, bin: runtime.bin }, { spaceId: "coding", specifier }),
      "module-invalid",
    );
  }
  await assertRejects(
    resolveBlueprintModule({ home, bin: runtime.bin }, { spaceId: "coding", specifier: "missing-plugin" }),
    "module-unresolved",
  );
  const group = await resolveBlueprintModule(
    { home, bin: runtime.bin },
    { spaceId: "coding", specifier: "cordis:group" },
  );
  assert.equal(group.builtin, true);
  assert.equal(group.packageName, "@deepseek-ai/cordis-plugin-group");
  assert.equal(group.packageVersion, "1.0.2-fixture");
  assert.equal(group.resolvedPath, null);
  const include = await resolveBlueprintModule(
    { home, bin: runtime.bin },
    { spaceId: "coding", specifier: "cordis:include" },
  );
  assert.equal(include.builtin, true);
  assert.equal(include.packageName, "@deepseek-ai/cordis-plugin-include");
  assert.equal(include.resolvedPath, null);
  await assertRejects(
    resolveBlueprintModule({ home, bin: runtime.bin }, { spaceId: "coding", specifier: "cordis:loader" }),
    "builtin-unsupported",
  );
  await assertRejects(
    resolveBlueprintModule({ home, bin: runtime.bin }, { spaceId: "coding", specifier: "cordis:group/x" }),
    "module-invalid",
  );
});

test("fixture: tarball library trees are not used and web/manager names are refused", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  mkdirSync(join(home, "hub", "plugins"), { recursive: true });
  const tarball = join(home, "hub", "plugins", "evil@1.0.0.tgz");
  writeFileSync(tarball, "not-a-real-tarball");
  const before = readFileSync(tarball);
  await assertRejects(
    resolveBlueprintModule({ home, bin: runtime.bin }, { spaceId: "coding", specifier: "evil" }),
    "module-unresolved",
  );
  assert.deepEqual(readFileSync(tarball), before);
  await assertRejects(
    composeBlueprintRuntime({ home, bin: runtime.bin }, { spaceId: "web", bundles: [], patch: [] }),
    "invalid-space",
  );
  await assertRejects(inspectBlueprintRuntime({ home: realHome, bin: runtime.bin }), "invalid-home");
  assert.equal(existsSync(join(home, "profiles", "web")), false);
});

test("fixture: root group insert then later overlay of the inserted child matches official order", async () => {
  const home = tempHome();
  const runtime = writeFakeRuntime();
  writeSpace(home, "coding");
  const composed = await composeBlueprintRuntime(
    { home, bin: runtime.bin },
    {
      spaceId: "coding",
      bundles: ["@deepseek-ai/dsh-base"],
      patch: [
        { insert: [{ id: "g", name: "group-mod", group: true, config: [] }] },
        { id: "g", insert: [{ id: "child", name: "child-mod", config: { n: 1 } }] },
        { id: "child", config: { n: 2 } },
      ],
    },
  );
  const group = asEntries(composed.entries).find((row) => row.id === "g");
  assert.equal(group?.group, true);
  assert.deepEqual(group?.config, [{ id: "child", name: "child-mod", config: { n: 2 } }]);
});

test(
  "integration: official 0.1.5-rc.2 base version is available without profiles/web or local base node_modules",
  { skip: officialBin ? false : "official 0.1.5-rc.2 bin not available" },
  async () => {
    const home = tempHome();
    const inspected = await inspectBlueprintRuntime({ home, bin: officialBin! });
    assert.equal(inspected.versions.dsh, "0.1.5-rc.2");
    assert.equal(inspected.versions.base, "0.1.5-rc.2");
    assert.equal(inspected.versions.webApp, "0.1.5-rc.2");
    assert.equal(inspected.baseLayers[0]?.name, "@deepseek-ai/dsh-base");
    assert.equal(inspected.baseLayers[0]?.version, "0.1.5-rc.2");
    assert.equal(inspected.baseLayers[1]?.name, "@deepseek-ai/dsh-web-app");
    assert.ok(asEntries(inspected.baseEntries).some((row) => row.id === "timer"));
    assert.deepEqual(inspected.homePatches, []);
    assert.equal(existsSync(join(home, "profiles")), false);
    assert.equal(existsSync(join(home, "node_modules")), false);
    assertNoSacredWrites(home);
  },
);

test(
  "integration: official 0.1.5-rc.2 skipped warnings and whole-config replacement",
  { skip: officialBin ? false : "official 0.1.5-rc.2 bin not available" },
  async () => {
    const home = tempHome();
    writeSpace(home, "coding");
    const composed = await composeBlueprintRuntime(
      { home, bin: officialBin! },
      {
        spaceId: "coding",
        bundles: ["@deepseek-ai/dsh-base"],
        patch: [
          { id: "missing", config: { a: 1 } },
          { id: "timer", name: "wrong" },
          { id: "timer", insert: [{ id: "child", name: "x" }] },
          { id: "hmr", config: { root: ["hub"] } },
        ],
      },
    );
    assert.deepEqual(composed.warnings, [
      'patch: entry "missing" not found',
      'patch: name mismatch for "timer" (expected "@deepseek-ai/cordis-plugin-timer", got "wrong"), skipping',
      'patch insert: entry "timer" is not a group',
    ]);
    const hmr = asEntries(composed.entries).find((row) => row.id === "hmr");
    assert.deepEqual(hmr?.config, { root: ["hub"] });
    assert.equal(composed.layers[0]?.version, "0.1.5-rc.2");
    assert.equal(existsSync(join(home, "profiles", "web")), false);
    const builtins = await resolveBlueprintModule(
      { home, bin: officialBin! },
      { spaceId: "coding", specifier: "cordis:group" },
    );
    assert.equal(builtins.builtin, true);
    assert.equal(builtins.packageName, "@deepseek-ai/cordis-plugin-group");
    assert.equal(builtins.resolvedPath, null);
    assert.equal(builtins.packageVersion, "1.0.2");
  },
);

test(
  "integration: official 0.1.5-rc.2 ESM-only export uses resolve.exports, not plugin execution",
  { skip: officialBin ? false : "official 0.1.5-rc.2 bin not available" },
  async () => {
    const home = tempHome();
    writeSpace(home, "coding");
    const pkg = join(home, "profiles", "coding", "node_modules", "esm-only-plugin");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      `${JSON.stringify({
        name: "esm-only-plugin",
        version: "3.0.0",
        type: "module",
        exports: { ".": { import: "./esm.js" } },
      })}\n`,
    );
    writeFileSync(join(pkg, "esm.js"), "throw new Error('plugin executed');\n");
    const resolved = await resolveBlueprintModule(
      { home, bin: officialBin! },
      { spaceId: "coding", specifier: "esm-only-plugin" },
    );
    assert.equal(resolved.packageVersion, "3.0.0");
    assert.ok(resolved.resolvedPath && /esm-only-plugin[\\/]esm\.js$/i.test(resolved.resolvedPath));
    await assertRejects(
      resolveBlueprintModule({ home, bin: officialBin! }, { spaceId: "coding", specifier: "esm-only-plugin/missing" }),
      "module-unresolved",
    );
  },
);

function writeFakeRuntime(options: { mutate?: boolean } = {}): {
  bin: string;
  dshDir: string;
  baseDir: string;
  webDir: string;
} {
  const dshDir = tempHome("dsh-spaces-blueprint-runtime-");
  const bin = join(dshDir, "lib", "bin.js");
  mkdirSync(join(dshDir, "lib"), { recursive: true });
  writeFileSync(
    join(dshDir, "package.json"),
    `${JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.9-fixture", type: "module" })}\n`,
  );
  writeFileSync(bin, "export {};\n");
  const nm = join(dshDir, "node_modules");
  writeAppBoot(join(nm, "@deepseek-ai", "dsh-app-boot"));
  writeResolveExports(join(nm, "resolve.exports"));
  const baseDir = writeBundle(join(nm, "@deepseek-ai", "dsh-base"), {
    name: "@deepseek-ai/dsh-base",
    version: "1.2.3-base",
    patch: `- insert:\n    - id: base-row\n      name: '@deepseek-ai/dsh-base'\n      config:\n        from: base\n    - id: shared\n      name: shared\n      config:\n        a: 1\n        b: 2\n`,
  });
  const webDir = writeBundle(join(nm, "@deepseek-ai", "dsh-web-app"), {
    name: "@deepseek-ai/dsh-web-app",
    version: "2.3.4-web",
    patch: `- id: shared\n  config:\n    a: 9\n- insert:\n    - id: web-row\n      name: '@deepseek-ai/dsh-web-app'\n`,
  });
  writeProvider(join(nm, "@deepseek-ai", "cordis-plugin-group"), "@deepseek-ai/cordis-plugin-group", "1.0.2-fixture");
  writeProvider(join(nm, "@deepseek-ai", "cordis-plugin-include"), "@deepseek-ai/cordis-plugin-include", "1.0.7-fixture");
  writeCjsPlugin(join(nm, "cjs-plugin"));
  writeEsmOnlyPlugin(join(nm, "esm-only-plugin"));
  writeThrowingPlugin(join(nm, "throwing-plugin"));
  if (options.mutate) {
    writeBundle(join(nm, "mutate-bundle"), {
      name: "mutate-bundle",
      version: "1.0.0",
      patchFile: "mutate-after-read.yml",
      patch: "- insert:\n    - id: mutate\n      name: mutate-bundle\n",
    });
  }
  return { bin, dshDir, baseDir, webDir };
}

function writeAppBoot(dir: string): void {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: "@deepseek-ai/dsh-app-boot",
      version: "9.9.9-fixture",
      type: "module",
      main: "lib/index.js",
      exports: { ".": "./lib/index.js" },
    })}\n`,
  );
  writeFileSync(join(dir, "lib", "index.js"), appBootSource());
}

function appBootSource(): string {
  return `import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const yaml = createRequire(import.meta.url)(${JSON.stringify(jsYamlPath)});
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: (data) => typeof data === "string",
  construct: (data) => ({ __jsExpr: data }),
  predicate: (data) => Boolean(data) && typeof data === "object" && "__jsExpr" in data,
  represent: (data) => data["__jsExpr"],
});
const schema = yaml.JSON_SCHEMA.extend(JsExpr);
export const PROFILES_DIR = "profiles";
export const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
export const PROFILE_TEMPLATES = { web: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" } };
export function loadProfileDirectory() { throw new Error("loadProfileDirectory must not be used"); }
export function mountRootInclude() { throw new Error("mountRootInclude must not boot"); }
export function resolveBundleDir(binName, packageName, installAnchor, profileDir) {
  for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
    const dir = packageDirFromAnchor(anchor, packageName);
    if (dir !== undefined) return dir;
  }
  throw new Error(binName + ": cannot resolve profile bundle");
}
function packageDirFromAnchor(anchor, packageName) {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
}
export function loadOptionalPatches(binName, file) {
  let content;
  try { content = readFileSync(file, "utf8"); }
  catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw new Error(binName + ": failed to read patches");
  }
  return parsePatchList(binName, file, content, "patches");
}
export function loadOverlayPatches(binName, file) {
  let content;
  try { content = readFileSync(file, "utf8"); }
  catch { throw new Error(binName + ": failed to read overlay"); }
  const parsed = parsePatchList(binName, file, content, "overlay");
  if (String(file).includes("mutate-after-read")) writeFileSync(file, "- id: mutated\\n");
  return parsed;
}
function parsePatchList(binName, file, content, label) {
  let parsed;
  try { parsed = yaml.load(content, { schema }); }
  catch { throw new Error(binName + ": failed to parse " + label); }
  if (!Array.isArray(parsed)) throw new Error(binName + ": " + label + " must be a top-level YAML array of loader patch entries");
  parsed.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(binName + ": " + label + " entry " + (index + 1) + " must be a mapping");
    }
  });
  const base = dirname(resolve(file));
  const visit = (entry) => {
    if (typeof entry.name === "string" && (isAbsolute(entry.name) || entry.name.startsWith("./") || entry.name.startsWith("../"))) {
      entry.name = pathToFileURL(resolve(base, entry.name)).href;
    }
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
  };
  for (const patch of parsed) patch.insert?.forEach(visit);
  return parsed;
}
function applyEntryPatches(data, patches, warn) {
  data = structuredClone(data);
  if (!patches?.length) return data;
  const entryMap = new Map();
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
    }
  };
  buildMap(data);
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target) { warn("patch insert: entry %C not found", id); continue; }
        if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
      } else data.push(...insert);
      buildMap(insert);
      continue;
    }
    if (!id) { warn("patch: id is required for non-insert patches"); continue; }
    const target = entryMap.get(id);
    if (!target) { warn("patch: entry %C not found", id); continue; }
    if (name && name !== target.name) {
      warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
      continue;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "id") continue;
      target[key] = value;
    }
  }
  return data;
}
export function composeEntries(layers, warn = () => {}) {
  return applyEntryPatches([], structuredClone(layers.flat()), (message, ...args) => {
    let index = 0;
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])));
  });
}
`;
}

function writeResolveExports(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: "resolve.exports",
      version: "2.0.3-fixture",
      main: "index.js",
      exports: { ".": { import: "./index.js", require: "./index.js", default: "./index.js" } },
    })}\n`,
  );
  writeFileSync(
    join(dir, "index.js"),
    `function pick(target, conditions) {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) {
    const acc = [];
    for (const item of target) {
      const got = pick(item, conditions);
      if (got) acc.push(...got);
    }
    return acc.length ? acc : undefined;
  }
  if (target && typeof target === "object") {
    for (const key of Object.keys(target)) {
      if (conditions.has(key)) return pick(target[key], conditions);
    }
  }
}
function resolve(pkg, entry, options = {}) {
  let exportsField = pkg.exports;
  if (exportsField == null) return;
  if (typeof exportsField === "string" || Array.isArray(exportsField) || (exportsField && typeof exportsField === "object" && !Object.keys(exportsField).some((key) => key.startsWith(".")))) {
    exportsField = { ".": exportsField };
  }
  const sub = !entry || entry === "." ? "." : entry.startsWith("./") ? entry : "./" + entry;
  const target = exportsField[sub];
  if (target === undefined) throw new Error('Missing "' + sub + '" specifier in "' + pkg.name + '" package');
  const conditions = new Set(["default", ...(options.conditions || [])]);
  if (!options.unsafe) {
    conditions.add(options.require ? "require" : "import");
    conditions.add(options.browser ? "browser" : "node");
  }
  const out = pick(target, conditions);
  if (!out) throw new Error('No known conditions for "' + sub + '" specifier in "' + pkg.name + '" package');
  return out;
}
exports.resolve = resolve;
exports.exports = resolve;
exports.legacy = function legacy(pkg) {
  const main = typeof pkg.main === "string" && pkg.main ? pkg.main : typeof pkg.module === "string" ? pkg.module : undefined;
  return main ? "./" + String(main).replace(/^\\.?\\//, "") : undefined;
};
`,
  );
}

function writeBundle(
  dir: string,
  input: { name: string; version: string; patch: string; patchFile?: string },
): string {
  mkdirSync(dir, { recursive: true });
  const patchFile = input.patchFile ?? "cordis.patch.yml";
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: input.name,
      version: input.version,
      dsh: { bundle: { patch: `./${patchFile}` } },
    })}\n`,
  );
  writeFileSync(join(dir, patchFile), input.patch);
  return dir;
}

function writeProvider(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name, version, exports: { ".": "./index.js", "./package.json": "./package.json" } })}\n`,
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

function writeCjsPlugin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "cjs-plugin", version: "1.0.0", main: "index.cjs" })}\n`,
  );
  writeFileSync(join(dir, "index.cjs"), "throw new Error('plugin executed');\n");
}

function writeEsmOnlyPlugin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: "esm-only-plugin",
      version: "2.0.0",
      type: "module",
      exports: { ".": { import: "./esm.js" }, "./extra": { import: "./extra.js" } },
    })}\n`,
  );
  writeFileSync(join(dir, "esm.js"), "throw new Error('plugin executed');\n");
  writeFileSync(join(dir, "extra.js"), "throw new Error('plugin executed');\n");
}

function writeThrowingPlugin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "throwing-plugin", version: "1.0.0", main: "index.cjs" })}\n`,
  );
  writeFileSync(
    join(dir, "index.cjs"),
    `require("fs").writeFileSync(require("path").join(__dirname, "executed.txt"), "executed");\nthrow new Error("plugin executed");\n`,
  );
}

function writeSpace(home: string, spaceId: string): void {
  const dir = join(home, "profiles", spaceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({
      name: `dsh-profile-${spaceId}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    }, null, 2)}\n`,
  );
}

function officialRc2Bin(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const bin = join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(bin)) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(bin, "..", "..", "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (pkg.name === "@deepseek-ai/dsh" && pkg.version === "0.1.5-rc.2") return bin;
  } catch {
    return null;
  }
  return null;
}

function tempHome(prefix = "dsh-spaces-blueprint-runtime-home-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  assert.notEqual(resolve(dir).toLowerCase(), resolve(realHome).toLowerCase());
  return dir;
}

function assertNoSacredWrites(home: string): void {
  assert.equal(existsSync(join(home, "profiles", "web")), false);
  assert.equal(existsSync(join(home, "sessions")), false);
  assert.equal(existsSync(join(home, "storages")), false);
}

function asEntries(value: unknown): Array<{ id?: string; name?: string; group?: unknown; config?: unknown }> {
  assert.ok(Array.isArray(value));
  return value as Array<{ id?: string; name?: string; group?: unknown; config?: unknown }>;
}

async function assertRejects(work: Promise<unknown>, code: string): Promise<BlueprintRuntimeError> {
  let failed: BlueprintRuntimeError | undefined;
  await assert.rejects(work, (error: unknown) => {
    assert.equal(error instanceof BlueprintRuntimeError, true);
    failed = error as BlueprintRuntimeError;
    assert.equal(failed.code, code);
    assert.match(failed.message, /^Blueprint /);
    assertNoLeak(failed);
    return true;
  });
  assert.ok(failed);
  return failed;
}

function assertNoLeak(error: Error): void {
  const text = error.message;
  assert.equal(text.includes(realHome), false);
  assert.equal(/[A-Za-z]:\\/.test(text), false);
  assert.equal(/\btoken\b/i.test(text), false);
}
