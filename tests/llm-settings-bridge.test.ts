import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  LLM_ERROR,
  compileManagedCredentialRef,
  compileManagedRecordKey,
  compileManagedRouteId,
  createConnectionId,
} from "../src/core/domain/llm-connections.ts";
import {
  openSpaceLlmBridge,
  startBridgedCredentials,
  startLocalCredentials,
  startPlainSettings,
  type OpenedNativeSpace,
} from "./helpers/llm-official.ts";

const temps: string[] = [];
const opened: OpenedNativeSpace[] = [];
const PINNED = "0.1.7-alpha.1";

afterEach(async () => {
  for (const space of opened.splice(0)) await space.dispose();
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

test("independent profile patches do not copy shared routes or keys into the user document", { timeout: 60_000 }, async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const snapshot = {
    catalogRevision: 4,
    policyRevision: 1,
    connections: [connection],
    defaultModel: { connectionId: connection.id, modelId: "demo-large" },
    adapterVersion: PINNED,
  };
  const a = await openSpaceLlmBridge({ dshHome: join(root, "a"), snapshot, spaceId: "alpha" });
  const b = await openSpaceLlmBridge({ dshHome: join(root, "b"), snapshot, spaceId: "beta" });
  opened.push(a, b);
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
  const aFile = readFileSync(a.patchPath, "utf8");
  const bFile = readFileSync(b.patchPath, "utf8");
  assert.match(aFile, /color: red/);
  assert.match(bFile, /color: blue/);
  assert.doesNotMatch(aFile, /spaces-llm-[0-9a-f]{32}/);
  assert.doesNotMatch(bFile, /spaces-llm-[0-9a-f]{32}/);
  assert.doesNotMatch(aFile, /sk-|apiKeyEnv|127\.0\.0\.1:9/);
  assert.doesNotMatch(bFile, /sk-|apiKeyEnv|127\.0\.0\.1:9/);
});

test("unjoined composition keeps a local patch and no shared route", { timeout: 60_000 }, async () => {
  const root = tempDir();
  const space = await startPlainSettings(join(root, "unused.yaml"), root);
  opened.push(space);
  await space.settings.update("spaces-theme", { color: "web-only" });
  const llm = space.settings.get("llm-pi-ai") as { providers?: Record<string, unknown> };
  assert.equal(Object.keys(llm.providers ?? {}).some((key) => key.startsWith("spaces-llm-")), false);
  assert.match(readFileSync(space.patchPath, "utf8"), /web-only/);
});

test("native SettingsForms CAS uses describe revision after shared merge", { timeout: 60_000 }, async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const route = compileManagedRouteId(connection.id);
  const space = await openSpaceLlmBridge({
    dshHome: root,
    snapshot: {
      catalogRevision: 1,
      policyRevision: 1,
      connections: [connection],
      defaultModel: null,
      adapterVersion: PINNED,
    },
    spaceId: "cas",
  });
  opened.push(space);
  const described = space.settings.describe().find((row) => row.ns === "llm-pi-ai");
  assert.ok(described);
  const value = described.value as { providers?: Record<string, { baseURL?: string }> };
  const user = described.user as { providers?: Record<string, unknown> };
  const base = described.base as { providers?: Record<string, unknown> };
  assert.equal(value.providers?.[route]?.baseURL, "http://127.0.0.1:9/v1");
  assert.equal(user?.providers?.[route], undefined);
  assert.equal(base?.providers?.[route], undefined);
  await space.settings.update(
    "llm-pi-ai",
    {
      providers: {
        "local-openai": {
          api: "openai-completions",
          baseURL: "http://127.0.0.1:8/v1",
          models: [{ id: "demo-large" }],
        },
      },
    },
    described.revision,
  );
  const again = space.settings.describe().find((row) => row.ns === "llm-pi-ai");
  const againValue = again?.value as { providers?: Record<string, { baseURL?: string }> };
  const againUser = again?.user as { providers?: Record<string, { baseURL?: string }> };
  assert.equal(againUser?.providers?.["local-openai"]?.baseURL, "http://127.0.0.1:8/v1");
  assert.equal(againValue?.providers?.[route]?.baseURL, "http://127.0.0.1:9/v1");
  assert.equal(againUser?.providers?.[route], undefined);
  assert.doesNotMatch(readFileSync(space.patchPath, "utf8"), /spaces-llm-[0-9a-f]{32}/);
});

test("official settings writes to a managed route are rejected", { timeout: 60_000 }, async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const space = await openSpaceLlmBridge({
    dshHome: root,
    snapshot: {
      catalogRevision: 1,
      policyRevision: 1,
      connections: [connection],
      defaultModel: null,
      adapterVersion: PINNED,
    },
  });
  opened.push(space);
  const route = compileManagedRouteId(connection.id);
  await assert.rejects(
    async () =>
      space.settings.update("llm-pi-ai", { providers: { [route]: { baseURL: "http://127.0.0.1:1/forged" } } }),
    { code: LLM_ERROR.SHARED_CONNECTION_READ_ONLY },
  );
  const llm = space.settings.get("llm-pi-ai") as { providers: Record<string, { baseURL?: string }> };
  assert.equal(llm.providers[route].baseURL, "http://127.0.0.1:9/v1");
});

test("forged managed routes in the profile override do not become the resolved endpoint", { timeout: 60_000 }, async () => {
  const root = tempDir();
  const connection = sharedConnection();
  const route = compileManagedRouteId(connection.id);
  const space = await openSpaceLlmBridge({
    dshHome: root,
    snapshot: {
      catalogRevision: 1,
      policyRevision: 1,
      connections: [connection],
      defaultModel: null,
      adapterVersion: PINNED,
    },
    forgedManagedProviders: {
      [route]: { api: "openai-completions", baseURL: "http://127.0.0.1:1/forged" },
    },
  });
  opened.push(space);
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
        adapterVersion: PINNED,
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
