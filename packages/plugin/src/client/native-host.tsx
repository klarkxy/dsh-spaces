import React, { useEffect, useRef, useSyncExternalStore } from "react";
import type { WorkbenchGuideApi, WorkbenchReturnTarget } from "../types";
import { isNativeSpaceTarget, parseNativeSpaceHash, parsePortalSnapshot, type NativeSpaceTarget, type PortalSnapshot } from "../../../../src/shared/space-host";
import { attachHostLayout } from "./host-layout";
import { SpaceGlyph } from "../workbench/space-glyph";
import { publicGuideDetail } from "./guide-detail";

export interface DesktopBrowserBridge {
  acquire(workspace: string): Promise<{ lease: string; partition: string }>;
  release(lease: string): Promise<void>;
}
interface Guest extends HTMLElement { loadURL(url: string): Promise<void>; getURL(): string }
export function desktopBrowserBridge(root: typeof globalThis = globalThis): DesktopBrowserBridge | null {
  const carrier = (root as unknown as { dshDesktop?: { protocolVersion?: number; browser?: DesktopBrowserBridge } }).dshDesktop;
  return root.location?.protocol === "dsh-app:" && root.location.hostname === "app" && root.parent === root.window &&
    carrier?.protocolVersion === 1 && typeof carrier.browser?.acquire === "function" && typeof carrier.browser.release === "function" ? carrier.browser : null;
}
type NativeState = { phase: "loading" | "initialize" | "ready" | "failed"; inventory: PortalSnapshot | null;
  selected: "current" | NativeSpaceTarget; pending: NativeSpaceTarget | null; error: string | null; detail: string | null; guide: boolean };

/** One native guest, one lifetime. It has no Node API or product script execution channel. */
export class NativeHostController {
  private state: NativeState = { phase: "loading", inventory: null, selected: "current", pending: null, error: null, detail: null, guide: false };
  private listeners = new Set<() => void>();
  private stopped = false;
  private lifetime = new AbortController();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private selectionTimer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private guest?: Guest;
  private lease?: string;
  private opening?: Promise<void>;
  private container?: HTMLElement;
  private nativeUrl?: string;
  private channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
  constructor(private guideApi: WorkbenchGuideApi, private bridge: DesktopBrowserBridge) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private patch(change: Partial<NativeState>) { this.state = { ...this.state, ...change }; for (const fn of this.listeners) fn(); }
  private detailOf(error: unknown): string | null {
    const detail = publicGuideDetail(error instanceof Error ? error.message : String(error ?? ""));
    return detail || null;
  }
  private reasonText(reasons: string[] | undefined): string | null {
    const detail = (reasons ?? []).map(publicGuideDetail).filter(Boolean).join(" ");
    return detail || null;
  }
  async start(container: HTMLElement) {
    this.container = container;
    try {
      const role = await this.guideApi.role(); if (this.stopped) return;
      if (role.unavailable || !role.profileId || !this.guideApi.presentationSnapshot) return this.fail(this.reasonText(role.reasons));
      if (!role.managerId) { this.patch({ phase: "initialize" }); return; }
      await this.readDirectory();
    } catch (error) { this.fail(this.detailOf(error)); }
  }
  initialize = async () => {
    if (this.stopped || this.state.phase !== "initialize") return;
    this.patch({ phase: "loading", error: null, detail: null });
    try {
      const result = await this.guideApi.initialize(); if (this.stopped) return;
      if (!result.ok) return this.fail(this.reasonText(result.reasons));
      await this.readDirectory();
      if (!this.stopped) this.select("@settings");
    } catch (error) { this.fail(this.detailOf(error)); }
  };
  private async readDirectory() {
    if (this.stopped) return;
    try {
      const snapshot = parsePortalSnapshot(await this.guideApi.presentationSnapshot!());
      if (this.stopped) return;
      if (!snapshot) throw Error("presentation snapshot rejected");
      if (this.state.inventory && snapshot.serviceEpoch !== this.state.inventory.serviceEpoch) throw Error("presentation snapshot epoch changed");
      this.patch({ phase: "ready", inventory: snapshot });
      this.pollTimer = setTimeout(() => { void this.readDirectory(); }, 1500);
    } catch (error) { this.fail(this.detailOf(error)); }
  }
  showCurrent = () => {
    this.sequence++; clearTimeout(this.selectionTimer);
    this.patch({ selected: "current", pending: null, guide: false });
  };
  select = (target: NativeSpaceTarget) => {
    if (this.stopped || !isNativeSpaceTarget(target)) return;
    if (this.state.phase === "initialize") { this.patch({ guide: true }); return; }
    if (this.state.phase !== "ready") { this.patch({ guide: true }); return; }
    const inventory = this.state.inventory;
    if (!target.startsWith("@") && !inventory?.spaces.some(s => s.id === target && s.id !== inventory.managerId && s.status === "running")) {
      this.patch({ guide: true, error: "该空间尚未运行。请在设置中明确启动。", detail: null }); return;
    }
    const requestId = ++this.sequence;
    this.patch({ pending: target, error: null, detail: null, guide: false });
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => { if (this.sequence === requestId) this.fail(); }, 45000);
    void this.open().then(async () => {
      if (this.stopped || requestId !== this.sequence) return;
      await this.guest!.loadURL(this.nativeUrl! + "#select/" + requestId + "/" + target);
    }).catch(() => {
      if (this.stopped || requestId !== this.sequence || this.state.pending !== target) return;
      // Electron can reject the request URL after the page has already acknowledged
      // the same-document navigation. Read that exact acknowledgement before failing.
      try {
        const actual = this.guest?.getURL();
        this.observed(actual);
        // The fragment is already committed even when Electron rejects loadURL.
        // Keep waiting for its bounded acknowledgement; do not send it again.
        if (!this.stopped && this.state.pending === target &&
          actual !== this.nativeUrl + "#select/" + requestId + "/" + target) this.fail();
      } catch (error) { this.fail(this.detailOf(error)); }
    });
  };
  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.createGuest(); return this.opening;
  }
  private async createGuest() {
    const target: WorkbenchReturnTarget = await this.guideApi.returnTarget();
    if (this.stopped) return;
    const origin = new URL(target.origin ?? "about:blank");
    if (!target.available || origin.origin !== target.origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
      origin.username || origin.password || !/^\/bootstrap\/[A-Za-z0-9_-]{16,128}$/.test(target.path ?? "")) throw Error("return target rejected");
    const reservation = await this.bridge.acquire("dsh-spaces:" + target.origin + ":" + this.channel);
    if (this.stopped) { await this.bridge.release(reservation.lease); return; }
    this.lease = reservation.lease;
    const element = document.createElement("webview") as Guest; this.guest = element;
    element.className = "dsh-native-guest";
    element.setAttribute("partition", reservation.partition);
    element.setAttribute("name", reservation.lease);
    element.setAttribute("src", "about:blank#" + reservation.lease);
    element.setAttribute("aria-label", "空间内容");
    const ready = new Promise<void>((resolve, reject) => {
      const finish = (error = false) => { clearTimeout(timeout); this.lifetime.signal.removeEventListener("abort", aborted); error ? reject(Error()) : resolve(); };
      const aborted = () => finish(true);
      const timeout = setTimeout(() => finish(true), 15000);
      this.lifetime.signal.addEventListener("abort", aborted, { once: true });
      element.addEventListener("dom-ready", () => finish(), { once: true });
    });
    element.addEventListener("did-fail-load", event => { const failure = event as Event & { errorCode?: number; isMainFrame?: boolean }; if (failure.isMainFrame !== false && failure.errorCode !== -3) this.fail(); });
    element.addEventListener("render-process-gone", () => this.fail());
    element.addEventListener("did-navigate-in-page", () => this.observed());
    this.container!.append(element); await ready;
    if (this.stopped) return;
    await element.loadURL(target.origin + target.path);
    if (this.stopped) return;
    if (element.getURL() !== target.origin + "/") throw Error("bootstrap entry rejected");
    this.nativeUrl = target.origin + "/native/" + this.channel;
    await element.loadURL(this.nativeUrl);
    if (!this.stopped && element.getURL() !== this.nativeUrl) throw Error("native channel rejected");
    element.addEventListener("did-navigate", () => { if (!this.stopped && !element.getURL().startsWith(this.nativeUrl! + "#") && element.getURL() !== this.nativeUrl) this.fail(); });
  }
  private observed(observedUrl?: string) {
    if (this.stopped || !this.guest || !this.nativeUrl) return;
    const url = new URL(observedUrl ?? this.guest.getURL());
    if (url.origin + url.pathname !== this.nativeUrl) { this.fail(); return; }
    if (url.hash === "#failed") { this.fail(); return; }
    const answer = parseNativeSpaceHash(url.hash);
    if (!answer || answer.kind === "select" || answer.requestId !== this.sequence || answer.target !== this.state.pending) return;
    clearTimeout(this.selectionTimer);
    if (answer.kind === "rejected") { this.patch({ pending: null, guide: true, error: "空间页面未能打开，该次操作已失败。", detail: null }); return; }
    this.patch({ selected: answer.target, pending: null, guide: false }); this.guest.focus();
  }
  private fail(detail: string | null = null) {
    if (this.stopped) return;
    this.patch({ phase: "failed", pending: null, guide: true, error: "空间服务或页面不可用。该次连接已停止，当前应用仍可使用。", detail });
    this.stop();
  }
  stop = () => {
    if (this.stopped) return;
    this.stopped = true; this.lifetime.abort(); this.sequence++; clearTimeout(this.pollTimer); clearTimeout(this.selectionTimer);
    this.guest?.remove(); this.guest = undefined;
    const lease = this.lease; this.lease = undefined;
    if (lease) void this.bridge.release(lease).catch(() => console.error("Spaces native guest release failed."));
  };
}

export function NativeHostShell({ controller }: { controller: NativeHostController }) {
  const ui = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const anchor = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), layout = useRef<ReturnType<typeof attachHostLayout> | null>(null);
  useEffect(() => {
    try { layout.current = attachHostLayout(anchor.current!); }
    catch { controller.stop(); return; }
    void controller.start(container.current!);
    return () => { controller.stop(); layout.current?.dispose(); };
  }, [controller]);
  useEffect(() => { layout.current?.cover(ui.selected !== "current" || ui.guide); }, [ui.selected, ui.guide]);
  const button = (target: NativeSpaceTarget, label: string, glyph: React.ReactNode) => <button type="button" disabled={ui.phase === "loading"} aria-label={label} title={label} aria-current={ui.selected === target ? "page" : undefined} aria-busy={ui.pending === target || undefined} onClick={() => controller.select(target)}>{glyph}</button>;
  return <div ref={anchor} className="dsh-host-dock" data-spaces-native="true">
    <nav className="dsh-host-rail" aria-label="空间">
      <button type="button" data-space-id="desktop" data-pinned="true" aria-label="Desktop · 默认空间" title="Desktop · 默认空间（始终置顶）" aria-current={ui.selected === "current" ? "page" : undefined} onClick={controller.showCurrent}><SpaceGlyph spaceId="desktop" /></button>
      <div className="dsh-host-rail-list">{ui.inventory?.spaces.filter(s => s.id !== ui.inventory?.managerId && s.id !== "desktop").map(s => <React.Fragment key={s.id}>{button(s.id, s.displayName, <SpaceGlyph spaceId={s.id} icon={s.icon} />)}</React.Fragment>)}</div>
      {button("@dashboard", "看板", "▦")}{button("@settings", "设置", "⚙")}
    </nav>
    <div ref={container} className="dsh-host-surface dsh-native-container" hidden={ui.selected === "current" || ui.guide} />
    {ui.guide && <section className="dsh-host-surface dsh-host-guide" aria-label="空间状态">
      {ui.error ? <p role="alert">{ui.error}</p> : <p>{ui.phase === "loading" ? "正在连接空间服务…" : "初始化独立的 Spaces 管理服务后，即可在这里切换空间。"}</p>}
      {ui.detail ? <p>{ui.detail}</p> : null}
      {ui.phase === "initialize" && <button type="button" onClick={() => void controller.initialize()}>初始化 Spaces</button>}
      <button type="button" onClick={controller.showCurrent}>当前应用</button>
    </section>}
    {ui.pending && <div className="dsh-host-loading" role="status">正在打开空间</div>}
  </div>;
}
export const NATIVE_HOST_CSS = `[data-windows-titlebar] .dsh-host-dock[data-spaces-native]{--dsh-frame-top-clearance:var(--dsh-windows-titlebar-height)}.dsh-host-dock[data-spaces-native] .dsh-host-rail{background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#f0f1f5));border-color:var(--dsw-alias-border-l3,#d6d8de)}.dsh-native-container{overflow:hidden;display:flex}.dsh-native-container[hidden]{display:none}.dsh-native-guest{display:flex;width:100%;height:100%;border:0}.dsh-host-rail button[aria-current=page]{border-color:currentColor;background:color-mix(in srgb,currentColor 12%,transparent)}`;
