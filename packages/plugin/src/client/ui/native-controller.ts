import { isNativeSpaceTarget, parseNativeSpaceHash, parseNativePortalFailureHash, portalFailureDetail,
  parsePortalSnapshot, nativeCreateIntentHash, parseNativeCreateIntent,
  type NativeSpaceTarget, type PortalSnapshot, type PortalFailure } from "../../../../../src/shared/space-host";
import { BROWSER_RESULT, nativeBrowserFragment, parseNativeBrowserFragment, type BrowserRelay } from "../../../../../src/shared/browser-guest";
import type { WorkbenchGuideApi, WorkbenchReturnTarget } from "../../types";
import { publicGuideDetail } from "../guide-detail";
import { WORKBENCH_ENTRY_UNAVAILABLE } from "../../../../../src/shared/workbench-errors";
import { NativeBrowserHost } from "../native-browser-host";

/**
 * The desktop (Electron) host controller.
 *
 * It owns the native guest lifetime and the browser relay. It never touches
 * the DOM of the guest itself: the guest is appended to the container it is
 * given, and the container is positioned by the shell. Nothing here may
 * remount, resize or re-place a native view.
 */

/** The desktop browser bridge offered by the official Desktop host. */
export interface DesktopBrowserBridge {
  acquire(workspace: string): Promise<{ lease: string; partition: string }>;
  release(lease: string): Promise<void>;
}

interface Guest extends HTMLElement { loadURL(url: string): Promise<void>; getURL(): string }

/**
 * The desktop browser bridge of the running host, or `null` when the host
 * does not offer one.
 */
export function desktopBrowserBridge(root: typeof globalThis = globalThis): DesktopBrowserBridge | null {
  const carrier = (root as unknown as { dshDesktop?: { protocolVersion?: number; browser?: DesktopBrowserBridge } }).dshDesktop;
  return root.location?.protocol === "dsh-app:" && root.location.hostname === "app" && root.parent === root.window &&
    carrier?.protocolVersion === 1 && typeof carrier.browser?.acquire === "function" && typeof carrier.browser.release === "function" ? carrier.browser : null;
}

type NativeState = { phase: "loading" | "launching" | "initialize" | "ready" | "failed"; inventory: PortalSnapshot | null;
  selected: "current" | NativeSpaceTarget; pending: NativeSpaceTarget | null; error: string | null; detail: string | null;
  portalFailure: PortalFailure | null; guide: boolean };

/** One native guest, one lifetime. It has no Node API or product script execution channel. */
export class NativeHostController {
  private state: NativeState = { phase: "loading", inventory: null, selected: "current", pending: null, error: null, detail: null, portalFailure: null, guide: false };
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
  private browser?: NativeBrowserHost;
  private browserRequest?: string;
  private channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
  /** Set while the next settings selection must also open the create dialog. */
  private createIntent = false;
  /** Monotonic id of the last create intent handed to the portal page. */
  private intentSequence = 0;
  constructor(private guideApi: WorkbenchGuideApi, private bridge: DesktopBrowserBridge) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  get supportsServiceRestart() { return !!this.guideApi.previewServiceRestart && !!this.guideApi.restartService; }
  previewServiceRestart = () => {
    if (!this.supportsServiceRestart || this.state.phase !== "failed") throw Error("Manual service restart is unavailable.");
    return this.guideApi.previewServiceRestart!();
  };
  restartService = async (confirmationId: string): Promise<NativeHostController> => {
    if (!this.supportsServiceRestart || this.state.phase !== "failed") throw Error("Manual service restart is unavailable.");
    const result = await this.guideApi.restartService!(confirmationId);
    if (!result.ok || !result.connected) throw Error(this.reasonText(result.reasons) ?? "The manual service restart failed.");
    // The failed controller stays terminal. A confirmed new service gets a new
    // controller, so old async responses and guest events cannot affect it.
    return new NativeHostController(this.guideApi, this.bridge);
  };
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
    this.browser = new NativeBrowserHost(this.bridge, container);
    try {
      const role = await this.guideApi.role(); if (this.stopped) return;
      if (role.unavailable || !role.profileId || !this.guideApi.presentationSnapshot) return this.fail(this.reasonText(role.reasons));
      if (!role.managerId) { this.patch({ phase: "initialize" }); return; }
      await this.readDirectory(true);
    } catch (error) { this.fail(this.detailOf(error)); }
  }
  initialize = async () => {
    if (this.stopped || this.state.phase !== "initialize") return;
    this.patch({ phase: "loading", error: null, detail: null, guide: true });
    try {
      const result = await this.guideApi.initialize(); if (this.stopped) return;
      if (!result.ok) return this.fail(this.reasonText(result.reasons));
      await this.readDirectory();
      if (!this.stopped) this.select("@settings");
    } catch (error) { this.fail(this.detailOf(error)); }
  };
  private async readDirectory(firstRead = false) {
    if (this.stopped) return;
    try {
      const snapshot = parsePortalSnapshot(await this.guideApi.presentationSnapshot!());
      if (this.stopped) return;
      if (!snapshot) throw Error("presentation snapshot rejected");
      if (this.state.inventory && snapshot.serviceEpoch !== this.state.inventory.serviceEpoch) throw Error("presentation snapshot epoch changed");
      this.patch({ phase: "ready", inventory: snapshot });
      this.pollTimer = setTimeout(() => { void this.readDirectory(); }, 1500);
    } catch (error) {
      // Opening the application is a new user-requested launch. When read-only
      // discovery finds no live supervisor on that first read, this launch starts
      // it exactly once; the guarded launch retires only a provably dead owner.
      // A later failure in this session never launches again.
      const message = error instanceof Error ? error.message : String(error ?? "");
      if (firstRead && !this.state.inventory && message === WORKBENCH_ENTRY_UNAVAILABLE) {
        await this.launchOnOpen(); return;
      }
      this.fail(this.detailOf(error));
    }
  }
  private async launchOnOpen() {
    this.patch({ phase: "launching" });
    try {
      const result = await this.guideApi.initialize(); if (this.stopped) return;
      if (!result.ok) return this.fail(this.reasonText(result.reasons));
      await this.readDirectory();
    } catch (error) { this.fail(this.detailOf(error)); }
  }
  showCurrent = () => {
    this.browserRequest = undefined; this.browser?.hide();
    this.sequence++; clearTimeout(this.selectionTimer);
    this.createIntent = false;
    this.patch({ selected: "current", pending: null, guide: false });
  };

  /**
   * Open the create dialog of the workbench.
   *
   * The desktop shell does not own the management surface: it navigates the
   * guest to its settings page and then hands over a closed create intent
   * through the portal fragment. The portal page forwards that intent to the
   * guest, which opens its own create dialog on top of the settings page.
   */
  openCreate = () => {
    this.createIntent = true;
    this.select("@settings");
  };
  select = (target: NativeSpaceTarget) => {
    if (!isNativeSpaceTarget(target)) return;
    // After a failure this controller is stopped for good (let it crash). A
    // later click shows the recorded failure again instead of doing nothing;
    // it never reconnects or retries.
    if (this.stopped) { if (this.state.phase === "failed" && !this.state.guide) this.patch({ guide: true }); return; }
    if (this.state.phase === "initialize") { this.patch({ guide: true }); return; }
    if (this.state.phase !== "ready") { this.patch({ guide: true }); return; }
    this.browserRequest = undefined; this.browser?.hide();
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
    let url: URL;
    try { url = new URL(observedUrl ?? this.guest.getURL()); }
    catch { this.fail(); return; }
    if (url.origin + url.pathname !== this.nativeUrl || url.search || url.username || url["password"]) { this.fail(); return; }
    if (url.hash === "#failed") { this.fail(); return; }
    if (url.hash.startsWith("#failed")) {
      const failure = parseNativePortalFailureHash(url.hash);
      this.fail(failure ? portalFailureDetail(failure) : null, failure);
      return;
    }
    if (url.hash.startsWith("#browser/")) {
      const request = parseNativeBrowserFragment(url.hash, "browser");
      if (request && this.browserRequest !== request.requestId) {
        this.browserRequest = request.requestId;
        void this.presentBrowser(request, url.href);
      }
      return;
    }
    // A create intent is a request, never an answer and never a failure.
    if (parseNativeCreateIntent(url.hash) !== null) return;
    const answer = parseNativeSpaceHash(url.hash);
    if (!answer || answer.kind === "select" || answer.requestId !== this.sequence || answer.target !== this.state.pending) return;
    clearTimeout(this.selectionTimer);
    if (answer.kind === "rejected") { this.patch({ pending: null, guide: true, error: "空间页面未能打开，该次操作已失败。", detail: null }); return; }
    this.patch({ selected: answer.target, pending: null, guide: false }); this.guest.focus();
    if (this.createIntent && answer.target === "@settings") {
      this.createIntent = false;
      this.handOverCreateIntent();
    }
  }
  /**
   * The manager guest lives in another origin than this shell. The portal
   * page in between carries the closed create intent to it. An older portal
   * page does not know the fragment: the user stays on the settings page
   * without a dialog, without a failure and without a timeout.
   */
  private handOverCreateIntent() {
    const intent = this.nativeUrl + nativeCreateIntentHash(++this.intentSequence);
    // Electron can reject the same-document hash load after the fragment is
    // already committed. The committed URL decides; a rejected hash load
    // never fails this shell.
    void this.guest!.loadURL(intent).catch(() => {
      try {
        if (this.guest?.getURL() !== intent) this.patch({ guide: true, error: "新建空间对话框未能打开，该次操作已失败。", detail: null });
      } catch { this.patch({ guide: true, error: "新建空间对话框未能打开，该次操作已失败。", detail: null }); }
    });
  }
  private async presentBrowser(request: BrowserRelay, requestUrl: string) {
    const identity = request.identity, inventory = this.state.inventory;
    if (!this.browser || identity.serviceEpoch !== inventory?.serviceEpoch || !inventory.spaces.some(row =>
      row.id === identity.spaceId && row.id !== inventory.managerId && row.generation === identity.generation && row.status === "running")) return;
    if (request.kind === "hide") { this.browser.hide(identity); return; }
    const result = this.state.phase !== "ready" || this.state.pending || this.state.selected === "current" || this.state.guide
      ? { source: BROWSER_RESULT, requestId: request.requestId, ok: false, error: "not-visible" } as const
      : await this.browser.present(request);
    if (this.stopped || this.browserRequest !== request.requestId || !this.guest || this.guest.getURL() !== requestUrl) return;
    const fragment = nativeBrowserFragment("browser-result", result);
    if (!fragment) return;
    const responseUrl = this.nativeUrl + fragment;
    try { await this.guest.loadURL(responseUrl); }
    catch { if (!this.stopped && this.guest?.getURL() !== responseUrl && this.browserRequest === request.requestId) this.fail(); }
  }
  private fail(detail: string | null = null, portalFailure: PortalFailure | null = null) {
    if (this.stopped) return;
    // Background discovery must not cover the main application. Keep the
    // failure terminal and inspectable; show it immediately only when the user
    // is already using or opening a Spaces surface.
    const guide = this.state.guide || this.state.selected !== "current" || this.state.pending !== null;
    this.patch({ phase: "failed", pending: null, inventory: null, selected: "current", guide,
      error: "空间服务或页面不可用。该次连接已停止，当前应用仍可使用。", detail, portalFailure });
    this.stop();
  }
  stop = () => {
    if (this.stopped) return;
    this.stopped = true; this.lifetime.abort(); this.sequence++; clearTimeout(this.pollTimer); clearTimeout(this.selectionTimer);
    this.browserRequest = undefined; this.browser?.stop();
    this.guest?.remove(); this.guest = undefined;
    const lease = this.lease; this.lease = undefined;
    if (lease) void this.bridge.release(lease).catch(() => console.error("Spaces native guest release failed."));
  };
}
