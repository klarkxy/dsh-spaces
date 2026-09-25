import { randomBytes } from "node:crypto";
import { parseSpaceHostAudience, type SpaceHostAudience } from "../../shared/space-host";

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
export function renderPortalPage(audience: SpaceHostAudience, managerOrigin: string): string {
  portalCsp(audience, managerOrigin);
  const config = JSON.stringify({ ...audience, managerOrigin }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Spaces presentation</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}#status{font:14px system-ui;padding:20px}</style></head><body><div id="status" role="status">Spaces</div><script>
"use strict";
const audience = ${config};
let stopped = false, reading = false, preparing = false, timer, selectionTimer, readyTimer;
let snapshot = null, managerView = null, frame = null, managerReady = false, viewReady = false, surfaceReady = false, pending = null;
const lifetime = new AbortController();
const send = (type, extra = {}) => {
  if (!stopped) parent.postMessage({ source: "dsh-spaces-portal", channel: audience.channel, type, ...extra }, audience.parentOrigin);
};
const fail = () => { send("failed"); stopped = true; lifetime.abort(); clearInterval(timer); clearTimeout(selectionTimer); clearTimeout(readyTimer); if (frame) frame.remove(); };
async function api(method, payload) {
  const response = await fetch("/api/workbench/" + method, {
    method: "POST", credentials: "include", redirect: "error",
    headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10000)])
  });
  if (!response.ok || !response.body) throw new Error("Request failed");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("Response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  const data = JSON.parse(text);
  if (!data || data.ok !== true) throw new Error("Request failed");
  return data.value;
}
async function refresh() {
  if (stopped || reading) return;
  reading = true;
  try {
    const state = await api("state", {});
    if (stopped) return;
    if (!state || state.protocolVersion !== 2 || state.availability === "unavailable" ||
        !Array.isArray(state.spaces) || state.spaces.length > 1000) throw new Error("Unavailable");
    if (snapshot && snapshot.serviceEpoch !== state.serviceEpoch) throw new Error("Service changed");
    if (managerView && !state.spaces.some(row => row.id === managerView.spaceId && row.generation === managerView.generation && row.status === "running")) throw new Error("Manager stopped");
    snapshot = { serviceEpoch: state.serviceEpoch, managerId: state.managerId,
      spaces: state.spaces.filter(row => row.hasWebApp).map(row => ({ id: row.id, displayName: row.displayName, status: row.status, generation: row.generation })) };
    send("state", { snapshot });
  } catch { fail(); } finally { reading = false; }
}
const rejected = requestId => send("selection-failed", { requestId });
function forwardSelection() {
  if (!managerReady || !frame || !pending || stopped) return;
  const request = pending;
  frame.contentWindow.postMessage({ source: "dsh-spaces-surface-parent", type: "select", requestId: request.requestId,
    serviceEpoch: managerView.serviceEpoch, spaceId: managerView.spaceId, generation: managerView.generation,
    channel: managerView.channel, target: request.spaceId }, audience.managerOrigin);
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => { if (pending === request) { pending = null; rejected(request.requestId); } }, 35000);
}
async function ensureManager() {
  if (frame || preparing || stopped) return;
  const row = snapshot && snapshot.spaces.find(item => item.id === snapshot.managerId && item.status === "running");
  if (!row) { if (pending) rejected(pending.requestId); pending = null; return; }
  preparing = true;
  try {
    const view = await api("view", { spaceId: row.id });
    if (stopped) return;
    if (view.spaceId !== row.id || view.generation !== row.generation || view.serviceEpoch !== snapshot.serviceEpoch ||
        view.entryOrigin !== location.origin || view.origin !== audience.managerOrigin ||
        view.entryPath !== "/view/" + row.id + "/" + row.generation ||
        typeof view.channel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(view.channel)) throw new Error("Invalid manager view");
    managerView = view;
    frame = document.createElement("iframe");
    frame.title = "Spaces workbench";
    frame.referrerPolicy = "no-referrer";
    frame.allow = "clipboard-write";
    frame.src = view.entryOrigin + view.entryPath + "?epoch=" + encodeURIComponent(view.serviceEpoch) + "&dsh-spaces-contained=1";
    frame.addEventListener("load", () => {
      if (stopped) return;
      frame.contentWindow.postMessage({ source: "dsh-spaces-view-parent", type: "ping", serviceEpoch: view.serviceEpoch,
        spaceId: view.spaceId, generation: view.generation, channel: view.channel }, view.origin);
    });
    document.getElementById("status").remove(); document.body.append(frame);
    readyTimer = setTimeout(() => { if (!managerReady) fail(); }, 35000);
  } catch { fail(); } finally { preparing = false; }
}
window.addEventListener("message", event => {
  if (stopped) return;
  const message = event.data;
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  if (frame && event.source === frame.contentWindow && event.origin === audience.managerOrigin && managerView &&
      message.serviceEpoch === managerView.serviceEpoch && message.spaceId === managerView.spaceId &&
      message.generation === managerView.generation && message.channel === managerView.channel) {
    if (message.source === "dsh-spaces-view") {
      if (message.state === "ready") { viewReady = true; managerReady = surfaceReady; if (managerReady) { clearTimeout(readyTimer); forwardSelection(); } }
      else if (message.state === "failed" || message.state === "disconnected") fail();
    } else if (message.source === "dsh-spaces-surface" && message.type === "ready") {
      surfaceReady = true; managerReady = viewReady;
      if (managerReady) { clearTimeout(readyTimer); forwardSelection(); }
    } else if (message.source === "dsh-spaces-surface" && pending && message.requestId === pending.requestId) {
      if (message.type === "selected" && message.target === pending.spaceId) {
        send("selected", { requestId: pending.requestId, spaceId: pending.spaceId }); pending = null; clearTimeout(selectionTimer);
      } else if (message.type === "selection-failed") { rejected(pending.requestId); pending = null; clearTimeout(selectionTimer); }
    }
    return;
  }
  if (event.source !== parent || event.origin !== audience.parentOrigin ||
      Object.keys(message).sort().join(",") !== "channel,requestId,source,spaceId,type" ||
      message.source !== "dsh-spaces-portal-parent" || message.channel !== audience.channel || message.type !== "select" ||
      !Number.isSafeInteger(message.requestId) || message.requestId < 1 ||
      !(message.spaceId === null || typeof message.spaceId === "string" && /^[a-z0-9][a-z0-9-]{0,38}$/.test(message.spaceId))) return;
  const allowed = snapshot && (message.spaceId === null || snapshot.spaces.some(row => row.id === message.spaceId && row.id !== snapshot.managerId && row.status === "running"));
  if (!allowed) { rejected(message.requestId); return; }
  pending = { requestId: message.requestId, spaceId: message.spaceId };
  if (managerReady) forwardSelection(); else void ensureManager();
});
window.addEventListener("pagehide", () => { stopped = true; lifetime.abort(); clearInterval(timer); clearTimeout(selectionTimer); clearTimeout(readyTimer); });
void refresh();
timer = setInterval(() => { void refresh(); }, 1500);
</script></body></html>`;
}
