import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FileLlmCatalogStore, assertCatalogPathInsideHome, llmCatalogPath } from "../src/adapters/node/llm-catalog-store.ts";
import { FileLlmCredentialStore } from "../src/adapters/node/llm-credential-store.ts";
import { FileLlmPolicyStore, llmPolicyPath } from "../src/adapters/node/llm-policy-store.ts";
import { llmCredentialsPath } from "../src/adapters/node/llm-paths.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import {
  LLM_ERROR,
  LlmConfigError,
  compileManagedRecordKey,
  compileManagedRouteId,
  createConnectionId,
  defaultPolicyFor,
  emptyCatalog,
  emptyPolicy,
  nextCredentialRecordId,
  parseCatalog,
  type GlobalLlmCatalog,
  type SharedConnection,
  type SpaceLlmPolicy,
} from "../src/core/domain/llm-connections.ts";
import type { LlmCatalogStore, LlmCredentialStore, LlmPolicyStore } from "../src/core/ports/llm-store.ts";

const temps: string[] = [];
const SECRET = "sk-test-shared-once-not-for-spaces";

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-llm-catalog-"));
  temps.push(dir);
  return dir;
}

function connection(overrides: Record<string, unknown> = {}): SharedConnection {
  const id = typeof overrides.id === "string" ? overrides.id : createConnectionId();
  return {
    id,
    revision: 1,
    displayName: "主力接口",
    enabled: true,
    backend: "llm-pi-ai",
    providerConfig: {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "demo-large" }, { id: "demo-small" }],
    },
    auth: { kind: "api-key", credentialRecordId: compileManagedRecordKey(id, 1) },
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  } as SharedConnection;
}

function catalogWith(items: SharedConnection[], revision: number, extra: Partial<GlobalLlmCatalog> = {}): GlobalLlmCatalog {
  const connections = Object.fromEntries(items.map((item) => [item.id, item]));
  return parseCatalog({
    schemaVersion: 1,
    revision,
    connections,
    defaultModel: extra.defaultModel ?? null,
    retiredConnectionIds: extra.retiredConnectionIds ?? [],
  });
}

class MemoryCatalogStore implements LlmCatalogStore {
  constructor(private catalog: GlobalLlmCatalog = emptyCatalog()) {}
  async read(): Promise<GlobalLlmCatalog> {
    return this.catalog;
  }
  async write(next: GlobalLlmCatalog, expectedRevision: number): Promise<GlobalLlmCatalog> {
    if (this.catalog.revision !== expectedRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "catalog revision moved");
    }
    this.catalog = parseCatalog(next);
    return this.catalog;
  }
}

class MemoryPolicyStore implements LlmPolicyStore {
  private readonly files = new Map<string, SpaceLlmPolicy>();
  async read(spaceId: string): Promise<SpaceLlmPolicy> {
    return this.files.get(spaceId) ?? defaultPolicyFor(spaceId);
  }
  async write(spaceId: string, next: SpaceLlmPolicy, expectedRevision: number): Promise<SpaceLlmPolicy> {
    const current = await this.read(spaceId);
    if (current.revision !== expectedRevision) {
      throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "policy revision moved");
    }
    this.files.set(spaceId, next);
    return next;
  }
}

class MemoryCredentialStore implements LlmCredentialStore {
  readonly records = new Map<string, string>();
  async writeRecord(input: { recordId: string; secret: string }) {
    if (this.records.has(input.recordId)) {
      throw new LlmConfigError(LLM_ERROR.CONFIG_INVALID, "credential records are immutable");
    }
    this.records.set(input.recordId, input.secret);
    return this.describe(input.recordId);
  }
  async readSecret(recordId: string) {
    return this.records.get(recordId);
  }
  async describe(recordId: string) {
    const configured = this.records.has(recordId);
    return { recordId, configured, writable: !configured, source: "spaces-global" as const };
  }
}

class FailWriteCatalogStore implements LlmCatalogStore {
  constructor(private readonly inner: LlmCatalogStore) {}
  read() {
    return this.inner.read();
  }
  async write(): Promise<GlobalLlmCatalog> {
    throw new LlmConfigError(LLM_ERROR.REVISION_CONFLICT, "injected catalog failure");
  }
}

function memoryService(spaceIds = ["web", "alpha", "beta"]) {
  const catalog = new MemoryCatalogStore();
  const policies = new MemoryPolicyStore();
  const credentials = new MemoryCredentialStore();
  const service = new GlobalLlmService(catalog, policies, credentials, async () => spaceIds);
  return { service, catalog, policies, credentials };
}

function fileService(home: string, spaceIds = ["web", "alpha", "beta"]) {
  const catalog = new FileLlmCatalogStore(home);
  const policies = new FileLlmPolicyStore(home);
  const credentials = new FileLlmCredentialStore(home);
  const service = new GlobalLlmService(catalog, policies, credentials, async () => spaceIds);
  return { service, catalog, policies, credentials };
}

test("file catalog and policy stay in one original location and refuse unknown schema", async () => {
  const home = tempHome();
  const catalogStore = new FileLlmCatalogStore(home);
  const policyStore = new FileLlmPolicyStore(home);
  const first = connection({ displayName: "主力接口" });
  const second = connection({ displayName: "主力接口" });
  await catalogStore.write(catalogWith([first], 1), 0);
  await catalogStore.write(catalogWith([first, second], 2), 1);
  await policyStore.write("alpha", { schemaVersion: 1, revision: 1, shared: { mode: "all" } }, 0);
  await policyStore.write("web", { schemaVersion: 1, revision: 1, shared: { mode: "none" } }, 0);

  const loaded = await catalogStore.read();
  assert.equal(Object.keys(loaded.connections).length, 2);
  assert.notEqual(compileManagedRouteId(first.id), compileManagedRouteId(second.id));
  assert.equal(existsSync(llmCatalogPath(home)), true);
  assert.equal(existsSync(join(home, "hub", "alpha", "providers.json")), false);
  assert.equal(existsSync(llmPolicyPath(home, "alpha")), true);
  assert.equal(existsSync(llmPolicyPath(home, "web")), true);
  assert.equal(existsSync(join(home, "profiles", "web", "llm-policy.json")), false);
  assert.deepEqual(await policyStore.read("beta"), emptyPolicy());

  writeFileSync(
    llmCatalogPath(home),
    JSON.stringify({ schemaVersion: 2, revision: 3, connections: {}, defaultModel: null, retiredConnectionIds: [] }),
  );
  await assert.rejects(() => catalogStore.read(), { code: LLM_ERROR.UNSUPPORTED_RUNTIME });
  assert.throws(() => assertCatalogPathInsideHome(home, join(home, "hub", "alpha", "catalog.json")), {
    code: LLM_ERROR.CONFIG_INVALID,
  });
});

test("stale catalog revision is refused and does not replace the committed file", async () => {
  const home = tempHome();
  const store = new FileLlmCatalogStore(home);
  const live = connection();
  const other = connection();
  await store.write(catalogWith([live], 1), 0);
  await assert.rejects(() => store.write(catalogWith([other], 1), 0), { code: LLM_ERROR.REVISION_CONFLICT });
  const kept = await store.read();
  assert.equal(kept.revision, 1);
  assert.equal(kept.connections[live.id]?.id, live.id);
  assert.equal(kept.connections[other.id], undefined);
});

test("two catalog writers with the same revision keep exactly one commit", async () => {
  const home = tempHome();
  const left = new FileLlmCatalogStore(home);
  const right = new FileLlmCatalogStore(home);
  const a = connection();
  const b = connection();
  const results = await Promise.allSettled([
    left.write(catalogWith([a], 1), 0),
    right.write(catalogWith([b], 1), 0),
  ]);
  const ok = results.filter((item) => item.status === "fulfilled");
  const failed = results.filter((item) => item.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as PromiseRejectedResult).reason.code, LLM_ERROR.REVISION_CONFLICT);
  const final = await left.read();
  assert.equal(final.revision, 1);
  assert.equal(Object.keys(final.connections).length, 1);
});

test("global service publishes one connection original and never copies the secret into catalog or space files", async () => {
  const home = tempHome();
  const { service } = fileService(home);
  const saved = await service.saveConnectionWithCredential(
    {
      displayName: "主力接口",
      providerConfig: {
        api: "openai-completions",
        baseURL: "http://127.0.0.1:9/v1",
        models: [{ id: "demo-large" }, { id: "demo-small" }],
      },
    },
    SECRET,
    0,
  );
  assert.equal(saved.revision, 1);
  const [connectionId] = Object.keys(saved.connections);
  await service.updateSpacePolicy("alpha", { mode: "all" }, 0);
  await service.updateSpacePolicy("beta", { mode: "selected", connectionIds: [connectionId] }, 0);
  await service.setDefault({ connectionId, modelId: "demo-large" }, 1);

  const described = await service.describe();
  assert.equal(described.connections[0].auth.kind, "api-key");
  assert.equal("credentialRecordId" in described.connections[0].auth, false);
  assert.doesNotMatch(JSON.stringify(described), new RegExp(SECRET));

  const catalogText = readFileSync(llmCatalogPath(home), "utf8");
  const credentialText = readFileSync(llmCredentialsPath(home), "utf8");
  assert.doesNotMatch(catalogText, new RegExp(SECRET));
  assert.match(catalogText, /spaces-llm\/conn-/);
  assert.match(credentialText, new RegExp(SECRET));
  assert.equal(existsSync(join(home, "hub", "alpha", "settings.yaml")), false);
  assert.equal(existsSync(join(home, "hub", "alpha", "providers.json")), false);
  assert.doesNotMatch(readFileSync(llmPolicyPath(home, "alpha"), "utf8"), new RegExp(SECRET));
  assert.equal(JSON.parse(readFileSync(llmPolicyPath(home, "beta"), "utf8")).shared.mode, "selected");
});

test("mode all is a live reference and blocks delete even for a later connection", async () => {
  const { service } = memoryService();
  await service.updateSpacePolicy("alpha", { mode: "all" }, 0);
  const first = await service.saveConnection(
    {
      displayName: "one",
      providerConfig: { api: "openai-completions", models: [{ id: "demo-large" }] },
      auth: { kind: "none" },
    },
    0,
  );
  const firstId = Object.keys(first.connections)[0];
  const preview = await service.previewChange(
    {
      displayName: "two",
      providerConfig: { api: "openai-completions", models: [{ id: "demo-small" }] },
      auth: { kind: "none" },
    },
    1,
  );
  assert.deepEqual(preview.affectedSpaceIds, ["alpha", "beta"]);
  await assert.rejects(() => service.deleteConnection(firstId, 1), { code: LLM_ERROR.CONNECTION_IN_USE });
  await service.updateSpacePolicy("alpha", { mode: "none" }, 1);
  await assert.rejects(() => service.deleteConnection(firstId, 1), { code: LLM_ERROR.CONNECTION_IN_USE });
  await service.updateSpacePolicy("beta", { mode: "none" }, 0);
  const deleted = await service.deleteConnection(firstId, 1);
  assert.equal(deleted.connections[firstId], undefined);
  assert.deepEqual(deleted.retiredConnectionIds, [firstId]);
  await assert.rejects(
    () =>
      service.saveConnection(
        {
          id: firstId,
          displayName: "reused",
          providerConfig: { api: "openai-completions", models: [{ id: "demo-large" }] },
          auth: { kind: "none" },
        },
        2,
      ),
    { code: LLM_ERROR.CONFIG_INVALID },
  );
});

test("selected policy still blocks delete of a disabled connection", async () => {
  const { service } = memoryService();
  const saved = await service.saveConnection(
    {
      displayName: "paused",
      enabled: false,
      providerConfig: { api: "openai-completions", models: [{ id: "demo-large" }] },
      auth: { kind: "none" },
    },
    0,
  );
  const id = Object.keys(saved.connections)[0];
  await service.updateSpacePolicy("beta", { mode: "selected", connectionIds: [id] }, 0);
  const preview = await service.previewDelete(id);
  assert.equal(preview.references.find((row) => row.spaceId === "beta")?.mode, "selected");
  await assert.rejects(() => service.deleteConnection(id, 1), { code: LLM_ERROR.CONNECTION_IN_USE });
});

test("saveConnection rejects secrets and missing records; with-credential leftover is reported", async () => {
  const credentials = new MemoryCredentialStore();
  const catalog = new MemoryCatalogStore();
  const failing = new FailWriteCatalogStore(catalog);
  const policies = new MemoryPolicyStore();
  const service = new GlobalLlmService(failing, policies, credentials, async () => ["web", "alpha"]);
  await assert.rejects(
    () =>
      service.saveConnection(
        {
          displayName: "leaky",
          providerConfig: { api: "openai-completions", models: [{ id: "demo-large" }] },
          auth: { kind: "none" },
          key: SECRET,
        } as never,
        0,
      ),
    { code: LLM_ERROR.CONFIG_INVALID },
  );
  await assert.rejects(
    () =>
      service.saveConnection(
        {
          displayName: "missing-key",
          providerConfig: { api: "openai-completions", models: [{ id: "demo-large" }] },
          auth: { kind: "api-key", credentialRecordId: compileManagedRecordKey(createConnectionId(), 1) },
        },
        0,
      ),
    { code: LLM_ERROR.CREDENTIAL_MISSING },
  );

  await assert.rejects(
    () =>
      service.saveConnectionWithCredential(
        {
          displayName: "orphan",
          providerConfig: { api: "openai-completions", models: [{ id: "demo-large" }] },
        },
        SECRET,
        0,
      ),
    (error: { code?: string; details?: { leftoverRecordId?: string } }) => {
      assert.equal(error.code, LLM_ERROR.REVISION_CONFLICT);
      assert.equal(typeof error.details?.leftoverRecordId, "string");
      assert.equal(credentials.records.has(error.details?.leftoverRecordId ?? ""), true);
      return true;
    },
  );
  assert.deepEqual(await catalog.read(), emptyCatalog());
});

test("explicit global default cannot point at an unbound or missing model", async () => {
  const { service } = memoryService();
  const saved = await service.saveConnection(
    {
      displayName: "only",
      providerConfig: { api: "openai-completions", models: [{ id: "demo-large" }] },
      auth: { kind: "none" },
    },
    0,
  );
  const id = Object.keys(saved.connections)[0];
  await assert.rejects(
    () => service.setDefault({ connectionId: id, modelId: "does-not-exist" }, 1),
    { code: LLM_ERROR.MODEL_NOT_FOUND },
  );
  await service.setDefault({ connectionId: id, modelId: "demo-large" }, 1);
  await assert.rejects(() => service.deleteConnection(id, 2), { code: LLM_ERROR.CONNECTION_IN_USE });
});

test("shared credential records ignore same-named environment values and refuse in-place replace", async () => {
  const home = tempHome();
  const store = new FileLlmCredentialStore(home);
  const connectionId = createConnectionId();
  const recordId = nextCredentialRecordId(connectionId);
  const envName = `SPACES_LLM_${connectionId.replaceAll("-", "").toUpperCase()}_R1_API_KEY`;
  const previous = process.env[envName];
  process.env[envName] = "from-environment";
  try {
    assert.equal(await store.readSecret(recordId), undefined);
    await store.writeRecord({ recordId, secret: SECRET });
    assert.equal(await store.readSecret(recordId), SECRET);
    assert.equal((await store.describe(recordId)).source, "spaces-global");
    assert.equal((await store.describe(recordId)).writable, false);
    await assert.rejects(() => store.writeRecord({ recordId, secret: "sk-rotated" }), {
      code: LLM_ERROR.CONFIG_INVALID,
    });
    assert.equal(await store.readSecret(recordId), SECRET);
    const rotated = nextCredentialRecordId(connectionId, { kind: "api-key", credentialRecordId: recordId });
    await store.writeRecord({ recordId: rotated, secret: "sk-rotated" });
    assert.equal(await store.readSecret(rotated), "sk-rotated");
    assert.equal(await store.readSecret(recordId), SECRET);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test("policy path escape and unknown space updates are refused", async () => {
  const home = tempHome();
  const { service, policies } = fileService(home);
  await assert.rejects(() => policies.read("../web"), { code: LLM_ERROR.CONFIG_INVALID });
  await assert.rejects(() => service.updateSpacePolicy("missing", { mode: "all" }, 0), {
    code: LLM_ERROR.CONFIG_INVALID,
  });
  await assert.rejects(
    () => service.updateSpacePolicy("alpha", { mode: "selected", connectionIds: [createConnectionId()] }, 0),
    { code: LLM_ERROR.MODEL_NOT_FOUND },
  );
});
