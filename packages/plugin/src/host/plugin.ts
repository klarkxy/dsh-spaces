import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { workbenchHostHintSchema } from "./workbench-schemas";
import { WorkbenchGuideHost } from "./workbench-guide";
import { WorkbenchManagerHost } from "./workbench-manager";
import { SpacesRemote, type SpacesRemoteConfig } from "./spaces-service";
import { runtimeFromContext, WorkbenchHostRuntime } from "./runtime";
import { publicReason } from "../../../../src/adapters/node/runtime/start-failure";
import { parseLoopbackOrigin, parseRelativeEntryPath } from "../../../../src/shared/loopback";
import { assertSupportedNode } from "../../../../src/shared/node-version";
import { MainLlmService } from "./llm-main";
import { MainSpaceCreatorService } from "./main-space-creator";
import { MainSpaceControlService } from "./main-space-control";
import { installMainSpaceGuidance } from "./main-space-guidance";
import { installMainSpaceTools } from "./main-space-tools";
import type { SupervisorEndpoint } from "./supervisor-bootstrap";
import { shareWelcomeNotice } from "./welcome-notice";

/** Bound for Main dependencies. The registration HTTP call keeps its own 10s limit. */
const MAIN_DEPENDENCY_WAIT_MS = 10_000;

const HOST_HINT_GLOBAL = "__DSH_SPACES_HOST__";
const HANDOFF_PATH = "/dsh-spaces/handoff";

/**
 * Package default plugin. Registers the guide Remote with presentation and
 * explicit launch operations (manual service restart is Desktop-only). Manager write remotes and
 * compatibility spaces reads register only when HomeLease.roleOf(current
 * profile) is manager. Web and ordinary managed profiles never auto-bootstrap a
 * supervisor. A confirmed Desktop host schedules one background launch after its
 * required Main registration listener is installed.
 */
export class SpacesPlugin {
  static inject = ["loader"];
  static name = "dsh-spaces";

  readonly runtime: WorkbenchHostRuntime;
  readonly guide: WorkbenchGuideHost;
  readonly manager: WorkbenchManagerHost | null;
  readonly spaces: SpacesRemote | null;
  readonly creator: MainSpaceCreatorService | null;
  readonly control: MainSpaceControlService | null;

  constructor(ctx: Context, config: SpacesRemoteConfig = {}, runtime?: WorkbenchHostRuntime) {
    assertSupportedNode();
    this.runtime = runtime ?? runtimeFromContext(ctx, config);
    shareWelcomeNotice(ctx, this.runtime);
    this.guide = new WorkbenchGuideHost(ctx, this.runtime);
    if (this.runtime.shouldRegisterManager) {
      this.manager = new WorkbenchManagerHost(ctx, this.runtime);
      this.spaces = new SpacesRemote(ctx, this.runtime);
      void this.runtime.bootstrap();
    } else {
      this.manager = null;
      this.spaces = null;
    }
    // Creator tools and guidance only ever live on the confirmed main host
    // (web/desktop), never on the manager profile and never on a child space.
    // The guidance names the tools, so both install together.
    this.creator = this.runtime.isTrustedMainHost ? new MainSpaceCreatorService(ctx) : null;
    // spacesMainChannel is provided only on the same confirmed main host:
    // the control tools' provider simply does not exist elsewhere.
    this.control = this.runtime.isTrustedMainHost && this.creator ? new MainSpaceControlService(ctx, this.creator) : null;
    if (this.creator) {
      installMainSpaceGuidance(ctx);
      installMainSpaceTools(ctx, this.runtime, this.creator);
      const creator = this.creator;
      const control = this.control;
      const dispose = this.runtime.onSupervisorAttached(
        async (endpoint) => {
          await creator.attach(endpoint);
          control?.attach(endpoint);
        },
        async (epoch) => {
          await creator.afterSupervisorStopped(epoch);
          control?.afterSupervisorStopped(epoch);
        },
      );
      ctx.effect(() => async () => {
        dispose();
        await control?.close();
        await creator.close();
      });
    }
    installHostHint(ctx, this.runtime);
    installHandoffRoute(ctx, this.runtime);
    if (!this.runtime.shouldRegisterManager) {
      if (this.runtime.qualifiesForAutomaticDesktopLaunch()) scheduleConfirmedDesktopLaunch(ctx, this.runtime);
      else if (process.env.DSH_SPACES_LLM_INHERIT_MAIN !== "1" && typeof ctx.inject === "function") {
        ctx.inject(["llm", "agentDefaultModel", "attachments", "fs"], (ready) => {
          const service = new MainLlmService(ready);
          const dispose = this.runtime.onSupervisorAttached((endpoint) => service.attach(endpoint), (epoch) => service.afterSupervisorStopped(epoch));
          ready.effect(() => async () => { dispose(); await service.close(); });
        });
      }
    }
  }
}

/**
 * Install the required Main listener before scheduling the launch. The listener
 * waits until dependency injection supplies MainLlmService; dropping it first
 * would let attachReady report ready with no registration. Disposal clears the
 * timer and this listener once it has run or the launch is already terminal.
 * It does not erase the process launch record or schedule another begin.
 */
function scheduleConfirmedDesktopLaunch(ctx: Context, runtime: WorkbenchHostRuntime): void {
  let service: MainLlmService | undefined;
  let settled = false;
  let disposed = false;
  let delivered = false;
  let listenerStopped = false;
  let resolveReady: (value: MainLlmService) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<MainLlmService>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const unavailable = () => new Error("Main registration dependencies are not available.");
  const failWait = () => {
    if (settled) return;
    settled = true;
    rejectReady(unavailable());
  };
  const timer = setTimeout(failWait, MAIN_DEPENDENCY_WAIT_MS);
  if (typeof timer === "object") timer.unref();
  let stopListening = (): void => undefined;
  const stopListener = () => {
    if (listenerStopped) return;
    listenerStopped = true;
    stopListening();
  };
  stopListening = runtime.onSupervisorAttached(async (endpoint: SupervisorEndpoint) => {
    delivered = true;
    try {
      const main = await ready;
      await main.attach(endpoint);
    } finally {
      if (disposed) stopListener();
    }
  }, async (epoch) => {
    if (service) await service.afterSupervisorStopped(epoch);
  });
  const release = () => {
    disposed = true;
    clearTimeout(timer);
    failWait();
    if (delivered) {
      stopListener();
      return;
    }
    void runtime.desktopLaunchState().then((state) => {
      if (state.phase === "failed" || state.phase === "stopped" || state.phase === "ready" || state.phase === "idle") stopListener();
    }, () => stopListener());
  };
  ctx.effect(() => release);
  void runtime.beginDesktopLaunch().catch((error: unknown) => {
    ctx.logger.error(publicReason(error));
  });
  if (process.env.DSH_SPACES_LLM_INHERIT_MAIN === "1" || typeof ctx.inject !== "function") return;
  ctx.inject(["llm", "agentDefaultModel", "attachments", "fs"], (injected) => {
    const created = new MainLlmService(injected);
    service = created;
    if (disposed) {
      void created.close();
      return;
    }
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      resolveReady(created);
    }
    injected.effect(() => async () => {
      release();
      await created.close();
    });
  });
}

export default SpacesPlugin;

function installHostHint(ctx: Context, runtime: WorkbenchHostRuntime): void {
  const hint = workbenchHostHintSchema.parse(runtime.hint());
  const payload = JSON.stringify(hint);
  const on = (ctx as { on?(event: string, listener: (...args: unknown[]) => void): () => void }).on;
  if (typeof on === "function") {
    on.call(ctx, "webserver/index-inject", (table: unknown) => {
      if (!Array.isArray(table)) return;
      table.push({ kind: "global", name: HOST_HINT_GLOBAL, value: hint });
    });
  }
  const getter = (ctx as { get?(name: string, strict?: boolean): unknown }).get;
  const webServer = (
    typeof getter === "function" ? getter.call(ctx, "webServer", false) : undefined
  ) as { tapIndex?(transform: (html: string) => string): () => void } | undefined;
  const effect = (ctx as { effect?(fn: () => () => void): () => void }).effect;
  if (webServer && typeof webServer.tapIndex === "function") {
    const install = () => webServer.tapIndex!((html) => injectHintScript(html, payload));
    if (typeof effect === "function") effect.call(ctx, install);
    else install();
  }
}

function installHandoffRoute(ctx: Context, runtime: WorkbenchHostRuntime): void {
  const getter = (ctx as { get?(name: string, strict?: boolean): unknown }).get;
  const webServer = (
    typeof getter === "function" ? getter.call(ctx, "webServer", false) : undefined
  ) as
    | {
        register?(route: {
          kind: "exact";
          path: string;
          handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
        }): () => void;
      }
    | undefined;
  const connection = (
    typeof getter === "function" ? getter.call(ctx, "connection", false) : undefined
  ) as { requestRejection?(request: { headers: IncomingMessage["headers"] }): number | undefined } | undefined;
  if (!webServer || typeof webServer.register !== "function") return;
  const effect = (ctx as { effect?(fn: () => () => void): () => void }).effect;
  const install = () =>
    webServer.register!({
      kind: "exact",
      path: HANDOFF_PATH,
      handler: async (req, res) => {
        const rejection = connection?.requestRejection?.(req);
        if (rejection) {
          res.writeHead(rejection, { "cache-control": "no-store" });
          res.end();
          return;
        }
        const target = await runtime.returnTarget();
        const href =
          target.available && target.origin && target.path
            ? authorizedHandoffHref(target.origin, target.path)
            : null;
        if (!href) {
          res.writeHead(503, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
          res.end("The workbench entry is not available.");
          return;
        }
        res.writeHead(303, { location: href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        res.end();
      },
    });
  if (typeof effect === "function") effect.call(ctx, install);
  else install();
}

function authorizedHandoffHref(origin: string, path: string): string | null {
  if (parseLoopbackOrigin(origin) !== origin) return null;
  if (parseRelativeEntryPath(path) !== path) return null;
  try {
    const url = new URL(path, origin);
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

export function injectHintScript(html: string, payload: string): string {
  if (!html || payload.includes("<") || payload.includes("&") || payload.includes("</")) return html;
  if (html.includes(HOST_HINT_GLOBAL)) return html;
  const tag = `<script>globalThis.${HOST_HINT_GLOBAL}=${payload};</script>`;
  return html.replace(/<head([^>]*)>/i, (open) => `${open}${tag}`);
}
