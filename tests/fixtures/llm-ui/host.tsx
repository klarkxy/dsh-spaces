import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { LlmModelCenter } from "../../../packages/plugin/src/workbench/llm/center";
import type { LlmUiClient } from "../../../packages/plugin/src/workbench/llm/client";
import type { LlmDescribeResult, LlmImportedRequirementsResult, LlmSpacePolicyResult } from "../../../src/shared/llm-api";

declare global {
  interface Window {
    __LLM?: {
      secrets: string[];
      mapped: unknown;
      policyMode: string;
      saved: boolean;
    };
  }
}

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
    pendingRestartSpaceIds: [],
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

function imported(): LlmImportedRequirementsResult {
  return {
    spaceId: "alpha",
    mappingRequired: true,
    manifest: {
      schemaVersion: 1,
      kind: "dsh-space-llm-requirements",
      sourceSharedMode: "selected",
      requirements: [
        {
          requirementId: "22222222-2222-4222-8222-222222222222",
          displayName: "Imported mock",
          protocol: "openai-completions",
          endpoint: "http://127.0.0.1:9/v1",
          modelIds: ["demo-large"],
          authKind: "api-key",
          usedAsDefault: false,
        },
      ],
      defaultRequirementId: null,
      adapterRequired: "llm-pi-ai",
      note: "Source connection IDs are local to the exporting Home and are not valid references here. Map each requirement to a connection on this Home. Unmapped requirements stay unavailable.",
    },
  };
}

function policy(mode: "none" | "all" | "selected"): LlmSpacePolicyResult {
  return {
    spaceId: "alpha",
    policy: {
      schemaVersion: 1,
      revision: 1,
      shared: mode === "selected" ? { mode, connectionIds: [CONNECTION_ID] } : { mode },
    },
    targetCatalogRevision: 1,
    runningCatalogRevision: 1,
    pendingRestart: false,
  };
}

function App(): React.ReactElement {
  const [mode, setMode] = useState<"none" | "all" | "selected">("none");
  const log = (window.__LLM ??= { secrets: [], mapped: null, policyMode: "none", saved: false });
  const client = useMemo<LlmUiClient>(
    () => ({
      describe: async () => describeResult(),
      previewChange: async () => ({
        catalogRevision: 1,
        affectedSpaceIds: ["alpha"],
        pendingRestartSpaceIds: [],
        connectionId: CONNECTION_ID,
      }),
      saveConnection: async () => describeResult(),
      saveConnectionWithCredential: async (_draft, secret) => {
        log.secrets.push(secret);
        log.saved = true;
        return { ...describeResult(), connectionId: CONNECTION_ID };
      },
      setDefault: async () => describeResult(),
      previewDelete: async () => ({ connectionId: CONNECTION_ID, references: [] }),
      deleteConnection: async () => describeResult(),
      discoverModels: async () => ({ models: [{ id: "demo-large" }], truncated: false }),
      discoverDraft: async () => ({ models: [{ id: "demo-large" }], truncated: false }),
      testConnection: async () => ({ ok: true, modelId: "demo-large", billed: true }),
      spacePolicy: async () => policy(mode),
      updateSpacePolicy: async (_spaceId, shared) => {
        const next = shared.mode;
        setMode(next);
        log.policyMode = next;
        return policy(next);
      },
      spaceDefault: async () => ({
        spaceId: "alpha",
        source: "global",
        inheritGlobal: true,
        local: null,
        global: { connectionId: CONNECTION_ID, modelId: "demo-large" },
        effective: {
          provider: "spaces-llm-11111111111141118111111111111111",
          model: "demo-large",
          origin: "global",
        },
      }),
      updateSpaceDefault: async () => ({
        spaceId: "alpha",
        source: "global",
        inheritGlobal: true,
        local: null,
        global: null,
        effective: null,
      }),
      listLocalCandidates: async () => ({ spaceId: "alpha", candidates: [] }),
      previewShare: async () => ({
        spaceId: "alpha",
        schemaVersion: 1,
        kind: "dsh-space-llm-requirements",
        sourceSharedMode: "none",
        requirements: [],
        defaultRequirementId: null,
        adapterRequired: "llm-pi-ai",
        note: "Source connection IDs are local to the exporting Home and are not valid references here. Map each requirement to a connection on this Home. Unmapped requirements stay unavailable.",
      }),
      importedRequirements: async () => imported(),
      mapImported: async (_spaceId, mappings) => {
        log.mapped = mappings;
        return policy("selected");
      },
      adoptLocal: async () => describeResult(),
      adoptLocalWithSecret: async () => describeResult(),
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
    }),
    [mode, log],
  );
  return (
    <LlmModelCenter
      locale="en"
      writable
      client={client}
      spaces={[{ spaceId: "alpha", displayName: "Alpha", status: "running", generation: 1 }]}
      uuid={() => "op-browser"}
      initialDescribe={describeResult()}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing root");
createRoot(root).render(<App />);
