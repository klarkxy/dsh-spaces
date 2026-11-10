/**
 * Creator registration transport of the trusted main host.
 *
 * Mirrors the MainLlmService handshake but is fully independent of the LLM
 * services: a plugin-owned loopback listener answers the server identity
 * challenge, guarded by a separate callback bearer. The issued `scope` never
 * reaches the model, the session, the endpoint record or the logs — it is
 * used only as the bearer of the Creator operation calls.
 *
 * Wire contract (`src/shared/creator.ts`, `src/adapters/node/supervisor/creator.ts`):
 *   POST {origin}/internal/creator/v1/issue         (Host bearer)
 *     body { origin, home, profile, bearer: callbackBearer }
 *     the supervisor then POSTs {origin}/identity { nonce } with that bearer;
 *     we answer { nonce, home, profile }.
 *     response { registrationId, scopes: { creator?, control? }, serviceEpoch }
 *   POST {origin}/internal/creator/v1/context        (scope bearer) body {}
 *   POST {origin}/internal/creator/v1/createPreview  (scope bearer) body { input }
 *   POST {origin}/internal/creator/v1/createExecute  (scope bearer) body { planId, requestId }
 *   POST {origin}/internal/creator/v1/job            (scope bearer) body { jobId }
 *   POST {origin}/internal/creator/v1/unregister     (Host bearer) body { registrationId }
 *
 * The server requires a native request: no Origin, Cookie or sec-fetch-site
 * header is ever sent. One live registration per service epoch; a live
 * registration elsewhere conflicts instead of rotating, and a failed issue is
 * terminal for this endpoint — the same rejection is reported on every later
 * call until the supervisor endpoint itself changes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  CREATOR_CHANNEL_PREFIX,
  CREATOR_ERROR,
  type CreatorContext,
  type CreatorErrorCode,
  type CreatorIssueResult,
  type CreatorPlan,
} from "../../../../src/shared/creator";
import { publicReason } from "../../../../src/adapters/node/runtime/start-failure";
import type { SupervisorEndpoint } from "./supervisor-bootstrap";
import type { CreatorCreatePreviewInput } from "./main-space-tools";
import type { WorkbenchJob } from "../../../../src/shared/workbench";

const BODY_LIMIT = 512 * 1024;
const CALL_TIMEOUT_MS = 30_000;

interface ProfileContextLike {
  home: string;
  name: string;
  dir?: string;
}

interface Registration {
  registrationId: string;
  scope: string;
  /** Issued for /internal/control/v1/; absent on a supervisor without the channel. */
  controlScope?: string;
  serviceEpoch: string;
}

function error(code: string): Error {
  const err = new Error(code);
  err.name = "CreatorServiceError";
  return err;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((closeError) => {
      if (closeError) reject(closeError);
      else resolvePromise();
    });
  });
}

function sanitizeFailure(failure: unknown): string {
  return publicReason(failure instanceof Error ? failure.message : String(failure));
}

/** Socket-level cause of a fetch failure (ECONNREFUSED etc.) for diagnostics. */
function fetchCause(failure: unknown): string {
  const cause = failure instanceof Error ? (failure as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
    ? (cause as { code: string }).code
    : undefined;
  if (code) return code;
  if (failure instanceof Error && failure.message) return failure.message.slice(0, 80);
  return "transport failure";
}

/**
 * The Creator-scoped port of one main host. Constructed for the host plugin;
 * attach happens only when the supervisor endpoint is delivered, and the
 * listener is owned by this service (closed on dispose or supervisor stop).
 */
export class MainSpaceCreatorService {
  private endpoint?: SupervisorEndpoint;
  private registration?: Registration;
  private readonly previews = new Map<string, CreatorPlan>();
  private bearer = randomBytes(32).toString("hex");
  private closed = false;
  /**
   * Settled issue for the current endpoint — success AND failure are terminal.
   * A rejected issue is never retried against the same endpoint; only a real
   * endpoint change (attach/afterSupervisorStopped) clears it.
   */
  private issuing?: Promise<Registration>;
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(private readonly ctx: Context) {}

  /** Delivered by the host plugin when the supervisor endpoint is known. */
  async attach(endpoint: SupervisorEndpoint): Promise<void> {
    if (this.closed) throw error("MAIN_CLOSED");
    if (this.endpoint && this.endpoint.serviceEpoch !== endpoint.serviceEpoch) {
      throw error("CREATOR_REGISTRATION_CHANGED");
    }
    if (!this.endpoint) this.endpoint = endpoint;
    // Register once when the endpoint arrives: the supervisor learns the main
    // profile from this registration (model sync, creation with main models),
    // and a Desktop launch stays connecting until it settles. A rejection is
    // terminal for this endpoint and is reported as the attach failure.
    await this.scope();
  }

  /** Called when the supervisor endpoint is released. */
  async afterSupervisorStopped(previousEpoch: string | null): Promise<void> {
    if (this.closed) throw error("MAIN_CLOSED");
    if (previousEpoch !== null && this.endpoint && this.endpoint.serviceEpoch !== previousEpoch) {
      throw error("CREATOR_REGISTRATION_CHANGED");
    }
    const pending = this.issuing;
    this.issuing = undefined;
    this.registration = undefined;
    this.previews.clear();
    this.endpoint = undefined;
    this.bearer = randomBytes(32).toString("hex");
    const errors: string[] = [];
    if (pending) {
      try {
        await pending;
      } catch (failure) {
        errors.push(`creator issue after supervisor stop: ${sanitizeFailure(failure)}`);
      }
    }
    try {
      await closeServer(this.server);
    } catch (failure) {
      errors.push(`creator listener close: ${sanitizeFailure(failure)}`);
    }
    if (errors.length) throw error(errors.join("; "));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const endpoint = this.endpoint;
    const errors: string[] = [];
    // A still-running issue settles first; its failure is reported, not hidden.
    if (this.issuing) {
      try {
        this.registration = await this.issuing;
      } catch (failure) {
        errors.push(`creator issue during close: ${sanitizeFailure(failure)}`);
      }
    }
    const registration = this.registration;
    this.registration = undefined;
    this.previews.clear();
    if (registration && endpoint) {
      try {
        await this.post(endpoint, "unregister", endpoint.bearer, {
          registrationId: registration.registrationId,
        });
      } catch (failure) {
        errors.push(`creator unregister: ${sanitizeFailure(failure)}`);
      }
    }
    try {
      await closeServer(this.server);
    } catch (failure) {
      errors.push(`creator listener close: ${sanitizeFailure(failure)}`);
    }
    if (errors.length) throw error(errors.join("; "));
  }

  // ---------------------------------------------------------------------
  // Scoped operations (all fail closed until a scope is registered).
  // ---------------------------------------------------------------------

  async context(signal?: AbortSignal): Promise<CreatorContext> {
    const scope = await this.scope();
    return this.postScoped("context", {}, scope, signal);
  }

  /** Freeze a server-side plan and remember it for the execute approval. */
  async createPreview(input: CreatorCreatePreviewInput, signal?: AbortSignal): Promise<CreatorPlan> {
    const scope = await this.scope();
    const plan = await this.postScoped<CreatorPlan>("createPreview", { input }, scope, signal);
    this.previews.set(plan.id, plan);
    return plan;
  }

  /**
   * The frozen plan this host previewed under the current registration.
   * Bound to this main host's registration, not to any agent session.
   */
  previewedPlan(planId: string): CreatorPlan | undefined {
    return this.previews.get(planId);
  }

  async createExecute(input: { planId: string; requestId: string }, signal?: AbortSignal): Promise<WorkbenchJob> {
    const scope = await this.scope();
    return this.postScoped("createExecute", input, scope, signal);
  }

  async job(jobId: string, signal?: AbortSignal): Promise<WorkbenchJob> {
    const scope = await this.scope();
    return this.postScoped("job", { jobId }, scope, signal);
  }

  /**
   * The issued control scope for the sibling MainSpaceControlService. Forces
   * the same lazy issue as the creator scope; a supervisor without the
   * control channel reports control/unsupported — never silently absent.
   */
  async controlScope(signal?: AbortSignal): Promise<string> {
    void signal;
    await this.scope();
    const controlScope = this.registration?.controlScope;
    if (!controlScope) throw error("control/unsupported");
    return controlScope;
  }

  /** The shared registration id (same record for both scopes), once issued. */
  async issuedRegistrationId(): Promise<string> {
    await this.scope();
    return this.registration!.registrationId;
  }

  // ---------------------------------------------------------------------
  // Registration handshake.
  // ---------------------------------------------------------------------

  private async scope(): Promise<string> {
    if (this.closed) throw error("MAIN_CLOSED");
    if (this.registration) return this.registration.scope;
    if (!this.endpoint) throw error("workbench/unavailable");
    // Once settled, `issuing` stays memoized for this endpoint: a failed issue
    // replays the same rejection instead of retrying against the server.
    if (!this.issuing) this.issuing = this.issue();
    const registration = await this.issuing;
    // A stop/dispose raced the issue: the endpoint was released meanwhile, so
    // this late registration must not be installed.
    if (this.closed || !this.endpoint || this.endpoint.serviceEpoch !== registration.serviceEpoch) {
      throw error("CREATOR_REGISTRATION_CHANGED");
    }
    this.registration = registration;
    return registration.scope;
  }

  private async issue(): Promise<Registration> {
    const endpoint = this.endpoint;
    if (!endpoint) throw error("workbench/unavailable");
    let listenFailed: unknown;
    try {
      await this.listen();
    } catch (failure) {
      listenFailed = failure;
    }
    if (listenFailed) {
      // Bounded cleanup: the failed listener is closed once, then the original
      // error propagates. Nothing retries it for this endpoint.
      try {
        await closeServer(this.server);
      } catch (closeFailure) {
        throw error(`${sanitizeFailure(listenFailed)}; callback listener cleanup: ${sanitizeFailure(closeFailure)}`);
      }
      throw listenFailed;
    }
    const profile = this.profile();
    const origin = `http://127.0.0.1:${this.port()}`;
    const body = {
      origin,
      home: resolve(profile.home),
      profile: profile.name,
      bearer: this.bearer,
    };
    const result = await this.post<CreatorIssueResult>(endpoint, "issue", endpoint.bearer, body);
    if (typeof result.registrationId !== "string" || typeof result.scopes?.creator !== "string" || typeof result.serviceEpoch !== "string") {
      throw error("CREATOR_REGISTRATION_INVALID");
    }
    if (result.serviceEpoch !== endpoint.serviceEpoch) {
      throw error("CREATOR_REGISTRATION_CHANGED");
    }
    const controlScope = typeof result.scopes.control === "string" ? result.scopes.control : undefined;
    return {
      registrationId: result.registrationId,
      scope: result.scopes.creator,
      ...(controlScope !== undefined ? { controlScope } : {}),
      serviceEpoch: result.serviceEpoch,
    };
  }

  private profile(): ProfileContextLike {
    const profile = (this.ctx as Context & { profileContext?: ProfileContextLike }).profileContext;
    if (!profile || typeof profile.home !== "string" || typeof profile.name !== "string") {
      throw error("profile-context-unavailable");
    }
    return profile;
  }

  private listen(): Promise<void> {
    if (this.server.listening) return Promise.resolve();
    return new Promise<void>((accept, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        accept();
      });
    });
  }

  private port(): number {
    const address = this.server.address();
    if (!address || typeof address === "string") throw error("callback-listener-unavailable");
    return address.port;
  }

  private url(endpoint: SupervisorEndpoint, op: string): string {
    return `${endpoint.origin}${CREATOR_CHANNEL_PREFIX}${op}`;
  }

  private async post<T>(endpoint: SupervisorEndpoint, op: string, bearer: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      // The server demands a native request: no Origin, Cookie or sec-fetch-site.
      // The caller's signal is joined with the bounded call timeout — passing a
      // signal never drops the deadline. `connection: close` keeps the shared
      // fetch pool from reusing a socket across listener rebirths on reused
      // loopback ports.
      const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
      response = await fetch(this.url(endpoint, op), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
          connection: "close",
        },
        body: JSON.stringify(body),
      });
    } catch (failure) {
      // The socket cause explains the transport failure without leaking the
      // request body or bearer.
      throw error(`workbench/unavailable (${op}: ${fetchCause(failure)})`);
    }
    return this.readEnvelope(response);
  }

  private async postScoped<T>(op: string, body: unknown, scope: string, signal?: AbortSignal): Promise<T> {
    return this.post<T>(this.endpoint!, op, scope, body, signal);
  }

  private async readEnvelope<T>(response: Response): Promise<T> {
    let text = "";
    try {
      text = await response.text();
    } catch {
      throw error("workbench/unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw error("workbench/unavailable");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw error("workbench/unavailable");
    }
    const row = parsed as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } };
    if (row.ok === false) {
      const code = typeof row.error?.code === "string" ? row.error.code : "creator/failed";
      const fallback = Object.hasOwn(CREATOR_ERROR, code) ? CREATOR_ERROR[code as CreatorErrorCode] : "The creator request failed.";
      const message = typeof row.error?.message === "string" && row.error.message ? row.error.message : fallback;
      throw error(`${code}: ${message}`);
    }
    // The transport status is authoritative too: a 4xx/5xx never reports a
    // successful value even when a body claims ok.
    if (!response.ok || row.ok !== true) throw error("workbench/unavailable");
    return row.value as T;
  }

  private json(res: ServerResponse, value: unknown, status = 200): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  }

  /** The server calls back here with the callback bearer to prove the host. */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.closed || req.method !== "POST" || req.headers.authorization !== `Bearer ${this.bearer}` || req.headers.origin || req.headers.cookie) {
        throw error("MAIN_AUTH_REQUIRED");
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > BODY_LIMIT) throw error("BODY_TOO_LARGE");
        chunks.push(part);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { nonce?: unknown };
      if (req.url === "/identity") {
        const profile = this.profile();
        this.json(res, { nonce: input.nonce, home: resolve(profile.home), profile: profile.name });
        return;
      }
      throw error("UNKNOWN_CALLBACK");
    } catch (failure) {
      if (!res.headersSent) {
        this.json(res, { error: sanitizeFailure(failure) }, 400);
      } else {
        res.destroy();
      }
    }
  }
}
