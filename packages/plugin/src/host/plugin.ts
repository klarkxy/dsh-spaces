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
import { MainSpaceCreatorService } from "./main-space-creator";
import { MainSpaceControlService } from "./main-space-control";
import { installMainSpaceGuidance } from "./main-space-guidance";
import { installMainSpaceTools } from "./main-space-tools";
import { shareWelcomeNotice } from "./welcome-notice";
import type { DiagnosticLogger } from "../../../../src/adapters/node/diagnostics/rotating-log";
import { attachHostDiagnosticLogger, hostProcessDiagnosticLogger } from "../../../../src/adapters/node/diagnostics/host-log";

const HOST_HINT_GLOBAL = "__DSH_SPACES_HOST__";
const HANDOFF_PATH = "/dsh-spaces/handoff";

export function hostDiagnosticLogger(runtime: WorkbenchHostRuntime): DiagnosticLogger | undefined {
  const identity = runtime.identity;
  if (!identity.confirmed || !identity.home) return undefined;
  return hostProcessDiagnosticLogger(identity.home, { allowRealHome: runtime.allowRealHome });
}

/**
 * Package default plugin. Registers the guide Remote with presentation and
 * explicit launch operations (manual service restart is Desktop-only). Manager write remotes and
 * compatibility spaces reads register only when HomeLease.roleOf(current
 * profile) is manager. Web and ordinary managed profiles never auto-bootstrap a
 * supervisor. A confirmed Desktop host schedules one background launch after its
 * Creator registration listener is installed.
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
    const diagnostic = hostDiagnosticLogger(this.runtime);
    diagnostic?.info("host.plugin-loaded", "Spaces host plugin loaded.", { role: this.runtime.identity.role, profile: this.runtime.identity.profileId });
    if (diagnostic) ctx.effect(() => attachHostDiagnosticLogger(ctx, diagnostic));
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
      const runtime = this.runtime;
      // The listener outlives a disposal that happens before the endpoint is
      // delivered: the late attach then fails with MAIN_CLOSED, so a launch
      // never reports ready without its main registration.
      let delivered = false;
      let disposed = false;
      let listening = true;
      let stopListening = (): void => undefined;
      const stop = (): void => {
        if (!listening) return;
        listening = false;
        stopListening();
      };
      stopListening = runtime.onSupervisorAttached(
        async (endpoint) => {
          delivered = true;
          try {
            await creator.attach(endpoint);
            control?.attach(endpoint);
          } finally {
            if (disposed) stop();
          }
        },
        async (epoch) => {
          await creator.afterSupervisorStopped(epoch);
          control?.afterSupervisorStopped(epoch);
        },
      );
      ctx.effect(() => async () => {
        disposed = true;
        if (delivered) stop();
        else {
          void runtime.desktopLaunchState().then((state) => {
            if (state.phase === "failed" || state.phase === "stopped" || state.phase === "ready" || state.phase === "idle") stop();
          }, () => stop());
        }
        await control?.close();
        await creator.close();
      });
    }
    installHostHint(ctx, this.runtime);
    installHandoffRoute(ctx, this.runtime);
    if (!this.runtime.shouldRegisterManager && this.runtime.qualifiesForAutomaticDesktopLaunch()) {
      scheduleConfirmedDesktopLaunch(ctx, this.runtime);
    }
  }
}

/**
 * A confirmed Desktop host is also the trusted main host, so the Creator
 * attachment listener is installed above before this launch begins; the
 * launch waits for that registration. One launch per process start.
 */
function scheduleConfirmedDesktopLaunch(ctx: Context, runtime: WorkbenchHostRuntime): void {
  hostDiagnosticLogger(runtime)?.info("host.desktop-launch", "Desktop requested its single service launch.");
  void runtime.beginDesktopLaunch().catch((error: unknown) => {
    hostDiagnosticLogger(runtime)?.error("host.desktop-launch-failed", "Desktop service launch failed.", error);
    ctx.logger.error(publicReason(error));
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
