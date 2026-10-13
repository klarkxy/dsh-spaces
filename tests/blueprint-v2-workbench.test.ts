import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { parseBlueprint as parseStandalone } from "@klarkxy/dsh-blueprint/core";
import { encodeBlueprintDocument } from "@klarkxy/dsh-blueprint/document-codec";
import { parseBlueprintDocument } from "@klarkxy/dsh-blueprint/document";
import { BlueprintWorkbench, type BlueprintRuntimeInspect, type BlueprintWorkbenchPorts } from "../src/adapters/node/blueprint-workbench.ts";
import { composeBlueprintRuntime, inspectBlueprintRuntime } from "../src/adapters/node/blueprint-runtime.ts";
import type { WorkbenchJobContext } from "../src/adapters/node/workbench-jobs.ts";
import type { WorkbenchBlueprintApplyOutcome } from "../src/shared/workbench-blueprint.ts";
import type { WorkbenchSpace } from "../src/shared/workbench.ts";
import { spaceIdFromName } from "../src/shared/types.ts";

const BUILTIN = "fixture-optional-bundle";
const HOST = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-spaces/view-bridge", "@dsh-spaces/llm-bridge"];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function row(id: string): WorkbenchSpace {
  return { id, displayName: id, isHost: false, hasWebApp: true, isolation: "verified", icon: "box", status: "stopped", generation: 1, managed: true, needsIsolation: false, dshVersion: null };
}
function document(packages = [
  { name: "alpha", version: "1.0.0", source: "npm" },
  { name: BUILTIN, version: "2.3.4", source: "builtin" },
], bundles = [BUILTIN, "alpha"]) {
  return parseBlueprintDocument({ kind: "dsh-blueprint", formatVersion: 2, metadata: { name: "v2 recipe", description: "Exact packages" }, packages, bundles });
}
function context(signal = new AbortController().signal): { ctx: WorkbenchJobContext; outcomes: WorkbenchBlueprintApplyOutcome[] } {
  const outcomes: WorkbenchBlueprintApplyOutcome[] = [];
  return { outcomes, ctx: { signal, phase() {}, message() {}, cancellable() {}, result(value) { outcomes.push(JSON.parse(JSON.stringify(value.product)) as WorkbenchBlueprintApplyOutcome); } } };
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dsh-bpv2-workbench-")); dirs.push(home);
  const spaces: WorkbenchSpace[] = []; const calls: string[] = [];
  let fingerprint = "runtime-one"; let version = "2.3.4"; let available = true;
  let prepared: { name: string; version: string } | undefined;
  let failPackage: string | undefined;
  const versions = { dsh: "0.2.0-rc.2", base: "0.2.0-rc.2", webApp: "0.2.0-rc.2" };
  function profile(name: string, deps: Record<string, string> = {}, bundles: string[] = HOST) {
    write(join(home, "profiles", name, "package.json"), { dependencies: deps, dsh: { profile: { bundles } } });
    if (!spaces.some(s => s.id === name)) spaces.push(row(name));
  }
  const ports: BlueprintWorkbenchPorts = {
    home, managerId: () => "manager", listSpaces: () => spaces,
    observation: () => ({ serviceEpoch: "ab".repeat(32), expectedRevision: "cd".repeat(32) }),
    runtimeBin: () => "bound-runtime", dshVersion: () => versions.dsh, spacesVersion: () => "0.4.0",
    inspectRuntime: async () => ({
      versions, baseLayers: [], baseEntries: [], homePatches: [], fingerprint,
      builtinLayers: available ? [{ name: BUILTIN, version, packageDir: "bound-builtin", patchPath: "bound-patch", patches: [] }] : [],
      builtinCatalog: [BUILTIN],
    } satisfies BlueprintRuntimeInspect),
    createSpace: async input => { calls.push(`create:${input.name}`); profile(spaceIdFromName(input.name)); },
    prepareBlueprintPackage: async (_home, pkg) => {
      calls.push(`prepare:${pkg.name}`);
      if (pkg.name === failPackage) throw new Error("failure token=sk-private-canary-path");
      prepared = { name: pkg.name, version: pkg.version };
      return { archivePath: join(home, "prepared.tgz"), ...prepared, integrity: "sha512-" + "A".repeat(86) + "==", hasBundle: true, lifecycleScripts: [] };
    },
    installPlugin: async id => {
      assert.ok(prepared); calls.push(`install:${prepared.name}`);
      write(join(home, "profiles", id, "node_modules", prepared.name, "package.json"), { ...prepared, dsh: { bundle: { patch: "patch.yml" } } });
    },
    composeRuntime: async (_options, input) => ({ versions, layers: input.bundles.map(name => ({ name, version: name === BUILTIN ? version : HOST.includes(name) ? "0.2.0-rc.2" : "1.0.0" })), entries: [], warnings: [], fingerprint }),
    llm: async () => { throw new Error("unexpected model request"); },
  };
  return { home, spaces, calls, ports, profile, wb: new BlueprintWorkbench(ports),
    change(next: { fingerprint?: string; version?: string; available?: boolean; failPackage?: string }) {
      if (next.fingerprint !== undefined) fingerprint = next.fingerprint;
      if (next.version !== undefined) version = next.version;
      if (next.available !== undefined) available = next.available;
      if (next.failPackage !== undefined) failPackage = next.failPackage;
    },
  };
}

test("v2 source and export share exact npm and optional builtin identities and native order", async () => {
  const f = fixture();
  f.profile("source", { alpha: "1.0.0" }, [...HOST, BUILTIN, "alpha"]);
  write(join(f.home, "profiles", "source", "node_modules", "alpha", "package.json"), { name: "alpha", version: "1.0.0", dsh: { bundle: { patch: "patch.yml" } } });
  const source = await f.wb.source("source");
  assert.deepEqual(source.packages.map(p => [p.name, p.source, p.version]), [["alpha", "npm", "1.0.0"], [BUILTIN, "builtin", "2.3.4"]]);
  const exported = await f.wb.generate({ formatVersion: 2, spaceId: "source", selection: { packages: ["alpha", BUILTIN], includePatch: false, settingsNamespaces: [] }, metadata: { name: "export", description: "share" } });
  assert.match(exported.shareCode, /^DSHBP2:/);
  assert.equal(exported.fileName, "export.dsh-blueprint.json");
  assert.deepEqual(parseStandalone(exported.shareCode), JSON.parse(exported.json));
  assert.deepEqual(exported.blueprint, { kind: "dsh-blueprint", formatVersion: 2, metadata: { name: "export", description: "share" }, packages: [{ name: "alpha", version: "1.0.0", source: "npm" }, { name: BUILTIN, version: "2.3.4", source: "builtin" }], bundles: [BUILTIN, "alpha"] });
});

test("v2 rejects selected presets, settings and bindings and v1 rejects builtin conversion", async () => {
  const f = fixture(); f.profile("source");
  const request = { formatVersion: 2 as const, spaceId: "source", metadata: { name: "export" }, selection: { packages: [], includePatch: false, settingsNamespaces: [] as string[] } };
  await assert.rejects(f.wb.generate({ ...request, selection: { ...request.selection, includePatch: true } }), /cannot include configuration/);
  await assert.rejects(f.wb.generate({ ...request, selection: { ...request.selection, settingsNamespaces: ["theme"] } }), /cannot include configuration/);
  await assert.rejects(f.wb.generate({ ...request, bindingOverrides: [{ pointer: "/profile/patch/0", input: { id: "path", type: "directory", label: "Path", required: true } }] }), /cannot include configuration/);
  await assert.rejects(f.wb.generate({ ...request, formatVersion: 1, metadata: { name: "legacy", version: "1.0.0" }, selection: { ...request.selection, packages: [BUILTIN] } }), /require.*version 2/);
});

test("v2 code and JSON preserve raw artifact in inspect, preview and provenance; builtins bypass npm", async () => {
  const f = fixture(); const raw = document();
  assert.deepEqual((await f.wb.inspect(encodeBlueprintDocument(raw))).blueprint, raw);
  const preview = await f.wb.preview({ content: JSON.stringify(raw), name: "target", values: {} });
  assert.ok(preview.planId); assert.deepEqual(preview.blueprint, raw);
  assert.deepEqual(preview.packages.map(p => [p.source, p.order]), [["npm", 1], ["builtin", 0]]);
  const outcome = await f.wb.apply(preview.planId, context().ctx);
  assert.equal(outcome.stages.presets.status, "succeeded");
  assert.equal(outcome.stages.start.status, "not-run");
  assert.deepEqual(f.calls, ["create:target", "prepare:alpha", "install:alpha"]);
  const manifest = JSON.parse(readFileSync(join(f.home, "profiles", "space-target", "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, [...HOST, BUILTIN, "alpha"]);
  const origin = JSON.parse(readFileSync(join(f.home, "hub", "space-target", "blueprint-origin.json"), "utf8"));
  assert.deepEqual(origin.blueprint, raw);
  assert.equal("profile" in origin.blueprint, false);
  assert.equal(existsSync(join(f.home, "profiles", "web")), false);
  assert.equal(existsSync(join(f.home, "sessions")), false);
  assert.equal(existsSync(join(f.home, "storages")), false);
});

test("package-only v2 installs identities without enabling optional bundles or removing host/control layers", async () => {
  const f = fixture(); const preview = await f.wb.preview({ content: JSON.stringify(document(undefined, [])), name: "package-only", values: {} });
  assert.ok(preview.planId); await f.wb.apply(preview.planId, context().ctx);
  const manifest = JSON.parse(readFileSync(join(f.home, "profiles", "space-package-only", "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, HOST);
  assert.deepEqual(f.calls, ["create:package-only", "prepare:alpha", "install:alpha"]);
});

test("mismatched, unavailable and protected builtins reject preview before writes", async () => {
  for (const change of [{ version: "2.3.5" }, { available: false }]) {
    const f = fixture(); f.change(change);
    const preview = await f.wb.preview({ content: JSON.stringify(document()), name: "blocked", values: {} });
    assert.equal(preview.planId, undefined); assert.ok(preview.diagnostics.some(d => d.code === "blueprint.builtin" && d.severity === "error"));
    assert.deepEqual(f.calls, []); assert.equal(existsSync(join(f.home, "profiles")), false);
  }
  const f = fixture();
  const protectedDoc = document([{ name: "@deepseek-ai/dsh-base", version: "0.2.0-rc.2", source: "builtin" }], []);
  const preview = await f.wb.preview({ content: JSON.stringify(protectedDoc), name: "blocked", values: {} });
  assert.equal(preview.planId, undefined); assert.deepEqual(f.calls, []);
  const npmProtected = document([{ name: "@dsh-spaces/view-bridge", version: "0.4.0", source: "npm" }], []);
  assert.equal((await f.wb.preview({ content: JSON.stringify(npmProtected), name: "blocked", values: {} })).planId, undefined);
  const npmBuiltin = document([{ name: BUILTIN, version: "2.3.4", source: "npm" }], []);
  assert.equal((await f.wb.preview({ content: JSON.stringify(npmBuiltin), name: "blocked", values: {} })).planId, undefined);
});

test("builtin fingerprint change invalidates the preview before creation", async () => {
  const f = fixture(); const preview = await f.wb.preview({ content: JSON.stringify(document()), name: "stale", values: {} });
  assert.ok(preview.planId); f.change({ fingerprint: "changed-patch-bytes" });
  const { ctx, outcomes } = context();
  await assert.rejects(f.wb.apply(preview.planId, ctx), /target changed/);
  assert.deepEqual(f.calls, []); assert.equal(outcomes.at(-1)?.stages["space-create"].status, "failed");
});

test("builtin change during npm preparation fails before npm installation and retains the created space", async () => {
  const f = fixture();
  const prepare = f.ports.prepareBlueprintPackage!;
  f.ports.prepareBlueprintPackage = async (...args) => {
    const prepared = await prepare(...args); f.change({ fingerprint: "changed-during-prepare" }); return prepared;
  };
  const preview = await f.wb.preview({ content: JSON.stringify(document()), name: "late-change", values: {} });
  assert.ok(preview.planId); const { ctx, outcomes } = context();
  await assert.rejects(f.wb.apply(preview.planId, ctx), /runtime changed/);
  assert.deepEqual(f.calls, ["create:late-change", "prepare:alpha"]);
  assert.equal(outcomes.at(-1)?.stages["space-create"].status, "succeeded");
  assert.equal(outcomes.at(-1)?.stages.packages.status, "failed");
});

test("v2 export rejects a direct npm manifest whose name does not match the selected identity", async () => {
  const f = fixture(); f.profile("source", { alpha: "1.0.0" });
  write(join(f.home, "profiles", "source", "node_modules", "alpha", "package.json"), { name: "foreign", version: "1.0.0" });
  await assert.rejects(f.wb.generate({ formatVersion: 2, spaceId: "source", metadata: { name: "bad" }, selection: { packages: ["alpha"], includePatch: false, settingsNamespaces: [] } }), /eligible installed identity/);
});

test("unavailable shipped builtins stay visible in source and cannot be exported as npm shadows", async () => {
  const f = fixture(); f.change({ available: false }); f.profile("source", { [BUILTIN]: "2.3.4" }, [...HOST, BUILTIN]);
  write(join(f.home, "profiles", "source", "node_modules", BUILTIN, "package.json"), { name: BUILTIN, version: "2.3.4" });
  const source = await f.wb.source("source");
  assert.equal(source.packages.find(pkg => pkg.name === BUILTIN)?.source, "builtin");
  assert.equal(source.packages.find(pkg => pkg.name === BUILTIN)?.eligibility.available, false);
  assert.equal(source.bundles.find(pkg => pkg.name === BUILTIN)?.eligible, false);
  const npmShadow = document([{ name: BUILTIN, version: "2.3.4", source: "npm" }], []);
  assert.equal((await f.wb.preview({ content: JSON.stringify(npmShadow), name: "blocked", values: {} })).planId, undefined);
});

test("npm manifest drift during v2 generation invalidates export", async () => {
  const f = fixture(); f.profile("source", { alpha: "1.0.0" });
  const file = join(f.home, "profiles", "source", "node_modules", "alpha", "package.json");
  write(file, { name: "alpha", version: "1.0.0" });
  const inspect = f.ports.inspectRuntime!;
  let calls = 0;
  f.ports.inspectRuntime = async (options) => {
    const result = await inspect(options);
    if (++calls === 2) write(file, { name: "alpha", version: "1.0.1" });
    return result;
  };
  await assert.rejects(f.wb.generate({ formatVersion: 2, spaceId: "source", metadata: { name: "bad" }, selection: { packages: ["alpha"], includePatch: false, settingsNamespaces: [] } }), /space changed/);
});

test("v2 partial npm failure retains succeeded identities and stops the remaining items without replay", async () => {
  const f = fixture(); f.change({ failPackage: "beta" });
  const raw = document([{ name: BUILTIN, version: "2.3.4", source: "builtin" }, { name: "alpha", version: "1.0.0", source: "npm" }, { name: "beta", version: "1.0.0", source: "npm" }, { name: "gamma", version: "1.0.0", source: "npm" }], []);
  const preview = await f.wb.preview({ content: JSON.stringify(raw), name: "partial", values: {} }); assert.ok(preview.planId);
  const { ctx, outcomes } = context(); await assert.rejects(f.wb.apply(preview.planId, ctx));
  const outcome = outcomes.at(-1)!;
  assert.deepEqual(outcome.packageResults.map(p => p.status), ["succeeded", "succeeded", "failed", "not-run"]);
  assert.equal(outcome.stages["space-create"].status, "succeeded"); assert.equal(outcome.stages.presets.status, "not-run");
  assert.ok(existsSync(join(f.home, "profiles", "space-partial", "node_modules", "alpha", "package.json")));
  assert.equal(f.calls.some(call => call.includes("gamma")), false);
  assert.doesNotMatch(JSON.stringify(outcome), /sk-private-canary/);
  await assert.rejects(f.wb.apply(preview.planId, context().ctx), /no longer valid/);
});

test("v2 receiver inputs and cancellation are rejected before writes", async () => {
  const f = fixture(); const raw = document();
  const invalid = await f.wb.preview({ content: JSON.stringify(raw), name: "invalid", values: { undeclared: "secret-local" } });
  assert.equal(invalid.planId, undefined);
  const preview = await f.wb.preview({ content: JSON.stringify(raw), name: "cancelled", values: {} }); assert.ok(preview.planId);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.wb.apply(preview.planId, context(controller.signal).ctx), /cancelled/);
  assert.deepEqual(f.calls, []);
});

test("legacy v1 raw inputs, patches and settings remain intact in inspect and preview", async () => {
  const f = fixture();
  const raw = parseBlueprintDocument({ kind: "dsh-blueprint", formatVersion: 1, metadata: { name: "legacy", version: "1.0.0" }, packages: [], profile: { base: "web", bundles: [], patch: [{ insert: [{ id: "entry", name: "cordis:group", group: true, config: [] }] }], settings: { theme: { color: null } } }, inputs: [{ id: "color", type: "string", label: "Color", required: true }], bindings: [{ input: "color", target: { kind: "value", pointer: "/profile/settings/theme/color" } }] });
  assert.deepEqual((await f.wb.inspect(encodeBlueprintDocument(raw))).blueprint, raw);
  const preview = await f.wb.preview({ content: JSON.stringify(raw), name: "legacy-target", values: { color: "red" } });
  assert.deepEqual(preview.blueprint, raw); assert.ok(preview.planId); assert.deepEqual(preview.missingInputs, []);
});

test("official DSH 0.2 inspection and composition apply a v2 builtin plus exact profile npm identity", async (t) => {
  const bin = process.env.DSH_BLUEPRINT_TEST_BIN ?? process.env.DSH_TEST_CLI_BIN ?? join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(bin)) { t.skip("official bound DSH installation unavailable"); return; }
  const f = fixture();
  const builtin = "@deepseek-ai/dsh-experimental-auto-review";
  f.ports.runtimeBin = () => bin;
  f.ports.inspectRuntime = inspectBlueprintRuntime;
  f.ports.composeRuntime = composeBlueprintRuntime;
  f.ports.createSpace = async input => { f.calls.push(`create:${input.name}`); f.profile(spaceIdFromName(input.name), {}, HOST.slice(0, 2)); };
  f.ports.installPlugin = async id => {
    f.calls.push("install:alpha");
    const dir = join(f.home, "profiles", id, "node_modules", "alpha");
    write(join(dir, "package.json"), { name: "alpha", version: "1.0.0", dsh: { bundle: { patch: ["first.yml", "second.yml"] } } });
    write(join(dir, "first.yml"), "[]\n"); write(join(dir, "second.yml"), "[]\n");
  };
  const raw = document([{ name: "alpha", version: "1.0.0", source: "npm" }, { name: builtin, version: "0.2.0-rc.2", source: "builtin" }], [builtin, "alpha"]);
  const preview = await f.wb.preview({ content: encodeBlueprintDocument(raw), name: "official", values: {} });
  assert.ok(preview.planId, JSON.stringify(preview.diagnostics));
  const outcome = await f.wb.apply(preview.planId, context().ctx);
  assert.equal(outcome.stages.presets.status, "succeeded");
  assert.deepEqual(f.calls, ["create:official", "prepare:alpha", "install:alpha"]);
  const manifest = JSON.parse(readFileSync(join(f.home, "profiles", "space-official", "package.json"), "utf8"));
  assert.deepEqual(manifest.dsh.profile.bundles, [...HOST.slice(0, 2), builtin, "alpha"]);
  assert.equal(outcome.host.dsh, "0.2.0-rc.2"); assert.equal(outcome.stages.start.status, "not-run");
  const origin = JSON.parse(readFileSync(join(f.home, "hub", "space-official", "blueprint-origin.json"), "utf8"));
  assert.deepEqual(parseStandalone(encodeBlueprintDocument(origin.blueprint)), raw);
  assert.equal(existsSync(join(f.home, "profiles", "web")), false);
  assert.equal(existsSync(join(f.home, "sessions")), false);
  assert.equal(existsSync(join(f.home, "storages")), false);
});
