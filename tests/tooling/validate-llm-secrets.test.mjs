import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Patch only the child process's reads. The actual gate still performs its
// normal file discovery and checks, without modifying the shared source tree.
function runGate(probe, { newPart = false } = {}) {
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const probe = ${JSON.stringify(probe ?? null)};
    const target = probe && resolve(probe);
    const originalRead = fs.readFileSync;
    const originalList = fs.readdirSync;
    fs.readFileSync = function (path, ...args) {
      if (target && resolve(String(path)) === target) {
        const original = ${newPart ? '""' : 'originalRead.call(this, path, ...args)'};
        return original + "\\n// synthetic fixture: sk-ABCDEFGH12345678\\n";
      }
      return originalRead.call(this, path, ...args);
    };
    ${newPart ? `fs.readdirSync = function (path, ...args) {
      const entries = originalList.call(this, path, ...args);
      return resolve(String(path)) === resolve("src/adapters/node/supervisor")
        ? [...entries, "zz-secret-gate-probe.ts"] : entries;
    };` : ""}
    syncBuiltinESMExports();
    await import(pathToFileURL(resolve("scripts/validate-llm-secrets.mjs")).href);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    encoding: "utf8",
  });
}

test("the secret gate passes on clean repository sources", () => {
  const run = runGate();
  assert.equal(run.status, 0, run.stderr);
});

for (const probe of [
  "src/adapters/node/workbench-supervisor.ts",
  "src/adapters/node/supervisor/toolchain.ts",
]) {
  test(`the secret gate detects a synthetic key in ${probe}`, () => {
    const run = runGate(probe);
    assert.equal(run.status, 1, run.stderr);
    assert.ok(run.stderr.includes(`${probe} contains a key-like token`), run.stderr);
  });
}

test("the secret gate discovers a new supervisor part without a manual file entry", () => {
  const probe = "src/adapters/node/supervisor/zz-secret-gate-probe.ts";
  const run = runGate(probe, { newPart: true });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.stderr.includes(`${probe} contains a key-like token`), run.stderr);
});
