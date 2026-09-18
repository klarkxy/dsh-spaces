import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { LLM_CAPABILITIES } from "../src/core/application/global-llm-host.ts";
import { LLM_ERROR, parseCatalog } from "../src/core/domain/llm-connections.ts";
import { readLaunchSnapshotFile } from "../src/adapters/node/llm-snapshot.ts";
import { requireOfficialLlmAdapter } from "../packages/llm-bridge/src/official-host.ts";
import { LLM_REQUIRED } from "../scripts/pack-spaces-plugin.mjs";

const repo = join(import.meta.dirname, "..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LLM_FEATURE_GLOBS = [
  "src/core/domain/llm-connections.ts",
  "src/core/domain/llm-resolution.ts",
  "src/core/domain/llm-share.ts",
  "src/core/application/global-llm-host.ts",
  "src/core/application/global-llm-service.ts",
  "src/adapters/node/llm-catalog-store.ts",
  "src/adapters/node/llm-credential-store.ts",
  "src/adapters/node/llm-policy-store.ts",
  "src/adapters/node/llm-operation-store.ts",
  "src/adapters/node/llm-probe.ts",
  "src/adapters/node/llm-snapshot.ts",
  "src/adapters/node/llm-space-settings.ts",
  "packages/llm-bridge/src/official-host.ts",
  "packages/llm-bridge/src/plugin.ts",
  "packages/llm-bridge/src/request-guard.ts",
  "packages/llm-bridge/src/space-bridge.ts",
  "src/adapters/node/workbench-supervisor.ts",
];

test("A08 missing adapter is reported and supervisor never installs llm-pi-ai", () => {
  assert.throws(() => requireOfficialLlmAdapter(null), { code: LLM_ERROR.ADAPTER_MISSING });
  assert.throws(() => requireOfficialLlmAdapter({}), { code: LLM_ERROR.ADAPTER_MISSING });
  const supervisor = readFileSync(join(repo, "src/adapters/node/workbench-supervisor.ts"), "utf8");
  assert.match(supervisor, /installLlmBridgeIfExplicit/);
  assert.doesNotMatch(supervisor, /installArtifact\([^)]*llm-pi-ai/);
  assert.doesNotMatch(supervisor, /@deepseek-ai\/dsh-llm-pi-ai/);
  const plugin = readFileSync(join(repo, "packages/llm-bridge/src/plugin.ts"), "utf8");
  assert.doesNotMatch(plugin, /ctx\.plugin\(.*llm-pi-ai/i);
});

test("A25 keyless stays unpublished on the first-version capability matrix", () => {
  assert.equal(LLM_CAPABILITIES.keyless, false);
  const i18n = readFileSync(join(repo, "packages/plugin/src/workbench/i18n.ts"), "utf8");
  assert.match(i18n, /llm\.keylessUnsupported/);
});

test("A27 unknown snapshot and catalog schemas are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-llm-schema-"));
  temps.push(dir);
  const snapshot = join(dir, "snap.json");
  writeFileSync(snapshot, JSON.stringify({ schemaVersion: 99, snapshot: null }));
  assert.throws(() => readLaunchSnapshotFile(snapshot), { code: LLM_ERROR.UNSUPPORTED_RUNTIME });
  assert.throws(() => parseCatalog({ schemaVersion: 2, revision: 0, connections: {} }), {
    code: LLM_ERROR.UNSUPPORTED_RUNTIME,
  });
});

test("A28 llm-bridge tarball is packable and lists the install unit files", () => {
  const dest = mkdtempSync(join(tmpdir(), "dsh-llm-pack-"));
  temps.push(dest);
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dest], {
    cwd: join(repo, "packages/llm-bridge"),
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const name = packed.stdout.trim().split("\n").at(-1) ?? "";
  assert.match(name, /dsh-spaces-llm-bridge-.*\.tgz/);
  const tarball = join(dest, name);
  const listed = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  for (const rel of ["package.json", "README.md", "LICENSE", "cordis.patch.yml"]) {
    assert.match(listed.stdout, new RegExp(`package/${rel.replace(".", "\\.")}`));
  }
  assert.doesNotMatch(listed.stdout, /credentials\.yaml|catalog\.json|sk-/);
  assert.ok(LLM_REQUIRED.includes("cordis.patch.yml"));
});

test("A30 LLM feature paths have no retry, rollback, restore, or silent adapter install", () => {
  const forbidden = /\b(autoRetry|retryFailed|rollback\(|restoreSnapshot|replayOperation|fallbackModel|installLlmPiAi)\b/;
  for (const rel of LLM_FEATURE_GLOBS) {
    const text = readFileSync(join(repo, rel), "utf8");
    assert.equal(forbidden.test(text), false, rel);
    assert.doesNotMatch(text, /automatically (retry|restore|reinstall|fallback)/i);
  }
  const probe = readFileSync(join(repo, "src/adapters/node/llm-probe.ts"), "utf8");
  assert.match(probe, /no retry/);
  const host = readFileSync(join(repo, "src/core/application/global-llm-host.ts"), "utf8");
  assert.match(host, /was not replayed/);
});
