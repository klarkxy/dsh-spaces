import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FileLlmCatalogStore } from "../src/adapters/node/llm-catalog-store.ts";
import { FileLlmCredentialStore } from "../src/adapters/node/llm-credential-store.ts";
import { FileLlmPolicyStore } from "../src/adapters/node/llm-policy-store.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import { LLM_ERROR } from "../src/core/domain/llm-connections.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("two catalog writers with the same expected revision keep exactly one commit", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-llm-cas-"));
  temps.push(home);
  const left = new GlobalLlmService(
    new FileLlmCatalogStore(home),
    new FileLlmPolicyStore(home),
    new FileLlmCredentialStore(home),
    async () => ["alpha"],
  );
  const right = new GlobalLlmService(
    new FileLlmCatalogStore(home),
    new FileLlmPolicyStore(home),
    new FileLlmCredentialStore(home),
    async () => ["alpha"],
  );
  const draft = (name: string) => ({
    displayName: name,
    providerConfig: {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:9/v1",
      models: [{ id: "demo-large" }],
    },
    auth: { kind: "none" as const },
  });
  const results = await Promise.allSettled([
    left.saveConnection(draft("left"), 0),
    right.saveConnection(draft("right"), 0),
  ]);
  const ok = results.filter((item) => item.status === "fulfilled");
  const failed = results.filter((item) => item.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal((failed[0] as PromiseRejectedResult).reason.code, LLM_ERROR.REVISION_CONFLICT);
  const catalog = await left.readCatalog();
  assert.equal(catalog.revision, 1);
  assert.equal(Object.keys(catalog.connections).length, 1);
});
