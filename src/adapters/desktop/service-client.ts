import {
  attachExistingSupervisor,
} from "../../../packages/plugin/src/host/supervisor-attach";
import {
  bootstrapSupervisor,
  readLastSupervisorDiagnostics,
  type SupervisorBootstrapOptions,
  type SupervisorBootstrapResult,
} from "../../../packages/plugin/src/host/supervisor-bootstrap";
import { parseLoopbackOrigin, parseSupervisorHandoffPath } from "../../../packages/plugin/src/host/loopback";
import type { SupervisorEndpoint } from "../../../packages/plugin/src/host/supervisor-endpoint";
import {
  createWorkbenchHttpClient,
  mintSupervisorHandoff,
  type WorkbenchHttpFetch,
} from "../../../packages/plugin/src/host/workbench-http";
import type { WorkbenchApi } from "../../shared/workbench";
import type { DesktopServicePublicStatus } from "../../shared/desktop-shell";

const ATTACH_FAILED = "The supervisor endpoint could not be attached.";
const START_FAILED = "The supervisor process could not be started.";
const ENTRY_UNAVAILABLE = "The workbench entry is not available yet.";
const HANDOFF_FAILED = "The workbench entry handoff could not be minted.";
const CLIENT_UNAVAILABLE = "The workbench client is not connected.";
const MISSING_RUNTIME_PATHS = "The Node executable or DSH CLI path was not provided.";
const CLIENT_REQUIRES_HOME = "Desktop service client requires a home and a controlled payload root.";
const CONNECTION_FAILED = "The supervisor connection failed.";
const MAX_REASONS = 32;
const MAX_REASON_CHARS = 500;

export type DesktopServiceStatus = DesktopServicePublicStatus;

export interface DesktopServicePublicState {
  status: DesktopServiceStatus;
  reasons: string[];
}

export interface DesktopServiceStartRequest {
  nodeExe: string;
  cliBin: string;
}

/** Endpoint extras the protocol helpers may add; this client does not reinterpret them. */
export type DesktopSupervisorEndpoint = SupervisorEndpoint & {
  protocol?: number | string;
  serviceEpoch?: string;
  homeId?: string;
};

export type DesktopAttachResult =
  | { endpoint: DesktopSupervisorEndpoint }
  | { missing: true }
  | { blocked: true; reasons: string[] }
  | { stale: true; reasons: string[] };

export type DesktopAttachFn = (options: {
  home: string;
  allowRealHome: boolean;
  fetch?: WorkbenchHttpFetch;
}) => Promise<DesktopAttachResult>;

export type DesktopBootstrapFn = (options: SupervisorBootstrapOptions) => Promise<SupervisorBootstrapResult>;

export type DesktopHandoffFn = (
  doFetch: WorkbenchHttpFetch,
  endpoint: SupervisorEndpoint,
) => Promise<string>;

export interface DesktopServiceClientOptions {
  home: string;
  payloadRoot: string;
  toolsRoot?: string;
  snapshotRoot?: string;
  allowRealHome?: boolean;
  fetch?: WorkbenchHttpFetch;
  attach?: DesktopAttachFn;
  bootstrap?: DesktopBootstrapFn;
  handoff?: DesktopHandoffFn;
}

export class DesktopServiceClientError extends Error {
  readonly name = "DesktopServiceClientError";
}

/**
 * Node-only connector to the unique Supervisor. It does not own Home locks,
 * spawn policy, or product services. dispose() drops local references only.
 */
export class DesktopServiceClient {
  private readonly home: string;
  private readonly payloadRoot: string;
  private readonly toolsRoot?: string;
  private readonly snapshotRoot?: string;
  private readonly allowRealHome: boolean;
  private readonly fetch?: WorkbenchHttpFetch;
  private readonly attachFn: DesktopAttachFn;
  private readonly bootstrapFn: DesktopBootstrapFn;
  private readonly handoffFn: DesktopHandoffFn;

  private generation = 0;
  private disposed = false;
  private status: DesktopServiceStatus = "idle";
  private reasons: string[] = [];
  private inflight: Promise<DesktopServicePublicState> | null = null;
  private allowBootstrap = false;
  private startArgs: DesktopServiceStartRequest | null = null;
  private endpoint: DesktopSupervisorEndpoint | null = null;
  private api: WorkbenchApi | null = null;

  constructor(options: DesktopServiceClientOptions) {
    if (!nonEmpty(options.home) || !nonEmpty(options.payloadRoot)) {
      throw new DesktopServiceClientError(CLIENT_REQUIRES_HOME);
    }
    this.home = options.home;
    this.payloadRoot = options.payloadRoot;
    this.toolsRoot = options.toolsRoot;
    this.snapshotRoot = options.snapshotRoot;
    this.allowRealHome = options.allowRealHome === true;
    this.fetch = options.fetch;
    this.attachFn = options.attach ?? attachExistingSupervisor;
    this.bootstrapFn = options.bootstrap ?? bootstrapSupervisor;
    this.handoffFn = options.handoff ?? mintSupervisorHandoff;
  }

  publicState(): DesktopServicePublicState {
    return { status: this.status, reasons: this.reasons.slice() };
  }

  async connect(): Promise<DesktopServicePublicState> {
    return this.queue({ bootstrap: false });
  }

  async start(request: DesktopServiceStartRequest): Promise<DesktopServicePublicState> {
    if (this.disposed) return this.publicState();
    if (this.status === "connected" && this.api) return this.publicState();
    if (!nonEmpty(request?.nodeExe) || !nonEmpty(request?.cliBin)) {
      if (this.inflight) return this.inflight;
      this.becomeUnavailable(this.generation, [MISSING_RUNTIME_PATHS]);
      return this.publicState();
    }
    return this.queue({
      bootstrap: true,
      args: { nodeExe: request.nodeExe, cliBin: request.cliBin },
    });
  }

  getApi(): WorkbenchApi {
    if (this.disposed || this.status !== "connected" || !this.api) {
      throw new DesktopServiceClientError(CLIENT_UNAVAILABLE);
    }
    return this.api;
  }

  async entryUrl(): Promise<string> {
    if (this.disposed || this.status !== "connected" || !this.endpoint) {
      throw new DesktopServiceClientError(ENTRY_UNAVAILABLE);
    }
    const generation = this.generation;
    const endpoint = this.endpoint;
    const origin = parseLoopbackOrigin(endpoint.origin);
    if (!origin) throw new DesktopServiceClientError(HANDOFF_FAILED);
    let raw: string;
    try {
      raw = await this.handoffFn(this.fetch ?? fetch, endpoint);
    } catch {
      throw new DesktopServiceClientError(HANDOFF_FAILED);
    }
    if (!this.live(generation) || this.endpoint !== endpoint) {
      throw new DesktopServiceClientError(ENTRY_UNAVAILABLE);
    }
    const candidate = raw.startsWith("/") ? `${origin}${raw}` : raw;
    const path = parseSupervisorHandoffPath(candidate, origin);
    if (!path) throw new DesktopServiceClientError(HANDOFF_FAILED);
    return `${origin}${path}`;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.endpoint = null;
    this.api = null;
    this.allowBootstrap = false;
    this.startArgs = null;
    this.status = "idle";
    this.reasons = [];
  }

  private queue(request: {
    bootstrap: boolean;
    args?: DesktopServiceStartRequest;
  }): Promise<DesktopServicePublicState> {
    if (this.disposed) return Promise.resolve(this.publicState());
    if (this.status === "connected" && this.api) return Promise.resolve(this.publicState());
    if (request.bootstrap) {
      this.allowBootstrap = true;
      if (!this.startArgs && request.args) this.startArgs = request.args;
    }
    if (this.inflight) return this.inflight;
    const generation = ++this.generation;
    this.status = "connecting";
    this.reasons = [];
    const pending = this.run(generation).finally(() => {
      if (this.inflight === pending) this.inflight = null;
    });
    this.inflight = pending;
    return pending;
  }

  private async run(generation: number): Promise<DesktopServicePublicState> {
    try {
      const attached = await this.attachFn({
        home: this.home,
        allowRealHome: this.allowRealHome,
        fetch: this.fetch,
      });
      if (!this.live(generation)) return this.publicState();

      const kind = classifyAttach(attached);
      if (kind === "endpoint" && "endpoint" in attached) {
        this.becomeConnected(generation, attached.endpoint);
        return this.publicState();
      }
      if (kind === "blocked") {
        this.becomeUnavailable(generation, [
          ...reasonsOf(attached, ATTACH_FAILED),
          ...(this.toolsRoot ? readLastSupervisorDiagnostics(this.home, this.toolsRoot) : []),
        ]);
        return this.publicState();
      }

      const allowBootstrap = this.allowBootstrap;
      const startArgs = this.startArgs;
      if (!allowBootstrap || !startArgs) {
        this.becomeStopped(generation);
        return this.publicState();
      }

      const bootstrapped = await this.bootstrapFn({
        home: this.home,
        argv: [startArgs.nodeExe, startArgs.cliBin],
        execPath: startArgs.nodeExe,
        payloadRoot: this.payloadRoot,
        toolsRoot: this.toolsRoot,
        snapshotRoot: this.snapshotRoot,
        allowRealHome: this.allowRealHome,
        allowColdStart: true,
        fetch: this.fetch,
      });
      if (!this.live(generation)) return this.publicState();
      if (!bootstrapped.connected) {
        this.becomeUnavailable(generation, bootstrapped.reasons.length ? bootstrapped.reasons : [START_FAILED]);
        return this.publicState();
      }
      this.becomeConnected(generation, bootstrapped.endpoint);
      return this.publicState();
    } catch (error) {
      if (!this.live(generation)) return this.publicState();
      this.becomeUnavailable(generation, [messageOf(error, CONNECTION_FAILED)]);
      return this.publicState();
    }
  }

  private becomeConnected(generation: number, endpoint: DesktopSupervisorEndpoint): void {
    if (!this.live(generation)) return;
    this.endpoint = endpoint;
    this.api = createWorkbenchHttpClient({
      endpoint,
      fetch: this.fetch,
    });
    this.status = "connected";
    this.reasons = [];
    this.allowBootstrap = false;
    this.startArgs = null;
  }

  /** A verified absence is a normal state, not an attach or startup failure. */
  private becomeStopped(generation: number): void {
    if (!this.live(generation)) return;
    this.endpoint = null;
    this.api = null;
    this.status = "stopped";
    this.reasons = [];
    this.allowBootstrap = false;
    this.startArgs = null;
  }

  private becomeUnavailable(generation: number, reasons: string[]): void {
    if (!this.live(generation)) return;
    this.endpoint = null;
    this.api = null;
    this.status = "unavailable";
    this.reasons = this.publishReasons(reasons);
    this.allowBootstrap = false;
    this.startArgs = null;
  }

  private live(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private publishReasons(reasons: string[]): string[] {
    const secrets = this.secretValues();
    const out: string[] = [];
    for (const reason of reasons) {
      if (typeof reason !== "string" || !reason.trim()) continue;
      const text = redactPublicText(reason, secrets);
      if (text) out.push(text);
      if (out.length >= MAX_REASONS) break;
    }
    return out.length ? out : [CONNECTION_FAILED];
  }

  private secretValues(): string[] {
    const rows = [
      this.home,
      this.payloadRoot,
      this.toolsRoot,
      this.snapshotRoot,
      this.startArgs?.nodeExe,
      this.startArgs?.cliBin,
      this.endpoint?.bearer,
    ];
    const unique = new Set<string>();
    for (const row of rows) {
      if (typeof row === "string" && row.trim().length >= 3) unique.add(row);
    }
    return [...unique].sort((a, b) => b.length - a.length);
  }
}

function classifyAttach(result: DesktopAttachResult): "endpoint" | "missing" | "blocked" {
  if (!result || typeof result !== "object") return "blocked";
  if ("endpoint" in result && result.endpoint && typeof result.endpoint === "object") {
    const endpoint = result.endpoint;
    if (typeof endpoint.origin === "string" && typeof endpoint.bearer === "string") return "endpoint";
    return "blocked";
  }
  if ("blocked" in result && result.blocked === true) return "blocked";
  if ("stale" in result && result.stale === true) return "blocked";
  if ("missing" in result && result.missing === true) return "missing";
  return "blocked";
}

function reasonsOf(result: DesktopAttachResult, fallback: string): string[] {
  if (result && typeof result === "object" && "reasons" in result && Array.isArray(result.reasons)) {
    const rows = result.reasons.filter((row): row is string => typeof row === "string" && Boolean(row.trim()));
    if (rows.length) return rows;
  }
  return [fallback];
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function redactPublicText(text: string, secrets: string[]): string {
  let out = text.trim();
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  out = out
    .replace(/\bAuthorization\s*:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]{16,}/g, "Bearer [redacted]")
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|token|password|secret|nonce|file|path)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
      (full) => `${full.slice(0, full.search(/[:=]/) + 1)}[redacted]`,
    )
    .replace(/\bsk-[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`<>]+/g, "[path]")
    .replace(/(?:\/(?:home|Users|tmp|var|root)\/|~\/)[^\s"'`<>]+/g, "[path]");
  if (out.length > MAX_REASON_CHARS) out = out.slice(0, MAX_REASON_CHARS);
  return out;
}
