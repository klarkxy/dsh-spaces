import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { FileSettingsProvider } from "@deepseek-ai/dsh-settings-file";
import { LocalCredentialProvider } from "@deepseek-ai/dsh-credentials-local";
import { SpacesCredentialsProvider, type SharedCredentialLookup } from "../../packages/llm-bridge/src/credentials-provider.ts";
import { SpacesFileSettingsProvider } from "../../packages/llm-bridge/src/settings-provider.ts";
import type { LlmSharedSnapshot } from "../../src/core/domain/llm-connections.ts";

export const PINNED_DSH_PACKAGE_VERSION = "0.1.5-rc.2";

export async function startLocalSettings(path: string, dshHome: string, shared?: LlmSharedSnapshot) {
  mkdirSync(dshHome, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(SpacesFileSettingsProvider, { path, dshHome, watch: false });
  const settings = ctx.settings as SpacesFileSettingsProvider;
  if (shared) settings.replaceSharedSnapshot(shared);
  return { ctx, settings };
}

export async function startPlainSettings(path: string, dshHome: string) {
  mkdirSync(dshHome, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(FileSettingsProvider, { path, dshHome, watch: false });
  return { ctx, settings: ctx.settings as FileSettingsProvider };
}

export async function startLocalCredentials(path: string, dshHome: string) {
  mkdirSync(dshHome, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(LocalCredentialProvider, { path, dshHome, watch: false });
  return { ctx, credentials: ctx.credentials as LocalCredentialProvider };
}

export async function startBridgedCredentials(input: {
  localPath: string;
  localHome: string;
  shared: SharedCredentialLookup;
  snapshot: LlmSharedSnapshot | null;
}) {
  const local = await startLocalCredentials(input.localPath, input.localHome);
  const ctx = new Context();
  const credentials = new SpacesCredentialsProvider(ctx, local.credentials, input.shared, input.snapshot);
  return { ctx, credentials, local };
}

export function spacePaths(root: string, spaceId: string) {
  const home = join(root, spaceId);
  return {
    home,
    settings: join(home, "settings.yaml"),
    credentials: join(home, ".credentials.yaml"),
    policy: join(home, "llm-policy.json"),
  };
}
