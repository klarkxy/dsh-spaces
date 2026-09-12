#!/usr/bin/env node
/**
 * Bounded runtime acceptance for the packed DSH Spaces plugin.
 *
 * Proves, when packages/plugin is packable:
 *   disposable DSH_HOME seed, packed @dsh-spaces/plugin install, sidebar Spaces,
 *   list/detail, Phase 1 create + verify + read-back, notes verify,
 *   host self-denial, invalid RPC denial, DTO hygiene, New Session present,
 *   no pageerrors.
 *
 * Does not prove: unknown-version read-only unless this host already reports
 * it; model calls; production ~/.dsh; Phase 2 plugin/snapshot/runtime mutation.
 *
 * Pending (exit 2) when lib/{index,client,typert.host,typert.remote-client}.js
 * or a packable manifest is absent. Run: npm run build:spaces
 */

import { createConnection, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from "yaml";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(REPO, ".sandbox", "spaces-plugin-acceptance");
const PLUGIN_DIR = join(REPO, "packages", "plugin");
const CORE_LIB = join(REPO, "packages", "core", "lib", "index.js");
const REAL_HOME = join(homedir(), ".dsh");
const HOST = "127.0.0.1";
const DEFAULT_BIN =
  "C:/Users/admin/AppData/Local/Temp/spaces-runtime-install-fIEaas/versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js";
const FALLBACK_NODE =
  "C:/Users/admin/AppData/Local/Temp/spaces-node-upgrade-cSfOOr/node/node-v22.23.2-win-x64/node.exe";
const DEFAULT_PLAYWRIGHT =
  "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";

const DUMP_MS = 180_000;
const CREATE_MS = 360_000;
const PACK_MS = 60_000;
const BOOT_MS = 90_000;
const RPC_MS = 15_000;
const UI_MS = 45_000;
const STOP_MS = 15_000;
const PORT_MS = 10_000;
const NAV_MS = 30_000;
const LAUNCH_RING = 16_384;

const HOST_PROFILE = "coding";
const PEER_PROFILE = "notes";
const CREATE_PROFILE = "probe";
const CANONICAL_NAME = "@dsh-spaces/plugin";
const PLUGIN_ROW_ID = "dsh-spaces";
const REQUIRED_LIBS = [
  "lib/index.js",
  "lib/client.js",
  "lib/typert.host.js",
  "lib/typert.remote-client.js",
];

const proved = [];
const skipped = [];
let failed = null;

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

function dshBin() {
  const override = process.env.DSH_TEST_BIN;
  const candidate = override && override.trim() ? override : DEFAULT_BIN;
  if (!existsSync(candidate)) {
    throw new Error(`DSH CLI missing at ${candidate}; set DSH_TEST_BIN`);
  }
  return resolve(candidate);
}

function sdkRootFromBin(bin) {
  return resolve(bin, "..", "..", "..", "..");
}

function inspectPluginBuild() {
  const missing = [];
  if (!existsSync(join(PLUGIN_DIR, "package.json"))) missing.push("packages/plugin/package.json");
  for (const rel of REQUIRED_LIBS) {
    if (!existsSync(join(PLUGIN_DIR, rel))) missing.push(`packages/plugin/${rel}`);
  }
  if (missing.length) {
    return { ready: false, pending: true, missing, reasons: missing };
  }
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
  const reasons = [];
  if (pkg.name !== CANONICAL_NAME) reasons.push(`package.json name ${pkg.name ?? "(missing)"}`);
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const covers = (rel) =>
    files.some((entry) => entry === "lib" || entry === rel || (typeof entry === "string" && rel.startsWith(`${entry.replace(/\\/g, "/").replace(/\/$/, "")}/`)));
  for (const rel of REQUIRED_LIBS) {
    if (!covers(rel)) reasons.push(`files[] missing ${rel}`);
  }
  const clientExport = pkg.exports?.["./client"];
  if (!clientExport) reasons.push("exports['./client']");
  if (pkg.dsh?.client?.platform !== "web") reasons.push("dsh.client.platform=web");
  const clientJs = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8");
  if (!clientJs.includes("__ModuleLoader__.load")) reasons.push("client.js __ModuleLoader__.load");
  if (reasons.length) {
    return { ready: false, pending: true, missing: reasons, pkg };
  }
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
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    throw new Error(`${options.label} timed out after ${timeout}ms`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${options.label} failed (${result.status}): ${redact((result.stderr || result.stdout || result.error?.message || "").slice(0, 800))}`,
    );
  }
  return result.stdout || "";
}

function dshEnv(home) {
  const env = { ...process.env, DSH_HOME: home, npm_config_ignore_workspace_root_check: "true" };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runDsh(nodeExe, bin, home, args, timeoutMs, label) {
  return run(nodeExe, [bin, ...args], { env: dshEnv(home), timeoutMs, label });
}

async function importCore() {
  if (!existsSync(CORE_LIB)) {
    throw new Error("packages/core/lib/index.js missing; run npm run build:spaces");
  }
  return import(pathToFileURL(CORE_LIB).href);
}

function ensurePatchFile(path) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[]\n", "utf8");
  }
}

function appendPluginRow(patchPath, packageName) {
  const original = readFileSync(patchPath, "utf8");
  const doc = parseDocument(original);
  if (!isSeq(doc.contents)) throw new Error(`${patchPath} must be a YAML sequence`);
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const inserted = item.get("insert", true);
    if (isSeq(inserted)) {
      for (const row of inserted.items) {
        if (isMap(row) && row.get("id") === PLUGIN_ROW_ID) return;
      }
    }
  }
  const row = new YAMLMap();
  row.set("id", PLUGIN_ROW_ID);
  row.set("name", packageName);
  const inserted = new YAMLSeq();
  inserted.add(row);
  const patch = new YAMLMap();
  patch.set("insert", inserted);
  doc.contents.add(patch);
  const body = doc.toString({ lineWidth: 0 });
  writeFileSync(patchPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

function packageInstallDir(home, profile, packageName) {
  return join(home, "profiles", profile, "node_modules", ...packageName.split("/"));
}

function profilePkgPath(home, name) {
  return join(home, "profiles", name, "package.json");
}

function addFileDependency(home, profile, packageName) {
  const path = profilePkgPath(home, profile);
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [packageName]: `file:./node_modules/${packageName}` };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

function extractPackedTarball(tarball, destDir) {
  const stage = join(ARTIFACT, "extract-stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const tar = spawnSync("tar", ["-xf", tarball, "-C", stage], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (tar.status !== 0) {
    throw new Error(`tar extract failed: ${(tar.stderr || tar.stdout || "").slice(0, 400)}`);
  }
  const packed = join(stage, "package");
  if (!existsSync(packed)) throw new Error("packed tarball did not contain package/");
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(packed, destDir, { recursive: true });
  rmSync(stage, { recursive: true, force: true });
}

function linkSdkDeps(pluginInstall, sdkRoot, provenance) {
  const pkg = JSON.parse(readFileSync(join(pluginInstall, "package.json"), "utf8"));
  const specs = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  const nm = join(pluginInstall, "node_modules");
  mkdirSync(nm, { recursive: true });
  for (const name of Object.keys(specs).sort()) {
    const source = join(sdkRoot, ...name.split("/"));
    const dest = join(nm, ...name.split("/"));
    if (!existsSync(source)) {
      provenance.unresolved.push({ name, spec: specs[name], source });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) continue;
    let version = null;
    try {
      version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version ?? null;
    } catch {
      version = null;
    }
    try {
      symlinkSync(source, dest, process.platform === "win32" ? "junction" : "dir");
      provenance.linked.push({ name, spec: specs[name], source, dest, version, method: "junction" });
    } catch {
      cpSync(source, dest, { recursive: true });
      provenance.copied.push({ name, spec: specs[name], source, dest, version, method: "copy" });
    }
  }
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
    socket.once("error", () => finish(true));
    socket.once("timeout", () => finish(true));
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
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method} HTTP ${response.status}: ${redact(text.slice(0, 200))}`);
  }
  return { status: response.status, body };
}

function assertRpcOk(call, label) {
  if (call.status !== 200) throw new Error(`${label} HTTP ${call.status}`);
  if (!call.body?.result?.ok) {
    throw new Error(`${label} RPC rejected: ${redact(JSON.stringify(call.body?.result?.error ?? call.body).slice(0, 300))}`);
  }
  return call.body.result.value;
}

function assertRpcRejected(call, label) {
  const error = call.body?.result?.error;
  if (call.body?.result?.ok === true) {
    throw new Error(`${label} unexpectedly succeeded`);
  }
  if (call.status >= 500) throw new Error(`${label} HTTP ${call.status}`);
  return error ?? { message: `HTTP ${call.status}` };
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

async function waitUntil(check, timeoutMs, label) {
  const start = Date.now();
  let last = "not tried";
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms (${redact(last)})`);
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

async function main() {
  mkdirSync(ARTIFACT, { recursive: true });
  const build = inspectPluginBuild();
  if (!build.ready) {
    await pendingExit(build.missing);
    return;
  }
  const pkg = build.pkg;
  const nodeExe = resolveNode();
  const bin = dshBin();
  const sdkRoot = sdkRootFromBin(bin);
  const npmCli = resolveNpmCli(nodeExe);
  const home = join(ARTIFACT, "home");
  refuseRealHome(home);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  const { applyIsolationPatch, assertDumpPatched } = await importCore();
  info("seed web --dump-config");
  runDsh(nodeExe, bin, home, ["--profile", "web", "--dump-config"], DUMP_MS, "web dump-config");
  pass("seeded web from official dump-config");

  for (const name of [HOST_PROFILE, PEER_PROFILE]) {
    info(`clone ${name} --from-default-profile web`);
    runDsh(
      nodeExe,
      bin,
      home,
      ["--profile", name, "--from-default-profile", "web", "--dump-config"],
      DUMP_MS,
      `${name} from-default-profile`,
    );
    const patchPath = join(home, "profiles", name, "cordis.patch.yml");
    ensurePatchFile(patchPath);
    const isolated = applyIsolationPatch(readFileSync(patchPath, "utf8"), name, patchPath);
    writeFileSync(patchPath, isolated, "utf8");
    const dump = runDsh(nodeExe, bin, home, ["--profile", name, "--dump-config"], DUMP_MS, `${name} dump-config verify`);
    assertDumpPatched(dump, name);
    pass(`${name} isolated via applyIsolationPatch and dump-config`);
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
  const tarball = tgzName && existsSync(join(packDir, tgzName)) ? join(packDir, tgzName) : readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  const tarballPath = tgzName && existsSync(join(packDir, tgzName)) ? join(packDir, tgzName) : tarball ? join(packDir, tarball) : "";
  if (!tarballPath || !existsSync(tarballPath)) throw new Error("npm pack did not produce a tarball");
  if (!/dsh-spaces-plugin-.*\.tgz$/i.test(tarballPath.replaceAll("\\", "/"))) {
    throw new Error(`npm pack produced the wrong artifact: ${tarballPath}`);
  }

  const installDir = packageInstallDir(home, HOST_PROFILE, pkg.name);
  extractPackedTarball(tarballPath, installDir);
  const packedPkg = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8"));
  if (packedPkg.name !== CANONICAL_NAME) {
    throw new Error(`packed name ${packedPkg.name} is not ${CANONICAL_NAME}`);
  }
  for (const rel of REQUIRED_LIBS) {
    if (!existsSync(join(installDir, rel))) throw new Error(`packed artifact missing ${rel}`);
  }
  const packedClient = readFileSync(join(installDir, "lib", "client.js"), "utf8");
  if (!packedClient.includes("__ModuleLoader__.load")) {
    throw new Error("packed client.js is not a host module loader bundle");
  }
  const provenance = {
    tarball: tarballPath,
    sha256: sha256File(tarballPath),
    package: packedPkg.name,
    version: packedPkg.version,
    sdkRoot,
    linked: [],
    copied: [],
    unresolved: [],
  };
  linkSdkDeps(installDir, sdkRoot, provenance);
  writeJson(join(ARTIFACT, "sdk-provenance.json"), provenance);
  if (provenance.unresolved.length) {
    info(`SDK unresolved (Node may still hoist from the profile): ${provenance.unresolved.map((row) => row.name).join(", ")}`);
  }
  pass(`packed ${packedPkg.name}@${packedPkg.version} extracted into the coding profile`);

  addFileDependency(home, HOST_PROFILE, packedPkg.name);
  appendPluginRow(join(home, "profiles", HOST_PROFILE, "cordis.patch.yml"), packedPkg.name);
  const composed = runDsh(
    nodeExe,
    bin,
    home,
    ["--profile", HOST_PROFILE, "--dump-config"],
    DUMP_MS,
    "coding dump-config after plugin patch",
  );
  if (!composed.includes(packedPkg.name)) {
    throw new Error("composed dump-config does not mention the packed plugin");
  }
  pass("plugin row present in disposable coding patch and composed dump-config");

  const port = await ephemeralPort();
  const logPath = join(ARTIFACT, "dsh-coding.log");
  writeFileSync(logPath, "", "utf8");
  const child = spawn(
    nodeExe,
    [bin, "--profile", HOST_PROFILE, "--no-open", "--host", HOST, "--port", String(port)],
    { env: dshEnv(home), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  if (!child.pid) throw new Error("failed to spawn owned DSH child");
  child.stdout?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  child.stderr?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));

  let browser;
  let launchUrl;
  try {
    launchUrl = await captureLaunchUrl(child, port, BOOT_MS);
    const cookie = await sessionCookie(launchUrl);
    pass(`owned CLI listening on ephemeral :${port}`);

    const overviewCall = await rpc(port, cookie, "spaces/overview", {});
    const overview = assertRpcOk(overviewCall, "spaces/overview");
    const leaks = dtoLeaks(overview, home);
    if (leaks.length) throw new Error(`overview DTO leaked ${leaks.join("; ")}`);
    const ids = (overview.spaces ?? []).map((row) => row.id);
    if (!ids.includes(HOST_PROFILE) || !ids.includes(PEER_PROFILE) || !ids.includes("web")) {
      throw new Error(`overview missing expected spaces: ${ids.join(",")}`);
    }
    pass(`spaces/overview lists ${ids.join(", ")} mode=${overview.capabilities?.mode}`);

    const hostId = overview.capabilities?.hostSpaceId ?? HOST_PROFILE;
    const detailCall = await rpc(port, cookie, "spaces/detail", { id: PEER_PROFILE });
    const detail = assertRpcOk(detailCall, "spaces/detail notes");
    const detailLeaks = dtoLeaks(detail, home);
    if (detailLeaks.length) throw new Error(`detail DTO leaked ${detailLeaks.join("; ")}`);
    pass("spaces/detail for non-host notes returned a sanitized DTO");

    const verifyPeer = await rpc(port, cookie, "spaces/verify", { id: PEER_PROFILE }, DUMP_MS);
    const verified = assertRpcOk(verifyPeer, "spaces/verify notes");
    if (verified.id !== PEER_PROFILE || verified.valid !== true) {
      throw new Error(`non-host verify did not succeed: ${JSON.stringify(verified)}`);
    }
    pass("non-host notes verify succeeded over real RPC");

    const hostVerify = await rpc(port, cookie, "spaces/verify", { id: hostId });
    assertRpcRejected(hostVerify, "spaces/verify host");
    pass("current host coding verify rejected over real RPC");

    if (overview.capabilities?.canCreate !== true) {
      throw new Error(
        `create skipped is not allowed: capabilities.canCreate=${overview.capabilities?.canCreate} mode=${overview.capabilities?.mode}`,
      );
    }
    const createdCall = await rpc(
      port,
      cookie,
      "spaces/create",
      { input: { name: CREATE_PROFILE, displayName: "Probe" } },
      CREATE_MS,
    );
    const created = assertRpcOk(createdCall, "spaces/create probe");
    if (created.id !== CREATE_PROFILE || created.isHost === true) {
      throw new Error(`create returned unexpected summary: ${JSON.stringify(created)}`);
    }
    const createdLeaks = dtoLeaks(created, home);
    if (createdLeaks.length) throw new Error(`create DTO leaked ${createdLeaks.join("; ")}`);
    pass("Phase 1 spaces/create probe over real RPC");

    const createdDetailCall = await rpc(port, cookie, "spaces/detail", { id: CREATE_PROFILE });
    const createdDetail = assertRpcOk(createdDetailCall, "spaces/detail probe");
    if (createdDetail.space?.id !== CREATE_PROFILE) {
      throw new Error("create read-back detail missing probe");
    }
    const createdDetailLeaks = dtoLeaks(createdDetail, home);
    if (createdDetailLeaks.length) throw new Error(`create detail DTO leaked ${createdDetailLeaks.join("; ")}`);
    const createdVerify = await rpc(port, cookie, "spaces/verify", { id: CREATE_PROFILE }, DUMP_MS);
    const createdVerified = assertRpcOk(createdVerify, "spaces/verify probe");
    if (createdVerified.id !== CREATE_PROFILE || createdVerified.valid !== true) {
      throw new Error(`created space verify did not succeed: ${JSON.stringify(createdVerified)}`);
    }
    pass("created probe detail+verify read-back succeeded");

    const overviewAfter = assertRpcOk(await rpc(port, cookie, "spaces/overview", {}), "spaces/overview after create");
    const idsAfter = (overviewAfter.spaces ?? []).map((row) => row.id);
    if (!idsAfter.includes(CREATE_PROFILE)) {
      throw new Error(`overview after create missing probe: ${idsAfter.join(",")}`);
    }

    for (const bad of ["../etc", "notes/../coding", "C:\\\\Windows", join(home, "profiles", PEER_PROFILE)]) {
      const denied = await rpc(port, cookie, "spaces/detail", { id: bad });
      assertRpcRejected(denied, `spaces/detail ${bad}`);
      const deniedVerify = await rpc(port, cookie, "spaces/verify", { id: bad });
      assertRpcRejected(deniedVerify, `spaces/verify ${bad}`);
    }
    pass("invalid id/path detail and verify rejected over real RPC");

    if (overview.capabilities?.mode === "unknown-readonly") {
      pass("unknown-readonly observed from real host capabilities (not injected)");
    } else {
      skip(`unknown-readonly not exercised; host mode is ${overview.capabilities?.mode} on CLI 0.1.5-rc.1`);
    }

    const playwrightModule = process.env.DSH_TEST_PLAYWRIGHT_MODULE || DEFAULT_PLAYWRIGHT;
    const playwrightHref = pathToFileURL(join(playwrightModule, "index.mjs")).href;
    const { chromium } = await import(playwrightHref);
    const pageErrors = [];
    browser = await chromium.launch({ headless: true, timeout: NAV_MS });
    const page = await browser.newPage({ locale: "zh-CN" });
    page.setDefaultTimeout(UI_MS);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const screenshot = join(ARTIFACT, "spaces-sidebar.png");
    try {
      await page.goto(launchUrl.href, { waitUntil: "domcontentloaded", timeout: NAV_MS });
      await waitUntil(async () => !new URL(page.url()).searchParams.has("token"), NAV_MS, "token redirect");
      const intro = page.getByRole("button", { name: /^(Continue|继续)$/ });
      await page.getByRole("button", { name: /new session|新会话|^Continue$|^继续$/i }).first().waitFor({ timeout: UI_MS });
      if (await intro.isVisible()) await intro.click();
      const deferKey = page.getByRole("button", { name: /稍后配置|set up later|configure later/i });
      await deferKey.waitFor({ timeout: UI_MS });
      await deferKey.click();
      await page.getByText(/^(New Session|新会话)$/i).first().waitFor({ timeout: UI_MS });
      await page.getByRole("button", { name: "空间", exact: true }).click();
      await page.getByRole("heading", { name: "空间", exact: true }).waitFor({ timeout: UI_MS });
      await waitUntil(
        async () => {
          const text = await page.locator(".dsh-spaces").innerText();
          return text.includes(PEER_PROFILE) && text.includes(HOST_PROFILE) && text.includes("Probe");
        },
        UI_MS,
        "Spaces list render",
      );
      await page.getByText(PEER_PROFILE, { exact: true }).first().click();
      await waitUntil(
        async () => /隔离|插件/.test(await page.locator(".dsh-spaces").innerText()),
        UI_MS,
        "Spaces detail render",
      );
      const verifyButton = page.getByRole("button", { name: "验证隔离", exact: true });
      await verifyButton.click();
      await page.getByText("隔离与当前组合配置一致。", { exact: true }).waitFor({ timeout: UI_MS });
      const createForm = page.getByRole("form", { name: "创建空间", exact: true });
      await createForm.getByLabel("名称", { exact: true }).fill("ui-probe");
      await createForm.getByLabel("显示名称（可选）", { exact: true }).fill("UI Probe");
      await createForm.getByRole("button", { name: "创建", exact: true }).click();
      await page.getByRole("heading", { name: "UI Probe", exact: true }).waitFor({ timeout: UI_MS });
      await verifyButton.click();
      await page.getByText("隔离与当前组合配置一致。", { exact: true }).waitFor({ timeout: UI_MS });
      await page.getByRole("button", { name: "English", exact: true }).click();
      await page.getByRole("heading", { name: "Spaces", exact: true }).waitFor({ timeout: UI_MS });
      await page.getByRole("heading", { name: "UI Probe", exact: true }).waitFor({ timeout: UI_MS });
      await page.getByRole("button", { name: "Verify isolation", exact: true }).click();
      await page.getByText("Isolation matches the current composed configuration.", { exact: true }).waitFor({ timeout: UI_MS });
      await page.getByRole("button", { name: "中文", exact: true }).click();
      await page.getByRole("heading", { name: "空间", exact: true }).waitFor({ timeout: UI_MS });
      pass("Playwright: Chinese default create/verify and English switch preserve the selected space");
      await page.getByText(/^(New Session|新会话)$/i).first().waitFor({ timeout: 5_000 });
      if (pageErrors.length) {
        throw new Error(`pageerrors: ${redact(pageErrors.join(" | "))}`);
      }
      pass("Playwright: sidebar Spaces list/detail, New Session remains, no pageerrors");
    } finally {
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
      info(`screenshot ${screenshot}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stopOwned(child);
    try {
      await waitPortClosed(port, PORT_MS);
      pass(`owned port :${port} closed after child stop`);
    } catch (error) {
      failed = failed ?? error;
      console.error(`FAIL  ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  }

  writeJson(join(ARTIFACT, "results.json"), {
    status: failed ? "fail" : "pass",
    proved,
    skipped,
    plugin: { name: packedPkg.name, version: packedPkg.version },
    hostProfile: HOST_PROFILE,
    peerProfile: PEER_PROFILE,
    createdProfile: CREATE_PROFILE,
    at: new Date().toISOString(),
  });
  if (failed) throw failed;
  console.log("\nPLUGIN ACCEPTANCE: PASS");
}

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
