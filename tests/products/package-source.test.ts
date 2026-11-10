import assert from "node:assert/strict";
import { test } from "node:test";
import { inferPackageSource } from "../../src/shared/types.ts";
import { readFileSync } from "node:fs";
import { assertSupportedNode, SUPPORTED_NODE_RANGE } from "../../src/shared/node-version.ts";

test("official Desktop Node 24.21 and Node 26 are supported", () => {
  for (const version of ["24.21.0", "v24.21.0", "24.22.0", "26.0.0", "26.10.0"]) {
    assert.doesNotThrow(() => assertSupportedNode(version), version);
  }
  for (const version of ["22.23.2", "24.20.0", "24.21.0-rc.1", "25.0.0", "27.0.0", "26.1", "unknown"]) {
    assert.throws(() => assertSupportedNode(version), /requires Node.js 24.21\+ \(24.x\) or 26.x/);
  }
});

test("distributed package engines admit exactly the supported runtime range", () => {
  for (const path of ["package.json", ...["plugin", "supervisor", "doctor", "browser", "view-bridge", "blueprint"].map(name => `packages/${name}/package.json`)]) {
    const manifest = JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
    assert.equal(manifest.engines.node, SUPPORTED_NODE_RANGE, path);
  }
});
import {
  NODE_VERSION,
  electronMirror,
  nodeArchiveName,
  nodeDownloadUrl,
  npmPackumentUrl,
  npmRegistry,
  sourceEnv,
} from "../../src/adapters/node/products/package-source.ts";

test("infers china source from zh locales", () => {
  assert.equal(inferPackageSource("zh-CN"), "china");
  assert.equal(inferPackageSource("zh"), "china");
  assert.equal(inferPackageSource("en-US"), "official");
});

test("node archive names follow platform", () => {
  assert.equal(nodeArchiveName("win32", "x64"), `node-v${NODE_VERSION}-win-x64.zip`);
  assert.equal(nodeArchiveName("darwin", "arm64"), `node-v${NODE_VERSION}-darwin-arm64.tar.gz`);
  assert.equal(nodeArchiveName("linux", "x64"), `node-v${NODE_VERSION}-linux-x64.tar.gz`);
});

test("china source uses npmmirror for node and npm", () => {
  assert.equal(
    nodeDownloadUrl("china", "win32", "x64"),
    `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  );
  assert.equal(npmRegistry("china"), "https://registry.npmmirror.com");
  assert.equal(electronMirror("china"), "https://npmmirror.com/mirrors/electron/");
  assert.equal(sourceEnv("china").npm_config_registry, "https://registry.npmmirror.com");
});

test("packument URLs encode scoped package names", () => {
  assert.equal(
    npmPackumentUrl("official", "@deepseek-ai/dsh"),
    "https://registry.npmjs.org/%40deepseek-ai%2Fdsh",
  );
  assert.equal(
    npmPackumentUrl("china", "@deepseek-ai/dsh"),
    "https://registry.npmmirror.com/%40deepseek-ai%2Fdsh",
  );
});

test("official source uses nodejs.org and npmjs", () => {
  assert.equal(
    nodeDownloadUrl("official", "win32", "x64"),
    `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  );
  assert.equal(npmRegistry("official"), "https://registry.npmjs.org");
  assert.equal(electronMirror("official"), undefined);
});
