import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMPONENT_PAYLOAD_MANIFEST_REL,
  COMPONENT_PAYLOAD_NAMES,
  COMPONENT_PAYLOAD_OPTIONAL_FILES,
  COMPONENT_PAYLOAD_PACKAGES,
  COMPONENT_PAYLOAD_PROTOCOL_VERSION,
  COMPONENT_PAYLOAD_REQUIRED_FILES,
  COMPONENT_PAYLOAD_SCHEMA_VERSION,
  ComponentPayloadError,
  copyComponentPayload,
  validateComponentPayload,
  writeComponentPayloadManifest,
  type ComponentPayloadManifest,
} from "../src/adapters/node/component-payload.ts";
import { PLUGIN_REQUIRED } from "../scripts/pack-spaces-plugin.mjs";

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

function pkg(name: string, version: string): string {
  return `${JSON.stringify({ name, version }, null, 2)}\n`;
}

function dummyTree(options: { skip?: string[] } = {}): { root: string; lib: string } {
  const root = tempDir("dsh-component-payload-");
  const skip = new Set(options.skip ?? []);
  const files: Array<[string, string]> = [
    ["package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["manager-plugin"], "1.0.0")],
    ["cordis.patch.yml", "plugin: dummy\n"],
    ["LICENSE", "plugin-license\n"],
    ["lib/index.js", "export const plugin = 1;\n"],
    ["lib/typert.host.js", "export const host = 1;\n"],
    ["lib/typert.remote-client.js", "export const remote = 1;\n"],
    ["lib/client.js", "export const client = 1;\n"],
    ["lib/supervisor/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES.supervisor, "2.0.0")],
    ["lib/supervisor/index.js", "export const supervisor = 1;\n"],
    ["lib/supervisor/launcher.mjs", "export const launcher = 1;\n"],
    ["lib/supervisor/LICENSE", "supervisor-license\n"],
    ["lib/supervisor/snapshot-worker.mjs", "export const worker = 1;\n"],
    ["lib/view-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["view-bridge"], "3.0.0")],
    ["lib/view-bridge/cordis.patch.yml", "view: dummy\n"],
    ["lib/view-bridge/LICENSE", "view-license\n"],
    ["lib/view-bridge/lib/index.js", "export const view = 1;\n"],
    ["lib/view-bridge/lib/client.js", "export const viewClient = 1;\n"],
    ["lib/view-bridge/lib/settings.js", "export const viewSettings = 1;\n"],
    ["lib/llm-bridge/package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], "4.0.0")],
    ["lib/llm-bridge/cordis.patch.yml", "llm: dummy\n"],
    ["lib/llm-bridge/LICENSE", "llm-license\n"],
    ["lib/llm-bridge/lib/index.js", "export const llm = 1;\n"],
    ["src/secret.ts", "should-not-copy\n"],
    ["node_modules/evil/index.js", "should-not-copy\n"],
  ];
  for (const [rel, content] of files) {
    if (skip.has(rel)) continue;
    writeRel(root, rel, content);
  }
  return { root, lib: join(root, "lib") };
}

function readManifest(root: string): ComponentPayloadManifest {
  return JSON.parse(readFileSync(join(root, ...COMPONENT_PAYLOAD_MANIFEST_REL.split("/")), "utf8")) as ComponentPayloadManifest;
}

function writeManifest(root: string, manifest: unknown): void {
  writeRel(root, COMPONENT_PAYLOAD_MANIFEST_REL, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("write and validate a complete five-component dummy payload", () => {
  const { root, lib } = dummyTree();
  const written = writeComponentPayloadManifest(lib);
  assert.equal(written.manifest.schemaVersion, COMPONENT_PAYLOAD_SCHEMA_VERSION);
  assert.equal(written.manifest.protocolVersion, COMPONENT_PAYLOAD_PROTOCOL_VERSION);
  assert.equal(written.manifest.entry, "index.js");
  assert.equal(written.manifest.version, "2.0.0");
  assert.match(written.digest, /^[a-f0-9]{64}$/);
  assert.equal(written.packageRoot, root);
  assert.deepEqual(
    COMPONENT_PAYLOAD_NAMES.map((name) => written.manifest.components[name].version),
    ["2.0.0", "1.0.0", "3.0.0", "4.0.0", "2.0.0"],
  );
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    const row = written.manifest.components[name];
    assert.equal(row.source, "bundled");
    assert.equal(row.protocolVersion, 2);
    assert.equal(row.packageName, COMPONENT_PAYLOAD_PACKAGES[name]);
    for (const rel of COMPONENT_PAYLOAD_REQUIRED_FILES[name]) {
      assert.ok(row.files.some((file) => file.path === rel), `${name} missing ${rel}`);
    }
  }
  assert.equal(
    written.files.some((file) => file.path === COMPONENT_PAYLOAD_MANIFEST_REL),
    false,
  );
  const again = validateComponentPayload(lib);
  assert.equal(again.digest, written.digest);
  assert.equal(again.files.length, written.files.length);
});

test("manifest identity must agree with the package bytes", () => {
  const { root, lib } = dummyTree();
  writeComponentPayloadManifest(lib);
  const manifest = readManifest(root);
  manifest.components["manager-plugin"].version = "9.9.9";
  writeManifest(root, manifest);
  assert.throws(() => validateComponentPayload(lib), /identity differs/);
});

test("write fails closed when llm-bridge assets are missing", () => {
  const { lib } = dummyTree({
    skip: ["lib/llm-bridge/package.json", "lib/llm-bridge/cordis.patch.yml", "lib/llm-bridge/lib/index.js", "lib/llm-bridge/LICENSE"],
  });
  assert.throws(() => writeComponentPayloadManifest(lib), ComponentPayloadError);
  assert.throws(() => writeComponentPayloadManifest(lib), /llm-bridge|missing/i);
});

test("write fails closed when the installation worker is missing", () => {
  const { lib } = dummyTree({ skip: ["lib/supervisor/snapshot-worker.mjs"] });
  assert.throws(() => writeComponentPayloadManifest(lib), ComponentPayloadError);
  assert.throws(() => writeComponentPayloadManifest(lib), /installation-worker|snapshot-worker/i);
});

test("validate rejects a v1 supervisor manifest", () => {
  const { root, lib } = dummyTree();
  writeManifest(root, { version: "2.0.0", entry: "index.js" });
  assert.throws(() => validateComponentPayload(lib), ComponentPayloadError);
  assert.throws(() => validateComponentPayload(lib), /schemaVersion/);
});

test("validate rejects unknown schema and protocol versions", () => {
  const { root, lib } = dummyTree();
  const valid = writeComponentPayloadManifest(lib).manifest;
  writeManifest(root, { ...valid, schemaVersion: 1 });
  assert.throws(() => validateComponentPayload(lib), /schemaVersion/);
  writeManifest(root, { ...valid, protocolVersion: 3 });
  assert.throws(() => validateComponentPayload(lib), /protocolVersion/);
});

test("validate rejects a missing llm-bridge component and a tampered file", () => {
  const { root, lib } = dummyTree();
  const valid = writeComponentPayloadManifest(lib).manifest;
  const { "llm-bridge": _omitted, ...rest } = valid.components;
  writeManifest(root, { ...valid, components: rest });
  assert.throws(() => validateComponentPayload(lib), /missing component llm-bridge/);

  writeManifest(root, valid);
  writeRel(root, "lib/index.js", "export const plugin = 2;\n");
  assert.throws(() => validateComponentPayload(lib), /sha256 does not match/);
});

test("validate rejects traversal, NUL, absolute paths, and listing the manifest", () => {
  const { root, lib } = dummyTree();
  const valid = writeComponentPayloadManifest(lib).manifest;
  const supervisor = valid.components.supervisor;
  writeManifest(root, {
    ...valid,
    components: {
      ...valid.components,
      supervisor: {
        ...supervisor,
        files: [...supervisor.files, { path: "../evil.js", sha256: "a".repeat(64), size: 1 }],
      },
    },
  });
  assert.throws(() => validateComponentPayload(lib), /\.\.|relative|segments/);

  writeManifest(root, {
    ...valid,
    components: {
      ...valid.components,
      supervisor: {
        ...supervisor,
        files: [...supervisor.files, { path: "lib/supervisor/manifest.json", sha256: "a".repeat(64), size: 1 }],
      },
    },
  });
  assert.throws(() => validateComponentPayload(lib), /must not list itself/);

  writeManifest(root, {
    ...valid,
    components: {
      ...valid.components,
      supervisor: {
        ...supervisor,
        files: [...supervisor.files, { path: "C:/Windows/notepad.exe", sha256: "a".repeat(64), size: 1 }],
      },
    },
  });
  assert.throws(() => validateComponentPayload(lib), /relative/);
});

test("validate rejects duplicate paths, unknown names, and latest versions", () => {
  const { root, lib } = dummyTree();
  const valid = writeComponentPayloadManifest(lib).manifest;
  const plugin = valid.components["manager-plugin"];
  writeManifest(root, {
    ...valid,
    components: {
      ...valid.components,
      "manager-plugin": {
        ...plugin,
        files: [...plugin.files, { ...plugin.files[0] }],
      },
    },
  });
  assert.throws(() => validateComponentPayload(lib), /Duplicate/);

  writeManifest(root, {
    ...valid,
    components: { ...valid.components, extra: valid.components.supervisor },
  });
  assert.throws(() => validateComponentPayload(lib), /Unknown component payload name 'extra'/);

  writeManifest(root, {
    ...valid,
    version: "latest",
    components: {
      ...valid.components,
      supervisor: { ...valid.components.supervisor, version: "latest" },
    },
  });
  assert.throws(() => validateComponentPayload(lib), /exact|dist-tag/);
});

test("copy copies only declared files and refuses to import src or node_modules", () => {
  const source = dummyTree();
  const written = writeComponentPayloadManifest(source.lib);
  const dest = join(tempDir("dsh-component-dest-"), "pkg");
  const copied = copyComponentPayload(source.lib, dest);
  assert.equal(copied.digest, written.digest);
  assert.equal(existsSync(join(dest, "src")), false);
  assert.equal(existsSync(join(dest, "node_modules")), false);
  assert.equal(existsSync(join(dest, COMPONENT_PAYLOAD_MANIFEST_REL)), true);
  assert.equal(existsSync(join(dest, "lib", "supervisor", "index.js")), true);
  assert.equal(existsSync(join(dest, "lib", "llm-bridge", "lib", "index.js")), true);
  const again = copyComponentPayload(source.lib, dest);
  assert.equal(again.digest, written.digest);
});

test("copy does not overwrite an existing destination with different content", () => {
  const source = dummyTree();
  writeComponentPayloadManifest(source.lib);
  const dest = join(tempDir("dsh-component-dest-exist-"), "pkg");
  mkdirSync(dest, { recursive: true });
  const marker = join(dest, "keep-me.txt");
  writeFileSync(marker, "original\n");
  assert.throws(() => copyComponentPayload(source.lib, dest), ComponentPayloadError);
  assert.throws(() => copyComponentPayload(source.lib, dest), /exists with different content/);
  assert.equal(readFileSync(marker, "utf8"), "original\n");
  assert.equal(existsSync(join(dest, "lib", "supervisor", "manifest.json")), false);
});

test("external file symlink assets are rejected", (t) => {
  const source = dummyTree();
  writeComponentPayloadManifest(source.lib);
  const outside = join(tempDir("dsh-component-outside-"), "escaped.js");
  writeFileSync(outside, "escaped\n");
  const link = join(source.root, "lib", "index.js");
  rmSync(link);
  try {
    symlinkSync(outside, link, "file");
  } catch (error) {
    t.skip(`external file symlink is not testable on this Windows account: ${String(error)}`);
    return;
  }
  assert.throws(() => validateComponentPayload(source.lib), /symlink or junction/);
});

test("external directory junction assets are rejected", (t) => {
  const source = dummyTree();
  writeComponentPayloadManifest(source.lib);
  const outsideDir = tempDir("dsh-component-outside-dir-");
  writeRel(outsideDir, "package.json", pkg(COMPONENT_PAYLOAD_PACKAGES["llm-bridge"], "4.0.0"));
  writeRel(outsideDir, "cordis.patch.yml", "llm: dummy\n");
  writeRel(outsideDir, "lib/index.js", "export const llm = 1;\n");
  rmSync(join(source.root, "lib", "llm-bridge"), { recursive: true, force: true });
  try {
    symlinkSync(outsideDir, join(source.root, "lib", "llm-bridge"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`external directory junction is not testable on this Windows account: ${String(error)}`);
    return;
  }
  assert.throws(() => validateComponentPayload(source.lib), /symlink or junction/);
});

test("pack-spaces-plugin required list includes the v2 manifest and llm assets", () => {
  for (const rel of [
    "lib/supervisor/manifest.json",
    "lib/supervisor/index.js",
    "lib/supervisor/launcher.mjs",
    "lib/supervisor/snapshot-worker.mjs",
    "lib/llm-bridge/package.json",
    "lib/llm-bridge/cordis.patch.yml",
    "lib/llm-bridge/lib/index.js",
    "lib/view-bridge/package.json",
    "lib/view-bridge/cordis.patch.yml",
    "lib/view-bridge/lib/index.js",
    "lib/view-bridge/lib/client.js",
    "lib/view-bridge/lib/settings.js",
    "package.json",
    "cordis.patch.yml",
    "lib/index.js",
    "lib/typert.host.js",
    "lib/typert.remote-client.js",
    "lib/client.js",
  ]) {
    assert.ok(PLUGIN_REQUIRED.includes(rel), `PLUGIN_REQUIRED missing ${rel}`);
  }
});

test("build-spaces generates the v2 manifest after view-bridge copy via the Node module", () => {
  const build = readFileSync(fileURLToPath(new URL("../scripts/build-spaces.mjs", import.meta.url)), "utf8");
  assert.match(build, /writeComponentPayloadManifest/);
  assert.match(build, /component-payload/);
  const viewCopy = build.lastIndexOf("packages/view-bridge");
  const writeCall = build.indexOf("writeSpacesComponentPayload");
  assert.ok(viewCopy >= 0 && writeCall > viewCopy);
  assert.equal(build.includes("JSON.stringify({ version: supervisorPackage.version, entry: 'index.js' }"), false);
});

test("optional LICENSE files are included when present as regular files", () => {
  const { root, lib } = dummyTree();
  const written = writeComponentPayloadManifest(lib);
  for (const name of COMPONENT_PAYLOAD_NAMES) {
    for (const rel of COMPONENT_PAYLOAD_OPTIONAL_FILES[name]) {
      assert.ok(written.files.some((file) => file.path === rel), `optional ${rel} not listed`);
    }
  }
  assert.equal(existsSync(join(root, "LICENSE")), true);
});
