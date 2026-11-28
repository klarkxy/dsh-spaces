/**
 * UiAutomationManager: the Supervisor-side UI automation for ordinary child
 * spaces. One headless browser (playwright-core over a system Chrome/Edge
 * channel — never downloaded), one isolated context and one page per UI
 * session, at most CONTROL_UI_SESSION_LIMIT live sessions.
 *
 * A uiSessionId is minted by `open` and binds
 * (registrationId, spaceId, generation, serviceEpoch): the space's observed
 * state is re-checked on every operation; stop, generation change, page
 * crash/close and the idle timer invalidate the session together with the
 * open-time authorization. Requests are serialized per session — a second
 * in-flight operation is refused with control/busy, never queued. act and
 * eval take a requestId idempotency key: an identical replay returns the
 * recorded result, a different command with the same requestId conflicts.
 *
 * Failure policy: the engine is probed once per service epoch (channel
 * detection + module load); a probe failure is terminal — ui.* keeps
 * answering control/engine-unavailable until the supervisor restarts. No
 * automatic relaunch, retry, channel switching or page reopening. Cookie
 * material and launch URLs never reach return values, error messages or
 * logs; every outbound string passes the credential redactor.
 */
import { randomBytes } from "node:crypto";
import {
  CONTROL_UI_ACT_TIMEOUT_MS,
  CONTROL_UI_ARIA_MAX_BYTES,
  CONTROL_UI_EVAL_RESULT_MAX_BYTES,
  CONTROL_UI_EVAL_TIMEOUT_MAX_MS,
  CONTROL_UI_HTML_DEFAULT_BYTES,
  CONTROL_UI_IDLE_MS,
  CONTROL_UI_OPEN_TIMEOUT_MS,
  CONTROL_UI_REQUEST_CACHE,
  CONTROL_UI_SCREENSHOT_MAX_BYTES,
  CONTROL_UI_SESSION_LIMIT,
  CONTROL_UI_SNAPSHOT_DEFAULT_FORMATS,
  CONTROL_UI_SNAPSHOT_TIMEOUT_MS,
  CONTROL_UI_TEXT_MAX_BYTES,
  CONTROL_UI_VIEWPORT,
  ControlPublicError,
  type ControlUiActInput,
  type ControlUiActResult,
  type ControlUiCloseResult,
  type ControlUiEvalInput,
  type ControlUiEvalResult,
  type ControlUiOpenResult,
  type ControlUiSnapshotInput,
  type ControlUiSnapshotResult,
} from "../../../shared/control";
import { dshSessionCookie } from "../runtime/dsh-endpoint";
import { redactPublicReason } from "../../../shared/public-reason";
import { sanitizeLogText } from "../diagnostics/diagnostics";
import { controlError } from "./control";
import {
  EVAL_ON_ELEMENT_SOURCE,
  EVAL_ON_PAGE_SOURCE,
  pageFunction,
  relativePagePath,
  redactCredentials,
  SANITIZE_ATTR_PAYLOAD_MIN,
  SANITIZE_OUTER_HTML_SOURCE,
  truncateUtf8,
} from "./ui-shared";

// Rebuilt once at module load: toString() is the verbatim source, so the
// page receives exactly this text — no transpiler helpers, no closures.
const SANITIZE_OUTER_HTML_FN = pageFunction<[Element, number | undefined], string>(SANITIZE_OUTER_HTML_SOURCE);
const EVAL_ON_ELEMENT_FN = pageFunction<[Element, string], unknown>(EVAL_ON_ELEMENT_SOURCE);
const EVAL_ON_PAGE_FN = pageFunction<[string], unknown>(EVAL_ON_PAGE_SOURCE);
import {
  ariaRefSelector,
  playwrightCoreLoader,
  PlaywrightUiEngine,
  runActOnPage,
  type UiContext,
  type UiEngine,
  type UiEngineLoader,
  type UiPage,
} from "./ui-playwright";

export interface UiAutomationPorts {
  /** Resolved ordinary-space id or a thrown public error (whitelist). */
  requireSpace(spaceId: string): string;
  /** web/desktop/manager are refused before any lookup. */
  managerId(): string | null;
  unmanaged(id: string): boolean;
  statusOf(id: string): "running" | "starting" | "stopping" | "stopped" | "crashed" | "unknown";
  /** runs.generation(id) — bumped on every start/stop. */
  generationOf(id: string): number;
  /** runs.spawned presence — the child must be owned by this supervisor. */
  spawned(id: string): boolean;
  /** The running child's launch URL (main-process-only). */
  urlOf(id: string): string | undefined;
  portOf(id: string): number | undefined;
  currentServiceEpoch(): string;
  fetch: typeof fetch;
  /** Test seam: engine loader + channel resolution + idle timeout. */
  loader?: UiEngineLoader;
  resolveEngine?: () => Promise<PlaywrightUiEngine | undefined>;
  idleTimeoutMs?: number;
}

interface StoredSession {
  id: string;
  registrationId: string;
  spaceId: string;
  generation: number;
  serviceEpoch: string;
  context: UiContext;
  page: UiPage;
  /** Cookie value + launch token — used only for output redaction. */
  secrets: string[];
  cookieValue: string;
  origin: string;
  idleTimer?: NodeJS.Timeout;
  inFlight: boolean;
  dead: boolean;
  deadReason?: { code: "control/not-running" | "control/failed"; message: string };
  /** requestId -> recorded result for act/eval idempotency. */
  requests: Map<string, { kind: "act" | "eval"; fingerprint: string; result: unknown }>;
}

/**
 * The manager never owns job lanes: `open` runs inline in the control
 * request (bounded by CONTROL_UI_OPEN_TIMEOUT_MS) and other ops are inline.
 */
export class UiAutomationManager {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly bySpace = new Map<string, string>();
  private readonly retiredRegistrationIds = new Set<string>();
  /**
   * One-shot engine probe + launch shared by every concurrent caller: the
   * promise is created once and never replaced, so a failure is terminal
   * for the service epoch — no re-probe and no second launch attempt.
   */
  private enginePromise?: Promise<UiEngine>;
  private browser?: UiEngine;
  private closed = false;

  constructor(private readonly ports: UiAutomationPorts) {}

  /** Deterministic one-shot probe; the outcome is terminal for this epoch. */
  private requireEngine(): Promise<UiEngine> {
    if (this.closed) {
      return Promise.reject(
        new ControlPublicError("control/unavailable", "The UI automation manager is closed."),
      );
    }
    this.enginePromise ??= this.probeAndLaunch();
    return this.enginePromise;
  }

  private async probeAndLaunch(): Promise<UiEngine> {
    try {
      const engine = this.ports.resolveEngine
        ? await this.ports.resolveEngine()
        : await PlaywrightUiEngine.create(this.ports.loader ?? playwrightCoreLoader);
      if (!engine) {
        throw new ControlPublicError(
          "control/engine-unavailable",
          "No system Chrome or Edge installation was found for UI automation.",
        );
      }
      // One launch against the chosen channel; a launch failure propagates
      // and is remembered — there is no other-channel attempt.
      this.browser = await engine.launch(CONTROL_UI_OPEN_TIMEOUT_MS);
      return this.browser;
    } catch (error) {
      if (error instanceof ControlPublicError) throw error;
      throw new ControlPublicError(
        "control/engine-unavailable",
        this.publicReason(error, "The UI automation engine is unavailable."),
      );
    }
  }

  /** Whitelist: registered ordinary space, owned by this supervisor. */
  private requireTargetSpace(spaceId: string): string {
    if (spaceId === "web" || spaceId === "desktop" || spaceId === this.ports.managerId()) {
      throw new ControlPublicError("control/protected");
    }
    let id: string;
    try {
      id = this.ports.requireSpace(spaceId);
    } catch (error) {
      throw controlError(error);
    }
    if (this.ports.unmanaged(id)) throw new ControlPublicError("control/not-found");
    return id;
  }

  /** The space is owned and running with the expected generation/epoch. */
  private requireRunning(id: string, generation: number, serviceEpoch: string): void {
    if (this.ports.statusOf(id) !== "running" ||
        this.ports.generationOf(id) !== generation ||
        !this.ports.spawned(id) ||
        serviceEpoch !== this.ports.currentServiceEpoch()) {
      throw new ControlPublicError(
        "control/not-running",
        "The space stopped or restarted; the UI session is no longer authorized.",
      );
    }
  }

  private publicReason(error: unknown, fallback: string, secrets: readonly string[] = []): string {
    // Never throw while building the public reason: a mis-typed engine
    // value must degrade to the fallback message, not mask the real error.
    try {
      const raw = error instanceof Error ? error.message : String(error ?? "");
      const cleaned = redactCredentials(redactPublicReason(sanitizeLogText(raw)), secrets);
      return cleaned || fallback;
    } catch {
      return fallback;
    }
  }

  private touch(session: StoredSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      // Idle expiry is ordinary resource release, not a failure or recovery.
      session.dead = true;
      session.deadReason = { code: "control/failed", message: "The UI session expired after an idle timeout." };
      void session.context.close().catch(() => undefined);
    }, this.ports.idleTimeoutMs ?? CONTROL_UI_IDLE_MS);
    session.idleTimer.unref?.();
  }

  private requireSession(uiSessionId: string, registrationId: string): StoredSession {
    const session = this.sessions.get(uiSessionId);
    if (!session || session.registrationId !== registrationId) {
      throw new ControlPublicError("control/not-found", "That UI session was not found.");
    }
    if (session.dead) {
      throw new ControlPublicError(
        session.deadReason?.code ?? "control/failed",
        session.deadReason?.message ?? "The UI session page is no longer available.",
      );
    }
    this.requireRunning(session.spaceId, session.generation, session.serviceEpoch);
    return session;
  }

  /** Serialize one operation on a session; a concurrent second is busy. */
  private async serialized<T>(session: StoredSession, action: () => Promise<T>): Promise<T> {
    if (session.inFlight) {
      throw new ControlPublicError("control/busy", "That UI session already has an operation in flight.");
    }
    session.inFlight = true;
    try {
      return await action();
    } finally {
      session.inFlight = false;
    }
  }

  private markDead(session: StoredSession, code: "control/not-running" | "control/failed", message: string): void {
    if (session.dead) return;
    session.dead = true;
    session.deadReason = { code, message };
  }

  /**
   * Open (or reuse) the one UI session for a space. Reopening the same
   * generation returns the same session; a new generation requires a fresh
   * open anyway. The launch token is exchanged for a session cookie that is
   * injected into the isolated context — the launch URL is never navigated.
   */
  async open(registrationId: string, spaceId: string): Promise<ControlUiOpenResult> {
    if (this.retiredRegistrationIds.has(registrationId)) {
      throw new ControlPublicError("control/unavailable", "The control registration is not active.");
    }
    const id = this.requireTargetSpace(spaceId);
    const generation = this.ports.generationOf(id);
    const serviceEpoch = this.ports.currentServiceEpoch();
    this.requireRunning(id, generation, serviceEpoch);
    const existing = this.bySpace.get(id);
    if (existing) {
      const session = this.sessions.get(existing);
      if (session && !session.dead &&
          session.generation === generation && session.serviceEpoch === serviceEpoch &&
          session.registrationId === registrationId) {
        this.touch(session);
        return {
          uiSessionId: session.id,
          spaceId: id,
          generation,
          viewport: { ...CONTROL_UI_VIEWPORT },
          path: relativePagePath(session.page.url()),
        };
      }
      // A stale entry for the same space (dead session or another
      // registration's page) is released before a new one is created.
      if (session) await this.release(session);
      this.bySpace.delete(id);
    }
    if (this.sessions.size >= CONTROL_UI_SESSION_LIMIT) {
      throw new ControlPublicError("control/busy", "Too many open UI sessions.");
    }
    const launch = this.ports.urlOf(id);
    const port = this.ports.portOf(id);
    if (!launch || !port) {
      throw new ControlPublicError("control/unavailable", "The space endpoint is not available.");
    }
    const engine = await this.requireEngine();
    const abort = AbortSignal.timeout(CONTROL_UI_OPEN_TIMEOUT_MS);
    let cookie: string;
    try {
      const value = await dshSessionCookie(launch, this.ports.fetch, abort);
      if (!value) throw new Error("The child authentication exchange produced no session cookie.");
      cookie = value;
    } catch (error) {
      throw new ControlPublicError("control/unavailable", this.publicReason(error, "The child authentication exchange failed."));
    }
    // Split on the first "=" only: the value itself may contain "=".
    const separator = cookie.indexOf("=");
    const cookieName = separator > 0 ? cookie.slice(0, separator) : undefined;
    const cookieValue = separator > 0 ? cookie.slice(separator + 1) : undefined;
    if (!cookieName || !cookieValue) {
      throw new ControlPublicError("control/unavailable", "The child authentication exchange returned no usable session cookie.");
    }
    const origin = `http://127.0.0.1:${port}`;
    const context = await engine.newContext();
    let page: UiPage | undefined;
    const secrets = [cookieValue, new URL(launch).searchParams.get("token") ?? ""];
    try {
      // Mirror the attributes DSH itself sets on the session cookie
      // (HttpOnly; SameSite=Strict): page scripts, including spaces_ui_eval,
      // must never be able to read it.
      await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: "Strict" }]);
      page = await context.newPage();
      await page.goto(`${origin}/`, { timeout: CONTROL_UI_OPEN_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    } catch (error) {
      await context.close().catch(() => undefined);
      throw new ControlPublicError("control/failed", this.publicReason(error, "The UI session page could not be opened.", secrets));
    }
    const session: StoredSession = {
      id: `ui-${randomBytes(16).toString("hex")}`,
      registrationId,
      spaceId: id,
      generation,
      serviceEpoch,
      context,
      page,
      secrets,
      cookieValue: cookieValue ?? "",
      origin,
      inFlight: false,
      dead: false,
      requests: new Map(),
    };
    const onGone = () => {
      this.markDead(session, "control/failed", "The UI session page closed or crashed.");
      void session.context.close().catch(() => undefined);
    };
    page.on("close", onGone);
    page.on("crash", onGone);
    if (this.retiredRegistrationIds.has(registrationId)) {
      await context.close().catch(() => undefined);
      throw new ControlPublicError("control/unavailable", "The control registration is not active.");
    }
    this.sessions.set(session.id, session);
    this.bySpace.set(id, session.id);
    this.touch(session);
    return {
      uiSessionId: session.id,
      spaceId: id,
      generation,
      viewport: { ...CONTROL_UI_VIEWPORT },
      path: relativePagePath(page.url()),
    };
  }

  async snapshot(registrationId: string, input: ControlUiSnapshotInput): Promise<ControlUiSnapshotResult> {
    const session = this.requireSession(input.uiSessionId, registrationId);
    return await this.serialized(session, async () => {
      this.touch(session);
      const formats = input.formats ?? [...CONTROL_UI_SNAPSHOT_DEFAULT_FORMATS];
      let truncated = false;
      const result: ControlUiSnapshotResult = {
        uiSessionId: session.id,
        spaceId: session.spaceId,
        title: "",
        path: "/",
        truncated: false,
      };
      try {
        result.title = redactCredentials(await session.page.title(), session.secrets);
        result.path = relativePagePath(session.page.url());
        const scope = input.ref ? session.page.locator(ariaRefSelector(input.ref)) : undefined;
        for (const format of formats) {
          if (format === "aria") {
            const raw = scope
              ? await scope.ariaSnapshot({ mode: "ai", timeout: CONTROL_UI_SNAPSHOT_TIMEOUT_MS })
              : await session.page.ariaSnapshot({ mode: "ai", timeout: CONTROL_UI_SNAPSHOT_TIMEOUT_MS });
            const cut = truncateUtf8(redactCredentials(raw, session.secrets), CONTROL_UI_ARIA_MAX_BYTES);
            result.aria = cut.text;
            truncated ||= cut.truncated;
          } else if (format === "text") {
            const raw = await (scope ?? session.page.locator("body"))
              .innerText({ timeout: CONTROL_UI_SNAPSHOT_TIMEOUT_MS });
            const cut = truncateUtf8(redactCredentials(raw, session.secrets), CONTROL_UI_TEXT_MAX_BYTES);
            result.text = cut.text;
            truncated ||= cut.truncated;
          } else if (format === "html") {
            const max = input.maxBytes ?? CONTROL_UI_HTML_DEFAULT_BYTES;
            // The fn is rebuilt from a verbatim source constant in Node, so
            // evaluate serializes exactly that source — no __name helpers.
            const raw = await (scope ?? session.page.locator("html"))
              .evaluate(SANITIZE_OUTER_HTML_FN, SANITIZE_ATTR_PAYLOAD_MIN, { timeout: CONTROL_UI_SNAPSHOT_TIMEOUT_MS });
            if (typeof raw !== "string") {
              throw new ControlPublicError("control/failed", "The page sanitizer returned a non-string result.");
            }
            const cut = truncateUtf8(redactCredentials(raw, session.secrets), max);
            result.html = cut.text;
            truncated ||= cut.truncated;
          } else if (format === "screenshot") {
            const png = scope
              ? await scope.screenshot({ type: "png" })
              : await session.page.screenshot({ type: "png" });
            if (png.byteLength > CONTROL_UI_SCREENSHOT_MAX_BYTES) {
              throw new ControlPublicError("control/failed", "The screenshot exceeded the byte limit.");
            }
            result.screenshot = png.toString("base64");
            result.screenshotBytes = png.byteLength;
          }
        }
      } catch (error) {
        if (session.page.isClosed()) {
          this.markDead(session, "control/failed", "The UI session page closed or crashed.");
        }
        throw this.publicError(error, session, "The snapshot failed.");
      }
      result.truncated = truncated;
      return result;
    });
  }

  private publicError(error: unknown, session: StoredSession, fallback: string): ControlPublicError {
    if (error instanceof ControlPublicError) return error;
    return new ControlPublicError("control/failed", this.publicReason(error, fallback, session.secrets));
  }

  private async idempotent<T>(
    session: StoredSession,
    requestId: string,
    kind: "act" | "eval",
    fingerprint: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const recorded = session.requests.get(requestId);
    if (recorded) {
      if (recorded.kind === kind && recorded.fingerprint === fingerprint) return recorded.result as T;
      throw new ControlPublicError(
        "control/request-conflict",
        "The request id was already used for a different UI command.",
      );
    }
    const result = await run();
    if (session.requests.size >= CONTROL_UI_REQUEST_CACHE) {
      const oldest = session.requests.keys().next().value;
      if (oldest !== undefined) session.requests.delete(oldest);
    }
    session.requests.set(requestId, { kind, fingerprint, result });
    return result;
  }

  async act(registrationId: string, input: ControlUiActInput): Promise<ControlUiActResult> {
    const session = this.requireSession(input.uiSessionId, registrationId);
    return await this.serialized(session, async () => {
      this.touch(session);
      return await this.idempotent(session, input.requestId, "act", JSON.stringify(input.act), async () => {
        try {
          await runActOnPage(session.page, input.act, session.origin, CONTROL_UI_ACT_TIMEOUT_MS);
        } catch (error) {
          if (session.page.isClosed()) {
            this.markDead(session, "control/failed", "The UI session page closed or crashed.");
          }
          throw this.publicError(error, session, "The UI action failed.");
        }
        return { done: true as const, path: relativePagePath(session.page.url()) };
      });
    });
  }

  async eval(registrationId: string, input: ControlUiEvalInput): Promise<ControlUiEvalResult> {
    const session = this.requireSession(input.uiSessionId, registrationId);
    return await this.serialized(session, async () => {
      this.touch(session);
      return await this.idempotent(session, input.requestId, "eval", input.script + (input.ref ?? ""), async () => {
        const timeoutMs = Math.min(input.timeoutMs ?? CONTROL_UI_EVAL_TIMEOUT_MAX_MS, CONTROL_UI_EVAL_TIMEOUT_MAX_MS);
        let raw: unknown;
        try {
          if (input.ref) {
            const locator = session.page.locator(ariaRefSelector(input.ref));
            raw = await locator.evaluate(EVAL_ON_ELEMENT_FN, input.script, { timeout: timeoutMs });
          } else {
            raw = await session.page.evaluate(EVAL_ON_PAGE_FN, input.script, { timeout: timeoutMs });
          }
        } catch (error) {
          if (session.page.isClosed()) {
            this.markDead(session, "control/failed", "The UI session page closed or crashed.");
          }
          throw this.publicError(error, session, "The script did not finish.");
        }
        // The result must be JSON-serializable; the serialized form is
        // redacted before the byte cap so no credential value can ever be
        // cut through mid-escape. Non-serializable and `undefined` results
        // both collapse to null — the call itself succeeded.
        let serialized: string;
        try {
          serialized = JSON.stringify(raw) ?? "null";
        } catch {
          throw new ControlPublicError("control/failed", "The script result is not JSON-serializable.");
        }
        serialized = redactCredentials(serialized, session.secrets);
        if (Buffer.byteLength(serialized, "utf8") <= CONTROL_UI_EVAL_RESULT_MAX_BYTES) {
          return { value: JSON.parse(serialized) as unknown, truncated: false };
        }
        const cut = truncateUtf8(serialized, CONTROL_UI_EVAL_RESULT_MAX_BYTES);
        return { value: cut.text, truncated: true };
      });
    });
  }

  async close(registrationId: string, uiSessionId: string): Promise<ControlUiCloseResult> {
    const session = this.sessions.get(uiSessionId);
    if (!session || session.registrationId !== registrationId) {
      throw new ControlPublicError("control/not-found", "That UI session was not found.");
    }
    await this.release(session);
    return { closed: true };
  }

  /** Normal resource release: stop the idle clock, close the context. */
  private async release(session: StoredSession): Promise<void> {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
    session.dead = true;
    this.sessions.delete(session.id);
    if (this.bySpace.get(session.spaceId) === session.id) this.bySpace.delete(session.spaceId);
    await session.context.close().catch(() => undefined);
  }

  /** Space status hook: invalidate every session whose space left running. */
  spaceStatusChanged(spaceId: string, status: string): void {
    if (status === "running") return;
    const id = this.bySpace.get(spaceId);
    if (!id) return;
    const session = this.sessions.get(id);
    if (!session || session.dead) return;
    this.markDead(session, "control/not-running",
      "The space stopped or restarted; the UI session is no longer authorized.");
    void session.context.close().catch(() => undefined);
  }

  /** Retire one main registration and release every UI session it opened. */
  async retireRegistration(registrationId: string): Promise<void> {
    this.retiredRegistrationIds.add(registrationId);
    for (const session of [...this.sessions.values()]) {
      if (session.registrationId === registrationId) await this.release(session);
    }
  }

  /** Supervisor shutdown: release the browser and every session. */
  async closeAll(): Promise<void> {
    this.closed = true;
    for (const session of [...this.sessions.values()]) {
      await this.release(session);
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = undefined;
    }
  }

  /** Live session count for diagnostics (no credential or page data). */
  sessionCount(): number {
    return this.sessions.size;
  }
}
