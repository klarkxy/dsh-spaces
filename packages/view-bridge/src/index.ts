import type { Context } from "@deepseek-ai/cordis";
import { injectViewHintScript, parseViewEnv, VIEW_HINT_GLOBAL, type ViewHandshakeConfig } from "./env";

export const name = "dsh-spaces-view-bridge";
export const inject = ["webServer"];

/**
 * Independent Host half. Does not import Spaces or workbench management.
 * Reads DSH_SPACES_VIEW_* from the supervisor-injected Node env. Invalid env
 * is a no-op. Non-secret handshake facts are given to the client through a
 * DSH webServer index tap when that service exists.
 */
export function apply(ctx: Context, _config?: unknown, env: NodeJS.ProcessEnv = process.env): ViewHandshakeConfig | null {
  const view = parseViewEnv(env);
  if (!view) return null;
  const on = (ctx as { on?(event: string, listener: (...args: unknown[]) => void): () => void }).on;
  if (typeof on === "function") {
    on.call(ctx, "webserver/index-inject", (table: unknown) => {
      if (!Array.isArray(table)) return;
      table.push({ kind: "global", name: VIEW_HINT_GLOBAL, value: view });
    });
  }
  const getter = (ctx as { get?(name: string, strict?: boolean): unknown }).get;
  const webServer = (
    typeof getter === "function" ? getter.call(ctx, "webServer", false) : undefined
  ) as { tapIndex?(transform: (html: string) => string): () => void } | undefined;
  if (webServer && typeof webServer.tapIndex === "function") {
    const effect = (ctx as { effect?(fn: () => () => void): () => void }).effect;
    const install = () => webServer.tapIndex!((html) => injectViewHintScript(html, view));
    if (typeof effect === "function") effect.call(ctx, install);
    else install();
  }
  return view;
}

export {
  VIEW_ENV,
  VIEW_HINT_GLOBAL,
  injectViewHintScript,
  parseViewEnv,
  parseViewHint,
  readViewHint,
  type ViewHandshakeConfig,
} from "./env";
export {
  PARENT_PING_SOURCE,
  acceptParentMessage,
  parseParentPing,
  postViewState,
  viewMessage,
  type ViewHandshakeMessage,
} from "./handshake";

export default { name, inject, apply };
