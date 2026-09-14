import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MAX_SPACE_ICON_FILE_BYTES } from "../../shared/space-icon";

export const WORKBENCH_API_PREFIX = "/api/workbench/";
export const WORKBENCH_API_METHODS = [
  "state",
  "detail",
  "submit",
  "job",
  "cancel",
  "view",
  "preview",
  "plugins",
  "snapshots",
  "snapshot",
  "runtimes",
  "workbenchPackage",
  "backups",
] as const;
export type WorkbenchApiMethod = (typeof WORKBENCH_API_METHODS)[number];

const BODY_LIMIT = MAX_SPACE_ICON_FILE_BYTES;
const HOST = "127.0.0.1";

export interface ViewBootstrap {
  setCookies: string[];
  location: string;
}

export interface WorkbenchHttpRuntime {
  cookieName(): string;
  sessionCookie(): string;
  sessionEquals(value: string): boolean;
  consumeBootstrapToken(token: string): boolean;
  hostBearerEquals(value: string): boolean;
  supervisorOrigin(): string;
  managerOrigin(): string | null;
  isWorkspaceOrigin(origin: string): boolean;
  dispatch(method: WorkbenchApiMethod, payload: unknown): Promise<unknown>;
  entryPage(): string;
  viewEntry(spaceId: string, generation: string): Promise<ViewBootstrap | { status: number; message: string }>;
  mintHandoff(): string;
}

export interface WorkbenchHttpServer {
  server: Server;
  origin: string;
  close(): Promise<void>;
}

export function expectedAuthCookieName(authority: string): string {
  const digest = createHash("sha256").update(authority).digest();
  const b64 = digest.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `dsh-auth-${b64}`;
}

export function supervisorCookieName(port: number): string {
  return expectedAuthCookieName(`${HOST}:${port}`);
}

export async function startWorkbenchHttp(
  host: WorkbenchHttpRuntime,
  port = 0,
): Promise<WorkbenchHttpServer> {
  const server = createServer((req, res) => {
    void handleRequest(host, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("supervisor did not bind 127.0.0.1");
  }
  const origin = `http://${HOST}:${address.port}`;
  return {
    server,
    origin,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
        setTimeout(resolveClose, 2000).unref();
      }),
  };
}

async function handleRequest(
  host: WorkbenchHttpRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const origin = host.supervisorOrigin();
    const url = new URL(req.url ?? "/", origin);
    if (!hostAllowed(req, origin)) {
      deny(res, 403, "workbench/forbidden", "Host is not the supervisor loopback entry.");
      return;
    }
    if (req.method === "OPTIONS") {
      if (!originAllowed(req, host, { allowMissing: false })) {
        deny(res, 403, "workbench/forbidden", "Origin is not allowed.");
        return;
      }
      res.writeHead(204, corsHeaders(req, host));
      res.end();
      return;
    }

    if (url.pathname === "/bootstrap" || url.pathname.startsWith("/bootstrap/")) {
      if (req.method !== "GET") {
        deny(res, 405, "workbench/invalid-input", "Use GET to exchange a bootstrap token.");
        return;
      }
      const token = url.pathname.startsWith("/bootstrap/")
        ? decodeURIComponent(url.pathname.slice("/bootstrap/".length))
        : url.searchParams.get("token") ?? "";
      exchangeBootstrap(host, req, res, token);
      return;
    }
    if (url.pathname === "/" && url.searchParams.has("token")) {
      if (req.method !== "GET") {
        deny(res, 405, "workbench/invalid-input", "Use GET to exchange a bootstrap token.");
        return;
      }
      exchangeBootstrap(host, req, res, url.searchParams.get("token") ?? "");
      return;
    }

    if (url.pathname === "/internal/bootstrap" && req.method === "POST") {
      handleInternalBootstrap(host, req, res);
      return;
    }

    if (url.pathname.startsWith("/view/")) {
      if (req.method !== "GET") {
        deny(res, 405, "workbench/invalid-input", "View entry is GET only.");
        return;
      }
      await handleView(host, req, res, url);
      return;
    }

    if (url.pathname.startsWith(WORKBENCH_API_PREFIX)) {
      await handleApi(host, req, res, url);
      return;
    }

    if (url.pathname === "/" && req.method === "GET") {
      if (!sessionOk(host, req)) {
        res.writeHead(401, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end(unauthPage());
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": entryCsp(),
      });
      res.end(host.entryPage());
      return;
    }

    if (looksLikeProxy(url)) {
      deny(res, 404, "workbench/not-found", "Arbitrary URL proxying is not allowed.");
      return;
    }
    deny(res, 404, "workbench/not-found", "That supervisor route was not found.");
  } catch {
    deny(res, 500, "workbench/failed", "The supervisor request failed.");
  }
}

async function handleApi(
  host: WorkbenchHttpRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== "POST") {
    deny(res, 405, "workbench/invalid-input", "Workbench API methods are POST JSON.");
    return;
  }
  const method = url.pathname.slice(WORKBENCH_API_PREFIX.length);
  if (!isApiMethod(method)) {
    deny(res, 404, "workbench/not-found", "Unknown workbench method.");
    return;
  }
  const auth = authenticate(host, req);
  if (auth === "unauthorized") {
    deny(res, 401, "workbench/unauthorized", "Authentication is required.");
    return;
  }
  if (auth === "workspace") {
    deny(res, 403, "workbench/forbidden", "Workspace origins cannot call management APIs.");
    return;
  }
  if (auth === "foreign") {
    deny(res, 403, "workbench/forbidden", "Origin is not allowed.");
    return;
  }
  let payload: unknown;
  try {
    payload = await readJsonBody(req, BODY_LIMIT);
  } catch (error) {
    if (error instanceof BodyLimitError) {
      deny(res, 413, "workbench/invalid-input", "The request body is too large.");
      return;
    }
    deny(res, 400, "workbench/invalid-input", "The request is not valid JSON.");
    return;
  }
  try {
    const value = await host.dispatch(method, payload);
    json(res, 200, { ok: true, value }, corsHeaders(req, host));
  } catch (error) {
    const mapped = publicError(error);
    json(res, 200, { ok: false, error: mapped }, corsHeaders(req, host));
  }
}

async function handleView(
  host: WorkbenchHttpRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.headers["sec-fetch-site"] === "cross-site") {
    deny(res, 403, "workbench/forbidden", "Cross-site view entry is denied.");
    return;
  }
  if (!sessionOk(host, req) && !hostBearerOk(host, req)) {
    deny(res, 401, "workbench/unauthorized", "Authentication is required.");
    return;
  }
  const requestOrigin = headerOrigin(req);
  if (requestOrigin && !originAllowed(req, host, { allowMissing: true })) {
    deny(res, 403, "workbench/forbidden", "Origin is not allowed.");
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "view") {
    deny(res, 404, "workbench/not-found", "That view entry was not found.");
    return;
  }
  const spaceId = decodeURIComponent(parts[1] ?? "");
  const generation = decodeURIComponent(parts[2] ?? "");
  const result = await host.viewEntry(spaceId, generation);
  if ("status" in result) {
    deny(res, result.status, "workbench/forbidden", result.message);
    return;
  }
  sendChildBootstrap(res, result);
}

function handleInternalBootstrap(
  host: WorkbenchHttpRuntime,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!hostBearerOk(host, req)) {
    deny(res, 401, "workbench/unauthorized", "Authentication is required.");
    return;
  }
  const origin = headerOrigin(req);
  if (origin && origin !== host.supervisorOrigin() && origin !== host.managerOrigin()) {
    deny(res, 403, "workbench/forbidden", "Origin is not allowed.");
    return;
  }
  if (origin && host.isWorkspaceOrigin(origin)) {
    deny(res, 403, "workbench/forbidden", "Workspace origins cannot mint entry handoff.");
    return;
  }
  json(res, 200, { url: host.mintHandoff() }, corsHeaders(req, host));
}

function exchangeBootstrap(
  host: WorkbenchHttpRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): void {
  if (req.headers["sec-fetch-site"] === "cross-site") {
    deny(res, 403, "workbench/forbidden", "Cross-site bootstrap is denied.");
    return;
  }
  const requestOrigin = headerOrigin(req);
  if (requestOrigin && requestOrigin !== host.supervisorOrigin()) {
    deny(res, 403, "workbench/forbidden", "Origin is not allowed.");
    return;
  }
  if (!token || !host.consumeBootstrapToken(token)) {
    deny(res, 401, "workbench/unauthorized", "The bootstrap token is invalid or already used.");
    return;
  }
  res.writeHead(303, {
    location: "/",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "set-cookie": `${host.cookieName()}=${host.sessionCookie()}; Path=/; HttpOnly; SameSite=Strict`,
  });
  res.end();
}

function authenticate(
  host: WorkbenchHttpRuntime,
  req: IncomingMessage,
): "ok" | "unauthorized" | "foreign" | "workspace" {
  if (hostBearerOk(host, req)) return "ok";
  if (!sessionOk(host, req)) return "unauthorized";
  const origin = headerOrigin(req);
  if (!origin) {
    if (req.headers["sec-fetch-site"] === "cross-site") return "foreign";
    return "ok";
  }
  if (origin === host.supervisorOrigin() || origin === host.managerOrigin()) return "ok";
  if (host.isWorkspaceOrigin(origin)) return "workspace";
  return "foreign";
}

function originAllowed(
  hostReq: IncomingMessage,
  host: WorkbenchHttpRuntime,
  options: { allowMissing: boolean },
): boolean {
  const origin = headerOrigin(hostReq);
  if (!origin) return options.allowMissing;
  return origin === host.supervisorOrigin() || origin === host.managerOrigin();
}

function sessionOk(host: WorkbenchHttpRuntime, req: IncomingMessage): boolean {
  const value = cookieValue(req.headers.cookie, host.cookieName());
  return Boolean(value && host.sessionEquals(value));
}

function hostBearerOk(host: WorkbenchHttpRuntime, req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return host.hostBearerEquals(header.slice("Bearer ".length));
}

function hostAllowed(req: IncomingMessage, origin: string): boolean {
  const expected = new URL(origin);
  const raw = req.headers.host;
  if (typeof raw !== "string" || !raw) return false;
  try {
    const parsed = new URL(`http://${raw}`);
    return parsed.hostname === HOST && parsed.port === expected.port;
  } catch {
    return false;
  }
}

function headerOrigin(req: IncomingMessage): string | null {
  const raw = req.headers.origin;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== HOST || url.username || url.password) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search || url.hash) return null;
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

function isApiMethod(value: string): value is WorkbenchApiMethod {
  return (WORKBENCH_API_METHODS as readonly string[]).includes(value);
}

function looksLikeProxy(url: URL): boolean {
  if (url.pathname.startsWith("/proxy")) return true;
  if (url.searchParams.has("url")) return true;
  if (/https?:/i.test(url.pathname)) return true;
  return false;
}

export function cookieValue(header: string | string[] | undefined, name: string): string | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join("; ") : header;
  for (const segment of raw.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1) continue;
    if (segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return null;
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

class BodyLimitError extends Error {
  readonly name = "BodyLimitError";
}

function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] ?? "");
    if (type && !type.toLowerCase().startsWith("application/json")) {
      reject(new Error("content-type"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new BodyLimitError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("json"));
      }
    });
    req.on("error", reject);
  });
}

function corsHeaders(req: IncomingMessage, host: WorkbenchHttpRuntime): Record<string, string> {
  const origin = headerOrigin(req);
  const allowed =
    origin && (origin === host.supervisorOrigin() || origin === host.managerOrigin()) ? origin : "";
  if (!allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    vary: "Origin",
  };
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function deny(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { ok: false, error: { code, message } });
}

function publicError(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const code = String((error as { code: unknown }).code);
    const message = String((error as { message: unknown }).message);
    if (code.startsWith("workbench/") || code.startsWith("spaces/")) {
      return { code, message };
    }
  }
  return { code: "workbench/failed", message: "The workbench request failed." };
}

function sendChildBootstrap(res: ServerResponse, minted: ViewBootstrap): void {
  const dest = minted.location;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "set-cookie": minted.setCookies,
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  });
  const safe = dest.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  res.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>space</title>
</head>
<body>
<p>正在进入工作空间…</p>
<script>location.replace(${JSON.stringify(dest)});</script>
</body>
</html>`);
}

function entryCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' http://127.0.0.1:*",
  ].join("; ");
}

function unauthPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>DSH Spaces</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh}
main{max-width:36rem;padding:2rem}
</style>
</head>
<body>
<main>
<h1>需要一次性引导</h1>
<p>请从监督进程给出的引导地址打开工作台。此页不会启动或代理任意地址。</p>
</main>
</body>
</html>`;
}

export function renderEntryPage(_input: {
  managerRunning: boolean;
  managerViewPath: string | null;
  maintenance: boolean;
  recoveryRequired: boolean;
  writable: boolean;
  reasons: string[];
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>DSH Spaces</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0e1014;color:#e8eaed;font:14px/1.45 "Segoe UI",system-ui,sans-serif}
#shell{display:flex;flex-direction:column;height:100%}
#banner,#jobs{display:none;padding:.6rem 1rem;background:#1b1f2a;border-bottom:1px solid #2a3142}
body[data-chrome="1"] #banner,body[data-jobs="1"] #jobs{display:block}
#banner strong{display:block;margin-bottom:.25rem}
.job{display:flex;gap:.75rem;margin:.35rem 0}
.job b{min-width:7rem}
iframe{flex:1;border:0;width:100%;background:#000}
#recovery{display:none;padding:1.5rem;max-width:48rem}
body[data-mode="recovery"] #recovery{display:block}
body[data-mode="live"] #recovery{display:none}
#error{display:none;padding:.5rem 1rem;background:#3b1d1d;color:#fecaca}
button{background:#3b82f6;color:#fff;border:0;border-radius:6px;padding:.45rem .8rem;margin-right:.5rem;cursor:pointer}
button.secondary{background:#334155}
ul{padding-left:1.2rem}
</style>
</head>
<body data-mode="recovery">
<div id="shell">
<div id="error"></div>
<div id="banner"><strong id="banner-title">稳定入口</strong><span id="banner-sub"></span></div>
<div id="jobs"><div id="job-list"></div></div>
<iframe id="manager-frame" title="spaces-hub" hidden></iframe>
<main id="recovery">
<h1 id="recovery-title">救援入口</h1>
<p>监督进程不随管理 profile 停机。关闭浏览器标签不会停止已启动的工作空间。</p>
<ul id="reasons"></ul>
<p>
<button id="acquire">接管运行权</button>
<button id="resume" class="secondary">检查并恢复</button>
<button id="refresh" class="secondary">刷新</button>
</p>
</main>
</div>
<script>
const api = (method, payload = {}) => fetch(${JSON.stringify(WORKBENCH_API_PREFIX)} + method, {
  method: "POST",
  credentials: "include",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
}).then(async (response) => {
  const body = await response.json();
  if (!body || body.ok !== true) throw new Error((body && body.error && body.error.message) || "request failed");
  return body.value;
});
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
function showError(message) {
  const el = document.getElementById("error");
  if (!message) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "block";
  el.textContent = message;
}
function renderJobs(jobs) {
  const el = document.getElementById("job-list");
  if (!jobs || !jobs.length) { el.textContent = "没有进行中的任务。"; return; }
  el.innerHTML = jobs.map((job) =>
    '<div class="job"><b>' + escapeHtml(job.status) + '</b><span>' +
    escapeHtml(job.kind) + " · " + escapeHtml(job.phase || "") + " · " +
    escapeHtml(job.message || "") + "</span></div>"
  ).join("");
}
function visibleJobs(jobs) {
  return (jobs || []).some((job) =>
    job.status === "queued" || job.status === "running" ||
    job.status === "recovery-required" || job.status === "failed");
}
function applyState(state) {
  const manager = (state.spaces || []).find((row) => row.id === state.managerId);
  const live = Boolean(manager && manager.status === "running" && !state.maintenance && !state.recoveryRequired);
  const jobs = state.jobs || [];
  const active = state.maintenance || visibleJobs(jobs);
  document.body.dataset.mode = live ? "live" : "recovery";
  document.body.dataset.chrome = (!live || active || state.recoveryRequired) ? "1" : "0";
  document.body.dataset.jobs = active ? "1" : "0";
  document.getElementById("banner-title").textContent = live ? "工作台入口在线" : "管理环境不可用，稳定入口仍在线";
  document.getElementById("banner-sub").textContent = state.writable
    ? (state.maintenance ? "维护进行中" : "当前进程持有运行权")
    : "只读。接管前不会安装或启动管理环境。";
  document.getElementById("recovery-title").textContent = state.recoveryRequired ? "需要恢复" : state.maintenance ? "维护中" : "救援入口";
  document.getElementById("reasons").innerHTML = (state.reasons || []).length
    ? state.reasons.map((row) => "<li>" + escapeHtml(row) + "</li>").join("")
    : "<li>管理进程未在运行。可查看任务进度或接管运行权。</li>";
  document.getElementById("acquire").disabled = Boolean(state.writable);
  renderJobs(jobs);
  const frame = document.getElementById("manager-frame");
  if (live) {
    const src = "/view/" + encodeURIComponent(manager.id) + "/" + manager.generation;
    frame.hidden = false;
    if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
  } else {
    frame.removeAttribute("src");
    frame.hidden = true;
  }
}
async function refresh() {
  try {
    const state = await api("state");
    showError("");
    applyState(state);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}
document.getElementById("refresh").addEventListener("click", () => { void refresh(); });
document.getElementById("acquire").addEventListener("click", async () => {
  try {
    await api("submit", { command: { kind: "controller.acquire" }, requestId: crypto.randomUUID() });
    await refresh();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
});
document.getElementById("resume").addEventListener("click", async () => {
  try {
    const submitted = await api("submit", { command: { kind: "recovery.resume" }, requestId: crypto.randomUUID() });
    let current = submitted;
    for (let i = 0; i < 120; i += 1) {
      if (current.status !== "queued" && current.status !== "running") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      current = await api("job", { id: submitted.id });
    }
    await refresh();
    if (current.status !== "succeeded") {
      showError(current.message || (current.error && current.error.message) || "Recovery is still required.");
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    await refresh();
  }
});
void refresh();
setInterval(() => { void refresh(); }, 1000);
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
