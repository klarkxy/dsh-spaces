#!/usr/bin/env node
/**
 * Creator (制作空间) channel acceptance — SDK host integration harness.
 *
 * NOT the official Desktop EXE and NOT the `dsh` CLI profile boot: the CLI
 * hard-refuses the `desktop` profile ("managed exclusively by the Electron
 * application"). This harness composes and boots a real isolated `desktop`
 * profile through the official SDK surface of the exact RC under test:
 *
 *   isolated Home
 *   -> @deepseek-ai/dsh-app-boot initProfile(desktop, [dsh-base, dsh-web-app])
 *   -> manifest registers @dsh-spaces/plugin in dsh.profile.bundles; the
 *      read-only observer is the Home-level patch layer written BEFORE any
 *      supervisor exists (file-URL row, loads in every profile of this Home)
 *   -> pnpm install -> app-boot loadProfile / createRuntimeResolution /
 *      readProfilePatches -> boot() with a real profileContext(name=desktop),
 *      PluginPackages resolution and provideCmdline — the same public calls
 *      dsh/lib/profile-boot.js runProfile makes
 *   -> production SpacesPlugin confirms the desktop identity and schedules
 *      its automatic Desktop supervisor launch
 *   -> production MainSpaceCreatorService performs issue/context/preview/
 *      execute/job through its own plugin-owned /identity listener
 *   -> observer fixture witnesses real tools registrations on the main host
 *      and inside the created child space
 *
 * No model calls. Disposable Home only (refuses ~/.dsh and the shared
 * .sandbox/dsh-home). The `web` profile is never created, installed into, or
 * read. No retries, restarts, or replay: failures are reported as themselves
 * and cleanup never kills a supervisor — a failed or ambiguous shutdown is
 * evidence, not something to terminate.
 *
 *   node --import tsx scripts/verify-creator-spaces.mjs --help
 *   node --import tsx scripts/verify-creator-spaces.mjs --syntax
 *   node --import tsx scripts/verify-creator-spaces.mjs --preflight
 *   node --import tsx scripts/verify-creator-spaces.mjs
 *
 * Env: DSH_TEST_BIN (RC lib/bin.js; default .sandbox/creator-runtime-rc1 then
 * repo node_modules), DSH_TEST_PNPM_CJS, DSH_TEST_OUTPUT (default
 * .sandbox/creator-acceptance-final), DSH_SPACES_PLUGIN_TGZ (else link: the
 * repo checkout, which must already be built), DSH_LINK_PLUGIN=0 forces tarball.
 *
 * NOT PROVEN (reported, not bypassed): the tool-layer approval gate of
 * spaces_create_execute (no headless agent/approval route exists) and the
 * packaged Desktop application (dsh-desktop-host is not shipped on npm).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST,
  PLUGIN_MS,
  PORT_MS,
  isolatedEnv,
  redact as redactBase,
  refuseRealHome,
  run,
  waitPortClosed,
  writeJson,
  writePnpmShim,
  cliVersion,
} from "./lib/distribution-harness.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THIS_FILE = fileURLToPath(import.meta.url);
const OBSERVER_DIR = join(REPO, "tests", "fixtures", "creator-acceptance", "observer");
const OBSERVER_NAME = "@dsh-spaces/creator-tools-observer";
const PLUGIN_ENTRY = join(REPO, "packages", "plugin", "lib", "index.js");
const CANONICAL_NAME = "@dsh-spaces/plugin";
const MAIN_PROFILE = "desktop";
const SPACE_NAME = "creator-ok";
const DEV_INDEX = { packageName: "@klarkxy/dsh-dev-index", version: "0.2.8" };
const CREATOR_TOOLS = ["spaces_context", "spaces_create_preview", "spaces_create_execute", "spaces_job"];
const DEV_INDEX_TOOLS = ["dsh_docs_fetch", "dsh_docs_search", "dsh_github_fetch", "dsh_plugins_fetch", "dsh_plugins_search"];
const PROFILE_BUNDLES = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  CANONICAL_NAME,
];
const EXACT_CLI = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CONTROL_DIR = ".dsh-spaces-control";
const CREATOR_PREFIX = "/internal/creator/v1/";
const JOB_WAIT_MS = 300_000;
const SUPERVISOR_WAIT_MS = 300_000;
const OBSERVER_WAIT_MS = 90_000;
const ROOT_CONFIG = "# dsh profile root — an empty entry list.\n[]\n";

const proved = [];
const notProven = [];
const report = {
  status: "running",
  kind: "sdk-host-integration",
  note: "SDK composition harness over the exact installed RC — not the packaged Desktop application.",
  proved,
  notProven,
  modelCalls: false,
  cleanup: [],
  cli: {},
};
let shutdownAttempted = false;

function redact(v) {
  return redactBase(v).replace(/Bearer [a-f0-9]{16,}/gi, "Bearer [redacted]");
}
const info = (m) => console.log(`INFO  ${redact(m)}`);
const pass = (m) => { proved.push(m); console.log(`PASS  ${redact(m)}`); };
const unproven = (m) => { notProven.push(m); console.log(`NOTE  ${redact(m)}`); };
const cleanupNote = (m, error = false) => {
  report.cleanup.push({ error, message: m });
  console.log(`CLEAN ${redact(m)}`);
};
const outputDir = () => resolve(process.env.DSH_TEST_OUTPUT || join(REPO, ".sandbox", "creator-acceptance-final"));

// ---------------- CLI / pnpm resolution (selected RC tree) -----------------

function npmGlobalRoot() {
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
    encoding: "utf8", timeout: 15_000, windowsHide: true,
  });
  const p = (r.stdout || "").trim();
  return r.status === 0 && p ? p : "";
}

function resolveDshBin() {
  const override = process.env.DSH_TEST_BIN?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_TEST_BIN is not a file: ${override}`);
    return resolve(override);
  }
  for (const candidate of [
    join(REPO, ".sandbox", "creator-runtime-rc1", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  ]) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error("Official DSH CLI not found. Set DSH_TEST_BIN to the RC lib/bin.js.");
}

function resolvePnpmCjs() {
  const override = process.env.DSH_TEST_PNPM_CJS?.trim();
  if (override) {
    if (!existsSync(override)) throw new Error(`DSH_TEST_PNPM_CJS is not a file: ${override}`);
    return resolve(override);
  }
  const globalRoot = npmGlobalRoot();
  for (const path of [
    globalRoot ? join(globalRoot, "pnpm", "bin", "pnpm.cjs") : "",
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs") : "",
    join(REPO, "node_modules", "pnpm", "bin", "pnpm.cjs"),
  ].filter(Boolean)) {
    if (existsSync(path)) return resolve(path);
  }
  throw new Error("pnpm.cjs not found. Set DSH_TEST_PNPM_CJS.");
}

function inspectCli(bin) {
  const version = cliVersion(bin);
  if (!version || !EXACT_CLI.test(version)) {
    throw new Error(`selected CLI did not report an exact version (${version || "empty"})`);
  }
  return version;
}

/** Resolve a file inside the SELECTED RC tree via the dsh package's own
 *  dependency view (works for flat pnpm and nested layouts alike). */
function rcFile(bin, ...rel) {
  const require = createRequire(join(dirname(bin), "..", "package.json"));
  if (rel.length === 1) return require.resolve(rel[0]);
  return join(dirname(require.resolve(`${rel[0]}/package.json`)), ...rel.slice(1));
}

// ---------------- supervisor records (no credential bytes read) ------------

function readV2Endpoint(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.version !== 2 || raw.protocolVersion !== 2) return null;
  let parsed = null;
  try {
    const url = new URL(raw.origin ?? "");
    if (url.protocol === "http:" && url.hostname === HOST && !url.username && !url.password) {
      const port = Number(url.port);
      if (Number.isInteger(port) && port > 0) parsed = { origin: url.origin, port };
    }
  } catch {
    /* invalid */
  }
  if (!parsed || typeof raw.bearer !== "string" || !raw.bearer) return null;
  if (typeof raw.homeId !== "string" || !HEX64.test(raw.homeId)) return null;
  if (typeof raw.serviceEpoch !== "string" || !HEX64.test(raw.serviceEpoch)) return null;
  return { ...parsed, bearer: raw.bearer, homeId: raw.homeId, serviceEpoch: raw.serviceEpoch };
}

function readHomeIdentity(home) {
  const control = join(home, CONTROL_DIR);
  const read = (file, parse) => {
    const path = join(control, file);
    if (!existsSync(path)) return null;
    try {
      return parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  };
  const endpoint = read("endpoint.json", readV2Endpoint);
  const entryPort = read("entry-port.json", (raw) => (raw.version === 1 && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : null));
  const owner = read(join("run", "owner.json"), (raw) => raw);
  return { endpoint, entryPort: entryPort ?? endpoint?.port ?? null, owner };
}

function ownerPid(owner) {
  const pid = Number(owner?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidLiveness(pid) {
  if (!pid) return "missing";
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e?.code === "ESRCH" ? "dead" : "ambiguous";
  }
  return "alive";
}

const managerRecord = (home) => {
  const path = join(home, CONTROL_DIR, "manager.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { broken: true };
  }
};

const hubProfiles = (home) => {
  const dir = join(home, "profiles");
  return existsSync(dir) ? readdirSync(dir).filter((n) => /^spaces-hub(?:-\d+)?$/i.test(n)) : [];
};

// ---------------- raw HTTP + small helpers ---------------------------------

async function postJson(url, bearer, body) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, ...JSON.parse(text) };
  } catch {
    return { status: response.status, ok: false, error: { code: "transport/non-json", message: text.slice(0, 200) } };
  }
}

const creatorCall = (endpoint) => (op, bearer, body) =>
  postJson(`${endpoint.origin}${CREATOR_PREFIX}${op}`, bearer, body ?? {});
const workbenchCall = (endpoint) => (method, bearer, payload = {}) =>
  postJson(`${endpoint.origin}/api/workbench/${method}`, bearer, payload);

async function until(check, label, timeout = 120_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}

function assertDenied(row, code, label) {
  if (row?.ok === true) throw new Error(`${label}: unexpectedly succeeded`);
  const actual = row?.error?.code ?? `http ${row?.status}`;
  if (code && actual !== code) throw new Error(`${label}: expected ${code}, got ${actual}`);
  return actual;
}

function assertOk(row, label) {
  if (!row || row.ok !== true || row.status !== 200) {
    throw new Error(`${label}: ${redact(JSON.stringify(row ?? {}).slice(0, 400))}`);
  }
  return row.value;
}

/**
 * The official readiness protocol (mirrors WorkbenchHostRuntime.waitManagerReady):
 * endpoint existence is NOT readiness. Poll state -> startupStatus with a 5s
 * read cap per call until the manager row reports running, the epoch matches,
 * and no failed startup phase / maintenance-failed job / crashed manager /
 * unavailable availability appeared. Read failures are terminal evidence —
 * never retried beyond the next scheduled read; timeouts report the last
 * reasons, never a fake ready.
 */
async function waitManagerReady({ wb, endpoint, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let reasons = ["The manager did not become ready before the startup deadline."];
  let seen = null;
  const read = async (method) => {
    const row = await wb(method, endpoint.bearer, {});
    if (row.ok !== true || row.status !== 200) {
      throw new Error(`startup observation ${method}: ${redact(JSON.stringify(row?.error ?? row).slice(0, 300))}`);
    }
    return row.value;
  };
  while (Date.now() < deadline) {
    let state;
    try {
      state = await read("state");
    } catch (error) {
      throw new Error(`startup state read failed: ${redact(error?.message ?? error)}`);
    }
    if (state.reasons?.length) reasons = [...state.reasons];
    const manager = state.spaces?.find((space) => space.id === state.managerId);
    if ((state.maintenance && [...(state.jobs ?? [])].reverse().find((job) => job.kind === "plan.execute")?.status === "failed") ||
        state.availability === "unavailable" || state.serviceEpoch !== endpoint.serviceEpoch ||
        manager?.status === "crashed") {
      throw new Error(`manager startup unavailable: ${redact(reasons.join(" | "))}`);
    }
    if (state.role === "manager" && manager?.status === "running") {
      return { state, manager };
    }
    if (seen?.phase === "ready") {
      throw new Error("startup reported ready but the manager is not running (inconsistent)");
    }
    let status;
    try {
      status = await read("startupStatus");
    } catch (error) {
      throw new Error(`startupStatus read failed: ${redact(error?.message ?? error)}`);
    }
    seen = status;
    if (status.serviceEpoch !== endpoint.serviceEpoch) {
      throw new Error("startup status epoch mismatch");
    }
    if (status.phase === "failed") {
      throw new Error(`manager startup failed: ${redact([...(status.reasons ?? []), status.failure?.primaryReason, status.failure?.cleanupReason].filter(Boolean).join(" | "))}`);
    }
    if (status.reasons?.length) reasons = [...status.reasons];
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(250, remaining));
  }
  throw new Error(`startup deadline: ${redact(reasons.join(" | "))}`);
}

/** Loopback /identity stub used ONLY by raw negative issue cases. */
async function startIdentityStub({ home, profile }) {
  const bearer = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || req.url !== "/identity" || req.headers.authorization !== `Bearer ${bearer}`) {
      reply(403, { error: "forbidden" });
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let input = {};
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep */ }
      reply(200, { nonce: input.nonce, home, profile });
    });
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => { server.off("error", reject); accept(); });
  });
  const address = server.address();
  return {
    origin: `http://${HOST}:${typeof address === "object" && address ? address.port : 0}`,
    bearer,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

/**
 * The one normal, owned shutdown of a verified supervisor: preview ->
 * submit -> durable-first wait -> port/pid/endpoint retirement checks.
 * `shutdownAttempted` is set BEFORE the first request so a crashed attempt is
 * never repeated — there is exactly one shutdown per run, normal or cleanup.
 * Returns the shutdown job record; throws the real failure otherwise.
 */
async function attemptServiceShutdown({ home, endpoint, identityInfo, wb }) {
  shutdownAttempted = true;
  const live = assertOk(await wb("state", endpoint.bearer, {}), "state before service.shutdown");
  const shutdownCtx = { serviceEpoch: live.serviceEpoch, expectedRevision: live.revision };
  const plan = assertOk(await wb("preview", endpoint.bearer, {
    request: { kind: "service.shutdown" }, context: shutdownCtx,
  }), "service.shutdown preview");
  const shutReq = randomUUID();
  assertOk(await wb("submit", endpoint.bearer, {
    command: { kind: "plan.execute", planId: plan.id }, requestId: shutReq, context: shutdownCtx,
  }), "service.shutdown submit");
  const durablePath = join(home, CONTROL_DIR, "jobs", `${shutReq}.json`);
  const terminalStatuses = ["succeeded", "failed", "cancelled"];
  const shutJob = await until(async () => {
    // The durable job record is authoritative: the supervisor closes its own
    // listener during shutdown, so HTTP may die mid-flight.
    if (existsSync(durablePath)) {
      try {
        const record = JSON.parse(readFileSync(durablePath, "utf8"));
        // Only a terminal status completes the wait; queued/running is a
        // normal pending observation, never a result.
        if (record?.requestId === shutReq && terminalStatuses.includes(record?.status)) {
          return { ...record, proof: "durable" };
        }
      } catch {
        /* record may be mid-write; keep observing */
      }
    }
    try {
      const row = await wb("job", endpoint.bearer, { id: shutReq });
      return row.ok === true && terminalStatuses.includes(row.value?.status) ? { ...row.value, proof: "http" } : false;
    } catch {
      return false; // transport ended; the durable file decides
    }
  }, "service.shutdown job", 240_000);
  if (shutJob.status !== "succeeded") {
    throw new Error(`service.shutdown job ${shutJob.status}${shutJob.proof ? ` (${shutJob.proof})` : ""}`);
  }
  for (const port of [endpoint.port, identityInfo.entryPort].filter((p) => Number.isInteger(p) && p > 0)) {
    await waitPortClosed(port, PORT_MS);
  }
  const beforePid = ownerPid(identityInfo.owner);
  if (beforePid) await until(() => pidLiveness(beforePid) === "dead", `owner pid ${beforePid} dead`, 30_000);
  if (readHomeIdentity(home).endpoint) throw new Error("endpoint.json still valid after service.shutdown");
  return { id: shutReq, status: "succeeded", proof: shutJob.proof };
}

// ---------------- preflight (static only; no composition, no boot) ---------

async function preflight({ syntaxOnly = false } = {}) {
  // stdio ignore: confined sandboxes deny piped stdio for spawned processes.
  const syntax = spawnSync(process.execPath, ["--check", THIS_FILE], {
    stdio: "ignore", windowsHide: true, timeout: 30_000,
  });
  if (syntax.status !== 0) throw new Error(`node --check failed (${syntax.error?.code ?? syntax.status})`);
  pass("node --check passed");

  for (const rel of ["package.json", "cordis.patch.yml", "index.js"]) {
    if (!existsSync(join(OBSERVER_DIR, rel))) throw new Error(`observer fixture missing ${rel}`);
  }
  const observerPkg = JSON.parse(readFileSync(join(OBSERVER_DIR, "package.json"), "utf8"));
  assert.equal(observerPkg.name, OBSERVER_NAME);
  const observerSrc = readFileSync(join(OBSERVER_DIR, "index.js"), "utf8");
  for (const required of ['"tools"', "tools/change", "definitions()", "DSH_CREATOR_OBSERVER_OUT"]) {
    if (!observerSrc.includes(required)) throw new Error(`observer fixture missing ${required}`);
  }
  for (const banned of ["tools.register", "tools.restrict", "tools.guard", "credentials.yaml"]) {
    if (observerSrc.includes(banned)) throw new Error(`observer fixture is not read-only: contains ${banned}`);
  }
  pass("observer fixture present, inject-only and read-only");

  const plugin = JSON.parse(readFileSync(join(REPO, "packages", "plugin", "package.json"), "utf8"));
  assert.equal(plugin.name, CANONICAL_NAME);
  assert.equal(plugin.dependencies?.[DEV_INDEX.packageName], DEV_INDEX.version);
  pass(`plugin manifest pins dev-index ${DEV_INDEX.version}`);

  const probeHome = mkdtempSync(join(tmpdir(), "dsh-creator-preflight-"));
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
  pass("disposable Home required; real ~/.dsh refused");

  if (syntaxOnly) {
    report.status = "syntax";
    report.scope = "syntax/static only. No profile composition, no boot, no supervisor.";
    return report;
  }

  const bin = resolveDshBin();
  const version = inspectCli(bin);
  report.cli.resolved = { bin, version };
  pass(`resolved CLI ${version}`);
  for (const [label, path] of [
    ["dsh-app-boot", rcFile(bin, "@deepseek-ai/dsh-app-boot", "lib", "index.js")],
    ["dsh-cmdline", rcFile(bin, "@deepseek-ai/dsh-cmdline", "lib", "index.js")],
    ["dsh-launch-environment", rcFile(bin, "@deepseek-ai/dsh-launch-environment", "lib", "index.js")],
    ["dsh-web-app patch", rcFile(bin, "@deepseek-ai/dsh-web-app", "cordis.patch.yml")],
  ]) {
    if (!existsSync(path)) throw new Error(`selected RC tree is missing ${label}: ${path}`);
  }
  pass("selected RC tree carries the SDK modules the harness imports");
  resolvePnpmCjs();
  pass("pnpm.cjs resolved");
  const tgz = process.env.DSH_SPACES_PLUGIN_TGZ?.trim();
  if (tgz) {
    if (!existsSync(tgz)) throw new Error(`DSH_SPACES_PLUGIN_TGZ is not a file: ${tgz}`);
    pass(`plugin tarball present: ${tgz}`);
  } else if (!existsSync(PLUGIN_ENTRY)) {
    info("packages/plugin/lib/index.js missing: link install needs a built checkout (or set DSH_SPACES_PLUGIN_TGZ)");
  }
  report.status = "preflight";
  report.scope = "static only. Did not compose, boot, or contact a supervisor.";
  pass("serial contract: initProfile(desktop)+bundles+pnpm+boot(); production handshake; observer evidence via DSH_CREATOR_OBSERVER_OUT");
  return report;
}

// ------------------------------ main --------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(readFileSync(THIS_FILE, "utf8").split("\n").slice(0, 46).join("\n"));
    return;
  }
  const out = outputDir();
  mkdirSync(out, { recursive: true });
  report.output = out;
  report.startedAt = new Date().toISOString();

  if (argv.includes("--syntax") || argv.includes("--preflight")) {
    const syntaxOnly = argv.includes("--syntax") && !argv.includes("--preflight");
    await preflight({ syntaxOnly });
    writeJson(join(out, syntaxOnly ? "syntax.json" : "preflight.json"), report);
    console.log(syntaxOnly ? "\nCREATOR SDK-HOST SYNTAX: PASS" : "\nCREATOR SDK-HOST PREFLIGHT: PASS");
    return;
  }

  const nodeExe = process.execPath;
  const bin = resolveDshBin();
  const version = inspectCli(bin);
  report.cli.resolved = { bin, version };
  pass(`using official CLI ${version} (${bin})`);

  const tgz = process.env.DSH_SPACES_PLUGIN_TGZ?.trim();
  const linkMode = process.env.DSH_LINK_PLUGIN === "0" ? false : !tgz;
  if (!linkMode && !existsSync(tgz)) throw new Error(`DSH_SPACES_PLUGIN_TGZ is not a file: ${tgz}`);
  if (linkMode && !existsSync(PLUGIN_ENTRY)) {
    throw new Error("Link install needs a built checkout (packages/plugin/lib/index.js); build first or set DSH_SPACES_PLUGIN_TGZ.");
  }
  pass(`plugin source: ${linkMode ? `link:${REPO}` : `tarball ${tgz}`}`);

  const home = realpathSync(mkdtempSync(join(out, "home-")));
  refuseRealHome(home);
  report.home = home;
  const observerOut = mkdtempSync(join(out, "observer-"));
  const tooling = Object.fromEntries(["shim", "pnpmHome", "store", "cache"].map((k) => [k, join(out, k)]));
  Object.values(tooling).forEach((p) => mkdirSync(p, { recursive: true }));
  const pnpmCjs = resolvePnpmCjs();
  writePnpmShim(tooling.shim, nodeExe, pnpmCjs);
  const env = { ...isolatedEnv(home, nodeExe, tooling), DSH_CREATOR_OBSERVER_OUT: observerOut };
  // The SDK host and every process it owns (supervisor, bound CLI spawns)
  // must see the SAME isolated toolchain env the harness gives pnpm —
  // otherwise they would resolve shared caches or a wrong toolchain.
  for (const key of ["DSH_HOME", "PNPM_HOME", "npm_config_store_dir", "npm_config_cache",
    "npm_config_registry", "npm_config_fund", "npm_config_audit",
    "npm_config_update_notifier", "npm_config_global",
    "npm_config_ignore_workspace_root_check", "CI", "DSH_CREATOR_OBSERVER_OUT"]) {
    if (env[key] !== undefined) process.env[key] = env[key];
  }
  for (const key of ["PATH", "Path"]) {
    if (env[key] !== undefined) process.env[key] = env[key];
  }
  process.env.DSH_TELEMETRY_DISABLED = "1";
  // The desktop-gated telemetry rows read the packaged client version from
  // this variable; the RC CLI version is the honest value for an SDK host.
  process.env.DSH_CLIENT_VERSION = version;

  // -- real isolated desktop profile (public SDK surface) --------------------
  // The observer is the Home-level test patch layer ($DSH_HOME/cordis.patch.yml
  // applies to every profile this Home boots): it is written BEFORE any
  // supervisor exists, so the main host, the manager, and every space created
  // inside this Home load it naturally — no child profile is touched after a
  // space exists (single-writer stays with the supervisor).
  writeFileSync(join(home, "cordis.patch.yml"),
    `- insert:\n    - id: dsh-creator-tools-observer\n      name: '${pathToFileURL(join(OBSERVER_DIR, "index.js")).href}'\n`, "utf8");

  const appBoot = await import(pathToFileURL(rcFile(bin, "@deepseek-ai/dsh-app-boot", "lib", "index.js")).href);
  const profileDir = join(home, "profiles", MAIN_PROFILE);
  appBoot.initProfile(profileDir, PROFILE_BUNDLES);
  const manifestPath = join(profileDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies[CANONICAL_NAME] = linkMode ? `link:${REPO}` : resolve(tgz);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  run(nodeExe, [pnpmCjs, "install", "--ignore-scripts"], {
    cwd: profileDir, env, timeoutMs: PLUGIN_MS, label: "pnpm install desktop profile",
    logPath: join(out, "profile-install.log"),
  });
  if (!existsSync(join(profileDir, "node_modules", ...CANONICAL_NAME.split("/"), "package.json"))) {
    throw new Error(`${CANONICAL_NAME} not installed into the desktop profile`);
  }
  pass(`isolated ${MAIN_PROFILE} profile: bundles ${PROFILE_BUNDLES.join(", ")}; observer mounts via the Home patch layer`);

  // -- boot the real composition exactly like the CLI's runProfile -----------
  process.argv[1] = bin;
  process.argv[2] = "--profile";
  process.argv[3] = MAIN_PROFILE;
  process.argv.length = 4;
  const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(rcFile(bin, "@deepseek-ai/dsh-launch-environment", "lib", "index.js")).href);
  const { provideCmdline } = await import(pathToFileURL(rcFile(bin, "@deepseek-ai/dsh-cmdline", "lib", "index.js")).href);
  const installAnchor = rcFile(bin, "@deepseek-ai/dsh/package.json");
  const profile = appBoot.loadProfile("dsh", MAIN_PROFILE, installAnchor, home);
  const startedBundles = profile.layers.map((l) => l.packageName);
  for (const expected of PROFILE_BUNDLES) {
    if (!startedBundles.includes(expected)) {
      throw new Error(`bundle ${expected} did not produce a layer; started: ${startedBundles.join(", ")}`);
    }
  }
  const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile, home });
  writeFileSync(join(profileDir, "cordis.yml"), ROOT_CONFIG, "utf8");
  const profileContext = {
    name: MAIN_PROFILE,
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor,
    cwd: process.cwd(),
    home,
    startedBundles,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  };
  const environment = createLaunchEnvironmentSnapshot([{ source: "process", values: { ...process.env } }]);
  const patches = appBoot.readProfilePatches("dsh", profileContext, profile);
  // Application readiness the CLI arms in runProfile: rows like the profile
  // HMR require ctx.appReady; it commits only after the tree settles and the
  // loader is present — never earlier.
  const appReady = (() => {
    let ready = false;
    const listeners = new Set();
    return {
      service: {
        onReady(listener) {
          if (ready) { listener(); return () => undefined; }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      commit() {
        if (ready) return;
        ready = true;
        for (const listener of [...listeners]) listener();
        listeners.clear();
      },
    };
  })();
  let appExitCode = null;
  const ctx = await appBoot.boot(
    "dsh",
    join(profileDir, "cordis.yml"),
    patches,
    async (hostCtx) => {
      hostCtx.provide("profileContext", profileContext);
      hostCtx.provide("launchEnvironment", environment);
      await hostCtx.plugin(appBoot.PluginPackages, { resolution });
      provideCmdline(hostCtx, {
        args: ["--no-open", "--host", HOST, "--port", "0"],
        exit: (code) => { appExitCode = code; },
        ready: appReady.service,
      });
    },
  );
  if (appExitCode !== null) throw new Error(`composition requested exit(${appExitCode}) during boot`);
  if (ctx.fiber.state !== 2 || ctx.get("loader") === undefined) {
    throw new Error(`composition did not reach a running loader (fiber.state=${ctx.fiber.state})`);
  }
  appReady.commit();
  if (ctx.profileContext?.name !== MAIN_PROFILE || ctx.profileContext?.home !== home) {
    throw new Error(`profileContext mismatch: ${redact(JSON.stringify(ctx.profileContext))}`);
  }
  pass(`boot() mounted the real composition; startedBundles includes the plugin; profileContext=desktop/${home}`);

  let shutdownVerified = false;
  let creator = null;
  let creatorStopped = false;
  let identityStub = null;
  let endpoint = null;
  let identityInfo = null;
  let wb = null;
  try {
    // -- production plugin's automatic desktop supervisor launch -------------
    identityInfo = await until(() => {
      const record = readHomeIdentity(home);
      return record.endpoint ? record : false;
    }, "supervisor endpoint after automatic desktop launch", SUPERVISOR_WAIT_MS);
    endpoint = identityInfo.endpoint;
    if (identityInfo.entryPort && endpoint.port !== identityInfo.entryPort) {
      throw new Error(`endpoint port ${endpoint.port} != entry-port.json ${identityInfo.entryPort}`);
    }
    wb = workbenchCall(endpoint);
    const creatorRaw = creatorCall(endpoint);
    pass(`production SpacesPlugin cold-started the supervisor at ${endpoint.origin} (v2 endpoint)`);

    // The endpoint appearing is only "the supervisor is listening"; the
    // manager is NOT ready until the official state/startupStatus protocol
    // says so — file presence is never used as a readiness signal.
    const ready = await waitManagerReady({ wb, endpoint, timeoutMs: SUPERVISOR_WAIT_MS });
    pass(`manager ${ready.state.managerId} reached running via the official startup observation protocol`);

    const hubs = hubProfiles(home);
    const manager = managerRecord(home);
    if (hubs.length !== 1 || !manager || manager.profileId !== hubs[0]) {
      throw new Error(`expected one manager profile, found ${JSON.stringify({ hubs, manager })}`);
    }
    pass(`one manager ${hubs[0]}; desktop is the main identity, not the manager`);

    assertDenied(await wb("state", "ff".repeat(32)), undefined, "workbench state with foreign token");
    pass("workbench /api rejects a foreign bearer");

    // -- raw issue rejections -------------------------------------------------
    identityStub = await startIdentityStub({ home, profile: MAIN_PROFILE });
    assertDenied(await creatorRaw("issue", endpoint.bearer, {
      origin: identityStub.origin, bearer: identityStub.bearer, home, profile: "space-anything",
    }), "creator/invalid-input", "issue with a managed-child profile name");
    const mismatched = await startIdentityStub({ home, profile: "web" });
    try {
      assertDenied(await creatorRaw("issue", endpoint.bearer, {
        origin: mismatched.origin, bearer: mismatched.bearer, home, profile: MAIN_PROFILE,
      }), "creator/unavailable", "issue with identity proof for a different profile");
    } finally {
      await mismatched.close();
    }
    assertDenied(await creatorRaw("issue", endpoint.bearer, {
      origin: endpoint.origin, bearer: identityStub.bearer, home, profile: MAIN_PROFILE,
    }), "creator/invalid-input", "issue with supervisor origin as identity endpoint");
    assertDenied(await creatorRaw("issue", "00".repeat(32), {
      origin: identityStub.origin, bearer: identityStub.bearer, home, profile: MAIN_PROFILE,
    }), "workbench/unauthorized", "issue with wrong host bearer");
    pass("issue refuses child-profile claims, mismatched identity proof, supervisor-self origin, wrong bearer");

    // -- production handshake --------------------------------------------------
    const { MainSpaceCreatorService } = await import(
      pathToFileURL(join(REPO, "packages", "plugin", "src", "host", "main-space-creator.ts")).href
    );
    creator = new MainSpaceCreatorService(ctx);
    await creator.attach({ ...endpoint });
    const context = await creator.context(); // lazy issue: listener + nonce + scope
    if (context.protocolVersion !== 1 || context.serviceEpoch !== endpoint.serviceEpoch || context.writable !== true) {
      throw new Error(`creator context invalid: ${redact(JSON.stringify(context))}`);
    }
    report.creatorContext = { serviceEpoch: context.serviceEpoch, writable: context.writable, dshVersion: context.dshVersion };
    pass("production MainSpaceCreatorService issued a creator scope for the desktop main identity");

    assertDenied(await creatorRaw("issue", endpoint.bearer, {
      origin: identityStub.origin, bearer: identityStub.bearer, home, profile: MAIN_PROFILE,
    }), "creator/conflict", "second issue in the same service epoch");
    assertDenied(await creatorRaw("context", endpoint.bearer, {}), "workbench/unauthorized", "context with host bearer");
    assertDenied(await creatorRaw("context", "ee".repeat(32), {}), "workbench/unauthorized", "context with foreign scope");
    pass("one registration per epoch; scope-only ops reject host/foreign bearers");

    // -- createPreview rejections ---------------------------------------------
    for (const [label, input] of [
      ["invalid space name", { name: "bad name!" }],
      ["npm tag instead of exact version", { name: SPACE_NAME, plugins: [{ npm: { packageName: "x", version: "latest" } }] }],
      ["github without 40-char commit", { name: SPACE_NAME, plugins: [{ github: { owner: "o", repo: "r", commit: "abc", packageName: "p" } }] }],
      ["duplicate plugin package", { name: SPACE_NAME, plugins: [{ npm: { packageName: "a", version: "1.0.0" } }, { npm: { packageName: "a", version: "1.0.1" } }] }],
    ]) {
      let denied = "";
      try {
        await creator.createPreview(input);
      } catch (error) {
        denied = String(error?.message ?? error);
      }
      if (!denied.includes("creator/invalid-input")) {
        throw new Error(`createPreview ${label}: expected creator/invalid-input, got ${redact(denied || "success")}`);
      }
    }
    pass("createPreview rejects unsafe specs (name, tag/range, sha, duplicates)");

    // -- createExecute rejects a plan this host never previewed ----------------
    let foreignDenied = "";
    try {
      await creator.createExecute({ planId: `ffffffff-${randomUUID()}`, requestId: randomUUID() });
    } catch (error) {
      foreignDenied = String(error?.message ?? error);
    }
    if (!foreignDenied) throw new Error("createExecute accepted a foreign plan id");
    pass("createExecute rejects a plan this host never previewed");

    // -- two real creator.create jobs on the same registration -----------------
    // Job 1: local model source + explicit dev-index install + start.
    // Job 2: main model source (one model sync at creation), start, no plugins.
    const runCreation = async (spec, expect) => {
      const plan = await creator.createPreview(spec);
      if (plan.kind !== "creator.create" || plan.serviceEpoch !== endpoint.serviceEpoch) {
        throw new Error(`${spec.name}: preview not epoch-bound`);
      }
      const stepKinds = plan.steps.map((s) => s.step);
      for (const required of ["prepare", "create", "result", ...(spec.startAfterCreate ? ["start"] : [])]) {
        if (!stepKinds.includes(required)) {
          throw new Error(`${spec.name}: plan missing step ${required}: ${JSON.stringify(plan.steps)}`);
        }
      }
      if ((spec.plugins?.length ?? 0) > 0 &&
          !plan.steps.some((s) => s.step === "plugin" && s.packageName === spec.plugins[0].npm?.packageName)) {
        throw new Error(`${spec.name}: plan missing plugin step: ${JSON.stringify(plan.steps)}`);
      }
      if (expect.modelsSync !== stepKinds.includes("models-sync")) {
        throw new Error(`${spec.name}: plan models-sync step mismatch: ${JSON.stringify(plan.steps)}`);
      }
      if (!creator.previewedPlan(plan.id)) throw new Error(`${spec.name}: service did not retain its own preview`);

      const requestId = randomUUID();
      const submitted = await creator.createExecute({ planId: plan.id, requestId });
      const jobId = submitted.id || requestId;
      const terminal = await until(async () => {
        // A read failure is evidence, not a retry loop: it propagates.
        const row = await creator.job(jobId);
        return ["succeeded", "failed", "cancelled"].includes(row?.status) ? row : false;
      }, `creator.create job ${jobId} (${spec.name})`, JOB_WAIT_MS);
      if (terminal.status !== "succeeded") {
        throw new Error(`creator.create job ${jobId} (${spec.name}) ${terminal.status}: ${redact(JSON.stringify(terminal.error ?? terminal).slice(0, 500))}`);
      }
      const spaceId = terminal.result?.spaceId;
      if (typeof spaceId !== "string" || !spaceId.startsWith("space-")) {
        throw new Error(`${spec.name}: job result missing spaceId`);
      }
      const steps = Array.isArray(terminal.result?.steps) ? terminal.result.steps : [];
      const failed = steps.find((s) => s.status === "failed");
      if (failed) throw new Error(`${spec.name}: job reports a failed step: ${JSON.stringify(failed)}`);

      const registry = JSON.parse(readFileSync(join(home, "hub", "spaces.json"), "utf8"));
      if (!registry.meta?.[spaceId] || !registry.order?.includes(spaceId)) {
        throw new Error(`${spaceId} missing from the space registry`);
      }
      for (const plugin of spec.plugins ?? []) {
        const pkg = plugin.npm;
        const onDisk = existsSync(join(home, "profiles", spaceId, "node_modules", ...pkg.packageName.split("/"), "package.json"));
        const dep = JSON.parse(readFileSync(join(home, "profiles", spaceId, "package.json"), "utf8"))
          .dependencies?.[pkg.packageName];
        if (!dep && !onDisk) throw new Error(`${pkg.packageName} not installed into ${spaceId}`);
      }
      if (expect.modelsSync) {
        const syncStep = steps.find((s) => s.step === "models-sync");
        if (syncStep?.status !== "done") {
          throw new Error(`${spec.name}: models-sync step is ${syncStep?.status ?? "missing"}`);
        }
        if (typeof syncStep.detail !== "string" || !syncStep.detail.startsWith(`main: ${MAIN_PROFILE}`)) {
          throw new Error(`${spec.name}: models-sync step does not name the main space: ${redact(String(syncStep.detail))}`);
        }
      }
      if (existsSync(join(home, "hub", spaceId, "llm-policy.json"))) {
        throw new Error(`${spec.name}: a retired llm-policy.json was written`);
      }
      // Observer witness inside the child: all dev-index tools, zero spaces_*.
      const childTools = await until(() => {
        try {
          const data = JSON.parse(readFileSync(join(observerOut, `${spaceId}.json`), "utf8"));
          return DEV_INDEX_TOOLS.every((t) => data.tools?.includes(t)) ? data : false;
        } catch {
          return false;
        }
      }, `observer evidence from ${spaceId}`, OBSERVER_WAIT_MS);
      const leaked = CREATOR_TOOLS.filter((tool) => childTools.tools.includes(tool));
      if (leaked.length) throw new Error(`creator tools leaked into ${spaceId}: ${leaked.join(", ")}`);
      return { planId: plan.id, jobId, spaceId, steps };
    };

    const first = await runCreation({
      name: SPACE_NAME,
      modelSource: "local",
      startAfterCreate: true,
      plugins: [{ npm: { packageName: DEV_INDEX.packageName, version: DEV_INDEX.version } }],
    }, { modelsSync: false });
    report.createJobs = [first];
    pass(`job 1: ${first.spaceId} created+started (local model, dev-index installed, child tools witnessed)`);

    const second = await runCreation({
      name: "creator-main",
      modelSource: "main",
      startAfterCreate: true,
      plugins: [],
    }, { modelsSync: true });
    report.createJobs.push(second);
    pass(`job 2: ${second.spaceId} created+started (main models synced once at creation, child tools witnessed)`);

    const createdIds = [first.spaceId, second.spaceId];
    for (const claimed of createdIds) {
      assertDenied(await creatorRaw("issue", endpoint.bearer, {
        origin: identityStub.origin, bearer: identityStub.bearer, home, profile: claimed,
      }), "creator/invalid-input", `issue claiming managed child ${claimed}`);
    }
    assertDenied(await creatorRaw("issue", endpoint.bearer, {
      origin: identityStub.origin, bearer: identityStub.bearer, home, profile: hubs[0],
    }), "creator/invalid-input", "issue claiming the manager profile");
    pass("issue refuses both managed children and the manager profile");

    // -- observer evidence: real tool registration -----------------------------
    await until(() => {
      try {
        const data = JSON.parse(readFileSync(join(observerOut, `${MAIN_PROFILE}.json`), "utf8"));
        return CREATOR_TOOLS.every((tool) => data.tools?.includes(tool)) ? data : false;
      } catch {
        return false;
      }
    }, `observer evidence listing creator tools on ${MAIN_PROFILE}`, OBSERVER_WAIT_MS);
    pass(`observer on ${MAIN_PROFILE}: real tools registry lists ${CREATOR_TOOLS.join(", ")}`);

    unproven(
      "tool-layer approval gate (spaces_create_execute approveEscalation -> danger-full-access): " +
      "no headless agent/approval route exists; wire-level createExecute is covered instead.",
    );
    unproven(
      "official Desktop EXE (dsh-desktop-host + Electron) not shipped on npm: " +
      "this harness proves the SDK composition path, not the packaged application.",
    );

    // -- the single, normal shutdown: preview -> submit -> durable-first wait --
    const shutJob = await attemptServiceShutdown({ home, endpoint, identityInfo, wb });
    report.shutdownJob = shutJob;
    shutdownVerified = true;
    pass(`service.shutdown accepted as a public job (${shutJob.proof} proof); owner pid dead; endpoint invalid; ports closed`);
  } finally {
    // Bounded, honest cleanup. If the run failed before the normal shutdown,
    // and this run's recorded supervisor is still verifiably alive and owned,
    // give it its ONE normal shutdown (shutdownAttempted guards a single
    // attempt; a failed or ambiguous shutdown is never repeated and never
    // killed — it stays evidence).
    if (!shutdownVerified && !shutdownAttempted && endpoint && wb) {
      const identityNow = readHomeIdentity(home);
      const nowPid = ownerPid(identityNow.owner);
      const sameEndpoint = identityNow.endpoint && identityNow.endpoint.serviceEpoch === endpoint.serviceEpoch;
      const aliveOwner = nowPid && pidLiveness(nowPid) === "alive";
      if (sameEndpoint && aliveOwner) {
        try {
          const cleanupJob = await attemptServiceShutdown({ home, endpoint, identityInfo: identityNow, wb });
          report.cleanupShutdownJob = cleanupJob;
          shutdownVerified = true;
          cleanupNote(`cleanup service.shutdown succeeded (${cleanupJob.proof} proof)`);
        } catch (error) {
          cleanupNote(`cleanup service.shutdown failed — evidence preserved, not retried: ${String(error?.message ?? error)}`, true);
        }
      } else {
        cleanupNote(
          `cleanup skipped supervisor shutdown: endpoint ${sameEndpoint ? "matches" : "changed/absent"}, ` +
          `owner pid ${nowPid ?? "none"} ${pidLiveness(nowPid)} — evidence preserved`,
        );
      }
    } else if (!shutdownVerified && shutdownAttempted) {
      cleanupNote("shutdown was already attempted and did not verify — evidence preserved, not retried", true);
    }
    if (creator) {
      // A confirmed dead service: retire the harness registration the same way
      // the product does (afterSupervisorStopped), then close without a
      // doomed unregister call.
      if (shutdownVerified && !creatorStopped) {
        try {
          await creator.afterSupervisorStopped(report.creatorContext?.serviceEpoch ?? null);
          creatorStopped = true;
        } catch (error) {
          cleanupNote(`creator afterSupervisorStopped: ${String(error?.message ?? error)}`, true);
        }
      }
      try {
        await creator.close();
      } catch (error) {
        cleanupNote(`creator.close: ${String(error?.message ?? error)}`, true);
      }
    }
    if (identityStub) {
      try {
        await identityStub.close();
      } catch (error) {
        cleanupNote(`identity stub close: ${String(error?.message ?? error)}`, true);
      }
    }
    try {
      await ctx.fiber.dispose();
    } catch (error) {
      cleanupNote(`composition dispose: ${String(error?.message ?? error)}`, true);
    }
  }

  const cleanupErrors = report.cleanup.filter((entry) => entry.error);
  if (!shutdownVerified) throw new Error("service.shutdown was not verified; cleanup is not PASS");
  const evidence = collectObserverEvidence(out);
  if (evidence) report.observerEvidence = evidence;
  if (cleanupErrors.length) {
    report.status = "cleanup-unconfirmed";
    report.env = env.DSH_HOME;
    report.finishedAt = new Date().toISOString();
    writeJson(join(out, "results.json"), report);
    console.error(`\nCREATOR SDK-HOST ACCEPTANCE: CLEANUP UNCONFIRMED (${cleanupErrors.length} cleanup error(s); original results preserved)`);
    process.exitCode = 1;
    return;
  }
  report.status = "pass";
  report.env = env.DSH_HOME;
  report.finishedAt = new Date().toISOString();
  writeJson(join(out, "results.json"), report);
  console.log("\nCREATOR SDK-HOST ACCEPTANCE: PASS");
}

/** Observer evidence snapshots (may be absent); bounded, parse errors kept as text. */
function collectObserverEvidence(out) {
  const dir = join(out, "");
  const evidence = {};
  try {
    for (const base of readdirSync(out).filter((d) => d.startsWith("observer-"))) {
      const observerDir = join(dir, base);
      for (const file of readdirSync(observerDir).filter((f) => f.endsWith(".json"))) {
        const key = `${base}/${file}`;
        try {
          evidence[key] = JSON.parse(readFileSync(join(observerDir, file), "utf8"));
        } catch {
          evidence[key] = "<unparsed>";
        }
      }
    }
  } catch {
    /* evidence dir may not exist yet */
  }
  return Object.keys(evidence).length ? evidence : null;
}

if (import.meta.main) {
  main().catch((error) => {
    report.status = "fail";
    report.error = redact(error instanceof Error ? error.stack || error.message : String(error));
    const evidence = collectObserverEvidence(outputDir());
    if (evidence) report.observerEvidence = evidence;
    report.finishedAt = new Date().toISOString();
    try {
      mkdirSync(outputDir(), { recursive: true });
      writeJson(join(outputDir(), "results.json"), report);
    } catch { /* still fail */ }
    console.error(`FAIL  ${report.error}`);
    process.exitCode = 1;
  });
}
