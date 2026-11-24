/** Bounded first-navigation diagnostics. Console only; never credentials, URLs, or product control. */

export const NAV_DIAG_TAG = "dsh-spaces-nav-diag";
export const NAV_DIAG_VERSION = 1;

const SOURCES = ["controller", "portal", "bootstrap"] as const;
const EVENTS = [
  "user-select", "return-target", "bridge-acquired", "guest-created", "guest-dom-ready", "guest-load-stopped",
  "bootstrap-load-start", "bootstrap-load-complete", "bootstrap-load-reject",
  "select-load-start", "select-load-complete", "select-load-reject",
  "did-start-navigation", "did-frame-navigate", "did-navigate-in-page", "did-fail-load",
  "ready", "fail", "deadline", "destroyed", "truncated",
  "document-start", "api-request", "api-result", "iframe-append", "iframe-load",
  "view-ready", "surface-ready", "select-receive", "select-forward", "select-result", "terminal",
  "script-run", "replace-call",
] as const;
const ROUTES = ["about-blank", "bootstrap", "native-portal", "view-entry", "loopback-other", "other", "invalid"] as const;
const HASH_KINDS = ["none", "select", "selected", "rejected", "failed", "intent", "service-stop-preview", "browser", "other"] as const;
const TARGET_KINDS = ["settings", "space", "none"] as const;
const STAGES = ["state", "view", "selection"] as const;
const RESULTS = ["selected", "rejected"] as const;
const REASONS = [
  "state-request", "state-invalid", "service-changed", "manager-generation-changed",
  "manager-stopped", "manager-view-request", "manager-view-invalid", "manager-view-failed",
  "manager-disconnected", "view-ready-timeout", "portal-entry-timeout",
] as const;
const CODES = [
  "workbench/unauthorized", "workbench/forbidden", "workbench/unavailable",
  "workbench/invalid-input", "workbench/not-found", "workbench/failed",
  "workbench/unsupported", "workbench/busy", "workbench/conflict", "workbench/incompatible",
  "workbench/locked", "workbench/maintenance", "workbench/protected", "workbench/read-only",
  "workbench/recovery-required", "workbench/unmanaged",
  "portal/request-deadline", "portal/transport-failed", "portal/response-invalid",
] as const;

export type NavDiagSource = typeof SOURCES[number];
export type NavDiagEvent = typeof EVENTS[number];
export type NavDiagRoute = typeof ROUTES[number];
export type NavDiagHashKind = typeof HASH_KINDS[number];
export type NavDiagTargetKind = typeof TARGET_KINDS[number];
export interface NavDiagRecord {
  v: 1;
  src: NavDiagSource;
  seq: number;
  t: number;
  ev: NavDiagEvent;
  isMainFrame?: boolean;
  errorCode?: number;
  ignored?: boolean;
  route?: NavDiagRoute;
  hashKind?: NavDiagHashKind;
  targetKind?: NavDiagTargetKind;
  status?: number;
  accepted?: boolean;
  result?: typeof RESULTS[number];
  ok?: boolean;
  stage?: typeof STAGES[number];
  reason?: typeof REASONS[number];
  code?: typeof CODES[number];
}

export type NavDiagEmit = ((ev: string, extra?: object) => void) & { end(): void };

/**
 * Self-contained emitter for native controller and portal injection.
 * Inner helpers stay inside this function so toString() has no module closures.
 */
export function createNavDiag(source: string, sink?: (row: NavDiagRecord) => void): NavDiagEmit {
  var seq = 0, count = 0, live = true, lastElapsed = 0;
  var origin: number | undefined;
  var cap = 96;
  var src = source === "portal" || source === "bootstrap" || source === "controller" ? source : "controller";
  var events = {
    "user-select": 1, "return-target": 1, "bridge-acquired": 1, "guest-created": 1, "guest-dom-ready": 1, "guest-load-stopped": 1,
    "bootstrap-load-start": 1, "bootstrap-load-complete": 1, "bootstrap-load-reject": 1,
    "select-load-start": 1, "select-load-complete": 1, "select-load-reject": 1,
    "did-start-navigation": 1, "did-frame-navigate": 1, "did-navigate-in-page": 1, "did-fail-load": 1,
    "ready": 1, "fail": 1, "deadline": 1, "destroyed": 1, "truncated": 1,
    "document-start": 1, "api-request": 1, "api-result": 1, "iframe-append": 1, "iframe-load": 1,
    "view-ready": 1, "surface-ready": 1, "select-receive": 1, "select-forward": 1, "select-result": 1, "terminal": 1,
    "script-run": 1, "replace-call": 1
  };
  var routes = { "about-blank": 1, bootstrap: 1, "native-portal": 1, "view-entry": 1, "loopback-other": 1, other: 1, invalid: 1 };
  var hashes = { none: 1, select: 1, selected: 1, rejected: 1, failed: 1, intent: 1, "service-stop-preview": 1, browser: 1, other: 1 };
  var targets = { settings: 1, space: 1, none: 1 };
  var stages = { state: 1, view: 1, selection: 1 };
  var results = { selected: 1, rejected: 1 };
  var reasons = {
    "state-request": 1, "state-invalid": 1, "service-changed": 1, "manager-generation-changed": 1,
    "manager-stopped": 1, "manager-view-request": 1, "manager-view-invalid": 1, "manager-view-failed": 1,
    "manager-disconnected": 1, "view-ready-timeout": 1, "portal-entry-timeout": 1
  };
  var codes = {
    "workbench/unauthorized": 1, "workbench/forbidden": 1, "workbench/unavailable": 1,
    "workbench/invalid-input": 1, "workbench/not-found": 1, "workbench/failed": 1,
    "workbench/unsupported": 1, "workbench/busy": 1, "workbench/conflict": 1, "workbench/incompatible": 1,
    "workbench/locked": 1, "workbench/maintenance": 1, "workbench/protected": 1, "workbench/read-only": 1,
    "workbench/recovery-required": 1, "workbench/unmanaged": 1,
    "portal/request-deadline": 1, "portal/transport-failed": 1, "portal/response-invalid": 1
  };
  function elapsed() {
    try {
      var now;
      try {
        now = typeof performance !== "undefined" && performance && typeof performance.now === "function"
          ? performance.now() : Date.now();
      } catch (e) {
        try { now = Date.now(); } catch (e2) { now = origin; }
      }
      if (typeof now !== "number" || !Number.isFinite(now)) now = origin;
      if (origin === undefined) {
        origin = typeof now === "number" && Number.isFinite(now) ? now : 0;
        lastElapsed = 0;
        return 0;
      }
      var delta = (now ?? origin) - origin;
      if (!Number.isFinite(delta)) return lastElapsed;
      delta = Math.round(delta);
      if (delta < lastElapsed) delta = lastElapsed;
      lastElapsed = delta;
      return lastElapsed;
    } catch (e) { return lastElapsed; }
  }
  function classifyRoute(value: any) {
    if (typeof value !== "string" || !value || value.length > 4096) return "invalid";
    try {
      var u = new URL(value);
      if (u.protocol === "about:" && (u.pathname === "blank" || value.indexOf("about:blank") === 0)) return "about-blank";
      if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") return "other";
      if (/^\/bootstrap\/[A-Za-z0-9_-]{16,128}$/.test(u.pathname)) return "bootstrap";
      if (/^\/native\/[a-f0-9]{32}$/.test(u.pathname)) return "native-portal";
      if (/^\/view\/[a-z0-9][a-z0-9-]{0,38}\/[0-9]+$/.test(u.pathname)) return "view-entry";
      return "loopback-other";
    } catch (e) { return "invalid"; }
  }
  function hashOf(value: any) {
    if (typeof value !== "string") return "";
    if (value.charAt(0) === "#") return value;
    try { return new URL(value).hash || ""; } catch (e) { return ""; }
  }
  function classifyHash(value: any) {
    var hash = hashOf(value);
    if (!hash || hash === "#") return "none";
    if (/^#select\/[1-9][0-9]{0,9}\//.test(hash)) return "select";
    if (/^#selected\/[1-9][0-9]{0,9}\//.test(hash)) return "selected";
    if (/^#rejected\/[1-9][0-9]{0,9}\//.test(hash)) return "rejected";
    if (hash === "#failed" || hash.indexOf("#failed/") === 0) return "failed";
    if (/^#intent\/create\/[1-9][0-9]{0,9}$/.test(hash)) return "intent";
    if (/^#service-stop-preview\/[1-9][0-9]{0,9}$/.test(hash)) return "service-stop-preview";
    if (hash.indexOf("#browser/") === 0 || hash.indexOf("#browser-result/") === 0) return "browser";
    return "other";
  }
  function classifyTarget(value: any) {
    var match = /^#(?:select|selected|rejected)\/[1-9][0-9]{0,9}\/(@settings|[a-z0-9][a-z0-9-]{0,38})/.exec(hashOf(value));
    if (!match) return "none";
    return match[1] === "@settings" ? "settings" : "space";
  }
  function write(row: any) {
    try { console.log("dsh-spaces-nav-diag " + JSON.stringify(row)); } catch (e) {}
    if (typeof sink === "function") {
      try { sink(row); } catch (e) {}
    }
  }
  function read(extra: any, key: string) {
    try {
      if (!extra || typeof extra !== "object" || !Object.hasOwn(extra, key)) return undefined;
      return extra[key];
    } catch (e) { return undefined; }
  }
  function allowed(table: any, value: any) {
    try { return typeof value === "string" && Object.hasOwn(table, value); } catch (e) { return false; }
  }
  function pick(extra: any) {
    try {
      var out: any = {};
      var url = read(extra, "url");
      if (typeof url !== "string") url = read(extra, "href");
      if (typeof url === "string" && url) {
        out.route = classifyRoute(url);
        var hashKind = classifyHash(url);
        if (hashKind !== "none") out.hashKind = hashKind;
        var targetKind = classifyTarget(url);
        if (targetKind !== "none") out.targetKind = targetKind;
      }
      var isMainFrame = read(extra, "isMainFrame");
      if (isMainFrame === true || isMainFrame === false) out.isMainFrame = isMainFrame;
      var errorCode = read(extra, "errorCode");
      if (typeof errorCode === "number" && Number.isFinite(errorCode) && errorCode === Math.trunc(errorCode)) out.errorCode = errorCode;
      var ignored = read(extra, "ignored");
      if (ignored === true || ignored === false) out.ignored = ignored;
      var route = read(extra, "route");
      if (allowed(routes, route)) out.route = route;
      var explicitHash = read(extra, "hashKind");
      if (allowed(hashes, explicitHash)) out.hashKind = explicitHash;
      var explicitTarget = read(extra, "targetKind");
      if (allowed(targets, explicitTarget)) out.targetKind = explicitTarget;
      var status = read(extra, "status");
      if (Number.isInteger(status) && status >= 100 && status <= 599) out.status = status;
      var accepted = read(extra, "accepted");
      if (accepted === true || accepted === false) out.accepted = accepted;
      var result = read(extra, "result");
      if (allowed(results, result)) out.result = result;
      var ok = read(extra, "ok");
      if (ok === true || ok === false) out.ok = ok;
      var stage = read(extra, "stage");
      if (allowed(stages, stage)) out.stage = stage;
      var reason = read(extra, "reason");
      if (allowed(reasons, reason)) out.reason = reason;
      var code = read(extra, "code");
      if (allowed(codes, code)) out.code = code;
      return out;
    } catch (e) { return {}; }
  }
  function emit(ev: any, extra?: any) {
    try {
      if (!live) return;
      if (count >= cap - 1) {
        live = false;
        count++;
        write({ v: 1, src: src, seq: ++seq, t: elapsed(), ev: "truncated" });
        return;
      }
      if (typeof ev !== "string" || !Object.hasOwn(events, ev) || ev === "truncated") return;
      count++;
      var row = pick(extra);
      row.v = 1;
      row.src = src;
      row.seq = ++seq;
      row.t = elapsed();
      row.ev = ev;
      write(row);
    } catch (e) {}
  }
  emit.end = function () { try { live = false; } catch (e) {} };
  return emit;
}

const RECORD_KEYS = [
  "v", "src", "seq", "t", "ev", "isMainFrame", "errorCode", "ignored", "route", "hashKind",
  "targetKind", "status", "accepted", "result", "ok", "stage", "reason", "code",
] as const;

export function parseNavDiag(value: unknown): NavDiagRecord | null {
  if (typeof value !== "string") return null;
  const prefix = NAV_DIAG_TAG + " ";
  const text = value.startsWith(prefix) ? value.slice(prefix.length) : value.startsWith(NAV_DIAG_TAG)
    ? value.slice(NAV_DIAG_TAG.length).trim() : value;
  let row: unknown;
  try { row = JSON.parse(text); } catch { return null; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const rec = row as Record<string, unknown>;
  if (Object.keys(rec).some(key => !RECORD_KEYS.includes(key as typeof RECORD_KEYS[number]))) return null;
  if (rec.v !== NAV_DIAG_VERSION || !SOURCES.includes(rec.src as NavDiagSource) ||
      !EVENTS.includes(rec.ev as NavDiagEvent) || !Number.isInteger(rec.seq) || (rec.seq as number) < 1 ||
      typeof rec.t !== "number" || !Number.isFinite(rec.t) || rec.t < 0) return null;
  const out: NavDiagRecord = { v: 1, src: rec.src as NavDiagSource, seq: rec.seq as number, t: rec.t as number, ev: rec.ev as NavDiagEvent };
  if (rec.isMainFrame === true || rec.isMainFrame === false) out.isMainFrame = rec.isMainFrame;
  if (typeof rec.errorCode === "number" && Number.isFinite(rec.errorCode) && rec.errorCode === Math.trunc(rec.errorCode)) out.errorCode = rec.errorCode;
  if (rec.ignored === true || rec.ignored === false) out.ignored = rec.ignored;
  if (typeof rec.route === "string" && ROUTES.includes(rec.route as NavDiagRoute)) out.route = rec.route as NavDiagRoute;
  if (typeof rec.hashKind === "string" && HASH_KINDS.includes(rec.hashKind as NavDiagHashKind)) out.hashKind = rec.hashKind as NavDiagHashKind;
  if (typeof rec.targetKind === "string" && TARGET_KINDS.includes(rec.targetKind as NavDiagTargetKind)) out.targetKind = rec.targetKind as NavDiagTargetKind;
  if (Number.isInteger(rec.status) && (rec.status as number) >= 100 && (rec.status as number) <= 599) out.status = rec.status as number;
  if (rec.accepted === true || rec.accepted === false) out.accepted = rec.accepted;
  if (rec.result === "selected" || rec.result === "rejected") out.result = rec.result;
  if (rec.ok === true || rec.ok === false) out.ok = rec.ok;
  if (rec.stage === "state" || rec.stage === "view" || rec.stage === "selection") out.stage = rec.stage;
  if (typeof rec.reason === "string" && REASONS.includes(rec.reason as typeof REASONS[number])) out.reason = rec.reason as typeof REASONS[number];
  if (typeof rec.code === "string" && CODES.includes(rec.code as typeof CODES[number])) out.code = rec.code as typeof CODES[number];
  return out;
}

export function navDiagPortalPrelude(): string {
  return "const emitNavDiag=(function(){const __name=(fn)=>fn;return (" + createNavDiag.toString() + ')("portal");})();\ntry{emitNavDiag("document-start");}catch(e){}\n';
}

/** Static bootstrap markers. Destination and cookies stay out of these strings. */
export const NAV_DIAG_BOOTSTRAP_SCRIPT_RUN =
  'try{console.log("dsh-spaces-nav-diag "+\'{"v":1,"src":"bootstrap","seq":1,"t":0,"ev":"script-run"}\')}catch(e){}';
export const NAV_DIAG_BOOTSTRAP_REPLACE_CALL =
  'try{console.log("dsh-spaces-nav-diag "+\'{"v":1,"src":"bootstrap","seq":2,"t":0,"ev":"replace-call"}\')}catch(e){}';
