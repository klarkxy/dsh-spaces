import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import z from "@deepseek-ai/schemastery";
import { Config as LlmPiAiConfig } from "@deepseek-ai/dsh-llm-pi-ai";
import { AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA } from "@deepseek-ai/dsh-agent-default-model";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createUserMessage, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SpacesCredentialsProvider } from "../../packages/llm-bridge/src/credentials-provider.ts";
import { attachOfficialLlm } from "../../packages/llm-bridge/src/official-host.ts";
import type { SpacesFileSettingsProvider } from "../../packages/llm-bridge/src/settings-provider.ts";
import { startLocalCredentials, startLocalSettings, startPlainSettings } from "./llm-official.ts";
import { compileManagedRouteId, LLM_ERROR, type LlmSharedSnapshot } from "../../src/core/domain/llm-connections.ts";
import { snapshotCredentialRef } from "../../src/core/domain/llm-resolution.ts";

type WorkerConfig = {
  spaceId: string;
  settingsPath: string;
  credentialsPath: string;
  home: string;
  snapshot: LlmSharedSnapshot | null;
  sharedCredentialsPath: string | null;
};

const THEME_SCHEMA = z.object({ color: z.string().default("gray") });

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "{}") as WorkerConfig;
  const settings = config.snapshot
    ? await startLocalSettings(config.settingsPath, config.home, config.snapshot)
    : await startPlainSettings(config.settingsPath, config.home);
  settings.settings.register("spaces-theme", THEME_SCHEMA);
  settings.settings.register("llm-pi-ai", LlmPiAiConfig, { base: { providers: {} } });
  settings.settings.register("agent-default-model", AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, {
    base: { provider: "xai-oauth", model: "grok-4.5" },
  });

  const sharedLookup = config.sharedCredentialsPath
    ? await sharedLookupFromFile(config.sharedCredentialsPath, config.home)
    : { describe: async () => ({ configured: false }), readSecret: async () => undefined };
  const localCredentials = await startLocalCredentials(config.credentialsPath, config.home);
  const credentials = config.snapshot
    ? new SpacesCredentialsProvider(settings.ctx, localCredentials.credentials, sharedLookup, config.snapshot)
    : localCredentials.credentials;
  if (config.snapshot) {
    await attachOfficialLlm(settings.ctx, settings.settings as SpacesFileSettingsProvider);
  }

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    try {
      const result = await dispatch(body, {
        spaceId: config.spaceId,
        settings: settings.settings,
        credentials,
        snapshot: config.snapshot,
        settingsPath: config.settingsPath,
        credentialsPath: config.credentialsPath,
        llm: (settings.ctx as { llm?: { stream(options: object): AsyncIterable<StreamChunk> } }).llm,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      const err = error as { code?: string; message?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: err.code ?? "ERROR", message: err.message ?? String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("worker port missing");
  process.stdout.write(`LISTENING ${address.port}\n`);
}

async function sharedLookupFromFile(path: string, home: string) {
  const store = await startLocalCredentials(path, home);
  return {
    async describe(recordId: string) {
      const record = await store.credentials.readRecord(recordId as never);
      return { configured: Boolean(record && record.kind === "api-key" && record.key) };
    },
    async readSecret(recordId: string) {
      const record = await store.credentials.readRecord(recordId as never);
      return record && record.kind === "api-key" ? record.key : undefined;
    },
  };
}

async function dispatch(
  body: { op?: string; color?: string; provider?: string; model?: string; ref?: string; value?: string },
  ctx: {
    spaceId: string;
    settings: {
      get(ns: string): unknown;
      update(ns: string, patch: object): Promise<void>;
      describe(): { ns: string; value: unknown; user?: unknown; base?: unknown }[];
      documentPath: string | undefined;
      bridgeStatus?: () => unknown;
    };
    credentials: SpacesCredentialsProvider | { set(ref: never, value: string): Promise<void>; describe(ref: never): Promise<unknown>; resolve(ref: never): Promise<unknown> };
    snapshot: LlmSharedSnapshot | null;
    settingsPath: string;
    credentialsPath: string;
    llm?: { stream(options: object): AsyncIterable<StreamChunk> };
  },
) {
  switch (body.op) {
    case "status":
      return {
        spaceId: ctx.spaceId,
        documentPath: ctx.settings.documentPath,
        theme: ctx.settings.get("spaces-theme"),
        llm: ctx.settings.get("llm-pi-ai"),
        defaultModel: ctx.settings.get("agent-default-model"),
        describe: ctx.settings.describe(),
        bridge: typeof ctx.settings.bridgeStatus === "function" ? ctx.settings.bridgeStatus() : null,
      };
    case "update-theme":
      await ctx.settings.update("spaces-theme", { color: body.color });
      return { theme: ctx.settings.get("spaces-theme") };
    case "update-default-model":
      await ctx.settings.update("agent-default-model", { provider: body.provider, model: body.model });
      return { defaultModel: ctx.settings.get("agent-default-model") };
    case "try-update-managed": {
      const routeId = compileManagedRouteId(ctx.snapshot?.connections[0]?.id ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      await ctx.settings.update("llm-pi-ai", {
        providers: { [routeId]: { baseURL: "http://127.0.0.1:1/forged" } },
      });
      return { llm: ctx.settings.get("llm-pi-ai") };
    }
    case "describe-managed-credential": {
      const ref = snapshotCredentialRef(ctx.snapshot!.connections[0]);
      return ctx.credentials.describe(credentialRef(ref!));
    }
    case "resolve-managed-credential": {
      const ref = snapshotCredentialRef(ctx.snapshot!.connections[0]);
      return ctx.credentials.resolve(credentialRef(ref!));
    }
    case "set-local-credential":
      await ctx.credentials.set(credentialRef(body.ref ?? "LOCAL_SPACE_KEY"), body.value ?? "local-secret");
      return ctx.credentials.describe(credentialRef(body.ref ?? "LOCAL_SPACE_KEY"));
    case "try-set-managed-credential": {
      const ref = snapshotCredentialRef(ctx.snapshot!.connections[0]);
      await ctx.credentials.set(credentialRef(ref!), "should-fail");
      return { ok: true };
    }
    case "files":
      return {
        settings: existsSync(ctx.settingsPath) ? readFileSync(ctx.settingsPath, "utf8") : "",
        credentials: existsSync(ctx.credentialsPath) ? readFileSync(ctx.credentialsPath, "utf8") : "",
      };
    case "stream": {
      if (!ctx.llm) {
        throw Object.assign(new Error("The official adapter is not available in this space."), {
          code: LLM_ERROR.ADAPTER_MISSING,
        });
      }
      let text = "";
      for await (const chunk of ctx.llm.stream({
        provider: body.provider,
        model: body.model,
        messages: [
          createUserMessage({
            content: [{ type: "text", text: "ping" }],
            source: { kind: "user" },
          }),
        ],
      })) {
        if (chunk.type === "text-delta") text += chunk.text;
        if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
          const failure = chunk.reason.failure;
          throw Object.assign(new Error(failure.message), { code: failure.code, status: failure.status });
        }
      }
      return { text };
    }
    default:
      throw new Error(`unknown op ${body.op}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
  });
}
