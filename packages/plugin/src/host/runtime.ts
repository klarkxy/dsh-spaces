import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import { HomeController } from "../../../../src/adapters/node/home-controller";
import { bindDshCli, isCompatibleDshCliVersion } from "../../../../src/adapters/node/spaces-control";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import type {
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchHostHint,
  WorkbenchInitializeResult,
  WorkbenchReturnTarget,
} from "../types";
import { resolveHostIdentity, type HostIdentity, type HostIdentityInput } from "./identity";
import { createWorkbenchHttpClient, mintSupervisorHandoff, mintSupervisorPortal, type WorkbenchHttpClientOptions } from "./workbench-http";
import { attachExistingSupervisor, pingSupervisorState } from "./supervisor-attach";
import {
  bootstrapSupervisor,
  defaultPayloadRoot,
  defaultToolsRoot,
  type SupervisorBootstrapOptions,
  type SupervisorEndpoint,
} from "./supervisor-bootstrap";

import { parseSpaceHostAudience, type SpaceHostAudience } from "../../../../src/shared/space-host";

const inflight = new Map<string, Promise<WorkbenchBootstrapResult>>();
const initializeInflight = new Map<string, Promise<WorkbenchBootstrapResult>>();

const IDENTITY_DAMAGED = "Manager identity is damaged or ambiguous and cannot be guessed.";
const HOME_UNAVAILABLE = "The DSH home could not be opened safely.";
const MANAGER_LOCKED = "Another workbench operation is already running.";
const HANDOFF_FAILED = "The workbench entry handoff could not be minted.";
const ENTRY_UNAVAILABLE = "The workbench entry is not available yet.";

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
  private readonly options: WorkbenchHostRuntimeOptions;

  constructor(options: WorkbenchHostRuntimeOptions = {}) {
    this.options = options;
    this.snapshotRoot = typeof options.snapshotRoot === "string" ? options.snapshotRoot : undefined;
  }

  get identity(): HostIdentity {
    return resolveHostIdentity(this.options);
  }

  get shouldRegisterManager(): boolean {
    return this.identity.role === "manager" && !this.identity.recoveryRequired && this.identity.confirmed;
  }

  get canColdStart(): boolean {
    if (this.identity.recoveryRequired || !this.identity.confirmed) return false;
    return this.identity.role === "manager";
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

  async bootstrap(): Promise<WorkbenchBootstrapResult> {
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
    if (this.endpoint && this.api && (await pingSupervisorState(this.endpoint, this.options.fetch))) {
      return {
        ok: true,
        connected: true,
        unavailable: false,
        origin: this.endpoint.origin,
        reasons: [],
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
    const denied = this.deniedInitialize();
    if (denied) return denied;
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
      const attached = await attachExistingSupervisor({ home, allowRealHome: this.options.allowRealHome === true, fetch: this.options.fetch });
      if (!("endpoint" in attached)) return this.initializeFailure([ENTRY_UNAVAILABLE]);
      this.remember(attached.endpoint);
    }
    const ready = await this.waitForManager();
    if (ready) return ready;
    return this.finishInitialize(this.currentManagerId());
  }

  private async waitForManager(): Promise<WorkbenchInitializeResult | null> {
    const deadline = Date.now() + (this.options.supervisorTimeoutMs ?? 240_000);
    let reasons = ["The manager did not become ready before the startup deadline."];
    while (Date.now() < deadline) {
      try {
        const state = await this.api!.state();
        if (state.reasons.length) reasons = state.reasons;
        const manager = state.spaces.find(space => space.id === state.managerId);
        if (state.availability === "unavailable" || state.serviceEpoch !== this.endpoint?.serviceEpoch || manager?.status === "crashed") {
          return this.initializeFailure(state.reasons.length ? reasons : ["The manager launch or its owning service is unavailable."]);
        }
        if (state.role === "manager" && manager?.status === "running") return null;
      } catch {
        return this.initializeFailure([ENTRY_UNAVAILABLE]);
      }
      await delay(250);
    }
    return this.initializeFailure(reasons);
  }

  async managerApi(): Promise<WorkbenchApi> {
    if (!this.shouldRegisterManager) {
      throw new Error("workbench/forbidden");
    }
    if (this.api && this.endpoint && (await pingSupervisorState(this.endpoint, this.options.fetch))) {
      return this.api;
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
    });
    if ("endpoint" in attached) {
      this.remember(attached.endpoint);
      return this.api!;
    }
    throw new Error("workbench/unavailable");
  }

  private async runInitialize(home: string): Promise<WorkbenchBootstrapResult> {
    const attached = await attachExistingSupervisor({
      home,
      allowRealHome: this.options.allowRealHome === true,
      fetch: this.options.fetch,
    });
    if ("endpoint" in attached) {
      this.remember(attached.endpoint);
      return { ok: true, connected: true, unavailable: false, origin: attached.endpoint.origin, reasons: [] };
    }
    if ("blocked" in attached) {
      return this.initializeFailure(attached.reasons);
    }

    try {
      const controller = new HomeController(home, { allowRealHome: this.options.allowRealHome === true });
      if (controller.inspect().held) return this.initializeFailure([MANAGER_LOCKED]);
    } catch {
      return this.initializeFailure([HOME_UNAVAILABLE], true);
    }
    // The supervisor owns manager allocation under its existing control protocol.
    // Do not leave a manager record behind when runtime/payload preflight fails.
    const denied = this.deniedInitialize();
    if (denied) return denied;
    return this.connectSupervisor(true);
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

  private async connectSupervisor(allowColdStart: boolean): Promise<WorkbenchBootstrapResult> {
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
    const attached = await attachExistingSupervisor({
      home,
      allowRealHome: this.options.allowRealHome === true,
      fetch: this.options.fetch,
    });
    if ("endpoint" in attached) {
      this.remember(attached.endpoint);
      return {
        ok: true,
        connected: true,
        unavailable: false,
        origin: attached.endpoint.origin,
        reasons: [],
      };
    }
    if ("blocked" in attached) {
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
      timeoutMs: this.options.supervisorTimeoutMs,
      fetch: this.options.fetch,
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
    this.remember(result.endpoint);
    return {
      ok: true,
      connected: true,
      unavailable: false,
      origin: result.origin,
      reasons: [],
    };
  }

  private remember(endpoint: SupervisorEndpoint): void {
    this.endpoint = endpoint;
    this.api = (this.options.connect ?? createWorkbenchHttpClient)({
      endpoint,
      fetch: this.options.fetch,
    });
  }
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
