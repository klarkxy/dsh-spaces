/**
 * Control (空间总控) channel transport of the trusted main host.
 *
 * The control channel shares the main registration minted by
 * MainSpaceCreatorService: the same registration id, a second scope. This
 * service never issues or unregisters — it only reads `controlScope()` from
 * the creator service and posts to the Supervisor's
 * /internal/control/v1/ read surface. Wire contract: src/shared/control.ts.
 *
 * The scope string stays inside this module: the Cordis Service exposes
 * operation-level methods only. A supervisor without the control channel
 * reports control/unsupported verbatim; no retry, reconnect or degraded
 * direct access ever happens here.
 */
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import {
  CONTROL_CHANNEL_PREFIX,
  CONTROL_ERROR,
  CONTROL_LOG_TAIL_MAX,
  CONTROL_PROTOCOL_VERSION,
  parseControlExecuteInput,
  parseControlImportPreviewInput,
  parseControlJobInput,
  parseControlPlanInput,
  parseControlReadInput,
  type ControlImportPreviewInput,
  parseControlUiActInput,
  parseControlUiCloseInput,
  parseControlUiEvalInput,
  parseControlUiOpenInput,
  parseControlUiSnapshotInput,
  type ControlContext,
  type ControlErrorCode,
  type ControlExecuteInput,
  type ControlInspectResult,
  type ControlInspectSection,
  type ControlLogsResult,
  type ControlOverviewResult,
  type ControlJobResult,
  type ControlPlanInput,
  type ControlPlanResult,
  type ControlReadResult,
  type ControlImportPreviewResult,
  type ControlTemplatesResult,
  type ControlUiActInput,
  type ControlUiActResult,
  type ControlUiCloseInput,
  type ControlUiCloseResult,
  type ControlUiEvalInput,
  type ControlUiEvalResult,
  type ControlUiOpenInput,
  type ControlUiOpenResult,
  type ControlUiSnapshotInput,
  type ControlUiSnapshotResult,
} from "../../../../src/shared/control";
import { publicReason } from "../../../../src/adapters/node/runtime/start-failure";
import type { MainSpaceCreatorService } from "./main-space-creator";
import type { SupervisorEndpoint } from "./supervisor-bootstrap";

const CALL_TIMEOUT_MS = 30_000;

/**
 * The model-adjacent surface of the control channel. Operations only; the
 * control scope is never exposed. Every call is one bounded POST to the
 * Supervisor and fails with the channel's own error code on rejection.
 */
export interface SpacesMainChannel {
  context(signal?: AbortSignal): Promise<ControlContext>;
  overview(signal?: AbortSignal): Promise<ControlOverviewResult>;
  inspect(spaceId: string, sections?: readonly ControlInspectSection[], signal?: AbortSignal): Promise<ControlInspectResult>;
  logs(spaceId: string, tail?: number, signal?: AbortSignal): Promise<ControlLogsResult>;
  templates(signal?: AbortSignal): Promise<ControlTemplatesResult>;
  importPreview(input: ControlImportPreviewInput, signal?: AbortSignal): Promise<ControlImportPreviewResult>;
  plan(input: ControlPlanInput, signal?: AbortSignal): Promise<ControlPlanResult>;
  execute(input: ControlExecuteInput, signal?: AbortSignal): Promise<ControlJobResult>;
  plannedPlan(planId: string): ControlPlanResult | undefined;
  job(jobId: string, signal?: AbortSignal): Promise<ControlJobResult>;
  uiOpen(input: ControlUiOpenInput, signal?: AbortSignal): Promise<ControlUiOpenResult>;
  uiSnapshot(input: ControlUiSnapshotInput, signal?: AbortSignal): Promise<ControlUiSnapshotResult>;
  uiAct(input: ControlUiActInput, signal?: AbortSignal): Promise<ControlUiActResult>;
  uiEval(input: ControlUiEvalInput, signal?: AbortSignal): Promise<ControlUiEvalResult>;
  uiClose(input: ControlUiCloseInput, signal?: AbortSignal): Promise<ControlUiCloseResult>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    spacesMainChannel: MainSpaceControlService;
  }
}

function error(code: string): Error {
  const err = new Error(code);
  err.name = "ControlServiceError";
  return err;
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

function expectObject(value: unknown, code = "CONTROL_RESULT_INVALID"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error(code);
  return value as Record<string, unknown>;
}

/**
 * Control-scoped read port of one main host. Registers as the Cordis service
 * `spacesMainChannel` (Service pattern: SpaceMessages in view-bridge). The
 * host plugin constructs it only for the trusted main host, so the service
 * simply does not exist on the manager profile or on child spaces.
 */
export class MainSpaceControlService extends Service implements SpacesMainChannel {
  private endpoint?: SupervisorEndpoint;
  private readonly plans = new Map<string, ControlPlanResult>();
  private closed = false;

  constructor(
    ctx: Context,
    private readonly creator: MainSpaceCreatorService,
  ) {
    super(ctx, "spacesMainChannel");
  }

  /** Delivered by the host plugin when the supervisor endpoint is known. */
  attach(endpoint: SupervisorEndpoint): void {
    if (this.closed) throw error("MAIN_CLOSED");
    if (this.endpoint && this.endpoint.serviceEpoch !== endpoint.serviceEpoch) {
      throw error("CONTROL_ENDPOINT_CHANGED");
    }
    if (!this.endpoint) this.endpoint = endpoint;
  }

  /** Called when the supervisor endpoint is released. */
  afterSupervisorStopped(previousEpoch: string | null): void {
    if (this.closed) throw error("MAIN_CLOSED");
    if (previousEpoch !== null && this.endpoint && this.endpoint.serviceEpoch !== previousEpoch) {
      throw error("CONTROL_ENDPOINT_CHANGED");
    }
    this.endpoint = undefined;
    this.plans.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.endpoint = undefined;
    this.plans.clear();
  }

  async context(signal?: AbortSignal): Promise<ControlContext> {
    const value = expectObject(await this.post("context", {}, signal));
    const spaces = value.spaces;
    if (
      value.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
      typeof value.serviceEpoch !== "string" ||
      typeof value.revision !== "string" ||
      typeof value.writable !== "boolean" ||
      typeof value.maintenance !== "boolean" ||
      typeof value.busy !== "boolean" ||
      !(value.dshVersion === null || typeof value.dshVersion === "string") ||
      !Array.isArray(spaces) ||
      spaces.some((row) => !row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string" ||
        !["idle", "busy", "unknown"].includes((row as { activity?: unknown }).activity as string))
    ) {
      throw error("CONTROL_RESULT_INVALID");
    }
    return value as unknown as ControlContext;
  }

  async overview(signal?: AbortSignal): Promise<ControlOverviewResult> {
    const value = await this.readResult("overview", {}, signal);
    return value as ControlOverviewResult & { view: "overview" };
  }

  async inspect(
    spaceId: string,
    sections?: readonly ControlInspectSection[],
    signal?: AbortSignal,
  ): Promise<ControlInspectResult> {
    const input = parseControlReadInput({
      view: "inspect",
      spaceId,
      ...(sections !== undefined ? { sections: [...sections] } : {}),
    });
    const value = await this.readResult("inspect", input, signal);
    return value as ControlInspectResult & { view: "inspect" };
  }

  async logs(spaceId: string, tail?: number, signal?: AbortSignal): Promise<ControlLogsResult> {
    const input = parseControlReadInput({
      view: "logs",
      spaceId,
      ...(tail !== undefined ? { tail: Math.min(tail, CONTROL_LOG_TAIL_MAX) } : {}),
    });
    const value = await this.readResult("logs", input, signal);
    return value as ControlLogsResult & { view: "logs" };
  }

  async templates(signal?: AbortSignal): Promise<ControlTemplatesResult> {
    const input = parseControlReadInput({ view: "templates" });
    const value = await this.readResult("templates", input, signal);
    return value as ControlTemplatesResult & { view: "templates" };
  }

  /**
   * Stage one share archive for a later space.import plan. The input is
   * content only — the channel has no path form, so the host never sends
   * one and the supervisor never opens one.
   */
  async importPreview(input: ControlImportPreviewInput, signal?: AbortSignal): Promise<ControlImportPreviewResult> {
    const parsed = parseControlImportPreviewInput(input);
    const value = expectObject(await this.post("import.preview", parsed, signal));
    if (
      typeof value.importId !== "string" ||
      typeof value.expiresAt !== "string" ||
      !value.preview || typeof value.preview !== "object"
    ) {
      throw error("CONTROL_RESULT_INVALID");
    }
    return value as unknown as ControlImportPreviewResult;
  }

  async job(jobId: string, signal?: AbortSignal): Promise<ControlJobResult> {
    const input = parseControlJobInput({ jobId });
    const value = expectObject(await this.post("job", input, signal));
    if (typeof value.id !== "string") throw error("CONTROL_RESULT_INVALID");
    return value as unknown as ControlJobResult;
  }

  /** Freeze a server-side control plan and remember it for the execute approval. */
  async plan(input: ControlPlanInput, signal?: AbortSignal): Promise<ControlPlanResult> {
    const parsed = parseControlPlanInput(input);
    const value = expectObject(await this.post("plan", parsed, signal));
    if (
      value.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
      typeof value.controlPlanId !== "string" ||
      typeof value.fingerprint !== "string" ||
      typeof value.op !== "string" ||
      value.op !== parsed.op ||
      typeof value.spaceId !== "string" ||
      // Creation ops carry no input spaceId: the supervisor derives it from
      // params.name and the plan result is the first place the id appears.
      (("spaceId" in parsed && parsed.spaceId !== undefined ? parsed.spaceId : value.spaceId) !== value.spaceId) ||
      typeof value.displayName !== "string" ||
      !Array.isArray(value.affectedSpaceIds) ||
      !Array.isArray(value.changes) ||
      !(value.taskActivity === undefined || ["idle", "busy", "unknown"].includes(value.taskActivity as string)) ||
      typeof value.expiresAt !== "string"
    ) {
      throw error("CONTROL_RESULT_INVALID");
    }
    const plan = value as unknown as ControlPlanResult;
    this.plans.set(plan.controlPlanId, plan);
    return plan;
  }

  /**
   * The frozen plan this host created under the current registration — the
   * object the execute approval names. Bound to this host's registration,
   * never to any agent session.
   */
  plannedPlan(planId: string): ControlPlanResult | undefined {
    return this.plans.get(planId);
  }

  async execute(input: ControlExecuteInput, signal?: AbortSignal): Promise<ControlJobResult> {
    const parsed = parseControlExecuteInput(input);
    const value = expectObject(await this.post("execute", parsed, signal));
    if (typeof value.id !== "string") throw error("CONTROL_RESULT_INVALID");
    return value as unknown as ControlJobResult;
  }

  /**
   * ui.open: mint a UI session on one running ordinary space. The result
   * carries no URL, port, cookie or launch token — `path` is the relative
   * page path only.
   */
  async uiOpen(input: ControlUiOpenInput, signal?: AbortSignal): Promise<ControlUiOpenResult> {
    const parsed = parseControlUiOpenInput(input);
    const value = expectObject(await this.post("ui.open", parsed, signal));
    const viewport = value.viewport;
    if (
      typeof value.uiSessionId !== "string" ||
      value.spaceId !== parsed.spaceId ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
      !viewport || typeof viewport !== "object" ||
      !Number.isFinite((viewport as { width?: unknown }).width) ||
      !Number.isFinite((viewport as { height?: unknown }).height) ||
      typeof value.path !== "string" || !value.path.startsWith("/")
    ) {
      throw error("CONTROL_RESULT_INVALID");
    }
    return value as unknown as ControlUiOpenResult;
  }

  /**
   * ui.snapshot: page snapshot. The screenshot arrives as raw base64 and is
   * passed through untouched — the tool layer persists it as an attachment.
   */
  async uiSnapshot(input: ControlUiSnapshotInput, signal?: AbortSignal): Promise<ControlUiSnapshotResult> {
    const parsed = parseControlUiSnapshotInput(input);
    const value = expectObject(await this.post("ui.snapshot", parsed, signal));
    if (
      value.uiSessionId !== parsed.uiSessionId ||
      typeof value.spaceId !== "string" ||
      typeof value.title !== "string" ||
      typeof value.path !== "string" ||
      !(value.aria === undefined || typeof value.aria === "string") ||
      !(value.text === undefined || typeof value.text === "string") ||
      !(value.html === undefined || typeof value.html === "string") ||
      !(value.screenshot === undefined || typeof value.screenshot === "string") ||
      !(value.screenshotBytes === undefined ||
        (typeof value.screenshotBytes === "number" && Number.isSafeInteger(value.screenshotBytes))) ||
      typeof value.truncated !== "boolean"
    ) {
      throw error("CONTROL_RESULT_INVALID");
    }
    return value as unknown as ControlUiSnapshotResult;
  }

  async uiAct(input: ControlUiActInput, signal?: AbortSignal): Promise<ControlUiActResult> {
    const parsed = parseControlUiActInput(input);
    const value = expectObject(await this.post("ui.act", parsed, signal));
    if (value.done !== true || typeof value.path !== "string") {
      throw error("CONTROL_RESULT_INVALID");
    }
    return value as unknown as ControlUiActResult;
  }

  async uiEval(input: ControlUiEvalInput, signal?: AbortSignal): Promise<ControlUiEvalResult> {
    const parsed = parseControlUiEvalInput(input);
    const value = expectObject(await this.post("ui.eval", parsed, signal));
    if (!("value" in value) || typeof value.truncated !== "boolean") {
      throw error("CONTROL_RESULT_INVALID");
    }
    return value as unknown as ControlUiEvalResult;
  }

  async uiClose(input: ControlUiCloseInput, signal?: AbortSignal): Promise<ControlUiCloseResult> {
    const parsed = parseControlUiCloseInput(input);
    const value = expectObject(await this.post("ui.close", parsed, signal));
    if (value.closed !== true) throw error("CONTROL_RESULT_INVALID");
    return { closed: true };
  }

  /** The issued control scope from the shared registration; never stored. */
  private async scope(signal?: AbortSignal): Promise<string> {
    if (this.closed) throw error("MAIN_CLOSED");
    if (!this.endpoint) throw error("workbench/unavailable");
    return this.creator.controlScope(signal);
  }

  private async readResult(
    view: "overview" | "inspect" | "logs" | "templates",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ControlReadResult> {
    const value = expectObject(await this.post("read", { view, ...(input as Record<string, unknown>) }, signal));
    if (value.view !== view) throw error("CONTROL_RESULT_INVALID");
    return value as unknown as ControlReadResult;
  }

  private async post(op: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const endpoint = this.endpoint;
    if (!endpoint) throw error("workbench/unavailable");
    const scope = await this.scope(signal);
    let response: Response;
    try {
      // The server demands a native request: no Origin, Cookie or sec-fetch-site.
      // `connection: close` keeps the shared fetch pool from reusing a socket
      // across listener rebirths on reused loopback ports.
      const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
      response = await fetch(`${endpoint.origin}${CONTROL_CHANNEL_PREFIX}${op}`, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${scope}`,
          connection: "close",
        },
        body: JSON.stringify(body),
      });
    } catch (failure) {
      throw error(`workbench/unavailable (${op}: ${fetchCause(failure)})`);
    }
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
      const code = typeof row.error?.code === "string" ? row.error.code : "control/failed";
      const fallback = Object.hasOwn(CONTROL_ERROR, code) ? CONTROL_ERROR[code as ControlErrorCode] : "The control request failed.";
      const message = typeof row.error?.message === "string" && row.error.message ? row.error.message : fallback;
      throw error(`${code}: ${sanitizeFailure(message)}`);
    }
    // The transport status is authoritative too: a 4xx/5xx never reports a
    // successful value even when a body claims ok.
    if (!response.ok || row.ok !== true) throw error("workbench/unavailable");
    return row.value;
  }
}
