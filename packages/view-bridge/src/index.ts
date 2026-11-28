import { SpaceMessageBus } from "./message-bus";
import { SpaceMessages } from "./message-service";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { injectViewHintScript, parseViewEnv, VIEW_ENTRY_PATH, VIEW_HINT_GLOBAL, type ViewHandshakeConfig } from "./env";
import { installSpaceAttention } from "./attention";
import { installLlmActivity } from "./activity";

export const name = "dsh-spaces-view-bridge";
export const inject = ["webServer"];

const VIEW_ENTRY_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>space</title><script>location.replace("/")</script></head><body></body></html>';
const VIEW_ENTRY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "origin-agent-cluster": "?1",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'",
} as const;

export function handleViewEntryRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "GET" || req.method === "HEAD") {
    res.writeHead(200, VIEW_ENTRY_HEADERS);
    if (req.method === "GET") res.end(VIEW_ENTRY_HTML);
    else res.end();
    return;
  }
  res.writeHead(405, { allow: "GET, HEAD" });
  res.end();
}

/**
 * Independent Host half. Does not import Spaces or workbench management.
 * Reads DSH_SPACES_VIEW_* from the supervisor-injected Node env. Invalid env
 * is a no-op. Non-secret handshake facts are given to the client through a
 * DSH webServer index tap when that service exists.
 */
export function apply(ctx: Context, _config?: unknown, env: NodeJS.ProcessEnv = process.env): ViewHandshakeConfig | null {
  const view = parseViewEnv(env);
  if (!view) return null;
  if (process.connected && typeof process.send === "function") {
    const bus = new SpaceMessageBus();
    ctx.effect(() => bus.close);
    new SpaceMessages(ctx, bus);
    installSpaceAttention(ctx);
    installLlmActivity(ctx, env);
  }
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
  ) as {
    tapIndex?(transform: (html: string) => string): () => void;
    register?(route: {
      kind: "exact";
      path: string;
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
  } | undefined;
  const effect = (ctx as { effect?(fn: () => () => void): () => void }).effect;
  if (webServer && typeof webServer.tapIndex === "function") {
    const install = () => webServer.tapIndex!((html) => injectViewHintScript(html, view));
    if (typeof effect === "function") effect.call(ctx, install);
    else install();
  }
  if (webServer && typeof webServer.register === "function") {
    const install = () => webServer.register!({ kind: "exact", path: VIEW_ENTRY_PATH, handler: handleViewEntryRequest });
    if (typeof effect === "function") effect.call(ctx, install);
    else install();
  }
  return view;
}

export {
  VIEW_ENV,
  VIEW_ENTRY_PATH,
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

export { SpaceMessages } from "./message-service";
export { SpaceMessageBus, SpaceMessageError, type SpaceOperation, type JsonValue, type SpaceCapability, type SpaceCapabilityDeclaration } from "./message-bus";
export { SpaceAttentionProbe, installSpaceAttention, type SpaceAttentionSources } from "./attention";
export { LlmActivity, installLlmActivity } from "./activity";
