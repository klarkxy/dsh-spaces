import { randomBytes } from "node:crypto";
import { browserProtocolScript } from "../../../shared/browser-guest";
import { parseSpaceHostAudience, parsePortalSnapshot, parsePortalFailure, nativePortalFailureHash,
  parseNativeCreateIntent, PORTAL_FAILURE_REASONS, PORTAL_FAILURE_CODES, NATIVE_PORTAL_FAILURE_HASH_LIMIT,
  type SpaceHostAudience } from "../../../shared/space-host";

/** Bounded, process-local, audience-bound entry grants. No disk state or cross-restart replay. */
export class WorkbenchPortalGrants {
  private readonly tickets = new Map<string, { audience: SpaceHostAudience; expires: number }>();
  private readonly pages = new Map<string, { audience: SpaceHostAudience; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  private prune(): void {
    for (const table of [this.tickets, this.pages]) for (const [id, row] of table) {
      if (row.expires <= this.now()) table.delete(id);
    }
  }
  mint(value: unknown): string {
    const audience = parseSpaceHostAudience(value);
    if (!audience) throw new Error("Invalid or unsupported space-host audience.");
    this.prune();
    if (this.tickets.size + this.pages.size >= 128) throw new Error("Too many space-host entries.");
    if (this.pages.has(audience.channel) || [...this.tickets.values()].some(row => row.audience.channel === audience.channel)) {
      throw new Error("Space-host channel already exists.");
    }
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { audience, expires: this.now() + 60_000 });
    return ticket;
  }
  consume(ticket: string): SpaceHostAudience | null {
    this.prune();
    const row = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!row) return null;
    this.pages.set(row.audience.channel, { audience: row.audience, expires: this.now() + 300_000 });
    return { ...row.audience };
  }
  page(channel: string): SpaceHostAudience | null {
    this.prune();
    const row = this.pages.get(channel);
    return row ? { ...row.audience } : null;
  }
}

export function portalCsp(audience: SpaceHostAudience, managerOrigin: string): string {
  const valid = parseSpaceHostAudience(audience);
  if (!valid || !parseSpaceHostAudience({ parentOrigin: managerOrigin, channel: valid.channel })) {
    throw new Error("Invalid space-host audience or manager.");
  }
  return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' "
    + managerOrigin + "; frame-ancestors " + valid.parentOrigin;
}

/**
 * The outer application receives navigation metadata, never credentials or a management API.
 * Keep the actual manager and its children in their existing origin chain. A parent selection
 * only opens an already-running view; management remains an explicit action inside the manager.
 */
export function renderPortalPage(audience: SpaceHostAudience, managerOrigin: string, native = false): string {
  portalCsp(audience, managerOrigin);
  const config = JSON.stringify({ ...audience, managerOrigin }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Spaces presentation</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}#status{font:14px system-ui;padding:20px}</style></head><body><div id="status" role="status">Spaces</div><script>
"use strict";
const audience = ${config};
const native = ${JSON.stringify(native)};
const failureCodes = ${JSON.stringify(PORTAL_FAILURE_CODES)};
const PORTAL_FAILURE_REASONS = ${JSON.stringify(PORTAL_FAILURE_REASONS)};
const PORTAL_FAILURE_CODES = failureCodes;
const NATIVE_PORTAL_FAILURE_HASH_LIMIT = ${NATIVE_PORTAL_FAILURE_HASH_LIMIT};
const parsePortalFailure = ${parsePortalFailure.toString()};
const nativePortalFailureHash = ${nativePortalFailureHash.toString()};
const parseSnapshot = ${parsePortalSnapshot.toString()};
const parseNativeCreateIntent = ${parseNativeCreateIntent.toString()};
${browserProtocolScript()}
let lastNativeRequest = 0, lastNativeIntent = 0;
let lastNativeTarget = null;
let browserRequest = null;
let stopped = false, reading = false, preparing = false, timer, selectionTimer, readyTimer;
let snapshot = null, managerView = null, frame = null, managerReady = false, viewReady = false, surfaceReady = false, pending = null, forwarded = null;
const lifetime = new AbortController();
const send = (type, extra = {}) => {
  if (stopped) return;
  if (native) {
    if (type === "failed") location.replace(nativePortalFailureHash(extra.failure) || "#failed");
    else if (type === "selected" || type === "selection-failed") {
      const target = extra.spaceId ?? pending?.spaceId;
      if (target && location.hash === "#select/" + extra.requestId + "/" + target) location.replace("#" + (type === "selected" ? "selected" : "rejected") + "/" + extra.requestId + "/" + target);
    }
  } else parent.postMessage({ source: "dsh-spaces-portal", channel: audience.channel, type, ...extra }, audience.parentOrigin);
};
const fail = (reason, diagnostic = {}) => {
  if (stopped) return;
  send("failed", { failure: { reason,
    ...(failureCodes.includes(diagnostic.code) ? { code: diagnostic.code } : {}),
    ...(Number.isInteger(diagnostic.status) && diagnostic.status >= 100 && diagnostic.status <= 599 ? { status: diagnostic.status } : {}) } });
  stopped = true; lifetime.abort(); clearInterval(timer); clearTimeout(selectionTimer); clearTimeout(readyTimer); if (frame) frame.remove();
};
class RequestFailure extends Error {
  constructor(diagnostic) { super("Portal request failed"); this.diagnostic = diagnostic; }
}
async function api(method, payload) {
  const deadline = AbortSignal.timeout(10000);
  let status;
  try {
  const response = await fetch("/api/workbench/" + method, {
    method: "POST", credentials: "include", redirect: "error",
    headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    signal: AbortSignal.any([lifetime.signal, deadline])
  });
  status = response.status;
  if (!response.body) throw new RequestFailure({ status, ...(response.ok ? { code: "portal/response-invalid" } : {}) });
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new RequestFailure({ status, code: "portal/response-invalid" });
      try { text += decoder.decode(chunk.value, { stream: true }); }
      catch { throw new RequestFailure({ status, code: "portal/response-invalid" }); }
    }
    try { text += decoder.decode(); }
    catch { throw new RequestFailure({ status, code: "portal/response-invalid" }); }
  } finally { await reader.cancel().catch(() => {}); }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new RequestFailure({ status, ...(response.ok ? { code: "portal/response-invalid" } : {}) }); }
  if (!response.ok || data?.ok === false) {
    throw new RequestFailure({ status, ...(failureCodes.includes(data?.error?.code) ? { code: data.error.code } : {}) });
  }
  if (!data || data.ok !== true || !Object.hasOwn(data, "value")) throw new RequestFailure({ status, code: "portal/response-invalid" });
  return data.value;
  } catch (error) {
    if (error instanceof RequestFailure) throw error;
    throw new RequestFailure({ ...(status === undefined ? {} : { status }),
      code: deadline.aborted ? "portal/request-deadline" : "portal/transport-failed" });
  }
}
async function refresh() {
  if (stopped || reading) return;
  reading = true;
  try {
    const state = await api("state", {});
    if (stopped) return;
    if (!state || state.protocolVersion !== 2 || !["ready", "limited", "unavailable"].includes(state.availability) ||
        !Array.isArray(state.spaces) || state.spaces.length > 1000 ||
        state.spaces.some(row => !row || typeof row !== "object" || Array.isArray(row) || typeof row.hasWebApp !== "boolean")) {
      fail("state-invalid"); return;
    }
    // Validate every projected row before publishing presentation data to the host.
    const all = parseSnapshot({ serviceEpoch: state.serviceEpoch, managerId: state.managerId,
      spaces: state.spaces.map(row => ({ id: row.id, displayName: row.displayName, status: row.status,
        generation: row.generation, ...(row.icon === undefined ? {} : { icon: row.icon }) })) });
    if (!all) { fail("state-invalid"); return; }
    if (snapshot && snapshot.serviceEpoch !== state.serviceEpoch) { fail("service-changed"); return; }
    const previousManager = managerView || snapshot?.spaces.find(row => row.id === snapshot.managerId);
    const manager = all.spaces.find(row => row.id === state.managerId);
    if (!manager) { fail("manager-stopped"); return; }
    if (previousManager && (state.managerId !== (managerView?.spaceId || previousManager.id) ||
        manager.generation !== previousManager.generation)) { fail("manager-generation-changed"); return; }
    if (manager.status !== "running") { fail("manager-stopped"); return; }
    if (state.availability === "unavailable") { fail("state-request", { code: "workbench/unavailable" }); return; }
    snapshot = { ...all, spaces: all.spaces.filter(row => state.spaces.find(item => item.id === row.id).hasWebApp) };
    send("state", { snapshot });
    if (native) nativeSelection();
  } catch (error) { fail(error instanceof RequestFailure && error.diagnostic.code !== "portal/response-invalid" ? "state-request" : "state-invalid",
    error instanceof RequestFailure ? error.diagnostic : {}); } finally { reading = false; }
}
const rejected = (requestId, spaceId = pending?.spaceId) => send("selection-failed", { requestId, ...(native ? { spaceId } : {}) });
function forwardSelection() {
  if (!managerReady || !frame || !pending || stopped || forwarded === pending) return;
  const request = pending;
  forwarded = request;
  frame.contentWindow.postMessage({ source: "dsh-spaces-surface-parent", type: "select", requestId: request.requestId,
    serviceEpoch: managerView.serviceEpoch, spaceId: managerView.spaceId, generation: managerView.generation,
    channel: managerView.channel, target: request.spaceId }, audience.managerOrigin);
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => { if (pending === request) { pending = null; rejected(request.requestId, request.spaceId); } }, 35000);
}
async function ensureManager() {
  if (frame || preparing || stopped) return;
  const row = snapshot && snapshot.spaces.find(item => item.id === snapshot.managerId && item.status === "running");
  if (!row) { if (pending) rejected(pending.requestId); pending = null; return; }
  preparing = true;
  try {
    const view = await api("view", { spaceId: row.id });
    if (stopped) return;
    if (!view || view.spaceId !== row.id || view.generation !== row.generation || view.serviceEpoch !== snapshot.serviceEpoch ||
        view.entryOrigin !== location.origin || view.origin !== audience.managerOrigin ||
        view.entryPath !== "/view/" + row.id + "/" + row.generation ||
        typeof view.channel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(view.channel)) { fail("manager-view-invalid"); return; }
    managerView = view;
    frame = document.createElement("iframe");
    frame.title = "Spaces workbench";
    frame.referrerPolicy = "no-referrer";
    // /view starts on the Supervisor and navigates to the verified manager.
    // A bare directive defaults to the initial src origin, which excludes it.
    frame.allow = "clipboard-write " + view.origin;
    frame.src = view.entryOrigin + view.entryPath + "?epoch=" + encodeURIComponent(view.serviceEpoch) + "&dsh-spaces-contained=1" + (native ? "&dsh-spaces-native=1" : "");
    frame.addEventListener("load", () => {
      if (stopped) return;
      frame.contentWindow.postMessage({ source: "dsh-spaces-view-parent", type: "ping", serviceEpoch: view.serviceEpoch,
        spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.origin);
    });
    document.getElementById("status").remove(); document.body.append(frame);
    readyTimer = setTimeout(() => { if (!managerReady) fail("view-ready-timeout"); }, 35000);
  } catch (error) { fail(error instanceof RequestFailure && error.diagnostic.code !== "portal/response-invalid" ? "manager-view-request" : "manager-view-invalid",
    error instanceof RequestFailure ? error.diagnostic : {}); } finally { preparing = false; }
}
window.addEventListener("message", event => {
  if (stopped) return;
  const message = event.data;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (native && managerReady && frame && event.source === frame.contentWindow && event.origin === audience.managerOrigin) {
    const relay = parseBrowserRelay(message);
    if (relay) {
      const identity = relay.identity;
      const row = snapshot?.spaces.find(row => row.id === identity.spaceId && row.id !== snapshot.managerId &&
        row.status === "running" && row.generation === identity.generation);
      if (!row || identity.serviceEpoch !== snapshot.serviceEpoch) return;
      if (relay.kind === "hide") {
        browserRequest = null;
        if (!pending) location.replace(nativeBrowserFragment("browser", relay));
      } else if (!pending) {
        const rect = frame.getBoundingClientRect();
        // Manager coordinates are relative to its frame, never the outer Desktop window.
        const viewport = relay.viewport;
        if (viewport.x + viewport.width > rect.width + 1 || viewport.y + viewport.height > rect.height + 1) return;
        browserRequest = relay.requestId;
        location.replace(nativeBrowserFragment("browser", relay));
      }
      return;
    }
  }
  if (frame && event.source === frame.contentWindow && event.origin === audience.managerOrigin && managerView &&
      message.serviceEpoch === managerView.serviceEpoch && message.spaceId === managerView.spaceId &&
      message.generation === managerView.generation && message.channel === managerView.channel) {
    if (message.source === "dsh-spaces-view") {
      const keys = Object.keys(message).sort().join(",");
      if (!["channel,generation,serviceEpoch,source,spaceId,state", "channel,generation,message,serviceEpoch,source,spaceId,state"].includes(keys) ||
          ("message" in message && typeof message.message !== "string")) return;
      if (message.state === "ready") { viewReady = true; managerReady = surfaceReady; if (managerReady) { clearTimeout(readyTimer); forwardSelection(); } }
      else if (message.state === "failed") fail("manager-view-failed");
      else if (message.state === "disconnected") fail("manager-disconnected");
    } else if (message.source === "dsh-spaces-surface" && message.type === "ready") {
      if (Object.keys(message).sort().join(",") !== "channel,generation,serviceEpoch,source,spaceId,type") return;
      surfaceReady = true; managerReady = viewReady;
      if (managerReady) { clearTimeout(readyTimer); forwardSelection(); }
    } else if (message.source === "dsh-spaces-surface" && pending && message.requestId === pending.requestId) {
      if (Object.keys(message).sort().join(",") !== "channel,generation,requestId,serviceEpoch,source,spaceId,target,type") return;
      if (message.type === "selected" && message.target === pending.spaceId) {
        send("selected", { requestId: pending.requestId, spaceId: pending.spaceId });
        // The completed selection decides which further fragment may follow.
        lastNativeTarget = pending.spaceId; pending = null; clearTimeout(selectionTimer);
      } else if (message.type === "selection-failed") {
        rejected(pending.requestId); lastNativeTarget = null; pending = null; clearTimeout(selectionTimer);
      }
    }
    return;
  }
  if (native || event.source !== parent || event.origin !== audience.parentOrigin ||
      Object.keys(message).sort().join(",") !== "channel,requestId,source,spaceId,type" ||
      message.source !== "dsh-spaces-portal-parent" || message.channel !== audience.channel || message.type !== "select" ||
      !Number.isSafeInteger(message.requestId) || message.requestId < 1 ||
      !(message.spaceId === null || typeof message.spaceId === "string" && /^[a-z0-9][a-z0-9-]{0,38}$/.test(message.spaceId))) return;
  // Cached status can lag a completed start/restart. The manager authorizes current running state.
  const allowed = snapshot && (message.spaceId === null || snapshot.spaces.some(row => row.id === message.spaceId && row.id !== snapshot.managerId));
  if (!allowed) { rejected(message.requestId); return; }
  pending = { requestId: message.requestId, spaceId: message.spaceId };
  if (managerReady) forwardSelection(); else void ensureManager();
});
function nativeSelection() {
  if (!native || stopped || !snapshot) return;
  const result = parseNativeBrowserFragment(location.hash, "browser-result");
  if (result) {
    if (result.requestId === browserRequest && frame && managerReady && !pending) {
      browserRequest = null;
      frame.contentWindow.postMessage(result, audience.managerOrigin);
    }
    return;
  }
  const intent = parseNativeCreateIntent(location.hash);
  if (intent !== null) { forwardCreateIntent(intent); return; }
  const match = location.hash.split("/");
  if (match.length !== 3 || match[0] !== "#select" || !/^[1-9][0-9]{0,9}$/.test(match[1]) ||
      !/^(@settings|[a-z0-9][a-z0-9-]{0,38})$/.test(match[2]) || Number(match[1]) <= lastNativeRequest) return;
  const requestId = Number(match[1]), target = match[2]; lastNativeRequest = requestId;
  browserRequest = null;
  const allowed = target === "@settings" || snapshot.spaces.some(row => row.id === target && row.id !== snapshot.managerId);
  if (!allowed) { send("selection-failed", {requestId, spaceId: target}); return; }
  pending = {requestId, spaceId: target};
  if (managerReady) forwardSelection(); else void ensureManager();
}
/**
 * The desktop shell asks the manager for a new space through this closed
 * fragment. Only a completed settings selection may carry it and every id is
 * used once. The portal forwards that request and nothing else: it never
 * navigates, starts or mutates anything for it.
 */
function forwardCreateIntent(requestId) {
  if (requestId <= lastNativeIntent) return;
  lastNativeIntent = requestId;
  if (!managerReady || !frame || !managerView || pending || lastNativeTarget !== "@settings") return;
  frame.contentWindow.postMessage({ source: "dsh-spaces-surface-parent", type: "intent", intent: "create", requestId,
    serviceEpoch: managerView.serviceEpoch, spaceId: managerView.spaceId, generation: managerView.generation,
    channel: managerView.channel }, audience.managerOrigin);
}
if (native) window.addEventListener("hashchange", nativeSelection);
window.addEventListener("pagehide", () => { stopped = true; lifetime.abort(); clearInterval(timer); clearTimeout(selectionTimer); clearTimeout(readyTimer); });
void refresh();
timer = setInterval(() => { void refresh(); }, 1500);
</script></body></html>`;
}
