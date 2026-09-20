/** Browser-safe global LLM management contract. Never carry secrets, hashes, or credential payloads. */
import type {
  SharedAuth,
  SharedConnection,
  SharedModelRef,
  SharedSelection,
  SpaceLlmPolicy,
} from "../core/domain/llm-connections";
import type { LlmShareManifest, LlmShareMapping } from "../core/domain/llm-share";

export type { SharedAuth, SharedModelRef, SharedSelection, SpaceLlmPolicy };
export type { LlmShareManifest, LlmShareMapping, LlmShareRequirement } from "../core/domain/llm-share";
import type { WorkbenchJob, WorkbenchSpace } from "./workbench";

export type RedactedConnection = Omit<SharedConnection, "auth"> & {
  auth: { kind: "none" } | { kind: "api-key"; configured: true };
  routeId: string;
};

export const LLM_API_METHODS = [
  "describe",
  "previewChange",
  "saveConnection",
  "setDefault",
  "previewDelete",
  "deleteConnection",
  "discoverModels",
  "testConnection",
  "spacePolicy",
  "updateSpacePolicy",
  "spaceDefault",
  "updateSpaceDefault",
  "listLocalCandidates",
  "adoptLocal",
  "previewShare",
  "importedRequirements",
  "mapImported",
  "applyPlan",
  "operationStatus",
] as const;

export type LlmApiMethod = (typeof LLM_API_METHODS)[number];

export const LLM_WRITE_API_METHODS = [
  "saveConnection",
  "setDefault",
  "deleteConnection",
  "discoverModels",
  "testConnection",
  "updateSpacePolicy",
  "updateSpaceDefault",
  "adoptLocal",
  "mapImported",
  "applyPlan",
] as const;

export const LLM_CREDENTIAL_METHOD = "saveConnectionWithCredential" as const;
export const LLM_CREDENTIAL_DISCOVER_METHOD = "discoverModels" as const;
export const LLM_CREDENTIAL_ADOPT_METHOD = "adoptLocal" as const;

export type LlmConnectionDraft = {
  id?: string;
  displayName: string;
  enabled?: boolean;
  providerConfig: Record<string, unknown>;
  auth?: SharedAuth;
};

export type LlmConnectionSecretDraft = Omit<LlmConnectionDraft, "auth">;

export type LlmSpaceObservation = {
  spaceId: string;
  status: WorkbenchSpace["status"];
  generation: number;
  catalogRevision: number | null;
  busy: boolean;
  serviceEpoch: string;
};

export type LlmCapabilities = {
  adapter: "llm-pi-ai";
  adapterVersion: "0.1.5-rc.2";
  protocols: readonly ["openai-completions", "openai-responses", "anthropic-messages"];
  keyless: false;
};

export type LlmDescribeResult = {
  revision: number;
  connections: Array<RedactedConnection & { usedBySpaceIds: string[] }>;
  defaultModel: SharedModelRef | null;
  capabilities: LlmCapabilities;
  pendingRestartSpaceIds: string[];
};

export type LlmChangePreview = {
  catalogRevision: number;
  affectedSpaceIds: string[];
  pendingRestartSpaceIds: string[];
  connectionId: string;
};

export type LlmDeletePreview = {
  connectionId: string;
  references: Array<{ spaceId: string; connectionIds: string[]; mode: SpaceLlmPolicy["shared"]["mode"] }>;
};

export type LlmCatalogResult = {
  revision: number;
  connections: RedactedConnection[];
  defaultModel: SharedModelRef | null;
  connectionId?: string;
};

export type LlmSpacePolicyResult = {
  spaceId: string;
  policy: SpaceLlmPolicy;
  targetCatalogRevision: number;
  runningCatalogRevision: number | null;
  pendingRestart: boolean;
};

export type LlmDiscoverResult = {
  models: Array<{ id: string; name?: string }>;
  truncated: boolean;
  connectionId?: string;
};

export type LlmTestResult = {
  ok: true;
  modelId: string;
  billed: true;
};

export type LlmOperationStatusResult = {
  operationId: string;
  status: "committed" | "not-found" | "unknown";
  catalogRevision?: number;
  connectionId?: string;
  leftoverRecordId?: string;
};

export type LlmSpaceDefaultResult = {
  spaceId: string;
  source: "local" | "global" | "none";
  inheritGlobal: boolean;
  local: { provider: string; model: string } | null;
  global: SharedModelRef | null;
  effective: { provider: string; model: string; origin: "local" | "global" } | null;
};

export type LlmLocalCandidate = {
  routeId: string;
  displayName: string;
  api?: string;
  origin: string;
  modelIds: string[];
  credentialCopy: "available" | "reenter" | "unsupported";
};

export type LlmLocalCandidatesResult = {
  spaceId: string;
  candidates: LlmLocalCandidate[];
};

export type LlmSharePreviewResult = LlmShareManifest & {
  spaceId: string;
};

export type LlmImportedRequirementsResult = {
  spaceId: string;
  mappingRequired: boolean;
  manifest: LlmShareManifest | null;
};

export type LlmApiRequest =
  | { method: "describe" }
  | { method: "previewChange"; draft: LlmConnectionDraft; expectedRevision: number }
  | { method: "saveConnection"; draft: LlmConnectionDraft; expectedRevision: number }
  | { method: "setDefault"; model: SharedModelRef | null; expectedRevision: number }
  | { method: "previewDelete"; connectionId: string }
  | { method: "deleteConnection"; connectionId: string; expectedRevision: number }
  | { method: "discoverModels"; connectionId?: string; draft?: LlmConnectionDraft }
  | { method: "testConnection"; connectionId: string; modelId: string; authorize: true }
  | { method: "spacePolicy"; spaceId: string }
  | { method: "updateSpacePolicy"; spaceId: string; shared: SharedSelection; expectedRevision: number }
  | { method: "spaceDefault"; spaceId: string }
  | { method: "updateSpaceDefault"; spaceId: string; model: SharedModelRef | null }
  | { method: "listLocalCandidates"; spaceId: string }
  | {
      method: "adoptLocal";
      spaceId: string;
      routeId: string;
      displayName: string;
      expectedRevision: number;
      copyCredential: true;
    }
  | { method: "previewShare"; spaceId: string }
  | { method: "importedRequirements"; spaceId: string }
  | {
      method: "mapImported";
      spaceId: string;
      mappings: LlmShareMapping[];
      expectedRevision: number;
    }
  | {
      method: "applyPlan";
      spaceIds: string[];
      catalogRevision: number;
      observations: LlmSpaceObservation[];
      requestId: string;
    }
  | { method: "operationStatus"; operationId: string };

export type LlmCredentialRequest =
  | {
      method: typeof LLM_CREDENTIAL_METHOD;
      draft: LlmConnectionSecretDraft;
      secret: string;
      expectedRevision: number;
      operationId: string;
    }
  | {
      method: typeof LLM_CREDENTIAL_DISCOVER_METHOD;
      draft: LlmConnectionSecretDraft;
      secret: string;
    }
  | {
      method: typeof LLM_CREDENTIAL_ADOPT_METHOD;
      spaceId: string;
      routeId: string;
      displayName: string;
      secret: string;
      expectedRevision: number;
      operationId: string;
    };

export type LlmApiResult =
  | LlmDescribeResult
  | LlmChangePreview
  | LlmDeletePreview
  | LlmCatalogResult
  | LlmSpacePolicyResult
  | LlmSpaceDefaultResult
  | LlmLocalCandidatesResult
  | LlmSharePreviewResult
  | LlmImportedRequirementsResult
  | LlmDiscoverResult
  | LlmTestResult
  | LlmOperationStatusResult
  | WorkbenchJob;

export function isLlmWriteMethod(method: string): boolean {
  return (LLM_WRITE_API_METHODS as readonly string[]).includes(method) || method === LLM_CREDENTIAL_METHOD;
}
