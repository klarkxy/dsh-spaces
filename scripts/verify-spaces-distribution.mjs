#!/usr/bin/env node
/**
 * Bounded CLI-distribution acceptance for the packed DSH Spaces plugin.
 *
 * Proves, when packages/plugin is a packable dsh.bundle:
 *   disposable DSH_HOME, real `dsh plugin add` auto-activates (bundles +
 *   dump id dsh-spaces with no user insert), id-only snapshotRoot overlay,
 *   owned Host RPC, replace/reinstall of the same 0.2.0 tarball, remove on
 *   the same coding profile (package+bundle gone, dump has no plugin row,
 *   session/list works, spaces RPC gone).
 *
 * Default tarball is `npm pack ./packages/plugin` (absolute path). Old
 * `.sandbox/pluginization-delivery` artifacts are not used unless
 * DSH_TEST_PLUGIN_TGZ is set.
 *
 * Optional unknown CLI: DSH_TEST_UNKNOWN_BIN or DSH_TEST_DOWNLOAD_UNKNOWN=1
 * (registry 0.1.5-rc.2). Must prove unknown-readonly, create/verify denied,
 * and config fingerprint unchanged. Missing that is FAIL, not PASS.
 *
 * Does not prove: Playwright/Electron, model calls, production ~/.dsh,
 * tar-extract/junction install, package-version upgrades.
 */

import { createConnection, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Scalar, YAMLMap, isMap, isSeq, parseDocument } from "yaml";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(REPO, ".sandbox", "spaces-distribution-acceptance");
const PLUGIN_DIR = join(REPO, "packages", "plugin");
const CORE_LIB = join(REPO, "packages", "core", "lib", "index.js");
const REAL_HOME = join(homedir(), ".dsh");
const HOST = "127.0.0.1";
const DEFAULT_BIN =
  "C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js";
const FALLBACK_NODE =
  "C:/Users/admin/AppData/Local/Temp/spaces-node-upgrade-cSfOOr/node/node-v22.23.2-win-x64/node.exe";
const TOOLCHAIN_PNPM =
  "C:/Users/admin/AppData/Roaming/dsh-spaces/toolchain/pnpm/node_modules/pnpm/bin/pnpm.cjs";
const REGISTRY = "https://registry.npmmirror.com";
const UNKNOWN_DOWNLOAD_SPEC = "@deepseek-ai/dsh@0.1.5-rc.2";

const DUMP_MS = 180_000;
const PACK_MS = 60_000;
const PLUGIN_MS = 180_000;
const BOOT_MS = 90_000;
const RPC_MS = 15_000;
const STOP_MS = 15_000;
const PORT_MS = 10_000;
const DOWNLOAD_MS = 180_000;
const LAUNCH_RING = 16_384;

const HOST_PROFILE = "coding";
const PEER_PROFILE = "notes";
const CANONICAL_NAME = "@dsh-spaces/plugin";
const PLUGIN_ROW_ID = "dsh-spaces";
const SNAPSHOT_ID = "11111111-1111-1111-1111-111111111111";
const SNAPSHOT_AT = "2026-09-12T00:00:00.000Z";
const REQUIRED_LIBS = [
  "lib/index.js",
  "lib/client.js",
  "lib/typert.host.js",
  "lib/typert.remote-client.js",
];

const proved = [];
const skipped = [];

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}
function pass(m) {
  proved.push(m);
  console.log(`PASS  ${redact(m)}`);
}
function skip(m) {
  skipped.push(m);
  console.log(`SKIP  ${redact(m)}`);
}
function redact(text) {
  return String(text)
    .replace(/[?&]token=[^&\s\x1b"']+/gi, "[redacted-token]")
    .replace(/dsh-auth-[^=]+=[^;\s"']+/gi, "[redacted-cookie]");
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function refuseRealHome(home) {
  const resolved = resolve(home);
  const real = resolve(REAL_HOME);
  if (samePath(resolved, real) || resolved.toLowerCase().startsWith(real.toLowerCase() + sep)) {
    throw new Error("refusing real ~/.dsh");
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nodeSupportsImportMetaMain(exe) {
  const dir = mkdtempSync(join(tmpdir(), "spaces-node-main-"));
  const script = join(dir, "probe.mjs");
  try {
    writeFileSync(script, "console.log(import.meta.main === true ? 'yes' : 'no');\n", "utf8");
    const result = spawnSync(exe, [script], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    });
    return result.status === 0 && (result.stdout || "").trim() === "yes";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function resolveNode() {
  const candidates = [process.execPath, FALLBACK_NODE].filter((exe) => existsSync(exe));
  for (const exe of candidates) {
    if (nodeSupportsImportMetaMain(exe)) {
      info(`node ${exe}`);
      return exe;
    }
  }
  throw new Error("no Node binary with import.meta.main; expected current execPath or 22.23.2 fallback");
}

function resolveNpmCli(nodeExe) {
  const nextToNode = join(dirname(nodeExe), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(nextToNode)) return nextToNode;
  const probe = spawnSync(nodeExe, ["-p", "require.resolve('npm/bin/npm-cli.js')"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  const path = (probe.stdout || "").trim();
  if (probe.status === 0 && existsSync(path)) return path;
  throw new Error("npm-cli.js not found next to the selected Node");
}

function resolvePnpmCjs() {
  const override = process.env.DSH_TEST_PNPM_CJS?.trim();
  const candidates = [
    override,
    TOOLCHAIN_PNPM,
    join(process.env.APPDATA ?? "", "npm", "node_modules", "pnpm", "bin", "pnpm.cjs"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return resolve(path);
  }
  throw new Error("pnpm.cjs missing; set DSH_TEST_PNPM_CJS");
}

function dshBin() {
  const override = process.env.DSH_TEST_BIN;
  const candidate = override && override.trim() ? override : DEFAULT_BIN;
  if (!existsSync(candidate)) {
    throw new Error(`DSH CLI missing at ${candidate}; set DSH_TEST_BIN`);
  }
  return resolve(candidate);
}

function cliVersion(bin) {
  const manifest = join(dirname(bin), "..", "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.name !== "@deepseek-ai/dsh" || typeof pkg.version !== "string") {
    throw new Error(`not a DSH CLI manifest: ${manifest}`);
  }
  return pkg.version;
}

function inspectPluginBuild() {
  const missing = [];
  if (!existsSync(join(PLUGIN_DIR, "package.json"))) missing.push("packages/plugin/package.json");
  for (const rel of REQUIRED_LIBS) {
    if (!existsSync(join(PLUGIN_DIR, rel))) missing.push(`packages/plugin/${rel}`);
  }
  if (missing.length) return { ready: false, pending: true, missing };
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
  const reasons = [];
  if (pkg.name !== CANONICAL_NAME) reasons.push(`package.json name ${pkg.name ?? "(missing)"}`);
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const covers = (rel) =>
    files.some(
      (entry) =>
        entry === "lib" ||
        entry === rel ||
        (typeof entry === "string" && rel.startsWith(`${entry.replace(/\\/g, "/").replace(/\/$/, "")}/`)),
    );
  for (const rel of REQUIRED_LIBS) {
    if (!covers(rel)) reasons.push(`files[] missing ${rel}`);
  }
  if (!files.includes("cordis.patch.yml")) reasons.push("files[] missing cordis.patch.yml");
  if (pkg.dsh?.client?.platform !== "web") reasons.push("dsh.client.platform=web");
  if (pkg.dsh?.bundle?.patch !== "./cordis.patch.yml") {
    reasons.push(`dsh.bundle.patch=${pkg.dsh?.bundle?.patch ?? "(missing)"}`);
  }
  if (!pkg.exports?.["./cordis.patch.yml"]) reasons.push("exports['./cordis.patch.yml']");
  const bundlePath = join(PLUGIN_DIR, "cordis.patch.yml");
  if (!existsSync(bundlePath)) reasons.push("packages/plugin/cordis.patch.yml");
  else {
    const bundle = readFileSync(bundlePath, "utf8");
    if (!bundle.includes("id: dsh-spaces") || !bundle.includes(CANONICAL_NAME)) {
      reasons.push("cordis.patch.yml missing dsh-spaces insert");
    }
    if (!bundle.includes("insert:")) {
      reasons.push("cordis.patch.yml must insert the Host row (id-only overlay belongs in the profile)");
    }
  }
  if (reasons.length) return { ready: false, pending: false, missing: reasons, pkg };
  return { ready: true, pending: false, missing: [], pkg };
}

function run(exe, args, options) {
  const timeout = options.timeoutMs ?? DUMP_MS;
  const result = spawnSync(exe, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (options.logPath) {
    writeFileSync(options.logPath, redact(output), { flag: "a" });
  }
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    throw new Error(`${options.label} timed out after ${timeout}ms`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${options.label} failed (${result.status}): ${redact((result.stderr || result.stdout || result.error?.message || "").slice(0, 1200))}`,
    );
  }
  return result.stdout || "";
}

function writePnpmShim(shimDir, nodeExe, pnpmCjs) {
  mkdirSync(shimDir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(shimDir, "pnpm.cmd"), `@echo off\r\n"${nodeExe}" "${pnpmCjs}" %*\r\n`, "utf8");
    writeFileSync(join(shimDir, "pnpm.ps1"), `& "${nodeExe}" "${pnpmCjs}" @args\r\nexit $LASTEXITCODE\r\n`, "utf8");
  } else {
    writeFileSync(join(shimDir, "pnpm"), `#!/bin/sh\nexec "${nodeExe}" "${pnpmCjs}" "$@"\n`, { mode: 0o755 });
  }
}

function isolatedEnv(home, nodeExe, tooling) {
  refuseRealHome(home);
  const pathParts = [tooling.shim, dirname(nodeExe), process.env.PATH].filter(Boolean);
  const path = pathParts.join(process.platform === "win32" ? ";" : ":");
  const env = {
    ...process.env,
    DSH_HOME: home,
    PNPM_HOME: tooling.pnpmHome,
    npm_config_store_dir: tooling.store,
    npm_config_cache: tooling.cache,
    npm_config_registry: REGISTRY,
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
    npm_config_global: "false",
    npm_config_ignore_workspace_root_check: "true",
    CI: "1",
    PATH: path,
  };
  if (process.platform === "win32") env.Path = path;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runDsh(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath) {
  return run(nodeExe, [bin, ...args], {
    env: isolatedEnv(home, nodeExe, tooling),
    timeoutMs,
    label,
    logPath,
  });
}

function runDshRetry(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath) {
  try {
    return runDsh(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath);
  } catch (error) {
    info(`${label} retrying once: ${error instanceof Error ? error.message : String(error)}`);
    return runDsh(nodeExe, bin, home, tooling, args, timeoutMs, `${label} retry`, logPath);
  }
}

async function importCore() {
  if (!existsSync(CORE_LIB)) {
    throw new Error("packages/core/lib/index.js missing; run npm run build:spaces");
  }
  return import(pathToFileURL(CORE_LIB).href);
}

function profileDir(home, name) {
  return join(home, "profiles", name);
}

function profilePkgPath(home, name) {
  return join(profileDir(home, name), "package.json");
}

function readProfilePkg(home, name) {
  const path = profilePkgPath(home, name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function pluginInstallState(home, name) {
  const pkg = readProfilePkg(home, name);
  const deps = pkg?.dependencies ?? {};
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const installDir = join(profileDir(home, name), "node_modules", ...CANONICAL_NAME.split("/"));
  return {
    dependency: Object.prototype.hasOwnProperty.call(deps, CANONICAL_NAME) ? String(deps[CANONICAL_NAME]) : null,
    inBundles: bundles.includes(CANONICAL_NAME),
    bundles,
    installedOnDisk: existsSync(join(installDir, "package.json")),
    installDir,
  };
}

function userPatchHasPluginInsert(patchPath) {
  if (!existsSync(patchPath)) return false;
  const doc = parseDocument(readFileSync(patchPath, "utf8"));
  if (!isSeq(doc.contents)) return false;
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const inserted = item.get("insert", true);
    if (!isSeq(inserted)) continue;
    for (const row of inserted.items) {
      if (isMap(row) && (row.get("id") === PLUGIN_ROW_ID || row.get("name") === CANONICAL_NAME)) return true;
    }
  }
  return false;
}

/** Id-only overlay. Whole `config` replace; do not set `name` (mismatch skips). */
function upsertSnapshotRootOverride(patchPath, snapshotRoot) {
  const original = readFileSync(patchPath, "utf8");
  const doc = parseDocument(original);
  if (!isSeq(doc.contents)) throw new Error(`${patchPath} must be a YAML sequence`);
  let row = null;
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    if (item.get("id") === PLUGIN_ROW_ID && !item.has("insert")) {
      row = item;
      break;
    }
  }
  if (!row) {
    row = new YAMLMap();
    row.set("id", PLUGIN_ROW_ID);
    doc.contents.add(row);
  }
  const cfg = new YAMLMap();
  const root = new Scalar(snapshotRoot);
  root.type = Scalar.QUOTE_DOUBLE;
  cfg.set("snapshotRoot", root);
  row.set("config", cfg);
  if (row.has("name")) row.delete("name");
  if (row.has("insert")) row.delete("insert");
  const body = doc.toString({ lineWidth: 0 });
  writeFileSync(patchPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

function removeSnapshotRootOverride(patchPath) {
  if (!existsSync(patchPath)) return;
  const original = readFileSync(patchPath, "utf8");
  const doc = parseDocument(original);
  if (!isSeq(doc.contents)) return;
  doc.contents.items = doc.contents.items.filter((item) => {
    if (!isMap(item)) return true;
    return !(item.get("id") === PLUGIN_ROW_ID && !item.has("insert"));
  });
  const body = doc.toString({ lineWidth: 0 });
  writeFileSync(patchPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

function writeSnapshotFixture(root, home, spaceId) {
  const dir = join(root, SNAPSHOT_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        id: SNAPSHOT_ID,
        createdAt: SNAPSHOT_AT,
        home,
        profiles: [spaceId],
        runtimeVersion: "0.1.5-rc.1",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function resolveTarball(nodeExe, npmCli) {
  const override = process.env.DSH_TEST_PLUGIN_TGZ?.trim();
  if (override) {
    if (!existsSync(override) || !/dsh-spaces-plugin-.*\.tgz$/i.test(override.replaceAll("\\", "/"))) {
      throw new Error(`DSH_TEST_PLUGIN_TGZ is not a plugin tarball: ${override}`);
    }
    return { path: resolve(override), source: "env" };
  }
  const packDir = join(ARTIFACT, "pack");
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  info("npm pack packages/plugin");
  const packOut = run(nodeExe, [npmCli, "pack", PLUGIN_DIR, "--pack-destination", packDir], {
    cwd: REPO,
    env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_offline: "true" },
    timeoutMs: PACK_MS,
    label: "npm pack",
  });
  const tgzName = packOut
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const packed = tgzName && existsSync(join(packDir, tgzName)) ? join(packDir, tgzName) : "";
  if (!packed) throw new Error("npm pack did not produce a tarball");
  return { path: resolve(packed), source: "npm-pack" };
}

function dumpHasPluginRow(dump) {
  return /^- id:\s*dsh-spaces\b/m.test(dump) && dump.includes(CANONICAL_NAME);
}

function assertDumpHasPluginRow(dump, label) {
  if (!dumpHasPluginRow(dump)) {
    throw new Error(`${label}: composed dump-config missing id: dsh-spaces / ${CANONICAL_NAME}`);
  }
}

function assertDumpLacksPlugin(dump, label) {
  if (dumpHasPluginRow(dump) || /^- id:\s*dsh-spaces\b/m.test(dump) || dump.includes(CANONICAL_NAME)) {
    throw new Error(`${label}: leftover plugin activation in dump-config`);
  }
}

function configFingerprint(home) {
  const hash = createHash("sha256");
  const skip = (rel) =>
    /\.log$/i.test(rel) ||
    /(^|\/)sessions(\/|$)/.test(rel) ||
    /(^|\/)storages(\/|$)/.test(rel) ||
    /(^|\/)node_modules(\/|$)/.test(rel);
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip(rel.replaceAll("\\", "/"))) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      hash.update(`file:${rel}:${sha256File(full)}\n`);
    }
  };
  walk(home, "");
  return hash.digest("hex");
}

function ephemeralPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
}

function portClosed(port) {
  return new Promise((resolveClosed) => {
    const socket = createConnection({ host: HOST, port, timeout: 1000 });
    const finish = (closed) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveClosed(closed);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED"));
    socket.once("timeout", () => finish(false));
  });
}

async function waitPortClosed(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portClosed(port)) return;
    await delay(200);
  }
  throw new Error(`port ${port} still open after ${timeoutMs}ms`);
}

function stopOwned(child) {
  return new Promise((resolveStop) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      resolveStop();
      return;
    }
    const pid = child.pid;
    const timer = setTimeout(() => resolveStop(), STOP_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        try {
          child.kill();
        } catch {
          /* gone */
        }
      });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  });
}

function captureLaunchUrl(child, port, timeoutMs) {
  return new Promise((resolveUrl, reject) => {
    let tail = "";
    let resolved = false;
    const finish = (error, url) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      error ? reject(error) : resolveUrl(url);
    };
    const onData = (chunk) => {
      tail = `${tail}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`.slice(-LAUNCH_RING);
      const match = tail.match(/dsh web:\s*(https?:\/\/[^\s\x1b]+)/);
      if (!match) return;
      try {
        const url = new URL(match[1]);
        if (url.protocol !== "http:" || url.hostname !== HOST || Number(url.port) !== port || url.pathname !== "/") {
          finish(new Error("DSH announced an unexpected endpoint"));
          return;
        }
        finish(undefined, url);
      } catch (error) {
        finish(error);
      }
    };
    const onExit = (code) => finish(new Error(`DSH exited before announcing its endpoint (${code})`));
    const onError = (error) => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(`DSH did not announce 127.0.0.1:${port} within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function sessionCookie(launchUrl) {
  if (!launchUrl.searchParams.has("token")) return undefined;
  const response = await fetch(launchUrl.href, { redirect: "manual", signal: AbortSignal.timeout(RPC_MS) });
  const cookies = response.headers.getSetCookie();
  await response.body?.cancel();
  const cookie = cookies.map((value) => value.split(";", 1)[0]).find((value) => /^dsh-auth-[^=]+=.+$/.test(value));
  if (response.status !== 303 || response.headers.get("location") !== "/" || !cookie) {
    throw new Error("DSH browser authentication failed");
  }
  return cookie;
}

async function rpc(port, cookie, method, args, timeoutMs = RPC_MS) {
  const origin = `http://${HOST}:${port}`;
  const response = await fetch(`${origin}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      connection: "close",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text: redact(text.slice(0, 200)) };
}

function assertRpcOk(call, label) {
  if (call.status !== 200) throw new Error(`${label} HTTP ${call.status}: ${call.text}`);
  if (!call.body?.result?.ok) {
    throw new Error(`${label} RPC rejected: ${redact(JSON.stringify(call.body?.result?.error ?? call.body).slice(0, 300))}`);
  }
  return call.body.result.value;
}

function rpcAvailable(call) {
  return call.status === 200 && call.body?.result?.ok === true;
}

function dtoLeaks(value, home) {
  const hits = [];
  const forbiddenKeys = /token|cookie|set-cookie|authorization|passwd|secret/i;
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === "string") {
      const lower = node.toLowerCase();
      if (node.includes("token=")) hits.push(`${path}: token query`);
      if (home && node.toLowerCase().includes(home.toLowerCase())) hits.push(`${path}: DSH_HOME`);
      if (lower.includes(REAL_HOME.toLowerCase())) hits.push(`${path}: real home`);
      if (/[a-z]:\\/i.test(node) || node.includes("/Users/") || node.includes("\\Users\\")) hits.push(`${path}: filesystem path`);
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (forbiddenKeys.test(key)) hits.push(`${path}.${key}: forbidden key`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(value, "$");
  return hits;
}

async function startProfile(nodeExe, bin, home, tooling, profile, logPath) {
  const port = await ephemeralPort();
  writeFileSync(logPath, "", "utf8");
  const child = spawn(
    nodeExe,
    [bin, "--profile", profile, "--no-open", "--host", HOST, "--port", String(port)],
    { env: isolatedEnv(home, nodeExe, tooling), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  if (!child.pid) throw new Error(`failed to spawn ${profile}`);
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

async function withHost(nodeExe, bin, home, tooling, profile, logPath, fn) {
  const started = await startProfile(nodeExe, bin, home, tooling, profile, logPath);
  try {
    return await fn(started);
  } finally {
    await stopOwned(started.child);
    await waitPortClosed(started.port, PORT_MS);
  }
}

async function pendingExit(reasons) {
  const message = `PENDING packages/plugin is not packable. Run: npm run build:spaces\nMissing: ${reasons.join(", ")}`;
  mkdirSync(ARTIFACT, { recursive: true });
  writeJson(join(ARTIFACT, "pending.json"), {
    status: "pending",
    command: "npm run build:spaces",
    missing: reasons,
    at: new Date().toISOString(),
  });
  console.error(message);
  process.exitCode = 2;
}

function unknownOptedIn() {
  return Boolean(process.env.DSH_TEST_UNKNOWN_BIN?.trim() || process.env.DSH_TEST_DOWNLOAD_UNKNOWN === "1");
}

function resolveUnknownBin() {
  const override = process.env.DSH_TEST_UNKNOWN_BIN?.trim();
  if (!override) return null;
  if (!existsSync(override)) throw new Error(`DSH_TEST_UNKNOWN_BIN missing: ${override}`);
  return { bin: resolve(override), source: "env" };
}

function downloadUnknownCli(nodeExe, npmCli, tooling) {
  const prefix = join(ARTIFACT, "unknown-cli");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  const env = {
    ...process.env,
    npm_config_cache: tooling.cache,
    npm_config_registry: REGISTRY,
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
    npm_config_global: "false",
    CI: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [npmCli, "install", "--prefix", prefix, UNKNOWN_DOWNLOAD_SPEC, "--ignore-scripts"];
  const logPath = join(ARTIFACT, "unknown-cli-download.log");
  try {
    run(nodeExe, args, { env, timeoutMs: DOWNLOAD_MS, label: `npm install ${UNKNOWN_DOWNLOAD_SPEC}`, logPath });
  } catch (error) {
    info(`unknown CLI download retrying once: ${error instanceof Error ? error.message : String(error)}`);
    run(nodeExe, args, { env, timeoutMs: DOWNLOAD_MS, label: `npm install ${UNKNOWN_DOWNLOAD_SPEC} retry`, logPath });
  }
  const bin = join(prefix, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(bin)) throw new Error(`downloaded ${UNKNOWN_DOWNLOAD_SPEC} but ${bin} is missing`);
  return { bin: resolve(bin), source: "download-0.1.5-rc.2", prefix };
}

async function optionalUnknownVersion(nodeExe, compatibleBin, tooling, tarball) {
  if (process.env.DSH_TEST_SKIP_UNKNOWN === "1" || !unknownOptedIn()) {
    skip("unknown-version skipped; set DSH_TEST_UNKNOWN_BIN or DSH_TEST_DOWNLOAD_UNKNOWN=1 for 0.1.5-rc.2");
    return { status: "skip", reason: "not opted in" };
  }
  const resolved =
    process.env.DSH_TEST_DOWNLOAD_UNKNOWN === "1"
      ? downloadUnknownCli(nodeExe, resolveNpmCli(nodeExe), tooling)
      : resolveUnknownBin();
  if (!resolved) throw new Error("unknown-version opted in but no bin resolved");
  const version = cliVersion(resolved.bin);
  if (version === "0.1.5-rc.1") {
    throw new Error(`unknown-version bin is the compatible CLI ${version}`);
  }
  info(`unknown CLI ${version} from ${resolved.source} at ${resolved.bin}`);
  const home = join(ARTIFACT, "unknown-home");
  refuseRealHome(home);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const { applyIsolationPatch } = await importCore();
  runDsh(nodeExe, compatibleBin, home, tooling, ["--profile", "web", "--dump-config"], DUMP_MS, "unknown seed web", join(ARTIFACT, "unknown-seed.log"));
  runDsh(
    nodeExe,
    compatibleBin,
    home,
    tooling,
    ["--profile", HOST_PROFILE, "--from-default-profile", "web", "--dump-config"],
    DUMP_MS,
    "unknown seed coding",
    join(ARTIFACT, "unknown-seed.log"),
  );
  const patchPath = join(home, "profiles", HOST_PROFILE, "cordis.patch.yml");
  writeFileSync(patchPath, applyIsolationPatch(readFileSync(patchPath, "utf8"), HOST_PROFILE, patchPath), "utf8");
  runDsh(nodeExe, compatibleBin, home, tooling,
    ["--profile", PEER_PROFILE, "--from-default-profile", "web", "--dump-config"],
    DUMP_MS, "unknown seed notes", join(ARTIFACT, "unknown-seed.log"));
  const peerPatchPath = join(home, "profiles", PEER_PROFILE, "cordis.patch.yml");
  writeFileSync(peerPatchPath, applyIsolationPatch(readFileSync(peerPatchPath, "utf8"), PEER_PROFILE, peerPatchPath), "utf8");
  runDshRetry(
    nodeExe,
    compatibleBin,
    home,
    tooling,
    ["plugin", "--profile", HOST_PROFILE, "add", tarball, "--config.auto-install-peers=true"],
    PLUGIN_MS,
    "unknown plugin add",
    join(ARTIFACT, "unknown-plugin-add.log"),
  );
  const afterAdd = pluginInstallState(home, HOST_PROFILE);
  if (!afterAdd.inBundles) {
    throw new Error(`unknown-version add did not register the bundle: ${JSON.stringify(afterAdd)}`);
  }
  const logPath = join(ARTIFACT, "unknown-dsh.log");
  const result = await withHost(nodeExe, resolved.bin, home, tooling, HOST_PROFILE, logPath, async ({ port, launchUrl }) => {
    const cookie = await sessionCookie(launchUrl);
    const overviewCall = await rpc(port, cookie, "spaces/overview", {});
    if (!rpcAvailable(overviewCall)) {
      throw new Error(
        `unknown CLI ${version} did not expose spaces/overview (HTTP ${overviewCall.status} ${overviewCall.text}); unknown-readonly was not proved`,
      );
    }
    const overview = overviewCall.body.result.value;
    if (overview.capabilities?.mode !== "unknown-readonly") {
      throw new Error(`unknown CLI ${version} mode=${overview.capabilities?.mode}, expected unknown-readonly`);
    }
    if (overview.capabilities?.canCreate === true || overview.capabilities?.canVerify === true) {
      throw new Error(`unknown-readonly still allows mutation: ${JSON.stringify(overview.capabilities)}`);
    }
    const before = configFingerprint(home);
    const created = await rpc(port, cookie, "spaces/create", { input: { name: "must-not-exist", displayName: "No" } }, DUMP_MS);
    if (created.status !== 200 || created.body?.result?.ok !== false || created.body?.result?.error?.code !== "spaces/read-only") {
      throw new Error(`unknown-readonly create did not return the read-only denial: ${created.text}`);
    }
    const verified = await rpc(port, cookie, "spaces/verify", { id: PEER_PROFILE }, DUMP_MS);
    if (verified.status !== 200 || verified.body?.result?.ok !== false || verified.body?.result?.error?.code !== "spaces/read-only") {
      throw new Error(`unknown-readonly verify did not return the read-only denial: ${verified.text}`);
    }
    if (existsSync(join(home, "profiles", "must-not-exist"))) {
      throw new Error("unknown-readonly create left a profile directory");
    }
    const after = configFingerprint(home);
    if (before !== after) {
      throw new Error("unknown-readonly create/verify changed DSH_HOME config (logs/sessions/storages excluded)");
    }
    return {
      status: "readonly",
      version,
      source: resolved.source,
      bin: resolved.bin,
      mode: overview.capabilities.mode,
      dshVersion: overview.capabilities.dshVersion ?? null,
      create: { status: created.status, ok: created.body?.result?.ok ?? false },
      verify: { status: verified.status, ok: verified.body?.result?.ok ?? false },
      fingerprint: before,
    };
  });
  pass(`unknown CLI ${version} is unknown-readonly; create/verify denied; home config unchanged`);
  return result;
}

async function main() {
  mkdirSync(ARTIFACT, { recursive: true });
  const build = inspectPluginBuild();
  if (!build.ready && build.pending) {
    await pendingExit(build.missing);
    return;
  }
  if (!build.ready) {
    throw new Error(`packages/plugin is not a packable dsh.bundle: ${build.missing.join(", ")}`);
  }
  const pkg = build.pkg;
  const nodeExe = resolveNode();
  const bin = dshBin();
  const compatibleVersion = cliVersion(bin);
  info(`compatible CLI ${compatibleVersion} at ${bin}`);
  const npmCli = resolveNpmCli(nodeExe);
  const pnpmCjs = resolvePnpmCjs();
  info(`pnpm ${pnpmCjs}`);

  const session = mkdtempSync(join(tmpdir(), "spaces-distribution-"));
  const sessionRel = relative(tmpdir(), session);
  if (isAbsolute(sessionRel) || sessionRel.startsWith("..")) {
    throw new Error("session root escaped tmpdir");
  }
  const tooling = {
    shim: join(session, "bin"),
    pnpmHome: join(session, "pnpm-home"),
    store: join(session, "pnpm-store"),
    cache: join(session, "npm-cache"),
  };
  mkdirSync(tooling.pnpmHome, { recursive: true });
  mkdirSync(tooling.store, { recursive: true });
  mkdirSync(tooling.cache, { recursive: true });
  writePnpmShim(tooling.shim, nodeExe, pnpmCjs);

  const home = join(ARTIFACT, "home");
  refuseRealHome(home);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  const { applyIsolationPatch, assertDumpPatched } = await importCore();
  info("seed web --dump-config");
  runDsh(nodeExe, bin, home, tooling, ["--profile", "web", "--dump-config"], DUMP_MS, "web dump-config");
  pass("seeded web from official dump-config");

  for (const name of [HOST_PROFILE, PEER_PROFILE]) {
    runDsh(
      nodeExe,
      bin,
      home,
      tooling,
      ["--profile", name, "--from-default-profile", "web", "--dump-config"],
      DUMP_MS,
      `${name} from-default-profile`,
    );
    const isolatedPatch = join(home, "profiles", name, "cordis.patch.yml");
    writeFileSync(isolatedPatch, applyIsolationPatch(readFileSync(isolatedPatch, "utf8"), name, isolatedPatch), "utf8");
    const dump = runDsh(nodeExe, bin, home, tooling, ["--profile", name, "--dump-config"], DUMP_MS, `${name} dump-config verify`);
    assertDumpPatched(dump, name);
    pass(`${name} isolated via applyIsolationPatch`);
  }

  const tarballOrigin = resolveTarball(nodeExe, npmCli);
  const originalTarball = tarballOrigin.path;
  if (!isAbsolute(originalTarball)) throw new Error(`plugin tarball must be absolute, got ${originalTarball}`);
  // DSH 0.1.5-rc.1 forwards pnpm arguments through a shell without quoting.
  // Stage identical bytes at a shell-safe path; still install through dsh plugin.
  const stage = mkdtempSync(join(tmpdir(), "spaces-dist-tgz-"));
  if (/[\s"'&|<>^()%!]/.test(stage)) throw new Error("DSH plugin CLI needs a shell-safe temp path; set TMP/TEMP to a path without spaces or shell metacharacters.");
  const tarball = join(stage, "dsh-spaces-plugin-0.2.0.tgz");
  copyFileSync(originalTarball, tarball);
  const tarballHash = sha256File(tarball);
  if (tarballHash !== sha256File(originalTarball)) throw new Error("Staged tarball differs from the packed artifact");
  writeJson(join(ARTIFACT, "tarball.json"), {
    source: tarballOrigin.source,
    origin: originalTarball,
    used: tarball,
    sha256: tarballHash,
  });
  info(`tarball ${tarballOrigin.source} ${tarball} sha256=${tarballHash}`);

  const addLog = join(ARTIFACT, "plugin-add.log");
  writeFileSync(addLog, "", "utf8");
  info(`dsh plugin --profile ${HOST_PROFILE} add ${tarball}`);
  runDshRetry(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", HOST_PROFILE, "add", tarball, "--config.auto-install-peers=true"],
    PLUGIN_MS,
    "dsh plugin add",
    addLog,
  );
  const afterAdd = pluginInstallState(home, HOST_PROFILE);
  const patchPath = join(home, "profiles", HOST_PROFILE, "cordis.patch.yml");
  writeFileSync(join(ARTIFACT, "coding.cordis.patch.after-add.yml"), readFileSync(patchPath, "utf8"), "utf8");
  if (userPatchHasPluginInsert(patchPath)) {
    throw new Error("coding cordis.patch.yml gained a manual plugin insert; auto-activation was not proved");
  }
  if (!afterAdd.dependency || !afterAdd.installedOnDisk) {
    throw new Error(`dsh plugin add did not install ${CANONICAL_NAME}: ${JSON.stringify(afterAdd)}`);
  }
  if (!afterAdd.inBundles) {
    throw new Error(`dsh plugin add did not register ${CANONICAL_NAME} in dsh.profile.bundles`);
  }
  const dumpAfterAdd = runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["--profile", HOST_PROFILE, "--dump-config"],
    DUMP_MS,
    "dump-config after add",
  );
  writeFileSync(join(ARTIFACT, "dump-after-add.txt"), dumpAfterAdd, "utf8");
  assertDumpHasPluginRow(dumpAfterAdd, "after dsh plugin add, before user overlay");
  pass(`dsh plugin add auto-activated ${CANONICAL_NAME} (bundles + dump id ${PLUGIN_ROW_ID})`);

  const snapshotRoot = join(ARTIFACT, "snapshots");
  rmSync(snapshotRoot, { recursive: true, force: true });
  mkdirSync(snapshotRoot, { recursive: true });
  writeSnapshotFixture(snapshotRoot, home, PEER_PROFILE);
  upsertSnapshotRootOverride(patchPath, snapshotRoot);
  writeFileSync(join(ARTIFACT, "coding.cordis.patch.yml"), readFileSync(patchPath, "utf8"), "utf8");
  if (userPatchHasPluginInsert(patchPath)) {
    throw new Error("snapshotRoot overlay must be id-only, not a second insert");
  }
  const dumpAfterOverlay = runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["--profile", HOST_PROFILE, "--dump-config"],
    DUMP_MS,
    "dump-config after snapshotRoot overlay",
  );
  writeFileSync(join(ARTIFACT, "dump-after-overlay.txt"), dumpAfterOverlay, "utf8");
  assertDumpHasPluginRow(dumpAfterOverlay, "after snapshotRoot id-only overlay");
  if (!dumpAfterOverlay.includes("snapshotRoot")) {
    throw new Error("composed dump-config missing snapshotRoot after id-only overlay");
  }
  pass("id-only snapshotRoot overlay applied; dump still has id dsh-spaces");

  const rpcEvidence = {};
  await withHost(nodeExe, bin, home, tooling, HOST_PROFILE, join(ARTIFACT, "dsh-coding.log"), async ({ port, launchUrl }) => {
    const cookie = await sessionCookie(launchUrl);
    pass(`owned CLI listening on ephemeral :${port} after dsh plugin add`);
    const overview = assertRpcOk(await rpc(port, cookie, "spaces/overview", {}), "spaces/overview");
    const overviewLeaks = dtoLeaks(overview, home);
    if (overviewLeaks.length) throw new Error(`overview DTO leaked ${overviewLeaks.join("; ")}`);
    const ids = (overview.spaces ?? []).map((row) => row.id);
    if (!ids.includes(HOST_PROFILE) || !ids.includes(PEER_PROFILE) || !ids.includes("web")) {
      throw new Error(`overview missing expected spaces: ${ids.join(",")}`);
    }
    pass(`spaces/overview lists ${ids.join(", ")} mode=${overview.capabilities?.mode}`);

    const notes = assertRpcOk(await rpc(port, cookie, "spaces/detail", { id: PEER_PROFILE }), "spaces/detail notes");
    const notesLeaks = dtoLeaks(notes, home);
    if (notesLeaks.length) throw new Error(`notes detail DTO leaked ${notesLeaks.join("; ")}`);
    const hit = (notes.snapshots ?? []).find((row) => row.id === SNAPSHOT_ID);
    if (!hit || hit.createdAt !== SNAPSHOT_AT || hit.runtimeVersion !== "0.1.5-rc.1") {
      throw new Error(`snapshotRoot did not surface the fixture snapshot: ${JSON.stringify(notes.snapshots)}`);
    }
    pass("spaces/detail notes returned snapshot metadata from id-only snapshotRoot");

    const coding = assertRpcOk(await rpc(port, cookie, "spaces/detail", { id: HOST_PROFILE }), "spaces/detail coding");
    if ((coding.snapshots ?? []).some((row) => row.id === SNAPSHOT_ID)) {
      throw new Error("host coding unexpectedly listed a notes-only snapshot");
    }
    const pluginRow = (coding.plugins ?? []).find((row) => row.name === CANONICAL_NAME);
    if (!pluginRow) {
      throw new Error("spaces/detail plugins list does not include @dsh-spaces/plugin after CLI install");
    }
    pass(`spaces/detail coding lists ${CANONICAL_NAME} version=${pluginRow.version}`);

    const inventory = await rpc(port, cookie, "pluginInventory/list", {});
    if (!rpcAvailable(inventory)) {
      throw new Error("pluginInventory/list unavailable after bundle install");
    }
    const entries = inventory.body.result.value?.entries ?? [];
    const loaded = entries.find((row) => row.moduleName === CANONICAL_NAME || String(row.entryId ?? "").endsWith(PLUGIN_ROW_ID));
    if (!loaded) {
      throw new Error("pluginInventory/list does not include @dsh-spaces/plugin");
    }
    pass(`pluginInventory/list entryId=${loaded.entryId} phase=${loaded.fiberPhase} enabled=${loaded.enabled}`);
    rpcEvidence.pluginInventory = { entryId: loaded.entryId ?? null, fiberPhase: loaded.fiberPhase ?? null };
    rpcEvidence.mode = overview.capabilities?.mode ?? null;
    rpcEvidence.snapshot = hit;
  });

  info(`dsh plugin --profile ${HOST_PROFILE} add --force (replace/reinstall, same 0.2.0)`);
  const replaceLog = join(ARTIFACT, "plugin-replace.log");
  writeFileSync(replaceLog, "", "utf8");
  runDshRetry(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", HOST_PROFILE, "add", tarball, "--force", "--config.auto-install-peers=true"],
    PLUGIN_MS,
    "dsh plugin add --force replace",
    replaceLog,
  );
  const afterReplace = pluginInstallState(home, HOST_PROFILE);
  if (!afterReplace.dependency || !afterReplace.installedOnDisk || !afterReplace.inBundles) {
    throw new Error(`replace/reinstall lost bundle registration: ${JSON.stringify(afterReplace)}`);
  }
  pass(`replace/reinstall kept ${CANONICAL_NAME} in bundles (package version unchanged 0.2.0)`);

  await withHost(nodeExe, bin, home, tooling, HOST_PROFILE, join(ARTIFACT, "dsh-coding-replace.log"), async ({ port, launchUrl }) => {
    const cookie = await sessionCookie(launchUrl);
    const overview = assertRpcOk(await rpc(port, cookie, "spaces/overview", {}), "spaces/overview after replace");
    if (overview.capabilities?.mode !== "verified-full" && overview.capabilities?.mode !== "verified-limited") {
      throw new Error(`after replace unexpected mode ${overview.capabilities?.mode}`);
    }
    const notes = assertRpcOk(await rpc(port, cookie, "spaces/detail", { id: PEER_PROFILE }), "spaces/detail notes after replace");
    if (!(notes.snapshots ?? []).some((row) => row.id === SNAPSHOT_ID)) {
      throw new Error("snapshotRoot unread after replace/reinstall");
    }
    pass("Host RPC still served after dsh plugin replace/reinstall");
  });

  info(`dsh plugin --profile ${HOST_PROFILE} remove ${CANONICAL_NAME}`);
  const removeLog = join(ARTIFACT, "plugin-remove.log");
  writeFileSync(removeLog, "", "utf8");
  runDshRetry(
    nodeExe,
    bin,
    home,
    tooling,
    ["plugin", "--profile", HOST_PROFILE, "remove", CANONICAL_NAME],
    PLUGIN_MS,
    "dsh plugin remove",
    removeLog,
  );
  const afterRemove = pluginInstallState(home, HOST_PROFILE);
  writeJson(join(ARTIFACT, "package-set-after-remove.json"), afterRemove);
  if (afterRemove.dependency || afterRemove.inBundles || afterRemove.installedOnDisk) {
    throw new Error(`dsh plugin remove left package or bundle: ${JSON.stringify(afterRemove)}`);
  }
  // Keep the optional id-only overlay while proving uninstall is sufficient.
  writeFileSync(join(ARTIFACT, "coding.cordis.patch.after-remove.yml"), readFileSync(patchPath, "utf8"), "utf8");
  if (userPatchHasPluginInsert(patchPath)) {
    throw new Error("coding patch still contains a plugin insert after remove");
  }
  const dumpAfterRemove = runDsh(
    nodeExe,
    bin,
    home,
    tooling,
    ["--profile", HOST_PROFILE, "--dump-config"],
    DUMP_MS,
    "dump-config after remove",
  );
  writeFileSync(join(ARTIFACT, "dump-after-remove.txt"), dumpAfterRemove, "utf8");
  assertDumpLacksPlugin(dumpAfterRemove, "after dsh plugin remove");
  pass("dsh plugin remove dropped package, bundle, and dump row on coding");

  await withHost(nodeExe, bin, home, tooling, HOST_PROFILE, join(ARTIFACT, "dsh-coding-removed.log"), async ({ port, launchUrl }) => {
    const cookie = await sessionCookie(launchUrl);
    const sessions = await rpc(port, cookie, "session/list", { _request: {} });
    assertRpcOk(sessions, "session/list after remove on coding");
    const spaces = await rpc(port, cookie, "spaces/overview", {});
    if (rpcAvailable(spaces)) {
      throw new Error("spaces/overview still available on coding after plugin remove");
    }
    pass(`coding after remove: session/list ok, spaces RPC unavailable (HTTP ${spaces.status})`);
  });
  removeSnapshotRootOverride(patchPath);

  const unknown = await optionalUnknownVersion(nodeExe, bin, tooling, tarball);
  writeJson(join(ARTIFACT, "unknown-version.json"), unknown);

  writeJson(join(ARTIFACT, "results.json"), {
    status: "pass",
    proved,
    skipped,
    plugin: { name: CANONICAL_NAME, version: pkg.version },
    tarball: { source: tarballOrigin.source, sha256: tarballHash, path: tarball },
    cli: { bin, version: compatibleVersion },
    install: afterAdd,
    replace: afterReplace,
    uninstall: afterRemove,
    rpc: rpcEvidence,
    unknown,
    at: new Date().toISOString(),
  });
  console.log("\nDISTRIBUTION ACCEPTANCE: PASS");
}

export {
  HOST,
  DEFAULT_BIN,
  FALLBACK_NODE,
  TOOLCHAIN_PNPM,
  REGISTRY,
  DUMP_MS,
  PLUGIN_MS,
  BOOT_MS,
  RPC_MS,
  STOP_MS,
  PORT_MS,
  LAUNCH_RING,
  redact,
  samePath,
  refuseRealHome,
  writeJson,
  sha256File,
  resolveNode,
  resolveNpmCli,
  resolvePnpmCjs,
  dshBin,
  cliVersion,
  run,
  writePnpmShim,
  isolatedEnv,
  runDsh,
  runDshRetry,
  importCore,
  ephemeralPort,
  portClosed,
  waitPortClosed,
  stopOwned,
  captureLaunchUrl,
  sessionCookie,
  rpc,
  assertRpcOk,
  rpcAvailable,
  startProfile,
  withHost,
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAIL  ${redact(error instanceof Error ? error.stack || error.message : String(error))}`);
    writeJson(join(ARTIFACT, "results.json"), {
      status: "fail",
      proved,
      skipped,
      error: redact(error instanceof Error ? error.message : String(error)),
      at: new Date().toISOString(),
    });
    process.exit(1);
  });
}
