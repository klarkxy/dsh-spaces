import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { gte } from "semver";
import { assertSettingsIsolation, alignProfileComponents } from "../../src/adapters/node/profile/profile-component-alignment.ts";
import { SupervisorSpaceLifecycle } from "../../src/adapters/node/supervisor/space-lifecycle.ts";

type Bridge = "view-bridge" | "llm-bridge" | "browser";
type Row = { id?: string; name?: string; disabled?: unknown };
type OfficialBoot = {
  getDshRuntimeVersion: () => string;
  loadProfileDirectory: (prefix: string, profile: string, anchor: string) => {
    layers: { patches: unknown[] }[]; patches: unknown[]; skippedBundles: { packageName: string }[];
  };
  composeEntries: (layers: unknown[][]) => Row[];
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const require = createRequire(import.meta.url);
const officialPath = process.env.DSH_COMPAT_APP_BOOT ?? require.resolve("@deepseek-ai/dsh-app-boot");
const boot = await import(pathToFileURL(officialPath).href) as OfficialBoot;
const officialVersion = boot.getDshRuntimeVersion();

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dsh-profile-02-")); roots.push(home);
  const profile = join(home, "profiles", "writing");
  const payloadRoot = join(home, "selected");
  const runtime = join(home, "runtime");
  const bin = join(runtime, "lib", "bin.js");
  const anchor = join(runtime, "package.json");
  mkdirSync(join(runtime, "lib"), { recursive: true });
  writeFileSync(anchor, JSON.stringify({ name: "@deepseek-ai/dsh", version: officialVersion, type: "module" }));
  writeFileSync(bin, "export {};\n");
  // Bind the actual installed 0.2 composer, without booting a DSH host.
  const bootFacade = join(runtime, "node_modules", "@deepseek-ai", "dsh-app-boot");
  mkdirSync(bootFacade, { recursive: true });
  writeFileSync(join(bootFacade, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", type: "module", main: "index.js" }));
  writeFileSync(join(bootFacade, "index.js"), `export * from ${JSON.stringify(pathToFileURL(officialPath).href)};\n`);
  const installed = (name: string) => join(profile, "node_modules", name);
  const bundles = ["fixture-base", "@dsh-spaces/view-bridge", "@dsh-spaces/llm-bridge"];
  mkdirSync(profile, { recursive: true });
  const manifestPath = join(profile, "package.json");
  writeFileSync(manifestPath, JSON.stringify({ name: "writing", dsh: { profile: { bundles } } }));
  const patch = join(profile, "cordis.patch.yml");
  writeFileSync(patch, "# user configuration stays byte-identical\n- id: fixture-local\n  config:\n    provider: local\n    root: custom-storage\n");
  const writeBundle = (name: string, peer: string, contents: string) => {
    const dir = installed(name);
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } }, peerDependencies: { "@deepseek-ai/dsh-settings": peer } }));
    writeFileSync(join(dir, "cordis.patch.yml"), contents);
    writeFileSync(join(dir, "lib/index.js"), "throw new Error('user plugin must not execute during admission');\n");
    return dir;
  };
  writeBundle("fixture-base", ">=0.2.0-rc.2", "- insert:\n    - id: settings\n      name: fixture-base\n    - id: fixture-local\n      name: fixture-base\n");
  for (const bridge of ["view-bridge", "llm-bridge"] as Bridge[]) {
    const name = `@dsh-spaces/${bridge}`;
    const dir = writeBundle(name, ">=0.2.0-rc.2", `- insert:\n    - id: dsh-spaces-${bridge}\n      name: '${name}'\n` + (bridge === "view-bridge" ? "- id: settings\n  disabled: true\n- insert:\n    - id: dsh-spaces-settings\n      name: '@dsh-spaces/view-bridge/settings'\n" : ""));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (bridge === "view-bridge") pkg.peerDependencies["@deepseek-ai/dsh-client-connection"] = ">=0.2.0-rc.2";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    cpSync(dir, join(payloadRoot, bridge), { recursive: true });
    for (const key of Object.keys(pkg.peerDependencies)) pkg.peerDependencies[key] = "^0.1.7-alpha.1";
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  }
  const calls: string[] = [];
  const dumps: { skipped: string[]; rows: Row[] }[] = [];
  const input = {
    home, profileId: "writing", payloadRoot, bin, cliVersion: officialVersion,
    install: async (bridge: Bridge) => { calls.push(bridge); cpSync(join(payloadRoot, bridge), installed(`@dsh-spaces/${bridge}`), { recursive: true }); },
    dump: async () => {
      const loaded = boot.loadProfileDirectory("dsh", profile, anchor);
      const rows = boot.composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]);
      dumps.push({ skipped: loaded.skippedBundles.map(row => row.packageName), rows });
      return JSON.stringify(rows);
    },
  };
  const add = (name: string, peer: string, selected = true) => {
    writeBundle(name, peer, `- insert:\n    - id: '${name}'\n      name: '${name}'\n`);
    if (selected) {
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
      pkg.dsh.profile.bundles.push(name);
      writeFileSync(manifestPath, JSON.stringify(pkg));
    }
  };
  return { input, home, profile, patch, manifestPath, installed, calls, dumps, add, marker: join(profile, ".dsh-spaces-component-alignment.json") };
}

for (const engineAccepts of [true, false]) {
  test(`bound host applies its own engine precedence before alignment: engine accepts=${engineAccepts}`, async () => {
    const f = fixture();
    f.add("engine-fixture", engineAccepts ? "<0.1.0" : ">=0.2.0-0");
    const manifestPath = join(f.installed("engine-fixture"), "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.engines = { dsh: engineAccepts ? ">=0.2.0-0" : "<0.1.0" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = readFileSync(f.patch, "utf8");
    const accepts = gte(officialVersion, "0.2.1-alpha.4") ? engineAccepts : !engineAccepts;
    if (accepts) await alignProfileComponents(f.input);
    else {
      await assert.rejects(alignProfileComponents(f.input), /engine-fixture.*cannot load/);
      assert.deepEqual(f.calls, []);
      assert.equal(existsSync(f.marker), false);
      assert.equal(readFileSync(f.patch, "utf8"), before);
    }
  });
}

test("omitted CLI version is derived from the selected official app-boot", async () => {
  const f = fixture();
  f.add("exact-host-fixture", officialVersion);
  const { cliVersion: _version, ...input } = f.input;
  await alignProfileComponents(input);
});

for (const state of ["!!js (() => { throw new Error('ancestor must not execute') })()", "true"]) {
  test(`literal native settings inactivity dominates ${state} parent intent`, () => {
    const dump = `- id: native-parent\n  name: cordis:group\n  group: true\n  disabled: ${state}\n  config:\n    - id: settings\n      disabled: true\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n`;
    assert.doesNotThrow(() => assertSettingsIsolation(dump));
  });
}

test("literal inherited inactivity dominates an enabled native settings leaf", () => {
  assert.doesNotThrow(() => assertSettingsIsolation("- id: parent\n  group: true\n  disabled: true\n  config:\n    - id: settings\n      disabled: false\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n"));
});

test("unknown native settings inactivity remains rejected when no literal true settles it", () => {
  assert.throws(() => assertSettingsIsolation("- id: parent\n  group: true\n  disabled: !!js process.env.UNKNOWN\n  config:\n    - id: settings\n      disabled: false\n- id: dsh-spaces-settings\n  name: '@dsh-spaces/view-bridge/settings'\n"), /scoped settings/);
});

test("0.2 omitted bundle layers do not turn an enabled LLM bridge into disabled intent", async () => {
  const f = fixture(); const before = readFileSync(f.patch);
  await alignProfileComponents(f.input);
  assert.deepEqual(f.dumps[0]!.skipped, ["@dsh-spaces/view-bridge", "@dsh-spaces/llm-bridge"]);
  assert.equal(f.dumps[0]!.rows.some(row => row.id === "dsh-spaces-llm-bridge"), false);
  assert.deepEqual(f.calls, ["view-bridge", "llm-bridge"]);
  assert.ok(readFileSync(f.patch).equals(before));
  assert.equal(f.dumps.at(-1)!.rows.find(row => row.id === "settings")?.disabled, true);
  assert.equal(f.dumps.at(-1)!.rows.find(row => row.id === "dsh-spaces-llm-bridge")?.disabled, undefined);
  assert.equal(existsSync(f.marker), false);
  await alignProfileComponents(f.input);
  assert.equal(f.calls.length, 2);
});

for (const value of [true, false]) test(`explicit LLM disabled=${value} survives absent old layers`, async () => {
  const f = fixture();
  writeFileSync(f.patch, readFileSync(f.patch, "utf8") + `- id: dsh-spaces-llm-bridge\n  disabled: ${value}\n`);
  const before = readFileSync(f.patch);
  const old = readFileSync(join(f.installed("@dsh-spaces/llm-bridge"), "package.json"));
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls, value ? ["view-bridge"] : ["view-bridge", "llm-bridge"]);
  assert.ok(readFileSync(f.patch).equals(before));
  if (value) assert.ok(readFileSync(join(f.installed("@dsh-spaces/llm-bridge"), "package.json")).equals(old));
  else assert.equal(f.dumps.at(-1)!.rows.find(row => row.id === "dsh-spaces-llm-bridge")?.disabled, false);
});

test("dynamic bridge intent rejects before installation even when dump would omit it", async () => {
  const f = fixture();
  writeFileSync(f.patch, readFileSync(f.patch, "utf8") + "- id: dsh-spaces-llm-bridge\n  disabled: !!js process.env.UNKNOWN\n");
  await assert.rejects(alignProfileComponents(f.input), /Dynamic/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

test("dynamic ordinary plugin enablement is inspected without evaluating its expression", async () => {
  const f = fixture(); f.add("third-party-dynamic", ">=0.2.0-rc.2");
  writeFileSync(f.patch, readFileSync(f.patch, "utf8") + "- id: third-party-dynamic\n  disabled: !!js (() => { throw new Error('expression must not execute') })()\n");
  const before = readFileSync(f.patch);
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls, ["view-bridge", "llm-bridge"]);
  assert.ok(readFileSync(f.patch).equals(before));
});

test("dynamic ordinary enablement does not hide a real incompatible peer", async () => {
  const f = fixture(); f.add("third-party-dynamic", "^0.1.7-alpha.1");
  writeFileSync(f.patch, readFileSync(f.patch, "utf8") + "- id: third-party-dynamic\n  disabled: !!js process.env.UNKNOWN\n");
  await assert.rejects(alignProfileComponents(f.input), /third-party-dynamic.*cannot load/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

function groupBridge(f: ReturnType<typeof fixture>, bridge: Bridge, state: string): void {
  writeFileSync(join(f.installed(`@dsh-spaces/${bridge}`), "cordis.patch.yml"), `- insert:\n    - id: bridge-parent\n      name: cordis:group\n      group: true\n      disabled: ${state}\n      config:\n        - id: dsh-spaces-${bridge}\n          name: '@dsh-spaces/${bridge}'\n`);
}

test("a literal disabled parent preserves the inactive LLM bridge", async () => {
  const f = fixture(); groupBridge(f, "llm-bridge", "true");
  const before = readFileSync(join(f.installed("@dsh-spaces/llm-bridge"), "package.json"));
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls, ["view-bridge"]);
  assert.ok(readFileSync(join(f.installed("@dsh-spaces/llm-bridge"), "package.json")).equals(before));
});

test("dynamic parent intent for a managed LLM bridge rejects before writes", async () => {
  const f = fixture(); groupBridge(f, "llm-bridge", "!!js process.env.UNKNOWN");
  await assert.rejects(alignProfileComponents(f.input), /Dynamic managed bridge ancestry/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

test("a disabled parent cannot provide the required managed view bridge", async () => {
  const f = fixture(); groupBridge(f, "view-bridge", "true");
  await assert.rejects(alignProfileComponents(f.input), /no active canonical view bridge/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

test("a disabled ordinary group does not admit its inactive incompatible child", async () => {
  const f = fixture(); f.add("third-party-grouped", "^0.1.7-alpha.1");
  writeFileSync(join(f.installed("third-party-grouped"), "cordis.patch.yml"), "- insert:\n    - id: custom-parent\n      name: cordis:group\n      group: true\n      disabled: true\n      config:\n        - id: custom-child\n          name: third-party-grouped\n");
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls, ["view-bridge", "llm-bridge"]);
});

const officialBin = process.env.DSH_PROFILE_TRANSITION_OFFICIAL_BIN ?? join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
test("actual official 0.2 web profile dynamic defaults admit current managed bridge bytes", { skip: !existsSync(officialBin) }, async () => {
  const f = fixture(); const anchor = join(dirname(dirname(officialBin)), "package.json");
  const boundBoot = await import(pathToFileURL(createRequire(officialBin).resolve("@deepseek-ai/dsh-app-boot")).href) as OfficialBoot;
  assert.equal(JSON.parse(readFileSync(anchor, "utf8")).version, boundBoot.getDshRuntimeVersion());
  const pkg = JSON.parse(readFileSync(f.manifestPath, "utf8"));
  pkg.dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-spaces/view-bridge", "@dsh-spaces/llm-bridge"];
  writeFileSync(f.manifestPath, JSON.stringify(pkg));
  for (const bridge of ["view-bridge", "llm-bridge"] as Bridge[]) cpSync(join(f.input.payloadRoot, bridge), f.installed(`@dsh-spaces/${bridge}`), { recursive: true });
  f.input.bin = officialBin;
  f.input.cliVersion = boundBoot.getDshRuntimeVersion();
  let dynamicRows = 0;
  f.input.dump = async () => {
    const loaded = boundBoot.loadProfileDirectory("dsh", f.profile, anchor);
    assert.deepEqual(loaded.skippedBundles, []);
    const rows = boundBoot.composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]);
    dynamicRows = rows.filter(row => row.disabled !== undefined && typeof row.disabled !== "boolean").length;
    return JSON.stringify(rows);
  };
  const before = readFileSync(f.patch);
  await alignProfileComponents(f.input);
  assert.ok(dynamicRows > 0, "the regression must include actual expression-controlled native rows");
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
  assert.ok(readFileSync(f.patch).equals(before));
});

test("an incompatible third-party bundle rejects before alignment writes despite a later compatible peer", async () => {
  const f = fixture(); f.add("third-party-old", "^0.1.7-alpha.1"); f.add("third-party-current", ">=0.2.0-rc.2");
  const patchBefore = readFileSync(f.patch); const manifestBefore = readFileSync(f.manifestPath);
  await assert.rejects(alignProfileComponents(f.input), /third-party-old.*cannot load/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
  assert.ok(readFileSync(f.patch).equals(patchBefore)); assert.ok(readFileSync(f.manifestPath).equals(manifestBefore));
});

test("an incompatible directly inserted plugin rejects even if a target dump could mark it disabled", async () => {
  const f = fixture(); f.add("third-party-old", "^0.1.7-alpha.1", false);
  writeFileSync(f.patch, readFileSync(f.patch, "utf8") + "- insert:\n    - id: custom\n      name: third-party-old\n");
  const dump = f.input.dump;
  f.input.dump = async () => JSON.stringify(JSON.parse(await dump()).map((row: Row) => row.id === "custom" ? { ...row, disabled: true } : row));
  await assert.rejects(alignProfileComponents(f.input), /third-party-old.*cannot load/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

test("a bare DSH peer incompatibility rejects before writes when the official host skips its bundle", async () => {
  const f = fixture(); f.add("third-party-bare", "*");
  const path = join(f.installed("third-party-bare"), "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")); pkg.peerDependencies = { "@deepseek-ai/dsh": "^0.1.7-alpha.1" };
  writeFileSync(path, JSON.stringify(pkg));
  const before = readFileSync(f.patch);
  await assert.rejects(alignProfileComponents(f.input), /third-party-bare.*@deepseek-ai\/dsh@\^0\.1\.7-alpha\.1/);
  assert.ok(f.dumps[0]!.skipped.includes("third-party-bare"));
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false); assert.ok(readFileSync(f.patch).equals(before));
});

for (const token of ["workspace:^", "workspace:~", "workspace:*"]) test(`official ${token} peers admit the unchanged third-party bundle`, async () => {
  const f = fixture(); f.add("third-party-workspace", token);
  const path = join(f.installed("third-party-workspace"), "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")); pkg.peerDependencies["@deepseek-ai/dsh"] = token;
  writeFileSync(path, JSON.stringify(pkg)); const before = readFileSync(path);
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls, ["view-bridge", "llm-bridge"]);
  assert.ok(readFileSync(path).equals(before));
  assert.ok(f.dumps.at(-1)!.rows.some(row => row.id === "third-party-workspace"));
  assert.equal(f.dumps.at(-1)!.skipped.includes("third-party-workspace"), false);
});

for (const peers of [null, [], { "@deepseek-ai/dsh": 2 }, { "@deepseek-ai/dsh-settings": "invalid range" }, { "@deepseek-ai/dsh": "" }, { "unrelated-peer": 42 }]) {
  test(`invalid peer contract ${JSON.stringify(peers)} rejects before writes`, async () => {
    const f = fixture(); f.add("third-party-invalid", "*");
    const path = join(f.installed("third-party-invalid"), "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8")); pkg.peerDependencies = peers;
    writeFileSync(path, JSON.stringify(pkg));
    await assert.rejects(alignProfileComponents(f.input), /peerDependencies|cannot load/);
    assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
  });
}

test("selected payload bare DSH peers are checked before the known bridge transition", async () => {
  const f = fixture();
  const path = join(f.input.payloadRoot, "view-bridge", "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")); pkg.peerDependencies["@deepseek-ai/dsh"] = "^0.1.7-alpha.1";
  writeFileSync(path, JSON.stringify(pkg));
  await assert.rejects(alignProfileComponents(f.input), /cannot load.*@deepseek-ai\/dsh@/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

test("disabled and dependency-only third-party packages stay installed and untouched", async () => {
  const f = fixture(); f.add("third-party-old", "^0.1.7-alpha.1"); f.add("dependency-only", "^0.1.7-alpha.1", false);
  writeFileSync(f.patch, readFileSync(f.patch, "utf8") + "- id: third-party-old\n  disabled: true\n");
  const old = readFileSync(join(f.installed("third-party-old"), "package.json"));
  await alignProfileComponents(f.input);
  assert.ok(readFileSync(join(f.installed("third-party-old"), "package.json")).equals(old));
  assert.deepEqual(f.calls, ["view-bridge", "llm-bridge"]);
});

test("the old management plugin has no transition exemption", async () => {
  const f = fixture(); f.add("@dsh-spaces/plugin", "^0.1.7-alpha.1");
  await assert.rejects(alignProfileComponents(f.input), /@dsh-spaces\/plugin.*cannot load/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

test("current selected bytes with changed code are reinstalled from the selected payload", async () => {
  const f = fixture();
  for (const bridge of ["view-bridge", "llm-bridge"] as Bridge[]) cpSync(join(f.input.payloadRoot, bridge), f.installed(`@dsh-spaces/${bridge}`), { recursive: true });
  writeFileSync(join(f.installed("@dsh-spaces/view-bridge"), "lib/index.js"), "changed current code");
  await alignProfileComponents(f.input);
  assert.deepEqual(f.calls, ["view-bridge"]);
  assert.equal(readFileSync(join(f.installed("@dsh-spaces/view-bridge"), "lib/index.js"), "utf8"), readFileSync(join(f.input.payloadRoot, "view-bridge", "lib/index.js"), "utf8"));
  assert.equal(existsSync(f.marker), false);
});

test("a CLI that cannot load the selected target rejects before alignment writes", async () => {
  const f = fixture(); f.input.cliVersion = "0.1.7-alpha.1";
  const basePath = join(f.installed("fixture-base"), "package.json");
  const base = JSON.parse(readFileSync(basePath, "utf8")); base.peerDependencies["@deepseek-ai/dsh-settings"] = "*";
  writeFileSync(basePath, JSON.stringify(base));
  await assert.rejects(alignProfileComponents(f.input), /cannot load/);
  assert.deepEqual(f.calls, []); assert.equal(existsSync(f.marker), false);
});

test("a target host denying the aligned LLM row leaves failure evidence and prevents replay", async () => {
  const f = fixture(); const dump = f.input.dump;
  f.input.dump = async () => JSON.stringify(JSON.parse(await dump()).map((row: Row) => row.id === "dsh-spaces-llm-bridge" ? { ...row, disabled: true } : row));
  await assert.rejects(alignProfileComponents(f.input), /denied by the target host/);
  assert.equal(JSON.parse(readFileSync(f.marker, "utf8")).target, officialVersion);
  await assert.rejects(alignProfileComponents(f.input), /Interrupted component alignment/);
  assert.deepEqual(f.calls, ["view-bridge", "llm-bridge"]);
});

test("a target dump disabled parent does not make its aligned LLM child look active", async () => {
  const f = fixture(); const dump = f.input.dump;
  f.input.dump = async () => {
    const rows: Row[] = JSON.parse(await dump());
    const llm = rows.find(row => row.id === "dsh-spaces-llm-bridge");
    if (!llm) return JSON.stringify(rows);
    return JSON.stringify([...rows.filter(row => row !== llm), { id: "denied-parent", name: "cordis:group", group: true, disabled: true, config: [llm] }]);
  };
  await assert.rejects(alignProfileComponents(f.input), /denied by the target host/);
  assert.equal(existsSync(f.marker), true);
  assert.deepEqual(f.calls, ["view-bridge", "llm-bridge"]);
});

test("a patch changed during component installation keeps the mutation and marker instead of restoring it", async () => {
  const f = fixture(); const install = f.input.install;
  f.input.install = async bridge => { await install(bridge); writeFileSync(f.patch, "# externally changed\n[]\n"); };
  await assert.rejects(alignProfileComponents(f.input), /patch changed/);
  assert.equal(readFileSync(f.patch, "utf8"), "# externally changed\n[]\n");
  assert.equal(existsSync(f.marker), true);
});

test("Supervisor start admits the known transition under its writer lock before spawning", async () => {
  const f = fixture(); const steps: string[] = []; const archiveIds: string[] = [];
  const startOwned = (SupervisorSpaceLifecycle.prototype as unknown as { startOwned(id: string): Promise<void> }).startOwned;
  const host = {
    home: f.home, runs: { unmanaged: new Set<string>() },
    options: { componentPayloadRoot: f.input.payloadRoot, viewBridgeArtifact: join(f.home, "view.tgz"), llmBridgeArtifact: join(f.home, "llm.tgz") },
    lifecycle: { assertWritable: () => { steps.push("guard"); } }, statusOf: () => "stopped",
    managerId: () => null,
    pinnedDshVersion: () => undefined,
    resolveSpaceRuntime: () => ({ bin: f.input.bin, version: f.input.cliVersion }),
    processes: () => ({ start: async () => { steps.push("spawn"); } }),
    lock: { run: async (_name: string, action: () => Promise<void>) => { steps.push("lock"); await action(); steps.push("unlock"); } },
    installComponent: async (_id: string, component: Bridge) => {
      steps.push("install");
      const artifact = component === "view-bridge" ? host.options.viewBridgeArtifact : host.options.llmBridgeArtifact;
      const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex").slice(0, 20);
      archiveIds.push(`dsh-spaces-${component}-${digest}`);
      await f.input.install(component);
    },
    ensureBundledDeps: async () => { steps.push("deps"); },
    readDump: f.input.dump,
  };
  const supervisor = { host };
  writeFileSync(host.options.viewBridgeArtifact, "view archive"); writeFileSync(host.options.llmBridgeArtifact, "llm archive");
  await startOwned.call(supervisor, "writing");
  assert.deepEqual(steps, ["guard", "lock", "deps", "install", "install", "unlock", "spawn"]);
  assert.match(archiveIds[0]!, /^dsh-spaces-view-bridge-[0-9a-f]{20}$/);
  assert.match(archiveIds[1]!, /^dsh-spaces-llm-bridge-[0-9a-f]{20}$/);
  f.add("third-party-old", "^0.1.7-alpha.1"); steps.length = 0;
  await assert.rejects(startOwned.call(supervisor, "writing"), /cannot load/);
  assert.deepEqual(steps, ["guard", "lock", "deps"]);
});
