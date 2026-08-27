#!/usr/bin/env node
/**
 * A3 / A9 process-lifecycle gate.
 * Starts web + coding + writing, asserts all three APIs live,
 * restarts coding, asserts web and writing still answer.
 */

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let homeArg;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--home") homeArg = args[++i];
  else if (args[i].startsWith("--home=")) homeArg = args[i].slice("--home=".length);
}
const HOME = resolve(homeArg || join(__dirname, "../.sandbox/dsh-home"));
const REAL = join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
const HOST = "127.0.0.1";
const PROFILES = [
  { name: "web", port: 3220 },
  { name: "coding", port: 3221 },
  { name: "writing", port: 3222 },
];

function dshBin() {
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

function info(m) {
  console.log(`INFO  ${m}`);
}
function pass(m) {
  console.log(`PASS  ${m}`);
}
function fail(m) {
  console.error(`FAIL  ${m}`);
  process.exitCode = 1;
}

function spawnProfile(name, port) {
  const child = spawn(
    process.execPath,
    [dshBin(), "--profile", name, "--no-open", "--host", HOST, "--port", String(port)],
    { env: { ...process.env, DSH_HOME: HOME }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  return child;
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

async function rpc(port, method, payload = {}) {
  const origin = `http://${HOST}:${port}`;
  const res = await fetch(`${origin}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  if (!body?.result?.ok) throw new Error(`${method} RPC: ${text.slice(0, 200)}`);
  return body.result.value;
}

async function waitForApi(port, timeoutMs = 60_000) {
  const start = Date.now();
  let last = "no attempt";
  while (Date.now() - start < timeoutMs) {
    if (!(await portClosed(port))) {
      try {
        await rpc(port, "session.list");
        return;
      } catch (err) {
        last = err.message;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`api :${port} not ready (${last})`);
}

async function stop(child) {
  if (!child?.pid) return;
  await new Promise((resolveKill) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("exit", () => resolveKill());
    killer.on("error", () => resolveKill());
  });
}

async function main() {
  if (HOME.toLowerCase() === REAL.toLowerCase()) {
    throw new Error("refusing real DSH home");
  }
  const children = new Map();
  try {
    for (const p of PROFILES) {
      children.set(p.name, spawnProfile(p.name, p.port));
      info(`started ${p.name} :${p.port} pid=${children.get(p.name).pid}`);
    }
    for (const p of PROFILES) await waitForApi(p.port);
    const lists = {};
    for (const p of PROFILES) {
      lists[p.name] = await rpc(p.port, "session.list");
      info(`${p.name} session.list ok (${(lists[p.name].items || []).length} items)`);
    }
    pass("A3 process: web + coding + writing APIs live in parallel");

    const writingBefore = JSON.stringify(lists.writing);
    const webBefore = JSON.stringify(lists.web);
    await stop(children.get("coding"));
    children.set("coding", spawnProfile("coding", 3221));
    await waitForApi(3221);
    const webAfter = JSON.stringify(await rpc(3220, "session.list"));
    const writingAfter = JSON.stringify(await rpc(3222, "session.list"));
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
    await rpc(3221, "session.list");
    pass("A9: coding came back after restart");
  } finally {
    for (const child of children.values()) await stop(child);
  }
  if (process.exitCode) {
    console.error("\nLIFECYCLE GATE: FAIL");
    process.exit(1);
  }
  console.log("\nLIFECYCLE GATE: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
