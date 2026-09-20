import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { COMPONENT_PAYLOAD_PACKAGES, writeComponentPayloadManifest } from "../src/adapters/node/component-payload.ts";
import {
  COLD_START_LOCK_NAME,
  ComponentSelectionError,
  readSelectedComponentPayload,
  selectComponentPayload,
  selectedPointerPath,
  stageComponentPayload,
} from "../src/adapters/node/component-selection.ts";
import {
  HomeControlBusyError,
  HomeController,
  homeControlDigest,
} from "../src/adapters/node/home-controller.ts";
import { deriveServiceEpoch } from "../src/adapters/node/workbench-protocol.ts";

describe("component-selection", { concurrency: 1 }, () => {
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

function dummyPayload(): { root: string; lib: string } {
  const root = tempDir("dsh-sel-payload-");
  const files: Array<[string, string]> = [
    ["package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["manager-plugin"], version: "1.0.0" })}\n`],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["LICENSE", "plugin-license\n"],
    ["lib/index.js", "export const plugin = 1;\n"],
    ["lib/typert.host.js", "export const host = 1;\n"],
    ["lib/typert.remote-client.js", "export const remote = 1;\n"],
    ["lib/client.js", "export const client = 1;\n"],
    ["lib/supervisor/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES.supervisor, version: "2.0.0" })}\n`],
    ["lib/supervisor/index.js", "export const supervisor = 1;\n"],
    ["lib/supervisor/launcher.mjs", "export const launcher = 1;\n"],
    ["lib/supervisor/LICENSE", "supervisor-license\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export const worker = 1;\n"],
    ["lib/view-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["view-bridge"], version: "3.0.0" })}\n`],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/LICENSE", "view-license\n"],
    ["lib/view-bridge/lib/index.js", "export const view = 1;\n"],
    ["lib/view-bridge/lib/client.js", "export const viewClient = 1;\n"],
    ["lib/llm-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], version: "4.0.0" })}\n`],
    ["lib/llm-bridge/cordis.patch.yml", "llm: dummy\n"],
    ["lib/llm-bridge/LICENSE", "llm-license\n"],
    ["lib/llm-bridge/lib/index.js", "export const llm = 1;\n"],
  ];
  for (const [rel, content] of files) writeRel(root, rel, content);
  return { root, lib: join(root, "lib") };
}

test("stage copies the v2 payload under components/<digest> outside Home", () => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const { root, lib } = dummyPayload();
  const source = writeComponentPayloadManifest(lib);
  const staged = stageComponentPayload(home, tools, lib);
  assert.equal(staged.digest, source.digest);
  assert.equal(staged.packageRoot, join(tools, "components", source.digest));
  assert.equal(readSelectedComponentPayload(home, tools), undefined);
  assert.equal(source.files.some((file) => file.path === "src/secret.ts"), false);
  assert.ok(!staged.packageRoot.startsWith(home));
});

test("stage reads a validated payload from profiles/web inside the target Home", () => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const pluginRoot = join(home, "profiles", "web", "node_modules", "@dsh-spaces", "plugin");
  const files: Array<[string, string]> = [
    ["package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["manager-plugin"], version: "1.0.0" })}\n`],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["LICENSE", "plugin-license\n"],
    ["lib/index.js", "export const plugin = 1;\n"],
    ["lib/typert.host.js", "export const host = 1;\n"],
    ["lib/typert.remote-client.js", "export const remote = 1;\n"],
    ["lib/client.js", "export const client = 1;\n"],
    ["lib/supervisor/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES.supervisor, version: "2.0.0" })}\n`],
    ["lib/supervisor/index.js", "export const supervisor = 1;\n"],
    ["lib/supervisor/launcher.mjs", "export const launcher = 1;\n"],
    ["lib/supervisor/LICENSE", "supervisor-license\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export const worker = 1;\n"],
    ["lib/view-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["view-bridge"], version: "3.0.0" })}\n`],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/LICENSE", "view-license\n"],
    ["lib/view-bridge/lib/index.js", "export const view = 1;\n"],
    ["lib/view-bridge/lib/client.js", "export const viewClient = 1;\n"],
    ["lib/llm-bridge/package.json", `${JSON.stringify({ name: COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], version: "4.0.0" })}\n`],
    ["lib/llm-bridge/cordis.patch.yml", "llm: dummy\n"],
    ["lib/llm-bridge/LICENSE", "llm-license\n"],
    ["lib/llm-bridge/lib/index.js", "export const llm = 1;\n"],
  ];
  for (const [rel, content] of files) writeRel(pluginRoot, rel, content);
  const lib = join(pluginRoot, "lib");
  const source = writeComponentPayloadManifest(lib);
  const staged = stageComponentPayload(home, tools, lib);
  assert.equal(staged.digest, source.digest);
  assert.equal(staged.packageRoot, join(tools, "components", source.digest));
  assert.equal(readFileSync(join(lib, "index.js"), "utf8"), "export const plugin = 1;\n");
});

test("stage refuses a tools root inside Home", () => {
  const home = tempDir("dsh-sel-home-");
  const nested = join(home, "tools");
  mkdirSync(nested);
  const { lib } = dummyPayload();
  writeComponentPayloadManifest(lib);
  assert.throws(() => stageComponentPayload(home, nested, lib), ComponentSelectionError);
});

test("stage refuses a components junction that redirects into Home", (t) => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const { lib } = dummyPayload();
  const source = writeComponentPayloadManifest(lib);
  try {
    symlinkSync(home, join(tools, "components"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`directory junction is not testable on this Windows account: ${String(error)}`);
    return;
  }
  assert.throws(() => stageComponentPayload(home, tools, lib), /symlink or junction|outside Home|path alias/);
  assert.equal(existsSync(join(home, source.digest)), false);
  assert.equal(readSelectedComponentPayload(home, tools), undefined);
});

test("readSelected throws and keeps invalid pointer bytes", () => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const pointer = selectedPointerPath(tools, homeControlDigest(home));
  writeFileSync(pointer, "{broken\n");
  const before = readFileSync(pointer);
  assert.throws(() => readSelectedComponentPayload(home, tools), ComponentSelectionError);
  assert.deepEqual(readFileSync(pointer), before);
});

test("select requires a cold-start reservation when no owner is held", () => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const { lib } = dummyPayload();
  const staged = stageComponentPayload(home, tools, writeComponentPayloadManifest(lib).payloadRootLib);
  assert.throws(() => selectComponentPayload(home, tools, staged.digest), /reservation|occupancy/);
  assert.equal(readSelectedComponentPayload(home, tools), undefined);
  mkdirSync(join(tools, COLD_START_LOCK_NAME));
  const selected = selectComponentPayload(home, tools, staged.digest);
  assert.equal(selected.digest, staged.digest);
  const again = readSelectedComponentPayload(home, tools);
  assert.ok(again);
  assert.equal(again.digest, staged.digest);
});

test("select refuses a live non-launcher owner and does not write a pointer", () => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const { lib } = dummyPayload();
  const staged = stageComponentPayload(home, tools, writeComponentPayloadManifest(lib).payloadRootLib);
  mkdirSync(join(tools, COLD_START_LOCK_NAME));
  const controller = new HomeController(home);
  const handle = controller.acquire("web");
  assert.throws(() => selectComponentPayload(home, tools, staged.digest), ComponentSelectionError);
  assert.equal(readSelectedComponentPayload(home, tools), undefined);
  handle.release();
});

test("select is allowed for the current launcher occupancy", async () => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const { lib } = dummyPayload();
  const staged = stageComponentPayload(home, tools, writeComponentPayloadManifest(lib).payloadRootLib);
  const controller = new HomeController(home);
  const handle = controller.acquire("desktop");
  await controller.transferToLauncher({
    nonce: handle.owner.nonce,
    binding: {
      homeDigest: homeControlDigest(home),
      handoffId: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
      serviceEpoch: deriveServiceEpoch(handle.owner.nonce),
      artifactDigest: staged.digest,
    },
  });
  assert.throws(() => new HomeController(home).acquire("web"), HomeControlBusyError);
  const selected = selectComponentPayload(home, tools, staged.digest);
  assert.equal(selected.digest, staged.digest);
  assert.equal(readSelectedComponentPayload(home, tools)?.digest, staged.digest);
});

test("select refuses authorized occupancy; only launcher phase may switch the pointer", async () => {
  const home = tempDir("dsh-sel-home-");
  const tools = tempDir("dsh-sel-tools-");
  const { lib } = dummyPayload();
  const staged = stageComponentPayload(home, tools, writeComponentPayloadManifest(lib).payloadRootLib);
  const controller = new HomeController(home);
  const handle = controller.acquire("web");
  const token = await controller.transferToLauncher({
    nonce: handle.owner.nonce,
    binding: {
      homeDigest: homeControlDigest(home),
      handoffId: "a1b2c3d4e5f60718a1b2c3d4e5f60718",
      serviceEpoch: deriveServiceEpoch(handle.owner.nonce),
      artifactDigest: staged.digest,
    },
  });
  await controller.authorizeHandoff({
    token,
    target: { pid: process.pid, startedAt: new Date().toISOString() },
  });
  assert.throws(() => selectComponentPayload(home, tools, staged.digest), /launcher phase|authorization/);
  assert.equal(readSelectedComponentPayload(home, tools), undefined);
});
});
