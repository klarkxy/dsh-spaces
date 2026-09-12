#!/usr/bin/env node
/**
 * Foundation gate A0: two ordinary DSH workspaces (no @dsh-spaces/plugin),
 * independent 127.0.0.1 entry + third management process, iframe embed of
 * real official DSH after server-side launch-token → HttpOnly cookie exchange.
 *
 * Experimental scaffolding (entry/manager HTTP) is NOT the product. Workspace
 * UI must be official DSH. Failures exit 1; this module does not start Hosts
 * when imported.
 *
 * node scripts/verify-workbench-foundation.mjs
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST,
  REGISTRY,
  DUMP_MS,
  PLUGIN_MS,
  BOOT_MS,
  RPC_MS,
  PORT_MS,
  redact,
  refuseRealHome,
  writeJson,
  resolveNode,
  resolveNpmCli,
  resolvePnpmCjs,
  dshBin,
  cliVersion,
  run,
  writePnpmShim,
  isolatedEnv,
  importCore,
  ephemeralPort,
  portClosed,
  waitPortClosed,
  stopOwned,
  captureLaunchUrl,
  sessionCookie,
  rpc,
  assertRpcOk,
} from "./verify-spaces-distribution.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(REPO, ".sandbox", "workbench-foundation");
const DEFAULT_PLAYWRIGHT =
  "C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const CANONICAL_SPACES = "@dsh-spaces/plugin";
const WEB_PROFILE = "web";
const NAV_MS = 30_000;
const UI_MS = 45_000;
const MANAGER_MS = 15_000;
const REUSE_HOME = process.env.DSH_TEST_WB_REUSE === "1";
const RESULT_PATH = join(ARTIFACT, "results.json");
const THIS_FILE = fileURLToPath(import.meta.url);

const SPACES = [
  {
    id: "zhuqing",
    profile: "zhuqing",
    spec: "dsh-theme-plugin@0.3.3",
    packageName: "dsh-theme-plugin",
    version: "0.3.3",
    dumpIds: ["theme-zhongguo"],
    installArgs: ["--ignore-scripts"],
    hash: "theme=zhuqing-light",
    displayName: "竹青",
    draft: "workbench-draft-zhuqing",
  },
  {
    id: "eternalnight",
    profile: "eternalnight",
    spec: "@eternalnight/dsh-theme@0.5.1",
    packageName: "@eternalnight/dsh-theme",
    version: "0.5.1",
    dumpIds: ["dsh-theme"],
    installArgs: [],
    hash: "",
    displayName: "EternalNight",
    draft: "workbench-draft-eternalnight",
  },
];

const proved = [];
const skipped = [];
const owned = [];

function info(m) {
  console.log(`INFO  ${redact(m)}`);
}
function pass(m) {
  proved.push(m);
  console.log(`PASS  ${redact(m)}`);
}

function dtoLeaks(value, home) {
  const hits = [];
  const forbiddenKeys = /token|cookie|set-cookie|authorization|passwd|secret/i;
  const realHome = resolve("C:/Users/admin/.dsh");
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === "string") {
      const lower = node.toLowerCase();
      if (node.includes("token=")) hits.push(`${path}: token query`);
      if (home && node.toLowerCase().includes(home.toLowerCase())) hits.push(`${path}: DSH_HOME`);
      if (lower.includes(realHome.toLowerCase())) hits.push(`${path}: real home`);
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

function themeEnv(home, nodeExe, tooling) {
  const env = isolatedEnv(home, nodeExe, tooling);
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

function runThemeDsh(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath) {
  return run(nodeExe, [bin, ...args], {
    env: themeEnv(home, nodeExe, tooling),
    timeoutMs,
    label,
    logPath,
  });
}

function runThemeDshRetry(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath) {
  try {
    return runThemeDsh(nodeExe, bin, home, tooling, args, timeoutMs, label, logPath);
  } catch (error) {
    info(`${label} retrying once: ${error instanceof Error ? error.message : String(error)}`);
    return runThemeDsh(nodeExe, bin, home, tooling, args, timeoutMs, `${label} retry`, logPath);
  }
}

async function startThemeProfile(nodeExe, bin, home, tooling, profile, logPath) {
  const port = await ephemeralPort();
  writeFileSync(logPath, "", "utf8");
  const child = spawn(nodeExe, [bin, "--profile", profile, "--no-open", "--host", HOST, "--port", String(port)], {
    env: themeEnv(home, nodeExe, tooling),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.pid) throw new Error(`failed to spawn ${profile}`);
  owned.push(child);
  child.stdout?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  child.stderr?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  try {
    const launchUrl = await captureLaunchUrl(child, port, BOOT_MS);
    return { child, port, launchUrl, profile };
  } catch (error) {
    await stopOwned(child);
    throw error;
  }
}

function readProfilePkg(home, name) {
  const path = join(home, "profiles", name, "package.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function pluginSet(home, name) {
  const pkg = readProfilePkg(home, name);
  const deps = pkg?.dependencies ?? {};
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  return { deps, bundles, names: Object.keys(deps) };
}

function assertOrdinaryThemeProfile(home, space) {
  const state = pluginSet(home, space.profile);
  if (!Object.prototype.hasOwnProperty.call(state.deps, space.packageName)) {
    throw new Error(`${space.profile} missing theme dep ${space.packageName}: ${JSON.stringify(state.deps)}`);
  }
  if (Object.prototype.hasOwnProperty.call(state.deps, CANONICAL_SPACES) || state.bundles.includes(CANONICAL_SPACES)) {
    throw new Error(`${space.profile} must not install ${CANONICAL_SPACES}`);
  }
  if (!state.bundles.includes(space.packageName)) {
    throw new Error(`${space.profile} bundles missing ${space.packageName}: ${JSON.stringify(state.bundles)}`);
  }
  const other = SPACES.filter((row) => row.id !== space.id).map((row) => row.packageName);
  const leaked = other.filter((name) => state.bundles.includes(name) || Object.prototype.hasOwnProperty.call(state.deps, name));
  if (leaked.length) throw new Error(`${space.profile} mixed extra themes ${leaked.join(", ")}`);
  return state;
}

function dumpHasId(dump, id) {
  return new RegExp(`^- id:\\s*${id}\\b`, "m").test(dump);
}

function expectedCookieName(authority) {
  const digest = createHash("sha256").update(authority).digest();
  const b64 = Buffer.from(digest).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `dsh-auth-${b64}`;
}

function parseSetCookie(raw) {
  const parts = String(raw).split(";").map((item) => item.trim()).filter(Boolean);
  const [name, ...rest] = (parts[0] ?? "").split("=");
  const attrs = {};
  for (const item of parts.slice(1)) {
    const at = item.indexOf("=");
    if (at === -1) attrs[item.toLowerCase()] = true;
    else attrs[item.slice(0, at).trim().toLowerCase()] = item.slice(at + 1).trim();
  }
  return {
    name,
    httpOnly: Boolean(attrs.httponly),
    path: attrs.path ?? "/",
    sameSite: String(attrs.samesite ?? ""),
    secure: Boolean(attrs.secure),
    maxAge: attrs["max-age"] ?? null,
  };
}

function assertCleanSubOrigin(url, allowedPorts) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== HOST || parsed.pathname !== "/") {
    throw new Error(`bootstrap location is not a clean loopback origin: ${redact(url)}`);
  }
  if (parsed.searchParams.has("token") || parsed.search.includes("token=")) {
    throw new Error("bootstrap location still carries a launch token");
  }
  if (parsed.username || parsed.password) throw new Error("bootstrap location has userinfo");
  const port = Number(parsed.port);
  if (!allowedPorts.includes(port)) throw new Error(`bootstrap location port ${port} is not an owned workspace`);
  return parsed;
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

async function clickIfVisible(locator) {
  if (await locator.first().isVisible().catch(() => false)) {
    await locator.first().click({ timeout: 5_000 }).catch(() => locator.first().click({ force: true }));
    return true;
  }
  return false;
}

function overlayLocators(frame) {
  return {
    continueBtn: frame.locator("button, [role='button']").filter({ hasText: /^(Continue|继续)$/ }),
    laterBtn: frame.locator("button, [role='button']").filter({ hasText: /稍后配置|set up later|configure later/i }),
    notice: frame.getByText(/内测声明|添加一个 API Key/),
  };
}

async function dismissOfficialOverlays(frame, { waitForContinue = false, waitForLater = false } = {}) {
  const { continueBtn, laterBtn, notice } = overlayLocators(frame);
  if (waitForContinue) {
    try {
      await continueBtn.first().waitFor({ timeout: 12_000 });
      await clickIfVisible(continueBtn);
    } catch {
      /* already past the beta notice */
    }
  }
  if (waitForLater) {
    try {
      await laterBtn.first().waitFor({ timeout: 15_000 });
      await clickIfVisible(laterBtn);
    } catch {
      /* already past API-key defer */
    }
  }
  const deadline = Date.now() + (waitForLater ? 8_000 : 3_000);
  while (Date.now() < deadline) {
    const clicked = (await clickIfVisible(continueBtn)) || (await clickIfVisible(laterBtn));
    if (clicked) {
      await delay(250);
      continue;
    }
    if (await notice.first().isVisible().catch(() => false)) {
      await delay(200);
      continue;
    }
    return;
  }
}

async function skipIntro(frame) {
  await waitUntil(async () => !new URL(frame.url()).searchParams.has("token"), NAV_MS, "token redirect");
  await dismissOfficialOverlays(frame, { waitForContinue: true, waitForLater: true });
}

async function openChatSurface(frame) {
  const editor = frame.locator('[contenteditable="true"]').first();
  if (await editor.isVisible().catch(() => false)) return editor;
  const chat = frame.getByText(/^(New Session|新会话)$/i).first();
  if (await chat.isVisible().catch(() => false)) await chat.click();
  await editor.waitFor({ timeout: UI_MS });
  return editor;
}

async function readThemeProof(frame) {
  return frame.evaluate(() => {
    const cs = getComputedStyle(document.body);
    const img = document.querySelector(".dt-bg img");
    const video = document.querySelector(".dt-bg video");
    return {
      href: location.href,
      origin: location.origin,
      search: location.search,
      bg: cs.backgroundColor,
      bgBase: cs.getPropertyValue("--dsw-alias-bg-base").trim(),
      dtBg: Boolean(document.querySelector(".dt-bg")),
      dtImgSrc: img instanceof HTMLImageElement ? img.currentSrc || img.getAttribute("src") : null,
      dtVideoSrc: video instanceof HTMLVideoElement ? video.currentSrc || video.getAttribute("src") : null,
      documentCookie: document.cookie,
    };
  });
}

function assertThemeProof(space, proof) {
  if (new URL(proof.href).searchParams.has("token") || String(proof.search).includes("token=")) {
    throw new Error(`${space.id} iframe URL still has a launch token`);
  }
  if (/dsh-auth-/i.test(proof.documentCookie || "")) {
    throw new Error(`${space.id} document.cookie exposed HttpOnly dsh-auth cookie`);
  }
  if (space.id === "zhuqing") {
    if (proof.bgBase.replace(/\s+/g, "") !== "rgb(239,248,241)") {
      throw new Error(`Zhu Qing theme tokens not applied: ${proof.bgBase}`);
    }
    return;
  }
  if (space.id === "eternalnight") {
    if (!proof.dtBg) throw new Error("eternalnight missing .dt-bg");
    const src = `${proof.dtImgSrc || ""} ${proof.dtVideoSrc || ""}`;
    if (!/\/dsh-theme\/assets\//.test(src)) {
      throw new Error(`eternalnight media src is not official plugin assets: ${src}`);
    }
  }
}

function entryHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Workbench Foundation (experimental)</title>
<style>
  :root { --rail:72px; --bg:#0b1016; --rail-bg:#070b10; --text:#e8eef4; --muted:#8b9bb0; --accent:#3ee0c5; --danger:#ff5d6c; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--text); font:13px/1.45 "Segoe UI",system-ui,sans-serif; }
  #app { display:flex; height:100%; }
  #rail-left, #rail-right {
    width:var(--rail); flex:none; background:var(--rail-bg);
    display:flex; flex-direction:column; align-items:center; gap:12px;
    padding:12px 8px; box-sizing:border-box;
  }
  #stage { flex:1; position:relative; min-width:0; background:#0e151e; overflow:hidden; }
  .space-btn { width:48px; height:48px; border:0; border-radius:12px; background:#151e28; color:var(--text); cursor:pointer; }
  .space-btn.active { outline:2px solid var(--accent); }
  iframe.space-frame { position:absolute; inset:0; width:100%; height:100%; border:0; background:#000; }
  iframe.space-frame:not(.active) { visibility:hidden; pointer-events:none; }
  #rescue {
    display:none; position:absolute; z-index:5; left:16px; right:16px; top:16px;
    padding:16px 18px; border-radius:12px; background:#1a1214; color:var(--text);
    border:1px solid var(--danger);
  }
  #rescue.visible { display:block; }
  .badge { font-size:10px; color:var(--muted); writing-mode:vertical-rl; letter-spacing:.12em; }
  #status { font-size:11px; color:var(--muted); text-align:center; word-break:break-all; }
</style>
</head>
<body>
<div id="app">
  <nav id="rail-left" data-testid="rail-left" aria-label="空间栏"></nav>
  <main id="stage" data-testid="stage">
    <div id="rescue" data-testid="rescue">
      <strong>管理环境恢复中</strong>
      <p id="rescue-body">独立入口仍在线。工作空间进程未随管理环境退出。此页是实验脚手架，不是产品实现。</p>
    </div>
  </main>
  <nav id="rail-right" data-testid="rail-right" aria-label="管理栏">
    <div class="badge">实验脚手架 · 非产品</div>
    <div id="status">连接中</div>
  </nav>
</div>
<script>
const left = document.getElementById("rail-left");
const stage = document.getElementById("stage");
const rescue = document.getElementById("rescue");
const statusEl = document.getElementById("status");
const frames = new Map();
let selected = null;

function spaceFrame(id) {
  let frame = frames.get(id);
  if (frame) return frame;
  frame = document.createElement("iframe");
  frame.className = "space-frame";
  frame.dataset.space = id;
  frame.title = id;
  frame.referrerPolicy = "no-referrer";
  stage.appendChild(frame);
  frames.set(id, frame);
  return frame;
}

function showRescue(on, text) {
  rescue.classList.toggle("visible", Boolean(on));
  if (text) document.getElementById("rescue-body").textContent = text;
}

function render(data) {
  statusEl.textContent = data.maintenance ? "救援" : "在线";
  showRescue(Boolean(data.maintenance), data.rescueMessage || "");
  left.replaceChildren();
  for (const space of data.spaces || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "space-btn" + (selected === space.id ? " active" : "");
    btn.dataset.space = space.id;
    btn.setAttribute("aria-label", space.displayName);
    btn.textContent = space.displayName.slice(0, 1);
    btn.addEventListener("click", () => activate(space.id));
    left.appendChild(btn);
    spaceFrame(space.id);
  }
  if (!selected && data.spaces && data.spaces[0]) activate(data.spaces[0].id);
}

function activate(id) {
  selected = id;
  for (const btn of left.querySelectorAll(".space-btn")) {
    btn.classList.toggle("active", btn.dataset.space === id);
  }
  for (const [key, frame] of frames) {
    const on = key === id;
    frame.classList.toggle("active", on);
    if (on && !frame.dataset.bootstrapped) {
      frame.src = "/embed/" + encodeURIComponent(id) + "/bootstrap";
      frame.dataset.bootstrapped = "1";
    }
  }
}

async function refresh() {
  try {
    const response = await fetch("/api/spaces", { credentials: "include" });
    const data = await response.json();
    render(data);
  } catch {
    showRescue(true, "独立入口仍在线，但暂时读不到管理状态。");
    statusEl.textContent = "救援";
  }
}
refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>`;
}

function json(res, status, value, extraHeaders = {}) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(body);
}

function requestOrigin(req) {
  const raw = req.headers.origin;
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function requestHost(req) {
  const host = req.headers.host;
  if (!host) return null;
  try {
    return new URL(`http://${host}`);
  } catch {
    return null;
  }
}

function cookieHeaderValue(headerValue, name) {
  if (!headerValue) return null;
  for (const segment of String(headerValue).split(";")) {
    const at = segment.indexOf("=");
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return null;
}

function apiTrusted(req, selfOrigin) {
  const host = requestHost(req);
  if (!host || host.hostname !== HOST || Number(host.port) !== selfOrigin.port) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = requestOrigin(req);
  if (!origin) return true;
  return origin.host === host.host;
}

function redactState(state) {
  const copy = structuredClone(state);
  for (const space of copy.spaces ?? []) {
    if (space.launchUrl) {
      try {
        const url = new URL(space.launchUrl);
        url.searchParams.set("token", "[redacted-token]");
        space.launchUrl = url.href;
      } catch {
        space.launchUrl = "[redacted]";
      }
    }
    if (space.token) space.token = "[redacted-token]";
  }
  if (copy.internalSecret) copy.internalSecret = "[redacted]";
  if (copy.entrySecret) copy.entrySecret = "[redacted]";
  return copy;
}

async function probeUpstreamAuth(launchUrl) {
  const tokenExchange = await fetch(launchUrl.href, { redirect: "manual", signal: AbortSignal.timeout(RPC_MS) });
  const setCookies = tokenExchange.headers.getSetCookie();
  await tokenExchange.body?.cancel();
  const raw = setCookies.find((value) => /^dsh-auth-[^=]+=.+$/.test(value.split(";", 1)[0] ?? ""));
  if (tokenExchange.status !== 303 || tokenExchange.headers.get("location") !== "/" || !raw) {
    throw new Error("DSH token exchange did not mint an HttpOnly session cookie");
  }
  const parsed = parseSetCookie(raw);
  const authority = `${HOST}:${launchUrl.port}`;
  const expected = expectedCookieName(authority);
  const cookie = raw.split(";", 1)[0];
  const document = await fetch(`${launchUrl.origin}/`, {
    headers: { cookie, origin: launchUrl.origin },
    redirect: "manual",
    signal: AbortSignal.timeout(RPC_MS),
  });
  const headers = {
    status: document.status,
    xFrameOptions: document.headers.get("x-frame-options"),
    csp: document.headers.get("content-security-policy"),
    location: document.headers.get("location"),
  };
  await document.body?.cancel();
  const foreignOrigin = `http://${HOST}:${Number(launchUrl.port) === 1 ? 2 : 1}`;
  const cross = await rpc(Number(launchUrl.port), cookie, "session/list", { _request: {} });
  // rpc() sets origin to the DSH origin; probe a mismatched Origin separately.
  const mismatch = await fetch(`http://${HOST}:${launchUrl.port}/api/session/list`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: foreignOrigin,
      cookie,
      connection: "close",
    },
    body: JSON.stringify({ type: "client-request", rpcId: "probe", method: "session/list", payload: { args: { _request: {} } } }),
    signal: AbortSignal.timeout(RPC_MS),
  });
  const mismatchText = redact((await mismatch.text()).slice(0, 200));
  return {
    cookie: {
      name: parsed.name,
      expectedName: expected,
      nameMatchesAuthority: parsed.name === expected,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
      path: parsed.path,
      secure: parsed.secure,
    },
    tokenExchange: {
      status: tokenExchange.status,
      location: tokenExchange.headers.get("location"),
      referrerPolicy: tokenExchange.headers.get("referrer-policy"),
    },
    document: headers,
    sameOriginRpc: { status: cross.status, ok: Boolean(cross.body?.result?.ok) },
    mismatchedOrigin: { status: mismatch.status, body: mismatchText },
    iframeFeasible: !headers.xFrameOptions && !/frame-ancestors\s+['\"]?none/i.test(headers.csp || ""),
  };
}

async function exchangeWorkspaceCookie(space) {
  const launchUrl = new URL(space.launchUrl);
  const response = await fetch(launchUrl.href, { redirect: "manual", signal: AbortSignal.timeout(RPC_MS) });
  const setCookies = response.headers.getSetCookie();
  await response.body?.cancel();
  if (response.status !== 303 || response.headers.get("location") !== "/" || !setCookies.length) {
    throw new Error(`DSH cookie mint failed for ${space.id}`);
  }
  const target = new URL(`http://${HOST}:${space.port}/`);
  if (space.hash) target.hash = space.hash;
  return {
    setCookies,
    location: target.href,
    probe: parseSetCookie(setCookies[0]),
    expectedName: expectedCookieName(`${HOST}:${space.port}`),
  };
}

function sendBootstrap(res, minted) {
  const dest = minted.location;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "set-cookie": minted.setCookies,
  });
  const safe = dest.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  res.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>workspace bootstrap</title>
</head>
<body>
<p>正在进入工作空间…</p>
<script>location.replace(${JSON.stringify(dest)});</script>
</body>
</html>`);
}

async function runManagerServer() {
  const port = Number(process.env.WB_BIND_PORT);
  const secret = process.env.WB_INTERNAL_SECRET;
  const statePath = process.env.WB_STATE_PATH;
  if (!port || !secret || !statePath) throw new Error("manager missing WB_BIND_PORT/WB_INTERNAL_SECRET/WB_STATE_PATH");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const self = { hostname: HOST, port };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
      if (req.headers["x-wb-internal"] !== secret) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (!apiTrusted(req, self) && url.pathname !== "/health") {
        json(res, 403, { ok: false, error: "origin-denied" });
        return;
      }
      if (url.pathname === "/health" && req.method === "GET") {
        json(res, 200, { ok: true, role: "manager", experimental: true });
        return;
      }
      if (url.pathname === "/internal/state" && req.method === "GET") {
        json(res, 200, {
          ok: true,
          experimental: true,
          maintenance: false,
          spaces: state.spaces.map((space) => ({
            id: space.id,
            displayName: space.displayName,
            status: "running",
            port: space.port,
          })),
        });
        return;
      }
      const boot = url.pathname.match(/^\/internal\/embed\/([^/]+)\/bootstrap$/);
      if (boot && req.method === "POST") {
        const id = decodeURIComponent(boot[1]);
        const space = state.spaces.find((row) => row.id === id);
        if (!space) {
          json(res, 404, { ok: false, error: "unknown-space" });
          return;
        }
        const minted = await exchangeWorkspaceCookie(space);
        json(res, 200, {
          ok: true,
          location: minted.location,
          setCookies: minted.setCookies,
          cookie: {
            name: minted.probe.name,
            expectedName: minted.expectedName,
            httpOnly: minted.probe.httpOnly,
            sameSite: minted.probe.sameSite,
            path: minted.probe.path,
            secure: minted.probe.secure,
          },
        });
        return;
      }
      json(res, 404, { ok: false, error: "not-found" });
    } catch (error) {
      json(res, 500, { ok: false, error: redact(error instanceof Error ? error.message : String(error)) });
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolveListen());
  });
  const stop = () =>
    new Promise((resolveStop) => {
      server.close(() => resolveStop());
      setTimeout(resolveStop, 2000).unref();
    });
  process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
  process.on("SIGINT", () => void stop().then(() => process.exit(0)));
}

async function runEntryServer() {
  const port = Number(process.env.WB_BIND_PORT);
  const managerOrigin = process.env.WB_MANAGER_ORIGIN;
  const internal = process.env.WB_INTERNAL_SECRET;
  const entrySecret = process.env.WB_ENTRY_SECRET;
  if (!port || !managerOrigin || !internal || !entrySecret) {
    throw new Error("entry missing bind/manager/secret env");
  }
  const self = { hostname: HOST, port };
  const selfOrigin = `http://${HOST}:${port}`;
  let cache = { experimental: true, maintenance: true, spaces: [], rescueMessage: "等待管理环境" };
  const allowPorts = new Set();

  async function managerFetch(pathname, init = {}) {
    const response = await fetch(`${managerOrigin}${pathname}`, {
      ...init,
      headers: {
        "x-wb-internal": internal,
        origin: managerOrigin,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(MANAGER_MS),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  async function refreshCache() {
    try {
      const call = await managerFetch("/internal/state");
      if (!call.body?.ok) throw new Error("manager state denied");
      for (const space of call.body.spaces ?? []) {
        if (Number.isInteger(space.port)) allowPorts.add(space.port);
      }
      cache = {
        experimental: true,
        note: "experimental-scaffold-not-product",
        maintenance: false,
        spaces: (call.body.spaces ?? []).map((space) => ({
          id: space.id,
          displayName: space.displayName,
          status: space.status,
        })),
      };
    } catch {
      cache = {
        experimental: true,
        note: "experimental-scaffold-not-product",
        maintenance: true,
        rescueMessage: "管理环境不可用。独立入口仍在线；已启动的工作空间进程不会因此退出。",
        spaces: cache.spaces,
      };
    }
  }

  await refreshCache();
  const timer = setInterval(() => void refreshCache(), 1000);
  timer.unref?.();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", selfOrigin);
      const host = requestHost(req);
      if (!host || host.hostname !== HOST || Number(host.port) !== port) {
        json(res, 403, { ok: false, error: "host-denied" });
        return;
      }

      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:*`,
          "set-cookie": `wb-entry=${entrySecret}; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end(entryHtml());
        return;
      }

      const hasEntry = cookieHeaderValue(req.headers.cookie, "wb-entry") === entrySecret;

      if (url.pathname === "/api/spaces" && req.method === "GET") {
        if (!apiTrusted(req, self) || !hasEntry) {
          json(res, 403, { ok: false, error: "origin-or-auth-denied" });
          return;
        }
        const leaks = dtoLeaks(cache, process.env.DSH_HOME);
        if (leaks.length) {
          json(res, 500, { ok: false, error: "dto-hygiene" });
          return;
        }
        json(res, 200, cache);
        return;
      }

      const boot = url.pathname.match(/^\/embed\/([^/]+)\/bootstrap$/);
      if (boot && req.method === "GET") {
        if (!hasEntry) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("entry authentication required\n");
          return;
        }
        if (req.headers["sec-fetch-site"] === "cross-site") {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end("cross-site embed denied\n");
          return;
        }
        const origin = requestOrigin(req);
        if (origin && origin.host !== host.host) {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end("origin-denied\n");
          return;
        }
        const id = decodeURIComponent(boot[1]);
        const known = (cache.spaces ?? []).some((space) => space.id === id);
        if (!known) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("unknown-space\n");
          return;
        }
        const call = await managerFetch(`/internal/embed/${encodeURIComponent(id)}/bootstrap`, { method: "POST" });
        if (!call.body?.ok || !Array.isArray(call.body.setCookies) || !call.body.location) {
          res.writeHead(cache.maintenance ? 503 : 502, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><p>工作空间引导失败，管理环境不可用。</p>`);
          return;
        }
        const dest = assertCleanSubOrigin(call.body.location, [...allowPorts]);
        if (call.body.location.includes("token=")) throw new Error("manager returned a token URL");
        sendBootstrap(res, { setCookies: call.body.setCookies, location: dest.href });
        return;
      }

      json(res, 404, { ok: false, error: "not-found" });
    } catch (error) {
      json(res, 500, { ok: false, error: redact(error instanceof Error ? error.message : String(error)) });
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolveListen());
  });
  const stop = () =>
    new Promise((resolveStop) => {
      clearInterval(timer);
      server.close(() => resolveStop());
      setTimeout(resolveStop, 2000).unref();
    });
  process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
  process.on("SIGINT", () => void stop().then(() => process.exit(0)));
}

function spawnRole(nodeExe, role, env, logPath) {
  writeFileSync(logPath, "", "utf8");
  const child = spawn(nodeExe, [THIS_FILE], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.pid) throw new Error(`failed to spawn ${role}`);
  owned.push(child);
  child.stdout?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  child.stderr?.on("data", (chunk) => writeFileSync(logPath, redact(chunk.toString("utf8")), { flag: "a" }));
  return child;
}

async function waitHttpOk(url, timeoutMs, headers = {}) {
  await waitUntil(async () => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.status === 200;
  }, timeoutMs, `wait ${url}`);
}

async function createEmptyWorkspaceAndSession(port, cookie, workspacePath) {
  mkdirSync(workspacePath, { recursive: true });
  const created = assertRpcOk(
    await rpc(port, cookie, "workspace/create", { request: { path: workspacePath } }),
    "workspace/create",
  );
  const workspaceId = created?.workspace?.workspaceId ?? created?.workspaceId;
  if (!workspaceId) throw new Error("workspace/create returned no workspaceId");
  const session = assertRpcOk(
    await rpc(port, cookie, "session/create", { request: { workspaceId } }),
    "session/create",
  );
  return { workspaceId, sessionId: session?.sessionId ?? null };
}

function collectBrowserLeaks(items) {
  const hits = [];
  for (const item of items) {
    const text = typeof item === "string" ? item : JSON.stringify(item);
    if (/[?&]token=/i.test(text) || /token=[A-Za-z0-9_-]{16,}/.test(text)) hits.push(redact(text).slice(0, 240));
  }
  return hits;
}

async function frameForSpace(page, space) {
  const handle = page.locator(`iframe[data-space="${space.id}"]`);
  await handle.waitFor({ timeout: UI_MS });
  await waitUntil(async () => {
    const el = await handle.elementHandle();
    const frame = el ? await el.contentFrame() : null;
    if (!frame) return false;
    try {
      const url = new URL(frame.url());
      return (
        url.protocol === "http:" &&
        url.hostname === HOST &&
        Number(url.port) === space.port &&
        url.pathname === "/" &&
        !url.searchParams.has("token")
      );
    } catch {
      return false;
    }
  }, UI_MS, `${space.id} clean DSH origin :${space.port}`);
  const frame = await (await handle.elementHandle()).contentFrame();
  if (!frame) throw new Error(`no contentFrame for ${space.id}`);
  return frame;
}

async function runPlaywright(ctx) {
  const { entryOrigin, entryPort, managerPort, spaces, nodeExe } = ctx;
  const playwrightModule = process.env.DSH_TEST_PLAYWRIGHT_MODULE || DEFAULT_PLAYWRIGHT;
  const { chromium } = await import(pathToFileURL(join(playwrightModule, "index.mjs")).href);
  const browser = await chromium.launch({ headless: true, timeout: NAV_MS });
  const page = await browser.newPage({ locale: "zh-CN" });
  page.setDefaultTimeout(UI_MS);
  const pageErrors = [];
  const requestUrls = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requestUrls.push(request.url()));
  const shot = (name) => join(ARTIFACT, name);
  mkdirSync(ARTIFACT, { recursive: true });
  try {
    await page.goto(entryOrigin + "/", { waitUntil: "domcontentloaded", timeout: NAV_MS });
    await page.locator("#rail-left").waitFor({ timeout: UI_MS });
    await page.locator("#rail-right").waitFor({ timeout: UI_MS });
    const rails = await page.evaluate(() => {
      const left = document.getElementById("rail-left");
      const right = document.getElementById("rail-right");
      return {
        left: left ? Math.round(left.getBoundingClientRect().width) : 0,
        right: right ? Math.round(right.getBoundingClientRect().width) : 0,
      };
    });
    if (rails.left !== 72 || rails.right !== 72) {
      throw new Error(`outer rails are not 72px: left=${rails.left} right=${rails.right}`);
    }
    pass("entry kept 72px left and right outer navigation");

    const dto = await page.evaluate(async () => {
      const response = await fetch("/api/spaces", { credentials: "include" });
      return { status: response.status, body: await response.json() };
    });
    if (dto.status !== 200) throw new Error(`root origin /api/spaces HTTP ${dto.status}`);
    const leaks = dtoLeaks(dto.body, ctx.home);
    if (leaks.length) throw new Error(`browser DTO leaked ${leaks.join("; ")}`);
    pass("root origin management DTO has no token/cookie/path/home");

    const proofs = {};
    const origins = [];
    for (const space of spaces) {
      await page.locator(`button[data-space="${space.id}"]`).click();
      const frame = await frameForSpace(page, space);
      const frameUrl = new URL(frame.url());
      if (frameUrl.searchParams.has("token")) throw new Error(`${space.id} iframe URL has token`);
      if (Number(frameUrl.port) === entryPort) throw new Error(`${space.id} iframe stayed on entry origin`);
      origins.push({ id: space.id, origin: frameUrl.origin, port: Number(frameUrl.port) });
      await skipIntro(frame);
      if (space.id === "zhuqing") {
        await waitUntil(async () => (await readThemeProof(frame)).bgBase.replace(/\s+/g, "") === "rgb(239,248,241)", UI_MS, "zhuqing tokens");
      } else {
        await waitUntil(async () => (await readThemeProof(frame)).dtBg, UI_MS, "eternalnight wallpaper");
      }
      const editor = await openChatSurface(frame);
      await dismissOfficialOverlays(frame, { waitForLater: true });
      await editor.click({ force: true });
      try {
        await editor.fill(space.draft);
      } catch {
        await editor.pressSequentially(space.draft, { delay: 15 });
      }
      const typed = await editor.innerText();
      if (!typed.includes(space.draft)) throw new Error(`${space.id} draft was not accepted`);
      const proof = await readThemeProof(frame);
      assertThemeProof(space, proof);
      proofs[space.id] = proof;
      await page.screenshot({ path: shot(`${space.id}-draft.png`), fullPage: true });
      pass(`${space.id} iframe is official DSH at ${frameUrl.origin}; draft kept; theme markers present`);
    }

    if (origins[0].origin === origins[1].origin || origins[0].port === origins[1].port) {
      throw new Error(`iframes did not get independent origins: ${JSON.stringify(origins)}`);
    }
    pass(`independent iframe origins ${origins.map((row) => row.origin).join(" | ")}`);

    const zhuqingStill = page.locator('iframe[data-space="zhuqing"]');
    const eternalStill = page.locator('iframe[data-space="eternalnight"]');
    if (!(await zhuqingStill.count()) || !(await eternalStill.count())) {
      throw new Error("switching unmounted an iframe");
    }
    await page.locator('button[data-space="zhuqing"]').click();
    const zhuqingFrame = await frameForSpace(page, spaces.find((row) => row.id === "zhuqing"));
    const zhuqingDraft = await zhuqingFrame.locator('[contenteditable="true"]').first().innerText();
    if (!zhuqingDraft.includes(SPACES[0].draft)) throw new Error("zhuqing draft lost after switch; iframe was likely unloaded");
    await page.locator('button[data-space="eternalnight"]').click();
    const nightFrame = await frameForSpace(page, spaces.find((row) => row.id === "eternalnight"));
    const nightDraft = await nightFrame.locator('[contenteditable="true"]').first().innerText();
    if (!nightDraft.includes(SPACES[1].draft)) throw new Error("eternalnight draft lost after switch");
    pass("switch did not unload iframes; drafts survived");

    if (proofs.zhuqing.dtBg) throw new Error("zhuqing iframe picked up eternalnight wallpaper");
    if (proofs.eternalnight.bgBase.replace(/\s+/g, "") === "rgb(239,248,241)") {
      throw new Error("eternalnight iframe picked up zhuqing tokens");
    }
    const parentTheme = await page.evaluate(() => ({
      bgBase: getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim(),
      dtBg: Boolean(document.querySelector(".dt-bg")),
    }));
    if (parentTheme.dtBg || parentTheme.bgBase.replace(/\s+/g, "") === "rgb(239,248,241)") {
      throw new Error("entry origin was stained by a workspace theme");
    }
    pass("themes did not stain each other or the entry origin");

    const zhuqingOrigin = origins.find((row) => row.id === "zhuqing").origin;
    const nightOrigin = origins.find((row) => row.id === "eternalnight").origin;
    const fromRootToDsh = await page.evaluate(async (origin) => {
      try {
        const response = await fetch(`${origin}/api/session/list`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "client-request", rpcId: "x", method: "session/list", payload: { args: { _request: {} } } }),
        });
        return { status: response.status, text: (await response.text()).slice(0, 200) };
      } catch (error) {
        return { status: 0, text: String(error) };
      }
    }, zhuqingOrigin);
    const rootReadDsh =
      fromRootToDsh.status === 200 && /"ok"\s*:\s*true/.test(fromRootToDsh.text);
    if (rootReadDsh) throw new Error(`root origin read workspace API: ${redact(fromRootToDsh.text)}`);
    pass("root origin cannot read workspace/DSH API");

    const fromChildToEntry = await zhuqingFrame.evaluate(async (origin) => {
      try {
        const response = await fetch(`${origin}/api/spaces`, { credentials: "include" });
        return { status: response.status, text: (await response.text()).slice(0, 200) };
      } catch (error) {
        return { status: 0, text: String(error) };
      }
    }, entryOrigin);
    if (fromChildToEntry.status === 200) {
      throw new Error(`sub-origin read management API: ${redact(fromChildToEntry.text)}`);
    }
    pass("sub-origin cannot read management API");

    const cookieDump = await page.context().cookies();
    const browserCookieNames = cookieDump.map((row) => row.name);
    const tokenInCookies = cookieDump.some((row) => /token/i.test(row.name) || String(row.value).includes("token="));
    if (tokenInCookies) throw new Error("browser cookie jar contains a launch token");
    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }));
    const iframeSrc = await page.locator("iframe.space-frame").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
    const leakHits = collectBrowserLeaks([
      JSON.stringify(dto.body),
      JSON.stringify(storage),
      ...iframeSrc,
      ...requestUrls,
      ...page.frames().map((frame) => frame.url()),
      ...pageErrors,
    ]);
    if (leakHits.length) throw new Error(`browser-visible token leak: ${leakHits.join(" | ")}`);
    pass("DTO, iframe src, storage, request URLs, and frame URLs have no raw launch token");

    await page.screenshot({ path: shot("shell-two-spaces.png"), fullPage: true });

    info(`stopping management environment :${managerPort}`);
    const managerChild = ctx.managerChild;
    await stopOwned(managerChild);
    await waitPortClosed(managerPort, PORT_MS);
    pass(`management process port :${managerPort} closed`);

    await waitUntil(async () => {
      const visible = await page.locator("#rescue.visible").isVisible().catch(() => false);
      return visible;
    }, UI_MS, "rescue view");
    const entryAlive = await fetch(entryOrigin + "/", { redirect: "manual", signal: AbortSignal.timeout(RPC_MS) });
    await entryAlive.body?.cancel();
    if (entryAlive.status !== 200) throw new Error(`entry lost after manager stop: HTTP ${entryAlive.status}`);
    const live = [];
    for (const space of spaces) {
      if (await portClosed(space.port)) continue;
      live.push({ id: space.id, port: space.port });
    }
    if (!live.length) throw new Error("no workspace process remained after manager stop");
    await page.screenshot({ path: shot("rescue-after-manager-stop.png"), fullPage: true });
    pass("entry stayed up with rescue/progress after manager stop; a workspace process still exists");

    if (pageErrors.length) throw new Error(`pageerrors: ${redact(pageErrors.join(" | "))}`);
    return {
      rails,
      dto: dto.body,
      origins,
      proofs,
      iframeSrc,
      fromRootToDsh,
      fromChildToEntry,
      browserCookieNames,
      liveAfterManagerStop: live,
      screenshots: {
        zhuqing: shot("zhuqing-draft.png"),
        eternalnight: shot("eternalnight-draft.png"),
        shell: shot("shell-two-spaces.png"),
        rescue: shot("rescue-after-manager-stop.png"),
      },
    };
  } catch (error) {
    await page.screenshot({ path: shot("failure.png"), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  mkdirSync(ARTIFACT, { recursive: true });
  const nodeExe = resolveNode();
  const bin = dshBin();
  const version = cliVersion(bin);
  info(`compatible CLI ${version} at ${bin}`);
  resolveNpmCli(nodeExe);
  const pnpmCjs = resolvePnpmCjs();
  info(`pnpm ${pnpmCjs} registry ${REGISTRY}`);

  const session = mkdtempSync(join(tmpdir(), "workbench-foundation-"));
  const sessionRel = relative(tmpdir(), session);
  if (isAbsolute(sessionRel) || sessionRel.startsWith("..")) throw new Error("session root escaped tmpdir");
  const tooling = {
    shim: join(session, "bin"),
    pnpmHome: join(session, "pnpm-home"),
    store: join(session, "store"),
    cache: join(session, "npm-cache"),
  };
  mkdirSync(tooling.pnpmHome, { recursive: true });
  mkdirSync(tooling.store, { recursive: true });
  mkdirSync(tooling.cache, { recursive: true });
  writePnpmShim(tooling.shim, nodeExe, pnpmCjs);

  const home = join(ARTIFACT, "home");
  refuseRealHome(home);
  if (home.toLowerCase().startsWith(resolve("C:/Users/admin/.dsh").toLowerCase() + sep)) {
    throw new Error("refusing real ~/.dsh");
  }
  if (!REUSE_HOME) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
  } else if (!existsSync(join(home, "profiles", WEB_PROFILE, "package.json"))) {
    throw new Error("Requested reuse but the owned test home has no web baseline");
  }

  const { applyIsolationPatch, assertDumpPatched } = await importCore();
  const seedLog = join(ARTIFACT, "seed.log");
  if (!REUSE_HOME) {
    info("seed web --dump-config");
    runThemeDsh(nodeExe, bin, home, tooling, ["--profile", WEB_PROFILE, "--dump-config"], DUMP_MS, "web dump-config", seedLog);
    pass("seeded web baseline");
  }

  for (const space of SPACES) {
    const addLog = join(ARTIFACT, `${space.id}-plugin-add.log`);
    if (!existsSync(addLog)) writeFileSync(addLog, "", "utf8");
    if (!REUSE_HOME || !existsSync(join(home, "profiles", space.profile, "package.json"))) {
      runThemeDsh(
        nodeExe,
        bin,
        home,
        tooling,
        ["--profile", space.profile, "--from-default-profile", WEB_PROFILE, "--dump-config"],
        DUMP_MS,
        `${space.profile} from-default-profile`,
        addLog,
      );
      const isolatedPatch = join(home, "profiles", space.profile, "cordis.patch.yml");
      writeFileSync(isolatedPatch, applyIsolationPatch(readFileSync(isolatedPatch, "utf8"), space.profile, isolatedPatch), "utf8");
      const dumpSeed = runThemeDsh(nodeExe, bin, home, tooling, ["--profile", space.profile, "--dump-config"], DUMP_MS, `${space.profile} dump after isolation`, addLog);
      assertDumpPatched(dumpSeed, space.profile);
      pass(`${space.profile} session/storage isolated from web`);
      info(`dsh plugin --profile ${space.profile} add ${space.spec}`);
      runThemeDshRetry(
        nodeExe,
        bin,
        home,
        tooling,
        ["plugin", "--profile", space.profile, "add", space.spec, ...space.installArgs],
        PLUGIN_MS,
        `${space.id} plugin add`,
        addLog,
      );
    }
    const install = assertOrdinaryThemeProfile(home, space);
    const dump = runThemeDsh(nodeExe, bin, home, tooling, ["--profile", space.profile, "--dump-config"], DUMP_MS, `${space.profile} dump after add`, addLog);
    writeFileSync(join(ARTIFACT, `${space.id}-dump.txt`), dump, "utf8");
    for (const id of space.dumpIds) {
      if (!dumpHasId(dump, id)) throw new Error(`${space.profile} dump-config missing id: ${id}`);
    }
    if (dumpHasId(dump, "dsh-spaces") || dump.includes(CANONICAL_SPACES)) {
      throw new Error(`${space.profile} dump contains Spaces plugin; ordinary profile must not`);
    }
    const installedManifest = JSON.parse(
      readFileSync(join(home, "profiles", space.profile, "node_modules", ...space.packageName.split("/"), "package.json"), "utf8"),
    );
    if (installedManifest.name !== space.packageName || installedManifest.version !== space.version) {
      throw new Error(`installed ${installedManifest.name}@${installedManifest.version}, expected ${space.packageName}@${space.version}`);
    }
    pass(`${space.profile} installed only ${space.packageName}@${space.version}; no ${CANONICAL_SPACES}`);
    void install;
  }

  const webFinal = pluginSet(home, WEB_PROFILE);
  for (const space of SPACES) {
    if (webFinal.bundles.includes(space.packageName) || Object.prototype.hasOwnProperty.call(webFinal.deps, space.packageName)) {
      throw new Error(`web baseline received ${space.packageName}`);
    }
  }
  pass("web baseline has no theme packages");

  const started = [];
  const authProbe = {};
  const extraPorts = [];
  let passed = false;
  try {
    for (const space of SPACES) {
      const logPath = join(ARTIFACT, `${space.id}-dsh.log`);
      const row = await startThemeProfile(nodeExe, bin, home, tooling, space.profile, logPath);
      started.push({ ...space, ...row });
      pass(`${space.id} official DSH listening on :${row.port}`);
    }

    for (const space of started) {
      const cookie = await sessionCookie(space.launchUrl);
      authProbe[space.id] = await probeUpstreamAuth(space.launchUrl);
      if (!authProbe[space.id].cookie.httpOnly || !/^strict$/i.test(authProbe[space.id].cookie.sameSite)) {
        throw new Error(`${space.id} upstream cookie is not HttpOnly SameSite=Strict`);
      }
      if (!authProbe[space.id].cookie.nameMatchesAuthority) {
        throw new Error(`${space.id} cookie name ${authProbe[space.id].cookie.name} != ${authProbe[space.id].cookie.expectedName}`);
      }
      if (!authProbe[space.id].iframeFeasible) {
        throw new Error(`${space.id} upstream CSP/X-Frame-Options blocks iframe embed: ${JSON.stringify(authProbe[space.id].document)}`);
      }
      if (authProbe[space.id].mismatchedOrigin.status === 200) {
        throw new Error(`${space.id} DSH API accepted a mismatched Origin`);
      }
      const workspacePath = join(ARTIFACT, "workspaces", space.id);
      const created = await createEmptyWorkspaceAndSession(space.port, cookie, workspacePath);
      space.workspaceId = created.workspaceId;
      space.sessionId = created.sessionId;
      pass(`${space.id} empty workspace+session via real RPC`);
    }
    writeJson(join(ARTIFACT, "auth-probe.json"), authProbe);
    pass("upstream cookie naming and Origin/CSP iframe feasibility recorded");

    const managerPort = await ephemeralPort();
    const entryPort = await ephemeralPort();
    extraPorts.push(managerPort, entryPort);
    const internalSecret = randomBytes(24).toString("base64url");
    const entrySecret = randomBytes(24).toString("base64url");
    const statePath = join(ARTIFACT, "manager-state.json");
    const state = {
      experimental: true,
      spaces: started.map((space) => ({
        id: space.id,
        displayName: space.displayName,
        port: space.port,
        launchUrl: space.launchUrl.href,
        hash: space.hash,
      })),
    };
    writeJson(statePath, state);

    const commonEnv = {
      ...themeEnv(home, nodeExe, tooling),
      WB_INTERNAL_SECRET: internalSecret,
      WB_ENTRY_SECRET: entrySecret,
      WB_STATE_PATH: statePath,
    };
    const managerChild = spawnRole(nodeExe, "manager", {
      ...commonEnv,
      WB_ROLE: "manager",
      WB_BIND_PORT: String(managerPort),
    }, join(ARTIFACT, "manager.log"));
    const managerOrigin = `http://${HOST}:${managerPort}`;
    await waitHttpOk(`${managerOrigin}/health`, BOOT_MS, { "x-wb-internal": internalSecret, origin: managerOrigin });
    pass(`management environment listening on :${managerPort}`);

    const entryChild = spawnRole(nodeExe, "entry", {
      ...commonEnv,
      WB_ROLE: "entry",
      WB_BIND_PORT: String(entryPort),
      WB_MANAGER_ORIGIN: managerOrigin,
    }, join(ARTIFACT, "entry.log"));
    const entryOrigin = `http://${HOST}:${entryPort}`;
    await waitUntil(async () => {
      const response = await fetch(`${entryOrigin}/`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      return response.status === 200;
    }, BOOT_MS, "entry /");
    pass(`stable entry listening on :${entryPort}`);

    const ui = await runPlaywright({
      entryOrigin,
      entryPort,
      managerPort,
      managerChild,
      home,
      nodeExe,
      spaces: started,
    });

    writeJson(statePath, redactState(state));
    const result = {
      status: "pass",
      experimentalScaffold: true,
      notProduct: true,
      proved,
      skipped,
      cli: { bin, version },
      home,
      entryOrigin,
      managerPort,
      workspaces: started.map((space) => ({
        id: space.id,
        profile: space.profile,
        port: space.port,
        spec: space.spec,
        workspaceId: space.workspaceId ?? null,
        sessionId: space.sessionId ?? null,
      })),
      authProbe,
      ui,
      note: "Entry/manager HTTP is experimental scaffolding. Workspace UI is official DSH. Script PASS still needs screenshot audit.",
      at: new Date().toISOString(),
    };
    writeJson(
      RESULT_PATH,
      JSON.parse(JSON.stringify(result), (_key, value) => (typeof value === "string" ? redact(value) : value)),
    );
    passed = true;
    console.log("\nWORKBENCH FOUNDATION: PASS (experimental scaffold; screenshots still need human audit)");
  } finally {
    const ports = [...started.map((space) => space.port), ...extraPorts];
    for (const child of [...owned].reverse()) {
      await stopOwned(child).catch(() => undefined);
    }
    const stillOpen = [];
    for (const port of ports) {
      try {
        await waitPortClosed(port, PORT_MS);
        pass(`owned port :${port} closed`);
      } catch (error) {
        stillOpen.push(port);
        console.error(`FAIL  port :${port} still open: ${redact(error instanceof Error ? error.message : String(error))}`);
      }
    }
    if (passed && stillOpen.length) {
      throw new Error(`owned ports still open after cleanup: ${stillOpen.join(", ")}`);
    }
  }
}

const role = process.env.WB_ROLE;
if (role === "manager") {
  runManagerServer().catch((error) => {
    console.error(`FAIL  manager: ${redact(error instanceof Error ? error.stack || error.message : String(error))}`);
    process.exit(1);
  });
} else if (role === "entry") {
  runEntryServer().catch((error) => {
    console.error(`FAIL  entry: ${redact(error instanceof Error ? error.stack || error.message : String(error))}`);
    process.exit(1);
  });
} else if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAIL  ${redact(error instanceof Error ? error.stack || error.message : String(error))}`);
    writeJson(RESULT_PATH, {
      status: "fail",
      experimentalScaffold: true,
      notProduct: true,
      proved,
      skipped,
      error: redact(error instanceof Error ? error.message : String(error)),
      at: new Date().toISOString(),
    });
    Promise.all(owned.map((child) => stopOwned(child).catch(() => undefined))).finally(() => process.exit(1));
  });
}

export { SPACES, expectedCookieName, parseSetCookie, assertCleanSubOrigin };
