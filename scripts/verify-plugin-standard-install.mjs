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
 *   node scripts/verify-plugin-standard-install.mjs --preflight
 *   node scripts/verify-plugin-standard-install.mjs
 *
 * Env: DSH_TEST_BIN, DSH_TEST_RC2_BIN, DSH_TEST_OUTPUT, DSH_TEST_PLAYWRIGHT,
 * DSH_TEST_PNPM_CJS, DSH_PACK_DEST.
 *
 * --preflight is syntax/static/safe mocks only: no DSH web, no supervisor,
 * no Playwright browser, no shared build.
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
  runDshRetry,
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
const ACCEPTED_CLI = new Set(["0.1.5-rc.1", "0.1.5-rc.2"]);
const INIT_BUTTON = /^(初始化 Spaces|Initialize Spaces)$/;
const ENTER_BUTTON = /^(进入工作台|Enter workbench)$/;
const SIDEBAR_TAB = /^(工作台|Workbench)$/;
const ONBOARDING = [/^(Continue|继续)$/, /稍后配置|set up later|configure later/i];
const CONTROL_DIR = ".dsh-spaces-control";
const MANAGER_FILE = "manager.json";
const ENDPOINT_FILE = "endpoint.json";
const ENTRY_PORT_FILE = "entry-port.json";
const OWNER_FILE = join("run", "owner.json");

const proved = [];
const report = {
  status: "running",
  proved,
  modelCalls: false,
  unpublished: true,
  pageErrors: [],
  consoleErrors: [],
  rpcErrors: [],
  cli: { latest: "0.1.5-rc.1", next: "0.1.5-rc.2" },
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
    "Official DSH CLI not found. Install the global package (@deepseek-ai/dsh@0.1.5-rc.1 latest or @0.1.5-rc.2 next) or set DSH_TEST_BIN to that package's lib/bin.js. This script does not guess a machine-local Temp path.",
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
  if (!ACCEPTED_CLI.has(version)) {
    throw new Error(`${label} is ${version}; accepted write/install CLIs are 0.1.5-rc.1 (latest) and 0.1.5-rc.2 (next)`);
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

function managerRecord(home) {
  const path = join(home, CONTROL_DIR, MANAGER_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { broken: true, path };
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
  const alert = page.locator(".dsh-spaces-return [role='alert']").first();
  if (!(await alert.count())) return "";
  if (!(await alert.isVisible().catch(() => false))) return "";
  return ((await alert.textContent()) || "").trim();
}

async function openGuidePanel(page) {
  const panel = page.locator(".dsh-spaces-return");
  if (await panel.isVisible().catch(() => false)) return panel;
  const tab = page.getByRole("button", { name: SIDEBAR_TAB });
  await tab.waitFor({ state: "visible", timeout: 30000 });
  await tab.click();
  await panel.waitFor({ state: "visible", timeout: 15000 });
  return panel;
}

async function clickInitialize(page) {
  const panel = await openGuidePanel(page);
  const init = panel.getByRole("button", { name: INIT_BUTTON });
  await init.waitFor({ state: "visible", timeout: 30000 });
  await init.click();
}

async function enterOrInitialize(page) {
  const panel = await openGuidePanel(page);
  const action = panel.getByRole("button", { name: /^(进入工作台|Enter workbench|初始化 Spaces|Initialize Spaces)$/ });
  await action.waitFor({ state: "visible", timeout: 30000 });
  const name = await action.innerText();
  await action.click();
  return ENTER_BUTTON.test(name) ? "enter" : "initialize";
}

function assertSingleManager(home, label) {
  const hubs = hubProfiles(home);
  const record = managerRecord(home);
  if (hubs.length !== 1) {
    throw new Error(`${label}: expected one manager profile, found ${JSON.stringify(hubs)}`);
  }
  if (!record || record.broken) throw new Error(`${label}: manager.json missing or damaged`);
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

function readHomeIdentity(home) {
  const control = join(home, CONTROL_DIR);
  const endpointPath = join(control, ENDPOINT_FILE);
  const portPath = join(control, ENTRY_PORT_FILE);
  const ownerPath = join(control, OWNER_FILE);
  let endpoint = null;
  if (existsSync(endpointPath)) {
    try {
      const raw = JSON.parse(readFileSync(endpointPath, "utf8"));
      const parsed = typeof raw.origin === "string" ? loopbackOrigin(raw.origin) : null;
      if (raw.version === 1 && parsed && typeof raw.bearer === "string" && raw.bearer) {
        endpoint = { origin: parsed.origin, port: parsed.port, bearer: raw.bearer };
      }
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

async function waitJob(api, command, label) {
  const submitted = await api("submit", { command, requestId: randomUUID() });
  let latest = submitted;
  await until(async () => {
    latest = await api("job", { id: submitted.id });
    return !["queued", "running"].includes(latest.status);
  }, label, 240000);
  if (latest.status !== "succeeded") {
    const error = redact(`${label} ${latest.status}: ${JSON.stringify(latest.error)}`);
    report.rpcErrors.push(error);
    throw new Error(error);
  }
  return latest;
}

async function managerFrameOf(page, api) {
  const state = await api("state");
  if (state.role !== "manager" || !state.managerId) {
    throw new Error(`workbench state is not manager: ${redact(JSON.stringify(state))}`);
  }
  const view = await api("view", { spaceId: state.managerId });
  const prefix = `${view.origin}/`;
  await until(() => page.frames().some((frame) => frame.url().startsWith(prefix)), "manager iframe", 60000);
  const frame = page.frames().find((row) => row.url().startsWith(prefix));
  if (!frame) throw new Error("manager iframe missing after wait");
  await frame.locator(".dsh-wb-rail").waitFor({ state: "visible", timeout: 60000 });
  return { state, view, frame };
}

async function waitHandoff(page, webPort) {
  return until(async () => {
    const alert = await guideAlert(page);
    if (alert) throw new Error(`initialize UI error: ${redact(alert)}`);
    try {
      const url = new URL(page.url());
      return url.hostname === HOST && Number(url.port) !== webPort && url.protocol === "http:";
    } catch {
      return false;
    }
  }, "handoff to supervisor origin", 240000);
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

async function shutdownThisHome({ home, api, origin, web }) {
  const identity = existsSync(home) ? readHomeIdentity(home) : { endpoint: null, entryPort: null, owner: null };
  const ports = new Set();
  if (web?.port) ports.add(web.port);
  if (identity.entryPort) ports.add(identity.entryPort);
  if (identity.endpoint?.port) ports.add(identity.endpoint.port);
  const instances = join(home, CONTROL_DIR, "instances");
  if (existsSync(instances)) {
    for (const file of readdirSync(instances).filter(file => file.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(join(instances, file), "utf8"));
      if (record.version === 1 && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535 &&
          record.origin === `http://${HOST}:${record.port}`) ports.add(record.port);
    }
  }
  if (origin) {
    const parsed = loopbackOrigin(origin);
    if (parsed) ports.add(parsed.port);
  }

  let call = api;
  if (!call && identity.endpoint) call = bearerApi(identity.endpoint);
  try { if (call) {
    const plan = await call("preview", { request: { kind: "controller.shutdown" } });
    const submitted = await call("submit", {
      command: { kind: "plan.execute", planId: plan.id },
      requestId: randomUUID(),
    });
    await until(async () => {
      const job = await call("job", { id: submitted.id });
      return !["queued", "running"].includes(job.status);
    }, "controller.shutdown", 120000).catch((error) => {
      report.rpcErrors.push(redact(error instanceof Error ? error.message : String(error)));
    });
  } } catch (error) {
    report.rpcErrors.push(redact(error instanceof Error ? error.message : String(error)));
  }

  // The ordinary Web was started by this harness, not by the supervisor.
  if (web?.child) await stopOwned(web.child);

  for (const port of ports) {
    await waitPortClosed(port, PORT_MS).catch(() => {});
  }

  const stillOpen = [];
  for (const port of ports) {
    try {
      await waitPortClosed(port, 1000);
    } catch {
      stillOpen.push(port);
    }
  }
  if (stillOpen.length && identity.owner?.pid && identity.endpoint) {
    const ownerOrigin = typeof identity.owner.endpoint === "string" ? loopbackOrigin(identity.owner.endpoint) : null;
    if (ownerOrigin && ownerOrigin.origin === identity.endpoint.origin) {
      await stopPid(identity.owner.pid);
      for (const port of stillOpen) await waitPortClosed(port, PORT_MS).catch(() => {});
    }
  }

  if (web?.child) await stopOwned(web.child);
  if (web?.port) await waitPortClosed(web.port, PORT_MS).catch(() => {});

  const leftover = [];
  for (const port of ports) {
    try {
      await waitPortClosed(port, 1000);
    } catch {
      leftover.push(port);
    }
  }
  report.ownedPorts = [...ports];
  report.leftoverPorts = leftover;
  if (leftover.length) {
    throw new Error(`owned test ports still open after shutdown: ${leftover.join(", ")}`);
  }
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

async function preflight() {
  assertNoHardcodedMachinePaths();
  pass("pack and verify scripts do not embed operator machine paths");

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
  let rc2 = null;
  try {
    const bin = resolveDshBin("DSH_TEST_RC2_BIN");
    if (bin) {
      const version = inspectCli(bin, "DSH_TEST_RC2_BIN");
      rc2 = { bin, version };
      pass(`resolved next CLI ${version} from DSH_TEST_RC2_BIN`);
    }
  } catch (error) {
    info(String(error.message));
  }

  report.status = "preflight";
  report.cli.resolved = cli;
  report.cli.rc2 = rc2;
  report.scope =
    "static/mocks only: manifests, nested-tgz detector, pack dry-run contents, Home/path guards. Did not boot DSH web, supervisor, or Playwright.";
  pass("serial run contract: Playwright clicks Initialize Spaces with no path args; rail is asserted on the manager iframe; shutdown uses this Home only");
  return report;
}

async function main() {
  const out = outputDir();
  mkdirSync(out, { recursive: true });
  report.output = out;
  report.startedAt = new Date().toISOString();

  if (process.argv.includes("--preflight")) {
    await preflight();
    writeJson(join(out, "preflight.json"), report);
    console.log("\nSTANDARD INSTALL PREFLIGHT: PASS");
    return;
  }

  const nodeExe = process.execPath;
  const bin = resolveDshBin();
  const version = inspectCli(bin, "selected DSH CLI");
  report.cli.resolved = { bin, version };
  pass(`using official CLI ${version} (latest=0.1.5-rc.1, next=0.1.5-rc.2)`);

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

  runDshRetry(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", WEB_PROFILE, "add", pluginTgz, "--config.auto-install-peers=true"],
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
  assert.equal(hubProfiles(home).length, 0);
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
  try {
    web = await startWeb(nodeExe, bin, home, tooling, join(out, "web.log"));
    await openAuthorizedWeb(page, web.launchUrl);
    await dismissOnboarding(page);
    await clickInitialize(page);
    await waitHandoff(page, web.port);
    supervisorOrigin = new URL(page.url()).origin;
    api = workbenchApi(context, supervisorOrigin);
    await managerFrameOf(page, api);
    await screenshot(page, out, "initialized.png");
    pass("Playwright clicked initialize; supervisor stable page shows the manager iframe rail");

    const first = assertSingleManager(home, "after initialize");
    pass(`one manager ${first.hubs[0]} after initialize`);

    const state = await api("state");
    assert.equal(state.role, "manager");
    assert.equal(state.recoveryRequired, false);
    assert.ok(!state.reasons.includes("Unfinished Home maintenance must be recovered before new changes."));
    assert.ok(!state.reasons.includes("The manager profile cannot be used until recovery."));
    await waitJob(api, { kind: "space.create", input: { name: "coding", displayName: "编程" } }, "space.create");
    await waitJob(api, { kind: "space.start", spaceId: "coding" }, "space.start");
    const codingPkg = JSON.parse(readFileSync(join(home, "profiles", "coding", "package.json"), "utf8"));
    assert.equal(Boolean(codingPkg.dependencies?.[CANONICAL_NAME]), false);
    assert.ok(codingPkg.dependencies?.["@dsh-spaces/view-bridge"]);
    pass("created and started an ordinary space with view-bridge only");
    const managerView = await managerFrameOf(page, api);
    await managerView.frame.getByRole("button", { name: "编程", exact: true }).click();
    const codingView = await api("view", { spaceId: "coding" });
    await until(() => page.frames().some(frame => frame.url().startsWith(codingView.origin + "/")), "ordinary space iframe", 60000);
    await managerView.frame.locator('iframe[data-space-id="coding"][data-visible="true"]').waitFor({ state: "visible", timeout: 60000 });
    await dismissOnboarding(page.frames().find(frame => frame.url().startsWith(codingView.origin + "/")));
    pass("selected space completed the view-bridge handshake and is visible");
    await screenshot(page, out, "coding.png");

    await page.goto(`http://${HOST}:${web.port}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissOnboarding(page);
    await enterOrInitialize(page);
    await waitHandoff(page, web.port);
    await managerFrameOf(page, workbenchApi(context, new URL(page.url()).origin));
    const second = assertSingleManager(home, "repeat initialize");
    assert.deepEqual(second.hubs, first.hubs);
    pass("repeat initialize / enter did not add a second manager");

    // Stop only this ordinary Web host. A process-tree kill would also kill
    // the detached supervisor whose independence this restart is testing.
    web.child.kill();
    await waitPortClosed(web.port, PORT_MS);
    web = await startWeb(nodeExe, bin, home, tooling, join(out, "web-restart.log"));
    await openAuthorizedWeb(page, web.launchUrl);
    await dismissOnboarding(page);
    await enterOrInitialize(page);
    await waitHandoff(page, web.port);
    supervisorOrigin = new URL(page.url()).origin;
    api = workbenchApi(context, supervisorOrigin);
    await managerFrameOf(page, api);
    const third = assertSingleManager(home, "after web restart");
    assert.deepEqual(third.hubs, first.hubs);
    pass("close and restart ordinary web re-enters the same manager");
    assert.deepEqual(report.pageErrors, [], "Unexpected browser runtime errors");
  } catch (error) {
    report.initAlert = redact(await guideAlert(page).catch(() => ""));
    await screenshot(page, out, "failure.png");
    throw error;
  } finally {
    try {
      await shutdownThisHome({ home, api, origin: supervisorOrigin, web });
    } catch (error) {
      report.shutdownError = redact(error instanceof Error ? error.message : String(error));
      if (!report.error) report.error = report.shutdownError;
    }
    await browser.close().catch(() => {});
  }
  if (report.shutdownError) throw new Error(report.shutdownError);
  if (report.leftoverPorts?.length) {
    throw new Error(`owned test ports still open after shutdown: ${report.leftoverPorts.join(", ")}`);
  }

  runDshRetry(
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
