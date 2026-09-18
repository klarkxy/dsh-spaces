import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import z from "@deepseek-ai/schemastery";
import { Config as LlmPiAiConfig } from "@deepseek-ai/dsh-llm-pi-ai";
import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  LLM_ERROR,
  compileManagedCredentialRef,
  compileManagedRecordKey,
  compileManagedRouteId,
  createConnectionId,
} from "../src/core/domain/llm-connections.ts";
import { startBridgedCredentials, startLocalCredentials, startLocalSettings, startPlainSettings } from "./helpers/llm-official.ts";

const temps: string[] = [];
const THEME = z.object({ color: z.string().default("gray") });

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-llm-bridge-"));
  temps.push(dir);
  return dir;
}

function sharedConnection(secretRecord = true) {
  const id = createConnectionId();
  return {
    id,
    revision: 3,
    displayName: "shared-mock",
    enabled: true,
    backend: "llm-pi-ai" as const,
    providerConfig: {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "demo-large" }],
    },
    auth: secretRecord
      ? { kind: "api-key" as const, credentialRecordId: compileManagedRecordKey(id, 1) }
      : { kind: "none" as const },
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

test("independent settings files do not copy shared routes or keys into the user document", async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const snapshot = {
    catalogRevision: 4,
    policyRevision: 1,
    connections: [connection],
    defaultModel: { connectionId: connection.id, modelId: "demo-large" },
    adapterVersion: "0.1.5-rc.2",
  };
  const a = await startLocalSettings(join(root, "a.yaml"), join(root, "a"), snapshot);
  const b = await startLocalSettings(join(root, "b.yaml"), join(root, "b"), snapshot);
  a.settings.register("spaces-theme", THEME);
  b.settings.register("spaces-theme", THEME);
  a.settings.register("llm-pi-ai", LlmPiAiConfig, { base: { providers: {} } });
  b.settings.register("llm-pi-ai", LlmPiAiConfig, { base: { providers: {} } });
  await a.settings.update("spaces-theme", { color: "red" });
  await b.settings.update("spaces-theme", { color: "blue" });
  assert.equal((a.settings.get("spaces-theme") as { color: string }).color, "red");
  assert.equal((b.settings.get("spaces-theme") as { color: string }).color, "blue");
  const route = compileManagedRouteId(connection.id);
  const aLlm = a.settings.get("llm-pi-ai") as { providers: Record<string, { baseURL?: string; apiKeyEnv?: string }> };
  const bLlm = b.settings.get("llm-pi-ai") as { providers: Record<string, { baseURL?: string; apiKeyEnv?: string }> };
  assert.equal(aLlm.providers[route].baseURL, "http://127.0.0.1:9/v1");
  assert.equal(bLlm.providers[route].baseURL, "http://127.0.0.1:9/v1");
  assert.equal(aLlm.providers[route].apiKeyEnv, compileManagedCredentialRef(connection.id, 1));
  const aFile = readFileSync(join(root, "a.yaml"), "utf8");
  const bFile = readFileSync(join(root, "b.yaml"), "utf8");
  assert.match(aFile, /color: red/);
  assert.match(bFile, /color: blue/);
  assert.doesNotMatch(aFile, /spaces-llm-/);
  assert.doesNotMatch(bFile, /spaces-llm-/);
  assert.doesNotMatch(aFile, /sk-|apiKeyEnv|127\.0\.0\.1:9/);
  assert.doesNotMatch(bFile, /sk-|apiKeyEnv|127\.0\.0\.1:9/);
});

test("web without a snapshot keeps the home settings file and no shared route", async () => {
  const root = tempDir();
  const web = await startPlainSettings(join(root, "settings.yaml"), root);
  web.settings.register("spaces-theme", THEME);
  web.settings.register("llm-pi-ai", LlmPiAiConfig, { base: { providers: {} } });
  await web.settings.update("spaces-theme", { color: "web-only" });
  const llm = web.settings.get("llm-pi-ai") as { providers?: Record<string, unknown> };
  assert.equal(Object.keys(llm.providers ?? {}).some((key) => key.startsWith("spaces-llm-")), false);
  assert.match(readFileSync(join(root, "settings.yaml"), "utf8"), /web-only/);
});

test("official settings writes to a managed route are rejected", async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const space = await startLocalSettings(join(root, "settings.yaml"), root, {
    catalogRevision: 1,
    policyRevision: 1,
    connections: [connection],
    defaultModel: null,
    adapterVersion: "0.1.5-rc.2",
  });
  space.settings.register("llm-pi-ai", LlmPiAiConfig, { base: { providers: {} } });
  const route = compileManagedRouteId(connection.id);
  await assert.rejects(
    async () =>
      space.settings.update("llm-pi-ai", { providers: { [route]: { baseURL: "http://127.0.0.1:1/forged" } } }),
    { code: LLM_ERROR.SHARED_CONNECTION_READ_ONLY },
  );
  const llm = space.settings.get("llm-pi-ai") as { providers: Record<string, { baseURL?: string }> };
  assert.equal(llm.providers[route].baseURL, "http://127.0.0.1:9/v1");
});

test("forged managed routes in the user file do not become the resolved endpoint", async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const route = compileManagedRouteId(connection.id);
  writeFileSync(
    join(root, "settings.yaml"),
    `llm-pi-ai:\n  providers:\n    ${route}:\n      baseURL: http://127.0.0.1:1/forged\n`,
  );
  const space = await startLocalSettings(join(root, "settings.yaml"), root, {
    catalogRevision: 1,
    policyRevision: 1,
    connections: [connection],
    defaultModel: null,
    adapterVersion: "0.1.5-rc.2",
  });
  space.settings.register("llm-pi-ai", LlmPiAiConfig, { base: { providers: {} } });
  const llm = space.settings.get("llm-pi-ai") as { providers: Record<string, { baseURL?: string }> };
  assert.equal(llm.providers[route].baseURL, "http://127.0.0.1:9/v1");
  assert.equal(space.settings.bridgeStatus().managedRouteConflict, true);
});

test("shared credential resolve uses the record and ignores a same-name environment variable", async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const ref = compileManagedCredentialRef(connection.id, 1);
  const recordId = compileManagedRecordKey(connection.id, 1);
  const parsed = recordId.split("/");
  const global = await startLocalCredentials(join(root, "global.yaml"), root);
  await global.credentials.modifyRecord(credentialKey(parsed[0], parsed[1]), async () => ({
    kind: "api-key",
    key: "sk-shared-record",
  }));
  process.env[ref] = "sk-from-env";
  try {
    const bridged = await startBridgedCredentials({
      localPath: join(root, "local.yaml"),
      localHome: join(root, "local"),
      snapshot: {
        catalogRevision: 1,
        policyRevision: 1,
        connections: [connection],
        defaultModel: null,
        adapterVersion: "0.1.5-rc.2",
      },
      shared: {
        describe: async (id) => {
          const record = await global.credentials.readRecord(id as never);
          return { configured: Boolean(record && record.kind === "api-key" && record.key) };
        },
        readSecret: async (id) => {
          const record = await global.credentials.readRecord(id as never);
          return record && record.kind === "api-key" ? record.key : undefined;
        },
      },
    });
    const resolved = await bridged.credentials.resolve(credentialRef(ref));
    assert.deepEqual(resolved, { value: "sk-shared-record", source: "spaces-global" });
    const described = await bridged.credentials.describe(credentialRef(ref));
    assert.equal(described.writable, false);
    assert.equal(described.source, "spaces-global");
    await assert.rejects(() => bridged.credentials.set(credentialRef(ref), "nope"), {
      code: LLM_ERROR.SHARED_CONNECTION_READ_ONLY,
    });
    if (existsSync(join(root, "local.yaml"))) {
      assert.doesNotMatch(readFileSync(join(root, "local.yaml"), "utf8"), /sk-shared-record|sk-from-env/);
    }
  } finally {
    delete process.env[ref];
  }
});
