import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import { canonicalHome } from "../../../../src/adapters/node/home/home-operation-lock";
import { bindDshCli, isCompatibleDshCliVersion } from "../../../../src/adapters/node/products/spaces-service";
import { publicReason } from "../../../../src/adapters/node/runtime/start-failure";
import type { WorkbenchStartupFailure } from "../../../../src/shared/workbench-startup";
import type { WorkbenchApi, WorkbenchState } from "../../../../src/shared/workbench";
import { WORKBENCH_ENTRY_UNAVAILABLE } from "../../../../src/shared/workbench-errors";
import type {
  DesktopLaunchState,
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchHostHint,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
} from "../types";
import { resolveHostIdentity, type HostIdentity, type HostIdentityInput } from "./identity";
import { DesktopServiceRestart } from "./service-restart";
import { runDesktopSpaceAction } from "./space-action";
import { validDesktopSpaceAction, type DesktopSpaceAction } from "../types";
import { createWorkbenchHttpClient, mintSupervisorHandoff, mintSupervisorPortal, type WorkbenchHttpClientOptions } from "./workbench-http";
import {
  copyFailure,
  joinLaunch,
  launchIsBusy,
  readLaunch,
  replaceLaunch,
  snapshotLaunch,
  updateLaunch,
  type DesktopLaunchRecord,
} from "./desktop-launch";
import {
  observeStartupRead,
  publicObservationReason,
  STARTUP_EPOCH_MISMATCH,
  STARTUP_READY_INCONSISTENT,
  startupFailureReasons,
  type StartupObservationReader,
  type StartupWatch,
  type StartupWatchEvent,
} from "./startup-observation";
import { attachExistingSupervisor, pingSupervisorState, type SupervisorAttachResult } from "./supervisor-attach";
import {
  bootstrapSupervisor,
  defaultPayloadRoot,
  defaultToolsRoot,
  type SupervisorBootstrapOptions,
  type SupervisorEndpoint,
} from "./supervisor-bootstrap";

import { parseSpaceHostAudience, parsePortalSnapshot, projectSpaceCreations, type PortalSnapshot, type SpaceHostAudience } from "../../../../src/shared/space-host";

const inflight = new Map<string, Promise<WorkbenchBootstrapResult>>();
const initializeInflight = new Map<string, Promise<WorkbenchBootstrapResult>>();
const spaceActions = new Set<string>();

const IDENTITY_DAMAGED = "Manager identity is damaged or ambiguous and cannot be guessed.";
const HANDOFF_FAILED = "The workbench entry handoff could not be minted.";
const ENTRY_UNAVAILABLE = WORKBENCH_ENTRY_UNAVAILABLE;

export interface WorkbenchHostRuntimeOptions extends HostIdentityInput {
  snapshotRoot?: string;
  payloadRoot?: string;
  toolsRoot?: string;
  supervisorTimeoutMs?: number;
  execPath?: string;
  bootstrap?: (options: SupervisorBootstrapOptions) => ReturnType<typeof bootstrapSupervisor>;
  connect?: (options: WorkbenchHttpClientOptions) => WorkbenchApi;
  fetch?: WorkbenchHttpClientOptions["fetch"];
}

export class WorkbenchHostRuntime {
  readonly snapshotRoot?: string;
  private endpoint: SupervisorEndpoint | null = null;
  private api: WorkbenchApi | null = null;
  private readonly attachedListeners=new Set<(endpoint:SupervisorEndpoint)=>Promise<void>>();
  private readonly stoppedListeners = new Set<(previousEpoch: string | null) => Promise<void>>();
  private serviceRestart?: DesktopServiceRestart;
  private restarting = false;
  private connectionGeneration = 0;
  private attachedEpoch: string | null = null;
  private acceptingListeners = false;
  private pendingEndpoint: SupervisorEndpoint | null = null;
  private deliveredTo = new WeakSet<(endpoint: SupervisorEndpoint) => Promise<void>>();
  private attachmentFlight: Promise<void> | null = null;
  private attachmentFlightEpoch: string | null = null;
  private attachmentBusy = 0;
  private attachmentIdle: (() => void) | undefined;
  onSupervisorAttached(listener:(endpoint:SupervisorEndpoint)=>Promise<void>, stopped?: (previousEpoch: string | null) => Promise<void>):()=>void {
    this.attachedListeners.add(listener);
    if (stopped) this.stoppedListeners.add(stopped);
    const endpoint = this.endpoint ?? this.pendingEndpoint;
    if (this.acceptingListeners && endpoint) {
      const generation = this.connectionGeneration;
      void this.callListenerOnce(listener, endpoint).catch((error) => this.failLateAttachment(error, generation));
    }
    return () => { this.attachedListeners.delete(listener); if (stopped) this.stoppedListeners.delete(stopped); };
  }
  private readonly options: WorkbenchHostRuntimeOptions;

  constructor(options: WorkbenchHostRuntimeOptions = {}) {
    this.options = options;
    this.snapshotRoot = typeof options.snapshotRoot === "string" ? options.snapshotRoot : undefined;
  }

  get allowRealHome(): boolean {
    return this.options.allowRealHome === true;
  }

  get identity(): HostIdentity {
    return resolveHostIdentity(this.options);
  }

  get shouldRegisterManager(): boolean {
    return this.identity.role === "manager" && !this.identity.recoveryRequired && this.identity.confirmed;
  }

  /**
   * Confirmed main host that may expose Creator tools: the operator's own
   * web/desktop profile, never a child space and never the manager profile.
   * Child spaces are also role "workspace", so the profile id itself must be
   * the trusted host identity, not the role.
   */
  get isTrustedMainHost(): boolean {
    const identity = this.identity;
    if (!identity.confirmed || identity.recoveryRequired || !identity.home) return false;
    if (identity.role === "manager") return false;
    return identity.profileId === "web" || identity.profileId === "desktop";
  }

  get canColdStart(): boolean {
    if (this.identity.recoveryRequired || !this.identity.confirmed) return false;
    return this.identity.role === "manager";
  }

  qualifiesForAutomaticDesktopLaunch(): boolean {
    return this.desktopIdentityRejection() === null;
  }

  hint(): WorkbenchHostHint {
    return {
      role: this.identity.role,
      unavailable: this.identity.recoveryRequired,
    };
  }

  guideRole(): WorkbenchGuideRole {
    return {
      role: this.identity.role,
      profileId: this.identity.profileId,
      managerId: this.identity.managerId,
      unavailable: this.identity.recoveryRequired,
      reasons: [...this.identity.reasons],
    };
  }

  /** Attach and read only. Never bootstrap, initialize or retire an owner during discovery. */
  async presentationSnapshot(): Promise<PortalSnapshot> {
    return this.snapshotFromState(await this.readPresentationState());
  }

  private async readPresentationState(): Promise<WorkbenchState> {
    this.assertNotRestarting();
    const identity = this.identity;
    if (!identity.confirmed || identity.recoveryRequired || !identity.home) throw new Error(ENTRY_UNAVAILABLE);
    if (this.endpoint && this.retiredByCurrentLaunch()) await this.supervisorReplaced(this.endpoint.serviceEpoch);
    if (!this.api || !this.endpoint) {
      const attached = await attachExistingSupervisor({ home: identity.home, allowRealHome: this.options.allowRealHome === true, fetch: this.options.fetch, timeoutMs: this.options.supervisorTimeoutMs });
      if (!("endpoint" in attached)) throw new Error(ENTRY_UNAVAILABLE);
      await this.remember(attached.endpoint);

    }
    return this.api!.state();
  }

  private snapshotFromState(state: WorkbenchState): PortalSnapshot {
    const failure = [...state.jobs].reverse().find(job => job.kind === "plan.execute");
    if (state.maintenance && failure?.status === "failed") {
      throw new Error([failure?.error?.message, ...state.reasons].filter(Boolean).join(" ") || "Maintenance has stopped the manager. The owning service remains blocked.");
    }
    const creating = projectSpaceCreations(state.jobs);
    const snapshot = parsePortalSnapshot({ serviceEpoch: state.serviceEpoch, managerId: state.managerId,
      ...(creating.length ? { creating } : {}),
      spaces: state.spaces.filter(row => row.hasWebApp).map(row => ({ id: row.id, displayName: row.displayName, status: row.status, generation: row.generation, ...(row.icon ? { icon: row.icon } : {}), ...(row.attention === undefined ? {} : { attention: row.attention }) })) });
    if (!snapshot) throw new Error(ENTRY_UNAVAILABLE);
    return snapshot;
  }

  async spaceAction(request: DesktopSpaceAction): Promise<PortalSnapshot> {
    this.assertNotRestarting();
    if (!validDesktopSpaceAction(request)) throw Error("Invalid space action.");
    // Reuse the same verified Desktop identity gate as explicit service control.
    this.restartOperation();
    const key = resolve(this.identity.home!) + ":" + request.spaceId;
    if (spaceActions.has(key)) throw Error("A space operation is already in progress.");
    spaceActions.add(key);
    try {
      const state = await this.readPresentationState(); // attach read-only; never launch the service here
      this.snapshotFromState(state);
      const final = await runDesktopSpaceAction(this.api!, request, this.options.supervisorTimeoutMs, state);
      return this.snapshotFromState(final);
    } finally { spaceActions.delete(key); }
  }

  async spaceActivity(spaceId: string, serviceEpoch: string): Promise<{ activity: "idle" | "busy" | "unknown"; generation: number }> {
    this.assertNotRestarting(); this.restartOperation();
    const state = await this.readPresentationState();
    this.snapshotFromState(state);
    const space = state.spaces.find(row => row.id === spaceId);
    if (state.serviceEpoch !== serviceEpoch || !space || !space.managed || space.isHost || spaceId === state.managerId || ["desktop", "web"].includes(spaceId)) throw Error("空间状态已变化，无法确认操作影响。");
    const plan = await this.api!.preview({ kind: "space.stop", spaceId }, { serviceEpoch, expectedRevision: state.revision });
    return { activity: plan.taskActivity ?? "unknown", generation: space.generation };
  }

  async bootstrap(): Promise<WorkbenchBootstrapResult> {
    this.assertNotRestarting();
    if (this.identity.recoveryRequired) {
      return {
        ok: false,
        connected: false,
        unavailable: true,
        origin: null,
        reasons: this.identity.reasons.length ? this.identity.reasons : [IDENTITY_DAMAGED],
      };
    }
    const home = this.identity.home;
    if (!home) {
      return {
        ok: false,
        connected: false,
        unavailable: false,
        origin: null,
        reasons: this.identity.reasons.length ? this.identity.reasons : ["Host identity could not be confirmed."],
      };
    }
    if (this.endpoint && this.api) {
      const origin = this.endpoint.origin;
      try {
        if (await pingSupervisorState(this.endpoint, this.options.fetch, this.options.supervisorTimeoutMs)) {
          return {
            ok: true,
            connected: true,
            unavailable: false,
            origin,
            reasons: [],
          };
        }
      } catch (error) {
        return {
          ok: false,
          connected: false,
          unavailable: false,
          origin,
          reasons: [publicObservationReason(error)],
        };
      }
      // A legal HTTP state whose epoch or protocol does not match is terminal.
      // Do not discover or launch again.
      return {
        ok: false,
        connected: false,
        unavailable: false,
        origin,
        reasons: [STARTUP_EPOCH_MISMATCH],
      };
    }
    const key = resolve(home);
    const existing = inflight.get(key);
    if (existing) return existing;
    const pending = this.connectSupervisor(this.canColdStart).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }

  async portalTarget(audience: SpaceHostAudience): Promise<WorkbenchReturnTarget> {
    // Check transport before attaching or starting anything. No application-name detection.
    const valid = parseSpaceHostAudience(audience);
    if (!valid) throw new Error("workbench/unsupported");
    const boot = await this.bootstrap();
    if (!boot.connected || !this.endpoint) return { available: false, origin: null, path: null, unavailable: boot.unavailable, reasons: boot.reasons };
    // The listener is published before the manager has finished its initial launch.
    // Observe that launch before issuing a one-use browser entry; never replay it.
    const waiting = await this.waitForManager();
    if (waiting) return { available: false, origin: null, path: null, unavailable: waiting.unavailable, reasons: waiting.reasons };
    const path = await mintSupervisorPortal(this.options.fetch ?? fetch, this.endpoint, valid);
    return { available: true, origin: this.endpoint.origin, path, unavailable: false, reasons: [] };
  }

  async returnTarget(): Promise<WorkbenchReturnTarget> {
    const boot = await this.bootstrap();
    if (!boot.connected || !boot.origin || !this.endpoint) {
      return {
        available: false,
        origin: null,
        path: null,
        unavailable: boot.unavailable,
        reasons: boot.reasons,
      };
    }
    return this.mintHandoff();
  }

  /**
   * Explicit, no-argument initialization for this confirmed Home.
   * Ordinary bootstrap/returnTarget still do not cold-start a workspace profile.
   */
  async initialize(): Promise<WorkbenchInitializeResult> {
    this.assertNotRestarting();
    const denied = this.deniedInitialize();
    if (denied) return denied;
    if (this.qualifiesForAutomaticDesktopLaunch()) return this.initializeThroughLaunch();
    const home = this.identity.home;
    if (!home) {
      return this.initializeFailure(this.identity.reasons.length ? this.identity.reasons : ["Host identity could not be confirmed."]);
    }
    const key = resolve(home);
    let pending = initializeInflight.get(key);
    if (!pending) {
      const started = this.runInitialize(home).finally(() => {
        if (initializeInflight.get(key) === started) initializeInflight.delete(key);
      });
      initializeInflight.set(key, started);
      pending = started;
    }
    const boot = await pending;
    if (!boot.connected) return this.initializeFailure(boot.reasons, boot.unavailable);
    // Share startup, never a single-use handoff token across browser requests.
    if (!this.endpoint) {
      const attached = await attachExistingSupervisor({ home, allowRealHome: this.options.allowRealHome === true, fetch: this.options.fetch, timeoutMs: this.options.supervisorTimeoutMs });
      if (!("endpoint" in attached)) return this.initializeFailure([ENTRY_UNAVAILABLE]);
      await this.remember(attached.endpoint);
    }
    const ready = await this.waitForManager();
    if (ready) return ready;
    return this.finishInitialize(this.currentManagerId());
  }

  private async waitForManager(
    api: StartupObservationReader = this.api!,
    endpoint: { serviceEpoch: string } | null = this.endpoint,
    watch?: StartupWatch,
  ): Promise<WorkbenchInitializeResult | null> {
    const deadline = Date.now() + (this.options.supervisorTimeoutMs ?? 240_000);
    let reasons = ["The manager did not become ready before the startup deadline."];
    let seen: import("../../../../src/shared/workbench-startup").WorkbenchStartupStatus | null = null;
    const read = <T>(load: (signal: AbortSignal) => Promise<T>): Promise<T> => observeStartupRead(load, deadline - Date.now());
    const fail = (
      next: string[],
      failure: WorkbenchStartupFailure | null,
      state: WorkbenchState | null,
      status: import("../../../../src/shared/workbench-startup").WorkbenchStartupStatus | null,
    ) => this.finishWait(watch, next, failure, publicLaunchEpoch(status?.serviceEpoch ?? state?.serviceEpoch ?? endpoint?.serviceEpoch), publicLaunchManagerId(status?.managerId ?? state?.managerId), status);
    while (Date.now() < deadline) {
      let state: WorkbenchState;
      try {
        state = await read((signal) => api.state(signal));
      } catch (error) {
        const reason = publicObservationReason(error);
        return fail([reason], null, null, seen);
      }
      if (state.reasons.length) reasons = [...state.reasons];
      const manager = state.spaces.find(space => space.id === state.managerId);
      if ((state.maintenance && [...state.jobs].reverse().find(job => job.kind === "plan.execute")?.status === "failed") || state.availability === "unavailable" || state.serviceEpoch !== endpoint?.serviceEpoch || manager?.status === "crashed") {
        const next = state.reasons.length ? reasons : ["The manager launch or its owning service is unavailable."];
        return fail(next, null, state, seen);
      }
      // An already-running manager is healthy on its own. Do not call startupStatus.
      if (state.role === "manager" && manager?.status === "running") {
        watch?.({ kind: "state", state });
        return null;
      }
      // A ready status was read after the previous state snapshot. This state
      // is the single confirmation of that transition, within the same deadline.
      if (seen?.phase === "ready") {
        return fail([STARTUP_READY_INCONSISTENT], null, state, seen);
      }
      let status: import("../../../../src/shared/workbench-startup").WorkbenchStartupStatus;
      try {
        status = await read((signal) => api.startupStatus(signal));
      } catch (error) {
        return fail([publicObservationReason(error)], null, state, null);
      }
      seen = status;
      if (status.serviceEpoch !== endpoint?.serviceEpoch) {
        return fail([STARTUP_EPOCH_MISMATCH], null, state, status);
      }
      if (status.phase === "failed") {
        return fail(startupFailureReasons(status), status.failure, state, status);
      }
      // The manager may have started between the two reads. Confirm against a
      // state captured after ready, rather than treating the older one as a fault.
      if (status.phase === "ready") continue;
      watch?.({ kind: "status", status });
      if (status.reasons.length) reasons = [...status.reasons];
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(250, remaining));
    }
    return fail(reasons, null, null, seen);
  }

  private finishWait(
    watch: StartupWatch | undefined,
    reasons: string[],
    failure: WorkbenchStartupFailure | null,
    serviceEpoch: string | null,
    managerId: string | null,
    status: import("../../../../src/shared/workbench-startup").WorkbenchStartupStatus | null,
  ): WorkbenchInitializeResult {
    watch?.({ kind: "terminal", failure, reasons: [...reasons], serviceEpoch, managerId, status });
    return this.initializeFailure(reasons);
  }

  async managerApi(): Promise<WorkbenchApi> {
    if (!this.shouldRegisterManager) {
      throw new Error("workbench/forbidden");
    }
    if (this.api && this.endpoint) {
      let matched = false;
      try {
        matched = await pingSupervisorState(this.endpoint, this.options.fetch, this.options.supervisorTimeoutMs);
      } catch (error) {
        throw new Error(publicObservationReason(error));
      }
      if (matched) return this.api;
      throw new Error(STARTUP_EPOCH_MISMATCH);
    }
    const home = this.identity.home;
    if (!home) throw new Error("workbench/unavailable");
    const pending = inflight.get(resolve(home));
    if (pending) {
      await pending;
      if (this.api) return this.api;
    }
    const attached = await attachExistingSupervisor({
      home,
      allowRealHome: this.options.allowRealHome === true,
      fetch: this.options.fetch,
      timeoutMs: this.options.supervisorTimeoutMs,
    });
    if ("endpoint" in attached) {
      await this.remember(attached.endpoint);
      return this.api!;
    }
    throw new Error("workbench/unavailable");
  }

  private async runInitialize(home: string): Promise<WorkbenchBootstrapResult> {
    const attached = await attachExistingSupervisor({
      home,
      allowRealHome: this.options.allowRealHome === true,
      fetch: this.options.fetch,
      timeoutMs: this.options.supervisorTimeoutMs,
    });
    if ("endpoint" in attached) {
      await this.remember(attached.endpoint);
      return { ok: true, connected: true, unavailable: false, origin: attached.endpoint.origin, reasons: [] };
    }
    if ("blocked" in attached || "stale" in attached) {
      return this.initializeFailure(attached.reasons);
    }
    // The supervisor owns manager allocation under its existing control protocol.
    // Do not leave a manager record behind when runtime/payload preflight fails.
    const denied = this.deniedInitialize();
    if (denied) return denied;
    return this.connectSupervisor(true, attached);
  }

  private deniedInitialize(): WorkbenchInitializeResult | null {
    if (this.identity.recoveryRequired) {
      return {
        ok: false,
        connected: false,
        unavailable: true,
        origin: null,
        path: null,
        managerId: this.currentManagerId(),
        reasons: this.identity.reasons.length ? this.identity.reasons : [IDENTITY_DAMAGED],
      };
    }
    if (!this.identity.confirmed || !this.identity.home || !this.identity.profileId) {
      return this.initializeFailure(
        this.identity.reasons.length ? this.identity.reasons : ["Host identity could not be confirmed."],
      );
    }
    if (this.identity.role === "uninitialized") {
      return this.initializeFailure(["The current DSH profile is no longer available. Restart DSH before initializing Spaces."]);
    }
    const argv = this.options.argv ?? process.argv;
    const runtime = typeof argv[1] === "string" ? bindDshCli(argv[1]) : null;
    if (!runtime) {
      return this.initializeFailure(["The bound DSH CLI could not be validated from the current process."]);
    }
    if (!isCompatibleDshCliVersion(runtime.version)) {
      return this.initializeFailure(["The bound DSH CLI is not an exact installed version. Spaces was not initialized."]);
    }
    return null;
  }

  private async finishInitialize(managerId: string | null): Promise<WorkbenchInitializeResult> {
    const target = await this.mintHandoff();
    return {
      ok: target.available,
      connected: Boolean(this.endpoint),
      unavailable: false,
      origin: target.origin,
      path: target.path,
      managerId,
      reasons: target.available ? [] : target.reasons.length ? target.reasons : [HANDOFF_FAILED],
    };
  }

  private async mintHandoff(): Promise<WorkbenchReturnTarget> {
    if (!this.endpoint) {
      return {
        available: false,
        origin: null,
        path: null,
        unavailable: false,
        reasons: [ENTRY_UNAVAILABLE],
      };
    }
    try {
      const path = await mintSupervisorHandoff(this.options.fetch ?? fetch, this.endpoint);
      return {
        available: true,
        origin: this.endpoint.origin,
        path,
        unavailable: false,
        reasons: [],
      };
    } catch {
      return {
        available: false,
        origin: this.endpoint.origin,
        path: null,
        unavailable: false,
        reasons: [HANDOFF_FAILED],
      };
    }
  }

  private currentManagerId(): string | null {
    return this.identity.managerId;
  }

  private initializeFailure(reasons: string[], unavailable = false): WorkbenchInitializeResult {
    return {
      ok: false,
      connected: false,
      unavailable,
      origin: null,
      path: null,
      managerId: this.currentManagerId(),
      reasons,
    };
  }

  private async connectSupervisor(allowColdStart: boolean, priorDiscovery?: SupervisorAttachResult, record?: DesktopLaunchRecord, startDesktopSpaces = false): Promise<WorkbenchBootstrapResult> {
    const home = this.identity.home;
    if (!home) {
      return {
        ok: false,
        connected: false,
        unavailable: false,
        origin: null,
        reasons: ["Host identity could not be confirmed."],
      };
    }
    const attached = priorDiscovery ?? await this.discoverForLaunch(record);
    if ("endpoint" in attached) {
      await this.remember(attached.endpoint, record);
      return {
        ok: true,
        connected: true,
        unavailable: false,
        origin: attached.endpoint.origin,
        reasons: [],
      };
    }
    if ("blocked" in attached || "stale" in attached) {
      return {
        ok: false,
        connected: false,
        unavailable: this.identity.recoveryRequired,
        origin: null,
        reasons: attached.reasons,
      };
    }
    const run = this.options.bootstrap ?? bootstrapSupervisor;
    const result = await run({
      home,
      argv: this.options.argv,
      env: this.options.env,
      execPath: this.options.execPath,
      payloadRoot: this.options.payloadRoot ?? defaultPayloadRoot(),
      toolsRoot: this.options.toolsRoot ?? defaultToolsRoot(home),
      snapshotRoot: this.snapshotRoot,
      allowRealHome: this.options.allowRealHome === true,
      allowColdStart,
      startDesktopSpaces,
      exitWithHost:
        this.identity.confirmed &&
        !this.identity.recoveryRequired &&
        this.identity.profileId === "desktop" &&
        this.identity.role === "workspace",
      priorDiscovery: attached,
      timeoutMs: this.options.supervisorTimeoutMs,
      fetch: this.options.fetch,
      progress: record ? (stage) => {
        updateLaunch(record, (row) => {
          if (row.phase === "failed" || row.phase === "stopped" || row.phase === "ready" || row.phase === "connecting" || row.phase === "starting") return;
          row.phase = stage === "prepare" ? "preparing" : "launching";
        });
      } : undefined,
    });
    if (!result.connected) {
      return {
        ok: false,
        connected: false,
        unavailable: this.identity.recoveryRequired,
        origin: null,
        reasons: result.reasons,
      };
    }
    await this.remember(result.endpoint, record);

    return {
      ok: true,
      connected: true,
      unavailable: false,
      origin: result.origin,
      reasons: [],
    };
  }

  private async supervisorReplaced(previousEpoch: string | null): Promise<void> {
    this.connectionGeneration++;
    this.endpoint = null;
    this.api = null;
    this.attachedEpoch = null;
    this.acceptingListeners = false;
    this.pendingEndpoint = null;
    this.deliveredTo = new WeakSet();
    this.attachmentFlight = null;
    this.attachmentFlightEpoch = null;
    for (const listener of this.stoppedListeners) await listener(previousEpoch);
  }

  private async remember(endpoint: SupervisorEndpoint, record?: DesktopLaunchRecord): Promise<void> {
    if (this.attachedEpoch !== null && this.attachedEpoch !== endpoint.serviceEpoch) await this.supervisorReplaced(this.attachedEpoch);
    const generation = this.connectionGeneration;
    const api = (this.options.connect ?? createWorkbenchHttpClient)({
      endpoint,
      fetch: this.options.fetch,
    });
    // Manager hosts have no attachment listeners and must not wait on their own
    // startup. A Desktop launch always waits, then registers main once.
    if (record || this.attachedListeners.size) {
      if (this.attachmentFlight && this.attachmentFlightEpoch === endpoint.serviceEpoch) await this.attachmentFlight;
      else if (!(this.attachedEpoch === endpoint.serviceEpoch && this.acceptingListeners)) {
        this.attachmentFlightEpoch = endpoint.serviceEpoch;
        const work = this.attachReady(endpoint, api, generation, record);
        this.attachmentFlight = work;
        try { await work; }
        finally { if (this.attachmentFlight === work) this.attachmentFlight = null; }
      }
    }
    if (generation !== this.connectionGeneration) throw new Error("The connection belongs to the service being manually restarted.");
    if (!this.endpoint) {
      this.endpoint = endpoint;
      this.api = api;
    }
    if (record) this.markReady(record, endpoint);
  }

  previewServiceRestart() { this.assertNotRestarting(); return this.restartOperation().preview(); }

  previewServiceStop() { this.assertNotRestarting(); return this.restartOperation().preview(true); }

  async stopService(confirmationId: string): Promise<WorkbenchBootstrapResult> {
    this.assertNotRestarting();
    const operation = this.restartOperation();
    this.restarting = true;
    try {
      const previousEpoch = this.endpoint?.serviceEpoch ?? null;
      const result = await operation.execute(confirmationId, true);
      const record = readLaunch(this.launchHomeKey());
      if (record) updateLaunch(record, (row) => { row.phase = "stopped"; });
      await this.supervisorReplaced(previousEpoch);
      return result;
    } finally { this.restarting = false; }
  }

  async restartService(confirmationId: string): Promise<WorkbenchBootstrapResult> {
    this.assertNotRestarting();
    const operation = this.restartOperation();
    this.restarting = true;
    try { return await operation.execute(confirmationId); }
    finally { this.restarting = false; }
  }

  private assertNotRestarting(): void {
    if (this.restarting) throw new Error("A manual service restart is in progress.");
  }

  private restartOperation(): DesktopServiceRestart {
    const assertDesktop = () => {
      const identity = this.identity;
      if (!identity.confirmed || identity.recoveryRequired || identity.profileId !== "desktop" || identity.role !== "workspace" || !identity.home) {
        throw new Error("Only the confirmed Desktop host can manually restart the Spaces service.");
      }
      if (launchIsBusy(canonicalHome(identity.home, { allowRealHome: this.options.allowRealHome === true })) || inflight.has(resolve(identity.home)) || initializeInflight.has(resolve(identity.home))) throw new Error("The current launch has not finished.");
      const denied = this.deniedInitialize();
      if (denied) throw new Error(denied.reasons.join("\n"));
    };
    assertDesktop();
    return this.serviceRestart ??= new DesktopServiceRestart({
      home: this.identity.home!, allowRealHome: this.options.allowRealHome === true,
      assertDesktop, connect: this.options.connect, fetch: this.options.fetch, timeoutMs: this.options.supervisorTimeoutMs,
      launch: async (previousEpoch, missing) => {
        await this.supervisorReplaced(previousEpoch);
        const record = replaceLaunch(this.launchHomeKey());
        const result = await this.runLaunch(record, missing);
        if (result.connected && (this.endpoint as SupervisorEndpoint | null)?.serviceEpoch === previousEpoch) throw new Error("The previous service is still active.");
        return result;
      },
    });
  }

  async beginDesktopLaunch(): Promise<DesktopLaunchState> {
    this.assertNotRestarting();
    const denied = this.desktopIdentityRejection();
    if (denied) throw new Error(denied);
    const { record, created } = joinLaunch(this.launchHomeKey());
    if (created) void this.runLaunch(record, undefined, true).catch(() => undefined);
    return snapshotLaunch(record);
  }

  async desktopLaunchState(): Promise<DesktopLaunchState> {
    const denied = this.desktopIdentityRejection();
    if (denied) throw new Error(denied);
    return snapshotLaunch(readLaunch(this.launchHomeKey()));
  }

  private desktopIdentityRejection(): string | null {
    const identity = this.identity;
    if (!identity.confirmed || identity.recoveryRequired || identity.profileId !== "desktop" || identity.role !== "workspace" || !identity.home) {
      return "Only the confirmed Desktop host can launch the Spaces service.";
    }
    const denied = this.deniedInitialize();
    return denied ? denied.reasons.join("\n") : null;
  }

  private launchHomeKey(): string {
    const home = this.identity.home;
    if (!home) throw new Error("Only the confirmed Desktop host can launch the Spaces service.");
    return canonicalHome(home, { allowRealHome: this.options.allowRealHome === true });
  }

  private async initializeThroughLaunch(): Promise<WorkbenchInitializeResult> {
    const snapshot = await this.beginDesktopLaunch();
    const homeKey = this.launchHomeKey();
    const joined = readLaunch(homeKey);
    if (joined?.operationId === snapshot.operationId) await joined.done;
    const current = readLaunch(homeKey);
    if (!current || current.operationId !== snapshot.operationId || current.phase !== "ready") {
      const reasons = current?.operationId === snapshot.operationId && current.reasons.length
        ? [...current.reasons]
        : ["The Desktop launch is not ready."];
      return this.initializeFailure(reasons);
    }
    if (!this.endpoint) {
      try {
        const attached = await attachExistingSupervisor({
          home: this.identity.home!,
          allowRealHome: this.options.allowRealHome === true,
          fetch: this.options.fetch,
          timeoutMs: this.options.supervisorTimeoutMs,
        });
        if (!("endpoint" in attached)) return this.initializeFailure([ENTRY_UNAVAILABLE]);
        await this.remember(attached.endpoint);
      } catch (error) {
        return this.initializeFailure([publicReason(error)]);
      }
    }
    if (!this.endpoint) return this.initializeFailure([ENTRY_UNAVAILABLE]);
    return this.finishInitialize(current.managerId ?? this.currentManagerId());
  }

  private async runLaunch(record: DesktopLaunchRecord, priorDiscovery?: SupervisorAttachResult, startDesktopSpaces = false): Promise<WorkbenchBootstrapResult> {
    try {
      const result = await this.connectSupervisor(true, priorDiscovery, record, startDesktopSpaces);
      if (!result.connected) this.failRecord(record, result.reasons);
      return result;
    } catch (error) {
      this.failRecord(record, error);
      throw error;
    } finally {
      record.settle();
    }
  }

  private async discoverForLaunch(record?: DesktopLaunchRecord): Promise<SupervisorAttachResult> {
    const home = this.identity.home;
    if (!home) return { blocked: true, reasons: ["Host identity could not be confirmed."] };
    if (record) {
      updateLaunch(record, (row) => {
        if (row.phase === "failed" || row.phase === "stopped" || row.phase === "ready" || row.phase === "connecting" || row.phase === "starting") return;
        row.phase = "discovering";
      });
    }
    return attachExistingSupervisor({
      home,
      allowRealHome: this.options.allowRealHome === true,
      fetch: this.options.fetch,
      timeoutMs: this.options.supervisorTimeoutMs,
    });
  }

  private async attachReady(endpoint: SupervisorEndpoint, api: WorkbenchApi, generation: number, record?: DesktopLaunchRecord): Promise<void> {
    if (record) {
      updateLaunch(record, (row) => {
        if (row.phase === "failed" || row.phase === "stopped" || row.phase === "ready") return;
        row.phase = "starting";
      });
    }
    const waiting = await this.waitForManager(api, endpoint, (event) => this.observeLaunch(record, event));
    if (generation !== this.connectionGeneration) throw new Error("The connection belongs to the service being manually restarted.");
    if (waiting) throw new Error(waiting.reasons.join("\n") || "The manager did not become ready.");
    if (record) {
      updateLaunch(record, (row) => {
        if (row.phase === "failed" || row.phase === "stopped" || row.phase === "ready") return;
        row.phase = "connecting";
      });
    }
    this.attachedEpoch = endpoint.serviceEpoch;
    this.pendingEndpoint = endpoint;
    this.acceptingListeners = true;
    try {
      while (generation === this.connectionGeneration) {
        const pending = [...this.attachedListeners].filter((listener) => !this.deliveredTo.has(listener));
        if (pending.length) {
          for (const listener of pending) {
            if (generation !== this.connectionGeneration) break;
            await this.callListenerOnce(listener, endpoint);
          }
          continue;
        }
        if (this.attachmentBusy === 0) break;
        await new Promise<void>((resolve) => { this.attachmentIdle = resolve; });
      }
      if (generation !== this.connectionGeneration) throw new Error("The connection belongs to the service being manually restarted.");
      if (!this.endpoint) {
        this.endpoint = endpoint;
        this.api = api;
      }
      this.pendingEndpoint = null;
    } catch (error) {
      if (generation !== this.connectionGeneration) throw error;
      this.acceptingListeners = false;
      this.pendingEndpoint = null;
      if (record) this.failRecord(record, error);
      throw error;
    }
  }

  private async callListenerOnce(listener: (endpoint: SupervisorEndpoint) => Promise<void>, endpoint: SupervisorEndpoint): Promise<void> {
    if (this.deliveredTo.has(listener)) return;
    this.deliveredTo.add(listener);
    this.attachmentBusy++;
    try { await listener(endpoint); }
    finally {
      this.attachmentBusy--;
      if (this.attachmentBusy === 0 && this.attachmentIdle) {
        const done = this.attachmentIdle;
        this.attachmentIdle = undefined;
        done();
      }
    }
  }

  private retiredByCurrentLaunch(): boolean {
    const home = this.identity.home;
    if (!home || !this.endpoint) return false;
    let record: DesktopLaunchRecord | undefined;
    try { record = readLaunch(canonicalHome(home, { allowRealHome: this.options.allowRealHome === true })); }
    catch { return false; }
    return record?.phase === "ready" && !!record.serviceEpoch && record.serviceEpoch !== this.endpoint.serviceEpoch;
  }

  private failLateAttachment(error: unknown, generation: number): void {
    if (generation !== this.connectionGeneration) return;
    this.acceptingListeners = false;
    const home = this.identity.home;
    if (!home) return;
    let record: DesktopLaunchRecord | undefined;
    try { record = readLaunch(canonicalHome(home, { allowRealHome: this.options.allowRealHome === true })); }
    catch { return; }
    if (!record || (record.phase !== "ready" && record.phase !== "connecting")) return;
    this.failRecord(record, error);
  }

  private markReady(record: DesktopLaunchRecord, endpoint: SupervisorEndpoint): void {
    updateLaunch(record, (row) => {
      if (row.phase === "failed" || row.phase === "stopped") return;
      row.phase = "ready";
      const epoch = publicLaunchEpoch(endpoint.serviceEpoch);
      if (epoch) row.serviceEpoch = epoch;
      if (!row.managerId) {
        const managerId = publicLaunchManagerId(this.identity.managerId);
        if (managerId) row.managerId = managerId;
      }
      row.reasons = [];
      row.failure = null;
    });
  }

  private observeLaunch(record: DesktopLaunchRecord | undefined, event: StartupWatchEvent): void {
    if (!record) return;
    if (event.kind === "terminal") {
      updateLaunch(record, (row) => {
        if (row.phase === "failed" || row.phase === "stopped") return;
        row.phase = "failed";
        if (event.serviceEpoch) row.serviceEpoch = event.serviceEpoch;
        if (event.managerId) row.managerId = event.managerId;
        row.reasons = launchReasons(event.reasons);
        row.failure = event.failure ? copyFailure(cleanLaunchFailure(event.failure)) : null;
      });
      return;
    }
    updateLaunch(record, (row) => {
      if (row.phase === "failed" || row.phase === "stopped" || row.phase === "ready") return;
      if (event.kind === "state") {
        const epoch = publicLaunchEpoch(event.state.serviceEpoch);
        const managerId = publicLaunchManagerId(event.state.managerId);
        if (epoch) row.serviceEpoch = epoch;
        if (managerId) row.managerId = managerId;
        return;
      }
      if (row.phase === "connecting") return;
      if (event.status.phase === "preparing" || event.status.phase === "starting") row.phase = event.status.phase;
      const epoch = publicLaunchEpoch(event.status.serviceEpoch);
      const managerId = publicLaunchManagerId(event.status.managerId);
      if (epoch) row.serviceEpoch = epoch;
      if (managerId) row.managerId = managerId;
      if (event.status.reasons.length) row.reasons = launchReasons(event.status.reasons);
    });
  }

  private failRecord(record: DesktopLaunchRecord, source: unknown, failure: WorkbenchStartupFailure | null = null): void {
    updateLaunch(record, (row) => {
      if (row.phase === "failed" || row.phase === "stopped") return;
      row.phase = "failed";
      row.reasons = launchReasons(source);
      row.failure = failure ? copyFailure(cleanLaunchFailure(failure)) : null;
    });
  }
}

function publicLaunchEpoch(id: string | null | undefined): string | null {
  return typeof id === "string" && /^[a-f0-9]{64}$/.test(id) ? id : null;
}

function publicLaunchManagerId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id === "web" || /^[a-z0-9][a-z0-9-]{0,38}$/.test(id)) return id;
  return null;
}

function cleanLaunchFailure(failure: WorkbenchStartupFailure): WorkbenchStartupFailure {
  const stage = publicReason(failure.stage).slice(0, 64);
  const primaryReason = publicReason(failure.primaryReason);
  const cleanupReason = failure.cleanupReason ? publicReason(failure.cleanupReason) : undefined;
  return {
    stage,
    primaryReason,
    ...(cleanupReason ? { cleanupReason } : {}),
    instanceRetained: failure.instanceRetained === true,
  };
}

function launchReasons(source: unknown): string[] {
  const values = Array.isArray(source) ? source : [source];
  const reasons: string[] = [];
  for (const value of values) {
    const reason = publicReason(value);
    if (!reason || reasons.includes(reason)) continue;
    reasons.push(reason);
  }
  return reasons.slice(0, 32);
}

export function runtimeFromContext(ctx: Context, config: { snapshotRoot?: string } = {}): WorkbenchHostRuntime {
  return new WorkbenchHostRuntime({
    home: process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
    allowRealHome: true,
    argv: process.argv,
    env: process.env,
    execPath: process.execPath,
    baseUrl: typeof ctx.baseUrl === "string" ? ctx.baseUrl : undefined,
    snapshotRoot: config.snapshotRoot,
  });
}
