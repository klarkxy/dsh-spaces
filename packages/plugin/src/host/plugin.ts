import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { workbenchHostHintSchema } from "./workbench-schemas";
import { WorkbenchGuideHost } from "./workbench-guide";
import { WorkbenchManagerHost } from "./workbench-manager";
import { SpacesHost, type SpacesHostConfig } from "./spaces-service";
import { runtimeFromContext, WorkbenchHostRuntime } from "./runtime";
import { parseLoopbackOrigin, parseRelativeEntryPath } from "./loopback";

const HOST_HINT_GLOBAL = "__DSH_SPACES_HOST__";
const HANDOFF_PATH = "/dsh-spaces/handoff";

/**
 * Package default plugin. Always registers the read-only guide Remote
 * (role/bootstrap/returnTarget/initialize). Manager write remotes and
 * compatibility spaces reads register only when HomeController.roleOf(current
 * profile) is manager. Ordinary profiles never auto-bootstrap a supervisor.
 */
export class SpacesPlugin {
  static inject = ["loader"];
  static name = "dsh-spaces";

  readonly runtime: WorkbenchHostRuntime;
  readonly guide: WorkbenchGuideHost;
  readonly manager: WorkbenchManagerHost | null;
  readonly spaces: SpacesHost | null;

  constructor(ctx: Context, config: SpacesHostConfig = {}, runtime?: WorkbenchHostRuntime) {
    this.runtime = runtime ?? runtimeFromContext(ctx, config);
    this.guide = new WorkbenchGuideHost(ctx, this.runtime);
    if (this.runtime.shouldRegisterManager) {
      this.manager = new WorkbenchManagerHost(ctx, this.runtime);
      this.spaces = new SpacesHost(ctx, this.runtime);
      void this.runtime.bootstrap();
    } else {
      this.manager = null;
      this.spaces = null;
    }
    installHostHint(ctx, this.runtime);
    installHandoffRoute(ctx, this.runtime);
  }
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
