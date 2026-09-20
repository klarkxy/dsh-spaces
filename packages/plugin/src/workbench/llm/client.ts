import type {
  LlmApiRequest,
  LlmApiResult,
  LlmCatalogResult,
  LlmChangePreview,
  LlmConnectionDraft,
  LlmConnectionSecretDraft,
  LlmCredentialRequest,
  LlmDeletePreview,
  LlmDescribeResult,
  LlmDiscoverResult,
  LlmImportedRequirementsResult,
  LlmLocalCandidatesResult,
  LlmOperationStatusResult,
  LlmShareMapping,
  LlmSharePreviewResult,
  LlmSpaceDefaultResult,
  LlmSpaceObservation,
  LlmSpacePolicyResult,
  LlmTestResult,
  SharedModelRef,
  SharedSelection,
} from "../../../../../src/shared/llm-api";
import type { WorkbenchApi, WorkbenchJob, WorkbenchSpace } from "../../../../../src/shared/workbench";

export type LlmUiSpace = {
  spaceId: string;
  displayName: string;
  status: WorkbenchSpace["status"];
  generation: number;
  serviceEpoch: string;
};

export interface LlmUiClient {
  describe(): Promise<LlmDescribeResult>;
  previewChange(draft: LlmConnectionDraft, expectedRevision: number): Promise<LlmChangePreview>;
  saveConnection(draft: LlmConnectionDraft, expectedRevision: number): Promise<LlmCatalogResult>;
  saveConnectionWithCredential(
    draft: LlmConnectionSecretDraft,
    secret: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<LlmCatalogResult>;
  setDefault(model: SharedModelRef | null, expectedRevision: number): Promise<LlmCatalogResult>;
  previewDelete(connectionId: string): Promise<LlmDeletePreview>;
  deleteConnection(connectionId: string, expectedRevision: number): Promise<LlmCatalogResult>;
  discoverModels(connectionId: string): Promise<LlmDiscoverResult>;
  discoverDraft(draft: LlmConnectionSecretDraft, secret: string): Promise<LlmDiscoverResult>;
  testConnection(connectionId: string, modelId: string): Promise<LlmTestResult>;
  spacePolicy(spaceId: string): Promise<LlmSpacePolicyResult>;
  updateSpacePolicy(spaceId: string, shared: SharedSelection, expectedRevision: number): Promise<LlmSpacePolicyResult>;
  spaceDefault(spaceId: string): Promise<LlmSpaceDefaultResult>;
  updateSpaceDefault(spaceId: string, model: SharedModelRef | null): Promise<LlmSpaceDefaultResult>;
  listLocalCandidates(spaceId: string): Promise<LlmLocalCandidatesResult>;
  adoptLocal(
    spaceId: string,
    routeId: string,
    displayName: string,
    expectedRevision: number,
    copyCredential: true,
  ): Promise<LlmCatalogResult>;
  previewShare(spaceId: string): Promise<LlmSharePreviewResult>;
  importedRequirements(spaceId: string): Promise<LlmImportedRequirementsResult>;
  mapImported(spaceId: string, mappings: LlmShareMapping[], expectedRevision: number): Promise<LlmSpacePolicyResult>;
  adoptLocalWithSecret(
    spaceId: string,
    routeId: string,
    displayName: string,
    secret: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<LlmCatalogResult>;
  applyPlan(
    spaceIds: string[],
    catalogRevision: number,
    observations: LlmSpaceObservation[],
    requestId: string,
  ): Promise<WorkbenchJob>;
  operationStatus(operationId: string): Promise<LlmOperationStatusResult>;
}

function asDescribe(result: LlmApiResult): LlmDescribeResult {
  if (!result || typeof result !== "object" || !("capabilities" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmDescribeResult;
}

function asCatalog(result: LlmApiResult): LlmCatalogResult {
  if (!result || typeof result !== "object" || !("connections" in result) || !("revision" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmCatalogResult;
}

function asPreview(result: LlmApiResult): LlmChangePreview {
  if (!result || typeof result !== "object" || !("affectedSpaceIds" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmChangePreview;
}

function asDeletePreview(result: LlmApiResult): LlmDeletePreview {
  if (!result || typeof result !== "object" || !("references" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmDeletePreview;
}

function asDiscover(result: LlmApiResult): LlmDiscoverResult {
  if (!result || typeof result !== "object" || !("models" in result) || !("truncated" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmDiscoverResult;
}

function asTest(result: LlmApiResult): LlmTestResult {
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmTestResult;
}

function asPolicy(result: LlmApiResult): LlmSpacePolicyResult {
  if (!result || typeof result !== "object" || !("policy" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmSpacePolicyResult;
}

function asDefault(result: LlmApiResult): LlmSpaceDefaultResult {
  if (!result || typeof result !== "object" || !("inheritGlobal" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmSpaceDefaultResult;
}

function asShare(result: LlmApiResult): LlmSharePreviewResult {
  if (!result || typeof result !== "object" || !("requirements" in result) || !("adapterRequired" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmSharePreviewResult;
}

function asImported(result: LlmApiResult): LlmImportedRequirementsResult {
  if (!result || typeof result !== "object" || !("mappingRequired" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmImportedRequirementsResult;
}

function asLocals(result: LlmApiResult): LlmLocalCandidatesResult {
  if (!result || typeof result !== "object" || !("candidates" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmLocalCandidatesResult;
}

function asJob(result: LlmApiResult): WorkbenchJob {
  if (!result || typeof result !== "object" || !("requestId" in result) || !("kind" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as WorkbenchJob;
}

function asOperation(result: LlmApiResult): LlmOperationStatusResult {
  if (!result || typeof result !== "object" || !("operationId" in result)) {
    throw new Error("workbench/unavailable");
  }
  return result as LlmOperationStatusResult;
}

export function createWorkbenchLlmClient(api: Pick<WorkbenchApi, "llm" | "llmCredential">, uuid: () => string): LlmUiClient {
  const llm = async (request: LlmApiRequest): Promise<LlmApiResult> => {
    if (!api.llm) throw new Error("workbench/unsupported");
    return api.llm(request);
  };
  const credential = async (request: LlmCredentialRequest): Promise<LlmApiResult> => {
    if (!api.llmCredential) throw new Error("workbench/unsupported");
    return api.llmCredential(request);
  };
  return {
    describe: async () => asDescribe(await llm({ method: "describe" })),
    previewChange: async (draft, expectedRevision) =>
      asPreview(await llm({ method: "previewChange", draft, expectedRevision })),
    saveConnection: async (draft, expectedRevision) =>
      asCatalog(await llm({ method: "saveConnection", draft, expectedRevision })),
    saveConnectionWithCredential: async (draft, secret, expectedRevision, operationId) =>
      asCatalog(
        await credential({
          method: "saveConnectionWithCredential",
          draft,
          secret,
          expectedRevision,
          operationId,
        }),
      ),
    setDefault: async (model, expectedRevision) => asCatalog(await llm({ method: "setDefault", model, expectedRevision })),
    previewDelete: async (connectionId) => asDeletePreview(await llm({ method: "previewDelete", connectionId })),
    deleteConnection: async (connectionId, expectedRevision) =>
      asCatalog(await llm({ method: "deleteConnection", connectionId, expectedRevision })),
    discoverModels: async (connectionId) => asDiscover(await llm({ method: "discoverModels", connectionId })),
    discoverDraft: async (draft, secret) => asDiscover(await credential({ method: "discoverModels", draft, secret })),
    testConnection: async (connectionId, modelId) =>
      asTest(await llm({ method: "testConnection", connectionId, modelId, authorize: true })),
    spacePolicy: async (spaceId) => asPolicy(await llm({ method: "spacePolicy", spaceId })),
    updateSpacePolicy: async (spaceId, shared, expectedRevision) =>
      asPolicy(await llm({ method: "updateSpacePolicy", spaceId, shared, expectedRevision })),
    spaceDefault: async (spaceId) => asDefault(await llm({ method: "spaceDefault", spaceId })),
    updateSpaceDefault: async (spaceId, model) => asDefault(await llm({ method: "updateSpaceDefault", spaceId, model })),
    listLocalCandidates: async (spaceId) => asLocals(await llm({ method: "listLocalCandidates", spaceId })),
    previewShare: async (spaceId) => asShare(await llm({ method: "previewShare", spaceId })),
    importedRequirements: async (spaceId) => asImported(await llm({ method: "importedRequirements", spaceId })),
    mapImported: async (spaceId, mappings, expectedRevision) =>
      asPolicy(await llm({ method: "mapImported", spaceId, mappings, expectedRevision })),
    adoptLocal: async (spaceId, routeId, displayName, expectedRevision, copyCredential) =>
      asCatalog(await llm({ method: "adoptLocal", spaceId, routeId, displayName, expectedRevision, copyCredential })),
    adoptLocalWithSecret: async (spaceId, routeId, displayName, secret, expectedRevision, operationId) =>
      asCatalog(
        await credential({
          method: "adoptLocal",
          spaceId,
          routeId,
          displayName,
          secret,
          expectedRevision,
          operationId,
        }),
      ),
    applyPlan: async (spaceIds, catalogRevision, observations, requestId) =>
      asJob(await llm({ method: "applyPlan", spaceIds, catalogRevision, observations, requestId })),
    operationStatus: async (operationId) => asOperation(await llm({ method: "operationStatus", operationId })),
  };
}

export function newOperationId(uuid: () => string): string {
  return uuid().replaceAll("-", "").slice(0, 32) || `llm${Date.now()}`;
}
