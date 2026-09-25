#!/usr/bin/env node
/**
 * A3 / A9 process-lifecycle gate.
 * Starts web + coding + writing, asserts all three APIs live,
 * restarts coding, asserts web and writing still answer.
 *
 * Official CLI requires a session cookie and typed transport. This script
 * reuses waitForApi/rpc from scripts/validate-isolation.mjs (read-only).
 *
 *   node scripts/verify-lifecycle.mjs
 *   node scripts/verify-lifecycle.mjs --home <sandbox-dsh-home>
 *   node scripts/verify-lifecycle.mjs --syntax
 *
 * Env: DSH_TEST_BIN or DSH_TEST_CLI_BIN override the official lib/bin.js.
 * --syntax is static only: no DSH CLI, no bound ports, no live profiles.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { rpc, waitForApi } from "./validate-isolation.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const __dirname = dirname(THIS_FILE);
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const HOST = "127.0.0.1";
const PROFILES = [
  { name: "web", port: 3220 },
  { name: "coding", port: 3221 },
  { name: "writing", port: 3222 },
];
const REAL = resolve(join(process.env.USERPROFILE || process.env.HOME || "", ".dsh"));

const parsed = parseArgs(process.argv.slice(2));
const HOME = parsed.home;

function parseArgs(argv) {
  const out = { home: resolve(join(__dirname, "../.sandbox/dsh-home")), syntax: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--syntax") out.syntax = true;
    else if (a === "--home") out.home = resolve(argv[++i]);
    else if (a.startsWith("--home=")) out.home = resolve(a.slice("--home=".length));
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function dshBin() {
  const explicit = process.env.DSH_TEST_BIN || process.env.DSH_TEST_CLI_BIN;
  if (explicit) {
    const bin = resolve(explicit);
    if (!existsSync(bin)) throw new Error("Explicit DSH test CLI is missing");
    return bin;
  }
  const win = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    : "";
  if (win && existsSync(win)) return win;
  const probe = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  const root = (probe.stdout || "").trim();
  const candidate = join(root, "@deepseek-ai", "dsh", "lib", "bin.js");
  if (existsSync(candidate)) return candidate;
  throw new Error("dsh CLI not found");
}

function redact(value) {
  return String(value)
    .replace(/[?&]token=[^&\s\x1b"']+/gi, "[redacted-token]")
    .replace(/dsh-auth-[^=]+=[^;\s"']+/gi, "[redacted-cookie]");
}

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}
function pass(m) {
  console.log(`PASS  ${redact(m)}`);
}
function fail(m) {
  console.error(`FAIL  ${redact(m)}`);
  process.exitCode = 1;
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function physicalPath(p) {
  let current = resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      tail.push(current.slice(parent.length).replace(/^[\\/]/, ""));
      current = parent;
    }
  }
}

function insideRoot(candidate, root) {
  const c = resolve(candidate).toLowerCase();
  const r = resolve(root).toLowerCase();
  return c === r || c.startsWith(r + sep);
}

function refuseRealHome(home) {
  if (!home) throw new Error("DSH_HOME is empty");
  const roots = [REAL];
  try {
    roots.push(realpathSync(REAL));
  } catch {
    /* real ~/.dsh may be absent */
  }
  const homes = [resolve(home), physicalPath(home)];
  try {
    const st = lstatSync(home);
    if (st.isSymbolicLink()) homes.push(physicalPath(home));
  } catch {
    /* home may not exist yet */
  }
  for (const candidate of homes) {
    for (const root of roots) {
      if (insideRoot(candidate, root) || samePath(candidate, root)) {
        throw new Error("refusing real ~/.dsh");
      }
    }
  }
}

function spawnProfile(name, port, logDir) {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${name}.log`);
  writeFileSync(logPath, "", { flag: "w" });
  const child = spawn(
    process.execPath,
    [dshBin(), "--profile", name, "--no-open", "--host", HOST, "--port", String(port)],
    { env: { ...process.env, DSH_HOME: HOME }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: false },
  );
  const stream = (chunk) => {
    writeFileSync(logPath, chunk, { flag: "a" });
  };
  child.stdout?.on("data", stream);
  child.stderr?.on("data", stream);
  child.on("error", (err) => {
    writeFileSync(logPath, `\nspawn error: ${err.stack || err}\n`, { flag: "a" });
  });
  if (!child.pid) {
    throw new Error(`failed to spawn ${name}; see ${logPath}`);
  }
  return { child, logPath, pid: child.pid, port, name };
}

function portClosed(port) {
  return new Promise((resolveClosed) => {
    const socket = createConnection({ host: HOST, port }, () => {
      socket.end();
      resolveClosed(false);
    });
    socket.on("error", () => resolveClosed(true));
  });
}

async function waitPortClosed(port, timeoutMs = STOP_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portClosed(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`port ${port} still open after stop`);
}

async function assertTestPortsClosed() {
  for (const p of PROFILES) {
    if (!(await portClosed(p.port))) {
      throw new Error(`port ${p.port} already in use; refusing to count an external service`);
    }
  }
}

async function stop(handle) {
  const pid = handle?.pid ?? handle?.child?.pid;
  if (!pid) return;
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolveKill, rejectKill) => {
      let output = "";
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      for (const stream of [killer.stdout, killer.stderr]) {
        stream.on("data", (chunk) => { output = (output + chunk).slice(-2_000); });
      }
      killer.once("error", rejectKill);
      killer.once("close", (code) => code === 0
        ? resolveKill()
        : rejectKill(new Error(`taskkill ${pid} failed (${code}): ${output.trim()}`)));
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

function runSyntax() {
  const syntax = spawnSync(process.execPath, ["--check", THIS_FILE], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (syntax.status !== 0) {
    throw new Error(`node --check failed: ${syntax.stderr || syntax.stdout || syntax.status}`);
  }
  pass("node --check passed");

  if (typeof waitForApi !== "function" || typeof rpc !== "function") {
    throw new Error("validate-isolation.mjs did not export waitForApi/rpc");
  }
  pass("reuses isolation waitForApi(port, logPath, timeout) and rpc(port, method, payload, cookie)");

  let refused = false;
  try {
    refuseRealHome(REAL);
  } catch (error) {
    if (!String(error.message).includes("refusing real")) throw error;
    refused = true;
  }
  if (!refused) throw new Error("refuseRealHome did not reject ~/.dsh");
  refused = false;
  try {
    refuseRealHome(join(REAL, "nested"));
  } catch (error) {
    if (!String(error.message).includes("refusing real")) throw error;
    refused = true;
  }
  if (!refused) throw new Error("refuseRealHome did not reject a path nested in ~/.dsh");

  const probe = mkdtempSync(join(tmpdir(), "dsh-lifecycle-syntax-"));
  try {
    refuseRealHome(probe);
    const junc = join(probe, "junc");
    try {
      symlinkSync(REAL, junc, process.platform === "win32" ? "junction" : "dir");
      refused = false;
      try {
        refuseRealHome(junc);
      } catch (error) {
        if (!String(error.message).includes("refusing real")) throw error;
        refused = true;
      }
      if (!refused) throw new Error("junction into real ~/.dsh was not refused");
      pass("HOME realpath, nested path, and junction into ~/.dsh are refused");
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      if (code === "EPERM" || code === "EACCES" || code === "ENOENT") {
        info(`junction probe skipped (${code || error.message})`);
        pass("HOME realpath and nested path into ~/.dsh are refused");
      } else {
        throw error;
      }
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }

  console.log("\nLIFECYCLE GATE SYNTAX: PASS");
}

async function main() {
  if (parsed.syntax) {
    runSyntax();
    return;
  }

  refuseRealHome(HOME);
  const logDir = join(HOME, "testlogs");
  await assertTestPortsClosed();
  mkdirSync(logDir, { recursive: true });

  const children = new Map();
  const cookies = new Map();
  try {
    for (const p of PROFILES) {
      const handle = spawnProfile(p.name, p.port, logDir);
      children.set(p.name, handle);
      info(`started ${p.name} :${p.port} pid=${handle.pid}`);
    }
    for (const p of PROFILES) {
      const handle = children.get(p.name);
      cookies.set(p.port, await waitForApi(p.port, handle.logPath, READY_TIMEOUT_MS));
    }
    const lists = {};
    for (const p of PROFILES) {
      lists[p.name] = await rpc(p.port, "session.list", {}, cookies.get(p.port));
      info(`${p.name} session.list ok (${(lists[p.name].items || []).length} items)`);
    }
    pass("A3 process: web + coding + writing APIs live in parallel");

    const writingBefore = JSON.stringify(lists.writing);
    const webBefore = JSON.stringify(lists.web);
    await stop(children.get("coding"));
    cookies.delete(3221);
    await waitPortClosed(3221);
    children.set("coding", spawnProfile("coding", 3221, logDir));
    cookies.set(3221, await waitForApi(3221, children.get("coding").logPath, READY_TIMEOUT_MS));
    const webAfter = JSON.stringify(await rpc(3220, "session.list", {}, cookies.get(3220)));
    const writingAfter = JSON.stringify(await rpc(3222, "session.list", {}, cookies.get(3222)));
    if (webAfter !== webBefore) {
      fail("web session.list changed after coding restart");
    } else {
      pass("A9: web still live and unchanged after coding restart");
    }
    if (writingAfter !== writingBefore) {
      fail("writing session.list changed after coding restart");
    } else {
      pass("A9: writing still live and unchanged after coding restart");
    }
    await rpc(3221, "session.list", {}, cookies.get(3221));
    pass("A9: coding came back after restart");
  } finally {
    const stopErrors = [];
    for (const handle of children.values()) {
      try {
        await stop(handle);
      } catch (error) {
        stopErrors.push(`${handle.pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (stopErrors.length) fail(`Could not stop isolated profiles: ${stopErrors.join("; ")}`);
    for (const p of PROFILES) {
      try {
        await waitPortClosed(p.port);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (process.exitCode) {
    console.error("\nLIFECYCLE GATE: FAIL");
    process.exit(1);
  }
  console.log("\nLIFECYCLE GATE: PASS");
}

main().catch((err) => {
  console.error(redact(err && err.stack ? err.stack : err));
  process.exit(1);
});
