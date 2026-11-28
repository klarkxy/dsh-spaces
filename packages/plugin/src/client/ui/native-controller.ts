import { isNativeSpaceTarget, parseNativeSpaceHash, parseNativePortalFailureHash, portalFailureDetail,
  parsePortalSnapshot, nativeCreateIntentHash, parseNativeCreateIntent, nativeDetailIntentHash, parseNativeDetailIntent, PORTAL_SPACE_RE,
  type NativeSpaceTarget, type PortalSnapshot, type PortalFailure, type PortalCreation } from "../../../../../src/shared/space-host";
import { BROWSER_RESULT, nativeBrowserFragment, parseNativeBrowserFragment, type BrowserRelay } from "../../../../../src/shared/browser-guest";
import type { ResumeSpacesMode } from "../../../../../src/shared/types";
import type { ClientFailureReport, ClientFailureStage, DesktopSpaceAction, WorkbenchGuideApi, WorkbenchReturnTarget } from "../../types";
import { publicGuideDetail } from "../guide-detail";
import { NativeBrowserHost } from "../native-browser-host";
import { SPACES_BROWSER_SEALED } from "../../../../../src/shared/browser-sealed";
import type { DesktopLaunchState } from "../../types";
import { WorkbenchRemoteError } from "../workbench-remote";
import { nativeTexts } from "./native-texts";
import { createNavDiag, parseNavDiag, type NavDiagRecord } from "../../../../../src/shared/nav-diag";
import { HostActivityPoller, type HostGlow } from "../host-activity";

const LAUNCH_POLL_MS = 1500;
export const NATIVE_SELECTION_DEADLINE_MS = 90_000;
const LAUNCH_BUSY = new Set<DesktopLaunchState["phase"]>(["discovering", "preparing", "launching", "starting", "connecting"]);

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

type NativeLaunchPhase = DesktopLaunchState["phase"];
type NativeNavigationIntent = "settings" | "create" | "detail";
type NativeState = { phase: "loading" | NativeLaunchPhase | "ready" | "stopping" | "service-stopped" | "failed"; inventory: PortalSnapshot | null;
  selected: "current" | NativeSpaceTarget; pending: NativeSpaceTarget | null; error: string | null; detail: string | null;
  failedAt: string | null; cleanupDetail: string | null; instanceRetained: boolean | null;
  portalFailure: PortalFailure | null; guide: boolean;
  navigationIntent: NativeNavigationIntent | null; createHandoff: boolean;
  operation: { spaceId: string; action: DesktopSpaceAction["action"] } | null; operationError: string | null;
  notice: string | null; serviceStopRequest: number;
  spaceConfirmation: { request: DesktopSpaceAction; activity: "busy" | "unknown" } | null;
  creationFailed: PortalCreation | null;
  /** Per-space button glow for the current native host space: green while working, yellow while needing attention. */
  hostGlow: HostGlow };

/** One native guest, one lifetime. It has no Node API or product script execution channel. */
export class NativeHostController {
  private state: NativeState = { phase: "loading", inventory: null, selected: "current", pending: null, error: null, detail: null, failedAt: null, cleanupDetail: null, instanceRetained: null, portalFailure: null, guide: false, navigationIntent: null, createHandoff: false, operation: null, operationError: null, notice: null, serviceStopRequest: 0, spaceConfirmation: null, creationFailed: null, hostGlow: null };
  /** Creation job ids seen queued/running this session; failed entries need it to stay visible. */
  private seenCreations = new Set<string>();
  private dismissedCreations = new Set<string>();
  private listeners = new Set<() => void>();
  private stopped = false;
  private started = false;
  private lifetime = new AbortController();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private launchTimer?: ReturnType<typeof setTimeout>;
  private selectionTimer?: ReturnType<typeof setTimeout>;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  /** Non-zero while a navigation still wants the native guest. Main clears it. */
  private desiredGuest = 0;
  private directoryVersion = 0;
  private launchGeneration = 0;
  private launchSettled = false;
  private launchOperationId: string | null = null;
  private launchEpoch: string | null = null;
  private launchManagerId: string | null = null;
  /** Set only for the settings selection that openCreate is performing. */
  private selectingCreate = false;
  private guest?: Guest;
  private lease?: string;
  private opening?: Promise<void>;
  private container?: HTMLElement;
  private nativeUrl?: string;
  private browser?: NativeBrowserHost;
  private browserRequest?: string;
  private readySpaces = new Map<string, number>();
  private failedSpaces = new Map<string, number>();
  private navigationGeneration?: number;
  private channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("");
  /** Set while the next settings selection must also open the create dialog. */
  private createIntent = false;
  /** Set while the next settings selection must open one space's detail page. */
  private detailIntentSpaceId: string | null = null;
  /** Latest settings or create choice. Main, failure and stop clear it. */
  private intent: NativeNavigationIntent | null = null;
  /** Monotonic id of the last create intent handed to the portal page. */
  private intentSequence = 0;
  private navTrail: NavDiagRecord[] = [];
  /** First-navigation diagnosis. Calls must not change navigation. */
  private navDiag = createNavDiag("controller", row => this.recordNavDiag(row));
  private navNavigateNoted = false;
  private navOutcomeNoted = false;
  private readonly readOnlyLaunch: boolean;
  /** Current-space sidebar button glow; absent when the host offers no `hostActivity`. */
  private activityPoller?: HostActivityPoller;
  constructor(private guideApi: WorkbenchGuideApi, private bridge: DesktopBrowserBridge, options?: { readOnlyLaunch?: boolean }) {
    this.readOnlyLaunch = options?.readOnlyLaunch === true;
    const read = guideApi.hostActivity?.bind(guideApi);
    if (read) this.activityPoller = new HostActivityPoller(read, hostGlow => this.patch({ hostGlow }));
  }
  get disposedBeforeTerminal(): boolean {
    return this.stopped && this.state.phase !== "failed" && this.state.phase !== "service-stopped";
  }
  recreate = (): NativeHostController =>
    new NativeHostController(this.guideApi, this.bridge);
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  get supportsSpaceActions() { return !!this.guideApi.spaceAction; }
  spaceStatus = (spaceId: string): string => {
    const row = this.state.inventory?.spaces.find(space => space.id === spaceId);
    if (!row) return "unknown";
    if (this.state.operation?.spaceId === spaceId) return this.state.operation.action === "stop" ? "stopping" : row.status === "running" ? "opening" : "starting";
    if (row.status !== "running") return row.status;
    if (this.state.pending === spaceId) return "opening";
    if (this.failedSpaces.get(spaceId) === row.generation) return "failed";
    return this.readySpaces.get(spaceId) === row.generation ? "running" : "unopened";
  };
  dismissOperationError = () => this.patch({ operationError: null });
  get supportsServiceRestart() { return !!this.guideApi.previewServiceRestart && !!this.guideApi.restartService; }
  previewServiceStop = () => {
    if (!this.guideApi.previewServiceStop || this.state.phase !== "ready" || this.state.operation) throw Error(nativeTexts().serviceCannotStop);
    return this.guideApi.previewServiceStop();
  };
  stopService = async (confirmationId: string) => {
    if (!this.guideApi.stopService || this.state.phase !== "ready" || this.state.operation) throw Error(nativeTexts().serviceCannotStop);
    // End discovery before submission. Only the exact host-side operation decides
    // success; the guest disappearing during this shutdown cannot declare failure.
    this.patch({ phase: "stopping", guide: true, pending: null, selected: "current", error: null, detail: null, failedAt: null });
    this.stop();
    try {
      const result = await this.guideApi.stopService(confirmationId);
      if (!result.ok || result.connected) throw Error(this.reasonText(result.reasons) ?? nativeTexts().serviceStopUnconfirmed);
      this.patch({ phase: "service-stopped", inventory: null });
    } catch (error) {
      this.patch({ phase: "failed", inventory: null, error: nativeTexts().serviceStopFailed, detail: this.detailOf(error) });
      throw error;
    }
  };
  previewServiceRestart = () => {
    if (!this.supportsServiceRestart || !["failed", "service-stopped"].includes(this.state.phase)) throw Error(nativeTexts().restartUnavailable);
    return this.guideApi.previewServiceRestart!();
  };
  get supportsSurfaceReload() { return !!this.guideApi.desktopLaunchState && !!this.guideApi.presentationSnapshot; }
  reloadSurface = async (): Promise<NativeHostController> => {
    if (!this.supportsSurfaceReload || this.state.phase !== "failed") throw Error(nativeTexts().surfaceReloadUnavailable);
    try {
      const role = await this.guideApi.role();
      if (role.unavailable || !role.profileId) {
        throw Error(this.reasonText(role.reasons) ?? nativeTexts().surfaceReloadFailed);
      }
      const launch = await this.guideApi.desktopLaunchState!();
      if (launch.phase !== "ready") {
        throw Error(this.launchDiagnostics(launch).detail ?? nativeTexts().surfaceReloadServiceNotReady);
      }
      const snapshot = parsePortalSnapshot(await this.guideApi.presentationSnapshot!());
      if (
        !snapshot ||
        !launch.serviceEpoch ||
        snapshot.serviceEpoch !== launch.serviceEpoch ||
        (launch.managerId !== null && snapshot.managerId !== launch.managerId)
      ) {
        throw Error(nativeTexts().surfaceReloadFailed);
      }
      const manager = snapshot.managerId ? snapshot.spaces.find(row => row.id === snapshot.managerId) : undefined;
      if (!manager || manager.status !== "running") {
        throw Error(nativeTexts().surfaceReloadServiceNotReady);
      }
    } catch (error) {
      const detail = this.detailOf(error) ?? nativeTexts().surfaceReloadFailed;
      this.reportFailure("reload-surface", detail, new Date().toISOString(), null, error);
      throw error instanceof WorkbenchRemoteError ? new Error(detail) : error;
    }
    const next = new NativeHostController(this.guideApi, this.bridge, { readOnlyLaunch: true });
    next.notify(nativeTexts().surfaceReloadedNotice);
    return next;
  };
  restartService = async (confirmationId: string, resumeMode: ResumeSpacesMode = "running-and-policy"): Promise<NativeHostController> => {
    if (!this.supportsServiceRestart || !["failed", "service-stopped"].includes(this.state.phase)) throw Error(nativeTexts().restartUnavailable);
    const result = await this.guideApi.restartService!(confirmationId, resumeMode);
    if (!result.ok || !result.connected) throw Error(this.reasonText(result.reasons) ?? nativeTexts().restartFailed);
    // The failed controller stays terminal. A confirmed new service gets a new
    // controller, so old async responses and guest events cannot affect it.
    const next = new NativeHostController(this.guideApi, this.bridge);
    next.notify(nativeTexts().serviceStartedNotice);
    return next;
  };
  private notify(notice: string) {
    clearTimeout(this.noticeTimer); this.patch({ notice });
    this.noticeTimer = setTimeout(() => this.patch({ notice: null }), 8000);
  }
  private patch(change: Partial<NativeState>) {
    if ("inventory" in change) {
      for (const table of [this.readySpaces, this.failedSpaces]) {
        for (const [id, generation] of table) {
          if (!change.inventory?.spaces.some(row => row.id === id && row.status === "running" && row.generation === generation) ||
              change.inventory.serviceEpoch !== this.state.inventory?.serviceEpoch) table.delete(id);
        }
      }
      if (change.inventory && change.inventory.serviceEpoch !== this.state.inventory?.serviceEpoch) {
        this.seenCreations.clear(); this.dismissedCreations.clear();
      }
      for (const creation of change.inventory?.creating ?? []) {
        if (creation.status !== "failed") this.seenCreations.add(creation.jobId);
      }
    }
    this.state = { ...this.state, ...change }; for (const fn of this.listeners) fn();
  }
  /** Creation placeholders visible in this session: all active, plus failed ones seen while active and not dismissed. */
  visibleCreations = (): PortalCreation[] => {
    const creating = this.state.inventory?.creating ?? [];
    return creating.filter(creation =>
      creation.status !== "failed" || (this.seenCreations.has(creation.jobId) && !this.dismissedCreations.has(creation.jobId)));
  };
  dismissCreation = (jobId: string): void => {
    this.dismissedCreations.add(jobId);
    this.patch(this.state.creationFailed?.jobId === jobId ? { creationFailed: null } : {});
  };
  openCreation = (creation: PortalCreation): void => {
    if (creation.status === "failed") { this.patch({ creationFailed: creation }); return; }
    this.select("@settings");
  };
  closeCreationFailed = (): void => { this.patch({ creationFailed: null }); };
  private detailOf(error: unknown): string | null {
    if (error instanceof WorkbenchRemoteError && error.code === null && error.failureKind === "rpc-transport" && error.endpoint) {
      const stateSuffix = error.connectionState
        ? nativeTexts().hostRpcConnectionSuffix.replace("{state}", error.connectionState)
        : "";
      return nativeTexts().hostRpcFailed.replace("{endpoint}", error.endpoint).replace("{state}", stateSuffix);
    }
    const detail = publicGuideDetail(error instanceof Error ? error.message : String(error ?? ""));
    return detail || null;
  }
  private reasonText(reasons: string[] | undefined): string | null {
    return this.reasonLines(reasons);
  }
  private reasonLines(reasons: string[] | undefined): string | null {
    const lines = (reasons ?? []).map(item => publicGuideDetail(item)).filter(Boolean);
    return lines.length ? lines.join("\n") : null;
  }
  private bounded(text: string | undefined): string | null {
    if (!text) return null;
    const detail = publicGuideDetail(text);
    return detail || null;
  }
  async start(container: HTMLElement) {
    if (this.started) return;
    this.started = true;
    this.container = container;
    this.activityPoller?.start();
    if (!SPACES_BROWSER_SEALED) this.browser = new NativeBrowserHost(this.bridge, container);
    const generation = ++this.launchGeneration;
    try {
      const role = await this.guideApi.role();
      if (this.stopped || generation !== this.launchGeneration) return;
      if (role.unavailable || !role.profileId || !this.guideApi.presentationSnapshot) return this.fail(this.reasonText(role.reasons), null, undefined, "role");
      if (this.readOnlyLaunch) {
        if (!this.guideApi.desktopLaunchState) return this.fail(nativeTexts().desktopLaunchUnsupported, null, undefined, "reload-surface");
        const snapshot = await this.guideApi.desktopLaunchState();
        if (this.stopped || generation !== this.launchGeneration) return;
        await this.applyLaunch(snapshot, generation);
        return;
      }
      if (!this.guideApi.beginDesktopLaunch || !this.guideApi.desktopLaunchState) return this.fail(nativeTexts().desktopLaunchUnsupported, null, undefined, "launch");
      const snapshot = await this.guideApi.beginDesktopLaunch();
      if (this.stopped || generation !== this.launchGeneration) return;
      await this.applyLaunch(snapshot, generation);
    } catch (error) {
      if (!this.stopped && generation === this.launchGeneration) this.fail(this.detailOf(error), null, undefined, this.readOnlyLaunch ? "reload-surface" : "launch", error);
    }
  }
  private async readDirectory() {
    if (this.stopped || this.launchSettled === false || this.state.phase === "failed" || this.state.phase === "service-stopped") return;
    const version = this.directoryVersion;
    try {
      const snapshot = parsePortalSnapshot(await this.guideApi.presentationSnapshot!());
      if (this.stopped) return;
      if (!snapshot) throw Error("presentation snapshot rejected");
      if (this.acceptedDirectoryMismatch(snapshot)) { this.fail(nativeTexts().launchObservationEnded, null, undefined, "directory-poll"); return; }
      if (this.state.inventory && snapshot.serviceEpoch !== this.state.inventory.serviceEpoch) throw Error("presentation snapshot epoch changed");
      if (version === this.directoryVersion) this.patch({ phase: "ready", inventory: snapshot });
      this.pollTimer = setTimeout(() => { void this.readDirectory(); }, LAUNCH_POLL_MS);
    } catch (error) { this.fail(this.detailOf(error), null, undefined, "directory-poll", error); }
  }
  private async applyLaunch(snapshot: DesktopLaunchState, generation: number) {
    if (this.stopped || generation !== this.launchGeneration) return;
    // A live observer reports the change and stops. A replaced generation never reaches here.
    if (!this.acceptsLaunch(snapshot)) { this.fail(nativeTexts().launchObservationEnded, null, undefined, "launch"); return; }
    const phase = snapshot.phase;
    if (LAUNCH_BUSY.has(phase)) {
      this.patch({ phase });
      this.scheduleLaunchPoll(generation);
      return;
    }
    this.launchSettled = true;
    clearTimeout(this.launchTimer);
    if (phase === "ready") {
      await this.readDirectory();
      if (this.stopped || generation !== this.launchGeneration || this.state.phase !== "ready") return;
      this.consumeIntent();
      return;
    }
    if (phase === "failed") { this.failLaunch(snapshot); return; }
    if (phase === "stopped") { this.finishStopped(snapshot); return; }
    if (phase === "idle") { this.patch({ phase: "idle" }); return; }
    this.fail(nativeTexts().desktopLaunchUnsupported, null, undefined, "launch");
  }
  private acceptsLaunch(snapshot: DesktopLaunchState): boolean {
    if (snapshot.operationId) {
      if (this.launchOperationId && snapshot.operationId !== this.launchOperationId) return false;
      this.launchOperationId = snapshot.operationId;
    }
    if (snapshot.serviceEpoch) {
      if (this.launchEpoch && snapshot.serviceEpoch !== this.launchEpoch) return false;
      this.launchEpoch = snapshot.serviceEpoch;
    }
    if (snapshot.managerId) {
      if (this.launchManagerId && snapshot.managerId !== this.launchManagerId) return false;
      this.launchManagerId = snapshot.managerId;
    }
    return true;
  }
  /** First and later inventories stay on the launch epoch and manager already accepted. */
  private acceptedDirectoryMismatch(snapshot: PortalSnapshot): boolean {
    return (this.launchEpoch !== null && snapshot.serviceEpoch !== this.launchEpoch) ||
      (this.launchManagerId !== null && snapshot.managerId !== this.launchManagerId);
  }
  private scheduleLaunchPoll(generation: number) {
    clearTimeout(this.launchTimer);
    this.launchTimer = setTimeout(() => { void this.pollLaunch(generation); }, LAUNCH_POLL_MS);
  }
  private async pollLaunch(generation: number) {
    if (this.stopped || this.launchSettled || generation !== this.launchGeneration || !this.guideApi.desktopLaunchState) return;
    try {
      const snapshot = await this.guideApi.desktopLaunchState();
      if (this.stopped || this.launchSettled || generation !== this.launchGeneration) return;
      await this.applyLaunch(snapshot, generation);
    } catch (error) {
      if (!this.stopped && !this.launchSettled && generation === this.launchGeneration) this.fail(this.detailOf(error), null, undefined, "launch-poll", error);
    }
  }
  private launchDiagnostics(snapshot: DesktopLaunchState): { detail: string | null; cleanupDetail: string | null; instanceRetained: boolean | null } {
    const failure = snapshot.failure;
    if (!failure) return { detail: this.reasonLines(snapshot.reasons), cleanupDetail: null, instanceRetained: null };
    return {
      detail: this.bounded(failure.primaryReason),
      cleanupDetail: this.bounded(failure.cleanupReason),
      instanceRetained: failure.instanceRetained === true,
    };
  }
  private failLaunch(snapshot: DesktopLaunchState) {
    const diagnostics = this.launchDiagnostics(snapshot);
    this.fail(diagnostics.detail, null, diagnostics, "launch");
  }
  private finishStopped(snapshot: DesktopLaunchState) {
    const diagnostics = this.launchDiagnostics(snapshot);
    this.intent = null; this.createIntent = false; this.detailIntentSpaceId = null; this.desiredGuest = 0;
    this.patch({ phase: "service-stopped", guide: false, selected: "current", pending: null, navigationIntent: null, createHandoff: false,
      error: null, detail: diagnostics.detail, failedAt: null, cleanupDetail: diagnostics.cleanupDetail, instanceRetained: diagnostics.instanceRetained, inventory: null });
  }
  private consumeIntent() {
    const intent = this.intent;
    if (!intent || this.stopped || this.state.phase !== "ready") return;
    this.intent = null;
    this.patch({ navigationIntent: null });
    if (intent === "create") {
      this.createIntent = true;
      this.detailIntentSpaceId = null;
      this.selectingCreate = true;
      this.patch({ createHandoff: true });
      this.select("@settings");
      this.selectingCreate = false;
      return;
    }
    if (intent === "detail" && this.detailIntentSpaceId) {
      this.createIntent = false;
      this.selectingCreate = true;
      this.patch({ createHandoff: false });
      this.select("@settings");
      this.selectingCreate = false;
      return;
    }
    this.createIntent = false;
    this.detailIntentSpaceId = null;
    this.patch({ createHandoff: false });
    this.select("@settings");
  }
  showCurrent = () => {
    this.browserRequest = undefined; this.browser?.hide();
    this.sequence++; this.desiredGuest = 0; clearTimeout(this.selectionTimer);
    this.createIntent = false; this.detailIntentSpaceId = null; this.intent = null;
    this.patch({ selected: "current", pending: null, guide: false, navigationIntent: null, createHandoff: false });
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
    if (this.stopped) { this.clearNavigationIntent(); this.select("@settings"); return; }
    if (this.state.phase === "failed" || this.state.phase === "service-stopped" || this.state.phase === "stopping") {
      this.clearNavigationIntent();
      if (this.state.phase !== "stopping") this.select("@settings");
      return;
    }
    this.createIntent = true;
    this.detailIntentSpaceId = null;
    this.intent = "create";
    this.patch({ navigationIntent: "create", createHandoff: true, ...(this.state.phase === "ready" ? {} : { guide: true }) });
    if (this.state.phase !== "ready") return;
    this.selectingCreate = true;
    this.select("@settings");
    this.selectingCreate = false;
  };
  /**
   * Open one space's detail page inside the workbench settings surface.
   *
   * Navigates the guest to `@settings` first and then hands over a closed
   * `#intent/detail/<requestId>/<spaceId>` fragment through the portal.
   */
  openSpaceSettings = (spaceId: string) => {
    if (!PORTAL_SPACE_RE.test(spaceId) || spaceId === "desktop" || spaceId === this.state.inventory?.managerId) return;
    if (this.stopped) { this.clearNavigationIntent(); this.select("@settings"); return; }
    if (this.state.phase === "failed" || this.state.phase === "service-stopped" || this.state.phase === "stopping") {
      this.clearNavigationIntent();
      if (this.state.phase !== "stopping") this.select("@settings");
      return;
    }
    if (this.state.phase === "ready" && this.state.selected === "@settings" && !this.state.pending &&
        !this.state.guide && !this.state.operation && this.guest && this.nativeUrl) {
      this.clearNavigationIntent();
      this.browserRequest = undefined; this.browser?.hide();
      this.guest.focus();
      this.handOverDetailIntent(spaceId);
      return;
    }
    this.createIntent = false;
    this.detailIntentSpaceId = spaceId;
    this.intent = "detail";
    this.patch({ navigationIntent: "detail", createHandoff: false, ...(this.state.phase === "ready" ? {} : { guide: true }) });
    if (this.state.phase !== "ready") return;
    this.selectingCreate = true;
    this.select("@settings");
    this.selectingCreate = false;
  };
  select = (target: NativeSpaceTarget) => {
    if (!isNativeSpaceTarget(target)) return;
    // After a failure this controller is stopped for good (let it crash). A
    // later click shows the recorded failure again instead of doing nothing;
    // it never reconnects or retries.
    if (this.stopped) { if (["failed", "service-stopped", "stopping"].includes(this.state.phase) && !this.state.guide) this.patch({ guide: true }); return; }
    if (this.state.phase === "stopping") return;
    if (this.state.phase !== "ready") {
      if (target !== "@settings" || this.selectingCreate) return;
      this.createIntent = false;
      this.detailIntentSpaceId = null;
      this.intent = this.state.phase === "failed" || this.state.phase === "service-stopped" ? null : "settings";
      this.patch({ navigationIntent: this.intent, createHandoff: false, guide: true });
      return;
    }
    if (target === "@settings" && !this.selectingCreate) {
      this.createIntent = false;
      this.detailIntentSpaceId = null;
      this.intent = null;
      this.patch({ navigationIntent: null, createHandoff: false });
    }
    if (this.state.operation) return;
    const inventory = this.state.inventory;
    const running = inventory?.spaces.some(s => s.id === target && s.id !== inventory.managerId && s.status === "running");
    // Navigation to a live child is presentation only. The manager owns the
    // ready-frame cache and validates its identity before acknowledging it.
    if (!target.startsWith("@") && !running && this.guideApi.spaceAction) {
      void this.spaceAction(target, "open"); return;
    }
    this.browserRequest = undefined; this.browser?.hide();
    if (!target.startsWith("@") && !running) {
      this.patch({ guide: true, error: nativeTexts().spaceNotRunning, detail: null }); return;
    }
    this.navigate(target);
  };

  cancelSpaceAction = () => this.patch({ spaceConfirmation: null });
  confirmSpaceAction = () => {
    const confirmed = this.state.spaceConfirmation;
    if (!confirmed) return;
    this.patch({ spaceConfirmation: null });
    void this.spaceAction(confirmed.request.spaceId, confirmed.request.action, confirmed.request);
  };
  spaceAction = async (spaceId: string, action: DesktopSpaceAction["action"], confirmed?: DesktopSpaceAction) => {
    const inventory = this.state.inventory;
    if (this.stopped || this.state.phase !== "ready" || this.state.operation || !this.guideApi.spaceAction ||
        !inventory || !inventory.spaces.some(row => row.id === spaceId && row.id !== inventory.managerId && row.id !== "desktop")) return;
    let request: DesktopSpaceAction = { spaceId, action, serviceEpoch: inventory.serviceEpoch };
    if (action === "stop" || action === "restart") {
      if (confirmed) {
        if (confirmed.serviceEpoch !== inventory.serviceEpoch || confirmed.expectedGeneration !== inventory.spaces.find(row => row.id === spaceId)?.generation) {
          this.patch({ operationError: nativeTexts().spaceChangedRetry }); return;
        }
        request = confirmed;
      } else {
        this.patch({ operation: { spaceId, action }, operationError: null });
        try {
          const activity = this.guideApi.spaceActivity ? await this.guideApi.spaceActivity(spaceId, inventory.serviceEpoch)
            : { activity: "unknown" as const, generation: inventory.spaces.find(row => row.id === spaceId)!.generation };
          if (this.stopped) return;
          request.expectedGeneration = activity.generation;
          if (activity.activity !== "idle") {
            this.patch({ operation: null, spaceConfirmation: { request: { ...request, interruptAccepted: true }, activity: activity.activity } }); return;
          }
        } catch (error) {
          if (!this.stopped) this.patch({ operation: null, operationError: this.detailOf(error) }); return;
        }
      }
    }
    const enter = action === "open" || action === "start" || (action === "restart" && this.state.selected === spaceId);
    if (action === "stop" || action === "restart") { this.readySpaces.delete(spaceId); this.failedSpaces.delete(spaceId); }
    if ((action === "stop" || action === "restart") && (this.state.selected === spaceId || this.state.pending === spaceId)) this.showCurrent();
    const intent = enter ? ++this.sequence : this.sequence;
    if (enter) this.desiredGuest = intent;
    if (enter) clearTimeout(this.selectionTimer);
    this.patch({ ...(enter ? { pending: null } : {}), operation: { spaceId, action }, operationError: null });
    // This explicit open owns both operations. Preparing the authenticated
    // presentation can run alongside the child launch; it never starts a child.
    const preparation = enter ? this.open().then(() => null, error => ({ error })) : null;
    try {
      const snapshot = parsePortalSnapshot(await this.guideApi.spaceAction(request));
      if (this.stopped) return;
      if (!snapshot || snapshot.serviceEpoch !== inventory.serviceEpoch) throw Error("The space service changed during the operation.");
      this.directoryVersion++;
      this.patch({ inventory: snapshot, operation: null, ...(enter && intent === this.sequence ? { pending: spaceId } : {}) });
      const name = snapshot.spaces.find(row => row.id === spaceId)?.displayName ?? spaceId;
      if (action === "stop") this.notify(nativeTexts().spaceStoppedNotice.replace("{name}", name));
      else if (action === "restart") this.notify(nativeTexts().spaceRestartedNotice.replace("{name}", name));
      else if (inventory.spaces.find(row => row.id === spaceId)?.status !== "running") this.notify(nativeTexts().spaceStartedNotice.replace("{name}", name));
      if (enter && intent === this.sequence) {
        const prepared = await preparation;
        if (this.stopped || intent !== this.sequence) return;
        if (prepared) { this.fail(this.detailOf(prepared.error), null, undefined, "guest-bootstrap", prepared.error); return; }
        this.navigate(spaceId);
      }
    } catch (error) {
      if (!this.stopped) this.patch({ operation: null, operationError: this.detailOf(error) ?? nativeTexts().spaceActionFailed });
    }
  };

  private navNote(ev: string, extra?: object) {
    try { this.navDiag(ev, extra); } catch { /* diagnosis never changes navigation */ }
  }
  private navEnd() {
    try { this.navDiag.end(); } catch { /* diagnosis never changes navigation */ }
  }
  /** First selected, rejected, or portal failure closes the diagnosis. */
  private navOutcome(ev: "ready" | "fail", endNow: boolean) {
    if (this.navOutcomeNoted) return;
    this.navOutcomeNoted = true;
    this.navNote(ev);
    if (endNow) this.navEnd();
  }
  private navigate(target: NativeSpaceTarget) {
    if (!this.navNavigateNoted) {
      this.navNavigateNoted = true;
      this.navNote("user-select", { targetKind: target === "@settings" ? "settings" : "space" });
    }
    this.browserRequest = undefined; this.browser?.hide();
    const requestId = ++this.sequence;
    this.desiredGuest = requestId;
    const generation = target.startsWith("@") ? undefined : this.state.inventory?.spaces.find(row => row.id === target)?.generation;
    this.navigationGeneration = generation;
    const fragment = "#select/" + requestId + "/" + target + (generation === undefined ? "" : "/" + generation);
    this.patch({ pending: target, error: null, detail: null, guide: false });
    clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      if (this.sequence === requestId) {
        this.navNote("deadline", { stage: "selection" });
        this.fail(this.selectionDeadlineDetail(), null, undefined, "selection-timeout");
      }
    }, NATIVE_SELECTION_DEADLINE_MS);
    let selectRejected = false;
    void this.open().then(async () => {
      if (this.stopped || requestId !== this.sequence) return;
      this.navNote("select-load-start");
      try {
        await this.guest!.loadURL(this.nativeUrl! + fragment);
      } catch (error) {
        selectRejected = true;
        throw error;
      }
      this.navNote("select-load-complete");
    }).catch((error) => {
      this.navNote("select-load-reject");
      if (this.stopped || requestId !== this.sequence || this.state.pending !== target) return;
      // Electron can reject the request URL after the page has already acknowledged
      // the same-document navigation. Read that exact acknowledgement before failing.
      try {
        const actual = this.guest?.getURL();
        this.observed(actual);
        // The fragment is already committed even when Electron rejects loadURL.
        // Keep waiting for its bounded acknowledgement; do not send it again.
        if (!this.stopped && this.state.pending === target &&
          actual !== this.nativeUrl + fragment) {
          this.fail(
            selectRejected ? nativeTexts().selectionLoadMismatch : this.detailOf(error) ?? nativeTexts().guestOpenFailed,
            null,
            undefined,
            selectRejected ? "navigation" : "guest-bootstrap",
            error,
          );
        }
      } catch (innerError) { this.fail(this.detailOf(innerError), null, undefined, "navigation", innerError); }
    });
  }
  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.createGuest(); return this.opening;
  }
  private async createGuest() {
    const target: WorkbenchReturnTarget = await this.guideApi.returnTarget();
    this.navNote("return-target");
    if (this.stopped || this.desiredGuest === 0) { this.opening = undefined; return; }
    const origin = new URL(target.origin ?? "about:blank");
    if (!target.available || origin.origin !== target.origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" ||
      origin.username || origin.password || !/^\/bootstrap\/[A-Za-z0-9_-]{16,128}$/.test(target.path ?? "")) throw Error("return target rejected");
    const reservation = await this.bridge.acquire("dsh-spaces:" + target.origin + ":" + this.channel);
    this.navNote("bridge-acquired");
    if (this.stopped || this.desiredGuest === 0) {
      this.opening = undefined;
      await this.bridge.release(reservation.lease).catch(() => console.error("Spaces native guest release failed."));
      return;
    }
    this.lease = reservation.lease;
    const element = document.createElement("webview") as Guest; this.guest = element;
    this.navNote("guest-created");
    element.className = "dsh-native-guest";
    element.setAttribute("partition", reservation.partition);
    element.setAttribute("name", reservation.lease);
    element.setAttribute("src", "about:blank#" + reservation.lease);
    element.setAttribute("aria-label", nativeTexts().guestContent);
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      let initialFinished = false;
      const finish = (error: Error | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.lifetime.signal.removeEventListener("abort", aborted);
        element.removeEventListener("did-stop-loading", onStop);
        error ? reject(error) : resolve();
      };
      const aborted = () => finish(new Error("native guest load aborted"));
      const timeout = setTimeout(() => finish(new Error(nativeTexts().guestInitialLoadTimeout)), 15000);
      this.lifetime.signal.addEventListener("abort", aborted, { once: true });
      // dom-ready is only an observation. Electron can settle the next loadURL
      // on this blank page's did-finish-load or did-stop-loading, so bootstrap
      // waits until that finish has been seen and its stop has arrived.
      element.addEventListener("dom-ready", () => { this.navNote("guest-dom-ready"); }, { once: true });
      element.addEventListener("did-finish-load", () => { initialFinished = true; }, { once: true });
      const onStop = () => {
        if (settled || !initialFinished) return;
        this.navNote("guest-load-stopped");
        finish();
      };
      element.addEventListener("did-stop-loading", onStop);
    });
    element.addEventListener("did-fail-load", event => {
      const failure = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean; validatedURL?: string };
      try {
        this.navDiag("did-fail-load", {
          url: failure.validatedURL, isMainFrame: failure.isMainFrame, errorCode: failure.errorCode,
          ignored: failure.isMainFrame === false || failure.errorCode === -3,
        });
      } catch { /* diagnosis never changes the failure decision */ }
      if (failure.isMainFrame !== false && failure.errorCode !== -3) {
        // The validated URL can carry credentials; only the numeric code and its description are reported.
        const bits = [
          typeof failure.errorCode === "number" ? String(failure.errorCode) : null,
          typeof failure.errorDescription === "string" && failure.errorDescription ? failure.errorDescription : null,
        ].filter((part): part is string => part !== null);
        this.fail(nativeTexts().guestLoadFailed.replace("{detail}", bits.join(" ") || "unknown"), null, undefined, "guest-load");
      }
    });
    element.addEventListener("did-start-navigation", event => { this.navNote("did-start-navigation", event); });
    element.addEventListener("did-frame-navigate", event => { this.navNote("did-frame-navigate", event); });
    element.addEventListener("console-message", event => {
      const rec = parseNavDiag((event as Event & { message?: unknown }).message);
      if (rec) this.recordNavDiag(rec);
    });
    element.addEventListener("render-process-gone", event => {
      const details = (event as Event & { details?: { reason?: unknown; exitCode?: unknown } }).details;
      const bits = [
        typeof details?.reason === "string" && details.reason ? details.reason : null,
        typeof details?.exitCode === "number" ? String(details.exitCode) : null,
      ].filter((part): part is string => part !== null);
      this.fail(nativeTexts().guestProcessGone.replace("{detail}", bits.join(", ") || "unknown"), null, undefined, "guest-crashed");
    });
    element.addEventListener("did-navigate-in-page", event => { this.navNote("did-navigate-in-page", event); this.observed(); });
    this.container!.append(element); await ready;
    if (this.stopped || this.desiredGuest === 0) {
      element.remove(); this.guest = undefined; this.opening = undefined;
      const lease = this.lease; this.lease = undefined;
      if (lease) await this.bridge.release(lease).catch(() => console.error("Spaces native guest release failed."));
      return;
    }
    this.nativeUrl = target.origin + "/native/" + this.channel;
    // Exchange the single-use token directly into the native portal. Visiting
    // the ordinary root first also mounts a manager UI that is then discarded.
    this.navNote("bootstrap-load-start");
    try {
      await element.loadURL(target.origin + target.path + "?native=" + this.channel);
    } catch (error) {
      this.navNote("bootstrap-load-reject");
      throw new Error(nativeTexts().guestBootstrapFailed, { cause: error });
    }
    this.navNote("bootstrap-load-complete");
    if (!this.stopped && element.getURL() !== this.nativeUrl) throw Error("native channel rejected");
    element.addEventListener("did-navigate", () => { if (!this.stopped && !element.getURL().startsWith(this.nativeUrl! + "#") && element.getURL() !== this.nativeUrl) this.fail(nativeTexts().guestNavigatedAway, null, undefined, "guest-navigated"); });
  }
  private observed(observedUrl?: string) {
    if (this.stopped || !this.guest || !this.nativeUrl) return;
    let url: URL;
    try { url = new URL(observedUrl ?? this.guest.getURL()); }
    catch { this.fail(nativeTexts().invalidPortalAddress, null, undefined, "guest-navigated"); return; }
    if (url.origin + url.pathname !== this.nativeUrl || url.search || url.username || url["password"]) { this.fail(nativeTexts().invalidPortalAddress, null, undefined, "guest-navigated"); return; }
    if (/^#service-stop-preview\/[1-9][0-9]{0,9}$/.test(url.hash)) {
      if (this.state.phase === "ready" && this.state.selected === "@settings" && !this.state.pending && !this.state.operation)
        this.patch({ serviceStopRequest: this.state.serviceStopRequest + 1 });
      return;
    }
    if (url.hash === "#failed") { this.fail(nativeTexts().portalFailureNoDetail, null, undefined, "portal"); return; }
    if (url.hash.startsWith("#failed")) {
      const failure = parseNativePortalFailureHash(url.hash);
      this.fail(failure ? portalFailureDetail(failure) : nativeTexts().portalFailureNoDetail, failure, undefined, "portal");
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
    // Create and detail intents are requests, never answers and never failures.
    if (parseNativeCreateIntent(url.hash) !== null || parseNativeDetailIntent(url.hash) !== null) return;
    const answer = parseNativeSpaceHash(url.hash);
    if (!answer || answer.kind === "select" || answer.requestId !== this.sequence || answer.target !== this.state.pending) return;
    clearTimeout(this.selectionTimer);
    const row = this.state.inventory?.spaces.find(space => space.id === answer.target);
    if (answer.kind === "rejected") {
      this.readySpaces.delete(answer.target);
      if (row) this.failedSpaces.set(row.id, row.generation);
      this.patch({ pending: null, guide: true, error: nativeTexts().spaceViewFailed, detail: null });
      this.navOutcome("fail", true);
      this.reportFailure("selection-rejected", nativeTexts().spaceViewFailed, new Date().toISOString());
      return;
    }
    if (row?.status === "running" && row.generation === this.navigationGeneration) { this.readySpaces.set(row.id, row.generation); this.failedSpaces.delete(row.id); }
    this.patch({ selected: answer.target, pending: null, guide: false }); this.guest.focus();
    if (this.createIntent && answer.target === "@settings") {
      this.createIntent = false;
      this.detailIntentSpaceId = null;
      this.handOverCreateIntent();
    } else if (this.detailIntentSpaceId && answer.target === "@settings") {
      const spaceId = this.detailIntentSpaceId;
      this.detailIntentSpaceId = null;
      this.handOverDetailIntent(spaceId);
    }
    this.navOutcome("ready", true);
  }
  /**
   * The manager guest lives in another origin than this shell. The portal
   * page in between carries the closed create intent to it.
   */
  private handOverCreateIntent() {
    const intent = this.nativeUrl + nativeCreateIntentHash(++this.intentSequence);
    // Electron can reject the same-document hash load after the fragment is
    // already committed. The committed URL decides; a rejected hash load
    // never fails this shell.
    void this.guest!.loadURL(intent).catch(() => {
      try {
        if (this.guest?.getURL() !== intent) this.patch({ guide: true, error: nativeTexts().createDialogFailed, detail: null });
      } catch { this.patch({ guide: true, error: nativeTexts().createDialogFailed, detail: null }); }
    });
  }
  private handOverDetailIntent(spaceId: string) {
    const intent = this.nativeUrl + nativeDetailIntentHash(++this.intentSequence, spaceId);
    void this.guest!.loadURL(intent).catch(() => {
      try {
        if (this.guest?.getURL() !== intent) this.patch({ guide: true, error: nativeTexts().spaceSettingsFailed, detail: null });
      } catch { this.patch({ guide: true, error: nativeTexts().spaceSettingsFailed, detail: null }); }
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
    catch (error) { if (!this.stopped && this.guest?.getURL() !== responseUrl && this.browserRequest === request.requestId) this.fail(nativeTexts().browserResultFailed, null, undefined, "browser-relay", error); }
  }
  private clearNavigationIntent() {
    this.intent = null; this.createIntent = false; this.detailIntentSpaceId = null;
    if (this.state.navigationIntent || this.state.createHandoff) this.patch({ navigationIntent: null, createHandoff: false });
  }
  private selectionDeadlineDetail(): string {
    const ignoredEvents = new Set([
      "did-start-navigation",
      "did-frame-navigate",
      "did-navigate-in-page",
      "deadline",
      "fail",
      "terminal",
      "destroyed",
    ]);
    const tail = this.navTrail.filter(row => !ignoredEvents.has(row.ev)).slice(-5);
    if (tail.length === 0) return nativeTexts().selectionDeadline;
    const stages = tail.map(row => `${row.src}:${row.ev}${row.stage ? `(${row.stage})` : ""}`).join(" -> ");
    return nativeTexts().selectionDeadline + nativeTexts().selectionStageSuffix.replace("{stages}", stages);
  }
  private recordNavDiag(row: NavDiagRecord) {
    const clean = parseNavDiag(JSON.stringify(row));
    if (!clean) return;
    if (this.navTrail.length >= 64) this.navTrail.shift();
    this.navTrail.push(clean);
  }
  private reportFailure(
    stage: ClientFailureStage,
    detail: string | null,
    failedAt: string,
    portalFailure: PortalFailure | null = null,
    cause?: unknown,
  ) {
    if (!this.guideApi.reportClientFailure) return;
    const boundedDetail = detail ? publicGuideDetail(detail).slice(0, 500) || null : null;
    const report: ClientFailureReport = {
      surface: "desktop-native",
      stage,
      detail: boundedDetail,
      failedAt,
      portalFailure,
      ...(this.navTrail.length > 0 ? { navTrail: [...this.navTrail] } : {}),
      ...(cause instanceof WorkbenchRemoteError ? {
        ...(cause.endpoint ? { rpcEndpoint: cause.endpoint } : {}),
        rpcFailureKind: cause.failureKind,
        ...(cause.connectionState ? { connectionState: cause.connectionState } : {}),
      } : {}),
    };
    void this.guideApi.reportClientFailure(report).catch(() => undefined);
  }
  private fail(
    detail: string | null = null,
    portalFailure: PortalFailure | null = null,
    diagnostics?: { cleanupDetail: string | null; instanceRetained: boolean | null },
    stage: ClientFailureStage = "navigation",
    cause?: unknown,
  ) {
    if (this.stopped) return;
    this.navOutcome("fail", false);
    // Background discovery must not cover the main application. Keep the
    // failure terminal and inspectable; show it immediately only when the user
    // is already using or opening a Spaces surface.
    this.launchSettled = true;
    this.intent = null; this.createIntent = false; this.detailIntentSpaceId = null; this.desiredGuest = 0;
    const guide = this.state.guide || this.state.selected !== "current" || this.state.pending !== null;
    const failedAt = new Date().toISOString();
    this.patch({ phase: "failed", pending: null, operation: null, inventory: null, selected: "current", guide,
      navigationIntent: null, createHandoff: false, error: nativeTexts().serviceUnavailable, detail, failedAt,
      cleanupDetail: diagnostics?.cleanupDetail ?? null, instanceRetained: diagnostics?.instanceRetained ?? null, portalFailure });
    this.reportFailure(stage, detail, failedAt, portalFailure, cause);
    this.stop();
  }
  stop = () => {
    if (this.stopped) return;
    this.stopped = true; this.lifetime.abort(); this.launchGeneration++; this.launchSettled = true; this.desiredGuest = 0;
    this.activityPoller?.stop();
    this.sequence++; clearTimeout(this.pollTimer); clearTimeout(this.launchTimer); clearTimeout(this.selectionTimer);
    clearTimeout(this.noticeTimer);
    this.browserRequest = undefined; this.browser?.stop();
    this.guest?.remove(); this.guest = undefined;
    const lease = this.lease; this.lease = undefined;
    if (lease) void this.bridge.release(lease).catch(() => console.error("Spaces native guest release failed."));
    this.navNote("destroyed");
    this.navEnd();
  };
}
