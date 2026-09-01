import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { findNodeDir, setToolchainRoot, writeToolchainConfig } from "../src/main/toolchain.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findNodeDir locates a nested windows node distribution", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-toolchain-"));
  temps.push(root);
  setToolchainRoot(root);
  const nested = join(root, "node", "node-v22.16.0-win-x64");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "node.exe"), "");
  assert.equal(findNodeDir(root), nested);
});

test("toolchain config round-trips packageSource", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-toolchain-"));
  temps.push(root);
  setToolchainRoot(root);
  const saved = writeToolchainConfig({ packageSource: "china", nodeVersion: "22.16.0" });
  assert.equal(saved.packageSource, "china");
  assert.equal(saved.nodeVersion, "22.16.0");
});
