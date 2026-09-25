#!/usr/bin/env node
/**
 * Standard install acceptance: official `dsh plugin --profile web add` of the
 * prebuilt plugin tarball, real web boot, Playwright click of initialize,
 * supervisor creates one manager and hands off, create/start a space, repeat
 * initialize does not add a manager, close/restart, web remove leaves no bundle.
 *
 * No model calls. Disposable Home only (refuses ~/.dsh). No machine-path
 * defaults. Does not import verify-workbench-product.mjs (that file runs at load).
 *
 *   node scripts/verify-plugin-standard-install.mjs --syntax
 *   node scripts/verify-plugin-standard-install.mjs --preflight
 *   node scripts/verify-plugin-standard-install.mjs
 *
 * Env: DSH_TEST_BIN, DSH_TEST_CLI_BIN, DSH_TEST_OUTPUT, DSH_TEST_PLAYWRIGHT,
 * DSH_TEST_PNPM_CJS, DSH_PACK_DEST.
 *
 * --syntax / --preflight are static only: no DSH web, no supervisor,
 * no Playwright browser, no shared build, no real ~/.dsh.
 * Protocol v2: preview/submit carry {serviceEpoch, expectedRevision};
 * stop uses service.shutdown. Force-clean is cleanup, never PASS.
 * Initialization-protection baseline is after ordinary web auth/onboarding,
 * not after plugin add. After-add inventory stays in the report separately.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  BOOT_MS,
  DUMP_MS,
  HOST,
  PLUGIN_MS,
  PORT_MS,
  STOP_MS,
  captureLaunchUrl,
  cliVersion,
  ephemeralPort,
  isolatedEnv,
  redact as redactBase,
  refuseRealHome,
  run,
  runDsh,
  sha256File,
  stopOwned,
  waitPortClosed,
  writeJson,
  writePnpmShim,
} from "./verify-spaces-distribution.mjs";
import { PLUGIN_REQUIRED, defaultPackDest, assertNoSpaces } from "./pack-spaces-plugin.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);
const PACK_SCRIPT = join(REPO, "scripts", "pack-spaces-plugin.mjs");
const PLUGIN_DIR = join(REPO, "packages", "plugin");
const CANONICAL_NAME = "@dsh-spaces/plugin";
const WEB_PROFILE = "web";
const EXACT_CLI = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEX64 = /^[a-f0-9]{64}$/;
const GUIDE_ROOT = "[data-dsh-spaces-guide]:visible";
const GUIDE_INIT = '[data-dsh-spaces-action="initialize"]';
const GUIDE_ENTER = '[data-dsh-spaces-action="enter"]';
const GUIDE_ALERT = "[data-dsh-spaces-error][role='alert']:visible, [data-dsh-spaces-error] [role='alert']:visible";
const SIDEBAR_TAB = /^(工作台|Workbench)$/;
const ONBOARDING = [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i];
const MANAGER_FRAME = "iframe[data-spaces-host-surface]";
const WORKBENCH_ROOT = ".dsh-workbench";
const CONTROL_DIR = ".dsh-spaces-control";
const JOBS_DIR = "jobs";
const PUBLIC_JOB_WAIT_MS = 240000;
const MANAGER_FILE = "manager.json";
const ENDPOINT_FILE = "endpoint.json";
const ENTRY_PORT_FILE = "entry-port.json";
const OWNER_FILE = join("run", "owner.json");
const WEB_PROTECTED = ["sessions", "storages", ".credentials.yaml", ".anonymous-user-id"];

const proved = [];
const report = {
  status: "running",
  proved,
  modelCalls: false,
  unpublished: true,
  pageErrors: [],
  consoleErrors: [],
  rpcErrors: [],
  cli: { channel: "latest" },
};

function redact(value) {
  return redactBase(value).replace(/\/bootstrap\/[A-Za-z0-9_-]+/g, "/bootstrap/[redacted]");
}

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}
function pass(m) {
  proved.push(m);
  console.log(`PASS  ${redact(m)}`);
}

function outputDir() {
  return resolve(process.env.DSH_TEST_OUTPUT || join(REPO, ".sandbox", "plugin-standard-install"));
}

function npmGlobalRoot() {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const path = (result.stdout || "").trim();
  return result.status === 0 && path ? path : "";
}

function dshBinFromPackage(dir) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.name !== "@deepseek-ai/dsh") return null;
  const bin = join(dir, "lib", "bin.js");
  return existsSync(bin) ? resolve(bin) : null;
}

function resolveDshBin(envName = "DSH_TEST_BIN") {
  const override = process.env[envName]?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`${envName} is not a file: ${override}`);
    return resolve(override);
  }
  if (envName !== "DSH_TEST_BIN") return null;
  const globalRoot = npmGlobalRoot();
  const fromGlobal = globalRoot ? dshBinFromPackage(join(globalRoot, "@deepseek-ai", "dsh")) : null;
  if (fromGlobal) return fromGlobal;
  throw new Error(
    "Official DSH CLI not found. Install the global package (@deepseek-ai/dsh@0.1.7-alpha.1) or set DSH_TEST_BIN to that package's lib/bin.js. This script does not guess a machine-local Temp path.",
  );
}

function resolvePnpmCjs() {
  const override = process.env.DSH_TEST_PNPM_CJS?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_TEST_PNPM_CJS is not a file: ${override}`);
    return resolve(override);
  }
  const globalRoot = npmGlobalRoot();
  const candidates = [
    globalRoot ? join(globalRoot, "pnpm", "bin", "pnpm.cjs") : "",
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs") : "",
    join(REPO, "node_modules", "pnpm", "bin", "pnpm.cjs"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return resolve(path);
  }
  throw new Error("pnpm.cjs not found. Set DSH_TEST_PNPM_CJS to pnpm's bin/pnpm.cjs.");
}

async function loadPlaywright() {
  const override = process.env.DSH_TEST_PLAYWRIGHT?.trim();
  if (override) {
    const file = override.endsWith(".mjs") || override.endsWith(".js") ? override : join(override, "index.mjs");
    if (!existsSync(file)) throw new Error(`DSH_TEST_PLAYWRIGHT is not a Playwright entry: ${override}`);
    return import(pathToFileURL(resolve(file)).href);
  }
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Playwright not found. Set DSH_TEST_PLAYWRIGHT to playwright/index.mjs (or a directory containing it). This script does not guess a Codex cache path.",
    );
  }
}

function inspectCli(bin, label) {
  const version = cliVersion(bin);
  if (!version || version === "latest" || version === "next" || !EXACT_CLI.test(version)) {
    throw new Error(`${label} did not report an exact DSH CLI version (${version || "empty"})`);
  }
  return version;
}

function pluginState(home, name) {
  const pkgPath = join(home, "profiles", name, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : null;
  const deps = pkg?.dependencies ?? {};
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const installDir = join(home, "profiles", name, "node_modules", ...CANONICAL_NAME.split("/"));
  return {
    dependency: Object.prototype.hasOwnProperty.call(deps, CANONICAL_NAME) ? String(deps[CANONICAL_NAME]) : null,
    inBundles: bundles.includes(CANONICAL_NAME),
    installedOnDisk: existsSync(join(installDir, "package.json")),
  };
}

function hubProfiles(home) {
  const dir = join(home, "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^spaces-hub(?:-\d+)?$/i.test(name));
}

function namesIfPresent(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return existsSync(path) ? ["<present>"] : null;
  }
}

/** Presence/names only. Never read credential bytes. */
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

/** Safe booleans only: file existence and directory presence, never names or bytes. */
function webProtectedPresence(fp) {
  const out = { webProfile: fingerprintPresent(fp.webProfile) };
  for (const name of WEB_PROTECTED) out[name] = fingerprintPresent(fp[name]);
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

function assertWebPathsProtected(home, before, label) {
  const after = webProtectedFingerprint(home);
  assert.equal(after.webProfile, true, `${label}: ordinary web profile is missing`);
  for (const name of WEB_PROTECTED) {
    assert.deepEqual(after[name], before[name], `${label}: protected ${name} changed`);
  }
  if (hubProfiles(home).includes(WEB_PROFILE)) {
    throw new Error(`${label}: ordinary web was turned into a manager`);
  }
  return after;
}

function managerRecord(home) {
  const path = join(home, CONTROL_DIR, MANAGER_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { broken: true, path };
  }
}

function assertManagerAbsent(home, label) {
  const hubs = hubProfiles(home);
  if (hubs.length !== 0) {
    throw new Error(`${label}: expected no manager profile, found ${JSON.stringify(hubs)}`);
  }
  const record = managerRecord(home);
  if (record) {
    throw new Error(`${label}: manager.json present before initialize`);
  }
}

function dumpHasPlugin(dump) {
  return /^- id:\s*dsh-spaces\b/m.test(dump) && dump.includes(CANONICAL_NAME);
}

function stripSecrets(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH).*(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key)) {
      delete next[key];
    }
  }
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

async function until(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

async function startWeb(nodeExe, bin, home, tooling, logPath) {
  const port = await ephemeralPort();
  writeFileSync(logPath, "", "utf8");
  const child = spawn(nodeExe, [bin, "--profile", WEB_PROFILE, "--no-open", "--host", HOST, "--port", String(port)], {
    env: stripSecrets(isolatedEnv(home, nodeExe, tooling)),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.pid) throw new Error("failed to spawn web");
  child.stdout?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  child.stderr?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  try {
    const launchUrl = await captureLaunchUrl(child, port, BOOT_MS);
    return { child, port, launchUrl };
  } catch (error) {
    await stopOwned(child);
    throw error;
  }
}

async function openAuthorizedWeb(page, launchUrl) {
  await page.goto(launchUrl.href, { waitUntil: "domcontentloaded", timeout: 30000 });
}

async function dismissOnboarding(page) {
  for (const label of ONBOARDING) {
    const button = page.getByRole("button", { name: label }).first();
    try {
      await button.waitFor({ state: "visible", timeout: 8000 });
      if (await button.isVisible()) await button.click();
    } catch {
      /* optional first-run chrome */
    }
  }
}

async function guideAlert(page) {
  const alert = page.locator(GUIDE_ALERT).first();
  if (!(await alert.count())) return "";
  if (!(await alert.isVisible().catch(() => false))) return "";
  return ((await alert.textContent()) || "").trim();
}

async function openGuidePanel(page) {
  const panel = page.locator(GUIDE_ROOT);
  if (await panel.isVisible().catch(() => false)) return panel;
  const tab = page.getByRole("button", { name: SIDEBAR_TAB });
  await tab.waitFor({ state: "visible", timeout: 30000 });
  await tab.click();
  await panel.waitFor({ state: "visible", timeout: 15000 });
  return panel;
}

async function clickInitialize(page) {
  const panel = await openGuidePanel(page);
  const init = panel.locator(GUIDE_INIT);
  await init.waitFor({ state: "visible", timeout: 30000 });
  if (await init.isDisabled()) throw new Error("guide initialize action is disabled");
  await init.click();
}

async function enterOrInitialize(page) {
  const panel = await openGuidePanel(page);
  const action = panel.locator(`${GUIDE_ENTER}, ${GUIDE_INIT}`).first();
  await action.waitFor({ state: "visible", timeout: 30000 });
  const kind = await action.getAttribute("data-dsh-spaces-action");
  if (kind !== "enter" && kind !== "initialize") {
    throw new Error(`guide action is not v2 initialize/enter: ${kind || "missing"}`);
  }
  if (await action.isDisabled()) throw new Error(`guide ${kind} action is disabled`);
  await action.click();
  return kind;
}

function assertSingleManager(home, label) {
  const hubs = hubProfiles(home);
  const record = managerRecord(home);
  if (hubs.length !== 1) {
    throw new Error(`${label}: expected one manager profile, found ${JSON.stringify(hubs)}`);
  }
  if (hubs[0] === WEB_PROFILE) {
    throw new Error(`${label}: manager profile must not be ordinary web`);
  }
  if (!record || record.broken) throw new Error(`${label}: manager.json missing or damaged`);
  if (record.profileId === WEB_PROFILE) {
    throw new Error(`${label}: manager.json bound ordinary web`);
  }
  if (record.profileId !== hubs[0]) {
    assert.fail(`${label}: manager.json profileId=${record.profileId} hub=${hubs[0]}`);
  }
  return { hubs, record };
}

function loopbackOrigin(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== HOST || url.username || url.password) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1) return null;
    return { origin: `${url.protocol}//${url.hostname}:${port}`, port };
  } catch {
    return null;
  }
}

function readV2Endpoint(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.version === 1) return null;
  if (raw.version !== 2 || raw.protocolVersion !== 2) return null;
  const parsed = typeof raw.origin === "string" ? loopbackOrigin(raw.origin) : null;
  if (!parsed || typeof raw.bearer !== "string" || !raw.bearer) return null;
  if (typeof raw.homeId !== "string" || !HEX64.test(raw.homeId)) return null;
  if (typeof raw.serviceEpoch !== "string" || !HEX64.test(raw.serviceEpoch)) return null;
  return {
    origin: parsed.origin,
    port: parsed.port,
    bearer: raw.bearer,
    homeId: raw.homeId,
    serviceEpoch: raw.serviceEpoch,
    protocolVersion: 2,
  };
}

function ownerPid(owner) {
  if (!owner || typeof owner !== "object") return null;
  const pid = Number(owner.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function ownerStartedAt(owner) {
  return typeof owner?.startedAt === "string" ? owner.startedAt : "";
}

function pidLiveness(pid, startedAt) {
  if (!pid) return "missing";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error && error.code === "ESRCH") return "dead";
    return "ambiguous";
  }
  if (startedAt && !Number.isFinite(Date.parse(startedAt))) return "ambiguous";
  return "alive";
}

function readHomeIdentity(home) {
  const control = join(home, CONTROL_DIR);
  const endpointPath = join(control, ENDPOINT_FILE);
  const portPath = join(control, ENTRY_PORT_FILE);
  const ownerPath = join(control, OWNER_FILE);
  let endpoint = null;
  if (existsSync(endpointPath)) {
    try {
      endpoint = readV2Endpoint(JSON.parse(readFileSync(endpointPath, "utf8")));
    } catch {
      endpoint = null;
    }
  }
  let entryPort = null;
  if (existsSync(portPath)) {
    try {
      const raw = JSON.parse(readFileSync(portPath, "utf8"));
      if (raw.version === 1 && Number.isInteger(raw.port) && raw.port > 0) entryPort = raw.port;
    } catch {
      entryPort = null;
    }
  }
  let owner = null;
  if (existsSync(ownerPath)) {
    try {
      owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    } catch {
      owner = null;
    }
  }
  if (endpoint && entryPort && endpoint.port !== entryPort) {
    throw new Error(`this Home endpoint port ${endpoint.port} != entry-port.json ${entryPort}`);
  }
  return { endpoint, entryPort: entryPort ?? endpoint?.port ?? null, owner };
}

function contextOf(state) {
  if (!HEX64.test(state?.serviceEpoch || "") || !HEX64.test(state?.revision || "")) {
    throw new Error("workbench mutation context requires 64-hex serviceEpoch and revision");
  }
  return { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision };
}

function assertV2State(state, label) {
  if (!state || state.protocolVersion !== 2) {
    throw new Error(`${label}: workbench state is not protocol v2`);
  }
  if (Object.prototype.hasOwnProperty.call(state, "recoveryRequired")) {
    throw new Error(`${label}: stale recoveryRequired field on v2 state`);
  }
  contextOf(state);
}

function viewSrc(view) {
  if (!view || typeof view.entryOrigin !== "string" || typeof view.origin !== "string") {
    throw new Error("view DTO missing origin/entryOrigin");
  }
  const entry = loopbackOrigin(view.entryOrigin);
  const child = loopbackOrigin(view.origin);
  if (!entry || !child) throw new Error("view DTO origins are not clean loopback");
  if (entry.origin === child.origin) throw new Error("view DTO entryOrigin must differ from origin");
  if (typeof view.entryPath !== "string" || !view.entryPath.startsWith("/") || view.entryPath.includes("?")) {
    throw new Error("view DTO entryPath is not a path-only supervisor route");
  }
  if (!HEX64.test(view.serviceEpoch || "")) throw new Error("view DTO missing serviceEpoch");
  const path = new URL(view.entryPath, entry.origin).pathname;
  return `${entry.origin}${path}?epoch=${encodeURIComponent(view.serviceEpoch)}`;
}

function assertV2View(view, spaceId, epoch, label) {
  if (view.spaceId !== spaceId) throw new Error(`${label}: view.spaceId=${view.spaceId} expected ${spaceId}`);
  if (view.serviceEpoch !== epoch) throw new Error(`${label}: view.serviceEpoch does not match state`);
  viewSrc(view);
}

function createApi(post) {
  return async (method, payload = {}) => {
    const body = await post(method, payload);
    if (!body?.ok) {
      const error = redact(`${method}: ${body?.error?.code ?? ""} ${body?.error?.message ?? JSON.stringify(body)}`);
      report.rpcErrors.push(error);
      throw new Error(error);
    }
    return body.value;
  };
}

function workbenchApi(context, origin) {
  return createApi(async (method, payload) => {
    const response = await context.request.post(`${origin}/api/workbench/${method}`, {
      headers: { origin },
      data: payload,
      timeout: 30000,
    });
    return response.json();
  });
}

function bearerApi(endpoint) {
  return createApi(async (method, payload) => {
    const response = await fetch(`${endpoint.origin}/api/workbench/${method}`, {
      method: "POST",
      headers: {
        origin: endpoint.origin,
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.bearer}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    return response.json();
  });
}

async function waitPublicJob(api, submitted, label) {
  if (!submitted?.id) throw new Error(`${label}: submit returned no public job id`);
  let latest = submitted;
  try {
    await until(async () => {
      latest = await api("job", { id: submitted.id });
      return !["queued", "running"].includes(latest.status);
    }, label, PUBLIC_JOB_WAIT_MS);
  } catch (error) {
    const extra = latest?.status ? ` lastStatus=${latest.status}` : "";
    throw new Error(
      `${label}: public job did not reach a terminal status${extra}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return latest;
}

function isTransportFailure(error) {
  const parts = [
    error instanceof Error ? error.message : String(error ?? ""),
    error && typeof error === "object" && "code" in error ? String(error.code) : "",
    error && typeof error === "object" && error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code)
      : "",
  ];
  const text = parts.filter(Boolean).join(" ");
  if (/\bworkbench\/[a-z-]+\b/.test(text) && !/ECONN(?:RESET|REFUSED|ABORTED)|ENOTCONN|EPIPE|UND_ERR_|ERR_CONNECTION_/i.test(text)) {
    return false;
  }
  return /ECONN(?:RESET|REFUSED|ABORTED)|ENOTCONN|EPIPE|EHOSTUNREACH|ERR_CONNECTION_(?:RESET|REFUSED|ABORTED|CLOSED)|ERR_SOCKET_NOT_CONNECTED|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT)|socket hang up|network socket disconnected|fetch failed|read ECONNRESET|connect ECONNREFUSED/i.test(text);
}

function ownJobPath(home, requestId) {
  return join(home, CONTROL_DIR, JOBS_DIR, `${requestId}.json`);
}

function readOwnShutdownJob(home, requestId, planId) {
  const path = ownJobPath(home, requestId);
  if (!existsSync(path)) return null;
  let row;
  try {
    row = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (row.schemaVersion !== 1) return null;
  if (row.id !== requestId || row.requestId !== requestId) return null;
  if (row.kind !== "plan.execute") return null;
  if (row.command?.kind !== "plan.execute" || row.command?.planId !== planId) return null;
  return row;
}

async function waitServiceShutdownAccepted({ home, api, submitted, requestId, planId, timeout }) {
  if (submitted?.id !== requestId) {
    throw new Error(`service.shutdown: submitted.id ${submitted?.id ?? ""} != requestId ${requestId}`);
  }
  if (submitted.requestId !== requestId) {
    throw new Error(`service.shutdown: submitted.requestId ${submitted.requestId ?? ""} != requestId ${requestId}`);
  }
  if (submitted.kind !== "plan.execute") {
    throw new Error(`service.shutdown: submitted.kind ${submitted.kind ?? ""} is not plan.execute`);
  }
  const end = Date.now() + timeout;
  let last = submitted;
  let proof = "";
  while (Date.now() < end) {
    try {
      last = await api("job", { id: requestId });
      if (last.status === "succeeded" || last.status === "failed" || last.status === "cancelled") {
        proof = "http";
        break;
      }
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      const durable = readOwnShutdownJob(home, requestId, planId);
      if (durable) last = durable;
      if (durable?.status === "succeeded" || durable?.status === "failed" || durable?.status === "cancelled") {
        proof = "durable";
        info(
          `service.shutdown: transport failed after public submit; durable job ${requestId} status=${durable.status} (durable proof, not HTTP success)`,
        );
        break;
      }
    }
    await delay(250);
  }
  if (!proof) {
    throw new Error(
      `service.shutdown: public job ${requestId} did not reach a terminal status lastStatus=${last?.status ?? "unknown"}`,
    );
  }
  if (last.status === "failed" || last.status === "cancelled") {
    throw new Error(`service.shutdown job ${requestId} ${last.status}${proof === "durable" ? " (durable)" : ""}`);
  }
  if (last.status !== "succeeded") {
    throw new Error(`service.shutdown job ${requestId} status=${last.status}`);
  }
  return { job: last, proof };
}

async function waitJob(api, command, label) {
  const state = await api("state");
  assertV2State(state, label);
  const submitted = await api("submit", {
    command,
    requestId: randomUUID(),
    context: contextOf(state),
  });
  const latest = await waitPublicJob(api, submitted, label);
  if (latest.status !== "succeeded") {
    const error = redact(`${label} ${latest.status}: ${JSON.stringify(latest.error)}`);
    report.rpcErrors.push(error);
    throw new Error(error);
  }
  return latest;
}

async function managerFrameOf(page, api) {
  const state = await api("state");
  assertV2State(state, "manager iframe");
  if (state.role !== "manager" || !state.managerId) {
    throw new Error(`workbench state is not manager: ${redact(JSON.stringify(state))}`);
  }
  await page.locator(MANAGER_FRAME).waitFor({ state: "attached", timeout: 60000 });
  const portal = page.frameLocator(MANAGER_FRAME);
  const workbench = portal.frameLocator("iframe");
  await workbench.locator(WORKBENCH_ROOT).waitFor({ state: "visible", timeout: 60000 });
  await workbench.locator(".dsh-wb-contained-tools").waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await workbench.locator(".dsh-wb-rail").count(), 0, "no nested rail");
  const view = await api("view", { spaceId: state.managerId });
  assertV2View(view, state.managerId, state.serviceEpoch, "manager view");
  const src = await portal.locator("iframe").getAttribute("src");
  const epochQuery = `epoch=${encodeURIComponent(view.serviceEpoch)}`;
  if (!src || !src.includes(epochQuery)) {
    throw new Error(`manager-frame src missing v2 epoch query: ${redact(src || "")}`);
  }
  return { state, view, frame: workbench };
}

async function waitHandoff(page, webPort) {
  let origin = null;
  await until(async () => {
    const alert = await guideAlert(page);
    if (alert) throw new Error(`initialize UI error: ${redact(alert)}`);
    const current = new URL(page.url());
    assert.equal(Number(current.port), webPort, "Spaces must not navigate away from the installed host");
    const frame = page.locator(MANAGER_FRAME);
    if (!(await frame.count()) || !(await frame.isVisible())) return false;
    const src = await frame.getAttribute("src");
    if (!src) return false;
    const url = new URL(src);
    if (url.hostname !== HOST || url.protocol !== "http:" || !url.pathname.startsWith("/portal-bootstrap/")) return false;
    origin = url.origin;
    return true;
  }, "in-place supervisor presentation", 240000);
  return origin;
}

async function screenshot(page, out, name) {
  if (!page) return;
  await page.screenshot({ path: join(out, name), fullPage: true }).catch(() => {});
}

function stopPid(pid) {
  return new Promise((resolveStop) => {
    if (!pid) {
      resolveStop();
      return;
    }
    const timer = setTimeout(resolveStop, STOP_MS);
    const killer = spawn(
      process.platform === "win32" ? "taskkill" : "kill",
      process.platform === "win32" ? ["/PID", String(pid), "/T", "/F"] : ["-TERM", String(pid)],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    killer.once("error", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

function collectSupervisorPorts(home, origin, identity) {
  const ports = new Set();
  if (identity.entryPort) ports.add(identity.entryPort);
  if (identity.endpoint?.port) ports.add(identity.endpoint.port);
  if (origin) {
    const parsed = loopbackOrigin(origin);
    if (parsed) ports.add(parsed.port);
  }
  const instances = join(home, CONTROL_DIR, "instances");
  if (existsSync(instances)) {
    for (const file of readdirSync(instances).filter((name) => name.endsWith(".json"))) {
      try {
        const record = JSON.parse(readFileSync(join(instances, file), "utf8"));
        if (
          record.version === 1 &&
          Number.isInteger(record.port) &&
          record.port > 0 &&
          record.port <= 65535 &&
          record.origin === `http://${HOST}:${record.port}`
        ) {
          ports.add(record.port);
        }
      } catch {
        /* skip damaged instance records */
      }
    }
  }
  return [...ports];
}

function shutdownCaller(api, identity, origin) {
  if (api) return api;
  if (!identity.endpoint) return null;
  const parsedOrigin = origin ? loopbackOrigin(origin) : null;
  if (parsedOrigin && parsedOrigin.origin !== identity.endpoint.origin) {
    throw new Error("service.shutdown: endpoint origin does not match this supervisor");
  }
  const ownerOrigin =
    typeof identity.owner?.endpoint === "string" ? loopbackOrigin(identity.owner.endpoint) : null;
  if (ownerOrigin && ownerOrigin.origin !== identity.endpoint.origin) {
    throw new Error("service.shutdown: owner endpoint does not match this Home origin");
  }
  return bearerApi(identity.endpoint);
}

async function verifyServiceShutdown({ home, api, origin }) {
  const identity = existsSync(home) ? readHomeIdentity(home) : { endpoint: null, entryPort: null, owner: null };
  const beforePid = ownerPid(identity.owner);
  const beforeStarted = ownerStartedAt(identity.owner);
  if (!beforePid) throw new Error("service.shutdown: owner pid missing before shutdown");
  const ports = collectSupervisorPorts(home, origin, identity);
  if (!ports.length) throw new Error("service.shutdown: no supervisor ports to verify");

  const call = shutdownCaller(api, identity, origin);
  if (!call) throw new Error("service.shutdown: no cookie API and no v2 endpoint bearer");

  const live = await call("state");
  assertV2State(live, "service.shutdown");
  const context = contextOf(live);
  const plan = await call("preview", { request: { kind: "service.shutdown" }, context });
  if (!plan?.id || plan.kind !== "service.shutdown") {
    throw new Error(`service.shutdown preview rejected: ${redact(JSON.stringify(plan))}`);
  }
  const requestId = randomUUID();
  const submitted = await call("submit", {
    command: { kind: "plan.execute", planId: plan.id },
    requestId,
    context,
  });
  const waited = await waitServiceShutdownAccepted({
    home,
    api: call,
    submitted,
    requestId,
    planId: plan.id,
    timeout: PUBLIC_JOB_WAIT_MS,
  });
  const job = waited.job;

  for (const port of ports) {
    await waitPortClosed(port, PORT_MS);
  }
  await until(
    () => pidLiveness(beforePid, beforeStarted) === "dead",
    `owner pid ${beforePid} dead after service.shutdown`,
    30000,
  );
  const after = readHomeIdentity(home);
  if (after.endpoint) {
    throw new Error("service.shutdown: endpoint.json still valid after succeeded job");
  }
  report.ownedPorts = ports;
  report.shutdownJob = {
    id: requestId,
    requestId,
    planId: plan.id,
    status: job.status,
    phase: job.phase,
    proof: waited.proof,
  };
  if (waited.proof === "durable") {
    info(`service.shutdown completed with durable proof (not HTTP success) job ${requestId}`);
  }
  return { job, ports, pid: beforePid, proof: waited.proof, requestId, planId: plan.id };
}

async function forceCleanOwned({ home, origin, web }) {
  const identity = existsSync(home) ? readHomeIdentity(home) : { endpoint: null, entryPort: null, owner: null };
  const ports = new Set(collectSupervisorPorts(home, origin, identity));
  if (web?.port) ports.add(web.port);
  let forced = false;
  if (web?.child) await stopOwned(web.child);
  const pid = ownerPid(identity.owner);
  const started = ownerStartedAt(identity.owner);
  if (pid && pidLiveness(pid, started) === "alive") {
    const ownerOrigin = typeof identity.owner?.endpoint === "string" ? loopbackOrigin(identity.owner.endpoint) : null;
    const expected = identity.endpoint?.origin || (origin ? loopbackOrigin(origin)?.origin : null);
    if (!expected || (ownerOrigin && ownerOrigin.origin === expected) || !ownerOrigin) {
      forced = true;
      await stopPid(pid);
    }
  }
  const leftover = [];
  for (const port of ports) {
    try {
      await waitPortClosed(port, PORT_MS);
    } catch {
      leftover.push(port);
    }
  }
  return { forced, leftoverPorts: leftover, ownedPorts: [...ports] };
}

function bannedPathNeedles() {
  return [
    ["C:", "Users", "admin"].join("/"),
    ["D:", "dsh"].join("\\"),
  ];
}

function assertNoHardcodedMachinePaths() {
  const needles = bannedPathNeedles();
  for (const file of [THIS_FILE, PACK_SCRIPT]) {
    const text = readFileSync(file, "utf8").replace(/function bannedPathNeedles[\s\S]*?\n\}\n/, "");
    for (const needle of needles) {
      if (text.includes(needle)) throw new Error(`${file} hardcodes ${needle}`);
    }
  }
}

function assertVerifierV2Contract() {
  const staleKind = ["controller", "shutdown"].join(".");
  const liveKind = ["service", "shutdown"].join(".");
  const text = readFileSync(THIS_FILE, "utf8").replace(/function assertVerifierV2Contract[\s\S]*?\n\}\n/, "");
  if (text.includes(`kind: "${staleKind}"`) || text.includes(`kind: '${staleKind}'`)) {
    throw new Error("verifier still previews controller.shutdown");
  }
  if (!text.includes(`kind: "${liveKind}"`)) {
    throw new Error("verifier does not preview service.shutdown");
  }
  if (!text.includes("serviceEpoch") || !text.includes("expectedRevision")) {
    throw new Error("verifier does not send v2 mutation context");
  }
  if (!text.includes("data-dsh-spaces-action") || !text.includes("data-dsh-spaces-guide")) {
    throw new Error("verifier does not use v2 guide selectors");
  }
  if (!text.includes("iframe[data-spaces-host-surface]") || !text.includes(".dsh-workbench")) {
    throw new Error("verifier does not use v2 workbench iframe selectors");
  }
  if (!text.includes("protocolVersion")) {
    throw new Error("verifier does not assert protocolVersion");
  }
  const staleFlag = ["recoveryRequired", "false"].join(", ");
  if (text.includes(staleFlag)) {
    throw new Error("verifier still requires stale recoveryRequired");
  }
  if (!text.includes("beforeOrdinaryBoot") || !text.includes("beforeInitialize")) {
    throw new Error("verifier does not report boolean web-protection presence before ordinary boot vs before initialize");
  }
  if (!text.includes('protectionBaseline: "beforeInitialize"')) {
    throw new Error("verifier does not pin initialization-protection baseline after ordinary web auth");
  }
}

async function preflight({ syntaxOnly = false } = {}) {
  const syntax = spawnSync(process.execPath, ["--check", THIS_FILE], { encoding: "utf8", windowsHide: true });
  if (syntax.status !== 0) {
    throw new Error(`node --check failed: ${syntax.stderr || syntax.stdout || syntax.status}`);
  }
  pass("node --check passed");

  assertNoHardcodedMachinePaths();
  pass("pack and verify scripts do not embed operator machine paths");
  assertVerifierV2Contract();
  pass("verifier source uses service.shutdown, v2 mutation context, and current guide/workbench selectors");

  const epoch = "aa".repeat(32);
  const revision = "bb".repeat(32);
  assert.deepEqual(contextOf({ serviceEpoch: epoch, revision }), {
    serviceEpoch: epoch,
    expectedRevision: revision,
  });
  assert.throws(() => contextOf({ serviceEpoch: "nope", revision }));
  assert.equal(readV2Endpoint({ version: 1, origin: `http://${HOST}:9`, bearer: "tok" }), null);
  const parsed = readV2Endpoint({
    version: 2,
    protocolVersion: 2,
    origin: `http://${HOST}:9`,
    bearer: "tok",
    homeId: epoch,
    serviceEpoch: revision,
  });
  assert.equal(parsed?.port, 9);
  assert.equal(parsed?.protocolVersion, 2);
  const src = viewSrc({
    serviceEpoch: epoch,
    spaceId: "coding",
    generation: 1,
    origin: `http://${HOST}:10`,
    entryOrigin: `http://${HOST}:9`,
    entryPath: "/view/coding/1",
    channel: "ch",
  });
  assert.equal(src, `http://${HOST}:9/view/coding/1?epoch=${epoch}`);
  assert.throws(() =>
    viewSrc({
      serviceEpoch: epoch,
      origin: `http://${HOST}:9`,
      entryOrigin: `http://${HOST}:9`,
      entryPath: "/view/coding/1",
    }),
  );
  pass("v2 endpoint/context/view parsers reject v1 endpoint and missing epoch");

  assert.deepEqual(
    webProtectedPresence({
      webProfile: true,
      sessions: null,
      storages: [],
      ".credentials.yaml": false,
      ".anonymous-user-id": false,
    }),
    {
      webProfile: true,
      sessions: false,
      storages: true,
      ".credentials.yaml": false,
      ".anonymous-user-id": false,
    },
  );
  const bootPresence = presenceDelta(
    {
      webProfile: true,
      sessions: null,
      storages: null,
      ".credentials.yaml": false,
      ".anonymous-user-id": false,
    },
    {
      webProfile: true,
      sessions: null,
      storages: null,
      ".credentials.yaml": true,
      ".anonymous-user-id": false,
    },
  );
  assert.deepEqual(bootPresence.changed, [".credentials.yaml"]);
  assert.equal(bootPresence.fields[".credentials.yaml"].before, false);
  assert.equal(bootPresence.fields[".credentials.yaml"].after, true);
  pass("web protection presence helpers keep credential checks as booleans (no byte reads)");

  const plugin = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
  assert.equal(plugin.name, CANONICAL_NAME);
  assert.equal(plugin.repository?.directory, "packages/plugin");
  assert.ok(plugin.keywords?.includes("dsh-plugin"));
  assert.ok(plugin.keywords?.includes("deepseek-harness"));
  assert.equal(plugin.publishConfig?.access, "public");
  assert.notEqual(plugin.private, true);
  pass("plugin manifest has distribution metadata; version/deps untouched by this check");

  const supervisor = JSON.parse(readFileSync(join(REPO, "packages", "supervisor", "package.json"), "utf8"));
  assert.equal(supervisor.private, true);
  pass("supervisor remains private; plugin tarball is the distribution unit");

  const probeHome = mkdtempSync(join(tmpdir(), "dsh-spaces-preflight-home-"));
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
  pass("disposable Home is required; real user Home is refused");

  try {
    assertNoSpaces("C:\\bad dir\\plugin.tgz", "fixture");
    throw new Error("assertNoSpaces accepted a spaced path");
  } catch (error) {
    if (!String(error.message).includes("must not contain spaces")) throw error;
  }
  pass("tarball / pack destination with spaces is rejected");

  const dest = defaultPackDest();
  assertNoSpaces(dest, "pack dest");
  if (dest.toLowerCase().includes(resolve(PLUGIN_DIR).toLowerCase())) {
    throw new Error("default pack dest is inside packages/plugin");
  }
  pass(`default pack dest is outside the package: ${dest}`);

  if (syntaxOnly) {
    const fixtureHome = mkdtempSync(join(tmpdir(), "dsh-spaces-shutdown-job-"));
    try {
      const planId = randomUUID();
      const requestId = randomUUID();
      const jobsDir = join(fixtureHome, CONTROL_DIR, JOBS_DIR);
      mkdirSync(jobsDir, { recursive: true });
      const succeeded = {
        schemaVersion: 1,
        id: requestId,
        requestId,
        kind: "plan.execute",
        command: { kind: "plan.execute", planId },
        status: "succeeded",
      };
      writeFileSync(join(jobsDir, `${requestId}.json`), `${JSON.stringify(succeeded)}\n`);
      const row = readOwnShutdownJob(fixtureHome, requestId, planId);
      assert.equal(row?.status, "succeeded");
      assert.equal(readOwnShutdownJob(fixtureHome, requestId, randomUUID()), null);
      assert.equal(isTransportFailure(new Error("apiRequestContext.post: read ECONNRESET")), true);
      assert.equal(isTransportFailure(new Error("fetch failed: connect ECONNREFUSED")), true);
      assert.equal(isTransportFailure(new Error("job: workbench/forbidden not allowed")), false);
      writeFileSync(
        join(jobsDir, `${requestId}.json`),
        `${JSON.stringify({ ...succeeded, status: "failed" })}\n`,
      );
      assert.equal(readOwnShutdownJob(fixtureHome, requestId, planId)?.status, "failed");
    } finally {
      rmSync(fixtureHome, { recursive: true, force: true });
    }
    report.status = "syntax";
    report.scope =
      "syntax/static only: v2 shutdown/context/guide selectors, Home/path guards. Did not pack, boot DSH web, supervisor, or Playwright.";
    pass("syntax contract: service.shutdown + mutation context; force-clean is not PASS");
    pass("syntax fixture: own jobs/<id>.json binds plan.execute planId; ECONNRESET is transport, workbench/forbidden is not");
    return report;
  }

  const nodeExe = process.execPath;
  run(nodeExe, [PACK_SCRIPT, "--preflight"], {
    cwd: REPO,
    env: { ...process.env, npm_config_offline: "true" },
    timeoutMs: 120000,
    label: "pack --preflight",
  });
  pass("pack --preflight inspected dry-run tarball file lists (not mere existence)");

  let cli = null;
  try {
    const bin = resolveDshBin();
    const version = inspectCli(bin, "DSH_TEST_BIN / global dsh");
    cli = { bin, version, source: process.env.DSH_TEST_BIN ? "DSH_TEST_BIN" : "npm global" };
    pass(`resolved CLI ${version} (${cli.source})`);
  } catch (error) {
    info(String(error.message));
  }
  report.status = "preflight";
  report.cli.resolved = cli;
  report.scope =
    "static/mocks only: manifests, nested-tgz detector, pack dry-run contents, Home/path guards, v2 API/selectors. Did not boot DSH web, supervisor, or Playwright.";
  pass("serial run contract: Playwright clicks data-dsh-spaces-action=initialize with no path args; workbench is a contained manager inside iframe[data-spaces-host-surface]; service.shutdown must succeed as a public job");
  return report;
}

async function main() {
  const out = outputDir();
  mkdirSync(out, { recursive: true });
  report.output = out;
  report.startedAt = new Date().toISOString();

  if (process.argv.includes("--syntax") || process.argv.includes("--preflight")) {
    const syntaxOnly = process.argv.includes("--syntax") && !process.argv.includes("--preflight");
    await preflight({ syntaxOnly });
    writeJson(join(out, syntaxOnly ? "syntax.json" : "preflight.json"), report);
    console.log(syntaxOnly ? "\nSTANDARD INSTALL SYNTAX: PASS" : "\nSTANDARD INSTALL PREFLIGHT: PASS");
    return;
  }

  const nodeExe = process.execPath;
  const bin = resolveDshBin();
  const version = inspectCli(bin, "selected DSH CLI");
  report.cli.resolved = { bin, version };
  pass(`using official CLI ${version} (channel=latest)`);

  const packDest = join(tmpdir(), "dsh-spaces-standard-install-pack");
  assertNoSpaces(packDest, "staged pack dest");
  mkdirSync(packDest, { recursive: true });
  run(nodeExe, [PACK_SCRIPT], {
    cwd: REPO,
    env: { ...process.env, DSH_PACK_DEST: packDest, npm_config_offline: "true" },
    timeoutMs: 120000,
    label: "pack plugin",
  });
  const pluginTgz = join(packDest, `dsh-spaces-plugin-${JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version}.tgz`);
  if (!existsSync(pluginTgz)) throw new Error(`packed plugin missing at ${pluginTgz}`);
  const packedFiles = JSON.parse(readFileSync(join(packDest, "pack-report.json"), "utf8")).plugin.entries;
  for (const rel of PLUGIN_REQUIRED) {
    if (!packedFiles.includes(rel)) throw new Error(`packed plugin missing ${rel}`);
  }
  pass(`packed plugin sha256=${sha256File(pluginTgz)}`);

  const home = mkdtempSync(join(out, "home-"));
  refuseRealHome(home);
  report.home = home;
  const tooling = Object.fromEntries(["shim", "pnpmHome", "store", "cache"].map((key) => [key, join(out, key)]));
  Object.values(tooling).forEach((path) => mkdirSync(path, { recursive: true }));
  writePnpmShim(tooling.shim, nodeExe, resolvePnpmCjs());
  const env = stripSecrets(isolatedEnv(home, nodeExe, tooling));

  runDsh(nodeExe, bin, home, tooling, ["--profile", WEB_PROFILE, "--dump-config"], DUMP_MS, "seed web", join(out, "seed.log"));
  pass("fresh official web profile seeded; no user Home copied");

  runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", WEB_PROFILE, "add", pluginTgz],
    PLUGIN_MS,
    "dsh plugin add web",
    join(out, "plugin-add.log"),
  );
  const afterAdd = pluginState(home, WEB_PROFILE);
  if (!afterAdd.dependency || !afterAdd.inBundles || !afterAdd.installedOnDisk) {
    throw new Error(`web add did not install bundle: ${JSON.stringify(afterAdd)}`);
  }
  const dumpAfterAdd = runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["--profile", WEB_PROFILE, "--dump-config"],
    DUMP_MS,
    "dump after add",
  );
  if (!dumpHasPlugin(dumpAfterAdd)) throw new Error("web dump-config missing id: dsh-spaces after add");
  const afterAddProtected = webProtectedFingerprint(home);
  assert.equal(afterAddProtected.webProfile, true, "ordinary web profile missing after plugin add");
  assertManagerAbsent(home, "after plugin add");
  report.webProtection = {
    beforeOrdinaryBoot: webProtectedPresence(afterAddProtected),
  };
  pass("ordinary web standard add registered @dsh-spaces/plugin; no manager created before initialize");

  const playwright = await loadPlaywright();
  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    const text = redact(error.message);
    report.pageErrors.push(text);
    console.log(`BROWSER ${text}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(redact(message.text()));
  });
  let web = null;
  let api;
  let supervisorOrigin = null;
  let shutdownVerified = false;
  let webBefore;
  try {
    web = await startWeb(nodeExe, bin, home, tooling, join(out, "web.log"));
    await openAuthorizedWeb(page, web.launchUrl);
    await dismissOnboarding(page);
    assertManagerAbsent(home, "after ordinary web boot");
    webBefore = webProtectedFingerprint(home);
    assert.equal(webBefore.webProfile, true, "ordinary web profile missing after ordinary boot");
    const ordinaryBootChange = presenceDelta(afterAddProtected, webBefore);
    report.webProtection.beforeInitialize = webProtectedPresence(webBefore);
    report.webProtection.ordinaryBootChange = ordinaryBootChange;
    report.webProtection.protectionBaseline = "beforeInitialize";
    if (ordinaryBootChange.changed.length) {
      info(
        `ordinary web boot changed protected presence ${JSON.stringify(ordinaryBootChange.changed)} (not initialize)`,
      );
    } else {
      info("ordinary web boot did not change protected presence");
    }
    pass("initialization-protection baseline captured after ordinary web auth/onboarding; manager still absent");
    await clickInitialize(page);
    supervisorOrigin = await waitHandoff(page, web.port);
    api = workbenchApi(context, supervisorOrigin);
    await managerFrameOf(page, api);
    await screenshot(page, out, "initialized.png");
    pass("Playwright clicked data-dsh-spaces-action=initialize; iframe[data-spaces-host-surface] shows .dsh-workbench");

    const first = assertSingleManager(home, "after initialize");
    assertWebPathsProtected(home, webBefore, "after initialize");
    pass(`one manager ${first.hubs[0]} after initialize; ordinary web paths unchanged`);

    const state = await api("state");
    assertV2State(state, "after initialize");
    assert.equal(state.role, "manager");
    assert.ok(!state.reasons.includes("Unfinished Home maintenance must be recovered before new changes."));
    assert.ok(!state.reasons.includes("The manager profile cannot be used until recovery."));
    await waitJob(api, { kind: "space.create", input: { name: "coding", displayName: "编程" } }, "space.create");
    await waitJob(api, { kind: "space.start", spaceId: "coding" }, "space.start");
    const codingPkg = JSON.parse(readFileSync(join(home, "profiles", "coding", "package.json"), "utf8"));
    assert.equal(Boolean(codingPkg.dependencies?.[CANONICAL_NAME]), false);
    assert.ok(codingPkg.dependencies?.["@dsh-spaces/view-bridge"]);
    pass("created and started an ordinary space with view-bridge only");
    const managerView = await managerFrameOf(page, api);
    await page.getByRole("button", { name: "编程", exact: true }).click();
    const live = await api("state");
    assertV2State(live, "coding view");
    const codingView = await api("view", { spaceId: "coding" });
    assertV2View(codingView, "coding", live.serviceEpoch, "coding view");
    const expectedSrc = viewSrc(codingView);
    await managerView.frame.locator('iframe[data-space-id="coding"][data-visible="true"]').waitFor({ state: "visible", timeout: 60000 });
    const codingSrc = await managerView.frame.locator('iframe[data-space-id="coding"]').getAttribute("src");
    if (codingSrc !== expectedSrc) {
      throw new Error(`coding iframe src is not authorized v2 view: ${redact(codingSrc || "")}`);
    }
    pass("selected space completed the view-bridge handshake and is visible");
    await screenshot(page, out, "coding.png");
    assertWebPathsProtected(home, webBefore, "after create/start");

    await page.goto(`http://${HOST}:${web.port}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissOnboarding(page);
    const again = await enterOrInitialize(page);
    assert.equal(again, "enter");
    supervisorOrigin = await waitHandoff(page, web.port);
    await managerFrameOf(page, workbenchApi(context, supervisorOrigin));
    const second = assertSingleManager(home, "repeat initialize");
    assert.deepEqual(second.hubs, first.hubs);
    assertWebPathsProtected(home, webBefore, "repeat enter");
    pass("repeat enter did not add a second manager");

    // Stop only this ordinary Web host. A process-tree kill would also kill
    // the detached supervisor whose independence this restart is testing.
    web.child.kill();
    await waitPortClosed(web.port, PORT_MS);
    web = await startWeb(nodeExe, bin, home, tooling, join(out, "web-restart.log"));
    await openAuthorizedWeb(page, web.launchUrl);
    await dismissOnboarding(page);
    assert.equal(await enterOrInitialize(page), "enter");
    supervisorOrigin = await waitHandoff(page, web.port);
    api = workbenchApi(context, supervisorOrigin);
    await managerFrameOf(page, api);
    const third = assertSingleManager(home, "after web restart");
    assert.deepEqual(third.hubs, first.hubs);
    assertWebPathsProtected(home, webBefore, "after web restart");
    pass("close and restart ordinary web re-enters the same manager");
    assert.deepEqual(report.pageErrors, [], "Unexpected browser runtime errors");

    const shutdown = await verifyServiceShutdown({ home, api, origin: supervisorOrigin });
    shutdownVerified = true;
    pass(
      shutdown.proof === "durable"
        ? "explicit service.shutdown confirmed by durable job file (not HTTP success), dead pid, invalid endpoint, closed ports"
        : "explicit service.shutdown confirmed by succeeded public job, dead pid, invalid endpoint, closed ports",
    );
  } catch (error) {
    report.initAlert = redact(await guideAlert(page).catch(() => ""));
    await screenshot(page, out, "failure.png");
    throw error;
  } finally {
    const cleaned = await forceCleanOwned({ home, origin: supervisorOrigin, web }).catch((error) => ({
      forced: true,
      leftoverPorts: [],
      ownedPorts: [],
      error: redact(error instanceof Error ? error.message : String(error)),
    }));
    report.forceCleaned = Boolean(cleaned.forced);
    report.leftoverPorts = cleaned.leftoverPorts;
    if (!report.ownedPorts) report.ownedPorts = cleaned.ownedPorts;
    if (cleaned.error) report.cleanupError = cleaned.error;
    await browser.close().catch(() => {});
  }
  if (!shutdownVerified) {
    throw new Error("service.shutdown was not verified; force-clean is not PASS");
  }
  if (report.forceCleaned) {
    throw new Error("force-clean killed a still-alive supervisor; service.shutdown is not PASS");
  }
  if (report.leftoverPorts?.length) {
    throw new Error(`owned test ports still open after shutdown: ${report.leftoverPorts.join(", ")}`);
  }

  runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", WEB_PROFILE, "remove", CANONICAL_NAME],
    PLUGIN_MS,
    "dsh plugin remove web",
    join(out, "plugin-remove.log"),
  );
  const afterRemove = pluginState(home, WEB_PROFILE);
  if (afterRemove.dependency || afterRemove.inBundles || afterRemove.installedOnDisk) {
    throw new Error(`web remove left package or bundle: ${JSON.stringify(afterRemove)}`);
  }
  const dumpAfterRemove = runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["--profile", WEB_PROFILE, "--dump-config"],
    DUMP_MS,
    "dump after remove",
  );
  if (dumpHasPlugin(dumpAfterRemove) || dumpAfterRemove.includes(CANONICAL_NAME)) {
    throw new Error("web dump-config still contains the plugin after remove");
  }
  assertWebPathsProtected(home, webBefore, "after web remove");
  pass("ordinary web remove dropped package, bundle, and dump row");

  report.status = "pass";
  report.env = env.DSH_HOME;
  report.finishedAt = new Date().toISOString();
  writeJson(join(out, "results.json"), report);
  console.log("\nSTANDARD INSTALL ACCEPTANCE: PASS");
}

if (import.meta.main) {
  main().catch((error) => {
    report.status = "fail";
    report.error = redact(error instanceof Error ? error.stack || error.message : String(error));
    report.finishedAt = new Date().toISOString();
    try {
      mkdirSync(outputDir(), { recursive: true });
      writeJson(join(outputDir(), "results.json"), report);
    } catch {
      /* still fail */
    }
    console.error(`FAIL  ${report.error}`);
    process.exitCode = 1;
  });
}
