import { Context } from "@deepseek-ai/cordis";
import { LocalCredentialProvider } from "@deepseek-ai/dsh-credentials-local";
import type { GlobalLlmCatalog, LlmSharedSnapshot, SpaceLlmPolicy } from "../../../src/core/domain/llm-connections";
import { snapshotForSpace } from "../../../src/core/domain/llm-resolution";
import { SpacesCredentialsProvider, type SharedCredentialLookup } from "./credentials-provider";
import { SpacesFileSettingsProvider } from "./settings-provider";

export type OpenedSpaceLlmBridge = {
  ctx: Context;
  settings: SpacesFileSettingsProvider;
  credentials: SpacesCredentialsProvider;
  snapshot: LlmSharedSnapshot | null;
  dispose(): Promise<void>;
};

export function freezeSpaceSnapshot(
  catalog: GlobalLlmCatalog,
  policy: SpaceLlmPolicy,
  adapterVersion: string,
): LlmSharedSnapshot {
  return snapshotForSpace(catalog, policy, adapterVersion);
}

/**
 * Open one Space's official settings/credentials seams against a frozen snapshot.
 * The snapshot is not re-read from catalog/policy after this returns.
 */
export async function openSpaceLlmBridge(input: {
  settingsPath: string;
  localCredentialsPath: string;
  dshHome: string;
  snapshot: LlmSharedSnapshot | null;
  shared: SharedCredentialLookup;
}): Promise<OpenedSpaceLlmBridge> {
  const ctx = new Context();
  const localCtx = new Context();
  await ctx.plugin(SpacesFileSettingsProvider, {
    path: input.settingsPath,
    dshHome: input.dshHome,
    watch: false,
    shared: input.snapshot ?? undefined,
  });
  await localCtx.plugin(LocalCredentialProvider, {
    path: input.localCredentialsPath,
    dshHome: input.dshHome,
    watch: false,
  });
  const settings = ctx.settings as SpacesFileSettingsProvider;
  const credentials = new SpacesCredentialsProvider(
    ctx,
    localCtx.credentials as LocalCredentialProvider,
    input.shared,
    input.snapshot,
  );
  return {
    ctx,
    settings,
    credentials,
    snapshot: input.snapshot,
    async dispose() {
      await ctx.fiber.dispose();
      await localCtx.fiber.dispose();
    },
  };
}
