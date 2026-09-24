#!/usr/bin/env node
/**
 * Bounded full-normal workbench component-update acceptance.
 *
 * Source core is read-only. This script does not publish, does not guess a
 * machine CLI, and does not claim live PASS from --preflight.
 *
 * Artifact source is two disposable copies of the built plugin package, served
 * as a local HTTP fixture packument/tgz (labeled as such — not a published
 * registry). OLD compiled Supervisor starts with a test-only Node --import
 * fetch shim; the launcher child is the unmodified production entry.
 *
 *   node --import tsx scripts/verify-component-update.mjs --syntax
 *   node --import tsx scripts/verify-component-update.mjs --preflight
 *   node --import tsx scripts/verify-component-update.mjs --with-browser
 *   node --import tsx scripts/verify-component-update.mjs --api-only
 *
 * Primary live run is --with-browser: actual Prepare update (latest via
 * fixture dist-tag) plus preview/confirm UI. --api-only keeps public API
 * mutations. Fixture packument latest is the exact candidate; this is not a
 * published registry.
 *
 * Env: DSH_TEST_BIN (official dsh lib/bin.js), optional DSH_TEST_PNPM_CJS,
 * optional DSH_TEST_PLAYWRIGHT, optional DSH_TEST_OUTPUT.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { writeComponentPayloadManifest, validateComponentPayload } from "../src/adapters/node/component-payload.ts";
import { readSelectedComponentPayload } from "../src/adapters/node/component-selection.ts";
import {
  defaultPidAlive,
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
} from "../src/adapters/node/home-controller.ts";
import { WORKBENCH_JOBS_DIR_NAME } from "../src/adapters/node/workbench-jobs.ts";
import { readHandoffReceipt } from "../src/adapters/node/component-handoff.ts";
import { DesktopServiceClient } from "../src/adapters/desktop/service-client.ts";
import { bootstrapSupervisor } from "../packages/plugin/src/host/supervisor-bootstrap.ts";
import { createWorkbenchHttpClient } from "../packages/plugin/src/host/workbench-http.ts";
import {
  readEndpointFile,
  SUPERVISOR_ENDPOINT_FILE,
} from "../packages/plugin/src/host/supervisor-endpoint.ts";
import {
  PLUGIN_REQUIRED,
  assertNoSpaces,
  listTarEntries,
  normalizePacked,
  resolveNpmCli,
  runNpmPack,
} from "./pack-spaces-plugin.mjs";
import {
  DUMP_MS,
  PLUGIN_MS,
  PORT_MS,
  STOP_MS,
  cliVersion,
  isolatedEnv,
  refuseRealHome,
  runDsh,
  stopOwned,
  waitPortClosed,
  writePnpmShim,
} from "./verify-spaces-distribution.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);
const PLUGIN_DIR = join(REPO, "packages", "plugin");
const SUPERVISOR_DIR = join(REPO, "packages", "supervisor");
const SHIM = join(REPO, "tests", "fixtures", "component-update", "fetch-shim.mjs");
const REWRITE = join(REPO, "tests", "fixtures", "component-update", "rewrite.mjs");
const SHIM_TEST = join(REPO, "tests", "component-update-shim.test.ts");
const HOST = "127.0.0.1";
const PLUGIN_NAME = "@dsh-spaces/plugin";
const WEB_PROFILE = "web";
const FIXTURE_VERSION = "0.3.1-test.1";
const NEXT_FIXTURE_VERSION = "0.3.1-test.2";
const HEX64 = /^[a-f0-9]{64}$/;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const IDENTITY_JSON = [
  "package.json",
  "lib/supervisor/package.json",
  "lib/view-bridge/package.json",
  "lib/llm-bridge/package.json",
];
const WEB_PROTECTED = ["sessions", "storages", ".credentials.yaml", ".anonymous-user-id"];
const PREPARE_MS = 180_000;
const EXECUTE_MS = 600_000;
const BOOT_MS = 240_000;
const PACK_MS = 60_000;

const proved = [];
const contractIssues = [];
const session = { home: "", child: null, server: null, candidateDigest: "" };
const report = {
  status: "running",
  proved,
  contractIssues,
  modelCalls: false,
  fixtureLatest: true,
  transport: "local fixture HTTP (not a published registry)",
  livePass: false,
};

function redact(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [redacted]")
    .replace(/\/bootstrap\/[A-Za-z0-9_-]+/g, "/bootstrap/[redacted]")
    .replace(/[?&]token=[^&\s"']+/gi, "[redacted-token]")
    .replace(/"nonce"\s*:\s*"[^"]+"/g, '"nonce":"[redacted]"')
    .replace(/"bearer"\s*:\s*"[^"]+"/g, '"bearer":"[redacted]"');
}

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}
function staticOk(m) {
  console.log(`STATIC ${redact(m)}`);
}
function pass(m) {
  proved.push(m);
  console.log(`PASS  ${redact(m)}`);
}
function issue(m) {
  contractIssues.push(m);
  console.log(`CONTRACT ${redact(m)}`);
}

function outputDir() {
  return resolve(process.env.DSH_TEST_OUTPUT || join(REPO, ".sandbox", "component-update-acceptance"));
}

function scratchRoot() {
  const dest = join(tmpdir(), "dsh-spaces-component-update");
  assertNoSpaces(dest, "component-update scratch");
  mkdirSync(dest, { recursive: true });
  return dest;
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function stripSecrets(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH|NPM|NODE).*(?:API_KEY|ACCESS_TOKEN|SECRET|TOKEN|PASSWORD)$/i.test(key)) {
      delete next[key];
    }
    if (/^npm_config_\/\//i.test(key) && /auth/i.test(key)) delete next[key];
  }
  delete next.ELECTRON_RUN_AS_NODE;
  delete next.NODE_OPTIONS;
  return next;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveDshBin() {
  const override = process.env.DSH_TEST_BIN?.trim();
  if (!override) {
    throw new Error(
      "Official DSH CLI not found. Set DSH_TEST_BIN to that package's lib/bin.js. This harness does not guess a machine-local path and does not publish.",
    );
  }
  if (!existsSync(override)) throw new Error(`DSH_TEST_BIN is not a file: ${override}`);
  return resolve(override);
}

function inspectCli(bin) {
  const version = cliVersion(bin);
  if (!version || version === "latest" || version === "next" || !EXACT.test(version)) {
    throw new Error(`DSH_TEST_BIN did not report an exact DSH CLI version (${version || "empty"})`);
  }
  return version;
}

function resolvePnpmCjs() {
  const override = process.env.DSH_TEST_PNPM_CJS?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_TEST_PNPM_CJS is not a file: ${override}`);
    return resolve(override);
  }
  const candidates = [
    join(REPO, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs") : "",
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return resolve(path);
  }
  throw new Error("pnpm.cjs not found. Set DSH_TEST_PNPM_CJS to pnpm's bin/pnpm.cjs.");
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`node --check failed for ${relative(REPO, file)}: ${result.stderr || result.stdout || result.status}`);
  }
}

function copyPluginPackage(dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(PLUGIN_DIR, dest, {
    recursive: true,
    filter: (src) => {
      const rel = relative(PLUGIN_DIR, src).replaceAll("\\", "/");
      if (!rel) return true;
      if (rel === "src" || rel.startsWith("src/")) return false;
      if (rel === "node_modules" || rel.startsWith("node_modules/")) return false;
      if (rel.toLowerCase().endsWith(".tgz")) return false;
      return true;
    },
  });
  const supervisorPkg = join(SUPERVISOR_DIR, "package.json");
  const destSupervisorPkg = join(dest, "lib", "supervisor", "package.json");
  if (!existsSync(destSupervisorPkg) && existsSync(supervisorPkg)) {
    mkdirSync(dirname(destSupervisorPkg), { recursive: true });
    writeFileSync(destSupervisorPkg, readFileSync(supervisorPkg));
  }
  for (const name of ["LICENSE", "launcher.mjs", "launcher.js", "snapshot-worker.mjs"]) {
    const from = join(SUPERVISOR_DIR, name === "LICENSE" ? "LICENSE" : join("lib", name));
    const to = join(dest, "lib", "supervisor", name);
    if (!existsSync(to) && existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    }
  }
}

function readVersion(file) {
  if (!existsSync(file)) return "";
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

function bumpIdentities(root, version) {
  for (const rel of IDENTITY_JSON) {
    const file = join(root, rel);
    if (!existsSync(file)) throw new Error(`component identity missing: ${rel}`);
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.version = version;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

function fixtureVersionFor(oldVersion) {
  return oldVersion === FIXTURE_VERSION ? NEXT_FIXTURE_VERSION : FIXTURE_VERSION;
}

function controlPath(home, ...parts) {
  return join(home, HOME_CONTROL_DIR_NAME, ...parts);
}

function readOwner(home) {
  const path = controlPath(home, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { unreadable: true };
  }
}

function ownerPid(owner) {
  const pid = Number(owner?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readEndpoint(home) {
  return readEndpointFile(controlPath(home, SUPERVISOR_ENDPOINT_FILE));
}

function contextOf(state) {
  if (!HEX64.test(state?.serviceEpoch || "") || !HEX64.test(state?.revision || "")) {
    throw new Error("workbench mutation context requires 64-hex serviceEpoch and revision");
  }
  return { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision };
}

function assertV2State(state, label) {
  if (!state || state.protocolVersion !== 2) throw new Error(`${label}: workbench state is not protocol v2`);
  if (Object.prototype.hasOwnProperty.call(state, "recoveryRequired")) {
    throw new Error(`${label}: stale recoveryRequired field on v2 state`);
  }
  contextOf(state);
}

function namesIfPresent(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return existsSync(path) ? ["<present>"] : null;
  }
}

function webProtectedFingerprint(home) {
  const webRoot = join(home, "profiles", WEB_PROFILE);
  const out = { webProfile: existsSync(join(webRoot, "package.json")) };
  for (const name of WEB_PROTECTED) {
    const path = name.startsWith(".") ? join(home, name) : join(webRoot, name);
    out[name] = name.startsWith(".") ? existsSync(path) : namesIfPresent(path);
  }
  return out;
}

function fingerprintPresent(value) {
  if (typeof value === "boolean") return value;
  return value != null;
}

function webProtectedPresence(fp) {
  const out = { webProfile: fingerprintPresent(fp?.webProfile) };
  for (const name of WEB_PROTECTED) out[name] = fingerprintPresent(fp?.[name]);
  return out;
}

function presenceDelta(before, after) {
  const beforeP = webProtectedPresence(before);
  const afterP = webProtectedPresence(after);
  const fields = {};
  const changed = [];
  for (const key of ["webProfile", ...WEB_PROTECTED]) {
    fields[key] = { before: beforeP[key], after: afterP[key] };
    if (beforeP[key] !== afterP[key]) changed.push(key);
  }
  return { fields, changed };
}

function assertWebSentinelsUnchanged(home, before, label) {
  if (!before) throw new Error(`${label}: mutation-protection baseline was not captured`);
  const after = webProtectedFingerprint(home);
  assert.equal(after.webProfile, true, `${label}: profiles/web missing`);
  for (const name of WEB_PROTECTED) {
    assert.deepEqual(after[name], before[name], `${label}: web sentinel ${name} changed`);
  }
  return after;
}

function pointerDigest(home, toolsRoot) {
  try {
    const selected = readSelectedComponentPayload(home, toolsRoot);
    return selected?.digest ?? null;
  } catch (error) {
    throw new Error(`selected pointer unreadable: ${error instanceof Error ? error.message : error}`);
  }
}

function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    return (result.stdout || "").trim();
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

async function until(check, label, timeout) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${redact(JSON.stringify(last).slice(0, 240))})` : ""}`);
}

function jobFile(home, requestId) {
  return controlPath(home, WORKBENCH_JOBS_DIR_NAME, `${requestId}.json`);
}

function readDurableJob(home, requestId) {
  const path = jobFile(home, requestId);
  if (!existsSync(path)) return null;
  try {
    const row = JSON.parse(readFileSync(path, "utf8"));
    if (!row || (row.id !== requestId && row.requestId !== requestId)) return null;
    return row;
  } catch {
    return null;
  }
}

function findPlanExecuteJob(home, planId) {
  const dir = controlPath(home, WORKBENCH_JOBS_DIR_NAME);
  if (!existsSync(dir) || !planId) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const row = readDurableJob(home, id);
    if (row?.kind === "plan.execute" && row.command?.planId === planId && row.requestId === id) return row;
  }
  return null;
}

function workbenchErrorCode(error) {
  if (!error || typeof error !== "object") return "";
  const code = error.code;
  return typeof code === "string" ? code : "";
}

const WRONG_NEGATIVE_CODES = new Set([
  "workbench/conflict",
  "workbench/busy",
  "workbench/invalid-input",
  "workbench/read-only",
  "workbench/unavailable",
  "workbench/locked",
  "spaces/read-only",
]);
const ORIGIN_ANNOUNCE = /(?:^|\n)origin=http:\/\/127\.0\.0\.1:\d+(?:\r?\n|$)/;
const BOOTSTRAP_ANNOUNCE = /(?:^|\n)bootstrap=http:\/\/127\.0\.0\.1:\d+\/bootstrap\/[A-Za-z0-9_-]+(?:\r?\n|$)/;
const MANAGER_ID_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

function failureCode(value) {
  return workbenchErrorCode(value) || workbenchErrorCode(value?.error);
}

function wrongNegativeCode(value) {
  const code = failureCode(value);
  if (WRONG_NEGATIVE_CODES.has(code)) return code;
  const message = String(value?.message || value?.error?.message || "");
  if (/already exists for a different command/i.test(message)) return "workbench/conflict";
  return "";
}

function failIfWrongNegative(label, value) {
  const code = wrongNegativeCode(value);
  if (!code) return;
  throw new Error(
    `${label}: wrong negative case ${code} (not download/tamper). Wait until the old service is fully initialized and capture a fresh context; do not retry or resubmit this failed job.`,
  );
}

function noteBootAnnounce(text, flags) {
  if (ORIGIN_ANNOUNCE.test(text)) flags.origin = true;
  if (BOOTSTRAP_ANNOUNCE.test(text)) flags.bootstrap = true;
  return flags.origin === true && flags.bootstrap === true;
}

function isValidManagerId(id) {
  return typeof id === "string" && id !== "web" && MANAGER_ID_RE.test(id);
}

function isInitializedManager(state) {
  if (!state || state.protocolVersion !== 2) return false;
  if (state.availability !== "ready") return false;
  if (state.writable !== true) return false;
  if (state.role !== "manager") return false;
  if (!isValidManagerId(state.managerId)) return false;
  const row = Array.isArray(state.spaces) ? state.spaces.find((space) => space.id === state.managerId) : null;
  return row?.status === "running";
}

function summarizeManagerState(state) {
  if (!state || typeof state !== "object") return "no-state";
  const managerId = state.managerId ?? "null";
  const row = Array.isArray(state.spaces) ? state.spaces.find((space) => space.id === managerId) : null;
  return `availability=${state.availability} role=${state.role} writable=${state.writable} managerId=${managerId} space=${row?.status ?? "missing"}`;
}

async function waitReadonlyInitialized(api, childRef, label, timeout) {
  const end = Date.now() + timeout;
  let last = "";
  while (Date.now() < end) {
    const child = childRef?.current;
    if (child && child.exitCode !== null) {
      throw new Error(`${label}: supervisor exited ${child.exitCode} before initialized (${redact(last).slice(0, 240)})`);
    }
    try {
      const state = await api.state();
      last = summarizeManagerState(state);
      if (isInitializedManager(state)) return state;
    } catch (error) {
      last = failureCode(error) || (error instanceof Error ? error.message : "state failed");
    }
    await delay(250);
  }
  throw new Error(`Timed out: ${label} (${redact(last).slice(0, 240)})`);
}

function summarizeHandoffReceipt(receipt) {
  if (!receipt) return "missing";
  const digest = typeof receipt.artifactDigest === "string" ? receipt.artifactDigest.slice(0, 8) : "none";
  return `status=${receipt.status} phase=${receipt.phase} digest=${digest}${receipt.code ? ` code=${receipt.code}` : ""}`;
}

function handoffReceiptDecision(receipt, expectedDigest) {
  if (!receipt) return "wait";
  if (receipt.status === "failed" || receipt.phase === "failed") return "failed";
  if (typeof receipt.artifactDigest === "string" && receipt.artifactDigest !== expectedDigest) return "wrong-digest";
  if (receipt.status === "succeeded" && receipt.phase === "accepted") return "accepted";
  return "wait";
}

async function waitHandoffReceiptAccepted(home, expectedDigest, label, timeout) {
  const end = Date.now() + timeout;
  let last = "missing";
  while (Date.now() < end) {
    let receipt = null;
    try {
      receipt = readHandoffReceipt(home) ?? null;
    } catch {
      last = "unreadable";
      await delay(250);
      continue;
    }
    last = summarizeHandoffReceipt(receipt);
    const decision = handoffReceiptDecision(receipt, expectedDigest);
    if (decision === "failed") {
      throw new Error(`handoff receipt failed code=${receipt?.code || "missing"} (${last})`);
    }
    if (decision === "wrong-digest") {
      throw new Error(`handoff receipt artifactDigest ${receipt.artifactDigest} !== candidate ${expectedDigest}`);
    }
    if (decision === "accepted") return receipt;
    await delay(250);
  }
  throw new Error(`Timed out: ${label} (${last})`);
}

async function waitHandoffReceiptTerminal(home, expectedDigest, timeout) {
  const end = Date.now() + timeout;
  let last = "missing";
  while (Date.now() < end) {
    let receipt = null;
    try {
      receipt = readHandoffReceipt(home) ?? null;
    } catch {
      last = "unreadable";
      await delay(250);
      continue;
    }
    last = summarizeHandoffReceipt(receipt);
    if (!expectedDigest) {
      if (receipt && (receipt.status === "failed" || receipt.phase === "failed")) return receipt;
      if (receipt && receipt.status === "succeeded" && receipt.phase === "accepted") return receipt;
      await delay(250);
      continue;
    }
    const decision = handoffReceiptDecision(receipt, expectedDigest);
    if (decision !== "wait") return receipt;
    await delay(250);
  }
  throw new Error(`Timed out: handoff receipt terminal (${last})`);
}

function readDurableShutdownJob(home, requestId, planId) {
  const path = jobFile(home, requestId);
  if (!existsSync(path)) return null;
  try {
    const row = JSON.parse(readFileSync(path, "utf8"));
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    if (row.schemaVersion !== 1) return null;
    if (row.id !== requestId || row.requestId !== requestId) return null;
    if (row.kind !== "plan.execute") return null;
    if (row.command?.kind !== "plan.execute" || row.command?.planId !== planId) return null;
    return row;
  } catch {
    return null;
  }
}

function assertShutdownSubmitted(submitted, requestId) {
  if (!submitted?.id) throw new Error("service.shutdown: public submit was not accepted");
  if (submitted.id !== requestId) {
    throw new Error(`service.shutdown: submitted.id ${submitted.id} != requestId ${requestId}`);
  }
  if (submitted.requestId !== requestId) {
    throw new Error(`service.shutdown: submitted.requestId ${submitted.requestId ?? ""} != requestId ${requestId}`);
  }
  if (submitted.kind !== "plan.execute") {
    throw new Error(`service.shutdown: submitted.kind ${submitted.kind ?? ""} is not plan.execute`);
  }
}

async function waitShutdownJob(home, api, submitted, requestId, planId, timeout) {
  assertShutdownSubmitted(submitted, requestId);
  const end = Date.now() + timeout;
  let last = submitted;
  let proof = "";
  while (Date.now() < end) {
    if (api) {
      try {
        const job = await api.job(requestId);
        last = job;
        if (job.id !== requestId || job.requestId !== requestId) {
          throw new Error(`service.shutdown: polled job identity ${job.id}/${job.requestId} != ${requestId}`);
        }
        if (job.kind !== "plan.execute") {
          throw new Error(`service.shutdown: polled job kind ${job.kind} is not plan.execute`);
        }
        if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
          proof = "http";
          break;
        }
      } catch (error) {
        const code = workbenchErrorCode(error);
        if (code !== "workbench/unavailable") throw error;
        const durable = readDurableShutdownJob(home, requestId, planId);
        if (durable) last = durable;
        if (durable?.status === "succeeded" || durable?.status === "failed" || durable?.status === "cancelled") {
          proof = "durable";
          info(
            `service.shutdown: API unavailable after public submit; durable job ${requestId} status=${durable.status} (durable proof, not HTTP success)`,
          );
          break;
        }
      }
    } else {
      const durable = readDurableShutdownJob(home, requestId, planId);
      if (durable) last = durable;
      if (durable?.status === "succeeded" || durable?.status === "failed" || durable?.status === "cancelled") {
        proof = "durable";
        break;
      }
    }
    await delay(250);
  }
  if (!proof) {
    throw new Error(`service.shutdown: public job ${requestId} did not reach a terminal status lastStatus=${last?.status ?? "unknown"}`);
  }
  if (last.status === "failed" || last.status === "cancelled") {
    throw new Error(`service.shutdown job ${requestId} ${last.status}${proof === "durable" ? " (durable)" : ""}`);
  }
  if (last.status !== "succeeded") {
    throw new Error(`service.shutdown job ${requestId} status=${last.status}`);
  }
  return { job: last, proof, requestId, planId };
}

async function submitPublicShutdown(home, api, state) {
  assertV2State(state, "service.shutdown");
  const context = contextOf(state);
  const plan = await api.preview({ kind: "service.shutdown" }, context);
  if (!plan?.id || plan.kind !== "service.shutdown") {
    throw new Error(`service.shutdown preview rejected: ${redact(JSON.stringify(plan))}`);
  }
  const requestId = randomUUID();
  const submitted = await api.submit({ kind: "plan.execute", planId: plan.id }, requestId, context);
  return waitShutdownJob(home, api, submitted, requestId, plan.id, 60_000);
}

function killOwnedPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: STOP_MS });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

function fixturePackumentHit(hits) {
  return hits.some((row) => row === `GET /${PLUGIN_NAME}` || row === `GET /${PLUGIN_NAME}/`);
}

function fixtureTarballHit(hits, tarballName) {
  return hits.some((row) => row === `GET /${PLUGIN_NAME}/-/${tarballName}`);
}

function assertTamperFixtureHits(hits, tarballName) {
  const packument = fixturePackumentHit(hits);
  const tarball = fixtureTarballHit(hits, tarballName);
  if (!packument || !tarball) {
    throw new Error(
      `tampered prepare did not hit fixture metadata+tarball (packument=${packument} tarball=${tarball} hits=${hits.slice(-12).join(", ") || "none"}). Cannot claim tamper validation.`,
    );
  }
}

function selfCheckHelpers() {
  const flags = { origin: false, bootstrap: false };
  assert.equal(noteBootAnnounce("INFO starting\n", flags), false);
  assert.equal(noteBootAnnounce("origin=http://127.0.0.1:4321\n", flags), false);
  assert.equal(flags.origin, true);
  assert.equal(noteBootAnnounce("bootstrap=http://127.0.0.1:4321/bootstrap/Zm9vYmFyYmF6\n", flags), true);
  assert.equal(
    isInitializedManager({
      protocolVersion: 2,
      availability: "limited",
      writable: true,
      role: "manager",
      managerId: "spaces-hub",
      spaces: [{ id: "spaces-hub", status: "running" }],
    }),
    false,
  );
  assert.equal(
    isInitializedManager({
      protocolVersion: 2,
      availability: "ready",
      writable: true,
      role: "uninitialized",
      managerId: "spaces-hub",
      spaces: [{ id: "spaces-hub", status: "running" }],
    }),
    false,
  );
  assert.equal(
    isInitializedManager({
      protocolVersion: 2,
      availability: "ready",
      writable: true,
      role: "manager",
      managerId: "spaces-hub",
      spaces: [{ id: "spaces-hub", status: "stopped" }],
    }),
    false,
  );
  assert.equal(
    isInitializedManager({
      protocolVersion: 2,
      availability: "ready",
      writable: true,
      role: "manager",
      managerId: "spaces-hub",
      spaces: [{ id: "spaces-hub", status: "running" }],
    }),
    true,
  );
  assert.equal(wrongNegativeCode({ code: "workbench/conflict" }), "workbench/conflict");
  assert.equal(wrongNegativeCode({ error: { code: "workbench/busy" } }), "workbench/busy");
  assert.equal(wrongNegativeCode({ error: { code: "workbench/failed", message: "integrity" } }), "");
  const hits = [`GET /${PLUGIN_NAME}`, `GET /${PLUGIN_NAME}/-/pkg.tgz`];
  assert.equal(fixturePackumentHit(hits), true);
  assert.equal(fixtureTarballHit(hits, "pkg.tgz"), true);
  assert.equal(fixtureTarballHit(hits, "other.tgz"), false);
  const digest = "ab".repeat(32);
  const other = "cd".repeat(32);
  assert.equal(handoffReceiptDecision(null, digest), "wait");
  assert.equal(handoffReceiptDecision({ status: "running", phase: "authorized", artifactDigest: digest }, digest), "wait");
  assert.equal(handoffReceiptDecision({ status: "running", phase: "spawned", artifactDigest: digest }, digest), "wait");
  assert.equal(handoffReceiptDecision({ status: "failed", phase: "failed", artifactDigest: digest, code: "accept-failed" }, digest), "failed");
  assert.equal(handoffReceiptDecision({ status: "succeeded", phase: "accepted", artifactDigest: other }, digest), "wrong-digest");
  assert.equal(handoffReceiptDecision({ status: "running", phase: "authorized", artifactDigest: other }, digest), "wrong-digest");
  assert.equal(handoffReceiptDecision({ status: "succeeded", phase: "accepted", artifactDigest: digest }, digest), "accepted");
  const beforeBoot = {
    webProfile: true,
    sessions: null,
    storages: null,
    ".credentials.yaml": false,
    ".anonymous-user-id": false,
  };
  const afterBoot = { ...beforeBoot, ".anonymous-user-id": true, ".credentials.yaml": true };
  assert.deepEqual(presenceDelta(beforeBoot, afterBoot).changed.sort(), [".anonymous-user-id", ".credentials.yaml"]);
  assert.equal(afterBoot[".anonymous-user-id"], true);
  assert.notDeepEqual(afterBoot[".anonymous-user-id"], beforeBoot[".anonymous-user-id"]);
}

async function supervisorHttpReachable(home) {
  const read = readEndpoint(home);
  if (!("endpoint" in read) || !read.endpoint?.origin) return false;
  const origin = String(read.endpoint.origin);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    try {
      const response = await fetch(origin, { method: "GET", redirect: "error", signal: ac.signal });
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function waitJob(home, api, submitted, requestId, label, timeout) {
  const id = submitted?.id;
  if (!id) throw new Error(`${label}: public submit was not accepted`);
  if (id !== requestId) throw new Error(`${label}: submit id ${id} != requestId ${requestId}`);
  const end = Date.now() + timeout;
  let last = null;
  let durableReason = "";
  while (Date.now() < end) {
    if (api) {
      try {
        const job = await api.job(id);
        last = job;
        if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
          return { job, proof: "http" };
        }
      } catch (error) {
        const code = workbenchErrorCode(error);
        if (code !== "workbench/unavailable") throw error;
        const reachable = await supervisorHttpReachable(home);
        durableReason = reachable ? "API unavailable" : "API unavailable (endpoint unreachable)";
      }
    } else {
      durableReason = "API unavailable";
    }
    if (durableReason) {
      const durable = readDurableJob(home, requestId);
      last = durable;
      if (durable?.status === "succeeded" || durable?.status === "failed" || durable?.status === "cancelled") {
        info(`${label}: ${durableReason} after public submit; durable job ${requestId} status=${durable.status} (durable proof)`);
        return { job: durable, proof: "durable" };
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out: ${label} job ${requestId}${last ? ` (${redact(JSON.stringify(last).slice(0, 240))})` : ""}`);
}

async function waitDurableSucceeded(home, requestId, label, timeout) {
  return until(
    () => {
      const durable = readDurableJob(home, requestId);
      if (durable?.status === "succeeded") return { job: durable, proof: "durable" };
      if (durable?.status === "failed" || durable?.status === "cancelled") {
        throw new Error(`${label}: durable job ${requestId} ${durable.status}`);
      }
      return null;
    },
    `${label} durable job ${requestId}`,
    timeout,
  );
}

function hasFetchShimImport(cmd) {
  const normalized = String(cmd).replaceAll("\\", "/");
  return /--import(?:\s+|=)(?:"[^"]*fetch-shim\.mjs[^"]*"|\S*fetch-shim\.mjs)/i.test(normalized);
}

function inventoryPayload() {
  const missing = [];
  const required = [
    "lib/supervisor/index.js",
    "lib/supervisor/snapshot-worker.mjs",
    "lib/supervisor/package.json",
    "lib/supervisor/launcher.mjs",
    "lib/supervisor/manifest.json",
  ];
  for (const rel of required) {
    if (!existsSync(join(PLUGIN_DIR, rel))) missing.push(`packages/plugin/${rel}`);
  }
  let schemaVersion = null;
  const manifestPath = join(PLUGIN_DIR, "lib", "supervisor", "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      schemaVersion = manifest.schemaVersion ?? null;
      if (schemaVersion !== 2) {
        missing.push(`packages/plugin/lib/supervisor/manifest.json schemaVersion=${schemaVersion ?? "missing"} (need 2)`);
      } else if (!manifest.components?.supervisor) {
        missing.push("packages/plugin/lib/supervisor/manifest.json missing supervisor component");
      } else {
        const declared = Array.isArray(manifest.components.supervisor.files)
          ? manifest.components.supervisor.files.some((file) => file.path === "lib/supervisor/launcher.mjs")
          : false;
        if (!declared) missing.push("v2 manifest does not declare lib/supervisor/launcher.mjs");
      }
    } catch {
      missing.push("packages/plugin/lib/supervisor/manifest.json unreadable");
    }
  }
  let validated = null;
  if (!missing.length) {
    try {
      validated = validateComponentPayload(join(PLUGIN_DIR, "lib"));
    } catch (error) {
      missing.push(`validateComponentPayload: ${error instanceof Error ? error.message : error}`);
    }
  }
  return {
    missing,
    schemaVersion,
    launcherMjs: existsSync(join(PLUGIN_DIR, "lib", "supervisor", "launcher.mjs")),
    digest: validated?.digest ?? null,
  };
}

function startFixtureServer({ tarballName, tarballPath, version }) {
  const state = { tarballPath, origin: "", hits: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${HOST}`);
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep */
    }
    state.hits.push(`${req.method} ${path}`);
    if (path === `/${PLUGIN_NAME}` || path === `/${PLUGIN_NAME}/`) {
      const packument = {
        name: PLUGIN_NAME,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: PLUGIN_NAME,
            version,
            dist: {
              tarball: `${state.origin}/@dsh-spaces/plugin/-/${tarballName}`,
            },
          },
        },
      };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(packument));
      return;
    }
    if (path === `/${PLUGIN_NAME}/-/${tarballName}`) {
      if (!existsSync(state.tarballPath)) {
        res.writeHead(404);
        res.end("missing fixture tarball");
        return;
      }
      const bytes = readFileSync(state.tarballPath);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "cache-control": "no-store",
      });
      res.end(bytes);
      return;
    }
    res.writeHead(404);
    res.end("fixture registry has no such path");
  });
  return { server, state };
}

async function listenLocal(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture registry listen failed");
  return `http://${HOST}:${address.port}`;
}

async function cachedPluginLibraryId(api, version) {
  const result = await api.product({ method: "library" });
  if (result.method !== "library") throw new Error("product library read failed");
  const needle = `${PLUGIN_NAME}@${version}`.toLowerCase();
  const entry =
    result.items.find((item) => item.id === needle) ||
    result.items.find((item) => item.packageName === PLUGIN_NAME && item.version === version);
  if (!entry) {
    throw new Error(
      `no public library entry ${needle} after failed prepare; download is cached before validation and must be removed via plugin.library.remove`,
    );
  }
  return entry.id;
}

async function runBrowserSuccessUpdate({
  attachClient,
  candidateVersion,
  home,
  toolsRoot,
  oldPid,
  oldStartedAt,
  oldPointer,
  afterAddProtected,
  prepareMs,
  executeMs,
}) {
  const playwright = await loadPlaywrightOptional();
  if (!playwright?.chromium) {
    throw new Error("--with-browser requires Playwright; set DSH_TEST_PLAYWRIGHT or install playwright");
  }
  const browser = await playwright.chromium.launch({ headless: true });
  let planId = "";
  let executeRequestId = "";
  let webBefore = null;
  let ordinaryBootChange = null;
  try {
    const page = await browser.newPage();
    const entry = await attachClient.entryUrl();
    await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const frame = page.frameLocator("iframe#manager-frame");
    await frame.locator(".dsh-workbench").waitFor({ timeout: 60_000 });
    await frame.getByRole("button", { name: /^(Home|首页)$/ }).click();
    await frame.getByRole("button", { name: /^(Settings|设置)$/ }).click();
    await frame.getByRole("tab", { name: /^(Runtime|运行时)$/ }).click();
    const prepareBtn = frame.locator('[data-workbench-prepare="true"]');
    await prepareBtn.waitFor({ timeout: 30_000 });
    await until(async () => !(await prepareBtn.isDisabled()), "Prepare update enabled", 30_000);
    webBefore = webProtectedFingerprint(home);
    ordinaryBootChange = presenceDelta(afterAddProtected, webBefore);
    if (ordinaryBootChange.changed.length) {
      info(
        `ordinary web/onboarding changed protected presence ${JSON.stringify(ordinaryBootChange.changed)} (not Prepare/update)`,
      );
    } else {
      info("ordinary web/onboarding did not change protected presence");
    }
    assert.equal(webBefore.webProfile, true, "profiles/web missing after ordinary workbench startup");
    await prepareBtn.click();
    await frame.locator(`[data-candidate-version="${candidateVersion}"]`).waitFor({ timeout: prepareMs });
    if (ownerPid(readOwner(home)) !== oldPid || defaultPidAlive(oldPid, oldStartedAt) !== "alive") {
      throw new Error("UI prepare stopped OLD before confirm");
    }
    if (pointerDigest(home, toolsRoot) !== oldPointer) {
      throw new Error("UI prepare selected the candidate before confirm");
    }
    const previewBtn = frame.locator('[data-workbench-upgrade="true"]');
    await until(async () => !(await previewBtn.isDisabled()), "Preview workbench update enabled", prepareMs);
    await previewBtn.click();
    const confirm = frame.locator("[data-plan-id]");
    await confirm.waitFor({ timeout: 30_000 });
    planId = (await confirm.getAttribute("data-plan-id")) || "";
    if (!planId) throw new Error("confirm button missing data-plan-id");
    await confirm.click();
    try {
      const executeJob = frame.locator(".dsh-wb-job").filter({ hasText: "plan.execute" });
      await executeJob.first().waitFor({ timeout: 15_000 });
      executeRequestId = (await executeJob.first().getAttribute("data-job-id")) || "";
    } catch {
      /* OLD HTTP/page may close; durable job file is the proof */
    }
  } finally {
    await browser.close();
  }
  if (!executeRequestId && planId) {
    const found = await until(
      () => findPlanExecuteJob(home, planId),
      `durable plan.execute for ${planId}`,
      30_000,
    );
    executeRequestId = found.requestId;
  }
  if (!executeRequestId) throw new Error("could not capture plan.execute requestId after UI confirm");
  const durable = await waitDurableSucceeded(home, executeRequestId, "UI plan.execute", executeMs);
  if (durable.job.status !== "succeeded") {
    throw new Error(`UI plan.execute durable ${durable.job.status}`);
  }
  info(`UI plan.execute ${executeRequestId} durable succeeded: old preparation pending confirmation (not handoff done)`);
  if (!webBefore) throw new Error("mutation-protection baseline was not captured after ordinary startup and before Prepare click");
  return { planId, executeRequestId, proof: durable.proof, webBefore, ordinaryBootChange };
}

async function loadPlaywrightOptional() {
  const override = process.env.DSH_TEST_PLAYWRIGHT?.trim();
  if (override) {
    const file = override.endsWith(".mjs") || override.endsWith(".js") ? override : join(override, "index.mjs");
    if (!existsSync(file)) throw new Error(`DSH_TEST_PLAYWRIGHT is not a Playwright entry: ${override}`);
    return import(pathToFileURL(resolve(file)).href);
  }
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

async function preflight({ syntaxOnly }) {
  nodeCheck(THIS_FILE);
  nodeCheck(SHIM);
  nodeCheck(REWRITE);
  selfCheckHelpers();
  staticOk("node --check passed for verifier, fetch-shim, and rewrite");
  staticOk("startup/precondition helpers: boot announce, initialized manager, wrong-negative, fixture hits, handoff receipt poll, web sentinel baseline");

  const probeHome = mkdtempSync(join(tmpdir(), "dsh-spaces-component-update-preflight-"));
  try {
    refuseRealHome(probeHome);
    try {
      refuseRealHome(join(homedir(), ".dsh"));
      throw new Error("refuseRealHome did not reject ~/.dsh");
    } catch (error) {
      if (!String(error.message).includes("refusing real")) throw error;
    }
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
  staticOk("disposable Home is required; real ~/.dsh is refused");

  if (!existsSync(SHIM) || !existsSync(REWRITE)) throw new Error("component-update fixture files missing");
  const shimText = readFileSync(SHIM, "utf8");
  if (!shimText.includes("DSH_TEST_COMPONENT_UPDATE") || !shimText.includes("rewritePluginRegistryUrl")) {
    throw new Error("fetch shim is missing the disposable-Home gate or URL rewrite");
  }
  if (shimText.includes("NODE_OPTIONS")) {
    throw new Error("fetch shim must not document or set NODE_OPTIONS (launcher would inherit it)");
  }
  staticOk("fetch shim is gated and does not use NODE_OPTIONS");

  const payload = inventoryPayload();
  report.payload = payload;
  if (syntaxOnly) {
    report.status = "syntax";
    report.scope = "syntax only; did not spawn Supervisor, DSH, fixture HTTP, or Playwright";
    if (payload.missing.length) {
      report.pendingBuild = payload.missing;
      for (const row of payload.missing) console.log(`PENDING ${row}`);
    }
    return report;
  }

  const testRun = spawnSync(process.execPath, ["--import", "tsx", "--test", SHIM_TEST], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: stripSecrets({ ...process.env, NODE_OPTIONS: "" }),
  });
  if (testRun.status !== 0) {
    throw new Error(`shim unit tests failed:\n${testRun.stdout || ""}\n${testRun.stderr || ""}`.slice(0, 4000));
  }
  staticOk("shim unit tests passed (spawn --import; no live Supervisor/DSH)");

  if (payload.missing.length) {
    throw new Error(
      `--preflight missing full v2 component payload / launcher.mjs: ${payload.missing.join("; ")}`,
    );
  }
  staticOk(`v2 component payload + launcher.mjs present digest=${payload.digest}`);

  let cli = null;
  try {
    const bin = resolveDshBin();
    cli = { bin, version: inspectCli(bin) };
    staticOk(`DSH_TEST_BIN present ${cli.version}`);
  } catch (error) {
    issue(String(error instanceof Error ? error.message : error));
  }
  report.cli = cli;

  report.status = "preflight";
  report.scope =
    "static/prereq only: syntax, shim gate/rewrite tests, v2 payload inventory, DSH_TEST_BIN. Did not pack, publish, boot Supervisor, or claim live PASS.";
  report.liveCommand = "node --import tsx scripts/verify-component-update.mjs --with-browser";
  report.preflightCommand = "node --import tsx scripts/verify-component-update.mjs --preflight";
  return report;
}

async function live() {
  const out = outputDir();
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot(), "run-"));
  refuseRealHome(scratch);
  const home = mkdtempSync(join(scratch, "home-"));
  refuseRealHome(home);
  const toolsRoot = join(scratch, "tools");
  const snapshotRoot = join(scratch, "snapshots");
  const copies = join(scratch, "copies");
  const packDest = join(scratch, "pack");
  mkdirSync(toolsRoot, { recursive: true });
  mkdirSync(snapshotRoot, { recursive: true });
  mkdirSync(copies, { recursive: true });
  mkdirSync(packDest, { recursive: true });
  report.home = home;
  report.scratch = scratch;
  session.home = home;

  const payload = inventoryPayload();
  report.payload = payload;
  if (payload.missing.length) {
    throw new Error(`live run missing full v2 component payload / launcher.mjs: ${payload.missing.join("; ")}`);
  }

  const bin = resolveDshBin();
  const cliVersionText = inspectCli(bin);
  const nodeExe = process.execPath;
  report.cli = { bin, version: cliVersionText };
  info(`official DSH ${cliVersionText} from DSH_TEST_BIN; local fixture HTTP (not published)`);

  const oldCopy = join(copies, "old");
  const candidateCopy = join(copies, "candidate");
  copyPluginPackage(oldCopy);
  copyPluginPackage(candidateCopy);
  const oldVersion = readVersion(join(oldCopy, "package.json")) || "0.3.0";
  const candidateVersion = fixtureVersionFor(oldVersion);
  if (!EXACT.test(candidateVersion)) throw new Error(`fixture version is not exact: ${candidateVersion}`);
  bumpIdentities(candidateCopy, candidateVersion);
  const oldPayload = writeComponentPayloadManifest(join(oldCopy, "lib"));
  const candidatePayload = writeComponentPayloadManifest(join(candidateCopy, "lib"));
  if (oldPayload.digest === candidatePayload.digest) {
    throw new Error("candidate payload digest equals old digest after version bump");
  }
  if (candidatePayload.manifest.version !== candidateVersion) {
    throw new Error(`candidate manifest version ${candidatePayload.manifest.version} != ${candidateVersion}`);
  }
  session.candidateDigest = candidatePayload.digest;
  info(`old digest=${oldPayload.digest} version=${oldPayload.manifest.version}`);
  info(`candidate digest=${candidatePayload.digest} version=${candidateVersion} (local fixture, not published)`);

  const npmCli = resolveNpmCli(nodeExe);
  const packedCandidate = runNpmPack(nodeExe, npmCli, candidateCopy, packDest, { dryRun: false });
  if (!existsSync(packedCandidate.path)) throw new Error("candidate npm pack did not write a tarball");
  const packedOld = runNpmPack(nodeExe, npmCli, oldCopy, packDest, { dryRun: false });
  const entries = listTarEntries(packedCandidate.path).map(normalizePacked);
  const missingPacked = PLUGIN_REQUIRED.filter((rel) => !entries.includes(rel) && rel !== "README.md");
  if (missingPacked.length) throw new Error(`candidate tarball missing ${missingPacked.join(", ")}`);
  const tamperedPath = join(packDest, `tampered-${packedCandidate.filename}`);
  writeFileSync(tamperedPath, readFileSync(packedCandidate.path).subarray(0, 64));

  const liveFixture = startFixtureServer({
    tarballName: packedCandidate.filename,
    tarballPath: tamperedPath,
    version: candidateVersion,
  });
  const fixtureOrigin = await listenLocal(liveFixture.server);
  liveFixture.state.origin = fixtureOrigin;
  session.server = liveFixture.server;
  info(`local fixture registry ${fixtureOrigin} (not published npm)`);
  report.fixtureOrigin = fixtureOrigin;

  try {
  const tooling = Object.fromEntries(["shim", "pnpmHome", "store", "cache"].map((key) => [key, join(scratch, key)]));
  Object.values(tooling).forEach((path) => mkdirSync(path, { recursive: true }));
  writePnpmShim(tooling.shim, nodeExe, resolvePnpmCjs());
  const baseEnv = stripSecrets(isolatedEnv(home, nodeExe, tooling));
  const spawnEnv = stripSecrets({
    ...baseEnv,
    DSH_HOME: home,
    DSH_SPACES_HOME: home,
    DSH_TEST_COMPONENT_UPDATE: "1",
    DSH_TEST_COMPONENT_UPDATE_HOME: home,
    DSH_TEST_FIXTURE_REGISTRY: fixtureOrigin,
  });

  runDsh(nodeExe, bin, home, tooling, ["--profile", WEB_PROFILE, "--dump-config"], DUMP_MS, "seed web", join(out, "seed.log"));
  assert.ok(existsSync(join(home, "profiles", WEB_PROFILE)), "official CLI did not create profiles/web");
  runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", WEB_PROFILE, "add", packedOld.path],
    PLUGIN_MS,
    "dsh plugin add web (old built tarball)",
    join(out, "plugin-add.log"),
  );
  pass("official DSH installed the old built plugin tarball on ordinary web");
  const afterAddProtected = webProtectedFingerprint(home);
  report.webProtection = {
    beforeOrdinaryBoot: webProtectedPresence(afterAddProtected),
  };

  const childRef = { current: null };
  const bootAnnounce = { origin: false, bootstrap: false };
  let bootScan = "";
  const boot = await bootstrapSupervisor({
    home,
    argv: [nodeExe, bin],
    execPath: nodeExe,
    payloadRoot: oldPayload.payloadRootLib,
    toolsRoot,
    snapshotRoot,
    allowColdStart: true,
    timeoutMs: BOOT_MS,
    env: spawnEnv,
    spawn: (request) => {
      const args = ["--import", pathToFileURL(SHIM).href, request.entry, ...request.argv];
      const child = spawn(request.execPath, args, {
        cwd: request.cwd,
        env: stripSecrets({ ...spawnEnv, ...request.env, DSH_HOME: home, DSH_SPACES_HOME: home }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        detached: false,
      });
      const log = join(out, "old-supervisor.log");
      const onData = (chunk) => {
        const raw = chunk.toString("utf8");
        try {
          writeFileSync(log, redact(raw), { flag: "a" });
        } catch {
          /* ignore */
        }
        bootScan = `${bootScan}${raw}`.slice(-2048);
        if (noteBootAnnounce(bootScan, bootAnnounce)) bootScan = "";
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      childRef.current = child;
      session.child = child;
      return child;
    },
  });
  if (!boot.connected) {
    throw new Error(`OLD supervisor bootstrap failed: ${(boot.reasons || []).join("; ") || "unknown"}`);
  }
  await until(() => {
    if (childRef.current && childRef.current.exitCode !== null) {
      throw new Error(`OLD supervisor exited ${childRef.current.exitCode} before origin/bootstrap announce`);
    }
    return bootAnnounce.origin && bootAnnounce.bootstrap;
  }, "OLD supervisor origin/bootstrap (createWorkbenchSupervisor returned)", BOOT_MS);
  info("OLD supervisor origin/bootstrap announced (createWorkbenchSupervisor returned)");
  const endpointRead = readEndpoint(home);
  if (!("endpoint" in endpointRead)) {
    throw new Error(`OLD supervisor endpoint is not v2: ${JSON.stringify(endpointRead)}`);
  }
  const oldEndpoint = endpointRead.endpoint;
  const oldOwner = readOwner(home);
  const oldPid = ownerPid(oldOwner);
  if (!oldPid) throw new Error("OLD owner pid missing");
  if (defaultPidAlive(oldPid, oldOwner.startedAt) !== "alive") throw new Error("OLD owner pid is not alive");
  const oldPointer = pointerDigest(home, toolsRoot);
  if (oldPointer && oldPointer !== oldPayload.digest) {
    throw new Error("selected pointer digest does not match the old payload");
  }
  pass(`OLD supervisor pid=${oldPid} epoch=${oldEndpoint.serviceEpoch.slice(0, 8)}… pointer=${oldPointer ? oldPointer.slice(0, 8) : "absent-until-handoff"}`);

  const api = createWorkbenchHttpClient({ endpoint: oldEndpoint });
  const state0 = await waitReadonlyInitialized(api, childRef, "OLD manager ready", BOOT_MS);
  assertV2State(state0, "old start");
  pass(`OLD manager ready writable role=manager id=${state0.managerId} space running`);
  const attachClient = new DesktopServiceClient({
    home,
    payloadRoot: oldPayload.payloadRootLib,
    toolsRoot,
    snapshotRoot,
  });
  const attached = await attachClient.connect();
  if (attached.status !== "connected") {
    throw new Error(`public attach before update failed: ${attached.reasons.join("; ")}`);
  }
  pass("public attach reused the running OLD service (no extra cold start)");

  const tamperState = await waitReadonlyInitialized(api, childRef, "OLD manager ready before tamper", BOOT_MS);
  assertV2State(tamperState, "before tamper");
  const tamperContext = contextOf(tamperState);
  const tamperId = randomUUID();
  const hitsBefore = liveFixture.state.hits.length;
  let failedPrepare;
  try {
    failedPrepare = await api.submit(
      { kind: "workbench.prepare", version: candidateVersion },
      tamperId,
      tamperContext,
    );
  } catch (error) {
    failIfWrongNegative("tampered prepare submit", error);
    throw error;
  }
  const failedWait = await waitJob(home, api, failedPrepare, tamperId, "tampered prepare", PREPARE_MS);
  failIfWrongNegative("tampered prepare", failedWait.job);
  if (failedWait.job.status !== "failed") {
    throw new Error(`tampered prepare expected failed, got ${failedWait.job.status}`);
  }
  assertTamperFixtureHits(liveFixture.state.hits.slice(hitsBefore), packedCandidate.filename);
  if (ownerPid(readOwner(home)) !== oldPid) throw new Error("tampered prepare changed owner pid");
  if (defaultPidAlive(oldPid, oldOwner.startedAt) !== "alive") throw new Error("tampered prepare stopped OLD supervisor");
  const afterFailPointer = pointerDigest(home, toolsRoot);
  if (afterFailPointer !== oldPointer) throw new Error("tampered prepare changed the selected pointer");
  const failEndpoint = readEndpoint(home);
  if (!("endpoint" in failEndpoint) || failEndpoint.endpoint.bearer !== oldEndpoint.bearer) {
    throw new Error("tampered prepare replaced the OLD bearer");
  }
  if (failEndpoint.endpoint.serviceEpoch !== oldEndpoint.serviceEpoch) {
    throw new Error("tampered prepare changed serviceEpoch");
  }
  pass("tampered/missing candidate bytes failed after fixture metadata+tarball hits; OLD pid/pointer/bearer stayed");

  const cachedId = await cachedPluginLibraryId(api, candidateVersion);
  const removeId = randomUUID();
  const removed = await api.submit(
    { kind: "plugin.library.remove", libraryId: cachedId },
    removeId,
    contextOf(await api.state()),
  );
  const removeWait = await waitJob(home, api, removed, removeId, "plugin.library.remove", PREPARE_MS);
  if (removeWait.job.status !== "succeeded") {
    throw new Error(`plugin.library.remove ${removeWait.job.status}: ${redact(JSON.stringify(removeWait.job.error || removeWait.job))}`);
  }
  const libraryAfter = await api.product({ method: "library" });
  if (libraryAfter.method === "library" && libraryAfter.items.some((item) => item.id === cachedId)) {
    throw new Error(`library still contains ${cachedId} after public plugin.library.remove`);
  }
  pass(`public plugin.library.remove ${cachedId} succeeded; product cache was not Home-deleted`);

  liveFixture.state.tarballPath = packedCandidate.path;
  const withBrowser = process.argv.includes("--with-browser");
  const apiOnly = process.argv.includes("--api-only") || !withBrowser;
  let uiUsed = false;
  let executeRequestId = "";
  let planId = "";
  let executeProof = "";
  let webBefore;

  if (withBrowser) {
    const ui = await runBrowserSuccessUpdate({
      attachClient,
      candidateVersion,
      home,
      toolsRoot,
      oldPid,
      oldStartedAt: oldOwner.startedAt,
      oldPointer,
      afterAddProtected,
      prepareMs: PREPARE_MS,
      executeMs: EXECUTE_MS,
    });
    uiUsed = true;
    planId = ui.planId;
    executeRequestId = ui.executeRequestId;
    executeProof = ui.proof;
    webBefore = ui.webBefore;
    report.webProtection.beforePrepare = webProtectedPresence(webBefore);
    report.webProtection.ordinaryBootChange = ui.ordinaryBootChange;
    report.webProtection.protectionBaseline = "beforePrepare";
    if (ownerPid(readOwner(home)) === oldPid && defaultPidAlive(oldPid, oldOwner.startedAt) === "alive") {
      info("OLD still alive immediately after UI confirm; waiting for handoff");
    }
    pass("mutation-protection baseline captured after ordinary workbench startup/onboarding; before Prepare click");
    pass("Chromium Prepare update (latest) + preview/confirm ran; fixture dist-tag latest is the exact candidate");
  } else {
    if (!apiOnly) throw new Error("success path requires --with-browser or --api-only");
    webBefore = webProtectedFingerprint(home);
    report.webProtection.beforePrepare = webProtectedPresence(webBefore);
    report.webProtection.ordinaryBootChange = presenceDelta(afterAddProtected, webBefore);
    report.webProtection.protectionBaseline = "beforePrepare";
    pass("mutation-protection baseline captured before API prepare");
    const prepareId = randomUUID();
    const prepared = await api.submit(
      { kind: "workbench.prepare", version: candidateVersion },
      prepareId,
      contextOf(await api.state()),
    );
    const preparedWait = await waitJob(home, api, prepared, prepareId, "prepare", PREPARE_MS);
    if (preparedWait.job.status !== "succeeded") {
      throw new Error(`prepare failed: ${redact(JSON.stringify(preparedWait.job.error || preparedWait.job))}`);
    }
    if (ownerPid(readOwner(home)) !== oldPid) throw new Error("successful prepare stopped OLD before confirm");
    if (pointerDigest(home, toolsRoot) !== oldPointer) throw new Error("successful prepare selected the candidate before confirm");
    const pkg = await api.workbenchPackage();
    if (!pkg || pkg.version !== candidateVersion) {
      throw new Error(`prepared candidate version ${pkg?.version ?? "missing"} != ${candidateVersion}`);
    }
    if (!pkg.updateAvailable) throw new Error("prepared candidate did not report updateAvailable");
    pass(`API prepare ${candidateVersion} succeeded; OLD still owner until confirm`);

    const previewState = await api.state();
    const plan = await api.preview(
      { kind: "workbench.upgrade", catalogId: "bundled-workbench", version: candidateVersion },
      contextOf(previewState),
    );
    if (!plan?.id || plan.kind !== "workbench.upgrade") {
      throw new Error(`workbench.upgrade preview rejected: ${redact(JSON.stringify(plan))}`);
    }
    planId = plan.id;
    executeRequestId = randomUUID();
    const executed = await api.submit(
      { kind: "plan.execute", planId: plan.id },
      executeRequestId,
      contextOf(previewState),
    );
    const executeWait = await waitJob(home, api, executed, executeRequestId, "upgrade execute", EXECUTE_MS);
    if (executeWait.job.status !== "succeeded") {
      throw new Error(`upgrade execute ${executeWait.job.status}: ${redact(JSON.stringify(executeWait.job.error || executeWait.job))}`);
    }
    executeProof = executeWait.proof;
    pass(`preview/execute workbench.upgrade ${executeProof === "durable" ? "durable proof" : "HTTP terminal"}`);
  }
  if (executeProof === "durable") {
    info(`plan.execute ${executeRequestId} durable succeeded: old preparation pending confirmation (not handoff done)`);
  }

  await until(() => {
    try {
      if (childRef.current && childRef.current.exitCode === null && childRef.current.signalCode === null) {
        process.kill(oldPid, 0);
        return false;
      }
    } catch (error) {
      if (error && error.code === "ESRCH") return true;
    }
    return defaultPidAlive(oldPid, oldOwner.startedAt) === "dead";
  }, "OLD supervisor pid exited after confirm", 60_000);

  const nextIdentity = await until(() => {
    const endpoint = readEndpoint(home);
    const owner = readOwner(home);
    const pid = ownerPid(owner);
    if (!("endpoint" in endpoint) || !pid || pid === oldPid) return null;
    if (endpoint.endpoint.bearer === oldEndpoint.bearer) return null;
    if (endpoint.endpoint.serviceEpoch === oldEndpoint.serviceEpoch) return null;
    if (defaultPidAlive(pid, owner.startedAt) !== "alive") return null;
    return { endpoint: endpoint.endpoint, owner, pid };
  }, "new owner pid/epoch/bearer", 120_000);

  const oldReject = await fetch(`${oldEndpoint.origin}/api/workbench/state`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${oldEndpoint.bearer}`,
      origin: oldEndpoint.origin,
    },
    body: "{}",
    redirect: "error",
  });
  if (oldReject.ok) throw new Error("OLD endpoint bearer still authorized after handoff");
  pass("OLD endpoint token rejected; new pid/epoch/bearer are live");

  const newPointer = pointerDigest(home, toolsRoot);
  if (newPointer !== candidatePayload.digest) {
    throw new Error(
      `selected pointer digest ${newPointer} !== candidate payload digest ${candidatePayload.digest} (pkg.digest is archive combo, not payload)`,
    );
  }
  const receipt = await waitHandoffReceiptAccepted(
    home,
    candidatePayload.digest,
    "handoff receipt succeeded/accepted",
    BOOT_MS,
  );
  if (receipt.artifactDigest !== candidatePayload.digest) {
    throw new Error(`handoff receipt artifactDigest ${receipt.artifactDigest} !== candidate ${candidatePayload.digest}`);
  }
  pass(`handoff receipt succeeded phase=accepted artifactDigest=${newPointer.slice(0, 8)}…`);

  const newCmd = processCommandLine(nextIdentity.pid);
  if (!newCmd) throw new Error("could not read new supervisor command line to prove the fixture loader is absent");
  if (hasFetchShimImport(newCmd)) {
    throw new Error("new supervisor command line still has --import fetch-shim.mjs");
  }
  const selectedEntry = join(toolsRoot, "components", candidatePayload.digest, "lib", "supervisor", "index.js");
  const cmdHay = newCmd.replaceAll("%5C", "\\").replaceAll("%2F", "/");
  const entryVariants = [
    selectedEntry,
    selectedEntry.replaceAll("/", "\\"),
    selectedEntry.replaceAll("\\", "/"),
    pathToFileURL(selectedEntry).href,
  ];
  if (!entryVariants.some((value) => cmdHay.includes(value) || cmdHay.toLowerCase().includes(value.toLowerCase()))) {
    throw new Error(`new supervisor argv does not contain selected entry ${selectedEntry}`);
  }
  pass("new Supervisor CLI has no fetch-shim --import and runs the selected supervisor entry");

  attachClient.dispose();
  const second = new DesktopServiceClient({
    home,
    payloadRoot: join(toolsRoot, "components", newPointer, "lib"),
    toolsRoot,
    snapshotRoot,
  });
  const secondState = await second.connect();
  if (secondState.status !== "connected") {
    throw new Error(`post-handoff attach failed (would imply extra cold start): ${secondState.reasons.join("; ")}`);
  }
  const newApi = second.getApi();
  const fresh = await waitReadonlyInitialized(newApi, { current: null }, "new manager ready after handoff receipt", BOOT_MS);
  assertV2State(fresh, "new service");
  if (fresh.serviceEpoch !== nextIdentity.endpoint.serviceEpoch) {
    throw new Error("public state epoch does not match the new endpoint");
  }
  pass("fresh public state/manager ready writable running; attach did not extra cold-start");

  assertWebSentinelsUnchanged(home, webBefore, "after component update");
  pass("profiles/web sentinel paths preserved around component mutation (presence/names only; credential bytes unread)");

  const shutdownWait = await submitPublicShutdown(home, newApi, fresh);
  if (shutdownWait.proof === "durable") {
    pass("service.shutdown durable job file succeeded (not HTTP success)");
  }
  const newPort = Number(new URL(nextIdentity.endpoint.origin).port);
  await waitPortClosed(newPort, PORT_MS);
  await until(
    () => defaultPidAlive(nextIdentity.pid, nextIdentity.owner.startedAt) === "dead",
    "new owner pid dead after service.shutdown",
    30_000,
  );
  const afterShutdown = readEndpoint(home);
  if ("endpoint" in afterShutdown) throw new Error("endpoint.json still valid after service.shutdown");
  if (defaultPidAlive(process.pid, new Date().toISOString()) !== "alive") {
    throw new Error("harness process died during shutdown");
  }
  pass("public service.shutdown succeeded; owned supervisor pid dead; this process still alive");
  second.dispose();
  report.uiUsed = uiUsed;
  report.candidateVersion = candidateVersion;
  report.livePass = true;
  report.status = "pass";
  return { home, liveFixture, childRef, toolsRoot };
  } catch (error) {
    try {
      liveFixture.server.close();
    } catch {
      /* ignore */
    }
    throw error;
  }
}

async function forceCleanOwned(home, child, _error) {
  const result = { forced: false, pid: null, shutdownAttempted: false, shutdownProof: "", leftInProgress: false };
  if (child) await stopOwned(child);
  const owner = readOwner(home);
  const pid = ownerPid(owner);
  result.pid = pid;
  if (!pid || defaultPidAlive(pid, owner?.startedAt || new Date().toISOString()) !== "alive") {
    return result;
  }

  let receipt = null;
  try {
    receipt = await waitHandoffReceiptTerminal(home, session.candidateDigest, BOOT_MS);
  } catch {
    killOwnedPid(pid);
    result.forced = true;
    return result;
  }
  const decision = session.candidateDigest
    ? handoffReceiptDecision(receipt, session.candidateDigest)
    : receipt && receipt.status === "succeeded" && receipt.phase === "accepted"
      ? "accepted"
      : receipt && (receipt.status === "failed" || receipt.phase === "failed")
        ? "failed"
        : "wait";
  if (decision !== "accepted") {
    killOwnedPid(pid);
    result.forced = true;
    return result;
  }

  try {
    const endpointRead = readEndpoint(home);
    if (!("endpoint" in endpointRead)) throw new Error("cleanup shutdown: endpoint missing");
    const api = createWorkbenchHttpClient({ endpoint: endpointRead.endpoint });
    const ready = await waitReadonlyInitialized(api, { current: null }, "cleanup manager ready before shutdown", BOOT_MS);
    result.shutdownAttempted = true;
    const shutdown = await submitPublicShutdown(home, api, ready);
    result.shutdownProof = shutdown.proof;
    const origin = endpointRead.endpoint.origin;
    const port = Number(new URL(origin).port);
    if (Number.isInteger(port) && port > 0) await waitPortClosed(port, PORT_MS);
    await until(
      () => defaultPidAlive(pid, owner.startedAt) === "dead",
      "cleanup owner pid dead after public service.shutdown",
      30_000,
    );
    return result;
  } catch {
    /* public shutdown did not finish; fall through to process cleanup */
  }
  if (defaultPidAlive(pid, owner?.startedAt || new Date().toISOString()) === "alive") {
    killOwnedPid(pid);
    result.forced = true;
  }
  return result;
}

async function main() {
  const syntaxOnly = process.argv.includes("--syntax") && !process.argv.includes("--preflight");
  const preflightOnly = process.argv.includes("--preflight") || process.argv.includes("--syntax");
  const out = outputDir();
  mkdirSync(out, { recursive: true });
  report.output = out;
  report.startedAt = new Date().toISOString();

  if (preflightOnly) {
    try {
      await preflight({ syntaxOnly });
      writeJson(join(out, syntaxOnly ? "syntax.json" : "preflight.json"), report);
      console.log("");
      console.log(
        syntaxOnly
          ? "COMPONENT UPDATE SYNTAX: OK (static only; not live PASS)"
          : "COMPONENT UPDATE PREFLIGHT: OK (static only; not live PASS)",
      );
      console.log("Live command after build:spaces + DSH_TEST_BIN:");
      console.log("  node --import tsx scripts/verify-component-update.mjs --with-browser");
      if (report.pendingBuild?.length) {
        console.log("Pending build:");
        for (const row of report.pendingBuild) console.log(`  - ${row}`);
      }
      if (report.contractIssues.length) {
        console.log("Contract issues:");
        for (const row of report.contractIssues) console.log(`  - ${row}`);
      }
    } catch (error) {
      report.status = "fail";
      report.livePass = false;
      report.error = redact(error instanceof Error ? error.stack || error.message : String(error));
      writeJson(join(out, syntaxOnly ? "syntax.json" : "preflight.json"), report);
      console.log("");
      console.log("COMPONENT UPDATE PREFLIGHT: FAIL");
      if (report.payload?.missing?.length) {
        console.log("Missing payload / launcher:");
        for (const row of report.payload.missing) console.log(`  - ${row}`);
      }
      throw error;
    }
    return;
  }

  try {
    await live();
    writeJson(join(out, "results.json"), report);
    console.log("\nCOMPONENT UPDATE: PASS");
  } catch (error) {
    report.status = "fail";
    report.livePass = false;
    report.error = redact(error instanceof Error ? error.stack || error.message : String(error));
    writeJson(join(out, "results.json"), report);
    if (session.home) {
      try {
        const cleaned = await forceCleanOwned(session.home, session.child, error);
        if (cleaned.forced) {
          console.log(`FAIL  public service.shutdown did not complete; owned-pid cleanup fallback used for pid ${cleaned.pid} (not PASS)`);
        } else if (cleaned.shutdownAttempted) {
          console.log(
            `FAIL  public service.shutdown ran during harness failure cleanup (proof=${cleaned.shutdownProof || "http"}; not PASS)`,
          );
        }
      } catch (cleanError) {
        console.log(`FAIL  owned-child cleanup fallback also failed: ${redact(cleanError instanceof Error ? cleanError.message : cleanError)}`);
      }
    }
    throw error;
  } finally {
    try {
      session.server?.close();
    } catch {
      /* ignore */
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAIL  ${redact(error instanceof Error ? error.stack || error.message : String(error))}`);
    process.exitCode = 1;
  });
}

export { inventoryPayload, fixtureVersionFor, waitJob, readDurableJob };
