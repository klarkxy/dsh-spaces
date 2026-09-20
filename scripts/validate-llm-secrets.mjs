#!/usr/bin/env node
/**
 * Secret and recovery-product gate for the global LLM library.
 * Scans Supervisor/Host/jobs/shared-shell/credential-channel contracts.
 * Does not touch ~/.dsh or live keys.
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
  "src/adapters/node/llm-host.ts",
  "src/adapters/node/workbench-jobs.ts",
  "src/adapters/node/workbench-http.ts",
  "src/adapters/node/workbench-supervisor.ts",
  "src/shared/llm-api.ts",
  "src/shared/desktop-shell.ts",
  "src/preload/index.ts",
  "packages/llm-bridge/src/plugin.ts",
  "packages/llm-bridge/src/official-host.ts",
  "packages/plugin/src/host/workbench-http.ts",
  "packages/plugin/src/host/workbench-manager.ts",
  "packages/plugin/src/workbench/llm/center.tsx",
  "packages/plugin/src/workbench/llm/client.ts",
];

const LIVE_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/;
const PRODUCT_RECOVERY = /\b(autoRetry|retryFailed|rollback\(|restoreSnapshot|replayOperation|fallbackModel|installLlmPiAi)\b/;
const CREDENTIAL_IPC = /llmCredential|saveConnectionWithCredential/;

for (const rel of SECRET_SCAN) {
  const text = readFileSync(join(REPO, rel), "utf8");
  if (LIVE_KEY.test(text)) fail(`${rel} contains a key-like token`);
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

const api = readFileSync(join(REPO, "src/shared/llm-api.ts"), "utf8");
if (!api.includes("LLM_CREDENTIAL_METHOD")) fail("llm-api must name LLM_CREDENTIAL_METHOD");
if (!api.includes('"saveConnectionWithCredential"')) {
  fail("actual credential channel method is saveConnectionWithCredential");
}

const supervisor = readFileSync(join(REPO, "src/adapters/node/workbench-supervisor.ts"), "utf8");
if (!supervisor.includes('"llmCredential"')) fail("Supervisor must dispatch llmCredential");

const nodeHttp = readFileSync(join(REPO, "src/adapters/node/workbench-http.ts"), "utf8");
if (!nodeHttp.includes('"llmCredential"')) fail("Supervisor HTTP methods must include llmCredential");

const hostHttp = readFileSync(join(REPO, "packages/plugin/src/host/workbench-http.ts"), "utf8");
if (!hostHttp.includes('"llmCredential"')) fail("Host HTTP client must call llmCredential");

const hostRemote = readFileSync(join(REPO, "packages/plugin/src/host/workbench-manager.ts"), "utf8");
if (!hostRemote.includes("@Remote(\"llmCredential\")")) fail("Host Remote must expose llmCredential");

const credentials = readFileSync(join(REPO, "src/adapters/node/llm-credential-store.ts"), "utf8");
if (!credentials.includes("readSecret") || !credentials.includes("writeRecord")) {
  fail("credential store must keep writeRecord/readSecret off the public catalog");
}

const shell = readFileSync(join(REPO, "src/shared/desktop-shell.ts"), "utf8");
if (!shell.includes("DESKTOP_SHELL_IPC") || !shell.includes("DESKTOP_SHELL_INVOKE_CHANNELS")) {
  fail("shared shell must define the closed DESKTOP_SHELL_IPC invoke set");
}
if (CREDENTIAL_IPC.test(shell)) fail("shared shell IPC must not carry llmCredential");
if (shell.includes("DESKTOP_WRITE_IPC_CHANNELS")) fail("shared shell must not revive the old desktop write IPC list");
const shellChannels = [...shell.matchAll(/["'](desktop-shell:[^"']+)["']/g)].map((row) => row[1]);
if (shellChannels.length === 0) fail("shared shell IPC channel names were not found");
for (const channel of shellChannels) {
  if (/llm|credential|secret|token|bearer|apiKey|restore/i.test(channel)) {
    fail(`shared shell IPC channel ${channel} is not a closed non-secret channel`);
  }
}

const preload = readFileSync(join(REPO, "src/preload/index.ts"), "utf8");
if (!preload.includes("DESKTOP_SHELL_IPC")) fail("preload must bind DESKTOP_SHELL_IPC");
if (CREDENTIAL_IPC.test(preload)) fail("preload must not expose llmCredential");
if (/ipcRenderer\.invoke\((?!DESKTOP_SHELL_IPC)/.test(preload)) {
  fail("preload invoke is not closed over DESKTOP_SHELL_IPC");
}

const share = readFileSync(join(REPO, "src/core/domain/llm-share.ts"), "utf8");
if (!share.includes("SPACES_LLM_")) fail("share scanner must refuse managed credential refs");
if (!share.includes("sk-")) fail("share scanner must refuse key-like tokens");

if (process.exitCode) process.exit(process.exitCode);
console.log("PASS  llm secret and recovery-product scan");
