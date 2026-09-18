#!/usr/bin/env node
/**
 * Secret and recovery-product gate for the global LLM library.
 * Scans Host/job/IPC/share contracts. Does not touch ~/.dsh or live keys.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

const SECRET_SCAN = [
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
  "src/adapters/node/workbench-jobs.ts",
  "src/shared/desktop-controller.ts",
  "src/shared/llm-api.ts",
  "src/main/desktop-llm.ts",
  "src/preload/index.ts",
  "packages/llm-bridge/src/plugin.ts",
  "packages/llm-bridge/src/official-host.ts",
  "packages/plugin/src/host/workbench-manager.ts",
  "packages/plugin/src/workbench/llm/center.tsx",
  "packages/plugin/src/workbench/llm/client.ts",
];

const RECOVERY_SCAN = SECRET_SCAN.filter(
  (rel) => rel !== "src/shared/desktop-controller.ts" && rel !== "src/preload/index.ts",
);

const LIVE_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/;
const PRODUCT_RECOVERY = /\b(autoRetry|retryFailed|rollback\(|restoreSnapshot|replayOperation|fallbackModel|installLlmPiAi)\b/;

for (const rel of SECRET_SCAN) {
  const text = readFileSync(join(REPO, rel), "utf8");
  if (LIVE_KEY.test(text)) fail(`${rel} contains a key-like token`);
}
for (const rel of RECOVERY_SCAN) {
  const text = readFileSync(join(REPO, rel), "utf8");
  if (PRODUCT_RECOVERY.test(text)) fail(`${rel} contains a recovery/fallback product path`);
}

const jobs = readFileSync(join(REPO, "src/adapters/node/workbench-jobs.ts"), "utf8");
for (const key of ["key", "apiKey", "secret", "credential", "token", "authorization"]) {
  if (!jobs.includes(`"${key}"`)) fail(`StoredJob secret denylist is missing ${key}`);
}

const operations = readFileSync(join(REPO, "src/adapters/node/llm-operation-store.ts"), "utf8");
for (const key of ["key", "apiKey", "secret", "hash", "authorization"]) {
  if (!operations.includes(`"${key}"`)) fail(`operations.json secret denylist is missing ${key}`);
}

const desktop = readFileSync(join(REPO, "src/shared/desktop-controller.ts"), "utf8");
if (!desktop.includes('"llmCredential"')) fail("desktop write IPC must include llmCredential");
if (desktop.includes('"llm",') && /DESKTOP_WRITE_IPC_CHANNELS[\s\S]*"llm"/.test(desktop)) {
  fail("redacted llm channel must not be a write-only secret channel");
}

const share = readFileSync(join(REPO, "src/core/domain/llm-share.ts"), "utf8");
if (!share.includes("SPACES_LLM_")) fail("share scanner must refuse managed credential refs");
if (!share.includes("sk-")) fail("share scanner must refuse key-like tokens");

if (process.exitCode) process.exit(process.exitCode);
console.log("PASS  llm secret and recovery-product scan");
