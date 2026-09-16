#!/usr/bin/env node
/**
 * DSH Spaces — phase-0 isolation gate.
 *
 * Boots web (default roots) + coding/writing (hub/<name> roots) in parallel,
 * creates one session in each, then asserts trees and APIs never leak.
 *
 * Usage:
 *   node scripts/validate-isolation.mjs
 *   node scripts/validate-isolation.mjs --home <sandbox-dsh-home>
 *   node scripts/validate-isolation.mjs --clean
 *
 * Never points DSH_HOME at the user's real ~/.dsh.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_HOME = join(REPO_ROOT, ".sandbox", "dsh-home");
const REAL_HOME = join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");

const PROFILES = [
  { name: "web", port: 3120, kind: "root" },
  { name: "coding", port: 3121, kind: "workbench" },
  { name: "writing", port: 3122, kind: "workbench" },
];

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const out = { home: DEFAULT_HOME, clean: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--clean") out.clean = true;
    else if (a === "--home") out.home = resolve(argv[++i]);
    else if (a.startsWith("--home=")) out.home = resolve(a.slice("--home=".length));
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS  ${message}`);
}

function info(message) {
  console.log(`INFO  ${message}`);
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function ensureSandboxHome(home) {
  if (!home) throw new Error("DSH_HOME is empty");
  if (samePath(home, REAL_HOME)) {
    throw new Error(`refusing to use the real DSH home: ${REAL_HOME}`);
  }
  const realResolved = resolve(REAL_HOME);
  const homeResolved = resolve(home);
  if (homeResolved.toLowerCase().startsWith(realResolved.toLowerCase() + sep)) {
    throw new Error(`refusing a DSH_HOME inside the real home: ${home}`);
  }
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function sessionRoot(home, profile) {
  return profile.kind === "root"
    ? join(home, "sessions")
    : join(home, "hub", profile.name, "sessions");
}

function storageRoot(home, profile) {
  return profile.kind === "root"
    ? join(home, "storages")
    : join(home, "hub", profile.name, "storages");
}

function workspaceDir(home, name) {
  return join(dirname(home), "workspaces", name);
}

function cleanData(home) {
  const targets = [
    join(home, "sessions"),
    join(home, "storages"),
    join(home, "hub"),
    join(dirname(home), "workspaces"),
    join(dirname(home), "logs"),
  ];
  for (const target of targets) {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      info(`removed ${target}`);
    }
  }
}

function dshBin() {
  const win = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    : "";
  if (win && existsSync(win)) return win;
  const probe = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: true });
  const root = (probe.stdout || "").trim();
  const candidate = join(root, "@deepseek-ai", "dsh", "lib", "bin.js");
  if (existsSync(candidate)) return candidate;
  throw new Error("dsh CLI not found; install @deepseek-ai/dsh globally");
}

function spawnProfile(home, profile, logDir) {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${profile.name}.log`);
  writeFileSync(logPath, "", { flag: "w" });
  const env = {
    ...process.env,
    DSH_HOME: home,
  };
  const bin = dshBin();
  const args = existsSync(bin)
    ? [
        bin,
        "--profile",
        profile.name,
        "--no-open",
        "--host",
        HOST,
        "--port",
        String(profile.port),
      ]
    : [
        "--profile",
        profile.name,
        "--no-open",
        "--host",
        HOST,
        "--port",
        String(profile.port),
      ];
  const command = existsSync(bin) ? process.execPath : bin;
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  });
  const stream = (chunk) => {
    writeFileSync(logPath, chunk, { flag: "a" });
  };
  child.stdout?.on("data", stream);
  child.stderr?.on("data", stream);
  child.on("error", (err) => {
    writeFileSync(logPath, `\nspawn error: ${err.stack || err}\n`, { flag: "a" });
  });
  if (!child.pid) {
    throw new Error(`failed to spawn ${profile.name}; see ${logPath}`);
  }
  return { child, logPath, pid: child.pid };
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

async function waitForPort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const closed = await portClosed(port);
    if (!closed) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${port} not ready within ${timeoutMs}ms`);
}

export function announcedUrl(logPath, port) {
  const text = readFileSync(logPath, "utf8").slice(-16_384);
  const announced = text.match(/dsh web:\s*(https?:\/\/[^\s\x1b]+)(?=[\s\x1b])/)?.[1];
  if (!announced) return undefined;
  const endpoint = new URL(announced);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== HOST ||
    Number(endpoint.port) !== port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/"
  ) {
    throw new Error(`profile announced an unexpected endpoint instead of localhost port ${port}`);
  }
  return endpoint.href;
}

export async function sessionCookie(url) {
  const endpoint = new URL(url);
  if (!endpoint.searchParams.has("token")) return undefined;
  const response = await fetch(endpoint, { redirect: "manual" });
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  await response.body?.cancel();
  const cookie = setCookies
    .map((value) => value.split(";", 1)[0])
    .find((value) => /^dsh-auth-[^=]+=.+$/.test(value));
  if (response.status !== 303 || response.headers.get("location") !== "/" || !cookie) {
    throw new Error("DSH browser authentication failed");
  }
  return cookie;
}

export async function waitForApi(port, logPath, timeoutMs) {
  await waitForPort(port, timeoutMs);
  const start = Date.now();
  let url;
  while (Date.now() - start < timeoutMs) {
    url = announcedUrl(logPath, port);
    if (url) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!url) throw new Error(`profile on port ${port} did not announce its API endpoint`);
  const cookie = await sessionCookie(url);
  let last = "no attempt";
  while (Date.now() - start < timeoutMs) {
    try {
      await rpc(port, "session.list", {}, cookie);
      return cookie;
    } catch (err) {
      last = err.message;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`api on port ${port} not ready within ${timeoutMs}ms (${last})`);
}

export async function rpc(port, method, payload = {}, cookie) {
  const origin = `http://${HOST}:${port}`;
  const rpcId = randomUUID();
  const res = await fetch(`${origin}/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method,
      payload,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text);
  if (!body?.result?.ok) {
    throw new Error(`${method} RPC error: ${text.slice(0, 800)}`);
  }
  return body.result.value;
}

async function stopProcess(handle) {
  if (!handle?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolveKill) => {
      const killer = spawn("taskkill", ["/PID", String(handle.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolveKill());
      killer.on("error", () => resolveKill());
    });
    return;
  }
  try {
    process.kill(-handle.pid, "SIGTERM");
  } catch {
    try {
      process.kill(handle.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const start = Date.now();
  while (Date.now() - start < STOP_TIMEOUT_MS) {
    try {
      process.kill(handle.pid, 0);
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return;
    }
  }
  try {
    process.kill(handle.pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function collectJsonlParseErrors(files) {
  const errors = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl") && !file.endsWith(".jsonl.zstd")) continue;
    try {
      let buf = readFileSync(file);
      if (file.endsWith(".zstd")) buf = zstdDecompressSync(buf);
      const text = buf.toString("utf8");
      for (const [i, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        JSON.parse(line);
        void i;
      }
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
    }
  }
  return errors;
}

function workspaceSessionIds(storageDir) {
  const path = join(storageDir, "workspace.json");
  if (!existsSync(path)) return [];
  const data = readJson(path);
  const ids = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node.sessionId === "string") ids.add(node.sessionId);
    for (const value of Object.values(node)) visit(value);
  };
  visit(data);
  return [...ids];
}

function requireProfiles(home) {
  for (const profile of PROFILES) {
    const dir = join(home, "profiles", profile.name);
    if (!existsSync(dir)) {
      throw new Error(`missing profile ${profile.name} at ${dir}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureSandboxHome(args.home);
  if (!existsSync(args.home)) {
    throw new Error(`sandbox DSH_HOME does not exist: ${args.home}`);
  }
  requireProfiles(args.home);

  if (args.clean) cleanData(args.home);

  const logDir = join(dirname(args.home), "logs");
  mkdirSync(logDir, { recursive: true });

  const handles = [];
  const cookies = new Map();
  const created = [];
  let failed = false;

  const shutdown = async () => {
    for (const handle of handles.reverse()) {
      await stopProcess(handle);
    }
  };

  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(1));
  });

  try {
    info(`DSH_HOME=${args.home}`);
    for (const profile of PROFILES) {
      mkdirSync(workspaceDir(args.home, profile.name), { recursive: true });
      const handle = spawnProfile(args.home, profile, logDir);
      handles.push(handle);
      info(`started ${profile.name} pid=${handle.pid} port=${profile.port}`);
    }

    for (let i = 0; i < PROFILES.length; i += 1) {
      const profile = PROFILES[i];
      const cookie = await waitForApi(profile.port, handles[i].logPath, READY_TIMEOUT_MS);
      cookies.set(profile.name, cookie);
      info(`${profile.name} API ready`);
    }

    for (const profile of PROFILES) {
      const cwd = workspaceDir(args.home, profile.name);
      const value = await rpc(profile.port, "session.create", { cwd }, cookies.get(profile.name));
      created.push({ ...profile, sessionId: value.sessionId, cwd });
      info(`${profile.name} created ${value.sessionId}`);
    }

    // Persistence flushes jsonl immediately; session_projcache.json uses writeIntervalMs=5000.
    await new Promise((r) => setTimeout(r, 5500));

    const lists = {};
    for (const profile of PROFILES) {
      const value = await rpc(profile.port, "session.list", {}, cookies.get(profile.name));
      lists[profile.name] = value.items ?? [];
    }

    const filesByProfile = {};
    for (const profile of PROFILES) {
      filesByProfile[profile.name] = {
        sessions: listFiles(sessionRoot(args.home, profile)),
        storages: listFiles(storageRoot(args.home, profile)),
      };
    }

    // A1/A5 files: web sessions only under default tree.
    const webSessionFiles = filesByProfile.web.sessions;
    const hubFiles = listFiles(join(args.home, "hub"));
    const webInHub = webSessionFiles.filter((f) =>
      f.toLowerCase().includes(`${sep}hub${sep}`),
    );
    if (webSessionFiles.length === 0) {
      fail("web produced no session files under $DSH_HOME/sessions");
      failed = true;
    } else if (webInHub.length) {
      fail(`web session files leaked into hub/: ${webInHub.join(", ")}`);
      failed = true;
    } else {
      pass(`web session files stay under sessions/ (${webSessionFiles.length} files)`);
    }

    for (const name of ["coding", "writing"]) {
      const files = filesByProfile[name].sessions;
      const leakedDefault = files.filter((f) =>
        relative(join(args.home, "sessions"), f).startsWith("..") === false
          ? existsSync(join(args.home, "sessions")) &&
            f.toLowerCase().startsWith(join(args.home, "sessions").toLowerCase())
          : false,
      );
      const leakedSibling = files.filter((f) => {
        const other = name === "coding" ? "writing" : "coding";
        return f.toLowerCase().includes(`${sep}hub${sep}${other}${sep}`);
      });
      if (files.length === 0) {
        fail(`${name} produced no session files under hub/${name}/sessions`);
        failed = true;
      } else if (leakedDefault.length || leakedSibling.length) {
        fail(`${name} session files leaked: ${[...leakedDefault, ...leakedSibling].join(", ")}`);
        failed = true;
      } else {
        pass(`${name} session files stay under hub/${name}/sessions (${files.length} files)`);
      }
    }

    const defaultSessionInHub = hubFiles.filter((f) =>
      f.toLowerCase().includes(`${sep}sessions${sep}`) &&
      !PROFILES.filter((p) => p.kind === "workbench").some((p) =>
        f.toLowerCase().includes(`${sep}hub${sep}${p.name}${sep}sessions${sep}`),
      ),
    );
    if (existsSync(join(args.home, "sessions"))) {
      const defaultHasWorkbench = listFiles(join(args.home, "sessions")).filter((f) =>
        /coding|writing/i.test(f),
      );
      if (defaultHasWorkbench.length) {
        fail(`default sessions/ contains workbench-looking files: ${defaultHasWorkbench.join(", ")}`);
        failed = true;
      }
    }
    void defaultSessionInHub;

    // Storages: workspace.json session ids must not cross trees.
    const idsByTree = {};
    for (const profile of PROFILES) {
      idsByTree[profile.name] = new Set(
        workspaceSessionIds(storageRoot(args.home, profile)),
      );
    }
    let storageCross = false;
    for (const a of created) {
      for (const b of created) {
        if (a.name === b.name) continue;
        if (idsByTree[b.name].has(a.sessionId)) {
          fail(`${a.name}'s ${a.sessionId} appears in ${b.name} workspace.json`);
          storageCross = true;
          failed = true;
        }
      }
    }
    if (!storageCross) {
      pass("workspace.json trees do not contain each other's session ids");
    }

    for (const profile of PROFILES) {
      const proj = join(storageRoot(args.home, profile), "session_projcache.json");
      if (existsSync(proj)) {
        pass(`session_projcache.json follows ${profile.name} storage root`);
      } else {
        info(`no session_projcache.json yet for ${profile.name} (not a fail)`);
      }
    }

    // API visibility.
    let apiLeak = false;
    for (const a of created) {
      const own = lists[a.name].map((item) => item.sessionId);
      if (!own.includes(a.sessionId)) {
        fail(`${a.name} session.list does not include its own ${a.sessionId}`);
        apiLeak = true;
        failed = true;
      }
      for (const b of created) {
        if (a.name === b.name) continue;
        if (own.includes(b.sessionId)) {
          fail(`${a.name} session.list can see ${b.name}'s ${b.sessionId}`);
          apiLeak = true;
          failed = true;
        }
      }
    }
    if (!apiLeak) pass("each instance's session.list sees only its own session");

    const allPersisted = [
      ...filesByProfile.web.sessions,
      ...filesByProfile.coding.sessions,
      ...filesByProfile.writing.sessions,
    ];
    const parseErrors = collectJsonlParseErrors(allPersisted);
    if (parseErrors.length) {
      fail(`jsonl parse errors:\n  ${parseErrors.join("\n  ")}`);
      failed = true;
    } else {
      pass(`persisted jsonl/zstd files parse (${allPersisted.filter((f) => f.includes("jsonl")).length} files)`);
    }

    for (const profile of PROFILES) {
      const ws = join(storageRoot(args.home, profile), "workspace.json");
      if (existsSync(ws)) {
        try {
          readJson(ws);
        } catch (err) {
          fail(`${profile.name} workspace.json is not valid JSON: ${err.message}`);
          failed = true;
        }
      } else {
        fail(`${profile.name} missing workspace.json`);
        failed = true;
      }
    }

    info("session files:");
    for (const profile of PROFILES) {
      for (const file of filesByProfile[profile.name].sessions) {
        info(`  ${profile.name}: ${relative(args.home, file)}`);
      }
    }
  } catch (err) {
    fail(err.stack || String(err));
    failed = true;
  } finally {
    await shutdown();
  }

  if (failed) {
    console.error("\nISOLATION GATE: FAIL");
    process.exit(1);
  }
  console.log("\nISOLATION GATE: PASS");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
