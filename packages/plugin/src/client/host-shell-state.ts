import { publicGuideDetail } from "./guide-detail";
import { WorkbenchRemoteError } from "./workbench-remote";
import type { ClientFailureReport, WorkbenchGuideApi, WorkbenchGuideRole } from "../types";
import { parsePortalFailure, portalFailureDetail, parsePortalSnapshot, parseSpaceHostAudience, portalMessage, PORTAL_PARENT_SOURCE, type PortalCreation, type PortalFailure, type PortalSnapshot } from "../../../../src/shared/space-host";
import { HostActivityPoller, type HostGlow } from "./host-activity";

export interface HostShellSnapshot {
  phase: "loading" | "initialize" | "start" | "connecting" | "ready" | "failed";
  role: WorkbenchGuideRole | null;
  inventory: PortalSnapshot | null;
  portal: { src: string; origin: string; channel: string } | null;
  visible: "current" | "guide" | "portal";
  selected: string | null;
  pending: number | null;
  detail: string | null;
  portalFailure: PortalFailure | null;
  error: "unavailable" | "unsupported" | "stopped" | "entry" | null;
  creationFailed: PortalCreation | null;
  /** Per-space button glow for the current native host space: green while working, yellow while needing attention. */
  hostGlow: HostGlow;
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
    visible: "current", selected: null, pending: null, error: null, detail: null, portalFailure: null, creationFailed: null, hostGlow: null };
  private seenCreations = new Set<string>();
  private dismissedCreations = new Set<string>();
  private listeners = new Set<() => void>();
  private frame: HostShellWindow | null = null;
  private epoch = 0;
  private sequence = 0;
  private running = false;
  private entryTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private target: string | null = null;
  private openAfterConnect = false;
  /** Current-space sidebar button glow; absent when the host offers no `hostActivity`. */
  private activityPoller?: HostActivityPoller;
  constructor(private guide: WorkbenchGuideApi, private env: HostShellEnvironment = browserEnv) {
    const read = guide.hostActivity?.bind(guide);
    if (read) this.activityPoller = new HostActivityPoller(read, hostGlow => this.patch({ hostGlow }),
      { setTimeout: (handler, ms) => this.env.setTimeout(handler, ms), clearTimeout: timer => this.env.clearTimeout(timer as ReturnType<typeof setTimeout>) });
  }
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
    this.patch({ phase: "loading", error: null, detail: null, portalFailure: null });
    this.activityPoller?.start();
    void this.guide.role().then(async role => {
      if (!this.running || epoch !== this.epoch) return;
      this.patch({ role });
      if (role.unavailable || !role.profileId) { this.fail("unavailable", role.reasons); return; }
      if (!this.supportsTransport()) { this.fail("unsupported"); return; }
      if (role.managerId) await this.connect(epoch);
      else this.patch({ phase: "initialize" });
    }).catch(cause => { if (this.running && epoch === this.epoch) this.fail("unavailable", cause); });
  };
  stop = (): void => { this.running = false; this.epoch++; this.clearTimers(); this.frame = null; this.activityPoller?.stop(); };
  registerFrame = (frame: HostShellWindow | null): void => { this.frame = frame; };
  private supportsTransport(): boolean {
    return !!parseSpaceHostAudience({ parentOrigin: this.env.origin(), channel: "0".repeat(32) });
  }
  private fail(error: HostShellSnapshot["error"], cause?: unknown): void {
    const epoch = this.epoch;
    const text = Array.isArray(cause) ? cause.filter(reason => typeof reason === "string").join("\n")
      : cause instanceof Error ? cause.message : typeof cause === "string" ? cause
      : cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string" ? cause.message : "";
    const detail = publicGuideDetail(text) || null;
    this.clearTimers(); this.frame = null;
    this.patch({ phase: "failed", error, portal: null, inventory: null, pending: null,
      visible: this.ui.visible === "current" ? "current" : "guide", selected: null, detail });
    this.reportFailure(detail, cause, this.ui.portalFailure);
    // A reported cause is authoritative; a generic directory error must not replace it.
    if (detail) return;
    // One read-only observation of the failure, never a new connection or launch.
    if (this.guide.presentationSnapshot) void this.guide.presentationSnapshot().catch(cause => {
      if (!this.running || epoch !== this.epoch || this.ui.phase !== "failed") return;
      const detail = publicGuideDetail(cause instanceof Error ? cause.message : String(cause));
      this.patch({ detail: detail.slice(0, 2000) || null });
    });
  }
  private reportFailure(detail: string | null, cause: unknown, portalFailure: PortalFailure | null): void {
    if (!this.guide.reportClientFailure) return;
    const report: ClientFailureReport = {
      surface: "portable-host",
      stage: "host-shell",
      detail: detail ? detail.slice(0, 500) : null,
      failedAt: new Date().toISOString(),
      portalFailure,
      ...(cause instanceof WorkbenchRemoteError ? {
        ...(cause.endpoint ? { rpcEndpoint: cause.endpoint } : {}),
        rpcFailureKind: cause.failureKind,
        ...(cause.connectionState ? { connectionState: cause.connectionState } : {}),
      } : {}),
    };
    void this.guide.reportClientFailure(report).catch(() => undefined);
  }
  private failPortal(failure: PortalFailure): void {
    this.patch({ portalFailure: failure });
    this.fail(["manager-view-invalid", "manager-view-failed", "view-ready-timeout"].includes(failure.reason) ? "entry" : "unavailable",
      portalFailureDetail(failure));
  }
  private async connect(epoch: number): Promise<void> {
    if (!this.supportsTransport()) { this.fail("unsupported"); return; }
    this.patch({ phase: "connecting" });
    const channel = this.env.channel();
    const audience = parseSpaceHostAudience({ parentOrigin: this.env.origin(), channel });
    if (!audience) throw new Error("unsupported-host-transport");
    const target = await this.guide.portalTarget(audience);
    if (!this.running || epoch !== this.epoch) return;
    if (!target.available && !target.unavailable && this.ui.role?.managerId) {
      this.patch({ phase: "start", error: null }); return;
    }
    if (!target.available || target.unavailable || typeof target.origin !== "string" ||
        !parseSpaceHostAudience({ parentOrigin: target.origin, channel }) ||
        typeof target.path !== "string" || !/^\/portal-bootstrap\/[A-Za-z0-9_-]{32}$/.test(target.path)) {
      this.fail("entry", target.reasons); return;
    }
    this.patch({ portal: { src: target.origin + target.path, origin: target.origin, channel } });
    this.entryTimer = this.env.setTimeout(() => {
      if (this.running && epoch === this.epoch && this.ui.phase === "connecting") this.failPortal({ reason: "portal-entry-timeout" });
    }, 30000);
  }
  initialize = async (): Promise<void> => {
    if (!this.running || (this.ui.phase !== "initialize" && this.ui.phase !== "start")) return;
    // Check transport before a potentially mutating initialization, not afterwards.
    if (!this.supportsTransport()) { this.fail("unsupported"); return; }
    const epoch = this.epoch;
    this.openAfterConnect = true;
    this.patch({ phase: "connecting", error: null, detail: null });
    try {
      const result = await this.guide.initialize();
      if (!this.running || epoch !== this.epoch) return;
      if (!result.ok || result.unavailable) { this.fail("unavailable", result.reasons); return; }
      await this.connect(epoch);
    } catch (cause) { if (this.running && epoch === this.epoch) this.fail("unavailable", cause); }
  };
  showCurrent = (): void => {
    if (this.selectionTimer !== null) this.env.clearTimeout(this.selectionTimer);
    this.selectionTimer = null; this.sequence++; this.openAfterConnect = false;
    this.patch({ visible: "current", selected: null, pending: null, error: this.ui.phase === "failed" ? this.ui.error : null });
  };
  showGuide = (): void => { this.patch({ visible: "guide" }); };
  /** Creation placeholders visible in this session: all active, plus failed ones seen while active and not dismissed. */
  visibleCreations = (): PortalCreation[] => {
    const creating = this.ui.inventory?.creating ?? [];
    return creating.filter(creation =>
      creation.status !== "failed" || (this.seenCreations.has(creation.jobId) && !this.dismissedCreations.has(creation.jobId)));
  };
  dismissCreation = (jobId: string): void => {
    this.dismissedCreations.add(jobId);
    this.patch(this.ui.creationFailed?.jobId === jobId ? { creationFailed: null } : {});
  };
  openCreation = (creation: PortalCreation): void => {
    if (creation.status === "failed") { this.patch({ creationFailed: creation }); return; }
    this.select(null);
  };
  closeCreationFailed = (): void => { this.patch({ creationFailed: null }); };
  select = (spaceId: string | null): void => {
    const { portal, inventory } = this.ui;
    if (this.ui.phase !== "ready" || !portal || !inventory || !this.frame) { this.showGuide(); return; }
    // Inventory is presentation data; the manager checks current running authority on each click.
    if (spaceId !== null && !inventory.spaces.some(s => s.id === spaceId && s.id !== inventory.managerId)) {
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
      if (!inventory) { this.failPortal({ reason: "state-invalid" }); return; }
      if (this.ui.inventory && inventory.serviceEpoch !== this.ui.inventory.serviceEpoch) { this.failPortal({ reason: "service-changed" }); return; }
      if (this.entryTimer !== null) this.env.clearTimeout(this.entryTimer);
      this.entryTimer = null;
      if (inventory.serviceEpoch !== this.ui.inventory?.serviceEpoch) {
        this.seenCreations.clear(); this.dismissedCreations.clear();
      }
      for (const creation of inventory.creating ?? []) {
        if (creation.status !== "failed") this.seenCreations.add(creation.jobId);
      }
      this.patch({ inventory, phase: "ready" });
      if (this.openAfterConnect) { this.openAfterConnect = false; this.select(null); }
    } else if (message.type === "failed" && keys === "channel,failure,source,type") {
      const failure = parsePortalFailure(message.failure);
      if (failure) this.failPortal(failure);
    }
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
