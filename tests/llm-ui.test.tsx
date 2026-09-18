import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LlmModelCenter } from "../packages/plugin/src/workbench/llm/center.tsx";
import type { LlmUiClient } from "../packages/plugin/src/workbench/llm/client.ts";
import type { LlmDescribeResult } from "../src/shared/llm-api.ts";
import { WorkbenchController } from "../packages/plugin/src/workbench/store.ts";
import type { WorkbenchApi, WorkbenchState } from "../src/shared/workbench.ts";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function describeResult(): LlmDescribeResult {
  return {
    revision: 1,
    defaultModel: { connectionId: CONNECTION_ID, modelId: "demo-large" },
    capabilities: {
      adapter: "llm-pi-ai",
      adapterVersion: "0.1.5-rc.2",
      protocols: ["openai-completions", "openai-responses", "anthropic-messages"],
      keyless: false,
    },
    pendingRestartSpaceIds: ["alpha"],
    connections: [
      {
        id: CONNECTION_ID,
        revision: 1,
        displayName: "共享接口",
        enabled: true,
        backend: "llm-pi-ai",
        providerConfig: {
          api: "openai-completions",
          baseURL: "http://127.0.0.1:9/v1",
          models: [{ id: "demo-large" }],
        },
        auth: { kind: "api-key", configured: true },
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
        routeId: "spaces-llm-11111111111141118111111111111111",
        usedBySpaceIds: ["alpha"],
      },
    ],
  };
}

function client(overrides: Partial<LlmUiClient> = {}): LlmUiClient {
  const described = describeResult();
  return {
    describe: async () => described,
    previewChange: async () => ({
      catalogRevision: 1,
      affectedSpaceIds: ["alpha"],
      pendingRestartSpaceIds: ["alpha"],
      connectionId: CONNECTION_ID,
    }),
    saveConnection: async () => described,
    saveConnectionWithCredential: async () => described,
    setDefault: async () => described,
    previewDelete: async () => ({ connectionId: CONNECTION_ID, references: [] }),
    deleteConnection: async () => described,
    discoverModels: async () => ({ models: [{ id: "demo-large" }], truncated: false }),
    discoverDraft: async () => ({ models: [{ id: "demo-large" }], truncated: false }),
    testConnection: async () => ({ ok: true, modelId: "demo-large", billed: true }),
    spacePolicy: async (spaceId) => ({
      spaceId,
      policy: { schemaVersion: 1, revision: 0, shared: { mode: "all" } },
      targetCatalogRevision: 1,
      runningCatalogRevision: 0,
      pendingRestart: true,
    }),
    updateSpacePolicy: async (spaceId) => ({
      spaceId,
      policy: { schemaVersion: 1, revision: 1, shared: { mode: "all" } },
      targetCatalogRevision: 1,
      runningCatalogRevision: 0,
      pendingRestart: true,
    }),
    spaceDefault: async (spaceId) => ({
      spaceId,
      source: "global",
      inheritGlobal: true,
      local: null,
      global: { connectionId: CONNECTION_ID, modelId: "demo-large" },
      effective: { provider: "spaces-llm-11111111111141118111111111111111", model: "demo-large", origin: "global" },
    }),
    updateSpaceDefault: async (spaceId) => ({
      spaceId,
      source: "global",
      inheritGlobal: true,
      local: null,
      global: null,
      effective: null,
    }),
    listLocalCandidates: async (spaceId) => ({ spaceId, candidates: [] }),
    previewShare: async (spaceId) => ({
      spaceId,
      schemaVersion: 1,
      kind: "dsh-space-llm-requirements",
      sourceSharedMode: "none",
      requirements: [],
      defaultRequirementId: null,
      adapterRequired: "llm-pi-ai",
      note: "Source connection IDs are local to the exporting Home and are not valid references here. Map each requirement to a connection on this Home. Unmapped requirements stay unavailable.",
    }),
    importedRequirements: async (spaceId) => ({ spaceId, mappingRequired: false, manifest: null }),
    mapImported: async (spaceId) => ({
      spaceId,
      policy: { schemaVersion: 1, revision: 1, shared: { mode: "none" } },
      targetCatalogRevision: 1,
      runningCatalogRevision: 0,
      pendingRestart: true,
    }),
    adoptLocal: async () => described,
    adoptLocalWithSecret: async () => described,
    applyPlan: async () => ({
      id: "job",
      requestId: "req",
      kind: "llm.apply",
      status: "succeeded",
      phase: "succeeded",
      message: "",
      affectedSpaceIds: ["alpha"],
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      canCancel: false,
    }),
    operationStatus: async (operationId) => ({ operationId, status: "committed" }),
    ...overrides,
  };
}

test("model center lists redacted connections and required copy without secrets", () => {
  const html = renderToStaticMarkup(
    <LlmModelCenter
      locale="zh"
      writable
      client={client()}
      spaces={[{ spaceId: "alpha", displayName: "Alpha", status: "running", generation: 1 }]}
      uuid={() => "op1"}
      initialDescribe={describeResult()}
    />,
  );
  assert.match(html, /模型与连接/);
  assert.match(html, /连接配置由 Spaces 共享/);
  assert.match(html, /已保存。1 个运行中空间仍使用旧配置/);
  assert.match(html, /共享接口/);
  assert.match(html, /openai-completions/);
  assert.match(html, /http:\/\/127.0.0.1:9\/v1/);
  assert.doesNotMatch(html, /sk-live/);
  assert.doesNotMatch(html, /credentialRecordId/);
});

test("create space submits the explicit shared-connection choice", async () => {
  const calls: unknown[] = [];
  const api = {
    state: async () =>
      ({
        role: "manager",
        managerId: "hub",
        owner: { kind: "web", since: "2026-09-18T00:00:00.000Z" },
        writable: true,
        mode: "verified-full",
        dshVersion: "0.1.5-rc.2",
        maintenance: false,
        recoveryRequired: false,
        reasons: [],
        spaces: [],
        jobs: [],
      }) satisfies WorkbenchState,
    detail: async () => {
      throw new Error("unused");
    },
    submit: async (command) => {
      calls.push(command);
      return {
        id: "job",
        requestId: "req",
        kind: command.kind,
        status: "succeeded",
        phase: "done",
        message: "",
        affectedSpaceIds: [],
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
        canCancel: false,
      };
    },
    job: async () => {
      throw new Error("unused");
    },
    cancel: async () => {
      throw new Error("unused");
    },
    view: async () => {
      throw new Error("unused");
    },
    preview: async () => {
      throw new Error("unused");
    },
    plugins: async () => [],
    snapshots: async () => [],
    snapshot: async () => {
      throw new Error("unused");
    },
    runtimes: async () => [],
    backups: async () => [],
  } as WorkbenchApi;
  const ctrl = new WorkbenchController(api, {
    uuid: () => "u",
    storage: { getItem: () => null, setItem: () => undefined },
    hidden: () => false,
    onVisibilityChange: () => () => undefined,
    addMessageListener: () => () => undefined,
  });
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  ctrl.start();
  await flush();
  await flush();
  ctrl.openSettings();
  assert.equal(ctrl.getSnapshot().settingsTab, "general");
  ctrl.setSettingsTab("llm");
  assert.equal(ctrl.getSnapshot().settingsTab, "llm");
  ctrl.createSpace({ name: "notes", useSharedLlm: true });
  await flush();
  await flush();
  ctrl.stop();
  assert.deepEqual(calls[0], {
    kind: "space.create",
    input: { name: "notes", displayName: undefined, icon: undefined, useSharedLlm: true },
  });
});
