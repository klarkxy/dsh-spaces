import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { LLM_CAPABILITIES } from "../src/core/application/global-llm-host.ts";
import { LLM_ERROR, parseCatalog } from "../src/core/domain/llm-connections.ts";
import { readLaunchSnapshotFile } from "../src/adapters/node/llm-snapshot.ts";
import { requireOfficialLlmAdapter } from "../packages/llm-bridge/src/official-host.ts";
import { LLM_REQUIRED, listTarEntries, normalizePacked } from "../scripts/pack-spaces-plugin.mjs";

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

function resolveNpmCli(nodeExe: string): string {
  const candidates = [
    join(dirname(nodeExe), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeExe), "..", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeExe), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const probe = spawnSync(nodeExe, ["-p", "require.resolve('npm/bin/npm-cli.js')"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.status === 0 && probe.stdout.trim()) candidates.push(probe.stdout.trim());
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["npm"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  for (const line of (found.stdout || "").split(/\r?\n/)) {
    const loc = line.trim();
    if (!loc) continue;
    candidates.push(join(dirname(loc), "node_modules", "npm", "bin", "npm-cli.js"));
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return resolve(candidate);
  }
  throw new Error("npm-cli.js not found. Use a Node install that ships npm, or put npm on PATH.");
}

function spawnFailure(result: SpawnSyncReturns<string>, label: string): string {
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const err = result.error?.message ?? "";
  return `${label} failed (status=${result.status} signal=${result.signal}${err ? ` error=${err}` : ""})${output ? `: ${output}` : ""}`;
}

function runNpmPack(packageDir: string, dest: string, dryRun: boolean) {
  const nodeExe = process.execPath;
  const npmCli = resolveNpmCli(nodeExe);
  const args = [npmCli, "pack", packageDir, "--json", "--ignore-scripts", "--pack-destination", dest];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync(nodeExe, args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      npm_config_ignore_scripts: "true",
      npm_config_offline: "true",
      npm_config_fund: "false",
      npm_config_audit: "false",
      npm_config_update_notifier: "false",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const label = dryRun ? "npm pack --dry-run" : "npm pack";
  assert.equal(result.status, 0, spawnFailure(result, label));
  const start = (result.stdout || "").indexOf("[");
  assert.ok(start >= 0, `${label} --json did not return an array (${spawnFailure(result, label)})`);
  const rows = JSON.parse(result.stdout.slice(start)) as Array<{
    filename?: string;
    files?: Array<{ path?: string } | string>;
  }>;
  const row = rows[0];
  assert.ok(row?.filename, `${label} --json missing filename (${spawnFailure(result, label)})`);
  const files = Array.isArray(row.files)
    ? row.files.map((file) =>
        String(typeof file === "string" ? file : file.path || file)
          .replaceAll("\\", "/")
          .replace(/^package\//, ""),
      )
    : [];
  return { filename: row.filename, files };
}

function assertInstallUnitFiles(listing: string, files: string[], source: string) {
  for (const rel of ["package.json", "README.md", "LICENSE", "cordis.patch.yml"]) {
    assert.ok(files.includes(rel), `${source} missing ${rel}: ${listing}`);
  }
  assert.doesNotMatch(listing, /credentials\.yaml|catalog\.json|sk-/);
}

test("A28 llm-bridge tarball is packable and lists the install unit files", { timeout: 120_000 }, () => {
  const dest = mkdtempSync(join(tmpdir(), "dsh-llm-pack-"));
  temps.push(dest);
  const packageDir = join(repo, "packages/llm-bridge");
  const dry = runNpmPack(packageDir, dest, true);
  assertInstallUnitFiles(dry.files.join("\n"), dry.files, "npm pack --dry-run");
  const packed = runNpmPack(packageDir, dest, false);
  assert.match(packed.filename, /dsh-spaces-llm-bridge-.*\.tgz/);
  const tarball = join(dest, packed.filename);
  assert.equal(existsSync(tarball), true, `npm pack did not write ${tarball}`);
  const entries = listTarEntries(tarball).map((entry: string) => normalizePacked(entry));
  assertInstallUnitFiles(entries.join("\n"), entries, "packed tarball");
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
