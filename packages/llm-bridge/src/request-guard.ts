import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { isManagedRouteId } from "../../../src/core/domain/llm-connections";
import { refuseManagedCall, type LlmBridgeStatus } from "./settings-provider";

export type BridgeStatusReader = { bridgeStatus(): LlmBridgeStatus };

/**
 * Refuse managed-route calls when the local user document occupies a reserved
 * prefix. Local routes keep their original path. This listener only rejects;
 * it does not rewrite the request, pick another model, or retry.
 */
export function installManagedRequestGuard(ctx: Context, settings: BridgeStatusReader): void {
  ctx.on("llm/stream", function (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
    if (isManagedRouteId(options.provider)) {
      refuseManagedCall(settings.bridgeStatus());
    }
    return next();
  });
}
