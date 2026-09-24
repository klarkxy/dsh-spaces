import type { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as llmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { LLM_ERROR, LlmConfigError } from "../../../src/core/domain/llm-connections";
import { installManagedRequestGuard, type BridgeStatusReader } from "./request-guard";

export function requireOfficialLlmAdapter(mod: { supportedProtocols?: unknown } | null | undefined): typeof llmPiAi {
  if (!mod || typeof mod.supportedProtocols !== "function") {
    throw new LlmConfigError(LLM_ERROR.ADAPTER_MISSING, "The official adapter is not available in this space.");
  }
  return mod as typeof llmPiAi;
}

/**
 * Attach the official `llm/stream` guard onto the native `llm` service.
 * Does not replace the adapter, install a missing package, or pick another implementation.
 * `llm-pi-ai` itself is composition-owned (Loader / profile insert).
 */
export async function attachOfficialLlm(ctx: Context, settings: BridgeStatusReader): Promise<void> {
  requireOfficialLlmAdapter(llmPiAi);
  if (!ctx.llm) await ctx.plugin(LlmRuntime);
  installManagedRequestGuard(ctx, settings);
}
