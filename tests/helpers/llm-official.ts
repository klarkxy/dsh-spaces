import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dump as dumpYaml } from "js-yaml";
import { Context } from "@deepseek-ai/cordis";
import { boot, initProfile, readProfilePatches, type ProfileContext } from "@deepseek-ai/dsh-app-boot";
import { LocalCredentialProvider } from "@deepseek-ai/dsh-credentials-local";
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import type { LlmSharedSnapshot } from "../../src/core/domain/llm-connections.ts";
import { LLM_SNAPSHOT_ENV } from "../../src/adapters/node/llm-snapshot.ts";
import { freezeSpaceSnapshot } from "../../packages/llm-bridge/src/space-bridge.ts";
import { SNAPSHOT_SERVICE, name as BRIDGE_ID } from "../../packages/llm-bridge/src/plugin.ts";
import { SpacesCredentialsProvider, type SharedCredentialLookup } from "../../packages/llm-bridge/src/credentials-provider.ts";
import type { LlmBridgeStatus } from "../../packages/llm-bridge/src/settings-provider.ts";
import { AGENT_DEFAULT_MODEL_NAMESPACE, LLM_PI_AI_NAMESPACE } from "../../packages/llm-bridge/src/settings-provider.ts";

export const PINNED_DSH_PACKAGE_VERSION = "0.1.7-alpha.1";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const themePlugin = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "llm-theme-plugin.ts")).href;
const bridgePlugin = pathToFileURL(join(repoRoot, "packages/llm-bridge/src/plugin.ts")).href;
const hostParent = pathToFileURL(join(repoRoot, "package.json")).href;

export type NativeSettingsFacade = {
  documentPath: string;
  update(ns: string, patch: object, expected?: number): Promise<void>;
  replace(ns: string, section: object, expected?: number): Promise<void>;
  mutate(ns: string, ops: readonly unknown[], expected?: number): Promise<void>;
  describe(): Array<{ ns: string; value?: unknown; user?: unknown; base?: unknown; revision?: number }>;
  get(ns: string): unknown;
  bridgeStatus(): LlmBridgeStatus;
};

export type OpenedNativeSpace = {
  ctx: Context;
  settings: NativeSettingsFacade;
  credentials: Context["credentials"];
  snapshot: LlmSharedSnapshot | null;
  home: string;
  profileDir: string;
  credentialsPath: string;
  patchPath: string;
  unplugBridge(): Promise<void>;
  dispose(): Promise<void>;
};

export function spacePaths(root: string, spaceId: string) {
  const home = join(root, spaceId);
  return {
    home,
    settings: join(home, "profiles", spaceId, "cordis.patch.yml"),
    credentials: join(home, ".credentials.yaml"),
    policy: join(home, "llm-policy.json"),
  };
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

export async function openSpaceLlmBridge(input: {
  dshHome: string;
  snapshot: LlmSharedSnapshot | null;
  sharedHome?: string;
  localCredentialsPath?: string;
  spaceId?: string;
  localProviders?: Record<string, unknown>;
  defaultModel?: { provider: string; model: string };
  forgedManagedProviders?: Record<string, unknown>;
}): Promise<OpenedNativeSpace> {
  const spaceId = input.spaceId ?? "space";
  if (spaceId === "web") {
    throw new Error("native llm tests must not write profiles/web");
  }
  const home = input.dshHome;
  mkdirSync(home, { recursive: true });
  const profileDir = join(home, "profiles", spaceId);
  initProfile(profileDir, []);
  const credentialsPath = input.localCredentialsPath ?? join(home, ".credentials.yaml");
  mkdirSync(dirname(credentialsPath), { recursive: true });
  const includePath = join(profileDir, "cordis.yml");
  writeFileSync(includePath, "[]\n");
  const insert = nativeInsertPatches({
    credentialsPath,
    dshHome: home,
    localProviders: input.localProviders,
    defaultModel: input.defaultModel,
  });
  if (input.forgedManagedProviders) {
    insert.push({
      id: LLM_PI_AI_NAMESPACE,
      config: { providers: input.forgedManagedProviders },
    });
  }
  const patchPath = join(profileDir, "cordis.patch.yml");
  writeFileSync(patchPath, `${dumpYaml(insert)}\n`);
  const profileContext: ProfileContext = {
    name: spaceId,
    dir: profileDir,
    patchPath,
    installAnchor: join(repoRoot, "package.json"),
    cwd: profileDir,
    home,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  };
  const snapshotPath = join(home, "llm-launch-snapshot.json");
  const sharedHome = input.sharedHome ?? home;
  const env = snapshotEnv(input.snapshot, snapshotPath, sharedHome);
  let ctx: Context;
  const restore = withEnv({
    ...env,
    DSH_HOME: home,
  });
  try {
    ctx = await boot(
      "dsh-spaces-llm-test",
      includePath,
      readProfilePatches("dsh", profileContext),
      (root) => {
        root.provide("profileContext", profileContext);
      },
      hostParent,
    );
  } finally {
    restore();
  }
  await ctx.loader?.await();
  await assertActive(ctx, [
    "config-editor",
    "settings",
    "credentials",
    "llm",
    BRIDGE_ID,
    LLM_PI_AI_NAMESPACE,
    AGENT_DEFAULT_MODEL_NAMESPACE,
    "spaces-theme",
  ]);
  return {
    ctx,
    settings: nativeSettingsFacade(ctx),
    credentials: ctx.credentials,
    snapshot: input.snapshot,
    home,
    profileDir,
    credentialsPath,
    patchPath,
    async unplugBridge() {
      for (const entry of ctx.loader?.entries() ?? []) {
        if (entry.options.id !== BRIDGE_ID) continue;
        await entry.fiber?.dispose();
        break;
      }
      await ctx.loader?.await();
    },
    async dispose() {
      await ctx.fiber.dispose();
    },
  };
}

export async function startLocalSettings(path: string, dshHome: string, shared?: LlmSharedSnapshot) {
  mkdirSync(dshHome, { recursive: true });
  void path;
  return openSpaceLlmBridge({
    dshHome,
    snapshot: shared ?? null,
    localCredentialsPath: join(dshHome, ".credentials.yaml"),
    spaceId: "space",
  });
}

export async function startPlainSettings(path: string, dshHome: string) {
  mkdirSync(dshHome, { recursive: true });
  void path;
  return openSpaceLlmBridge({
    dshHome,
    snapshot: null,
    localCredentialsPath: join(dshHome, ".credentials.yaml"),
    spaceId: "plain",
  });
}

export function nativeSettingsFacade(ctx: Context): NativeSettingsFacade {
  const settings = ctx.settings as NativeSettingsFacade;
  return {
    get documentPath() {
      return settings.documentPath;
    },
    update: (ns, patch, expected) => settings.update(ns, patch, expected),
    replace: (ns, section, expected) => settings.replace(ns, section, expected),
    mutate: (ns, ops, expected) => settings.mutate(ns, ops, expected),
    describe: () => settings.describe(),
    get(ns: string) {
      return liveNamespace(ctx, ns);
    },
    bridgeStatus() {
      if (typeof (settings as { bridgeStatus?: () => LlmBridgeStatus }).bridgeStatus === "function") {
        return (settings as { bridgeStatus: () => LlmBridgeStatus }).bridgeStatus();
      }
      return {
        source: "local-only",
        catalogRevision: null,
        policyRevision: null,
        connectionRevisions: {},
        adapterVersion: null,
        managedRouteConflict: false,
        conflictRouteIds: [],
      };
    },
  };
}

export function liveNamespace(ctx: Context, ns: string): unknown {
  const described = ctx.settings.describe().find((row) => row.ns === ns);
  if (described?.value !== undefined) return described.value;
  const loader = ctx.loader;
  if (!loader) return undefined;
  for (const entry of loader.entries()) {
    if (entry.options.id !== ns || entry.fiber?.state !== 2 || !entry.fiber.config) continue;
    return plainConfig(entry.fiber.config);
  }
  return undefined;
}

export { freezeSpaceSnapshot };

function nativeInsertPatches(input: {
  credentialsPath: string;
  dshHome: string;
  localProviders?: Record<string, unknown>;
  defaultModel?: { provider: string; model: string };
}): PatchOptions[] {
  return [
    {
      insert: [
        { id: "config-editor", name: "@deepseek-ai/dsh-config-editor" },
        { id: "settings", name: "@deepseek-ai/dsh-settings" },
        {
          id: "credentials",
          name: "@deepseek-ai/dsh-credentials-local",
          config: { path: input.credentialsPath, dshHome: input.dshHome, watch: false },
        },
        { id: "llm", name: "@deepseek-ai/dsh-llm" },
        {
          id: BRIDGE_ID,
          name: bridgePlugin,
          config: {},
        },
        {
          id: LLM_PI_AI_NAMESPACE,
          name: "@deepseek-ai/dsh-llm-pi-ai",
          inject: { [SNAPSHOT_SERVICE]: true },
          config: { providers: input.localProviders ?? {} },
        },
        {
          id: AGENT_DEFAULT_MODEL_NAMESPACE,
          name: "@deepseek-ai/dsh-agent-default-model",
          inject: { [SNAPSHOT_SERVICE]: true },
          config: input.defaultModel ?? { provider: "composition", model: "baseline" },
        },
        {
          id: "spaces-theme",
          name: themePlugin,
          config: { color: "gray" },
        },
      ],
    },
  ];
}

function snapshotEnv(
  snapshot: LlmSharedSnapshot | null,
  snapshotPath: string,
  sharedHome: string,
): Record<string, string | undefined> {
  if (!snapshot) {
    return {
      [LLM_SNAPSHOT_ENV.snapshot]: undefined,
      [LLM_SNAPSHOT_ENV.home]: undefined,
    };
  }
  writeFileSync(snapshotPath, `${JSON.stringify({ schemaVersion: 1, snapshot })}\n`);
  return {
    [LLM_SNAPSHOT_ENV.snapshot]: snapshotPath,
    [LLM_SNAPSHOT_ENV.home]: sharedHome,
  };
}

function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function assertActive(ctx: Context, ids: readonly string[]): Promise<void> {
  const active = new Set<string>();
  const failed: string[] = [];
  for (const entry of ctx.loader?.entries() ?? []) {
    const id = entry.options.id;
    if (!id) continue;
    if (entry.fiber?.state === 2) {
      active.add(id);
      continue;
    }
    if (!ids.includes(id)) continue;
    let detail = `${id} (${entry.options.name}) state=${String(entry.fiber?.state)}`;
    try {
      await entry.fiber?.await();
    } catch (error) {
      detail += ` error=${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    }
    failed.push(detail);
  }
  const missing = ids.filter((id) => !active.has(id));
  if (missing.length === 0) return;
  throw new Error(
    `native llm composition missing active entries: ${missing.join(", ")}${failed.length ? `; ${failed.join("; ")}` : ""}`,
  );
}

function plainConfig(value: unknown): unknown {
  if (value && typeof value === "object" && "get" in value && typeof (value as { get: unknown }).get === "function") {
    return plainConfig((value as { get: () => unknown }).get());
  }
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
  }
  return value;
}

export function tempNativeHome(prefix = "dsh-llm-native-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
