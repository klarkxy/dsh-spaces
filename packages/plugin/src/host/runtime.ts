import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { WorkbenchApi } from "../../../../src/shared/workbench";
import type {
  WorkbenchBootstrapResult,
  WorkbenchGuideRole,
  WorkbenchHostHint,
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
  readonly identity: HostIdentity;
  readonly snapshotRoot?: string;
  private endpoint: SupervisorEndpoint | null = null;
  private api: WorkbenchApi | null = null;
  private readonly options: WorkbenchHostRuntimeOptions;

  constructor(options: WorkbenchHostRuntimeOptions = {}) {
    this.options = options;
    this.identity = resolveHostIdentity(options);
    this.snapshotRoot = typeof options.snapshotRoot === "string" ? options.snapshotRoot : undefined;
  }

  get shouldRegisterManager(): boolean {
    return this.identity.role === "manager" && !this.identity.recoveryRequired && this.identity.confirmed;
  }

  get canColdStart(): boolean {
    if (this.identity.recoveryRequired || !this.identity.confirmed) return false;
    return this.identity.role === "manager" || this.identity.role === "uninitialized";
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
    const pending = this.connectSupervisor().finally(() => {
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
    try {
      const path = await mintSupervisorHandoff(this.options.fetch ?? fetch, this.endpoint);
      return {
        available: true,
        origin: boot.origin,
        path,
        recoveryRequired: false,
        reasons: [],
      };
    } catch {
      return {
        available: false,
        origin: boot.origin,
        path: null,
        recoveryRequired: false,
        reasons: ["The workbench entry handoff could not be minted."],
      };
    }
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

  private async connectSupervisor(): Promise<WorkbenchBootstrapResult> {
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
      allowColdStart: this.canColdStart,
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
