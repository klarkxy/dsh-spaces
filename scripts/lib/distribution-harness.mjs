/** Shared DSH harness helpers for the scripts/* acceptance drivers. */

import { createConnection, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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

const DUMP_MS = 180_000;
const PLUGIN_MS = 180_000;
const BOOT_MS = 90_000;
const RPC_MS = 15_000;
const STOP_MS = 15_000;
const PORT_MS = 10_000;
const LAUNCH_RING = 16_384;

function info(m) {
  console.log(`INFO  ${redact(m)}`);
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
  if (response.status !== 303 || !["/", "./"].includes(response.headers.get("location") ?? "") || !cookie) {
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
};
