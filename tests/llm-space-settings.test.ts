import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  listLocalLlmCandidates,
  readLocalProviderConfig,
  readSpaceDefaultModel,
  writeSpaceDefaultModel,
} from "../src/adapters/node/llm-space-settings.ts";
import { redactEndpoint } from "../src/core/domain/llm-connections.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-llm-settings-"));
  temps.push(dir);
  mkdirSync(join(dir, "hub", "alpha"), { recursive: true });
  return dir;
}

test("space default writes only agent-default-model and keeps other YAML comments", () => {
  const root = home();
  const path = join(root, "hub", "alpha", "settings.yaml");
  writeFileSync(
    path,
    ["# keep me", "theme:", "  name: dark", "agent-default-model:", "  provider: local-openai", "  model: old", ""].join("\n"),
  );
  assert.deepEqual(readSpaceDefaultModel(root, "alpha"), { provider: "local-openai", model: "old" });
  writeSpaceDefaultModel(root, "alpha", { provider: "spaces-llm-aa", model: "demo-large" });
  const text = readFileSync(path, "utf8");
  assert.match(text, /# keep me/);
  assert.match(text, /name: dark/);
  assert.deepEqual(readSpaceDefaultModel(root, "alpha"), { provider: "spaces-llm-aa", model: "demo-large" });
  writeSpaceDefaultModel(root, "alpha", null);
  assert.equal(readSpaceDefaultModel(root, "alpha"), null);
  assert.match(readFileSync(path, "utf8"), /# keep me/);
});

test("local candidates skip managed routes and never surface keys", () => {
  const root = home();
  writeFileSync(
    join(root, "hub", "alpha", "settings.yaml"),
    [
      "llm-pi-ai:",
      "  providers:",
      "    local-openai:",
      "      displayName: Local",
      "      api: openai-completions",
      "      baseURL: http://127.0.0.1:9/v1",
      "      apiKeyEnv: LOCAL_KEY",
      "      models:",
      "        - id: demo-large",
      "    spaces-llm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:",
      "      api: openai-completions",
      "      baseURL: http://example.invalid",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "hub", "alpha", ".credentials.yaml"), "LOCAL_KEY: sk-copy-me\n");
  const rows = listLocalLlmCandidates(root, "alpha");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].routeId, "local-openai");
  assert.equal(rows[0].credentialCopy, "available");
  assert.doesNotMatch(JSON.stringify(rows), /sk-copy-me/);
  const config = readLocalProviderConfig(root, "alpha", "local-openai");
  assert.equal(config.api, "openai-completions");
  assert.equal("apiKeyEnv" in config, false);
});

test("redactEndpoint drops userinfo and query", () => {
  assert.equal(redactEndpoint("https://host.example/v1"), "https://host.example/v1");
  assert.equal(redactEndpoint("https://user:pass@host.example/v1?key=1"), "https://host.example/v1");
});
