import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  applySnapshotToCredentials,
  applySnapshotToPatch,
  assertModelSyncPreview,
  prepareMainModelSync,
  readSpaceModelConfig,
  describeModelSync,
  MODEL_SYNC_DETAIL_MAX,
  readMainModelSnapshot,
  syncMainModels,
} from "../../src/adapters/node/llm/main-model-sync.ts";

const DUMP = `# == @deepseek-ai/dsh-base
- id: llm
  name: '@deepseek-ai/dsh-llm'
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: gw
    model: gw-large
    reasoningEffort: high
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      gw:
        api: openai-completions
        baseURL: http://127.0.0.1:9/v1
        apiKeyEnv: GW_KEY
        models:
          - id: gw-large
      codex:
        displayName: Codex login
      env-only:
        api: openai-completions
        baseURL: http://127.0.0.1:8/v1
        apiKeyEnv: ENV_ONLY_KEY
      computed:
        baseURL: !!js process.env.X
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
`;

const MAIN_CREDENTIALS = `version: 1
refs:
  GW_KEY: test-gw-value
  DEEPSEEK_API_KEY: test-deepseek-value
  UNRELATED: other
records:
  llm-pi-ai/codex:
    kind: grant
    payload: { refresh: r }
`;

function home(): string {
  return mkdtempSync(join(tmpdir(), "dsh-spaces-model-sync-"));
}

test("snapshot copies config routes, the DeepSeek key and the default; skips grants and expressions", () => {
  const snapshot = readMainModelSnapshot(DUMP, "H:/home", () => MAIN_CREDENTIALS);
  assert.deepEqual(Object.keys(snapshot.providers), ["gw", "env-only"]);
  assert.deepEqual(snapshot.skipped, [
    { route: "codex", reason: "login-grant" },
    { route: "computed", reason: "expression" },
  ]);
  assert.deepEqual(snapshot.refs, { GW_KEY: "test-gw-value", DEEPSEEK_API_KEY: "test-deepseek-value" });
  assert.deepEqual(snapshot.missingCredentials, ["ENV_ONLY_KEY"]);
  assert.equal(snapshot.deepseek, true);
  assert.deepEqual(snapshot.defaultModel, { provider: "gw", model: "gw-large", reasoningEffort: "high" });
});

test("a default that names a skipped route is not copied", () => {
  const dump = DUMP.replace("provider: gw", "provider: codex");
  const snapshot = readMainModelSnapshot(dump, "H:/home", () => MAIN_CREDENTIALS);
  assert.equal(snapshot.defaultModel, undefined);
  assert.equal(snapshot.defaultModelSkipped, "codex");
});

test("the patch merge keeps the space's own rows and routes", () => {
  const snapshot = readMainModelSnapshot(DUMP, "H:/home", () => MAIN_CREDENTIALS);
  const before = `- id: credentials
  config:
    path: !!js dshHomePath('hub/space-a/.credentials.yaml')
- id: llm-pi-ai
  config:
    providers:
      mine:
        api: openai-completions
        baseURL: http://127.0.0.1:7/v1
      gw:
        baseURL: http://old
`;
  const after = applySnapshotToPatch(before, snapshot);
  assert.match(after, /dshHomePath\('hub\/space-a\/\.credentials\.yaml'\)/);
  const rows = parse(after.replace(/!!js /g, "")) as Array<Record<string, any>>;
  const pi = rows.find((row) => row.id === "llm-pi-ai")!;
  assert.deepEqual(Object.keys(pi.config.providers).sort(), ["env-only", "gw", "mine"]);
  assert.equal(pi.config.providers.gw.baseURL, "http://127.0.0.1:9/v1");
  const selection = rows.find((row) => row.id === "agent-default-model")!;
  assert.deepEqual(selection.config, { provider: "gw", model: "gw-large", reasoningEffort: "high" });
});

test("an empty flow-list patch becomes a block list", () => {
  const snapshot = readMainModelSnapshot(DUMP, "H:/home", () => MAIN_CREDENTIALS);
  const after = applySnapshotToPatch("# user layer\n[]\n", snapshot);
  assert.match(after, /^- id: llm-pi-ai$/m);
});

test("credentials keep existing entries and add only referenced values", () => {
  const snapshot = readMainModelSnapshot(DUMP, "H:/home", () => MAIN_CREDENTIALS);
  const after = parse(applySnapshotToCredentials("version: 1\nrefs:\n  OWN: keep\n", snapshot));
  assert.deepEqual(after, { version: 1, refs: { OWN: "keep", GW_KEY: "test-gw-value", DEEPSEEK_API_KEY: "test-deepseek-value" } });
  assert.equal(JSON.stringify(after).includes("other"), false);
});

test("a non-version-1 main credentials document fails instead of guessing", () => {
  assert.throws(() => readMainModelSnapshot(DUMP, "H:/home", () => "GW_KEY: flat\n"), /version 1/);
});

test("syncMainModels writes the space patch and its isolated credentials once", async () => {
  const dir = home();
  mkdirSync(join(dir, "profiles", "space-a"), { recursive: true });
  writeFileSync(join(dir, "profiles", "space-a", "cordis.patch.yml"), "[]\n");
  writeFileSync(join(dir, ".credentials.yaml"), MAIN_CREDENTIALS);
  const dumps: string[] = [];
  const summary = await syncMainModels({ home: dir, mainProfile: "web", spaceId: "space-a", dumpConfig: async (profile) => { dumps.push(profile); return DUMP; } });
  assert.deepEqual(dumps, ["web"]);
  assert.deepEqual(summary.routes, ["gw", "env-only"]);
  assert.deepEqual(summary.credentials, ["DEEPSEEK_API_KEY", "GW_KEY"]);
  const credentials = parse(readFileSync(join(dir, "hub", "space-a", ".credentials.yaml"), "utf8"));
  assert.equal(credentials.refs.GW_KEY, "test-gw-value");
  assert.equal(JSON.stringify(summary).includes("test-"), false);
  assert.equal(describeModelSync(summary).includes("test-"), false);
  assert.match(describeModelSync(summary), /skipped: codex \(login-grant\), computed \(expression\)/);
  assert.equal(existsSync(join(dir, "profiles", "web")), false);
});

test("preparation compares only public summaries and does not write before approval", async () => {
  const dir = home();
  mkdirSync(join(dir, "profiles", "space-a"), { recursive: true });
  writeFileSync(join(dir, "profiles", "space-a", "cordis.patch.yml"), "[]\n");
  writeFileSync(join(dir, ".credentials.yaml"), MAIN_CREDENTIALS);
  const prepared = await prepareMainModelSync({ home: dir, mainProfile: "web", spaceId: "space-a", dumpConfig: async () => DUMP });
  assert.equal(prepared.summary.defaultModel, "gw/gw-large");
  assert.doesNotThrow(() => assertModelSyncPreview(prepared, prepared.summary));
  assert.throws(() => assertModelSyncPreview(prepared, { ...prepared.summary, defaultModel: "gw/changed" }), /Preview the sync again/);
  assert.throws(() => assertModelSyncPreview(prepared, undefined), /Preview the sync again/);
  assert.equal(readFileSync(join(dir, "profiles", "space-a", "cordis.patch.yml"), "utf8"), "[]\n");
  assert.equal(JSON.stringify(prepared.summary).includes("test-gw-value"), false);
});

test("the persistent model card reads the target's own routes, default and missing keys", async () => {
  const dir = home();
  mkdirSync(join(dir, "profiles", "space-a"), { recursive: true });
  writeFileSync(join(dir, "profiles", "space-a", "cordis.patch.yml"), "[]\n");
  writeFileSync(join(dir, ".credentials.yaml"), MAIN_CREDENTIALS);
  await syncMainModels({ home: dir, mainProfile: "web", spaceId: "space-a", dumpConfig: async () => DUMP });
  const synced = readSpaceModelConfig(dir, "space-a");
  assert.equal(synced.status, "incomplete");
  assert.deepEqual(synced.missingCredentials, ["ENV_ONLY_KEY"]);
  writeFileSync(join(dir, "profiles", "space-a", "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      gw: { apiKeyEnv: GW_KEY }
- id: agent-default-model
  config: { provider: gw, model: gw-large }
`);
  const configured = readSpaceModelConfig(dir, "space-a");
  assert.deepEqual(configured, { status: "configured", routeNames: ["gw"], defaultModel: "gw/gw-large", missingCredentials: [] });
  assert.equal(JSON.stringify(configured).includes("test-gw-value"), false);
  writeFileSync(join(dir, "profiles", "space-a", "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      gw:
        apiKeyEnv: MISSING_KEY
- id: agent-default-model
  config: { provider: gw, model: gw-large }
`);
  assert.deepEqual(readSpaceModelConfig(dir, "space-a"), { status: "incomplete", routeNames: ["gw"], defaultModel: "gw/gw-large", missingCredentials: ["MISSING_KEY"] });
  writeFileSync(join(dir, "profiles", "space-a", "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      gw: { apiKeyEnv: GW_KEY }
`);
  assert.equal(readSpaceModelConfig(dir, "space-a").status, "incomplete");
  assert.equal(readSpaceModelConfig(dir, "space-empty").status, "unconfigured");
});

test("the main profile is never a sync target", async () => {
  await assert.rejects(syncMainModels({ home: "H:/x", mainProfile: "web", spaceId: "web", dumpConfig: async () => DUMP }), /main space/);
});

test("a long sync summary folds into counts and keeps the skipped route names", () => {
  const routes = Array.from({ length: 30 }, (_, index) => `provider-route-${index}`);
  const summary = {
    mainProfile: "web",
    routes,
    deepseek: true,
    defaultModel: "provider-route-0/model",
    credentials: routes.map((route) => `${route.toUpperCase()}_KEY`),
    skipped: [{ route: "codex", reason: "login-grant" }, { route: "computed", reason: "expression" }],
    missingCredentials: [],
  } as Parameters<typeof describeModelSync>[0];
  const line = describeModelSync(summary);
  assert.ok(line.length <= MODEL_SYNC_DETAIL_MAX);
  assert.match(line, /routes: 30/);
  assert.match(line, /skipped: codex \(login-grant\), computed \(expression\)/);
  const crowded = { ...summary, skipped: routes.map((route) => ({ route, reason: "login-grant" })) } as typeof summary;
  assert.ok(describeModelSync(crowded).length <= MODEL_SYNC_DETAIL_MAX);
});
