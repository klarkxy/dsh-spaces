import type { WorkbenchGuideApi, WorkbenchGuideRole } from "../types";
import { parsePortalSnapshot, parseSpaceHostAudience, portalMessage, PORTAL_PARENT_SOURCE, type PortalSnapshot } from "../../../../src/shared/space-host";

export interface HostShellSnapshot {
  phase: "loading" | "initialize" | "connecting" | "ready" | "failed";
  role: WorkbenchGuideRole | null;
  inventory: PortalSnapshot | null;
  portal: { src: string; origin: string; channel: string } | null;
  visible: "current" | "guide" | "portal";
  selected: string | null;
  pending: number | null;
  error: "unavailable" | "unsupported" | "stopped" | "entry" | null;
}
export interface HostShellWindow { postMessage(value: unknown, origin: string): void }
export interface HostShellEnvironment {
  origin(): string;
  channel(): string;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const browserEnv: HostShellEnvironment = {
  origin: () => window.location.origin,
  channel: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join(""),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: timer => clearTimeout(timer),
};

/** Presentation client only. It cannot submit a management command, stop a Host or change its profile. */
export class HostShellController {
  private ui: HostShellSnapshot = { phase: "loading", role: null, inventory: null, portal: null,
    visible: "current", selected: null, pending: null, error: null };
  private listeners = new Set<() => void>();
  private frame: HostShellWindow | null = null;
  private epoch = 0;
  private sequence = 0;
  private running = false;
  private entryTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private target: string | null = null;
  private openAfterConnect = false;
  constructor(private guide: WorkbenchGuideApi, private env: HostShellEnvironment = browserEnv) {}
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = (): HostShellSnapshot => this.ui;
  private patch(patch: Partial<HostShellSnapshot>): void { this.ui = { ...this.ui, ...patch }; for (const fn of this.listeners) fn(); }
  private clearTimers(): void {
    if (this.entryTimer !== null) this.env.clearTimeout(this.entryTimer);
    if (this.selectionTimer !== null) this.env.clearTimeout(this.selectionTimer);
    this.entryTimer = this.selectionTimer = null;
  }
  start = (): void => {
    if (this.running) return;
    this.running = true;
    const epoch = ++this.epoch;
    this.patch({ phase: "loading", error: null });
    void this.guide.role().then(async role => {
      if (!this.running || epoch !== this.epoch) return;
      this.patch({ role });
      if (role.unavailable || !role.profileId) { this.fail("unavailable"); return; }
      if (!this.supportsTransport()) { this.fail("unsupported"); return; }
      if (role.managerId) await this.connect(epoch);
      else this.patch({ phase: "initialize" });
    }).catch(() => { if (this.running && epoch === this.epoch) this.fail("unavailable"); });
  };
  stop = (): void => { this.running = false; this.epoch++; this.clearTimers(); this.frame = null; };
  registerFrame = (frame: HostShellWindow | null): void => { this.frame = frame; };
  private supportsTransport(): boolean {
    return !!this.guide.portalTarget && !!parseSpaceHostAudience({ parentOrigin: this.env.origin(), channel: "0".repeat(32) });
  }
  private fail(error: HostShellSnapshot["error"]): void {
    this.clearTimers(); this.frame = null;
    this.patch({ phase: "failed", error, portal: null, inventory: null, pending: null,
      visible: this.ui.visible === "current" ? "current" : "guide", selected: null });
  }
  private async connect(epoch: number): Promise<void> {
    if (!this.supportsTransport()) { this.fail("unsupported"); return; }
    this.patch({ phase: "connecting" });
    const channel = this.env.channel();
    const audience = parseSpaceHostAudience({ parentOrigin: this.env.origin(), channel });
    if (!audience) throw new Error("unsupported-host-transport");
    const target = await this.guide.portalTarget!(audience);
    if (!this.running || epoch !== this.epoch) return;
    if (!target.available || target.unavailable || typeof target.origin !== "string" ||
        !parseSpaceHostAudience({ parentOrigin: target.origin, channel }) ||
        typeof target.path !== "string" || !/^\/portal-bootstrap\/[A-Za-z0-9_-]{32}$/.test(target.path)) {
      this.fail("entry"); return;
    }
    this.patch({ portal: { src: target.origin + target.path, origin: target.origin, channel } });
    this.entryTimer = this.env.setTimeout(() => { this.fail("entry"); }, 30000);
  }
  initialize = async (): Promise<void> => {
    if (!this.running || this.ui.phase !== "initialize") return;
    // Check transport before a potentially mutating initialization, not afterwards.
    if (!this.supportsTransport()) { this.fail("unsupported"); return; }
    const epoch = this.epoch;
    this.openAfterConnect = true;
    this.patch({ phase: "connecting", error: null });
    try {
      const result = await this.guide.initialize();
      if (!this.running || epoch !== this.epoch) return;
      if (!result.ok || result.unavailable) { this.fail("unavailable"); return; }
      // The legacy top-level handoff URL is never navigated to or sent to another frame.
      await this.connect(epoch);
    } catch { if (this.running && epoch === this.epoch) this.fail("unavailable"); }
  };
  showCurrent = (): void => {
    if (this.selectionTimer !== null) this.env.clearTimeout(this.selectionTimer);
    this.selectionTimer = null; this.sequence++; this.openAfterConnect = false;
    this.patch({ visible: "current", selected: null, pending: null, error: this.ui.phase === "failed" ? this.ui.error : null });
  };
  showGuide = (): void => { this.patch({ visible: "guide" }); };
  select = (spaceId: string | null): void => {
    const { portal, inventory } = this.ui;
    if (this.ui.phase !== "ready" || !portal || !inventory || !this.frame) { this.showGuide(); return; }
    if (spaceId !== null && !inventory.spaces.some(s => s.id === spaceId && s.id !== inventory.managerId && s.status === "running")) {
      this.patch({ error: "stopped", visible: "guide" }); return;
    }
    const requestId = ++this.sequence;
    this.target = spaceId;
    this.patch({ pending: requestId, error: null });
    this.frame.postMessage({ source: PORTAL_PARENT_SOURCE, channel: portal.channel, type: "select", requestId, spaceId }, portal.origin);
    if (this.selectionTimer !== null) this.env.clearTimeout(this.selectionTimer);
    this.selectionTimer = this.env.setTimeout(() => {
      if (this.ui.pending === requestId) this.patch({ pending: null, error: "entry", visible: "guide" });
    }, 45000);
  };
  handleMessage = (event: { source: unknown; origin: string; data: unknown }): void => {
    const portal = this.ui.portal;
    if (!this.running || !portal) return;
    const message = portalMessage(event, this.frame, portal.origin, portal.channel);
    if (!message) return;
    const keys = Object.keys(message).sort().join(",");
    if (message.type === "state" && keys === "channel,snapshot,source,type") {
      const inventory = parsePortalSnapshot(message.snapshot);
      if (!inventory || this.ui.inventory && inventory.serviceEpoch !== this.ui.inventory.serviceEpoch) { this.fail("unavailable"); return; }
      if (this.entryTimer !== null) this.env.clearTimeout(this.entryTimer);
      this.entryTimer = null;
      this.patch({ inventory, phase: "ready" });
      if (this.openAfterConnect) { this.openAfterConnect = false; this.select(null); }
    } else if (message.type === "failed" && keys === "channel,source,type") this.fail("entry");
    else if (message.requestId === this.ui.pending && this.ui.pending !== null) {
      if (message.type === "selected" && keys === "channel,requestId,source,spaceId,type" && message.spaceId === this.target) {
        if (this.selectionTimer !== null) this.env.clearTimeout(this.selectionTimer);
        this.selectionTimer = null;
        this.patch({ pending: null, visible: "portal", selected: this.target, error: null });
      } else if (message.type === "selection-failed" && keys === "channel,requestId,source,type") {
        if (this.selectionTimer !== null) this.env.clearTimeout(this.selectionTimer);
        this.selectionTimer = null;
        this.patch({ pending: null, error: "entry", visible: "guide" });
      }
    }
  };
}
