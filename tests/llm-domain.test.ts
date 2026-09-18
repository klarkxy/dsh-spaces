import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LLM_ERROR,
  compileManagedCredentialRef,
  compileManagedRecordKey,
  compileManagedRouteId,
  createConnectionId,
  emptyCatalog,
  emptyPolicy,
  isManagedCredentialRef,
  isManagedRouteId,
  parseCatalog,
  parseManagedCredentialRef,
  parseManagedRouteId,
  sanitizeProviderConfig,
} from "../src/core/domain/llm-connections.ts";
import {
  boundConnectionIds,
  compileSharedProviderProfile,
  mergeSharedProvidersIntoBase,
  policyBindsConnection,
  resolveDefaultModel,
  selectSharedConnections,
} from "../src/core/domain/llm-resolution.ts";

function connection(overrides: Record<string, unknown> = {}) {
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
      models: [{ id: "demo-large" }],
    },
    auth: { kind: "api-key", credentialRecordId: compileManagedRecordKey(id, 1) },
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

test("managed route and credential ids are stable and not derived from display names", () => {
  const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.equal(compileManagedRouteId(first), `spaces-llm-${first.replaceAll("-", "")}`);
  assert.equal(compileManagedRouteId(second), `spaces-llm-${second.replaceAll("-", "")}`);
  assert.equal(isManagedRouteId(compileManagedRouteId(first)), true);
  assert.equal(parseManagedRouteId(compileManagedRouteId(first)), first);
  assert.equal(isManagedRouteId("openai"), false);
  const ref = compileManagedCredentialRef(first, 2);
  assert.equal(ref, `SPACES_LLM_${first.replaceAll("-", "").toUpperCase()}_R2_API_KEY`);
  assert.equal(isManagedCredentialRef(ref), true);
  assert.deepEqual(parseManagedCredentialRef(ref), { connectionId: first, credentialRevision: 2 });
  assert.equal(isManagedCredentialRef("DEEPSEEK_API_KEY"), false);
});

test("duplicate display names stay distinct connections", () => {
  const a = connection({ displayName: "主力接口" });
  const b = connection({ displayName: "主力接口" });
  const catalog = emptyCatalog();
  catalog.connections[a.id] = a as never;
  catalog.connections[b.id] = b as never;
  const selected = selectSharedConnections(catalog, { schemaVersion: 1, revision: 1, shared: { mode: "all" } });
  assert.equal(selected.length, 2);
  assert.notEqual(compileManagedRouteId(a.id), compileManagedRouteId(b.id));
});

test("unknown catalog schema is refused instead of treated as empty", () => {
  assert.throws(
    () => parseCatalog({ schemaVersion: 2, revision: 1, connections: {}, defaultModel: null, retiredConnectionIds: [] }),
    { code: LLM_ERROR.UNSUPPORTED_RUNTIME },
  );
});

test("providerConfig cannot smuggle credentials, route ids, or secret URLs", () => {
  assert.throws(() => sanitizeProviderConfig({ apiKeyEnv: "OPENAI_API_KEY" }), { code: LLM_ERROR.CONFIG_INVALID });
  assert.throws(() => sanitizeProviderConfig({ headers: { Authorization: "secret" } }), { code: LLM_ERROR.CONFIG_INVALID });
  assert.throws(() => sanitizeProviderConfig({ api: "mystery-protocol" }), { code: LLM_ERROR.UNSUPPORTED_PROTOCOL });
  assert.throws(() => sanitizeProviderConfig({ baseURL: "https://user:key@example.com" }), { code: LLM_ERROR.CONFIG_INVALID });
});

test("shared provider projection injects the managed credential ref and keeps local routes", () => {
  const shared = connection();
  const merged = mergeSharedProvidersIntoBase(
    { providers: { openai: { apiKeyEnv: "OPENAI_API_KEY" } } },
    [shared as never],
  );
  const providers = merged.providers as Record<string, Record<string, unknown>>;
  assert.deepEqual(providers.openai, { apiKeyEnv: "OPENAI_API_KEY" });
  const route = compileManagedRouteId(shared.id);
  assert.equal(providers[route].apiKeyEnv, compileManagedCredentialRef(shared.id, 1));
  assert.equal(providers[route].baseURL, "http://127.0.0.1:9/v1");
  assert.equal(compileSharedProviderProfile(shared as never).displayName, "主力接口");
});

test("explicit unavailable defaults fail instead of falling through", () => {
    const available = [{ provider: `spaces-llm-${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".replaceAll("-", "")}`, model: "demo-large" }];
  assert.throws(
    () =>
      resolveDefaultModel({
        session: { provider: "local-openai", model: "demo-large" },
        available,
      }),
    { code: LLM_ERROR.MODEL_NOT_FOUND },
  );
  assert.throws(
    () =>
      resolveDefaultModel({
        globalDefault: { connectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", modelId: "demo-large" },
        composition: { provider: "xai-oauth", model: "grok-4.5" },
        available,
      }),
    { code: LLM_ERROR.MODEL_NOT_FOUND },
  );
  const resolved = resolveDefaultModel({
        spaceUser: { provider: `spaces-llm-${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".replaceAll("-", "")}`, model: "demo-large" },
    globalDefault: { connectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", modelId: "other" },
    available,
  });
  assert.equal(resolved.source, "space");
  assert.equal(resolved.model, "demo-large");
});

test("mode none keeps the space off the shared catalog", () => {
  const catalog = emptyCatalog();
  const shared = connection();
  catalog.connections[shared.id] = shared as never;
  assert.deepEqual(selectSharedConnections(catalog, emptyPolicy()), []);
});

test("mode all binds every current connection including disabled ones", () => {
  const catalog = emptyCatalog();
  const live = connection();
  const stopped = connection({ enabled: false });
  catalog.connections[live.id] = live as never;
  catalog.connections[stopped.id] = stopped as never;
  const policy = { schemaVersion: 1, revision: 1, shared: { mode: "all" as const } };
  assert.equal(policyBindsConnection(policy, live.id), true);
  assert.equal(policyBindsConnection(policy, stopped.id), true);
  assert.deepEqual(selectSharedConnections(catalog, policy).map((item) => item.id), [live.id]);
  assert.deepEqual(new Set(boundConnectionIds(catalog, policy)), new Set([live.id, stopped.id]));
});

test("mode selected still binds a disabled connection by id", () => {
  const catalog = emptyCatalog();
  const stopped = connection({ enabled: false });
  catalog.connections[stopped.id] = stopped as never;
  const policy = {
    schemaVersion: 1,
    revision: 1,
    shared: { mode: "selected" as const, connectionIds: [stopped.id] },
  };
  assert.equal(policyBindsConnection(policy, stopped.id), true);
  assert.deepEqual(selectSharedConnections(catalog, policy), []);
  assert.deepEqual(boundConnectionIds(catalog, policy), [stopped.id]);
});
