#!/usr/bin/env node
/**
 * Desktop shell + shared workbench acceptance.
 * Unpackaged: repo Electron + out/main. Packaged: DSH_TEST_PACKAGED_EXE next to resources/app.asar.
 * Does not execute the NSIS installer. Official plugin install is verify-plugin-standard-install.mjs.
 *
 * Env: DSH_TEST_BIN or DSH_TEST_CLI_BIN (required file), DSH_TEST_NODE (file; default process.execPath),
 * optional DSH_TEST_PLAYWRIGHT_MODULE (else repo node_modules/playwright),
 * optional DSH_TEST_PACKAGED_EXE, optional DSH_TEST_INSTALLER (7z list only),
 * optional DSH_TEST_OUTPUT (evidence dir; default .sandbox/spaces-desktop-acceptance).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateComponentPayload } from "../src/adapters/node/component-payload.ts";
import { DesktopServiceClient } from "../src/adapters/desktop/service-client.ts";
import {
  defaultPidAlive,
  HOME_CONTROL_DIR_NAME,
  HOME_CONTROL_OWNER_FILE,
  HOME_CONTROL_RUN_DIR_NAME,
} from "../src/adapters/node/home-controller.ts";
import { resolveSpacesPayloadRoot } from "../src/main/desktop-shell-runtime.ts";
import { readEndpointFile, SUPERVISOR_ENDPOINT_FILE } from "../packages/plugin/src/host/supervisor-endpoint.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
const evidence = resolve(process.env.DSH_TEST_OUTPUT?.trim() || join(repo, ".sandbox", "spaces-desktop-acceptance"));
const realHome = resolve(homedir(), ".dsh");
const prereqOnly = process.argv.includes("--prereq") || process.env.DSH_TEST_DESKTOP_PREREQ === "1";
const packagedExe = process.env.DSH_TEST_PACKAGED_EXE?.trim() || "";
const installerPath = process.env.DSH_TEST_INSTALLER?.trim() || "";
const productName = pkg.build?.productName || "DSH Spaces";
const expectedUnpackedExe = join(repo, pkg.build?.directories?.output || "release", "win-unpacked", `${productName}.exe`);
const expectedInstaller = join(repo, pkg.build?.directories?.output || "release", `${productName} Setup ${pkg.version}.exe`);
const packCommand = "npx electron-builder --win nsis --publish never";
const unpackagedMain = join(repo, "out", "main", "index.js");
const SPACE_ID = "notes";
const SPACE_DISPLAY = "Notes Desk";
const SPACE_RENAMED = "Notes Desk Renamed";
const SURVIVE_SPACE_ID = "coding";
const SURVIVE_DISPLAY = "Coding Desk";
const STALE_DISPLAY = "Should Not Apply";
const DRAFT_CATALOG = "https://example.invalid/catalog.json";
const ACTIVE_JOB = new Set(["queued", "running"]);
const TERMINAL_JOB = new Set(["succeeded", "failed", "cancelled"]);

const NEW_SPACE = /^(New space|新建空间)$/;
const PLUGIN_SEARCH = /^(Search plugins|搜索插件)$/;

const checks = [];
const ownedClosers = [];

function pass(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

function stage(label) {
  console.log(`STAGE ${label}`);
}

function redact(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [redacted]")
    .replace(/\/bootstrap\/[A-Za-z0-9_-]+/g, "/bootstrap/[redacted]")
    .replace(/[?&]token=[^&\s"']+/gi, "[redacted-token]")
    .replace(realHome.replaceAll("\\", "\\\\"), "[real-home]");
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function refuseRealHome(home) {
  const resolved = resolve(home);
  if (samePath(resolved, realHome) || resolved.toLowerCase().startsWith(realHome.toLowerCase() + sep)) {
    throw new Error("refusing real ~/.dsh");
  }
}

function verifiedFile(raw, label) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, path: "", error: `${label} is empty` };
  const path = resolve(raw.trim());
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, path, error: `${label} is not a file: ${path}` };
    return { ok: true, path };
  } catch {
    return { ok: false, path, error: `${label} missing: ${path}` };
  }
}

function resolveCliBin() {
  return verifiedFile(process.env.DSH_TEST_BIN || process.env.DSH_TEST_CLI_BIN || "", "DSH_TEST_BIN");
}

function resolveNodeExe() {
  return verifiedFile(process.env.DSH_TEST_NODE || process.execPath, "DSH_TEST_NODE");
}

function resolvePlaywrightModule() {
  const override = process.env.DSH_TEST_PLAYWRIGHT_MODULE?.trim();
  if (override) return resolve(override);
  return join(repo, "node_modules", "playwright");
}

function find7z() {
  const candidates = [
    "7z",
    "7za",
    join(process.env.ProgramFiles ?? "C:/Program Files", "7-Zip", "7z.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "7-Zip", "7z.exe"),
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--help"], { encoding: "utf8", timeout: 8_000, windowsHide: true });
    if (probe.error) continue;
    if (probe.status === 0 || (probe.stdout || probe.stderr || "").includes("7-Zip")) return candidate;
  }
  return null;
}

function inspectInstaller(path) {
  if (!path || !existsSync(path)) return { path: path || "", exists: false, executed: false };
  const stat = statSync(path);
  const listing = { path, exists: true, bytes: stat.size, listed: false, executed: false };
  const seven = find7z();
  if (!seven) {
    listing.note = "7z not on PATH; NSIS installer was not extracted or executed";
    return listing;
  }
  const listed = spawnSync(seven, ["l", path], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  listing.listed = listed.status === 0;
  listing.tool = seven;
  listing.names = (listed.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /app\.asar|DSH Spaces\.exe|resources\\app|spaces-payload/i.test(line))
    .slice(0, 20);
  listing.note = "7z l only; installer was not executed and no files were written";
  return listing;
}

function packagedLayout(exe) {
  const dir = dirname(resolve(exe));
  const resources = join(dir, "resources");
  return {
    exe: resolve(exe),
    dir,
    asar: existsSync(join(resources, "app.asar")),
    payloadLib: join(resources, "spaces-payload", "lib"),
    unpackedWorker: existsSync(join(resources, "app.asar.unpacked", "out", "main", "snapshot-worker.mjs")),
  };
}

function payloadForMode() {
  if (packagedExe) {
    return resolveSpacesPayloadRoot({
      packaged: true,
      resourcesPath: join(dirname(resolve(packagedExe)), "resources"),
      moduleDir: join(repo, "out", "main"),
    });
  }
  return resolveSpacesPayloadRoot({
    packaged: false,
    resourcesPath: join(repo, "resources"),
    moduleDir: join(repo, "out", "main"),
  });
}

function validatePayload(lib) {
  const result = validateComponentPayload(lib);
  return {
    ok: true,
    digest: result.digest,
    version: result.manifest.version,
    schemaVersion: result.manifest.schemaVersion,
    protocolVersion: result.manifest.protocolVersion,
    components: Object.keys(result.manifest.components),
    payloadRootLib: result.payloadRootLib,
  };
}

function collectPrereq() {
  const cli = resolveCliBin();
  const nodeExe = resolveNodeExe();
  const playwrightModule = resolvePlaywrightModule();
  const playwrightOk =
    existsSync(join(playwrightModule, "index.js")) || existsSync(join(playwrightModule, "index.mjs"));
  const layout = packagedExe ? packagedLayout(packagedExe) : null;
  const payloadLib = payloadForMode();
  const problems = [];
  if (!cli.ok) problems.push(cli.error);
  if (!nodeExe.ok) problems.push(nodeExe.error);
  if (!playwrightOk) problems.push(`Playwright missing at ${playwrightModule} (repo node_modules/playwright)`);
  if (packagedExe) {
    if (!existsSync(packagedExe)) {
      problems.push(`DSH_TEST_PACKAGED_EXE missing: ${packagedExe}. Build with: npm run build && ${packCommand}`);
    } else if (!layout.asar) {
      problems.push(
        `${packagedExe} has no sibling resources/app.asar; pass the unpacked/installed app exe, not the NSIS Setup installer`,
      );
    }
  } else if (!existsSync(unpackagedMain)) {
    problems.push("out/main/index.js is missing; npm run build first (unpackaged mode). Did not run a global build.");
  }
  let payload = null;
  if (packagedExe && existsSync(packagedExe) && layout?.asar) {
    try {
      payload = validatePayload(layout.payloadLib);
    } catch (error) {
      problems.push(`packaged spaces-payload/lib invalid: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  } else if (!packagedExe && existsSync(payloadLib)) {
    try {
      payload = validatePayload(payloadLib);
    } catch (error) {
      payload = { ok: false, error: redact(error instanceof Error ? error.message : String(error)) };
    }
  }
  if (installerPath && !existsSync(installerPath)) problems.push(`DSH_TEST_INSTALLER missing: ${installerPath}`);
  return {
    status: problems.length ? "fail" : "ready",
    problems,
    packaged: Boolean(packagedExe),
    packagedLayout: layout,
    payload,
    installerInspect: inspectInstaller(installerPath || (existsSync(expectedInstaller) ? expectedInstaller : "")),
    nsis: {
      distinguishedFromUnpackedLayout: true,
      executed: false,
      silentInstall: `"${expectedInstaller}" /S /currentuser /D=<temp-dir>`,
      note: "This verifier never runs the NSIS installer. Layout evidence is sibling resources/app.asar + spaces-payload.",
    },
    fixtures: {
      dshBin: cli.ok,
      dshBinPath: cli.path || undefined,
      nodeExe: nodeExe.ok,
      nodeExePath: nodeExe.path,
      playwright: playwrightOk,
      playwrightModule,
      unpackagedMain: existsSync(unpackagedMain),
      nodeZipRequired: false,
    },
    packCommand: `npm run build && ${packCommand}`,
    exeEntry: packagedExe || expectedUnpackedExe,
    expectedUnpackedExe,
    expectedInstaller,
    onDiskUnpacked: existsSync(expectedUnpackedExe),
    onDiskInstaller: existsSync(expectedInstaller),
    evidence,
    version: pkg.version,
  };
}

async function until(check, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function originPort(origin) {
  return Number(new URL(origin).port);
}

function waitPortClosed(port) {
  return new Promise((resolveClosed, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is still open`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolveClosed();
      else reject(error);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error(`Could not confirm shutdown of ${port}`));
    });
  });
}

function publicErrorCode(error) {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return "";
}

function isRetainedPublicError(error) {
  const code = publicErrorCode(error);
  if (!code) return false;
  if (code === "workbench/unavailable" || code === "spaces/unavailable") return false;
  return /^(workbench|spaces)\//.test(code) || code.startsWith("LLM_");
}

function persistedJobPath(homePath, requestId) {
  return join(homePath, HOME_CONTROL_DIR_NAME, "jobs", `${requestId}.json`);
}

function readPersistedJob(homePath, requestId) {
  const path = persistedJobPath(homePath, requestId);
  if (!existsSync(path)) return null;
  try {
    const row = JSON.parse(readFileSync(path, "utf8"));
    if (row.schemaVersion !== 1) return null;
    if (row.id !== requestId || row.requestId !== requestId) return null;
    if (typeof row.status !== "string" || typeof row.kind !== "string") return null;
    return {
      id: row.id,
      requestId: row.requestId,
      kind: row.kind,
      status: row.status,
      phase: row.phase,
      message: row.message,
      affectedSpaceIds: row.affectedSpaceIds,
      result: row.result,
      error: row.error,
    };
  } catch {
    return null;
  }
}

async function originRefused(origin) {
  try {
    await waitPortClosed(originPort(origin));
    return true;
  } catch {
    return false;
  }
}

function assertJobStillActive(job, label) {
  if (!ACTIVE_JOB.has(job.status)) {
    throw new Error(
      `${label}: job ${job.id} kind=${job.kind} already ${job.status} before desktop quit; V02/V06 client-quit-while-running is not covered`,
    );
  }
  if (job.result) {
    throw new Error(`${label}: public job.result present on ${job.id} while ${job.status}; result is only valid after completion`);
  }
}

function assertKnownJobStatus(job, label) {
  if (ACTIVE_JOB.has(job.status) || TERMINAL_JOB.has(job.status)) return;
  throw new Error(`${label}: job ${job.id} has unknown status ${job.status}`);
}

async function waitJob(api, submitted, label, options = {}) {
  const id = submitted?.id;
  if (!id) throw new Error(`${label}: public submit was not accepted`);
  const allowHttpClose = options.allowHttpClose === true;
  if (allowHttpClose && (!options.home || !options.origin)) {
    throw new Error(`${label}: HTTP-close wait requires home and origin for exact persisted id`);
  }
  if (allowHttpClose && submitted.requestId !== submitted.id) {
    throw new Error(`${label}: public accept requires submitted.requestId===submitted.id`);
  }
  let latest = submitted;
  let httpClosed = false;
  await until(async () => {
    if (!httpClosed) {
      try {
        latest = await api.job(id);
      } catch (error) {
        if (isRetainedPublicError(error) || !allowHttpClose) throw error;
        if (!(await originRefused(options.origin))) return false;
        httpClosed = true;
      }
      if (!httpClosed) {
        assertKnownJobStatus(latest, label);
        return ACTIVE_JOB.has(latest.status) ? false : latest;
      }
    }
    const persisted = readPersistedJob(options.home, id);
    if (!persisted) return false;
    if (persisted.id !== id || persisted.requestId !== submitted.requestId || persisted.kind !== submitted.kind) {
      throw new Error(
        `${label}: persisted job did not match accepted id=${id} requestId=${submitted.requestId} kind=${submitted.kind}`,
      );
    }
    assertKnownJobStatus(persisted, label);
    if (ACTIVE_JOB.has(persisted.status)) return false;
    latest = persisted;
    return latest;
  }, label, options.timeout ?? 240_000);
  return latest;
}

function contextOf(state) {
  return { serviceEpoch: state.serviceEpoch, expectedRevision: state.revision };
}

function isStaleCas(error) {
  const code = publicErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code === "workbench/conflict" || /conflict|revision|epoch/i.test(message);
}

function inspectSupervisor(homePath, liveOrigin) {
  const endpointPath = join(homePath, HOME_CONTROL_DIR_NAME, SUPERVISOR_ENDPOINT_FILE);
  const ownerPath = join(homePath, HOME_CONTROL_DIR_NAME, HOME_CONTROL_RUN_DIR_NAME, HOME_CONTROL_OWNER_FILE);
  const endpoint = readEndpointFile(endpointPath);
  let owner = { missing: true };
  if (existsSync(ownerPath)) {
    try {
      const row = JSON.parse(readFileSync(ownerPath, "utf8"));
      const occupant = row.owner && typeof row.owner === "object" ? row.owner : row.occupant && typeof row.occupant === "object" ? row.occupant : row;
      const pid = Number(occupant.pid ?? row.pid);
      const startedAt = String(occupant.startedAt ?? row.startedAt ?? "");
      owner = Number.isInteger(pid)
        ? { pid, startedAt, liveness: defaultPidAlive(pid, startedAt) }
        : { invalid: true };
    } catch {
      owner = { invalid: true };
    }
  }
  return { endpoint, owner, origin: liveOrigin };
}

const prereq = collectPrereq();
refuseRealHome(evidence);
mkdirSync(evidence, { recursive: true });
writeFileSync(join(evidence, "prereq.json"), `${JSON.stringify(prereq, null, 2)}\n`);
if (prereq.status !== "ready") {
  console.error(prereq.problems.join("\n"));
  process.exit(1);
}
console.log("PASS desktop prereq");
console.log(`DESKTOP_PACK_CMD=${prereq.packCommand}`);
console.log(`DESKTOP_EXE_ENTRY=${prereq.exeEntry}`);
console.log(`DESKTOP_INSTALLER=${expectedInstaller}`);
console.log(`DESKTOP_EVIDENCE=${evidence}`);
console.log(`DESKTOP_PACKAGED_LAYOUT=${Boolean(prereq.packagedLayout?.asar)}`);
console.log(`DESKTOP_NSIS_EXECUTED=false`);
if (prereqOnly) {
  console.log("DESKTOP_PREREQ_ONLY=1 (did not launch Electron or run NSIS)");
  process.exit(0);
}

const cliBin = resolveCliBin().path;
const nodeExe = resolveNodeExe().path;
const payloadRoot = payloadForMode();
const playwrightModule = resolvePlaywrightModule();
const root = mkdtempSync(join(tmpdir(), "spaces-desktop-"));
const home = join(root, "home");
const userData = join(root, "app");
mkdirSync(home);
mkdirSync(userData);
assert.ok(!isAbsolute(relative(tmpdir(), root)) && !relative(tmpdir(), root).startsWith(".."));
refuseRealHome(home);
refuseRealHome(userData);

const seed = spawnSync(nodeExe, [cliBin, "--profile", "web", "--dump-config"], {
  env: { ...process.env, DSH_HOME: home },
  encoding: "utf8",
  timeout: 60_000,
  windowsHide: true,
});
assert.equal(seed.status, 0, redact(seed.error?.message ?? seed.stderr ?? "official CLI web initialize failed"));
assert.ok(existsSync(join(home, "profiles", "web")), "official CLI did not create profiles/web");
pass("official CLI initialized web on disposable Home");

const { _electron: electron } = require(playwrightModule);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|GEMINI|GOOGLE|AZURE|DSH).*(?:API_KEY|ACCESS_TOKEN|SECRET)$/i.test(key)) {
    delete env[key];
  }
}
Object.assign(env, {
  DSH_SPACES_HOME: home,
  DSH_SPACES_USER_DATA: userData,
  DSH_SPACES_DISABLE_UPDATES: "1",
  DISABLE_UPDATES: "1",
  DSH_TEST_BIN: cliBin,
  DSH_TEST_CLI_BIN: cliBin,
  DSH_TEST_NODE: nodeExe,
});
delete env.ELECTRON_RUN_AS_NODE;

const chromeArgs = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

const app = await electron.launch(
  packagedExe
    ? {
        executablePath: resolve(packagedExe),
        args: chromeArgs,
        cwd: dirname(resolve(packagedExe)),
        env,
        timeout: 120_000,
      }
    : {
        executablePath: require("electron"),
        args: [repo, ...chromeArgs],
        cwd: repo,
        env,
        timeout: 120_000,
      },
);

let client = null;
let origin = "";
let presentedSnippet = "";
let chromium = null;
let electronPid = 0;
let electronStartedAt = "";
let electronClosePromise = null;
try {
  electronPid = Number(app.process()?.pid) || 0;
  electronStartedAt = new Date().toISOString();
} catch {
  electronPid = 0;
}
stage(`launch: electron pid=${electronPid || "unknown"}`);

function makeClient() {
  return new DesktopServiceClient({
    home,
    payloadRoot,
    toolsRoot: join(userData, "supervisor-tools"),
    snapshotRoot: join(userData, "snapshots"),
    allowRealHome: false,
  });
}

function endpointOrigin(endpointRead) {
  if (!endpointRead || typeof endpointRead !== "object" || !("endpoint" in endpointRead)) return "";
  try {
    return new URL(endpointRead.endpoint.origin).origin;
  } catch {
    return "";
  }
}

function pidIsAlive(pid, startedAt) {
  if (!pid || !startedAt) return false;
  return defaultPidAlive(pid, startedAt) === "alive";
}

function initiateElectronClose() {
  if (electronClosePromise) return electronClosePromise;
  stage("electron: initiate app.close (not awaiting Playwright close)");
  electronClosePromise = Promise.resolve()
    .then(() => app.close())
    .catch((error) => {
      stage(`electron: app.close settled ${redact(error instanceof Error ? error.message : String(error))}`);
    });
  return electronClosePromise;
}

async function awaitElectronCloseBounded(timeoutMs = 20_000) {
  if (!electronClosePromise) return;
  stage(`electron: bounded await close promise ${timeoutMs}ms`);
  let pending = true;
  await Promise.race([
    electronClosePromise.then(() => {
      pending = false;
    }),
    delay(timeoutMs),
  ]);
  stage(pending ? "electron: close promise still pending after bound; continuing" : "electron: close promise settled");
}

async function waitElectronProcessGone(pid, startedAt, timeoutMs = 20_000) {
  if (!pid) throw new Error("electron pid missing");
  if (!pidIsAlive(pid, startedAt)) {
    stage(`electron: pid ${pid} already dead`);
    return;
  }
  let proc = null;
  try {
    proc = app.process();
  } catch {
    proc = null;
  }
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    proc.once("exit", (code, signal) => {
      stage(`electron: process exit event pid=${pid} code=${code} signal=${signal}`);
    });
  } else if (proc && (proc.exitCode !== null || proc.signalCode !== null)) {
    stage(`electron: process handle already exited code=${proc.exitCode} signal=${proc.signalCode}`);
  }
  await until(() => (pidIsAlive(pid, startedAt) ? false : true), `electron pid ${pid} dead`, timeoutMs);
  stage(`electron: pid ${pid} verified dead`);
}

function stopExactRecordedPid(pid, startedAt) {
  if (!pidIsAlive(pid, startedAt)) return false;
  stage(`cleanup: taskkill exact recorded pid ${pid}`);
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 15_000 });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return true;
}

async function stopDetachedServiceIfNeeded() {
  const inspected = inspectSupervisor(home, origin);
  const pid = inspected.owner?.pid;
  const startedAt = inspected.owner?.startedAt;
  if (!pidIsAlive(pid, startedAt)) {
    stage("cleanup: no live supervisor");
    return;
  }
  const bindOrigin = origin || endpointOrigin(inspected.endpoint);
  stage(`cleanup: live supervisor pid=${pid}; public service.shutdown origin=${bindOrigin || "none"}`);
  try {
    const cleaner = makeClient();
    const attached = await cleaner.connect();
    if (attached.status !== "connected") throw new Error(attached.reasons.join("; ") || "cleanup attach failed");
    const api = cleaner.getApi();
    const state = await api.state();
    const plan = await api.preview({ kind: "service.shutdown" }, contextOf(state));
    const requestId = randomUUID();
    let job;
    try {
      job = await api.submit({ kind: "plan.execute", planId: plan.id }, requestId, contextOf(state));
    } catch (error) {
      if (isRetainedPublicError(error)) throw error;
      const persisted = readPersistedJob(home, requestId);
      if (!persisted || persisted.id !== requestId || persisted.requestId !== requestId || persisted.kind !== "plan.execute") {
        throw error;
      }
      job = persisted;
    }
    await waitJob(api, job, "cleanup service.shutdown", {
      allowHttpClose: Boolean(bindOrigin),
      home,
      origin: bindOrigin,
      timeout: 30_000,
    });
    await until(() => (pidIsAlive(pid, startedAt) ? false : true), `cleanup supervisor pid ${pid} dead`, 20_000);
    cleaner.dispose();
    stage("cleanup: public service.shutdown stopped supervisor");
    return;
  } catch (error) {
    stage(`cleanup: public shutdown failed ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  if (pidIsAlive(pid, startedAt)) stopExactRecordedPid(pid, startedAt);
  await until(() => (pidIsAlive(pid, startedAt) ? false : true), `cleanup taskkill pid ${pid} dead`, 15_000).catch(() => {
    stage(`cleanup: recorded pid ${pid} still alive after taskkill`);
  });
}

function isLoopback(url) {
  try {
    return /^http:\/\/127\.0\.0\.1:\d+/.test(url);
  } catch {
    return false;
  }
}

function contextPages() {
  try {
    const listed = app.context().pages();
    return Array.isArray(listed) ? listed : [];
  } catch {
    return [];
  }
}

async function readShellStartupError() {
  for (const item of contextPages()) {
    let url = "";
    try {
      url = item.url();
    } catch {
      continue;
    }
    if (isLoopback(url)) continue;
    try {
      const alert = item.getByRole("alert");
      if ((await alert.count()) > 0) {
        const text = (await alert.first().innerText()).trim();
        if (text) return text;
      }
      const red = item.locator("p.text-red-500");
      const n = await red.count();
      for (let i = 0; i < n; i += 1) {
        const node = red.nth(i);
        const text = ((await node.getAttribute("title")) || (await node.innerText())).trim();
        if (text) return text;
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function electronEntryPage() {
  return until(async () => {
    const startupError = await readShellStartupError();
    if (startupError) throw new Error(`desktop startup failed: ${redact(startupError)}`);
    for (const item of contextPages()) {
      let url = "";
      try {
        url = item.url();
      } catch {
        continue;
      }
      if (!isLoopback(url)) continue;
      try {
        if ((await item.locator("iframe#manager-frame").count()) > 0) return item;
      } catch {
        continue;
      }
    }
    return false;
  }, "electron bootstrap page with iframe#manager-frame", 240_000);
}

function managerFrame(page) {
  return page.frameLocator("iframe#manager-frame");
}

function pluginSearchSubmit(workbench) {
  return workbench
    .locator("form.dsh-wb-form")
    .filter({ has: workbench.getByRole("textbox", { name: PLUGIN_SEARCH }) })
    .locator('button[type="submit"]')
    .filter({ hasText: PLUGIN_SEARCH });
}

async function waitSharedWorkbench(page) {
  await page.locator("body[data-mode='live']").waitFor({ timeout: 240_000 });
  await page.locator("iframe#manager-frame").waitFor({ state: "attached", timeout: 60_000 });
  const workbench = managerFrame(page);
  await workbench.locator(".dsh-workbench").waitFor({ timeout: 60_000 });
  await workbench.getByRole("button", { name: NEW_SPACE }).waitFor({ timeout: 30_000 });
  return workbench;
}

async function captureManager(file) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("main window missing");
    const stack = [...(win.contentView?.children ?? [])];
    while (stack.length) {
      const child = stack.pop();
      if (child?.children) stack.push(...child.children);
      const url = child?.webContents?.getURL?.() ?? "";
      if (url.startsWith("http://127.0.0.1:")) {
        return (await child.webContents.capturePage()).toPNG().toString("base64");
      }
    }
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  });
  writeFileSync(join(evidence, file), Buffer.from(png, "base64"));
}

try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.bringToFront();

  const packagedFlag = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
  assert.equal(packagedFlag, Boolean(packagedExe), `app.isPackaged=${packagedFlag} packagedExe=${Boolean(packagedExe)}`);
  pass(packagedFlag ? "packaged app.isPackaged true" : "unpackaged app.isPackaged false");

  const windowState = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    const bounds = win.getBounds();
    return {
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      width: bounds.width,
      height: bounds.height,
      title: win.getTitle(),
    };
  });
  assert.ok(windowState?.visible, "main window is not visible");
  assert.equal(windowState.minimized, false);
  assert.ok(windowState.width >= 800 && windowState.height >= 560, "main window smaller than product minimum");
  pass(`main window visible ${windowState.width}x${windowState.height}`);

  stage("start: waiting for automatic workbench entry; no Start service click");
  const entryPage = await electronEntryPage();
  const shellState = await page.evaluate(() => window.dshSpaces.getState());
  assert.equal(shellState.serviceStatus, "connected");
  assert.equal(shellState.phase, "connected");
  assert.equal(shellState.canPrepare, false);
  assert.equal(shellState.canStart, false);
  pass("desktop launch automatically connected or started the workbench without a Start service click");
  origin = new URL(entryPage.url()).origin;
  const desktopWorkbench = await waitSharedWorkbench(entryPage);
  presentedSnippet = redact(await desktopWorkbench.locator(".dsh-workbench").innerText()).slice(0, 240);
  pass(`shared workbench in iframe#manager-frame at ${origin}`);

  await page.screenshot({ path: join(evidence, "window.png") });
  await captureManager("workbench.png");
  pass("screenshots of shell window and shared workbench");

  client = makeClient();
  const attached = await client.connect();
  assert.equal(attached.status, "connected", redact(attached.reasons.join("; ") || "second client attach failed"));
  const api = client.getApi();
  const entryUrl = await client.entryUrl();
  assert.match(entryUrl, /^http:\/\/127\.0\.0\.1:\d+\/bootstrap\//);
  pass("authenticated Node client attached via DesktopServiceClient.connect/entryUrl");

  const before = await api.state();
  assert.equal(before.protocolVersion, 2);
  assert.equal(before.availability === "unavailable", false);

  await desktopWorkbench.getByRole("button", { name: NEW_SPACE }).click();
  const createForm = desktopWorkbench.locator('form[aria-label="Create space"], form[aria-label="创建空间"]');
  await createForm.waitFor({ timeout: 30_000 });
  await createForm.locator('input[name="name"]').fill(SPACE_ID);
  await createForm.locator('input[name="displayName"]').fill(SPACE_DISPLAY);
  await createForm.getByRole("button", { name: /^(Create|创建)$/ }).click();

  const afterCreate = await until(async () => {
    const state = await api.state();
    const row = state.spaces.find((space) => space.id === SPACE_ID);
    return row || false;
  }, "created space visible on Node workbench API", 180_000);
  assert.equal(afterCreate.id, SPACE_ID);
  await desktopWorkbench.locator(`[data-created="${SPACE_ID}"]`).waitFor({ timeout: 30_000 });
  pass(`desktop UI created ${SPACE_ID}; Node client sees the same space`);

  let createJob = (await api.state()).jobs.find(
    (job) => job.kind === "space.create" && job.affectedSpaceIds.includes(SPACE_ID),
  );
  assert.ok(createJob, "space.create job missing on shared backend");
  createJob = await waitJob(api, createJob, "desktop space.create");
  assert.equal(createJob.status, "succeeded", redact(JSON.stringify(createJob.error || createJob)));
  pass(`backend: shared job ${createJob.id} kind=${createJob.kind} status=${createJob.status}`);

  const snapshot = await api.state();
  const renamed = await api.submit(
    { kind: "space.update", spaceId: SPACE_ID, displayName: SPACE_RENAMED },
    randomUUID(),
    contextOf(snapshot),
  );
  const renameJob = await waitJob(api, renamed, "space.update CAS");
  assert.equal(renameJob.status, "succeeded", redact(JSON.stringify(renameJob.error || renameJob)));
  const afterRename = await api.state();
  assert.equal(afterRename.spaces.find((space) => space.id === SPACE_ID)?.displayName, SPACE_RENAMED);
  assert.notEqual(afterRename.revision, snapshot.revision);
  await desktopWorkbench.getByRole("button", { name: SPACE_RENAMED }).waitFor({ timeout: 30_000 });
  pass("backend+UI: metadata CAS renamed to a different display name");

  let staleAccepted = false;
  let staleRejected = false;
  try {
    const stale = await api.submit(
      { kind: "space.update", spaceId: SPACE_ID, displayName: STALE_DISPLAY },
      randomUUID(),
      contextOf(snapshot),
    );
    const staleJob = await waitJob(api, stale, "stale space.update");
    if (staleJob.status === "succeeded") staleAccepted = true;
    else {
      assert.ok(isStaleCas(staleJob.error), redact(JSON.stringify(staleJob.error || staleJob)));
      staleRejected = true;
    }
  } catch (error) {
    assert.equal(isStaleCas(error), true, redact(error instanceof Error ? error.message : String(error)));
    staleRejected = true;
  }
  assert.equal(staleAccepted, false, "stale CAS must not succeed");
  assert.equal(staleRejected, true, "stale CAS must be rejected, not ignored");
  if (staleRejected) pass("backend: stale CAS rejected with workbench/conflict");
  const afterStale = await api.state();
  assert.equal(afterStale.revision, afterRename.revision);
  assert.equal(afterStale.spaces.find((space) => space.id === SPACE_ID)?.displayName, SPACE_RENAMED);
  pass("backend: stale CAS left revision and display name unchanged");

  await desktopWorkbench.getByRole("button", { name: /^(Settings|设置)$/ }).click();
  const settings = desktopWorkbench.locator("[data-settings-dialog='true']");
  await settings.waitFor({ timeout: 30_000 });
  const catalog = settings.getByLabel(/^(Catalog URL|目录 URL)$/);
  await catalog.waitFor({ timeout: 30_000 });
  await catalog.fill(DRAFT_CATALOG);
  await settings.getByRole("tab", { name: /^(Models and connections|模型与连接)$/ }).click();
  await settings.locator("[data-llm-center='true']").waitFor({ timeout: 30_000 });
  pass("UI: settings models tab (data-llm-center); no live model request");
  if (typeof api.llm !== "function") throw new Error("WorkbenchApi.llm is missing");
  const described = await api.llm({ method: "describe" });
  assert.ok(described && typeof described === "object");
  pass("backend: llm describe callable without credentials");
  await settings.getByRole("tab", { name: /^(General|常规)$/ }).click();
  await catalog.waitFor({ timeout: 15_000 });
  assert.equal(await catalog.inputValue(), DRAFT_CATALOG);
  pass("UI: settings draft survived General ↔ Models navigation (not saved)");
  const settingsProduct = await api.product({ method: "settings" });
  assert.equal(settingsProduct.method, "settings");
  assert.notEqual(settingsProduct.settings.catalogUrl, DRAFT_CATALOG);
  pass("backend: product settings still the saved catalog, not the unsaved draft");
  await settings.locator("[data-settings-close='true']").click();

  await desktopWorkbench.getByRole("button", { name: /^(Home|首页)$/ }).click();
  const pluginSearch = pluginSearchSubmit(desktopWorkbench);
  const homeTabs = [
    { name: /^(Overview|总览)$/ },
    { name: /^(Spaces|空间)$/ },
    { name: /^(Plugins|插件)$/, control: pluginSearch },
    { name: /^(Snapshots|快照)$/, marker: /^(Create Home snapshot|创建整 Home 快照)$/ },
    { name: /^(Runtime|运行时)$/, attr: "[data-workbench-package='true']" },
    { name: /^(Templates|模板)$/, attr: "[data-templates='true']" },
  ];
  for (const tab of homeTabs) {
    await desktopWorkbench.getByRole("tab", { name: tab.name }).click();
    if (tab.control) await tab.control.waitFor({ timeout: 30_000 });
    if (tab.marker) await desktopWorkbench.getByRole("button", { name: tab.marker }).waitFor({ timeout: 30_000 });
    if (tab.attr) await desktopWorkbench.locator(tab.attr).waitFor({ timeout: 30_000 });
  }
  pass("UI: Home tabs overview/spaces/plugins/snapshots/runtime/templates opened");

  await desktopWorkbench.getByRole("tab", { name: /^(Plugins|插件)$/ }).click();
  await pluginSearch.waitFor({ timeout: 30_000 });
  assert.equal(await pluginSearch.isEnabled(), true);
  await pluginSearch.click();
  const pluginRows = await api.plugins("");
  assert.ok(Array.isArray(pluginRows));
  pass("backend: plugins() callable after UI search");

  await desktopWorkbench.getByRole("tab", { name: /^(Snapshots|快照)$/ }).click();
  const snapshotRows = await api.snapshots();
  assert.ok(Array.isArray(snapshotRows));
  pass("backend: snapshots() callable; did not click create/restore");

  const templateProduct = await api.product({ method: "templates" });
  assert.equal(templateProduct.method, "templates");
  pass("backend: product templates callable");

  const runtimeRows = await api.runtimes();
  assert.ok(Array.isArray(runtimeRows));
  pass("backend: runtimes() callable; did not click install/upgrade");

  await desktopWorkbench.getByRole("tab", { name: /^(Spaces|空间)$/ }).click();
  await desktopWorkbench.getByRole("button", { name: /^(Diagnostics|诊断)$/ }).click();
  await desktopWorkbench.locator("[data-diagnostics='true']").waitFor({ timeout: 30_000 });
  pass("UI: space diagnostics overlay");
  const diag = await api.product({ method: "diagnostics", spaceId: SPACE_ID });
  assert.equal(diag.method, "diagnostics");
  const detail = await api.detail(SPACE_ID);
  assert.equal(detail.space.id, SPACE_ID);
  pass("backend: product diagnostics + detail callable");
  await desktopWorkbench.locator(".dsh-wb-dialog").getByRole("button", { name: /^(Close|关闭)$/ }).click();

  await desktopWorkbench.getByRole("button", { name: /^(Home|首页)$/ }).click();
  await desktopWorkbench.getByRole("tab", { name: /^(Overview|总览)$/ }).click();
  await desktopWorkbench.locator(`[data-job-id="${createJob.id}"]`).waitFor({ timeout: 30_000 });
  pass("UI: overview lists the create job");

  const pw = require(playwrightModule);
  chromium = await pw.chromium.launch({ headless: false, timeout: 30_000 });
  ownedClosers.push(() => chromium.close());
  const browserPage = await chromium.newPage();
  await browserPage.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const browserWorkbench = await waitSharedWorkbench(browserPage);
  await browserWorkbench.getByRole("button", { name: NEW_SPACE }).waitFor({ timeout: 30_000 });
  await browserWorkbench.getByRole("button", { name: SPACE_RENAMED }).waitFor({ timeout: 30_000 });
  await browserWorkbench.getByRole("button", { name: /^(Home|首页)$/ }).click();
  await browserWorkbench.getByRole("tab", { name: /^(Overview|总览)$/ }).click();
  const browserJob = browserWorkbench.locator(`[data-job-id="${createJob.id}"]`);
  await browserJob.waitFor({ timeout: 30_000 });
  assert.equal(await browserJob.getAttribute("data-status"), createJob.status);
  const browserState = await api.state();
  assert.ok(browserState.spaces.some((space) => space.id === SPACE_ID && space.displayName === SPACE_RENAMED));
  assert.ok(browserState.jobs.some((job) => job.id === createJob.id));
  await browserPage.screenshot({ path: join(evidence, "browser.png") });
  pass("UI+backend: Chromium manager iframe shows the same renamed space and create job");

  const knownJobIds = new Set((await api.state()).jobs.map((job) => job.id));
  assert.ok(knownJobIds.has(createJob.id), "initial space.create job missing before persist create");

  await page.bringToFront();
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("main window missing");
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  await desktopWorkbench.getByRole("button", { name: /^(Home|首页)$/ }).click();
  await desktopWorkbench.getByRole("button", { name: NEW_SPACE }).click();
  const persistForm = desktopWorkbench.locator('form[aria-label="Create space"], form[aria-label="创建空间"]');
  await persistForm.waitFor({ timeout: 30_000 });
  await persistForm.locator('input[name="name"]').fill(SURVIVE_SPACE_ID);
  await persistForm.locator('input[name="displayName"]').fill(SURVIVE_DISPLAY);
  await persistForm.getByRole("button", { name: /^(Create|创建)$/ }).click();

  const persistJob = await until(async () => {
    const state = await api.state();
    const created = state.jobs.filter((job) => job.kind === "space.create" && !knownJobIds.has(job.id));
    if (created.length > 1) {
      throw new Error(`expected one new space.create; found ${created.map((job) => job.id).join(",")}`);
    }
    const row = created[0];
    if (!row) return false;
    assertJobStillActive(row, "capture new space.create");
    assert.notEqual(row.id, createJob.id);
    return row;
  }, "new space.create job still queued/running", 60_000);
  stage(`persist: captured active ${persistJob.kind} ${persistJob.id} status=${persistJob.status}`);
  pass(`backend: captured active ${persistJob.kind} ${persistJob.id} status=${persistJob.status} before desktop quit`);

  await browserWorkbench.getByRole("button", { name: /^(Home|首页)$/ }).click();
  await browserWorkbench.getByRole("tab", { name: /^(Overview|总览)$/ }).click();
  const browserPersist = browserWorkbench.locator(`[data-job-id="${persistJob.id}"]`);
  await browserPersist.waitFor({ timeout: 30_000 });
  const aligned = await until(async () => {
    const shown = await browserPersist.getAttribute("data-status").catch(() => null);
    const liveJob = await api.job(persistJob.id);
    assert.equal(liveJob.id, persistJob.id);
    assert.equal(liveJob.kind, "space.create");
    assertJobStillActive(liveJob, "browser observe");
    if (shown == null) return false;
    if (!ACTIVE_JOB.has(shown)) {
      throw new Error(
        `V02/V06 race: browser already shows ${persistJob.id} status=${shown} before desktop quit; client-quit-while-running is not covered`,
      );
    }
    return shown === liveJob.status ? { shown, liveJob } : false;
  }, "browser and API share the same active job id/status", 30_000);
  pass(`UI: Chromium shows the same active job ${persistJob.id} status=${aligned.shown}`);

  await captureManager("persist-active.png");
  const atQuit = await api.job(persistJob.id);
  assert.equal(atQuit.id, persistJob.id);
  assert.equal(atQuit.kind, "space.create");
  assertJobStillActive(atQuit, "immediately before desktop quit");

  const beforeQuit = inspectSupervisor(home, origin);
  assert.ok(beforeQuit.owner.pid, "supervisor owner pid missing before desktop quit");
  stage(`quit: supervisor pid=${beforeQuit.owner.pid} electron pid=${electronPid}; initiate close`);
  initiateElectronClose();
  await waitElectronProcessGone(electronPid, electronStartedAt, 20_000);
  assert.equal(pidIsAlive(electronPid, electronStartedAt), false, `electron pid ${electronPid} still alive after quit`);
  const afterElectronGone = inspectSupervisor(home, origin);
  assert.equal(afterElectronGone.owner.liveness, "alive", "supervisor pid must stay alive after desktop quit");
  assert.equal(afterElectronGone.owner.pid, beforeQuit.owner.pid);
  pass("desktop Electron process exited while space.create still active; no service.shutdown");

  stage("quit: leftover DesktopServiceClient attach");
  const leftover = makeClient();
  client = leftover;
  const still = await leftover.connect();
  assert.equal(still.status, "connected", redact(still.reasons.join("; ") || "supervisor gone after desktop quit"));
  const live = leftover.getApi();
  stage(`quit: wait exact job ${persistJob.id} on detached service`);
  const persistDone = await waitJob(live, persistJob, "detached space.create after desktop quit");
  assert.equal(persistDone.id, persistJob.id);
  assert.equal(persistDone.kind, "space.create");
  assert.equal(persistDone.status, "succeeded", redact(JSON.stringify(persistDone.error || persistDone)));
  assert.equal(persistDone.result?.spaceId, SURVIVE_SPACE_ID);
  assert.ok(persistDone.affectedSpaceIds.includes(SURVIVE_SPACE_ID));
  pass(`backend: detached service finished exact job ${persistDone.id} without resubmit; result.spaceId=${SURVIVE_SPACE_ID}`);

  await until(async () => {
    const status = await browserPersist.getAttribute("data-status").catch(() => null);
    return status === "succeeded" ? status : false;
  }, `browser job ${persistJob.id} succeeded after desktop quit`, 180_000);
  await browserWorkbench.getByRole("button", { name: SURVIVE_DISPLAY }).waitFor({ timeout: 60_000 });
  await browserWorkbench.locator(`[data-created="${SURVIVE_SPACE_ID}"]`).waitFor({ timeout: 30_000 });
  await browserPage.screenshot({ path: join(evidence, "persist-browser.png") });
  pass("UI: Chromium shows succeeded job and new space after desktop quit; did not resubmit");

  const liveState = await live.state();
  assert.equal(liveState.protocolVersion, 2);
  assert.ok(liveState.spaces.some((space) => space.id === SPACE_ID && space.displayName === SPACE_RENAMED));
  assert.ok(liveState.spaces.some((space) => space.id === SURVIVE_SPACE_ID && space.displayName === SURVIVE_DISPLAY));
  assert.ok(liveState.jobs.some((job) => job.id === createJob.id));
  assert.ok(liveState.jobs.some((job) => job.id === persistJob.id && job.status === "succeeded"));
  const stillAlive = inspectSupervisor(home, origin);
  assert.equal(stillAlive.owner.liveness, "alive", "supervisor pid must stay alive after desktop quit");
  assert.equal("endpoint" in stillAlive.endpoint, true, "supervisor endpoint must remain after desktop quit");
  assert.equal(stillAlive.owner.pid, beforeQuit.owner.pid);
  pass("backend: Supervisor still answers after desktop client exit (owned pid unchanged)");

  const ownerPid = stillAlive.owner.pid;
  const ownerStarted = stillAlive.owner.startedAt;
  stage("shutdown: preview/submit service.shutdown");
  const shutPlan = await live.preview({ kind: "service.shutdown" }, contextOf(liveState));
  const shutRequestId = randomUUID();
  let shutJob;
  try {
    shutJob = await live.submit({ kind: "plan.execute", planId: shutPlan.id }, shutRequestId, contextOf(liveState));
  } catch (error) {
    if (isRetainedPublicError(error)) throw error;
    const persisted = readPersistedJob(home, shutRequestId);
    if (!persisted || persisted.id !== shutRequestId || persisted.requestId !== shutRequestId || persisted.kind !== "plan.execute") {
      throw error;
    }
    shutJob = persisted;
  }
  assert.equal(shutJob?.id, shutRequestId, "service.shutdown public request id must be the exact persisted job id");
  assert.equal(shutJob.requestId, shutJob.id, "service.shutdown accepted requestId must equal job id");
  assert.equal(shutJob.kind, "plan.execute");
  const shutDone = await waitJob(live, shutJob, "service.shutdown", {
    allowHttpClose: true,
    home,
    origin,
  });
  assert.equal(shutDone.id, shutRequestId);
  assert.equal(shutDone.status, "succeeded", redact(JSON.stringify(shutDone.error || shutDone)));
  const port = originPort(origin);
  await until(async () => {
    try {
      await waitPortClosed(port);
      return true;
    } catch {
      return false;
    }
  }, `manager port ${port} closed after shutdown`, 30_000);
  const afterStop = inspectSupervisor(home, origin);
  const pidNow = afterStop.owner.missing
    ? "dead"
    : afterStop.owner.liveness ?? defaultPidAlive(ownerPid, ownerStarted);
  assert.equal(pidNow, "dead", `supervisor pid ${ownerPid} liveness=${pidNow} after shutdown`);
  assert.equal("endpoint" in afterStop.endpoint, false, "supervisor endpoint must not remain valid after shutdown");
  assert.equal(process.pid !== ownerPid, true);
  pass("backend: explicit service.shutdown succeeded; owned supervisor pid dead; this verifier process still alive");
  await awaitElectronCloseBounded(20_000);

  writeFileSync(
    join(evidence, "results.json"),
    `${JSON.stringify(
      {
        status: "pass",
        at: new Date().toISOString(),
        packaged: Boolean(packagedExe),
        packagedLayout: prereq.packagedLayout,
        nsisExecuted: false,
        installerInspect: prereq.installerInspect,
        payload: prereq.payload,
        origin,
        home,
        userData,
        presented: presentedSnippet,
        persistJob: {
          id: persistJob.id,
          kind: persistJob.kind,
          capturedStatus: persistJob.status,
          doneStatus: persistDone.status,
          spaceId: SURVIVE_SPACE_ID,
        },
        checks,
        screenshots: [
          "window.png",
          "workbench.png",
          existsSync(join(evidence, "browser.png")) ? "browser.png" : null,
          existsSync(join(evidence, "persist-active.png")) ? "persist-active.png" : null,
          existsSync(join(evidence, "persist-browser.png")) ? "persist-browser.png" : null,
        ].filter(Boolean),
      },
      null,
      2,
    )}\n`,
  );
  console.log("PASS desktop shell + shared workbench");
  console.log(`DESKTOP_SMOKE_ROOT=${root}`);
  console.log(`DESKTOP_EVIDENCE=${evidence}`);
  console.log(`DESKTOP_PACKAGED=${Boolean(packagedExe)}`);
} catch (error) {
  const pages = contextPages();
  writeFileSync(
    join(evidence, "failure.json"),
    `${JSON.stringify(
      {
        message: redact(error instanceof Error ? error.message : String(error)),
        pages: pages.map((item) => {
          try {
            return redact(item.url());
          } catch {
            return "<unavailable>";
          }
        }),
        home,
        userData,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  console.error(`FAIL sanitized evidence written to ${join(evidence, "failure.json")}`);
  throw error;
} finally {
  try {
    await stopDetachedServiceIfNeeded();
  } catch (error) {
    stage(`cleanup: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  if (!electronClosePromise && pidIsAlive(electronPid, electronStartedAt)) initiateElectronClose();
  await awaitElectronCloseBounded(20_000);
  if (pidIsAlive(electronPid, electronStartedAt)) {
    await waitElectronProcessGone(electronPid, electronStartedAt, 20_000).catch((error) => {
      stage(`cleanup: ${redact(error instanceof Error ? error.message : String(error))}`);
    });
  }
  while (ownedClosers.length) {
    const close = ownedClosers.pop();
    await Promise.race([Promise.resolve().then(close).catch(() => {}), delay(20_000)]);
  }
  client?.dispose();
  const leftoverOwner = inspectSupervisor(home, origin).owner;
  const serviceLive = pidIsAlive(leftoverOwner?.pid, leftoverOwner?.startedAt);
  const shellLive = pidIsAlive(electronPid, electronStartedAt);
  if (serviceLive || shellLive) {
    stage(`cleanup: skip rmSync while live service=${serviceLive} electron=${shellLive}`);
  } else {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* leftover Home is disposable temp; do not touch ~/.dsh */
    }
  }
}
