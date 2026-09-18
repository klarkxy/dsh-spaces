import type { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as llmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { LLM_ERROR, LlmConfigError } from "../../../src/core/domain/llm-connections";
import { installManagedRequestGuard } from "./request-guard";
import type { SpacesFileSettingsProvider } from "./settings-provider";

export function requireOfficialLlmAdapter(mod: { supportedProtocols?: unknown } | null | undefined): typeof llmPiAi {
  if (!mod || typeof mod.supportedProtocols !== "function") {
    throw new LlmConfigError(LLM_ERROR.ADAPTER_MISSING, "The official adapter is not available in this space.");
  }
  return mod as typeof llmPiAi;
}

/**
 * Attach the official `0.1.5-rc.2` llm service and llm-pi-ai adapter.
 * Does not replace the adapter, install a missing package, or pick another implementation.
 */
export async function attachOfficialLlm(ctx: Context, settings: SpacesFileSettingsProvider): Promise<void> {
  const adapter = requireOfficialLlmAdapter(llmPiAi);
  await ctx.plugin(LlmRuntime);
  installManagedRequestGuard(ctx, settings);
  await ctx.plugin(adapter, { providers: {} });
}
