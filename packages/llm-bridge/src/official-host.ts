import type { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as llmPiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { installManagedRequestGuard } from "./request-guard";
import type { SpacesFileSettingsProvider } from "./settings-provider";

/**
 * Attach the official `0.1.5-rc.2` llm service and llm-pi-ai adapter.
 * Does not replace the adapter; it only registers the existing plugin.
 */
export async function attachOfficialLlm(ctx: Context, settings: SpacesFileSettingsProvider): Promise<void> {
  await ctx.plugin(LlmRuntime);
  installManagedRequestGuard(ctx, settings);
  await ctx.plugin(llmPiAi, { providers: {} });
}
