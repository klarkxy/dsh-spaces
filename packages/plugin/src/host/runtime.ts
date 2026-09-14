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
import { createWorkbenchHttpClient, mintSupervisorHandoff, type WorkbenchHttpClientOptions } from "./workbench-http";
import { attachExistingSupervisor, pingSupervisorState } from "./supervisor-attach";
import {
  bootstrapSupervisor,
  defaultPayloadRoot,
  defaultToolsRoot,
  type SupervisorBootstrapOptions,
  type SupervisorEndpoint,
} from "./supervisor-bootstrap";

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
      recoveryRequired: this.identity.recoveryRequired,
    };
  }

  guideRole(): WorkbenchGuideRole {
    return {
      role: this.identity.role,
      profileId: this.identity.profileId,
      managerId: this.identity.managerId,
      recoveryRequired: this.identity.recoveryRequired,
      reasons: [...this.identity.reasons],
    };
  }

  async bootstrap(): Promise<WorkbenchBootstrapResult> {
    if (this.identity.recoveryRequired) {
      return {
        ok: false,
        connected: false,
        recoveryRequired: true,
        origin: null,
        reasons: this.identity.reasons.length
          ? this.identity.reasons
          : ["Workbench identity is damaged. Recovery is required."],
      };
    }
    const home = this.identity.home;
    if (!home) {
      return {
        ok: false,
        connected: false,
        recoveryRequired: false,
        origin: null,
        reasons: this.identity.reasons.length ? this.identity.reasons : ["Host identity could not be confirmed."],
      };
    }
    if (this.endpoint && this.api && (await pingSupervisorState(this.endpoint, this.options.fetch))) {
      return {
        ok: true,
        connected: true,
        recoveryRequired: false,
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

  async returnTarget(): Promise<WorkbenchReturnTarget> {
    const boot = await this.bootstrap();
    if (!boot.connected || !boot.origin || !this.endpoint) {
      return {
        available: false,
        origin: null,
        path: null,
        recoveryRequired: boot.recoveryRequired,
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
    if (!boot.connected) return this.initializeFailure(boot.reasons, boot.recoveryRequired);
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
    let reasons = ["The manager is still starting. Retry initialization to reconnect."];
    while (Date.now() < deadline) {
      try {
        const state = await this.api!.state();
        if (state.role === "manager" && !state.recoveryRequired &&
            state.spaces.some(space => space.id === state.managerId && space.status === "running")) return null;
        if (state.reasons.length) reasons = state.reasons;
      } catch {
        reasons = [ENTRY_UNAVAILABLE];
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
    const boot = await this.bootstrap();
    if (!boot.ok || !this.api) {
      throw new Error("workbench/unavailable");
    }
    return this.api;
  }

  private async runInitialize(home: string): Promise<WorkbenchBootstrapResult> {
    const attached = await attachExistingSupervisor({
      home,
      allowRealHome: this.options.allowRealHome === true,
      fetch: this.options.fetch,
    });
    if ("endpoint" in attached) {
      this.remember(attached.endpoint);
      return { ok: true, connected: true, recoveryRequired: false, origin: attached.endpoint.origin, reasons: [] };
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
        recoveryRequired: true,
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
    if (!runtime || !isCompatibleDshCliVersion(runtime.version)) {
      return this.initializeFailure(["The bound DSH CLI is not a supported version. Spaces was not initialized."]);
    }
    return null;
  }

  private async finishInitialize(managerId: string | null): Promise<WorkbenchInitializeResult> {
    const target = await this.mintHandoff();
    return {
      ok: target.available,
      connected: Boolean(this.endpoint),
      recoveryRequired: false,
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
        recoveryRequired: false,
        reasons: [ENTRY_UNAVAILABLE],
      };
    }
    try {
      const path = await mintSupervisorHandoff(this.options.fetch ?? fetch, this.endpoint);
      return {
        available: true,
        origin: this.endpoint.origin,
        path,
        recoveryRequired: false,
        reasons: [],
      };
    } catch {
      return {
        available: false,
        origin: this.endpoint.origin,
        path: null,
        recoveryRequired: false,
        reasons: [HANDOFF_FAILED],
      };
    }
  }

  private currentManagerId(): string | null {
    return this.identity.managerId;
  }

  private initializeFailure(reasons: string[], recoveryRequired = false): WorkbenchInitializeResult {
    return {
      ok: false,
      connected: false,
      recoveryRequired,
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
        recoveryRequired: false,
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
        recoveryRequired: false,
        origin: attached.endpoint.origin,
        reasons: [],
      };
    }
    if ("blocked" in attached) {
      return {
        ok: false,
        connected: false,
        recoveryRequired: this.identity.recoveryRequired,
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
        recoveryRequired: this.identity.recoveryRequired,
        origin: null,
        reasons: result.reasons,
      };
    }
    this.remember(result.endpoint);
    return {
      ok: true,
      connected: true,
      recoveryRequired: false,
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
