import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { FileLlmCatalogStore } from "../src/adapters/node/llm-catalog-store.ts";
import { FileLlmCredentialStore } from "../src/adapters/node/llm-credential-store.ts";
import { FileLlmOperationStore, llmOperationsPath } from "../src/adapters/node/llm-operation-store.ts";
import { FileLlmPolicyStore } from "../src/adapters/node/llm-policy-store.ts";
import { llmCatalogPath, llmCredentialsPath } from "../src/adapters/node/llm-paths.ts";
import { WorkbenchJobStore } from "../src/adapters/node/workbench-jobs.ts";
import { GlobalLlmHost } from "../src/core/application/global-llm-host.ts";
import { GlobalLlmService } from "../src/core/application/global-llm-service.ts";
import { LLM_CREDENTIAL_METHOD } from "../src/shared/llm-api.ts";
import { DESKTOP_WRITE_IPC_CHANNELS } from "../src/shared/desktop-controller.ts";

const temps: string[] = [];
const SECRET = "sk-live-global-never-in-jobs";

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("jobs, operations, catalog, and IPC never persist the live key", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-llm-leak-"));
  temps.push(home);
  const credentials = new FileLlmCredentialStore(home);
  const operations = new FileLlmOperationStore(home);
  const service = new GlobalLlmService(
    new FileLlmCatalogStore(home),
    new FileLlmPolicyStore(home),
    credentials,
    async () => ["alpha"],
  );
  const jobs = new WorkbenchJobStore({ home });
  const host = new GlobalLlmHost({
    service,
    operations,
    instances: {
      list: async () => [],
      get: async () => undefined,
      markApplied: async () => undefined,
    },
    probe: {
      discover: async () => ({ models: [{ id: "demo-large" }], truncated: false }),
      test: async ({ modelId }) => ({ ok: true as const, modelId }),
    },
    spaceSettings: {
      readDefault: async () => null,
      writeDefault: async () => undefined,
      listLocal: async () => [],
      readLocalProvider: async () => ({}),
      readCopyableSecret: async () => undefined,
    },
    assertWritable: () => undefined,
    submitApply: async () => {
      throw new Error("apply unused");
    },
    readSecret: (recordId) => credentials.readSecret(recordId),
  });
  const described = await host.dispatchCredential({
    method: LLM_CREDENTIAL_METHOD,
    draft: {
      displayName: "shared",
      providerConfig: {
        api: "openai-completions",
        baseURL: "http://127.0.0.1:9/v1",
        models: [{ id: "demo-large" }],
      },
    },
    secret: SECRET,
    expectedRevision: 0,
    operationId: "op-secret-1",
  });
  assert.doesNotMatch(JSON.stringify(described), new RegExp(SECRET));
  assert.doesNotMatch(readFileSync(llmCatalogPath(home), "utf8"), new RegExp(SECRET));
  assert.match(readFileSync(llmCredentialsPath(home), "utf8"), new RegExp(SECRET));
  assert.doesNotMatch(readFileSync(llmOperationsPath(home), "utf8"), new RegExp(SECRET));
  assert.doesNotMatch(readFileSync(llmOperationsPath(home), "utf8"), /hash|apiKey|authorization/i);
  await assert.rejects(
    () =>
      jobs.submit(
        {
          kind: "llm.apply",
          spaceIds: ["alpha"],
          catalogRevision: 1,
          observations: [
            { spaceId: "alpha", status: "running", generation: 1, catalogRevision: 0, busy: false, apiKey: SECRET },
          ],
        } as never,
        "job-secret",
        async () => undefined,
      ),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "workbench/invalid-input"),
  );
  const jobsDir = join(home, ".dsh-spaces-control", "jobs");
  if (existsSync(jobsDir)) {
    for (const name of ["queue.json", "jobs.json"]) {
      const path = join(jobsDir, name);
      if (existsSync(path)) assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(SECRET));
    }
  }
  assert.equal(DESKTOP_WRITE_IPC_CHANNELS.includes("llmCredential"), true);
  assert.equal(DESKTOP_WRITE_IPC_CHANNELS.includes("llm"), false);
});
