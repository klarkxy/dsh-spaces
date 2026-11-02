import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { COMPATIBLE_DSH_CLI_VERSION } from "../../src/adapters/node/products/spaces-service.ts";
import {
  COMPONENT_PAYLOAD_PACKAGES,
  writeComponentPayloadManifest,
} from "../../src/adapters/node/payload/component-payload.ts";
import {
  bootstrapSupervisor,
  COMPONENT_PAYLOAD_ARGV_FLAG,
  LLM_BRIDGE_PAYLOAD_DIRNAME,
  SUPERVISOR_CLI_FLAGS,
} from "../../packages/plugin/src/host/supervisor-bootstrap.ts";
import { packLocalArtifacts } from "../../packages/plugin/src/host/supervisor-pack.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeRel(root: string, rel: string, content: string): void {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function writeNamedPackage(root: string, name: string, version = "0.2.0"): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name, version })}\n`);
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "index.js"), "export {};\n");
  return root;
}

function writeV2Plugin(pluginRoot: string): string {
  const pkg = (name: string) => `${JSON.stringify({ name, version: "0.2.0" })}\n`;
  const files: Array<[string, string]> = [
    ["package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["manager-plugin"])],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["lib/index.js", "export {};\n"],
    ["lib/typert.host.js", "export {};\n"],
    ["lib/typert.remote-client.js", "export {};\n"],
    ["lib/client.js", "export {};\n"],
    ["lib/supervisor/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.supervisor)],
    ["lib/supervisor/index.js", "export {};\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export {};\n"],
    ["lib/view-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["view-bridge"])],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/lib/index.js", "export {};\n"],
    ["lib/view-bridge/lib/client.js", "export {};\n"],
    ["lib/view-bridge/lib/settings.js", "export {};\n"],
    ["lib/view-bridge/lib/typert.host.js", "export {};\n"],
    ["lib/browser/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.browser)],
    ["lib/browser/cordis.patch.yml", "browser: dummy\n"],
    ["lib/browser/lib/index.js", "export {};\n"],
    ["lib/browser/lib/client.js", "export {};\n"],
    ["lib/browser/lib/typert.host.js", "export {};\n"],
    ["lib/llm-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["llm-bridge"])],
    ["lib/llm-bridge/cordis.patch.yml", "llm: dummy\n"],
    ["lib/llm-bridge/lib/index.js", "export {};\n"],
    ["lib/llm-bridge/lib/auxiliary.js", "export {};\n"],
  ];
  for (const [rel, content] of files) writeRel(pluginRoot, rel, content);
  writeComponentPayloadManifest(join(pluginRoot, "lib"));
  return join(pluginRoot, "lib");
}

function writeCli(root: string): string {
  const pkg = join(root, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@deepseek-ai/dsh", version: COMPATIBLE_DSH_CLI_VERSION })}\n`);
  const bin = join(pkg, "lib", "bin.js");
  writeFileSync(bin, "export {};\n");
  return bin;
}

async function stubPack(request: { packageRoot: string; destination: string }): Promise<string> {
  mkdirSync(request.destination, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(request.packageRoot, "package.json"), "utf8")) as { name?: string };
  const name = pkg.name === "@dsh-spaces/llm-bridge"
    ? "llm-bridge-0.2.0.tgz"
    : pkg.name === "@dsh-spaces/view-bridge"
      ? "view-bridge-0.2.0.tgz"
      : "plugin-0.2.0.tgz";
  const path = join(request.destination, name);
  writeFileSync(path, "tarball");
  return path;
}

test("packLocalArtifacts packs llm-bridge when llmBridgeRoot is provided", async () => {
  const home = tempDir("dsh-pack-home-");
  const plugin = writeNamedPackage(tempDir("dsh-pack-plugin-"), "@dsh-spaces/plugin");
  const view = writeNamedPackage(tempDir("dsh-pack-view-"), "@dsh-spaces/view-bridge");
  const llm = writeNamedPackage(tempDir("dsh-pack-llm-"), "@dsh-spaces/llm-bridge");
  const dest = tempDir("dsh-pack-dest-");
  const packed = await packLocalArtifacts({
    home,
    pluginPackageRoot: plugin,
    viewBridgeRoot: view,
    llmBridgeRoot: llm,
    artifactDir: dest,
    execPath: process.execPath,
    pack: stubPack,
  });
  assert.equal("reasons" in packed, false);
  if ("reasons" in packed) return;
  assert.match(packed.pluginArtifact.replaceAll("\\", "/"), /plugin-0\.2\.0\.tgz$/);
  assert.match(packed.viewBridgeArtifact.replaceAll("\\", "/"), /view-bridge-0\.2\.0\.tgz$/);
  assert.ok(packed.llmBridgeArtifact);
  assert.match(packed.llmBridgeArtifact.replaceAll("\\", "/"), /llm-bridge-0\.2\.0\.tgz$/);
});

test("packLocalArtifacts omits llm-bridge when llmBridgeRoot is not provided", async () => {
  const packed = await packLocalArtifacts({
    home: tempDir("dsh-pack-home2-"),
    pluginPackageRoot: writeNamedPackage(tempDir("dsh-pack-plugin2-"), "@dsh-spaces/plugin"),
    viewBridgeRoot: writeNamedPackage(tempDir("dsh-pack-view2-"), "@dsh-spaces/view-bridge"),
    artifactDir: tempDir("dsh-pack-dest2-"),
    execPath: process.execPath,
    pack: stubPack,
  });
  assert.equal("reasons" in packed, false);
  if ("reasons" in packed) return;
  assert.equal(packed.llmBridgeArtifact, undefined);
});

test("packLocalArtifacts refuses a misnamed llm-bridge package", async () => {
  const packed = await packLocalArtifacts({
    home: tempDir("dsh-pack-home3-"),
    pluginPackageRoot: writeNamedPackage(tempDir("dsh-pack-plugin3-"), "@dsh-spaces/plugin"),
    viewBridgeRoot: writeNamedPackage(tempDir("dsh-pack-view3-"), "@dsh-spaces/view-bridge"),
    llmBridgeRoot: writeNamedPackage(tempDir("dsh-pack-llm3-"), "not-llm-bridge"),
    artifactDir: tempDir("dsh-pack-dest3-"),
    execPath: process.execPath,
    pack: stubPack,
  });
  assert.equal("reasons" in packed, true);
  if (!("reasons" in packed)) return;
  assert.ok(packed.reasons.some((row) => /llm-bridge/i.test(row)));
});

test("bootstrap packs selected llm-bridge and passes --llm-bridge-artifact", async () => {
  const home = tempDir("dsh-boot-home-");
  const payloadRoot = writeV2Plugin(tempDir("dsh-boot-plugin-"));
  const toolsRoot = tempDir("dsh-boot-tools-");
  const bin = writeCli(home);
  const spawned: string[][] = [];
  const packedRoots: string[] = [];
  const result = await bootstrapSupervisor({
    home,
    argv: [process.execPath, bin],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    payloadRoot,
    toolsRoot,
    allowColdStart: true,
    timeoutMs: 80,
    pollMs: 20,
    pack: async (request) => {
      packedRoots.push(request.packageRoot);
      return stubPack(request);
    },
    spawn: (request) => {
      spawned.push([...request.argv]);
    },
  });
  assert.equal(result.connected, false);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0]?.includes(SUPERVISOR_CLI_FLAGS.llmBridgeArtifact));
  assert.ok(spawned[0]?.some((row) => /llm-bridge-0\.2\.0\.tgz$/.test(row.replaceAll("\\", "/"))));
  assert.ok(packedRoots.some((root) => root.replaceAll("\\", "/").includes(`/${LLM_BRIDGE_PAYLOAD_DIRNAME}`)));
});

test("bootstrap links a source checkout without staging, pointer writes, or packing", async () => {
  const home = tempDir("dsh-boot-dev-home-");
  const checkout = tempDir("dsh-boot-dev-co-");
  writeFileSync(join(checkout, "package.json"), `${JSON.stringify({ name: "@dsh-spaces/plugin", private: true })}\n`);
  const payloadRoot = writeV2Plugin(join(checkout, "packages", "plugin"));
  const toolsRoot = tempDir("dsh-boot-dev-tools-");
  const bin = writeCli(home);
  const spawned: string[][] = [];
  let spawnedCwd = "";
  let packs = 0;
  const result = await bootstrapSupervisor({
    home,
    argv: [process.execPath, bin],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    payloadRoot,
    toolsRoot,
    allowColdStart: true,
    timeoutMs: 80,
    pollMs: 20,
    pack: async (request) => {
      packs += 1;
      return stubPack(request);
    },
    spawn: (request) => {
      spawned.push([...request.argv]);
      spawnedCwd = request.cwd;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(packs, 0, "a linked checkout is never packed");
  assert.equal(spawned.length, 1);
  assert.equal(spawnedCwd, toolsRoot, "dev supervisor must not pin the source lib as cwd");
  const argv = spawned[0]!;
  for (const flag of [
    SUPERVISOR_CLI_FLAGS.pluginArtifact,
    SUPERVISOR_CLI_FLAGS.viewBridgeArtifact,
    SUPERVISOR_CLI_FLAGS.browserArtifact,
    SUPERVISOR_CLI_FLAGS.llmBridgeArtifact,
  ]) {
    assert.equal(argv.includes(flag), false, flag);
  }
  const devIndex = argv.indexOf("--dev-checkout");
  assert.ok(devIndex > 0, JSON.stringify(argv));
  assert.equal(realpathSync(argv[devIndex + 1]!), realpathSync(checkout));
  assert.ok(argv.includes(COMPONENT_PAYLOAD_ARGV_FLAG));
  assert.equal(argv[argv.indexOf(COMPONENT_PAYLOAD_ARGV_FLAG) + 1], payloadRoot);
  assert.equal(existsSync(join(toolsRoot, "components")), false, "no staged copy");
  assert.equal(readdirSync(toolsRoot).some((name) => name.startsWith("selected-")), false, "no selected pointer");
});

test("bootstrap may stage a standard plugin install that lives inside a temp Home", async () => {
  const home = tempDir("dsh-boot-std-home-");
  const pluginRoot = join(home, "profiles", "web", "node_modules", "@dsh-spaces", "plugin");
  const payloadRoot = writeV2Plugin(pluginRoot);
  const toolsRoot = tempDir("dsh-boot-std-tools-");
  const bin = writeCli(home);
  let spawned = 0;
  const result = await bootstrapSupervisor({
    home,
    argv: [process.execPath, bin],
    env: { ...process.env, DSH_HOME: home },
    execPath: process.execPath,
    payloadRoot,
    toolsRoot,
    allowColdStart: true,
    timeoutMs: 80,
    pollMs: 20,
    pack: stubPack,
    spawn: () => {
      spawned += 1;
    },
  });
  assert.equal(result.connected, false);
  assert.equal(spawned, 1);
});
