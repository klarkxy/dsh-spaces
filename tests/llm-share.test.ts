import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  compileManagedRecordKey,
  createConnectionId,
  emptyCatalog,
  emptyPolicy,
  LLM_ERROR,
} from "../src/core/domain/llm-connections.ts";
import {
  applyLlmShareMapping,
  assertShareSecretFree,
  buildLlmShareManifest,
  LLM_SHARE_FILENAME,
  parseLlmShareManifest,
  scanShareEntries,
} from "../src/core/domain/llm-share.ts";
import { FileLlmCatalogStore } from "../src/adapters/node/llm-catalog-store.ts";
import { FileLlmPolicyStore } from "../src/adapters/node/llm-policy-store.ts";
import {
  buildSpaceShare,
  exportSpaceArchive,
  importSpaceArchive,
  packSpaceShare,
  parseSpaceShare,
} from "../src/main/space-share.ts";
import { packZip } from "../src/main/space-share-zip.ts";
import type { InstalledPlugin } from "../src/shared/types.ts";

const temps: string[] = [];
const SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-llm-share-"));
  temps.push(dir);
  return dir;
}

function connection(id = SOURCE_ID) {
  return {
    id,
    revision: 1,
    displayName: "共享接口",
    enabled: true,
    backend: "llm-pi-ai" as const,
    providerConfig: {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "demo-large" }],
    },
    auth: { kind: "api-key" as const, credentialRecordId: compileManagedRecordKey(id, 1) },
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

function catalogWith(id = SOURCE_ID) {
  const catalog = emptyCatalog();
  catalog.revision = 1;
  catalog.connections[id] = connection(id);
  catalog.defaultModel = { connectionId: id, modelId: "demo-large" };
  return catalog;
}

test("share requirements use new ids and never carry secrets or source connection ids as refs", () => {
  const manifest = buildLlmShareManifest({
    catalog: catalogWith(),
    policy: { schemaVersion: 1, revision: 1, shared: { mode: "all" } },
    createId: () => "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(manifest.kind, "dsh-space-llm-requirements");
  assert.equal(manifest.requirements.length, 1);
  assert.equal(manifest.requirements[0].requirementId, "11111111-1111-4111-8111-111111111111");
  assert.notEqual(manifest.requirements[0].requirementId, SOURCE_ID);
  assert.equal(manifest.requirements[0].endpoint, "http://127.0.0.1:9/v1");
  const packed = JSON.stringify(manifest);
  assert.doesNotMatch(packed, /sk-/);
  assert.doesNotMatch(packed, /SPACES_LLM_/);
  assert.doesNotMatch(packed, /spaces-llm\/conn-/);
  assert.doesNotMatch(packed, /credentialRecordId/);
});

test("unknown share schema is refused instead of imported as empty", () => {
  assert.throws(
    () =>
      parseLlmShareManifest({
        schemaVersion: 2,
        kind: "dsh-space-llm-requirements",
        sourceSharedMode: "none",
        requirements: [],
        defaultRequirementId: null,
        adapterRequired: "llm-pi-ai",
        note: "x",
      }),
    { code: LLM_ERROR.UNSUPPORTED_RUNTIME },
  );
});

test("mapping requires a connection that exists on the receiving Home", () => {
  const manifest = buildLlmShareManifest({
    catalog: catalogWith(),
    policy: { schemaVersion: 1, revision: 1, shared: { mode: "selected", connectionIds: [SOURCE_ID] } },
    createId: () => "11111111-1111-4111-8111-111111111111",
  });
  const receiver = catalogWith(LOCAL_ID);
  assert.throws(
    () =>
      applyLlmShareMapping({
        manifest,
        mappings: [{ requirementId: manifest.requirements[0].requirementId, connectionId: SOURCE_ID }],
        catalog: receiver,
      }),
    { code: LLM_ERROR.MODEL_NOT_FOUND },
  );
  const applied = applyLlmShareMapping({
    manifest,
    mappings: [{ requirementId: manifest.requirements[0].requirementId, connectionId: LOCAL_ID }],
    catalog: receiver,
  });
  assert.deepEqual(applied.shared, { mode: "selected", connectionIds: [LOCAL_ID] });
  assert.deepEqual(applied.unmapped, []);
});

test("empty mapping leaves the imported space on none", () => {
  const manifest = buildLlmShareManifest({
    catalog: catalogWith(),
    policy: { schemaVersion: 1, revision: 1, shared: { mode: "all" } },
    createId: () => createConnectionId(),
  });
  const applied = applyLlmShareMapping({
    manifest,
    mappings: [],
    catalog: catalogWith(LOCAL_ID),
  });
  assert.deepEqual(applied.shared, { mode: "none" });
  assert.equal(applied.unmapped.length, 1);
});

test("secret scan refuses keys, credential refs, and Home catalog files", () => {
  const findings = scanShareEntries([
    { name: ".credentials.yaml", data: "key: sk-live-secret" },
    { name: "notes.txt", data: "Authorization: Bearer sk-live-secret" },
    { name: "llm.json", data: JSON.stringify({ ok: true }) },
  ]);
  assert.ok(findings.some((row) => row.path === ".credentials.yaml"));
  assert.ok(findings.some((row) => row.reason.includes("authorization") || row.reason.includes("key-like")));
  assert.throws(
    () =>
      assertShareSecretFree([
        { name: "profile.patch.yml", data: "llm-pi-ai:\n  providers:\n    local:\n      apiKey: sk-live-secret\n" },
      ]),
    { code: LLM_ERROR.CONFIG_INVALID },
  );
});

test("export archive includes secret-free llm.json and import does not copy source ids", async () => {
  const dir = home();
  const profile = join(dir, "profiles", "coding");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, "package.json"),
    JSON.stringify({
      dependencies: { "dsh-outline": "1.2.3" },
      dsh: { profile: { bundles: ["dsh-outline"] } },
    }),
  );
  mkdirSync(join(profile, "node_modules", "dsh-outline"), { recursive: true });
  writeFileSync(join(profile, "node_modules", "dsh-outline", "package.json"), JSON.stringify({ name: "dsh-outline", version: "1.2.3" }));
  const manifest = buildLlmShareManifest({
    catalog: catalogWith(),
    policy: { schemaVersion: 1, revision: 1, shared: { mode: "all" } },
    createId: () => "11111111-1111-4111-8111-111111111111",
  });
  const archive = exportSpaceArchive(dir, "coding", { displayName: "Coding", llm: manifest });
  const parsed = parseSpaceShare(archive);
  assert.ok(parsed.llm);
  assert.equal(parsed.llm?.requirements[0].requirementId, "11111111-1111-4111-8111-111111111111");
  const created: string[] = [];
  const written: unknown[] = [];
  const result = await importSpaceArchive(archive, {
    listSpaceIds: () => ["web"],
    createSpace: async (input) => {
      created.push(input.name);
    },
    installPlugin: async (_spaceId, spec) => {
      if (/llm-bridge|llm-pi-ai|dsh-llm/i.test(spec)) {
        throw new Error("should not auto-install adapters");
      }
    },
    writeLlmShare: (spaceId, next) => {
      written.push({ spaceId, next });
    },
  });
  assert.equal(result.definition, "imported");
  assert.equal(result.llm?.mappingRequired, true);
  assert.equal(result.llm?.mapped, false);
  assert.equal(created.length, 1);
  assert.equal((written[0] as { next: { requirements: { requirementId: string }[] } }).next.requirements[0].requirementId, "11111111-1111-4111-8111-111111111111");
});

test("leaving shared access does not delete the Home catalog", async () => {
  const dir = home();
  const catalogStore = new FileLlmCatalogStore(dir);
  const policyStore = new FileLlmPolicyStore(dir);
  await catalogStore.write({ ...catalogWith(), revision: 1 }, 0);
  await policyStore.write("alpha", { schemaVersion: 1, revision: 1, shared: { mode: "all" } }, 0);
  await policyStore.write("alpha", { schemaVersion: 1, revision: 2, shared: { mode: "none" } }, 1);
  const kept = await catalogStore.read();
  assert.equal(Object.keys(kept.connections)[0], SOURCE_ID);
  assert.match(readFileSync(join(dir, ".dsh-spaces-control", "llm", "catalog.json"), "utf8"), /共享接口/);
});

test("legacy share without llm.json still imports and does not invent a mapping", async () => {
  const share = buildSpaceShare({
    displayName: "Legacy",
    plugins: [{ name: "dsh-outline", requestedSpec: "1.2.3", resolvedVersion: "1.2.3", version: "1.2.3", protected: false }] satisfies InstalledPlugin[],
  });
  const archive = packZip([
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(share.manifest)}\n`) },
    { name: "plugins.json", data: Buffer.from(`${JSON.stringify(share.plugins)}\n`) },
  ]);
  const result = await importSpaceArchive(archive, {
    listSpaceIds: () => ["web"],
    createSpace: async () => undefined,
    installPlugin: async () => undefined,
  });
  assert.equal(result.definition, "imported");
  assert.equal(result.llm, undefined);
});

test("packSpaceShare refuses a patch that embeds a live key", () => {
  assert.throws(
    () =>
      packSpaceShare({
        manifest: {
          formatVersion: 1,
          kind: "dsh-space",
          exportedAt: "2026-09-18T00:00:00.000Z",
          source: { dshVersion: "0.1.5-rc.2" },
          space: { displayName: "Coding" },
        },
        plugins: [],
        patch: "apiKey: sk-live-should-not-export\n",
      }),
    { code: LLM_ERROR.CONFIG_INVALID },
  );
  assert.equal(LLM_SHARE_FILENAME, "llm.json");
});
